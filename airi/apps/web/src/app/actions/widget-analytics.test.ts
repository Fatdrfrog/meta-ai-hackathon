const mockQueryPageviews = jest.fn();
const mockQuerySessionStats = jest.fn();
const mockQueryTrafficSources = jest.fn();
const mockQueryDeviceStats = jest.fn();
const mockQueryTopPages = jest.fn();
const mockQueryStatus = jest.fn();
const workspaceId = "41b51d55-697c-4455-875a-9a7238bdf272";

jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/supabase/server", () => ({
  createReadOnlyClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: () => ({
      select() {
        return this;
      },
      eq() {
        return this;
      },
      order() {
        return this;
      },
      single: async () => ({ data: { workspace_id: workspaceId } }),
      limit: async () => ({ data: [] }),
    }),
  }),
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    countDocuments: async () => 7,
    aggregate: async () => [],
    distinct: async () => [],
  },
}));
jest.mock("./posthog-queries", () => ({
  getPostHogQueryStatus: () => mockQueryStatus(),
  queryPageviews: (...args: unknown[]) => mockQueryPageviews(...args),
  querySessionStats: (...args: unknown[]) => mockQuerySessionStats(...args),
  queryTrafficSources: (...args: unknown[]) => mockQueryTrafficSources(...args),
  queryDeviceStats: (...args: unknown[]) => mockQueryDeviceStats(...args),
  queryTopPages: (...args: unknown[]) => mockQueryTopPages(...args),
}));

import { getWidgetAnalytics } from "./widget-analytics";

describe("widget website analytics availability", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryStatus.mockReturnValue({ configured: true });
    mockQueryPageviews.mockResolvedValue({ total: 10, timeSeries: [] });
    mockQuerySessionStats.mockResolvedValue({
      totalSessions: 5,
      avgSessionDuration: 30,
      bounceRate: 0,
    });
    mockQueryTrafficSources.mockResolvedValue([]);
    mockQueryDeviceStats.mockResolvedValue({
      desktop: 10,
      mobile: 0,
      tablet: 0,
    });
    mockQueryTopPages.mockResolvedValue([]);
  });

  it.each([
    mockQueryPageviews,
    mockQuerySessionStats,
    mockQueryTrafficSources,
    mockQueryDeviceStats,
    mockQueryTopPages,
  ])(
    "preserves conversation data and withholds incomplete website metrics when a query fails",
    async failedQuery => {
      failedQuery.mockRejectedValue(new Error("provider unavailable"));
      const result = await getWidgetAnalytics(workspaceId);
      expect(result.error).toBeUndefined();
      expect(result.data?.websiteAnalyticsStatus).toEqual({
        state: "unavailable",
        reason: "query_failed",
      });
      expect(result.data?.conversations.totalConversations).toBe(7);
      expect(result.data?.summary.chatStartRate).toBeNull();
    }
  );

  it("keeps a successful empty response distinct from an unavailable query", async () => {
    mockQueryPageviews.mockResolvedValue({ total: 0, timeSeries: [] });
    expect(
      (await getWidgetAnalytics(workspaceId)).data?.websiteAnalyticsStatus
    ).toEqual({ state: "ready" });
  });

  it("preserves the missing-configuration reason without sending queries", async () => {
    mockQueryStatus.mockReturnValue({
      configured: false,
      reason: "missing_config",
    });
    expect(
      (await getWidgetAnalytics(workspaceId)).data?.websiteAnalyticsStatus
    ).toEqual({ state: "unavailable", reason: "missing_config" });
    expect(mockQueryPageviews).not.toHaveBeenCalled();
  });
});
