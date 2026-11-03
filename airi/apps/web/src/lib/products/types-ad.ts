// Video ads made from shelf products: what the ad API answers and takes, and
// the ad's vocabulary shared with the worker that makes it. Re-exported by
// types.ts, so the page and the API import it from there.

import type {
  ProductAdErrorCode,
  ProductAdIdeaKind,
  ProductAdSceneMethod,
  ProductAdStatus,
  ProductAdStep,
  ProductAdVoice,
  ProductShopWordsCode,
  ProductVideoImportPhotoStop,
} from "@icecore/temporal";

export {
  PRODUCT_AD_CTWA_QUESTIONS,
  PRODUCT_AD_ERROR_CODES,
  PRODUCT_AD_IDEA_KINDS,
  PRODUCT_AD_IDEA_MAX_LENGTH,
  PRODUCT_AD_MAX_PRODUCTS,
  PRODUCT_AD_MIN_PRODUCTS,
  PRODUCT_AD_SCENE_METHODS,
  PRODUCT_AD_SETTINGS,
  PRODUCT_AD_STATUSES,
  PRODUCT_AD_STEPS,
  PRODUCT_AD_TEXT_LIMITS,
  PRODUCT_AD_VOICES,
  PRODUCT_SHOP_WORDS_CODES,
  productAdLettersSupported,
  productAdLines,
  productAdScriptIssues,
  productAdShopName,
  productAdTextIssues,
  type ProductAdErrorCode,
  type ProductAdIdeaKind,
  type ProductAdSceneMethod,
  type ProductAdScript,
  type ProductAdSetting,
  type ProductAdStatus,
  type ProductAdStep,
  type ProductAdTextLimit,
  type ProductAdVoice,
  type ProductShopWordsCode,
} from "@icecore/temporal";

/**
 * What stops a workspace paying for an ad's AI action now: the company's AI
 * spending limit, the plan's included actions, or the free trial. The
 * import's own reasons, ruled the same way.
 */
export type ProductAdAdmissionStop = ProductVideoImportPhotoStop;

/** One video ad, as the studio and the "Made from your shelf" list show it; links are signed. */
export type ProductAdRecord = {
  id: string;
  status: ProductAdStatus;
  /** The step being made; null once it's ready or failed. */
  step: ProductAdStep | null;
  errorCode: ProductAdErrorCode | null;
  createdAt: string;
  /**
   * When the current run was asked for: the press of "Make the ad", or the
   * latest edit or retry. The making time counts from here.
   */
  requestedAt: string;
  /** When the worker picked up the current run; null while it waits for a free slot. */
  startedAt: string | null;
  readyAt: string | null;
  /** The render being made or last made: 1 for the first video, one more for each edit or retry. */
  renderNo: number;
  /** The language the owner spoke, as Muse Spark named it. */
  language: string | null;
  /** When each step started and finished, for the seconds on the step list. */
  timings: Partial<
    Record<ProductAdStep, { startedAt: string; finishedAt: string | null }>
  >;
  /** The brief, as the owner chose it. */
  idea: { kind: ProductAdIdeaKind; text: string | null };
  voice: ProductAdVoice;
  /** How buyers reach the shop at the end: the connected number, else the shop's name. */
  ending: { phone: string | null; shopName: string };
  /** The products as the ad shows them, snapshotted when it was made. */
  products: Array<{
    productId: string;
    name: string;
    /** The catalog name in English, for the studio's English lines. */
    englishName: string | null;
    /** The price drawn by code, as buyers read it: "15 500 ₸ бастап". */
    priceText: string;
    imageUrl: string | null;
  }>;
  /** The words the owner may edit; null until they're written. */
  script: {
    sticker: string;
    captions: Array<{ productId: string; caption: string }>;
    priceCardTitle: string;
    ending: string;
  } | null;
  /**
   * One per product, filled in as each picture lands. The made list leaves
   * their links out (null): it shows the poster.
   */
  scenes: Array<{
    productId: string;
    method: ProductAdSceneMethod;
    imageUrl: string | null;
    /** Whether Muse Spark checked that the scene still shows the same product. */
    checked: boolean;
  }>;
  video: {
    url: string;
    bytes: number;
    seconds: number;
    posterUrl: string | null;
  } | null;
  /**
   * The Status picture (9:16) and the 4:5 ad picture, as soon as each
   * exists. The made list leaves them out (null).
   */
  stills: { statusUrl: string | null; feedUrl: string | null };
  /** The post text, composed by code around Muse Spark's opening. */
  post: { text: string } | null;
  /** Click-to-WhatsApp ad copy. */
  ctwa: {
    headline: string;
    primaryText: string;
    greeting: string;
    questions: string[];
  } | null;
  /** The person from the video, when the owner chose to show them. */
  presenter: { imageUrl: string } | null;
  /** List-price cost of its Meta model calls, in US dollars. */
  costUsd: number;
  /**
   * Whether a shelf price changed since the ad was made, so the ad shows an
   * old one. Read with the ad itself (GET /products/ads/[adId]) only.
   */
  pricesChanged?: boolean;
};

/** POST /products/ads: make an ad of 1 to 3 shelf products. */
export type ProductAdCreateRequest = {
  /** The page's id for this press, so a repeat returns the same ad. */
  requestId: string;
  /** In the order the ad shows them. */
  productIds: string[];
  idea: { kind: ProductAdIdeaKind; text?: string };
  voice: ProductAdVoice;
  /** Whether to show the person from the video, and that they agreed to it. */
  presenter: { use: boolean; consent: boolean };
};

/** PATCH /products/ads/[adId]: the owner's edits, which make the video again. */
export type ProductAdUpdateRequest = {
  sticker?: string;
  captions?: Array<{ productId: string; caption: string }>;
  priceCardTitle?: string;
  ending?: string;
};

export type ProductAdResponse = { ad: ProductAdRecord };

/** Why a picked product can't be in an ad: it needs a cut-out photo and a price. */
export type ProductAdProductProblem = "no_photo" | "no_price";

/** A picked product as the brief shows it. */
export type ProductAdBriefProduct = {
  productId: string;
  name: string;
  englishName: string | null;
  /** The price as the ad would draw it, in the buyers' words; null without one. */
  priceText: string | null;
  imageUrl: string | null;
  /** Why it can't be in an ad; null when it can. */
  problem: ProductAdProductProblem | null;
  /** Whether the video has the owner saying its price, for "Your voice". */
  hasVoice: boolean;
};

/**
 * GET /products/ads/brief?products=<ids>: what the brief starts from, before
 * anything is spent.
 */
export type ProductAdBrief = {
  /** The picked products on the shelf, in the order asked. */
  products: ProductAdBriefProduct[];
  /** Picked products that aren't on the shelf any more. */
  missing: number;
  /** The language the owner spoke, as Muse Spark named it; null when unknown. */
  language: string | null;
  /** The language of the ad's fixed words. */
  wordsCode: ProductShopWordsCode;
  /** The person who presents the products in the video, cut out by SAM 3.1; null without one. */
  presenter: { imageUrl: string } | null;
  /** How buyers reach the shop at the end: the connected number, else the shop's name. */
  ending: { phone: string | null; shopName: string };
  /** What stops the workspace paying for the ad's AI action now; null when nothing does. */
  blocked: ProductAdAdmissionStop | null;
};

export type ProductAdBriefResponse = { brief: ProductAdBrief };
