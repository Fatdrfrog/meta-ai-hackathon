import {
  getWhatsAppGraphClient,
  MetaGraphRequestError,
  type GraphQuery,
} from "@icecore/shared/lib/meta/api";
import { asRecord } from "@icecore/shared/lib/value-utils";

// Click-to-WhatsApp ads through the Marketing API, with a workspace's stored
// Meta Ads token: the video or picture, then a campaign, an ad set, a creative
// and an ad, every one created PAUSED. Pure Graph calls: no model, no MCP,
// no storage. Every create can run as `validateOnly`
// (execution_options=["validate_only"]), which checks the request and creates
// nothing. Errors come back as MetaAdsGraphError, sorted into what the caller
// does next (try again later, reconnect, link WhatsApp, or show Meta's words).
// Tokens never appear in an error, a log or a returned value.

const graph = getWhatsAppGraphClient();

/** The token and the ad account ("act_…") calls are made with. */
export type MetaAdsAuth = { accessToken: string; adAccountId: string };

export type MetaAdsCallOptions = { signal?: AbortSignal };
export type MetaAdsCreateOptions = MetaAdsCallOptions & {
  /** Check the request and create nothing. */
  validateOnly?: boolean;
};

/** Where the ads run: Kazakhstan, Facebook placements (the ads token can't reach Instagram). */
export const CTWA_COUNTRIES = ["KZ"] as const;
export const CTWA_PUBLISHER_PLATFORMS = ["facebook"] as const;

/**
 * What a failed call means for the caller:
 * - transient: Meta or the network hiccuped; ask again later, nothing changed;
 * - auth: the token no longer works; Meta Ads needs reconnecting;
 * - whatsapp: the Page has no WhatsApp number to send buyers to;
 * - refused: Meta refused the request as it is (`userMessage` says why).
 */
export type MetaAdsFailureKind = "transient" | "auth" | "whatsapp" | "refused";

export class MetaAdsGraphError extends Error {
  readonly kind: MetaAdsFailureKind;
  readonly code: number | null;
  readonly subcode: number | null;
  /** Meta's reason for a person, in its own words, at most 300 characters. */
  readonly userMessage: string;

  constructor(params: {
    kind: MetaAdsFailureKind;
    code: number | null;
    subcode: number | null;
    userMessage: string;
  }) {
    super(
      `Meta Ads ${params.kind} failure${params.code === null ? "" : ` (${params.code}${params.subcode === null ? "" : `/${params.subcode}`})`}: ${params.userMessage}`
    );
    this.name = "MetaAdsGraphError";
    this.kind = params.kind;
    this.code = params.code;
    this.subcode = params.subcode;
    this.userMessage = params.userMessage;
  }
}

// Meta's codes for "try again later": unknown and temporary errors, and the
// app, user and ad account rate limits.
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);
const isRateLimitCode = (code: number) => code >= 80000 && code <= 80014;
// Expired or invalid tokens, and a session the user ended.
const AUTH_CODES = new Set([102, 190]);

// Only a missing Page connection calls for linking WhatsApp. Creative
// validation can mention WhatsApp too (for example page_welcome_message).
const WHATSAPP_LINK_WORDS =
  /(?:\b(?:connect|link|associate)\b.{0,80}\bwhats\s?app\b|\bwhats\s?app\b.{0,80}\b(?:not connected|not linked|not associated)\b|\b(?:no|missing)\s+whats\s?app\s+(?:number|account)\b)/i;

const oneLineOf = (value: unknown, max = 300): string | null => {
  if (typeof value !== "string") return null;
  const line = value.replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

const numberOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** What a failed Graph call means (see MetaAdsFailureKind). */
export function toMetaAdsGraphError(error: unknown): MetaAdsGraphError {
  if (error instanceof MetaAdsGraphError) return error;
  if (!(error instanceof MetaGraphRequestError)) {
    // A timeout, an abort or the network: nothing is known to have changed.
    return new MetaAdsGraphError({
      kind: "transient",
      code: null,
      subcode: null,
      userMessage: "Meta didn't answer in time",
    });
  }
  const meta = asRecord(error.metaError);
  const code = numberOf(meta.code);
  const subcode = numberOf(meta.error_subcode);
  const userMessage =
    oneLineOf(meta.error_user_msg) ??
    oneLineOf(meta.error_user_title) ??
    oneLineOf(meta.message) ??
    `Meta answered HTTP ${error.status}`;
  const words = [meta.error_user_msg, meta.error_user_title, meta.message]
    .filter(value => typeof value === "string")
    .join(" ");
  let kind: MetaAdsFailureKind = "refused";
  if (code !== null && AUTH_CODES.has(code)) kind = "auth";
  else if (
    meta.is_transient === true ||
    (code !== null && (TRANSIENT_CODES.has(code) || isRateLimitCode(code))) ||
    (code === null && error.status >= 500)
  )
    kind = "transient";
  else if (WHATSAPP_LINK_WORDS.test(words)) kind = "whatsapp";
  return new MetaAdsGraphError({ kind, code, subcode, userMessage });
}

async function graphGet<T>(
  path: string,
  token: string,
  query: GraphQuery,
  options: MetaAdsCallOptions
): Promise<T> {
  try {
    return await graph.getJson<T>(path, {
      token,
      query,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    throw toMetaAdsGraphError(error);
  }
}

async function graphPost<T>(
  path: string,
  token: string,
  body: Record<string, unknown>,
  options: MetaAdsCreateOptions
): Promise<T> {
  try {
    return await graph.postJson<T>(path, {
      token,
      body: options.validateOnly
        ? { ...body, execution_options: ["validate_only"] }
        : body,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    throw toMetaAdsGraphError(error);
  }
}

/** The id a create answered; a create that answers none failed. */
function createdId(answer: unknown, what: string): string {
  const id = asRecord(answer).id;
  if (typeof id === "string" && id.trim()) return id.trim();
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  throw new MetaAdsGraphError({
    kind: "transient",
    code: null,
    subcode: null,
    userMessage: `Meta didn't say which ${what} it made`,
  });
}

/** "act_123" → "123", as Ads Manager links take it. */
export const bareAdAccountId = (adAccountId: string) =>
  adAccountId.replace(/^act_/, "");

/** The ad in Ads Manager. */
export function adsManagerAdUrl(adAccountId: string, adId: string): string {
  const url = new URL("https://adsmanager.facebook.com/adsmanager/manage/ads");
  url.searchParams.set("act", bareAdAccountId(adAccountId));
  url.searchParams.set("selected_ad_ids", adId);
  return url.toString();
}

// ---------------------------------------------------------------------------
// The ad account and its Page

/** The ad account's name and currency ("USD"). */
export async function adAccountInfo(
  auth: MetaAdsAuth,
  options: MetaAdsCallOptions = {}
): Promise<{ name: string | null; currency: string | null }> {
  const answer = await graphGet<Record<string, unknown>>(
    auth.adAccountId,
    auth.accessToken,
    { fields: "name,currency,account_status" },
    options
  );
  return {
    name: oneLineOf(answer.name, 200),
    currency: oneLineOf(answer.currency, 8),
  };
}

/** The Pages the ad account can advertise for, first the one Meta lists first. */
export async function promotablePages(
  auth: MetaAdsAuth,
  options: MetaAdsCallOptions = {}
): Promise<Array<{ id: string; name: string | null }>> {
  const answer = await graphGet<{ data?: unknown }>(
    `${auth.adAccountId}/promote_pages`,
    auth.accessToken,
    { fields: "id,name", limit: 5 },
    options
  );
  return (Array.isArray(answer.data) ? answer.data : [])
    .map(item => asRecord(item))
    .filter(page => typeof page.id === "string" && page.id)
    .map(page => ({ id: String(page.id), name: oneLineOf(page.name, 200) }));
}

/**
 * Whether the Page has a WhatsApp number linked, read with the Page's own
 * token (derived from the system user's). Only a yes or no comes back: the
 * number itself is never returned. Null when the Page or its token can't be
 * read.
 */
export async function pageWhatsAppLinked(
  accessToken: string,
  pageId: string,
  options: MetaAdsCallOptions = {}
): Promise<boolean | null> {
  const accounts = await graphGet<{ data?: unknown }>(
    "me/accounts",
    accessToken,
    { fields: "id,access_token", limit: 100 },
    options
  );
  const page = (Array.isArray(accounts.data) ? accounts.data : [])
    .map(item => asRecord(item))
    .find(item => String(item.id) === pageId);
  const pageToken =
    typeof page?.access_token === "string" ? page.access_token : null;
  if (!pageToken) return null;
  const fields = await graphGet<Record<string, unknown>>(
    pageId,
    pageToken,
    { fields: "whatsapp_number,has_whatsapp_number" },
    options
  );
  const number = fields.whatsapp_number;
  return (
    (typeof number === "string" && number.trim().length > 0) ||
    fields.has_whatsapp_number === true
  );
}

// ---------------------------------------------------------------------------
// Looking a lost answer up by its name

/** The edges whose objects carry the deterministic names. */
export type MetaAdsNamedEdge = "campaigns" | "adsets" | "adcreatives" | "ads";

/**
 * The id of the object this account made with exactly `name`, or null. A
 * create whose answer was lost (a timeout) is found before making another.
 * An incomplete bounded lookup is transient, never proof of absence.
 */
export async function findByName(
  auth: MetaAdsAuth,
  edge: MetaAdsNamedEdge,
  name: string,
  options: MetaAdsCallOptions = {}
): Promise<string | null> {
  let query: GraphQuery =
    edge === "adcreatives"
      ? // Creatives can't be filtered by name: the newest come first.
        { fields: "id,name", limit: 100 }
      : {
          fields: "id,name",
          limit: 5,
          filtering: JSON.stringify([
            { field: "name", operator: "EQUAL", value: name },
          ]),
        };
  const incomplete = () =>
    new MetaAdsGraphError({
      kind: "transient",
      code: null,
      subcode: null,
      userMessage: "Meta's name lookup did not finish. Try again later.",
    });
  for (let page = 0; page < 5; page++) {
    let answer: { data?: unknown; paging?: unknown };
    try {
      answer = await graphGet(
        `${auth.adAccountId}/${edge}`,
        auth.accessToken,
        query,
        options
      );
    } catch (error) {
      const failure = toMetaAdsGraphError(error);
      if (
        query.filtering &&
        failure.kind === "refused" &&
        /\bfilter(?:ing)?\b/i.test(failure.userMessage)
      ) {
        // Some edges/accounts reject this filter. Keep using the canonical
        // transport and compare exact names locally, with bounded paging.
        query = { fields: "id,name", limit: 100 };
        page--;
        continue;
      }
      throw failure;
    }
    const match = (Array.isArray(answer.data) ? answer.data : [])
      .map(item => asRecord(item))
      .find(item => item.name === name && item.id);
    if (match) return String(match.id);
    const paging = asRecord(answer.paging);
    if (!paging.next) return null;
    const after = asRecord(paging.cursors).after;
    if (typeof after !== "string" || !after) throw incomplete();
    query = { ...query, after };
  }
  throw incomplete();
}

// ---------------------------------------------------------------------------
// The video or the picture

/**
 * Asks Meta to fetch the video from `fileUrl` (a signed link that lasts an
 * hour). Meta processes it after answering: see adVideoStatus.
 */
export async function uploadAdVideo(
  auth: MetaAdsAuth,
  params: { fileUrl: string; name: string },
  options: MetaAdsCallOptions = {}
): Promise<string> {
  const answer = await graphPost(
    `${auth.adAccountId}/advideos`,
    auth.accessToken,
    { file_url: params.fileUrl, name: params.name, title: params.name },
    options
  );
  return createdId(answer, "video");
}

/** The ad account's video titled `name` (an upload whose answer was lost), or null. */
export async function findAdVideoByName(
  auth: MetaAdsAuth,
  name: string,
  options: MetaAdsCallOptions = {}
): Promise<string | null> {
  const answer = await graphGet<{ data?: unknown }>(
    `${auth.adAccountId}/advideos`,
    auth.accessToken,
    { fields: "id,title", limit: 50 },
    options
  );
  const match = (Array.isArray(answer.data) ? answer.data : [])
    .map(item => asRecord(item))
    .find(item => item.title === name && item.id);
  return match ? String(match.id) : null;
}

export type AdVideoStatus = {
  state: "ready" | "processing" | "error";
  /** Meta's reason, when it couldn't process the video. */
  reason: string | null;
};

/** Whether Meta finished processing the video. */
export async function adVideoStatus(
  auth: MetaAdsAuth,
  videoId: string,
  options: MetaAdsCallOptions = {}
): Promise<AdVideoStatus> {
  const answer = await graphGet<{ status?: unknown }>(
    videoId,
    auth.accessToken,
    { fields: "status" },
    options
  );
  const status = asRecord(answer.status);
  const videoStatus = status.video_status;
  if (videoStatus === "ready") return { state: "ready", reason: null };
  if (videoStatus === "error") {
    const phase = asRecord(status.processing_phase);
    const errors = Array.isArray(phase.errors) ? phase.errors : [];
    const reason = errors
      .map(item => oneLineOf(asRecord(item).message))
      .find(Boolean);
    return { state: "error", reason: reason ?? null };
  }
  return { state: "processing", reason: null };
}

/** Uploads a JPEG to the account's image library; answers its hash. */
export async function uploadAdImage(
  auth: MetaAdsAuth,
  params: { bytes: Uint8Array; name: string },
  options: MetaAdsCallOptions = {}
): Promise<string> {
  const answer = await graphPost<{ images?: unknown }>(
    `${auth.adAccountId}/adimages`,
    auth.accessToken,
    { bytes: Buffer.from(params.bytes).toString("base64"), name: params.name },
    options
  );
  const images = asRecord(answer.images);
  const hash = Object.values(images)
    .map(image => asRecord(image).hash)
    .find(value => typeof value === "string" && value);
  if (typeof hash === "string") return hash;
  throw new MetaAdsGraphError({
    kind: "transient",
    code: null,
    subcode: null,
    userMessage: "Meta didn't say which picture it kept",
  });
}

// ---------------------------------------------------------------------------
// Campaign, ad set, creative and ad: the request bodies, then the calls.

/** A campaign for messages, its budget set on the ad set; PAUSED. */
export function campaignBody(params: { name: string }) {
  return {
    name: params.name,
    objective: "OUTCOME_ENGAGEMENT",
    special_ad_categories: [],
    buying_type: "AUCTION",
    is_adset_budget_sharing_enabled: false,
    status: "PAUSED",
  };
}

export type CtwaAdSetParams = {
  name: string;
  campaignId: string;
  pageId: string;
  /** In the account's minor units (US cents); Meta's minimum is 100. */
  dailyBudgetCents: number;
  startTime: Date;
  endTime: Date;
};

/**
 * The ad set, in the shape of the account's live Click-to-WhatsApp ad sets:
 * conversations in WhatsApp, Kazakhstan, 18 to 65 with Advantage+ audience,
 * Facebook placements only. Created PAUSED with its budget and end already
 * set, so running it only switches it on. The Page's linked WhatsApp number
 * receives the chats.
 */
export function adSetBody(params: CtwaAdSetParams) {
  return {
    name: params.name,
    campaign_id: params.campaignId,
    destination_type: "WHATSAPP",
    optimization_goal: "CONVERSATIONS",
    billing_event: "IMPRESSIONS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    promoted_object: { page_id: params.pageId },
    targeting: {
      geo_locations: { countries: [...CTWA_COUNTRIES] },
      age_min: 18,
      age_max: 65,
      publisher_platforms: [...CTWA_PUBLISHER_PLATFORMS],
      targeting_automation: { advantage_audience: 1 },
    },
    daily_budget: Math.round(params.dailyBudgetCents),
    start_time: params.startTime.toISOString(),
    end_time: params.endTime.toISOString(),
    status: "PAUSED",
  };
}

/** Where the WhatsApp button goes (Meta opens the Page's number). */
export const CTWA_PICTURE_LINK = "https://api.whatsapp.com/send";

// As the account's live Click-to-WhatsApp creatives have it.
const WHATSAPP_CALL_TO_ACTION = {
  type: "WHATSAPP_MESSAGE",
  value: { app_destination: "WHATSAPP", link: CTWA_PICTURE_LINK },
} as const;

/**
 * The chat's start: the shop's greeting, and the message WhatsApp writes for
 * the buyer to send. Without it, Meta's default greeting is used.
 */
export type CtwaWelcome = { greeting: string; buyerMessage: string };

/**
 * Meta's welcome message for a Click-to-WhatsApp creative: the visual
 * editor's text greeting with a pre-filled buyer message, as a JSON string
 * (how Meta stores it on the account's live creatives).
 */
export function ctwaWelcomeMessage(welcome: CtwaWelcome): string {
  return JSON.stringify({
    type: "VISUAL_EDITOR",
    version: 2,
    landing_screen_type: "welcome_message",
    media_type: "text",
    text_format: {
      customer_action_type: "autofill_message",
      message: {
        text: welcome.greeting,
        autofill_message: { content: welcome.buyerMessage },
      },
    },
    user_edit: false,
    surface: "visual_editor_new",
  });
}

export type CtwaCreativeParams = {
  name: string;
  pageId: string;
  /** The ad's text above the media. */
  message: string;
  /** The bold line under the media. */
  headline: string;
  media:
    | { kind: "video"; videoId: string; posterUrl: string }
    | { kind: "picture"; imageHash: string };
  /** The chat's greeting; absent or null: Meta's default. */
  welcome?: CtwaWelcome | null;
};

/** A Page post with the video (and its poster) or the picture, and a WhatsApp button. */
export function creativeBody(params: CtwaCreativeParams) {
  const message = params.message.trim();
  const headline = params.headline.trim();
  const greeting = params.welcome?.greeting.trim() ?? "";
  const buyerMessage = params.welcome?.buyerMessage.trim() ?? "";
  const welcome =
    greeting && buyerMessage
      ? {
          page_welcome_message: ctwaWelcomeMessage({ greeting, buyerMessage }),
        }
      : {};
  return {
    name: params.name,
    object_story_spec:
      params.media.kind === "video"
        ? {
            page_id: params.pageId,
            video_data: {
              video_id: params.media.videoId,
              image_url: params.media.posterUrl,
              ...(message ? { message } : {}),
              ...(headline ? { title: headline } : {}),
              ...welcome,
              call_to_action: WHATSAPP_CALL_TO_ACTION,
            },
          }
        : {
            page_id: params.pageId,
            link_data: {
              image_hash: params.media.imageHash,
              link: CTWA_PICTURE_LINK,
              ...(message ? { message } : {}),
              ...(headline ? { name: headline } : {}),
              ...welcome,
              call_to_action: WHATSAPP_CALL_TO_ACTION,
            },
          },
  };
}

/** The ad: the ad set and the creative together; PAUSED. */
export function adBody(params: {
  name: string;
  adSetId: string;
  creativeId: string;
}) {
  return {
    name: params.name,
    adset_id: params.adSetId,
    creative: { creative_id: params.creativeId },
    status: "PAUSED",
  };
}

export async function createCampaign(
  auth: MetaAdsAuth,
  params: { name: string },
  options: MetaAdsCallOptions = {}
): Promise<string> {
  return createdId(
    await graphPost(
      `${auth.adAccountId}/campaigns`,
      auth.accessToken,
      campaignBody(params),
      options
    ),
    "campaign"
  );
}

/** Checks the ad set with Meta (validate_only) and creates nothing; throws Meta's refusal. */
export async function validateAdSet(
  auth: MetaAdsAuth,
  params: CtwaAdSetParams,
  options: MetaAdsCallOptions = {}
): Promise<void> {
  await graphPost(
    `${auth.adAccountId}/adsets`,
    auth.accessToken,
    adSetBody(params),
    { ...options, validateOnly: true }
  );
}

export async function createAdSet(
  auth: MetaAdsAuth,
  params: CtwaAdSetParams,
  options: MetaAdsCallOptions = {}
): Promise<string> {
  return createdId(
    await graphPost(
      `${auth.adAccountId}/adsets`,
      auth.accessToken,
      adSetBody(params),
      options
    ),
    "ad set"
  );
}

export async function createAdCreative(
  auth: MetaAdsAuth,
  params: CtwaCreativeParams,
  options: MetaAdsCallOptions = {}
): Promise<string> {
  return createdId(
    await graphPost(
      `${auth.adAccountId}/adcreatives`,
      auth.accessToken,
      creativeBody(params),
      options
    ),
    "creative"
  );
}

export async function createAd(
  auth: MetaAdsAuth,
  params: { name: string; adSetId: string; creativeId: string },
  options: MetaAdsCallOptions = {}
): Promise<string> {
  return createdId(
    await graphPost(
      `${auth.adAccountId}/ads`,
      auth.accessToken,
      adBody(params),
      options
    ),
    "ad"
  );
}

// ---------------------------------------------------------------------------
// Running it, and Meta's review

/** Sets the ad set's daily budget (minor units) and when it stops. */
export async function setAdSetBudget(
  auth: MetaAdsAuth,
  adSetId: string,
  params: { dailyBudgetCents: number; endTime: Date },
  options: MetaAdsCallOptions = {}
): Promise<void> {
  await graphPost(
    adSetId,
    auth.accessToken,
    {
      daily_budget: Math.round(params.dailyBudgetCents),
      end_time: params.endTime.toISOString(),
    },
    options
  );
}

/** Switches a campaign, ad set or ad on (ACTIVE) or off (PAUSED). */
export async function setObjectStatus(
  auth: MetaAdsAuth,
  objectId: string,
  status: "ACTIVE" | "PAUSED",
  options: MetaAdsCallOptions = {}
): Promise<void> {
  await graphPost(objectId, auth.accessToken, { status }, options);
}

export type AdReview = {
  /** PAUSED, PENDING_REVIEW, ACTIVE, DISAPPROVED, WITH_ISSUES…; null when Meta gave none. */
  effectiveStatus: string | null;
  /** Meta's reasons when it didn't approve the ad, joined; null otherwise. */
  feedback: string | null;
};

/** Where the ad is in Meta's review and delivery. */
export async function adReview(
  auth: MetaAdsAuth,
  adId: string,
  options: MetaAdsCallOptions = {}
): Promise<AdReview> {
  const answer = await graphGet<Record<string, unknown>>(
    adId,
    auth.accessToken,
    { fields: "effective_status,ad_review_feedback" },
    options
  );
  const effectiveStatus = oneLineOf(answer.effective_status, 64);
  const global = asRecord(asRecord(answer.ad_review_feedback).global);
  const reasons = Object.entries(global)
    .map(([key, value]) => oneLineOf(value, 200) ?? oneLineOf(key, 80))
    .filter((value): value is string => Boolean(value));
  return {
    effectiveStatus,
    feedback: reasons.length ? oneLineOf(reasons.join(" "), 300) : null,
  };
}
