// Studio v3's Meta actions: what the page asks Meta to do with an ad, and
// what it reads back. Posting to Instagram (Reel, Story, feed picture,
// carousel) through the Instagram Graph API, and the Click-to-WhatsApp ad
// through the Marketing API, created PAUSED. Re-exported by types.ts, so the
// page and the API import it from there. Nothing here carries a token, an
// account id or a phone number.

import type {
  ProductAdAdmissionStop,
  ProductAdMotion,
  ProductAdStillKind,
  ProductAdStudioColourway,
} from "./types-ad";

// ---------------------------------------------------------------------------
// Instagram posts (stream P1)

/**
 * Where a post goes on Instagram: a Reel (the ad's video), a Story (the
 * video, or a 9:16 still), a feed post (one 4:5 still) or a carousel (2 to 4
 * 4:5 stills).
 */
export const PRODUCT_AD_POST_DESTINATIONS = [
  "reel",
  "story",
  "post",
  "carousel",
] as const;
export type ProductAdPostDestination =
  (typeof PRODUCT_AD_POST_DESTINATIONS)[number];

/**
 * Where a post is. processing: Instagram is fetching and checking the media
 * (its container). publishing: the container is FINISHED and media_publish
 * was asked. published: it's live (`permalink`). failed: Instagram refused
 * it (`errorMessage`); nothing was posted.
 */
export const PRODUCT_AD_POST_STATES = [
  "processing",
  "publishing",
  "published",
  "failed",
] as const;
export type ProductAdPostState = (typeof PRODUCT_AD_POST_STATES)[number];

/** Instagram's longest caption, in characters. */
export const PRODUCT_AD_CAPTION_MAX = 2200;
/** Instagram's most hashtags in one caption. */
export const PRODUCT_AD_CAPTION_HASHTAGS_MAX = 30;
/** Slides one carousel post has here (Instagram allows up to 20). */
export const PRODUCT_AD_CAROUSEL_MIN_SLIDES = 2;
export const PRODUCT_AD_CAROUSEL_MAX_SLIDES = 4;

/**
 * One of the ad's stills, as a post names it: the kind, the product (null
 * for a still of every product: collection, price_list) and, for studio, the
 * colourway (the product's default when absent). The format follows the
 * destination: "story" for a Story, "feed" otherwise.
 */
export type ProductAdStillChoice = {
  kind: ProductAdStillKind;
  productId: string | null;
  colourway?: ProductAdStudioColourway | null;
};

/**
 * POST /products/ads/[adId]/publish: post the ad on Instagram. Answers 202
 * `{post}`; a repeated `requestId` answers the same post.
 * - reel: the ad's video (`still` and `slides` absent);
 * - story: the video, or `still` (a 9:16 still: big_price, price_list);
 * - post: `still` (a 4:5 still: room, studio, big_price, collection);
 * - carousel: `slides`, 2 to 4 4:5 stills in order (absent: Collection, then
 *   one In a room per product).
 * `caption` is the confirm sheet's text, at most PRODUCT_AD_CAPTION_MAX
 * characters; absent, the ad's `post.text`. Code appends nothing to it.
 */
export type ProductAdPublishRequest = {
  /** The page's id for this press, so a repeat posts nothing twice. */
  requestId: string;
  destination: ProductAdPostDestination;
  still?: ProductAdStillChoice;
  slides?: ProductAdStillChoice[];
  caption?: string;
};

/** One Instagram post of the ad, as the workbench and Out on Meta show it. */
export type ProductAdPostRecord = {
  id: string;
  destination: ProductAdPostDestination;
  /** The picture posted for a post or a picture Story; null for a Reel or a video Story. */
  still: ProductAdStillChoice | null;
  /** A carousel's pictures, in order; [] for anything else. */
  slides: ProductAdStillChoice[];
  /** The render whose video or stills were posted. */
  renderNo: number;
  /** The posted video's motion (its Reel tile); null for pictures. */
  motion: ProductAdMotion | null;
  state: ProductAdPostState;
  /** The post on Instagram, once it's published. */
  permalink: string | null;
  /** Why it failed; null unless `state` is failed. */
  errorCode: ProductsMetaFailureCode | null;
  /** Instagram's reason in plain English, shown to the owner; null unless failed. */
  errorMessage: string | null;
  requestedAt: string;
  publishedAt: string | null;
};

/** POST .../publish and GET .../publish/[postId] (which advances the post first). */
export type ProductAdPublishResponse = { post: ProductAdPostRecord };

// ---------------------------------------------------------------------------
// The Click-to-WhatsApp ad (stream P2)

/** What the ad shows: the video with its poster, or the In a room (or Studio) feed still. */
export const PRODUCT_AD_CTWA_ASSETS = ["video", "picture"] as const;
export type ProductAdCtwaAsset = (typeof PRODUCT_AD_CTWA_ASSETS)[number];

/**
 * Where the ad's making is: the step being made (video: the video uploaded
 * and processed at Meta, or the picture's hash; then the campaign, the ad
 * set, the creative and the ad, each created PAUSED), then paused (all made,
 * nothing spent), running (Run asked, `effectiveStatus` says whether Meta
 * still reviews it) or failed (`errorMessage`). A retry resumes from the
 * last step made.
 */
export const PRODUCT_AD_CTWA_STATES = [
  "video",
  "campaign",
  "adset",
  "creative",
  "ad",
  "paused",
  "running",
  "failed",
] as const;
export type ProductAdCtwaState = (typeof PRODUCT_AD_CTWA_STATES)[number];

/** The steps made in order before the ad is paused, for the Graph steps line. */
export const PRODUCT_AD_CTWA_STEPS = [
  "video",
  "campaign",
  "adset",
  "creative",
  "ad",
] as const satisfies readonly ProductAdCtwaState[];
export type ProductAdCtwaStep = (typeof PRODUCT_AD_CTWA_STEPS)[number];

/** Run's caps when the server's env sets none: $1 a day for at most 3 days. */
export const PRODUCT_AD_CTWA_RUN_DEFAULT_MAX_DAILY_CENTS = 100;
export const PRODUCT_AD_CTWA_RUN_DEFAULT_MAX_DAYS = 3;
/** The ad account's minimum daily budget (USD). */
export const PRODUCT_AD_CTWA_MIN_DAILY_CENTS = 100;

/**
 * POST /products/ads/[adId]/ctwa: "Create ad". Creates the campaign, ad set,
 * creative and ad PAUSED (nothing spent until Run; Meta may review it).
 * Answers 202
 * `{ctwa}`; a repeated `requestId` answers the same one. After a final
 * failure, a new `requestId` creates again (the next attempt).
 */
export type ProductAdCtwaRequest = {
  requestId: string;
  asset: ProductAdCtwaAsset;
};

/**
 * POST /products/ads/[adId]/ctwa/run: "Run", after its confirm. The server
 * caps both whatever is sent (409 budget_refused above them), and refuses it
 * all unless PRODUCTS_CTWA_RUN_ENABLED=1 (409 run_disabled).
 */
export type ProductAdCtwaRunRequest = {
  dailyBudgetCents: number;
  days: number;
};

/** The Click-to-WhatsApp ad of the ad, as the workbench and Out on Meta show it. */
export type ProductAdCtwaRecord = {
  /** 1 for the first try; one more for each "Create again" after a final failure. */
  attempt: number;
  asset: ProductAdCtwaAsset;
  state: ProductAdCtwaState;
  /** Meta's effective_status of the ad (PAUSED, PENDING_REVIEW, ACTIVE, DISAPPROVED…); null before the ad exists. */
  effectiveStatus: string | null;
  /** The ad in Ads Manager, once it exists. */
  adsManagerUrl: string | null;
  /** While it runs: the daily budget and when it stops. */
  dailyBudgetCents: number | null;
  endsAt: string | null;
  errorCode: ProductsMetaFailureCode | null;
  /**
   * Meta's reason in plain English; null unless failed. Also set on a paused
   * ad whose Run Meta refused (it stays paused, nothing spent).
   */
  errorMessage: string | null;
  /**
   * The step a failed attempt stopped at (the Graph steps line marks it); a
   * retry resumes there. Null unless failed, or when it failed once all were
   * made (Meta didn't approve the ad).
   */
  failedStep?: ProductAdCtwaStep | null;
};

/** POST .../ctwa and .../ctwa/run answer it; GET .../ctwa answers it (null when none was asked) after one step. */
export type ProductAdCtwaResponse = { ctwa: ProductAdCtwaRecord | null };

/** Everything that went out on Meta from one ad (`ProductAdRecord.meta`). */
export type ProductAdMetaRecord = {
  /** Newest last. */
  posts: ProductAdPostRecord[];
  ctwa: ProductAdCtwaRecord | null;
};

// ---------------------------------------------------------------------------
// Readiness: GET /products/meta (P1, with P2's ctwaReadiness())

/**
 * What the workspace can do on Meta now: booleans and names only, never a
 * token, an id or a phone number. Cached 60 s per workspace on the server.
 */
export type ProductsMetaReadiness = {
  instagram: {
    connected: boolean;
    /** The Instagram account's @name, without the "@". */
    username: string | null;
    /** Connected with the content-publishing permission. */
    canPublish: boolean;
    /** Posts left in Instagram's 24-hour limit (100); null when it can't be read. */
    quotaLeft: number | null;
  };
  ads: ProductsCtwaReadiness;
  whatsapp: { connected: boolean };
  /** What stops a make paying for its AI action now ("AI is off for your company"); null when nothing does. */
  ai: { blocked: ProductAdAdmissionStop | null };
};

/** The Meta Ads half of readiness, from lib/products/ctwa.ts's ctwaReadiness(). */
export type ProductsCtwaReadiness = {
  connected: boolean;
  adAccountName: string | null;
  /** The ad account's currency ("USD"); null when unknown. */
  currency: string | null;
  pageName: string | null;
  /** Whether the Page has the WhatsApp number linked; null when it can't be read. */
  pageHasWhatsApp: boolean | null;
  /** The ads token can't see the Instagram account: Facebook placements only. */
  instagramPlacements: false;
  /** Whether Run is on (PRODUCTS_CTWA_RUN_ENABLED=1), and its caps. */
  runEnabled: boolean;
  runMaxDailyCents: number;
  runMaxDays: number;
};

export type ProductsMetaReadinessResponse = { meta: ProductsMetaReadiness };

// ---------------------------------------------------------------------------
// Failures

/**
 * Why a post or the Click-to-WhatsApp ad failed, as stored on it. Each is
 * also a ProductsErrorCode, with its message in api.ts.
 */
export const PRODUCTS_META_FAILURE_CODES = [
  "instagram_not_connected",
  "instagram_quota",
  "post_failed",
  "ads_not_connected",
  "page_whatsapp_missing",
  "ctwa_failed",
  "budget_refused",
  "run_disabled",
  "price_to_check",
] as const;
export type ProductsMetaFailureCode =
  (typeof PRODUCTS_META_FAILURE_CODES)[number];
