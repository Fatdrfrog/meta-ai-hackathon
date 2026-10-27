import { randomUUID } from "node:crypto";
import { cache } from "@icecore/shared/lib/cache";
import { awaitWithCancellation } from "@/lib/ai/cancellation";
const LOCAL_ANALYTICS_TTL_SECONDS = 60;
const LOCAL_REFRESH_FLOOR_MS = 30_000;
const LOCAL_AGGREGATE_MAX_TIME_MS = 25_000;
const LOCAL_LOCK_TTL_SECONDS = 35;
const LOCAL_WAIT_POLL_MS = 500;
type LocalAnalyticsEntry<T> = { generatedAt: string; raw: T };
function waitForPoll(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, LOCAL_WAIT_POLL_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs one local aggregate per cache key at a time. Concurrent viewers wait
 * for the running aggregate instead of starting their own, and a refresh
 * reuses a result that is younger than the refresh floor.
 */
export async function readCachedLocalAnalytics<T>(params: {
  key: string;
  refresh?: boolean;
  signal?: AbortSignal;
  run: () => Promise<T>;
}): Promise<T> {
  const usable = async () => {
    params.signal?.throwIfAborted();
    const entry = await cache.get<LocalAnalyticsEntry<T>>(params.key);
    params.signal?.throwIfAborted();
    const age = entry ? Date.now() - Date.parse(entry.generatedAt) : NaN;
    return entry &&
      Number.isFinite(age) &&
      "raw" in entry &&
      (!params.refresh || age < LOCAL_REFRESH_FLOOR_MS)
      ? entry
      : null;
  };
  const cached = await usable();
  if (cached) return cached.raw;
  const lockKey = `${params.key}:lock`;
  const deadline = Date.now() + LOCAL_AGGREGATE_MAX_TIME_MS;
  for (;;) {
    params.signal?.throwIfAborted();
    const owner = randomUUID();
    const lock = await cache.acquireLock(
      lockKey,
      owner,
      LOCAL_LOCK_TTL_SECONDS
    );
    // Without a coordination backend every request runs its own aggregate.
    if (lock !== "contended") {
      try {
        params.signal?.throwIfAborted();
        // Another owner may have published after our initial miss, before this claim.
        const published = await usable();
        if (published) return published.raw;
        params.signal?.throwIfAborted();
        const raw = await params.run();
        params.signal?.throwIfAborted();
        await cache.set<LocalAnalyticsEntry<T>>(
          params.key,
          { generatedAt: new Date().toISOString(), raw },
          LOCAL_ANALYTICS_TTL_SECONDS
        );
        return raw;
      } finally {
        if (lock === "acquired") await cache.compareAndDelete(lockKey, owner);
      }
    }
    if (Date.now() >= deadline)
      throw new Error("WhatsApp analytics aggregate is still running");
    await waitForPoll(params.signal);
    const published = await usable();
    if (published) return published.raw;
  }
}

export type AnalyticsQueryBudget = {
  signal: AbortSignal;
  deadlineAt: number;
  /** Throws after cancellation/deadline; never grants a fresh query budget. */
  remainingMs: () => number;
};

/** One request-wide deadline, shared by database reads and connection waits. */
export async function withAnalyticsQueryBudget<T>(params: {
  signal?: AbortSignal;
  maxTimeMS?: number;
  run: (budget: AnalyticsQueryBudget) => Promise<T>;
}): Promise<T> {
  const maxTimeMS = Math.max(
    1,
    Math.min(
      params.maxTimeMS ?? LOCAL_AGGREGATE_MAX_TIME_MS,
      LOCAL_AGGREGATE_MAX_TIME_MS
    )
  );
  const controller = new AbortController();
  const deadlineAt = Date.now() + maxTimeMS;
  const cancel = () => controller.abort(params.signal?.reason);
  if (params.signal?.aborted) cancel();
  params.signal?.addEventListener("abort", cancel, { once: true });
  const expire = () =>
    controller.abort(
      new Error("Analytics query exceeded its execution budget.")
    );
  const timer = setTimeout(expire, maxTimeMS);
  const remainingMs = () => {
    controller.signal.throwIfAborted();
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      expire();
      controller.signal.throwIfAborted();
    }
    return Math.max(1, remaining);
  };
  try {
    remainingMs();
    const result = await awaitWithCancellation(
      params.run({ signal: controller.signal, deadlineAt, remainingMs }),
      controller.signal
    );
    remainingMs();
    return result;
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener("abort", cancel);
  }
}
