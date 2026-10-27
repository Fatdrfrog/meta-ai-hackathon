import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Upstash REST traffic seen inside one unit of work (an activity or one
 * WhatsApp webhook event). Every Upstash call from europe-west1 is a
 * cross-region round trip, so the count is a latency budget, not a detail.
 */
export type UpstashUsage = {
  /** HTTP round trips to Upstash. */
  requests: number;
  /** Redis commands carried; one pipelined request carries several. */
  commands: number;
  /** Summed request time, including requests that ran concurrently. */
  waitMs: number;
  maxRequestMs: number;
  failures: number;
};

type FetchHost = { fetch: typeof fetch };

const usageScope = new AsyncLocalStorage<UpstashUsage>();
let upstashBaseUrl: string | null = null;

export function createUpstashUsage(): UpstashUsage {
  return { requests: 0, commands: 0, waitMs: 0, maxRequestMs: 0, failures: 0 };
}

function readRequestUrl(input: unknown): string | null {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object" && "url" in input) {
    const url = (input as { url?: unknown }).url;
    return typeof url === "string" ? url : null;
  }
  return null;
}

/** A pipeline or transaction body is a JSON array of commands. */
function countCommands(url: string, body: unknown): number {
  if (!/\/(pipeline|multi-exec)(\?|$)/.test(url)) return 1;
  if (typeof body !== "string") return 1;
  try {
    const parsed: unknown = JSON.parse(body);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed.length : 1;
  } catch {
    return 1;
  }
}

/**
 * Counts Upstash requests made while a usage scope is active. Requests made
 * outside a scope, and all other hosts, pass through untouched. The Upstash
 * client calls the global `fetch` per request, so wrapping it once covers
 * the shared cache, the rate limiters and the capacity locks alike.
 */
export function installUpstashUsageTracking(
  url: string | undefined,
  host: FetchHost = globalThis,
): boolean {
  const baseUrl = url?.trim().replace(/\/+$/, "");
  if (!baseUrl || upstashBaseUrl || typeof host.fetch !== "function") {
    return false;
  }
  upstashBaseUrl = baseUrl;
  const passthrough = host.fetch.bind(host);
  host.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const usage = usageScope.getStore();
    const requestUrl = usage ? readRequestUrl(input) : null;
    if (!usage || !requestUrl?.startsWith(baseUrl)) {
      return passthrough(input, init);
    }
    usage.requests += 1;
    usage.commands += countCommands(requestUrl, init?.body);
    const startedAt = performance.now();
    try {
      return await passthrough(input, init);
    } catch (error) {
      usage.failures += 1;
      throw error;
    } finally {
      const elapsedMs = performance.now() - startedAt;
      usage.waitMs += elapsedMs;
      usage.maxRequestMs = Math.max(usage.maxRequestMs, elapsedMs);
    }
  }) as typeof fetch;
  return true;
}

export function isUpstashUsageTrackingInstalled(): boolean {
  return upstashBaseUrl !== null;
}

/** Test hook: forget the installed base URL so a test can install again. */
export function resetUpstashUsageTrackingForTests(): void {
  upstashBaseUrl = null;
}

/** Runs `run` with `usage` as the active scope; nested scopes don't add up. */
export function runInUpstashUsageScope<T>(
  usage: UpstashUsage,
  run: () => Promise<T>,
): Promise<T> {
  return usageScope.run(usage, run);
}

export async function measureUpstashUsage<T>(
  run: () => Promise<T>,
): Promise<{ value: T; usage: UpstashUsage }> {
  const usage = createUpstashUsage();
  const value = await runInUpstashUsageScope(usage, run);
  return { value, usage };
}

/** Fields for an existing structured log line; empty when not tracking. */
export function upstashUsageLogFields(
  usage: UpstashUsage | null | undefined,
): Record<string, number> {
  if (!usage || !isUpstashUsageTrackingInstalled()) return {};
  return {
    upstashRequests: usage.requests,
    upstashCommands: usage.commands,
    upstashWaitMs: Math.round(usage.waitMs),
    upstashMaxRequestMs: Math.round(usage.maxRequestMs),
    upstashFailures: usage.failures,
  };
}
