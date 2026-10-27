const mockCreateClient = jest.fn();
const mockSupabaseFrom = jest.fn();
const mockGraphGetJson = jest.fn();
const mockGetPhoneNumberDetails = jest.fn();
const mockRegisterPhoneNumberWithPin = jest.fn();
const mockGetPhoneCallingSettings = jest.fn();
const mockGetWabaWebhookSubscriptionStatus = jest.fn();
const mockRunWhatsAppAutoDefaults = jest.fn();
const mockUploadWhatsAppVoicemailAnnouncementFile = jest.fn();
const mockRevalidatePath = jest.fn();
const mockUpdateCurrentWhatsAppSourceCredentials = jest.fn();
const mockUpdateCurrentWhatsAppSourceCredentialsFromSnapshot = jest.fn();
const mockCacheAcquireLock = jest.fn();
const mockCacheCompareAndDelete = jest.fn();
const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();

jest.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@icecore/shared/lib/cache", () => ({
  buildCacheKey: (namespace: string, parts: string[]) =>
    `icecore:${namespace}:${parts.join(":")}`,
  cache: {
    get: (...args: unknown[]) => mockCacheGet(...args),
    set: (...args: unknown[]) => mockCacheSet(...args),
    acquireLock: (...args: unknown[]) => mockCacheAcquireLock(...args),
    compareAndDelete: (...args: unknown[]) =>
      mockCacheCompareAndDelete(...args),
  },
}));

jest.mock("@/lib/whatsapp/flows/source-rebind-guard", () => ({
  createWhatsAppSourceCredentialSnapshotSaver: (params: {
    workspaceId: string;
    sourceId: string;
    currentCredentials: Record<string, unknown>;
  }) => {
    let currentCredentials = params.currentCredentials;
    return async (nextCredentials: Record<string, unknown>) => {
      const result =
        await mockUpdateCurrentWhatsAppSourceCredentialsFromSnapshot({
          ...params,
          currentCredentials,
          nextCredentials,
        });
      currentCredentials = nextCredentials;
      return result;
    };
  },
  updateCurrentWhatsAppSourceCredentials: (...args: unknown[]) =>
    mockUpdateCurrentWhatsAppSourceCredentials(...args),
  updateCurrentWhatsAppSourceCredentialsFromSnapshot: (...args: unknown[]) =>
    mockUpdateCurrentWhatsAppSourceCredentialsFromSnapshot(...args),
}));

jest.mock("@icecore/shared/lib/meta/api", () => ({
  ...jest.requireActual("@icecore/shared/lib/meta/api"),
  getWhatsAppGraphClient: () => ({
    getJson: (...args: unknown[]) => mockGraphGetJson(...args),
  }),
}));

jest.mock("@/lib/whatsapp/auto-defaults", () => {
  const actual = jest.requireActual("@/lib/whatsapp/auto-defaults");
  return {
    ...actual,
    runWhatsAppAutoDefaults: (...args: unknown[]) =>
      mockRunWhatsAppAutoDefaults(...args),
  };
});

jest.mock("@/lib/whatsapp/media-upload", () => ({
  uploadWhatsAppVoicemailAnnouncementFile: (...args: unknown[]) =>
    mockUploadWhatsAppVoicemailAnnouncementFile(...args),
}));

jest.mock("@/lib/whatsapp/qr-code-service", () => ({
  getPhoneNumberDetails: (...args: unknown[]) =>
    mockGetPhoneNumberDetails(...args),
  registerPhoneNumberWithPin: (...args: unknown[]) =>
    mockRegisterPhoneNumberWithPin(...args),
}));

jest.mock("@icecore/airi-runtime/whatsapp-calling-service", () => ({
  getPhoneCallingSettings: (...args: unknown[]) =>
    mockGetPhoneCallingSettings(...args),
}));

jest.mock("@/lib/whatsapp/waba-service", () => {
  const actual = jest.requireActual("@/lib/whatsapp/waba-service");
  return {
    ...actual,
    getWabaWebhookSubscriptionStatus: (...args: unknown[]) =>
      mockGetWabaWebhookSubscriptionStatus(...args),
  };
});

import { readBusinessUsernameState } from "@icecore/whatsapp/businessUsernameState";
import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";
import { WHATSAPP_CALL_WEBHOOK_PUBSUB_DEFAULT_TOPIC } from "@icecore/temporal";
import { GET, POST } from "./route";
import { supabaseAuth } from "@/test-support/supabase-auth-test-utils";

describe("readBusinessUsernameState", () => {
  it("returns only the sanitized business username fields for onboarding status", () => {
    expect(
      readBusinessUsernameState({
        username: "airi_support",
        requested_username: "airi_support",
        status: "approved",
        rejection_reason: "",
        last_webhook_at: "2026-06-12T10:00:00.000Z",
        phone_number_id: "phone-1",
        display_phone_number: "+15551234567",
        raw: { should_not_leak: true },
      })
    ).toEqual({
      username: "airi_support",
      requested_username: "airi_support",
      status: "approved",
      rejection_reason: undefined,
      last_webhook_at: "2026-06-12T10:00:00.000Z",
      phone_number_id: "phone-1",
      display_phone_number: "+15551234567",
    });
  });

  it("returns undefined when no business username state is present", () => {
    expect(
      readBusinessUsernameState({ raw: { ignored: true } })
    ).toBeUndefined();
    expect(readBusinessUsernameState(null)).toBeUndefined();
  });
});

describe("GET /api/whatsapp/onboarding", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    mockCacheAcquireLock.mockResolvedValue("acquired");
    mockCacheCompareAndDelete.mockResolvedValue(true);
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockResolvedValue(undefined);
    mockUpdateCurrentWhatsAppSourceCredentials.mockImplementation(
      async (params: {
        workspaceId: string;
        sourceId: string;
        buildCredentials: (
          credentials: Record<string, unknown>
        ) => Record<string, unknown>;
      }) => {
        const sourceQuery = mockSupabaseFrom("sources");
        const loaded = await sourceQuery
          .select("credentials")
          .eq("id", params.sourceId)
          .maybeSingle();
        const credentials = params.buildCredentials(
          (loaded.data?.credentials as Record<string, unknown>) || {}
        );
        await sourceQuery.update({ credentials }).eq("id", params.sourceId);
        return {
          id: params.sourceId,
          workspaceId: params.workspaceId,
          updatedAt: "2026-08-03T00:00:00.000Z",
          credentials,
        };
      }
    );
    mockGetPhoneCallingSettings.mockResolvedValue({
      success: false,
      error: { message: "Calling settings unavailable" },
    });
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  function setupAuthenticatedGet(credentials: Record<string, unknown>) {
    const sourceUpdate = jest.fn().mockReturnThis();
    const sourceBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { id: "source-1", credentials },
      }),
      update: sourceUpdate,
    };
    const membershipBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { workspace_id: "workspace-1" },
      }),
    };

    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === "company_users") return membershipBuilder;
      if (table === "sources") return sourceBuilder;
      throw new Error(`Unexpected table ${table}`);
    });
    mockCreateClient.mockResolvedValue({
      auth: supabaseAuth(),
      from: (...args: unknown[]) => mockSupabaseFrom(...args),
    });

    return { sourceUpdate };
  }

  it.each([
    {
      policy: "fresh persisted diagnostics",
      query: "workspaceId=workspace-1",
      policyCredentials: {
        meta_diagnostics_last_success_at: new Date().toISOString(),
      },
      expectedStatus: 200,
      expectedOutcome: "fresh",
      expectedError: undefined,
    },
    {
      policy: "an active persisted cooldown during an explicit refresh",
      query: "workspaceId=workspace-1&refresh=true",
      policyCredentials: {
        meta_diagnostics_cooldown_until: new Date(
          Date.now() + 60_000
        ).toISOString(),
      },
      expectedStatus: 429,
      expectedOutcome: "cooldown",
      expectedError: expect.any(String),
    },
  ])(
    "serves $policy without reading Meta or writing the source",
    async ({
      query,
      policyCredentials,
      expectedStatus,
      expectedOutcome,
      expectedError,
    }) => {
      setupAuthenticatedGet({
        access_token: "token-1",
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        verified_name: "Persisted name",
        phone_number_accessible: true,
        ...policyCredentials,
      });

      const response = await GET(
        new Request(`https://www.airi.chat/api/whatsapp/onboarding?${query}`)
      );
      const body = await response.json();

      expect(response.status).toBe(expectedStatus);
      expect(body).toMatchObject({
        meta_refresh: {
          requested: query.includes("refresh="),
          performed: false,
          outcome: expectedOutcome,
        },
        ...(expectedError ? { error: expectedError } : {}),
      });
      expect(body.status).toMatchObject({
        verified_name: "Persisted name",
        phone_number_accessible: true,
      });
      expect(mockGetPhoneNumberDetails).not.toHaveBeenCalled();
      expect(mockGraphGetJson).not.toHaveBeenCalled();
      expect(mockGetWabaWebhookSubscriptionStatus).not.toHaveBeenCalled();
      expect(mockGetPhoneCallingSettings).not.toHaveBeenCalled();
      expect(mockUpdateCurrentWhatsAppSourceCredentials).not.toHaveBeenCalled();
      expect(mockRevalidatePath).not.toHaveBeenCalled();
      expect(mockCacheAcquireLock).not.toHaveBeenCalled();
    }
  );

  it("suppresses an explicit refresh from a shared WABA cooldown", async () => {
    setupAuthenticatedGet({
      access_token: "token-1",
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      verified_name: "Persisted name",
    });
    const cooldownUntil = new Date(Date.now() + 5 * 60_000).toISOString();
    mockCacheGet.mockResolvedValueOnce(cooldownUntil);

    const response = await GET(
      new Request(
        "https://www.airi.chat/api/whatsapp/onboarding?workspaceId=workspace-1&refresh=1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body.meta_refresh).toEqual({
      requested: true,
      performed: false,
      outcome: "cooldown",
      cooldown_until: cooldownUntil,
    });
    expect(mockGetPhoneNumberDetails).not.toHaveBeenCalled();
    expect(mockCacheAcquireLock).not.toHaveBeenCalled();
  });

  it.each([
    {
      lockResult: "contended",
      expectedStatus: 429,
      expectedOutcome: "in_progress",
    },
    {
      lockResult: "unavailable",
      expectedStatus: 503,
      expectedOutcome: "failed",
    },
  ])(
    "reports a $lockResult provider lock truthfully without calling Meta",
    async ({ lockResult, expectedStatus, expectedOutcome }) => {
      setupAuthenticatedGet({
        access_token: "token-1",
        waba_id: "waba-1",
        phone_number_id: "phone-1",
      });
      mockCacheAcquireLock.mockResolvedValueOnce(lockResult);

      const response = await GET(
        new Request(
          "https://www.airi.chat/api/whatsapp/onboarding?workspaceId=workspace-1&refresh=1"
        )
      );
      const body = await response.json();

      expect(response.status).toBe(expectedStatus);
      expect(body.meta_refresh).toEqual({
        requested: true,
        performed: false,
        outcome: expectedOutcome,
      });
      expect(body.error).toEqual(expect.any(String));
      expect(mockGetPhoneNumberDetails).not.toHaveBeenCalled();
      expect(mockGraphGetJson).not.toHaveBeenCalled();
      expect(mockGetWabaWebhookSubscriptionStatus).not.toHaveBeenCalled();
      expect(mockCacheCompareAndDelete).not.toHaveBeenCalled();
    }
  );

  it("rechecks the shared WABA cooldown after acquiring the provider lock", async () => {
    setupAuthenticatedGet({
      access_token: "token-1",
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      verified_name: "Persisted name",
    });
    const cooldownUntil = new Date(Date.now() + 5 * 60_000).toISOString();
    mockCacheGet
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(cooldownUntil);

    const response = await GET(
      new Request(
        "https://www.airi.chat/api/whatsapp/onboarding?workspaceId=workspace-1&refresh=1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body.meta_refresh).toEqual({
      requested: true,
      performed: false,
      outcome: "cooldown",
      cooldown_until: cooldownUntil,
    });
    expect(mockCacheAcquireLock).toHaveBeenCalledTimes(1);
    expect(mockCacheCompareAndDelete).toHaveBeenCalledTimes(1);
    expect(mockGetPhoneNumberDetails).not.toHaveBeenCalled();
    expect(mockGraphGetJson).not.toHaveBeenCalled();
    expect(mockGetWabaWebhookSubscriptionStatus).not.toHaveBeenCalled();
  });

  it("persists a cooldown on Meta 80008, stops remaining reads, and retains last-known-good phone state", async () => {
    const persistedCredentials = {
      access_token: "token-1",
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      verified_name: "Persisted name",
      phone_number_accessible: true,
      meta_diagnostics_last_success_at: "2026-08-03T00:00:00.000Z",
      waba_health_last_checked_at: "2026-08-02T00:00:00.000Z",
    };
    const { sourceUpdate } = setupAuthenticatedGet(persistedCredentials);
    mockGetPhoneNumberDetails.mockRejectedValue(
      new MetaGraphRequestError({
        message: "Too many calls",
        status: 400,
        statusText: "Bad Request",
        url: "https://graph.facebook.com/v25.0/phone-1",
        details: {
          error: {
            message: "Too many calls",
            type: "OAuthException",
            code: 80008,
          },
        },
        metaError: {
          message: "Too many calls",
          type: "OAuthException",
          code: 80008,
        },
      })
    );

    const response = await GET(
      new Request(
        "https://www.airi.chat/api/whatsapp/onboarding?workspaceId=workspace-1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toMatchObject({
      verified_name: "Persisted name",
      phone_number_accessible: true,
    });
    expect(mockGraphGetJson).not.toHaveBeenCalled();
    expect(mockGetWabaWebhookSubscriptionStatus).not.toHaveBeenCalled();
    expect(mockGetPhoneCallingSettings).not.toHaveBeenCalled();
    expect(sourceUpdate).toHaveBeenCalledWith({
      credentials: expect.objectContaining({
        verified_name: "Persisted name",
        phone_number_accessible: true,
        meta_diagnostics_consecutive_rate_limits: 1,
        meta_diagnostics_last_error_code: "80008",
        meta_diagnostics_cooldown_until: expect.any(String),
        waba_health_last_checked_at: "2026-08-02T00:00:00.000Z",
      }),
    });
    expect(sourceUpdate).not.toHaveBeenCalledWith({
      credentials: expect.objectContaining({ phone_number_accessible: false }),
    });
    const refreshLockToken = mockCacheAcquireLock.mock.calls[0]?.[1];
    expect(refreshLockToken).toEqual(expect.any(String));
    expect(refreshLockToken).not.toBe("1");
    expect(mockCacheCompareAndDelete).toHaveBeenCalledWith(
      "icecore:whatsapp:meta-read-lock:v1:waba:waba-1",
      refreshLockToken
    );
    expect(mockCacheSet).toHaveBeenCalledWith(
      "icecore:whatsapp:meta-read-cooldown:v1:waba:waba-1",
      expect.any(String),
      expect.any(Number)
    );
  });

  it("reports a failed explicit refresh when a rate-limit cooldown cannot be persisted", async () => {
    setupAuthenticatedGet({
      access_token: "token-1",
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      verified_name: "Persisted name",
      phone_number_accessible: true,
    });
    mockGetPhoneNumberDetails.mockRejectedValue(
      new MetaGraphRequestError({
        message: "Too Many Requests",
        status: 429,
        statusText: "Too Many Requests",
        url: "https://graph.facebook.com/v25.0/phone-1",
        details: null,
      })
    );
    mockUpdateCurrentWhatsAppSourceCredentials.mockRejectedValueOnce(
      new Error("CAS failed")
    );

    const response = await GET(
      new Request(
        "https://www.airi.chat/api/whatsapp/onboarding?workspaceId=workspace-1&refresh=1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.meta_refresh).toEqual({
      requested: true,
      performed: true,
      outcome: "failed",
    });
    expect(body.error).toContain("could not be saved");
    expect(body.status).toMatchObject({
      verified_name: "Persisted name",
      phone_number_accessible: true,
    });
  });

  it("persists reconnect-required truth and returns a truthful explicit failure after a terminal Meta authorization error", async () => {
    const { sourceUpdate } = setupAuthenticatedGet({
      access_token: "token-1",
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      verified_name: "Persisted name",
      phone_number_accessible: true,
      meta_diagnostics_last_success_at: "2026-08-03T00:00:00.000Z",
    });
    mockGetPhoneNumberDetails.mockRejectedValue(
      new MetaGraphRequestError({
        message: "Missing permission",
        status: 403,
        statusText: "Forbidden",
        url: "https://graph.facebook.com/v25.0/phone-1",
        details: {
          error: {
            message: "Missing permission",
            type: "OAuthException",
            code: 200,
          },
        },
        metaError: {
          message: "Missing permission",
          type: "OAuthException",
          code: 200,
        },
      })
    );

    const response = await GET(
      new Request(
        "https://www.airi.chat/api/whatsapp/onboarding?workspaceId=workspace-1&refresh=1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.meta_refresh).toEqual({
      requested: true,
      performed: true,
      outcome: "failed",
    });
    expect(body.error).toContain("Reconnect WhatsApp");
    expect(body.status).toMatchObject({
      verified_name: "Persisted name",
      phone_number_accessible: true,
      webhook_requires_reconnect: true,
      webhook_error: expect.stringContaining("Missing permission"),
      waba_health_state: "warning",
      waba_health_reasons: expect.arrayContaining([
        expect.objectContaining({ code: "webhook_reconnect_required" }),
      ]),
    });
    expect(mockGraphGetJson).not.toHaveBeenCalled();
    expect(mockGetWabaWebhookSubscriptionStatus).not.toHaveBeenCalled();
    expect(mockGetPhoneCallingSettings).not.toHaveBeenCalled();
    expect(sourceUpdate).toHaveBeenCalledWith({
      credentials: expect.objectContaining({
        verified_name: "Persisted name",
        phone_number_accessible: true,
        meta_diagnostics_last_attempt_at: expect.any(String),
        meta_diagnostics_last_success_at: "2026-08-03T00:00:00.000Z",
        webhook_requires_reconnect: true,
        webhook_error: expect.stringContaining("Missing permission"),
      }),
    });
  });

  it("does not mark calls subscribed from another app's fallback fields", async () => {
    process.env.META_APP_ID = "configured-app";
    process.env.META_APP_SECRET = "secret-1";
    const { sourceUpdate } = setupAuthenticatedGet({
      access_token: "token-1",
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      calls_webhook_subscribed: false,
      webhook_requires_reconnect: true,
    });
    mockGetPhoneNumberDetails.mockResolvedValue({
      id: "phone-1",
      code_verification_status: "VERIFIED",
      platform_type: "CLOUD_API",
    });
    mockGetPhoneCallingSettings.mockResolvedValue({
      success: true,
      data: {},
    });
    mockGetWabaWebhookSubscriptionStatus.mockResolvedValue({
      subscribed: false,
      selectedAppId: "other-app",
      selectedAppName: "Other app",
      matchedPreferredApp: false,
      availableAppIds: ["other-app"],
      fields: ["messages", "account_update", "calls"],
      missingRequiredFields: [],
      missingOptionalFields: [],
      coverageOk: true,
      actionable: null,
      coverage: {
        profileVersion: "test",
        requiredFields: ["messages", "account_update"],
        optionalFields: ["calls"],
        missingRequiredFields: [],
        missingOptionalFields: [],
      },
    });
    mockGraphGetJson.mockImplementation((path: string) => {
      if (path === "waba-1") {
        return Promise.resolve({ account_review_status: "APPROVED" });
      }
      if (path === "debug_token") {
        return Promise.resolve({ data: { app_id: "configured-app" } });
      }
      if (path === "waba-1/phone_numbers") {
        return Promise.resolve({ data: [{ id: "phone-1" }] });
      }
      throw new Error(`Unexpected Graph path ${path}`);
    });

    const response = await GET(
      new Request(
        "https://www.airi.chat/api/whatsapp/onboarding?workspaceId=workspace-1&refresh=1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.meta_refresh.outcome).toBe("succeeded");
    expect(body.status).toMatchObject({
      calls_webhook_subscribed: false,
      waba_selected_app_id: "other-app",
      waba_selected_app_matches_config: false,
      webhook_requires_reconnect: true,
    });
    expect(sourceUpdate).toHaveBeenCalledWith({
      credentials: expect.objectContaining({
        calls_webhook_subscribed: false,
        waba_selected_app_id: "other-app",
        waba_selected_app_matches_config: false,
      }),
    });
  });

  it("reports configured-app authorization failures without marking customer credentials for reconnect", async () => {
    process.env.META_APP_ID = "configured-app";
    process.env.META_APP_SECRET = "secret-1";
    const { sourceUpdate } = setupAuthenticatedGet({
      access_token: "token-1",
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      webhook_requires_reconnect: false,
    });
    mockGetPhoneNumberDetails.mockResolvedValue({
      id: "phone-1",
      code_verification_status: "VERIFIED",
      platform_type: "CLOUD_API",
    });
    const configuredAppError = new MetaGraphRequestError({
      message: "Invalid configured app token",
      status: 401,
      statusText: "Unauthorized",
      url: "https://graph.facebook.com/v25.0/configured-app/subscriptions",
      details: {
        error: {
          message: "Invalid configured app token",
          type: "OAuthException",
          code: 190,
        },
      },
      metaError: {
        message: "Invalid configured app token",
        type: "OAuthException",
        code: 190,
      },
    }) as MetaGraphRequestError & { metaCredentialOwner: "configured_app" };
    configuredAppError.metaCredentialOwner = "configured_app";
    mockGetWabaWebhookSubscriptionStatus.mockRejectedValue(configuredAppError);
    mockGraphGetJson.mockImplementation((path: string) => {
      if (path === "waba-1") {
        return Promise.resolve({ account_review_status: "APPROVED" });
      }
      if (path === "debug_token") {
        return Promise.resolve({ data: { app_id: "configured-app" } });
      }
      throw new Error(`Unexpected Graph path ${path}`);
    });

    const response = await GET(
      new Request(
        "https://www.airi.chat/api/whatsapp/onboarding?workspaceId=workspace-1&refresh=1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.meta_refresh).toEqual({
      requested: true,
      performed: true,
      outcome: "failed",
    });
    expect(body.error).toContain("airi.chat Meta app");
    expect(body.status.webhook_requires_reconnect).toBe(false);
    expect(mockGetPhoneCallingSettings).not.toHaveBeenCalled();
    expect(sourceUpdate).toHaveBeenCalledWith({
      credentials: expect.objectContaining({
        webhook_requires_reconnect: false,
        meta_diagnostics_last_attempt_at: expect.any(String),
      }),
    });
    expect(sourceUpdate).not.toHaveBeenCalledWith({
      credentials: expect.objectContaining({
        webhook_requires_reconnect: true,
      }),
    });
  });

  it.each([
    {
      failure: "authorization",
      status: 401,
      statusText: "Unauthorized",
      code: 190,
    },
    {
      failure: "throttling",
      status: 400,
      statusText: "Bad Request",
      code: 4,
    },
  ])(
    "attributes debug-token $failure failures to the configured app",
    async ({ status, statusText, code }) => {
      process.env.META_APP_ID = "configured-app";
      process.env.META_APP_SECRET = "secret-1";
      const { sourceUpdate } = setupAuthenticatedGet({
        access_token: "token-1",
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        webhook_requires_reconnect: false,
      });
      mockGetPhoneNumberDetails.mockResolvedValue({
        id: "phone-1",
        code_verification_status: "VERIFIED",
        platform_type: "CLOUD_API",
      });
      const configuredAppError = new MetaGraphRequestError({
        message: "Configured app request failed",
        status,
        statusText,
        url: "https://graph.facebook.com/v25.0/debug_token",
        details: {
          error: {
            message: "Configured app request failed",
            type: "OAuthException",
            code,
          },
        },
        metaError: {
          message: "Configured app request failed",
          type: "OAuthException",
          code,
        },
      });
      mockGraphGetJson.mockImplementation((path: string) => {
        if (path === "waba-1") {
          return Promise.resolve({ account_review_status: "APPROVED" });
        }
        if (path === "debug_token") {
          return Promise.reject(configuredAppError);
        }
        throw new Error(`Unexpected Graph path ${path}`);
      });

      const response = await GET(
        new Request(
          "https://www.airi.chat/api/whatsapp/onboarding?workspaceId=workspace-1&refresh=1"
        )
      );
      const body = await response.json();

      expect(response.status).toBe(502);
      expect(body.meta_refresh).toEqual({
        requested: true,
        performed: true,
        outcome: "failed",
      });
      expect(body.error).toContain("airi.chat Meta app");
      expect(body.status.webhook_requires_reconnect).toBe(false);
      expect(mockGetWabaWebhookSubscriptionStatus).not.toHaveBeenCalled();
      expect(sourceUpdate).toHaveBeenCalledWith({
        credentials: expect.objectContaining({
          webhook_requires_reconnect: false,
          meta_diagnostics_last_attempt_at: expect.any(String),
        }),
      });
      expect(sourceUpdate).not.toHaveBeenCalledWith({
        credentials: expect.objectContaining({
          webhook_requires_reconnect: true,
        }),
      });
      expect(mockCacheSet).not.toHaveBeenCalled();
    }
  );

  it("persists successful partial fields but not freshness when a later applicable Meta read fails", async () => {
    const { sourceUpdate } = setupAuthenticatedGet({
      access_token: "token-1",
      phone_number_id: "phone-1",
      verified_name: "Persisted name",
      meta_diagnostics_last_success_at: "2026-08-03T00:00:00.000Z",
    });
    mockGetPhoneNumberDetails.mockResolvedValue({
      id: "phone-1",
      code_verification_status: "VERIFIED",
      platform_type: "CLOUD_API",
      display_phone_number: "+15551234567",
      verified_name: "Fresh phone name",
      quality_rating: "GREEN",
      throughput: { level: "STANDARD" },
      name_status: "APPROVED",
    });

    const response = await GET(
      new Request(
        "https://www.airi.chat/api/whatsapp/onboarding?workspaceId=workspace-1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.meta_refresh).toEqual({
      requested: false,
      performed: true,
      outcome: "failed",
    });
    expect(sourceUpdate).toHaveBeenCalledWith({
      credentials: expect.objectContaining({
        verified_name: "Fresh phone name",
        calls_enablement_error: "Calling settings unavailable",
        meta_diagnostics_last_attempt_at: expect.any(String),
        meta_diagnostics_last_success_at: "2026-08-03T00:00:00.000Z",
      }),
    });
    expect(sourceUpdate).not.toHaveBeenCalledWith({
      credentials: expect.objectContaining({
        diagnostics_last_checked_at: expect.any(String),
      }),
    });
  });

  it.each([
    { code_verification_status: "VERIFIED" },
    { code_verification_status: "VERIFIED", platform_type: "CLOUD_API" },
  ])(
    "preserves failed registration when Meta only reports ownership or platform: %j",
    async details => {
      const { sourceUpdate } = setupAuthenticatedGet({
        access_token: "token-1",
        phone_number_id: "phone-1",
        embedded_signup_flow: "cloud_api",
        phone_registered: false,
        phone_registration_error: "Registration failed",
      });
      mockGetPhoneNumberDetails.mockResolvedValue({
        id: "phone-1",
        ...details,
      });

      const response = await GET(
        new Request(
          "https://www.airi.chat/api/whatsapp/onboarding?workspaceId=workspace-1"
        )
      );
      const body = await response.json();

      expect(body.status).toMatchObject({
        phone_registered: false,
        phone_registration_error: "Registration failed",
      });
      expect(sourceUpdate).toHaveBeenCalledWith({
        credentials: expect.objectContaining({
          phone_registered: false,
          phone_registration_error: "Registration failed",
        }),
      });
    }
  );

  it.each([
    { status: "CONNECTED", registered: true },
    { status: "PENDING", registered: false },
    { status: undefined, registered: true },
  ])(
    "uses live connection status or proven registration when status is $status",
    async ({ status, registered }) => {
      setupAuthenticatedGet({
        access_token: "token-1",
        phone_number_id: "phone-1",
        embedded_signup_flow: "cloud_api",
        phone_registered: true,
        phone_registration_status: "REGISTERED",
        phone_registered_at: "2026-09-01T00:00:00.000Z",
      });
      mockGetPhoneNumberDetails.mockResolvedValue({
        id: "phone-1",
        code_verification_status: "VERIFIED",
        platform_type: "CLOUD_API",
        ...(status ? { status } : {}),
      });

      const response = await GET(
        new Request(
          "https://www.airi.chat/api/whatsapp/onboarding?workspaceId=workspace-1"
        )
      );
      const body = await response.json();

      expect(body.status).toMatchObject({
        phone_registered: registered,
        phone_registration_status: status || "REGISTERED",
        phone_registered_at: "2026-09-01T00:00:00.000Z",
      });
    }
  );

  it("returns persisted onboarding status without claiming a Meta refresh when credentials are incomplete", async () => {
    const { sourceUpdate } = setupAuthenticatedGet({
      phone_registered: true,
      phone_registered_at: "2026-06-01T00:00:00.000Z",
    });

    const response = await GET(
      new Request(
        "https://www.airi.chat/api/whatsapp/onboarding?workspaceId=workspace-1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      connected: true,
      status: {
        phone_registered: true,
        phone_registered_at: "2026-06-01T00:00:00.000Z",
      },
    });
    expect(body.meta_refresh).toEqual({
      requested: false,
      performed: false,
      outcome: "not_configured",
    });
    expect(body.status.diagnostics_last_checked_at).toBeUndefined();
    expect(sourceUpdate).not.toHaveBeenCalled();
    expect(mockUpdateCurrentWhatsAppSourceCredentials).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns live co-existence flags and persists refreshed source credentials from GET", async () => {
    process.env.NEXT_PUBLIC_META_APP_ID = "app-1";

    const { sourceUpdate } = setupAuthenticatedGet({
      access_token: "token-1",
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      embedded_signup: true,
      embedded_signup_flow: "cloud_api",
      coexistence_mode: false,
    });
    mockGetPhoneNumberDetails.mockResolvedValue({
      code_verification_status: "NOT_VERIFIED",
      platform_type: "CLOUD_API",
      is_on_biz_app: true,
      display_phone_number: "+77073379206",
      verified_name: "Demoshop Group",
      quality_rating: "GREEN",
      name_status: "APPROVED",
    });
    mockGetPhoneCallingSettings.mockResolvedValue({
      success: true,
      data: {},
    });
    mockGetWabaWebhookSubscriptionStatus.mockResolvedValue({
      subscribed: true,
      selectedAppId: "app-1",
      selectedAppName: "airi.chat",
      matchedPreferredApp: true,
      availableAppIds: ["app-1"],
      fields: [
        "messages",
        "account_update",
        "history",
        "smb_app_state_sync",
        "smb_message_echoes",
      ],
      missingRequiredFields: [],
      missingOptionalFields: [],
      coverageOk: true,
      actionable: null,
      coverage: {
        profileVersion: "test",
        requiredFields: [
          "messages",
          "account_update",
          "history",
          "smb_app_state_sync",
          "smb_message_echoes",
        ],
        optionalFields: [],
        missingRequiredFields: [],
        missingOptionalFields: [],
      },
    });
    mockGraphGetJson.mockImplementation((path: string) => {
      if (path === "debug_token") {
        return Promise.resolve({ data: { app_id: "app-1" } });
      }
      if (path === "waba-1") {
        return Promise.resolve({
          account_review_status: "APPROVED",
          marketing_messages_onboarding_status: "ONBOARDED",
        });
      }
      if (path === "waba-1/subscribed_apps") {
        return Promise.resolve({
          data: [{ id: "app-1", name: "airi.chat" }],
        });
      }
      if (path === "waba-1/phone_numbers") {
        return Promise.resolve({ data: [{ id: "phone-1" }] });
      }
      if (path === "phone-1") {
        return Promise.resolve({ id: "phone-1", is_pin_enabled: true });
      }
      throw new Error(`Unexpected Graph path ${path}`);
    });

    const response = await GET(
      new Request(
        "https://www.airi.chat/api/whatsapp/onboarding?workspaceId=workspace-1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.meta_refresh).toEqual({
      requested: false,
      performed: true,
      outcome: "succeeded",
    });
    expect(body.status).toMatchObject({
      platform_type: "CLOUD_API",
      is_on_biz_app: true,
      coexistence_mode: true,
      partner_app_installed: true,
    });
    expect(mockGetWabaWebhookSubscriptionStatus).toHaveBeenCalledWith(
      "waba-1",
      "token-1",
      { coexistenceMode: true }
    );
    expect(mockUpdateCurrentWhatsAppSourceCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPhoneNumberId: "phone-1",
        expectedCredentials: {
          access_token: "token-1",
          accessToken: undefined,
        },
      })
    );
    expect(sourceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: expect.objectContaining({
          coexistence_mode: true,
          marketing_messages_enabled: true,
          marketing_messages_onboarding_status: "ONBOARDED",
          meta_diagnostics_last_success_at: expect.any(String),
        }),
      })
    );
  });

  describe("offboarded coexistence sources", () => {
    const coexistenceCredentials = {
      access_token: "token-1",
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      embedded_signup: true,
      embedded_signup_flow: "coexistence",
      coexistence_mode: true,
      partner_app_installed: true,
      partner_app_installed_at: "2026-05-28T15:51:18.811Z",
    };
    const offboardedCredentials = {
      ...coexistenceCredentials,
      partner_app_installed: false,
      cloud_api_messaging_suspended: true,
      coexistence_reonboarding_status: "offboarded",
      coexistence_reonboarding_event: "ACCOUNT_OFFBOARDED",
    };

    function mockLiveBusinessAppReads() {
      process.env.NEXT_PUBLIC_META_APP_ID = "app-1";
      mockGetPhoneNumberDetails.mockResolvedValue({
        code_verification_status: "NOT_VERIFIED",
        platform_type: "CLOUD_API",
        is_on_biz_app: true,
        display_phone_number: "+77067040359",
        verified_name: "EduKey",
        quality_rating: "YELLOW",
        name_status: "NON_EXISTS",
      });
      mockGetWabaWebhookSubscriptionStatus.mockResolvedValue({
        subscribed: true,
        selectedAppId: "app-1",
        selectedAppName: "airi.chat",
        matchedPreferredApp: true,
        availableAppIds: ["app-1"],
        fields: ["messages", "account_update", "smb_message_echoes"],
        missingRequiredFields: [],
        missingOptionalFields: [],
        coverageOk: true,
        actionable: null,
        coverage: {
          profileVersion: "test",
          requiredFields: ["messages", "account_update", "smb_message_echoes"],
          optionalFields: [],
          missingRequiredFields: [],
          missingOptionalFields: [],
        },
      });
      mockGraphGetJson.mockImplementation((path: string) => {
        if (path === "debug_token") {
          return Promise.resolve({ data: { app_id: "app-1" } });
        }
        if (path === "waba-1") {
          return Promise.resolve({ account_review_status: "APPROVED" });
        }
        if (path === "waba-1/subscribed_apps") {
          return Promise.resolve({
            data: [{ id: "app-1", name: "airi.chat" }],
          });
        }
        if (path === "waba-1/phone_numbers") {
          return Promise.resolve({ data: [{ id: "phone-1" }] });
        }
        if (path === "phone-1") {
          return Promise.resolve({ id: "phone-1" });
        }
        throw new Error(`Unexpected Graph path ${path}`);
      });
    }

    function lastPersistedCredentials(sourceUpdate: jest.Mock) {
      const calls = sourceUpdate.mock.calls as unknown as Array<
        [{ credentials: Record<string, unknown> }]
      >;
      return calls[calls.length - 1][0].credentials;
    }

    it("keeps an offboarded source's partner app disconnected after a live read", async () => {
      const { sourceUpdate } = setupAuthenticatedGet(offboardedCredentials);
      mockLiveBusinessAppReads();

      const response = await GET(
        new Request(
          "https://www.airi.chat/api/whatsapp/onboarding?workspaceId=workspace-1"
        )
      );

      expect(response.status).toBe(200);
      expect(lastPersistedCredentials(sourceUpdate)).toMatchObject({
        is_on_biz_app: true,
        coexistence_mode: true,
        partner_app_installed: false,
        partner_app_installed_at: "2026-05-28T15:51:18.811Z",
        coexistence_reonboarding_status: "offboarded",
      });
    });

    it("keeps an offboarding that lands during the live read", async () => {
      setupAuthenticatedGet(coexistenceCredentials);
      mockLiveBusinessAppReads();
      let persisted: Record<string, unknown> | undefined;
      mockUpdateCurrentWhatsAppSourceCredentials.mockImplementationOnce(
        async (params: {
          workspaceId: string;
          sourceId: string;
          buildCredentials: (
            credentials: Record<string, unknown>
          ) => Record<string, unknown>;
        }) => {
          // ACCOUNT_OFFBOARDED committed after GET read the source.
          persisted = params.buildCredentials({ ...offboardedCredentials });
          return {
            id: params.sourceId,
            workspaceId: params.workspaceId,
            updatedAt: "2026-08-03T00:00:00.000Z",
            credentials: persisted,
          };
        }
      );

      const response = await GET(
        new Request(
          "https://www.airi.chat/api/whatsapp/onboarding?workspaceId=workspace-1"
        )
      );

      expect(response.status).toBe(200);
      expect(persisted).toMatchObject({
        coexistence_mode: true,
        partner_app_installed: false,
        partner_app_installed_at: "2026-05-28T15:51:18.811Z",
        cloud_api_messaging_suspended: true,
        coexistence_reonboarding_status: "offboarded",
      });
    });
  });

  it("clears stale phone webhook reconnect warnings when WABA subscription is healthy", async () => {
    process.env.META_APP_ID = "server-app-1";
    process.env.NEXT_PUBLIC_META_APP_ID = "public-app-1";
    process.env.META_APP_SECRET = "secret-1";

    const { sourceUpdate } = setupAuthenticatedGet({
      access_token: "token-1",
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      webhook_requires_reconnect: true,
      phone_webhook_error:
        "Object does not exist or missing permissions: Unsupported post request. Object with ID 'phone-1' does not exist.",
    });
    mockGetPhoneNumberDetails.mockResolvedValue({
      status: "CONNECTED",
      code_verification_status: "VERIFIED",
      platform_type: "CLOUD_API",
      display_phone_number: "+15551234567",
      verified_name: "Airi",
      quality_rating: "GREEN",
    });
    mockGetWabaWebhookSubscriptionStatus.mockResolvedValue({
      subscribed: true,
      selectedAppId: "server-app-1",
      selectedAppName: "airi.chat",
      matchedPreferredApp: true,
      availableAppIds: ["server-app-1"],
      fields: ["messages", "account_update", "calls"],
      missingRequiredFields: [],
      missingOptionalFields: [],
      coverageOk: true,
      actionable: null,
      coverage: {
        profileVersion: "test",
        requiredFields: ["messages", "account_update"],
        optionalFields: ["calls"],
        missingRequiredFields: [],
        missingOptionalFields: [],
      },
    });
    mockGraphGetJson.mockImplementation((path: string) => {
      if (path === "debug_token") {
        return Promise.resolve({ data: { app_id: "server-app-1" } });
      }
      if (path === "waba-1") {
        return Promise.resolve({
          account_review_status: "APPROVED",
          marketing_messages_onboarding_status: "ONBOARDED",
        });
      }
      if (path === "waba-1/subscribed_apps") {
        return Promise.resolve({
          data: [{ id: "server-app-1", name: "airi.chat" }],
        });
      }
      if (path === "waba-1/phone_numbers") {
        return Promise.resolve({ data: [{ id: "phone-1" }] });
      }
      if (path === "phone-1") {
        return Promise.resolve({ id: "phone-1", is_pin_enabled: true });
      }
      throw new Error(`Unexpected Graph path ${path}`);
    });

    const response = await GET(
      new Request(
        "https://www.airi.chat/api/whatsapp/onboarding?workspaceId=workspace-1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toMatchObject({
      webhook_requires_reconnect: false,
      webhook_error: null,
      phone_webhook_error: null,
      waba_selected_app_matches_config: true,
      webhook_missing_required_fields: [],
      waba_health_state: "healthy",
      waba_health_reasons: [],
    });
    expect(mockGraphGetJson).toHaveBeenCalledWith("debug_token", {
      token: "server-app-1|secret-1",
      query: {
        input_token: "token-1",
        access_token: "server-app-1|secret-1",
      },
    });
    expect(sourceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: expect.objectContaining({
          expected_meta_app_id: "server-app-1",
          token_app_id: "server-app-1",
          token_app_id_matches_config: true,
          webhook_requires_reconnect: false,
          phone_webhook_error: null,
        }),
      })
    );
  });

  it("returns WhatsApp calling platform readiness from source status and runtime env", async () => {
    process.env.LIVEKIT_URL = "wss://livekit.example.com";
    process.env.LIVEKIT_API_KEY = "livekit-key";
    process.env.LIVEKIT_API_SECRET = "livekit-secret";
    process.env.TEMPORAL_ADDRESS = "temporal.example.com:7233";
    process.env.TEMPORAL_NAMESPACE = "production";
    process.env.WHATSAPP_CALL_PUBSUB_PROJECT_ID = "gcp-project";
    process.env.WHATSAPP_CALL_PUBSUB_TOPIC =
      WHATSAPP_CALL_WEBHOOK_PUBSUB_DEFAULT_TOPIC;

    setupAuthenticatedGet({
      calls_webhook_subscribed: true,
      calls_enabled: true,
      calls_callback_permission_status: "ENABLED",
      embedded_signup_flow: "cloud_api",
      coexistence_mode: false,
    });

    const response = await GET(
      new Request(
        "https://www.airi.chat/api/whatsapp/onboarding?workspaceId=workspace-1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status.calls_operational_readiness).toMatchObject({
      ready: true,
      checks: expect.arrayContaining([
        expect.objectContaining({
          id: "calls_webhook_subscribed",
          ready: true,
        }),
        expect.objectContaining({
          id: "phone_calling_enabled",
          ready: true,
        }),
        expect.objectContaining({
          id: "callback_permission_enabled",
          ready: true,
        }),
        expect.objectContaining({
          id: "source_media_enabled",
          ready: true,
        }),
        expect.objectContaining({
          id: "livekit_configured",
          ready: true,
        }),
        expect.objectContaining({
          id: "temporal_configured",
          ready: true,
        }),
        expect.objectContaining({
          id: "call_pubsub_configured",
          ready: true,
        }),
      ]),
    });
  });
});

describe("POST /api/whatsapp/onboarding", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRegisterPhoneNumberWithPin.mockReset();
    mockRegisterPhoneNumberWithPin.mockResolvedValue({ success: true });
    mockUpdateCurrentWhatsAppSourceCredentials.mockImplementation(
      async (params: {
        workspaceId: string;
        sourceId: string;
        buildCredentials: (
          credentials: Record<string, unknown>
        ) => Record<string, unknown>;
      }) => {
        const sourceQuery = mockSupabaseFrom("sources");
        const loaded = await sourceQuery
          .select("credentials")
          .eq("id", params.sourceId)
          .maybeSingle();
        const credentials = params.buildCredentials(
          (loaded.data?.credentials as Record<string, unknown>) || {}
        );
        await sourceQuery.update({ credentials }).eq("id", params.sourceId);
        return {
          id: params.sourceId,
          workspaceId: params.workspaceId,
          updatedAt: "2026-08-03T00:00:00.000Z",
          credentials,
        };
      }
    );
    mockUpdateCurrentWhatsAppSourceCredentialsFromSnapshot.mockImplementation(
      async (params: {
        workspaceId: string;
        sourceId: string;
        nextCredentials: Record<string, unknown>;
      }) => {
        await mockSupabaseFrom("sources")
          .update({ credentials: params.nextCredentials })
          .eq("id", params.sourceId);
        return {
          id: params.sourceId,
          workspaceId: params.workspaceId,
          updatedAt: "2026-08-03T00:00:00.000Z",
          credentials: params.nextCredentials,
        };
      }
    );
    mockUploadWhatsAppVoicemailAnnouncementFile.mockResolvedValue({
      id: "media-vm-1",
      mimeType: "audio/ogg",
      sizeBytes: 3,
    });
    mockRunWhatsAppAutoDefaults.mockImplementation(
      async (params: {
        credentials: Record<string, unknown>;
        saveCredentials: (
          credentials: Record<string, unknown>
        ) => Promise<void>;
      }) => {
        const credentials = {
          ...params.credentials,
          calls_voicemail_enabled: true,
        };
        await params.saveCredentials(credentials);
        return {
          success: true,
          warnings: [],
          credentials,
          stepResults: {},
        };
      }
    );
  });

  function setupPhoneRegistration(credentials: Record<string, unknown> = {}) {
    const sourceBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          id: "source-1",
          credentials: {
            phone_number_id: "phone-1",
            waba_id: "waba-1",
            access_token: "access-token",
            embedded_signup_flow: "cloud_api",
            ...credentials,
          },
        },
      }),
      update: jest.fn().mockReturnThis(),
    };
    const membershipBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { workspace_id: "workspace-1", role: "admin" },
      }),
    };
    mockSupabaseFrom.mockImplementation((table: string) =>
      table === "company_users" ? membershipBuilder : sourceBuilder
    );
    mockCreateClient.mockResolvedValue({
      auth: supabaseAuth(),
      from: (...args: unknown[]) => mockSupabaseFrom(...args),
    });

    return new Request("https://www.airi.chat/api/whatsapp/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "workspace-1",
        action: "register_phone",
        pin: "123456",
      }),
    });
  }

  it.each([
    { code_verification_status: "VERIFIED" },
    { code_verification_status: "VERIFIED", platform_type: "CLOUD_API" },
  ])(
    "registers Cloud API phones whose only evidence is ownership or platform: %j",
    async details => {
      const request = setupPhoneRegistration();
      mockGetPhoneNumberDetails.mockResolvedValue({
        id: "phone-1",
        ...details,
      });

      const response = await POST(request);
      const body = await response.json();

      expect(mockRegisterPhoneNumberWithPin).toHaveBeenCalledWith({
        phoneNumberId: "phone-1",
        pin: "123456",
        accessToken: "access-token",
      });
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        success: true,
        status: {
          phone_registered: true,
          phone_registration_status: "REGISTERED",
        },
      });
    }
  );

  it("keeps a failed register request unregistered even when ownership is verified", async () => {
    const request = setupPhoneRegistration();
    mockGetPhoneNumberDetails.mockResolvedValue({
      id: "phone-1",
      code_verification_status: "VERIFIED",
      platform_type: "CLOUD_API",
    });
    mockRegisterPhoneNumberWithPin.mockRejectedValue(
      new Error("Registration failed")
    );

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      status: {
        phone_registered: false,
        phone_registration_error: "Registration failed",
      },
    });
  });

  it("skips registration when Meta reports the phone is CONNECTED", async () => {
    const request = setupPhoneRegistration();
    mockGetPhoneNumberDetails.mockResolvedValue({
      id: "phone-1",
      status: "CONNECTED",
    });

    const response = await POST(request);
    const body = await response.json();

    expect(mockRegisterPhoneNumberWithPin).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      success: true,
      status: {
        phone_registered: true,
        phone_registration_status: "CONNECTED",
      },
    });
  });

  it("preserves coexistence registration bypass when phone details fail", async () => {
    const request = setupPhoneRegistration({
      embedded_signup_flow: "coexistence",
      coexistence_mode: true,
    });
    mockGetPhoneNumberDetails.mockRejectedValue(
      new Error("Phone details unavailable")
    );

    const response = await POST(request);

    expect(response.status).toBe(409);
    expect(mockRegisterPhoneNumberWithPin).not.toHaveBeenCalled();
  });

  it("uploads and persists a voicemail announcement before applying calling defaults", async () => {
    const sourceUpdateEq = jest.fn().mockResolvedValue({ error: null });
    const sourceUpdate = jest.fn(() => ({ eq: sourceUpdateEq }));
    const sourceBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          id: "source-1",
          credentials: {
            phone_number_id: "phone-1",
            waba_id: "waba-1",
            access_token: "access-token",
          },
        },
      }),
      update: sourceUpdate,
    };
    const membershipBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { workspace_id: "workspace-1", role: "admin" },
      }),
    };

    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === "company_users") return membershipBuilder;
      if (table === "sources") return sourceBuilder;
      throw new Error(`Unexpected table ${table}`);
    });
    mockCreateClient.mockResolvedValue({
      auth: supabaseAuth(),
      from: (...args: unknown[]) => mockSupabaseFrom(...args),
    });

    const file = new File([new Uint8Array([1, 2, 3])], "announcement.ogg", {
      type: "audio/ogg",
    });
    const formData = new FormData();
    formData.set("workspaceId", "workspace-1");
    formData.set("action", "upload_voicemail_announcement");
    formData.set("file", file);

    const response = await POST(
      new Request("https://www.airi.chat/api/whatsapp/onboarding", {
        method: "POST",
        body: formData,
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      auto_defaults_success: true,
      upload: { id: "media-vm-1", mimeType: "audio/ogg", sizeBytes: 3 },
      status: {
        calls_voicemail_enabled: true,
        calls_voicemail_announcement_media_id: "media-vm-1",
      },
    });
    const uploadParams =
      mockUploadWhatsAppVoicemailAnnouncementFile.mock.calls[0]?.[0];
    expect(uploadParams).toEqual(
      expect.objectContaining({
        phoneNumberId: "phone-1",
        accessToken: "access-token",
        description: "Default voicemail announcement",
      })
    );
    expect(uploadParams.file).toBeInstanceOf(File);
    expect(uploadParams.file.name).toBe("announcement.ogg");
    expect(uploadParams.file.type).toBe("audio/ogg");
    expect(uploadParams.file.size).toBe(3);
    expect(sourceUpdate).toHaveBeenCalledWith({
      credentials: expect.objectContaining({
        calls_voicemail_announcement_media_id: "media-vm-1",
        calls_voicemail_announcement_file_name: "announcement.ogg",
        calls_voicemail_announcement_file_size_bytes: 3,
        calls_voicemail_announcement_mime_type: "audio/ogg",
      }),
    });
    expect(mockRunWhatsAppAutoDefaults).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "source-1",
        force: true,
        trigger: "onboarding_action",
        credentials: expect.objectContaining({
          calls_voicemail_announcement_media_id: "media-vm-1",
        }),
      })
    );
  });
});

export {};
