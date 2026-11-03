import "server-only";
import { logger } from "@/lib/logger";
import { carouselTemplateComponents } from "@/lib/products/carousel-components";
import {
  isObjectIdText,
  type ProductKitRequest,
} from "@/lib/products/kit-request";
import {
  carouselVerdict,
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
  shopWords,
  spokeShopWordsLanguage,
  type ShopPrice,
} from "@/lib/products/shop-words";
import {
  PRODUCT_KIT_PARTS,
  type ProductKitPart,
  type ProductKitPartError,
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
  getMetaWhatsAppFlow,
  updateMetaWhatsAppFlow,
} from "@/lib/whatsapp/flows/service";
import { getWhatsAppWorkspaceContext } from "@/lib/whatsapp/get-workspace-context";
import { parseWhatsAppTemplateSubmissionComponents } from "@/lib/whatsapp/templates/component-schemas";
import { WhatsAppTemplateGraphRefusalError } from "@/lib/whatsapp/templates/graph-response";
import {
  findWhatsAppTemplateByName,
  getTemplate,
} from "@/lib/whatsapp/templates/service";
import {
  createUnifiedTemplateRecord,
  WhatsAppTemplateRecordPersistenceError,
} from "@/lib/whatsapp/templates/unified-service";
import {
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

// Kits: the carousel and the order form one press makes from shelf products,
// for customers on WhatsApp. The carousel goes straight to Meta for review,
// the way the template editor sends one; the order form is published. Both
// run at once inside the request, and each part is saved as it settles, so a
// part that worked is never undone by the other failing, and leaving the page
// loses nothing. A failed part is made again on its own.

/** A part still "making" this long after its last change has stopped: functions end at 60 s. */
const MAKING_TIMEOUT_MS = 90_000;
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

/** products_YYYYMMDD_HHMMSS (UTC): two kits a minute apart don't clash at Meta. */
export function carouselTemplateName(now: Date): string {
  return `products_${now
    .toISOString()
    .slice(0, 19)
    .replace(/[-:]/g, "")
    .replace("T", "_")}`;
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
   * The carousel's template name for this attempt, saved on the kit before
   * Meta is asked; `mayExist` when an earlier attempt sent it under that
   * name and its answer was lost, so Meta is asked for it first.
   */
  carousel: { name: string; mayExist: boolean };
  /** The Flow an earlier attempt made before its answer was lost, to finish; null for none. */
  orderForm: { flowId: string | null; flowName: string | null };
};

/** A first attempt: nothing made before it. */
const firstAttempt = (
  now: Date
): Pick<KitContext, "carousel" | "orderForm"> => ({
  carousel: { name: carouselTemplateName(now), mayExist: false },
  orderForm: { flowId: null, flowName: null },
});

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

/**
 * Why sending the carousel failed: Meta's refusal in its own words (its
 * template limit apart), or airi's own call timing out, or failing some
 * other way, which Meta had no part in.
 */
function carouselSendError(error: unknown): ProductKitStoredError {
  const chain = causesOf(error);
  const refusal = chain.find(
    (entry): entry is WhatsAppTemplateGraphRefusalError =>
      entry instanceof WhatsAppTemplateGraphRefusalError
  );
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
 * a draft (to finish), or neither (gone, or stopped by Meta: make another).
 */
async function earlierFlow(
  context: KitContext,
  flowId: string
): Promise<"published" | "draft" | null> {
  const read = await getMetaWhatsAppFlow({
    accessToken: context.whatsapp.accessToken,
    flowId,
    expectedWabaId: context.whatsapp.wabaId,
  });
  const status = read.ok ? String(read.flow?.status ?? "").toUpperCase() : "";
  return status === "PUBLISHED"
    ? "published"
    : status === "DRAFT"
      ? "draft"
      : null;
}

/** The order form: saved as a Flow, then published; a Flow Meta won't publish stays a draft. */
async function makeOrderForm(context: KitContext): Promise<OrderFormOutcome> {
  const { accessToken, wabaId } = context.whatsapp;
  const productCount = Math.min(
    context.products.length,
    ORDER_FORM_MAX_PRODUCTS
  );
  const name =
    context.orderForm.flowName ?? orderFormName(context.now, context.timeZone);
  // An earlier attempt's answer was lost after Meta made its Flow: finish
  // that one rather than publish a second (published Flows can't be deleted).
  const earlier = context.orderForm.flowId
    ? await earlierFlow(context, context.orderForm.flowId)
    : null;
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
  const flow = { flowId: draft.flowId, flowName: draft.name, productCount };
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

/**
 * The template an earlier attempt sent under this name, when Meta has it.
 * Null when it hasn't, or can't be asked now: the same name sent again,
 * Meta refuses a twin, so nothing goes to review twice.
 */
async function sentEarlier(
  context: KitContext,
  name: string
): Promise<{ id: string; status: string } | null> {
  try {
    return await findWhatsAppTemplateByName({
      accessToken: context.whatsapp.accessToken,
      wabaId: context.whatsapp.wabaId,
      name,
      language: context.language,
    });
  } catch (error) {
    logger.warn("[Products] kit carousel lookup failed", {
      event: "products.kit_carousel_lookup_failed",
      workspaceId: context.workspaceId,
      kitId: String(context.kitId),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The carousel: its cards on white, stored as the template's samples, sent
 * to Meta for review through the path the template editor uses, so it is
 * in Templates too. Meta's first answer (usually PENDING) is kept.
 */
async function makeCarousel(context: KitContext): Promise<CarouselOutcome> {
  const name = context.carousel.name;
  // An earlier attempt's answer was lost (it timed out, or its function
  // was stopped): Meta may have its template under this very name.
  if (context.carousel.mayExist) {
    const found = await sentEarlier(context, name);
    if (found)
      return submittedCarousel(
        { templateId: found.id, status: found.status, rowId: null },
        name,
        Math.min(
          context.products.filter(product => product.photo).length,
          KIT_CAROUSEL_MAX_CARDS
        ),
        true
      );
  }
  const draft = await prepareCarouselDraft(
    context.workspaceId,
    { language: context.language, products: context.products },
    context.now
  );
  if (!draft)
    return {
      state: "failed",
      cardCount: 0,
      error: { code: "not_enough_products", message: null },
    };
  const cardCount = draft.cards.length;
  const components = carouselTemplateComponents(draft);
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
        language: draft.language,
        category: "MARKETING",
        components,
      },
      analyticsOrigin: "products",
    });
    sent = {
      templateId: record.metaTemplateId,
      status: record.metaTemplateStatus,
      rowId: record.id,
    };
  } catch (error) {
    if (!(error instanceof WhatsAppTemplateRecordPersistenceError)) {
      const failure = carouselSendError(error);
      logger.warn("[Products] kit carousel not sent", {
        event: "products.kit_carousel_refused",
        workspaceId: context.workspaceId,
        kitId: String(context.kitId),
        code: failure.code,
        reason: error instanceof Error ? error.message : String(error),
      });
      return { state: "failed", cardCount, error: failure };
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
      error: { code: "failed", message: null },
    };
  return submittedCarousel(
    { templateId: sent.templateId, status: sent.status, rowId: sent.rowId },
    name,
    cardCount
  );
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
 * Kits as they now are: parts stuck "making" time out, and a carousel due a
 * look has Meta's verdict read again: from airi's Templates rows first (one
 * read for all), then from Meta itself, at most `metaReads` times, at once.
 */
async function refreshKits(
  workspaceId: string,
  docs: IProductKit[],
  metaReads: number
): Promise<IProductKit[]> {
  const now = new Date();
  const fresh = await Promise.all(docs.map(doc => expireStaleParts(doc, now)));
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
  let reads = metaReads;
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
        wantsMetaRead(carousel, fromRow.metaStatus, now) && reads-- > 0;
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

/** Why a kit (or one part of it) can't be made at all; nothing is written. */
export type ProductKitRefusal =
  | "not_enough_products"
  | "whatsapp_not_connected";

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
  { kit: ProductKitRecord; repeated: boolean } | { refused: ProductKitRefusal }
> {
  const { workspaceId, userId, request } = params;
  const earlier = await findByRequest(workspaceId, request.requestId);
  if (earlier)
    return { kit: await currentRecord(workspaceId, earlier), repeated: true };

  const shelf = await loadShelfProducts(workspaceId, request.productIds);
  if (shelf.products.length === 0) return { refused: "not_enough_products" };
  const whatsapp = await readKitWhatsApp(workspaceId);
  if (!whatsapp.connected) return { refused: "whatsapp_not_connected" };
  const photos = shelf.products.filter(product => product.photo).length;
  const carouselFits = photos >= KIT_CAROUSEL_MIN_CARDS;
  if (request.make.carousel && !carouselFits && !request.make.orderForm)
    return { refused: "not_enough_products" };

  const now = new Date();
  const attempt = firstAttempt(now);
  const parts: IProductKit["parts"] = {};
  if (request.make.orderForm)
    parts.orderForm = {
      state: "making",
      productCount: Math.min(shelf.products.length, ORDER_FORM_MAX_PRODUCTS),
      prices: orderFormPrices(shelf.products),
      updatedAt: now,
    };
  if (request.make.carousel)
    parts.carousel = carouselFits
      ? {
          state: "making",
          // Saved before Meta is asked: a retry after a lost answer finds it.
          templateName: attempt.carousel.name,
          cardCount: Math.min(photos, KIT_CAROUSEL_MAX_CARDS),
          prices: carouselPrices(shelf.products),
          updatedAt: now,
        }
      : {
          state: "skipped",
          cardCount: 0,
          error: { code: "not_enough_products", message: null },
          updatedAt: now,
        };
  const language = request.language ?? shopWords(shelf.language).code;

  let kitId: KitId;
  try {
    const created = await ProductKit.create({
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
    kitId = created._id;
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
 * down starts anew.
 */
function retryAttempt(
  part: ProductKitPart,
  doc: IProductKit,
  now: Date
): Pick<KitContext, "carousel" | "orderForm"> {
  const attempt = firstAttempt(now);
  const current = doc.parts?.[part];
  const lost =
    current?.state === "failed" &&
    (current.error?.code === "timed_out" || current.error?.code === "failed");
  if (!lost) return attempt;
  const { carousel, orderForm } = doc.parts ?? {};
  if (part === "carousel" && carousel?.templateName && !carousel.templateId)
    return {
      ...attempt,
      carousel: { name: carousel.templateName, mayExist: true },
    };
  if (part === "orderForm" && orderForm?.flowId)
    return {
      ...attempt,
      orderForm: {
        flowId: orderForm.flowId,
        flowName: orderForm.flowName ?? null,
      },
    };
  return attempt;
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
          productCount: Math.min(shelf.length, ORDER_FORM_MAX_PRODUCTS),
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
          cardCount: Math.min(
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
}): Promise<{ kit: ProductKitRecord } | { refused: ProductKitRefusal } | null> {
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
  if (
    shelf.products.length === 0 ||
    (part === "carousel" && photos < KIT_CAROUSEL_MIN_CARDS)
  )
    return { refused: "not_enough_products" };

  const now = new Date();
  const attempt = retryAttempt(part, doc, now);
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
