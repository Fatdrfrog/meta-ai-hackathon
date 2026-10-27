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
  PRODUCT_VIDEO_IMPORT_ERROR_CODES,
  PRODUCT_VIDEO_IMPORT_STAGES,
  type ProductPhotoMethod,
  type ProductVideoImportErrorCode,
  type ProductVideoImportStage,
} from "@icecore/temporal";
import type {
  ProductPhotoMethod,
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
  /** The product cut out of the video on a transparent background, or null. */
  imageUrl: string | null;
  updatedAt: string | null;
};

export type ProductsListResponse = {
  products: WorkspaceProductRecord[];
};

/** A product an import found, as the owner checks it before publishing. */
export type DraftProductRecord = WorkspaceProductRecord & {
  status: WorkspaceProductStatus;
  /** The catalog name in English, beside the owner's own `name`. */
  englishName: string | null;
  /** The narration's words the price came from. */
  priceQuote: string | null;
  /** What the owner should confirm, in English. */
  doubts: string[];
  photoMethod: ProductPhotoMethod;
  /** The full-size cut-out; `imageUrl` is its small copy. */
  photoUrl: string | null;
  /** The product as filmed, to compare the cleaned-up photo with. */
  originalUrl: string | null;
  /** Seconds into the video where the photo was taken. */
  videoMomentSeconds: number | null;
};

export type ProductVideoImportRecord = {
  id: string;
  status: ProductVideoImportStatus;
  stage: ProductVideoImportStage | null;
  /** Products found so far, and how many of them have their photo. */
  productTotal: number;
  productDone: number;
  errorCode: ProductVideoImportErrorCode | null;
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
 * a price never wraps between its digits and the sign.
 */
export function formatProductPrice(price: number): string {
  const grouped = String(Math.round(price)).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    " "
  );
  return `${grouped} ₸`;
}
