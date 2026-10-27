/**
 * Shared caching utilities with Redis + in-memory fallback
 *
 * Usage:
 * ```ts
 * import { cache, buildCacheKey } from '@icecore/shared/lib/cache';
 *
 * const key = buildCacheKey('users', [workspaceId, userId]);
 * await cache.set(key, userData, 3600); // TTL in seconds
 * const data = await cache.get(key);
 * ```
 */

import { Redis } from "@upstash/redis";
import {
  deleteRuntimeLocal,
  deleteRuntimeLocalByPrefix,
  getRuntimeCachePlacement,
  readRuntimeLocal,
  writeRuntimeLocal,
} from "./cache-runtime-policy";

export {
  configureCacheRuntimePolicy,
  type CacheRuntimePolicy,
} from "./cache-runtime-policy";

// Safe way to access process.env without Node.js types
declare const process: { env: Record<string, string | undefined> } | undefined;

type CacheRecord<T> = {
  value: T;
  expiresAt: number;
};

export type CacheLockAcquisition = "acquired" | "contended" | "unavailable";
export type CacheReadResult<T> =
  | { status: "hit"; value: T }
  | { status: "miss" }
  | { status: "unavailable" };
export type CacheWriteResult = "stored" | "unavailable";
export type CacheConsumeResult = "consumed" | "invalid" | "unavailable";
export type CachePublishResult = "published" | "lost" | "unavailable";
export type CacheCompletionLockClaim =
  | "acquired"
  | "contended"
  | "completed"
  | "unavailable";
export type CacheCompletionLockFinalization =
  | "finalized"
  | "not_owner"
  | "unavailable";

export type CacheCompletionLockClaimOptions = {
  completionKey: string;
  lockKey: string;
  token: string;
  lockTtlSeconds: number;
};

export type CacheCompletionLockFinalizationOptions = {
  completionKey: string;
  completionValue: string;
  completionTtlSeconds: number;
  lockKey: string;
  token: string;
};

// Initialize Redis client
// Safe access to process.env (works in both Node.js and edge runtimes)
const env =
  typeof process !== "undefined"
    ? process.env
    : ({} as Record<string, string | undefined>);
const nodeEnv = env.NODE_ENV ?? "production";
const redisUrl = env.UPSTASH_REDIS_REST_URL;
const redisToken = env.UPSTASH_REDIS_REST_TOKEN;
const redisConfigured = Boolean(redisUrl && redisToken);
const cacheDebugEnabled = env.CACHE_DEBUG === "1";
const COMPARE_AND_DELETE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;
const CLAIM_COMPLETION_LOCK_SCRIPT = `
if redis.call("exists", KEYS[1]) == 1 then
  return 2
end
if redis.call("set", KEYS[2], ARGV[1], "NX", "EX", ARGV[2]) then
  return 1
end
return 0
`;
const FINALIZE_COMPLETION_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call("set", KEYS[2], ARGV[2], "EX", ARGV[3])
redis.call("del", KEYS[1])
return 1
`;

let redis: Redis | null = null;
try {
  if (redisConfigured) {
    redis = new Redis({
      url: redisUrl!,
      token: redisToken!,
      enableAutoPipelining: true,
    });
  }
} catch {
  redis = null;
}

const redisEnabled = Boolean(redis);
const memoryEnabled = nodeEnv !== "production";
const cacheEnabled = redisEnabled || memoryEnabled;

if (nodeEnv === "production" && !redisEnabled) {
  console.warn(
    `[Cache] Redis disabled in production (configured=${redisConfigured}, memoryFallback=${memoryEnabled})`,
  );
}

// Simple in-memory fallback cache for local/dev or when Upstash is unavailable
const memoryStore = new Map<string, CacheRecord<unknown>>();
const MEMORY_MAX_ENTRIES = 5000;
const MEMORY_PRUNE_INTERVAL_MS = 60_000;
let lastMemoryPruneAt = 0;

function nowMs(): number {
  return Date.now();
}

function pruneMemoryStore(): void {
  if (!memoryEnabled) return;
  const now = nowMs();
  if (now - lastMemoryPruneAt < MEMORY_PRUNE_INTERVAL_MS) return;
  lastMemoryPruneAt = now;

  for (const [key, rec] of memoryStore) {
    if (rec.expiresAt <= now) {
      memoryStore.delete(key);
    }
  }

  if (memoryStore.size > MEMORY_MAX_ENTRIES) {
    const excess = memoryStore.size - MEMORY_MAX_ENTRIES;
    let removed = 0;
    for (const key of memoryStore.keys()) {
      memoryStore.delete(key);
      removed += 1;
      if (removed >= excess) break;
    }
  }
}

function shouldLogCacheError(key?: string): boolean {
  if (cacheDebugEnabled) return true;
  if (!key) return false;
  return (
    key.startsWith("icecore:kb:") ||
    key.startsWith("icecore:telegram:") ||
    key.startsWith("icecore:whatsapp:")
  );
}

/**
 * Build a cache key from namespace and parts
 * Example: buildCacheKey('users', ['workspace-123', 'user-456']) → 'icecore:users:workspace-123:user-456'
 */
export function buildCacheKey(
  namespace: string,
  parts: Array<string | number | undefined | null>,
): string {
  const safe = parts
    .filter((p) => p !== undefined && p !== null && `${p}`.length > 0)
    .map((p) => `${p}`.replace(/\s+/g, "_"))
    .join(":");
  return `icecore:${namespace}:${safe}`;
}

async function getFromRedis<T>(key: string): Promise<T | null> {
  if (!redisEnabled || !redis) return null;
  try {
    const data = await redis.get<T>(key);
    return (data as T) ?? null;
  } catch (error) {
    if (shouldLogCacheError(key)) {
      console.warn("[Cache] Redis GET failed", {
        key: key.slice(0, 120),
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}

async function setToRedis<T>(
  key: string,
  value: T,
  ttlSeconds: number,
): Promise<void> {
  if (!redisEnabled || !redis) return;
  try {
    await redis.set(key, value, { ex: ttlSeconds });
  } catch (error) {
    if (shouldLogCacheError(key)) {
      console.warn("[Cache] Redis SET failed", {
        key: key.slice(0, 120),
        ttlSeconds,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function getFromRedisWithStatus<T>(
  key: string,
): Promise<CacheReadResult<T>> {
  if (!redisEnabled || !redis) return { status: "unavailable" };
  try {
    const value = await redis.get<T>(key);
    return value === null ? { status: "miss" } : { status: "hit", value };
  } catch {
    return { status: "unavailable" };
  }
}

async function setToRedisWithStatus<T>(
  key: string,
  value: T,
  ttlSeconds: number,
): Promise<CacheWriteResult> {
  if (!redisEnabled || !redis) return "unavailable";
  try {
    await redis.set(key, value, { ex: ttlSeconds });
    return "stored";
  } catch {
    return "unavailable";
  }
}

async function consumeFromRedis(
  key: string,
  expectedValue: string,
): Promise<CacheConsumeResult> {
  if (!redisEnabled || !redis) return "unavailable";
  try {
    const deleted = await redis.eval<[string], number>(
      COMPARE_AND_DELETE_SCRIPT,
      [key],
      [expectedValue],
    );
    return deleted === 1 ? "consumed" : "invalid";
  } catch {
    return "unavailable";
  }
}

async function runOwnedPublicationScript(input: {
  lockKey: string;
  ownerToken: string;
  valueKey: string;
  serializedValue: string;
  ttlSeconds: number;
}): Promise<CachePublishResult> {
  if (!redisEnabled || !redis) return "unavailable";
  try {
    const published = await redis.eval<[string, string, string], number>(
      FINALIZE_COMPLETION_LOCK_SCRIPT,
      [input.lockKey, input.valueKey],
      [input.ownerToken, input.serializedValue, String(input.ttlSeconds)],
    );
    return published === 1 ? "published" : "lost";
  } catch (error) {
    if (shouldLogCacheError(input.lockKey)) {
      console.warn("[Cache] Redis completion-lock finalize failed", {
        key: input.lockKey.slice(0, 120),
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return "unavailable";
  }
}

async function publishFromRedis<T>(input: {
  lockKey: string;
  ownerToken: string;
  valueKey: string;
  value: T;
  ttlSeconds: number;
}): Promise<CachePublishResult> {
  return runOwnedPublicationScript({
    lockKey: input.lockKey,
    ownerToken: input.ownerToken,
    valueKey: input.valueKey,
    serializedValue: JSON.stringify(input.value),
    ttlSeconds: input.ttlSeconds,
  });
}

/**
 * Atomically set a key only if it does not already exist (SET … NX EX).
 * Keeps ordinary contention distinct from a coordination-backend outage.
 */
async function acquireRedisLock<T>(
  key: string,
  value: T,
  ttlSeconds: number,
): Promise<CacheLockAcquisition> {
  if (!redisEnabled || !redis) return "unavailable";
  try {
    const result = await redis.set(key, value, { nx: true, ex: ttlSeconds });
    return result === "OK" ? "acquired" : "contended";
  } catch (error) {
    if (shouldLogCacheError(key)) {
      console.warn("[Cache] Redis SETNX failed", {
        key: key.slice(0, 120),
        ttlSeconds,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return "unavailable";
  }
}

async function claimRedisCompletionLock(
  options: CacheCompletionLockClaimOptions,
): Promise<CacheCompletionLockClaim> {
  if (!redisEnabled || !redis) return "unavailable";
  try {
    const result = await redis.eval<[string, string], number>(
      CLAIM_COMPLETION_LOCK_SCRIPT,
      [options.completionKey, options.lockKey],
      [options.token, String(options.lockTtlSeconds)],
    );
    if (result === 1) return "acquired";
    if (result === 2) return "completed";
    return "contended";
  } catch (error) {
    if (shouldLogCacheError(options.lockKey)) {
      console.warn("[Cache] Redis completion-lock claim failed", {
        key: options.lockKey.slice(0, 120),
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return "unavailable";
  }
}

async function finalizeRedisCompletionLock(
  options: CacheCompletionLockFinalizationOptions,
): Promise<CacheCompletionLockFinalization> {
  const result = await runOwnedPublicationScript({
    lockKey: options.lockKey,
    ownerToken: options.token,
    valueKey: options.completionKey,
    serializedValue: options.completionValue,
    ttlSeconds: options.completionTtlSeconds,
  });
  return result === "published"
    ? "finalized"
    : result === "lost"
      ? "not_owner"
      : "unavailable";
}

function setNXToMemory<T>(key: string, value: T, ttlSeconds: number): boolean {
  if (!memoryEnabled) return false;
  pruneMemoryStore();
  const existing = memoryStore.get(key) as CacheRecord<unknown> | undefined;
  if (existing && existing.expiresAt > nowMs()) return false;
  const expiresAt = nowMs() + ttlSeconds * 1000;
  memoryStore.set(key, { value, expiresAt });
  return true;
}

function getFromMemory<T>(key: string): T | null {
  if (!memoryEnabled) return null;
  pruneMemoryStore();
  const rec = memoryStore.get(key) as CacheRecord<T> | undefined;
  if (!rec) return null;
  if (rec.expiresAt <= nowMs()) {
    memoryStore.delete(key);
    return null;
  }
  return rec.value;
}

function setToMemory<T>(key: string, value: T, ttlSeconds: number): void {
  if (!memoryEnabled) return;
  pruneMemoryStore();
  const expiresAt = nowMs() + ttlSeconds * 1000;
  memoryStore.set(key, { value, expiresAt });
}

async function delRedis(key: string): Promise<void> {
  if (!redisEnabled || !redis) return;
  try {
    await redis.del(key);
  } catch (error) {
    if (shouldLogCacheError(key)) {
      console.warn("[Cache] Redis DEL failed", {
        key: key.slice(0, 120),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function compareAndDeleteRedis(
  key: string,
  expectedValue: string,
): Promise<boolean> {
  if (!redisEnabled || !redis) return false;
  try {
    const deleted = await redis.eval<[string], number>(
      COMPARE_AND_DELETE_SCRIPT,
      [key],
      [expectedValue],
    );
    return deleted === 1;
  } catch (error) {
    if (shouldLogCacheError(key)) {
      console.warn("[Cache] Redis compare-and-delete failed", {
        key: key.slice(0, 120),
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return false;
  }
}

function delMemory(key: string): void {
  if (!memoryEnabled) return;
  memoryStore.delete(key);
}

function compareAndDeleteMemory(key: string, expectedValue: string): boolean {
  if (!memoryEnabled) return false;
  const current = getFromMemory<string>(key);
  if (current !== expectedValue) return false;
  memoryStore.delete(key);
  return true;
}

function claimMemoryCompletionLock(
  options: CacheCompletionLockClaimOptions,
): CacheCompletionLockClaim {
  if (!memoryEnabled) return "unavailable";
  if (getFromMemory(options.completionKey) !== null) return "completed";
  return setNXToMemory(options.lockKey, options.token, options.lockTtlSeconds)
    ? "acquired"
    : "contended";
}

function finalizeMemoryCompletionLock(
  options: CacheCompletionLockFinalizationOptions,
): CacheCompletionLockFinalization {
  if (!memoryEnabled) return "unavailable";
  if (getFromMemory<string>(options.lockKey) !== options.token) {
    return "not_owner";
  }
  setToMemory(
    options.completionKey,
    options.completionValue,
    options.completionTtlSeconds,
  );
  memoryStore.delete(options.lockKey);
  return "finalized";
}

/**
 * Main cache interface
 */
export const cache = {
  /** Whether Redis is available */
  enabled: cacheEnabled,
  redisEnabled,
  memoryEnabled,

  /** Get cached value (checks Redis first, then memory fallback) */
  async get<T>(key: string): Promise<T | null> {
    const placement = getRuntimeCachePlacement(key);
    if (placement === "bypass") return null;
    if (placement === "local") return readRuntimeLocal<T>(key);
    if (!cacheEnabled) return null;
    const fromRedis = await getFromRedis<T>(key);
    if (fromRedis !== null) return fromRedis;
    return getFromMemory<T>(key);
  },

  /** Set cache value (writes to both Redis and memory) */
  async set<T>(key: string, value: T, ttlSeconds = 30): Promise<void> {
    const placement = getRuntimeCachePlacement(key);
    if (placement === "bypass") return;
    if (placement === "local") {
      writeRuntimeLocal(key, value, ttlSeconds);
      return;
    }
    if (!cacheEnabled) return;
    await setToRedis<T>(key, value, ttlSeconds);
    setToMemory<T>(key, value, ttlSeconds);
  },

  async readWithStatus<T>(key: string): Promise<CacheReadResult<T>> {
    const placement = getRuntimeCachePlacement(key);
    if (placement === "bypass") return { status: "miss" };
    if (placement === "local") {
      const value = readRuntimeLocal<T>(key);
      return value === null ? { status: "miss" } : { status: "hit", value };
    }
    if (redisEnabled) return getFromRedisWithStatus<T>(key);
    if (!memoryEnabled) return { status: "unavailable" };
    const value = getFromMemory<T>(key);
    return value === null ? { status: "miss" } : { status: "hit", value };
  },

  async writeWithStatus<T>(
    key: string,
    value: T,
    ttlSeconds = 30,
  ): Promise<CacheWriteResult> {
    const placement = getRuntimeCachePlacement(key);
    if (placement === "bypass") return "stored";
    if (placement === "local") {
      writeRuntimeLocal(key, value, ttlSeconds);
      return "stored";
    }
    if (redisEnabled) return setToRedisWithStatus(key, value, ttlSeconds);
    if (!memoryEnabled) return "unavailable";
    setToMemory(key, value, ttlSeconds);
    return "stored";
  },

  async consumeIfMatches(
    key: string,
    expectedValue: string,
  ): Promise<CacheConsumeResult> {
    if (redisEnabled) return consumeFromRedis(key, expectedValue);
    if (!memoryEnabled) return "unavailable";
    return compareAndDeleteMemory(key, expectedValue) ? "consumed" : "invalid";
  },

  async publishIfLockOwned<T>(input: {
    lockKey: string;
    ownerToken: string;
    valueKey: string;
    value: T;
    ttlSeconds: number;
  }): Promise<CachePublishResult> {
    if (redisEnabled) return publishFromRedis(input);
    if (!memoryEnabled) return "unavailable";
    if (getFromMemory<string>(input.lockKey) !== input.ownerToken)
      return "lost";
    setToMemory(input.valueKey, input.value, input.ttlSeconds);
    compareAndDeleteMemory(input.lockKey, input.ownerToken);
    return "published";
  },

  /**
   * Atomically set a key only if it does not already exist (SET … NX EX).
   * Returns `true` when the key was newly set, `false` if it already existed.
   * When cache is disabled (no Redis or memory), returns `true` so callers
   * can proceed – there is no backend to enforce the lock anyway.
   */
  async setNX<T>(key: string, value: T, ttlSeconds = 30): Promise<boolean> {
    if (!cacheEnabled) return true;
    if (redisEnabled) {
      return (await acquireRedisLock<T>(key, value, ttlSeconds)) === "acquired";
    }
    return setNXToMemory<T>(key, value, ttlSeconds);
  },

  /**
   * Acquire a critical lock without mistaking a backend outage for ordinary
   * contention. Callers can fail closed while reporting the correct reason.
   */
  async acquireLock<T>(
    key: string,
    value: T,
    ttlSeconds = 30,
  ): Promise<CacheLockAcquisition> {
    if (!cacheEnabled) return "unavailable";
    if (redisEnabled) {
      return acquireRedisLock<T>(key, value, ttlSeconds);
    }
    if (memoryEnabled) {
      return setNXToMemory<T>(key, value, ttlSeconds)
        ? "acquired"
        : "contended";
    }
    return "unavailable";
  },

  /**
   * Atomically observe a durable completion marker or acquire its in-progress
   * lock. This prevents a completion/release transition from being mistaken
   * for an untracked gap between separate reads.
   */
  async claimCompletionLock(
    options: CacheCompletionLockClaimOptions,
  ): Promise<CacheCompletionLockClaim> {
    if (!cacheEnabled) return "unavailable";
    if (redisEnabled) return claimRedisCompletionLock(options);
    return claimMemoryCompletionLock(options);
  },

  /**
   * Atomically turn an owned in-progress lock into a durable completion
   * marker. The lock is retained whenever the completion write fails.
   */
  async finalizeCompletionLock(
    options: CacheCompletionLockFinalizationOptions,
  ): Promise<CacheCompletionLockFinalization> {
    if (!cacheEnabled) return "unavailable";
    if (redisEnabled) {
      const result = await finalizeRedisCompletionLock(options);
      if (result === "finalized") {
        setToMemory(
          options.completionKey,
          options.completionValue,
          options.completionTtlSeconds,
        );
        compareAndDeleteMemory(options.lockKey, options.token);
      }
      return result;
    }
    return finalizeMemoryCompletionLock(options);
  },

  /** Delete cache value; bypassed keys are still deleted from Redis. */
  async del(key: string): Promise<void> {
    if (getRuntimeCachePlacement(key) === "local") {
      deleteRuntimeLocal(key);
      return;
    }
    if (!cacheEnabled) return;
    await delRedis(key);
    delMemory(key);
  },

  /** Atomically delete a string value only when it still belongs to the caller. */
  async compareAndDelete(key: string, expectedValue: string): Promise<boolean> {
    if (!cacheEnabled) return false;
    if (redisEnabled) {
      const deleted = await compareAndDeleteRedis(key, expectedValue);
      if (deleted) {
        compareAndDeleteMemory(key, expectedValue);
      }
      return deleted;
    }
    return compareAndDeleteMemory(key, expectedValue);
  },
};

type RedisScanClient = {
  scan: (
    cursor: number,
    opts?: { match?: string; count?: number },
  ) => Promise<[number, string[]]>;
  del: (...keys: string[]) => Promise<number>;
};

async function delRedisByPrefix(prefix: string): Promise<void> {
  if (!redisEnabled || !redis) return;
  try {
    const r = redis as unknown as RedisScanClient;
    let cursor = 0;
    do {
      const [nextCursor, keys] = await r.scan(cursor, {
        match: `${prefix}*`,
        count: 1000,
      });
      if (Array.isArray(keys) && keys.length) {
        await r.del(...keys);
      }
      cursor =
        typeof nextCursor === "string"
          ? parseInt(String(nextCursor), 10)
          : nextCursor || 0;
    } while (cursor !== 0);
  } catch (error) {
    if (shouldLogCacheError(prefix)) {
      console.warn("[Cache] Redis prefix invalidation failed", {
        prefix: prefix.slice(0, 120),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function delMemoryByPrefix(prefix: string): void {
  if (!memoryEnabled) return;
  const keys = Array.from(memoryStore.keys());
  for (const key of keys) {
    if (key.startsWith(prefix)) {
      memoryStore.delete(key);
    }
  }
}

/**
 * Invalidate all cache entries matching a prefix
 */
export async function invalidateCacheByPrefix(prefix: string): Promise<void> {
  deleteRuntimeLocalByPrefix(prefix);
  await delRedisByPrefix(prefix);
  delMemoryByPrefix(prefix);
}

/**
 * Pre-built cache invalidation helpers
 */
export const cacheInvalidation = {
  /** Invalidate a specific conversation */
  async conversation(
    workspaceId: string,
    conversationId: string,
  ): Promise<void> {
    const prefix = `icecore:conversation:${workspaceId}:${conversationId}:`;
    await invalidateCacheByPrefix(prefix);
  },

  /** Invalidate all data for a workspace */
  async workspace(workspaceId: string): Promise<void> {
    const prefix = `icecore:${workspaceId}:`;
    await invalidateCacheByPrefix(prefix);
  },
};
