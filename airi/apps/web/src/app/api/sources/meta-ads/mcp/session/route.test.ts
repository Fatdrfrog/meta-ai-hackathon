const mockCreateClient = jest.fn();
const mockProbe = jest.fn();
const mockAccount = jest.fn();
jest.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
}));
jest.mock("@/lib/supabase/queries", () => ({
  checkUserWorkspaceAccess: async () => true,
}));
jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: (value: unknown) =>
    typeof value === "string" ? value : null,
}));
jest.mock("@/lib/meta-ads/meta-ads-accounts", () => ({
  fetchMetaAdsAdAccountById: (...args: unknown[]) => mockAccount(...args),
}));
jest.mock("@/lib/meta-ads/meta-ads-login-config", () => ({
  getMetaAdsAppConfig: () => ({ appId: "app-1", appSecret: "fixture-secret" }),
  resolveMetaAdsMcpLoginConfigId: () => "config-1",
  resolveMetaAdsLoginConfigId: () => "reporting-config",
}));
jest.mock("@/lib/supabase/company-users", () => ({
  getCompanyIdForWorkspace: async () => "company-1",
}));
jest.mock("@/lib/meta-ads/mcp/readiness-probe", () => ({
  probeMetaAdsMcpReadiness: (...args: unknown[]) => mockProbe(...args),
}));

import { NextRequest } from "next/server";
import { GET, PATCH } from "./route";
import { toPublicMetaAdsCredentials } from "@/lib/meta-ads/meta-ads-source";
import { getMetaAdsReportingReadiness } from "@/lib/meta-ads/meta-ads-reporting-readiness";

function store(credentials: Record<string, unknown>, conflict = false) {
  const source = {
    id: "source-1",
    company_id: "company-1",
    updated_at: "2026-09-19T00:00:00.000Z",
    credentials,
  };
  let saved: Record<string, unknown> | undefined;
  let reads = 0;
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    update: jest
      .fn()
      .mockImplementation((value: { credentials: Record<string, unknown> }) => {
        saved = value.credentials;
        return query;
      }),
    maybeSingle: jest.fn().mockImplementation(async () => ({
      data: {
        ...source,
        ...(saved
          ? { credentials: saved, updated_at: "2026-09-19T00:01:00.000Z" }
          : ++reads > 1 && conflict
            ? { updated_at: "2026-09-19T00:02:00.000Z" }
            : {}),
      },
      error: null,
    })),
  };
  mockCreateClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: "member-1" } } }) },
    from: () => query,
  });
  return query;
}

function selectAccount() {
  return PATCH(
    new NextRequest("http://localhost/api/sources/meta-ads/mcp/session", {
      method: "PATCH",
      body: JSON.stringify({
        workspaceId: "workspace-1",
        adAccountId: "act_2",
      }),
    })
  );
}

describe("GET Meta Ads MCP session lifetime refresh", () => {
  beforeEach(() => jest.clearAllMocks());

  it("carries the existing token deadline into its authenticated recheck", async () => {
    const source = {
      id: "source-1",
      company_id: "company-1",
      updated_at: "2026-09-19T00:00:00.000Z",
      credentials: {
        access_token: "graph-token",
        mcp_access_token: "mcp-token",
        mcp_connection_id: "connection-1",
        mcp_user_id: "user-1",
        mcp_expires_at: "2099-01-01T00:00:00.000Z",
        selected_ad_account_id: "act_1",
      },
    };
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: source, error: null }),
    };
    mockCreateClient.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: "member-1" } } }) },
      from: () => query,
    });
    mockProbe.mockResolvedValue({
      kind: "connected_not_ready",
      evidence: {
        mcp_connection_id: "connection-1",
        mcp_expires_at: "2099-01-01T00:00:00.000Z",
      },
    });
    const response = await GET(
      new NextRequest(
        "http://localhost/api/sources/meta-ads/mcp/session?workspaceId=workspace-1&probe=1"
      )
    );
    if (!response) throw new Error("Expected a session response");
    expect(response.status).toBe(200);
    expect(mockProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "connection-1",
        accessToken: "mcp-token",
        oauthClaims: {
          expiresAt: "2099-01-01T00:00:00.000Z",
          authoritativeScope: false,
        },
      })
    );
    expect(JSON.stringify(await response.json())).not.toContain(
      "fixture-token"
    );
  });

  it("returns authoritative reporting and account selection without an MCP token", async () => {
    store({
      access_token: "graph-token",
      scope: "ads_read",
      selected_ad_account_id: "act_1",
      ad_accounts: [{ id: "act_1", name: "Primary" }],
    });
    const response = await GET(
      new NextRequest(
        "http://localhost/api/sources/meta-ads/mcp/session?workspaceId=workspace-1"
      )
    );
    expect(await response!.json()).toMatchObject({
      reportingConfigId: "reporting-config",
      reporting: { canRead: true },
      adAccounts: [{ id: "act_1", name: "Primary" }],
      selectedAdAccountId: "act_1",
      readiness: { canWrite: false },
    });
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it("selects a Graph-only account and preserves the rest of the inventory", async () => {
    const query = store({
      access_token: "graph-token",
      scope: "ads_read",
      selected_ad_account_id: "act_removed",
      ad_accounts: [{ id: "act_1", name: "First" }],
      ad_accounts_error: "old failure",
    });
    mockAccount.mockResolvedValue({ id: "act_2", name: "Second" });
    const response = await selectAccount();
    expect(response!.status).toBe(200);
    expect(mockAccount).toHaveBeenCalledWith({
      accessToken: "graph-token",
      adAccountId: "act_2",
      grantedScopes: ["ads_read"],
    });
    expect(await response!.json()).toMatchObject({
      reporting: { canRead: true },
      selectedAdAccountId: "act_2",
      adAccounts: [
        { id: "act_1", name: "First" },
        { id: "act_2", name: "Second" },
      ],
    });
    const saved = query.update.mock.calls[0][0].credentials;
    expect(saved.ad_accounts_error).toBeUndefined();
    expect(saved.mcp_selected_ad_account).toBeUndefined();
    expect(query.eq).toHaveBeenCalledWith(
      "updated_at",
      "2026-09-19T00:00:00.000Z"
    );
    expect(query.eq).toHaveBeenCalledWith("company_id", "company-1");
  });

  it("never transfers a Graph account grant to a distinct legacy MCP token", async () => {
    const query = store({
      access_token: "new-graph-token",
      scope: "ads_read",
      selected_ad_account_id: "act_1",
      mcp_access_token: "old-mcp-token",
      mcp_connection_id: "old-connection",
      mcp_selected_ad_account: { id: "act_1" },
      mcp_assets_checked_at: "2026-09-19T00:00:00.000Z",
      mcp_provider_probe: { outcome: "success" },
    });
    mockAccount.mockResolvedValue({ id: "act_2" });
    expect((await selectAccount())!.status).toBe(200);
    const saved = query.update.mock.calls[0][0].credentials;
    expect(saved.mcp_access_token).toBe("old-mcp-token");
    expect(saved.mcp_selected_ad_account).toBeUndefined();
    expect(saved.mcp_provider_probe).toBeUndefined();
  });

  it("updates MCP account evidence only when the verified token is the same", async () => {
    const query = store({
      access_token: "same-token",
      scope: "ads_read",
      mcp_access_token: "same-token",
      mcp_connection_id: "connection-1",
      selected_ad_account_id: "act_1",
      mcp_ad_account_ids: ["act_1"],
      mcp_provider_probe: {
        checkedAt: new Date().toISOString(),
        outcome: "success",
        selectedAccountEnabled: true,
        warnings: [],
      },
    });
    mockAccount.mockResolvedValue({ id: "act_2" });
    expect((await selectAccount())!.status).toBe(200);
    expect(query.update.mock.calls[0][0].credentials).toMatchObject({
      mcp_selected_ad_account: { id: "act_2" },
      mcp_ad_account_ids: ["act_1", "act_2"],
    });
    expect(
      query.update.mock.calls[0][0].credentials.mcp_provider_probe
    ).toBeUndefined();
  });

  it("rejects selection after a concurrent Graph-only reconnect", async () => {
    const query = store(
      {
        access_token: "graph-token",
        scope: "ads_read",
        selected_ad_account_id: "act_1",
      },
      true
    );
    mockAccount.mockResolvedValue({ id: "act_2" });
    expect((await selectAccount())!.status).toBe(409);
    expect(query.update).not.toHaveBeenCalled();
  });

  it.each([
    ["shared-token", true, false],
    ["shared-token", undefined, true],
    ["different-ai-token", true, true],
  ])(
    "projects reporting availability from confirmed same-token invalidity: %s %s",
    async (mcpToken, graphAccessInvalid, canRead) => {
      const query = store({
        access_token: "shared-token",
        scope: "ads_read",
        selected_ad_account_id: "act_1",
        ad_accounts: [{ id: "act_1" }],
        mcp_access_token: mcpToken,
        mcp_connection_id: "connection-1",
      });
      mockProbe.mockResolvedValue({
        kind: "invalid_credentials",
        error: "mcp_invalid_credentials",
        status: 400,
        graphAccessInvalid,
      });
      const response = await GET(
        new NextRequest(
          "http://localhost/api/sources/meta-ads/mcp/session?workspaceId=workspace-1&probe=1"
        )
      );
      expect(await response!.json()).toMatchObject({
        reporting: { canRead },
        readiness: { canRead: false, canWrite: false },
      });
      if (graphAccessInvalid) {
        expect(query.update).toHaveBeenCalledTimes(1);
        const saved = query.update.mock.calls[0][0].credentials;
        expect(saved.access_token).toBe("shared-token");
        expect(saved.mcp_access_token).toBe(mcpToken);
        expect(saved.mcp_provider_probe).toMatchObject({
          outcome: "unauthorized",
        });
        expect(Boolean(saved.ads_access_invalidated_at)).toBe(!canRead);
        expect(
          getMetaAdsReportingReadiness(toPublicMetaAdsCredentials(saved))
            .canRead
        ).toBe(canRead);
        const refreshed = await GET(
          new NextRequest(
            "http://localhost/api/sources/meta-ads/mcp/session?workspaceId=workspace-1"
          )
        );
        expect(await refreshed!.json()).toMatchObject({
          reporting: { canRead },
          readiness: { canRead: false, canWrite: false },
        });
      } else {
        expect(query.update).not.toHaveBeenCalled();
      }
    }
  );

  it.each(["shared-token", "distinct-token"])(
    "mirrors authoritative scopes and expiry only from the actual same token: %s",
    async mcpToken => {
      const query = store({
        access_token: "shared-token",
        scope: "ads_read",
        expires_at: null,
        ads_never_expires: true,
        selected_ad_account_id: "act_1",
        ad_accounts: [{ id: "act_1" }],
        mcp_access_token: mcpToken,
        mcp_connection_id: "connection-1",
      });
      const verifiedAt = "2026-09-20T00:00:00.000Z";
      mockProbe.mockResolvedValue({
        kind: "connected_not_ready",
        evidence: {
          mcp_scope: "ads_mcp_management",
          mcp_scopes_verified_at: verifiedAt,
        },
        graphTokenEvidence: {
          verifiedAt,
          scope: "ads_mcp_management",
          expiresAt: "2099-01-01T00:00:00.000Z",
          neverExpires: false,
        },
      });
      const checked = await GET(
        new NextRequest(
          "http://localhost/api/sources/meta-ads/mcp/session?workspaceId=workspace-1&probe=1"
        )
      );
      const canRead = mcpToken !== "shared-token";
      expect(await checked!.json()).toMatchObject({ reporting: { canRead } });
      const saved = query.update.mock.calls[0][0].credentials;
      expect(saved.scope).toBe(canRead ? "ads_read" : "ads_mcp_management");
      expect(saved.expires_at).toBe(
        canRead ? null : "2099-01-01T00:00:00.000Z"
      );
      expect(saved.ads_never_expires).toBe(canRead);
      expect(
        getMetaAdsReportingReadiness(toPublicMetaAdsCredentials(saved)).canRead
      ).toBe(canRead);
      const refreshed = await GET(
        new NextRequest(
          "http://localhost/api/sources/meta-ads/mcp/session?workspaceId=workspace-1"
        )
      );
      expect(await refreshed!.json()).toMatchObject({ reporting: { canRead } });
    }
  );

  it("preserves Graph evidence when the probe provides only uncertain or fallback MCP metadata", async () => {
    const query = store({
      access_token: "shared-token",
      scope: "ads_read",
      expires_at: "2098-01-01T00:00:00.000Z",
      selected_ad_account_id: "act_1",
      ad_accounts: [{ id: "act_1" }],
      mcp_access_token: "shared-token",
      mcp_connection_id: "connection-1",
    });
    mockProbe.mockResolvedValue({
      kind: "connected_not_ready",
      evidence: {
        mcp_scope: "",
        mcp_expires_at: null,
        mcp_provider_probe: {
          outcome: "unreachable",
          checkedAt: new Date().toISOString(),
          warnings: [],
        },
      },
    });
    await GET(
      new NextRequest(
        "http://localhost/api/sources/meta-ads/mcp/session?workspaceId=workspace-1&probe=1"
      )
    );
    expect(query.update.mock.calls[0][0].credentials).toMatchObject({
      scope: "ads_read",
      expires_at: "2098-01-01T00:00:00.000Z",
    });
  });
});
