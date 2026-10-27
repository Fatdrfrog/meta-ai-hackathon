import { fetchLiveMetaReferralAudience } from "./meta-ads-audience";

const mockFetch = jest.fn();

function graphResponse(data: unknown[], ok = true, next?: string) {
  return new Response(
    JSON.stringify(
      ok
        ? { data, paging: next ? { next } : undefined }
        : {
            error: { message: "Graph request failed", code: 10 },
          }
    ),
    { status: ok ? 200 : 403, headers: { "content-type": "application/json" } }
  );
}

function emptyGraphResponse() {
  return graphResponse([]);
}

describe("fetchLiveMetaReferralAudience", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = mockFetch as never;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("fetches campaigns, ad sets, and ads from the selected ad account first", async () => {
    mockFetch.mockImplementation((input: string) => {
      const path = new URL(input).pathname;
      if (path === "/v25.0/act_2/campaigns") {
        return Promise.resolve(
          graphResponse([
            {
              id: "campaign-2",
              name: "Selected campaign",
              updated_time: "2026-06-14T12:00:00+0000",
            },
          ])
        );
      }
      if (path === "/v25.0/act_2/adsets") {
        return Promise.resolve(
          graphResponse([
            {
              id: "adset-2",
              name: "Selected ad set",
              campaign_id: "campaign-2",
              campaign: { id: "campaign-2", name: "Selected campaign" },
              updated_time: "2026-06-14T12:10:00+0000",
            },
          ])
        );
      }
      if (path === "/v25.0/act_2/ads") {
        return Promise.resolve(
          graphResponse([
            {
              id: "ad-2",
              name: "Selected ad",
              campaign_id: "campaign-2",
              campaign: { id: "campaign-2", name: "Selected campaign" },
              adset_id: "adset-2",
              adset: { id: "adset-2", name: "Selected ad set" },
              effective_status: "ACTIVE",
              updated_time: "2026-06-14T12:15:00+0000",
              creative: {
                id: "creative-2",
                name: "Creative",
                instagram_permalink_url: "https://instagram.com/p/selected",
              },
            },
          ])
        );
      }
      return Promise.resolve(emptyGraphResponse());
    });

    const result = await fetchLiveMetaReferralAudience({
      access_token: "token",
      selected_ad_account_id: "act_2",
      ad_accounts: [{ id: "act_1" }, { id: "act_2" }],
    });

    expect(new URL(mockFetch.mock.calls[0][0]).pathname).toBe(
      "/v25.0/act_2/campaigns"
    );
    expect(result.campaigns).toEqual([
      expect.objectContaining({
        campaignId: "campaign-2",
        campaignName: "Selected campaign",
      }),
    ]);
    expect(result.adSets).toEqual([
      expect.objectContaining({
        adSetId: "adset-2",
        campaignId: "campaign-2",
      }),
    ]);
    expect(result.ads).toEqual([
      expect.objectContaining({
        sourceId: "ad-2",
        sourceType: "ad",
        campaignId: "campaign-2",
        adSetId: "adset-2",
      }),
    ]);
    // A creative's Instagram permalink does not prove where its ad was shown.
    expect(result.ads[0].sourcePlatform).toBeUndefined();
    expect(result.ads[0].channel).toBeUndefined();
  });

  it("discovers ad accounts when stored credentials only have a token", async () => {
    mockFetch.mockImplementation((input: string) => {
      const path = new URL(input).pathname;
      if (path === "/v25.0/me/adaccounts") {
        return Promise.resolve(
          graphResponse([{ id: "act_9", account_id: "9", name: "Recovered" }])
        );
      }
      if (path === "/v25.0/act_9/campaigns") {
        return Promise.resolve(
          graphResponse([{ id: "campaign-9", name: "Recovered campaign" }])
        );
      }
      return Promise.resolve(emptyGraphResponse());
    });

    const result = await fetchLiveMetaReferralAudience({
      access_token: "token",
    });

    expect(new URL(mockFetch.mock.calls[0][0]).pathname).toBe(
      "/v25.0/me/adaccounts"
    );
    expect(result.campaigns).toEqual([
      expect.objectContaining({
        campaignId: "campaign-9",
        campaignName: "Recovered campaign",
      }),
    ]);
  });

  it("includes later pages and the sixth connected account without inventing a platform", async () => {
    mockFetch.mockImplementation((input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith("act_1/campaigns")) {
        return Promise.resolve(
          url.searchParams.has("after")
            ? graphResponse([{ id: "campaign-later", name: "Later page" }])
            : graphResponse(
                [{ id: "campaign-first" }],
                true,
                "https://graph.facebook.com/v25.0/act_1/campaigns?after=next&access_token=stale-token"
              )
        );
      }
      if (url.pathname.endsWith("act_6/ads")) {
        return Promise.resolve(graphResponse([{ id: "sixth-account-ad" }]));
      }
      return Promise.resolve(emptyGraphResponse());
    });
    const result = await fetchLiveMetaReferralAudience({
      access_token: "token",
      ad_accounts: Array.from({ length: 6 }, (_, i) => ({
        id: `act_${i + 1}`,
      })),
    });
    expect(result.campaigns.map(row => row.campaignId)).toEqual([
      "campaign-first",
      "campaign-later",
    ]);
    expect(result.ads).toEqual([
      expect.objectContaining({ sourceId: "sixth-account-ad" }),
    ]);
    expect(result.ads[0].sourcePlatform).toBeUndefined();
    expect(result.dataStatus).toEqual({ state: "complete", reasons: [] });
  });

  it("preserves fetched campaigns and reports a failed next page", async () => {
    mockFetch.mockImplementation((input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/campaigns")) {
        return Promise.resolve(
          url.searchParams.has("after")
            ? graphResponse([], false)
            : graphResponse(
                [{ id: "campaign-kept" }],
                true,
                "https://graph.facebook.com/v25.0/act_1/campaigns?after=next"
              )
        );
      }
      return Promise.resolve(emptyGraphResponse());
    });
    const result = await fetchLiveMetaReferralAudience({
      access_token: "token",
      ad_accounts: [{ id: "act_1" }],
    });
    expect(result.campaigns.map(row => row.campaignId)).toEqual([
      "campaign-kept",
    ]);
    expect(result.dataStatus).toEqual({
      state: "partial",
      reasons: ["access_unavailable"],
    });
  });

  it("rejects unsafe pagination and preserves the safe first page", async () => {
    mockFetch.mockImplementation((input: string) =>
      Promise.resolve(
        new URL(input).pathname.endsWith("/campaigns")
          ? graphResponse(
              [{ id: "campaign-kept" }],
              true,
              "https://attacker.example/steal"
            )
          : emptyGraphResponse()
      )
    );
    const result = await fetchLiveMetaReferralAudience({
      access_token: "token",
      ad_accounts: [{ id: "act_1" }],
    });
    expect(result.campaigns.map(row => row.campaignId)).toEqual([
      "campaign-kept",
    ]);
    expect(result.dataStatus).toEqual({
      state: "partial",
      reasons: ["provider_error"],
    });
    expect(
      mockFetch.mock.calls.every(
        ([input]) => new URL(input).hostname === "graph.facebook.com"
      )
    ).toBe(true);
  });

  it("reports bounded traversal as partial instead of a complete catalog", async () => {
    let page = 0;
    mockFetch.mockImplementation((input: string) => {
      if (!new URL(input).pathname.endsWith("/campaigns"))
        return Promise.resolve(emptyGraphResponse());
      page += 1;
      return Promise.resolve(
        graphResponse(
          Array.from({ length: 200 }, (_, i) => ({
            id: `campaign-${page}-${i}`,
          })),
          true,
          `https://graph.facebook.com/v25.0/act_1/campaigns?after=${page}`
        )
      );
    });
    const result = await fetchLiveMetaReferralAudience({
      access_token: "token",
      ad_accounts: [{ id: "act_1" }],
    });
    expect(result.campaigns.length).toBeGreaterThan(200);
    expect(result.campaigns.length).toBeLessThanOrEqual(1000);
    expect(result.dataStatus).toEqual({
      state: "partial",
      reasons: ["limit_reached"],
    });
  });

  it("distinguishes inaccessible data from an empty account", async () => {
    mockFetch.mockResolvedValue(graphResponse([], false));
    const result = await fetchLiveMetaReferralAudience({
      access_token: "token",
      ad_accounts: [{ id: "act_1" }],
    });
    expect(result.dataStatus).toEqual({
      state: "unavailable",
      reasons: ["access_unavailable"],
    });
  });

  it("reports no accessible ad accounts instead of a complete empty catalog", async () => {
    mockFetch.mockResolvedValue(emptyGraphResponse());
    const result = await fetchLiveMetaReferralAudience({
      access_token: "token",
    });
    expect(result.dataStatus).toEqual({
      state: "unavailable",
      reasons: ["access_unavailable"],
    });
  });

  it("does not request catalog data with an expired or explicitly insufficient grant", async () => {
    mockFetch.mockResolvedValue(emptyGraphResponse());
    for (const credentials of [
      { scope: "pages_show_list" },
      { scope: "ads_read", expires_at: "2020-01-01T00:00:00Z" },
    ]) {
      const result = await fetchLiveMetaReferralAudience({
        access_token: "token",
        ad_accounts: [{ id: "act_1" }],
        ...credentials,
      });
      expect(result.dataStatus).toEqual({
        state: "unavailable",
        reasons: ["access_unavailable"],
      });
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
