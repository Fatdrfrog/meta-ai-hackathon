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
  PRODUCT_PHOTO_METHODS,
  PRODUCT_TEXT_SOURCES,
  PRODUCT_VIDEO_IMPORT_ERROR_CODES,
  PRODUCT_VIDEO_IMPORT_STAGES,
  type ProductPhotoMethod,
  type ProductTextSource,
  type ProductVideoImportErrorCode,
  type ProductVideoImportStage,
} from "@icecore/temporal";
import type {
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
  /** What the owner should confirm, in English. */
  doubts: string[];
  /** The items shown for it, in the order shown. */
  options: DraftProductOptionRecord[];
  /** The option the shelf shows, as an index into `options`. */
  featuredOption: number;
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
