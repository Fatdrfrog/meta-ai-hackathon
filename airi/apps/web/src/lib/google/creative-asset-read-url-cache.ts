import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { after } from "next/server";
import type {
  CreativeAssetReadUrlRequest,
  CreativeAssetReadUrlResponse,
} from "@icecore/airi-runtime/creative-asset-read-url";
import {
  buildCacheKey,
  cache,
  type CacheReadResult,
  type CacheWriteResult,
} from "@icecore/shared/lib/cache";
import { isRecord } from "@icecore/shared/lib/value-utils";

/**
 * Signed read URLs are bearer credentials: they are never logged, and the
 * cache key always carries the workspace, because the Media API signs a path
 * only for the workspace that owns it.
 */
const READ_URL_CACHE_NAMESPACE = "media:creative-asset-read-url:v1";
/** A cached URL is served only while it stays valid at least this long. */
export const READ_URL_CACHE_EXPIRY_MARGIN_MS = 10 * 60_000;
const READ_URL_CACHE_MIN_TTL_SECONDS = 60;
/** Redis is only a shortcut: past this, signing goes ahead without it. */
export const READ_URL_CACHE_TIMEOUT_MS = 250;

type CreateReadUrl = (
  request: CreativeAssetReadUrlRequest
) => Promise<CreativeAssetReadUrlResponse>;

type ReadUrlCacheOptions = {
  /** Which signer produced the URL, for example the Media API base URL. */
  signer: string;
  now?: () => number;
};

const globalForDisplayReadUrlScope = globalThis as typeof globalThis & {
  __creativeAssetDisplayReadUrlScope?: AsyncLocalStorage<true>;
};

// On globalThis, like the read-URL port itself: instrumentation configures
// the port from its own copy of this module, so a module-local scope entered
// by a page or route would never be seen by the port.
const displayReadUrlScope =
  globalForDisplayReadUrlScope.__creativeAssetDisplayReadUrlScope ??
  new AsyncLocalStorage<true>();

globalForDisplayReadUrlScope.__creativeAssetDisplayReadUrlScope =
  displayReadUrlScope;

/**
 * Runs `work` with the read URLs it signs served through the cache. Only the
 * scenario editor's display path does this: every other caller gets a fresh
 * URL with its full validity, because it may hand the URL to a third party
 * that fetches it later.
 */
export function withCreativeAssetDisplayReadUrlCache<T>(work: () => T): T {
  return displayReadUrlScope.run(true, work);
}

export function isCreativeAssetDisplayReadUrlCacheEnabled(): boolean {
  return displayReadUrlScope.getStore() === true;
}

const inFlightReadUrls = new Map<
  string,
  Promise<CreativeAssetReadUrlResponse>
>();

function readUrlCacheKey(
  request: CreativeAssetReadUrlRequest,
  signer: string
): string | null {
  const workspaceId = request.workspaceId?.trim();
  if (!workspaceId) return null;
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        // Development, preview and production never share a signed URL.
        process.env.VERCEL_ENV?.trim() || "local",
        signer,
        workspaceId,
        request.bucket,
        request.path,
        request.expiresInSeconds ?? null,
      ])
    )
    .digest("hex");
  return buildCacheKey(READ_URL_CACHE_NAMESPACE, [digest]);
}

/** Settles with `fallback` when Redis fails or takes too long. */
function withinCacheTimeout<T>(operation: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<T>(resolve => {
    timer = setTimeout(() => resolve(fallback), READ_URL_CACHE_TIMEOUT_MS);
  });
  return Promise.race([operation.catch(() => fallback), timedOut]).finally(() =>
    clearTimeout(timer)
  );
}

function readRemainingValidityMs(expiresAt: unknown, nowMs: number): number {
  const expiresAtMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : 0;
  return Number.isFinite(expiresAtMs) ? expiresAtMs - nowMs : 0;
}

function isServableReadUrl(
  value: unknown,
  nowMs: number
): value is CreativeAssetReadUrlResponse {
  return (
    isRecord(value) &&
    value.provider === "gcs" &&
    typeof value.url === "string" &&
    value.url.length > 0 &&
    readRemainingValidityMs(value.expiresAt, nowMs) >=
      READ_URL_CACHE_EXPIRY_MARGIN_MS
  );
}

async function readCachedReadUrl(
  key: string,
  nowMs: number
): Promise<CreativeAssetReadUrlResponse | null> {
  const unavailable: CacheReadResult<unknown> = { status: "unavailable" };
  const cached = await withinCacheTimeout(
    cache.readWithStatus<unknown>(key),
    unavailable
  );
  return cached.status === "hit" && isServableReadUrl(cached.value, nowMs)
    ? cached.value
    : null;
}

/** Fire and forget: the fresh URL answers without waiting for Redis. */
function writeCachedReadUrlInBackground(
  key: string,
  response: CreativeAssetReadUrlResponse,
  nowMs: number
): void {
  const ttlSeconds = Math.floor(
    (readRemainingValidityMs(response.expiresAt, nowMs) -
      READ_URL_CACHE_EXPIRY_MARGIN_MS) /
      1000
  );
  if (ttlSeconds < READ_URL_CACHE_MIN_TTL_SECONDS) return;
  const unavailable: CacheWriteResult = "unavailable";
  const write = withinCacheTimeout(
    cache.writeWithStatus(key, response, ttlSeconds),
    unavailable
  );
  try {
    // Keeps the function alive for the write after the response.
    after(write);
  } catch {
    // Outside a request scope the write settles on its own.
  }
}

async function resolveReadUrl(
  key: string,
  request: CreativeAssetReadUrlRequest,
  createReadUrl: CreateReadUrl,
  now: () => number
): Promise<CreativeAssetReadUrlResponse> {
  const cached = await readCachedReadUrl(key, now());
  if (cached) return cached;
  const response = await createReadUrl(request);
  writeCachedReadUrlInBackground(key, response, now());
  return response;
}

/**
 * Reuses a signed read URL until shortly before it expires, so reopening a
 * scenario neither waits for the Media API again nor changes image URLs the
 * browser has cached. Identical requests in flight share one signing call.
 * Requests without a workspace are never cached.
 */
export function readCreativeAssetReadUrlThroughCache(
  request: CreativeAssetReadUrlRequest,
  createReadUrl: CreateReadUrl,
  { signer, now = Date.now }: ReadUrlCacheOptions
): Promise<CreativeAssetReadUrlResponse> {
  const key = readUrlCacheKey(request, signer);
  if (!key) return createReadUrl(request);
  const inFlight = inFlightReadUrls.get(key);
  if (inFlight) return inFlight;
  const pending = resolveReadUrl(key, request, createReadUrl, now).finally(
    () => {
      inFlightReadUrls.delete(key);
    }
  );
  inFlightReadUrls.set(key, pending);
  return pending;
}
