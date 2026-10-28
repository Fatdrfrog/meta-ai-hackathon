import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { panelWorkspaceHref } from "@/features/panel/shared/routing/hrefs";
import { getAppBaseUrl } from "@/lib/billing/config";
import { logger } from "@/lib/logger";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import { createProductVideoImport } from "@/lib/products/imports";
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
} from "@/models/product-whatsapp-link";
import { normalizeWhatsAppPhone } from "@icecore/shared/lib/whatsapp/contact-identities";

// Shop owners send shelf videos to airi's own WhatsApp number, and the
// products appear in their workspace. A phone is linked to a workspace by a
// one-time code the owner sends from the Products page, or by being the
// number the workspace already has connected. A video from a linked phone
// within 30 minutes of linking or of its last video is imported straight
// away; a later one is asked about first, in case it wasn't meant for the
// shelf. Anything else is left to the number's usual handling. Airi writes
// back only what the owner needs: that the phone is linked, that question,
// and, once, how the import went.

const COPY = PRODUCTS_COPY.whatsapp;
const CODE_TTL_MS = 30 * 60_000;
const LINK_WINDOW_MS = 30 * 60_000;
const CODE_MARKER = "AIRI-SHOP:";
const CODE_PATTERN = /AIRI-SHOP:([a-f0-9]{32})\b/i;
const BUTTON_PATTERN = /^products-intake:(add|skip):([a-f0-9]{24})$/;

const hashCode = (code: string) =>
  createHash("sha256").update(code.toLowerCase()).digest("hex");

/**
 * A one-time link for the Products page: it opens WhatsApp to airi's number
 * with the code written in, and sending it links that phone to the
 * workspace. Null when the number isn't set up.
 */
export async function createProductsWhatsAppLink(
  workspaceId: string,
  userId: string,
  now: Date = new Date()
): Promise<{ url: string; expiresAt: string } | null> {
  const number = productsWhatsAppNumber();
  if (!number) return null;
  const code = randomBytes(16).toString("hex");
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  await ProductWhatsAppLink.create({
    workspaceId,
    via: "code",
    createdBy: userId,
    codeHash: hashCode(code),
    expiresAt,
  });
  const text = `${COPY.linkMessage}\n${CODE_MARKER}${code}`;
  return {
    url: `https://wa.me/${number}?text=${encodeURIComponent(text)}`,
    expiresAt: expiresAt.toISOString(),
  };
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
  const name = (data as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.trim() ? name.trim() : "your shop";
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

/**
 * The workspace whose connected WhatsApp number this is, when exactly one
 * has it. Numbers are stored as written ("+7 708 260 9346"), so they're
 * compared as digits.
 */
async function connectedNumberWorkspace(phone: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("sources")
    .select("workspace_id, display_phone:credentials->>display_phone_number")
    .eq("type", "whatsapp");
  if (error)
    throw new Error(`WhatsApp sources couldn't be read: ${error.message}`);
  const workspaces = new Set(
    ((data ?? []) as Array<{ workspace_id?: unknown; display_phone?: unknown }>)
      .filter(row => normalizeWhatsAppPhone(row.display_phone) === phone)
      .map(row => row.workspace_id)
      .filter((id): id is string => typeof id === "string")
  );
  return workspaces.size === 1 ? [...workspaces][0]! : null;
}

/** The phone's link: one made with a code, or, for a connected number, one made now. */
async function findLink(phone: string): Promise<IProductWhatsAppLink | null> {
  const link = await ProductWhatsAppLink.findOne({
    phone,
  }).lean<IProductWhatsAppLink>();
  if (link) return link;
  const workspaceId = await connectedNumberWorkspace(phone);
  if (!workspaceId) return null;
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

async function linkPhone(
  message: ProductsWhatsAppMessage & { sourceId: string },
  phone: string,
  code: string,
  now: Date
): Promise<ProductsWhatsAppOutcome> {
  const codeHash = hashCode(code);
  const pending = await ProductWhatsAppLink.findOne({
    codeHash,
    expiresAt: { $gt: now },
  })
    .select("_id workspaceId")
    .lean<{ _id: unknown; workspaceId: string } | null>();
  if (!pending) {
    await reply(message.sourceId, phone, { text: COPY.linkExpired });
    return done("link_expired");
  }
  // A phone belongs to one workspace: linking it again moves it.
  await ProductWhatsAppLink.deleteMany({ phone, _id: { $ne: pending._id } });
  const claimed = await ProductWhatsAppLink.updateOne(
    { _id: pending._id, codeHash },
    {
      $set: { phone, linkedAt: now },
      $unset: { codeHash: "", expiresAt: "" },
    }
  );
  if (claimed.modifiedCount === 0) {
    await reply(message.sourceId, phone, { text: COPY.linkExpired });
    return done("link_expired");
  }
  await reply(message.sourceId, phone, {
    text: COPY.linked(await workspaceName(pending.workspaceId)),
  });
  return done("linked");
}

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

/** The owner tapped "Add them" or "No" under a video Airi asked about. */
async function answerQuestion(
  message: ProductsWhatsAppMessage & { sourceId: string },
  phone: string,
  answer: { add: boolean; videoMessageId: string },
  now: Date
): Promise<ProductsWhatsAppOutcome> {
  if (!answer.add) return done("skipped");
  // Only a video this phone sent, in this same chat.
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
 * Handles a message on airi's own number when it's for Products: a link
 * code, an answer to Airi's question, or a video from a linked phone.
 * Anything else, or any message to another number, is left alone.
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

  const code = CODE_PATTERN.exec(message.text ?? "")?.[1];
  if (code) return linkPhone(own, phone, code, now);

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
  if (
    !(await isWorkspaceFeatureEnabled(link.workspaceId, "products").catch(
      () => false
    ))
  )
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
  await reply(sourceId, phone, {
    text: COPY.askToAdd(await workspaceName(link.workspaceId)),
    buttons: [
      { id: `products-intake:add:${message.messageId}`, title: COPY.addButton },
      {
        id: `products-intake:skip:${message.messageId}`,
        title: COPY.skipButton,
      },
    ],
  });
  return done("asked");
}

/**
 * Tells the owner of an import that came on WhatsApp how it went, once:
 * where to check its products, or why it failed. Does nothing for an
 * upload, a running import, or one already told.
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
    .select("workspaceId status productCount errorCode whatsapp")
    .lean<{
      workspaceId: string;
      status: string;
      productCount?: number;
      errorCode?: keyof typeof PRODUCTS_COPY.importErrors | null;
      whatsapp?: { sourceId: string; phone: string } | null;
    } | null>();
  if (!doc?.whatsapp) return;
  let text: string;
  if (doc.status === "failed")
    text = PRODUCTS_COPY.importErrors[doc.errorCode ?? "failed"];
  else if (!doc.productCount) text = PRODUCTS_COPY.nothingFound;
  else
    text = COPY.ready(
      doc.productCount,
      `${getAppBaseUrl()}${panelWorkspaceHref(
        doc.workspaceId,
        `products?review=${encodeURIComponent(importId)}`
      )}`
    );
  await reply(doc.whatsapp.sourceId, doc.whatsapp.phone, { text });
}
