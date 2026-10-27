import {
  assertWhatsAppOtpRequestAllowed,
  getOtpRateLimitBackend,
  installOtpRateLimitValkeyForTests,
  OTP_RATE_LIMIT_UNAVAILABLE_ERROR,
  resetOtpRateLimitForTests,
  shouldSkipUpstashOtpRateLimitFallback,
} from "./otp-rate-limit";

describe("assertWhatsAppOtpRequestAllowed", () => {
  const previousCooldown = process.env.OTP_RATE_LIMIT_COOLDOWN_SECONDS;
  const previousPhoneLimit = process.env.OTP_RATE_LIMIT_PHONE_PER_HOUR;
  const previousWorkspaceLimit =
    process.env.OTP_RATE_LIMIT_WORKSPACE_PER_MINUTE;
  const previousRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const previousValkeyHost = process.env.MEMORYSTORE_VALKEY_HOST;
  const previousRuntimeMode = process.env.AIRI_RUNTIME_MODE;
  const previousVercelEnv = process.env.VERCEL_ENV;

  beforeEach(() => {
    resetOtpRateLimitForTests();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.MEMORYSTORE_VALKEY_HOST;
    delete process.env.AIRI_RUNTIME_MODE;
    delete process.env.VERCEL_ENV;
    process.env.OTP_RATE_LIMIT_COOLDOWN_SECONDS = "30";
    process.env.OTP_RATE_LIMIT_PHONE_PER_HOUR = "5";
    process.env.OTP_RATE_LIMIT_WORKSPACE_PER_MINUTE = "1000";
  });

  afterAll(() => {
    process.env.OTP_RATE_LIMIT_COOLDOWN_SECONDS = previousCooldown;
    process.env.OTP_RATE_LIMIT_PHONE_PER_HOUR = previousPhoneLimit;
    process.env.OTP_RATE_LIMIT_WORKSPACE_PER_MINUTE = previousWorkspaceLimit;
    process.env.UPSTASH_REDIS_REST_URL = previousRedisUrl;
    process.env.UPSTASH_REDIS_REST_TOKEN = previousRedisToken;
    process.env.MEMORYSTORE_VALKEY_HOST = previousValkeyHost;
    process.env.AIRI_RUNTIME_MODE = previousRuntimeMode;
    process.env.VERCEL_ENV = previousVercelEnv;
  });

  it("selects the Valkey backend when a Memorystore host is configured", () => {
    process.env.MEMORYSTORE_VALKEY_HOST = "10.0.0.5";
    resetOtpRateLimitForTests();

    expect(getOtpRateLimitBackend()).toBe("valkey");
  });

  it("ignores Upstash when Valkey host is configured", () => {
    process.env.MEMORYSTORE_VALKEY_HOST = "10.0.0.5";
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";
    resetOtpRateLimitForTests();

    expect(shouldSkipUpstashOtpRateLimitFallback()).toBe(true);
    expect(getOtpRateLimitBackend()).toBe("valkey");
  });

  it("skips Upstash fallback for otp-api runtime even without Valkey", () => {
    process.env.AIRI_RUNTIME_MODE = "otp-api";
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";
    resetOtpRateLimitForTests();

    expect(shouldSkipUpstashOtpRateLimitFallback()).toBe(true);
    expect(getOtpRateLimitBackend()).toBe("memory");
  });

  it("fails closed in production when the Valkey limiter errors", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.OTP_RATE_LIMIT_COOLDOWN_SECONDS = "0";
    installOtpRateLimitValkeyForTests({
      setNxEx: async () => {
        throw new Error("ECONNREFUSED");
      },
      incr: async () => {
        throw new Error("ECONNREFUSED");
      },
      expire: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    await expect(
      assertWhatsAppOtpRequestAllowed({
        workspaceId: "workspace-1",
        recipientPhone: "77001234567",
        purpose: "login",
      })
    ).rejects.toThrow(OTP_RATE_LIMIT_UNAVAILABLE_ERROR);
  });

  it("blocks repeated OTP requests to the same phone during the cooldown", async () => {
    await assertWhatsAppOtpRequestAllowed({
      workspaceId: "workspace-1",
      recipientPhone: "77001234567",
      purpose: "login",
    });

    await expect(
      assertWhatsAppOtpRequestAllowed({
        workspaceId: "workspace-1",
        recipientPhone: "77001234567",
        purpose: "login",
      })
    ).rejects.toThrow("Please wait before requesting another OTP");
  });

  it("limits repeated OTP requests to the same phone within the hourly window", async () => {
    process.env.OTP_RATE_LIMIT_COOLDOWN_SECONDS = "0";
    process.env.OTP_RATE_LIMIT_PHONE_PER_HOUR = "2";

    await assertWhatsAppOtpRequestAllowed({
      workspaceId: "workspace-1",
      recipientPhone: "77001234567",
      purpose: "login",
    });
    await assertWhatsAppOtpRequestAllowed({
      workspaceId: "workspace-1",
      recipientPhone: "77001234567",
      purpose: "login",
    });

    await expect(
      assertWhatsAppOtpRequestAllowed({
        workspaceId: "workspace-1",
        recipientPhone: "77001234567",
        purpose: "login",
      })
    ).rejects.toThrow("Too many OTP requests for this phone number");
  });

  it("limits workspace-wide OTP request bursts", async () => {
    process.env.OTP_RATE_LIMIT_COOLDOWN_SECONDS = "0";
    process.env.OTP_RATE_LIMIT_WORKSPACE_PER_MINUTE = "1";

    await assertWhatsAppOtpRequestAllowed({
      workspaceId: "workspace-1",
      recipientPhone: "77001234567",
      purpose: "login",
    });

    await expect(
      assertWhatsAppOtpRequestAllowed({
        workspaceId: "workspace-1",
        recipientPhone: "77007654321",
        purpose: "login",
      })
    ).rejects.toThrow("Too many OTP requests for this workspace");
  });

  it("does not reserve cooldown for requests rejected by workspace counters", async () => {
    process.env.OTP_RATE_LIMIT_WORKSPACE_PER_MINUTE = "1";

    await assertWhatsAppOtpRequestAllowed({
      workspaceId: "workspace-1",
      recipientPhone: "77001234567",
      purpose: "login",
    });

    await expect(
      assertWhatsAppOtpRequestAllowed({
        workspaceId: "workspace-1",
        recipientPhone: "77007654321",
        purpose: "login",
      })
    ).rejects.toThrow("Too many OTP requests for this workspace");

    process.env.OTP_RATE_LIMIT_WORKSPACE_PER_MINUTE = "10";

    await expect(
      assertWhatsAppOtpRequestAllowed({
        workspaceId: "workspace-1",
        recipientPhone: "77007654321",
        purpose: "login",
      })
    ).resolves.toBeUndefined();
  });
});
