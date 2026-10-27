/**
 * Shared rate limiting utilities using Upstash Redis
 *
 * Usage:
 * ```ts
 * import { createRateLimiter } from '@icecore/shared/lib/rate-limiter';
 *
 * const limiter = createRateLimiter({
 *   requests: 10,
 *   window: '1 m',
 *   prefix: 'api:endpoint',
 * });
 *
 * const result = await limiter.limit('user-123');
 * if (!result.success) {
 *   // Rate limited
 * }
 * ```
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Safe way to access process.env without Node.js types
declare const process: { env: Record<string, string | undefined> } | undefined;

export interface RateLimitConfig {
  requests: number;
  window: "1 s" | "10 s" | "30 s" | "1 m" | "5 m" | "10 m" | "1 h" | "1 d";
  prefix: string;
  analytics?: boolean;
}

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
}

export type CriticalRateLimitResult =
  | {
      status: "granted" | "limited";
      limit: number;
      remaining: number;
      reset: number;
    }
  | { status: "unavailable" };

/**
 * Create a rate limiter with sliding window algorithm
 */
export function createRateLimiter(config: RateLimitConfig): Ratelimit | null {
  // Safe access to process.env (works in both Node.js and edge runtimes)
  const env =
    typeof process !== "undefined"
      ? process.env
      : ({} as Record<string, string | undefined>);
  const redisUrl = env.UPSTASH_REDIS_REST_URL;
  const redisToken = env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    // No Redis configured - return null for graceful degradation
    return null;
  }

  const redis = new Redis({ url: redisUrl, token: redisToken });

  return new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(config.requests, config.window),
    analytics: config.analytics ?? true,
    prefix: `ratelimit:${config.prefix}`,
  });
}

/**
 * Check rate limit for a given identifier
 * Returns a result with success/limit/remaining/reset
 * If Redis is not configured, always returns success (graceful degradation)
 */
export async function checkRateLimit(
  limiter: Ratelimit | null,
  identifier: string,
  fallbackLimit: number = 100,
): Promise<RateLimitResult> {
  if (!limiter) {
    // No rate limiter configured - allow request with fallback values
    return {
      success: true,
      limit: fallbackLimit,
      remaining: fallbackLimit - 1,
      reset: Date.now() + 60000,
    };
  }

  const result = await limiter.limit(identifier);

  return {
    success: result.success,
    limit: result.limit,
    remaining: result.remaining,
    reset: result.reset,
  };
}

export async function checkCriticalRateLimit(
  limiter: Pick<Ratelimit, "limit"> | null,
  identifier: string,
): Promise<CriticalRateLimitResult> {
  if (!limiter) return { status: "unavailable" };
  try {
    const result = await limiter.limit(identifier);
    if (result.reason === "timeout") return { status: "unavailable" };
    return {
      status: result.success ? "granted" : "limited",
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
    };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * Pre-configured rate limiters for common use cases
 */
export const rateLimitPresets = {
  /** API endpoints - 100 requests per minute */
  api: { requests: 100, window: "1 m" as const, prefix: "api" },

  /** Webhooks - 60 requests per minute */
  webhook: { requests: 60, window: "1 m" as const, prefix: "webhook" },

  /** Widget config - 30 requests per minute */
  widgetConfig: {
    requests: 30,
    window: "1 m" as const,
    prefix: "widget:config",
  },

  /** Widget messages - 10 requests per minute */
  widgetMessages: {
    requests: 10,
    window: "1 m" as const,
    prefix: "widget:messages",
  },

  /** Widget history - 20 requests per minute */
  widgetHistory: {
    requests: 20,
    window: "1 m" as const,
    prefix: "widget:history",
  },

  /** Auth attempts - 5 requests per 5 minutes */
  auth: { requests: 5, window: "5 m" as const, prefix: "auth" },

  /** Strict - 10 requests per minute */
  strict: { requests: 10, window: "1 m" as const, prefix: "strict" },

  /** Generous - 1000 requests per minute */
  generous: { requests: 1000, window: "1 m" as const, prefix: "generous" },
};
