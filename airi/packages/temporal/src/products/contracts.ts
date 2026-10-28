// Importing products from an owner's shelf video: one workflow per import, on
// the media queue. Its activity runs the whole pipeline, saving each step to
// the import and its products, so a retry resumes instead of paying again.

export const PRODUCT_VIDEO_IMPORT_WORKFLOW = "productVideoImportWorkflow";

export const PRODUCT_VIDEO_IMPORT_TASK_QUEUE = "airi-media";

export const PRODUCT_VIDEO_IMPORT_WORKFLOW_CONTRACT_VERSION = 1;
export const PRODUCT_VIDEO_IMPORT_ACTIVITY_CONTRACT_VERSION = 1;

export const PRODUCT_VIDEO_IMPORT_ACTIVITY = "productVideoImportActivity";

export const PRODUCT_VIDEO_IMPORT_FAIL_ACTIVITY =
  "productVideoImportFailActivity";

/** Attempts the workflow gives the import activity before recording a failure. */
export const PRODUCT_VIDEO_IMPORT_ACTIVITY_MAX_ATTEMPTS = 3;

/** Products one video may add. */
export const PRODUCT_VIDEO_IMPORT_MAX_PRODUCTS = 60;

/**
 * Options one product may have: the items shown under its one name and
 * price, like several designs of a family-tree panel.
 */
export const PRODUCT_VIDEO_IMPORT_MAX_OPTIONS = 8;

/** Photos one video may make, one per option; caps an import's cost at a few dollars. */
export const PRODUCT_VIDEO_IMPORT_MAX_PHOTOS = 60;

/** Where a running import is, for the progress the owner sees. */
export const PRODUCT_VIDEO_IMPORT_STAGES = [
  "preparing",
  "listening",
  "watching",
  "cutting",
] as const;
export type ProductVideoImportStage =
  (typeof PRODUCT_VIDEO_IMPORT_STAGES)[number];

/** Why an import failed, as a code the panel explains. */
export const PRODUCT_VIDEO_IMPORT_ERROR_CODES = [
  "video_too_long",
  "video_unreadable",
  "video_missing",
  "spend_limit",
  "failed",
] as const;
export type ProductVideoImportErrorCode =
  (typeof PRODUCT_VIDEO_IMPORT_ERROR_CODES)[number];

/**
 * How a product's photo was made. restored: Muse Image's whole, upright
 * product, checked to be the same one. tracked / phrase: the product as
 * filmed. none: nothing could be cut out. pending: not made yet.
 */
export const PRODUCT_PHOTO_METHODS = [
  "pending",
  "restored",
  "tracked",
  "phrase",
  "none",
] as const;
export type ProductPhotoMethod = (typeof PRODUCT_PHOTO_METHODS)[number];

/**
 * Where a product's name or price came from. spoken: the narration, a price
 * checked word for word against the transcript. on_screen: text in the
 * video, like a headline, a caption or a price sticker, which no transcript
 * can confirm.
 */
export const PRODUCT_TEXT_SOURCES = ["spoken", "on_screen"] as const;
export type ProductTextSource = (typeof PRODUCT_TEXT_SOURCES)[number];

export type ProductVideoImportWorkflowInput = {
  contractVersion: number;
  workspaceId: string;
  importId: string;
};

export type ProductVideoImportActivityInput =
  ProductVideoImportWorkflowInput & {
    workflowId: string;
  };

export type ProductVideoImportFailActivityInput =
  ProductVideoImportActivityInput & {
    error: string;
  };

export type ProductVideoImportActivityResult = {
  importId: string;
  status: "ready" | "failed";
  productCount: number;
};

export type ProductVideoImportWorkflowResult = ProductVideoImportActivityResult;

export function buildProductVideoImportWorkflowId(params: {
  importId: string;
}): string {
  const importId = (params.importId || "import")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-");
  return `product-video-import:${importId}`;
}
