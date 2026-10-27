const mockDebugToken = jest.fn();
const mockGraphGet = jest.fn();
const mockInventory = jest.fn();
const mockInitialize = jest.fn();
const mockListTools = jest.fn();
const mockAccountAccess = jest.fn();
jest.mock("./account-access", () => ({
  readMetaAdsMcpAccountAccess: (...args: unknown[]) =>
    mockAccountAccess(...args),
}));
jest.mock("@/lib/meta/debug-token", () => ({
  debugConfiguredMetaAccessToken: (...args: unknown[]) =>
    mockDebugToken(...args),
}));
jest.mock("@/lib/meta-ads/meta-ads-accounts", () => ({
  fetchMetaAdsAdAccountInventory: (...args: unknown[]) =>
    mockInventory(...args),
}));
jest.mock("@icecore/shared/lib/meta/api", () => ({
  getWhatsAppGraphClient: () => ({
    getJson: (...args: unknown[]) => mockGraphGet(...args),
  }),
  isMetaGraphAuthorizationError: () => false,
}));
jest.mock("./operation-event", () => ({
  createMetaAdsMcpOperationEvent: () => ({ add: jest.fn(), finish: jest.fn() }),
}));
jest.mock("./client", () => ({
  META_ADS_MCP_URL: "https://mcp.facebook.com/ads",
  MetaAdsMcpClientError: class extends Error {},
  createMetaAdsMcpSession: () => ({ closed: false }),
  closeMetaAdsMcpSession: jest.fn(),
  initializeMetaAdsMcpSession: (...args: unknown[]) => mockInitialize(...args),
  listMetaAdsMcpTools: (...args: unknown[]) => mockListTools(...args),
}));

import { probeMetaAdsMcpReadiness } from "./readiness-probe";

const now = new Date("2026-09-19T12:00:00.000Z");
const nowSeconds = now.getTime() / 1000;
const scopes = [
  "ads_mcp_management",
  "ads_read",
  "ads_management",
  "catalog_management",
  "business_management",
  "pages_show_list",
  "instagram_basic",
];
const params = {
  accessToken: "fixture-token",
  connectionId: "connection-1",
  appConfig: { appId: "app-1", appSecret: "fixture-secret" },
  selectedAdAccountId: "act_1",
  now,
};

describe("Ads MCP token lifetime evidence", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    jest.clearAllMocks();
    mockDebugToken.mockResolvedValue({
      is_valid: true,
      app_id: "app-1",
      user_id: "user-1",
      scopes,
    });
    mockGraphGet.mockResolvedValue({ id: "user-1", name: "Fixture user" });
    const account = { id: "act_1", currency: "USD" };
    mockInventory.mockResolvedValue({
      accounts: [account],
      selectedAccount: account,
      accessibleAdAccountIds: [account.id],
      truncated: false,
    });
    mockInitialize.mockResolvedValue(undefined);
    mockAccountAccess.mockResolvedValue({
      complete: true,
      inventory: {
        ad_accounts: [
          { ad_account_id: "1", is_ads_mcp_enabled: true, is_queryable: true },
        ],
      },
    });
    mockListTools.mockResolvedValue({
      tools: [{ name: "list_campaigns" }],
      catalogSha256: "a".repeat(64),
      protocol: { era: "modern", protocolVersion: "2025-06-18" },
    });
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          resource: "https://mcp.facebook.com/ads",
          scopes_supported: scopes,
        }),
        { headers: { "content-type": "application/json" } }
      )
    );
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("keeps callable tools ready while warning about unsupported task-only tools", async () => {
    mockDebugToken.mockResolvedValue({
      is_valid: true,
      app_id: "app-1",
      user_id: "user-1",
      scopes,
      expires_at: 0,
    });
    mockListTools.mockResolvedValue({
      tools: [{ name: "list_campaigns" }],
      unsupportedTaskToolCount: 1,
      catalogSha256: "a".repeat(64),
      protocol: { era: "modern", protocolVersion: "2025-06-18" },
    });
    expect(await probeMetaAdsMcpReadiness(params)).toMatchObject({
      kind: "verified",
      readiness: {
        state: "ready",
        canRead: true,
        provider: {
          warnings: expect.arrayContaining(["provider_capability_drift"]),
        },
      },
    });
  });

  it("hands a verified probe's open session, catalog and inventory to a caller that asks", async () => {
    mockDebugToken.mockResolvedValue({
      is_valid: true,
      app_id: "app-1",
      user_id: "user-1",
      scopes,
      expires_at: 0,
    });
    const { closeMetaAdsMcpSession } = jest.requireMock("./client");
    const retained = await probeMetaAdsMcpReadiness({
      ...params,
      retainSession: true,
    });
    expect(retained).toMatchObject({
      kind: "verified",
      liveSession: {
        session: { closed: false },
        catalog: { catalogSha256: "a".repeat(64) },
        accountInventory: {
          ad_accounts: [expect.objectContaining({ ad_account_id: "1" })],
        },
      },
    });
    expect(closeMetaAdsMcpSession).not.toHaveBeenCalled();

    const closed = await probeMetaAdsMcpReadiness(params);
    expect(closed).not.toHaveProperty("liveSession");
    expect(closeMetaAdsMcpSession).toHaveBeenCalledTimes(1);
  });

  it("never retains the session of a probe that did not verify readiness", async () => {
    mockDebugToken.mockResolvedValue({
      is_valid: true,
      app_id: "app-1",
      user_id: "user-1",
      scopes,
      expires_at: 0,
    });
    mockAccountAccess.mockResolvedValue({ complete: false, inventory: {} });
    const { closeMetaAdsMcpSession } = jest.requireMock("./client");
    const result = await probeMetaAdsMcpReadiness({
      ...params,
      retainSession: true,
    });
    expect(result).not.toHaveProperty("liveSession");
    expect(closeMetaAdsMcpSession).toHaveBeenCalledTimes(1);
  });

  it("does not claim readiness when Meta has not enabled MCP for the selected account", async () => {
    mockDebugToken.mockResolvedValue({
      is_valid: true,
      app_id: "app-1",
      user_id: "user-1",
      scopes,
      expires_at: 0,
    });
    mockAccountAccess.mockResolvedValue({
      complete: true,
      inventory: {
        ad_accounts: [
          { ad_account_id: "1", is_ads_mcp_enabled: false, is_queryable: true },
        ],
      },
    });
    const result = await probeMetaAdsMcpReadiness(params);
    expect(result).toMatchObject({
      kind: "connected_not_ready",
      readiness: {
        state: "asset_unavailable",
        canRead: false,
        canWrite: false,
        reconnectRequired: false,
        provider: {
          selectedAccountEnabled: false,
          warnings: expect.arrayContaining(["account_not_enabled"]),
        },
      },
      evidence: { mcp_provider_probe: { selectedAccountEnabled: false } },
    });
  });

  it("keeps an incomplete MCP account inventory retryable without revoking grants", async () => {
    mockAccountAccess.mockResolvedValue({
      complete: false,
      reason: "account_page_limit",
      inventory: [],
    });
    expect(await probeMetaAdsMcpReadiness(params)).toMatchObject({
      kind: "connected_not_ready",
      readiness: {
        state: "provider_unreachable",
        reconnectRequired: false,
        canRead: false,
      },
    });
  });

  it("records entity query restrictions without blocking every enabled account tool", async () => {
    mockDebugToken.mockResolvedValue({
      is_valid: true,
      app_id: "app-1",
      user_id: "user-1",
      scopes,
      expires_at: 0,
    });
    mockAccountAccess.mockResolvedValue({
      complete: true,
      inventory: {
        ad_accounts: [
          { ad_account_id: "1", is_ads_mcp_enabled: true, is_queryable: false },
        ],
      },
    });
    expect(await probeMetaAdsMcpReadiness(params)).toMatchObject({
      kind: "verified",
      readiness: {
        state: "ready",
        canRead: true,
        provider: {
          selectedAccountEnabled: true,
          selectedAccountQueryable: false,
        },
      },
    });
  });

  it("does not start provider requests after the caller cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Turn deadline"));
    await expect(
      probeMetaAdsMcpReadiness({ ...params, signal: controller.signal })
    ).rejects.toThrow("Turn deadline");
    expect(mockDebugToken).not.toHaveBeenCalled();
  });

  it("stops after cancellation during token verification without revoking credentials", async () => {
    const controller = new AbortController();
    mockDebugToken.mockImplementation(async () => {
      controller.abort(new Error("Turn deadline"));
      throw new Error("Fetch aborted");
    });
    await expect(
      probeMetaAdsMcpReadiness({ ...params, signal: controller.signal })
    ).rejects.toThrow("Turn deadline");
    expect(mockGraphGet).not.toHaveBeenCalled();
    expect(mockListTools).not.toHaveBeenCalled();
  });

  it("does not begin MCP after cancellation during account discovery", async () => {
    const controller = new AbortController();
    mockInventory.mockImplementation(async () => {
      controller.abort(new Error("Turn deadline"));
      return { accounts: [], accessibleAdAccountIds: [], truncated: false };
    });
    await expect(
      probeMetaAdsMcpReadiness({ ...params, signal: controller.signal })
    ).rejects.toThrow("Turn deadline");
    expect(mockInitialize).not.toHaveBeenCalled();
  });

  it("passes verified minimum grants into account discovery without requiring business metadata", async () => {
    const minimumScopes = ["ads_mcp_management", "ads_read"];
    mockDebugToken.mockResolvedValue({
      is_valid: true,
      app_id: "app-1",
      user_id: "user-1",
      scopes: minimumScopes,
      expires_at: 0,
    });
    await probeMetaAdsMcpReadiness(params);
    expect(mockInventory).toHaveBeenCalledWith(
      expect.objectContaining({ grantedScopes: minimumScopes })
    );
  });

  it("returns directly verified Graph grant and lifetime evidence after matching identity", async () => {
    mockDebugToken.mockResolvedValue({
      is_valid: true,
      app_id: "app-1",
      user_id: "user-1",
      scopes: ["ads_mcp_management"],
      expires_at: 0,
    });
    expect(await probeMetaAdsMcpReadiness(params)).toMatchObject({
      graphTokenEvidence: {
        verifiedAt: now.toISOString(),
        scope: "ads_mcp_management",
        expiresAt: null,
        neverExpires: true,
      },
    });
  });

  it("does not label OAuth scope or lifetime fallbacks as current Graph evidence", async () => {
    mockDebugToken.mockResolvedValue({
      is_valid: true,
      app_id: "app-1",
      user_id: "user-1",
    });
    expect(
      await probeMetaAdsMcpReadiness({
        ...params,
        oauthClaims: {
          scope: "ads_read",
          expiresAt: "2099-01-01T00:00:00.000Z",
          authoritativeScope: true,
        },
      })
    ).not.toHaveProperty("graphTokenEvidence");
  });

  it("does not mirror debugger grants before the Graph identity matches", async () => {
    mockGraphGet.mockResolvedValue({ id: "another-user" });
    mockDebugToken.mockResolvedValue({
      is_valid: true,
      app_id: "app-1",
      user_id: "user-1",
      scopes: ["ads_read"],
      expires_at: 0,
    });
    expect(await probeMetaAdsMcpReadiness(params)).not.toHaveProperty(
      "graphTokenEvidence"
    );
  });

  it.each([undefined, 0])(
    "accepts explicit non-expiry with data expiry %s",
    async dataExpiry => {
      mockDebugToken.mockResolvedValue({
        is_valid: true,
        app_id: "app-1",
        user_id: "user-1",
        scopes,
        expires_at: 0,
        data_access_expires_at: dataExpiry,
      });
      const result = await probeMetaAdsMcpReadiness({
        ...params,
        oauthClaims: {
          expiresAt: "2026-10-19T12:00:00.000Z",
          authoritativeScope: false,
        },
      });
      expect(result).toMatchObject({
        evidence: { mcp_expires_at: null, mcp_never_expires: true },
      });
      expect(result).toHaveProperty(
        "warnings",
        expect.not.arrayContaining(["expiry_unknown"])
      );
    }
  );

  it("keeps omitted lifetime unknown", async () => {
    const result = await probeMetaAdsMcpReadiness(params);
    expect(result).toMatchObject({
      readiness: { canWrite: false },
      evidence: { mcp_expires_at: null },
    });
    expect(result).toHaveProperty(
      "warnings",
      expect.arrayContaining(["expiry_unknown"])
    );
    expect(result).not.toHaveProperty("evidence.mcp_never_expires", true);
  });

  it("preserves an authoritative empty scope list over OAuth claims", async () => {
    mockDebugToken.mockResolvedValue({
      is_valid: true,
      app_id: "app-1",
      user_id: "user-1",
      scopes: [],
      expires_at: nowSeconds + 3600,
    });
    expect(
      await probeMetaAdsMcpReadiness({
        ...params,
        oauthClaims: {
          scope: scopes.join(" "),
          authoritativeScope: true,
        },
      })
    ).toMatchObject({
      evidence: { mcp_scope: "", mcp_scopes_verified_at: now.toISOString() },
      readiness: { state: "missing_scopes", canRead: false, canWrite: false },
    });
  });

  it("honors a positive data-access deadline for a non-expiring token", async () => {
    mockDebugToken.mockResolvedValue({
      is_valid: true,
      app_id: "app-1",
      user_id: "user-1",
      scopes,
      expires_at: 0,
      data_access_expires_at: nowSeconds + 3600,
    });
    expect(await probeMetaAdsMcpReadiness(params)).toMatchObject({
      evidence: { mcp_expires_at: "2026-09-19T13:00:00.000Z" },
    });
  });

  it("does not call malformed data-access metadata verified non-expiry", async () => {
    mockDebugToken.mockResolvedValue({
      is_valid: true,
      app_id: "app-1",
      user_id: "user-1",
      scopes,
      expires_at: 0,
      data_access_expires_at: -1,
    });
    const result = await probeMetaAdsMcpReadiness(params);
    expect(result).toMatchObject({ readiness: { canWrite: false } });
    expect(result).not.toHaveProperty("evidence.mcp_never_expires", true);
  });

  it("preserves a same-token deadline during a transient introspection failure", async () => {
    mockDebugToken.mockRejectedValue(new Error("Temporary provider failure"));
    expect(
      await probeMetaAdsMcpReadiness({
        ...params,
        oauthClaims: {
          expiresAt: "2026-09-20T12:00:00.000Z",
          authoritativeScope: false,
        },
      })
    ).toMatchObject({
      evidence: { mcp_expires_at: "2026-09-20T12:00:00.000Z" },
      readiness: { canRead: false, canWrite: false },
    });
  });

  it.each([
    { expires_at: 0, data_access_expires_at: nowSeconds - 1 },
    { expires_at: 0, app_id: "other-app" },
    { expires_at: 0, is_valid: false },
  ])("rejects invalid token metadata %j", async overrides => {
    mockDebugToken.mockResolvedValue({
      is_valid: true,
      app_id: "app-1",
      user_id: "user-1",
      scopes,
      ...overrides,
    });
    expect(await probeMetaAdsMcpReadiness(params)).toMatchObject({
      kind: "invalid_credentials",
    });
    expect(mockInitialize).not.toHaveBeenCalled();
  });

  it("uses same-token OAuth expiry only when debugger expiry is absent", async () => {
    expect(
      await probeMetaAdsMcpReadiness({
        ...params,
        oauthClaims: {
          expiresAt: "2026-09-20T12:00:00.000Z",
          authoritativeScope: false,
        },
      })
    ).toMatchObject({
      evidence: { mcp_expires_at: "2026-09-20T12:00:00.000Z" },
    });
    mockDebugToken.mockResolvedValue({
      is_valid: true,
      app_id: "app-1",
      user_id: "user-1",
      scopes,
      expires_at: nowSeconds + 3600,
    });
    expect(
      await probeMetaAdsMcpReadiness({
        ...params,
        oauthClaims: {
          expiresAt: "2026-09-19T12:10:00.000Z",
          authoritativeScope: false,
        },
      })
    ).toMatchObject({
      evidence: { mcp_expires_at: "2026-09-19T13:00:00.000Z" },
    });
  });

  it("mirrors a verified imminent deadline without revoking Graph or contacting MCP", async () => {
    mockDebugToken.mockResolvedValue({
      is_valid: true,
      app_id: "app-1",
      user_id: "user-1",
      scopes,
      expires_at: nowSeconds + 299,
    });
    const result = await probeMetaAdsMcpReadiness(params);
    expect(result).toMatchObject({
      kind: "connected_not_ready",
      readiness: { state: "expired", canRead: false, canWrite: false },
      graphTokenEvidence: {
        expiresAt: new Date(now.getTime() + 299_000).toISOString(),
        neverExpires: false,
      },
    });
    expect(result).not.toHaveProperty("graphAccessInvalid", true);
    expect(mockInitialize).not.toHaveBeenCalled();
    expect(mockInventory).not.toHaveBeenCalled();
  });

  it("rejects an expired same-token OAuth fallback", async () => {
    expect(
      await probeMetaAdsMcpReadiness({
        ...params,
        oauthClaims: {
          expiresAt: "2026-09-18T12:00:00.000Z",
          authoritativeScope: false,
        },
      })
    ).toMatchObject({ kind: "invalid_credentials" });
  });

  it.each([
    { is_valid: false },
    { app_id: "other-app" },
    { expires_at: nowSeconds - 1 },
    { expires_at: 0, data_access_expires_at: nowSeconds - 1 },
  ])(
    "identifies confirmed shared-token invalidity without exposing token data: %j",
    async overrides => {
      mockDebugToken.mockResolvedValue({
        is_valid: true,
        app_id: "app-1",
        user_id: "user-1",
        scopes,
        ...overrides,
      });
      expect(await probeMetaAdsMcpReadiness(params)).toMatchObject({
        kind: "invalid_credentials",
        graphAccessInvalid: true,
      });
    }
  );

  it.each([
    { app_id: undefined },
    { is_valid: undefined },
    { user_id: undefined },
  ])(
    "does not turn uncertain metadata or MCP expiry skew into confirmed Graph revocation: %j",
    async overrides => {
      mockDebugToken.mockResolvedValue({
        is_valid: true,
        app_id: "app-1",
        user_id: "user-1",
        scopes,
        ...overrides,
      });
      const result = await probeMetaAdsMcpReadiness(params);
      expect(result).toMatchObject({ kind: "invalid_credentials" });
      expect(result).not.toHaveProperty("graphAccessInvalid", true);
    }
  );

  it("does not block the provider probe when metadata omits optional scopes", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          resource: "https://mcp.facebook.com/ads",
          scopes_supported: ["ads_mcp_management", "ads_read"],
        }),
        { headers: { "content-type": "application/json" } }
      )
    );
    mockDebugToken.mockResolvedValue({
      is_valid: true,
      app_id: "app-1",
      user_id: "user-1",
      scopes,
      expires_at: nowSeconds + 3600,
    });
    expect(await probeMetaAdsMcpReadiness(params)).toMatchObject({
      evidence: {
        mcp_provider_probe: { outcome: "success" },
      },
    });
    expect(mockInitialize).toHaveBeenCalledTimes(1);
    expect(mockListTools).toHaveBeenCalledTimes(1);
  });

  it("still blocks a mismatched protected resource", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          resource: "https://other.invalid/ads",
          scopes_supported: scopes,
        }),
        { headers: { "content-type": "application/json" } }
      )
    );
    mockDebugToken.mockResolvedValue({
      is_valid: true,
      app_id: "app-1",
      user_id: "user-1",
      scopes,
      expires_at: nowSeconds + 3600,
    });
    expect(await probeMetaAdsMcpReadiness(params)).toMatchObject({
      readiness: { canRead: false, canWrite: false },
      evidence: { mcp_provider_probe: { outcome: "invalid_catalog" } },
    });
  });
});
