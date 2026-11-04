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
 * stayed over WhatsApp's 16 MB at the smallest size. ai_disabled: the
 * company turned AI off (main's workspace_ai_disabled); a retry can't help.
 */
export const PRODUCT_AD_ERROR_CODES = [
  "spend_limit",
  "ai_actions_used",
  "trial_ended",
  "photo_missing",
  "too_big",
  "failed",
  "ai_disabled",
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
  "market_stall",
  "marble_boutique",
  "festive_table",
  "vanity_table",
  "kitchen_counter",
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
    /**
     * What the voice-over says over this scene, in the ad's language, for
     * "Your voice, new words" and "Airi voices" (Part V). A price in it is
     * written by code from the shelf, never by the model. Absent on ads
     * written before it.
     */
    spoken?: string;
  }>;
  priceCardTitle: string;
  ending: string;
  /**
   * Muse Spark's openings to choose from, one per kind; `sticker` is the one
   * in the video. 0 to 3; absent on ads written before them.
   */
  openings?: ProductAdOption<ProductAdOpeningKind>[];
  /** Muse Spark's endings to choose from, one per kind; `ending` is the one in the video. */
  endings?: ProductAdOption<ProductAdEndingKind>[];
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
  // v2's creative tools; every one optional, so ads made before them read
  // as their defaults.
  /** Where the words sit on the picture; "auto" (v1's placement) when absent. */
  textZone?: ProductAdTextZone;
  /** "Use my exact photo here": the exact still renders instead of Muse Image's scene. */
  useExact?: boolean;
  /** The product's box in the exact still; recomputed from the cut-out when absent. */
  exactBox?: ProductAdBox | null;
  /** Muse Image pictures that passed the check, newest last, at most PRODUCT_AD_PICTURES_KEPT. */
  pictures?: ProductAdScenePicture[];
  /** The place the scene's picture was asked for. */
  place?: ProductAdScenePlace;
  /** Muse Image calls this scene may make in all; PRODUCT_AD_MAX_SCENE_ATTEMPTS when absent. */
  allowance?: number;
  /** The latest "New picture" press; null or absent when there was none. */
  redo?: ProductAdSceneRedo | null;
  /** Whether the latest render's words cover the product, for the Top/Bottom hint. */
  textOverlap?: ProductAdTextOverlap | null;
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

// ---------------------------------------------------------------------------
// Studio v2: the ad's creative tools and its voices. Every field below is
// optional on the stored ad, so ads made before v2 keep working, and the
// workflow and activity contracts stay at version 1: a scene or voice run is
// a "make" run, a words run a "render" run, and the ad's `runKind` says which.

/**
 * What a run of the ad does. make: the first video (or a retry of a failed
 * one). render: the free "Update the video" (the words, their place, the
 * exact photo, an earlier picture), with no model call. scene: "New
 * picture" for one scene, paying only for that scene. voice: the voice-over
 * again in another voice or new words, paying only for the text-to-speech.
 * render, scene and voice are edit runs: one that fails leaves the ad ready
 * with its earlier video (`lastRun` says why), never failed.
 */
export const PRODUCT_AD_RUN_KINDS = [
  "make",
  "render",
  "scene",
  "voice",
] as const;
export type ProductAdRunKind = (typeof PRODUCT_AD_RUN_KINDS)[number];

/** Where a scene's words sit: auto (v1's placement), or forced to the top or bottom band. */
export const PRODUCT_AD_TEXT_ZONES = ["auto", "top", "bottom"] as const;
export type ProductAdTextZone = (typeof PRODUCT_AD_TEXT_ZONES)[number];

/** The kinds of opening Muse Spark writes, one of each. */
export const PRODUCT_AD_OPENING_KINDS = [
  "news",
  "question",
  "promise",
] as const;
export type ProductAdOpeningKind = (typeof PRODUCT_AD_OPENING_KINDS)[number];

/** The kinds of ending Muse Spark writes, one of each. */
export const PRODUCT_AD_ENDING_KINDS = ["order", "ask", "reserve"] as const;
export type ProductAdEndingKind = (typeof PRODUCT_AD_ENDING_KINDS)[number];

/** Openings (and endings) one script offers at most. */
export const PRODUCT_AD_OPTIONS_MAX = 3;

/**
 * One of Muse Spark's openings or endings: the text in the ad's language,
 * its kind, and an English gloss for the owner ("New pieces have arrived").
 */
export type ProductAdOption<K extends string> = {
  text: string;
  kind: K;
  gloss: string;
};

/**
 * How a "New picture" press ended. new: the new picture is in. kept_check:
 * Muse Spark found it changed the product. place_refused: Muse Spark
 * wouldn't use the described place. image_refused: Muse Image wouldn't make
 * it. no_budget: the ad's AI action had no room left. unavailable: a Meta
 * model didn't answer. ai_disabled: the company turned AI off while the run
 * went. In every case but new, the scene keeps its picture.
 */
export const PRODUCT_AD_REDO_OUTCOMES = [
  "new",
  "kept_check",
  "place_refused",
  "image_refused",
  "no_budget",
  "unavailable",
  "ai_disabled",
] as const;
export type ProductAdRedoOutcome = (typeof PRODUCT_AD_REDO_OUTCOMES)[number];

/** Why Muse Spark refused a described place, as `redo.reason` holds it. */
export const PRODUCT_AD_PLACE_REFUSALS = [
  "people",
  "text",
  "logo",
  "brand",
  "unclear",
] as const;
export type ProductAdPlaceRefusal = (typeof PRODUCT_AD_PLACE_REFUSALS)[number];

/** The longest place the owner may describe, in characters, after trimming. */
export const PRODUCT_AD_PLACE_WORDS_MAX = 80;

/** Muse Image pictures a scene keeps to pick again for free. */
export const PRODUCT_AD_PICTURES_KEPT = 4;

/** Muse Image calls a scene may make before any "New picture" press (v1's MAX_SCENE_ATTEMPTS). */
export const PRODUCT_AD_MAX_SCENE_ATTEMPTS = 2;

/** Muse Image tries one "New picture" press adds to the scene's allowance. */
export const PRODUCT_AD_REDO_ATTEMPTS = 2;

/** Muse Spark reading a described place: one short JSON call. */
export const PRODUCT_AD_PLACE_MAX_COST_MICROS = 5_000;

/**
 * The most one "New picture" press may cost: the place (5 000), two Muse
 * Image tries each with Muse Spark's check (2 x (10 000 + 10 000)) and SAM's
 * framing (2 500). The studio's "{n} new pictures left" divides the ad's
 * room by it.
 */
export const PRODUCT_AD_NEW_PICTURE_MAX_MICROS = 47_500;

/** A Muse Image picture a scene kept, to pick again for free. */
export type ProductAdScenePicture = {
  ref: ProductAdFileRef;
  /** SAM 3.1's box of the product in it; null when framing failed. */
  box: ProductAdBox | null;
  /** The place it was made in, in English, for the studio's lines. */
  place: string;
  madeAt: Date;
};

/**
 * The place a scene's picture was asked for: one of the tested settings, or
 * the owner's own words with Muse Spark's English reading of them (null
 * until read, or when refused).
 */
export type ProductAdScenePlace = {
  setting: ProductAdSetting | null;
  words: string | null;
  englishPlace: string | null;
};

/**
 * A "New picture" press on a scene: the render it runs in, what the scene
 * was before it (restored when the press doesn't end in a new picture), and
 * how it ended (null while it runs).
 */
export type ProductAdSceneRedo = {
  requestId: string;
  renderNo: number;
  from: {
    muse: ProductAdFileRef | null;
    box: ProductAdBox | null;
    method: ProductAdSceneMethod;
    check: ProductAdStoredScene["check"];
    /**
     * The setting the replaced picture was made in, as the script had it
     * before the press (which writes the pressed chip there): what an ad
     * from before v2 names its first picture by. Absent on older presses.
     */
    setting?: ProductAdSetting | null;
  };
  outcome: ProductAdRedoOutcome | null;
  /** Muse Spark's refusal kind for a described place, in English; null otherwise. */
  reason: string | null;
  /**
   * The scene's Muse Image allowance this press raised it to, set by the
   * worker once as the press's run starts, so a retried attempt never
   * raises it twice; absent until then.
   */
  allowance?: number;
};

/**
 * Whether the rendered words cover the product (more than 4% of its box),
 * and the band that would keep it clear; null suggests nothing better.
 */
export type ProductAdTextOverlap = {
  covers: boolean;
  suggested: "top" | "bottom" | null;
};

/**
 * How the ad's latest finished run went, for the update card: an edit run
 * that failed leaves the ad ready with its earlier video and says why here.
 */
export type ProductAdLastRun = {
  renderNo: number;
  kind: ProductAdRunKind;
  outcome: "ready" | "failed";
  errorCode: ProductAdErrorCode | null;
  /** The failure in words, for support; not shown to the owner. */
  message: string | null;
  at: Date;
};

// Voices (Part V). The ad's `voice` takes one of these modes; v1's
// PRODUCT_AD_VOICES ("own", "none") stays the subset ads were made with
// before them.

/**
 * own: "Your recording", the owner's polished clips from the video (v1).
 * clone: "Your voice, new words", the script's spoken lines read by the
 * workspace's ElevenLabs clone of the owner (made only after their consent).
 * stock: "Airi voices", read by one of airi's curated ElevenLabs voices
 * (`stockVoiceId`). none: silent.
 */
export const PRODUCT_AD_VOICE_MODES = [
  "own",
  "clone",
  "stock",
  "none",
] as const;
export type ProductAdVoiceMode = (typeof PRODUCT_AD_VOICE_MODES)[number];

/**
 * Why a render's voice-over wasn't the new words asked for, so it fell back
 * to the recording (or silence without one). no_voice: no cloned voice for
 * the workspace, or an unknown Airi voice. unavailable: ElevenLabs didn't
 * answer or isn't set up. spend_refused: the ad's AI action had no room.
 * price_unchecked: a spoken price didn't read back as the shelf's. too_long:
 * the lines didn't fit the ad's length.
 */
export const PRODUCT_AD_VOICE_FALLBACKS = [
  "no_voice",
  "unavailable",
  "spend_refused",
  "price_unchecked",
  "too_long",
] as const;
export type ProductAdVoiceFallback =
  (typeof PRODUCT_AD_VOICE_FALLBACKS)[number];

/**
 * The voice-over a render read in new words, kept so a later render with
 * the same voice and words reuses it instead of paying again.
 */
export type ProductAdVoiceOver = {
  mode: "clone" | "stock";
  /** ElevenLabs' id of the voice that read it. */
  voiceId: string;
  /** The ElevenLabs model that read it. */
  modelId: string;
  /** One line per product's scene, in the ad's order. */
  lines: Array<{
    productId: string;
    /** The words read, prices written in by code. */
    text: string;
    audio: ProductAdFileRef;
    seconds: number;
  }>;
  /** The voice and the words it read, hashed: a render with the same key reuses it. */
  key: string;
  /** What reading it cost, in millionths of a US dollar. */
  costMicros: number;
  madeAt: Date;
};

/** What the latest video's voice was, when the ad asked for new words. */
export type ProductAdVoiceResult = {
  used: ProductAdVoiceMode;
  /** Why it isn't the voice asked for; null when it is. */
  fallback: ProductAdVoiceFallback | null;
};

/**
 * A workspace's cloned voice (product_voices): pending while it's made from
 * the owner's video, ready to read ads, failed (`errorCode` says why), or
 * removed (deleted at ElevenLabs by "Remove my voice").
 */
export const PRODUCT_VOICE_STATES = [
  "pending",
  "ready",
  "failed",
  "removed",
] as const;
export type ProductVoiceState = (typeof PRODUCT_VOICE_STATES)[number];

/**
 * Why a voice couldn't be cloned. too_little_speech: the video's narration
 * had under PRODUCT_VOICE_MIN_SPEECH_SECONDS of clear speech. no_source:
 * the video or its sound is gone. clone_failed: ElevenLabs refused or
 * didn't answer. spend_refused: the AI ledger refused the cost.
 */
export const PRODUCT_VOICE_ERROR_CODES = [
  "too_little_speech",
  "no_source",
  "clone_failed",
  "spend_refused",
] as const;
export type ProductVoiceErrorCode = (typeof PRODUCT_VOICE_ERROR_CODES)[number];

/** Clear speech a clone needs at least, and takes at most, in seconds. */
export const PRODUCT_VOICE_MIN_SPEECH_SECONDS = 20;
export const PRODUCT_VOICE_MAX_SPEECH_SECONDS = 120;

// ---------------------------------------------------------------------------
// Studio v3: template tiles. A tile is a motion (how the Reel moves) or a
// still (a picture drawn by code from what the ad already made). Both are
// code over the ad's saved scenes and cut-outs: no model call, no AI action.
// Every field is optional on the stored ad, so v1 and v2 ads keep working,
// and the contracts stay at version 1 (a motion change is a "render" run).

/**
 * How the ad's video moves. shelf: v2's Muse Image scenes with the SAM-box
 * push-in. filmed_sold: each shot opens on the owner's filmed frame, then
 * wipes to the made scene. float: the exact cut-out bobbing on the code
 * wall. pop: the cut-out scaling up over the blurred scene. An absent or
 * unknown motion reads as "shelf" (productAdMotionOf).
 */
export const PRODUCT_AD_MOTIONS = [
  "shelf",
  "filmed_sold",
  "float",
  "pop",
] as const;
export type ProductAdMotion = (typeof PRODUCT_AD_MOTIONS)[number];

/** The ad's motion, "shelf" for an ad from before motions or one the reader doesn't know. */
export function productAdMotionOf(value: unknown): ProductAdMotion {
  return (PRODUCT_AD_MOTIONS as readonly unknown[]).includes(value)
    ? (value as ProductAdMotion)
    : "shelf";
}

/**
 * The pictures a render draws besides the video. room: v2's feed still
 * (Muse Image scene, label, tag), one per product. studio: the cut-out on a
 * code sweep, per product and colourway. big_price: the shelf price huge
 * behind the product, per product. collection: every product on one plank,
 * titled by the opening. price_list: every product with dotted leaders, the
 * shop name and the ending's contact line. spotlight: one product large on
 * its sweep under its own caption, per product. print: the product's scene
 * as a framed photo print on paper, with its caption and tag, per product.
 * grid: every product in a catalog grid under the opening, with the shop's
 * contact line.
 */
export const PRODUCT_AD_STILL_KINDS = [
  "room",
  "studio",
  "big_price",
  "collection",
  "price_list",
  "spotlight",
  "print",
  "grid",
] as const;
export type ProductAdStillKind = (typeof PRODUCT_AD_STILL_KINDS)[number];

/** feed: 1080x1350 (4:5). story: 1080x1920 (9:16). Both JPEG q90 sRGB. */
export const PRODUCT_AD_STILL_FORMATS = ["feed", "story"] as const;
export type ProductAdStillFormat = (typeof PRODUCT_AD_STILL_FORMATS)[number];

/** The sweeps the studio still is drawn on, from the Paper look. */
export const PRODUCT_AD_STUDIO_COLOURWAYS = [
  "white",
  "sand",
  "rose",
  "sage",
  "night",
] as const;
export type ProductAdStudioColourway =
  (typeof PRODUCT_AD_STUDIO_COLOURWAYS)[number];

/**
 * Each colourway's sweep (top to bottom) and the ink drawn on it, so the
 * worker's stills and the page's tile art match. "night" is a warm evening
 * shop, never black.
 */
export const PRODUCT_AD_STUDIO_SWEEPS: Record<
  ProductAdStudioColourway,
  { top: string; bottom: string; ink: string }
> = {
  white: { top: "#fefdfc", bottom: "#efeae3", ink: "#241e1a" },
  sand: { top: "#f6efe4", bottom: "#e6d2ba", ink: "#241e1a" },
  rose: { top: "#f8e7e5", bottom: "#ebc6c2", ink: "#4a1d1f" },
  sage: { top: "#edf1e8", bottom: "#cfd9c6", ink: "#1f2a1c" },
  night: { top: "#3a322c", bottom: "#241e1a", ink: "#fbf9f6" },
};

/**
 * Which stills a render draws and for which products: `productId` is null
 * for a still of every product (collection, price_list), `colourway` null
 * for every kind but studio.
 */
export const PRODUCT_AD_STILL_SHAPES: Record<
  ProductAdStillKind,
  { formats: readonly ProductAdStillFormat[]; perProduct: boolean }
> = {
  room: { formats: ["feed"], perProduct: true },
  studio: { formats: ["feed"], perProduct: true },
  big_price: { formats: ["feed", "story"], perProduct: true },
  collection: { formats: ["feed"], perProduct: false },
  price_list: { formats: ["story"], perProduct: false },
  spotlight: { formats: ["story"], perProduct: true },
  print: { formats: ["feed"], perProduct: true },
  grid: { formats: ["feed", "story"], perProduct: false },
};

/**
 * One still a render drew, saved as
 * `${renderNo}-${kind}-${format}-${productId|all}-${colourway|x}.jpg`.
 * For studio, a product's default colourway (picked by code for contrast)
 * is its first item.
 */
export type ProductAdStillSetItem = {
  kind: ProductAdStillKind;
  format: ProductAdStillFormat;
  productId: string | null;
  colourway: ProductAdStudioColourway | null;
  ref: ProductAdFileRef;
};

/**
 * The stills of one render, written by the worker once they all landed
 * (ad-job.ts). Absent on ads rendered by a worker from before v3: the page
 * then hides the tiles that need them. `renderNo` is the render they were
 * drawn for; the page shows them only with that render's video.
 */
export type ProductAdStillSet = {
  renderNo: number;
  items: ProductAdStillSetItem[];
};

/**
 * The most stills one render draws: 3 products x (room + 5 studio + 2
 * big_price + spotlight + print) + collection + price_list + 2 grid = 34.
 */
export const PRODUCT_AD_STILL_SET_MAX = 34;
