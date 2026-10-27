const mockIncr = jest.fn();
const mockExpire = jest.fn();
const mockMaybeSingle = jest.fn();
const mockEq = jest.fn();

jest.mock("@upstash/redis", () => ({
  Redis: jest.fn().mockImplementation(() => ({
    incr: (...args: unknown[]) => mockIncr(...args),
    expire: (...args: unknown[]) => mockExpire(...args),
  })),
}));

jest.mock("./supabase/admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: (...args: unknown[]) => {
          mockEq(...args);
          return {
            eq: (...nextArgs: unknown[]) => {
              mockEq(...nextArgs);
              return { maybeSingle: () => mockMaybeSingle() };
            },
          };
        },
      }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  },
}));

const storedKey = {
  id: "api-key-1",
  workspace_id: "workspace-1",
  key_prefix: "sk_live_",
  name: "Customer backend",
  permissions: { read: true, write: true },
  rate_limit_per_minute: 60,
  is_active: true,
  expires_at: null,
};

describe("customer API key authentication", () => {
  const originalEnvironment = process.env.NODE_ENV;
  const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    Object.assign(process.env, { NODE_ENV: "production" });
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    mockMaybeSingle.mockResolvedValue({ data: { ...storedKey }, error: null });
    mockIncr.mockResolvedValue(1);
    mockExpire.mockResolvedValue(1);
  });

  afterAll(() => {
    Object.assign(process.env, { NODE_ENV: originalEnvironment });
    if (originalRedisUrl === undefined)
      delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
    if (originalRedisToken === undefined)
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
  });

  function request() {
    return new Request("https://airi.chat/api/v1/messages/send", {
      headers: { Authorization: "Bearer sk_live_customer_secret" },
    });
  }

  it("refuses production message writes when distributed limits are not configured", async () => {
    const { authenticateRequest } = await import("./api-auth");
    const result = await authenticateRequest(request(), {
      requireDistributedRateLimit: true,
    });

    expect(result.apiKey).toBeNull();
    expect(result.error?.status).toBe(503);
    expect(await result.error?.json()).toMatchObject({
      code: "API_RATE_LIMIT_UNAVAILABLE",
    });
  });

  it("does not fall back to process-local limits after a distributed write-limit failure", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.example.com";
    process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
    mockIncr.mockRejectedValue(new Error("Redis unavailable"));
    const { authenticateRequest } = await import("./api-auth");
    const result = await authenticateRequest(request(), {
      requireDistributedRateLimit: true,
    });

    expect(result.apiKey).toBeNull();
    expect(result.error?.status).toBe(503);
  });

  it("accepts a hashed workspace-bound key under its distributed limit", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.example.com";
    process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
    const { authenticateRequest } = await import("./api-auth");
    const result = await authenticateRequest(request(), {
      requireDistributedRateLimit: true,
    });

    expect(result.error).toBeNull();
    expect(result.apiKey?.workspace_id).toBe("workspace-1");
    expect(mockEq).toHaveBeenCalledWith(
      "key_hash",
      "9014745507fafb66f60f0b62e859fe48b17cbe8bb3d3070f70d6c7cfc6432d42"
    );
    expect(JSON.stringify(mockEq.mock.calls)).not.toContain(
      "sk_live_customer_secret"
    );
  });

  it("returns the existing 429 contract when the shared counter exceeds the key limit", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.example.com";
    process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
    mockIncr.mockResolvedValue(61);
    const { authenticateRequest } = await import("./api-auth");
    const result = await authenticateRequest(request(), {
      requireDistributedRateLimit: true,
    });

    expect(result.error?.status).toBe(429);
    expect(result.error?.headers.get("Retry-After")).toBeTruthy();
    expect(result.error?.headers.get("X-RateLimit-Limit")).toBe("60");
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "rejects a malformed stored rate limit %s",
    async rateLimit => {
      mockMaybeSingle.mockResolvedValue({
        data: { ...storedKey, rate_limit_per_minute: rateLimit },
        error: null,
      });
      const { authenticateRequest } = await import("./api-auth");
      const result = await authenticateRequest(request());

      expect(result.apiKey).toBeNull();
      expect(result.error?.status).toBe(401);
    }
  );

  it("rejects an expired key before attempting a send", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { ...storedKey, expires_at: "2020-01-01T00:00:00.000Z" },
      error: null,
    });
    const { authenticateRequest } = await import("./api-auth");
    expect((await authenticateRequest(request())).error?.status).toBe(401);
    expect(mockIncr).not.toHaveBeenCalled();
  });

  it("keeps local development usable without a shared limit backend", async () => {
    Object.assign(process.env, { NODE_ENV: "development" });
    const { authenticateRequest } = await import("./api-auth");
    const result = await authenticateRequest(request(), {
      requireDistributedRateLimit: true,
    });
    expect(result.error).toBeNull();
  });

  it("accepts X-API-Key when Authorization is absent", async () => {
    const { authenticateRequest } = await import("./api-auth");
    const result = await authenticateRequest(
      new Request("https://airi.chat/api/v1/conversations", {
        headers: { "X-API-Key": "sk_live_customer_secret" },
      })
    );

    expect(result.error).toBeNull();
    expect(result.apiKey?.workspace_id).toBe("workspace-1");
    expect(mockEq).toHaveBeenCalledWith(
      "key_hash",
      "9014745507fafb66f60f0b62e859fe48b17cbe8bb3d3070f70d6c7cfc6432d42"
    );
  });

  it.each(["", "not-a-key", "Bearer sk_live_customer_secret"])(
    "rejects malformed X-API-Key values (%s)",
    async apiKeyHeader => {
      const { authenticateRequest } = await import("./api-auth");
      const result = await authenticateRequest(
        new Request("https://airi.chat/api/v1/conversations", {
          headers: { "X-API-Key": apiKeyHeader },
        })
      );

      expect(result.error?.status).toBe(401);
      expect(mockMaybeSingle).not.toHaveBeenCalled();
    }
  );

  it.each(["", "Basic unrelated", "Bearer invalid"])(
    "does not fall back to X-API-Key when Authorization is present (%s)",
    async authorization => {
      const { authenticateRequest } = await import("./api-auth");
      const result = await authenticateRequest(
        new Request("https://airi.chat/api/v1/conversations", {
          headers: {
            Authorization: authorization,
            "X-API-Key": "sk_live_customer_secret",
          },
        })
      );

      expect(result.error?.status).toBe(401);
      expect(mockMaybeSingle).not.toHaveBeenCalled();
    }
  );

  it("does not retry an unrecognized Authorization key through X-API-Key", async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const { authenticateRequest } = await import("./api-auth");
    const result = await authenticateRequest(
      new Request("https://airi.chat/api/v1/conversations", {
        headers: {
          Authorization: "Bearer sk_unrecognized",
          "X-API-Key": "sk_live_customer_secret",
        },
      })
    );

    expect(result.error?.status).toBe(401);
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it.each(["Bearer sk_live_customer_secret", "sk_live_customer_secret"])(
    "preserves Authorization precedence and its existing key formats (%s)",
    async authorization => {
      const { authenticateRequest } = await import("./api-auth");
      const result = await authenticateRequest(
        new Request("https://airi.chat/api/v1/conversations", {
          headers: {
            Authorization: authorization,
            "X-API-Key": "sk_other_key",
          },
        })
      );

      expect(result.error).toBeNull();
      expect(mockEq).toHaveBeenCalledWith(
        "key_hash",
        "9014745507fafb66f60f0b62e859fe48b17cbe8bb3d3070f70d6c7cfc6432d42"
      );
      expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
    }
  );
});
