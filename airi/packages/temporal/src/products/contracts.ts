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

/** Option photos one import makes at once; the panel shows that many as being made. */
export const PRODUCT_VIDEO_IMPORT_PHOTO_CONCURRENCY = 4;

/**
 * The longest video an import reads, and the biggest file it downloads. The
 * panel checks a video against both before uploading it. Longer videos cost
 * too much to read and are rarely one shelf; phones film a few minutes in
 * well under the size.
 */
export const PRODUCT_VIDEO_MAX_SECONDS = 300;
export const PRODUCT_VIDEO_MAX_BYTES = 1024 * 1024 * 1024;

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
  "ai_actions_used",
  "trial_ended",
  "failed",
] as const;
export type ProductVideoImportErrorCode =
  (typeof PRODUCT_VIDEO_IMPORT_ERROR_CODES)[number];

/**
 * Why an import stopped making photos before every one was made: the
 * company's AI spending limit was reached, the plan's included AI actions
 * ran out, or the free plan's trial ended. The import still finishes with
 * the products it found.
 */
export const PRODUCT_VIDEO_IMPORT_PHOTO_STOPS = [
  "spend_limit",
  "ai_actions_used",
  "trial_ended",
] as const;
export type ProductVideoImportPhotoStop =
  (typeof PRODUCT_VIDEO_IMPORT_PHOTO_STOPS)[number];

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

/**
 * What a doubt about a found product is about: its price, which the owner
 * settles by setting it, or the product as a whole.
 */
export const PRODUCT_DOUBT_SUBJECTS = ["price", "product"] as const;
export type ProductDoubtSubject = (typeof PRODUCT_DOUBT_SUBJECTS)[number];

/** Something the owner should confirm about a found product, in English. */
export type ProductDoubt = { about: ProductDoubtSubject; text: string };

/** A priced product's doubt when no currency was said or shown for its price. */
export const PRODUCT_NO_CURRENCY_DOUBT =
  "No currency was said or shown for this price.";

/** A priced product's doubt when its currency was given as something other than a code ("TL"). */
export function productCurrencyTextDoubt(currencyText: string): string {
  return `Check the currency: it was given as “${currencyText}”.`;
}

/**
 * Matches the two doubts above: the price's currency isn't known yet. A
 * price set without a currency leaves them.
 */
export const PRODUCT_UNKNOWN_CURRENCY_DOUBT =
  /^(?:No currency was said or shown for this price\.|Check the currency: it was given as “.*”\.)$/;

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

// ---------------------------------------------------------------------------
// Video ads: a short vertical video of 1 to 3 shelf products. One workflow per
// render of an ad, on the media queue beside the imports. Its activity saves
// every step on the ad (the script, each scene, the stills), so a retry, or a
// later render after the owner edits the words, never pays for one again.

export const PRODUCT_AD_WORKFLOW = "productAdWorkflow";

/** The media queue the imports run on, so an ad runs beside one. */
export const PRODUCT_AD_TASK_QUEUE = PRODUCT_VIDEO_IMPORT_TASK_QUEUE;

export const PRODUCT_AD_WORKFLOW_CONTRACT_VERSION = 1;
export const PRODUCT_AD_ACTIVITY_CONTRACT_VERSION = 1;

export const PRODUCT_AD_ACTIVITY = "productAdActivity";

export const PRODUCT_AD_FAIL_ACTIVITY = "productAdFailActivity";

/** Attempts the workflow gives the ad activity before recording a failure. */
export const PRODUCT_AD_ACTIVITY_MAX_ATTEMPTS = 3;

/**
 * make: the whole ad, paying only for the steps not saved yet. render: the
 * video and its stills again, from the saved script and pictures, after the
 * owner edited the words; it calls no model.
 */
export const PRODUCT_AD_MODES = ["make", "render"] as const;
export type ProductAdMode = (typeof PRODUCT_AD_MODES)[number];

export type ProductAdWorkflowInput = {
  contractVersion: number;
  workspaceId: string;
  adId: string;
  /** 1 for the first video; each render after an edit is the next number. */
  renderNo: number;
  mode: ProductAdMode;
};

export type ProductAdActivityInput = ProductAdWorkflowInput & {
  workflowId: string;
};

export type ProductAdFailActivityInput = ProductAdActivityInput & {
  error: string;
};

export type ProductAdActivityResult = {
  adId: string;
  renderNo: number;
  status: "ready" | "failed";
};

export type ProductAdWorkflowResult = ProductAdActivityResult;

/** "product-ad:<adId>:r<renderNo>": one workflow per render of an ad. */
export function buildProductAdWorkflowId(params: {
  adId: string;
  renderNo: number;
}): string {
  const adId = (params.adId || "ad")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-");
  const renderNo =
    Number.isSafeInteger(params.renderNo) && params.renderNo > 0
      ? params.renderNo
      : 1;
  return `product-ad:${adId}:r${renderNo}`;
}

/** The ledger's action for an ad: every paid call of every render books to it. */
export function buildProductAdActionId(adId: string): string {
  return `product-ad:${adId}`;
}

/** Products one ad shows: each needs a cut-out photo and a price. */
export const PRODUCT_AD_MIN_PRODUCTS = 1;
export const PRODUCT_AD_MAX_PRODUCTS = 3;

export const PRODUCT_AD_STATUSES = ["making", "ready", "failed"] as const;
export type ProductAdStatus = (typeof PRODUCT_AD_STATUSES)[number];

/** Where an ad being made is, for the honest step list the owner sees. */
export const PRODUCT_AD_STEPS = [
  "script",
  "pictures",
  "framing",
  "video",
] as const;
export type ProductAdStep = (typeof PRODUCT_AD_STEPS)[number];

/**
 * Why an ad failed, as a code the studio explains. The spending refusals are
 * the import's own: an ad already running finishes with exact photos instead.
 * photo_missing: a product's photo is gone from storage. too_big: the video
 * stayed over WhatsApp's 16 MB at the smallest size.
 */
export const PRODUCT_AD_ERROR_CODES = [
  "spend_limit",
  "ai_actions_used",
  "trial_ended",
  "photo_missing",
  "too_big",
  "failed",
] as const;
export type ProductAdErrorCode = (typeof PRODUCT_AD_ERROR_CODES)[number];

/** The ad's idea: new on the shelf, a gift idea, or the owner's own words. */
export const PRODUCT_AD_IDEA_KINDS = ["new", "gift", "own"] as const;
export type ProductAdIdeaKind = (typeof PRODUCT_AD_IDEA_KINDS)[number];

/** The longest idea the owner may write in their own words. */
export const PRODUCT_AD_IDEA_MAX_LENGTH = 120;

/** own: the owner's own spoken clips from the video, polished. none: silent. */
export const PRODUCT_AD_VOICES = ["own", "none"] as const;
export type ProductAdVoice = (typeof PRODUCT_AD_VOICES)[number];

/** The places Muse Image may set a product in. */
export const PRODUCT_AD_SETTINGS = [
  "oak_table_window",
  "linen_shelf",
  "stone_counter",
  "playroom_shelf",
  "gift_table",
] as const;
export type ProductAdSetting = (typeof PRODUCT_AD_SETTINGS)[number];

/**
 * How a scene's picture was made: muse, Muse Image's scene, checked by Muse
 * Spark to still show the same product; exact, the owner's own cut-out on a
 * code-drawn wall.
 */
export const PRODUCT_AD_SCENE_METHODS = ["muse", "exact"] as const;
export type ProductAdSceneMethod = (typeof PRODUCT_AD_SCENE_METHODS)[number];

/**
 * The languages buyers' words are written in: Meta's codes for Kazakh,
 * Russian and English. The kit's carousel and form and the ad's fixed words
 * use them; any other spoken language gets English.
 */
export const PRODUCT_SHOP_WORDS_CODES = ["kk", "ru", "en"] as const;
export type ProductShopWordsCode = (typeof PRODUCT_SHOP_WORDS_CODES)[number];

// What the product_ads collection stores, as the web's model and the worker
// both read it. Files are in the workspace's private media storage.

export type ProductAdFileRef = { bucket: string; path: string };

/**
 * A product as the ad shows it, snapshotted when the ad is made: an edit on
 * the shelf afterwards doesn't change the ad.
 */
export type ProductAdStoredProduct = {
  productId: string;
  /** The video it was found in; null for a product added by hand. */
  importId: string | null;
  name: string;
  /** The catalog name in English, for the script's prompt. */
  englishName: string | null;
  /** The price as buyers read it, drawn by code: "15 500 ₸ бастап". */
  priceText: string;
  /** The words the price came from, as the owner said or showed them. */
  priceQuote: string | null;
  /** The featured option: its transparent cut-out and the item as filmed. */
  cutout: ProductAdFileRef | null;
  original: ProductAdFileRef | null;
  /** The owner saying its price, with sound; null without one. */
  clip: ProductAdFileRef | null;
  /** The English noun phrase SAM 3.1 finds it by. */
  samPhrase: string;
  /** A few English words that tell it apart. */
  description: string;
};

/**
 * The ad's words: Muse Spark's script, or the code's own when it fails, then
 * the owner's edits. Nothing on screen holds a digit or a currency: prices are
 * drawn by code from the shelf. ad-script.ts checks every version of it.
 */
export type ProductAdScript = {
  /** The sticker on the first scene. */
  sticker: string;
  /** One scene per product, in the ad's order. */
  scenes: Array<{
    productId: string;
    caption: string;
    setting: ProductAdSetting;
  }>;
  priceCardTitle: string;
  ending: string;
  /** The post text's opening, before the code's price lines. */
  postIntro: string;
  /** Click-to-WhatsApp ad copy. */
  ctwa: {
    headline: string;
    primaryText: string;
    greeting: string;
    questions: string[];
  };
  /** Whether the owner changed the words since they were written. */
  edited: boolean;
};

/** A box in a picture, as fractions (0 to 1) of its width and height. */
export type ProductAdBox = { x: number; y: number; w: number; h: number };

/** One product's scene, saved as soon as each part of it exists. */
export type ProductAdStoredScene = {
  productId: string;
  /** The exact cut-out on the code-drawn wall: made first, so a result always exists. */
  exact: ProductAdFileRef | null;
  /** Muse Image's scene, kept once Muse Spark checked it; null otherwise. */
  muse: ProductAdFileRef | null;
  method: ProductAdSceneMethod;
  /** Muse Spark's same-product check of the Muse Image scene. */
  check: { same: boolean; difference: string | null } | null;
  /** SAM 3.1's box of the product in the scene used; null when framing failed. */
  box: ProductAdBox | null;
  /** Muse Image calls made for it so far. */
  attempts: number;
};

/** The Status picture (9:16) and the 4:5 ad picture, kept as soon as each exists. */
export type ProductAdStills = {
  status: ProductAdFileRef | null;
  feed: ProductAdFileRef | null;
};

/** The latest finished video. */
export type ProductAdRender = {
  renderNo: number;
  video: ProductAdFileRef;
  bytes: number;
  seconds: number;
  width: number;
  height: number;
  poster: ProductAdFileRef | null;
  /** How long the render took. */
  ms: number;
};

/** When each step started and finished, for the making list's seconds. */
export type ProductAdStepTiming = { startedAt: Date; finishedAt: Date | null };
export type ProductAdTimings = Partial<
  Record<ProductAdStep, ProductAdStepTiming>
>;
