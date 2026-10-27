const mockSupabaseFrom = jest.fn();
const mockDecryptMaybeString = jest.fn((value: unknown) =>
  typeof value === "string" ? value : ""
);
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();
const mockAccountGetJson = jest.fn();

jest.mock("@icecore/shared/lib/meta/api", () => ({
  ...jest.requireActual("@icecore/shared/lib/meta/api"),
  getWhatsAppGraphClient: () => ({
    getJson: (...args: unknown[]) => mockAccountGetJson(...args),
  }),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
  },
}));

jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: (value: unknown) => mockDecryptMaybeString(value),
}));

jest.mock("@/lib/observability/server-logs", () => ({
  createServerLogger: () => ({
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: jest.fn(),
  }),
}));

import {
  fetchMetaAdsDashboardInsights,
  resolveMetaAdsInsightsDateRange,
} from "./meta-ads-insights";

const mockFetch = jest.fn();

function mockSourcesQuery(data: unknown[]) {
  mockSupabaseFrom.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue({ data, error: null }),
  });
}

function graphResponse(data: unknown[], ok = true) {
  return {
    ok,
    status: ok ? 200 : 400,
    json: jest.fn().mockResolvedValue(
      ok
        ? { data }
        : {
            error: {
              message: "Graph request failed",
            },
          }
    ),
  };
}

describe("Meta Ads dashboard insights", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAccountGetJson.mockReset();
    global.fetch = mockFetch as never;
    mockSourcesQuery([]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });
  it("reads only the requested integration and freshly verified account", async () => {
    mockAccountGetJson.mockResolvedValue({
      id: "act_123",
      currency: "USD",
      timezone_name: "UTC",
    });
    const eq = jest.fn().mockReturnThis();
    mockSupabaseFrom.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq,
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({
        data: [
          {
            id: "source-1",
            credentials: {
              access_token: "token",
              ad_accounts: [{ id: "act_999", currency: "KZT" }],
            },
          },
        ],
        error: null,
      }),
    });
    mockFetch.mockImplementation((input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/act_123"))
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            id: "act_123",
            currency: "USD",
            timezone_name: "UTC",
          }),
        });
      return Promise.resolve(graphResponse([]));
    });
    const result = await fetchMetaAdsDashboardInsights({
      workspaceId: "workspace",
      sourceId: "source-1",
      adAccountId: "act_123",
      comparisonPeriod: {
        timeZone: "UTC",
        current: {
          start: "2026-09-01T00:00:00Z",
          endExclusive: "2026-10-01T00:00:00Z",
        },
      } as never,
    });
    expect(eq).toHaveBeenCalledWith("id", "source-1");
    expect(mockAccountGetJson).toHaveBeenCalledWith(
      "act_123",
      expect.anything()
    );
    expect(result?.accounts?.map(account => account.accountId)).toEqual([
      "act_123",
    ]);
    expect(
      mockFetch.mock.calls.some(([url]) => String(url).includes("act_999"))
    ).toBe(false);
  });
  it("does not issue provider reads after caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(
      fetchMetaAdsDashboardInsights({
        workspaceId: "workspace",
        signal: controller.signal,
        comparisonPeriod: {
          timeZone: "UTC",
          current: {
            start: "2026-09-01",
            endExclusive: "2026-10-01",
          },
        } as never,
      })
    ).rejects.toThrow("Stopped");
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it("cancels an in-flight source lookup before any Graph reads", async () => {
    const controller = new AbortController();
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      abortSignal: jest.fn().mockReturnThis(),
      then: jest.fn(() => new Promise(() => {})),
    };
    mockSupabaseFrom.mockReturnValue(query);
    const work = fetchMetaAdsDashboardInsights({
      workspaceId: "workspace",
      signal: controller.signal,
      comparisonPeriod: {
        timeZone: "UTC",
        current: {
          start: "2026-09-01",
          endExclusive: "2026-10-01",
        },
      } as never,
    });
    controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(work).rejects.toThrow("Stopped");
    expect(query.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockAccountGetJson).not.toHaveBeenCalled();
  });
  it("confirms WhatsApp destination only from explicit current ad-set configuration", async () => {
    mockSourcesQuery([
      {
        id: "source-1",
        credentials: {
          access_token: "token-1",
          ad_accounts: [
            {
              id: "act_123",
              name: "Account",
              currency: "USD",
              timezone_name: "UTC",
            },
          ],
        },
      },
    ]);
    const adIds = ["111111111111", "222222222222", "333333333333"];
    mockFetch.mockImplementation(
      (input: string, options: { method?: string; body?: string }) => {
        if (options.method === "POST") {
          const batch = JSON.parse(
            new URLSearchParams(options.body).get("batch")!
          );
          expect(batch).toHaveLength(3);
          expect(
            batch.every(
              (row: { method: string; relative_url: string }) =>
                row.method === "GET" &&
                row.relative_url.includes("adset") &&
                row.relative_url.includes("updated_time") &&
                !row.relative_url.includes("token")
            )
          ).toBe(true);
          return Promise.resolve({
            ok: true,
            json: async () =>
              adIds.map((id, index) => ({
                code: 200,
                body: JSON.stringify({
                  id,
                  adset: {
                    destination_type: [
                      "WHATSAPP",
                      "MESSAGING_MESSENGER_WHATSAPP",
                      "MESSENGER",
                    ][index],
                    updated_time:
                      index === 0 ? "2026-05-25T07:00:00+0000" : "invalid",
                  },
                }),
              })),
          });
        }
        const url = new URL(input);
        return Promise.resolve(
          graphResponse(
            url.searchParams.get("level") === "account"
              ? [
                  {
                    impressions: "100",
                    inline_link_clicks: "5",
                    reach: "90",
                    frequency: "1.1",
                  },
                ]
              : adIds.map(ad_id => ({
                  ad_id,
                  spend: "10",
                  date_start: "2026-06-01",
                  actions: [
                    {
                      action_type:
                        "onsite_conversion.messaging_conversation_started_7d",
                      value: "1",
                      action_destination: "whatsapp",
                    },
                  ],
                }))
          )
        );
      }
    );
    const result = await fetchMetaAdsDashboardInsights({
      workspaceId: "workspace",
      comparisonPeriod: {
        timeZone: "UTC",
        current: { start: "2026-06-01", endExclusive: "2026-06-03" },
      } as never,
    });
    expect(result?.topAds.map(ad => ad.destination)).toEqual([
      "whatsapp",
      "other",
      "other",
    ]);
    expect(result?.topAds[1].destinationType).toBe(
      "MESSAGING_MESSENGER_WHATSAPP"
    );
    expect(result?.topAds[0].destinationUpdatedAt).toBe(
      "2026-05-25T07:00:00.000Z"
    );
    expect(result?.topAds[1].destinationUpdatedAt).toBeNull();
  });
  it("keeps denied ad-set destination unknown without guessing from messaging actions", async () => {
    mockSourcesQuery([
      {
        id: "source-1",
        credentials: {
          access_token: "token-1",
          ad_accounts: [
            {
              id: "act_123",
              name: "Account",
              currency: "USD",
              timezone_name: "UTC",
            },
          ],
        },
      },
    ]);
    mockFetch.mockImplementation(
      (input: string, options: { method?: string }) =>
        options.method === "POST"
          ? Promise.resolve({
              ok: true,
              json: async () => [
                {
                  code: 403,
                  body: JSON.stringify({
                    error: { message: "private provider reason" },
                  }),
                },
              ],
            })
          : Promise.resolve(
              graphResponse(
                new URL(input).searchParams.get("level") === "account"
                  ? []
                  : [
                      {
                        ad_id: "111111111111",
                        spend: "10",
                        date_start: "2026-06-01",
                        actions: [
                          {
                            action_type:
                              "onsite_conversion.messaging_conversation_started_7d",
                            value: "1",
                            action_destination: "whatsapp",
                          },
                        ],
                      },
                    ]
              )
            )
    );
    const result = await fetchMetaAdsDashboardInsights({
      workspaceId: "workspace",
      comparisonPeriod: {
        timeZone: "UTC",
        current: { start: "2026-06-01", endExclusive: "2026-06-03" },
      } as never,
    });
    expect(result?.topAds[0].destination).toBeNull();
    expect(result?.topAds[0].destinationType).toBeNull();
    expect(result?.totalSpend).toBe(10);
  });

  it("aggregates Ads Manager messaging results and spend by selected ad account", async () => {
    mockSourcesQuery([
      {
        id: "source-1",
        name: "Meta Ads",
        credentials: {
          access_token: "token-1",
          selected_ad_account_id: "act_1443702520598900",
          ad_accounts: [
            {
              id: "act_1443702520598900",
              name: "Selected Account",
              currency: "USD",
              timezone_name: "Asia/Almaty",
            },
            {
              id: "act_2231036097435363",
              name: "Results Account",
              currency: "USD",
              timezone_name: "Asia/Almaty",
            },
          ],
        },
      },
    ]);
    mockFetch.mockImplementation((input: string) => {
      const path = new URL(input).pathname;
      if (path === "/v25.0/act_1443702520598900/insights") {
        return Promise.resolve(graphResponse([]));
      }
      if (path === "/v25.0/act_2231036097435363/insights") {
        return Promise.resolve(
          graphResponse([
            {
              ad_id: "120249144478770472",
              ad_name: "June WhatsApp engagement",
              campaign_id: "campaign-1",
              campaign_name: "Campaign",
              adset_id: "adset-1",
              adset_name: "Ad Set",
              date_start: "2026-06-21",
              date_stop: "2026-06-21",
              spend: "7.44",
              actions: [
                {
                  action_type:
                    "onsite_conversion.messaging_conversation_started_7d",
                  value: "5",
                },
              ],
            },
            {
              ad_id: "120249144478770472",
              ad_name: "June WhatsApp engagement",
              campaign_id: "campaign-1",
              campaign_name: "Campaign",
              adset_id: "adset-1",
              adset_name: "Ad Set",
              date_start: "2026-06-22",
              date_stop: "2026-06-22",
              spend: "6.11",
              actions: [
                {
                  action_type:
                    "onsite_conversion.messaging_conversation_started_7d",
                  value: "12",
                },
              ],
            },
          ])
        );
      }
      return Promise.resolve(graphResponse([]));
    });

    const result = await fetchMetaAdsDashboardInsights({
      workspaceId: "41b51d55-697c-4455-875a-9a7238bdf272",
      comparisonPeriod: {
        preset: "custom",
        strategy: "adjacent_equal_duration",
        timeZone: "Asia/Qyzylorda",
        current: {
          start: "2026-06-20T19:00:00.000Z",
          endExclusive: "2026-06-22T19:00:00.000Z",
        },
        previous: {
          start: "2026-06-18T19:00:00.000Z",
          endExclusive: "2026-06-20T19:00:00.000Z",
        },
      },
    });

    expect(result).toMatchObject({
      dateStart: "2026-06-21",
      dateStop: "2026-06-22",
      totalResults: 17,
      totalSpend: 13.55,
      costPerResult: 0.797059,
      currency: "USD",
      accountId: "act_2231036097435363",
      accountName: "Results Account",
      accountTimezone: "Asia/Almaty",
      sourceCount: 1,
      accountCount: 2,
      partial: false,
      dailyCounts: [
        {
          date: "2026-06-21",
          results: 5,
          spend: 7.44,
          costPerResult: 1.488,
        },
        {
          date: "2026-06-22",
          results: 12,
          spend: 6.11,
          costPerResult: 0.509167,
        },
      ],
      topAds: [
        expect.objectContaining({
          adId: "120249144478770472",
          results: 17,
          spend: 13.55,
          costPerResult: 0.797059,
        }),
      ],
    });

    const adRequests = mockFetch.mock.calls
      .map(([input]) => new URL(input))
      .filter(url => url.searchParams.get("level") === "ad");
    const selectedRequestUrl = adRequests[0];
    const resultsRequestUrl = adRequests[1];
    expect(selectedRequestUrl.pathname).toBe(
      "/v25.0/act_1443702520598900/insights"
    );
    expect(resultsRequestUrl.pathname).toBe(
      "/v25.0/act_2231036097435363/insights"
    );
    expect(resultsRequestUrl.searchParams.get("level")).toBe("ad");
    expect(resultsRequestUrl.searchParams.get("time_increment")).toBe("1");
    expect(
      JSON.parse(resultsRequestUrl.searchParams.get("time_range") || "{}")
    ).toEqual({
      since: "2026-06-21",
      until: "2026-06-22",
    });
  });

  it("decrements a normal-midnight custom exclusive end", () => {
    expect(
      resolveMetaAdsInsightsDateRange(
        {
          start: "2026-06-20T19:00:00.000Z",
          endExclusive: "2026-06-21T19:00:00.000Z",
        },
        "Asia/Qyzylorda"
      )
    ).toEqual({
      since: "2026-06-21",
      until: "2026-06-21",
    });
  });

  it("keeps the local end date for a non-midnight rolling end", () => {
    expect(
      resolveMetaAdsInsightsDateRange(
        {
          start: "2026-07-06T12:00:00.000Z",
          endExclusive: "2026-08-05T12:00:00.000Z",
        },
        "UTC"
      )
    ).toEqual({
      since: "2026-07-06",
      until: "2026-08-05",
    });
  });

  it("decrements a custom exclusive end when DST skips local midnight", () => {
    expect(
      resolveMetaAdsInsightsDateRange(
        {
          start: "2026-03-07T05:00:00.000Z",
          endExclusive: "2026-03-08T05:00:00.000Z",
        },
        "America/Havana"
      )
    ).toEqual({
      since: "2026-03-07",
      until: "2026-03-07",
    });
  });

  it("accepts the route-normalized comparison period without resolving now", async () => {
    mockSourcesQuery([]);

    await expect(
      fetchMetaAdsDashboardInsights({
        workspaceId: "workspace-1",
        comparisonPeriod: {
          preset: "30d",
          strategy: "adjacent_equal_duration",
          timeZone: "UTC",
          current: {
            start: "2026-07-06T12:00:00.000Z",
            endExclusive: "2026-08-05T12:00:00.000Z",
          },
          previous: {
            start: "2026-06-06T12:00:00.000Z",
            endExclusive: "2026-07-06T12:00:00.000Z",
          },
        },
      })
    ).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null when the workspace has no Meta Ads source credentials", async () => {
    mockSourcesQuery([]);

    await expect(
      fetchMetaAdsDashboardInsights({
        workspaceId: "workspace-1",
        comparisonPeriod: {
          preset: "30d",
          strategy: "adjacent_equal_duration",
          timeZone: "UTC",
          current: {
            start: "2026-07-06T12:00:00.000Z",
            endExclusive: "2026-08-05T12:00:00.000Z",
          },
          previous: {
            start: "2026-06-06T12:00:00.000Z",
            endExclusive: "2026-07-06T12:00:00.000Z",
          },
        },
      })
    ).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  const period = {
    preset: "custom",
    strategy: "adjacent_equal_duration",
    timeZone: "UTC",
    current: {
      start: "2026-09-01T00:00:00Z",
      endExclusive: "2026-09-03T00:00:00Z",
    },
    previous: null,
  } as const;
  const account = { id: "act_1", currency: "USD", timezone_name: "UTC" };
  function prepare(rows: unknown[], accounts: unknown[] = [account]) {
    mockSourcesQuery([
      {
        id: "source",
        credentials: { access_token: "token", ad_accounts: accounts },
      },
    ]);
    mockFetch.mockImplementation((input: string) => {
      const url = new URL(input);
      return Promise.resolve(
        graphResponse(
          url.searchParams.get("level") === "account"
            ? [
                {
                  impressions: "1000",
                  reach: "400",
                  frequency: "2.5",
                  inline_link_clicks: "20",
                },
              ]
            : rows
        )
      );
    });
  }
  const selectedAction = (value: string) => ({
    action_type: "onsite_conversion.messaging_conversation_started_7d",
    value,
  });

  it("stops new pages and accounts after the whole-report deadline", async () => {
    prepare(
      [],
      [account, { id: "act_2", currency: "USD", timezone_name: "UTC" }]
    );
    const now = jest.spyOn(Date, "now").mockReturnValue(0);
    mockFetch.mockImplementation((input: string) => {
      const url = new URL(input);
      if (url.searchParams.get("level") === "account")
        return Promise.resolve(graphResponse([]));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => {
          now.mockReturnValue(20001);
          return {
            data: [
              {
                ad_id: "ad",
                date_start: "2026-09-01",
                spend: "10",
                actions: [selectedAction("2")],
              },
            ],
            paging: {
              next: `${url.origin}${url.pathname}?level=ad&after=next`,
            },
          };
        },
      });
    });
    try {
      const result = await fetchMetaAdsDashboardInsights({
        workspaceId: "workspace",
        comparisonPeriod: period,
      });
      expect(result?.warnings).toContain("report_timeout");
      expect(result?.partial).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result?.totalSpend).toBe(10);
      expect(result?.costPerResult).toBeNull();
    } finally {
      now.mockRestore();
    }
  });

  it("shows connected sources with unavailable credentials as an incomplete report", async () => {
    mockSourcesQuery([{ id: "connected", credentials: null }]);
    const result = await fetchMetaAdsDashboardInsights({
      workspaceId: "workspace",
      comparisonPeriod: period,
    });
    expect(result).toMatchObject({
      partial: true,
      totalSpend: null,
      totalResults: null,
      warnings: ["credentials_unavailable"],
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("distinguishes source lookup failure from a workspace without Meta integration", async () => {
    mockSupabaseFrom.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({
        data: null,
        error: { message: "Private database detail" },
      }),
    });
    const result = await fetchMetaAdsDashboardInsights({
      workspaceId: "workspace",
      comparisonPeriod: period,
    });
    expect(result).toMatchObject({
      partial: true,
      totalSpend: null,
      totalResults: null,
      warnings: ["sources_unavailable"],
      error: "Meta Ads Manager data could not be loaded.",
    });
    expect(JSON.stringify(result)).not.toContain("Private database detail");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("never presents a completely failed account fetch as zero spend", async () => {
    prepare([]);
    mockFetch.mockResolvedValue(graphResponse([], false));
    const result = await fetchMetaAdsDashboardInsights({
      workspaceId: "workspace",
      comparisonPeriod: period,
    });
    expect(result).toMatchObject({
      partial: true,
      totalSpend: null,
      totalResults: null,
    });
    expect(result?.currencyBuckets?.[0].spend).toBeNull();
  });

  it("keeps present-zero spend and rejects missing or malformed spend totals", async () => {
    prepare([
      {
        ad_id: "zero",
        date_start: "2026-09-01",
        spend: "0",
        inline_link_clicks: "2",
        actions: [selectedAction("2")],
      },
      {
        ad_id: "missing",
        date_start: "2026-09-02",
        actions: [selectedAction("1")],
      },
      {
        ad_id: "invalid",
        date_start: "2026-09-02",
        spend: "not-a-number",
        actions: [selectedAction("1")],
      },
    ]);
    const result = await fetchMetaAdsDashboardInsights({
      workspaceId: "workspace",
      comparisonPeriod: period,
    });
    expect(result).toMatchObject({
      totalSpend: null,
      costPerResult: null,
      partial: true,
      spendCoverage: { reportedRows: 1, missingRows: 2 },
    });
    expect(result?.warnings).toContain("spend_not_reported");
    expect(result?.topAds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adId: "zero",
          spend: 0,
          missingSpendRows: 0,
        }),
        expect.objectContaining({
          adId: "missing",
          spend: null,
          missingSpendRows: 1,
        }),
        expect.objectContaining({
          adId: "invalid",
          spend: null,
          missingSpendRows: 1,
        }),
      ])
    );
    expect(
      result?.dailyCounts.find(day => day.date === "2026-09-02")?.spend
    ).toBeNull();
    expect(result?.currencyBuckets?.[0].spend).toBeNull();
    expect(result?.accounts?.[0].cpc).toBeNull();
  });

  it("rejects nonnumeric types and whitespace rather than treating them as zero metrics", async () => {
    prepare(
      [true, [], " "].map((spend, index) => ({
        ad_id: String(index),
        date_start: "2026-09-01",
        spend,
        actions: [selectedAction("0")],
      }))
    );
    const result = await fetchMetaAdsDashboardInsights({
      workspaceId: "workspace",
      comparisonPeriod: period,
    });
    expect(result).toMatchObject({
      totalSpend: null,
      partial: true,
      spendCoverage: { reportedRows: 0, missingRows: 3 },
    });
  });

  it("never divides partial ad spend by full-account summary clicks", async () => {
    prepare([]);
    mockFetch.mockImplementation((input: string) => {
      const url = new URL(input);
      if (url.searchParams.get("level") === "account")
        return Promise.resolve(
          graphResponse([{ impressions: "1000", inline_link_clicks: "20" }])
        );
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              ad_id: "ad",
              date_start: "2026-09-01",
              spend: "10",
              actions: [selectedAction("2")],
            },
          ],
          paging: { next: "https://outside.example/invalid" },
        }),
      });
    });
    const result = await fetchMetaAdsDashboardInsights({
      workspaceId: "workspace",
      comparisonPeriod: period,
    });
    expect(result?.partial).toBe(true);
    expect(result?.accounts?.[0].cpc).toBeNull();
  });

  it("withholds monetary efficiency when the account currency is unknown", async () => {
    prepare(
      [
        {
          ad_id: "ad",
          date_start: "2026-09-01",
          spend: "10",
          inline_link_clicks: "2",
          actions: [selectedAction("2")],
        },
      ],
      [{ id: "act_1", timezone_name: "UTC" }]
    );
    const result = await fetchMetaAdsDashboardInsights({
      workspaceId: "workspace",
      comparisonPeriod: period,
    });
    expect(result?.currencyBuckets?.[0]).toMatchObject({
      currency: null,
      costPerResult: null,
      cpc: null,
    });
    expect(result?.topAds[0].costPerResult).toBeNull();
    expect(result?.dailyCounts[0].costPerResult).toBeNull();
  });

  it("counts a reported row without the selected action as zero results", async () => {
    prepare([
      {
        ad_id: "zero",
        date_start: "2026-09-01",
        spend: "30",
        actions: [
          selectedAction("0"),
          {
            action_type: "onsite_conversion.messaging_first_reply",
            value: "9",
          },
        ],
      },
      { ad_id: "missing", date_start: "2026-09-02", spend: "20" },
    ]);
    const result = await fetchMetaAdsDashboardInsights({
      workspaceId: "workspace",
      comparisonPeriod: period,
    });
    expect(result).toMatchObject({
      totalSpend: 50,
      totalResults: 0,
      costPerResult: null,
      resultCoverage: { reportedRows: 2, missingRows: 0 },
    });
    expect(result?.warnings ?? []).not.toContain("results_not_reported");
    expect(result?.topAds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ adId: "zero", results: 0, spend: 30 }),
        expect.objectContaining({ adId: "missing", results: 0, spend: 20 }),
      ])
    );
  });

  it("keeps cost per result when a quiet day reports spend without conversation starts", async () => {
    prepare([
      {
        ad_id: "wa",
        date_start: "2026-09-01",
        spend: "10",
        actions: [selectedAction("5")],
      },
      { ad_id: "wa", date_start: "2026-09-02", spend: "3" },
    ]);
    const result = await fetchMetaAdsDashboardInsights({
      workspaceId: "workspace",
      comparisonPeriod: period,
    });
    expect(result).toMatchObject({
      totalSpend: 13,
      totalResults: 5,
      costPerResult: 2.6,
      resultCoverage: { reportedRows: 2, missingRows: 0 },
    });
    expect(result?.warnings ?? []).not.toContain("results_not_reported");
    expect(result?.topAds[0]).toMatchObject({
      adId: "wa",
      results: 5,
      costPerResult: 2.6,
    });
    expect(
      result?.dailyCounts.find(day => day.date === "2026-09-02")
    ).toMatchObject({ results: 0, spend: 3, costPerResult: null });
  });

  it("still reports a malformed selected action value as missing", async () => {
    prepare([
      {
        ad_id: "wa",
        date_start: "2026-09-01",
        spend: "10",
        actions: [selectedAction("not-a-number")],
      },
    ]);
    const result = await fetchMetaAdsDashboardInsights({
      workspaceId: "workspace",
      comparisonPeriod: period,
    });
    expect(result).toMatchObject({
      totalResults: null,
      costPerResult: null,
      resultCoverage: { reportedRows: 0, missingRows: 1 },
    });
    expect(result?.warnings).toContain("results_not_reported");
  });

  it("does not relabel a first-reply count as conversation starts", async () => {
    prepare([
      {
        ad_id: "ad",
        date_start: "2026-09-01",
        spend: "12",
        actions: [
          {
            action_type: "onsite_conversion.messaging_first_reply",
            value: "3",
          },
        ],
      },
    ]);
    const result = await fetchMetaAdsDashboardInsights({
      workspaceId: "workspace",
      comparisonPeriod: period,
    });
    expect(result).toMatchObject({
      totalResults: 0,
      totalSpend: 12,
      costPerResult: null,
      resultCoverage: { reportedRows: 1, missingRows: 0 },
    });
    expect(result?.actionCounts).toContainEqual({
      actionType: "onsite_conversion.messaging_first_reply",
      destination: null,
      value: 3,
    });
  });

  it("keeps different currencies in separate buckets without a mixed spend total", async () => {
    prepare(
      [
        {
          ad_id: "ad",
          date_start: "2026-09-01",
          spend: "10",
          actions: [selectedAction("2")],
        },
      ],
      [account, { id: "act_2", currency: "KZT", timezone_name: "Asia/Almaty" }]
    );
    const result = await fetchMetaAdsDashboardInsights({
      workspaceId: "workspace",
      comparisonPeriod: period,
    });
    expect(result).toMatchObject({
      totalResults: 4,
      totalSpend: null,
      costPerResult: null,
      currency: null,
    });
    expect(result?.currencyBuckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ currency: "USD", spend: 10, results: 2 }),
        expect.objectContaining({ currency: "KZT", spend: 10, results: 2 }),
      ])
    );
    expect(result?.topAds.map(row => row.currency)).toEqual(
      expect.arrayContaining(["USD", "KZT"])
    );
  });

  it("requests explicit attribution and report time and reads reach at period account scope", async () => {
    prepare([
      {
        ad_id: "ad",
        date_start: "2026-09-01",
        spend: "10",
        impressions: "300",
        inline_link_clicks: "6",
        actions: [selectedAction("2")],
      },
    ]);
    const result = await fetchMetaAdsDashboardInsights({
      workspaceId: "workspace",
      comparisonPeriod: period,
    });
    const urls = mockFetch.mock.calls.map(([input]) => new URL(input));
    const daily = urls.find(url => url.searchParams.get("level") === "ad")!;
    expect(daily.searchParams.get("use_unified_attribution_setting")).toBe(
      "true"
    );
    expect(daily.searchParams.get("action_report_time")).toBe("conversion");
    expect(daily.searchParams.get("action_breakdowns")).toBe(
      "action_type,action_destination"
    );
    expect(result?.accounts?.[0]).toMatchObject({
      reach: 400,
      frequency: 2.5,
      impressions: 1000,
      linkClicks: 20,
    });
    expect(result?.currencyBuckets?.[0]).toMatchObject({
      impressions: 300,
      linkClicks: 6,
      ctr: 2,
      cpc: 1.666667,
    });
  });

  it("marks pagination caps as incomplete and refuses an external paging host", async () => {
    prepare([]);
    mockFetch.mockImplementation((input: string) => {
      const url = new URL(input);
      if (url.searchParams.get("level") === "account")
        return Promise.resolve(graphResponse([]));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              ad_id: "ad",
              date_start: "2026-09-01",
              spend: "1",
              actions: [selectedAction("1")],
            },
          ],
          paging: { next: "https://outside.example/steal" },
        }),
      });
    });
    const result = await fetchMetaAdsDashboardInsights({
      workspaceId: "workspace",
      comparisonPeriod: period,
    });
    expect(result?.partial).toBe(true);
    expect(result?.warnings).toContain("invalid_paging");
    expect(
      mockFetch.mock.calls.some(([url]) =>
        String(url).includes("outside.example")
      )
    ).toBe(false);
  });

  it("marks a valid next page beyond the bounded report as truncated", async () => {
    prepare([]);
    mockFetch.mockImplementation((input: string) => {
      const url = new URL(input);
      if (url.searchParams.get("level") === "account")
        return Promise.resolve(graphResponse([]));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              ad_id: "ad",
              date_start: "2026-09-01",
              spend: "1",
              actions: [selectedAction("1")],
            },
          ],
          paging: {
            next: `${url.origin}${url.pathname}?level=ad&after=${mockFetch.mock.calls.length}`,
          },
        }),
      });
    });
    const result = await fetchMetaAdsDashboardInsights({
      workspaceId: "workspace",
      comparisonPeriod: period,
    });
    expect(result?.partial).toBe(true);
    expect(result?.warnings).toContain("rows_truncated");
    expect(result?.costPerResult).toBeNull();
    expect(
      mockFetch.mock.calls.every(
        ([url, init]) =>
          !String(url).includes("access_token") &&
          init.headers.Authorization === "Bearer token"
      )
    ).toBe(true);
  });
});
