// Products: the workspace's own catalog, which the owner fills by filming
// their shelf. Shared by the panel page, the API and the models.

/**
 * A product found in a video starts as a draft. The owner's review either
 * publishes it (buyers and the AI seller see it) or rejects it.
 */
export const WORKSPACE_PRODUCT_STATUSES = [
  "draft",
  "published",
  "rejected",
] as const;
export type WorkspaceProductStatus =
  (typeof WORKSPACE_PRODUCT_STATUSES)[number];

/** How a video reached airi: uploaded in the panel, or sent on WhatsApp. */
export const PRODUCT_VIDEO_IMPORT_SOURCES = ["upload", "whatsapp"] as const;
export type ProductVideoImportSource =
  (typeof PRODUCT_VIDEO_IMPORT_SOURCES)[number];

export const PRODUCT_VIDEO_IMPORT_STATUSES = [
  "queued",
  "processing",
  "ready",
  "failed",
] as const;
export type ProductVideoImportStatus =
  (typeof PRODUCT_VIDEO_IMPORT_STATUSES)[number];

// The import job's own vocabulary and price rules, shared with the worker
// that runs it.
export {
  PRODUCT_DOUBT_SUBJECTS,
  PRODUCT_MAX_PRICE,
  PRODUCT_PHOTO_METHODS,
  PRODUCT_PRICE_MAX_DECIMALS,
  PRODUCT_TEXT_SOURCES,
  PRODUCT_UNKNOWN_CURRENCY_DOUBT,
  PRODUCT_VIDEO_IMPORT_ERROR_CODES,
  PRODUCT_VIDEO_IMPORT_MAX_PRODUCTS,
  PRODUCT_VIDEO_IMPORT_PHOTO_CONCURRENCY,
  PRODUCT_VIDEO_IMPORT_PHOTO_STOPS,
  PRODUCT_VIDEO_IMPORT_STAGES,
  PRODUCT_VIDEO_MAX_BYTES,
  PRODUCT_VIDEO_MAX_SECONDS,
  hasAtMostDecimals,
  parseTypedPrice,
  productCurrency,
  productPriceDecimals,
  toMinorUnits,
  type ProductDoubt,
  type ProductDoubtSubject,
  type ProductPhotoMethod,
  type ProductTextSource,
  type ProductVideoImportErrorCode,
  type ProductVideoImportPhotoStop,
  type ProductVideoImportStage,
} from "@icecore/temporal";
import {
  PRODUCT_MAX_PRICE,
  productCurrency,
  productPriceDecimals,
  toMinorUnits,
  type ProductDoubt,
  type ProductPhotoMethod,
  type ProductTextSource,
  type ProductVideoImportErrorCode,
  type ProductVideoImportPhotoStop,
  type ProductVideoImportStage,
} from "@icecore/temporal";
import type { ProductKitRecord } from "./types-kit";

/** A file in the workspace's private media storage. */
export type StoredFileRef = { bucket: string; path: string };

/** Published products one list returns; far above a small shop's shelf. */
export const MAX_LISTED_PRODUCTS = 1000;

/** One published product as the Products page lists it. */
export type WorkspaceProductRecord = {
  id: string;
  name: string;
  /** An amount in `currency`, to its decimals, or null while the owner hasn't set a price. */
  price: number | null;
  /** The price's ISO code ("KZT", "USD"); null when no currency was said or shown. */
  currency: string | null;
  /** A starting price, shown as "from …": the final one depends on options. */
  priceIsFrom: boolean;
  /** Its featured option cut out of the video on a transparent background, or null. */
  imageUrl: string | null;
  /**
   * Whether that photo is a cut-out: a product with no clear view keeps
   * the whole frame as its photo, which a video ad can't show.
   */
  hasCutout?: boolean;
  updatedAt: string | null;
  /** The video it was found in; the Products list sends it, to count the shelf's videos. */
  importId?: string | null;
};

export type ProductsListResponse = {
  products: WorkspaceProductRecord[];
};

/** One item shown for a product, as the owner checks its photo. */
export type DraftProductOptionRecord = {
  /** A few English words that tell it apart from the product's other options. */
  description: string;
  photoMethod: ProductPhotoMethod;
  /** Small WebP copy of the cut-out. */
  imageUrl: string | null;
  /** The full-size cut-out. */
  photoUrl: string | null;
  /** The item as filmed, to compare the cleaned-up photo with. */
  originalUrl: string | null;
  /** Seconds into the video where the photo was taken. */
  videoMomentSeconds: number | null;
  /** Degrees the photo was turned to stand level, clockwise; 0 when it wasn't. */
  straightenedDegrees: number;
  /** What the owner should know about the photo, in English. */
  notes: string[];
};

/** A product an import found, as the owner checks it before publishing. */
export type DraftProductRecord = WorkspaceProductRecord & {
  status: WorkspaceProductStatus;
  /** The catalog name in English, beside the owner's own `name`. */
  englishName: string | null;
  /** Whether `name` was said in the video or only written on screen. */
  nameSource: ProductTextSource | null;
  /** The narration's words, or the video's text, the price came from. */
  priceQuote: string | null;
  priceSource: ProductTextSource | null;
  /** What the owner should confirm, in English; those about the price go once it's set. */
  doubts: ProductDoubt[];
  /** The items shown for it, in the order shown. */
  options: DraftProductOptionRecord[];
  /** The option the shelf shows, as an index into `options`. */
  featuredOption: number;
  /** A short clip of the video with sound: the owner saying its price. */
  clipUrl: string | null;
};

export type ProductVideoImportRecord = {
  id: string;
  status: ProductVideoImportStatus;
  stage: ProductVideoImportStage | null;
  /** Products found so far, their options' photos, and how many photos are made. */
  productTotal: number;
  photoTotal: number;
  photoDone: number;
  errorCode: ProductVideoImportErrorCode | null;
  /**
   * Why photos stopped being made before every one was; the import still
   * finished with the products it found. Null when none stopped.
   */
  photosStopped: ProductVideoImportPhotoStop | null;
  /**
   * Whether products it found are still drafts, waiting for the owner's
   * check. The list of imports looks once one has finished, so it's false
   * there while one runs.
   */
  draftsLeft: boolean;
  /**
   * The person who presents the products in the video, cut out to reuse
   * beside them later; null when nobody presents them or it isn't made yet.
   */
  presenter: {
    /** Small WebP copy of the cut-out. */
    imageUrl: string | null;
    /** The full-size transparent cut-out. */
    photoUrl: string | null;
    /** The frame as filmed. */
    originalUrl: string | null;
  } | null;
  createdAt: string | null;
  finishedAt: string | null;
};

export type ProductVideoImportResponse = {
  import: ProductVideoImportRecord;
  products: DraftProductRecord[];
};

/** The longest name a product may have. */
export const MAX_PRODUCT_NAME_LENGTH = 160;
/** A sanity cap on prices, in the price's own currency. */
export const MAX_PRODUCT_PRICE = PRODUCT_MAX_PRICE;

/**
 * What the owner may change about a product while checking it: its name,
 * its price (null for none yet) with its currency, and which option the
 * shelf shows.
 */
export type ProductChanges = {
  name?: string;
  price?: number | null;
  /** The price's ISO code, sent with a price. */
  currency?: string;
  featuredOption?: number;
};

export type ProductUpdateResponse = { product: DraftProductRecord };

/**
 * The owner's decision on some of an import's products: published adds them
 * to the shelf, rejected skips them, and draft undoes either.
 */
export type ProductReviewRequest = {
  productIds: string[];
  status: WorkspaceProductStatus;
};

/** How many of the products changed; those already in that state don't count. */
export type ProductReviewResponse = { changed: number };

/**
 * A carousel template made from the products a video added to the shelf,
 * for the owner to finish in airi's template editor and send to Meta.
 */
export type ProductCarouselDraft = {
  /** A template name Meta takes, such as "products_20261028_1432". */
  name: string;
  /** Meta's code for the language the owner spoke: kk, ru or en. */
  language: string;
  /** The message above the cards. */
  bodyText: string;
  /** One per product: its picture on white (a public link), name and price, and an order button. */
  cards: Array<{
    productId: string;
    imageUrl: string;
    bodyText: string;
    buttonText: string;
  }>;
  /** Added products not on a card: past the 10 a carousel holds, or without a photo. */
  leftOut: number;
};

export type ProductCarouselDraftResponse = { draft: ProductCarouselDraft };

/**
 * How a phone came to be linked: an admin confirmed it in airi, it's the
 * workspace's own connected number, or it sent a one-time code (how phones
 * were linked before admins confirmed them).
 */
export const PRODUCTS_WHATSAPP_LINK_VIAS = [
  "approved",
  "connected_number",
  "code",
] as const;
export type ProductsWhatsAppLinkVia =
  (typeof PRODUCTS_WHATSAPP_LINK_VIAS)[number];

/** A phone that asked to be linked, waiting for an admin to say it's theirs. */
export type ProductsWhatsAppLinkRequestRecord = {
  id: string;
  /** Masked, such as "+7 ••• ••• 12 34". */
  phone: string;
  /** The name on its WhatsApp profile, when it has one. */
  profileName: string | null;
  /** When the phone last asked. */
  createdAt: string;
};

/** A phone linked to the workspace: the shelf videos it sends to Airi land here. */
export type ProductsWhatsAppLinkedPhoneRecord = {
  id: string;
  /** Masked, such as "+7 ••• ••• 12 34". */
  phone: string;
  via: ProductsWhatsAppLinkVia;
  /** Null for a connected number, which is linked by its first video. */
  linkedAt: string | null;
  lastVideoAt: string | null;
};

/**
 * How long opening the "Send from WhatsApp" panel keeps the shop open to
 * phones asking to be linked. The open panel opens it again before then.
 */
export const PRODUCTS_WHATSAPP_PAIRING_TTL_MS = 15 * 60_000;

/**
 * The "Send from WhatsApp" panel. While it's open the shop is open to phones
 * asking to be linked: `pairing` is the link that opens WhatsApp to airi's
 * number with a message naming the shop. A phone that sends it waits in
 * `requests` until an admin confirms it, and then joins `linkedPhones`.
 * `businessNumbers` are the workspace's own numbers on the WhatsApp Business
 * app, whose videos need no linking.
 */
export type ProductsWhatsAppLinkResponse = {
  pairing: { url: string; expiresAt: string } | null;
  requests: ProductsWhatsAppLinkRequestRecord[];
  linkedPhones: ProductsWhatsAppLinkedPhoneRecord[];
  businessNumbers: string[];
};

/** The order form, saved on Meta as a draft Flow for the owner to publish. */
export type ProductOrderFormResponse = {
  flow: { id: string; name: string };
  /** Added products not on the form, past the 20 it lists. */
  leftOut: number;
};

/**
 * The imports the Products page shows, newest first: running ones, finished
 * ones with products left to check, and those that recently failed or found
 * nothing.
 */
export type ProductVideoImportsResponse = {
  imports: ProductVideoImportRecord[];
};

/** Whether this user sees the Products section: the flag is on and they're an admin. */
export type ProductsAccessResponse = {
  available: boolean;
};

export const PRODUCTS_ERROR_CODES = [
  "feature_disabled",
  "admin_required",
  "load_failed",
  "invalid_request",
  "video_not_found",
  "import_not_found",
  "import_unavailable",
  "product_not_found",
  "currency_required",
  "save_failed",
  "whatsapp_not_connected",
  "not_enough_products",
  "storage_full",
  "draft_failed",
  "whatsapp_intake_unavailable",
  "whatsapp_link_not_found",
  "whatsapp_link_linked_elsewhere",
  "whatsapp_link_shop_name_taken",
  // Kits and video ads.
  "kit_not_found",
  "ad_not_found",
  "ad_not_ready",
  "ad_letters_unsupported",
  "ad_unavailable",
  // An AI action refused before it starts, as the import refuses one.
  "ai_actions_used",
  "spend_limit",
  "trial_ended",
  // The company turned AI off (main's workspace_ai_disabled).
  "ai_disabled",
  // Studio v2: editing a kit's parts.
  "kit_part_busy",
  "carousel_found",
  "template_name_taken",
  "test_phone_missing",
  "rate_limited",
  // Meta refused an edited part; its words are in `issues`, the kit as it now is in `kit`.
  "meta_refused",
  // S1: Meta's refusals of a test send to the owner's phone (131021, 131026, 131030).
  "test_phone_is_shop",
  "test_phone_unreachable",
  "test_phone_not_allowed",
  // Studio v2: the ad's "New picture".
  "no_pictures_left",
  // Studio v2: voices.
  "voice_consent_required",
  "voice_not_found",
  "voice_unavailable",
] as const;
export type ProductsErrorCode = (typeof PRODUCTS_ERROR_CODES)[number];

// Kits (carousel + order form), video ads and voices, each in its own file.
export * from "./types-kit";
export * from "./types-ad";
export * from "./types-voice";

export type ProductsErrorBody = {
  error: string;
  code: ProductsErrorCode;
  /** What failed a 400 invalid_request's checks, the first 3, in English (for support and the sheets). */
  issues?: string[];
  /**
   * The kit as it now is, with 409 carousel_found: Meta got the carousel an
   * earlier send timed out on, so the edits weren't sent. Also with 409
   * meta_refused: Meta refused the edited part (its words in `issues`), and
   * the kit keeps what it held before.
   */
  kit?: ProductKitRecord;
};

const NO_BREAK_SPACE = "\u00a0";

/**
 * "5 000 ₸", "12.50 EUR", "1 500 JPY". Grouped by hand with no-break
 * spaces, so the server, every browser and every locale agree, and a price
 * never wraps between its digits and its currency. Decimals show only when
 * the amount has some, to the currency's own count, and "." is only ever the
 * decimal point. Tenge keeps its sign, any other currency ends in its ISO
 * code, and a price whose currency isn't known stands bare ("20"). A
 * starting price reads "from 5 000 ₸".
 */
export function formatProductPrice(
  price: number,
  options: { from?: boolean; currency?: string | null } = {}
): string {
  return productPriceParts(price, options).join("");
}

/**
 * formatProductPrice's text in its two parts: the "from " a starting price
 * opens with ("" for any other), and the amount with its currency, which
 * never breaks. Where space is short, a line may break between the two.
 */
export function productPriceParts(
  price: number,
  options: { from?: boolean; currency?: string | null } = {}
): [lead: string, amount: string] {
  const code = productCurrency(options.currency ?? null);
  const digits = productPriceDecimals(code);
  const scale = 10 ** digits;
  const minor = toMinorUnits(price, digits);
  const whole = Math.floor(minor / scale);
  const fraction = minor - whole * scale;
  const grouped = String(whole).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    NO_BREAK_SPACE
  );
  const amount =
    fraction === 0
      ? grouped
      : `${grouped}.${String(fraction).padStart(digits, "0")}`;
  const unit =
    code === null ? "" : `${NO_BREAK_SPACE}${code === "KZT" ? "₸" : code}`;
  return [options.from ? `from${NO_BREAK_SPACE}` : "", `${amount}${unit}`];
}

/**
 * How long a written price runs, for the type a narrow card or shelf tag
 * shows it in: "short" up to 17 characters ("from 1 299.99 USD"), "long" up
 * to 22 ("from 1 250 000 000 IRR"), and "longest" beyond, up to the 28 of
 * "from 999 999 999 999.999 KWD" near the price cap.
 */
export function productPriceLength(text: string): "short" | "long" | "longest" {
  if (text.length <= 17) return "short";
  return text.length <= 22 ? "long" : "longest";
}
