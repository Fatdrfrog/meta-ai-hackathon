import {
  evaluateMetaAdsMcpReadiness,
  canRetryMetaAdsMcpReadiness,
} from "./meta-ads-mcp-readiness";

const NOW = new Date("2026-09-19T15:00:00.000Z");

function credentials(overrides: Record<string, unknown> = {}) {
  return {
    mcp_access_token: "test-token",
    mcp_scope: "ads_mcp_management ads_management",
    mcp_scopes_verified_at: NOW.toISOString(),
    mcp_expires_at: "2026-10-19T15:00:00.000Z",
    mcp_connection_id: "connection-1",
    mcp_user_id: "user-1",
    selected_ad_account_id: "act_123",
    mcp_ad_account_ids: ["act_123"],
    mcp_selected_ad_account: { id: "act_123", currency: "KZT" },
    mcp_assets_checked_at: NOW.toISOString(),
    mcp_provider_probe: {
      checkedAt: NOW.toISOString(),
      outcome: "success",
      warnings: [],
    },
    ...overrides,
  };
}

function evaluate(overrides: Record<string, unknown> = {}) {
  return evaluateMetaAdsMcpReadiness({
    hasMetaAdsSource: true,
    credentials: credentials(overrides),
    now: NOW,
  });
}

describe("Meta Ads MCP readiness", () => {
  it("projects explicit provider rollout flags without treating them as missing permissions", () => {
    expect(
      evaluate({
        mcp_provider_probe: {
          checkedAt: NOW.toISOString(),
          outcome: "success",
          selectedAccountEnabled: false,
          selectedAccountQueryable: true,
          warnings: ["account_not_enabled"],
        },
      })
    ).toMatchObject({
      state: "asset_unavailable",
      canRead: false,
      canWrite: false,
      reconnectRequired: false,
      provider: {
        selectedAccountEnabled: false,
        selectedAccountQueryable: true,
        warnings: ["account_not_enabled"],
      },
    });
  });
  it("does not block all analytics solely because entity queries are unavailable", () => {
    expect(
      evaluate({
        mcp_provider_probe: {
          checkedAt: NOW.toISOString(),
          outcome: "success",
          selectedAccountEnabled: true,
          selectedAccountQueryable: false,
          warnings: [],
        },
      })
    ).toMatchObject({
      state: "ready",
      canRead: true,
      provider: { selectedAccountQueryable: false },
    });
  });
  it("allows a later fresh check once rollout evidence becomes stale", () => {
    expect(
      evaluate({
        mcp_provider_probe: {
          checkedAt: "2026-09-19T14:40:00.000Z",
          outcome: "success",
          selectedAccountEnabled: false,
          warnings: ["account_not_enabled"],
        },
      })
    ).toMatchObject({
      state: "stale",
      canRead: false,
      reconnectRequired: false,
    });
  });
  it("allows reporting with the MCP permission and ads_read without optional asset permissions", () => {
    expect(
      evaluate({ mcp_scope: "ads_mcp_management ads_read" })
    ).toMatchObject({
      state: "ready",
      canRead: true,
      canWrite: false,
      reconnectRequired: false,
      requiredScopes: ["ads_mcp_management", "ads_read"],
      missingScopes: [],
      missingReadScopes: [],
      missingWriteScopes: ["ads_management"],
    });
  });

  it("accepts ads_management instead of ads_read for reporting and confirmed changes", () => {
    expect(evaluate()).toMatchObject({
      state: "ready",
      canRead: true,
      canWrite: true,
      requiredScopes: ["ads_mcp_management", "ads_management"],
      missingScopes: [],
      missingReadScopes: [],
      missingWriteScopes: [],
    });
  });

  it("normalizes comma-separated grants without requiring every advertised optional permission", () => {
    expect(
      evaluate({
        mcp_scope: "ads_read, ads_mcp_management, pages_show_list, ads_read",
      })
    ).toMatchObject({ state: "ready", canRead: true, canWrite: false });
  });

  it.each([
    ["ads_read", ["ads_mcp_management"]],
    ["ads_management", ["ads_mcp_management"]],
    ["ads_mcp_management", ["ads_read"]],
    ["", ["ads_mcp_management", "ads_read"]],
    ["instagram_basic catalog_management", ["ads_mcp_management", "ads_read"]],
  ])("blocks incomplete minimum grants: %s", (mcp_scope, missingScopes) => {
    expect(evaluate({ mcp_scope })).toMatchObject({
      state: "missing_scopes",
      canRead: false,
      canWrite: false,
      reconnectRequired: true,
      missingScopes,
      missingReadScopes: missingScopes,
    });
  });

  it.each([
    ["not_connected", { mcp_access_token: undefined }],
    ["identity_unverified", { mcp_connection_id: undefined }],
    ["identity_unverified", { mcp_user_id: undefined }],
    ["asset_unavailable", { mcp_ad_account_ids: ["act_other"] }],
    ["asset_unavailable", { mcp_selected_ad_account: { id: "act_123" } }],
    ["asset_unavailable", { mcp_assets_checked_at: undefined }],
    [
      "stale",
      {
        mcp_provider_probe: {
          checkedAt: "2026-09-19T14:44:59.000Z",
          outcome: "success",
        },
      },
    ],
    ["expired", { mcp_expires_at: "2026-09-19T15:05:00.000Z" }],
  ])("keeps the %s gate after accepting minimal scopes", (state, overrides) => {
    expect(evaluate(overrides)).toMatchObject({
      state,
      canRead: false,
      canWrite: false,
    });
  });

  it.each([
    ["unauthorized", "provider_unauthorized"],
    ["unreachable", "provider_unreachable"],
    ["invalid_catalog", "invalid_catalog"],
  ])("keeps failed provider evidence blocked: %s", (outcome, state) => {
    expect(
      evaluate({
        mcp_provider_probe: { checkedAt: NOW.toISOString(), outcome },
      })
    ).toMatchObject({ state, canRead: false, canWrite: false });
  });

  it("does not turn verified scopes into usable credentials", () => {
    expect(
      evaluateMetaAdsMcpReadiness({
        hasMetaAdsSource: true,
        credentials: credentials(),
        tokenUsable: false,
        now: NOW,
      })
    ).toMatchObject({
      state: "provider_unauthorized",
      canRead: false,
      canWrite: false,
    });
  });

  it("allows only reporting when scope grants are unverified", () => {
    expect(evaluate({ mcp_scopes_verified_at: undefined })).toMatchObject({
      state: "scope_unverified",
      canRead: true,
      canWrite: false,
    });
  });

  it("keeps genuinely unknown expiry read-only", () => {
    expect(evaluate({ mcp_expires_at: null })).toMatchObject({
      state: "expiry_unknown",
      canRead: true,
      canWrite: false,
    });
  });

  it("accepts verified non-expiring credentials without inventing a deadline", () => {
    const readiness = evaluate({
      mcp_expires_at: null,
      mcp_never_expires: true,
    });
    expect(readiness).toMatchObject({
      state: "ready",
      canRead: true,
      canWrite: true,
      neverExpires: true,
    });
    expect(readiness.expiresAt).toBeUndefined();
  });

  it("does not allow a non-expiring marker to override a finite expired deadline", () => {
    expect(
      evaluate({
        mcp_expires_at: "2026-09-19T14:59:59.000Z",
        mcp_never_expires: true,
      })
    ).toMatchObject({ state: "expired", canRead: false, canWrite: false });
  });

  it("does not trust a string value as a verified non-expiring marker", () => {
    expect(
      evaluate({ mcp_expires_at: null, mcp_never_expires: "true" })
    ).toMatchObject({
      state: "expiry_unknown",
      canRead: true,
      canWrite: false,
    });
  });
});

it.each([
  [0, false],
  [59_999, false],
  [60_000, true],
  [60_001, true],
])("shares the provider retry cooldown at age %i", (age, allowed) => {
  expect(
    canRetryMetaAdsMcpReadiness(
      {
        state: "provider_unreachable",
        checkedAt: new Date(NOW.getTime() - age).toISOString(),
      },
      NOW.getTime()
    )
  ).toBe(allowed);
});
