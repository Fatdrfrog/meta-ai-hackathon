const mockProbe = jest.fn();
jest.mock("@/lib/ai", () => ({}));
jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: (value: unknown) =>
    typeof value === "string" ? value : null,
}));
jest.mock("@/lib/meta-ads/meta-ads-login-config", () => ({
  getMetaAdsAppConfig: () => ({ appId: "app-1", appSecret: "fixture-secret" }),
}));
jest.mock("@/lib/supabase/company-users", () => ({
  getCompanyIdForWorkspace: async () => "company-1",
}));
jest.mock("./readiness-probe", () => ({
  probeMetaAdsMcpReadiness: (...args: unknown[]) => mockProbe(...args),
}));
const mockCloseSession = jest.fn();
jest.mock("./client", () => ({
  closeMetaAdsMcpSession: (...args: unknown[]) => mockCloseSession(...args),
}));

import { resolveWorkspaceMetaAdsMcpAccessToken } from "./readiness-service";
import type { MetaAdsMcpLiveReadinessResult } from "./readiness-probe";
import { evaluateMetaAdsMcpReadiness } from "../meta-ads-mcp-readiness";
import type { SupabaseClient } from "@supabase/supabase-js";

const now = "2026-09-20T12:00:00.000Z";
const previous = "2026-09-20T11:00:00.000Z";

function credentials(checkedAt = previous): Record<string, unknown> {
  return {
    access_token: "token-1",
    user_id: "user-1",
    mcp_access_token: "token-1",
    mcp_connection_id: "connection-1",
    mcp_user_id: "user-1",
    scope: "ads_mcp_management ads_read ads_management",
    mcp_scope: "ads_mcp_management ads_read ads_management",
    mcp_scopes_verified_at: previous,
    mcp_never_expires: true,
    selected_ad_account_id: "act_1",
    mcp_ad_account_ids: ["act_1"],
    mcp_selected_ad_account: { id: "act_1", currency: "USD" },
    mcp_assets_checked_at: previous,
    mcp_provider_probe: { checkedAt, outcome: "success", warnings: [] },
  };
}

function probeResult(
  overrides: Record<string, unknown> = {}
): MetaAdsMcpLiveReadinessResult {
  const evidence = {
    mcp_connection_id: "connection-1",
    mcp_user_id: "user-1",
    mcp_scope: "ads_mcp_management ads_read ads_management",
    mcp_scopes_verified_at: now,
    mcp_never_expires: true,
    mcp_ad_account_ids: ["act_1"],
    mcp_selected_ad_account: { id: "act_1", currency: "USD" },
    mcp_assets_checked_at: now,
    mcp_provider_probe: {
      checkedAt: now,
      outcome: "success" as const,
      warnings: [],
    },
    ...overrides,
  };
  const readiness = evaluateMetaAdsMcpReadiness({
    hasMetaAdsSource: true,
    credentials: { ...credentials(now), ...evidence },
    now: new Date(now),
  });
  return {
    kind: readiness.canRead ? "verified" : "connected_not_ready",
    evidence,
    readiness,
    warnings: [],
  };
}

function store(initial = credentials()) {
  let source = {
    id: "source-1",
    company_id: "company-1",
    updated_at: previous,
    credentials: initial,
  };
  let writes = 0;
  const supabase = {
    from: () => {
      const filters: Array<[string, unknown]> = [];
      let update: { credentials: Record<string, unknown> } | undefined;
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return query;
        },
        is: (column: string, value: unknown) => {
          filters.push([column, value]);
          return query;
        },
        order: () => query,
        limit: () => query,
        update: (value: { credentials: Record<string, unknown> }) => {
          update = value;
          return query;
        },
        maybeSingle: async () => {
          const matches = filters.every(([column, expected]) => {
            if (column === "workspace_id") return expected === "workspace-1";
            if (column === "type") return expected === "meta_ads";
            const actual = column.startsWith("credentials->>")
              ? (source.credentials[column.slice("credentials->>".length)] ??
                null)
              : source[column as keyof typeof source];
            return actual === expected;
          });
          if (!matches) return { data: null, error: null };
          if (update) {
            writes += 1;
            source = {
              ...source,
              credentials: update.credentials,
              updated_at: now,
            };
          }
          return { data: { ...source }, error: null };
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  return {
    supabase,
    read: () => source,
    writes: () => writes,
    reconnect: () => {
      source = {
        ...source,
        updated_at: now,
        credentials: {
          ...credentials(now),
          mcp_connection_id: "connection-2",
          mcp_access_token: "token-2",
        },
      };
    },
  };
}

describe("workspace Meta Ads readiness refresh", () => {
  beforeEach(() => {
    jest.useFakeTimers({
      now: new Date(now),
      doNotFake: ["nextTick", "setImmediate"],
    });
    mockProbe.mockReset().mockResolvedValue(probeResult());
    mockCloseSession.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => jest.useRealTimers());

  it("refreshes stale access before returning a usable chat connection", async () => {
    const data = store();
    const access = await resolveWorkspaceMetaAdsMcpAccessToken({
      supabase: data.supabase,
      workspaceId: "workspace-1",
    });
    expect(access.readiness).toMatchObject({
      state: "ready",
      canRead: true,
      canWrite: true,
    });
    expect(data.read().credentials.mcp_assets_checked_at).toBe(now);
    expect(data.writes()).toBe(1);
  });

  it("reuses fresh evidence without changing the saved connection", async () => {
    const data = store(credentials(now));
    const access = await resolveWorkspaceMetaAdsMcpAccessToken({
      supabase: data.supabase,
      workspaceId: "workspace-1",
    });
    expect(access.readiness.canRead).toBe(true);
    expect(data.writes()).toBe(0);
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it("does not revive grants removed by the fresh provider check", async () => {
    const data = store();
    mockProbe.mockResolvedValue(probeResult({ mcp_scope: "ads_read" }));
    const access = await resolveWorkspaceMetaAdsMcpAccessToken({
      supabase: data.supabase,
      workspaceId: "workspace-1",
    });
    expect(access.readiness).toMatchObject({
      state: "missing_scopes",
      canRead: false,
      canWrite: false,
    });
    expect(data.read().credentials.mcp_scope).toBe("ads_read");
  });

  it("never overwrites or executes using a concurrent reconnect", async () => {
    const data = store();
    mockProbe.mockImplementation(async () => {
      data.reconnect();
      return probeResult();
    });
    const access = await resolveWorkspaceMetaAdsMcpAccessToken({
      supabase: data.supabase,
      workspaceId: "workspace-1",
    });
    expect(access.accessToken).toBeNull();
    expect(access.readiness.canRead).toBe(false);
    expect(data.read().credentials.mcp_connection_id).toBe("connection-2");
    expect(data.writes()).toBe(0);
  });

  it("does not turn a provider outage into credential revocation", async () => {
    const data = store();
    mockProbe.mockResolvedValue({
      ...probeResult({
        mcp_provider_probe: {
          checkedAt: now,
          outcome: "unreachable",
          warnings: [],
        },
      }),
      kind: "connected_not_ready",
    });
    const access = await resolveWorkspaceMetaAdsMcpAccessToken({
      supabase: data.supabase,
      workspaceId: "workspace-1",
    });
    expect(access.readiness).toMatchObject({
      state: "provider_unreachable",
      canRead: false,
      reconnectRequired: false,
    });
    expect(data.read().credentials.ads_access_invalidated_at).toBeUndefined();
  });

  it("recovers from a saved provider outage after its retry cooldown", async () => {
    const data = store({
      ...credentials(),
      mcp_provider_probe: {
        checkedAt: previous,
        outcome: "unreachable",
        warnings: [],
      },
    });
    const access = await resolveWorkspaceMetaAdsMcpAccessToken({
      supabase: data.supabase,
      workspaceId: "workspace-1",
    });
    expect(access.readiness).toMatchObject({ state: "ready", canRead: true });
    expect(data.writes()).toBe(1);
  });

  it("does not repeatedly probe a recent provider outage", async () => {
    const data = store({
      ...credentials(),
      mcp_provider_probe: {
        checkedAt: now,
        outcome: "unreachable",
        warnings: [],
      },
    });
    const access = await resolveWorkspaceMetaAdsMcpAccessToken({
      supabase: data.supabase,
      workspaceId: "workspace-1",
    });
    expect(access.readiness).toMatchObject({
      state: "provider_unreachable",
      canRead: false,
    });
    expect(data.writes()).toBe(0);
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it("does not let a future provider timestamp prevent recovery indefinitely", async () => {
    const data = store({
      ...credentials(),
      mcp_provider_probe: {
        checkedAt: "2099-01-01T00:00:00.000Z",
        outcome: "unreachable",
        warnings: [],
      },
    });
    const access = await resolveWorkspaceMetaAdsMcpAccessToken({
      supabase: data.supabase,
      workspaceId: "workspace-1",
    });
    expect(access.readiness.canRead).toBe(true);
    expect(mockProbe).toHaveBeenCalledTimes(1);
  });

  it("does not persist evidence when the turn is cancelled during its probe", async () => {
    const data = store();
    const cancellation = new AbortController();
    mockProbe.mockImplementation(async () => {
      cancellation.abort(new Error("Turn cancelled"));
      return probeResult();
    });
    await expect(
      resolveWorkspaceMetaAdsMcpAccessToken({
        supabase: data.supabase,
        workspaceId: "workspace-1",
        signal: cancellation.signal,
      })
    ).rejects.toThrow("Turn cancelled");
    expect(data.writes()).toBe(0);
  });

  describe("probe session handover", () => {
    const live = {
      session: { closed: false },
      catalog: { tools: [], catalogSha256: "a".repeat(64) },
      accountInventory: { ad_accounts: [] },
    };
    const withLiveSession = () => ({ ...probeResult(), liveSession: live });

    it("hands the probe's session to a caller that asked once evidence is saved", async () => {
      const data = store();
      mockProbe.mockResolvedValue(withLiveSession());
      const access = await resolveWorkspaceMetaAdsMcpAccessToken({
        supabase: data.supabase,
        workspaceId: "workspace-1",
        retainProbeSession: true,
      });
      expect(mockProbe).toHaveBeenCalledWith(
        expect.objectContaining({ retainSession: true })
      );
      expect(access.readiness.canRead).toBe(true);
      expect(access.liveSession).toBe(live);
      expect(mockCloseSession).not.toHaveBeenCalled();
    });

    it("does not ask the probe to retain a session by default", async () => {
      const data = store();
      await resolveWorkspaceMetaAdsMcpAccessToken({
        supabase: data.supabase,
        workspaceId: "workspace-1",
      });
      expect(mockProbe.mock.calls[0][0]).not.toHaveProperty("retainSession");
    });

    it("closes the session when the evidence cannot be saved", async () => {
      const data = store();
      mockProbe.mockImplementation(async () => {
        data.reconnect();
        return withLiveSession();
      });
      const access = await resolveWorkspaceMetaAdsMcpAccessToken({
        supabase: data.supabase,
        workspaceId: "workspace-1",
        retainProbeSession: true,
      });
      expect(access.liveSession).toBeUndefined();
      expect(mockCloseSession).toHaveBeenCalledWith(live.session);
    });

    it("closes the session when the turn is cancelled during the probe", async () => {
      const data = store();
      const cancellation = new AbortController();
      mockProbe.mockImplementation(async () => {
        cancellation.abort(new Error("Turn cancelled"));
        return withLiveSession();
      });
      await expect(
        resolveWorkspaceMetaAdsMcpAccessToken({
          supabase: data.supabase,
          workspaceId: "workspace-1",
          signal: cancellation.signal,
          retainProbeSession: true,
        })
      ).rejects.toThrow("Turn cancelled");
      expect(mockCloseSession).toHaveBeenCalledWith(live.session);
    });

    it("closes the session when the refreshed connection cannot read", async () => {
      const data = store();
      mockProbe.mockResolvedValue({
        ...probeResult({ mcp_scope: "ads_read" }),
        liveSession: live,
      });
      const access = await resolveWorkspaceMetaAdsMcpAccessToken({
        supabase: data.supabase,
        workspaceId: "workspace-1",
        retainProbeSession: true,
      });
      expect(access.readiness.canRead).toBe(false);
      expect(access.liveSession).toBeUndefined();
      expect(mockCloseSession).toHaveBeenCalledWith(live.session);
    });
  });
});
