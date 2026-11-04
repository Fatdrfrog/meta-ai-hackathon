import "server-only";
import { logger } from "@/lib/logger";
import { carouselTemplateComponents } from "@/lib/products/carousel-components";
import {
  carouselCardCount,
  keepCardPictures,
  parseCarouselEdit,
} from "@/lib/products/kit-carousel-edit";
import {
  isObjectIdText,
  type ProductKitEditInput,
  type ProductKitRequest,
  type ProductKitRequestEdits,
} from "@/lib/products/kit-request";
import {
  carouselVerdict,
  kitPartBusy,
  kitPartCanEdit,
  kitPartCanRetry,
  productKitStatus,
} from "@/lib/products/kit-status";
import {
  clipText,
  KIT_CAROUSEL_MAX_CARDS,
  KIT_CAROUSEL_MIN_CARDS,
  ORDER_FORM_MAX_PRODUCTS,
} from "@/lib/products/kit-text";
import {
  productPhotoUrl,
  withProductPhotoUrls,
} from "@/lib/products/photo-urls";
import {
  buildOrderFormFlowConfig,
  ORDER_FORM_PRODUCTS_FIELD_ID,
  parseOrderFormConfig,
} from "@/lib/products/order-form-config";
import {
  shopWords,
  spokeShopWordsLanguage,
  type ShopPrice,
} from "@/lib/products/shop-words";
import {
  PRODUCT_KIT_PARTS,
  type ProductKitDraftsRequest,
  type ProductKitDraftsResponse,
  type ProductKitEditSourceResponse,
  type ProductKitPart,
  type ProductKitPartError,
  type ProductKitPartErrorCode,
  type ProductKitPlanProduct,
  type ProductKitPlanResponse,
  type ProductKitRecord,
  type ProductShopWordsCode,
  type StoredFileRef,
} from "@/lib/products/types";
import {
  ADDED_PRODUCT_FIELDS,
  createOrderFormDraft,
  featuredPhoto,
  prepareCarouselDraft,
  storedRef,
  toAddedProduct,
  type AddedProduct,
  type AddedProductRow,
} from "@/lib/products/whatsapp-drafts";
import { createClient } from "@/lib/supabase/server";
import {
  deleteMetaWhatsAppFlow,
  getMetaWhatsAppFlow,
  updateMetaWhatsAppFlow,
} from "@/lib/whatsapp/flows/service";
import { getWhatsAppWorkspaceContext } from "@/lib/whatsapp/get-workspace-context";
import { parseWhatsAppTemplateSubmissionComponents } from "@/lib/whatsapp/templates/component-schemas";
import { WhatsAppTemplateGraphRefusalError } from "@/lib/whatsapp/templates/graph-response";
import {
  findWhatsAppTemplateByName,
  getTemplate,
  WHATSAPP_TEMPLATE_CAROUSEL_CREATE_TIMEOUT_MS,
} from "@/lib/whatsapp/templates/service";
import {
  createUnifiedTemplateRecord,
  WhatsAppTemplateRecordPersistenceError,
} from "@/lib/whatsapp/templates/unified-service";
import {
  PRODUCT_KIT_COMPONENTS_MAX_BYTES,
  PRODUCT_KIT_EARLIER_MAX,
  ProductKit,
  type IProductKit,
  type IProductKitCarouselPart,
  type IProductKitOrderFormPart,
  type ProductKitPrice,
  type ProductKitStoredError,
} from "@/models/product-kit";
import { ProductVideoImport } from "@/models/product-video-import";
import { WorkspaceProduct } from "@/models/workspace-product";
import { StorageQuotaError } from "@icecore/airi-runtime/storage-quota";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import mongoose from "mongoose";

// Kits: the carousel and the order form one press makes from shelf products,
// for customers on WhatsApp. The carousel goes straight to Meta for review,
// the way the template editor sends one; the order form is published. Both
// run at once inside the request, and each part is saved as it settles, so a
// part that worked is never undone by the other failing, and leaving the page
// loses nothing. A failed part is made again on its own.

/** A part still "making" this long after its last change has stopped: functions end at 60 s. */
const MAKING_TIMEOUT_MS = 90_000;
/**
 * The kit routes stop at 60 s (maxDuration). From when the press or edit
 * began (`deadlineFrom`: after sign-in, before the kit, shelf and
 * connection reads, an edit's Assets copies and its looks by name), nothing
 * new is begun after this, so the answer leaves well before then.
 *
 * Before the carousel's create come a Try again's look by name (up to 5 s),
 * the cards on white and their header uploads, 4 at a time: about 7 s for 4
 * cards in production (2026-11-03, where the 10 s abort came 17 s into the
 * request), up to about 15 s for 10. The create then gets up to
 * WHATSAPP_TEMPLATE_CAROUSEL_CREATE_TIMEOUT_MS (25 s) rather than the usual
 * 10 s, but only until one look (5 s) before this deadline, and never under
 * 10 s. Meta's status is read back only while that read (10 s at most) ends
 * by then too, and the looks after a lost answer end by the deadline, so
 * the answer leaves by about 50 s unless the cards alone take over 30 s.
 */
const KIT_DEADLINE_MS = 45_000;
/** One look at Meta for a carousel by its name. */
const LOOKUP_TIMEOUT_MS = 5_000;
/** Meta's code for a second template under a name and language it has… */
const TWIN_SUBCODE = 2388024;
/** …and its words for it: "There is already Kazakh content for this template." */
const TWIN_WORDS = /already .*content for this template/i;
/** After Meta's answer to the create was lost: looks at once, then after these waits, while time allows. */
const LOST_LOOK_WAITS_MS = [0, 2_000, 4_000] as const;
/** A carousel still "checking" is looked for again at most this often, as the page polls the kit… */
const CHECKING_LOOK_MS = 15_000;
/** …for this long, before it counts as not made (Try again looks for it first). */
const CHECKING_FOR_MS = 3 * 60_000;
/** How often Meta's verdict on a waiting carousel is read again. */
const WAITING_RECHECK_MS = 60_000;
/** …and, once it has waited 10 minutes, every 5. */
const LONG_WAIT_MS = 10 * 60_000;
const LONG_WAIT_RECHECK_MS = 5 * 60_000;
/** A decided carousel is read again, from airi's copy only, every 10 minutes. */
const DECIDED_RECHECK_MS = 10 * 60_000;
/** airi's copy can be late: after 2 minutes waiting, Meta itself is asked. */
const META_READ_AFTER_MS = 2 * 60_000;
/** Meta reads one list of kits may make. */
const LIST_META_READS = 3;
/** Meta's words kept for a refusal. */
const MESSAGE_MAX = 300;
/**
 * How Meta words a refusal for the account's template limit; the template
 * then carries LIMIT_EXCEEDED, which needs the same answer from the owner.
 */
const TEMPLATE_LIMIT_WORDS =
  /maximum number of (message )?templates|(message )?templates? limit|limit of (message )?templates/i;

// ---------------------------------------------------------------- shelf

/** A shelf product as a kit uses it: what the drafts read, plus its video and small photo. */
export type ShelfProduct = AddedProduct & {
  importId: string | null;
  thumb: StoredFileRef | null;
};

type ShelfRow = AddedProductRow & { importId?: unknown };

function toShelfProduct(row: ShelfRow): ShelfProduct {
  return {
    ...toAddedProduct(row),
    importId: row.importId ? String(row.importId) : null,
    thumb: storedRef(featuredPhoto(row)?.thumb) ?? null,
  };
}

/** The language spoken in the newest of these products' videos that has one. */
async function newestSpokenLanguage(
  workspaceId: string,
  products: ShelfProduct[]
): Promise<string | null> {
  const importIds = [
    ...new Set(
      products.flatMap(product =>
        product.importId && isObjectIdText(product.importId)
          ? [product.importId]
          : []
      )
    ),
  ];
  if (importIds.length === 0) return null;
  const [newest] = await ProductVideoImport.find({
    _id: { $in: importIds },
    workspaceId,
    language: { $nin: [null, ""] },
  })
    .sort({ createdAt: -1 })
    .limit(1)
    .select("language")
    .lean<Array<{ language?: string | null }>>();
  return newest?.language ?? null;
}

/**
 * The published products among `productIds`, in that order (the shelf's,
 * as the page sends them), with the language spoken in the newest of their
 * videos. Products from several videos are fine; ids that aren't on this
 * workspace's shelf are left out.
 */
export async function loadShelfProducts(
  workspaceId: string,
  productIds: readonly string[]
): Promise<{ language: string | null; products: ShelfProduct[] }> {
  const ids = [...new Set(productIds)].filter(isObjectIdText);
  if (ids.length === 0) return { language: null, products: [] };
  const rows = await WorkspaceProduct.find({
    workspaceId,
    _id: { $in: ids },
    status: "published",
  })
    .select(`${ADDED_PRODUCT_FIELDS} importId`)
    .lean<ShelfRow[]>();
  const byId = new Map(rows.map(row => [String(row._id).toLowerCase(), row]));
  const products = ids.flatMap(id => {
    const row = byId.get(id.toLowerCase());
    return row ? [toShelfProduct(row)] : [];
  });
  return {
    language: await newestSpokenLanguage(workspaceId, products),
    products,
  };
}

// ---------------------------------------------------------------- WhatsApp

type KitWhatsApp =
  | { connected: false; displayPhone: null }
  | {
      connected: true;
      accessToken: string;
      wabaId: string;
      displayPhone: string | null;
    };

async function readKitWhatsApp(workspaceId: string): Promise<KitWhatsApp> {
  const result = await getWhatsAppWorkspaceContext(workspaceId, {
    requireCredentials: false,
    requireManager: true,
  });
  if (result.error) {
    // An unreadable connection isn't a missing one.
    if (result.error.status >= 500)
      throw new Error(
        `The WhatsApp connection couldn't be read (${result.error.status})`
      );
    return { connected: false, displayPhone: null };
  }
  const { accessToken, wabaId, credentials } = result.context;
  if (!accessToken || !wabaId) return { connected: false, displayPhone: null };
  return {
    connected: true,
    accessToken,
    wabaId,
    displayPhone: credentials.displayPhoneNumber?.trim() || null,
  };
}

/** Whether a WhatsApp number is connected to make kits on, and the number buyers see. */
export async function productsWhatsAppConnection(
  workspaceId: string
): Promise<{ connected: boolean; displayPhone: string | null }> {
  const { connected, displayPhone } = await readKitWhatsApp(workspaceId);
  return { connected, displayPhone };
}

// ---------------------------------------------------------------- record

type KitId = IProductKit["_id"];

function findByRequest(workspaceId: string, requestId: string) {
  return ProductKit.findOne({ workspaceId, requestId }).lean<IProductKit>();
}

function findKit(workspaceId: string, kitId: KitId | string) {
  return ProductKit.findOne({ _id: kitId, workspaceId }).lean<IProductKit>();
}

const iso = (value: Date | null | undefined): string | null =>
  value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString()
    : null;

const recordError = (
  error: ProductKitStoredError | null | undefined
): ProductKitPartError | null =>
  error ? { code: error.code, message: error.message ?? null } : null;

/** A shelf product's price now, keyed by product id. */
type ShelfPrices = ReadonlyMap<string, ShopPrice>;

/** The prices products are written with for buyers, as a kit keeps them. */
const priceSnapshot = (products: readonly ShelfProduct[]): ProductKitPrice[] =>
  products.map(product => ({
    productId: product.id,
    price: product.price,
    currency: product.currency,
    priceIsFrom: product.priceIsFrom,
  }));

/** What each part shows: the form lists the first 20, the cards the first 10 with photos. */
const orderFormPrices = (products: readonly ShelfProduct[]) =>
  priceSnapshot(products.slice(0, ORDER_FORM_MAX_PRODUCTS));
const carouselPrices = (products: readonly ShelfProduct[]) =>
  priceSnapshot(
    products.filter(product => product.photo).slice(0, KIT_CAROUSEL_MAX_CARDS)
  );

/**
 * The prices a kit shows buyers now: each part that holds something (a form
 * ready or kept as a draft, a carousel with Meta) with the prices it was
 * last made with; a kit from before parts kept them, with the kit's.
 */
function shownPrices(doc: IProductKit): ProductKitPrice[][] {
  const { orderForm, carousel } = doc.parts ?? {};
  const holding = [
    orderForm?.state === "ready" || orderForm?.state === "draft"
      ? orderForm
      : null,
    carousel?.state === "submitted" ? carousel : null,
  ];
  return holding.flatMap(part =>
    part ? [part.prices ?? doc.prices ?? []] : []
  );
}

/** The shelf's prices now for these kits' products (one read for all). */
async function shelfPricesOf(
  workspaceId: string,
  docs: IProductKit[]
): Promise<ShelfPrices> {
  const ids = [
    ...new Set(
      docs.flatMap(doc =>
        shownPrices(doc).flatMap(prices => prices.map(p => p.productId))
      )
    ),
  ].filter(isObjectIdText);
  if (ids.length === 0) return new Map();
  const rows = await WorkspaceProduct.find({
    workspaceId,
    _id: { $in: ids },
    status: "published",
  })
    .select("price currency priceIsFrom")
    .lean<
      Array<{
        _id: unknown;
        price?: number | null;
        currency?: string | null;
        priceIsFrom?: boolean;
      }>
    >();
  return new Map(
    rows.map(row => [
      String(row._id).toLowerCase(),
      {
        price: typeof row.price === "number" ? row.price : null,
        currency: typeof row.currency === "string" ? row.currency : null,
        priceIsFrom: row.priceIsFrom === true,
      },
    ])
  );
}

/**
 * Whether a product on the shelf now has another price than a part shows
 * buyers. A part made again at the shelf's new prices shows them.
 */
function pricesChanged(doc: IProductKit, shelf: ShelfPrices): boolean {
  return shownPrices(doc).some(prices =>
    prices.some(made => {
      const now = shelf.get(made.productId.toLowerCase());
      return (
        now !== undefined &&
        (now.price !== made.price ||
          now.currency !== made.currency ||
          now.priceIsFrom !== made.priceIsFrom)
      );
    })
  );
}

/**
 * A stored kit as the page reads it: its status derived from its parts, and
 * whether a shelf price changed since (given the shelf's prices now).
 */
export function toProductKitRecord(
  doc: IProductKit,
  shelf: ShelfPrices = new Map()
): ProductKitRecord {
  const form = doc.parts?.orderForm;
  const carousel = doc.parts?.carousel;
  const parts: ProductKitRecord["parts"] = {};
  if (form)
    parts.orderForm = {
      state: form.state,
      flowId: form.flowId ?? null,
      flowName: form.flowName ?? null,
      productCount: form.productCount ?? 0,
      error: recordError(form.error),
      edited: form.edited === true,
      version: form.version ?? 1,
      earlier: (form.earlier ?? []).map(entry => ({
        flowId: entry.flowId ?? null,
        flowName: entry.flowName ?? null,
        replacedAt: iso(entry.replacedAt) ?? new Date(0).toISOString(),
      })),
    };
  if (carousel)
    parts.carousel = {
      state: carousel.state,
      templateId: carousel.templateId ?? null,
      templateName: carousel.templateName ?? null,
      cardCount: carousel.cardCount ?? 0,
      metaStatus: carousel.metaStatus ?? null,
      metaReason: carousel.metaReason ?? null,
      approvedAt: iso(carousel.approvedAt),
      error: recordError(carousel.error),
      edited: carousel.edited === true,
      earlier: (carousel.earlier ?? []).map(entry => ({
        templateId: entry.templateId ?? null,
        templateName: entry.templateName ?? null,
        metaStatus: entry.metaStatus ?? null,
        replacedAt: iso(entry.replacedAt) ?? new Date(0).toISOString(),
      })),
    };
  return {
    id: String(doc._id),
    createdAt: iso(doc.createdAt) ?? new Date(0).toISOString(),
    language: doc.language,
    productIds: [...doc.productIds],
    importId: doc.importId ?? null,
    parts,
    status: productKitStatus(parts),
    pricesChanged: pricesChanged(doc, shelf),
  };
}

// ---------------------------------------------------------------- names

/**
 * products_YYYYMMDD_HHMMSS_<the kit id's last 6> (UTC). The kit in it keeps
 * two kits made in the same second apart at Meta, so a look by name after a
 * lost answer only ever finds this kit's own carousel.
 */
export function carouselTemplateName(now: Date, kitId: KitId): string {
  const stamp = now
    .toISOString()
    .slice(0, 19)
    .replace(/[-:]/g, "")
    .replace("T", "_");
  return `products_${stamp}_${String(kitId).slice(-6).toLowerCase()}`;
}

/** A name carouselTemplateName made, for this kit or another (or for a draft). */
const MADE_NAME = /^products_\d{8}_\d{6}_[0-9a-f]{6}$/;

/** Why a carousel can't go under a name: this kit had it, or Meta has it, or Meta couldn't say. */
type NameRefusal = "template_name_taken" | "meta_unavailable";

/**
 * The name an edited carousel goes to Meta under, unique to this kit so a
 * look by name after a lost answer only finds this kit's own carousel:
 * - a name this kit already sent under (now or earlier) is taken;
 * - a name airi made for this kit (GET …/edit) is used as it is;
 * - a name airi made for a draft before Make, or for another kit, is made
 *   again for this kit;
 * - the owner's own name is used once Meta says it has no template under
 *   it in the kit's language; Meta having one, it's taken.
 */
async function carouselNameFor(params: {
  wanted: string;
  kitId: KitId;
  now: Date;
  taken: ReadonlySet<string>;
  lookup: CarouselLookup;
}): Promise<{ name: string } | { refused: NameRefusal }> {
  const { wanted, kitId, now, taken, lookup } = params;
  if (taken.has(wanted)) return { refused: "template_name_taken" };
  if (MADE_NAME.test(wanted)) {
    const own = `_${String(kitId).slice(-6).toLowerCase()}`;
    if (wanted.endsWith(own)) return { name: wanted };
    // Made a second later when this second's name was this kit's already.
    for (let tries = 0; tries < 5; tries += 1) {
      const name = carouselTemplateName(
        new Date(now.getTime() + tries * 1000),
        kitId
      );
      if (!taken.has(name)) return { name };
    }
    return { refused: "template_name_taken" };
  }
  const look = await sentEarlier(lookup, wanted);
  if (isFound(look)) return { refused: "template_name_taken" };
  if (look === "unknown") return { refused: "meta_unavailable" };
  return { name: wanted };
}

/** The names a kit's carousel was sent under: now and before. */
function sentNames(carousel: IProductKitCarouselPart | null | undefined) {
  return new Set(
    [
      carousel?.templateName,
      ...(carousel?.earlier ?? []).map(entry => entry.templateName),
    ].filter((name): name is string => Boolean(name))
  );
}

/** "Order form · 2 Nov 09:14" on the owner's clock, or "… 04:14 UTC" without their zone. */
export function orderFormName(now: Date, timeZone: string | null): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timeZone ?? "UTC",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(entry => entry.type === type)?.value ?? "";
  const when = `${part("day")} ${part("month")} ${part("hour")}:${part("minute")}`;
  return `Order form · ${when}${timeZone ? "" : " UTC"}`;
}

// ---------------------------------------------------------------- parts

type KitContext = {
  workspaceId: string;
  userId: string;
  kitId: KitId;
  language: ProductShopWordsCode;
  timeZone: string | null;
  products: ShelfProduct[];
  whatsapp: { accessToken: string; wabaId: string };
  now: Date;
  /**
   * When the request's work began, if before `now`: the kit's time counts
   * from it, so slow reads before the parts start never push the answer
   * past the route's 60 s. `now` stays the time names and records carry.
   */
  deadlineFrom?: Date;
  /**
   * The carousel's template name for this attempt, saved on the kit before
   * Meta is asked; `mayExist` when an earlier attempt sent it under that
   * name and its answer was lost, so Meta is asked for it first.
   * `components` are the owner's edited cards, sent instead of the shelf's.
   */
  carousel: {
    name: string;
    mayExist: boolean;
    components?: WhatsAppComponent[];
  };
  /**
   * The Flow an earlier attempt made before its answer was lost, to finish;
   * null for none. `config` is the owner's edited form, sent instead of the
   * shelf's.
   */
  orderForm: {
    flowId: string | null;
    flowName: string | null;
    config?: WhatsAppFlowConfig;
  };
};

/** A first attempt: nothing made before it. */
const firstAttempt = (
  now: Date,
  kitId: KitId
): Pick<KitContext, "carousel" | "orderForm"> => ({
  carousel: { name: carouselTemplateName(now, kitId), mayExist: false },
  orderForm: { flowId: null, flowName: null },
});

/** When nothing new starts for this attempt's parts any more. */
const kitDeadline = (context: KitContext) =>
  (context.deadlineFrom ?? context.now).getTime() + KIT_DEADLINE_MS;

type OrderFormOutcome = Partial<Omit<IProductKitOrderFormPart, "updatedAt">> &
  Pick<IProductKitOrderFormPart, "state">;
type CarouselOutcome = Partial<Omit<IProductKitCarouselPart, "updatedAt">> &
  Pick<IProductKitCarouselPart, "state">;

/** Meta's own words for a refusal, without airi's wrapping. */
function metaWords(error: unknown): string | null {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const words = text.replace(/^WhatsApp API error:\s*/i, "").trim();
  return words ? clipText(words, MESSAGE_MAX) : null;
}

/** Why a part threw: the company's storage being full is the owner's to fix. */
const thrownError = (error: unknown): ProductKitStoredError =>
  error instanceof StorageQuotaError
    ? { code: "storage_full", message: null }
    : { code: "failed", message: null };

/** An error and the ones it wraps, outermost first. */
function causesOf(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let at = error; at && chain.length < 5; ) {
    chain.push(at);
    at = (at as { cause?: unknown }).cause;
  }
  return chain;
}

const timedOut = (error: unknown) => {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
};

/** Meta's refusal among what an error wraps; null when Meta refused nothing. */
const graphRefusalOf = (error: unknown) =>
  causesOf(error).find(
    (entry): entry is WhatsAppTemplateGraphRefusalError =>
      entry instanceof WhatsAppTemplateGraphRefusalError
  ) ?? null;

/** Whether Meta refused a template because it has one under that name and language. */
function isTwinRefusal(refusal: WhatsAppTemplateGraphRefusalError): boolean {
  // Meta's body carries the subcode; airi's type of it doesn't name it.
  const body = refusal.graphError as
    | (typeof refusal.graphError & { error_subcode?: unknown })
    | undefined;
  return (
    Number(body?.error_subcode) === TWIN_SUBCODE ||
    [refusal.message, body?.message, body?.error_user_msg].some(
      words => typeof words === "string" && TWIN_WORDS.test(words)
    )
  );
}

/**
 * Why sending the carousel failed: Meta's refusal in its own words (its
 * template limit apart), or airi's own call timing out, or failing some
 * other way, which Meta had no part in.
 */
function carouselSendError(error: unknown): ProductKitStoredError {
  const chain = causesOf(error);
  const refusal = graphRefusalOf(error);
  if (refusal) {
    const words = metaWords(refusal);
    return {
      code:
        words && TEMPLATE_LIMIT_WORDS.test(words)
          ? "template_limit"
          : "meta_refused",
      message: words,
    };
  }
  return chain.some(timedOut)
    ? { code: "timed_out", message: null }
    : { code: "failed", message: null };
}

/**
 * Saves the new Flow's id on the kit as soon as Meta made it: a function
 * stopped before the part settles leaves it findable for "Try again".
 * Best effort: the form goes on either way.
 */
async function recordFlow(context: KitContext, flowId: string, name: string) {
  try {
    await ProductKit.updateOne(
      {
        _id: context.kitId,
        workspaceId: context.workspaceId,
        "parts.orderForm.state": "making",
      },
      {
        $set: {
          "parts.orderForm.flowId": flowId,
          "parts.orderForm.flowName": name,
        },
      }
    );
  } catch (error) {
    logger.warn("[Products] kit order form id not saved", {
      event: "products.kit_order_form_id_failed",
      workspaceId: context.workspaceId,
      kitId: String(context.kitId),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The Flow an earlier attempt made, as Meta has it now: published (done),
 * a draft (to finish), neither (gone, or stopped by Meta: make another), or
 * "unknown" when Meta couldn't be asked (an outage, a rate limit, the read
 * failing), when making another would leave this one behind.
 */
async function earlierFlow(
  context: Pick<KitContext, "whatsapp">,
  flowId: string
): Promise<"published" | "draft" | "unknown" | null> {
  const read = await getMetaWhatsAppFlow({
    accessToken: context.whatsapp.accessToken,
    flowId,
    expectedWabaId: context.whatsapp.wabaId,
  });
  // Gone, as template-flow-facts reads it: 404 (not this WABA's) or
  // Graph's 100/33 (no such object). Any other failure says nothing.
  if (
    !read.ok &&
    read.status !== 404 &&
    !(read.providerCode === 100 && read.providerSubcode === 33)
  )
    return "unknown";
  const status = read.ok ? String(read.flow?.status ?? "").toUpperCase() : "";
  return status === "PUBLISHED"
    ? "published"
    : status === "DRAFT"
      ? "draft"
      : null;
}

/** How many products a form's products question lists. */
function listedProducts(config: WhatsAppFlowConfig): number {
  const field = config.screens
    .flatMap(screen => screen.fields)
    .find(entry => entry.id === ORDER_FORM_PRODUCTS_FIELD_ID);
  return field?.options?.length ?? 0;
}

/** The order form: saved as a Flow, then published; a Flow Meta won't publish stays a draft. */
async function makeOrderForm(context: KitContext): Promise<OrderFormOutcome> {
  const { accessToken, wabaId } = context.whatsapp;
  // The owner's edit, or the shelf's questions: kept on the kit as sent.
  const config =
    context.orderForm.config ??
    buildOrderFormFlowConfig(context.products, context.language);
  const productCount = context.orderForm.config
    ? listedProducts(config)
    : Math.min(context.products.length, ORDER_FORM_MAX_PRODUCTS);
  const name =
    context.orderForm.flowName ?? orderFormName(context.now, context.timeZone);
  // An earlier attempt's answer was lost after Meta made its Flow: finish
  // that one rather than publish a second (published Flows can't be deleted).
  const earlier = context.orderForm.flowId
    ? await earlierFlow(context, context.orderForm.flowId)
    : null;
  // Meta couldn't say what became of it: nothing new is made while it may
  // be there. The part keeps its Flow, so Try again finishes that one.
  if (earlier === "unknown")
    return {
      state: "failed",
      productCount,
      config,
      error: { code: "failed", message: null },
    };
  if (earlier === "published")
    return {
      state: "ready",
      flowId: context.orderForm.flowId,
      flowName: name,
      productCount,
      error: null,
    };
  const draft = await createOrderFormDraft({
    accessToken,
    wabaId,
    products: context.products,
    language: context.language,
    config,
    name,
    ...(earlier === "draft" && context.orderForm.flowId
      ? { flowId: context.orderForm.flowId }
      : {}),
    onCreated: flowId => recordFlow(context, flowId, name),
  });
  if (!draft.ok) {
    logger.error("[Products] kit order form refused", undefined, {
      event: "products.kit_order_form_refused",
      workspaceId: context.workspaceId,
      kitId: String(context.kitId),
      reason: draft.error,
    });
    return {
      state: "failed",
      productCount,
      config,
      error:
        draft.reason === "refused"
          ? { code: "meta_refused", message: metaWords(draft.error) }
          : { code: "failed", message: null },
    };
  }
  const published = await updateMetaWhatsAppFlow({
    accessToken,
    flowId: draft.flowId,
    operation: "publish",
  });
  const flow = {
    flowId: draft.flowId,
    flowName: draft.name,
    productCount,
    config,
  };
  if (published.ok) return { state: "ready", ...flow, error: null };
  logger.warn("[Products] kit order form left as a draft", {
    event: "products.kit_order_form_draft",
    workspaceId: context.workspaceId,
    kitId: String(context.kitId),
    reason: published.error,
  });
  return {
    state: "draft",
    ...flow,
    error: { code: "meta_refused", message: metaWords(published.error) },
  };
}

/**
 * A carousel with Meta, as Meta just answered. One an earlier attempt sent
 * (`found`) was approved at a time nobody knows, so it gets none.
 */
function submittedCarousel(
  sent: { templateId: string; status?: string; rowId: string | null },
  name: string,
  cardCount: number,
  found = false
): CarouselOutcome {
  const metaStatus = (sent.status || "PENDING").toUpperCase();
  const answeredAt = new Date();
  return {
    state: "submitted",
    templateId: sent.templateId,
    templateName: name,
    templateRowId: sent.rowId,
    cardCount,
    metaStatus,
    metaReason: null,
    approvedAt:
      !found && carouselVerdict(metaStatus) === "approved" ? answeredAt : null,
    submittedAt: answeredAt,
    checkedAt: answeredAt,
    error: null,
  };
}

/** What looking for a kit's carousel at Meta by name needs. */
type CarouselLookup = Pick<
  KitContext,
  "workspaceId" | "kitId" | "language" | "whatsapp"
>;

/** A template Meta has under a carousel's name. */
type FoundTemplate = { id: string; status: string };

/**
 * What a look at Meta for a carousel by its name found: the template, or
 * "absent" when Meta lists none, or "unknown" when Meta couldn't be asked
 * (the look timed out, or Meta refused it: a rate limit, an outage).
 */
type CarouselLook = FoundTemplate | "absent" | "unknown";

const isFound = (look: CarouselLook | null): look is FoundTemplate =>
  typeof look === "object" && look !== null;

/**
 * The template an earlier attempt sent under this name, as Meta has it now.
 * Only "absent" lets the carousel be sent again or called refused: sent
 * again under the same name, Meta refuses a twin, so nothing goes to review
 * twice, while a new name would make a second.
 */
async function sentEarlier(
  context: CarouselLookup,
  name: string
): Promise<CarouselLook> {
  try {
    return (
      (await findWhatsAppTemplateByName({
        accessToken: context.whatsapp.accessToken,
        wabaId: context.whatsapp.wabaId,
        name,
        language: context.language,
        timeoutMs: LOOKUP_TIMEOUT_MS,
      })) ?? "absent"
    );
  } catch (error) {
    logger.warn("[Products] kit carousel lookup failed", {
      event: "products.kit_carousel_lookup_failed",
      workspaceId: context.workspaceId,
      kitId: String(context.kitId),
      error: error instanceof Error ? error.message : String(error),
    });
    return "unknown";
  }
}

/**
 * A carousel Meta may have under its name without airi having seen it: the
 * kit's poll looks again (settleCheckingCarousels) until it turns up or its
 * time is over, when it fails as timed out with its name kept. `checkedAt`
 * is null when there was no time to look: the first poll looks at once.
 */
const checkingCarousel = (
  name: string,
  cardCount: number,
  checkedAt: Date | null
): CarouselOutcome => ({
  state: "checking",
  templateName: name,
  cardCount,
  checkedAt,
  error: null,
});

const pause = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * After airi stopped waiting for Meta's answer to the create, Meta may have
 * made the carousel all the same, or still be making it. It is looked for by
 * name at once and after short waits, while the kit's time allows: found,
 * it is with Meta. Not found yet, it is "checking", and the kit's poll looks
 * again (settleCheckingCarousels) until it turns up or the time is over.
 */
async function lookForLostCarousel(
  context: KitContext,
  name: string,
  cardCount: number
): Promise<CarouselOutcome> {
  const deadline = kitDeadline(context);
  let lookedAt: Date | null = null;
  for (const wait of LOST_LOOK_WAITS_MS) {
    if (Date.now() + wait + LOOKUP_TIMEOUT_MS > deadline) break;
    if (wait > 0) await pause(wait);
    lookedAt = new Date();
    const look = await sentEarlier(context, name);
    if (isFound(look)) {
      logger.info("[Products] kit carousel found after a lost answer", {
        event: "products.kit_carousel_found",
        workspaceId: context.workspaceId,
        kitId: String(context.kitId),
      });
      return submittedCarousel(
        { templateId: look.id, status: look.status, rowId: null },
        name,
        cardCount
      );
    }
  }
  return checkingCarousel(name, cardCount, lookedAt);
}

/**
 * After Meta refused the carousel while it may have one under this name: a
 * twin it refused, or any refusal of a resend after an earlier attempt's
 * answer was lost. Found, that one is this carousel (the name carries the
 * kit). Not found, a twin refusal still says Meta has it, and a look that
 * couldn't be made says nothing: either way it is "checking", never
 * refused, since Try again would then start anew under another name and
 * Meta would have two. Null when Meta has none: the refusal stands.
 */
async function carouselBehindRefusal(
  context: KitContext,
  name: string,
  cardCount: number,
  twin: boolean,
  reason: string
): Promise<CarouselOutcome | null> {
  const inTime = Date.now() + LOOKUP_TIMEOUT_MS <= kitDeadline(context);
  const look: CarouselLook = inTime
    ? await sentEarlier(context, name)
    : "unknown";
  if (isFound(look))
    return submittedCarousel(
      { templateId: look.id, status: look.status, rowId: null },
      name,
      cardCount,
      true
    );
  if (!twin && look === "absent") return null;
  logger.warn("[Products] kit carousel may be at Meta already", {
    event: "products.kit_carousel_twin_unconfirmed",
    workspaceId: context.workspaceId,
    kitId: String(context.kitId),
    twin,
    look,
    reason,
  });
  return checkingCarousel(name, cardCount, inTime ? new Date() : null);
}

/**
 * The carousel: its cards on white, stored as the template's samples, sent
 * to Meta for review through the path the template editor uses, so it is
 * in Templates too. Meta's first answer (usually PENDING) is kept.
 */
async function makeCarousel(context: KitContext): Promise<CarouselOutcome> {
  const name = context.carousel.name;
  const edited = context.carousel.components;
  // An earlier attempt's answer was lost (it timed out, or its function
  // was stopped): Meta may have its template under this very name.
  if (context.carousel.mayExist) {
    const look = await sentEarlier(context, name);
    const cards = edited
      ? carouselCardCount(edited)
      : Math.min(
          context.products.filter(product => product.photo).length,
          KIT_CAROUSEL_MAX_CARDS
        );
    if (isFound(look))
      return submittedCarousel(
        { templateId: look.id, status: look.status, rowId: null },
        name,
        cards,
        true
      );
    // Meta couldn't say: nothing is sent while it may have it. The kit's
    // poll looks again.
    if (look === "unknown") return checkingCarousel(name, cards, new Date());
  }
  // The owner's edited cards (checked when they were saved), or the
  // shelf's: its products' pictures on white, stored as header samples.
  const draft = edited
    ? null
    : await prepareCarouselDraft(
        context.workspaceId,
        { language: context.language, products: context.products },
        context.now
      );
  if (!edited && !draft)
    return {
      state: "failed",
      cardCount: 0,
      error: { code: "not_enough_products", message: null },
    };
  const components = edited ?? carouselTemplateComponents(draft!);
  const cardCount = edited ? carouselCardCount(edited) : draft!.cards.length;
  const language = draft?.language ?? context.language;
  // Kept on the kit as sent, for "Edit and send again".
  const kept = storableComponents(components);
  const checked = parseWhatsAppTemplateSubmissionComponents(
    components,
    "MARKETING"
  );
  if (!checked.success) {
    logger.error("[Products] kit carousel is not a valid template", undefined, {
      event: "products.kit_carousel_invalid",
      workspaceId: context.workspaceId,
      kitId: String(context.kitId),
    });
    return {
      state: "failed",
      cardCount,
      ...kept,
      error: { code: "failed", message: null },
    };
  }

  let sent: { templateId?: string; status?: string; rowId: string | null };
  try {
    const supabase = await createClient();
    const record = await createUnifiedTemplateRecord({
      supabase,
      workspaceId: context.workspaceId,
      userId: context.userId,
      name,
      channel: "whatsapp",
      whatsappData: {
        language,
        category: "MARKETING",
        components,
      },
      analyticsOrigin: "products",
      metaTimeoutMs: WHATSAPP_TEMPLATE_CAROUSEL_CREATE_TIMEOUT_MS,
      // Cut to leave one look by name within the kit's time.
      metaDeadlineAt: kitDeadline(context) - LOOKUP_TIMEOUT_MS,
    });
    sent = {
      templateId: record.metaTemplateId,
      status: record.metaTemplateStatus,
      rowId: record.id,
    };
  } catch (error) {
    if (!(error instanceof WhatsAppTemplateRecordPersistenceError)) {
      const failure = carouselSendError(error);
      const reason = error instanceof Error ? error.message : String(error);
      // airi stopped waiting; Meta may have it all the same.
      if (failure.code === "timed_out") {
        logger.warn("[Products] kit carousel answer lost", {
          event: "products.kit_carousel_answer_lost",
          workspaceId: context.workspaceId,
          kitId: String(context.kitId),
          reason,
        });
        return {
          ...(await lookForLostCarousel(context, name, cardCount)),
          ...kept,
        };
      }
      const refusal = graphRefusalOf(error);
      const twin = refusal !== null && isTwinRefusal(refusal);
      if (
        twin ||
        (failure.code === "meta_refused" && context.carousel.mayExist)
      ) {
        const behind = await carouselBehindRefusal(
          context,
          name,
          cardCount,
          twin,
          reason
        );
        if (behind) return { ...behind, ...kept };
      }
      logger.warn("[Products] kit carousel not sent", {
        event: "products.kit_carousel_refused",
        workspaceId: context.workspaceId,
        kitId: String(context.kitId),
        code: failure.code,
        reason,
      });
      return { state: "failed", cardCount, ...kept, error: failure };
    }
    // Meta has it; only airi's own row of it wasn't saved.
    logger.warn("[Products] kit carousel row not saved", {
      event: "products.kit_carousel_row_failed",
      workspaceId: context.workspaceId,
      kitId: String(context.kitId),
    });
    sent = {
      templateId: error.metaTemplateId,
      status: error.metaTemplateStatus,
      rowId: null,
    };
  }
  if (!sent.templateId)
    return {
      state: "failed",
      cardCount,
      ...kept,
      error: { code: "failed", message: null },
    };
  return {
    ...submittedCarousel(
      { templateId: sent.templateId, status: sent.status, rowId: sent.rowId },
      name,
      cardCount
    ),
    ...kept,
  };
}

/** Components small enough to keep on the kit, as `{components}`; nothing for bigger ones. */
function storableComponents(components: WhatsAppComponent[]): {
  components?: WhatsAppComponent[];
} {
  const bytes = new TextEncoder().encode(JSON.stringify(components)).length;
  return bytes <= PRODUCT_KIT_COMPONENTS_MAX_BYTES ? { components } : {};
}

/**
 * Saves a part's outcome. Only a part still being made (or one that timed
 * out while it was) takes it, so a late attempt never undoes a newer one.
 */
async function settlePart(
  context: KitContext,
  part: ProductKitPart,
  outcome: OrderFormOutcome | CarouselOutcome
): Promise<void> {
  const fields: Record<string, unknown> = { ...outcome, updatedAt: new Date() };
  await ProductKit.updateOne(
    {
      _id: context.kitId,
      workspaceId: context.workspaceId,
      [`parts.${part}.state`]: { $in: ["making", "failed"] },
    },
    {
      $set: Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
          `parts.${part}.${key}`,
          value,
        ])
      ),
    }
  );
}

async function runPart(context: KitContext, part: ProductKitPart) {
  let outcome: OrderFormOutcome | CarouselOutcome;
  try {
    outcome =
      part === "orderForm"
        ? await makeOrderForm(context)
        : await makeCarousel(context);
  } catch (error) {
    if (!(error instanceof StorageQuotaError))
      logger.error("[Products] kit part failed", error, {
        event: "products.kit_part_failed",
        workspaceId: context.workspaceId,
        kitId: String(context.kitId),
        part,
      });
    outcome = { state: "failed", error: thrownError(error) };
  }
  await settlePart(context, part, outcome);
}

/** Makes the parts at once; each is saved as it settles. */
async function runParts(context: KitContext, parts: ProductKitPart[]) {
  await Promise.all(parts.map(part => runPart(context, part)));
}

// ---------------------------------------------------------------- refresh

/** The kit with one part timed out, as just saved. */
function withTimedOutPart(
  doc: IProductKit,
  part: ProductKitPart,
  now: Date
): IProductKit {
  const timedOut = {
    state: "failed" as const,
    error: { code: "timed_out" as const, message: null },
    updatedAt: now,
  };
  const { orderForm, carousel } = doc.parts ?? {};
  return {
    ...doc,
    parts:
      part === "orderForm"
        ? {
            ...doc.parts,
            orderForm: orderForm && { ...orderForm, ...timedOut },
          }
        : { ...doc.parts, carousel: carousel && { ...carousel, ...timedOut } },
  };
}

/** Marks parts stuck "making" as timed out, so the owner can try again. */
async function expireStaleParts(
  doc: IProductKit,
  now: Date
): Promise<IProductKit> {
  let next = doc;
  for (const part of PRODUCT_KIT_PARTS) {
    const current = next.parts?.[part];
    if (current?.state !== "making") continue;
    if (now.getTime() - current.updatedAt.getTime() < MAKING_TIMEOUT_MS)
      continue;
    const result = await ProductKit.updateOne(
      {
        _id: doc._id,
        workspaceId: doc.workspaceId,
        [`parts.${part}.state`]: "making",
        [`parts.${part}.updatedAt`]: current.updatedAt,
      },
      {
        $set: {
          [`parts.${part}.state`]: "failed",
          [`parts.${part}.error`]: { code: "timed_out", message: null },
          [`parts.${part}.updatedAt`]: now,
        },
      }
    );
    if (result.modifiedCount > 0) {
      next = withTimedOutPart(next, part, now);
      continue;
    }
    // It settled meanwhile: read what it became.
    const latest = await findKit(doc.workspaceId, doc._id);
    if (latest) next = latest;
  }
  return next;
}

/** A "checking" carousel's time to be found is over. */
const checkingOver = (carousel: IProductKitCarouselPart, now: Date) =>
  now.getTime() - carousel.updatedAt.getTime() >= CHECKING_FOR_MS;

/** A carousel airi lost Meta's answer for, due another look (or out of time). */
function checkingDue(
  carousel: IProductKitCarouselPart | null | undefined,
  now: Date
): carousel is IProductKitCarouselPart {
  if (carousel?.state !== "checking") return false;
  return (
    !carousel.templateName ||
    checkingOver(carousel, now) ||
    now.getTime() - (carousel.checkedAt?.getTime() ?? 0) >= CHECKING_LOOK_MS
  );
}

/** Sets carousel fields while it is still "checking"; the kit as it then is. */
async function updateCheckingCarousel(
  doc: IProductKit,
  carousel: IProductKitCarouselPart,
  fields: Partial<IProductKitCarouselPart>
): Promise<IProductKit> {
  const result = await ProductKit.updateOne(
    {
      _id: doc._id,
      workspaceId: doc.workspaceId,
      "parts.carousel.state": "checking",
      "parts.carousel.updatedAt": carousel.updatedAt,
    },
    {
      $set: Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
          `parts.carousel.${key}`,
          value,
        ])
      ),
    }
  );
  if (result.modifiedCount > 0)
    return {
      ...doc,
      parts: { ...doc.parts, carousel: { ...carousel, ...fields } },
    };
  // It settled meanwhile: read what it became.
  return (await findKit(doc.workspaceId, doc._id)) ?? doc;
}

/**
 * Looks again, by name, for carousels airi lost Meta's answer for, at most
 * `reads.left` times: found, a carousel is with Meta; still missing after
 * CHECKING_FOR_MS, it wasn't made. Its name is kept, so Try again looks for
 * it first, and Meta refuses a twin of a name it has.
 */
async function settleCheckingCarousels(
  workspaceId: string,
  docs: IProductKit[],
  now: Date,
  reads: { left: number }
): Promise<IProductKit[]> {
  const due = docs.filter(doc => checkingDue(doc.parts?.carousel, now));
  if (due.length === 0) return docs;
  const whatsapp = await readKitWhatsApp(workspaceId).catch(
    (error: unknown) => {
      logger.warn("[Products] kit connection unreadable for a lookup", {
        event: "products.kit_carousel_lookup_failed",
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  );
  const settled = await Promise.all(
    due.map(async doc => {
      const carousel = doc.parts!.carousel!;
      const name = carousel.templateName;
      const lookup =
        name && whatsapp?.connected && reads.left-- > 0 ? whatsapp : null;
      // A look that couldn't be made is no answer: it waits for the next.
      const look =
        lookup && name
          ? await sentEarlier(
              {
                workspaceId,
                kitId: doc._id,
                language: doc.language,
                whatsapp: lookup,
              },
              name
            )
          : null;
      const at = new Date();
      if (isFound(look) && name) {
        // Found soon after the last look, Meta's approval came about now.
        const lookedPromptly =
          now.getTime() -
            (carousel.checkedAt ?? carousel.updatedAt).getTime() <=
          PROMPT_LOOK_MS;
        return updateCheckingCarousel(doc, carousel, {
          ...submittedCarousel(
            { templateId: look.id, status: look.status, rowId: null },
            name,
            carousel.cardCount,
            !lookedPromptly
          ),
          updatedAt: at,
        });
      }
      if (!name || checkingOver(carousel, now)) {
        logger.warn("[Products] kit carousel not found at Meta", {
          event: "products.kit_carousel_not_found",
          workspaceId,
          kitId: String(doc._id),
        });
        return updateCheckingCarousel(doc, carousel, {
          state: "failed",
          error: { code: "timed_out", message: null },
          updatedAt: at,
        });
      }
      return lookup
        ? updateCheckingCarousel(doc, carousel, { checkedAt: at })
        : doc;
    })
  );
  const byId = new Map(settled.map(doc => [String(doc._id), doc]));
  return docs.map(doc => byId.get(String(doc._id)) ?? doc);
}

function statusCheckDue(
  carousel: IProductKitCarouselPart | null | undefined,
  now: Date
): carousel is IProductKitCarouselPart & { templateId: string } {
  if (carousel?.state !== "submitted" || !carousel.templateId) return false;
  const since = now.getTime() - (carousel.checkedAt?.getTime() ?? 0);
  if (carouselVerdict(carousel.metaStatus) !== "waiting")
    return since >= DECIDED_RECHECK_MS;
  const waited = now.getTime() - (carousel.submittedAt?.getTime() ?? 0);
  return (
    since >=
    (waited >= LONG_WAIT_MS ? LONG_WAIT_RECHECK_MS : WAITING_RECHECK_MS)
  );
}

/**
 * Statuses airi's Templates rows hold for these templates; Meta's status
 * webhooks keep them current. Unreadable rows only mean asking Meta later.
 */
async function readTemplateRows(
  workspaceId: string,
  rowIds: string[]
): Promise<Map<string, string>> {
  if (rowIds.length === 0) return new Map();
  try {
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    const { data, error } = await supabaseAdmin
      .from("message_templates")
      .select("id, whatsapp_data")
      .eq("workspace_id", workspaceId)
      .in("id", rowIds);
    if (error) throw new Error(error.message);
    return new Map(
      ((data ?? []) as Array<{ id: unknown; whatsapp_data?: unknown }>).flatMap(
        row => {
          const status = (row.whatsapp_data as { status?: unknown } | null)
            ?.status;
          return typeof status === "string" && status.trim()
            ? [[String(row.id), status.trim().toUpperCase()] as const]
            : [];
        }
      )
    );
  } catch (error) {
    logger.warn("[Products] kit template rows unreadable", {
      event: "products.kit_template_rows_failed",
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}

/** Meta's rejection code in words: "INVALID_FORMAT" reads "invalid format". */
function rejectionWords(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  const words = reason.trim();
  if (!words || words.toUpperCase() === "NONE") return null;
  return clipText(
    /^[A-Z0-9_]+$/.test(words) ? words.toLowerCase().replace(/_/g, " ") : words,
    MESSAGE_MAX
  );
}

type SentCarousel = IProductKitCarouselPart & { templateId: string };

/**
 * Whether Meta itself should be asked: airi's copy still says it waits after
 * 2 minutes (it has been seen late), or it was rejected without a reason.
 */
function wantsMetaRead(
  carousel: SentCarousel,
  metaStatus: string | null,
  now: Date
): boolean {
  const verdict = carouselVerdict(metaStatus);
  if (verdict === "rejected") return !carousel.metaReason;
  return (
    verdict === "waiting" &&
    now.getTime() - (carousel.submittedAt?.getTime() ?? 0) >= META_READ_AFTER_MS
  );
}

/** Meta's own status and reason for a template; null when Meta can't be read. */
async function readMetaVerdict(
  workspaceId: string,
  templateId: string
): Promise<{ metaStatus: string | null; metaReason: string | null } | null> {
  try {
    const template = await getTemplate(workspaceId, templateId);
    return {
      metaStatus: template.status ? template.status.toUpperCase() : null,
      metaReason: rejectionWords(template.rejected_reason),
    };
  } catch (error) {
    logger.warn("[Products] kit carousel status unreadable", {
      event: "products.kit_carousel_status_failed",
      workspaceId,
      templateId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The longest a carousel waits between two looks while a page shows it (one
 * look every 5 minutes after the first 10, and a page's poll may come late
 * by up to a minute). An approval seen after a longer gap happened while
 * nobody looked, at a time nobody knows.
 */
const PROMPT_LOOK_MS = LONG_WAIT_RECHECK_MS + WAITING_RECHECK_MS;

/**
 * Saves a carousel's verdict as just read, and the kit with it. An approval
 * gets the time it was seen only when the last look was recent: the page
 * says "Meta approved it" without a time otherwise, rather than the time
 * the page was next opened.
 */
async function saveVerdict(
  workspaceId: string,
  doc: IProductKit,
  carousel: SentCarousel,
  verdict: { metaStatus: string | null; metaReason: string | null },
  now: Date
): Promise<IProductKit> {
  const seenPromptly =
    now.getTime() - (carousel.checkedAt?.getTime() ?? 0) <= PROMPT_LOOK_MS;
  const approvedAt =
    carousel.approvedAt ??
    (carouselVerdict(verdict.metaStatus) === "approved" && seenPromptly
      ? now
      : null);
  await ProductKit.updateOne(
    {
      _id: doc._id,
      workspaceId,
      "parts.carousel.templateId": carousel.templateId,
    },
    {
      $set: {
        "parts.carousel.metaStatus": verdict.metaStatus,
        "parts.carousel.metaReason": verdict.metaReason,
        "parts.carousel.approvedAt": approvedAt,
        "parts.carousel.checkedAt": now,
      },
    }
  );
  return {
    ...doc,
    parts: {
      ...doc.parts,
      carousel: { ...carousel, ...verdict, approvedAt, checkedAt: now },
    },
  };
}

/**
 * Kits as they now are: parts stuck "making" time out, a carousel airi lost
 * Meta's answer for is looked for again, and a carousel due a look has
 * Meta's verdict read again: from airi's Templates rows first (one read for
 * all), then from Meta itself. Meta is asked at most `metaReads` times in
 * all, at once.
 */
async function refreshKits(
  workspaceId: string,
  docs: IProductKit[],
  metaReads: number
): Promise<IProductKit[]> {
  const now = new Date();
  const reads = { left: metaReads };
  const fresh = await settleCheckingCarousels(
    workspaceId,
    await Promise.all(docs.map(doc => expireStaleParts(doc, now))),
    now,
    reads
  );
  const due = fresh.flatMap(doc => {
    const carousel = doc.parts?.carousel;
    return statusCheckDue(carousel, now) ? [{ doc, carousel }] : [];
  });
  if (due.length === 0) return fresh;
  const rows = await readTemplateRows(
    workspaceId,
    due.flatMap(({ carousel }) =>
      carousel.templateRowId ? [carousel.templateRowId] : []
    )
  );
  const checked = await Promise.all(
    due.map(async ({ doc, carousel }) => {
      const fromRow = {
        metaStatus:
          (carousel.templateRowId && rows.get(carousel.templateRowId)) ||
          carousel.metaStatus ||
          null,
        metaReason: carousel.metaReason ?? null,
      };
      const askMeta =
        wantsMetaRead(carousel, fromRow.metaStatus, now) && reads.left-- > 0;
      const fromMeta = askMeta
        ? await readMetaVerdict(workspaceId, carousel.templateId)
        : null;
      const verdict = {
        metaStatus: fromMeta?.metaStatus ?? fromRow.metaStatus,
        metaReason: fromMeta?.metaReason ?? fromRow.metaReason,
      };
      return saveVerdict(workspaceId, doc, carousel, verdict, now);
    })
  );
  const byId = new Map(checked.map(doc => [String(doc._id), doc]));
  return fresh.map(doc => byId.get(String(doc._id)) ?? doc);
}

// ---------------------------------------------------------------- API

/** Kits as the page reads them, with the shelf's prices now. */
async function toRecords(
  workspaceId: string,
  docs: IProductKit[]
): Promise<ProductKitRecord[]> {
  const shelf = await shelfPricesOf(workspaceId, docs);
  return docs.map(doc => toProductKitRecord(doc, shelf));
}

async function recordOf(
  workspaceId: string,
  doc: IProductKit
): Promise<ProductKitRecord> {
  const [record] = await toRecords(workspaceId, [doc]);
  return record!;
}

/** One kit as it now is, read again where due. */
async function currentRecord(
  workspaceId: string,
  doc: IProductKit
): Promise<ProductKitRecord> {
  const [fresh] = await refreshKits(workspaceId, [doc], 1);
  return recordOf(workspaceId, fresh ?? doc);
}

const isDuplicateKey = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === 11000;

/**
 * Why a kit (or one part of it) can't be made at all; nothing is written.
 * The edited carousel's name can be taken, or Meta couldn't say whether it
 * is (meta_unavailable: try again).
 */
export type ProductKitRefusal = PartRefusal | NameRefusal;

/** Why a part can't be made (or made again) at all. */
type PartRefusal = "not_enough_products" | "whatsapp_not_connected";

/**
 * The checked edits with the cards' pictures from airi's Assets copied to
 * Supabase Storage, so the kit keeps cards whose links last; issues for
 * pictures that couldn't be copied.
 */
async function keepEditedPictures(
  workspaceId: string,
  edits: CheckedEdits
): Promise<{ edits: CheckedEdits } | { invalid: string[] }> {
  if (!edits.carousel) return { edits };
  const kept = await keepCardPictures(workspaceId, edits.carousel.components);
  if (!kept.ok) return { invalid: kept.issues.slice(0, 3) };
  return {
    edits: {
      ...edits,
      carousel: { ...edits.carousel, components: kept.components },
    },
  };
}

/** The owner's edits, checked: what each edited part sends. */
type CheckedEdits = {
  carousel?: { name: string; components: WhatsAppComponent[] };
  orderForm?: { config: WhatsAppFlowConfig };
};

/**
 * The owner's edits with their content checked: the carousel by its
 * template rules and pictures, the form by the Flow's rules with the
 * shelf's products question listing only `productIds`. The issues, the
 * first 3, when either fails.
 */
function checkEdits(
  edits: ProductKitRequestEdits | null,
  productIds: readonly string[]
): { edits: CheckedEdits } | { invalid: string[] } {
  const checked: CheckedEdits = {};
  const issues: string[] = [];
  if (edits?.carousel) {
    const carousel = parseCarouselEdit(
      edits.carousel.name,
      edits.carousel.components
    );
    if (carousel.ok)
      checked.carousel = {
        name: carousel.name,
        components: carousel.components,
      };
    else issues.push(...carousel.issues);
  }
  if (edits?.orderForm) {
    const form = parseOrderFormConfig(edits.orderForm.config, productIds);
    if (form.ok) checked.orderForm = { config: form.config };
    else issues.push(...form.issues);
  }
  return issues.length > 0
    ? { invalid: issues.slice(0, 3) }
    : { edits: checked };
}

/**
 * Makes the parts asked for, at once, and answers with the kit once both
 * have settled. Checked first, before anything is written: products on the
 * shelf, a connected number, and for a carousel alone, 2 photos (asked with
 * the form, a carousel without them is skipped). A press sent again
 * (same requestId) answers with the kit it made, without making it again.
 */
export async function makeProductKit(params: {
  workspaceId: string;
  userId: string;
  request: ProductKitRequest;
}): Promise<
  | { kit: ProductKitRecord; repeated: boolean }
  | { refused: ProductKitRefusal }
  | { invalid: string[] }
> {
  const { workspaceId, userId, request } = params;
  // The kit's time counts from here: the reads, Assets copies and name
  // look below come out of the route's 60 s too.
  const startedAt = new Date();
  const earlier = await findByRequest(workspaceId, request.requestId);
  if (earlier)
    return { kit: await currentRecord(workspaceId, earlier), repeated: true };

  const shelf = await loadShelfProducts(workspaceId, request.productIds);
  if (shelf.products.length === 0) return { refused: "not_enough_products" };
  const whatsapp = await readKitWhatsApp(workspaceId);
  if (!whatsapp.connected) return { refused: "whatsapp_not_connected" };
  const checked = checkEdits(
    request.edits,
    shelf.products.map(product => product.id)
  );
  if ("invalid" in checked) return { invalid: checked.invalid };
  const kept = await keepEditedPictures(workspaceId, checked.edits);
  if ("invalid" in kept) return kept;
  const { edits } = kept;
  const photos = shelf.products.filter(product => product.photo).length;
  // The owner's edited cards carry their own pictures.
  const carouselFits =
    Boolean(edits.carousel) || photos >= KIT_CAROUSEL_MIN_CARDS;
  if (request.make.carousel && !carouselFits && !request.make.orderForm)
    return { refused: "not_enough_products" };
  const language = request.language ?? shopWords(shelf.language).code;

  // The kit's id first: its carousel's name carries it.
  const kitId: KitId = new mongoose.Types.ObjectId();
  const named = edits.carousel
    ? await carouselNameFor({
        wanted: edits.carousel.name,
        kitId,
        now: new Date(),
        taken: new Set(),
        lookup: { workspaceId, kitId, language, whatsapp },
      })
    : null;
  if (named && "refused" in named) return { refused: named.refused };
  // Its names and records carry the time its name was settled.
  const now = new Date();
  const first = firstAttempt(now, kitId);
  const attempt: Pick<KitContext, "carousel" | "orderForm"> = {
    carousel: {
      ...first.carousel,
      ...(named ? { name: named.name } : {}),
      ...(edits.carousel ? { components: edits.carousel.components } : {}),
    },
    orderForm: {
      ...first.orderForm,
      ...(edits.orderForm ? { config: edits.orderForm.config } : {}),
    },
  };
  const parts: IProductKit["parts"] = {};
  if (request.make.orderForm)
    parts.orderForm = {
      state: "making",
      productCount: edits.orderForm
        ? listedProducts(edits.orderForm.config)
        : Math.min(shelf.products.length, ORDER_FORM_MAX_PRODUCTS),
      prices: orderFormPrices(shelf.products),
      updatedAt: now,
      edited: Boolean(edits.orderForm),
      version: 1,
      ...(edits.orderForm ? { config: edits.orderForm.config } : {}),
    };
  if (request.make.carousel)
    parts.carousel = carouselFits
      ? {
          state: "making",
          // Saved before Meta is asked: a retry after a lost answer finds it.
          templateName: attempt.carousel.name,
          cardCount: edits.carousel
            ? carouselCardCount(edits.carousel.components)
            : Math.min(photos, KIT_CAROUSEL_MAX_CARDS),
          prices: carouselPrices(shelf.products),
          updatedAt: now,
          edited: Boolean(edits.carousel),
          ...(edits.carousel ? { components: edits.carousel.components } : {}),
        }
      : {
          state: "skipped",
          cardCount: 0,
          error: { code: "not_enough_products", message: null },
          updatedAt: now,
        };

  try {
    await ProductKit.create({
      _id: kitId,
      workspaceId,
      requestId: request.requestId,
      createdBy: userId,
      language,
      productIds: shelf.products.map(product => product.id),
      importId: request.importId,
      timeZone: request.timeZone,
      prices: priceSnapshot(shelf.products),
      parts,
    });
  } catch (error) {
    // The same press, sent twice at once: the other made it.
    const raced = isDuplicateKey(error)
      ? await findByRequest(workspaceId, request.requestId)
      : null;
    if (!raced) throw error;
    return { kit: await currentRecord(workspaceId, raced), repeated: true };
  }

  await runParts(
    {
      workspaceId,
      userId,
      kitId,
      language,
      timeZone: request.timeZone,
      products: shelf.products,
      whatsapp,
      now,
      deadlineFrom: startedAt,
      ...attempt,
    },
    PRODUCT_KIT_PARTS.filter(part => parts[part]?.state === "making")
  );
  const kit = await findKit(workspaceId, kitId);
  if (!kit) throw new Error("The kit wasn't found after it was made");
  // Just made with the shelf's prices: none has changed since.
  return { kit: toProductKitRecord(kit), repeated: false };
}

/** One kit as it now is; null when it isn't this workspace's. */
export async function readProductKit(
  workspaceId: string,
  kitId: string
): Promise<ProductKitRecord | null> {
  if (!isObjectIdText(kitId)) return null;
  const doc = await findKit(workspaceId, kitId);
  return doc ? currentRecord(workspaceId, doc) : null;
}

/** The workspace's newest kits, at most `limit`, as they now are. */
export async function listProductKitRecords(
  workspaceId: string,
  limit: number
): Promise<ProductKitRecord[]> {
  const docs = await ProductKit.find({ workspaceId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<IProductKit[]>();
  return toRecords(
    workspaceId,
    await refreshKits(workspaceId, docs, LIST_META_READS)
  );
}

/**
 * What an attempt to make a part again starts from. A part that timed out,
 * or failed on airi's side, may have reached Meta before its answer was
 * lost: its template name is kept (Meta is asked for it first, and refuses
 * a twin), and so is its Flow, to finish. A part Meta refused or turned
 * down starts anew. (A carousel Meta may still have is never saved as
 * refused: it is "checking" until found, or timed out with its name.) A
 * form's later version keeps its "… · v2" name either way, so Flows tells
 * its versions apart.
 */
function retryAttempt(
  part: ProductKitPart,
  doc: IProductKit,
  now: Date
): Pick<KitContext, "carousel" | "orderForm"> {
  const attempt = firstAttempt(now, doc._id);
  const current = doc.parts?.[part];
  const lost =
    current?.state === "failed" &&
    (current.error?.code === "timed_out" || current.error?.code === "failed");
  const { carousel, orderForm } = doc.parts ?? {};
  if (part === "carousel")
    return lost && carousel?.templateName && !carousel.templateId
      ? {
          ...attempt,
          carousel: { name: carousel.templateName, mayExist: true },
        }
      : attempt;
  const version = orderForm?.version ?? 1;
  const versionName =
    version > 1
      ? `${flowBaseName(orderForm?.flowName ?? orderFormName(now, doc.timeZone ?? null))} · v${version}`
      : null;
  if (lost && orderForm?.flowId)
    return {
      ...attempt,
      orderForm: {
        flowId: orderForm.flowId,
        flowName: orderForm.flowName ?? versionName,
      },
    };
  return versionName
    ? { ...attempt, orderForm: { flowId: null, flowName: versionName } }
    : attempt;
}

/** The owner's edits a kit sent, to send again: none for parts made from the shelf. */
function keptEdits(doc: IProductKit): {
  carousel?: { components: WhatsAppComponent[] };
  orderForm?: { config: WhatsAppFlowConfig };
} {
  const { carousel, orderForm } = doc.parts ?? {};
  return {
    ...(carousel?.edited && carousel.components?.length
      ? { carousel: { components: carousel.components } }
      : {}),
    ...(orderForm?.edited && orderForm.config
      ? { orderForm: { config: orderForm.config } }
      : {}),
  };
}

/** What a part is reset to while it's made again. */
function remakeFields(
  part: ProductKitPart,
  shelf: ShelfProduct[],
  now: Date,
  attempt: Pick<KitContext, "carousel" | "orderForm">
): Record<string, unknown> {
  const common = { state: "making", error: null, updatedAt: now };
  // Made again from the shelf as it is now: the part shows its prices.
  const fields =
    part === "orderForm"
      ? {
          ...common,
          flowId: attempt.orderForm.flowId,
          flowName: attempt.orderForm.flowName,
          productCount: attempt.orderForm.config
            ? listedProducts(attempt.orderForm.config)
            : Math.min(shelf.length, ORDER_FORM_MAX_PRODUCTS),
          prices: orderFormPrices(shelf),
        }
      : {
          ...common,
          templateId: null,
          // Saved before Meta is asked, as when the kit was first made.
          templateName: attempt.carousel.name,
          templateRowId: null,
          metaStatus: null,
          metaReason: null,
          approvedAt: null,
          submittedAt: null,
          checkedAt: null,
          cardCount: attempt.carousel.components
            ? carouselCardCount(attempt.carousel.components)
            : Math.min(
                shelf.filter(product => product.photo).length,
                KIT_CAROUSEL_MAX_CARDS
              ),
          prices: carouselPrices(shelf),
        };
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      `parts.${part}.${key}`,
      value,
    ])
  );
}

/**
 * Makes one part of a kit again: a part that wasn't made (or timed out), or
 * a carousel Meta turned down for good, which is sent as a new template. The
 * other part is left as it is. Any other part answers with the kit as is,
 * so a repeated press does nothing. Null when the kit isn't this workspace's.
 */
export async function retryProductKitPart(params: {
  workspaceId: string;
  userId: string;
  kitId: string;
  part: ProductKitPart;
}): Promise<{ kit: ProductKitRecord } | { refused: PartRefusal } | null> {
  const { workspaceId, userId, kitId, part } = params;
  if (!isObjectIdText(kitId)) return null;
  const found = await findKit(workspaceId, kitId);
  if (!found) return null;
  const doc = await expireStaleParts(found, new Date());
  const current = doc.parts?.[part];
  if (!current || !kitPartCanRetry(part, current))
    return { kit: await recordOf(workspaceId, doc) };

  const whatsapp = await readKitWhatsApp(workspaceId);
  if (!whatsapp.connected) return { refused: "whatsapp_not_connected" };
  const shelf = await loadShelfProducts(workspaceId, doc.productIds);
  const photos = shelf.products.filter(product => product.photo).length;
  // The owner's edits go again, as they were sent: not the shelf's.
  const edits = keptEdits(doc);
  if (
    shelf.products.length === 0 ||
    (part === "carousel" && !edits.carousel && photos < KIT_CAROUSEL_MIN_CARDS)
  )
    return { refused: "not_enough_products" };

  const now = new Date();
  const retried = retryAttempt(part, doc, now);
  const attempt: Pick<KitContext, "carousel" | "orderForm"> = {
    carousel: { ...retried.carousel, ...edits.carousel },
    orderForm: { ...retried.orderForm, ...edits.orderForm },
  };
  const claimed = await ProductKit.updateOne(
    {
      _id: doc._id,
      workspaceId,
      [`parts.${part}.state`]: current.state,
      [`parts.${part}.updatedAt`]: current.updatedAt,
    },
    { $set: remakeFields(part, shelf.products, now, attempt) }
  );
  if (claimed.modifiedCount > 0)
    await runParts(
      {
        workspaceId,
        userId,
        kitId: doc._id,
        language: doc.language,
        timeZone: doc.timeZone ?? null,
        products: shelf.products,
        whatsapp,
        now,
        ...attempt,
      },
      [part]
    );
  // Another press claimed it first: answer with the kit as that one leaves it.
  const kit = await findKit(workspaceId, doc._id);
  return { kit: await recordOf(workspaceId, kit ?? doc) };
}

// ---------------------------------------------------------------- editing

/** Meta's answers that refuse a part outright, rather than airi failing to ask. */
const META_REFUSALS: ReadonlySet<ProductKitPartErrorCode> = new Set([
  "meta_refused",
  "template_limit",
]);

/** What sending a made part again with the owner's edits answers. */
export type ProductKitEditOutcome =
  | { kit: ProductKitRecord }
  | {
      refused: ProductKitRefusal | "kit_part_busy" | "invalid_request";
      /** The kit as it now is, when the refusal changed what it shows (a carousel now looked for). */
      kit?: ProductKitRecord;
    }
  | { invalid: string[] }
  /** The carousel an earlier send lost the answer for was at Meta after all: the edits weren't sent. */
  | { carouselFound: ProductKitRecord }
  /** Meta refused the edited part, in its own words; the kit keeps what it held. */
  | { metaRefused: { words: string | null; kit: ProductKitRecord } };

/** What an edit of one kit part works with. */
type EditBase = {
  workspaceId: string;
  userId: string;
  doc: IProductKit;
  whatsapp: { accessToken: string; wabaId: string };
  shelf: ShelfProduct[];
  requestId: string;
  /** When the edit's request began: the kit's time counts from it. */
  startedAt: Date;
};

/** A part's fields as one $set. */
const partFields = (part: ProductKitPart, fields: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      `parts.${part}.${key}`,
      value,
    ])
  );

const editContext = (
  base: EditBase,
  now: Date,
  attempt: Pick<KitContext, "carousel" | "orderForm">
): KitContext => ({
  workspaceId: base.workspaceId,
  userId: base.userId,
  kitId: base.doc._id,
  language: base.doc.language,
  timeZone: base.doc.timeZone ?? null,
  products: base.shelf,
  whatsapp: base.whatsapp,
  now,
  deadlineFrom: base.startedAt,
  ...attempt,
});

/**
 * Takes the part for this edit, while it is as it was read: null when
 * taken, or the answer when another press got there first (this same press
 * answers with the kit; any other means the part is busy).
 */
async function claimPart(
  base: EditBase,
  part: ProductKitPart,
  current: { state: string; updatedAt: Date },
  fields: Record<string, unknown>
): Promise<ProductKitEditOutcome | null> {
  const { workspaceId, doc } = base;
  const claimed = await ProductKit.updateOne(
    {
      _id: doc._id,
      workspaceId,
      [`parts.${part}.state`]: current.state,
      [`parts.${part}.updatedAt`]: current.updatedAt,
    },
    { $set: partFields(part, fields) }
  );
  if (claimed.modifiedCount > 0) return null;
  const latest = await findKit(workspaceId, doc._id);
  if (latest?.parts?.[part]?.lastEditRequestId === base.requestId)
    return { kit: await recordOf(workspaceId, latest) };
  return { refused: "kit_part_busy" };
}

/**
 * Puts back what a part held before an edit Meta refused, while the part
 * is still as that refusal left it; the kit as it then is.
 */
async function restorePart(
  base: EditBase,
  part: ProductKitPart,
  refusedAt: Date,
  fields: Record<string, unknown>
): Promise<IProductKit | null> {
  const { workspaceId, doc } = base;
  await ProductKit.updateOne(
    {
      _id: doc._id,
      workspaceId,
      [`parts.${part}.state`]: { $in: ["failed", "draft"] },
      [`parts.${part}.updatedAt`]: refusedAt,
    },
    { $set: partFields(part, { ...fields, updatedAt: new Date() }) }
  );
  return findKit(workspaceId, doc._id);
}

/** A carousel with Meta as it was before an edit: what a refused edit puts back. */
const heldCarousel = (carousel: IProductKitCarouselPart) => ({
  state: carousel.state,
  templateId: carousel.templateId ?? null,
  templateName: carousel.templateName ?? null,
  templateRowId: carousel.templateRowId ?? null,
  cardCount: carousel.cardCount,
  prices: carousel.prices ?? null,
  metaStatus: carousel.metaStatus ?? null,
  metaReason: carousel.metaReason ?? null,
  approvedAt: carousel.approvedAt ?? null,
  submittedAt: carousel.submittedAt ?? null,
  checkedAt: carousel.checkedAt ?? null,
  error: carousel.error ?? null,
  components: carousel.components ?? null,
  edited: carousel.edited === true,
  earlier: carousel.earlier ?? [],
});

/** A published form as it was before an edit: what a refused new version puts back. */
const heldOrderForm = (form: IProductKitOrderFormPart) => ({
  state: form.state,
  flowId: form.flowId ?? null,
  flowName: form.flowName ?? null,
  productCount: form.productCount,
  prices: form.prices ?? null,
  error: form.error ?? null,
  config: form.config ?? null,
  edited: form.edited === true,
  version: form.version ?? 1,
  earlier: form.earlier ?? [],
});

/**
 * "Edit and send again" / "Edit and try again": the owner's cards go to
 * Meta as a new template, through the same path as Make. A carousel whose
 * answer was lost is looked for at Meta first, so nothing goes twice: found,
 * it is with Meta and the edits aren't sent (carouselFound). One with Meta
 * is remembered in `earlier`; if Meta refuses the new one, the kit goes on
 * pointing at it.
 */
async function editCarousel(
  base: EditBase,
  carousel: IProductKitCarouselPart,
  edit: { name: string; components: WhatsAppComponent[] }
): Promise<ProductKitEditOutcome> {
  const { workspaceId, doc } = base;
  const lookup: CarouselLookup = {
    workspaceId,
    kitId: doc._id,
    language: doc.language,
    whatsapp: base.whatsapp,
  };
  const keptName = carousel.templateName;
  const lost =
    carousel.state === "failed" &&
    !carousel.templateId &&
    Boolean(keptName) &&
    (carousel.error?.code === "timed_out" || carousel.error?.code === "failed");
  let lostLook: CarouselLook | null = null;
  if (lost && keptName) {
    const look = await sentEarlier(lookup, keptName);
    lostLook = look;
    if (isFound(look)) {
      logger.info("[Products] kit carousel found before an edit", {
        event: "products.kit_carousel_found",
        workspaceId,
        kitId: String(doc._id),
      });
      await ProductKit.updateOne(
        {
          _id: doc._id,
          workspaceId,
          "parts.carousel.state": "failed",
          "parts.carousel.updatedAt": carousel.updatedAt,
        },
        {
          $set: partFields("carousel", {
            ...submittedCarousel(
              { templateId: look.id, status: look.status, rowId: null },
              keptName,
              carousel.cardCount,
              true
            ),
            updatedAt: new Date(),
          }),
        }
      );
      const kit = await findKit(workspaceId, doc._id);
      return { carouselFound: await recordOf(workspaceId, kit ?? doc) };
    }
    // Meta couldn't say: nothing new goes while it may have the first.
    if (look === "unknown") return { refused: "meta_unavailable" };
    // A send that failed moments ago (a dropped connection, say) may have
    // reached Meta, which can take a while to list it: it is looked for
    // as a lost answer is ("checking", its 3 minutes counted from the
    // failure), and the edits go once it is found or its time is over.
    if (
      carousel.error?.code === "failed" &&
      Date.now() - carousel.updatedAt.getTime() < CHECKING_FOR_MS
    ) {
      await ProductKit.updateOne(
        {
          _id: doc._id,
          workspaceId,
          "parts.carousel.state": "failed",
          "parts.carousel.updatedAt": carousel.updatedAt,
        },
        {
          $set: partFields("carousel", {
            ...checkingCarousel(keptName, carousel.cardCount, new Date()),
            updatedAt: carousel.updatedAt,
          }),
        }
      );
      const kit = await findKit(workspaceId, doc._id);
      return {
        refused: "kit_part_busy",
        kit: await recordOf(workspaceId, kit ?? doc),
      };
    }
  }

  // The part's own name, when Meta refused it or doesn't list it, never
  // made a template: the owner may press the same name again. (Were it at
  // Meta after all, Meta refuses the twin, and the part is "checking".)
  const taken = sentNames(carousel);
  if (
    carousel.state === "failed" &&
    !carousel.templateId &&
    keptName &&
    ((carousel.error && META_REFUSALS.has(carousel.error.code)) ||
      lostLook === "absent")
  )
    taken.delete(keptName);
  const named = await carouselNameFor({
    wanted: edit.name,
    kitId: doc._id,
    now: new Date(),
    taken,
    lookup,
  });
  if ("refused" in named) return named;
  const now = new Date();
  const earlier =
    carousel.state === "submitted"
      ? [
          ...(carousel.earlier ?? []),
          {
            templateId: carousel.templateId ?? null,
            templateName: carousel.templateName ?? null,
            metaStatus: carousel.metaStatus ?? null,
            replacedAt: now,
          },
        ].slice(-PRODUCT_KIT_EARLIER_MAX)
      : (carousel.earlier ?? []);
  const busy = await claimPart(base, "carousel", carousel, {
    state: "making",
    error: null,
    updatedAt: now,
    templateId: null,
    // Saved before Meta is asked: a retry after a lost answer finds it.
    templateName: named.name,
    templateRowId: null,
    metaStatus: null,
    metaReason: null,
    approvedAt: null,
    submittedAt: null,
    checkedAt: null,
    cardCount: carouselCardCount(edit.components),
    prices: carouselPrices(base.shelf),
    components: edit.components,
    edited: true,
    earlier,
    lastEditRequestId: base.requestId,
  });
  if (busy) return busy;

  await runParts(
    editContext(base, now, {
      carousel: {
        name: named.name,
        mayExist: false,
        components: edit.components,
      },
      orderForm: { flowId: null, flowName: null },
    }),
    ["carousel"]
  );
  const after = await findKit(workspaceId, doc._id);
  const settled = after?.parts?.carousel;
  if (
    after &&
    settled?.state === "failed" &&
    settled.error &&
    META_REFUSALS.has(settled.error.code)
  ) {
    // The kit goes on with the carousel it had; this press may be sent again.
    const kit =
      (await restorePart(base, "carousel", settled.updatedAt, {
        ...(carousel.state === "submitted" ? heldCarousel(carousel) : {}),
        lastEditRequestId: carousel.lastEditRequestId ?? null,
      })) ?? after;
    return {
      metaRefused: {
        words: settled.error.message ?? null,
        kit: await recordOf(workspaceId, kit),
      },
    };
  }
  return { kit: await recordOf(workspaceId, after ?? doc) };
}

/** A form's name without its version: "Order form · 2 Nov 09:14" from "… · v3". */
const flowBaseName = (name: string) => name.replace(/ · v\d+$/, "");

/**
 * "Edit order form" / "Edit and publish": a published form gets a new Flow
 * as its next version ("… · v2"), since forms already sent keep opening the
 * one they have and published Flows can't be changed or deleted; the old
 * one is remembered in `earlier`. A draft is given the edits in place and
 * published; a form without a Flow gets one. If Meta refuses a new version,
 * its Flow is deleted and the kit goes on with the published one.
 */
async function editOrderForm(
  base: EditBase,
  form: IProductKitOrderFormPart,
  config: WhatsAppFlowConfig
): Promise<ProductKitEditOutcome> {
  const { workspaceId, doc } = base;
  const status =
    form.state === "ready"
      ? "published"
      : form.flowId
        ? await earlierFlow(base, form.flowId)
        : null;
  // Meta couldn't say what became of the form's Flow: nothing is written,
  // so no second Flow is made beside it and the kit keeps it.
  if (status === "unknown") return { refused: "meta_unavailable" };
  const now = new Date();
  const newVersion = status === "published";
  const version = (form.version ?? 1) + (newVersion ? 1 : 0);
  const named = form.flowName ?? orderFormName(now, doc.timeZone ?? null);
  const flowName =
    version > 1 && status !== "draft"
      ? `${flowBaseName(named)} · v${version}`
      : named;
  const flowId = status === "draft" ? form.flowId! : null;
  const earlier =
    newVersion && form.flowId
      ? [
          ...(form.earlier ?? []),
          {
            flowId: form.flowId,
            flowName: form.flowName ?? null,
            replacedAt: now,
          },
        ].slice(-PRODUCT_KIT_EARLIER_MAX)
      : (form.earlier ?? []);
  const busy = await claimPart(base, "orderForm", form, {
    state: "making",
    error: null,
    updatedAt: now,
    flowId,
    flowName,
    productCount: listedProducts(config),
    prices: orderFormPrices(base.shelf),
    config,
    edited: true,
    version,
    earlier,
    lastEditRequestId: base.requestId,
  });
  if (busy) return busy;

  await runParts(
    editContext(base, now, {
      carousel: { name: "", mayExist: false },
      orderForm: { flowId, flowName, config },
    }),
    ["orderForm"]
  );
  const after = await findKit(workspaceId, doc._id);
  const settled = after?.parts?.orderForm;
  const refused =
    settled?.state === "draft" ||
    (settled?.state === "failed" &&
      Boolean(settled.error && META_REFUSALS.has(settled.error.code)));
  if (!after || !settled || !refused)
    return { kit: await recordOf(workspaceId, after ?? doc) };
  if (
    newVersion &&
    settled.state === "draft" &&
    settled.flowId &&
    settled.flowId !== form.flowId
  ) {
    // An unpublished Flow can go: the published one stays the form. (One
    // whose JSON Meta refused was deleted as it was refused.)
    try {
      await deleteMetaWhatsAppFlow({
        accessToken: base.whatsapp.accessToken,
        flowId: settled.flowId,
      });
    } catch (error) {
      logger.warn("[Products] kit order form version not deleted", {
        event: "products.kit_order_form_version_delete_failed",
        workspaceId,
        kitId: String(doc._id),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const kit =
    (await restorePart(base, "orderForm", settled.updatedAt, {
      ...(newVersion ? heldOrderForm(form) : {}),
      lastEditRequestId: form.lastEditRequestId ?? null,
    })) ?? after;
  return {
    metaRefused: {
      words: settled.error?.message ?? null,
      kit: await recordOf(workspaceId, kit),
    },
  };
}

/**
 * Sends one made part again with the owner's edits, through the same path
 * as Make: the carousel as a new template, the order form as a new version
 * (or in place, for a draft). Checked first, before anything is written:
 * the part can be edited now (409 kit_part_busy while it's made or looked
 * for), the edit's content, a connected number. The same requestId again
 * answers with the kit as it is. Null when the kit isn't this workspace's.
 */
export async function editProductKitPart(params: {
  workspaceId: string;
  userId: string;
  kitId: string;
  request: ProductKitEditInput;
}): Promise<ProductKitEditOutcome | null> {
  const { workspaceId, userId, kitId, request } = params;
  // The kit's time counts from here: the Assets copies and looks by name
  // below come out of the route's 60 s too.
  const startedAt = new Date();
  if (!isObjectIdText(kitId)) return null;
  const found = await findKit(workspaceId, kitId);
  if (!found) return null;
  const doc = await expireStaleParts(found, new Date());
  const current = doc.parts?.[request.part];
  if (current?.lastEditRequestId === request.requestId)
    return { kit: await recordOf(workspaceId, doc) };
  if (kitPartBusy(current)) return { refused: "kit_part_busy" };
  if (!current || !kitPartCanEdit(request.part, current))
    return { refused: "invalid_request" };
  const checked = checkEdits(
    request.part === "carousel"
      ? {
          carousel: { name: request.name, components: request.components },
        }
      : { orderForm: { config: request.config } },
    doc.productIds
  );
  if ("invalid" in checked) return checked;
  const whatsapp = await readKitWhatsApp(workspaceId);
  if (!whatsapp.connected) return { refused: "whatsapp_not_connected" };
  const kept = await keepEditedPictures(workspaceId, checked.edits);
  if ("invalid" in kept) return kept;
  const shelf = await loadShelfProducts(workspaceId, doc.productIds);
  const base: EditBase = {
    workspaceId,
    userId,
    doc,
    whatsapp,
    shelf: shelf.products,
    requestId: request.requestId,
    startedAt,
  };
  return request.part === "carousel"
    ? editCarousel(
        base,
        current as IProductKitCarouselPart,
        kept.edits.carousel!
      )
    : editOrderForm(
        base,
        current as IProductKitOrderFormPart,
        kept.edits.orderForm!.config
      );
}

/**
 * What "Edit and send again" or "Edit order form" opens with: the part as
 * it was sent (kits from before v2 kept nothing, so it's made again from the
 * shelf), the carousel under a new name for this kit. Null when the kit
 * isn't this workspace's.
 */
export async function productKitEditSource(params: {
  workspaceId: string;
  kitId: string;
  part: ProductKitPart;
}): Promise<
  | ProductKitEditSourceResponse
  | { refused: "not_enough_products" | "invalid_request" }
  | null
> {
  const { workspaceId, kitId, part } = params;
  if (!isObjectIdText(kitId)) return null;
  const doc = await findKit(workspaceId, kitId);
  if (!doc) return null;
  const stored = doc.parts?.[part];
  if (!stored || stored.state === "skipped")
    return { refused: "invalid_request" };
  const kit = await currentRecord(workspaceId, doc);
  const shelf = () => loadShelfProducts(workspaceId, doc.productIds);
  if (part === "carousel") {
    let components = doc.parts?.carousel?.components ?? null;
    if (!components?.length) {
      const draft = await prepareCarouselDraft(workspaceId, {
        language: doc.language,
        products: (await shelf()).products,
      });
      if (!draft) return { refused: "not_enough_products" };
      components = carouselTemplateComponents(draft);
    }
    return {
      kit,
      carousel: {
        name: carouselTemplateName(new Date(), doc._id),
        language: doc.language,
        components,
      },
    };
  }
  let config = doc.parts?.orderForm?.config ?? null;
  if (!config) {
    const { products } = await shelf();
    if (products.length === 0) return { refused: "not_enough_products" };
    config = buildOrderFormFlowConfig(products, doc.language);
  }
  return { kit, orderForm: { config } };
}

/**
 * "Edit cards" before Make: the carousel the shelf would make for these
 * products, as template components (its pictures on white, stored as
 * header samples), under a name that is made again for the kit at Make.
 */
export async function prepareProductKitDrafts(
  workspaceId: string,
  request: ProductKitDraftsRequest
): Promise<ProductKitDraftsResponse | { refused: "not_enough_products" }> {
  const shelf = await loadShelfProducts(workspaceId, request.productIds);
  if (shelf.products.length === 0) return { refused: "not_enough_products" };
  const now = new Date();
  const draft = await prepareCarouselDraft(
    workspaceId,
    { language: request.language, products: shelf.products },
    now
  );
  if (!draft) return { refused: "not_enough_products" };
  return {
    carousel: {
      // No kit yet: a name of the same shape, made again for the kit at Make.
      name: carouselTemplateName(now, new mongoose.Types.ObjectId()),
      language: request.language,
      components: carouselTemplateComponents(draft),
      productIds: draft.cards.map(card => card.productId),
      leftOut: draft.leftOut,
    },
  };
}

/** A shelf product as the make view shows it. */
async function toPlanProduct(
  workspaceId: string,
  product: ShelfProduct
): Promise<ProductKitPlanProduct> {
  const picture =
    product.thumb ?? product.photo?.cutout ?? product.photo?.original ?? null;
  return {
    id: product.id,
    name: product.name,
    price: product.price,
    currency: product.currency,
    priceIsFrom: product.priceIsFrom,
    hasPhoto: Boolean(product.photo),
    hasCutout: Boolean(product.photo?.cutout),
    imageUrl: picture ? await productPhotoUrl(workspaceId, picture) : null,
  };
}

/**
 * What the make view needs before the press: the products as their cards
 * and form lines will read, the buyers' language by default, whether a
 * number is connected, and the kit last made from this import's review.
 */
export async function readProductKitPlan(params: {
  workspaceId: string;
  productIds: readonly string[];
  importId: string | null;
}): Promise<ProductKitPlanResponse> {
  const { workspaceId, importId } = params;
  const shelf = await loadShelfProducts(workspaceId, params.productIds);
  const [products, whatsapp, latest] = await Promise.all([
    withProductPhotoUrls(() =>
      Promise.all(
        shelf.products.map(product => toPlanProduct(workspaceId, product))
      )
    ),
    productsWhatsAppConnection(workspaceId),
    importId
      ? ProductKit.findOne({ workspaceId, importId })
          .sort({ createdAt: -1 })
          .lean<IProductKit>()
      : Promise.resolve(null),
  ]);
  return {
    language: shopWords(shelf.language).code,
    languageIsSpoken: spokeShopWordsLanguage(shelf.language),
    products,
    whatsapp,
    latestKit: latest ? await currentRecord(workspaceId, latest) : null,
  };
}
