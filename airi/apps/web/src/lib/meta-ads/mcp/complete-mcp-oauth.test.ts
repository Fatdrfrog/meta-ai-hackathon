const mockResolveToken = jest.fn();
const mockProbe = jest.fn();
const mockDebug = jest.fn();
const mockUser = jest.fn();
const mockInventory = jest.fn();
jest.mock("@/lib/crypto", () => ({
  encryptString: (value: string) => ({
    iv: "iv",
    tag: "tag",
    ciphertext: value,
  }),
}));
jest.mock("@/lib/meta-ads/meta-ads-login-config", () => ({
  getMetaAdsAppConfig: () => ({ appId: "app-1", appSecret: "fixture-secret" }),
}));
jest.mock("@/lib/meta-ads/meta-ads-oauth-exchange", () => ({
  resolveMetaAdsOAuthAccessToken: (...args: unknown[]) =>
    mockResolveToken(...args),
  fetchMetaOAuthUser: (...args: unknown[]) => mockUser(...args),
  metaOAuthErrorDetails: () => undefined,
}));
jest.mock("@/lib/meta/debug-token", () => ({
  debugConfiguredMetaAccessToken: (...args: unknown[]) => mockDebug(...args),
}));
jest.mock("@/lib/meta-ads/meta-ads-accounts", () => ({
  fetchMetaAdsAdAccountInventory: (...args: unknown[]) =>
    mockInventory(...args),
}));
jest.mock("./readiness-probe", () => ({
  probeMetaAdsMcpReadiness: (...args: unknown[]) => mockProbe(...args),
}));
jest.mock("@/lib/observability/server-logs", () => ({
  createServerLogger: () => ({ error: jest.fn(), info: jest.fn() }),
}));
jest.mock("@/lib/supabase/company-users", () => ({
  getCompanyIdForWorkspace: async () => "company-1",
}));

import type { SupabaseClient } from "@supabase/supabase-js";
import { completeMetaAdsMcpOAuth } from "./complete-mcp-oauth";

const accounts = [
  { id: "act_1", name: "First account", currency: "KZT" },
  { id: "act_2", name: "Selected account", currency: "USD" },
];
const debug = {
  is_valid: true,
  app_id: "app-1",
  user_id: "user-1",
  expires_at: 0,
  scopes: ["ads_read", "ads_mcp_management"],
};

function sourceClient(
  options: {
    missing?: boolean;
    companyId?: string;
    conflict?: boolean;
    uniqueConflict?: boolean;
    invalidated?: boolean;
  } = {}
) {
  let saving = false;
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    update: jest.fn().mockImplementation(() => {
      saving = true;
      return query;
    }),
    insert: jest.fn().mockImplementation(() => {
      saving = true;
      return query;
    }),
    maybeSingle: jest.fn().mockImplementation(async () => ({
      data: saving
        ? options.conflict
          ? null
          : { id: "source-1" }
        : options.missing
          ? null
          : {
              id: "source-1",
              company_id: options.companyId ?? "company-1",
              updated_at: "2026-09-19T00:00:00.000Z",
              credentials: {
                access_token: "old-graph-token",
                scope: "ads_read",
                ...(options.invalidated
                  ? { ads_access_invalidated_at: "2026-09-19T00:00:00.000Z" }
                  : {}),
                user_id: "old-user",
                selected_ad_account_id: "act_2",
                ad_accounts: accounts,
                mcp_access_token: "old-mcp-token",
                mcp_connection_id: "old-connection",
                mcp_provider_probe: {
                  outcome: "success",
                  checkedAt: new Date().toISOString(),
                  warnings: [],
                },
              },
            },
      error: saving && options.uniqueConflict ? { code: "23505" } : null,
    })),
  };
  return {
    query,
    supabase: { from: () => query } as unknown as SupabaseClient,
  };
}

describe("unified Meta Ads authorization completion", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveToken.mockResolvedValue({
      ok: true,
      token: {
        access_token: "new-token",
        scope: "ads_read ads_mcp_management",
        expires_in: 3600,
      },
      shortLived: { access_token: "code-token", expires_in: 60 },
    });
    mockDebug.mockResolvedValue(debug);
    mockUser.mockResolvedValue({ id: "user-1", name: "New account owner" });
    mockInventory.mockResolvedValue({
      accounts,
      accessibleAdAccountIds: ["act_1", "act_2"],
      selectedAccount: accounts[1],
      truncated: false,
    });
    mockProbe.mockResolvedValue({
      kind: "connected_not_ready",
      evidence: {
        mcp_expires_at: null,
        mcp_never_expires: true,
        mcp_scope: "ads_mcp_management ads_read",
        mcp_user_id: "user-1",
        mcp_ad_account_ids: ["act_1", "act_2"],
        mcp_selected_ad_account: accounts[1],
      },
    });
  });

  it("refreshes Graph and AI credentials together while preserving verified selection and full inventory", async () => {
    const { query, supabase } = sourceClient();
    const result = await completeMetaAdsMcpOAuth({
      supabase,
      workspaceId: "workspace-1",
      code: "code",
    });
    expect(result).toMatchObject({
      ok: true,
      reportingReady: true,
      adAccounts: accounts,
      selectedAdAccountId: "act_2",
    });
    expect(query.update).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: expect.objectContaining({
          access_token: { iv: "iv", tag: "tag", ciphertext: "new-token" },
          mcp_access_token: { iv: "iv", tag: "tag", ciphertext: "new-token" },
          user_id: "user-1",
          mcp_user_id: "user-1",
          ad_accounts: accounts,
          selected_ad_account_id: "act_2",
          scope: "ads_mcp_management ads_read",
          mcp_scope: "ads_mcp_management ads_read",
        }),
      })
    );
    const saved = query.update.mock.calls[0][0].credentials;
    expect(saved.mcp_connection_id).not.toBe("old-connection");
    expect(saved.mcp_provider_probe).toBeUndefined();
  });

  it("commits reporting without depending on optional AI permission or provider availability", async () => {
    mockDebug.mockResolvedValue({ ...debug, scopes: ["ads_read"] });
    mockProbe.mockRejectedValue(new Error("provider unavailable"));
    const { query, supabase } = sourceClient();
    expect(
      await completeMetaAdsMcpOAuth({
        supabase,
        workspaceId: "workspace-1",
        code: "code",
      })
    ).toMatchObject({
      ok: true,
      reportingReady: true,
      readiness: { state: "missing_scopes", canRead: false, canWrite: false },
    });
    expect(query.update).toHaveBeenCalledTimes(1);
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it("does not overwrite introspected non-expiry with an OAuth duration", async () => {
    const { query, supabase } = sourceClient();
    await completeMetaAdsMcpOAuth({
      supabase,
      workspaceId: "workspace-1",
      code: "code",
    });
    expect(query.update.mock.calls[0][0].credentials).toMatchObject({
      expires_at: null,
      mcp_expires_at: null,
      mcp_never_expires: true,
    });
  });

  it("never borrows a distinct code token's lifetime for the final token", async () => {
    mockResolveToken.mockResolvedValue({
      ok: true,
      token: { access_token: "new-token" },
      shortLived: { access_token: "code-token", expires_in: 3600 },
    });
    mockDebug.mockResolvedValue({ ...debug, expires_at: undefined });
    const { query, supabase } = sourceClient();
    await completeMetaAdsMcpOAuth({
      supabase,
      workspaceId: "workspace-1",
      code: "code",
    });
    expect(query.update.mock.calls[0][0].credentials).toMatchObject({
      expires_at: null,
      mcp_expires_at: null,
    });
  });

  it.each([
    [{ scopes: [] }, "ads_permissions_missing"],
    [{ is_valid: false }, "token_verification_failed"],
    [{ app_id: "other-app" }, "token_verification_failed"],
    [{ expires_at: 1 }, "token_verification_failed"],
    [{ user_id: "other-user" }, "identity_verification_failed"],
  ])(
    "never saves invalid or mismatched authorization: %j",
    async (metadata, error) => {
      mockDebug.mockResolvedValue({ ...debug, ...metadata });
      const { query, supabase } = sourceClient();
      expect(
        await completeMetaAdsMcpOAuth({
          supabase,
          workspaceId: "workspace-1",
          code: "code",
        })
      ).toMatchObject({ ok: false, error });
      expect(query.update).not.toHaveBeenCalled();
    }
  );

  it("rejects a source whose company does not match its workspace", async () => {
    const { query, supabase } = sourceClient({ companyId: "other-company" });
    expect(
      await completeMetaAdsMcpOAuth({
        supabase,
        workspaceId: "workspace-1",
        code: "code",
      })
    ).toMatchObject({ ok: false, error: "source_company_mismatch" });
    expect(query.update).not.toHaveBeenCalled();
  });

  it("does not replace a complete account list with a partial failed discovery", async () => {
    mockInventory.mockImplementation(async ({ onError }) => {
      onError({ status: 503 });
      return {
        accounts: [accounts[0]],
        accessibleAdAccountIds: ["act_1"],
        truncated: false,
      };
    });
    const { query, supabase } = sourceClient();
    expect(
      await completeMetaAdsMcpOAuth({
        supabase,
        workspaceId: "workspace-1",
        code: "code",
      })
    ).toMatchObject({ ok: false, error: "ad_accounts_unavailable" });
    expect(query.update).not.toHaveBeenCalled();
  });

  it("saves the new grant for recovery without silently switching an unavailable selection", async () => {
    mockInventory.mockResolvedValue({
      accounts: [accounts[0]],
      accessibleAdAccountIds: ["act_1"],
      truncated: false,
    });
    const { query, supabase } = sourceClient();
    expect(
      await completeMetaAdsMcpOAuth({
        supabase,
        workspaceId: "workspace-1",
        code: "code",
      })
    ).toMatchObject({
      ok: true,
      reportingReady: false,
      reporting: { reason: "account_unavailable" },
      selectedAdAccountId: "act_2",
      adAccounts: [accounts[0]],
      readiness: { canRead: false, canWrite: false },
    });
    const saved = query.update.mock.calls[0][0].credentials;
    expect(saved.access_token.ciphertext).toBe("new-token");
    expect(saved.selected_ad_account_id).toBe("act_2");
    expect(saved.mcp_selected_ad_account).toBeUndefined();
  });

  it("uses the original source revision and tenant filters to reject a concurrent reconnect", async () => {
    const { query, supabase } = sourceClient({ conflict: true });
    expect(
      await completeMetaAdsMcpOAuth({
        supabase,
        workspaceId: "workspace-1",
        code: "code",
      })
    ).toMatchObject({ ok: false, status: 409, error: "mcp_save_conflict" });
    expect(query.eq).toHaveBeenCalledWith(
      "updated_at",
      "2026-09-19T00:00:00.000Z"
    );
    expect(query.eq).toHaveBeenCalledWith("company_id", "company-1");
    expect(query.eq).toHaveBeenCalledWith("workspace_id", "workspace-1");
    expect(query.eq).toHaveBeenCalledWith("type", "meta_ads");
  });

  it("creates one source with all verified accounts and no implicit AI readiness", async () => {
    const { query, supabase } = sourceClient({ missing: true });
    expect(
      await completeMetaAdsMcpOAuth({
        supabase,
        workspaceId: "workspace-1",
        code: "code",
        allowCreateGraphSource: true,
      })
    ).toMatchObject({
      ok: true,
      createdSource: true,
      reportingReady: true,
      readiness: { canWrite: false },
    });
    expect(query.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: "company-1",
        workspace_id: "workspace-1",
        type: "meta_ads",
        credentials: expect.objectContaining({ ad_accounts: accounts }),
      })
    );
  });

  it("accepts ads_management alone for reporting and supports profile_id identity", async () => {
    mockDebug.mockResolvedValue({
      ...debug,
      user_id: undefined,
      profile_id: "user-1",
      scopes: ["ads_management"],
    });
    const { query, supabase } = sourceClient();
    expect(
      await completeMetaAdsMcpOAuth({
        supabase,
        workspaceId: "workspace-1",
        code: "code",
        intent: "reporting",
      })
    ).toMatchObject({ ok: true, reportingReady: true });
    expect(query.update.mock.calls[0][0].credentials.scope).toBe(
      "ads_management"
    );
    expect(mockInventory).toHaveBeenCalledWith(
      expect.objectContaining({ grantedScopes: ["ads_management"] })
    );
  });

  it("does not claim readiness for a new connection with no granted accounts", async () => {
    mockInventory.mockResolvedValue({
      accounts: [],
      accessibleAdAccountIds: [],
      truncated: false,
    });
    const { query, supabase } = sourceClient({ missing: true });
    expect(
      await completeMetaAdsMcpOAuth({
        supabase,
        workspaceId: "workspace-1",
        code: "code",
        allowCreateGraphSource: true,
      })
    ).toMatchObject({ ok: false, error: "no_ad_accounts" });
    expect(query.insert).not.toHaveBeenCalled();
  });

  it("keeps selected account metadata verified beyond a truncated inventory", async () => {
    mockInventory.mockResolvedValue({
      accounts: [accounts[0]],
      accessibleAdAccountIds: ["act_1", "act_2"],
      selectedAccount: accounts[1],
      truncated: true,
    });
    const { query, supabase } = sourceClient();
    expect(
      await completeMetaAdsMcpOAuth({
        supabase,
        workspaceId: "workspace-1",
        code: "code",
      })
    ).toMatchObject({
      ok: true,
      adAccounts: accounts,
      selectedAdAccountId: "act_2",
    });
    expect(
      query.update.mock.calls[0][0].credentials.mcp_ad_accounts_truncated
    ).toBe(true);
  });

  it("fails closed when final token verification is unavailable", async () => {
    mockDebug.mockRejectedValue(new Error("Unavailable"));
    const { query, supabase } = sourceClient();
    expect(
      await completeMetaAdsMcpOAuth({
        supabase,
        workspaceId: "workspace-1",
        code: "code",
      })
    ).toMatchObject({ ok: false, error: "token_verification_failed" });
    expect(query.update).not.toHaveBeenCalled();
  });

  it("maps concurrent first connections to a conflict without overwriting the winner", async () => {
    const { query, supabase } = sourceClient({
      missing: true,
      uniqueConflict: true,
    });
    expect(
      await completeMetaAdsMcpOAuth({
        supabase,
        workspaceId: "workspace-1",
        code: "code",
        allowCreateGraphSource: true,
      })
    ).toMatchObject({ ok: false, status: 409, error: "mcp_save_conflict" });
    expect(query.insert).toHaveBeenCalledTimes(1);
    expect(query.update).not.toHaveBeenCalled();
  });

  it("clears old account evidence when the newly verified account inventory is empty", async () => {
    mockInventory.mockResolvedValue({
      accounts: [],
      accessibleAdAccountIds: [],
      truncated: false,
    });
    const { query, supabase } = sourceClient();
    expect(
      await completeMetaAdsMcpOAuth({
        supabase,
        workspaceId: "workspace-1",
        code: "code",
      })
    ).toMatchObject({
      ok: true,
      reportingReady: false,
      reporting: { reason: "account_unavailable" },
      adAccounts: [],
      selectedAdAccountId: "act_2",
    });
    expect(query.update.mock.calls[0][0].credentials.ad_accounts).toEqual([]);
  });

  it("retains fresh inventory for recovery when only the prior selected account lookup fails", async () => {
    mockInventory.mockImplementation(async ({ onError }) => {
      onError({ phase: "selected_account", status: 403 });
      return {
        accounts: [accounts[0]],
        accessibleAdAccountIds: ["act_1"],
        truncated: false,
      };
    });
    const { query, supabase } = sourceClient();
    expect(
      await completeMetaAdsMcpOAuth({
        supabase,
        workspaceId: "workspace-1",
        code: "code",
      })
    ).toMatchObject({
      ok: true,
      reportingReady: false,
      reporting: { reason: "account_unavailable" },
      adAccounts: [accounts[0]],
      selectedAdAccountId: "act_2",
    });
    expect(
      query.update.mock.calls[0][0].credentials.mcp_selected_ad_account
    ).toBeUndefined();
  });

  it("clears confirmed invalidation only after successful verified reauthorization", async () => {
    const { query, supabase } = sourceClient({ invalidated: true });
    expect(
      await completeMetaAdsMcpOAuth({
        supabase,
        workspaceId: "workspace-1",
        code: "code",
      })
    ).toMatchObject({ ok: true, reportingReady: true });
    expect(
      query.update.mock.calls[0][0].credentials.ads_access_invalidated_at
    ).toBeUndefined();
  });
});
