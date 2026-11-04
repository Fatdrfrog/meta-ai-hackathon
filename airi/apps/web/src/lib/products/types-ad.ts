// Video ads made from shelf products: what the ad API answers and takes, and
// the ad's vocabulary shared with the worker that makes it. Re-exported by
// types.ts, so the page and the API import it from there.

import type {
  ProductAdEndingKind,
  ProductAdErrorCode,
  ProductAdIdeaKind,
  ProductAdMotion,
  ProductAdOpeningKind,
  ProductAdOption,
  ProductAdRedoOutcome,
  ProductAdRunKind,
  ProductAdSceneMethod,
  ProductAdScenePlace,
  ProductAdSetting,
  ProductAdStatus,
  ProductAdStep,
  ProductAdStillFormat,
  ProductAdStillKind,
  ProductAdStudioColourway,
  ProductAdTextOverlap,
  ProductAdTextZone,
  ProductAdVoiceMode,
  ProductAdVoiceResult,
  ProductShopWordsCode,
  ProductVideoImportPhotoStop,
} from "@icecore/temporal";
import type { ProductAdMetaRecord } from "./types-meta";

export {
  PRODUCT_AD_CTWA_QUESTIONS,
  PRODUCT_AD_ENDING_KINDS,
  PRODUCT_AD_ERROR_CODES,
  PRODUCT_AD_IDEA_KINDS,
  PRODUCT_AD_IDEA_MAX_LENGTH,
  PRODUCT_AD_MAX_PRODUCTS,
  PRODUCT_AD_MAX_SCENE_ATTEMPTS,
  PRODUCT_AD_MIN_PRODUCTS,
  PRODUCT_AD_MOTIONS,
  PRODUCT_AD_NEW_PICTURE_MAX_MICROS,
  PRODUCT_AD_OPENING_KINDS,
  PRODUCT_AD_OPTIONS_MAX,
  PRODUCT_AD_PICTURES_KEPT,
  PRODUCT_AD_PLACE_REFUSALS,
  PRODUCT_AD_PLACE_WORDS_MAX,
  PRODUCT_AD_REDO_OUTCOMES,
  PRODUCT_AD_RUN_KINDS,
  PRODUCT_AD_SCENE_METHODS,
  PRODUCT_AD_SETTINGS,
  PRODUCT_AD_STATUSES,
  PRODUCT_AD_STEPS,
  PRODUCT_AD_STILL_FORMATS,
  PRODUCT_AD_STILL_KINDS,
  PRODUCT_AD_STILL_SET_MAX,
  PRODUCT_AD_STILL_SHAPES,
  PRODUCT_AD_STOCK_VOICES,
  PRODUCT_AD_STUDIO_COLOURWAYS,
  PRODUCT_AD_STUDIO_SWEEPS,
  PRODUCT_AD_TEXT_LIMITS,
  PRODUCT_AD_TEXT_ZONES,
  PRODUCT_AD_VOICE_FALLBACKS,
  PRODUCT_AD_VOICE_MODES,
  PRODUCT_AD_VOICES,
  PRODUCT_SHOP_WORDS_CODES,
  productAdLettersSupported,
  productAdLines,
  productAdMotionOf,
  productAdOptionIssues,
  productAdScriptIssues,
  productAdShopName,
  productAdRecordingIsPaid,
  productAdStockVoice,
  productAdTextIssues,
  type ProductAdEndingKind,
  type ProductAdErrorCode,
  type ProductAdIdeaKind,
  type ProductAdMotion,
  type ProductAdOpeningKind,
  type ProductAdOption,
  type ProductAdPlaceRefusal,
  type ProductAdRedoOutcome,
  type ProductAdRunKind,
  type ProductAdSceneMethod,
  type ProductAdScenePlace,
  type ProductAdScript,
  type ProductAdSetting,
  type ProductAdStatus,
  type ProductAdStep,
  type ProductAdStillFormat,
  type ProductAdStillKind,
  type ProductAdStillSet,
  type ProductAdStillSetItem,
  type ProductAdStockVoice,
  type ProductAdStudioColourway,
  type ProductAdTextLimit,
  type ProductAdTextOverlap,
  type ProductAdTextZone,
  type ProductAdVoice,
  type ProductAdVoiceFallback,
  type ProductAdVoiceMode,
  type ProductAdVoiceResult,
  type ProductShopWordsCode,
} from "@icecore/temporal";

/**
 * What stops a workspace paying for an ad's AI action now: the company's AI
 * spending limit, the plan's included actions, or the free trial (the
 * import's own reasons, ruled the same way); or the company turned AI off.
 */
export type ProductAdAdmissionStop =
  | ProductVideoImportPhotoStop
  | "ai_disabled";

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
  /**
   * How the video moves (studio v3's Reel tiles); "shelf" for an ad from
   * before motions. A worker from before v3 renders every motion as "shelf".
   */
  motion: ProductAdMotion;
  /** The voice asked for: "own" and "none" as in v1, or new words read by "clone" or "stock". */
  voice: ProductAdVoiceMode;
  /** The Airi voice asked for, with "stock"; null otherwise. */
  stockVoiceId: string | null;
  /**
   * The voice the latest video actually has, when new words were asked for,
   * and why it fell back when it did; null for "own" and "none".
   */
  voiceResult: ProductAdVoiceResult | null;
  /**
   * Whether any product has the owner's recording (a clip of them saying
   * it), so "Your recording" has words to say; absent reads as true.
   */
  hasRecording?: boolean;
  /** What the current (or latest) run does; "make" for ads from before edit runs. */
  runKind: ProductAdRunKind;
  /**
   * How the latest finished run went. An edit run (render, scene or voice)
   * that failed leaves the ad ready with its earlier video: the update card
   * says why from here. Null before any run finished, and on ads from before.
   */
  lastRun: ProductAdRecordLastRun | null;
  /**
   * "New picture" presses the ad's AI action still has room for, read from
   * the ledger for a ready ad by GET /products/ads/[adId] only; null
   * elsewhere (the made list, and while it's made).
   */
  picturesLeft: number | null;
  /** Muse Spark's openings to choose from; [] for ads from before them. */
  openings: Array<ProductAdOption<ProductAdOpeningKind>>;
  /** Muse Spark's endings to choose from; [] for ads from before them. */
  endings: Array<ProductAdOption<ProductAdEndingKind>>;
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
  scenes: ProductAdRecordScene[];
  video: {
    url: string;
    bytes: number;
    seconds: number;
    posterUrl: string | null;
    /** The run that made this video ("Video 2 · 13 s"); older than `renderNo` while another run goes. */
    renderNo?: number;
  } | null;
  /**
   * The Status picture (9:16) and the 4:5 ad picture, as soon as each
   * exists. The made list leaves them out (null). `templates` are studio
   * v3's stills of the video shown (`video.renderNo`), signed; absent when
   * the worker that rendered it drew none (a worker from before v3), and
   * then the tiles that need them are hidden.
   */
  stills: {
    statusUrl: string | null;
    feedUrl: string | null;
    templates?: ProductAdRecordStill[];
  };
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
  /**
   * What went out on Meta from this ad: Instagram posts and the
   * Click-to-WhatsApp ad (studio v3, types-meta.ts). Absent before anything
   * was asked for.
   */
  meta?: ProductAdMetaRecord;
};

/**
 * One of studio v3's stills of the ad, signed. For studio, a product's
 * default colourway (picked by code for contrast) comes first.
 */
export type ProductAdRecordStill = {
  kind: ProductAdStillKind;
  format: ProductAdStillFormat;
  /** Null for a still of every product (collection, price_list). */
  productId: string | null;
  /** Null for every kind but studio. */
  colourway: ProductAdStudioColourway | null;
  url: string;
};

/** One product's scene as the studio shows it, filled in as its picture lands. */
export type ProductAdRecordScene = {
  productId: string;
  method: ProductAdSceneMethod;
  imageUrl: string | null;
  /** Whether Muse Spark checked that the scene still shows the same product. */
  checked: boolean;
  /** Where its words sit; "auto" for ads from before. */
  textZone: ProductAdTextZone;
  /** "Use my exact photo here"; false for ads from before. */
  useExact: boolean;
  /**
   * The Muse Image pictures it kept, oldest first (at most 4), to pick again
   * for free; `index` is what PATCH's `pictureIndex` takes. Links are null
   * in the made list.
   */
  pictures: Array<{
    index: number;
    url: string | null;
    /** The place it was made in, in English. */
    place: string;
    /** Whether it's the picture in the video now. */
    current: boolean;
  }>;
  /** The place its picture was asked for; null for ads from before. */
  place: ProductAdScenePlace | null;
  /** The latest "New picture" press: outcome null while it runs; null when there was none. */
  redo: {
    /** The run the press made; its outcome is news only while it's the ad's latest run. */
    renderNo?: number;
    outcome: ProductAdRedoOutcome | null;
    /** Muse Spark's refusal of a described place, in English; null otherwise. */
    reason: string | null;
    /** Muse Spark's English reading of the described place; null for a setting chip. */
    englishPlace: string | null;
  } | null;
  /** Whether the latest render's words cover the product; null when unknown. */
  textOverlap: ProductAdTextOverlap | null;
};

/** How the ad's latest finished run went (`ProductAdRecord.lastRun`). */
export type ProductAdRecordLastRun = {
  renderNo: number;
  kind: ProductAdRunKind;
  outcome: "ready" | "failed";
  errorCode: ProductAdErrorCode | null;
  at: string;
};

/** POST /products/ads: make an ad of 1 to 3 shelf products. */
export type ProductAdCreateRequest = {
  /** The page's id for this press, so a repeat returns the same ad. */
  requestId: string;
  /** In the order the ad shows them. */
  productIds: string[];
  idea: { kind: ProductAdIdeaKind; text?: string };
  voice: ProductAdVoiceMode;
  /** With voice "stock": one of PRODUCT_AD_STOCK_VOICES' ids. */
  stockVoiceId?: string;
  /** Whether to show the person from the video, and that they agreed to it. */
  presenter: { use: boolean; consent: boolean };
  /** How the video moves (the Reel tile it was made from); "shelf" when absent. */
  motion?: ProductAdMotion;
};

/** One scene's free changes in PATCH /products/ads/[adId]. */
export type ProductAdSceneChange = {
  productId: string;
  textZone?: ProductAdTextZone;
  useExact?: boolean;
  /** One of the scene's kept pictures (0 to 3) to use again. */
  pictureIndex?: number;
};

/**
 * PATCH /products/ads/[adId]: the owner's free changes ("Update the video"),
 * which make the video again with no model call. Choosing one of Muse
 * Spark's openings or endings sends its text as `sticker` or `ending`.
 */
export type ProductAdUpdateRequest = {
  sticker?: string;
  captions?: Array<{ productId: string; caption: string }>;
  priceCardTitle?: string;
  ending?: string;
  scenes?: ProductAdSceneChange[];
  /**
   * Another Reel tile's motion (studio v3): the video made again from the
   * kept scenes, free, as a "render" run.
   */
  motion?: ProductAdMotion;
};

/**
 * POST /products/ads/[adId]/scenes/[productId]: "New picture" for one scene,
 * in a tested setting or a place the owner describes (exactly one of the
 * two), with any pending free changes riding along. Answers 202 `{ad}`.
 */
export type ProductAdSceneRequest = {
  /** The page's id for this press, so a repeat starts nothing twice. */
  requestId: string;
  setting?: ProductAdSetting;
  /** 1 to PRODUCT_AD_PLACE_WORDS_MAX characters after trimming, in any language. */
  words?: string;
  changes?: ProductAdUpdateRequest;
};

/**
 * POST /products/ads/[adId]/voice (Part V): read the ad in another voice,
 * or in new words. Answers 202 `{ad}` with a "voice" run started, or 200 as
 * it is when nothing changes.
 */
export type ProductAdVoiceRequest = {
  /** The page's id for this press, so a repeat starts nothing twice. */
  requestId: string;
  voice: ProductAdVoiceMode;
  /** With voice "stock": one of PRODUCT_AD_STOCK_VOICES' ids. */
  stockVoiceId?: string;
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
