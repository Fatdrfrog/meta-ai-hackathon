const mockMessageAggregate = jest.fn();

jest.mock("@/models/conversation", () => ({
  Conversation: { collection: { name: "conversations" } },
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    aggregate: (...args: unknown[]) => mockMessageAggregate(...args),
  },
}));

import { fetchDashboardMessageAnalytics } from "./dashboard-message-analytics";
import { resolveDashboardComparisonWindow } from "./dashboard-comparison";
import { DASHBOARD_UNCATEGORIZED_CATEGORY } from "@/types/dashboard";

function aggregateResult<T>(value: T) {
  const allowDiskUse = jest.fn().mockResolvedValue(value);
  return { allowDiskUse };
}

const comparisonPeriod = {
  preset: "7d" as const,
  strategy: "adjacent_equal_duration" as const,
  timeZone: "Asia/Qyzylorda",
  current: {
    start: "2026-07-08T00:00:00.000Z",
    endExclusive: "2026-07-15T00:00:00.000Z",
  },
  previous: {
    start: "2026-07-01T00:00:00.000Z",
    endExclusive: "2026-07-08T00:00:00.000Z",
  },
};

describe("fetchDashboardMessageAnalytics", () => {
  beforeEach(() => {
    mockMessageAggregate.mockReset();
  });

  it("counts each inbound conversation once per period and preserves previous-only categories", async () => {
    const aggregateQuery = aggregateResult([
      {
        totals: [
          { _id: "current", count: 2 },
          { _id: "previous", count: 2 },
        ],
        periodCategories: [
          { _id: { period: "current", category: "New" }, count: 1 },
          {
            _id: {
              period: "current",
              category: DASHBOARD_UNCATEGORIZED_CATEGORY,
            },
            count: 1,
          },
          { _id: { period: "previous", category: "New" }, count: 1 },
          { _id: { period: "previous", category: "Legacy" }, count: 1 },
        ],
        dailyConversations: [
          { _id: { period: "current", date: "2026-07-08" }, count: 2 },
          { _id: { period: "previous", date: "2026-07-01" }, count: 2 },
        ],
        categoriesByChannel: [
          { _id: { channel: "whatsapp", category: "New" }, count: 1 },
          {
            _id: {
              channel: "telegram",
              category: DASHBOARD_UNCATEGORIZED_CATEGORY,
            },
            count: 1,
          },
        ],
      },
    ]);
    mockMessageAggregate.mockReturnValue(aggregateQuery);

    const result = await fetchDashboardMessageAnalytics({
      workspaceId: "workspace-1",
      comparisonPeriod,
    });

    const pipeline = mockMessageAggregate.mock.calls[0][0];
    const previousStart = new Date(comparisonPeriod.previous.start);
    const currentEndExclusive = new Date(comparisonPeriod.current.endExclusive);

    expect(pipeline[0]).toEqual({
      $match: {
        workspaceId: "workspace-1",
        date: { $gte: previousStart, $lt: currentEndExclusive },
      },
    });
    expect(JSON.stringify(pipeline)).toContain('"direction":"inbound"');
    expect(JSON.stringify(pipeline)).toContain('"$facet"');
    expect(pipeline).toEqual(
      expect.arrayContaining([
        {
          $group: expect.objectContaining({
            _id: {
              period: "$dashboardPeriod",
              conversation: "$conversation",
            },
            firstInboundAt: { $min: "$date" },
          }),
        },
      ])
    );
    expect(aggregateQuery.allowDiskUse).toHaveBeenCalledWith(true);
    expect(result).toEqual({
      totals: { current: 2, previous: 2 },
      categories: {
        current: { New: 1, [DASHBOARD_UNCATEGORIZED_CATEGORY]: 1 },
        previous: { New: 1, Legacy: 1 },
      },
      dailySeries: {
        current: [{ date: "2026-07-08", total: 2 }],
        previous: [{ date: "2026-07-01", total: 2 }],
      },
      categoriesByChannel: [
        { channel: "whatsapp", category: "New", count: 1 },
        {
          channel: "telegram",
          category: DASHBOARD_UNCATEGORIZED_CATEGORY,
          count: 1,
        },
      ],
    });
  });

  it("applies channel filters before grouping and conversation-owned filters after one projected lookup", async () => {
    mockMessageAggregate.mockReturnValue(aggregateResult([]));

    await fetchDashboardMessageAnalytics({
      workspaceId: "workspace-1",
      comparisonPeriod,
      filters: {
        channels: ["whatsapp"],
        categories: [DASHBOARD_UNCATEGORIZED_CATEGORY, "Sales"],
        internalLabels: ["vip"],
        managerIds: ["manager-1"],
      },
    });

    const pipeline = mockMessageAggregate.mock.calls[0][0];
    expect(pipeline[1]).toEqual({
      $match: {
        direction: "inbound",
        channel: { $in: ["whatsapp"] },
      },
    });
    expect(pipeline).toEqual(
      expect.arrayContaining([
        {
          $lookup: {
            from: "conversations",
            let: { conversationId: "$_id.conversation" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$_id", "$$conversationId"] },
                      { $eq: ["$workspaceId", "workspace-1"] },
                    ],
                  },
                },
              },
              {
                $project: {
                  workspaceId: 1,
                  channel: 1,
                  "classification.category": 1,
                  internal_labels: 1,
                  handled_by_agent_id: 1,
                },
              },
            ],
            as: "dashboardConversation",
          },
        },
        { $unwind: "$dashboardConversation" },
        {
          $match: {
            $or: [
              {
                "dashboardConversation.classification.category": {
                  $in: ["Sales"],
                },
              },
              {
                "dashboardConversation.classification.category": {
                  $exists: false,
                },
              },
              { "dashboardConversation.classification.category": null },
              { "dashboardConversation.classification.category": "" },
              { "dashboardConversation.classification.category": "Other" },
            ],
            "dashboardConversation.internal_labels": { $in: ["vip"] },
            "dashboardConversation.handled_by_agent_id": {
              $in: ["manager-1"],
            },
          },
        },
      ])
    );
  });

  it("excludes the non-adjacent this-week gap and previous end while including current start", async () => {
    const thisWeek = resolveDashboardComparisonWindow(
      "this_week",
      "UTC",
      new Date("2026-08-05T12:00:00.000Z")
    );
    expect(thisWeek).toMatchObject({
      current: {
        start: "2026-08-03T00:00:00.000Z",
        endExclusive: "2026-08-05T12:00:00.000Z",
      },
      previous: {
        start: "2026-07-27T00:00:00.000Z",
        endExclusive: "2026-07-29T12:00:00.000Z",
      },
    });
    mockMessageAggregate.mockReturnValue(aggregateResult([]));

    await fetchDashboardMessageAnalytics({
      workspaceId: "workspace-1",
      comparisonPeriod: thisWeek,
    });

    const pipeline = mockMessageAggregate.mock.calls[0][0];
    const currentStart = new Date("2026-08-03T00:00:00.000Z");
    const currentEndExclusive = new Date("2026-08-05T12:00:00.000Z");
    const previousStart = new Date("2026-07-27T00:00:00.000Z");
    const previousEndExclusive = new Date("2026-07-29T12:00:00.000Z");
    const assignmentIndex = pipeline.findIndex(
      (stage: Record<string, unknown>) => "$set" in stage
    );

    expect(pipeline[0]).toEqual({
      $match: {
        workspaceId: "workspace-1",
        date: { $gte: previousStart, $lt: currentEndExclusive },
      },
    });
    expect(pipeline[assignmentIndex]).toEqual({
      $set: {
        dashboardPeriod: {
          $switch: {
            branches: [
              {
                case: {
                  $and: [
                    { $gte: ["$date", currentStart] },
                    { $lt: ["$date", currentEndExclusive] },
                  ],
                },
                then: "current",
              },
              {
                case: {
                  $and: [
                    { $gte: ["$date", previousStart] },
                    { $lt: ["$date", previousEndExclusive] },
                  ],
                },
                then: "previous",
              },
            ],
            default: null,
          },
        },
      },
    });
    expect(pipeline[assignmentIndex + 1]).toEqual({
      $match: { dashboardPeriod: { $ne: null } },
    });
  });
});
