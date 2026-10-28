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

// The import job's own vocabulary, shared with the worker that runs it.
export {
  PRODUCT_DOUBT_SUBJECTS,
  PRODUCT_PHOTO_METHODS,
  PRODUCT_TEXT_SOURCES,
  PRODUCT_VIDEO_IMPORT_ERROR_CODES,
  PRODUCT_VIDEO_IMPORT_MAX_PRODUCTS,
  PRODUCT_VIDEO_IMPORT_STAGES,
  PRODUCT_VIDEO_MAX_BYTES,
  PRODUCT_VIDEO_MAX_SECONDS,
  type ProductDoubt,
  type ProductDoubtSubject,
  type ProductPhotoMethod,
  type ProductTextSource,
  type ProductVideoImportErrorCode,
  type ProductVideoImportStage,
} from "@icecore/temporal";
import type {
  ProductDoubt,
  ProductPhotoMethod,
  ProductTextSource,
  ProductVideoImportErrorCode,
  ProductVideoImportStage,
} from "@icecore/temporal";

/** A file in the workspace's private media storage. */
export type StoredFileRef = { bucket: string; path: string };

/** Published products one list returns; far above a small shop's shelf. */
export const MAX_LISTED_PRODUCTS = 1000;

/** One published product as the Products page lists it. */
export type WorkspaceProductRecord = {
  id: string;
  name: string;
  /** Whole tenge, or null while the owner hasn't set a price. */
  price: number | null;
  /** A starting price, shown as "from …": the final one depends on options. */
  priceIsFrom: boolean;
  /** Its featured option cut out of the video on a transparent background, or null. */
  imageUrl: string | null;
  updatedAt: string | null;
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
/** A sanity cap on prices, in whole tenge. */
export const MAX_PRODUCT_PRICE = 1_000_000_000;

/**
 * What the owner may change about a product while checking it: its name,
 * its price (null for none yet), and which option the shelf shows.
 */
export type ProductChanges = {
  name?: string;
  price?: number | null;
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
  "save_failed",
  "whatsapp_not_connected",
  "not_enough_products",
  "storage_full",
  "draft_failed",
] as const;
export type ProductsErrorCode = (typeof PRODUCTS_ERROR_CODES)[number];

export type ProductsErrorBody = {
  error: string;
  code: ProductsErrorCode;
};

/**
 * "5 000 ₸", the way shops in Kazakhstan write prices. Grouped by hand with
 * no-break spaces, so the server, every browser and every locale agree, and
 * a price never wraps between its digits and the sign. A starting price
 * reads "from 5 000 ₸".
 */
export function formatProductPrice(
  price: number,
  options: { from?: boolean } = {}
): string {
  const grouped = String(Math.round(price)).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    " "
  );
  return `${options.from ? "from " : ""}${grouped} ₸`;
}
