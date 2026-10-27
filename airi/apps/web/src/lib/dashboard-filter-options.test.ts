import type { DashboardData } from "@/types/dashboard";
import { mergeDashboardFilterOptions } from "./dashboard-filter-options";

const emptyDashboardData: DashboardData = {
  stats: [],
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
  dailySeries: { current: [], previous: [] },
  conversationActivityByTime: [],
  categoryComparisons: [],
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
};

describe("mergeDashboardFilterOptions", () => {
  it("does not collapse available filter choices after a filtered response", () => {
    const options = mergeDashboardFilterOptions({
      data: {
        ...emptyDashboardData,
        topCategories: [{ name: "Complaint", value: 4 }],
        categoriesByChannel: [
          { channel: "whatsapp", category: "Complaint", count: 4 },
        ],
        internalLabels: {
          ...emptyDashboardData.internalLabels,
          availableLabels: ["vip"],
        },
      },
      previous: {
        channels: ["email", "telegram"],
        categories: ["Sales"],
        internalLabels: ["priority"],
        managers: [],
      },
      selected: {
        channels: ["whatsapp"],
        categories: ["Complaint"],
        internalLabels: ["vip"],
        managers: [],
      },
    });

    expect(options.channels).toEqual(["email", "telegram", "whatsapp"]);
    expect(options.categories).toEqual(["Complaint", "Sales"]);
    expect(options.internalLabels).toEqual(["priority", "vip"]);
  });

  it("retains categories found only in the previous comparison period", () => {
    const options = mergeDashboardFilterOptions({
      data: {
        ...emptyDashboardData,
        categoryComparisons: [
          {
            category: "Refunds",
            current: 0,
            previous: 8,
            delta: -8,
            percentChange: -100,
            kind: "no_longer_active",
          },
        ],
      },
      previous: {
        channels: [],
        categories: [],
        internalLabels: [],
        managers: [],
      },
      selected: {
        channels: [],
        categories: [],
        internalLabels: [],
        managers: [],
      },
    });

    expect(options.categories).toEqual(["Refunds"]);
  });
});
