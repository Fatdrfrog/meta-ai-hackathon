import { toPublicMetaAdsCredentials } from "./meta-ads-source";

describe("toPublicMetaAdsCredentials", () => {
  it("redacts the access token while preserving ad account metadata", () => {
    expect(
      toPublicMetaAdsCredentials({
        access_token: { iv: "iv", tag: "tag", ciphertext: "ciphertext" },
        scope: "ads_read",
        token_type: "bearer",
        connected_at: "2026-06-07T00:00:00.000Z",
        user_id: "user-1",
        user_name: "Ads Manager",
        selected_ad_account_id: "act_123",
        ad_accounts_checked_at: "2026-06-07T00:00:00.000Z",
        ad_accounts_error: "temporary failure",
        ad_accounts: [
          {
            id: "act_123",
            account_id: "123",
            name: "Demoshop ads",
            account_status: 1,
            currency: "KZT",
            timezone_name: "Asia/Almaty",
            business: { id: "business-1", name: "Demoshop" },
          },
        ],
      })
    ).toMatchObject({
      has_access_token: true,
      expires_at: null,
      scope: "ads_read",
      token_type: "bearer",
      connected_at: "2026-06-07T00:00:00.000Z",
      user_id: "user-1",
      user_name: "Ads Manager",
      selected_ad_account_id: "act_123",
      ad_accounts_checked_at: "2026-06-07T00:00:00.000Z",
      ad_accounts_error: "temporary failure",
      ad_accounts: [
        {
          id: "act_123",
          account_id: "123",
          name: "Demoshop ads",
          account_status: 1,
          currency: "KZT",
          timezone_name: "Asia/Almaty",
          business: { id: "business-1", name: "Demoshop" },
        },
      ],
      has_mcp_access_token: false,
      mcp_expires_at: null,
      mcp_scope: null,
      mcp_connected_at: null,
      mcp_user_id: null,
    });
  });

  it("exposes verified capability evidence without either credential", () => {
    const result = toPublicMetaAdsCredentials({
      access_token: "graph-secret",
      mcp_access_token: "mcp-secret",
      ads_scopes_verified_at: "2026-09-19T00:00:00.000Z",
      ads_identity_verified_at: "2026-09-19T00:00:00.000Z",
      ads_never_expires: true,
    });
    expect(result).toMatchObject({
      has_access_token: true,
      has_mcp_access_token: true,
      ads_scopes_verified_at: "2026-09-19T00:00:00.000Z",
      ads_identity_verified_at: "2026-09-19T00:00:00.000Z",
      ads_never_expires: true,
    });
    expect(result).not.toHaveProperty("access_token");
    expect(result).not.toHaveProperty("mcp_access_token");
    expect(JSON.stringify(result)).not.toMatch(/graph-secret|mcp-secret/u);
  });
});
