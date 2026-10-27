import {
  buildWhatsAppMetaAuthorizationCredentialPatch,
  buildWhatsAppMetaRateLimitCredentialPatch,
  acquireWhatsAppMetaReadLock,
  acquireWhatsAppMetaReadPermit,
  buildWhatsAppMetaReadCooldownCacheKey,
  buildWhatsAppMetaReadFailureCredentialPatch,
  buildWhatsAppMetaReadLockKey,
  buildWhatsAppMetaReadSuccessCredentialPatch,
  getCachedWhatsAppMetaReadCooldownUntil,
  getWhatsAppMetaReadDecision,
  hasConfirmedWhatsAppMetaAuthorizationReconnect,
  setCachedWhatsAppMetaReadCooldownUntil,
  releaseWhatsAppMetaReadPermit,
} from "./meta-read-policy";
import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";

const META_DIAGNOSTICS_LAST_ATTEMPT_AT_FIELD =
  "meta_diagnostics_last_attempt_at";
const META_DIAGNOSTICS_LAST_SUCCESS_AT_FIELD =
  "meta_diagnostics_last_success_at";
const META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD = "meta_diagnostics_cooldown_until";
const META_DIAGNOSTICS_CONSECUTIVE_RATE_LIMITS_FIELD =
  "meta_diagnostics_consecutive_rate_limits";
const META_DIAGNOSTICS_LAST_ERROR_CODE_FIELD =
  "meta_diagnostics_last_error_code";
const META_DIAGNOSTICS_RECONNECT_REASON_FIELD =
  "meta_diagnostics_reconnect_reason";
const META_DIAGNOSTICS_META_AUTHORIZATION_RECONNECT_REASON =
  "meta_authorization";

type TestMetaReadLockClient = NonNullable<
  NonNullable<
    Parameters<typeof acquireWhatsAppMetaReadPermit>[1]
  >["cacheClient"]
>;

const NOW = new Date("2026-08-03T12:00:00.000Z");

function metaRateLimit(code = 80008) {
  return new MetaGraphRequestError({
    message: `OAuthException (${code}): Too many calls`,
    status: 400,
    statusText: "Bad Request",
    url: "https://graph.facebook.com/v25.0/phone-1",
    details: {
      error: { message: "Too many calls", type: "OAuthException", code },
    },
    metaError: { message: "Too many calls", type: "OAuthException", code },
  });
}

describe("WhatsApp Meta read policy", () => {
  it("serves a recent persisted success without refreshing Meta", () => {
    expect(
      getWhatsAppMetaReadDecision(
        {
          [META_DIAGNOSTICS_LAST_SUCCESS_AT_FIELD]: "2026-08-03T11:58:00.000Z",
        },
        { now: NOW, explicitRefresh: false }
      )
    ).toEqual({
      shouldRefresh: false,
      reason: "fresh",
      cooldownUntil: null,
    });
  });

  it("allows stale ordinary reads and bounded explicit reads to refresh", () => {
    const staleCredentials = {
      [META_DIAGNOSTICS_LAST_SUCCESS_AT_FIELD]: "2026-08-03T11:40:00.000Z",
      [META_DIAGNOSTICS_LAST_ATTEMPT_AT_FIELD]: "2026-08-03T11:40:00.000Z",
    };

    expect(
      getWhatsAppMetaReadDecision(staleCredentials, {
        now: NOW,
        explicitRefresh: false,
      })
    ).toMatchObject({ shouldRefresh: true, reason: "stale" });
    expect(
      getWhatsAppMetaReadDecision(staleCredentials, {
        now: NOW,
        explicitRefresh: true,
      })
    ).toMatchObject({ shouldRefresh: true, reason: "explicit" });
    expect(
      getWhatsAppMetaReadDecision(
        {
          ...staleCredentials,
          [META_DIAGNOSTICS_LAST_ATTEMPT_AT_FIELD]: "2026-08-03T11:59:50.000Z",
        },
        { now: NOW, explicitRefresh: true }
      )
    ).toEqual({
      shouldRefresh: false,
      reason: "minimum_interval",
      cooldownUntil: null,
    });
    expect(
      getWhatsAppMetaReadDecision(
        {
          ...staleCredentials,
          [META_DIAGNOSTICS_LAST_ATTEMPT_AT_FIELD]: "2026-08-03T11:59:50.000Z",
        },
        { now: NOW, explicitRefresh: false }
      )
    ).toEqual({
      shouldRefresh: false,
      reason: "minimum_interval",
      cooldownUntil: null,
    });
    expect(
      getWhatsAppMetaReadDecision(
        {
          ...staleCredentials,
          [META_DIAGNOSTICS_LAST_ATTEMPT_AT_FIELD]: "2026-08-03T11:55:00.000Z",
        },
        { now: NOW, explicitRefresh: false }
      )
    ).toMatchObject({ shouldRefresh: false, reason: "minimum_interval" });
    expect(
      getWhatsAppMetaReadDecision(
        {
          ...staleCredentials,
          [META_DIAGNOSTICS_LAST_ATTEMPT_AT_FIELD]: "2026-08-03T11:55:00.000Z",
        },
        { now: NOW, explicitRefresh: true }
      )
    ).toMatchObject({ shouldRefresh: true, reason: "explicit" });
  });

  it("records a failed attempt without claiming a successful Meta refresh", () => {
    const patch = buildWhatsAppMetaReadFailureCredentialPatch(NOW);
    expect(patch).toEqual({
      [META_DIAGNOSTICS_LAST_ATTEMPT_AT_FIELD]: NOW.toISOString(),
    });
    const merged = {
      [META_DIAGNOSTICS_LAST_SUCCESS_AT_FIELD]: "2026-08-03T11:00:00.000Z",
      [META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD]: "2026-08-03T11:55:00.000Z",
      [META_DIAGNOSTICS_CONSECUTIVE_RATE_LIMITS_FIELD]: 3,
      [META_DIAGNOSTICS_LAST_ERROR_CODE_FIELD]: "80008",
      ...patch,
    };
    expect(merged[META_DIAGNOSTICS_LAST_SUCCESS_AT_FIELD]).toBe(
      "2026-08-03T11:00:00.000Z"
    );
    expect(merged[META_DIAGNOSTICS_CONSECUTIVE_RATE_LIMITS_FIELD]).toBe(3);
    expect(merged[META_DIAGNOSTICS_LAST_ERROR_CODE_FIELD]).toBe("80008");
  });

  it("shares provider locks by WABA and falls back to source identity", () => {
    expect(
      buildWhatsAppMetaReadLockKey({ wabaId: "waba-1", sourceId: "source-1" })
    ).toBe(
      buildWhatsAppMetaReadLockKey({ wabaId: "waba-1", sourceId: "source-2" })
    );
    expect(buildWhatsAppMetaReadLockKey({ sourceId: "source-1" })).not.toBe(
      buildWhatsAppMetaReadLockKey({ sourceId: "source-2" })
    );
  });

  it("centralizes permit decisions, lock rechecks, and token-safe release", async () => {
    const lockClient = {
      get: jest.fn(async <T>(_key: string): Promise<T | null> => null),
      acquireLock: jest.fn(async () => "acquired" as const),
      compareAndDelete: jest.fn(async () => true),
    } as unknown as TestMetaReadLockClient;

    const permit = await acquireWhatsAppMetaReadPermit(
      {
        sourceId: "source-1",
        wabaId: "waba-1",
        credentials: {
          [META_DIAGNOSTICS_LAST_SUCCESS_AT_FIELD]: "2026-08-03T11:00:00.000Z",
        },
        now: NOW,
      },
      { cacheClient: lockClient }
    );

    expect(permit.outcome).toBe("acquired");
    expect(lockClient.acquireLock).toHaveBeenCalledTimes(1);
    expect(lockClient.get).toHaveBeenCalledTimes(2);

    await expect(
      releaseWhatsAppMetaReadPermit(permit, lockClient)
    ).resolves.toBe(true);
    expect(lockClient.compareAndDelete).toHaveBeenCalledWith(
      expect.stringContaining("whatsapp:meta-read-lock:v1"),
      expect.any(String)
    );
  });

  it("does not acquire a lock for fresh state and distinguishes coordination failures", async () => {
    const freshClient = {
      get: jest.fn(async <T>(_key: string): Promise<T | null> => null),
      acquireLock: jest.fn(async () => "acquired" as const),
      compareAndDelete: jest.fn(async () => true),
    } as unknown as TestMetaReadLockClient;
    const freshPermit = await acquireWhatsAppMetaReadPermit(
      {
        sourceId: "source-1",
        credentials: {
          [META_DIAGNOSTICS_LAST_SUCCESS_AT_FIELD]: "2026-08-03T11:59:00.000Z",
        },
        now: NOW,
      },
      { cacheClient: freshClient }
    );
    expect(freshPermit).toEqual({
      outcome: "fresh",
      cooldownUntil: null,
    });
    expect(freshClient.acquireLock).not.toHaveBeenCalled();

    const unavailableClient = {
      get: jest.fn(async <T>(_key: string): Promise<T | null> => null),
      acquireLock: jest.fn(async () => "unavailable" as const),
      compareAndDelete: jest.fn(async () => false),
    } as unknown as TestMetaReadLockClient;
    await expect(
      acquireWhatsAppMetaReadLock(
        { sourceId: "source-1", wabaId: "waba-1", now: NOW },
        { cacheClient: unavailableClient }
      )
    ).resolves.toEqual({
      outcome: "coordination_unavailable",
      cooldownUntil: null,
    });
  });

  it("releases a permit when another owner opens a cooldown before the recheck", async () => {
    const cooldownUntil = "2026-08-03T12:05:00.000Z";
    const lockClient = {
      get: jest.fn(
        async <T>(_key: string): Promise<T | null> => cooldownUntil as T
      ),
      acquireLock: jest.fn(async () => "acquired" as const),
      compareAndDelete: jest.fn(async () => true),
    } as unknown as TestMetaReadLockClient;

    await expect(
      acquireWhatsAppMetaReadLock(
        { sourceId: "source-1", wabaId: "waba-1", now: NOW },
        { cacheClient: lockClient }
      )
    ).resolves.toEqual({
      outcome: "cooldown",
      cooldownUntil,
    });
    expect(lockClient.compareAndDelete).toHaveBeenCalledTimes(1);
  });

  it("shares a fail-soft WABA cooldown with validated expiry-derived TTL", async () => {
    const values = new Map<string, unknown>();
    const set = jest.fn(
      async (key: string, value: unknown, _ttlSeconds: number) => {
        values.set(key, value);
      }
    );
    const cacheClient = {
      get: async <T>(key: string) => (values.get(key) as T | undefined) ?? null,
      set,
    };
    const cooldownUntil = "2026-08-03T12:05:00.000Z";

    await expect(
      setCachedWhatsAppMetaReadCooldownUntil("waba-1", cooldownUntil, {
        now: NOW,
        cacheClient,
      })
    ).resolves.toBeUndefined();
    expect(set).toHaveBeenCalledWith(
      buildWhatsAppMetaReadCooldownCacheKey("waba-1"),
      cooldownUntil,
      300
    );
    await expect(
      getCachedWhatsAppMetaReadCooldownUntil("waba-1", {
        now: NOW,
        cacheClient,
      })
    ).resolves.toBe(cooldownUntil);
    await expect(
      setCachedWhatsAppMetaReadCooldownUntil("waba-1", "not-a-date", {
        now: NOW,
        cacheClient,
      })
    ).resolves.toBeUndefined();
    await expect(
      getCachedWhatsAppMetaReadCooldownUntil("waba-1", {
        now: new Date("2026-08-03T12:06:00.000Z"),
        cacheClient,
      })
    ).resolves.toBeNull();

    const unavailableCache = {
      get: async <T>(_key: string): Promise<T | null> => {
        throw new Error("cache unavailable");
      },
      set: async () => {
        throw new Error("cache unavailable");
      },
    };
    await expect(
      setCachedWhatsAppMetaReadCooldownUntil("waba-1", cooldownUntil, {
        now: NOW,
        cacheClient: unavailableCache,
      })
    ).resolves.toBeUndefined();
    await expect(
      getCachedWhatsAppMetaReadCooldownUntil("waba-1", {
        now: NOW,
        cacheClient: unavailableCache,
      })
    ).resolves.toBeNull();
  });

  it("persists an exponential rate-limit cooldown and exposes it as active", () => {
    const firstPatch = buildWhatsAppMetaRateLimitCredentialPatch(
      {},
      { now: NOW, error: metaRateLimit() }
    );

    expect(firstPatch).toEqual({
      [META_DIAGNOSTICS_LAST_ATTEMPT_AT_FIELD]: NOW.toISOString(),
      [META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD]: "2026-08-03T12:05:00.000Z",
      [META_DIAGNOSTICS_CONSECUTIVE_RATE_LIMITS_FIELD]: 1,
      [META_DIAGNOSTICS_LAST_ERROR_CODE_FIELD]: "80008",
    });
    expect(getWhatsAppMetaReadDecision(firstPatch, { now: NOW })).toMatchObject(
      {
        shouldRefresh: false,
        reason: "cooldown",
        cooldownUntil: "2026-08-03T12:05:00.000Z",
      }
    );
    expect(
      getWhatsAppMetaReadDecision(firstPatch, {
        now: NOW,
        explicitRefresh: true,
      })
    ).toEqual({
      shouldRefresh: false,
      reason: "cooldown",
      cooldownUntil: "2026-08-03T12:05:00.000Z",
    });

    const secondPatch = buildWhatsAppMetaRateLimitCredentialPatch(firstPatch, {
      now: NOW,
      error: metaRateLimit(),
    });
    expect(secondPatch[META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD]).toBe(
      "2026-08-03T12:10:00.000Z"
    );
    expect(secondPatch[META_DIAGNOSTICS_CONSECUTIVE_RATE_LIMITS_FIELD]).toBe(2);

    expect(
      buildWhatsAppMetaRateLimitCredentialPatch(secondPatch, {
        now: NOW,
        error: {
          success: false,
          metaError: { message: "Too many calls", code: 80008 },
        },
      })[META_DIAGNOSTICS_LAST_ERROR_CODE_FIELD]
    ).toBe("80008");
    expect(
      buildWhatsAppMetaRateLimitCredentialPatch(secondPatch, {
        now: NOW,
        error: { success: false, status: 429 },
      })[META_DIAGNOSTICS_LAST_ERROR_CODE_FIELD]
    ).toBe("HTTP_429");
    for (const code of [4, 17, 32, 613]) {
      expect(
        buildWhatsAppMetaRateLimitCredentialPatch(secondPatch, {
          now: NOW,
          error: {
            success: false,
            metaError: { message: "Request limit reached", code },
          },
        })[META_DIAGNOSTICS_LAST_ERROR_CODE_FIELD]
      ).toBe(String(code));
    }
  });

  it("resets cooldown state only after a successful provider refresh", () => {
    expect(buildWhatsAppMetaReadSuccessCredentialPatch(NOW)).toEqual({
      diagnostics_last_checked_at: NOW.toISOString(),
      [META_DIAGNOSTICS_LAST_ATTEMPT_AT_FIELD]: NOW.toISOString(),
      [META_DIAGNOSTICS_LAST_SUCCESS_AT_FIELD]: NOW.toISOString(),
      [META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD]: null,
      [META_DIAGNOSTICS_CONSECUTIVE_RATE_LIMITS_FIELD]: 0,
      [META_DIAGNOSTICS_LAST_ERROR_CODE_FIELD]: null,
      [META_DIAGNOSTICS_RECONNECT_REASON_FIELD]: null,
    });
  });

  it("persists provenance only for provider-confirmed authorization failures", () => {
    const authorizationError = new MetaGraphRequestError({
      message: "Object is unavailable",
      status: 400,
      statusText: "Bad Request",
      url: "https://graph.facebook.com/v25.0/phone-1",
      details: null,
      metaError: {
        message: "Object is unavailable",
        type: "GraphMethodException",
        code: 100,
        error_subcode: 33,
      },
    });

    const patch = buildWhatsAppMetaAuthorizationCredentialPatch(
      authorizationError,
      NOW
    );

    expect(patch).toEqual({
      [META_DIAGNOSTICS_LAST_ATTEMPT_AT_FIELD]: NOW.toISOString(),
      [META_DIAGNOSTICS_LAST_ERROR_CODE_FIELD]: "100:33",
      [META_DIAGNOSTICS_RECONNECT_REASON_FIELD]:
        META_DIAGNOSTICS_META_AUTHORIZATION_RECONNECT_REASON,
    });
    expect(hasConfirmedWhatsAppMetaAuthorizationReconnect(patch)).toBe(true);
    expect(
      hasConfirmedWhatsAppMetaAuthorizationReconnect({
        webhook_requires_reconnect: true,
      })
    ).toBe(false);
  });
});
