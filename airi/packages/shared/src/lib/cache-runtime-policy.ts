/**
 * Per-runtime cache placement for `cache.ts`.
 *
 * A runtime far from Upstash, like the GCP services in europe-west1, keeps
 * pure caches in its own memory and skips caching for data it can read from
 * the source faster than Upstash answers. The state lives on `globalThis` so
 * the CJS and ESM copies of the cache module share one policy and one store,
 * and this module has no side effects, so a runtime can set its policy
 * before its environment (and the Upstash client) is loaded.
 */
export type CacheRuntimePolicy = {
  /** Key prefixes cached in this process only, never sent to Upstash. */
  localPrefixes?: readonly string[];
  /**
   * Key prefixes this runtime neither reads nor writes. Deletes still reach
   * Upstash, so invalidations for other runtimes keep working.
   */
  bypassPrefixes?: readonly string[];
};

export type RuntimeCachePlacement = "local" | "bypass" | null;

type LocalRecord = { json: string; expiresAt: number };
type RuntimeCacheState = {
  localPrefixes: readonly string[];
  bypassPrefixes: readonly string[];
  local: Map<string, LocalRecord>;
};
type RuntimeCacheHost = Record<symbol, RuntimeCacheState | undefined>;

const RUNTIME_CACHE_STATE = Symbol.for("icecore.cache.runtimePolicy");
export const RUNTIME_LOCAL_CACHE_MAX_ENTRIES = 10_000;

function readState(): RuntimeCacheState | null {
  return (globalThis as RuntimeCacheHost)[RUNTIME_CACHE_STATE] ?? null;
}

export function configureCacheRuntimePolicy(
  policy: CacheRuntimePolicy | null,
): void {
  const host = globalThis as RuntimeCacheHost;
  if (!policy) {
    delete host[RUNTIME_CACHE_STATE];
    return;
  }
  host[RUNTIME_CACHE_STATE] = {
    localPrefixes: [...(policy.localPrefixes ?? [])],
    bypassPrefixes: [...(policy.bypassPrefixes ?? [])],
    local: host[RUNTIME_CACHE_STATE]?.local ?? new Map(),
  };
}

export function getRuntimeCachePlacement(key: string): RuntimeCachePlacement {
  const state = readState();
  if (!state) return null;
  if (state.bypassPrefixes.some((prefix) => key.startsWith(prefix))) {
    return "bypass";
  }
  if (state.localPrefixes.some((prefix) => key.startsWith(prefix))) {
    return "local";
  }
  return null;
}

/** Returns a fresh copy, like a value read back from Upstash. */
export function readRuntimeLocal<T>(key: string): T | null {
  const local = readState()?.local;
  const record = local?.get(key);
  if (!local || !record) return null;
  if (record.expiresAt <= Date.now()) {
    local.delete(key);
    return null;
  }
  // Refresh insertion order so bounded eviction behaves like an LRU cache.
  local.delete(key);
  local.set(key, record);
  return JSON.parse(record.json) as T;
}

export function writeRuntimeLocal<T>(
  key: string,
  value: T,
  ttlSeconds: number,
): void {
  const local = readState()?.local;
  if (!local) return;
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return;
  }
  if (json === undefined) return;
  local.delete(key);
  local.set(key, { json, expiresAt: Date.now() + ttlSeconds * 1000 });
  while (local.size > RUNTIME_LOCAL_CACHE_MAX_ENTRIES) {
    const oldest = local.keys().next().value;
    if (oldest === undefined) break;
    local.delete(oldest);
  }
}

export function deleteRuntimeLocal(key: string): void {
  readState()?.local.delete(key);
}

export function deleteRuntimeLocalByPrefix(prefix: string): void {
  const local = readState()?.local;
  if (!local) return;
  for (const key of [...local.keys()]) {
    if (key.startsWith(prefix)) local.delete(key);
  }
}
