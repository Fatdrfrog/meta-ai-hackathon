import "server-only";
import { panelWorkspaceHref } from "@/features/panel/shared/routing/hrefs";
import { getAppBaseUrl } from "@/lib/billing/config";
import { logger } from "@/lib/logger";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import { createProductVideoImport } from "@/lib/products/imports";
import {
  PRODUCTS_WHATSAPP_PAIRING_TTL_MS,
  type ProductsWhatsAppLinkedPhoneRecord,
  type ProductsWhatsAppLinkRequestRecord,
  type ProductsWhatsAppLinkResponse,
} from "@/lib/products/types";
import { productsWhatsAppNumber } from "@/lib/products/whatsapp-number";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  sendWhatsappInteractiveReplyButtons,
  sendWhatsappMessage,
} from "@/lib/whatsapp";
import { resolveWhatsAppSendContext } from "@/lib/whatsapp/send-context";
import { isWorkspaceFeatureEnabled } from "@/lib/workspace-feature-flags";
import Message from "@/models/message";
import { ProductVideoImport } from "@/models/product-video-import";
import {
  ProductWhatsAppLink,
  type IProductWhatsAppLink,
  type ProductWhatsAppQuestion,
} from "@/models/product-whatsapp-link";
import {
  ProductWhatsAppLinkMiss,
  ProductWhatsAppLinkRequest,
  ProductWhatsAppPairing,
  type IProductWhatsAppLinkRequest,
} from "@/models/product-whatsapp-pairing";
import { coerceBoolean } from "@icecore/shared/lib/value-utils";
import { normalizeWhatsAppPhone } from "@icecore/shared/lib/whatsapp/contact-identities";

// Shop owners send shelf videos to airi's own WhatsApp number, and the
// products appear in their workspace. To link a phone, an admin opens "Send
// from WhatsApp" on the Products page, whose QR opens WhatsApp with a message
// naming the shop. The message carries nothing secret, so sending it only
// asks: the phone is linked once the admin confirms it in airi. WhatsApp
// vouches for the sender's number, the admin for it being theirs. Since the
// name is all a message carries, a shop opens to phones only under a name no
// other shop with Products has, and a phone linked to one shop is never moved
// to another by asking: it's unlinked there first. The number the workspace
// already has connected needs no linking. A video from a
// linked phone within 30 minutes of linking or of its last video is imported
// straight away; a later one is asked about first, in case it wasn't meant
// for the shelf. Videos sent together share one question: WhatsApp delivers
// an album as one message per video, so a video within two minutes of the
// last one joins it. Anything else is left to the number's usual handling.
// Airi writes back only what the owner needs: where to confirm the phone,
// that it's linked, that question, and, once per video, how the import went.

const COPY = PRODUCTS_COPY.whatsapp;
const LINK_WINDOW_MS = 30 * 60_000;
const BURST_MS = 2 * 60_000;
/** How long a phone's ask waits for an admin. */
const REQUEST_TTL_MS = 10 * 60_000;
/** Phones that may wait for an admin at once; a newer ask pushes out the oldest. */
const MAX_OPEN_REQUESTS = 3;
/** Link messages matching no shop that Airi answers per phone each hour. */
const MAX_MISSES_PER_HOUR = 5;
const MISS_TTL_MS = 60 * 60_000;
const SHOP_NAME_MAX = 40;
const PROFILE_NAME_MAX = 40;
/** "…link this phone to my shop <name>", wherever the owner's greeting leaves it. */
const LINK_PHRASE = /link this phone to my shop\b[^\S\n]*([^\n]*)/i;
/** The one-time code earlier QRs wrote in. */
const CODE_MARKER = /AIRI-SHOP:/i;
const BUTTON_PATTERN = /^products-intake:(add|skip):([a-f0-9]{24})$/;
// Country calling codes two digits long; +1 and +7 are one, the rest three.
const TWO_DIGIT_CALLING_CODE =
  /^(?:2[07]|3[0-469]|4[013-9]|5[1-8]|6[0-6]|8[1246]|9[0-58])/;

/** The workspace's name as the link message writes it: one line, 40 characters at most. */
function shopName(name: string): string {
  const line = name.replace(/\s+/g, " ").trim();
  return Array.from(line).slice(0, SHOP_NAME_MAX).join("").trim();
}

/** A workspace's name as Airi says it, or "your shop" without one. */
const nameOrShop = (name: unknown) =>
  typeof name === "string" && name.trim() ? name.trim() : "your shop";

// Cyrillic and Greek letters that look like Latin ones, in lower case, and
// the Latin letter each passes for, paired by position. A capital that looks
// like a Latin capital is matched by its lower case.
const LOOKALIKES = "авекмнорстухѕіјһүӏԁԛԝαβεζηικμνορτυχ";
const AS_LATIN = "abekmhopctyxsijhyldqwabezhikmnoptyx";
const LATIN_LOOKALIKES = new Map(
  Array.from(LOOKALIKES, (char, index) => [char, AS_LATIN[index]!])
);

/**
 * A shop's name as messages are matched against it. Case, spacing, the
 * sentence's closing marks, invisible characters and letters of another
 * alphabet that look Latin don't count, so a message whose full stop was
 * dropped, or that was typed in capitals, still names the shop, and a name
 * that only looks like another shop's is that shop's name.
 */
function shopKey(name: string): string {
  return Array.from(
    name
      .normalize("NFKC")
      .replace(/\p{Cf}/gu, "")
      .toLowerCase(),
    char => LATIN_LOOKALIKES.get(char) ?? char
  )
    .join("")
    .replace(/\s+/g, " ")
    .replace(/[\s.!?…]+$/u, "")
    .trim();
}

/**
 * A WhatsApp profile name as the Products page shows it: one line, without
 * the controls that would turn the question around it, nor digits or dots
 * that could pass for the masked number shown above it, 40 characters at
 * most.
 */
function profileNameOf(name: string | null): string | null {
  const line = (name ?? "")
    .normalize("NFKC")
    .replace(/[\p{Nd}+•∙·●⋅・]/gu, " ")
    .replace(/[\p{Cc}\p{Bidi_Control}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return null;
  const chars = Array.from(line);
  return chars.length > PROFILE_NAME_MAX
    ? `${chars
        .slice(0, PROFILE_NAME_MAX - 1)
        .join("")
        .trim()}…`
    : line;
}

/**
 * A phone as the Products page shows it, "+7 ••• ••• 12 34": its country
 * code and last four digits, enough for the owner to know their own.
 */
function maskPhone(phone: string): string {
  const codeLength = /^[17]/.test(phone)
    ? 1
    : TWO_DIGIT_CALLING_CODE.test(phone)
      ? 2
      : 3;
  const last = phone.slice(-4);
  const masked = `••• ••• ${last.slice(0, 2)} ${last.slice(2)}`;
  return phone.length - codeLength >= 8
    ? `+${phone.slice(0, codeLength)} ${masked}`
    : masked;
}

const iso = (date: Date | null | undefined) =>
  date ? new Date(date).toISOString() : null;

/**
 * Opens the workspace to phones asking to be linked, for 15 minutes, or keeps
 * it open longer: the Products page does this whenever "Send from WhatsApp"
 * opens. Answers with the panel; "shop_name_taken" when another workspace
 * with Products has the same name, since a phone's message names nothing
 * else; null when airi's number isn't set up.
 */
export async function openProductsWhatsAppPairing(
  workspaceId: string,
  userId: string,
  now: Date = new Date()
): Promise<ProductsWhatsAppLinkResponse | "shop_name_taken" | null> {
  if (!productsWhatsAppNumber()) return null;
  const shop = shopName(await workspaceName(workspaceId));
  const key = shopKey(shop);
  if ((await productsShopsNamed(key)).some(id => id !== workspaceId))
    return "shop_name_taken";
  await ProductWhatsAppPairing.updateOne(
    { workspaceId },
    {
      $set: {
        createdBy: userId,
        shopName: shop,
        shopKey: key,
        expiresAt: new Date(now.getTime() + PRODUCTS_WHATSAPP_PAIRING_TTL_MS),
      },
    },
    { upsert: true }
  );
  return loadProductsWhatsAppLink(workspaceId, now);
}

/**
 * The "Send from WhatsApp" panel: the link that opens WhatsApp with the
 * shop's message, while the shop is open to phones asking; the phones
 * asking; the phones linked; and the workspace's numbers on the WhatsApp
 * Business app. Phones are masked. Null when airi's number isn't set up.
 */
export async function loadProductsWhatsAppLink(
  workspaceId: string,
  now: Date = new Date()
): Promise<ProductsWhatsAppLinkResponse | null> {
  const number = productsWhatsAppNumber();
  if (!number) return null;
  const [pairing, requests, links, businessNumbers] = await Promise.all([
    ProductWhatsAppPairing.findOne({ workspaceId, expiresAt: { $gt: now } })
      .select("shopName expiresAt")
      .lean<{ shopName: string; expiresAt: Date } | null>(),
    ProductWhatsAppLinkRequest.find({ workspaceId, expiresAt: { $gt: now } })
      .sort({ createdAt: 1 })
      .select("phone profileName createdAt")
      .lean<
        Array<
          Pick<
            IProductWhatsAppLinkRequest,
            "_id" | "phone" | "profileName" | "createdAt"
          >
        >
      >(),
    ProductWhatsAppLink.find({ workspaceId, phone: { $type: "string" } })
      .sort({ createdAt: 1 })
      .select("phone via linkedAt lastVideoAt")
      .lean<
        Array<
          Pick<
            IProductWhatsAppLink,
            "_id" | "phone" | "via" | "linkedAt" | "lastVideoAt"
          >
        >
      >(),
    workspaceBusinessNumbers(workspaceId, number),
  ]);
  return {
    pairing: pairing
      ? {
          url: `https://wa.me/${number}?text=${encodeURIComponent(
            COPY.linkMessage(pairing.shopName)
          )}`,
          expiresAt: new Date(pairing.expiresAt).toISOString(),
        }
      : null,
    requests: requests.slice(-MAX_OPEN_REQUESTS).map(
      (request): ProductsWhatsAppLinkRequestRecord => ({
        id: String(request._id),
        phone: maskPhone(request.phone),
        profileName: request.profileName ?? null,
        createdAt: new Date(request.createdAt).toISOString(),
      })
    ),
    linkedPhones: links.map(
      (link): ProductsWhatsAppLinkedPhoneRecord => ({
        id: String(link._id),
        phone: maskPhone(link.phone ?? ""),
        via: link.via,
        linkedAt: iso(link.linkedAt),
        lastVideoAt: iso(link.lastVideoAt),
      })
    ),
    businessNumbers,
  };
}

/**
 * What came of an admin's Yes: the phone is linked; the ask is gone (it
 * isn't this workspace's, expired, or was answered); or the phone belongs to
 * another workspace, which has to unlink it first.
 */
export type ProductsWhatsAppApproval = "linked" | "gone" | "linked_elsewhere";

const isDuplicateKeyError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === 11000;

/**
 * Links the phone that asked, once an admin of its workspace says it's
 * theirs. The ask is used up first, so it links once however often it's
 * confirmed, and not at all once someone said "Not me". A phone belongs to
 * one workspace, and confirming never takes it from another: one linked
 * there since it asked, or connected there, stays. Airi then tells the owner
 * on WhatsApp.
 */
export async function approveProductsWhatsAppRequest(
  workspaceId: string,
  requestId: string,
  userId: string,
  now: Date = new Date()
): Promise<ProductsWhatsAppApproval> {
  const request = await ProductWhatsAppLinkRequest.findOneAndDelete({
    _id: requestId,
    workspaceId,
    expiresAt: { $gt: now },
  })
    .select("phone sourceId")
    .lean<Pick<IProductWhatsAppLinkRequest, "phone" | "sourceId"> | null>();
  if (!request) return "gone";
  const connectedTo = await connectedNumberWorkspace(request.phone);
  if (connectedTo && connectedTo !== workspaceId) return "linked_elsewhere";
  try {
    // A link of this phone in another workspace keeps it there: the unique
    // index on the phone refuses a second one.
    await ProductWhatsAppLink.updateOne(
      { phone: request.phone, workspaceId },
      {
        $set: {
          via: "approved",
          createdBy: userId,
          linkedAt: now,
          question: null,
        },
        $unset: { lastVideoAt: "" },
      },
      { upsert: true }
    );
  } catch (error) {
    if (isDuplicateKeyError(error)) return "linked_elsewhere";
    throw error;
  }
  await reply(request.sourceId, request.phone, {
    text: COPY.linked(await workspaceName(workspaceId)),
  });
  return "linked";
}

/**
 * Forgets a phone's ask: an admin said it isn't theirs. Airi doesn't write
 * to the phone. False when the workspace has no such ask.
 */
export async function denyProductsWhatsAppRequest(
  workspaceId: string,
  requestId: string
): Promise<boolean> {
  const { deletedCount } = await ProductWhatsAppLinkRequest.deleteOne({
    _id: requestId,
    workspaceId,
  });
  return deletedCount > 0;
}

/**
 * Unlinks one of the workspace's phones: its videos go back to the number's
 * usual handling. False when the workspace has no such phone.
 */
export async function unlinkProductsWhatsAppPhone(
  workspaceId: string,
  linkId: string
): Promise<boolean> {
  const { deletedCount } = await ProductWhatsAppLink.deleteOne({
    _id: linkId,
    workspaceId,
    phone: { $type: "string" },
  });
  return deletedCount > 0;
}

/** An inbound message as the webhook stored it, with what the intake reads. */
export type ProductsWhatsAppMessage = {
  /** The number it was sent to, as the webhook names it. */
  receivingPhone: string | null;
  /** The source and workspace that own that number, where the message is stored. */
  sourceId: string | null;
  workspaceId: string;
  conversationId: string;
  /** The stored message. */
  messageId: string;
  /** The sender's number; null when WhatsApp gave only a username. */
  from: string | null;
  /** The name on the sender's WhatsApp profile, when they have one. */
  profileName: string | null;
  text: string | null;
  /** The id of a reply button the sender tapped. */
  buttonReplyId: string | null;
  /** A video, sent as a video or as a file. */
  video: { mediaId: string; mimeType: string | null } | null;
};

export type ProductsWhatsAppOutcome = {
  handled: boolean;
  /** What happened, for logs. */
  outcome: string;
};

const leftAlone = (outcome: string): ProductsWhatsAppOutcome => ({
  handled: false,
  outcome,
});
const done = (outcome: string): ProductsWhatsAppOutcome => ({
  handled: true,
  outcome,
});

async function workspaceName(workspaceId: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from("workspaces")
    .select("name")
    .eq("id", workspaceId)
    .maybeSingle();
  return nameOrShop((data as { name?: unknown } | null)?.name);
}

/**
 * The workspaces with Products whose shop name, as they're named now, a
 * phone's message would match by `key`.
 */
async function productsShopsNamed(key: string): Promise<string[]> {
  const { data: flags, error } = await supabaseAdmin
    .from("workspace_feature_flags")
    .select("workspace_id")
    .eq("feature_key", "products")
    .eq("enabled", true);
  if (error)
    throw new Error(`Products workspaces couldn't be read: ${error.message}`);
  const ids = ((flags ?? []) as Array<{ workspace_id?: unknown }>).flatMap(
    row => (typeof row.workspace_id === "string" ? [row.workspace_id] : [])
  );
  if (ids.length === 0) return [];
  const { data: workspaces, error: namesError } = await supabaseAdmin
    .from("workspaces")
    .select("id, name")
    .in("id", ids);
  if (namesError)
    throw new Error(`Workspace names couldn't be read: ${namesError.message}`);
  return ((workspaces ?? []) as Array<{ id?: unknown; name?: unknown }>)
    .filter(row => shopKey(shopName(nameOrShop(row.name))) === key)
    .flatMap(row => (typeof row.id === "string" ? [row.id] : []));
}

/** Writes to the owner from airi's number; a failure is logged, not thrown. */
async function reply(
  sourceId: string,
  to: string,
  message:
    | { text: string }
    | { text: string; buttons: Array<{ id: string; title: string }> }
): Promise<void> {
  try {
    const context = await resolveWhatsAppSendContext({ sourceId });
    if (!context) throw new Error("WhatsApp credentials not found");
    if ("buttons" in message)
      await sendWhatsappInteractiveReplyButtons(
        context.phoneNumberId,
        context.accessToken,
        to,
        message.text,
        message.buttons
      );
    else
      await sendWhatsappMessage(
        context.phoneNumberId,
        context.accessToken,
        to,
        message.text
      );
  } catch (error) {
    logger.warn("[Products] WhatsApp reply failed", {
      event: "products.whatsapp_reply_failed",
      sourceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

type ConnectedNumber = {
  workspaceId: string;
  /** Digits only. */
  phone: string;
  /** As stored, such as "+7 708 000 0011". */
  written: string;
  /** Whether it's also used in the WhatsApp Business app on a phone. */
  onBizApp: boolean;
};

/**
 * The WhatsApp numbers connected in airi: every workspace's, or one's.
 * Numbers are stored as written ("+7 708 000 0011"), so they're compared as
 * digits.
 */
async function connectedNumbers(
  workspaceId?: string
): Promise<ConnectedNumber[]> {
  let query = supabaseAdmin
    .from("sources")
    .select(
      "workspace_id, display_phone:credentials->>display_phone_number, on_biz_app:credentials->>is_on_biz_app"
    )
    .eq("type", "whatsapp");
  if (workspaceId) query = query.eq("workspace_id", workspaceId);
  const { data, error } = await query;
  if (error)
    throw new Error(`WhatsApp sources couldn't be read: ${error.message}`);
  return (
    (data ?? []) as Array<{
      workspace_id?: unknown;
      display_phone?: unknown;
      on_biz_app?: unknown;
    }>
  ).flatMap(row => {
    const phone = normalizeWhatsAppPhone(row.display_phone);
    if (!phone || typeof row.workspace_id !== "string") return [];
    return [
      {
        workspaceId: row.workspace_id,
        phone,
        written: String(row.display_phone).trim(),
        onBizApp: coerceBoolean(row.on_biz_app) === true,
      },
    ];
  });
}

/** The workspace whose connected WhatsApp number this is, when exactly one has it. */
async function connectedNumberWorkspace(phone: string): Promise<string | null> {
  const workspaces = new Set(
    (await connectedNumbers())
      .filter(number => number.phone === phone)
      .map(number => number.workspaceId)
  );
  return workspaces.size === 1 ? [...workspaces][0]! : null;
}

/**
 * The workspace's numbers on the WhatsApp Business app, as the owner reads
 * them: videos sent from one need no linking. airi's own number isn't one,
 * nor is one linked to another workspace, whose videos go there. None are
 * given when they can't be read, since the panel only mentions them.
 */
async function workspaceBusinessNumbers(
  workspaceId: string,
  airiNumber: string
): Promise<string[]> {
  let numbers: ConnectedNumber[];
  let linkedElsewhere: Set<string>;
  try {
    numbers = (await connectedNumbers(workspaceId)).filter(
      number => number.onBizApp && number.phone !== airiNumber
    );
    linkedElsewhere = new Set(
      numbers.length === 0
        ? []
        : (
            await ProductWhatsAppLink.find({
              phone: { $in: numbers.map(number => number.phone) },
              workspaceId: { $ne: workspaceId },
            })
              .select("phone")
              .lean<Array<{ phone: string }>>()
          ).map(link => link.phone)
    );
  } catch (error) {
    logger.warn("[Products] WhatsApp Business numbers couldn't be read", {
      event: "products.whatsapp_business_numbers_failed",
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  const shown = new Map<string, string>();
  for (const number of numbers)
    if (!linkedElsewhere.has(number.phone))
      shown.set(
        number.phone,
        number.written.startsWith("+") ? number.written : `+${number.phone}`
      );
  return [...shown.values()];
}

const productsEnabled = (workspaceId: string) =>
  isWorkspaceFeatureEnabled(workspaceId, "products").catch(() => false);

/**
 * The phone's link, or, for a number a workspace with Products has
 * connected, one made now. A workspace without Products gets no link.
 */
async function findLink(phone: string): Promise<IProductWhatsAppLink | null> {
  const link = await ProductWhatsAppLink.findOne({
    phone,
  }).lean<IProductWhatsAppLink>();
  if (link) return link;
  const workspaceId = await connectedNumberWorkspace(phone);
  if (!workspaceId || !(await productsEnabled(workspaceId))) return null;
  return ProductWhatsAppLink.findOneAndUpdate(
    { phone },
    { $setOnInsert: { phone, workspaceId, via: "connected_number" } },
    { upsert: true, new: true }
  ).lean<IProductWhatsAppLink>();
}

function isRecent(link: IProductWhatsAppLink, now: Date): boolean {
  const last = Math.max(
    link.linkedAt ? new Date(link.linkedAt).getTime() : 0,
    link.lastVideoAt ? new Date(link.lastVideoAt).getTime() : 0
  );
  return now.getTime() - last <= LINK_WINDOW_MS;
}

/**
 * What a text asks of Products: to link the phone to the shop it names, or,
 * from an earlier QR, to link it with a code that no longer works.
 */
function linkAsk(text: string | null): { shop: string } | "code" | null {
  if (!text) return null;
  const phrase = LINK_PHRASE.exec(text);
  if (phrase) return { shop: phrase[1] ?? "" };
  return CODE_MARKER.test(text) ? "code" : null;
}

/**
 * The workspace a phone belongs to: the one it's linked to, else the one
 * that has it connected; null when neither.
 */
async function phoneWorkspace(phone: string): Promise<string | null> {
  const link = await ProductWhatsAppLink.findOne({ phone })
    .select("workspaceId")
    .lean<Pick<IProductWhatsAppLink, "workspaceId"> | null>();
  return link?.workspaceId ?? (await connectedNumberWorkspace(phone));
}

/**
 * A phone asking to be linked to the shop its message names. With exactly
 * one shop of that name open on its Products page, and no other shop with
 * Products named that way now, the phone waits for that workspace's admin;
 * otherwise nothing is asked. A phone that belongs to another workspace
 * isn't asked about either: it's unlinked there first.
 */
async function askToLink(
  message: ProductsWhatsAppMessage & { sourceId: string },
  phone: string,
  shop: string,
  now: Date
): Promise<ProductsWhatsAppOutcome> {
  const key = shopKey(shop);
  const windows = key
    ? await ProductWhatsAppPairing.find({
        shopKey: key,
        expiresAt: { $gt: now },
      })
        .select("workspaceId shopName")
        .lean<Array<{ workspaceId: string; shopName: string }>>()
    : [];
  if (new Set(windows.map(window => window.workspaceId)).size !== 1)
    return startInAiri(message, phone, now);
  const { workspaceId, shopName: name } = windows[0]!;
  // A window keeps the name it opened with; another shop may have taken
  // that name since.
  if ((await productsShopsNamed(key)).some(id => id !== workspaceId))
    return startInAiri(message, phone, now);
  const owner = await phoneWorkspace(phone);
  if (owner === workspaceId) {
    await reply(message.sourceId, phone, { text: COPY.alreadyLinked(name) });
    return done("already_linked");
  }
  if (owner)
    return answerMiss(
      message,
      phone,
      now,
      COPY.linkedElsewhere,
      "linked_elsewhere"
    );
  await ProductWhatsAppLinkRequest.updateOne(
    { workspaceId, phone },
    {
      $set: {
        profileName: profileNameOf(message.profileName),
        sourceId: message.sourceId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
      },
    },
    { upsert: true }
  );
  const older = await ProductWhatsAppLinkRequest.find({ workspaceId })
    .sort({ createdAt: -1 })
    .skip(MAX_OPEN_REQUESTS)
    .select("_id")
    .lean<Array<{ _id: unknown }>>();
  if (older.length > 0)
    await ProductWhatsAppLinkRequest.deleteMany({
      _id: { $in: older.map(request => request._id) },
    });
  await reply(message.sourceId, phone, { text: COPY.confirmInAiri(name) });
  return done("link_requested");
}

/**
 * A link message Airi can't take, answered with `text`: up to five of them
 * an hour per phone, then nothing, so a phone can't keep Airi writing.
 */
async function answerMiss(
  message: ProductsWhatsAppMessage & { sourceId: string },
  phone: string,
  now: Date,
  text: string,
  outcome: string
): Promise<ProductsWhatsAppOutcome> {
  const misses = await ProductWhatsAppLinkMiss.countDocuments({
    phone,
    expiresAt: { $gt: now },
  });
  if (misses >= MAX_MISSES_PER_HOUR) return done("link_ignored");
  await ProductWhatsAppLinkMiss.create({
    phone,
    expiresAt: new Date(now.getTime() + MISS_TTL_MS),
  });
  await reply(message.sourceId, phone, { text });
  return done(outcome);
}

/**
 * A link message naming no shop open to phones, or one whose name more than
 * one shop has, or an earlier QR's code: Airi says where to start.
 */
const startInAiri = (
  message: ProductsWhatsAppMessage & { sourceId: string },
  phone: string,
  now: Date
) => answerMiss(message, phone, now, COPY.openProducts, "link_unmatched");

async function startImport(params: {
  message: ProductsWhatsAppMessage & { sourceId: string };
  phone: string;
  link: IProductWhatsAppLink;
  videoMessageId: string;
  video: { mediaId: string; mimeType: string | null };
  now: Date;
}): Promise<void> {
  const { message, link } = params;
  await createProductVideoImport({
    workspaceId: link.workspaceId,
    source: "whatsapp",
    whatsapp: {
      sourceId: message.sourceId,
      workspaceId: message.workspaceId,
      conversationId: message.conversationId,
      messageId: params.videoMessageId,
      mediaId: params.video.mediaId,
      mimeType: params.video.mimeType,
      phone: params.phone,
    },
  });
  await ProductWhatsAppLink.updateOne(
    { _id: link._id },
    { $set: { lastVideoAt: params.now } }
  );
}

type QuestionVideo = ProductWhatsAppQuestion["videos"][number];

/**
 * Adds a video to the burst Airi is asking about, when it comes within two
 * minutes of the burst's last video. Returns the owner's answer so far (null
 * before they answer), or undefined when there's no burst to join.
 */
async function joinBurst(
  link: IProductWhatsAppLink,
  video: QuestionVideo,
  now: Date
): Promise<ProductWhatsAppQuestion["answer"] | undefined> {
  const joined = await ProductWhatsAppLink.findOneAndUpdate(
    {
      _id: link._id,
      "question.lastVideoAt": { $gte: new Date(now.getTime() - BURST_MS) },
    },
    {
      $push: { "question.videos": video },
      $set: { "question.lastVideoAt": now },
    }
  )
    .select("question.answer")
    .lean<Pick<IProductWhatsAppLink, "question"> | null>();
  return joined?.question ? joined.question.answer : undefined;
}

/** Starts a question with this video, unless another video of its burst just did. */
async function openQuestion(
  link: IProductWhatsAppLink,
  video: QuestionVideo,
  now: Date
): Promise<boolean> {
  const opened = await ProductWhatsAppLink.updateOne(
    {
      _id: link._id,
      $or: [
        { question: null },
        { "question.lastVideoAt": { $lt: new Date(now.getTime() - BURST_MS) } },
      ],
    },
    {
      $set: {
        question: {
          messageId: video.messageId,
          videos: [video],
          lastVideoAt: now,
          answer: null,
        },
      },
    }
  );
  return opened.modifiedCount > 0;
}

/**
 * A video from a linked phone that hasn't sent one lately: Airi asks once
 * whether to add the products in it and in the videos sent with it.
 */
async function askAboutVideo(
  message: ProductsWhatsAppMessage & { sourceId: string },
  phone: string,
  link: IProductWhatsAppLink,
  video: QuestionVideo,
  now: Date
): Promise<ProductsWhatsAppOutcome> {
  let answer = await joinBurst(link, video, now);
  // Another video of the same burst started the question just now: join it.
  if (answer === undefined && !(await openQuestion(link, video, now)))
    answer = await joinBurst(link, video, now);
  if (answer === null) return done("joined_question");
  if (answer === "skip") return done("skipped");
  if (answer === "add") {
    await startImport({
      message,
      phone,
      link,
      videoMessageId: video.messageId,
      video,
      now,
    });
    return done("import_started");
  }
  await reply(message.sourceId, phone, {
    text: COPY.askToAdd(await workspaceName(link.workspaceId)),
    buttons: [
      { id: `products-intake:add:${video.messageId}`, title: COPY.addButton },
      { id: `products-intake:skip:${video.messageId}`, title: COPY.skipButton },
    ],
  });
  return done("asked");
}

/** The owner tapped "Add them" or "No" under Airi's question. */
async function answerQuestion(
  message: ProductsWhatsAppMessage & { sourceId: string },
  phone: string,
  answer: { add: boolean; videoMessageId: string },
  now: Date
): Promise<ProductsWhatsAppOutcome> {
  if (!answer.add) {
    // "No" lets the burst go, unless its videos are already being added.
    await ProductWhatsAppLink.updateOne(
      {
        phone,
        "question.messageId": answer.videoMessageId,
        "question.answer": null,
      },
      { $set: { "question.answer": "skip" } }
    );
    return done("skipped");
  }
  // "Add them" adds every video of the burst, also after a "No". Tapped
  // again, it adds nothing twice: a video's import is made once.
  const asked = await ProductWhatsAppLink.findOneAndUpdate(
    { phone, "question.messageId": answer.videoMessageId },
    { $set: { "question.answer": "add" } },
    { new: true }
  ).lean<IProductWhatsAppLink | null>();
  if (asked?.question) {
    for (const video of asked.question.videos)
      await startImport({
        message,
        phone,
        link: asked,
        videoMessageId: video.messageId,
        video,
        now,
      });
    return done("import_started");
  }
  // A question a later one replaced: only the video it was asked about,
  // and only one this phone sent, in this same chat.
  const video = await Message.findOne({
    _id: answer.videoMessageId,
    conversation: message.conversationId,
    whatsappMediaId: { $type: "string" },
  })
    .select("whatsappMediaId mimeType")
    .lean<{ whatsappMediaId: string; mimeType?: string | null } | null>();
  const link = video ? await findLink(phone) : null;
  if (!video || !link) return done("video_gone");
  await startImport({
    message,
    phone,
    link,
    videoMessageId: answer.videoMessageId,
    video: { mediaId: video.whatsappMediaId, mimeType: video.mimeType ?? null },
    now,
  });
  return done("import_started");
}

/**
 * Handles a message on airi's own number when it's for Products: a phone
 * asking to be linked, an answer to Airi's question, or a video from a
 * linked phone. Anything else, or any message to another number, is left
 * alone.
 */
export async function handleProductsWhatsAppMessage(
  message: ProductsWhatsAppMessage,
  now: Date = new Date()
): Promise<ProductsWhatsAppOutcome> {
  const number = productsWhatsAppNumber();
  if (!number || normalizeWhatsAppPhone(message.receivingPhone) !== number)
    return leftAlone("other_number");
  const phone = normalizeWhatsAppPhone(message.from);
  const sourceId = message.sourceId;
  if (!phone || !sourceId) return leftAlone("no_sender");
  const own = { ...message, sourceId };

  const ask = linkAsk(message.text);
  if (ask === "code") return startInAiri(own, phone, now);
  if (ask) return askToLink(own, phone, ask.shop, now);

  const button = BUTTON_PATTERN.exec(message.buttonReplyId ?? "");
  if (button)
    return answerQuestion(
      own,
      phone,
      { add: button[1] === "add", videoMessageId: button[2]! },
      now
    );

  if (!message.video) return leftAlone("not_a_video");
  const link = await findLink(phone);
  if (!link) return leftAlone("not_linked");
  if (!(await productsEnabled(link.workspaceId)))
    return leftAlone("products_off");

  if (isRecent(link, now)) {
    await startImport({
      message: own,
      phone,
      link,
      videoMessageId: message.messageId,
      video: message.video,
      now,
    });
    return done("import_started");
  }
  return askAboutVideo(
    own,
    phone,
    link,
    {
      messageId: message.messageId,
      mediaId: message.video.mediaId,
      mimeType: message.video.mimeType,
    },
    now
  );
}

/**
 * Tells the owner of an import that came on WhatsApp how it went, once:
 * where to check its products (and which photos weren't made), or why it
 * failed, with where to check what it found before failing. Does nothing
 * for an upload, a running import, or one already told.
 */
export async function notifyProductsWhatsAppOwner(
  importId: string
): Promise<void> {
  const doc = await ProductVideoImport.findOneAndUpdate(
    {
      _id: importId,
      "whatsapp.phone": { $type: "string" },
      "whatsapp.notifiedAt": null,
      status: { $in: ["ready", "failed"] },
    },
    { $set: { "whatsapp.notifiedAt": new Date() } },
    { new: true }
  )
    .select(
      "workspaceId status productCount productTotal photoTotal photoDone photosStopped errorCode whatsapp"
    )
    .lean<{
      workspaceId: string;
      status: string;
      productCount?: number;
      productTotal?: number;
      photoTotal?: number;
      photoDone?: number;
      photosStopped?: Parameters<typeof PRODUCTS_COPY.photosStopped>[0] | null;
      errorCode?: keyof typeof PRODUCTS_COPY.importErrors | null;
      whatsapp?: { sourceId: string; phone: string } | null;
    } | null>();
  if (!doc?.whatsapp) return;
  // Always last in its message, so WhatsApp makes it a link.
  const review = `${getAppBaseUrl()}${panelWorkspaceHref(
    doc.workspaceId,
    `products?review=${encodeURIComponent(importId)}`
  )}`;
  const photoTotal = doc.photoTotal ?? 0;
  const missing = Math.max(0, photoTotal - (doc.photoDone ?? 0));
  let text: string;
  if (doc.status === "failed")
    text = doc.productTotal
      ? COPY.failedPartial(doc.productTotal, review)
      : PRODUCTS_COPY.importErrors[doc.errorCode ?? "failed"];
  else if (!doc.productCount) text = PRODUCTS_COPY.nothingFound;
  else if (doc.photosStopped && missing > 0)
    text = COPY.readyPartial(
      doc.productCount,
      PRODUCTS_COPY.photosStopped(doc.photosStopped, missing, photoTotal),
      review
    );
  else text = COPY.ready(doc.productCount, review);
  await reply(doc.whatsapp.sourceId, doc.whatsapp.phone, { text });
}
