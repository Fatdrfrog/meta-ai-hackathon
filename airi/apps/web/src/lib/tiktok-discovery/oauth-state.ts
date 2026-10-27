import "server-only";

import { createHash, randomBytes } from "node:crypto";

import type {
  CacheConsumeResult,
  CacheLockAcquisition,
} from "@icecore/shared/lib/cache";

import { buildCacheKey, cache } from "@/lib/cache";

export const TIKTOK_OAUTH_COOKIE_NAME = "airi_tiktok_oauth_state";
export const TIKTOK_OAUTH_STATE_TTL_SECONDS = 900;

export type TikTokOAuthStateDependencies = {
  cacheClient: Pick<typeof cache, "acquireLock" | "consumeIfMatches">;
};

type TikTokOAuthStateContext = {
  state: string;
  userId: string;
  redirectUri: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stateCacheMaterial(input: TikTokOAuthStateContext): {
  key: string;
  binding: string;
} {
  const stateDigest = sha256(input.state);
  const canonicalBinding = JSON.stringify([
    "v1",
    stateDigest,
    input.userId,
    input.redirectUri,
  ]);
  return {
    key: buildCacheKey("tiktok:oauth-state:v1", [stateDigest]),
    binding: sha256(canonicalBinding),
  };
}

export function generateTikTokOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function registerTikTokOAuthState(
  input: TikTokOAuthStateContext,
  dependencies: Partial<TikTokOAuthStateDependencies> = {}
): Promise<CacheLockAcquisition> {
  const { key, binding } = stateCacheMaterial(input);
  return (dependencies.cacheClient ?? cache).acquireLock(
    key,
    binding,
    TIKTOK_OAUTH_STATE_TTL_SECONDS
  );
}

export function consumeTikTokOAuthState(
  input: TikTokOAuthStateContext,
  dependencies: Partial<TikTokOAuthStateDependencies> = {}
): Promise<CacheConsumeResult> {
  const { key, binding } = stateCacheMaterial(input);
  return (dependencies.cacheClient ?? cache).consumeIfMatches(key, binding);
}
