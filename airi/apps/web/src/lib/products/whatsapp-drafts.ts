import "server-only";
import { generateFlowJsonString } from "@/components/scenarios/builders/whatsapp/flow-json-generator";
import { validateWhatsAppFlowConfig } from "@/components/scenarios/builders/whatsapp/flow-validation";
import { logger } from "@/lib/logger";
import {
  productPhotoUrl,
  withProductPhotoUrls,
} from "@/lib/products/photo-urls";
import {
  formatProductPrice,
  type ProductCarouselDraft,
  type StoredFileRef,
} from "@/lib/products/types";
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
import { WHATSAPP_TEMPLATE_LIMITS } from "@icecore/shared/constants/whatsapp-templates";

// What the owner can make on WhatsApp from the products a video added to the
// shelf, both finished by the owner in airi: a carousel template, whose cards
// go to the template editor, and an order form, saved on Meta as a draft
// Flow. Buyers read them, so they're written in the language the owner spoke.

/** A product a video added to the shelf, as the drafts use it. */
export type AddedProduct = {
  id: string;
  name: string;
  price: number | null;
  priceIsFrom: boolean;
  /** Its featured option's photo: the transparent cut-out, or the item as filmed. */
  photo: { cutout?: StoredFileRef; original?: StoredFileRef } | null;
};

type ShopWords = {
  /** Meta's code for the language. */
  code: "kk" | "ru" | "en";
  from: (amount: string) => string;
  carouselBody: string;
  orderButton: string;
  form: {
    title: string;
    products: string;
    name: string;
    address: string;
    comment: string;
    submit: string;
    cta: string;
  };
};

const SHOP_WORDS: Record<ShopWords["code"], ShopWords> = {
  kk: {
    code: "kk",
    from: amount => `${amount} бастап`,
    carouselBody: "Біздің тауарлар. Ұнағанын таңдап, тапсырыс беріңіз.",
    orderButton: "Тапсырыс беру",
    form: {
      title: "Тапсырыс",
      products: "Не алғыңыз келеді?",
      name: "Атыңыз",
      address: "Жеткізу мекенжайы",
      comment: "Түсініктеме",
      submit: "Тапсырысты жіберу",
      cta: "Тапсырыс беру",
    },
  },
  ru: {
    code: "ru",
    from: amount => `от ${amount}`,
    carouselBody: "Наши товары. Выберите, что понравится, и закажите.",
    orderButton: "Заказать",
    form: {
      title: "Заказ",
      products: "Что хотите заказать?",
      name: "Имя",
      address: "Адрес доставки",
      comment: "Комментарий",
      submit: "Отправить заказ",
      cta: "Заказать",
    },
  },
  en: {
    code: "en",
    from: amount => `from ${amount}`,
    carouselBody: "Our products. Pick the one you like and order it here.",
    orderButton: "Order",
    form: {
      title: "Order",
      products: "What would you like?",
      name: "Name",
      address: "Delivery address",
      comment: "Comment",
      submit: "Send order",
      cta: "Order",
    },
  },
};

/**
 * The words buyers see, in the language the owner spoke as Muse Spark named
 * it ("Kazakh", "Russian", "kk"…); English for any other.
 */
export function shopWords(language: string | null | undefined): ShopWords {
  if (/kaz|қаз|^kk\b/i.test(language ?? "")) return SHOP_WORDS.kk;
  if (/rus|рус|^ru\b/i.test(language ?? "")) return SHOP_WORDS.ru;
  return SHOP_WORDS.en;
}

/** "15 500 ₸", or the shop's way of saying "from 15 500 ₸". */
function buyerPrice(product: AddedProduct, words: ShopWords): string | null {
  if (product.price === null) return null;
  const amount = formatProductPrice(product.price);
  return product.priceIsFrom ? words.from(amount) : amount;
}

/** At most `max` characters, cut at the end with "…" and no dangling comma. */
const clip = (text: string, max: number) =>
  text.length > max
    ? `${text.slice(0, max - 1).replace(/[\s,.;:–-]+$/u, "")}…`
    : text;

type PhotoRow = {
  cutout?: Partial<StoredFileRef>;
  original?: Partial<StoredFileRef>;
};

const storedRef = (ref: Partial<StoredFileRef> | undefined) =>
  ref?.bucket && ref.path ? { bucket: ref.bucket, path: ref.path } : undefined;

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
    .select("name price priceIsFrom featuredOption options.photo")
    .lean<
      Array<{
        _id: unknown;
        name?: string;
        price?: number | null;
        priceIsFrom?: boolean;
        featuredOption?: number;
        options?: Array<{ photo?: PhotoRow }>;
      }>
    >();
  return {
    language: found.language ?? null,
    products: rows.map(row => {
      const options = row.options ?? [];
      const photo = (options[row.featuredOption ?? 0] ?? options[0])?.photo;
      const cutout = storedRef(photo?.cutout);
      const original = storedRef(photo?.original);
      return {
        id: String(row._id),
        name: row.name ?? "",
        price: typeof row.price === "number" ? row.price : null,
        priceIsFrom: row.priceIsFrom === true,
        photo:
          cutout || original
            ? {
                ...(cutout ? { cutout } : {}),
                ...(original ? { original } : {}),
              }
            : null,
      };
    }),
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
    .slice(0, WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARDS_MAX);
  const pictures = await withProductPhotoUrls(() =>
    Promise.all(chosen.map(product => cardPicture(workspaceId, product)))
  );
  const cards = chosen.flatMap((product, index) => {
    const imageUrl = pictures[index];
    if (!imageUrl) return [];
    const price = buyerPrice(product, words);
    const maxName =
      WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARD_BODY_MAX_LENGTH -
      (price ? price.length + 1 : 0);
    const name = clip(product.name, maxName);
    return [
      {
        productId: product.id,
        imageUrl,
        bodyText: price ? `${name}\n${price}` : name,
        buttonText: words.orderButton,
      },
    ];
  });
  if (cards.length < WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARDS_MIN) return null;
  return {
    name: templateName(now),
    language: words.code,
    bodyText: words.carouselBody,
    cards,
    leftOut: added.products.length - cards.length,
  };
}

// A CheckboxGroup lists at most 20 items, each title at most 30 characters.
export const ORDER_FORM_MAX_PRODUCTS = 20;
const OPTION_TITLE_MAX = 30;

/**
 * The order form, one screen: the products to tick (by product id), the
 * buyer's name, where to deliver, and a comment. WhatsApp already gives the
 * buyer's number.
 */
export function buildOrderFormFlowConfig(
  products: AddedProduct[],
  language: string | null
): WhatsAppFlowConfig {
  const words = shopWords(language);
  return {
    templateId: "products_order_form",
    ctaText: words.form.cta,
    flowSubmitLabel: words.form.submit,
    flowNavigationMode: "linear",
    flowJsonVersion: "6.3",
    categories: ["OTHER"],
    screens: [
      {
        id: "ORDER",
        title: words.form.title,
        fields: [
          {
            id: "products",
            label: words.form.products,
            fieldType: "CheckboxGroup",
            required: true,
            options: products.slice(0, ORDER_FORM_MAX_PRODUCTS).map(product => {
              const price = buyerPrice(product, words);
              return {
                id: product.id,
                title: clip(product.name, OPTION_TITLE_MAX),
                ...(price ? { description: price } : {}),
              };
            }),
          },
          {
            id: "name",
            label: words.form.name,
            fieldType: "TextInput",
            required: true,
          },
          {
            id: "address",
            label: words.form.address,
            fieldType: "TextArea",
            required: false,
          },
          {
            id: "comment",
            label: words.form.comment,
            fieldType: "TextArea",
            required: false,
          },
        ],
      },
    ],
  };
}

const failureMessage = (result: WhatsAppFlowServiceResult) =>
  result.error ||
  (result.validation_errors?.length
    ? JSON.stringify(result.validation_errors).slice(0, 300)
    : `Meta answered ${result.status}`);

/**
 * Saves the order form on Meta as a draft Flow the owner checks and
 * publishes in WhatsApp Flows: created empty, then given its JSON, the way
 * airi's own Flow provisioning does. A draft Meta refused the JSON for is
 * deleted rather than left broken.
 */
export async function createOrderFormDraft(params: {
  accessToken: string;
  wabaId: string;
  products: AddedProduct[];
  language: string | null;
  now?: Date;
}): Promise<
  | { ok: true; flowId: string; name: string; leftOut: number }
  | { ok: false; error: string }
> {
  const config = buildOrderFormFlowConfig(params.products, params.language);
  const { isValid, issues } = validateWhatsAppFlowConfig(config);
  if (!isValid)
    return {
      ok: false,
      error: `The order form is invalid: ${issues.map(issue => issue.code).join(", ")}`,
    };
  const name = `Order form ${(params.now ?? new Date())
    .toISOString()
    .slice(0, 16)
    .replace("T", " ")}`;
  const created = await createMetaWhatsAppFlow({
    accessToken: params.accessToken,
    wabaId: params.wabaId,
    name,
    categories: ["OTHER"],
  });
  const flowId = created.providerFlowId ?? created.flow?.id;
  if (!created.ok || !flowId) {
    if (flowId)
      await deleteMetaWhatsAppFlow({
        accessToken: params.accessToken,
        flowId,
      }).catch(() => undefined);
    return { ok: false, error: failureMessage(created) };
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
    return { ok: false, error: failureMessage(uploaded) };
  }
  return {
    ok: true,
    flowId,
    name,
    leftOut: Math.max(0, params.products.length - ORDER_FORM_MAX_PRODUCTS),
  };
}
