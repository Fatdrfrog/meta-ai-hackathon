import { Redis } from "@upstash/redis";
import { createHash } from "crypto";
import { supabaseAdmin } from "./supabase/admin";

export interface ApiKeyData {
  id: string;
  workspace_id: string;
  key_prefix: string;
  name: string;
  permissions: {
    read?: boolean;
    write?: boolean;
    conversations?: boolean;
    analytics?: boolean;
    templates?: boolean;
    bulk_send?: boolean;
  };
  rate_limit_per_minute: number;
  is_active: boolean;
  expires_at?: string | null;
}

export async function validateApiKey(
  apiKey: string
): Promise<ApiKeyData | null> {
  if (!apiKey || !apiKey.startsWith("sk_")) {
    return null;
  }

  const keyHash = createHash("sha256").update(apiKey).digest("hex");

  try {
    const { data, error } = await supabaseAdmin
      .from("api_keys")
      .select(
        "id, workspace_id, key_prefix, name, permissions, rate_limit_per_minute, is_active, expires_at, last_used_at"
      )
      .eq("key_hash", keyHash)
      .eq("is_active", true)
      .maybeSingle();

    if (
      error ||
      !data ||
      typeof data.workspace_id !== "string" ||
      !data.workspace_id ||
      !data.permissions ||
      typeof data.permissions !== "object" ||
      Array.isArray(data.permissions) ||
      !Number.isSafeInteger(data.rate_limit_per_minute) ||
      data.rate_limit_per_minute < 1
    ) {
      return null;
    }

    if (data.expires_at) {
      const expiresAt = new Date(data.expires_at);
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) {
        return null;
      }
    }
    supabaseAdmin
      .from("api_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", data.id)
      .then(() => {});

    return data as ApiKeyData;
  } catch (error) {
    console.error("API key validation error:", error);
    return null;
  }
}

export function hasPermission(
  apiKey: ApiKeyData,
  permission: keyof ApiKeyData["permissions"]
): boolean {
  return apiKey.permissions[permission] === true;
}

export function extractApiKey(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }

  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  return authHeader;
}

const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

type ApiRateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  unavailable?: boolean;
};

type ApiRequestAuthOptions = {
  /** Message writes must not silently lose shared throttling in production. */
  requireDistributedRateLimit?: boolean;
};

let redis: Redis | null | undefined = undefined;

function getRedis(): Redis | null {
  if (redis !== undefined) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    redis = null;
    return redis;
  }
  try {
    redis = new Redis({ url, token });
  } catch {
    redis = null;
  }
  return redis;
}

async function checkRateLimitDistributed(
  apiKeyId: string,
  limitPerMinute: number,
  options: ApiRequestAuthOptions = {}
): Promise<ApiRateLimitResult> {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const bucket = Math.floor(now / windowMs);
  const key = `ratelimit:api_key:${apiKeyId}:${bucket}`;
  const resetAt = (bucket + 1) * windowMs;
  const requireSharedLimit =
    options.requireDistributedRateLimit &&
    process.env.NODE_ENV === "production";
  const unavailable = (): ApiRateLimitResult => ({
    allowed: false,
    remaining: 0,
    resetAt,
    unavailable: true,
  });

  const client = getRedis();
  if (!client) {
    if (requireSharedLimit) return unavailable();
    return checkRateLimitLocal(apiKeyId, limitPerMinute);
  }

  try {
    const count = await client.incr(key);
    if (count === 1) {
      await client.expire(key, 120);
    }

    const remaining = Math.max(0, limitPerMinute - count);
    return {
      allowed: count <= limitPerMinute,
      remaining,
      resetAt,
    };
  } catch {
    if (requireSharedLimit) return unavailable();
    return checkRateLimitLocal(apiKeyId, limitPerMinute);
  }
}

function checkRateLimitLocal(
  apiKeyId: string,
  limitPerMinute: number
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const minuteWindow = 60 * 1000;

  const entry = rateLimitStore.get(apiKeyId);

  if (!entry || now > entry.resetAt) {
    const resetAt = now + minuteWindow;
    rateLimitStore.set(apiKeyId, { count: 1, resetAt });
    return { allowed: true, remaining: limitPerMinute - 1, resetAt };
  }

  if (entry.count >= limitPerMinute) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count++;
  rateLimitStore.set(apiKeyId, entry);

  return {
    allowed: true,
    remaining: limitPerMinute - entry.count,
    resetAt: entry.resetAt,
  };
}

export async function checkRateLimit(
  apiKeyId: string,
  limitPerMinute: number,
  options: ApiRequestAuthOptions = {}
): Promise<ApiRateLimitResult> {
  return checkRateLimitDistributed(apiKeyId, limitPerMinute, options);
}

export async function authenticateRequest(
  request: Request,
  options: ApiRequestAuthOptions = {}
): Promise<
  { apiKey: ApiKeyData; error: null } | { apiKey: null; error: Response }
> {
  const authHeader = request.headers.get("Authorization");
  // An explicitly supplied Authorization header always owns authentication;
  // an invalid bearer must not silently authenticate with another credential.
  const apiKeyString =
    authHeader !== null
      ? extractApiKey(authHeader)
      : request.headers.get("X-API-Key");

  if (!apiKeyString) {
    return {
      apiKey: null,
      error: new Response(
        JSON.stringify({ error: "Missing API key. Use Authorization header." }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }
      ),
    };
  }

  const apiKey = await validateApiKey(apiKeyString);

  if (!apiKey) {
    return {
      apiKey: null,
      error: new Response(
        JSON.stringify({ error: "Invalid or expired API key" }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }
      ),
    };
  }

  const rateLimit = await checkRateLimit(
    apiKey.id,
    apiKey.rate_limit_per_minute,
    options
  );

  if (rateLimit.unavailable) {
    return {
      apiKey: null,
      error: Response.json(
        {
          code: "API_RATE_LIMIT_UNAVAILABLE",
          error:
            "API rate limiting is temporarily unavailable. Retry the same request and idempotency key later.",
        },
        { status: 503, headers: { "Retry-After": "5" } }
      ),
    };
  }

  if (!rateLimit.allowed) {
    const retryAfter = Math.ceil((rateLimit.resetAt - Date.now()) / 1000);
    return {
      apiKey: null,
      error: new Response(
        JSON.stringify({
          error: "Rate limit exceeded",
          retry_after: retryAfter,
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Limit": apiKey.rate_limit_per_minute.toString(),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": Math.floor(
              rateLimit.resetAt / 1000
            ).toString(),
            "Retry-After": retryAfter.toString(),
          },
        }
      ),
    };
  }

  return { apiKey, error: null };
}
