import { createHash } from "crypto";
import {
  createValkeyRateLimitClientFromEnv,
  type ValkeyRateLimitClient,
} from "./valkey-rate-limit-client";
import {
  checkRateLimit,
  createRateLimiter,
} from "@icecore/shared/lib/rate-limiter";

type RateLimitInput = {
  workspaceId: string;
  recipientPhone: string;
  purpose: string;
};

type CounterEntry = {
  count: number;
  resetAt: number;
};

const counters = new Map<string, CounterEntry>();
const cooldowns = new Map<string, number>();

type OtpValkeyLimiter = Pick<
  ValkeyRateLimitClient,
  "setNxEx" | "incr" | "expire"
>;

let valkey: OtpValkeyLimiter | null | undefined;

export const OTP_RATE_LIMIT_UNAVAILABLE_ERROR =
  "OTP rate limiter is unavailable";

type SharedRateLimitWindow =
  | "1 s"
  | "10 s"
  | "30 s"
  | "1 m"
  | "5 m"
  | "10 m"
  | "1 h";
type SharedRateLimiter = NonNullable<ReturnType<typeof createRateLimiter>>;
const sharedLimiters = new Map<string, SharedRateLimiter | null>();

export type OtpRateLimitBackend = "valkey" | "upstash" | "memory";

function getRuntimeMode(): string {
  return String(process.env.AIRI_RUNTIME_MODE || "")
    .trim()
    .toLowerCase();
}

/** Cloud Run OTP/worker paths must not use Upstash; Valkey (or memory in non-prod) only. */
export function shouldSkipUpstashOtpRateLimitFallback(): boolean {
  const mode = getRuntimeMode();
  if (mode === "otp-api" || mode === "otp-worker" || mode === "worker") {
    return true;
  }
  return Boolean(
    String(process.env.MEMORYSTORE_VALKEY_HOST || "").trim() ||
      String(process.env.MEMORYSTORE_VALKEY_URL || "").trim() ||
      String(process.env.VALKEY_HOST || "").trim()
  );
}

function shouldFailClosedOnRateLimitBackendError(): boolean {
  const nodeEnv = String(process.env.NODE_ENV || "").toLowerCase();
  const vercelEnv = String(process.env.VERCEL_ENV || "").toLowerCase();
  return nodeEnv === "production" || vercelEnv === "production";
}

function getValkey(): OtpValkeyLimiter | null {
  if (valkey !== undefined) return valkey;
  valkey = createValkeyRateLimitClientFromEnv();
  return valkey;
}

function rethrowIfProductionRateLimitUnavailable(): void {
  if (shouldFailClosedOnRateLimitBackendError()) {
    throw new Error(OTP_RATE_LIMIT_UNAVAILABLE_ERROR);
  }
}

export function getOtpRateLimitBackend(): OtpRateLimitBackend {
  if (getValkey()) return "valkey";
  if (shouldSkipUpstashOtpRateLimitFallback()) {
    return "memory";
  }
  if (
    getSharedRateLimiter({
      requests: 1,
      window: "1 m",
      prefix: "otp:backend",
    })
  ) {
    return "upstash";
  }
  return "memory";
}

function getSharedRateLimiter(input: {
  requests: number;
  window: SharedRateLimitWindow;
  prefix: string;
}): SharedRateLimiter | null {
  const key = `${input.prefix}:${input.requests}:${input.window}`;
  if (sharedLimiters.has(key)) return sharedLimiters.get(key) ?? null;
  try {
    const limiter = createRateLimiter({
      requests: input.requests,
      window: input.window,
      prefix: input.prefix,
      analytics: false,
    });
    sharedLimiters.set(key, limiter);
    return limiter;
  } catch {
    sharedLimiters.set(key, null);
    return null;
  }
}

function parsePositiveInteger(name: string, fallback: number): number {
  const parsed = Number.parseInt(String(process.env[name] || ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function hashPhone(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function toSharedWindow(seconds: number): SharedRateLimitWindow | null {
  if (seconds === 1) return "1 s";
  if (seconds === 10) return "10 s";
  if (seconds === 30) return "30 s";
  if (seconds === 60) return "1 m";
  if (seconds === 300) return "5 m";
  if (seconds === 600) return "10 m";
  if (seconds === 3600) return "1 h";
  return null;
}

async function reserveCooldown(key: string, seconds: number): Promise<boolean> {
  if (seconds <= 0) return true;
  const valkeyClient = getValkey();
  if (valkeyClient) {
    try {
      return await valkeyClient.setNxEx(key, "1", seconds);
    } catch {
      rethrowIfProductionRateLimitUnavailable();
    }
  }

  if (!shouldSkipUpstashOtpRateLimitFallback()) {
    const sharedWindow = toSharedWindow(seconds);
    if (sharedWindow) {
      const limiter = getSharedRateLimiter({
        requests: 1,
        window: sharedWindow,
        prefix: "otp:cooldown",
      });
      if (limiter) {
        try {
          const result = await checkRateLimit(limiter, key, 1);
          return result.success;
        } catch {
          // Fall through to local limiter when the shared Redis limiter is unavailable.
        }
      }
    }
  }

  const now = Date.now();
  const existingReset = cooldowns.get(key);
  if (existingReset && existingReset > now) return false;
  cooldowns.set(key, now + seconds * 1000);
  return true;
}

async function incrementWindowCounter(input: {
  key: string;
  limit: number;
  ttlSeconds: number;
  sharedPrefix: string;
  sharedWindow: SharedRateLimitWindow;
}): Promise<boolean> {
  if (input.limit <= 0) return false;
  const valkeyClient = getValkey();
  if (valkeyClient) {
    try {
      const count = await valkeyClient.incr(input.key);
      if (count === 1) {
        await valkeyClient.expire(input.key, input.ttlSeconds);
      }
      return count <= input.limit;
    } catch {
      rethrowIfProductionRateLimitUnavailable();
    }
  }

  if (!shouldSkipUpstashOtpRateLimitFallback()) {
    const limiter = getSharedRateLimiter({
      requests: input.limit,
      window: input.sharedWindow,
      prefix: input.sharedPrefix,
    });
    if (limiter) {
      try {
        const result = await checkRateLimit(limiter, input.key, input.limit);
        return result.success;
      } catch {
        // Fall through to local limiter when the shared Redis limiter is unavailable.
      }
    }
  }

  const now = Date.now();
  const existing = counters.get(input.key);
  if (!existing || existing.resetAt <= now) {
    counters.set(input.key, {
      count: 1,
      resetAt: now + input.ttlSeconds * 1000,
    });
    return true;
  }
  existing.count += 1;
  counters.set(input.key, existing);
  return existing.count <= input.limit;
}

export async function assertWhatsAppOtpRequestAllowed(
  input: RateLimitInput
): Promise<void> {
  const phoneHash = hashPhone(input.recipientPhone);
  const cooldownSeconds = parsePositiveInteger(
    "OTP_RATE_LIMIT_COOLDOWN_SECONDS",
    30
  );
  const phoneLimit = parsePositiveInteger("OTP_RATE_LIMIT_PHONE_PER_HOUR", 5);
  const workspaceLimit = parsePositiveInteger(
    "OTP_RATE_LIMIT_WORKSPACE_PER_MINUTE",
    1000
  );
  const now = Date.now();
  const minuteBucket = Math.floor(now / 60_000);
  const hourBucket = Math.floor(now / 3_600_000);
  const base = `${input.workspaceId}:${input.purpose}`;

  const workspaceAllowed = await incrementWindowCounter({
    key: `otp:workspace:${input.workspaceId}:${minuteBucket}`,
    limit: workspaceLimit,
    ttlSeconds: 120,
    sharedPrefix: "otp:workspace",
    sharedWindow: "1 m",
  });
  if (!workspaceAllowed) {
    throw new Error("Too many OTP requests for this workspace");
  }

  const phoneAllowed = await incrementWindowCounter({
    key: `otp:phone:${base}:${phoneHash}:${hourBucket}`,
    limit: phoneLimit,
    ttlSeconds: 7_200,
    sharedPrefix: "otp:phone",
    sharedWindow: "1 h",
  });
  if (!phoneAllowed) {
    throw new Error("Too many OTP requests for this phone number");
  }

  const cooldownReserved = await reserveCooldown(
    `otp:cooldown:${base}:${phoneHash}`,
    cooldownSeconds
  );
  if (!cooldownReserved) {
    throw new Error("Please wait before requesting another OTP");
  }
}

export function installOtpRateLimitValkeyForTests(
  client: OtpValkeyLimiter | null
): void {
  valkey = client;
}

export function resetOtpRateLimitForTests(): void {
  counters.clear();
  cooldowns.clear();
  valkey = undefined;
  sharedLimiters.clear();
}
