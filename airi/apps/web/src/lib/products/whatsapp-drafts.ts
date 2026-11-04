import "server-only";
import { generateFlowJsonString } from "@/components/scenarios/builders/whatsapp/flow-json-generator";
import { validateWhatsAppFlowConfig } from "@/components/scenarios/builders/whatsapp/flow-validation";
import { logger } from "@/lib/logger";
import {
  carouselCardText,
  KIT_CAROUSEL_MAX_CARDS,
  KIT_CAROUSEL_MIN_CARDS,
  ORDER_FORM_MAX_PRODUCTS,
} from "@/lib/products/kit-text";
import { buildOrderFormFlowConfig } from "@/lib/products/order-form-config";
import {
  productPhotoUrl,
  withProductPhotoUrls,
} from "@/lib/products/photo-urls";
import { shopWords } from "@/lib/products/shop-words";
import type { ProductCarouselDraft, StoredFileRef } from "@/lib/products/types";
import {
  createMetaWhatsAppFlow,
  deleteMetaWhatsAppFlow,
  updateMetaWhatsAppFlow,
  type WhatsAppFlowServiceResult,
} from "@/lib/whatsapp/flows/service";
import { storeWhatsAppTemplateHeaderMedia } from "@/lib/whatsapp/templates/header-media-storage";
import { ProductVideoImport } from "@/models/product-video-import";
import { WorkspaceProduct } from "@/models/workspace-product";
import { StorageQuotaError } from "@icecore/airi-runtime/storage-quota";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";

// What the owner can make on WhatsApp from shelf products: a carousel
// template's cards, on white, and an order form saved on Meta as a Flow. Kits
// (kits.ts) send both to Meta in one press; the import's own carousel and
// order-form routes still make them one at a time. Buyers read them, so
// they're written in the buyers' language (the one the owner spoke, unless
// the owner chose another); the words themselves are in kit-text.ts.

/** A product a video added to the shelf, as the drafts use it. */
export type AddedProduct = {
  id: string;
  name: string;
  price: number | null;
  /**
   * The price's ISO currency code; null when none was said or shown: the
   * price reads as a bare amount.
   */
  currency: string | null;
  priceIsFrom: boolean;
  /** Its featured option's photo: the transparent cut-out, or the item as filmed. */
  photo: { cutout?: StoredFileRef; original?: StoredFileRef } | null;
};

/** A stored item's photo files: the cut-out, its small copy and the item as filmed. */
export type PhotoRow = {
  cutout?: Partial<StoredFileRef>;
  thumb?: Partial<StoredFileRef>;
  original?: Partial<StoredFileRef>;
};

export const storedRef = (ref: Partial<StoredFileRef> | undefined) =>
  ref?.bucket && ref.path ? { bucket: ref.bucket, path: ref.path } : undefined;

/** A stored product as the drafts read it, with `ADDED_PRODUCT_FIELDS`. */
export type AddedProductRow = {
  _id: unknown;
  name?: string;
  price?: number | null;
  currency?: string | null;
  priceIsFrom?: boolean;
  featuredOption?: number;
  options?: Array<{ photo?: PhotoRow }>;
};

/** The product fields `toAddedProduct` reads. */
export const ADDED_PRODUCT_FIELDS =
  "name price currency priceIsFrom featuredOption options.photo";

/** The photo of a stored product's featured item (its first item's when that one is gone). */
export function featuredPhoto<Photo>(row: {
  featuredOption?: number;
  options?: Array<{ photo?: Photo }>;
}): Photo | undefined {
  const options = row.options ?? [];
  return (options[row.featuredOption ?? 0] ?? options[0])?.photo;
}

/** A stored product as the drafts use it, with its featured item's photo. */
export function toAddedProduct(row: AddedProductRow): AddedProduct {
  const photo = featuredPhoto(row);
  const cutout = storedRef(photo?.cutout);
  const original = storedRef(photo?.original);
  return {
    id: String(row._id),
    name: row.name ?? "",
    price: typeof row.price === "number" ? row.price : null,
    currency: typeof row.currency === "string" ? row.currency : null,
    priceIsFrom: row.priceIsFrom === true,
    photo:
      cutout || original
        ? {
            ...(cutout ? { cutout } : {}),
            ...(original ? { original } : {}),
          }
        : null,
  };
}

/**
 * The products an import added to the shelf, in the order they were filmed,
 * and the language the owner spoke; null when the import isn't this
 * workspace's.
 */
export async function loadAddedProducts(
  workspaceId: string,
  importId: string
): Promise<{ language: string | null; products: AddedProduct[] } | null> {
  const found = await ProductVideoImport.findOne({ _id: importId, workspaceId })
    .select("language")
    .lean<{ language?: string | null }>();
  if (!found) return null;
  const rows = await WorkspaceProduct.find({
    workspaceId,
    importId,
    status: "published",
  })
    .sort({ importIndex: 1, _id: 1 })
    .select(ADDED_PRODUCT_FIELDS)
    .lean<AddedProductRow[]>();
  return {
    language: found.language ?? null,
    products: rows.map(toAddedProduct),
  };
}

// Meta crops carousel images to the first card's shape: square suits
// products. The product fills most of it, on white.
const CARD_SIZE = 1080;
const PRODUCT_SHARE = 0.8;
const PHOTO_FETCH_TIMEOUT_MS = 15_000;
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

async function downloadPhoto(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(PHOTO_FETCH_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`Photo download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_PHOTO_BYTES) throw new Error("Photo too large");
  return bytes;
}

/**
 * A carousel card's picture: the product centred on white, as a square
 * JPEG. A cut-out is trimmed to the product first; a photo as filmed is
 * shown whole.
 */
export async function whiteCardImage(
  photo: Buffer,
  kind: "cutout" | "original"
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const inner = Math.round(CARD_SIZE * PRODUCT_SHARE);
  const source = kind === "cutout" ? sharp(photo).trim() : sharp(photo);
  const product = await source
    .resize({ width: inner, height: inner, fit: "inside" })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: CARD_SIZE,
      height: CARD_SIZE,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite([{ input: product, gravity: "centre" }])
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

/** The card picture for one product, stored as a template header sample; null without a photo. */
async function cardPicture(
  workspaceId: string,
  product: AddedProduct
): Promise<string | null> {
  const kind = product.photo?.cutout ? "cutout" : "original";
  const url = await productPhotoUrl(
    workspaceId,
    product.photo?.cutout ?? product.photo?.original
  );
  if (!url) return null;
  try {
    const stored = await storeWhatsAppTemplateHeaderMedia({
      workspaceId,
      fileName: `product-${product.id}.jpg`,
      buffer: await whiteCardImage(await downloadPhoto(url), kind),
      mimeType: "image/jpeg",
    });
    return stored.url;
  } catch (error) {
    // Storage being full is the owner's to fix; a photo that won't load
    // only leaves its product off the cards.
    if (error instanceof StorageQuotaError) throw error;
    logger.warn("[Products] carousel card picture failed", {
      event: "products.carousel_picture_failed",
      workspaceId,
      productId: product.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** A template name Meta takes: lowercase, digits and underscores. */
function templateName(now: Date): string {
  const stamp = now
    .toISOString()
    .slice(0, 16)
    .replace(/[-:]/g, "")
    .replace("T", "_");
  return `products_${stamp}`;
}

/**
 * The carousel the owner opens in the template editor: one card per added
 * product, up to the 10 a carousel holds, each with its picture on white,
 * its name and price, and an order button. Null when fewer than two
 * products have a picture, since a carousel needs two cards.
 */
export async function prepareCarouselDraft(
  workspaceId: string,
  added: { language: string | null; products: AddedProduct[] },
  now: Date = new Date()
): Promise<ProductCarouselDraft | null> {
  const words = shopWords(added.language);
  const chosen = added.products
    .filter(product => product.photo)
    .slice(0, KIT_CAROUSEL_MAX_CARDS);
  const pictures = await withProductPhotoUrls(() =>
    Promise.all(chosen.map(product => cardPicture(workspaceId, product)))
  );
  const cards = chosen.flatMap((product, index) => {
    const imageUrl = pictures[index];
    if (!imageUrl) return [];
    return [
      {
        productId: product.id,
        imageUrl,
        bodyText: carouselCardText(product, words).text,
        buttonText: words.orderButton,
      },
    ];
  });
  if (cards.length < KIT_CAROUSEL_MIN_CARDS) return null;
  return {
    name: templateName(now),
    language: words.code,
    bodyText: words.carouselBody,
    cards,
    leftOut: added.products.length - cards.length,
  };
}

// The order form's config moved to order-form-config.ts (client safe), so
// "Edit questions" builds it in the page; it's re-exported here for the
// server code that imported it from this file.
export { buildOrderFormFlowConfig } from "@/lib/products/order-form-config";

const failureMessage = (result: WhatsAppFlowServiceResult) =>
  result.error ||
  (result.validation_errors?.length
    ? JSON.stringify(result.validation_errors).slice(0, 300)
    : `Meta answered ${result.status}`);

/**
 * Saves the order form on Meta as a draft Flow: created empty, then given
 * its JSON, the way airi's own Flow provisioning does. A draft Meta refused
 * the JSON for is deleted rather than left broken. A failure says whether
 * the form itself was invalid or Meta refused it, in Meta's words. Given a
 * draft an earlier attempt created (`flowId`), it gives that one the JSON
 * instead of creating another.
 */
export async function createOrderFormDraft(params: {
  accessToken: string;
  wabaId: string;
  products: AddedProduct[];
  language: string | null;
  /** The Flow's name in WhatsApp Flows; "Order form <UTC time>" by default. */
  name?: string;
  now?: Date;
  /** A draft Flow an earlier attempt created and never finished. */
  flowId?: string;
  /**
   * The questions to send instead of the shelf's: the owner's edit, as
   * parseOrderFormConfig passed it. `products` still counts what it lists.
   */
  config?: WhatsAppFlowConfig;
  /**
   * Told the new Flow's id as soon as Meta made it, before its JSON: a
   * caller stopped after this point can finish that Flow next time.
   */
  onCreated?: (flowId: string) => Promise<void> | void;
}): Promise<
  | { ok: true; flowId: string; name: string; leftOut: number }
  | { ok: false; reason: "invalid" | "refused"; error: string }
> {
  const config =
    params.config ?? buildOrderFormFlowConfig(params.products, params.language);
  const { isValid, issues } = validateWhatsAppFlowConfig(config);
  if (!isValid)
    return {
      ok: false,
      reason: "invalid",
      error: `The order form is invalid: ${issues.map(issue => issue.code).join(", ")}`,
    };
  const name =
    params.name ??
    `Order form ${(params.now ?? new Date())
      .toISOString()
      .slice(0, 16)
      .replace("T", " ")}`;
  let flowId = params.flowId;
  if (!flowId) {
    const created = await createMetaWhatsAppFlow({
      accessToken: params.accessToken,
      wabaId: params.wabaId,
      name,
      categories: ["OTHER"],
    });
    flowId = created.providerFlowId ?? created.flow?.id;
    if (!created.ok || !flowId) {
      if (flowId)
        await deleteMetaWhatsAppFlow({
          accessToken: params.accessToken,
          flowId,
        }).catch(() => undefined);
      return { ok: false, reason: "refused", error: failureMessage(created) };
    }
    await params.onCreated?.(flowId);
  }
  const uploaded = await updateMetaWhatsAppFlow({
    accessToken: params.accessToken,
    flowId,
    operation: "update_json",
    flowJson: generateFlowJsonString(config),
  });
  if (!uploaded.ok) {
    await deleteMetaWhatsAppFlow({
      accessToken: params.accessToken,
      flowId,
    }).catch(() => undefined);
    return { ok: false, reason: "refused", error: failureMessage(uploaded) };
  }
  return {
    ok: true,
    flowId,
    name,
    leftOut: Math.max(0, params.products.length - ORDER_FORM_MAX_PRODUCTS),
  };
}
