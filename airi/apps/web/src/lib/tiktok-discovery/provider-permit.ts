import "server-only";

import { createHash } from "node:crypto";
import type { Ratelimit } from "@upstash/ratelimit";
import {
  checkCriticalRateLimit,
  createRateLimiter,
} from "@icecore/shared/lib/rate-limiter";

const PROVIDER_REQUESTS_PER_SECOND = 8;
const PROVIDER_WINDOW_MS = 1_000;
const MAX_MEMORY_WINDOWS = 512;

export type TikTokDiscoveryProviderEndpoint = "trending_list" | "video_list";

export type TikTokProviderPermitResult = {
  permit: "granted" | "limited" | "unavailable";
  retryAt: string | null;
};

export type TikTokProviderPermitDependencies = {
  limiters: Record<
    TikTokDiscoveryProviderEndpoint,
    Pick<Ratelimit, "limit"> | null
  >;
  nodeEnv: string | undefined;
  nowMs: () => number;
  memoryWindows: Map<string, number[]>;
};

const memoryWindows = new Map<string, number[]>();

const defaultDependencies: TikTokProviderPermitDependencies = {
  limiters: {
    trending_list: createRateLimiter({
      requests: PROVIDER_REQUESTS_PER_SECOND,
      window: "1 s",
      prefix: "tiktok-discovery:provider:trending_list",
      analytics: false,
    }),
    video_list: createRateLimiter({
      requests: PROVIDER_REQUESTS_PER_SECOND,
      window: "1 s",
      prefix: "tiktok-discovery:provider:video_list",
      analytics: false,
    }),
  },
  nodeEnv: process.env.NODE_ENV,
  nowMs: Date.now,
  memoryWindows,
};

function buildProviderPermitKey(input: {
  endpoint: TikTokDiscoveryProviderEndpoint;
  developerAppId: string;
}): string {
  return createHash("sha256")
    .update(
      `tiktok-discovery:provider-permit:v1:${input.endpoint}:${input.developerAppId}`
    )
    .digest("hex");
}

function toRetryAt(timestamp: number): string | null {
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function pruneMemoryWindows(
  windows: Map<string, number[]>,
  nowMs: number
): void {
  const cutoff = nowMs - PROVIDER_WINDOW_MS;
  for (const [key, timestamps] of windows) {
    const activeTimestamps = timestamps.filter(timestamp => timestamp > cutoff);
    if (activeTimestamps.length === 0) {
      windows.delete(key);
    } else if (activeTimestamps.length !== timestamps.length) {
      windows.set(key, activeTimestamps);
    }
  }
}

function acquireMemoryPermit(
  key: string,
  dependencies: Pick<
    TikTokProviderPermitDependencies,
    "memoryWindows" | "nowMs"
  >
): TikTokProviderPermitResult {
  const nowMs = dependencies.nowMs();
  pruneMemoryWindows(dependencies.memoryWindows, nowMs);

  let timestamps = dependencies.memoryWindows.get(key);
  if (!timestamps) {
    if (dependencies.memoryWindows.size >= MAX_MEMORY_WINDOWS) {
      const oldestActiveTimestamp = Math.min(
        ...[...dependencies.memoryWindows.values()].map(
          activeTimestamps => activeTimestamps[0]
        )
      );
      return {
        permit: "limited",
        retryAt: toRetryAt(oldestActiveTimestamp + PROVIDER_WINDOW_MS),
      };
    }
    timestamps = [];
    dependencies.memoryWindows.set(key, timestamps);
  }

  if (timestamps.length >= PROVIDER_REQUESTS_PER_SECOND) {
    return {
      permit: "limited",
      retryAt: toRetryAt(timestamps[0] + PROVIDER_WINDOW_MS),
    };
  }

  timestamps.push(nowMs);
  return { permit: "granted", retryAt: null };
}

export async function acquireTikTokProviderPermit(
  input: {
    endpoint: TikTokDiscoveryProviderEndpoint;
    developerAppId: string;
  },
  dependencies?: Partial<TikTokProviderPermitDependencies>
): Promise<TikTokProviderPermitResult> {
  const resolvedDependencies = { ...defaultDependencies, ...dependencies };
  const limiter = resolvedDependencies.limiters[input.endpoint];
  const identifier = buildProviderPermitKey(input);

  if (limiter !== null || resolvedDependencies.nodeEnv === "production") {
    const result = await checkCriticalRateLimit(limiter, identifier);
    if (result.status === "unavailable") {
      return { permit: "unavailable", retryAt: null };
    }
    if (result.status === "limited") {
      return { permit: "limited", retryAt: toRetryAt(result.reset) };
    }
    return { permit: "granted", retryAt: null };
  }

  return acquireMemoryPermit(identifier, resolvedDependencies);
}

export function resetTikTokProviderPermitMemoryForTests(): void {
  memoryWindows.clear();
}
