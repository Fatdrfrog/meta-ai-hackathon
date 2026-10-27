const mockCreateClient = jest.fn();
const mockCheckUserWorkspaceAccess = jest.fn();
const mockBuildCacheKey = jest.fn();
const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();
const mockConnectDB = jest.fn();
const mockCalculateDashboardMetrics = jest.fn();
const mockSupabaseFrom = jest.fn();
const mockGetWorkspaceManagerReplyGuardConfig = jest.fn();
const mockFetchMetaAdsDashboardInsights = jest.fn();
const mockGetUserProfilesByIds = jest.fn();
const mockGetConversionAttributionReport = jest.fn();
const mockGetConversionFeedbackReport = jest.fn();

jest.mock("@/lib/conversions/conversion-attribution", () => ({
  getConversionAttributionReport: (...args: unknown[]) =>
    mockGetConversionAttributionReport(...args),
}));

jest.mock("@/lib/conversions/conversion-feedback-report", () => ({
  getConversionFeedbackReport: (...args: unknown[]) =>
    mockGetConversionFeedbackReport(...args),
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/supabase/queries", () => ({
  checkUserWorkspaceAccess: (...args: unknown[]) =>
    mockCheckUserWorkspaceAccess(...args),
}));

jest.mock("@/lib/airi/reply/runtime/manager-reply-guard", () => ({
  getWorkspaceManagerReplyGuardConfig: (...args: unknown[]) =>
    mockGetWorkspaceManagerReplyGuardConfig(...args),
}));

jest.mock("@/lib/cache", () => ({
  buildCacheKey: (...args: unknown[]) => mockBuildCacheKey(...args),
  cache: {
    get: (...args: unknown[]) => mockCacheGet(...args),
    set: (...args: unknown[]) => mockCacheSet(...args),
  },
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/metrics-calculator", () => ({
  calculateDashboardMetrics: (...args: unknown[]) =>
    mockCalculateDashboardMetrics(...args),
}));

jest.mock("@/lib/meta-ads/meta-ads-insights", () => ({
  fetchMetaAdsDashboardInsights: (...args: unknown[]) =>
    mockFetchMetaAdsDashboardInsights(...args),
}));

jest.mock("@/lib/supabase/company-users", () => ({
  ...jest.requireActual("@/lib/supabase/company-users"),
  getMembershipDisplayName: (
    membership: {
      email?: string | null;
      users?: { full_name?: string | null } | null;
    },
    fallback: string
  ) => membership.users?.full_name || membership.email || fallback,
  getUserProfilesByIds: (...args: unknown[]) =>
    mockGetUserProfilesByIds(...args),
}));

import { GET } from "./route";
import { supabaseAuth } from "@/test-support/supabase-auth-test-utils";

describe("GET /api/dashboard", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateClient.mockResolvedValue({
      auth: supabaseAuth(),
      from: mockSupabaseFrom,
    });
    mockSupabaseFrom.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      in: jest.fn().mockResolvedValue({
        data: [
          {
            user_id: "manager-1",
            role: "manager",
            email: "manager@example.com",
            users: { full_name: "Manager One", avatar_url: null },
          },
        ],
        error: null,
      }),
    });
    mockCheckUserWorkspaceAccess.mockResolvedValue(true);
    mockBuildCacheKey.mockReturnValue("dashboard-cache-key");
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockResolvedValue(undefined);
    mockConnectDB.mockResolvedValue(undefined);
    mockGetWorkspaceManagerReplyGuardConfig.mockResolvedValue({
      managerUserLinks: [],
    });
    mockGetUserProfilesByIds.mockResolvedValue(
      new Map([["manager-1", { full_name: "Manager One", avatar_url: null }]])
    );
    mockFetchMetaAdsDashboardInsights.mockResolvedValue(null);
    mockGetConversionAttributionReport
      .mockReset()
      .mockResolvedValue({ rows: [], recentDeliveries: [], truncated: false });
    mockGetConversionFeedbackReport.mockReset().mockResolvedValue(null);
    mockCalculateDashboardMetrics.mockResolvedValue({
      stats: [{ id: "total", value: 3, secondaryValue: null, trend: 0 }],
      dailyCounts: [],
      conversationActivityByTime: [],
      topGrowingCategories: [],
      topDecliningCategories: [],
      peakTime: null,
      topCategories: [],
      uncategorizedCount: 0,
      categoriesByChannel: [],
      topComplaintTag: null,
      advertisement: {
        totalConversations: 0,
        uniqueSources: 0,
        respondedConversations: 0,
        closedConversations: 0,
        responseRate: 0,
        closeRate: 0,
        topSources: [],
        bySourceType: [],
        dailyCounts: [],
      },
      internalLabels: {
        taggedConversations: 0,
        unlabeledConversations: 0,
        uniqueLabels: 0,
        totalAssignments: 0,
        availableLabels: [],
        topLabels: [],
      },
      managerOptions: [],
      managerPerformance: [],
      firstResponse: {
        count: 0,
        medianSeconds: null,
        averageSeconds: null,
        p90Seconds: null,
      },
    });
  });

  it("uses one locale-neutral cache key for raw dashboard payloads", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-05T12:00:00.000Z"));
    const response = await GET(
      new Request(
        "http://localhost/api/dashboard?workspaceId=workspace-1&period=30",
        { headers: { "accept-language": "ru" } }
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.stats).toEqual([
      { id: "total", value: 3, secondaryValue: null, trend: 0 },
    ]);
    expect(payload.stats[0]).not.toHaveProperty("label");
    expect(payload).toMatchObject({ peakTime: null, topComplaintTag: null });
    expect(mockBuildCacheKey).toHaveBeenCalledWith("dashboard", [
      "workspace=%5B%22workspace-1%22%5D",
      "versions=%5B%22responseContract%3AdashboardComparison%3Av2%22%2C%22messageConversationVolume%3Av1%22%2C%22firstResponseComparison%3Av1%22%2C%22metaAdsInsightsAccounts%3Av2%22%2C%22activityByMessageDate%3Av1%22%2C%22conversionAttribution%3Av2%22%2C%22metricTruth%3Av2%22%2C%22cardPeriodComparisons%3Av1%22%5D",
      "period=%5B%22comparison%22%2C%2230d%22%2C%22adjacent_equal_duration%22%2C%22UTC%22%2C%22anchorBucket%22%2C19843680%5D",
      "channels=%5B%5D",
      "categories=%5B%5D",
      "internalLabels=%5B%5D",
      "managerIds=%5B%5D",
      "timeZone=%5B%22UTC%22%5D",
    ]);
  });

  it("passes exact custom ranges through to the metrics calculator and cache key", async () => {
    const from = "2026-05-01";
    const to = "2026-05-07";

    const response = await GET(
      new Request(
        `http://localhost/api/dashboard?workspaceId=workspace-1&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&timezone=Asia%2FQyzylorda&channels=whatsapp&channels=telegram&categories=Complaint&internalLabels=vip`
      )
    );

    expect(response.status).toBe(200);
    expect(mockCalculateDashboardMetrics).toHaveBeenCalledWith(
      "workspace-1",
      {
        preset: "custom",
        strategy: "adjacent_equal_duration",
        timeZone: "Asia/Qyzylorda",
        current: {
          start: "2026-04-30T19:00:00.000Z",
          endExclusive: "2026-05-07T19:00:00.000Z",
        },
        previous: {
          start: "2026-04-23T19:00:00.000Z",
          endExclusive: "2026-04-30T19:00:00.000Z",
        },
      },
      {
        channels: ["telegram", "whatsapp"],
        categories: ["Complaint"],
        internalLabels: ["vip"],
        managerIds: [],
        managerOptions: [
          {
            id: "manager-1",
            name: "Manager One",
            role: "manager",
            email: "manager@example.com",
            avatarUrl: null,
          },
        ],
        managerUserLinks: [],
        timeZone: "Asia/Qyzylorda",
      }
    );
    expect(mockFetchMetaAdsDashboardInsights).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      comparisonPeriod: {
        preset: "custom",
        strategy: "adjacent_equal_duration",
        timeZone: "Asia/Qyzylorda",
        current: {
          start: "2026-04-30T19:00:00.000Z",
          endExclusive: "2026-05-07T19:00:00.000Z",
        },
        previous: {
          start: "2026-04-23T19:00:00.000Z",
          endExclusive: "2026-04-30T19:00:00.000Z",
        },
      },
    });
    expect(mockBuildCacheKey).toHaveBeenCalledWith(
      "dashboard",
      expect.arrayContaining([
        "period=%5B%22comparison%22%2C%22custom%22%2C%22adjacent_equal_duration%22%2C%22Asia%2FQyzylorda%22%2C%222026-04-30T19%3A00%3A00.000Z%22%2C%222026-05-07T19%3A00%3A00.000Z%22%2C%222026-04-23T19%3A00%3A00.000Z%22%2C%222026-04-30T19%3A00%3A00.000Z%22%5D",
        "channels=%5B%22telegram%22%2C%22whatsapp%22%5D",
        "categories=%5B%22Complaint%22%5D",
        "internalLabels=%5B%22vip%22%5D",
        "managerIds=%5B%5D",
      ])
    );
  });

  it.each(["0", "-7", "31", "999", "junk"])(
    "rejects unsupported period %s",
    async period => {
      const response = await GET(
        new Request(
          `http://localhost/api/dashboard?workspaceId=workspace-1&period=${period}`
        )
      );

      expect(response.status).toBe(400);
      expect(mockCalculateDashboardMetrics).not.toHaveBeenCalled();
    }
  );

  it.each([
    "from=&to=",
    "from=%20%20&to=%20",
    "from=2026-05-01",
    "from=not-a-date&to=2026-05-07",
    "from=2026-05-08&to=2026-05-07",
    "from=2025-01-01&to=2026-01-02",
  ])("rejects invalid custom range %s", async query => {
    const response = await GET(
      new Request(
        `http://localhost/api/dashboard?workspaceId=workspace-1&${query}`
      )
    );

    expect(response.status).toBe(400);
    expect(mockCalculateDashboardMetrics).not.toHaveBeenCalled();
  });

  it("uses one request anchor and one normalized period for metrics and Meta Ads", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-05T12:00:00.000Z"));

    const response = await GET(
      new Request(
        "http://localhost/api/dashboard?workspaceId=workspace-1&period=this_week&timezone=UTC"
      )
    );

    expect(response.status).toBe(200);
    const metricsPeriod = mockCalculateDashboardMetrics.mock.calls[0][1];
    const metaPeriod =
      mockFetchMetaAdsDashboardInsights.mock.calls[0][0].comparisonPeriod;
    expect(metricsPeriod).toBe(metaPeriod);
    expect(metricsPeriod).toEqual({
      preset: "this_week",
      strategy: "previous_week_same_elapsed",
      timeZone: "UTC",
      current: {
        start: "2026-08-03T00:00:00.000Z",
        endExclusive: "2026-08-05T12:00:00.000Z",
      },
      previous: {
        start: "2026-07-27T00:00:00.000Z",
        endExclusive: "2026-07-29T12:00:00.000Z",
      },
    });
  });

  it("buckets rolling cache identity while keeping custom boundaries distinct", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-05T12:00:10.000Z"));
    await GET(
      new Request(
        "http://localhost/api/dashboard?workspaceId=workspace-1&period=30&timezone=UTC"
      )
    );
    jest.setSystemTime(new Date("2026-08-05T12:00:50.000Z"));
    await GET(
      new Request(
        "http://localhost/api/dashboard?workspaceId=workspace-1&period=30&timezone=UTC"
      )
    );
    await GET(
      new Request(
        "http://localhost/api/dashboard?workspaceId=workspace-1&from=2026-05-01&to=2026-05-07&timezone=UTC"
      )
    );
    await GET(
      new Request(
        "http://localhost/api/dashboard?workspaceId=workspace-1&from=2026-05-02&to=2026-05-08&timezone=UTC"
      )
    );

    const cacheParts = mockBuildCacheKey.mock.calls.map(call => call[1]);
    expect(cacheParts[0]).toEqual(cacheParts[1]);
    expect(cacheParts[2]).not.toEqual(cacheParts[3]);
  });

  it("merges Meta Ads Manager insights into the advertisement payload", async () => {
    mockFetchMetaAdsDashboardInsights.mockResolvedValue({
      dateStart: "2026-06-21",
      dateStop: "2026-06-22",
      resultActionType: "onsite_conversion.messaging_conversation_started_7d",
      resultLabel: "Messaging conversations started",
      totalResults: 17,
      totalSpend: 13.55,
      costPerResult: 0.797059,
      currency: "USD",
      accountId: "act_1443702520598900",
      accountName: "Selected Account",
      accountTimezone: "Asia/Almaty",
      sourceCount: 1,
      accountCount: 1,
      partial: false,
      error: null,
      fetchedAt: "2026-06-23T10:00:00.000Z",
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
      topAds: [],
    });

    const response = await GET(
      new Request(
        "http://localhost/api/dashboard?workspaceId=workspace-1&period=30"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.advertisement.metaInsights).toMatchObject({
      totalResults: 17,
      totalSpend: 13.55,
      currency: "USD",
    });
    expect(mockCacheSet).toHaveBeenCalledWith(
      "dashboard-cache-key",
      expect.objectContaining({
        advertisement: expect.objectContaining({
          metaInsights: expect.objectContaining({ totalResults: 17 }),
        }),
      }),
      90
    );
  });

  it("enriches sales for the exact workspace/date scope using the authenticated client", async () => {
    const report = {
      rows: [{ adId: "ad-1", currency: "KZT", sales: 1 }],
      recentDeliveries: [],
      truncated: false,
    };
    mockGetConversionAttributionReport.mockResolvedValue(report);
    const response = await GET(
      new Request(
        "http://localhost/api/dashboard?workspaceId=workspace-1&from=2026-09-01&to=2026-09-07&timezone=Asia%2FQyzylorda&managerIds=manager-a&categories=Support&channels=whatsapp"
      )
    );
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.advertisement.conversionAttribution).toEqual(report);
    expect(payload.advertisement.conversionAttributionError).toBeNull();
    expect(mockGetConversionAttributionReport).toHaveBeenCalledWith({
      supabase: await mockCreateClient.mock.results[0].value,
      workspaceId: "workspace-1",
      start: "2026-08-31T19:00:00.000Z",
      timeZone: "Asia/Qyzylorda",
      end: "2026-09-07T19:00:00.000Z",
    });
  });

  it("preserves the dashboard with an explicit sales failure instead of zero sales", async () => {
    mockGetConversionAttributionReport.mockRejectedValue(
      new Error("private database diagnostic")
    );
    const response = await GET(
      new Request(
        "http://localhost/api/dashboard?workspaceId=workspace-1&period=30"
      )
    );
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.advertisement.conversionAttribution).toBeNull();
    expect(payload.advertisement.conversionAttributionError).toBe(
      "unavailable"
    );
    expect(JSON.stringify(payload)).not.toContain(
      "private database diagnostic"
    );
    expect(payload.stats).toHaveLength(1);
  });

  it("returns Meta sales feedback for the exact dashboard window", async () => {
    const feedback = {
      recorded: 3,
      eligible: 2,
      statuses: {
        not_eligible: 1,
        pending: 0,
        queued: 0,
        sent: 2,
        rejected: 0,
        delivery_unknown: 0,
      },
      oldestPendingAt: null,
      reasons: [],
      truncated: false,
    };
    mockGetConversionFeedbackReport.mockResolvedValue(feedback);
    const response = await GET(
      new Request(
        "http://localhost/api/dashboard?workspaceId=workspace-1&from=2026-09-01&to=2026-09-07&timezone=Asia%2FQyzylorda"
      )
    );
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.advertisement.conversionFeedback).toEqual(feedback);
    expect(payload.advertisement.conversionFeedbackError).toBeNull();
    expect(mockGetConversionFeedbackReport).toHaveBeenCalledWith({
      supabase: await mockCreateClient.mock.results[0].value,
      workspaceId: "workspace-1",
      start: "2026-08-31T19:00:00.000Z",
      end: "2026-09-07T19:00:00.000Z",
      timeZone: "Asia/Qyzylorda",
    });
  });

  it("keeps sales attribution when only the Meta feedback report fails", async () => {
    const report = { rows: [], recentDeliveries: [], truncated: false };
    mockGetConversionAttributionReport.mockResolvedValue(report);
    mockGetConversionFeedbackReport.mockRejectedValue(
      new Error("private feedback diagnostic")
    );
    const response = await GET(
      new Request(
        "http://localhost/api/dashboard?workspaceId=workspace-1&period=30"
      )
    );
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.advertisement.conversionFeedback).toBeNull();
    expect(payload.advertisement.conversionFeedbackError).toBe("unavailable");
    expect(payload.advertisement.conversionAttribution).toEqual(report);
    expect(payload.advertisement.conversionAttributionError).toBeNull();
    expect(JSON.stringify(payload)).not.toContain(
      "private feedback diagnostic"
    );
  });

  it("includes sales for exactly 366 calendar days across a DST fall-back", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/dashboard?workspaceId=workspace-1&from=2023-11-05&to=2024-11-04&timezone=America%2FNew_York"
      )
    );
    expect(response.status).toBe(200);
    expect(mockGetConversionAttributionReport).toHaveBeenCalledWith(
      expect.objectContaining({
        start: "2023-11-05T04:00:00.000Z",
        end: "2024-11-05T05:00:00.000Z",
        timeZone: "America/New_York",
      })
    );
  });

  it("rejects an actual 367-calendar-day range before requesting sales", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/dashboard?workspaceId=workspace-1&from=2023-11-05&to=2024-11-05&timezone=America%2FNew_York"
      )
    );
    expect(response.status).toBe(400);
    expect(mockGetConversionAttributionReport).not.toHaveBeenCalled();
  });

  it("does not request sales before workspace access is granted", async () => {
    mockCheckUserWorkspaceAccess.mockResolvedValue(false);
    const response = await GET(
      new Request(
        "http://localhost/api/dashboard?workspaceId=other-workspace&period=30"
      )
    );
    expect(response.status).toBe(403);
    expect(mockGetConversionAttributionReport).not.toHaveBeenCalled();
  });

  it("passes selected managers through to metrics and cache key", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/dashboard?workspaceId=workspace-1&period=30&managerIds=manager-b&managerIds=manager-a"
      )
    );

    expect(response.status).toBe(200);
    expect(mockCalculateDashboardMetrics).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        preset: "30d",
        strategy: "adjacent_equal_duration",
        timeZone: "UTC",
      }),
      expect.objectContaining({
        managerIds: ["manager-a", "manager-b"],
        timeZone: "UTC",
      })
    );
    expect(mockBuildCacheKey).toHaveBeenCalledWith(
      "dashboard",
      expect.arrayContaining([
        "managerIds=%5B%22manager-a%22%2C%22manager-b%22%5D",
      ])
    );
  });
});
