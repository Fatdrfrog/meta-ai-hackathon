import "server-only";

import {
  isTikTokDiscoveryCategory,
  isTikTokDiscoveryMarket,
  type TikTokDiscoveryCategory,
  type TikTokDiscoveryMarket,
} from "@/lib/creative-assets/tiktok-marketing-templates";
import { fetchJsonWithinLimits } from "@/lib/http/bounded-json-response";
import { isRecord } from "@icecore/shared/lib/value-utils";
import {
  normalizeTikTokShareUrl,
  normalizeTikTokThumbnailUrl,
} from "./url-policy";

const API_BASE = "https://business-api.tiktok.com/open_api/v1.3";
const BUSINESS_MAX_BYTES = 2 * 1024 * 1024;
const OEMBED_MAX_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_HASHTAGS = 200;
const MAX_TOP_COUNTRIES = 5;
const MAX_VIDEOS_PER_HASHTAG = 20;
const MAX_PROVIDER_RANK = 1_000;
const MAX_PROVIDER_IDENTIFIER_LENGTH = 128;
const MAX_HASHTAG_NAME_LENGTH = 200;
const MAX_OEMBED_TITLE_LENGTH = 500;
const MAX_OEMBED_AUTHOR_LENGTH = 128;
const PROVIDER_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;
const ADVERTISER_ID_PATTERN = /^[0-9]{1,128}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const RANK_PATTERN = /^[1-9][0-9]{0,3}$/;

const RATE_LIMIT_CODES = new Set([40016, 40100, 40132, 40133]);
const UNAUTHORIZED_CODES = new Set([40102, 40104, 40105, 40106]);
const FORBIDDEN_CODES = new Set([40001, 40118, 40125]);

export type TikTokBusinessErrorCode =
  | "rate_limited"
  | "unauthorized"
  | "forbidden"
  | "provider";

export class TikTokBusinessApiError extends Error {
  readonly name = "TikTokBusinessApiError";

  constructor(
    readonly code: TikTokBusinessErrorCode,
    readonly retryable: boolean,
    readonly requestId: string | null,
    readonly retryAfterSeconds: number | null
  ) {
    super(code);
  }
}

export type TikTokDiscoveryHashtag = {
  id: string;
  name: string;
  rank: number;
  topCountryList: TikTokDiscoveryMarket[];
};

export type TikTokDiscoveryVideo = {
  videoId: string;
  shareUrl: string;
  rank: number;
};

export type TikTokDiscoveryVideoGroup = {
  hashtagId: string;
  videos: TikTokDiscoveryVideo[];
};

export type TikTokOEmbedMetadata = {
  title: string | null;
  authorName: string | null;
  authorUrl: string | null;
  thumbnailUrl: string | null;
};

type BusinessResult = {
  response: Response;
  payload: unknown;
  requestId: string | null;
};

function protocolError(
  requestId: string | null = null
): TikTokBusinessApiError {
  return new TikTokBusinessApiError("provider", false, requestId, null);
}

function networkError(): TikTokBusinessApiError {
  return new TikTokBusinessApiError("provider", true, null, null);
}

function classifyProviderCode(
  code: number
): Pick<TikTokBusinessApiError, "code" | "retryable"> {
  if (RATE_LIMIT_CODES.has(code)) {
    return { code: "rate_limited", retryable: true };
  }
  if (UNAUTHORIZED_CODES.has(code)) {
    return { code: "unauthorized", retryable: false };
  }
  if (FORBIDDEN_CODES.has(code)) {
    return { code: "forbidden", retryable: false };
  }
  return { code: "provider", retryable: code >= 50_000 || code === 60_001 };
}

function classifyHttpStatus(
  status: number
): Pick<TikTokBusinessApiError, "code" | "retryable"> {
  if (status === 429) return { code: "rate_limited", retryable: true };
  if (status === 401) return { code: "unauthorized", retryable: false };
  if (status === 403) return { code: "forbidden", retryable: false };
  return {
    code: "provider",
    retryable: status === 408 || status >= 500,
  };
}

function safeRequestId(
  payload: unknown,
  sensitiveValues: readonly string[]
): string | null {
  if (!isRecord(payload) || typeof payload.request_id !== "string") {
    return null;
  }
  const requestId = payload.request_id;
  if (!REQUEST_ID_PATTERN.test(requestId)) return null;
  if (
    sensitiveValues.some(value => value.length > 0 && requestId.includes(value))
  ) {
    return null;
  }
  return requestId;
}

export function parseTikTokRetryAfter(
  value: string | null,
  nowEpochMs = Date.now()
): number | null {
  if (typeof value !== "string" || !Number.isFinite(nowEpochMs)) return null;
  const normalized = value.trim();
  let seconds: number;

  if (/^[0-9]+$/.test(normalized)) {
    seconds = Number(normalized);
  } else {
    const deadline = Date.parse(normalized);
    if (!Number.isFinite(deadline)) return null;
    seconds = Math.ceil((deadline - nowEpochMs) / 1_000);
  }

  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 3_600
    ? seconds
    : null;
}

function errorFromHttpResponse(
  response: Response,
  requestId: string | null
): TikTokBusinessApiError {
  const classified = classifyHttpStatus(response.status);
  return new TikTokBusinessApiError(
    classified.code,
    classified.retryable,
    requestId,
    parseTikTokRetryAfter(response.headers.get("Retry-After"))
  );
}

function businessHeaders(accessToken: string): HeadersInit {
  return { "Access-Token": accessToken };
}

function discoveryQuery(input: {
  advertiserId: string;
  market: string;
}): URLSearchParams {
  return new URLSearchParams({
    advertiser_id: input.advertiserId,
    discovery_type: "HASHTAG",
    country_code: input.market,
    date_range: "7DAY",
  });
}

function assertBusinessInput(input: {
  accessToken: unknown;
  advertiserId: unknown;
  market: unknown;
}): void {
  if (
    typeof input.accessToken !== "string" ||
    input.accessToken.length === 0 ||
    input.accessToken.length > 4_096 ||
    typeof input.advertiserId !== "string" ||
    !ADVERTISER_ID_PATTERN.test(input.advertiserId) ||
    !isTikTokDiscoveryMarket(input.market)
  ) {
    throw protocolError();
  }
}

async function fetchBusinessResult(
  url: string,
  accessToken: string
): Promise<BusinessResult> {
  let result: { response: Response; payload: unknown };
  try {
    result = await fetchJsonWithinLimits(
      url,
      { headers: businessHeaders(accessToken), redirect: "error" },
      { maxBytes: BUSINESS_MAX_BYTES, timeoutMs: REQUEST_TIMEOUT_MS }
    );
  } catch {
    throw networkError();
  }

  const requestId = safeRequestId(result.payload, [accessToken]);
  if (isRecord(result.payload)) {
    const providerCode = result.payload.code;
    if (
      typeof providerCode === "number" &&
      Number.isSafeInteger(providerCode) &&
      providerCode !== 0
    ) {
      const classified = classifyProviderCode(providerCode);
      throw new TikTokBusinessApiError(
        classified.code,
        classified.retryable,
        requestId,
        parseTikTokRetryAfter(result.response.headers.get("Retry-After"))
      );
    }
  }

  if (!result.response.ok) {
    throw errorFromHttpResponse(result.response, requestId);
  }
  if (!isRecord(result.payload) || result.payload.code !== 0) {
    throw protocolError(requestId);
  }
  return { ...result, requestId };
}

function boundedIdentifier(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PROVIDER_IDENTIFIER_LENGTH &&
    PROVIDER_IDENTIFIER_PATTERN.test(value)
    ? value
    : null;
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength
    ? value
    : null;
}

function parseProviderRank(value: unknown): number | null {
  if (typeof value !== "string" || !RANK_PATTERN.test(value)) return null;
  const rank = Number(value);
  return Number.isSafeInteger(rank) && rank <= MAX_PROVIDER_RANK ? rank : null;
}

function parseTopCountries(value: unknown): TikTokDiscoveryMarket[] | null {
  if (!Array.isArray(value) || value.length > MAX_TOP_COUNTRIES) return null;
  if (
    !value.every(
      country => typeof country === "string" && /^[A-Z]{2}$/.test(country)
    )
  ) {
    return null;
  }
  return [...new Set(value.filter(isTikTokDiscoveryMarket))];
}

function parseHashtags(
  payload: unknown,
  requestId: string | null
): TikTokDiscoveryHashtag[] {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw protocolError(requestId);
  }
  const list = payload.data.list;
  if (!Array.isArray(list) || list.length > MAX_HASHTAGS) {
    throw protocolError(requestId);
  }

  const hashtags: TikTokDiscoveryHashtag[] = [];
  const seenIds = new Set<string>();
  for (const value of list) {
    if (!isRecord(value)) throw protocolError(requestId);
    const id = boundedIdentifier(value.hashtag_id);
    const name = boundedString(value.hashtag_name, MAX_HASHTAG_NAME_LENGTH);
    const rank = parseProviderRank(value.rank_position);
    const topCountryList = parseTopCountries(value.top_country_list);
    if (
      id === null ||
      name === null ||
      rank === null ||
      topCountryList === null ||
      seenIds.has(id)
    ) {
      throw protocolError(requestId);
    }
    seenIds.add(id);
    hashtags.push({ id, name, rank, topCountryList });
  }
  return hashtags;
}

function assertHashtagIds(value: readonly string[]): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    throw protocolError();
  }
  const unique = new Set(value);
  if (
    unique.size !== value.length ||
    !value.every(hashtagId => boundedIdentifier(hashtagId) !== null)
  ) {
    throw protocolError();
  }
}

function parseVideoGroup(
  value: unknown,
  requestId: string | null
): TikTokDiscoveryVideoGroup {
  if (!isRecord(value)) throw protocolError(requestId);
  const hashtagId = boundedIdentifier(value.hashtag_id);
  const list = value.top_video_list;
  if (
    hashtagId === null ||
    !Array.isArray(list) ||
    list.length > MAX_VIDEOS_PER_HASHTAG
  ) {
    throw protocolError(requestId);
  }

  const videos: TikTokDiscoveryVideo[] = [];
  for (const [index, video] of list.entries()) {
    if (!isRecord(video)) throw protocolError(requestId);
    const videoId = boundedIdentifier(video.video_id);
    if (videoId === null) throw protocolError(requestId);
    const shareUrl = normalizeTikTokShareUrl(video.share_url);
    if (shareUrl === null) continue;
    videos.push({ videoId, shareUrl, rank: index + 1 });
  }
  return { hashtagId, videos };
}

function parseVideoGroups(
  payload: unknown,
  requestId: string | null,
  requestedIds: readonly string[]
): TikTokDiscoveryVideoGroup[] {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw protocolError(requestId);
  }
  const list = payload.data.list;
  if (!Array.isArray(list) || list.length !== requestedIds.length) {
    throw protocolError(requestId);
  }

  const requested = new Set(requestedIds);
  const groups = new Map<string, TikTokDiscoveryVideoGroup>();
  for (const value of list) {
    const group = parseVideoGroup(value, requestId);
    if (!requested.has(group.hashtagId) || groups.has(group.hashtagId)) {
      throw protocolError(requestId);
    }
    groups.set(group.hashtagId, group);
  }
  if (groups.size !== requestedIds.length) throw protocolError(requestId);
  return requestedIds.map(hashtagId => {
    const group = groups.get(hashtagId);
    if (!group) throw protocolError(requestId);
    return group;
  });
}

export async function fetchTikTokTrendingHashtags(input: {
  accessToken: string;
  advertiserId: string;
  market: TikTokDiscoveryMarket;
  category: TikTokDiscoveryCategory;
}): Promise<{ hashtags: TikTokDiscoveryHashtag[]; requestId: string | null }> {
  assertBusinessInput(input);
  if (!isTikTokDiscoveryCategory(input.category)) throw protocolError();

  const query = discoveryQuery(input);
  query.set("category_name", input.category);
  const result = await fetchBusinessResult(
    `${API_BASE}/discovery/trending_list/?${query.toString()}`,
    input.accessToken
  );
  return {
    hashtags: parseHashtags(result.payload, result.requestId),
    requestId: result.requestId,
  };
}

export async function fetchTikTokTrendingVideos(input: {
  accessToken: string;
  advertiserId: string;
  market: TikTokDiscoveryMarket;
  hashtagIds:
    | readonly [string]
    | readonly [string, string]
    | readonly [string, string, string];
}): Promise<{ groups: TikTokDiscoveryVideoGroup[]; requestId: string | null }> {
  assertBusinessInput(input);
  assertHashtagIds(input.hashtagIds);

  const query = discoveryQuery(input);
  query.set("hashtag_ids", JSON.stringify(input.hashtagIds));
  const result = await fetchBusinessResult(
    `${API_BASE}/discovery/video_list/?${query.toString()}`,
    input.accessToken
  );
  return {
    groups: parseVideoGroups(
      result.payload,
      result.requestId,
      input.hashtagIds
    ),
    requestId: result.requestId,
  };
}

export async function fetchTikTokOEmbed(
  shareUrl: string
): Promise<TikTokOEmbedMetadata> {
  const normalizedShareUrl = normalizeTikTokShareUrl(shareUrl);
  if (normalizedShareUrl === null) throw protocolError();

  let result: { response: Response; payload: unknown };
  try {
    result = await fetchJsonWithinLimits(
      `https://www.tiktok.com/oembed?url=${encodeURIComponent(
        normalizedShareUrl
      )}`,
      { redirect: "error" },
      { maxBytes: OEMBED_MAX_BYTES, timeoutMs: REQUEST_TIMEOUT_MS }
    );
  } catch {
    throw networkError();
  }

  if (!result.response.ok) {
    throw errorFromHttpResponse(result.response, null);
  }
  if (!isRecord(result.payload)) throw protocolError();
  return {
    title: boundedString(result.payload.title, MAX_OEMBED_TITLE_LENGTH),
    authorName: boundedString(
      result.payload.author_name,
      MAX_OEMBED_AUTHOR_LENGTH
    ),
    authorUrl: normalizeTikTokShareUrl(result.payload.author_url),
    thumbnailUrl: normalizeTikTokThumbnailUrl(result.payload.thumbnail_url),
  };
}
