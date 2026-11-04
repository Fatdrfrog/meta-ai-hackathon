import "server-only";
import { decryptMaybeString } from "@/lib/crypto";
import * as metaAds from "@/lib/meta-ads/ctwa";
import {
  MetaAdsGraphError,
  toMetaAdsGraphError,
  type MetaAdsAuth,
} from "@/lib/meta-ads/ctwa";
import { normalizeMetaAdAccountId } from "@/lib/meta-ads/meta-ad-account-id";
import { META_ADS_SOURCE_TYPE } from "@/lib/meta-ads/meta-ads-source";
import { ensureMediaApiCreativeAssetReadUrlPort } from "@/lib/google/creative-asset-read-url-media-api-adapter";
import { isAdObjectId } from "@/lib/products/ad-request";
import { toCtwaRecord } from "@/lib/products/ctwa-record";
import { productPhotoUrl } from "@/lib/products/photo-urls";
import {
  PRODUCT_AD_CTWA_ASSETS,
  PRODUCT_AD_CTWA_MIN_DAILY_CENTS,
  PRODUCT_AD_CTWA_RUN_DEFAULT_MAX_DAILY_CENTS,
  PRODUCT_AD_CTWA_RUN_DEFAULT_MAX_DAYS,
  type ProductAdCtwaAsset,
  type ProductAdCtwaRecord,
  type ProductAdCtwaRequest,
  type ProductAdCtwaRunRequest,
  type ProductAdCtwaState,
  type ProductsCtwaReadiness,
  type ProductsErrorCode,
  type ProductsMetaFailureCode,
  type StoredFileRef,
} from "@/lib/products/types";
import {
  ProductAd,
  type IProductAd,
  type ProductAdStoredCtwa,
} from "@/models/product-ad";
import { WorkspaceProduct } from "@/models/workspace-product";
import { getCompanyIdForWorkspace } from "@icecore/shared/lib/workspace-company";
import { asRecord } from "@icecore/shared/lib/value-utils";

// The ad's Click-to-WhatsApp ad (studio v3): "Create ad" makes the video (or
// picture), a campaign, an ad set, a creative and an ad through the Marketing
// API, every one PAUSED, so nothing is spent until Run. Meta may review a
// paused ad. This is a
// resumable state machine stored on the ad (`meta.ctwa`): each step saves its
// id before the next starts, a lost answer is looked up by its deterministic
// name (airi-products-<adId>-<attempt>-<step>), and a 30 s lease keeps two
// polls from making the same step. "Run" (behind PRODUCTS_CTWA_RUN_ENABLED=1)
// sets a budget the server caps and switches the ad on; delivery still
// requires Meta's approval.
// Also: what the workspace's Meta Ads can do (ctwaReadiness), for GET
// /products/meta. Nothing here returns or logs a token or a phone number.

export { toCtwaRecord } from "@/lib/products/ctwa-record";

/** Run's caps and switch, read from the server's env each call. */
export type ProductsCtwaRunCaps = {
  /** PRODUCTS_CTWA_RUN_ENABLED=1; Run is refused (run_disabled) otherwise. */
  enabled: boolean;
  /** PRODUCTS_CTWA_RUN_MAX_DAILY_CENTS, at least Meta's $1 minimum; 100 when unset. */
  maxDailyCents: number;
  /** PRODUCTS_CTWA_RUN_MAX_DAYS, at least 1; 3 when unset. */
  maxDays: number;
};

const positiveInteger = (value: string | undefined): number | null => {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

/** Run's caps, whatever the client sends: the server re-checks every Run against them. */
export function productsCtwaRunCaps(
  env: Readonly<Record<string, string | undefined>> = process.env
): ProductsCtwaRunCaps {
  return {
    enabled: env.PRODUCTS_CTWA_RUN_ENABLED?.trim() === "1",
    maxDailyCents: Math.max(
      PRODUCT_AD_CTWA_MIN_DAILY_CENTS,
      positiveInteger(env.PRODUCTS_CTWA_RUN_MAX_DAILY_CENTS) ??
        PRODUCT_AD_CTWA_RUN_DEFAULT_MAX_DAILY_CENTS
    ),
    maxDays:
      positiveInteger(env.PRODUCTS_CTWA_RUN_MAX_DAYS) ??
      PRODUCT_AD_CTWA_RUN_DEFAULT_MAX_DAYS,
  };
}

// ---------------------------------------------------------------------------
// What it runs on: the Graph calls, the ad's storage, the workspace's Meta
// Ads token. Tests swap them.

/** The Marketing API calls the state machine makes (lib/meta-ads/ctwa.ts). */
export type CtwaGraph = Pick<
  typeof metaAds,
  | "adAccountInfo"
  | "promotablePages"
  | "pageWhatsAppLinked"
  | "findByName"
  | "findAdVideoByName"
  | "uploadAdVideo"
  | "adVideoStatus"
  | "uploadAdImage"
  | "createCampaign"
  | "validateAdSet"
  | "createAdSet"
  | "createAdCreative"
  | "createAd"
  | "setAdSetBudget"
  | "setObjectStatus"
  | "adReview"
>;

/** What the state machine reads of an ad. */
export type CtwaAdDoc = Pick<
  IProductAd,
  "status" | "products" | "render" | "script" | "stills" | "stillSet"
> & {
  _id: unknown;
  meta?: { ctwa?: ProductAdStoredCtwa | null } | null;
};

const AD_FIELDS =
  "status products.productId products.name render script.ctwa stills stillSet meta.ctwa";

/** Reads and writes the ad's `meta.ctwa`, and only that. */
export type CtwaStore = {
  load(workspaceId: string, adId: string): Promise<CtwaAdDoc | null>;
  /**
   * Puts `next` in place of the ad's ctwa if it still is the one with
   * `expectedRequestId` (null: none yet). False when another press won.
   */
  replace(
    workspaceId: string,
    adId: string,
    expectedRequestId: string | null,
    next: ProductAdStoredCtwa
  ): Promise<boolean>;
  /** Takes the 30 s lease on the ctwa with `requestId`; the ad as it then is, or null when another poll holds it. */
  lease(
    workspaceId: string,
    adId: string,
    requestId: string,
    now: Date,
    until: Date
  ): Promise<CtwaAdDoc | null>;
  /** Saves `patch` on the ctwa this lease holds; false when the lease was lost. */
  save(
    workspaceId: string,
    adId: string,
    held: { requestId: string; leaseUntil: Date },
    patch: Partial<ProductAdStoredCtwa>
  ): Promise<boolean>;
};

export type CtwaDeps = {
  graph: CtwaGraph;
  store: CtwaStore;
  /** The workspace's Meta Ads token and ad account; null when it has none that works. */
  auth(workspaceId: string): Promise<MetaAdsAuth | null>;
  /** A signed link (1 h) to one of the ad's files. */
  sign(workspaceId: string, ref: StoredFileRef | null): Promise<string | null>;
  /** The picture's bytes, read from its signed link. */
  fetchBytes(url: string): Promise<Uint8Array>;
  /** Whether a product in the ad has a price to check (its red tag). */
  priceToCheck(workspaceId: string, productIds: string[]): Promise<boolean>;
  env: Readonly<Record<string, string | undefined>>;
  now(): Date;
};

const prefixed = (patch: Partial<ProductAdStoredCtwa>) =>
  Object.fromEntries(
    Object.entries(patch).map(([key, value]) => [`meta.ctwa.${key}`, value])
  );

const mongoStore: CtwaStore = {
  async load(workspaceId, adId) {
    return ProductAd.findOne({ _id: adId, workspaceId })
      .select(AD_FIELDS)
      .lean<CtwaAdDoc | null>();
  },
  async replace(workspaceId, adId, expectedRequestId, next) {
    const base = { _id: adId, workspaceId };
    if (expectedRequestId) {
      const result = await ProductAd.updateOne(
        { ...base, "meta.ctwa.requestId": expectedRequestId },
        { $set: { "meta.ctwa": next } }
      );
      return result.modifiedCount > 0;
    }
    // No ctwa yet: beside the ad's posts when it has a `meta`, else a new
    // `meta` (matched only while it still has none, so no post is wiped).
    const beside = await ProductAd.updateOne(
      { ...base, meta: { $type: "object" }, "meta.ctwa": null },
      { $set: { "meta.ctwa": next } }
    );
    if (beside.modifiedCount > 0) return true;
    const fresh = await ProductAd.updateOne(
      { ...base, meta: null },
      { $set: { meta: { posts: [], ctwa: next } } }
    );
    return fresh.modifiedCount > 0;
  },
  async lease(workspaceId, adId, requestId, now, until) {
    return ProductAd.findOneAndUpdate(
      {
        _id: adId,
        workspaceId,
        "meta.ctwa.requestId": requestId,
        $or: [
          { "meta.ctwa.leaseUntil": null },
          { "meta.ctwa.leaseUntil": { $lte: now } },
        ],
      },
      { $set: { "meta.ctwa.leaseUntil": until } },
      { new: true }
    )
      .select(AD_FIELDS)
      .lean<CtwaAdDoc | null>();
  },
  async save(workspaceId, adId, held, patch) {
    const result = await ProductAd.updateOne(
      {
        _id: adId,
        workspaceId,
        "meta.ctwa.requestId": held.requestId,
        "meta.ctwa.leaseUntil": held.leaseUntil,
      },
      { $set: prefixed(patch) }
    );
    return result.matchedCount > 0;
  },
};

/** The workspace's Meta Ads token (the system user's) and its selected ad account. */
async function workspaceMetaAdsAuth(
  workspaceId: string
): Promise<MetaAdsAuth | null> {
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const [source, companyId] = await Promise.all([
    supabaseAdmin
      .from("sources")
      .select("company_id, credentials")
      .eq("workspace_id", workspaceId)
      .eq("type", META_ADS_SOURCE_TYPE)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    getCompanyIdForWorkspace(supabaseAdmin, workspaceId),
  ]);
  const row = source.data as {
    company_id?: unknown;
    credentials?: unknown;
  } | null;
  if (source.error || !row || !companyId || row.company_id !== companyId)
    return null;
  const credentials = asRecord(row.credentials);
  if (credentials.ads_access_invalidated_at) return null;
  const accessToken = decryptMaybeString(credentials.access_token);
  const accounts = Array.isArray(credentials.ad_accounts)
    ? credentials.ad_accounts
    : [];
  const adAccountId =
    normalizeMetaAdAccountId(credentials.selected_ad_account_id) ||
    (!("selected_ad_account_id" in credentials)
      ? normalizeMetaAdAccountId(asRecord(accounts[0]).id)
      : "");
  return accessToken && adAccountId ? { accessToken, adAccountId } : null;
}

const PICTURE_MAX_BYTES = 8 * 1024 * 1024;

async function fetchPictureBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok)
    throw new MetaAdsGraphError({
      kind: "transient",
      code: null,
      subcode: null,
      userMessage: "The picture couldn't be read",
    });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > PICTURE_MAX_BYTES)
    throw new MetaAdsGraphError({
      kind: "refused",
      code: null,
      subcode: null,
      userMessage: "The picture is too large for an ad",
    });
  return bytes;
}

/**
 * Whether a product in the ad has a price to check: an open doubt about its
 * price (the red tag). The same query as meta-publish.ts's adPriceToCheck,
 * which imports this file (so it can't be imported back here).
 */
async function priceToCheckOf(
  workspaceId: string,
  productIds: string[]
): Promise<boolean> {
  const ids = productIds.filter(isAdObjectId);
  if (!ids.length) return false;
  const found = await WorkspaceProduct.exists({
    workspaceId,
    _id: { $in: ids },
    "doubts.about": "price",
  });
  return Boolean(found);
}

/**
 * A fresh signed link with its full hour: Meta fetches it later, so never
 * the display cache's (withProductPhotoUrls), which may be older.
 */
function signForMeta(
  workspaceId: string,
  ref: StoredFileRef | null
): Promise<string | null> {
  ensureMediaApiCreativeAssetReadUrlPort();
  return productPhotoUrl(workspaceId, ref);
}

const defaultDeps: CtwaDeps = {
  graph: metaAds,
  store: mongoStore,
  auth: workspaceMetaAdsAuth,
  sign: signForMeta,
  fetchBytes: fetchPictureBytes,
  priceToCheck: priceToCheckOf,
  get env() {
    return process.env;
  },
  now: () => new Date(),
};

const depsOf = (deps?: Partial<CtwaDeps>): CtwaDeps => ({
  ...defaultDeps,
  ...deps,
});

// ---------------------------------------------------------------------------
// Readiness

/**
 * The Meta Ads half of GET /products/meta: whether Meta Ads is connected,
 * the ad account's and Page's names, whether the Page has the WhatsApp
 * number linked, and Run's switch and caps. Names and booleans only, never
 * a token, an id or a phone number. Never throws: what can't be read is
 * false or null.
 */
export async function ctwaReadiness(
  workspaceId: string,
  overrides?: Partial<CtwaDeps>
): Promise<ProductsCtwaReadiness> {
  const deps = depsOf(overrides);
  const caps = productsCtwaRunCaps(deps.env);
  const ready: ProductsCtwaReadiness = {
    connected: false,
    adAccountName: null,
    currency: null,
    pageName: null,
    pageHasWhatsApp: null,
    instagramPlacements: false,
    runEnabled: caps.enabled,
    runMaxDailyCents: caps.maxDailyCents,
    runMaxDays: caps.maxDays,
  };
  try {
    const auth = await deps.auth(workspaceId);
    if (!auth) return ready;
    // Within the 5 s GET /products/meta gives it.
    const signal = AbortSignal.timeout(4_500);
    const [account, pages] = await Promise.all([
      deps.graph.adAccountInfo(auth, { signal }).catch(toMetaAdsGraphError),
      deps.graph.promotablePages(auth, { signal }).catch(() => null),
    ]);
    if (account instanceof MetaAdsGraphError) {
      // A token Meta refuses is no connection; a hiccup still is one.
      return account.kind === "auth" || account.kind === "refused"
        ? ready
        : { ...ready, connected: true };
    }
    const page = pages?.[0] ?? null;
    const pageHasWhatsApp = page
      ? await deps.graph
          .pageWhatsAppLinked(auth.accessToken, page.id, { signal })
          .catch(() => null)
      : null;
    return {
      ...ready,
      connected: true,
      adAccountName: account.name,
      currency: account.currency,
      pageName: page?.name ?? null,
      pageHasWhatsApp,
    };
  } catch {
    return ready;
  }
}

// ---------------------------------------------------------------------------
// The state machine

/** How long one poll holds the ad's ctwa. */
const LEASE_MS = 30_000;
/** How long one request spends on Graph calls (the route answers within ~10 s). */
const STEP_BUDGET_MS = 7_000;
/** A step needs this much of the budget left to start. */
const STEP_MIN_MS = 1_500;
/** Making longer than this fails ("Meta took too long"); nothing was spent. */
const STALL_MS = 20 * 60_000;
/** How often the review state is read again while the ad is paused or running. */
const REVIEW_EVERY_MS = 20_000;
/** A paused ad set's planned run when it's created (Run sets its own). */
const PAUSED_PLAN_DAYS = 3;
const DAY_MS = 24 * 60 * 60_000;
/** Run's budgets are US cents, so it runs only on a USD ad account. */
const RUN_CURRENCY = "USD";
/** How long Run waits for a poll that holds the lease. */
const RUN_LEASE_WAIT_MS = 1_500;

const MAKING_STATES: readonly ProductAdCtwaState[] = [
  "video",
  "campaign",
  "adset",
  "creative",
  "ad",
];
const isMaking = (state: ProductAdCtwaState) => MAKING_STATES.includes(state);

/** The deterministic name of an attempt's object, so a lost answer is found. */
export const ctwaObjectName = (
  adId: string,
  attempt: number,
  step: "video" | "campaign" | "adset" | "creative" | "ad"
) => `airi-products-${adId}-${attempt}-${step}`;

/** The step an attempt resumes at: the first whose id isn't stored. */
function resumeState(ctwa: ProductAdStoredCtwa): ProductAdCtwaState {
  if (!(ctwa.asset === "video" ? ctwa.videoId : ctwa.imageHash)) return "video";
  // An uploaded video is asked about again (cheap) before anything uses it.
  if (!ctwa.campaignId) return ctwa.asset === "video" ? "video" : "campaign";
  if (!ctwa.adSetId) return "adset";
  if (!ctwa.creativeId) return "creative";
  if (!ctwa.adId) return "ad";
  return "paused";
}

type CtwaMedia = {
  renderNo: number;
  video: StoredFileRef | null;
  poster: StoredFileRef | null;
  picture: StoredFileRef | null;
};

/**
 * What the ad shows: the shown render's video and poster, or its In a room
 * still of the first product (else its Studio still, else v2's feed still).
 * Null while the ad isn't ready (for a new attempt), when the render isn't
 * `renderNo` (an attempt being made), or when it lacks what `asset` needs.
 */
function ctwaMedia(
  doc: CtwaAdDoc,
  asset: ProductAdCtwaAsset,
  of: { ready: true } | { renderNo: number | null | undefined }
): CtwaMedia | null {
  const render = doc.render;
  if (!render?.video) return null;
  if ("ready" in of ? doc.status !== "ready" : of.renderNo !== render.renderNo)
    return null;
  const firstProductId = doc.products[0]?.productId ?? null;
  const stills =
    doc.stillSet?.renderNo === render.renderNo ? doc.stillSet.items : [];
  const still = (kind: "room" | "studio") =>
    stills.find(
      item =>
        item.kind === kind &&
        item.format === "feed" &&
        item.productId === firstProductId
    )?.ref ?? null;
  const picture = still("room") ?? still("studio") ?? doc.stills?.feed ?? null;
  const media = {
    renderNo: render.renderNo,
    video: render.video,
    poster: render.poster ?? null,
    picture,
  };
  if (asset === "video" ? !media.poster : !media.picture) return null;
  return media;
}

const cut = (value: string | null | undefined, max: number) =>
  Array.from((value ?? "").replace(/\s+/g, " ").trim())
    .slice(0, max)
    .join("");

/** The ad's words for the creative: Muse Spark's primary text and headline. */
function ctwaWords(doc: CtwaAdDoc) {
  const words = doc.script?.ctwa;
  const greeting = cut(words?.greeting, 320);
  // The first question a buyer could tap is what WhatsApp writes for them.
  const buyerMessage = cut(words?.questions?.[0], 160);
  return {
    message: cut(words?.primaryText, 250),
    headline: cut(words?.headline, 80) || cut(doc.products[0]?.name, 80),
    welcome: greeting && buyerMessage ? { greeting, buyerMessage } : null,
  };
}

const failurePatch = (
  code: ProductsMetaFailureCode,
  message: string
): Partial<ProductAdStoredCtwa> => ({
  state: "failed",
  errorCode: code,
  errorMessage: cut(message, 500),
});

/** A refused step, stored on the ctwa: what the owner reads and the code the page explains. */
function failureOf(error: MetaAdsGraphError): Partial<ProductAdStoredCtwa> {
  if (error.kind === "auth")
    return failurePatch(
      "ads_not_connected",
      `Meta Ads needs connecting again. ${error.userMessage}`
    );
  if (error.kind === "whatsapp")
    return failurePatch("page_whatsapp_missing", error.userMessage);
  return failurePatch("ctwa_failed", error.userMessage);
}

type StepOutcome =
  | { kind: "next"; patch: Partial<ProductAdStoredCtwa> }
  | { kind: "wait"; patch?: Partial<ProductAdStoredCtwa> };

/** Makes the ctwa's current step; throws a MetaAdsGraphError when Meta refuses or hiccups. */
async function makeStep(params: {
  deps: CtwaDeps;
  workspaceId: string;
  adId: string;
  doc: CtwaAdDoc;
  ctwa: ProductAdStoredCtwa;
  auth: MetaAdsAuth;
  signal: AbortSignal;
}): Promise<StepOutcome> {
  const { deps, workspaceId, adId, doc, ctwa, auth, signal } = params;
  const graph = deps.graph;
  const name = (step: Parameters<typeof ctwaObjectName>[2]) =>
    ctwaObjectName(adId, ctwa.attempt, step);
  const pageId = ctwa.pageId;
  if (!pageId)
    return {
      kind: "next",
      patch: failurePatch(
        "page_whatsapp_missing",
        "The ad account has no Facebook Page to run the ad from"
      ),
    };
  // The attempt's own render: a newer video needs a new attempt.
  const media = ctwaMedia(doc, ctwa.asset, { renderNo: ctwa.renderNo });
  const gone = (what: string) =>
    ({
      kind: "next",
      patch: failurePatch(
        "ctwa_failed",
        `The ad's ${what} changed while the WhatsApp ad was made. Create it again`
      ),
    }) as const;
  switch (ctwa.state) {
    case "video": {
      if (ctwa.asset === "picture") {
        if (ctwa.imageHash)
          return { kind: "next", patch: { state: "campaign" } };
        const url = media ? await deps.sign(workspaceId, media.picture) : null;
        if (!url) return gone("picture");
        const imageHash = await graph.uploadAdImage(
          auth,
          { bytes: await deps.fetchBytes(url), name: `${name("video")}.jpg` },
          { signal }
        );
        return { kind: "next", patch: { imageHash, state: "campaign" } };
      }
      if (!ctwa.videoId) {
        const found = await graph.findAdVideoByName(auth, name("video"), {
          signal,
        });
        if (found) return { kind: "wait", patch: { videoId: found } };
        const url = media ? await deps.sign(workspaceId, media.video) : null;
        if (!url) return gone("video");
        const videoId = await graph.uploadAdVideo(
          auth,
          { fileUrl: url, name: name("video") },
          { signal }
        );
        // Meta fetches and processes it now; the next poll asks how it went.
        return { kind: "wait", patch: { videoId } };
      }
      const status = await graph.adVideoStatus(auth, ctwa.videoId, { signal });
      if (status.state === "ready")
        return { kind: "next", patch: { state: "campaign" } };
      if (status.state === "error")
        return {
          kind: "next",
          patch: {
            ...failurePatch(
              "ctwa_failed",
              `Meta couldn't process the video${status.reason ? `: ${status.reason}` : ""}`
            ),
            // A retry uploads it again, as a new attempt.
            videoId: null,
          },
        };
      return { kind: "wait" };
    }
    case "campaign": {
      const campaignId =
        (await graph.findByName(auth, "campaigns", name("campaign"), {
          signal,
        })) ??
        (await graph.createCampaign(
          auth,
          { name: name("campaign") },
          { signal }
        ));
      return { kind: "next", patch: { campaignId, state: "adset" } };
    }
    case "adset": {
      const found = await graph.findByName(auth, "adsets", name("adset"), {
        signal,
      });
      if (found)
        return { kind: "next", patch: { adSetId: found, state: "creative" } };
      const now = deps.now();
      const adSet = {
        name: name("adset"),
        campaignId: ctwa.campaignId ?? "",
        pageId,
        dailyBudgetCents: PRODUCT_AD_CTWA_MIN_DAILY_CENTS,
        startTime: now,
        endTime: new Date(now.getTime() + PAUSED_PLAN_DAYS * DAY_MS),
      };
      // Meta checks it first (creating nothing): a Page without WhatsApp is
      // refused here, before anything else is made.
      await graph.validateAdSet(auth, adSet, { signal });
      const adSetId = await graph.createAdSet(auth, adSet, { signal });
      return { kind: "next", patch: { adSetId, state: "creative" } };
    }
    case "creative": {
      const found = await graph.findByName(
        auth,
        "adcreatives",
        name("creative"),
        { signal }
      );
      if (found)
        return { kind: "next", patch: { creativeId: found, state: "ad" } };
      const words = ctwaWords(doc);
      let creativeMedia: metaAds.CtwaCreativeParams["media"];
      if (ctwa.asset === "video") {
        const posterUrl = media
          ? await deps.sign(workspaceId, media.poster)
          : null;
        if (!posterUrl || !ctwa.videoId) return gone("video");
        creativeMedia = { kind: "video", videoId: ctwa.videoId, posterUrl };
      } else {
        creativeMedia = { kind: "picture", imageHash: ctwa.imageHash ?? "" };
      }
      const creative: metaAds.CtwaCreativeParams = {
        name: name("creative"),
        pageId,
        message: words.message,
        headline: words.headline,
        media: creativeMedia,
        welcome: words.welcome,
      };
      let creativeId: string;
      try {
        creativeId = await graph.createAdCreative(auth, creative, { signal });
      } catch (error) {
        const failure = toMetaAdsGraphError(error);
        if (!creative.welcome || failure.kind !== "refused") throw failure;
        // Meta refused it with the greeting: once more without it, so
        // Meta's default greeting is used.
        creativeId = await graph.createAdCreative(
          auth,
          { ...creative, welcome: null },
          { signal }
        );
      }
      return { kind: "next", patch: { creativeId, state: "ad" } };
    }
    case "ad": {
      const adObjectId =
        (await graph.findByName(auth, "ads", name("ad"), { signal })) ??
        (await graph.createAd(
          auth,
          {
            name: name("ad"),
            adSetId: ctwa.adSetId ?? "",
            creativeId: ctwa.creativeId ?? "",
          },
          { signal }
        ));
      return {
        kind: "next",
        patch: {
          adId: adObjectId,
          state: "paused",
          effectiveStatus: "PAUSED",
          checkedAt: deps.now(),
        },
      };
    }
    default:
      return { kind: "wait" };
  }
}

/** Reads Meta's review state of a made ad; a disapproval fails it, so "Create ad" starts again. */
async function readReview(params: {
  deps: CtwaDeps;
  ctwa: ProductAdStoredCtwa;
  auth: MetaAdsAuth;
  signal: AbortSignal;
}): Promise<Partial<ProductAdStoredCtwa>> {
  const { deps, ctwa, auth, signal } = params;
  const review = await deps.graph.adReview(auth, ctwa.adId ?? "", { signal });
  const checkedAt = deps.now();
  if (review.effectiveStatus === "DISAPPROVED")
    return {
      ...failurePatch(
        "ctwa_failed",
        `Meta didn't approve the ad${review.feedback ? `: ${review.feedback}` : ""}`
      ),
      effectiveStatus: review.effectiveStatus,
      checkedAt,
    };
  const activationUnknown =
    ctwa.state === "running" && ctwa.effectiveStatus === null;
  const settledActivation =
    activationUnknown && review.effectiveStatus !== null;
  return {
    effectiveStatus: review.effectiveStatus ?? ctwa.effectiveStatus,
    checkedAt,
    ...(settledActivation
      ? {
          state: ["PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED"].includes(
            review.effectiveStatus!
          )
            ? "paused"
            : "running",
          errorCode: null,
          errorMessage: null,
        }
      : {}),
  };
}

const time = (value: unknown): number =>
  value instanceof Date
    ? value.getTime()
    : typeof value === "string"
      ? Date.parse(value)
      : NaN;

/**
 * Takes the lease and advances the ad's ctwa as far as the request's budget
 * allows: each step's id is saved before the next, Meta's hiccups wait for
 * the next poll, its refusals land on the ctwa. A paused or running ad gets
 * its review state read (at most every 20 s). The ctwa as it then is.
 */
async function advanceHeld(params: {
  deps: CtwaDeps;
  workspaceId: string;
  adId: string;
  requestId: string;
}): Promise<ProductAdStoredCtwa | null> {
  const { deps, workspaceId, adId, requestId } = params;
  const started = deps.now();
  const leaseUntil = new Date(started.getTime() + LEASE_MS);
  const doc = await deps.store.lease(
    workspaceId,
    adId,
    requestId,
    started,
    leaseUntil
  );
  if (!doc?.meta?.ctwa) return null;
  let ctwa: ProductAdStoredCtwa = { ...doc.meta.ctwa, leaseUntil };
  const held = { requestId, leaseUntil };
  const save = async (patch: Partial<ProductAdStoredCtwa>) => {
    const saved = await deps.store.save(workspaceId, adId, held, patch);
    if (saved) ctwa = { ...ctwa, ...patch };
    return saved;
  };
  // The budget runs on the real clock, whatever `deps.now` says.
  const deadline = Date.now() + STEP_BUDGET_MS;
  const signal = AbortSignal.timeout(STEP_BUDGET_MS);
  let releaseLease = true;
  try {
    const needsReview =
      (ctwa.state === "paused" || ctwa.state === "running") &&
      Boolean(ctwa.adId) &&
      !(started.getTime() - time(ctwa.checkedAt) < REVIEW_EVERY_MS);
    if (!isMaking(ctwa.state) && !needsReview) return ctwa;
    if (
      isMaking(ctwa.state) &&
      started.getTime() - time(ctwa.requestedAt) > STALL_MS
    ) {
      await save(
        failurePatch(
          "ctwa_failed",
          "Meta took too long to make the ad. Nothing was spent"
        )
      );
      return ctwa;
    }
    const auth = await deps.auth(workspaceId);
    if (!auth) {
      if (isMaking(ctwa.state))
        await save(
          failurePatch("ads_not_connected", "Meta Ads isn't connected anymore")
        );
      return ctwa;
    }
    // The attempt stays in the ad account it was started in.
    const attemptAuth: MetaAdsAuth = {
      accessToken: auth.accessToken,
      adAccountId: ctwa.adAccountId || auth.adAccountId,
    };
    if (needsReview) {
      try {
        await save(await readReview({ deps, ctwa, auth: attemptAuth, signal }));
      } catch (error) {
        // The review state waits for the next poll.
        void toMetaAdsGraphError(error);
      }
      return ctwa;
    }
    while (isMaking(ctwa.state) && Date.now() < deadline - STEP_MIN_MS) {
      let outcome: StepOutcome;
      try {
        // A timed-out create can still complete at Meta. Keep this lease
        // until its normal expiry unless the outcome was saved, so an
        // immediate poll cannot race the delayed write/name lookup.
        releaseLease = false;
        outcome = await makeStep({
          deps,
          workspaceId,
          adId,
          doc,
          ctwa,
          auth: attemptAuth,
          signal,
        });
      } catch (error) {
        const failure = toMetaAdsGraphError(error);
        if (failure.kind === "transient") break;
        await save(failureOf(failure));
        releaseLease = true;
        break;
      }
      if (outcome.patch && !(await save(outcome.patch))) break;
      releaseLease = true;
      if (outcome.kind === "wait") break;
    }
    return ctwa;
  } finally {
    if (releaseLease) {
      await deps.store
        .save(workspaceId, adId, held, { leaseUntil: null })
        .catch(() => false);
      ctwa = { ...ctwa, leaseUntil: null };
    }
  }
}

export type CtwaRefusal = {
  refused: ProductsErrorCode;
  status: number;
  issues?: string[];
};

/**
 * GET .../ctwa: the ad's Click-to-WhatsApp ad, advanced first (one request's
 * budget, under the lease). `{ctwa: null}` when none was asked for.
 */
export async function loadCtwa(params: {
  workspaceId: string;
  adId: string;
  deps?: Partial<CtwaDeps>;
}): Promise<{ ctwa: ProductAdCtwaRecord | null } | CtwaRefusal> {
  const deps = depsOf(params.deps);
  const doc = await deps.store.load(params.workspaceId, params.adId);
  if (!doc) return { refused: "ad_not_found", status: 404 };
  const current = doc.meta?.ctwa ?? null;
  if (!current) return { ctwa: null };
  const advanced = await advanceHeld({
    deps,
    workspaceId: params.workspaceId,
    adId: params.adId,
    requestId: current.requestId,
  });
  if (advanced) return { ctwa: toCtwaRecord(advanced) };
  // Another poll holds it: as it is.
  const latest = await deps.store.load(params.workspaceId, params.adId);
  return { ctwa: toCtwaRecord(latest?.meta?.ctwa ?? current) };
}

const isAsset = (value: unknown): value is ProductAdCtwaAsset =>
  typeof value === "string" &&
  (PRODUCT_AD_CTWA_ASSETS as readonly string[]).includes(value);

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** POST .../ctwa's body, or null when it isn't one. */
export function parseCtwaRequest(body: unknown): ProductAdCtwaRequest | null {
  const raw = asRecord(body);
  if (typeof raw.requestId !== "string" || !REQUEST_ID.test(raw.requestId))
    return null;
  if (!isAsset(raw.asset)) return null;
  return { requestId: raw.requestId, asset: raw.asset };
}

/** POST .../ctwa/run's body, or null when it isn't one (whole cents and days). */
export function parseCtwaRunRequest(
  body: unknown
): ProductAdCtwaRunRequest | null {
  const raw = asRecord(body);
  const { dailyBudgetCents, days } = raw;
  if (
    typeof dailyBudgetCents !== "number" ||
    !Number.isSafeInteger(dailyBudgetCents) ||
    typeof days !== "number" ||
    !Number.isSafeInteger(days)
  )
    return null;
  return { dailyBudgetCents, days };
}

/** A Graph failure before anything is stored: the refusal the route answers. */
function preCheckRefusal(error: unknown): CtwaRefusal {
  const failure = toMetaAdsGraphError(error);
  if (failure.kind === "auth")
    return { refused: "ads_not_connected", status: 409 };
  if (failure.kind === "whatsapp")
    return { refused: "page_whatsapp_missing", status: 409 };
  if (failure.kind === "transient")
    return { refused: "ctwa_failed", status: 503 };
  return { refused: "ctwa_failed", status: 409, issues: [failure.userMessage] };
}

/**
 * POST .../ctwa, "Create ad": checks the ad and the workspace's Meta Ads
 * (4xx refusals), then stores the ctwa and makes its first steps. A repeated
 * requestId, an ad being made or running, or a paused one of the same video
 * answers as it is (`started` false). After a failure it resumes from the
 * last step made; a new video or asset, a failed upload or Meta's
 * disapproval starts the next attempt (earlier objects stay at Meta, paused).
 */
export async function createCtwa(params: {
  workspaceId: string;
  adId: string;
  request: ProductAdCtwaRequest;
  deps?: Partial<CtwaDeps>;
}): Promise<{ ctwa: ProductAdCtwaRecord; started: boolean } | CtwaRefusal> {
  const { workspaceId, adId, request } = params;
  const deps = depsOf(params.deps);
  const doc = await deps.store.load(workspaceId, adId);
  if (!doc) return { refused: "ad_not_found", status: 404 };
  const current = doc.meta?.ctwa ?? null;
  const asIs = (ctwa: ProductAdStoredCtwa) => ({
    ctwa: toCtwaRecord(ctwa) as ProductAdCtwaRecord,
    started: false,
  });
  if (current?.requestId === request.requestId) return asIs(current);
  if (current && (isMaking(current.state) || current.state === "running"))
    return asIs(current);
  const media = ctwaMedia(doc, request.asset, { ready: true });
  if (!media) return { refused: "ad_not_ready", status: 409 };
  const sameShow =
    current?.asset === request.asset && current.renderNo === media.renderNo;
  if (current?.state === "paused" && sameShow) return asIs(current);

  const productIds = doc.products.map(product => product.productId);
  if (await deps.priceToCheck(workspaceId, productIds))
    return { refused: "price_to_check", status: 409 };
  const auth = await deps.auth(workspaceId);
  if (!auth) return { refused: "ads_not_connected", status: 409 };

  const resume =
    current?.state === "failed" &&
    sameShow &&
    Boolean(current.asset === "video" ? current.videoId : current.imageHash) &&
    current.effectiveStatus !== "DISAPPROVED";
  const adAccountId = resume
    ? current.adAccountId || auth.adAccountId
    : auth.adAccountId;
  const accountAuth = { ...auth, adAccountId };
  const signal = AbortSignal.timeout(6_000);
  let pageId: string;
  try {
    const account = await deps.graph.adAccountInfo(accountAuth, { signal });
    if (account.currency && account.currency !== RUN_CURRENCY)
      return {
        refused: "budget_refused",
        status: 409,
        issues: [`The ad account's currency is ${account.currency}, not USD`],
      };
    const pages = await deps.graph.promotablePages(accountAuth, { signal });
    const page = resume && current.pageId ? current.pageId : pages[0]?.id;
    if (!page) return { refused: "page_whatsapp_missing", status: 409 };
    pageId = page;
    const linked = await deps.graph
      .pageWhatsAppLinked(auth.accessToken, pageId, { signal })
      .catch(() => null);
    // Unknown is let through: the ad set's validate_only call decides.
    if (linked === false)
      return { refused: "page_whatsapp_missing", status: 409 };
  } catch (error) {
    return preCheckRefusal(error);
  }

  const now = deps.now();
  const next: ProductAdStoredCtwa = resume
    ? {
        ...current,
        requestId: request.requestId,
        state: resumeState(current),
        errorCode: null,
        errorMessage: null,
        requestedAt: now,
        leaseUntil: null,
        adAccountId,
        pageId,
      }
    : {
        requestId: request.requestId,
        attempt: (current?.attempt ?? 0) + 1,
        asset: request.asset,
        state: "video",
        videoId: null,
        imageHash: null,
        campaignId: null,
        adSetId: null,
        creativeId: null,
        adId: null,
        effectiveStatus: null,
        dailyBudgetCents: null,
        endsAt: null,
        errorCode: null,
        errorMessage: null,
        requestedAt: now,
        leaseUntil: null,
        adAccountId,
        pageId,
        renderNo: media.renderNo,
        checkedAt: null,
      };
  if (
    !(await deps.store.replace(
      workspaceId,
      adId,
      current?.requestId ?? null,
      next
    ))
  ) {
    // Another press won: its ctwa.
    const latest = await deps.store.load(workspaceId, adId);
    const theirs = latest?.meta?.ctwa;
    return theirs ? asIs(theirs) : { refused: "ctwa_failed", status: 503 };
  }
  // The page's polls (GET, every 3 s) make the steps, each within its own
  // request's budget, so this answer stays quick.
  return { ctwa: toCtwaRecord(next) as ProductAdCtwaRecord, started: true };
}

/**
 * POST .../ctwa/run, "Run" after its confirm: refused unless
 * PRODUCTS_CTWA_RUN_ENABLED=1 (run_disabled) and within the server's caps
 * (budget_refused), whatever the page sent. Sets the ad set's daily budget
 * and end, then switches the ad, the ad set and last the campaign on, so
 * nothing runs until all three are on. Meta reviews it before it runs:
 * `effectiveStatus` says where that is. A running ad answers as it is; a
 * Graph failure lands on the ctwa (still paused).
 */
export async function runCtwa(params: {
  workspaceId: string;
  adId: string;
  request: ProductAdCtwaRunRequest;
  deps?: Partial<CtwaDeps>;
}): Promise<{ ctwa: ProductAdCtwaRecord } | CtwaRefusal> {
  const { workspaceId, adId, request } = params;
  const deps = depsOf(params.deps);
  const caps = productsCtwaRunCaps(deps.env);
  if (!caps.enabled) return { refused: "run_disabled", status: 409 };
  if (
    request.dailyBudgetCents < PRODUCT_AD_CTWA_MIN_DAILY_CENTS ||
    request.days < 1
  )
    return {
      refused: "invalid_request",
      status: 400,
      issues: ["The ad runs at least $1 a day for at least a day"],
    };
  if (
    request.dailyBudgetCents > caps.maxDailyCents ||
    request.days > caps.maxDays
  )
    return { refused: "budget_refused", status: 409 };

  const doc = await deps.store.load(workspaceId, adId);
  if (!doc) return { refused: "ad_not_found", status: 404 };
  const current = doc.meta?.ctwa ?? null;
  if (!current) return { refused: "ad_not_ready", status: 409 };
  if (current.state === "running")
    return { ctwa: toCtwaRecord(current) as ProductAdCtwaRecord };
  if (
    current.state !== "paused" ||
    !current.campaignId ||
    !current.adSetId ||
    !current.adId
  )
    return { refused: "ad_not_ready", status: 409 };
  const productIds = doc.products.map(product => product.productId);
  if (await deps.priceToCheck(workspaceId, productIds))
    return { refused: "price_to_check", status: 409 };
  const auth = await deps.auth(workspaceId);
  if (!auth) return { refused: "ads_not_connected", status: 409 };
  const attemptAuth: MetaAdsAuth = {
    accessToken: auth.accessToken,
    adAccountId: current.adAccountId || auth.adAccountId,
  };
  try {
    const account = await deps.graph.adAccountInfo(attemptAuth, {
      signal: AbortSignal.timeout(STEP_BUDGET_MS),
    });
    if (account.currency !== RUN_CURRENCY)
      return {
        refused: "budget_refused",
        status: 409,
        issues: [
          `The ad account's currency is ${account.currency ?? "unknown"}, not USD`,
        ],
      };
  } catch (error) {
    return preCheckRefusal(error);
  }

  // A poll reading the review holds the lease for a moment: wait for it once.
  let started = deps.now();
  let leaseUntil = new Date(started.getTime() + LEASE_MS);
  let leased = await deps.store.lease(
    workspaceId,
    adId,
    current.requestId,
    started,
    leaseUntil
  );
  if (!leased) {
    await new Promise(resolve => setTimeout(resolve, RUN_LEASE_WAIT_MS));
    started = deps.now();
    leaseUntil = new Date(started.getTime() + LEASE_MS);
    leased = await deps.store.lease(
      workspaceId,
      adId,
      current.requestId,
      started,
      leaseUntil
    );
  }
  const ctwa = leased?.meta?.ctwa;
  if (!ctwa || ctwa.state !== "paused")
    return ctwa?.state === "running"
      ? { ctwa: toCtwaRecord(ctwa) as ProductAdCtwaRecord }
      : { refused: "ad_not_ready", status: 409 };
  const held = { requestId: current.requestId, leaseUntil };
  // Preflight and waiting for a poll's lease must not consume the budget
  // for switching the paused objects on.
  const signal = AbortSignal.timeout(STEP_BUDGET_MS);
  const endsAt = new Date(started.getTime() + request.days * DAY_MS);
  const pending: Partial<ProductAdStoredCtwa> = {
    state: "running",
    effectiveStatus: null,
    dailyBudgetCents: request.dailyBudgetCents,
    endsAt,
    checkedAt: null,
    errorCode: "ctwa_failed",
    errorMessage:
      "Meta has not confirmed whether the ad is running. Check Ads Manager before trying again.",
  };
  // Persist an uncertain activation before dispatch. If this request dies
  // mid-flight, another Run cannot treat the original paused snapshot as
  // permission to activate again; GET reconciles the existing ad instead.
  if (!(await deps.store.save(workspaceId, adId, held, pending)))
    return { refused: "ad_not_ready", status: 409 };
  let patch: Partial<ProductAdStoredCtwa>;
  let switching = false;
  let releaseLease = true;
  try {
    await deps.graph.setAdSetBudget(
      attemptAuth,
      ctwa.adSetId ?? "",
      { dailyBudgetCents: request.dailyBudgetCents, endTime: endsAt },
      { signal }
    );
    switching = true;
    // The campaign last: nothing delivers until all three are on.
    await deps.graph.setObjectStatus(attemptAuth, ctwa.adId ?? "", "ACTIVE", {
      signal,
    });
    await deps.graph.setObjectStatus(
      attemptAuth,
      ctwa.adSetId ?? "",
      "ACTIVE",
      { signal }
    );
    await deps.graph.setObjectStatus(
      attemptAuth,
      ctwa.campaignId ?? "",
      "ACTIVE",
      { signal }
    );
    const review = await deps.graph
      .adReview(attemptAuth, ctwa.adId ?? "", { signal })
      .catch(() => null);
    patch = {
      state: "running",
      dailyBudgetCents: request.dailyBudgetCents,
      endsAt,
      effectiveStatus: review?.effectiveStatus ?? "PENDING_REVIEW",
      checkedAt: deps.now(),
      errorCode: null,
      errorMessage: null,
    };
  } catch (error) {
    const failure = toMetaAdsGraphError(error);
    // A timed-out activation can have taken effect. Only an acknowledged
    // rollback establishes that the campaign is paused now; it cannot prove
    // that there was no delivery before the rollback.
    let paused = !switching;
    if (switching)
      paused = await deps.graph
        .setObjectStatus(attemptAuth, ctwa.campaignId ?? "", "PAUSED", {
          signal: AbortSignal.timeout(4_000),
        })
        .then(
          () => true,
          () => false
        );
    releaseLease = paused;
    patch = paused
      ? {
          state: "paused",
          effectiveStatus: switching ? "CAMPAIGN_PAUSED" : ctwa.effectiveStatus,
          errorCode:
            failure.kind === "auth"
              ? "ads_not_connected"
              : failure.kind === "whatsapp"
                ? "page_whatsapp_missing"
                : "ctwa_failed",
          errorMessage: cut(
            failure.kind === "transient"
              ? switching
                ? "Meta didn't finish switching on the ad. The campaign is now paused. Check Ads Manager for any delivery."
                : "Meta didn't confirm the budget. The ad was not switched on."
              : failure.userMessage,
            500
          ),
        }
      : pending;
  }
  const finalPatch = {
    ...patch,
    leaseUntil: releaseLease ? null : leaseUntil,
  };
  const saved = await deps.store.save(workspaceId, adId, held, finalPatch);
  if (!saved) {
    const latest = (await deps.store.load(workspaceId, adId))?.meta?.ctwa;
    return latest
      ? { ctwa: toCtwaRecord(latest) as ProductAdCtwaRecord }
      : { refused: "ad_not_ready", status: 409 };
  }
  return {
    ctwa: toCtwaRecord({
      ...ctwa,
      ...finalPatch,
    }) as ProductAdCtwaRecord,
  };
}
