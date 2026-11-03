// Kits made from shelf products, for customers on WhatsApp: a carousel sent
// to Meta for review and a published order form, made by one press. What the
// kit API answers and takes. Re-exported by types.ts, so the page and the API
// import it from there.

import type { ProductShopWordsCode } from "@icecore/temporal";
import type { ProductAdRecord } from "./types-ad";

/** The parts a kit can have. */
export const PRODUCT_KIT_PARTS = ["orderForm", "carousel"] as const;
export type ProductKitPart = (typeof PRODUCT_KIT_PARTS)[number];

/**
 * The order form: being made, ready (published on WhatsApp), draft (Meta
 * wouldn't publish it, so it's kept as a draft), failed, or skipped (not asked
 * for).
 */
export const PRODUCT_KIT_ORDER_FORM_STATES = [
  "making",
  "ready",
  "draft",
  "failed",
  "skipped",
] as const;
export type ProductKitOrderFormState =
  (typeof PRODUCT_KIT_ORDER_FORM_STATES)[number];

/**
 * The carousel: being made, submitted (with Meta, whose verdict is in
 * `metaStatus`), failed, or skipped (not asked for, or too few photos).
 */
export const PRODUCT_KIT_CAROUSEL_STATES = [
  "making",
  "submitted",
  "failed",
  "skipped",
] as const;
export type ProductKitCarouselState =
  (typeof PRODUCT_KIT_CAROUSEL_STATES)[number];

/** The kit as a whole, derived from its parts. */
export const PRODUCT_KIT_STATUSES = [
  "making",
  "waiting_for_meta",
  "ready",
  "needs_attention",
] as const;
export type ProductKitStatus = (typeof PRODUCT_KIT_STATUSES)[number];

/** Why a part wasn't made, as a code the kit's card explains. */
export const PRODUCT_KIT_PART_ERROR_CODES = [
  "whatsapp_not_connected",
  "not_enough_products",
  "storage_full",
  "meta_refused",
  // Meta refused the carousel: the account has as many templates as it allows.
  "template_limit",
  "timed_out",
  "failed",
] as const;
export type ProductKitPartErrorCode =
  (typeof PRODUCT_KIT_PART_ERROR_CODES)[number];

export type ProductKitPartError = {
  code: ProductKitPartErrorCode;
  /** Meta's own words for a refusal, up to 300 characters; null otherwise. */
  message: string | null;
};

export type ProductKitOrderFormPart = {
  state: ProductKitOrderFormState;
  flowId: string | null;
  flowName: string | null;
  /** Products the form lists (it holds the first 20). */
  productCount: number;
  error: ProductKitPartError | null;
};

export type ProductKitCarouselPart = {
  state: ProductKitCarouselState;
  templateId: string | null;
  templateName: string | null;
  /** Cards it has (the first 10 products with photos). */
  cardCount: number;
  /** Meta's status: PENDING, APPROVED, REJECTED, PAUSED, DISABLED…; null until sent. */
  metaStatus: string | null;
  /** Meta's reason for a rejection, when it gave one. */
  metaReason: string | null;
  approvedAt: string | null;
  error: ProductKitPartError | null;
};

/** A carousel and an order form made by one press. */
export type ProductKitRecord = {
  id: string;
  createdAt: string;
  /** The language buyers read it in. */
  language: ProductShopWordsCode;
  /** In shelf order. */
  productIds: string[];
  /** The import whose review it was made from; null for products chosen on the shelf. */
  importId: string | null;
  /** Only the parts asked for. */
  parts: {
    orderForm?: ProductKitOrderFormPart;
    carousel?: ProductKitCarouselPart;
  };
  status: ProductKitStatus;
  /** A shelf price changed after it was made, so it shows an old one. */
  pricesChanged: boolean;
};

/** POST /products/kits: make the parts asked for, both at once. */
export type ProductKitCreateRequest = {
  /** The page's id for this press, so a repeat returns the same kit. */
  requestId: string;
  /** 1 to 60, in shelf order. */
  productIds: string[];
  importId?: string;
  make: { carousel: boolean; orderForm: boolean };
  /** Defaults to the language the owner spoke in the newest of their videos. */
  language?: ProductShopWordsCode;
  /** The owner's IANA time zone, so the form's name has their clock's time; UTC without it. */
  timeZone?: string;
};

/** The most products one kit is made from. */
export const PRODUCT_KIT_MAX_PRODUCTS = 60;

/** One product as the make view shows it: what its card and its line on the form say. */
export type ProductKitPlanProduct = {
  id: string;
  name: string;
  price: number | null;
  currency: string | null;
  priceIsFrom: boolean;
  /** Whether it has a photo for a carousel card: its cut-out, or the item as filmed. */
  hasPhoto: boolean;
  /** Whether it has a cut-out: a video ad shows only those. */
  hasCutout: boolean;
  /** That photo's link (the cut-out's small copy when there is one); null without one. */
  imageUrl: string | null;
};

/** GET /products/kits?products=…&importId=…: what the make view needs before the press. */
export type ProductKitPlanResponse = {
  /** The buyers' language by default: the one spoken in the newest video of these products. */
  language: ProductShopWordsCode;
  /**
   * Whether `language` is the one the owner spoke; false when they spoke
   * another (Uzbek, say) or it wasn't heard, and buyers get English.
   */
  languageIsSpoken: boolean;
  /** The published ones among those asked for, in the order asked. */
  products: ProductKitPlanProduct[];
  whatsapp: { connected: boolean; displayPhone: string | null };
  /** The newest kit made from this import's review, so its status shows again; null without one. */
  latestKit: ProductKitRecord | null;
};

/** POST /products/kits/[kitId]/retry: make one failed part again. */
export type ProductKitRetryRequest = { part: ProductKitPart };

export type ProductKitResponse = { kit: ProductKitRecord };

/** GET /products/made: what the owner made from the shelf, newest first, 20 of each. */
export type ProductsMadeResponse = {
  kits: ProductKitRecord[];
  ads: ProductAdRecord[];
  whatsapp: { connected: boolean; displayPhone: string | null };
};
