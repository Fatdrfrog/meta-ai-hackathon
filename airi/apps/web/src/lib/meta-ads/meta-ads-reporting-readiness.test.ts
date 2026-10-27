import { getMetaAdsReportingReadiness } from "./meta-ads-reporting-readiness";
import { toPublicMetaAdsCredentials } from "./meta-ads-source";

const connected = {
  has_access_token: true,
  scope: "ads_read",
  selected_ad_account_id: "act_123",
  ad_accounts: [{ id: "act_123" }],
};

describe("Meta Ads reporting readiness", () => {
  it("keeps reporting available without optional MCP or Instagram grants", () => {
    expect(getMetaAdsReportingReadiness(connected)).toMatchObject({
      canRead: true,
      reason: "ready",
    });
    expect(
      getMetaAdsReportingReadiness({ ...connected, scope: "ads_management" })
        .canRead
    ).toBe(true);
  });

  it("preserves confirmed invalidity when credentials are projected or reloaded", () => {
    const credentials = {
      ...connected,
      access_token: "invalid",
      ads_access_invalidated_at: "2026-09-19T19:00:00Z",
    };
    expect(getMetaAdsReportingReadiness(credentials).canRead).toBe(false);
    expect(
      getMetaAdsReportingReadiness(toPublicMetaAdsCredentials(credentials))
        .canRead
    ).toBe(false);
  });

  it.each([
    [{ ...connected, has_access_token: false }, "not_connected"],
    [
      {
        ...connected,
        has_access_token: false,
        access_token: { iv: null, tag: null, ciphertext: null },
      },
      "not_connected",
    ],
    [{ ...connected, scope: "instagram_business_basic" }, "missing_permission"],
    [{ ...connected, expires_at: "2026-01-01T00:00:00Z" }, "expired"],
    [{ ...connected, selected_ad_account_id: null }, "account_missing"],
    [
      { ...connected, selected_ad_account_id: "act_removed" },
      "account_unavailable",
    ],
    [
      { ...connected, ad_accounts_error: "Discovery failed" },
      "account_check_failed",
    ],
    [
      {
        ...connected,
        scope: null,
        ads_scopes_verified_at: "2026-09-19T00:00:00Z",
      },
      "missing_permission",
    ],
  ])(
    "does not claim reporting readiness from incomplete evidence",
    (credentials, reason) => {
      expect(getMetaAdsReportingReadiness(credentials)).toMatchObject({
        canRead: false,
        reason,
      });
    }
  );

  it("supports legacy account discovery without invented expiry or grants", () => {
    expect(
      getMetaAdsReportingReadiness({
        access_token: "legacy",
        ad_accounts: [{ id: "act_123" }],
      })
    ).toEqual({
      canRead: true,
      reason: "ready",
      selectedAdAccountId: "act_123",
    });
  });

  it("keeps legacy readiness consistent through the public credential projection", () => {
    const credentials = {
      access_token: "legacy",
      ad_accounts: [{ id: "act_123" }],
    };
    expect(
      getMetaAdsReportingReadiness(toPublicMetaAdsCredentials(credentials))
    ).toEqual(getMetaAdsReportingReadiness(credentials));
    expect(
      getMetaAdsReportingReadiness(
        toPublicMetaAdsCredentials({
          ...credentials,
          selected_ad_account_id: null,
        })
      ).reason
    ).toBe("account_missing");
  });

  it("does not choose the first account when an explicit selection disappeared", () => {
    expect(
      getMetaAdsReportingReadiness({
        ...connected,
        selected_ad_account_id: "act_removed",
      })
    ).toEqual({
      canRead: false,
      reason: "account_unavailable",
      selectedAdAccountId: "act_removed",
    });
  });

  it("does not treat never-expiring evidence as overriding a positive deadline", () => {
    expect(
      getMetaAdsReportingReadiness({
        ...connected,
        ads_never_expires: true,
        expires_at: "2026-01-01T00:00:00Z",
      }).canRead
    ).toBe(false);
  });
});
