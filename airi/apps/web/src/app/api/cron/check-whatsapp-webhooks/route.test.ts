import { decryptMaybeString } from "@/lib/crypto";

const mockCheckTokenExpiryAndAlert = jest.fn();
const mockSupabaseFrom = jest.fn();
const mockCacheAcquireLock = jest.fn();
const mockCacheCompareAndDelete = jest.fn();
const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();
const mockGraphRequest = jest.fn();
const mockGraphGetJson = jest.fn();
const mockDebugToken = jest.fn();
let mockSourceRows: Array<{ credentials: Record<string, unknown> }> = [];
const mockSubscribeToWABAWebhooks = jest.fn();
const mockGetWabaWebhookSubscriptionStatus = jest.fn();
const mockGetPhoneNumberDetails = jest.fn();
const COMPLETE_CLOUD_WEBHOOK_FIELDS = [
  "messages",
  "account_update",
  "calls",
  "group_lifecycle_update",
  "group_participants_update",
  "group_settings_update",
  "group_status_update",
  "flows",
  "account_alerts",
  "business_capability_update",
  "message_template_status_update",
  "message_template_quality_update",
  "message_template_components_update",
  "template_category_update",
  "template_correct_category_detection",
  "tracking_events",
  "partner_solutions",
  "payment_configuration_update",
  "security",
  "user_preferences",
];
async function persistMockSourceCredentials(params: {
  workspaceId: string;
  sourceId: string;
  expectedPhoneNumberId?: string;
  expectedCredentials?: Readonly<Record<string, unknown>>;
  nextCredentials: Record<string, unknown>;
}) {
  await mockSupabaseFrom("sources")
    .update({ credentials: params.nextCredentials })
    .eq("id", params.sourceId);
  return {
    id: params.sourceId,
    workspaceId: params.workspaceId,
    updatedAt: "2026-05-11T00:00:01.000Z",
    credentials: params.nextCredentials,
  };
}
const mockUpdateCurrentWhatsAppSourceCredentialsFromSnapshot = jest.fn(
  persistMockSourceCredentials
);

jest.mock("@/lib/notifications/check-token-expiry", () => ({
  checkTokenExpiryAndAlert: (...args: unknown[]) =>
    mockCheckTokenExpiryAndAlert(...args),
}));

jest.mock("@/lib/meta/debug-token", () => ({
  debugConfiguredMetaAccessToken: (...args: unknown[]) =>
    mockDebugToken(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
  },
}));

jest.mock("@icecore/shared/lib/cache", () => ({
  buildCacheKey: (namespace: string, parts: Array<string | number>) =>
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
  updateCurrentWhatsAppSourceCredentialsFromSnapshot: (
    params: Parameters<
      typeof mockUpdateCurrentWhatsAppSourceCredentialsFromSnapshot
    >[0]
  ) => mockUpdateCurrentWhatsAppSourceCredentialsFromSnapshot(params),
}));

jest.mock("@icecore/shared/lib/meta/api", () => ({
  getWhatsAppGraphClient: () => ({
    request: (...args: unknown[]) => mockGraphRequest(...args),
    getJson: (...args: unknown[]) => mockGraphGetJson(...args),
  }),
  isMetaGraphRateLimitError: (error: unknown) => {
    if (!error || typeof error !== "object") return false;
    const value = error as {
      status?: number;
      metaError?: { code?: number };
    };
    return (
      value.status === 429 ||
      [4, 17, 32, 613, 80008].includes(value.metaError?.code ?? -1)
    );
  },
  isMetaGraphAuthorizationError: (error: unknown) => {
    if (!error || typeof error !== "object") return false;
    const value = error as {
      status?: number;
      metaError?: { code?: number; error_subcode?: number };
      formattedError?: { requiresReconnect?: boolean };
    };
    const code = value.metaError?.code;
    return (
      value.status === 401 ||
      value.status === 403 ||
      code === 10 ||
      code === 190 ||
      code === 200 ||
      (code === 100 && value.metaError?.error_subcode === 33) ||
      value.formattedError?.requiresReconnect === true
    );
  },
  getMetaGraphAuthorizationMetadata: (error: unknown) => {
    if (!error || typeof error !== "object") return null;
    const value = error as {
      status?: number;
      metaError?: { code?: number; error_subcode?: number };
      formattedError?: { requiresReconnect?: boolean };
    };
    const code = value.metaError?.code;
    const isAuthorizationFailure =
      value.status === 401 ||
      value.status === 403 ||
      code === 10 ||
      code === 190 ||
      code === 200 ||
      (code === 100 && value.metaError?.error_subcode === 33) ||
      value.formattedError?.requiresReconnect === true;
    return isAuthorizationFailure
      ? {
          status: value.status,
          code,
          subcode: value.metaError?.error_subcode,
          requiresReconnect: true,
        }
      : null;
  },
  getMetaGraphRateLimitMetadata: (error: unknown) => {
    if (!error || typeof error !== "object") return null;
    const value = error as {
      status?: number;
      metaError?: { code?: number };
    };
    return value.status === 429 ||
      [4, 17, 32, 613, 80008].includes(value.metaError?.code ?? -1)
      ? { status: value.status, code: value.metaError?.code }
      : null;
  },
}));

jest.mock("@/lib/whatsapp/waba-service", () => ({
  getWabaWebhookSubscriptionStatus: (...args: unknown[]) =>
    mockGetWabaWebhookSubscriptionStatus(...args),
  subscribeToWABAWebhooks: (...args: unknown[]) =>
    mockSubscribeToWABAWebhooks(...args),
}));

jest.mock("@/lib/whatsapp/qr-code-service", () => ({
  getPhoneNumberDetails: (...args: unknown[]) =>
    mockGetPhoneNumberDetails(...args),
}));

function mockSourcesQuery(sources: unknown[]) {
  mockSourceRows = sources as typeof mockSourceRows;
  const sourceEq = jest.fn().mockResolvedValue({
    data: sources,
    error: null,
  });
  const select = jest.fn(() => ({ eq: sourceEq }));
  const updateEq = jest.fn().mockResolvedValue({ error: null });
  const update = jest.fn(
    (_payload: { credentials: Record<string, unknown> }) => ({ eq: updateEq })
  );

  mockSupabaseFrom.mockReturnValue({
    select,
    update,
  });

  return { update, updateEq };
}

function duplicateWhatsAppSources(credentials: Record<string, unknown>) {
  return ["1", "2"].map(index => ({
    id: `source-${index}`,
    workspace_id: `workspace-${index}`,
    credentials: { ...credentials },
  }));
}

describe("/api/cron/check-whatsapp-webhooks", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockGraphRequest.mockReset();
    mockGraphGetJson.mockReset();
    mockSourceRows = [];
    const inspectedTokens = new Set<string>();
    mockDebugToken
      .mockReset()
      .mockImplementation(async (accessToken: string) => {
        const source = mockSourceRows.find(
          row => row.credentials.access_token === accessToken
        );
        const afterExchange = inspectedTokens.has(accessToken) || !source;
        inspectedTokens.add(accessToken);
        const sourceExpiry = source?.credentials.token_expires_at;
        const expiry = afterExchange
          ? "2026-07-10T00:00:00.000Z"
          : sourceExpiry;
        const wabaIds = [
          ...new Set(mockSourceRows.map(row => row.credentials.waba_id)),
        ];
        const scopes = [
          "whatsapp_business_management",
          "whatsapp_business_messaging",
        ];
        return {
          app_id: "meta-app-id",
          user_id: "system-user",
          type: "SYSTEM_USER",
          is_valid: true,
          expires_at:
            typeof expiry === "string" ? Date.parse(expiry) / 1000 : 0,
          data_access_expires_at: 0,
          scopes,
          granular_scopes: scopes.map(scope => ({
            scope,
            target_ids: wabaIds,
          })),
        };
      });
    mockSubscribeToWABAWebhooks.mockReset();
    mockGetWabaWebhookSubscriptionStatus.mockReset();
    mockGetPhoneNumberDetails.mockReset();
    mockUpdateCurrentWhatsAppSourceCredentialsFromSnapshot
      .mockReset()
      .mockImplementation(persistMockSourceCredentials);
    mockCacheAcquireLock.mockReset().mockResolvedValue("acquired");
    mockCacheCompareAndDelete.mockReset().mockResolvedValue(true);
    mockCacheGet.mockReset().mockResolvedValue(null);
    mockCacheSet.mockReset().mockResolvedValue(undefined);
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-05-11T00:00:00.000Z"));
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});

    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_META_APP_ID: "meta-app-id",
      META_APP_SECRET: "meta-app-secret",
      ENCRYPTION_SECRET: "test-encryption-secret",
    };
    delete process.env.CRON_SECRET;

    mockCheckTokenExpiryAndAlert.mockResolvedValue({
      isExpired: false,
      daysUntilExpiry: 3,
      alertSent: false,
    });
    mockGetPhoneNumberDetails.mockResolvedValue({
      code_verification_status: "VERIFIED",
      platform_type: "CLOUD_API",
      is_on_biz_app: false,
      display_phone_number: "+15551234567",
      verified_name: "Airi",
      quality_rating: "GREEN",
      name_status: "APPROVED",
    });
    mockGraphGetJson.mockResolvedValue({
      access_token: "same-access-token",
      expires_in: 60 * 24 * 60 * 60,
    });
    mockGetWabaWebhookSubscriptionStatus.mockResolvedValue({
      subscribed: true,
      fields: COMPLETE_CLOUD_WEBHOOK_FIELDS,
      missingRequiredFields: [],
      missingOptionalFields: [],
      coverageOk: true,
      actionable: null,
      coverage: {
        profileVersion: "2026-06-19",
        coexistenceMode: false,
        requiredFields: COMPLETE_CLOUD_WEBHOOK_FIELDS,
        optionalFields: [],
        subscribedFields: COMPLETE_CLOUD_WEBHOOK_FIELDS,
        missingRequiredFields: [],
        missingOptionalFields: [],
        coverageOk: true,
        actionable: null,
      },
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("rejects unauthorized cron requests when CRON_SECRET is configured", async () => {
    process.env.CRON_SECRET = "cron-secret";
    mockSourcesQuery([]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );

    expect(response.status).toBe(401);
    expect(mockSupabaseFrom).not.toHaveBeenCalled();
    expect(mockCacheAcquireLock).not.toHaveBeenCalled();
  });

  it("skips an overlapping maintenance run before loading sources", async () => {
    mockCacheAcquireLock.mockResolvedValueOnce("contended");

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "skipped",
      reason: "maintenance_already_running",
    });
    expect(mockSupabaseFrom).not.toHaveBeenCalled();
    expect(mockCacheCompareAndDelete).not.toHaveBeenCalled();
  });

  it("fails closed when the maintenance coordination backend is unavailable", async () => {
    mockCacheAcquireLock.mockResolvedValueOnce("unavailable");

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "error",
      reason: "maintenance_coordination_unavailable",
    });
    expect(mockSupabaseFrom).not.toHaveBeenCalled();
    expect(mockCacheCompareAndDelete).not.toHaveBeenCalled();
  });

  it("releases only the maintenance lock token owned by this run", async () => {
    mockSourcesQuery([]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );

    expect(response.status).toBe(200);
    const [lockKey, lockToken, ttlSeconds] = mockCacheAcquireLock.mock.calls[0];
    expect(lockKey).toBe("icecore:whatsapp:maintenance:v1:global");
    expect(lockToken).toEqual(expect.any(String));
    expect(lockToken).not.toBe("1");
    expect(ttlSeconds).toBe(15 * 60);
    expect(mockCacheCompareAndDelete).toHaveBeenCalledWith(lockKey, lockToken);
  });

  it("persists a renewed expiry when Meta returns the same token with expires_in", async () => {
    const { update, updateEq } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-05-14T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          embedded_signup: true,
          coexistence_mode: false,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.summary.token_refreshed).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(updateEq).toHaveBeenCalledWith("id", "source-1");

    const updateCalls = update.mock.calls as unknown as Array<
      [
        {
          credentials?: {
            access_token?: unknown;
            token_expires_at?: string;
            webhook_coverage_ok?: boolean;
          };
        },
      ]
    >;
    const updatePayload = updateCalls[0][0];
    expect(updatePayload.credentials?.token_expires_at).toBe(
      "2026-07-10T00:00:00.000Z"
    );
    expect(decryptMaybeString(updatePayload.credentials?.access_token)).toBe(
      "same-access-token"
    );
    expect(updatePayload.credentials?.webhook_coverage_ok).toBe(true);
    expect(
      mockUpdateCurrentWhatsAppSourceCredentialsFromSnapshot
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        expectedPhoneNumberId: "phone-1",
        expectedCredentials: {
          access_token: "same-access-token",
          accessToken: undefined,
        },
      })
    );
  });

  it("reconciles a stale expired date before renewing a still-valid provider token", async () => {
    mockDebugToken.mockResolvedValueOnce({
      app_id: "meta-app-id",
      user_id: "system-user",
      type: "SYSTEM_USER",
      is_valid: true,
      expires_at: Date.parse("2026-05-25T00:00:00.000Z") / 1000,
      scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
      granular_scopes: [
        "whatsapp_business_management",
        "whatsapp_business_messaging",
      ].map(scope => ({ scope, target_ids: ["waba-1"] })),
    });
    mockDebugToken.mockResolvedValueOnce({
      app_id: "meta-app-id",
      user_id: "system-user",
      type: "SYSTEM_USER",
      is_valid: true,
      expires_at: Date.parse("2026-07-10T00:00:00.000Z") / 1000,
      scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
      granular_scopes: [
        "whatsapp_business_management",
        "whatsapp_business_messaging",
      ].map(scope => ({ scope, target_ids: ["waba-1"] })),
    });
    mockCheckTokenExpiryAndAlert.mockResolvedValue({
      isExpired: true,
      daysUntilExpiry: -1,
      alertSent: true,
    });
    mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-05-10T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          embedded_signup: true,
          coexistence_mode: true,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.summary.token_refreshed).toBe(1);
    expect(body.summary.token_expired).toBe(0);
    expect(body.summary.critical_issues).toBe(0);
    expect(body.critical_issues).toEqual([]);
    expect(mockCheckTokenExpiryAndAlert).not.toHaveBeenCalled();
  });

  it("reports verified expiry without exchanging an expired token", async () => {
    mockCheckTokenExpiryAndAlert.mockResolvedValue({
      isExpired: true,
      daysUntilExpiry: -1,
      alertSent: true,
    });
    mockGraphGetJson.mockRejectedValueOnce({
      status: 429,
      metaError: { code: 80008 },
    });
    mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "expired-access-token",
          token_expires_at: "2026-05-10T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          embedded_signup: true,
          coexistence_mode: true,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.summary.token_refreshed).toBe(0);
    expect(body.summary.token_expired).toBe(1);
    expect(body.summary.critical_issues).toBe(1);
    expect(body.critical_issues).toEqual([
      "Workspace workspace-1: WhatsApp access has expired",
    ]);
    expect(mockGraphGetJson).not.toHaveBeenCalled();
    expect(
      mockCheckTokenExpiryAndAlert.mock.invocationCallOrder[0]
    ).toBeGreaterThan(
      mockUpdateCurrentWhatsAppSourceCredentialsFromSnapshot.mock
        .invocationCallOrder[0]
    );
    expect(mockGetPhoneNumberDetails).not.toHaveBeenCalled();
    expect(mockGetWabaWebhookSubscriptionStatus).not.toHaveBeenCalled();
  });

  it("does not exchange a healthy token outside the renewal window", async () => {
    mockCheckTokenExpiryAndAlert.mockResolvedValueOnce({
      isExpired: false,
      daysUntilExpiry: 30,
      alertSent: false,
    });
    mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-06-10T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          embedded_signup: true,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGraphRequest).not.toHaveBeenCalled();
    expect(mockGraphGetJson).not.toHaveBeenCalled();
    expect(body.summary.token_refreshed).toBe(0);
  });

  it("renews fourteen days before expiry and persists the verified deadline without alerting", async () => {
    const { update } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          token_expires_at: "2026-05-25T00:00:00.000Z",
        },
      },
    ]);
    const { GET } = await import("./route");
    const body = await (
      await GET(
        new Request("https://example.com/api/cron/check-whatsapp-webhooks")
      )
    ).json();
    expect(body.summary.token_refreshed).toBe(1);
    expect(update.mock.calls[0][0].credentials).toMatchObject({
      token_expires_at: "2026-07-10T00:00:00.000Z",
      token_maintenance_status: "renewed",
      token_is_valid: true,
    });
    expect(mockCheckTokenExpiryAndAlert).not.toHaveBeenCalled();
  });

  it("clears a synthetic expiry from provider evidence even when no token is renewed", async () => {
    mockDebugToken.mockResolvedValue({
      app_id: "meta-app-id",
      user_id: "system-user",
      type: "SYSTEM_USER",
      is_valid: true,
      expires_at: 0,
      data_access_expires_at: 0,
      scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
      granular_scopes: [
        "whatsapp_business_management",
        "whatsapp_business_messaging",
      ].map(scope => ({ scope, target_ids: ["waba-1"] })),
    });
    const { update } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          token_expires_at: "2026-05-10T00:00:00.000Z",
        },
      },
    ]);
    const { GET } = await import("./route");
    const body = await (
      await GET(
        new Request("https://example.com/api/cron/check-whatsapp-webhooks")
      )
    ).json();
    expect(body.summary).toMatchObject({
      token_refreshed: 0,
      token_expired: 0,
    });
    expect(update.mock.calls[0][0].credentials).toMatchObject({
      token_expires_at: null,
      token_never_expires: true,
      token_is_valid: true,
    });
    expect(mockGraphGetJson).not.toHaveBeenCalled();
    expect(mockCheckTokenExpiryAndAlert).not.toHaveBeenCalled();
  });

  it("does not publish a reconnect alert when a concurrent reconnection rejects the maintenance write", async () => {
    mockUpdateCurrentWhatsAppSourceCredentialsFromSnapshot.mockRejectedValueOnce(
      new Error("Source binding changed")
    );
    mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          token_expires_at: "2026-05-10T00:00:00.000Z",
        },
      },
    ]);
    const { GET } = await import("./route");
    const body = await (
      await GET(
        new Request("https://example.com/api/cron/check-whatsapp-webhooks")
      )
    ).json();
    expect(body.results[0].persistence_failed).toBe(true);
    expect(mockCheckTokenExpiryAndAlert).not.toHaveBeenCalled();
  });

  it("does not let an inaccessible WABA poison another authorized WABA sharing the token", async () => {
    mockDebugToken.mockResolvedValue({
      app_id: "meta-app-id",
      user_id: "system-user",
      type: "SYSTEM_USER",
      is_valid: true,
      expires_at: Date.parse("2026-07-10T00:00:00.000Z") / 1000,
      scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
      granular_scopes: [
        "whatsapp_business_management",
        "whatsapp_business_messaging",
      ].map(scope => ({ scope, target_ids: ["waba-2"] })),
    });
    mockSourcesQuery(
      ["1", "2"].map(index => ({
        id: "source-" + index,
        workspace_id: "workspace-" + index,
        credentials: {
          access_token: "same-access-token",
          waba_id: "waba-" + index,
          phone_number_id: "phone-" + index,
        },
      }))
    );
    const { GET } = await import("./route");
    const body = await (
      await GET(
        new Request("https://example.com/api/cron/check-whatsapp-webhooks")
      )
    ).json();
    expect(body.results[0].skipped_reason).toBe("reconnection_required");
    expect(body.results[1]).toMatchObject({
      source_id: "source-2",
      waba_subscription_status: "subscribed",
    });
    expect(body.results[1].failed).toBeUndefined();
  });

  it("deduplicates provider work for duplicate sources while persisting each source truthfully", async () => {
    mockGetWabaWebhookSubscriptionStatus.mockResolvedValue({
      subscribed: false,
      fields: [],
      missingRequiredFields: ["messages"],
      missingOptionalFields: [],
      coverageOk: false,
      actionable: "Enable missing fields",
    });
    mockSubscribeToWABAWebhooks.mockResolvedValue({
      success: true,
      subscribedFields: COMPLETE_CLOUD_WEBHOOK_FIELDS,
      missingRequiredFields: [],
      missingOptionalFields: [],
      coverageOk: true,
    });
    const { update } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "shared-access-token",
          token_expires_at: "2026-05-14T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          webhook_subscribed: false,
          waba_subscription_consecutive_failures: 2,
        },
      },
      {
        id: "source-2",
        workspace_id: "workspace-2",
        credentials: {
          access_token: "shared-access-token",
          token_expires_at: "2026-05-14T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          webhook_subscribed: false,
          waba_subscription_consecutive_failures: 1,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGraphGetJson).toHaveBeenCalledTimes(1);
    expect(mockGetPhoneNumberDetails).toHaveBeenCalledTimes(1);
    expect(mockGetWabaWebhookSubscriptionStatus).toHaveBeenCalledTimes(1);
    expect(mockSubscribeToWABAWebhooks).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(2);
    expect(body.summary).toMatchObject({
      checked: 2,
      waba_subscribed: 2,
      waba_unknown: 0,
      token_refreshed: 2,
      auto_fixed: 2,
      failed: 0,
    });
    expect(body.results).toEqual([
      expect.objectContaining({
        source_id: "source-1",
        waba_subscription_status: "subscribed",
        token_refreshed: true,
        auto_fixed: true,
      }),
      expect.objectContaining({
        source_id: "source-2",
        waba_subscription_status: "subscribed",
        token_refreshed: true,
        auto_fixed: true,
      }),
    ]);

    const persistedCredentials = update.mock.calls.map(
      call => (call[0] as { credentials: Record<string, unknown> }).credentials
    );
    expect(persistedCredentials).toEqual([
      expect.objectContaining({
        webhook_subscribed: true,
        waba_subscription_consecutive_failures: 0,
        meta_diagnostics_last_success_at: "2026-05-11T00:00:00.000Z",
      }),
      expect.objectContaining({
        webhook_subscribed: true,
        waba_subscription_consecutive_failures: 0,
        meta_diagnostics_last_success_at: "2026-05-11T00:00:00.000Z",
      }),
    ]);
    expect(
      mockUpdateCurrentWhatsAppSourceCredentialsFromSnapshot.mock.calls.map(
        ([params]) => ({
          sourceId: params.sourceId,
          expectedPhoneNumberId: params.expectedPhoneNumberId,
        })
      )
    ).toEqual([
      { sourceId: "source-1", expectedPhoneNumberId: "phone-1" },
      { sourceId: "source-2", expectedPhoneNumberId: "phone-1" },
    ]);
  });

  it("memoizes a transient phone-read failure across duplicate source rows", async () => {
    mockCheckTokenExpiryAndAlert.mockResolvedValue({
      isExpired: false,
      daysUntilExpiry: 30,
      alertSent: false,
    });
    mockGetPhoneNumberDetails.mockRejectedValue(
      new Error("temporary phone diagnostics failure")
    );
    mockSourcesQuery(
      duplicateWhatsAppSources({
        access_token: "shared-access-token",
        token_expires_at: "2026-06-10T00:00:00.000Z",
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        webhook_subscribed: true,
      })
    );

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetPhoneNumberDetails).toHaveBeenCalledTimes(1);
    expect(mockGetWabaWebhookSubscriptionStatus).toHaveBeenCalledTimes(1);
    expect(body.results).toEqual([
      expect.objectContaining({
        error: expect.stringContaining("temporary phone diagnostics failure"),
      }),
      expect.objectContaining({
        error: expect.stringContaining("temporary phone diagnostics failure"),
      }),
    ]);
  });

  it("memoizes an unknown WABA read across duplicate source rows", async () => {
    mockCheckTokenExpiryAndAlert.mockResolvedValue({
      isExpired: false,
      daysUntilExpiry: 30,
      alertSent: false,
    });
    mockGetWabaWebhookSubscriptionStatus.mockRejectedValue(
      new Error("temporary WABA diagnostics failure")
    );
    mockSourcesQuery(
      duplicateWhatsAppSources({
        access_token: "shared-access-token",
        token_expires_at: "2026-06-10T00:00:00.000Z",
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        webhook_subscribed: true,
      })
    );

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetPhoneNumberDetails).toHaveBeenCalledTimes(1);
    expect(mockGetWabaWebhookSubscriptionStatus).toHaveBeenCalledTimes(1);
    expect(mockSubscribeToWABAWebhooks).not.toHaveBeenCalled();
    expect(body.results).toEqual([
      expect.objectContaining({
        waba_subscription_status: "unknown",
        error: expect.stringContaining("temporary WABA diagnostics failure"),
      }),
      expect.objectContaining({
        waba_subscription_status: "unknown",
        error: expect.stringContaining("temporary WABA diagnostics failure"),
      }),
    ]);
  });

  it("memoizes a transient repair failure across duplicate source rows", async () => {
    mockCheckTokenExpiryAndAlert.mockResolvedValue({
      isExpired: false,
      daysUntilExpiry: 30,
      alertSent: false,
    });
    mockGetWabaWebhookSubscriptionStatus.mockResolvedValue({
      subscribed: false,
      fields: [],
      missingRequiredFields: ["messages"],
      missingOptionalFields: [],
      coverageOk: false,
      actionable: "Enable missing fields",
    });
    mockSubscribeToWABAWebhooks.mockResolvedValue({
      success: false,
      error: "Temporary Meta gateway failure",
      status: 503,
    });
    mockSourcesQuery(
      duplicateWhatsAppSources({
        access_token: "shared-access-token",
        token_expires_at: "2026-06-10T00:00:00.000Z",
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        webhook_subscribed: false,
      })
    );

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetPhoneNumberDetails).toHaveBeenCalledTimes(1);
    expect(mockGetWabaWebhookSubscriptionStatus).toHaveBeenCalledTimes(1);
    expect(mockSubscribeToWABAWebhooks).toHaveBeenCalledTimes(1);
    expect(body.results).toEqual([
      expect.objectContaining({
        error: expect.stringContaining("Temporary Meta gateway failure"),
      }),
      expect.objectContaining({
        error: expect.stringContaining("Temporary Meta gateway failure"),
      }),
    ]);
  });

  it("does not reuse token exchange across different token identities", async () => {
    mockGraphGetJson
      .mockReset()
      .mockResolvedValueOnce({
        access_token: "renewed-token-a",
        expires_in: 60 * 24 * 60 * 60,
      })
      .mockResolvedValueOnce({
        access_token: "renewed-token-b",
        expires_in: 60 * 24 * 60 * 60,
      });
    mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "access-token-a",
          token_expires_at: "2026-05-14T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          webhook_subscribed: true,
        },
      },
      {
        id: "source-2",
        workspace_id: "workspace-2",
        credentials: {
          access_token: "access-token-b",
          token_expires_at: "2026-05-14T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          webhook_subscribed: true,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );

    expect(response.status).toBe(200);
    expect(mockGraphGetJson).toHaveBeenCalledTimes(2);
    expect(mockGetPhoneNumberDetails).toHaveBeenCalledTimes(2);
    expect(mockGetWabaWebhookSubscriptionStatus).toHaveBeenCalledTimes(2);
  });

  it("does not let a valid duplicate source mask a revoked token", async () => {
    mockCheckTokenExpiryAndAlert.mockResolvedValue({
      isExpired: false,
      daysUntilExpiry: 30,
      alertSent: false,
    });
    const authorizationError = Object.assign(
      new Error("Invalid access token"),
      {
        status: 401,
        metaError: {
          type: "OAuthException",
          code: 190,
          message: "Invalid access token",
        },
      }
    );
    mockGetPhoneNumberDetails
      .mockResolvedValueOnce({
        code_verification_status: "VERIFIED",
        platform_type: "CLOUD_API",
        is_on_biz_app: false,
        display_phone_number: "+15551234567",
        verified_name: "Airi",
        quality_rating: "GREEN",
        name_status: "APPROVED",
      })
      .mockRejectedValueOnce(authorizationError);
    mockGetWabaWebhookSubscriptionStatus
      .mockResolvedValueOnce({
        subscribed: true,
        fields: COMPLETE_CLOUD_WEBHOOK_FIELDS,
        missingRequiredFields: [],
        missingOptionalFields: [],
        coverageOk: true,
        actionable: null,
      })
      .mockRejectedValueOnce(authorizationError);
    const { update } = mockSourcesQuery([
      {
        id: "source-valid",
        workspace_id: "workspace-valid",
        credentials: {
          access_token: "valid-token",
          token_expires_at: "2026-06-10T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          webhook_subscribed: true,
        },
      },
      {
        id: "source-revoked",
        workspace_id: "workspace-revoked",
        credentials: {
          access_token: "revoked-token",
          token_expires_at: "2026-06-10T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          webhook_subscribed: true,
          meta_diagnostics_last_success_at: "2026-05-10T00:00:00.000Z",
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetPhoneNumberDetails).toHaveBeenCalledTimes(2);
    expect(mockGetWabaWebhookSubscriptionStatus).toHaveBeenCalledTimes(1);
    expect(body.results[1]).toMatchObject({
      source_id: "source-revoked",
      waba_subscription_status: "unknown",
      skipped_reason: "reconnection_required",
      error: expect.stringContaining("Invalid access token"),
    });
    const persistedCredentials = update.mock.calls.map(
      call => (call[0] as { credentials: Record<string, unknown> }).credentials
    );
    expect(persistedCredentials[0].meta_diagnostics_last_success_at).toBe(
      "2026-05-11T00:00:00.000Z"
    );
    expect(persistedCredentials[1]).toMatchObject({
      meta_diagnostics_last_success_at: "2026-05-10T00:00:00.000Z",
      meta_diagnostics_last_attempt_at: "2026-05-11T00:00:00.000Z",
      webhook_requires_reconnect: true,
      webhook_error: expect.stringContaining("Invalid access token"),
      phone_webhook_error: expect.stringContaining("Invalid access token"),
    });
  });

  it("marks the source for reconnection when the WABA read loses authorization", async () => {
    mockCheckTokenExpiryAndAlert.mockResolvedValue({
      isExpired: false,
      daysUntilExpiry: 30,
      alertSent: false,
    });
    const authorizationError = Object.assign(
      new Error("WABA is inaccessible"),
      {
        status: 400,
        metaError: {
          type: "GraphMethodException",
          code: 100,
          error_subcode: 33,
          message: "WABA is inaccessible",
        },
      }
    );
    mockGetWabaWebhookSubscriptionStatus.mockRejectedValueOnce(
      authorizationError
    );
    const { update } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "revoked-token",
          token_expires_at: "2026-06-10T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          webhook_subscribed: true,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetPhoneNumberDetails).toHaveBeenCalledTimes(1);
    expect(mockGetWabaWebhookSubscriptionStatus).toHaveBeenCalledTimes(1);
    expect(mockSubscribeToWABAWebhooks).not.toHaveBeenCalled();
    expect(body.summary).toMatchObject({
      failed: 1,
      critical_issues: 1,
    });
    expect(body.results[0]).toMatchObject({
      waba_subscription_status: "unknown",
      skipped_reason: "reconnection_required",
      error: expect.stringContaining("WABA is inaccessible"),
    });
    const persistedCredentials = update.mock.calls[0][0].credentials as Record<
      string,
      unknown
    >;
    expect(persistedCredentials).toMatchObject({
      webhook_requires_reconnect: true,
      webhook_error: expect.stringContaining("WABA is inaccessible"),
      meta_diagnostics_last_attempt_at: "2026-05-11T00:00:00.000Z",
    });
    expect(persistedCredentials).not.toHaveProperty("phone_webhook_error");
    expect(persistedCredentials).not.toHaveProperty(
      "meta_diagnostics_last_success_at"
    );
  });

  it("memoizes terminal authorization per token and persists every duplicate source without repeated calls", async () => {
    mockCheckTokenExpiryAndAlert.mockResolvedValue({
      isExpired: false,
      daysUntilExpiry: 30,
      alertSent: false,
    });
    const authorizationError = Object.assign(
      new Error("Invalid access token"),
      {
        status: 401,
        metaError: {
          type: "OAuthException",
          code: 190,
          message: "Invalid access token",
        },
      }
    );
    mockGetPhoneNumberDetails.mockRejectedValueOnce(authorizationError);
    const { update } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-revoked-token",
          token_expires_at: "2026-06-10T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          webhook_subscribed: true,
        },
      },
      {
        id: "source-2",
        workspace_id: "workspace-2",
        credentials: {
          access_token: "same-revoked-token",
          token_expires_at: "2026-06-10T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          webhook_subscribed: true,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetPhoneNumberDetails).toHaveBeenCalledTimes(1);
    expect(mockGetWabaWebhookSubscriptionStatus).not.toHaveBeenCalled();
    expect(body.status).toBe("degraded");
    expect(body.summary.failed).toBe(2);
    expect(body.results).toEqual([
      expect.objectContaining({ skipped_reason: "reconnection_required" }),
      expect.objectContaining({ skipped_reason: "reconnection_required" }),
    ]);
    expect(update).toHaveBeenCalledTimes(2);
    for (const [payload] of update.mock.calls) {
      expect(payload.credentials).toMatchObject({
        webhook_requires_reconnect: true,
        webhook_error: expect.stringContaining("Invalid access token"),
      });
    }
  });

  it.each([
    { failure: "authorization", status: 401, code: 190 },
    { failure: "throttling", status: 400, code: 4 },
  ])(
    "opens a run-level platform circuit when configured-app $failure fails",
    async ({ status, code }) => {
      mockCheckTokenExpiryAndAlert.mockResolvedValue({
        isExpired: false,
        daysUntilExpiry: 30,
        alertSent: false,
      });
      const configuredAppError = Object.assign(
        new Error("Invalid configured app token"),
        {
          status,
          metaError: {
            type: "OAuthException",
            code,
            message: "Invalid configured app token",
          },
          metaCredentialOwner: "configured_app",
        }
      );
      mockGetWabaWebhookSubscriptionStatus.mockRejectedValueOnce(
        configuredAppError
      );
      const { update } = mockSourcesQuery([
        {
          id: "source-1",
          workspace_id: "workspace-1",
          credentials: {
            access_token: "source-token-1",
            token_expires_at: "2026-06-10T00:00:00.000Z",
            waba_id: "waba-1",
            phone_number_id: "phone-1",
            webhook_subscribed: true,
          },
        },
        {
          id: "source-2",
          workspace_id: "workspace-2",
          credentials: {
            access_token: "source-token-2",
            token_expires_at: "2026-06-10T00:00:00.000Z",
            waba_id: "waba-2",
            phone_number_id: "phone-2",
            webhook_subscribed: true,
          },
        },
      ]);

      const { GET } = await import("./route");
      const response = await GET(
        new Request("https://example.com/api/cron/check-whatsapp-webhooks")
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(mockGetPhoneNumberDetails).toHaveBeenCalledTimes(1);
      expect(mockGetWabaWebhookSubscriptionStatus).toHaveBeenCalledTimes(1);
      expect(body.status).toBe("degraded");
      expect(body.summary).toMatchObject({ failed: 2, critical_issues: 1 });
      expect(body.summary.rate_limited).toBe(0);
      expect(body.results).toEqual([
        expect.objectContaining({
          skipped_reason: "provider_configuration_error",
        }),
        expect.objectContaining({
          skipped_reason: "provider_configuration_error",
        }),
      ]);
      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0][0].credentials).not.toHaveProperty(
        "webhook_requires_reconnect",
        true
      );
      expect(mockCacheSet).not.toHaveBeenCalled();
    }
  );

  it("reanalyzes memoized WABA fields for each source connection mode", async () => {
    mockCheckTokenExpiryAndAlert.mockResolvedValue({
      isExpired: false,
      daysUntilExpiry: 30,
      alertSent: false,
    });
    const cloudRequiredFields = COMPLETE_CLOUD_WEBHOOK_FIELDS;
    mockGetWabaWebhookSubscriptionStatus.mockResolvedValue({
      subscribed: true,
      fields: cloudRequiredFields,
      missingRequiredFields: [],
      missingOptionalFields: [],
      coverageOk: true,
      actionable: null,
    });
    mockSubscribeToWABAWebhooks.mockResolvedValue({
      success: true,
      subscribedFields: [
        ...cloudRequiredFields,
        "history",
        "smb_app_state_sync",
        "smb_message_echoes",
      ],
      missingRequiredFields: [],
      missingOptionalFields: [],
      coverageOk: true,
    });
    const { update } = mockSourcesQuery([
      {
        id: "source-cloud",
        workspace_id: "workspace-cloud",
        credentials: {
          access_token: "shared-token",
          token_expires_at: "2026-06-10T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-cloud",
          webhook_subscribed: true,
          coexistence_mode: false,
        },
      },
      {
        id: "source-coexistence",
        workspace_id: "workspace-coexistence",
        credentials: {
          access_token: "shared-token",
          token_expires_at: "2026-06-10T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-coexistence",
          webhook_subscribed: true,
          coexistence_mode: true,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.summary.warnings).toBe(1);
    expect(mockGetPhoneNumberDetails).toHaveBeenCalledTimes(2);
    expect(mockGetWabaWebhookSubscriptionStatus).toHaveBeenCalledTimes(1);
    expect(mockSubscribeToWABAWebhooks).not.toHaveBeenCalled();
    const persistedCredentials = update.mock.calls.map(
      call => (call[0] as { credentials: Record<string, unknown> }).credentials
    );
    expect(persistedCredentials[0]).toMatchObject({
      webhook_coverage_ok: true,
      webhook_missing_required_fields: [],
    });
    expect(persistedCredentials[1]).toMatchObject({
      coexistence_mode: true,
      webhook_coverage_ok: false,
      webhook_missing_required_fields: [
        "history",
        "smb_app_state_sync",
        "smb_message_echoes",
      ],
      waba_subscribed_fields: cloudRequiredFields,
    });
    expect(body.results[1]).toMatchObject({
      webhook_coverage_ok: false,
      error: expect.stringContaining("history"),
    });
  });

  it("keeps authorization failures token-scoped so a revoked source cannot block a valid source", async () => {
    mockCheckTokenExpiryAndAlert.mockResolvedValue({
      isExpired: false,
      daysUntilExpiry: 30,
      alertSent: false,
    });
    const authorizationError = Object.assign(
      new Error("Invalid access token"),
      {
        status: 401,
        metaError: {
          type: "OAuthException",
          code: 190,
          message: "Invalid access token",
        },
      }
    );
    mockGetPhoneNumberDetails
      .mockRejectedValueOnce(authorizationError)
      .mockResolvedValueOnce({
        code_verification_status: "VERIFIED",
        platform_type: "CLOUD_API",
        is_on_biz_app: false,
        display_phone_number: "+15551234567",
        verified_name: "Airi",
        quality_rating: "GREEN",
        name_status: "APPROVED",
      });
    mockGetWabaWebhookSubscriptionStatus.mockResolvedValueOnce({
      subscribed: true,
      fields: ["messages", "account_update", "calls"],
      missingRequiredFields: [],
      missingOptionalFields: [],
      coverageOk: true,
      actionable: null,
    });
    const { update } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "invalid-access-token",
          token_expires_at: "2026-06-10T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          webhook_subscribed: true,
        },
      },
      {
        id: "source-2",
        workspace_id: "workspace-2",
        credentials: {
          access_token: "valid-access-token",
          token_expires_at: "2026-06-10T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          webhook_subscribed: true,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetPhoneNumberDetails).toHaveBeenCalledTimes(2);
    expect(mockGetWabaWebhookSubscriptionStatus).toHaveBeenCalledTimes(1);
    expect(body.results[0]).toMatchObject({
      source_id: "source-1",
      waba_subscription_status: "unknown",
      skipped_reason: "reconnection_required",
    });
    expect(body.results[1]).toMatchObject({
      source_id: "source-2",
      waba_subscription_status: "subscribed",
    });
    const persistedCredentials = update.mock.calls.map(
      call => (call[0] as { credentials: Record<string, unknown> }).credentials
    );
    expect(persistedCredentials[0]).not.toHaveProperty(
      "meta_diagnostics_last_success_at"
    );
    expect(persistedCredentials[0]).toMatchObject({
      webhook_requires_reconnect: true,
      phone_webhook_error: expect.stringContaining("Invalid access token"),
    });
    expect(persistedCredentials[1]).toMatchObject({
      meta_diagnostics_last_success_at: "2026-05-11T00:00:00.000Z",
    });
  });

  it("skips every Meta call when another request owns the source diagnostics lock", async () => {
    mockCacheAcquireLock
      .mockResolvedValueOnce("acquired")
      .mockResolvedValueOnce("contended");
    const { update } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-05-14T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          webhook_subscribed: true,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGraphRequest).not.toHaveBeenCalled();
    expect(mockGraphGetJson).not.toHaveBeenCalled();
    expect(mockGetPhoneNumberDetails).not.toHaveBeenCalled();
    expect(mockGetWabaWebhookSubscriptionStatus).not.toHaveBeenCalled();
    expect(mockSubscribeToWABAWebhooks).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(body.results[0]).toMatchObject({
      skipped_reason: "provider_refresh_in_progress",
      waba_subscription_status: "unknown",
      waba_subscribed: true,
      phone_subscribed: true,
      token_refreshed: false,
      auto_fixed: false,
    });

    const [sourceLockKey, sourceLockToken, sourceLockTtlSeconds] =
      mockCacheAcquireLock.mock.calls[1];
    expect(sourceLockKey).toBe(
      "icecore:whatsapp:meta-read-lock:v1:waba:waba-1"
    );
    expect(sourceLockToken).toEqual(expect.any(String));
    expect(sourceLockTtlSeconds).toBe(15 * 60);
    expect(mockCacheCompareAndDelete).not.toHaveBeenCalledWith(
      sourceLockKey,
      sourceLockToken
    );
  });

  it("degrades without Meta calls when provider coordination is unavailable", async () => {
    mockCacheAcquireLock
      .mockResolvedValueOnce("acquired")
      .mockResolvedValueOnce("unavailable");
    const { update } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-05-14T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          webhook_subscribed: true,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.summary).toMatchObject({ warnings: 1, failed: 0 });
    expect(body.results[0]).toMatchObject({
      skipped_reason: "provider_coordination_unavailable",
      waba_subscription_status: "unknown",
      waba_subscribed: true,
    });
    expect(mockGraphGetJson).not.toHaveBeenCalled();
    expect(mockGetPhoneNumberDetails).not.toHaveBeenCalled();
    expect(mockGetWabaWebhookSubscriptionStatus).not.toHaveBeenCalled();
    expect(mockSubscribeToWABAWebhooks).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("honors the WABA-wide cooldown before token exchange or diagnostics", async () => {
    mockCacheGet.mockResolvedValueOnce("2026-05-11T00:05:00.000Z");
    const { update } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-05-14T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          webhook_subscribed: true,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockCacheGet).toHaveBeenCalledWith(
      "icecore:whatsapp:meta-read-cooldown:v1:waba:waba-1"
    );
    expect(mockGraphRequest).not.toHaveBeenCalled();
    expect(mockGraphGetJson).not.toHaveBeenCalled();
    expect(mockGetPhoneNumberDetails).not.toHaveBeenCalled();
    expect(mockGetWabaWebhookSubscriptionStatus).not.toHaveBeenCalled();
    expect(mockSubscribeToWABAWebhooks).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(body.summary.rate_limited).toBe(1);
    expect(body.results[0]).toMatchObject({
      skipped_reason: "rate_limit_cooldown",
      rate_limited: true,
      waba_subscription_status: "unknown",
      waba_subscribed: true,
    });
  });

  it("rechecks the WABA cooldown after acquiring the provider lock", async () => {
    mockCheckTokenExpiryAndAlert.mockResolvedValueOnce({
      isExpired: false,
      daysUntilExpiry: 30,
      alertSent: false,
    });
    mockCacheGet
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("2026-05-11T00:05:00.000Z");
    const { update } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-06-10T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          webhook_subscribed: true,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockCacheGet).toHaveBeenCalledTimes(2);
    expect(mockGraphGetJson).not.toHaveBeenCalled();
    expect(mockGetPhoneNumberDetails).not.toHaveBeenCalled();
    expect(mockGetWabaWebhookSubscriptionStatus).not.toHaveBeenCalled();
    expect(mockSubscribeToWABAWebhooks).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(body.summary.rate_limited).toBe(1);
    expect(body.results[0]).toMatchObject({
      skipped_reason: "rate_limit_cooldown",
      rate_limited: true,
      waba_subscription_status: "unknown",
      waba_subscribed: true,
    });

    const [sourceLockKey, sourceLockToken] = mockCacheAcquireLock.mock.calls[1];
    expect(mockCacheCompareAndDelete).toHaveBeenCalledWith(
      sourceLockKey,
      sourceLockToken
    );
  });

  it("opens the WABA cooldown and stops fan-out when token exchange is rate-limited", async () => {
    const rateLimitError = Object.assign(
      new Error("Too many calls to this WhatsApp Business account"),
      {
        status: 429,
        metaError: {
          type: "OAuthException",
          code: 80008,
          message: "Too many calls to this WhatsApp Business account",
        },
      }
    );
    mockGraphGetJson.mockReset().mockRejectedValueOnce(rateLimitError);
    const { update } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-05-14T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          webhook_subscribed: true,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetPhoneNumberDetails).not.toHaveBeenCalled();
    expect(mockGetWabaWebhookSubscriptionStatus).not.toHaveBeenCalled();
    expect(mockSubscribeToWABAWebhooks).not.toHaveBeenCalled();
    expect(body.summary.rate_limited).toBe(1);
    expect(body.results[0]).toMatchObject({
      rate_limited: true,
      waba_subscription_status: "unknown",
      waba_subscribed: true,
    });
    const updateCalls = update.mock.calls as unknown as Array<
      [{ credentials: Record<string, unknown> }]
    >;
    expect(updateCalls[0][0].credentials).toMatchObject({
      webhook_subscribed: true,
      meta_diagnostics_last_attempt_at: "2026-05-11T00:00:00.000Z",
      meta_diagnostics_last_error_code: "80008",
      meta_diagnostics_cooldown_until: "2026-05-11T00:05:00.000Z",
    });
    expect(mockCacheSet).toHaveBeenCalledWith(
      "icecore:whatsapp:meta-read-cooldown:v1:waba:waba-1",
      "2026-05-11T00:05:00.000Z",
      5 * 60
    );
  });

  it("continues WABA-wide exponential backoff from the highest duplicate-source counter", async () => {
    const rateLimitError = Object.assign(new Error("Too many calls"), {
      status: 429,
      metaError: {
        type: "OAuthException",
        code: 80008,
        message: "Too many calls",
      },
    });
    mockGraphGetJson.mockReset().mockRejectedValueOnce(rateLimitError);
    const { update } = mockSourcesQuery([
      {
        id: "source-with-low-counter",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-05-14T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          webhook_subscribed: true,
          meta_diagnostics_consecutive_rate_limits: 0,
        },
      },
      {
        id: "source-with-high-counter",
        workspace_id: "workspace-2",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-05-14T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-2",
          webhook_subscribed: true,
          meta_diagnostics_consecutive_rate_limits: 4,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(mockGraphGetJson).toHaveBeenCalledTimes(1);
    expect(mockGetPhoneNumberDetails).not.toHaveBeenCalled();
    expect(body.summary.rate_limited).toBe(2);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].credentials).toMatchObject({
      meta_diagnostics_consecutive_rate_limits: 5,
      meta_diagnostics_cooldown_until: "2026-05-11T01:20:00.000Z",
    });
    expect(mockCacheSet).toHaveBeenCalledWith(
      "icecore:whatsapp:meta-read-cooldown:v1:waba:waba-1",
      "2026-05-11T01:20:00.000Z",
      80 * 60
    );
  });

  it("continues with a still-valid token after a generic exchange failure without advancing freshness", async () => {
    mockGraphGetJson
      .mockReset()
      .mockRejectedValueOnce(
        Object.assign(new Error("temporary failure"), { status: 500 })
      );
    const { update } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-05-14T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          webhook_subscribed: true,
          diagnostics_last_checked_at: "2026-05-10T12:00:00.000Z",
          meta_diagnostics_last_success_at: "2026-05-10T12:00:00.000Z",
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );

    expect(response.status).toBe(200);
    expect(mockGetPhoneNumberDetails).toHaveBeenCalledTimes(1);
    expect(mockGetWabaWebhookSubscriptionStatus).toHaveBeenCalledTimes(1);
    const updateCalls = update.mock.calls as unknown as Array<
      [{ credentials: Record<string, unknown> }]
    >;
    expect(updateCalls[0][0].credentials).toMatchObject({
      diagnostics_last_checked_at: "2026-05-10T12:00:00.000Z",
      meta_diagnostics_last_success_at: "2026-05-10T12:00:00.000Z",
      meta_diagnostics_last_attempt_at: "2026-05-11T00:00:00.000Z",
    });
  });

  it("attributes ambiguous token-exchange authorization to the configured app", async () => {
    const authorizationError = Object.assign(
      new Error("Invalid access token"),
      {
        status: 401,
        metaError: {
          type: "OAuthException",
          code: 190,
          message: "Invalid access token",
        },
        formattedError: {
          requiresReconnect: true,
        },
      }
    );
    mockGraphGetJson.mockReset().mockRejectedValueOnce(authorizationError);
    const { update } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-05-14T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          webhook_subscribed: true,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetPhoneNumberDetails).not.toHaveBeenCalled();
    expect(mockGetWabaWebhookSubscriptionStatus).not.toHaveBeenCalled();
    expect(mockSubscribeToWABAWebhooks).not.toHaveBeenCalled();
    expect(body.results[0]).toMatchObject({
      token_expired: false,
      waba_subscription_status: "unknown",
      waba_subscribed: true,
      skipped_reason: "provider_configuration_error",
    });
    expect(body.summary.critical_issues).toBe(1);
    expect(body.critical_issues[0]).toContain(
      "Platform Meta app diagnostics failed during token renewal"
    );
    expect(update.mock.calls[0][0].credentials).toMatchObject({
      access_token: "same-access-token",
      token_is_valid: true,
      token_maintenance_status: "retrying",
      webhook_subscribed: true,
    });
    expect(update.mock.calls[0][0].credentials).not.toHaveProperty(
      "webhook_requires_reconnect"
    );
  });

  it("fails the run-level platform circuit when token renewal app configuration is missing", async () => {
    delete process.env.META_APP_ID;
    delete process.env.NEXT_PUBLIC_META_APP_ID;
    delete process.env.META_APP_SECRET;
    const { update } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-05-14T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          webhook_subscribed: true,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGraphGetJson).not.toHaveBeenCalled();
    expect(mockGetPhoneNumberDetails).not.toHaveBeenCalled();
    expect(mockGetWabaWebhookSubscriptionStatus).not.toHaveBeenCalled();
    expect(body.results[0]).toMatchObject({
      waba_subscription_status: "unknown",
      skipped_reason: "provider_configuration_error",
    });
    expect(body.critical_issues).toEqual([
      expect.stringContaining("Meta server app ID is not configured"),
    ]);
    expect(update.mock.calls[0][0].credentials).toMatchObject({
      access_token: "same-access-token",
      token_maintenance_status: "retrying",
      webhook_subscribed: true,
    });
    expect(update.mock.calls[0][0].credentials).not.toHaveProperty(
      "token_verified_at"
    );
    expect(mockCheckTokenExpiryAndAlert).not.toHaveBeenCalled();
  });

  it("treats a rate-limited WABA read as unknown and never attempts repair", async () => {
    const rateLimitError = Object.assign(
      new Error("Meta Graph API request failed"),
      {
        status: 429,
        metaError: {
          type: "OAuthException",
          code: 80008,
          message: "Too many calls to this WhatsApp Business account",
        },
      }
    );
    mockGetPhoneNumberDetails.mockRejectedValueOnce(rateLimitError);
    mockGetWabaWebhookSubscriptionStatus.mockRejectedValueOnce(rateLimitError);
    const { update } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-05-14T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          embedded_signup: true,
          webhook_subscribed: true,
          waba_subscription_consecutive_failures: 2,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockSubscribeToWABAWebhooks).not.toHaveBeenCalled();
    expect(mockGetWabaWebhookSubscriptionStatus).not.toHaveBeenCalled();
    expect(body.summary.rate_limited).toBe(1);
    expect(body.summary).toMatchObject({
      waba_subscribed: 0,
      waba_unknown: 1,
      waba_last_known_subscribed: 1,
    });
    expect(body.summary.critical_issues).toBe(0);
    expect(body.results[0]).toMatchObject({
      waba_subscription_status: "unknown",
      rate_limited: true,
    });
    const updateCalls = update.mock.calls as unknown as Array<
      [{ credentials: Record<string, unknown> }]
    >;
    expect(updateCalls[0][0].credentials).toMatchObject({
      webhook_subscribed: true,
      waba_subscription_consecutive_failures: 2,
      meta_diagnostics_consecutive_rate_limits: 1,
      meta_diagnostics_last_error_code: "80008",
      meta_diagnostics_cooldown_until: "2026-05-11T00:05:00.000Z",
    });
    expect(mockCacheSet).toHaveBeenCalledWith(
      "icecore:whatsapp:meta-read-cooldown:v1:waba:waba-1",
      "2026-05-11T00:05:00.000Z",
      5 * 60
    );
  });

  it("preserves webhook state when a non-rate-limit subscription read fails", async () => {
    mockGetWabaWebhookSubscriptionStatus.mockRejectedValueOnce(
      new Error("temporary network failure")
    );
    const { update } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-05-14T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          embedded_signup: true,
          webhook_subscribed: true,
          waba_subscription_consecutive_failures: 2,
          diagnostics_last_checked_at: "2026-05-10T12:00:00.000Z",
          meta_diagnostics_last_success_at: "2026-05-10T12:00:00.000Z",
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockSubscribeToWABAWebhooks).not.toHaveBeenCalled();
    expect(body.summary.critical_issues).toBe(0);
    expect(body.results[0]).toMatchObject({
      waba_subscription_status: "unknown",
      waba_subscribed: true,
    });
    const updateCalls = update.mock.calls as unknown as Array<
      [{ credentials: Record<string, unknown> }]
    >;
    expect(updateCalls[0][0].credentials).toMatchObject({
      webhook_subscribed: true,
      waba_subscription_consecutive_failures: 2,
      diagnostics_last_checked_at: "2026-05-10T12:00:00.000Z",
      meta_diagnostics_last_success_at: "2026-05-10T12:00:00.000Z",
      meta_diagnostics_last_attempt_at: "2026-05-11T00:00:00.000Z",
    });
    const [sourceLockKey, sourceLockToken, sourceLockTtlSeconds] =
      mockCacheAcquireLock.mock.calls[1];
    expect(sourceLockKey).toBe(
      "icecore:whatsapp:meta-read-lock:v1:waba:waba-1"
    );
    expect(sourceLockTtlSeconds).toBe(15 * 60);
    expect(mockCacheCompareAndDelete).toHaveBeenCalledWith(
      sourceLockKey,
      sourceLockToken
    );
  });

  it("does not advance provider freshness when phone diagnostics fail", async () => {
    mockCheckTokenExpiryAndAlert.mockResolvedValueOnce({
      isExpired: false,
      daysUntilExpiry: 30,
      alertSent: false,
    });
    mockGetPhoneNumberDetails.mockRejectedValueOnce(
      new Error("temporary phone diagnostics failure")
    );
    const { update } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-06-10T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          webhook_subscribed: true,
          diagnostics_last_checked_at: "2026-05-10T12:00:00.000Z",
          meta_diagnostics_last_success_at: "2026-05-10T12:00:00.000Z",
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.summary).toMatchObject({
      warnings: 1,
      failed: 0,
      critical_issues: 0,
    });
    expect(body.results[0]).toMatchObject({
      waba_subscription_status: "subscribed",
      error:
        "Could not fetch phone details: temporary phone diagnostics failure",
    });
    const updateCalls = update.mock.calls as unknown as Array<
      [{ credentials: Record<string, unknown> }]
    >;
    expect(updateCalls[0][0].credentials).toMatchObject({
      diagnostics_last_checked_at: "2026-05-10T12:00:00.000Z",
      meta_diagnostics_last_success_at: "2026-05-10T12:00:00.000Z",
      meta_diagnostics_last_attempt_at: "2026-05-11T00:00:00.000Z",
      webhook_subscribed: true,
    });
  });

  it("honors a persisted Meta cooldown without making another provider call", async () => {
    mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-05-14T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          webhook_subscribed: true,
          meta_diagnostics_cooldown_until: "2026-05-11T00:05:00.000Z",
          meta_diagnostics_consecutive_rate_limits: 1,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGraphRequest).not.toHaveBeenCalled();
    expect(mockGraphGetJson).not.toHaveBeenCalled();
    expect(mockGetPhoneNumberDetails).not.toHaveBeenCalled();
    expect(mockGetWabaWebhookSubscriptionStatus).not.toHaveBeenCalled();
    expect(body.summary.rate_limited).toBe(1);
    expect(body.results[0]).toMatchObject({
      skipped_reason: "rate_limit_cooldown",
      waba_subscription_status: "unknown",
      waba_subscribed: true,
    });
  });

  it("preseeds a WABA cooldown from every source before provider fan-out", async () => {
    mockCheckTokenExpiryAndAlert.mockResolvedValue({
      isExpired: false,
      daysUntilExpiry: 30,
      alertSent: false,
    });
    mockSourcesQuery([
      {
        id: "source-before-cooldown-row",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-06-10T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          webhook_subscribed: true,
        },
      },
      {
        id: "source-with-cooldown",
        workspace_id: "workspace-2",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-06-10T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-2",
          webhook_subscribed: true,
          meta_diagnostics_cooldown_until: "2026-05-11T00:05:00.000Z",
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockCacheGet).toHaveBeenCalledTimes(1);
    expect(mockGraphGetJson).not.toHaveBeenCalled();
    expect(mockGetPhoneNumberDetails).not.toHaveBeenCalled();
    expect(mockGetWabaWebhookSubscriptionStatus).not.toHaveBeenCalled();
    expect(body.summary.rate_limited).toBe(2);
    expect(body.results).toEqual([
      expect.objectContaining({ skipped_reason: "rate_limit_cooldown" }),
      expect.objectContaining({ skipped_reason: "rate_limit_cooldown" }),
    ]);
  });

  it("does not report refreshed state when a concurrent phone rebind wins the persistence fence", async () => {
    mockGraphGetJson.mockReset().mockResolvedValueOnce({
      access_token: "renewed-access-token",
      expires_in: 60 * 24 * 60 * 60,
    });
    mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-05-14T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          embedded_signup: true,
        },
      },
    ]);
    mockUpdateCurrentWhatsAppSourceCredentialsFromSnapshot.mockRejectedValueOnce(
      new Error("WhatsApp source phone changed concurrently")
    );

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.summary.token_refreshed).toBe(0);
    expect(body.summary.failed).toBe(1);
    expect(body.summary.critical_issues).toBe(1);
    expect(body.status).toBe("degraded");
    expect(body.results[0]).toMatchObject({
      token_refreshed: false,
      persistence_failed: true,
    });
    expect(
      mockUpdateCurrentWhatsAppSourceCredentialsFromSnapshot
    ).toHaveBeenCalledWith(
      expect.objectContaining({ expectedPhoneNumberId: "phone-1" })
    );
  });

  it("skips live subscription probes for sources already requiring reconnection", async () => {
    mockCheckTokenExpiryAndAlert.mockResolvedValueOnce({
      isExpired: false,
      daysUntilExpiry: 30,
      alertSent: false,
    });
    mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-06-10T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          embedded_signup: true,
          webhook_subscribed: false,
          webhook_requires_reconnect: true,
          waba_subscription_permanently_failed: true,
          meta_diagnostics_reconnect_reason: "meta_authorization",
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGraphRequest).not.toHaveBeenCalled();
    expect(mockGraphGetJson).not.toHaveBeenCalled();
    expect(mockGetPhoneNumberDetails).not.toHaveBeenCalled();
    expect(mockGetWabaWebhookSubscriptionStatus).not.toHaveBeenCalled();
    expect(mockSubscribeToWABAWebhooks).not.toHaveBeenCalled();
    expect(body.results[0]).toMatchObject({
      skipped_reason: "reconnection_required",
    });
  });

  it("revalidates and heals reconnect flags written by the legacy transient-failure policy", async () => {
    mockCheckTokenExpiryAndAlert.mockResolvedValueOnce({
      isExpired: false,
      daysUntilExpiry: 30,
      alertSent: false,
    });
    const { update } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-06-10T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          embedded_signup: true,
          webhook_subscribed: false,
          webhook_requires_reconnect: true,
          waba_subscription_permanently_failed: true,
          waba_subscription_consecutive_failures: 3,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetPhoneNumberDetails).toHaveBeenCalledTimes(1);
    expect(mockGetWabaWebhookSubscriptionStatus).toHaveBeenCalledTimes(1);
    expect(body.results[0]).toMatchObject({
      waba_subscription_status: "subscribed",
    });
    expect(body.results[0].failed).toBeUndefined();
    const updateCalls = update.mock.calls as unknown as Array<
      [{ credentials: Record<string, unknown> }]
    >;
    expect(updateCalls[0][0].credentials).toMatchObject({
      webhook_requires_reconnect: false,
      waba_subscription_permanently_failed: false,
      waba_subscription_consecutive_failures: 0,
      meta_diagnostics_reconnect_reason: null,
    });
  });

  it("repairs co-existence mode from live Business App phone details before checking WABA coverage", async () => {
    mockGetPhoneNumberDetails.mockResolvedValueOnce({
      code_verification_status: "NOT_VERIFIED",
      platform_type: "CLOUD_API",
      is_on_biz_app: true,
      display_phone_number: "+77073379206",
      verified_name: "Demoshop Group",
      quality_rating: "GREEN",
      name_status: "APPROVED",
    });
    const { update } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-07-10T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          embedded_signup: true,
          embedded_signup_flow: "cloud_api",
          coexistence_mode: false,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );

    expect(response.status).toBe(200);
    expect(mockGetWabaWebhookSubscriptionStatus).toHaveBeenCalledWith(
      "waba-1",
      "same-access-token",
      { coexistenceMode: true }
    );
    const updateCalls = update.mock.calls as unknown as Array<
      [{ credentials: Record<string, unknown> }]
    >;
    const updatePayload = updateCalls[0][0];
    expect(updatePayload.credentials).toMatchObject({
      phone_registration_status: "REGISTERED",
      platform_type: "CLOUD_API",
      is_on_biz_app: true,
      coexistence_mode: true,
      partner_app_installed: true,
      partner_app_installed_at: expect.any(String),
    });
  });

  it("keeps an offboarded coexistence source disconnected after live phone details", async () => {
    mockGetPhoneNumberDetails.mockResolvedValueOnce({
      code_verification_status: "NOT_VERIFIED",
      platform_type: "CLOUD_API",
      is_on_biz_app: true,
      display_phone_number: "+77067040359",
      verified_name: "EduKey",
      quality_rating: "YELLOW",
      name_status: "NON_EXISTS",
    });
    const { update } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-07-10T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          embedded_signup: true,
          coexistence_mode: true,
          partner_app_installed: false,
          partner_app_installed_at: "2026-05-28T15:51:18.811Z",
          cloud_api_messaging_suspended: true,
          coexistence_reonboarding_status: "offboarded",
          coexistence_reonboarding_event: "ACCOUNT_OFFBOARDED",
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );

    expect(response.status).toBe(200);
    const updateCalls = update.mock.calls as unknown as Array<
      [{ credentials: Record<string, unknown> }]
    >;
    const updatePayload = updateCalls[0][0];
    expect(updatePayload.credentials).toMatchObject({
      is_on_biz_app: true,
      coexistence_mode: true,
      partner_app_installed: false,
      partner_app_installed_at: "2026-05-28T15:51:18.811Z",
      coexistence_reonboarding_status: "offboarded",
    });
  });

  it("keeps coexistence webhook coverage when auto-fixing a lost WABA subscription", async () => {
    mockGetWabaWebhookSubscriptionStatus.mockResolvedValueOnce({
      subscribed: false,
      fields: [],
      missingRequiredFields: [
        "messages",
        "account_update",
        "history",
        "smb_app_state_sync",
        "smb_message_echoes",
      ],
      missingOptionalFields: [],
      coverageOk: false,
      actionable: "Enable missing fields",
    });
    mockSubscribeToWABAWebhooks.mockResolvedValueOnce({
      success: true,
      subscribedFields: [
        ...COMPLETE_CLOUD_WEBHOOK_FIELDS,
        "history",
        "smb_app_state_sync",
        "smb_message_echoes",
      ],
      missingRequiredFields: [],
      missingOptionalFields: [],
      coverageOk: true,
    });
    const { update } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-05-14T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          embedded_signup: true,
          coexistence_mode: true,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );

    expect(response.status).toBe(200);
    expect(mockSubscribeToWABAWebhooks).toHaveBeenCalledWith(
      "waba-1",
      "same-access-token",
      { coexistenceMode: true }
    );
    const updateCalls = update.mock.calls as unknown as Array<
      [{ credentials: Record<string, unknown> }]
    >;
    expect(updateCalls[0][0].credentials).toMatchObject({
      webhook_subscribed: true,
      webhook_coverage_ok: true,
      webhook_missing_required_fields: [],
      waba_subscribed_fields: [
        ...COMPLETE_CLOUD_WEBHOOK_FIELDS,
        "history",
        "smb_app_state_sync",
        "smb_message_echoes",
      ],
    });
  });

  it("requires reconnection immediately when repair confirms terminal authorization failure", async () => {
    mockGetWabaWebhookSubscriptionStatus.mockResolvedValueOnce({
      subscribed: false,
      fields: [],
      missingRequiredFields: ["messages"],
      missingOptionalFields: [],
      coverageOk: false,
      actionable: "Enable missing fields",
    });
    mockSubscribeToWABAWebhooks.mockResolvedValueOnce({
      success: false,
      error: "Permissions error",
      formattedError: { requiresReconnect: true },
    });
    const { update } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-05-14T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          embedded_signup: true,
          waba_subscription_consecutive_failures: 0,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.summary.critical_issues).toBe(1);
    expect(body.critical_issues[0]).toContain("attempt 1");
    expect(body.critical_issues[0]).toContain("requires reconnection");
    const updateCalls = update.mock.calls as unknown as Array<
      [{ credentials: Record<string, unknown> }]
    >;
    expect(updateCalls[0][0].credentials).toMatchObject({
      waba_subscription_consecutive_failures: 1,
      waba_subscription_permanently_failed: true,
      webhook_requires_reconnect: true,
      meta_diagnostics_reconnect_reason: "meta_authorization",
    });
  });

  it("never turns repeated transient repair failures into permanent customer lockout", async () => {
    mockGetWabaWebhookSubscriptionStatus.mockResolvedValueOnce({
      subscribed: false,
      fields: [],
      missingRequiredFields: ["messages"],
      missingOptionalFields: [],
      coverageOk: false,
      actionable: "Enable missing fields",
    });
    mockSubscribeToWABAWebhooks.mockResolvedValueOnce({
      success: false,
      error: "Temporary Meta gateway failure",
      status: 503,
    });
    const { update } = mockSourcesQuery([
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials: {
          access_token: "same-access-token",
          token_expires_at: "2026-05-14T00:00:00.000Z",
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          embedded_signup: true,
          waba_subscription_consecutive_failures: 2,
        },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-whatsapp-webhooks")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.critical_issues[0]).toContain("attempt 3");
    expect(body.critical_issues[0]).not.toContain("requires reconnection");
    const updateCalls = update.mock.calls as unknown as Array<
      [{ credentials: Record<string, unknown> }]
    >;
    expect(updateCalls[0][0].credentials).toMatchObject({
      waba_subscription_consecutive_failures: 3,
      waba_subscription_permanently_failed: false,
      webhook_requires_reconnect: false,
    });
  });
});
