import "server-only";

import { createHash, randomBytes } from "node:crypto";
import pLimit from "p-limit";

import type { TikTokSafeErrorCode } from "@/lib/tiktok-discovery/safe-errors";
import {
  type TikTokDiscoveryCategory,
  type TikTokDiscoveryMarket,
  type TikTokMarketingTemplateCatalogItem,
  type TikTokMarketingTemplatesResponse,
} from "@/lib/creative-assets/tiktok-marketing-templates";
import { buildCacheKey, cache } from "@/lib/cache";
import {
  fetchTikTokOEmbed,
  fetchTikTokTrendingHashtags,
  fetchTikTokTrendingVideos,
  TikTokBusinessApiError,
  type TikTokBusinessErrorCode,
  type TikTokDiscoveryHashtag,
  type TikTokDiscoveryVideo,
  type TikTokOEmbedMetadata,
} from "@/lib/tiktok-discovery/business-api-client";
import { resolveTikTokDiscoveryAppIdentity } from "@/lib/tiktok-discovery/oauth-config";
import { loadTikTokPlatformCredentialForGeneration } from "@/lib/tiktok-discovery/platform-credential";
import {
  markTikTokPlatformCredentialFailureAndPublish,
  markTikTokPlatformCredentialValidatedAndPublish,
  resolveTikTokPlatformCredentialCoordinate,
} from "@/lib/tiktok-discovery/platform-credential-coordinate";
import {
  acquireTikTokProviderPermit,
  type TikTokDiscoveryProviderEndpoint,
} from "@/lib/tiktok-discovery/provider-permit";
import {
  normalizeTikTokShareUrl,
  normalizeTikTokThumbnailUrl,
} from "@/lib/tiktok-discovery/url-policy";
import { isRecord, hasExactKeys } from "@icecore/shared/lib/value-utils";

const SCHEMA_VERSION = 1 as const;
const API_VERSION = "v1.3" as const;
const WINDOW_DAYS = 7 as const;
const CATALOG_TTL_SECONDS = 86_400;
const FRESH_SECONDS = 30 * 60;
const REFRESH_LOCK_TTL_SECONDS = 240;
const MAX_COOLDOWN_SECONDS = 3_600;
const MAX_ITEMS = 12;
const MAX_HASHTAGS = 3;
const OEMBED_CONCURRENCY = 4;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_TITLE_LENGTH = 500;
const MAX_CREATOR_LENGTH = 128;
const MAX_HASHTAG_LENGTH = 200;
const MAX_PROVIDER_RANK = 1_000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;

export type TikTokDiscoveryLoadResult = {
  response: TikTokMarketingTemplatesResponse;
  transportStatus: 200 | 503;
  cacheOutcome:
    | "fresh"
    | "refreshed"
    | "stale_provider_error"
    | "stale_rate_limited"
    | "stale_lock_contended"
    | "credential_unavailable"
    | "temporarily_unavailable"
    | "coordination_unavailable";
  providerOutcome:
    | "not_called"
    | "success"
    | TikTokBusinessErrorCode
    | "permit_limited"
    | "permit_unavailable";
  hashtagCount: number;
  retryAt: string | null;
};

export type TikTokDiscoveryCacheStore = Pick<
  typeof cache,
  | "readWithStatus"
  | "writeWithStatus"
  | "acquireLock"
  | "compareAndDelete"
  | "publishIfLockOwned"
>;

export type TikTokDiscoveryCacheEnvelope = {
  schemaVersion: 1;
  apiVersion: "v1.3";
  generation: string;
  advertiserId: string;
  market: TikTokDiscoveryMarket;
  category: TikTokDiscoveryCategory;
  windowDays: 7;
  items: TikTokMarketingTemplateCatalogItem[];
  updatedAt: string;
  refreshedAt: string;
};

export type TikTokDiscoveryCooldownEnvelope = {
  schemaVersion: 1;
  apiVersion: "v1.3";
  generation: string;
  endpoint: TikTokDiscoveryProviderEndpoint;
  retryAt: string;
};

export type TikTokDiscoveryDependencies = {
  cacheStore: TikTokDiscoveryCacheStore;
  resolveAppIdentity: typeof resolveTikTokDiscoveryAppIdentity;
  resolveCredentialCoordinate: typeof resolveTikTokPlatformCredentialCoordinate;
  loadCredentialForGeneration: typeof loadTikTokPlatformCredentialForGeneration;
  acquireProviderPermit: typeof acquireTikTokProviderPermit;
  fetchTrendingHashtags: typeof fetchTikTokTrendingHashtags;
  fetchTrendingVideos: typeof fetchTikTokTrendingVideos;
  fetchOEmbed: typeof fetchTikTokOEmbed;
  markCredentialValidatedAndPublish: typeof markTikTokPlatformCredentialValidatedAndPublish;
  markCredentialFailureAndPublish: typeof markTikTokPlatformCredentialFailureAndPublish;
};

const defaultDependencies: TikTokDiscoveryDependencies = {
  cacheStore: cache,
  resolveAppIdentity: resolveTikTokDiscoveryAppIdentity,
  resolveCredentialCoordinate: resolveTikTokPlatformCredentialCoordinate,
  loadCredentialForGeneration: loadTikTokPlatformCredentialForGeneration,
  acquireProviderPermit: acquireTikTokProviderPermit,
  fetchTrendingHashtags: fetchTikTokTrendingHashtags,
  fetchTrendingVideos: fetchTikTokTrendingVideos,
  fetchOEmbed: fetchTikTokOEmbed,
  markCredentialValidatedAndPublish:
    markTikTokPlatformCredentialValidatedAndPublish,
  markCredentialFailureAndPublish:
    markTikTokPlatformCredentialFailureAndPublish,
};

type CatalogRead =
  | { status: "unavailable" }
  | { status: "miss" }
  | {
      status: "fresh" | "stale";
      envelope: TikTokDiscoveryCacheEnvelope;
    };

type RefreshContext = {
  deps: TikTokDiscoveryDependencies;
  keys: ReturnType<typeof buildTikTokDiscoveryCacheKeys>;
  generation: string;
  ownerToken: string;
  clock: () => Date;
  stale: TikTokDiscoveryCacheEnvelope | null;
  hashtagCount: number;
};

type ProviderFailureState = {
  status: "connected" | "reconnect_required";
  errorCode: TikTokSafeErrorCode;
};

export function buildTikTokDiscoveryCacheKeys(input: {
  developerAppId: string;
  generation: string;
  advertiserId: string;
  market: TikTokDiscoveryMarket;
  category: TikTokDiscoveryCategory;
}): {
  catalog: string;
  refreshLock: string;
  trendingCooldown: string;
  videoCooldown: string;
} {
  const catalogParts = [
    `schema-${SCHEMA_VERSION}`,
    API_VERSION,
    input.generation,
    input.advertiserId,
    input.market,
    input.category,
    `${WINDOW_DAYS}-day`,
  ];
  const developerAppHash = createHash("sha256")
    .update(`tiktok-discovery:developer-app:v1:${input.developerAppId}`)
    .digest("hex");
  const cooldownKey = (endpoint: TikTokDiscoveryProviderEndpoint) =>
    buildCacheKey("tiktok:discovery:cooldown", [
      `schema-${SCHEMA_VERSION}`,
      API_VERSION,
      developerAppHash,
      input.generation,
      endpoint,
    ]);
  return {
    catalog: buildCacheKey("tiktok:discovery:catalog", catalogParts),
    refreshLock: buildCacheKey(
      "tiktok:discovery:catalog-refresh-lock",
      catalogParts
    ),
    trendingCooldown: cooldownKey("trending_list"),
    videoCooldown: cooldownKey("video_list"),
  };
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}

function isIdentifier(value: unknown): value is string {
  return (
    isBoundedString(value, MAX_IDENTIFIER_LENGTH) &&
    IDENTIFIER_PATTERN.test(value)
  );
}

function isProviderRank(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_PROVIDER_RANK
  );
}

function isCanonicalShareUrl(value: unknown): value is string {
  return typeof value === "string" && normalizeTikTokShareUrl(value) === value;
}

function isCanonicalThumbnailUrl(value: unknown): value is string {
  return (
    typeof value === "string" && normalizeTikTokThumbnailUrl(value) === value
  );
}

function isValidCatalogItem(
  value: unknown,
  coordinate: Pick<
    TikTokDiscoveryCacheEnvelope,
    "market" | "category" | "windowDays"
  >
): value is TikTokMarketingTemplateCatalogItem {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "source", "title", "preset", "reference"]) ||
    value.source !== "tiktok_discovery" ||
    value.preset !== null ||
    !isBoundedString(value.title, MAX_TITLE_LENGTH) ||
    !isRecord(value.reference)
  ) {
    return false;
  }
  const reference = value.reference;
  if (
    !hasExactKeys(reference, [
      "providerVideoId",
      "shareUrl",
      "thumbnailUrl",
      "creatorName",
      "creatorUrl",
      "hashtag",
      "hashtagRank",
      "videoRank",
      "market",
      "category",
      "windowDays",
    ]) ||
    !isIdentifier(reference.providerVideoId) ||
    value.id !== `tiktok:${reference.providerVideoId}` ||
    !isCanonicalShareUrl(reference.shareUrl) ||
    (reference.thumbnailUrl !== null &&
      !isCanonicalThumbnailUrl(reference.thumbnailUrl)) ||
    (reference.creatorName !== null &&
      !isBoundedString(reference.creatorName, MAX_CREATOR_LENGTH)) ||
    (reference.creatorUrl !== null &&
      !isCanonicalShareUrl(reference.creatorUrl)) ||
    !isBoundedString(reference.hashtag, MAX_HASHTAG_LENGTH) ||
    !isProviderRank(reference.hashtagRank) ||
    !isProviderRank(reference.videoRank) ||
    reference.market !== coordinate.market ||
    reference.category !== coordinate.category ||
    reference.windowDays !== coordinate.windowDays
  ) {
    return false;
  }
  return true;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString() === value ? timestamp : null;
}

function classifyCatalogEnvelope(
  value: unknown,
  expected: {
    generation: string;
    advertiserId: string;
    market: TikTokDiscoveryMarket;
    category: TikTokDiscoveryCategory;
  },
  now: Date
): {
  status: "fresh" | "stale";
  envelope: TikTokDiscoveryCacheEnvelope;
} | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "apiVersion",
      "generation",
      "advertiserId",
      "market",
      "category",
      "windowDays",
      "items",
      "updatedAt",
      "refreshedAt",
    ]) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    value.apiVersion !== API_VERSION ||
    value.generation !== expected.generation ||
    value.advertiserId !== expected.advertiserId ||
    value.market !== expected.market ||
    value.category !== expected.category ||
    value.windowDays !== WINDOW_DAYS ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_ITEMS
  ) {
    return null;
  }
  const updatedAt = parseTimestamp(value.updatedAt);
  const refreshedAt = parseTimestamp(value.refreshedAt);
  const nowMs = now.getTime();
  if (
    !Number.isFinite(nowMs) ||
    updatedAt === null ||
    refreshedAt === null ||
    updatedAt > nowMs ||
    refreshedAt > nowMs
  ) {
    return null;
  }
  const ageSeconds = (nowMs - refreshedAt) / 1_000;
  if (ageSeconds >= CATALOG_TTL_SECONDS) return null;
  const coordinate = {
    market: expected.market,
    category: expected.category,
    windowDays: WINDOW_DAYS,
  } as const;
  const seenVideoIds = new Set<string>();
  for (const item of value.items) {
    if (
      !isValidCatalogItem(item, coordinate) ||
      seenVideoIds.has(item.reference.providerVideoId)
    ) {
      return null;
    }
    seenVideoIds.add(item.reference.providerVideoId);
  }
  return {
    status: ageSeconds < FRESH_SECONDS ? "fresh" : "stale",
    envelope: value as TikTokDiscoveryCacheEnvelope,
  };
}

async function readCatalog(
  deps: TikTokDiscoveryDependencies,
  key: string,
  expected: {
    generation: string;
    advertiserId: string;
    market: TikTokDiscoveryMarket;
    category: TikTokDiscoveryCategory;
  },
  now: Date
): Promise<CatalogRead> {
  const read = await deps.cacheStore.readWithStatus<unknown>(key);
  if (read.status === "unavailable") return { status: "unavailable" };
  if (read.status === "miss") return { status: "miss" };
  return (
    classifyCatalogEnvelope(read.value, expected, now) ?? { status: "miss" }
  );
}

function validCooldown(
  value: unknown,
  input: {
    generation: string;
    endpoint: TikTokDiscoveryProviderEndpoint;
    now: Date;
  }
): TikTokDiscoveryCooldownEnvelope | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "apiVersion",
      "generation",
      "endpoint",
      "retryAt",
    ]) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    value.apiVersion !== API_VERSION ||
    value.generation !== input.generation ||
    value.endpoint !== input.endpoint
  ) {
    return null;
  }
  const deadline = parseTimestamp(value.retryAt);
  const nowMs = input.now.getTime();
  if (
    deadline === null ||
    deadline <= nowMs ||
    deadline > nowMs + MAX_COOLDOWN_SECONDS * 1_000
  ) {
    return null;
  }
  return value as TikTokDiscoveryCooldownEnvelope;
}

async function readCooldown(
  deps: TikTokDiscoveryDependencies,
  key: string,
  input: {
    generation: string;
    endpoint: TikTokDiscoveryProviderEndpoint;
    now: Date;
  }
): Promise<
  | { status: "unavailable" }
  | { status: "none" }
  | { status: "live"; retryAt: string }
> {
  const read = await deps.cacheStore.readWithStatus<unknown>(key);
  if (read.status === "unavailable") return { status: "unavailable" };
  if (read.status === "miss") return { status: "none" };
  const cooldown = validCooldown(read.value, input);
  return cooldown
    ? { status: "live", retryAt: cooldown.retryAt }
    : { status: "none" };
}

function okResponse(
  envelope: TikTokDiscoveryCacheEnvelope,
  stale: boolean,
  warning?: "provider_unavailable" | "provider_rate_limited"
): TikTokMarketingTemplatesResponse {
  return {
    status: "ok",
    items: envelope.items,
    market: envelope.market,
    category: envelope.category,
    windowDays: envelope.windowDays,
    updatedAt: envelope.updatedAt,
    stale,
    ...(warning ? { warning } : {}),
  };
}

function freshResult(
  envelope: TikTokDiscoveryCacheEnvelope
): TikTokDiscoveryLoadResult {
  return {
    response: okResponse(envelope, false),
    transportStatus: 200,
    cacheOutcome: "fresh",
    providerOutcome: "not_called",
    hashtagCount: 0,
    retryAt: null,
  };
}

function temporaryResult(
  input: {
    transportStatus?: 200 | 503;
    cacheOutcome?: TikTokDiscoveryLoadResult["cacheOutcome"];
    providerOutcome?: TikTokDiscoveryLoadResult["providerOutcome"];
    hashtagCount?: number;
    retryAt?: string | null;
  } = {}
): TikTokDiscoveryLoadResult {
  const retryAt = input.retryAt ?? null;
  return {
    response: {
      status: "temporarily_unavailable",
      items: [],
      ...(retryAt ? { retryAt } : {}),
    },
    transportStatus: input.transportStatus ?? 200,
    cacheOutcome: input.cacheOutcome ?? "temporarily_unavailable",
    providerOutcome: input.providerOutcome ?? "not_called",
    hashtagCount: input.hashtagCount ?? 0,
    retryAt,
  };
}

function unavailableResult(
  cacheOutcome: TikTokDiscoveryLoadResult["cacheOutcome"] = "credential_unavailable",
  providerOutcome: TikTokDiscoveryLoadResult["providerOutcome"] = "not_called",
  hashtagCount = 0
): TikTokDiscoveryLoadResult {
  return {
    response: { status: "unavailable", items: [] },
    transportStatus: 200,
    cacheOutcome,
    providerOutcome,
    hashtagCount,
    retryAt: null,
  };
}

function coordinationResult(input: {
  stale: TikTokDiscoveryCacheEnvelope | null;
  providerOutcome?: TikTokDiscoveryLoadResult["providerOutcome"];
  hashtagCount?: number;
  retryAt?: string | null;
}): TikTokDiscoveryLoadResult {
  const providerOutcome = input.providerOutcome ?? "not_called";
  const hashtagCount = input.hashtagCount ?? 0;
  const retryAt = input.retryAt ?? null;
  if (input.stale) {
    return {
      response: okResponse(input.stale, true, "provider_unavailable"),
      transportStatus: 200,
      cacheOutcome: "coordination_unavailable",
      providerOutcome,
      hashtagCount,
      retryAt,
    };
  }
  return temporaryResult({
    transportStatus: 503,
    cacheOutcome: "coordination_unavailable",
    providerOutcome,
    hashtagCount,
    retryAt,
  });
}

function rateLimitedResult(input: {
  stale: TikTokDiscoveryCacheEnvelope | null;
  providerOutcome: TikTokDiscoveryLoadResult["providerOutcome"];
  hashtagCount: number;
  retryAt: string | null;
}): TikTokDiscoveryLoadResult {
  if (input.stale) {
    return {
      response: okResponse(input.stale, true, "provider_rate_limited"),
      transportStatus: 200,
      cacheOutcome: "stale_rate_limited",
      providerOutcome: input.providerOutcome,
      hashtagCount: input.hashtagCount,
      retryAt: input.retryAt,
    };
  }
  return temporaryResult({
    providerOutcome: input.providerOutcome,
    hashtagCount: input.hashtagCount,
    retryAt: input.retryAt,
  });
}

async function releaseRefreshLock(context: RefreshContext): Promise<void> {
  try {
    const released = await context.deps.cacheStore.compareAndDelete(
      context.keys.refreshLock,
      context.ownerToken
    );
    if (!released) {
      // False may mean lease loss or backend failure. Never retry with an
      // unconditional delete that could release a newer owner.
      return;
    }
  } catch {
    // The owner-token lease remains bounded; an early-exit release is best effort.
  }
}

function providerFailureState(
  error: TikTokBusinessApiError
): ProviderFailureState {
  if (error.code === "unauthorized") {
    return {
      status: "reconnect_required",
      errorCode: "reconnect_required",
    };
  }
  if (error.code === "forbidden") {
    return { status: "connected", errorCode: "approval_required" };
  }
  if (error.code === "rate_limited") {
    return { status: "connected", errorCode: "provider_rate_limited" };
  }
  return {
    status: "connected",
    errorCode: error.retryable
      ? "provider_unavailable"
      : "provider_protocol_error",
  };
}

function coldProviderFailure(
  error: TikTokBusinessApiError,
  hashtagCount: number,
  retryAt: string | null
): TikTokDiscoveryLoadResult {
  if (error.code === "rate_limited") {
    return rateLimitedResult({
      stale: null,
      providerOutcome: error.code,
      hashtagCount,
      retryAt,
    });
  }
  if (error.code === "unauthorized") {
    return temporaryResult({
      cacheOutcome: "credential_unavailable",
      providerOutcome: error.code,
      hashtagCount,
    });
  }
  if (error.code === "forbidden") {
    return unavailableResult(
      "credential_unavailable",
      error.code,
      hashtagCount
    );
  }
  return {
    response: { status: "error", items: [], retryable: error.retryable },
    transportStatus: 200,
    cacheOutcome: "temporarily_unavailable",
    providerOutcome: error.code,
    hashtagCount,
    retryAt: null,
  };
}

async function storeCooldown(
  context: RefreshContext,
  endpoint: TikTokDiscoveryProviderEndpoint,
  retryAfterSeconds: number | null,
  writeAt: Date
): Promise<string | null | "unavailable"> {
  if (retryAfterSeconds === null) return null;
  const retryAt = new Date(
    writeAt.getTime() + retryAfterSeconds * 1_000
  ).toISOString();
  const key =
    endpoint === "trending_list"
      ? context.keys.trendingCooldown
      : context.keys.videoCooldown;
  const stored = await context.deps.cacheStore.writeWithStatus(
    key,
    {
      schemaVersion: SCHEMA_VERSION,
      apiVersion: API_VERSION,
      generation: context.generation,
      endpoint,
      retryAt,
    } satisfies TikTokDiscoveryCooldownEnvelope,
    retryAfterSeconds
  );
  return stored === "stored" ? retryAt : "unavailable";
}

async function handleProviderFailure(
  failure: unknown,
  endpoint: TikTokDiscoveryProviderEndpoint,
  context: RefreshContext
): Promise<TikTokDiscoveryLoadResult> {
  const error =
    failure instanceof TikTokBusinessApiError
      ? failure
      : new TikTokBusinessApiError("provider", true, null, null);
  const state = providerFailureState(error);
  const publication = await context.deps.markCredentialFailureAndPublish({
    generation: context.generation,
    ...state,
  });
  if (publication !== "published") {
    await releaseRefreshLock(context);
    return temporaryResult({
      transportStatus: publication === "coordination_unavailable" ? 503 : 200,
      cacheOutcome:
        publication === "coordination_unavailable"
          ? "coordination_unavailable"
          : "temporarily_unavailable",
      providerOutcome: error.code,
      hashtagCount: context.hashtagCount,
    });
  }

  const cooldown =
    error.code === "rate_limited"
      ? await storeCooldown(
          context,
          endpoint,
          error.retryAfterSeconds,
          context.clock()
        )
      : null;
  if (cooldown === "unavailable") {
    await releaseRefreshLock(context);
    return coordinationResult({
      stale: context.stale,
      providerOutcome: error.code,
      hashtagCount: context.hashtagCount,
    });
  }
  await releaseRefreshLock(context);
  if (context.stale) {
    return {
      response: okResponse(
        context.stale,
        true,
        error.code === "rate_limited"
          ? "provider_rate_limited"
          : "provider_unavailable"
      ),
      transportStatus: 200,
      cacheOutcome:
        error.code === "rate_limited"
          ? "stale_rate_limited"
          : "stale_provider_error",
      providerOutcome: error.code,
      hashtagCount: context.hashtagCount,
      retryAt: cooldown,
    };
  }
  return coldProviderFailure(error, context.hashtagCount, cooldown);
}

async function publishValidation(
  deps: TikTokDiscoveryDependencies,
  generation: string,
  validatedAt: Date
): Promise<"published" | "changed" | "coordination_unavailable"> {
  return deps.markCredentialValidatedAndPublish({
    generation,
    validatedAt,
  });
}

function boundedMetadataText(value: unknown, maximum: number): string | null {
  return isBoundedString(value, maximum) ? value : null;
}

async function buildCatalogItems(
  selected: Array<{
    hashtag: TikTokDiscoveryHashtag;
    video: TikTokDiscoveryVideo;
  }>,
  input: {
    market: TikTokDiscoveryMarket;
    category: TikTokDiscoveryCategory;
    fetchOEmbed: typeof fetchTikTokOEmbed;
  }
): Promise<TikTokMarketingTemplateCatalogItem[]> {
  const limit = pLimit(OEMBED_CONCURRENCY);
  return Promise.all(
    selected.map(({ hashtag, video }) =>
      limit(async () => {
        let metadata: TikTokOEmbedMetadata | null = null;
        try {
          metadata = await input.fetchOEmbed(video.shareUrl);
        } catch {
          metadata = null;
        }
        return {
          id: `tiktok:${video.videoId}` as const,
          source: "tiktok_discovery" as const,
          title:
            boundedMetadataText(metadata?.title, MAX_TITLE_LENGTH) ??
            `#${hashtag.name}`,
          preset: null,
          reference: {
            providerVideoId: video.videoId,
            shareUrl: video.shareUrl,
            thumbnailUrl: normalizeTikTokThumbnailUrl(metadata?.thumbnailUrl),
            creatorName: boundedMetadataText(
              metadata?.authorName,
              MAX_CREATOR_LENGTH
            ),
            creatorUrl: normalizeTikTokShareUrl(metadata?.authorUrl),
            hashtag: hashtag.name,
            hashtagRank: hashtag.rank,
            videoRank: video.rank,
            market: input.market,
            category: input.category,
            windowDays: WINDOW_DAYS,
          },
        };
      })
    )
  );
}

async function publishCatalog(
  context: RefreshContext,
  input: {
    advertiserId: string;
    market: TikTokDiscoveryMarket;
    category: TikTokDiscoveryCategory;
    items: TikTokMarketingTemplateCatalogItem[];
  }
): Promise<TikTokDiscoveryLoadResult> {
  const timestamp = context.clock().toISOString();
  const envelope: TikTokDiscoveryCacheEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    apiVersion: API_VERSION,
    generation: context.generation,
    advertiserId: input.advertiserId,
    market: input.market,
    category: input.category,
    windowDays: WINDOW_DAYS,
    items: input.items,
    updatedAt: timestamp,
    refreshedAt: timestamp,
  };
  const publication = await context.deps.cacheStore.publishIfLockOwned({
    lockKey: context.keys.refreshLock,
    ownerToken: context.ownerToken,
    valueKey: context.keys.catalog,
    value: envelope,
    ttlSeconds: CATALOG_TTL_SECONDS,
  });
  if (publication !== "published") {
    return coordinationResult({
      stale: context.stale,
      providerOutcome: "success",
      hashtagCount: context.hashtagCount,
    });
  }
  return {
    response: okResponse(envelope, false),
    transportStatus: 200,
    cacheOutcome: "refreshed",
    providerOutcome: "success",
    hashtagCount: context.hashtagCount,
    retryAt: null,
  };
}

function bestStale(
  current: TikTokDiscoveryCacheEnvelope | null,
  candidate: CatalogRead
): TikTokDiscoveryCacheEnvelope | null {
  if (candidate.status !== "stale") return current;
  if (!current) return candidate.envelope;
  return Date.parse(candidate.envelope.refreshedAt) >
    Date.parse(current.refreshedAt)
    ? candidate.envelope
    : current;
}

export async function loadTikTokDiscoveryMarketingTemplates(
  input: {
    market: TikTokDiscoveryMarket;
    category: TikTokDiscoveryCategory;
    now?: () => Date;
  },
  overrides: Partial<TikTokDiscoveryDependencies> = {}
): Promise<TikTokDiscoveryLoadResult> {
  const deps = { ...defaultDependencies, ...overrides };
  const clock = input.now ?? (() => new Date());
  const classificationNow = clock();
  const appIdentity = deps.resolveAppIdentity();
  if (appIdentity.status !== "configured") return unavailableResult();

  const coordinate = await deps.resolveCredentialCoordinate();
  if (coordinate.status === "unavailable") return unavailableResult();
  if (coordinate.status === "reconnect_required") {
    return temporaryResult({ cacheOutcome: "credential_unavailable" });
  }
  if (coordinate.status === "infrastructure_unavailable") {
    return temporaryResult({
      transportStatus: 503,
      cacheOutcome: "coordination_unavailable",
    });
  }

  const keys = buildTikTokDiscoveryCacheKeys({
    developerAppId: appIdentity.appId,
    generation: coordinate.generation,
    advertiserId: coordinate.advertiserId,
    market: input.market,
    category: input.category,
  });
  const expected = {
    generation: coordinate.generation,
    advertiserId: coordinate.advertiserId,
    market: input.market,
    category: input.category,
  };
  const initialCatalog = await readCatalog(
    deps,
    keys.catalog,
    expected,
    classificationNow
  );
  if (initialCatalog.status === "unavailable") {
    return coordinationResult({ stale: null });
  }
  if (initialCatalog.status === "fresh") {
    return freshResult(initialCatalog.envelope);
  }
  let stale =
    initialCatalog.status === "stale" ? initialCatalog.envelope : null;

  const initialTrendingCooldown = await readCooldown(
    deps,
    keys.trendingCooldown,
    {
      generation: coordinate.generation,
      endpoint: "trending_list",
      now: clock(),
    }
  );
  if (initialTrendingCooldown.status === "unavailable") {
    return coordinationResult({ stale });
  }
  if (initialTrendingCooldown.status === "live") {
    return rateLimitedResult({
      stale,
      providerOutcome: "rate_limited",
      hashtagCount: 0,
      retryAt: initialTrendingCooldown.retryAt,
    });
  }

  const ownerToken = randomBytes(16).toString("hex");
  const lock = await deps.cacheStore.acquireLock(
    keys.refreshLock,
    ownerToken,
    REFRESH_LOCK_TTL_SECONDS
  );
  if (lock === "unavailable") return coordinationResult({ stale });
  if (lock === "contended") {
    if (stale) {
      return {
        response: okResponse(stale, true, "provider_unavailable"),
        transportStatus: 200,
        cacheOutcome: "stale_lock_contended",
        providerOutcome: "not_called",
        hashtagCount: 0,
        retryAt: null,
      };
    }
    return temporaryResult();
  }

  const context: RefreshContext = {
    deps,
    keys,
    generation: coordinate.generation,
    ownerToken,
    clock,
    stale,
    hashtagCount: 0,
  };
  const rereadCatalog = await readCatalog(
    deps,
    keys.catalog,
    expected,
    classificationNow
  );
  if (rereadCatalog.status === "unavailable") {
    await releaseRefreshLock(context);
    return coordinationResult({ stale });
  }
  if (rereadCatalog.status === "fresh") {
    await releaseRefreshLock(context);
    return freshResult(rereadCatalog.envelope);
  }
  stale = bestStale(stale, rereadCatalog);
  context.stale = stale;

  const rereadTrendingCooldown = await readCooldown(
    deps,
    keys.trendingCooldown,
    {
      generation: coordinate.generation,
      endpoint: "trending_list",
      now: clock(),
    }
  );
  if (rereadTrendingCooldown.status === "unavailable") {
    await releaseRefreshLock(context);
    return coordinationResult({ stale });
  }
  if (rereadTrendingCooldown.status === "live") {
    await releaseRefreshLock(context);
    return rateLimitedResult({
      stale,
      providerOutcome: "rate_limited",
      hashtagCount: 0,
      retryAt: rereadTrendingCooldown.retryAt,
    });
  }

  const credential = await deps.loadCredentialForGeneration({
    generation: coordinate.generation,
  });
  if (credential.status !== "ready") {
    await releaseRefreshLock(context);
    if (credential.status === "infrastructure_unavailable") {
      return coordinationResult({ stale });
    }
    if (credential.status === "unavailable") return unavailableResult();
    return temporaryResult({ cacheOutcome: "credential_unavailable" });
  }
  if (
    credential.generation !== coordinate.generation ||
    credential.advertiserId !== coordinate.advertiserId
  ) {
    await releaseRefreshLock(context);
    return temporaryResult({ cacheOutcome: "credential_unavailable" });
  }

  const trendingPermit = await deps.acquireProviderPermit({
    endpoint: "trending_list",
    developerAppId: appIdentity.appId,
  });
  if (trendingPermit.permit !== "granted") {
    await releaseRefreshLock(context);
    if (trendingPermit.permit === "unavailable") {
      return coordinationResult({
        stale,
        providerOutcome: "permit_unavailable",
      });
    }
    return rateLimitedResult({
      stale,
      providerOutcome: "permit_limited",
      hashtagCount: 0,
      retryAt: trendingPermit.retryAt,
    });
  }

  let trending: Awaited<ReturnType<typeof fetchTikTokTrendingHashtags>>;
  try {
    trending = await deps.fetchTrendingHashtags({
      accessToken: credential.accessToken,
      advertiserId: credential.advertiserId,
      market: input.market,
      category: input.category,
    });
  } catch (error) {
    return handleProviderFailure(error, "trending_list", context);
  }
  const trendingPublication = await publishValidation(
    deps,
    coordinate.generation,
    clock()
  );
  if (trendingPublication !== "published") {
    await releaseRefreshLock(context);
    return temporaryResult({
      transportStatus:
        trendingPublication === "coordination_unavailable" ? 503 : 200,
      cacheOutcome:
        trendingPublication === "coordination_unavailable"
          ? "coordination_unavailable"
          : "temporarily_unavailable",
      providerOutcome: "success",
    });
  }

  const eligibleHashtags = trending.hashtags
    .filter(hashtag => hashtag.topCountryList.includes(input.market))
    .sort((left, right) => left.rank - right.rank)
    .slice(0, MAX_HASHTAGS);
  context.hashtagCount = eligibleHashtags.length;
  if (eligibleHashtags.length === 0) {
    return publishCatalog(context, {
      advertiserId: coordinate.advertiserId,
      market: input.market,
      category: input.category,
      items: [],
    });
  }

  const videoCooldown = await readCooldown(deps, keys.videoCooldown, {
    generation: coordinate.generation,
    endpoint: "video_list",
    now: clock(),
  });
  if (videoCooldown.status === "unavailable") {
    await releaseRefreshLock(context);
    return coordinationResult({
      stale,
      providerOutcome: "success",
      hashtagCount: context.hashtagCount,
    });
  }
  if (videoCooldown.status === "live") {
    await releaseRefreshLock(context);
    return rateLimitedResult({
      stale,
      providerOutcome: "rate_limited",
      hashtagCount: context.hashtagCount,
      retryAt: videoCooldown.retryAt,
    });
  }

  const videoPermit = await deps.acquireProviderPermit({
    endpoint: "video_list",
    developerAppId: appIdentity.appId,
  });
  if (videoPermit.permit !== "granted") {
    await releaseRefreshLock(context);
    if (videoPermit.permit === "unavailable") {
      return coordinationResult({
        stale,
        providerOutcome: "permit_unavailable",
        hashtagCount: context.hashtagCount,
      });
    }
    return rateLimitedResult({
      stale,
      providerOutcome: "permit_limited",
      hashtagCount: context.hashtagCount,
      retryAt: videoPermit.retryAt,
    });
  }

  const hashtagIds = eligibleHashtags.map(hashtag => hashtag.id) as
    | [string]
    | [string, string]
    | [string, string, string];
  let videoResult: Awaited<ReturnType<typeof fetchTikTokTrendingVideos>>;
  try {
    videoResult = await deps.fetchTrendingVideos({
      accessToken: credential.accessToken,
      advertiserId: credential.advertiserId,
      hashtagIds,
      market: input.market,
    });
  } catch (error) {
    return handleProviderFailure(error, "video_list", context);
  }
  const videoPublication = await publishValidation(
    deps,
    coordinate.generation,
    clock()
  );
  if (videoPublication !== "published") {
    await releaseRefreshLock(context);
    return temporaryResult({
      transportStatus:
        videoPublication === "coordination_unavailable" ? 503 : 200,
      cacheOutcome:
        videoPublication === "coordination_unavailable"
          ? "coordination_unavailable"
          : "temporarily_unavailable",
      providerOutcome: "success",
      hashtagCount: context.hashtagCount,
    });
  }

  const groupsByHashtagId = new Map(
    videoResult.groups.map(group => [group.hashtagId, group] as const)
  );
  const seenVideoIds = new Set<string>();
  const selected: Array<{
    hashtag: TikTokDiscoveryHashtag;
    video: TikTokDiscoveryVideo;
  }> = [];
  for (const hashtag of eligibleHashtags) {
    const group = groupsByHashtagId.get(hashtag.id);
    for (const video of group?.videos ?? []) {
      const shareUrl = normalizeTikTokShareUrl(video.shareUrl);
      if (
        !isIdentifier(video.videoId) ||
        !isProviderRank(video.rank) ||
        shareUrl === null ||
        seenVideoIds.has(video.videoId)
      ) {
        continue;
      }
      seenVideoIds.add(video.videoId);
      selected.push({ hashtag, video: { ...video, shareUrl } });
      if (selected.length === MAX_ITEMS) break;
    }
    if (selected.length === MAX_ITEMS) break;
  }
  const items = await buildCatalogItems(selected, {
    market: input.market,
    category: input.category,
    fetchOEmbed: deps.fetchOEmbed,
  });
  return publishCatalog(context, {
    advertiserId: coordinate.advertiserId,
    market: input.market,
    category: input.category,
    items,
  });
}
