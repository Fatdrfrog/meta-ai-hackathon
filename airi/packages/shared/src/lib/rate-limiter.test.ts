import assert from "node:assert/strict";
import test from "node:test";

test("the shared factory accepts a daily sliding window without contacting Redis", async () => {
  const { createRateLimiter } = await import("./rate-limiter");
  const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
  const savedToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  try {
    assert.ok(
      createRateLimiter({
        requests: 10,
        window: "1 d",
        prefix: "test:daily",
        analytics: false,
      }),
    );
  } finally {
    if (savedUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = savedUrl;
    if (savedToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = savedToken;
  }
});

test("critical limiter distinguishes granted, limited, and unavailable", async () => {
  const { checkCriticalRateLimit } = await import("./rate-limiter");
  const granted = {
    limit: async () => ({
      success: true,
      limit: 8,
      remaining: 7,
      reset: 1000,
      pending: Promise.resolve(),
    }),
  };
  const limited = {
    limit: async () => ({
      success: false,
      limit: 8,
      remaining: 0,
      reset: 2000,
      pending: Promise.resolve(),
    }),
  };
  const timedOut = {
    limit: async () => ({
      success: true,
      limit: 0,
      remaining: 0,
      reset: 0,
      pending: Promise.resolve(),
      reason: "timeout" as const,
    }),
  };
  const broken = {
    limit: async () => {
      throw new Error("redis down");
    },
  };

  assert.deepEqual(await checkCriticalRateLimit(granted, "app"), {
    status: "granted",
    limit: 8,
    remaining: 7,
    reset: 1000,
  });
  assert.deepEqual(await checkCriticalRateLimit(limited, "app"), {
    status: "limited",
    limit: 8,
    remaining: 0,
    reset: 2000,
  });
  assert.deepEqual(await checkCriticalRateLimit(timedOut, "app"), {
    status: "unavailable",
  });
  assert.deepEqual(await checkCriticalRateLimit(null, "app"), {
    status: "unavailable",
  });
  assert.deepEqual(await checkCriticalRateLimit(broken, "app"), {
    status: "unavailable",
  });
});
