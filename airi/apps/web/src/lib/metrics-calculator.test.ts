const mockConversationAggregate = jest.fn();
const mockConversationFind = jest.fn();
const mockMessageAggregate = jest.fn();
const mockMessageFind = jest.fn();
const mockFetchDashboardMessageAnalytics = jest.fn();

jest.mock("@/models/conversation", () => ({
  CONVERSATION_FIRST_RESPONSE_ANALYTICS_INDEX_NAME:
    "conversations_workspace_first_inbound_first_response",
  Conversation: {
    aggregate: (...args: unknown[]) => mockConversationAggregate(...args),
    collection: { name: "conversations" },
    find: (...args: unknown[]) => mockConversationFind(...args),
  },
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    aggregate: (...args: unknown[]) => mockMessageAggregate(...args),
    find: (...args: unknown[]) => mockMessageFind(...args),
  },
}));

jest.mock("@/lib/dashboard-message-analytics", () => {
  const actual = jest.requireActual("@/lib/dashboard-message-analytics");
  return {
    ...actual,
    fetchDashboardMessageAnalytics: (...args: unknown[]) =>
      mockFetchDashboardMessageAnalytics(...args),
  };
});

import { calculateDashboardMetrics } from "./metrics-calculator";
import { resolveDashboardComparisonWindow } from "./dashboard-comparison";
import { DASHBOARD_UNCATEGORIZED_CATEGORY } from "@/types/dashboard";
import mongoose from "mongoose";

function localActivityFixtureUri(value: string): URL {
  const uri = new URL(value);
  if (
    uri.protocol !== "mongodb:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(uri.hostname) ||
    uri.port !== "27277" ||
    uri.username ||
    uri.password ||
    uri.pathname !== "/airi_mongo_index_cost_tests" ||
    uri.searchParams.get("replicaSet") !== "airiCostTests"
  )
    throw new Error(
      "Dashboard activity tests require the dedicated local cost-test replica set"
    );
  return uri;
}

const activityFixtureUri = process.env.MONGO_COST_TEST_URI
  ? localActivityFixtureUri(process.env.MONGO_COST_TEST_URI)
  : null;
const activityMongoSuite = activityFixtureUri ? describe : describe.skip;

activityMongoSuite("dashboard activity on actual local Mongo", () => {
  const fixtureName = `airi_mongo_index_cost_tests_heatmap_${process.pid}_${Date.now()}`;
  let client: mongoose.mongo.MongoClient;
  let db: mongoose.mongo.Db;
  const workspaceId = "workspace-activity-qa";
  const start = new Date("2026-10-24T00:00:00Z");
  const end = new Date("2026-10-26T00:00:00Z");
  beforeAll(async () => {
    const uri = new URL(activityFixtureUri!.toString());
    uri.pathname = `/${fixtureName}`;
    client = new mongoose.mongo.MongoClient(uri.toString(), {
      serverSelectionTimeoutMS: 5000,
    });
    await client.connect();
    db = client.db(fixtureName);
    const ids = Array.from({ length: 8 }, () => new mongoose.Types.ObjectId());
    const matching = {
      workspaceId,
      classification: { category: "Sales" },
      internal_labels: ["vip"],
      handled_by_agent_id: "manager-a",
    };
    await db.collection("conversations").insertMany([
      { _id: ids[0], ...matching },
      { _id: ids[1], ...matching },
      { _id: ids[2], ...matching, classification: { category: "Other" } },
      { _id: ids[3], ...matching, workspaceId: "other-workspace" },
      { _id: ids[4], ...matching, internal_labels: ["other-label"] },
      { _id: ids[5], ...matching, handled_by_agent_id: "other-manager" },
      {
        _id: ids[6],
        workspaceId,
        internal_labels: ["vip"],
        handled_by_agent_id: "manager-a",
      },
    ]);
    const message = (
      conversation: mongoose.Types.ObjectId | undefined,
      date = "2026-10-24T18:30:00Z"
    ) => ({
      workspaceId,
      channel: "whatsapp",
      conversation,
      date: new Date(date),
    });
    await db
      .collection("messages")
      .insertMany([
        ...Array.from({ length: 240 }, () => message(ids[0])),
        ...Array.from({ length: 10 }, () =>
          message(ids[0], "2026-10-24T19:30:00Z")
        ),
        message(ids[0], "2026-10-25T00:30:00Z"),
        message(ids[0], "2026-10-25T01:30:00Z"),
        ...ids.slice(1).map(id => message(id)),
        message(undefined),
        { ...message(ids[0]), channel: "telegram" },
        { ...message(ids[0]), workspaceId: "other-workspace" },
        message(ids[0], end.toISOString()),
        message(ids[0], "2026-10-23T23:59:59Z"),
      ]);
    await db.collection("messages").createIndex({ workspaceId: 1, date: -1 });
  });
  afterAll(async () => {
    try {
      if (db) {
        expect(db.databaseName).toBe(fixtureName);
        await db.dropDatabase();
      }
    } finally {
      await client?.close();
    }
  });

  it.each([
    {
      name: "combined filters and midnight",
      timeZone: "Asia/Qyzylorda",
      filters: {
        categories: ["Sales"],
        internalLabels: ["vip"],
        managerIds: ["manager-a"],
      },
    },
    {
      name: "repeated daylight-saving hour",
      timeZone: "Europe/Berlin",
      filters: {
        categories: ["Sales"],
        internalLabels: ["vip"],
        managerIds: ["manager-a"],
      },
    },
    {
      name: "category only",
      timeZone: "UTC",
      filters: { categories: ["Sales"] },
    },
    {
      name: "uncategorized values",
      timeZone: "UTC",
      filters: { categories: [DASHBOARD_UNCATEGORIZED_CATEGORY] },
    },
    {
      name: "label only",
      timeZone: "UTC",
      filters: { internalLabels: ["vip"] },
    },
    {
      name: "manager only",
      timeZone: "UTC",
      filters: { managerIds: ["manager-a"] },
    },
    { name: "unfiltered path", timeZone: "UTC", filters: {} },
  ])(
    "preserves counts and reduces lookup work: $name",
    async ({ timeZone, filters }) => {
      mockConversationReads([], []);
      let actualRows: mongoose.mongo.Document[] = [];
      mockMessageAggregate.mockImplementation(
        (pipeline: mongoose.PipelineStage[]) => ({
          allowDiskUse: async () => {
            actualRows = await db
              .collection("messages")
              .aggregate(pipeline, { allowDiskUse: true })
              .toArray();
            return actualRows;
          },
        })
      );
      await calculateDashboardMetrics(
        workspaceId,
        customComparisonPeriod(start, end, timeZone),
        { ...filters, channels: ["whatsapp"] }
      );
      const pipeline = mockMessageAggregate.mock
        .calls[0][0] as mongoose.PipelineStage[];
      const lookupIndex = pipeline.findIndex(stage => "$lookup" in stage);
      const firstGroupIndex = pipeline.findIndex(stage => "$group" in stage);
      const originalGroup = {
        $group: {
          _id: {
            dayOfWeek: { $dayOfWeek: { date: "$date", timezone: timeZone } },
            hour: { $hour: { date: "$date", timezone: timeZone } },
          },
          count: { $sum: 1 },
        },
      };
      const lookupStages =
        lookupIndex < 0
          ? []
          : pipeline.slice(
              lookupIndex,
              pipeline.findIndex(
                (stage, index) => index > lookupIndex && "$group" in stage
              )
            );
      const original = [
        pipeline[0],
        ...lookupStages,
        originalGroup,
        { $sort: { "_id.dayOfWeek": 1, "_id.hour": 1 } },
      ];
      const originalRows = await db
        .collection("messages")
        .aggregate(original)
        .toArray();
      expect(actualRows).toEqual(originalRows);
      if (lookupIndex < 0) {
        expect(firstGroupIndex).toBe(1);
        return;
      }
      const beforeLookup = await db
        .collection("messages")
        .aggregate([...pipeline.slice(0, lookupIndex), { $count: "rows" }])
        .next();
      expect(beforeLookup?.rows).toBe(timeZone === "Europe/Berlin" ? 11 : 12);
      expect(firstGroupIndex).toBeLessThan(lookupIndex);
      const explain = await db
        .collection("messages")
        .aggregate(pipeline)
        .explain("executionStats");
      const lookup = explain.stages.find(
        (stage: mongoose.mongo.Document) => stage.$lookup
      );
      expect(lookup.indexesUsed).toContain("_id_");
      expect(lookup.collectionScans).toBe(0);
      expect(lookup.totalDocsExamined).toBeLessThanOrEqual(beforeLookup?.rows);
      if (timeZone === "Asia/Qyzylorda") {
        expect(actualRows).toEqual([
          { _id: { dayOfWeek: 1, hour: 0 }, count: 10 },
          { _id: { dayOfWeek: 1, hour: 5 }, count: 1 },
          { _id: { dayOfWeek: 1, hour: 6 }, count: 1 },
          { _id: { dayOfWeek: 7, hour: 23 }, count: 241 },
        ]);
      }
      if (timeZone === "Europe/Berlin") {
        expect(actualRows).toContainEqual({
          _id: { dayOfWeek: 1, hour: 2 },
          count: 2,
        });
      }
    }
  );
});

beforeEach(() => {
  mockConversationAggregate.mockReset();
  mockConversationFind.mockReset();
  mockMessageAggregate.mockReset();
  mockMessageFind.mockReset();
  mockFetchDashboardMessageAnalytics.mockReset();
  mockMessageAggregate.mockReturnValue(aggregateResult([]));
  mockFetchDashboardMessageAnalytics.mockResolvedValue({
    totals: { current: 0, previous: 0 },
    categories: { current: {}, previous: {} },
    dailySeries: { current: [], previous: [] },
    categoriesByChannel: [],
  });
});

function aggregateResult<T>(value: T) {
  return {
    allowDiskUse: jest.fn().mockResolvedValue(value),
  };
}

function findResult<T>(value: T) {
  type MockFindQuery = {
    hint: jest.MockedFunction<() => MockFindQuery>;
    select: jest.MockedFunction<() => MockFindQuery>;
    sort: jest.MockedFunction<() => MockFindQuery>;
    limit: jest.MockedFunction<() => MockFindQuery>;
    lean: jest.MockedFunction<() => MockFindQuery>;
    exec: jest.MockedFunction<() => Promise<T>>;
  };

  const query: MockFindQuery = {
    hint: jest.fn(() => query),
    select: jest.fn(() => query),
    sort: jest.fn(() => query),
    limit: jest.fn(() => query),
    lean: jest.fn(() => query),
    exec: jest.fn().mockResolvedValue(value),
  };
  return query;
}

function customComparisonPeriod(
  start: Date,
  endExclusive: Date,
  timeZone = "UTC"
) {
  return resolveDashboardComparisonWindow(
    { start, endExclusive },
    timeZone,
    endExclusive
  );
}

function mockConversationReads<TCurrent, TFirstResponse>(
  currentRows: TCurrent[],
  firstResponseRows: TFirstResponse[],
  previousRows: TCurrent[] = []
) {
  let servedCurrentRows = false;
  mockConversationFind.mockImplementation((match: Record<string, unknown>) => {
    if ("first_inbound_at" in match) {
      return findResult(firstResponseRows);
    }
    if (!servedCurrentRows) {
      servedCurrentRows = true;
      return findResult(currentRows);
    }
    return findResult(previousRows);
  });
}

describe("service truth in dashboard metrics", () => {
  it("bounds legacy conversation reads and exposes partial coverage rather than full-population counts", async () => {
    mockConversationReads(Array.from({ length: 10001 }, () => ({ status: "open" })), []);
    const result = await calculateDashboardMetrics("workspace-1", customComparisonPeriod(new Date("2026-10-01T00:00:00Z"), new Date("2026-10-03T00:00:00Z")));
    expect(result.sourceCoverage).toMatchObject({ status: "partial", rowLimit: 10000, conversationRowsLoaded: 10000, conversationRowsTruncated: true });
    expect(result.stats.find(row => row.id === "new")?.value).toBeNull();
    expect(result.serviceTruth?.sourceCoverage?.status).toBe("partial");
  });
  it("retains unanswered cohort members and never invents resolution from updatedAt", async () => {
    mockConversationReads([{ status: "closed", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" }], [
      { first_inbound_at: "2026-10-01T12:00:00Z", first_response_seconds: 60 },
      { first_inbound_at: "2026-10-01T13:00:00Z", first_response_seconds: null },
    ]);
    const result = await calculateDashboardMetrics("workspace-1", customComparisonPeriod(new Date("2026-10-01T00:00:00Z"), new Date("2026-10-03T00:00:00Z")));
    expect(result.firstResponse).toMatchObject({ count: 1, eligibleConversations: 2, unansweredConversations: 1, coverageRate: 50 });
    expect(result.stats.find(row => row.id === "ttr")?.value).toBeNull();
    expect(result.serviceTruth?.resolution.unknownClosedConversations).toBe(1);
  });
});

describe("calculateDashboardMetrics", () => {
  it("filters invalid activity buckets and breaks peak ties by local weekday and hour", async () => {
    mockConversationReads([], []);
    mockMessageAggregate.mockReturnValueOnce(
      aggregateResult([
        { _id: { dayOfWeek: 4, hour: 8 }, count: 5 },
        { _id: { dayOfWeek: 2, hour: 12 }, count: 5 },
        { _id: { dayOfWeek: 2, hour: 7 }, count: 5 },
        { _id: { dayOfWeek: 8, hour: 7 }, count: 100 },
        { _id: { dayOfWeek: 1, hour: 24 }, count: 100 },
        { _id: { dayOfWeek: 1, hour: 0 }, count: 0 },
        { _id: null, count: 100 },
      ])
    );

    const result = await calculateDashboardMetrics(
      "workspace-1",
      customComparisonPeriod(
        new Date("2026-10-01T00:00:00Z"),
        new Date("2026-10-03T00:00:00Z")
      )
    );

    expect(result.conversationActivityByTime).toEqual([
      { dayOfWeek: 2, hour: 7, count: 5 },
      { dayOfWeek: 2, hour: 12, count: 5 },
      { dayOfWeek: 4, hour: 8, count: 5 },
    ]);
    expect(result.peakTime).toEqual({ dayOfWeek: 2, hour: 7 });
  });

  it("combines message counts per conversation and local hour before filtered lookups", async () => {
    mockConversationReads([], []);
    await calculateDashboardMetrics(
      "workspace-1",
      customComparisonPeriod(
        new Date("2026-10-24T00:00:00Z"),
        new Date("2026-10-26T00:00:00Z"),
        "Asia/Qyzylorda"
      ),
      {
        categories: ["Sales"],
        internalLabels: ["vip"],
        managerIds: ["manager-a"],
      }
    );
    const pipeline = mockMessageAggregate.mock.calls[0][0];
    const lookupIndex = pipeline.findIndex(
      (stage: Record<string, unknown>) => "$lookup" in stage
    );
    expect(pipeline.slice(0, lookupIndex)).toContainEqual({
      $group: {
        _id: {
          conversation: "$conversation",
          dayOfWeek: {
            $dayOfWeek: { date: "$date", timezone: "Asia/Qyzylorda" },
          },
          hour: { $hour: { date: "$date", timezone: "Asia/Qyzylorda" } },
        },
        count: { $sum: 1 },
      },
    });
    expect(pipeline.slice(lookupIndex)).toContainEqual({
      $group: {
        _id: { dayOfWeek: "$_id.dayOfWeek", hour: "$_id.hour" },
        count: { $sum: "$count" },
      },
    });
  });
  it("consumes a route-normalized comparison period without resolving a new anchor", async () => {
    const comparisonPeriod = {
      preset: "custom" as const,
      strategy: "adjacent_equal_duration" as const,
      timeZone: "UTC",
      current: {
        start: "2026-05-01T00:00:00.000Z",
        endExclusive: "2026-05-08T00:00:00.000Z",
      },
      previous: {
        start: "2026-04-24T00:00:00.000Z",
        endExclusive: "2026-05-01T00:00:00.000Z",
      },
    };
    mockConversationFind
      .mockReturnValueOnce(findResult([]))
      .mockReturnValueOnce(findResult([]))
      .mockReturnValueOnce(findResult([]));

    const result = await calculateDashboardMetrics(
      "workspace-1",
      comparisonPeriod,
      { timeZone: "UTC" }
    );

    expect(result.comparisonPeriod).toBe(comparisonPeriod);
    expect(mockConversationFind.mock.calls[0][0]).toMatchObject({
      lastMessageAt: {
        $gte: new Date("2026-05-01T00:00:00.000Z"),
        $lt: new Date("2026-05-08T00:00:00.000Z"),
      },
    });
  });

  it("uses projected conversation reads for explicit custom date ranges", async () => {
    const start = new Date("2026-05-01T00:00:00.000Z");
    const endExclusive = new Date("2026-05-08T00:00:00.000Z");
    const previousStart = new Date("2026-04-24T00:00:00.000Z");

    mockConversationReads([], []);

    await calculateDashboardMetrics(
      "workspace-1",
      customComparisonPeriod(start, endExclusive, "Asia/Qyzylorda"),
      { timeZone: "Asia/Qyzylorda" }
    );

    expect(mockConversationFind).toHaveBeenCalledTimes(3);
    expect(mockConversationFind.mock.calls[0][0]).toEqual({
      workspaceId: "workspace-1",
      lastMessageAt: { $gte: start, $lt: endExclusive },
    });
    expect(mockConversationFind.mock.calls[1][0]).toEqual({
      workspaceId: "workspace-1",
      first_inbound_at: { $gte: previousStart, $lt: endExclusive },
    });
    expect(mockConversationFind.mock.calls[2][0]).toEqual({
      workspaceId: "workspace-1",
      lastMessageAt: { $gte: previousStart, $lt: start },
    });
    expect(
      mockConversationFind.mock.results[2].value.hint
    ).toHaveBeenCalledWith({ workspaceId: 1, lastMessageAt: -1 });
    expect(
      mockConversationFind.mock.results[0].value.hint
    ).toHaveBeenCalledWith({ workspaceId: 1, lastMessageAt: -1 });
    expect(
      mockConversationFind.mock.results[1].value.hint
    ).toHaveBeenCalledWith(
      "conversations_workspace_first_inbound_first_response"
    );
    expect(
      mockConversationFind.mock.results[1].value.select
    ).toHaveBeenCalledWith(expect.stringContaining("first_inbound_at"));
    expect(mockConversationAggregate).not.toHaveBeenCalled();
    expect(mockMessageAggregate).toHaveBeenCalledTimes(1);
    expect(mockMessageAggregate.mock.calls[0][0]).toEqual([
      {
        $match: {
          workspaceId: "workspace-1",
          date: { $gte: start, $lt: endExclusive },
        },
      },
      {
        $group: {
          _id: {
            dayOfWeek: {
              $dayOfWeek: { date: "$date", timezone: "Asia/Qyzylorda" },
            },
            hour: { $hour: { date: "$date", timezone: "Asia/Qyzylorda" } },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.dayOfWeek": 1, "_id.hour": 1 } },
    ]);
    expect(mockFetchDashboardMessageAnalytics).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      comparisonPeriod: {
        preset: "custom",
        strategy: "adjacent_equal_duration",
        timeZone: "Asia/Qyzylorda",
        current: {
          start: start.toISOString(),
          endExclusive: endExclusive.toISOString(),
        },
        previous: {
          start: previousStart.toISOString(),
          endExclusive: start.toISOString(),
        },
      },
      filters: expect.objectContaining({ timeZone: "Asia/Qyzylorda" }),
    });
    expect(mockMessageFind).not.toHaveBeenCalled();
  });

  it("expands the uncategorized category filter for conversation and message activity reads", async () => {
    const start = new Date("2026-05-01T00:00:00.000Z");
    const endExclusive = new Date("2026-05-08T00:00:00.000Z");

    mockConversationReads([], []);

    await calculateDashboardMetrics(
      "workspace-1",
      customComparisonPeriod(start, endExclusive),
      {
        categories: [DASHBOARD_UNCATEGORIZED_CATEGORY],
      }
    );

    const conversationCategoryFilter = {
      $or: [
        { "classification.category": { $exists: false } },
        { "classification.category": null },
        { "classification.category": "" },
        { "classification.category": "Other" },
      ],
    };
    expect(mockConversationFind.mock.calls[0][0]).toMatchObject(
      conversationCategoryFilter
    );
    expect(mockConversationFind.mock.calls[1][0]).toMatchObject(
      conversationCategoryFilter
    );
    expect(mockMessageAggregate.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        {
          $match: {
            $or: [
              {
                "dashboardConversation.classification.category": {
                  $exists: false,
                },
              },
              { "dashboardConversation.classification.category": null },
              { "dashboardConversation.classification.category": "" },
              { "dashboardConversation.classification.category": "Other" },
            ],
          },
        },
      ])
    );
    expect(mockFetchDashboardMessageAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({
          categories: [DASHBOARD_UNCATEGORIZED_CATEGORY],
        }),
      })
    );
  });

  it("combines null and Other categories for the same channel", async () => {
    mockFetchDashboardMessageAnalytics.mockResolvedValueOnce({
      totals: { current: 2, previous: 0 },
      categories: {
        current: { [DASHBOARD_UNCATEGORIZED_CATEGORY]: 2 },
        previous: {},
      },
      dailySeries: { current: [], previous: [] },
      categoriesByChannel: [
        {
          channel: "whatsapp",
          category: DASHBOARD_UNCATEGORIZED_CATEGORY,
          count: 2,
        },
      ],
    });
    mockConversationReads(
      [
        {
          channel: "whatsapp",
          classification: { category: null },
        },
        {
          channel: "whatsapp",
          classification: { category: "Other" },
        },
      ],
      []
    );

    const result = await calculateDashboardMetrics(
      "workspace-1",
      resolveDashboardComparisonWindow(
        30,
        "UTC",
        new Date("2026-08-05T12:00:00.000Z")
      )
    );

    expect(result.categoriesByChannel).toEqual([
      {
        channel: "whatsapp",
        category: DASHBOARD_UNCATEGORIZED_CATEGORY,
        count: 2,
      },
    ]);
  });

  it("reduces dashboard metrics from projected conversation rows", async () => {
    mockMessageAggregate.mockReturnValueOnce(
      aggregateResult([
        { _id: { dayOfWeek: 4, hour: 8 }, count: 2 },
        { _id: { dayOfWeek: 4, hour: 15 }, count: 5 },
      ])
    );

    mockFetchDashboardMessageAnalytics.mockResolvedValueOnce({
      totals: { current: 35, previous: 20 },
      categories: {
        current: {
          Complaint: 30,
          New: 4,
          [DASHBOARD_UNCATEGORIZED_CATEGORY]: 1,
        },
        previous: { Complaint: 13, Legacy: 7 },
      },
      dailySeries: {
        current: [{ date: "2026-07-08", total: 35 }],
        previous: [{ date: "2026-07-01", total: 7 }],
      },
      categoriesByChannel: [
        { channel: "whatsapp", category: "Complaint", count: 30 },
        {
          channel: "unknown",
          category: DASHBOARD_UNCATEGORIZED_CATEGORY,
          count: 1,
        },
      ],
    });

    mockConversationReads(
      [
        {
          status: "open",
          customer_satisfaction_score: 4,
          createdAt: new Date("2026-07-01T10:00:00.000Z"),
          updatedAt: new Date("2026-07-01T10:00:00.000Z"),
          user: "customer-1",
          channel: "whatsapp",
          classification: { category: "Complaint", tags: [] },
          internal_labels: ["stage:qualified"],
          handled_by_agent_id: "manager-1",
          last_outbound_at: new Date("2026-04-01T09:05:00.000Z"),
          lastMessageAt: new Date("2026-04-01T09:00:00.000Z"),
          whatsappReferral: {
            sourceId: "6821452622921",
            sourceType: "ad",
            sourceUrl: "https://instagram.com/p/meta-ad",
            headline: "Medals for school teams",
            body: "Order custom medals through WhatsApp",
            mediaType: "image",
            capturedAt: new Date("2026-04-10T12:00:00.000Z"),
          },
        },
        {
          status: "in_progress",
          customer_satisfaction_score: 4.4,
          createdAt: new Date("2026-07-01T11:00:00.000Z"),
          updatedAt: new Date("2026-07-01T11:00:00.000Z"),
          user: "customer-1",
          channel: "whatsapp",
          classification: { category: "Complaint", tags: [] },
          internal_labels: ["stage:qualified", "vip"],
          handled_by_agent_id: "manager-1",
          last_outbound_at: null,
          lastMessageAt: new Date("2026-04-01T10:00:00.000Z"),
          whatsappReferral: {
            sourceId: "6821452622921",
            sourceType: "ad",
            sourceUrl: "https://instagram.com/p/meta-ad",
            headline: "Medals for school teams",
            body: "Order custom medals through WhatsApp",
            mediaType: "image",
            capturedAt: new Date("2026-04-10T13:00:00.000Z"),
          },
        },
        {
          status: "closed",
          customer_satisfaction_score: 4.2,
          createdAt: new Date("2026-03-30T11:00:00.000Z"),
          updatedAt: new Date("2026-04-01T11:00:00.000Z"),
          user: "customer-2",
          channel: null,
          classification: { category: null, tags: [] },
          internal_labels: [],
          handled_by_agent_id: null,
          last_outbound_at: new Date("2026-04-01T11:05:00.000Z"),
          lastMessageAt: new Date("2026-04-01T11:00:00.000Z"),
          whatsappReferral: {
            sourceUrl: "instagram-post-1",
            sourceType: "post",
            capturedAt: new Date("2026-04-11T12:00:00.000Z"),
          },
        },
      ],
      [
        {
          first_inbound_at: new Date("2026-07-09T10:00:00.000Z"),
          first_response_seconds: 60,
        },
        {
          first_inbound_at: new Date("2026-07-10T10:00:00.000Z"),
          first_response_seconds: 120,
        },
        {
          first_inbound_at: new Date("2026-07-11T10:00:00.000Z"),
          first_response_seconds: 600,
        },
        {
          first_inbound_at: new Date("2026-07-02T10:00:00.000Z"),
          first_response_seconds: 30,
        },
        {
          first_inbound_at: new Date("2026-07-03T10:00:00.000Z"),
          first_response_seconds: 90,
        },
      ]
    );

    const result = await calculateDashboardMetrics(
      "workspace-1",
      customComparisonPeriod(
        new Date("2026-07-08T00:00:00.000Z"),
        new Date("2026-07-15T00:00:00.000Z")
      )
    );

    expect(mockConversationAggregate).not.toHaveBeenCalled();
    expect(
      result.stats.find(metric => metric.id === "total")?.comparison
    ).toEqual({
      current: 35,
      previous: 20,
      delta: 15,
      percentChange: 75,
      kind: "increase",
    });
    expect(result.stats).toEqual(
      expect.arrayContaining([
        {
          id: "total",
          value: 35,
          secondaryValue: null,
          comparison: {
            current: 35,
            previous: 20,
            delta: 15,
            percentChange: 75,
            kind: "increase",
          },
        },
        {
          id: "first_response",
          value: 120,
          secondaryValue: null,
          comparison: {
            current: 120,
            previous: 60,
            delta: 60,
            percentChange: 100,
            kind: "increase",
          },
        },
      ])
    );
    expect(result.stats[0]).not.toHaveProperty("label");
    expect(result.stats[0]).not.toHaveProperty("insight");
    expect(result.topCategories).toContainEqual({
      name: DASHBOARD_UNCATEGORIZED_CATEGORY,
      value: 1,
    });
    expect(result.peakTime).toEqual({ dayOfWeek: 4, hour: 15 });
    expect(result.topComplaintTag).toBeNull();
    expect(result.categoriesByChannel).toContainEqual({
      channel: "unknown",
      category: DASHBOARD_UNCATEGORIZED_CATEGORY,
      count: 1,
    });
    expect(
      result.categoryComparisons.find(row => row.category === "New")
    ).toMatchObject({
      current: 4,
      previous: 0,
      percentChange: null,
      kind: "new",
    });
    expect(result.categoryComparisons).toContainEqual({
      category: "Legacy",
      current: 0,
      previous: 7,
      delta: -7,
      percentChange: -100,
      kind: "no_longer_active",
    });
    expect(result.dailySeries.previous).toEqual([
      { date: "2026-07-01", total: 7 },
    ]);
    // Live queue counts have no past snapshot to compare.
    expect(
      result.stats
        .filter(metric => ["new", "in_progress", "sla"].includes(metric.id))
        .map(metric => metric.comparison)
    ).toEqual([null, null, null]);
    // No previous-window conversations: counts start from zero, averages stay uncompared.
    expect(
      result.stats.find(metric => metric.id === "resolved")?.comparison
    ).toEqual({
      current: 1,
      previous: 0,
      delta: 1,
      percentChange: null,
      kind: "new",
    });
    expect(
      result.stats.find(metric => metric.id === "csat")?.comparison
    ).toBeNull();
    expect(result.conversationActivityByTime).toEqual([
      { dayOfWeek: 4, hour: 8, count: 2 },
      { dayOfWeek: 4, hour: 15, count: 5 },
    ]);
    expect(result.advertisement).toMatchObject({
      totalConversations: 3,
      uniqueSources: 2,
      respondedConversations: 2,
      closedConversations: 1,
      responseRate: 67,
      closeRate: 33,
      bySourceType: [
        { sourceType: "ad", conversations: 2 },
        { sourceType: "post", conversations: 1 },
      ],
      dailyCounts: [
        { date: "2026-04-10", conversations: 2 },
        { date: "2026-04-11", conversations: 1 },
      ],
    });
    expect(result.advertisement.topSources[0]).toMatchObject({
      sourceKey: "6821452622921",
      sourceId: "6821452622921",
      sourceType: "ad",
      sourceUrl: "https://instagram.com/p/meta-ad",
      headline: "Medals for school teams",
      conversations: 2,
      responded: 1,
      closed: 0,
    });
    expect(result.internalLabels).toMatchObject({
      taggedConversations: 2,
      unlabeledConversations: 1,
      uniqueLabels: 2,
      totalAssignments: 3,
      availableLabels: ["stage:qualified", "vip"],
      topLabels: [
        expect.objectContaining({
          label: "stage:qualified",
          conversations: 2,
          open: 1,
          inProgress: 1,
          closed: 0,
          responded: 1,
        }),
        expect.objectContaining({
          label: "vip",
          conversations: 1,
          open: 0,
          inProgress: 1,
          closed: 0,
          responded: 0,
        }),
      ],
    });
  });

  describe("previous-period card comparisons", () => {
    const resolvedRow = (
      user: string,
      rating: number | null,
      start: string,
      resolved: string
    ) => ({
      status: "closed",
      customer_satisfaction_score: rating,
      user,
      first_inbound_at: new Date(start),
      service_resolved_at: new Date(resolved),
      service_resolution_kind: "manager",
    });
    const period = () =>
      customComparisonPeriod(
        new Date("2026-07-08T00:00:00.000Z"),
        new Date("2026-07-15T00:00:00.000Z")
      );
    const comparisonOf = (
      result: Awaited<ReturnType<typeof calculateDashboardMetrics>>,
      id: string
    ) => result.stats.find(metric => metric.id === id)?.comparison;

    it("compares resolved, repeat, CSAT and resolution time with the previous window's conversations", async () => {
      mockConversationReads(
        [
          resolvedRow(
            "customer-1",
            5,
            "2026-07-09T10:00:00.000Z",
            "2026-07-10T10:00:00.000Z"
          ),
          resolvedRow(
            "customer-1",
            3,
            "2026-07-09T10:00:00.000Z",
            "2026-07-12T10:00:00.000Z"
          ),
          { status: "open", user: "customer-2" },
        ],
        [],
        [
          resolvedRow(
            "customer-3",
            4,
            "2026-07-02T00:00:00.000Z",
            "2026-07-03T00:00:00.000Z"
          ),
          { status: "open", user: "customer-4" },
        ]
      );

      const result = await calculateDashboardMetrics("workspace-1", period());

      expect(mockConversationFind.mock.calls[2][0]).toEqual({
        workspaceId: "workspace-1",
        lastMessageAt: {
          $gte: new Date("2026-07-01T00:00:00.000Z"),
          $lt: new Date("2026-07-08T00:00:00.000Z"),
        },
      });
      expect(comparisonOf(result, "resolved")).toEqual({
        current: 2,
        previous: 1,
        delta: 1,
        percentChange: 100,
        kind: "increase",
      });
      expect(comparisonOf(result, "repeat")).toEqual({
        current: 1,
        previous: 0,
        delta: 1,
        percentChange: null,
        kind: "new",
      });
      expect(comparisonOf(result, "csat")).toEqual({
        current: 4,
        previous: 4,
        delta: 0,
        percentChange: 0,
        kind: "unchanged",
      });
      // Days, matching the card value (2.0 vs 1.0 measured days).
      expect(comparisonOf(result, "ttr")).toEqual({
        current: 2,
        previous: 1,
        delta: 1,
        percentChange: 100,
        kind: "increase",
      });
      for (const id of ["new", "in_progress", "sla"]) {
        expect(comparisonOf(result, id)).toBeNull();
      }
    });

    it("leaves the previous-window comparisons out when that read is truncated", async () => {
      mockConversationReads<Record<string, unknown>, never>(
        [
          resolvedRow(
            "customer-1",
            5,
            "2026-07-09T10:00:00.000Z",
            "2026-07-10T10:00:00.000Z"
          ),
        ],
        [],
        Array.from({ length: 10_001 }, () => ({
          status: "closed",
          customer_satisfaction_score: 2,
        }))
      );

      const result = await calculateDashboardMetrics("workspace-1", period());

      for (const id of ["resolved", "repeat", "csat", "ttr"]) {
        expect(comparisonOf(result, id)).toBeNull();
      }
      expect(result.stats.find(metric => metric.id === "resolved")?.value).toBe(
        1
      );
      expect(result.sourceCoverage?.status).toBe("complete");
    });

    it("skips the previous-window read when the range has no previous period", async () => {
      mockConversationReads([], []);

      const result = await calculateDashboardMetrics(
        "workspace-1",
        resolveDashboardComparisonWindow(
          "all",
          "UTC",
          new Date("2026-07-15T00:00:00.000Z")
        )
      );

      expect(mockConversationFind).toHaveBeenCalledTimes(2);
      expect(result.stats.every(metric => metric.comparison === null)).toBe(
        true
      );
    });
  });

  it("uses selected managers and averages both middle responses for an even median sample", async () => {
    mockFetchDashboardMessageAnalytics.mockResolvedValueOnce({
      totals: { current: 2, previous: 1 },
      categories: { current: {}, previous: {} },
      dailySeries: { current: [], previous: [] },
      categoriesByChannel: [],
    });
    mockConversationReads(
      [
        {
          status: "open",
          handled_by_agent_id: "supabase-manager-1",
          lastMessageAt: new Date("2026-04-01T09:00:00.000Z"),
        },
        {
          status: "closed",
          handled_by_agent_id: "supabase-manager-1",
          lastMessageAt: new Date("2026-04-01T10:00:00.000Z"),
        },
      ],
      [
        {
          first_inbound_at: new Date("2026-07-09T10:00:00.000Z"),
          first_response_seconds: 120,
          first_response_manager_id: "mongo-user-1",
        },
        {
          first_inbound_at: new Date("2026-07-10T10:00:00.000Z"),
          first_response_seconds: 3600,
          first_response_manager_id: "mongo-user-1",
        },
        {
          first_inbound_at: new Date("2026-07-02T10:00:00.000Z"),
          first_response_seconds: 60,
          first_response_manager_id: "mongo-user-1",
        },
        {
          first_inbound_at: new Date("2026-07-03T10:00:00.000Z"),
          first_response_seconds: 180,
          first_response_manager_id: "mongo-user-1",
        },
      ]
    );

    const result = await calculateDashboardMetrics(
      "workspace-1",
      customComparisonPeriod(
        new Date("2026-07-08T00:00:00.000Z"),
        new Date("2026-07-15T00:00:00.000Z")
      ),
      {
        managerIds: ["supabase-manager-1"],
        managerOptions: [
          {
            id: "supabase-manager-1",
            name: "Aida Manager",
            role: "manager",
            email: "aida@example.com",
            avatarUrl: null,
          },
        ],
        managerUserLinks: [
          {
            supabase_user_id: "supabase-manager-1",
            mongo_user_id: "mongo-user-1",
          },
        ],
      }
    );

    expect(mockConversationFind.mock.calls[0][0]).toMatchObject({
      workspaceId: "workspace-1",
      handled_by_agent_id: { $in: ["supabase-manager-1"] },
    });
    expect(mockConversationFind.mock.calls[1][0]).toMatchObject({
      first_response_manager_id: {
        $in: ["supabase-manager-1", "mongo-user-1"],
      },
    });
    expect(mockMessageAggregate.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          $lookup: expect.objectContaining({ from: "conversations" }),
        }),
        { $unwind: "$dashboardConversation" },
        {
          $match: {
            "dashboardConversation.handled_by_agent_id": {
              $in: ["supabase-manager-1"],
            },
          },
        },
      ])
    );
    expect(mockConversationAggregate).not.toHaveBeenCalled();
    expect(
      result.stats.find(stat => stat.id === "first_response")
    ).toMatchObject({
      value: 1860,
      secondaryValue: null,
      comparison: {
        current: 1860,
        previous: 120,
        delta: 1740,
        percentChange: 1450,
        kind: "increase",
      },
    });
    expect(result.managerPerformance).toEqual([
      expect.objectContaining({
        id: "supabase-manager-1",
        name: "Aida Manager",
        conversations: 2,
        medianFirstResponseSeconds: 1860,
        averageFirstResponseSeconds: 1860,
        p90FirstResponseSeconds: 3600,
      }),
    ]);
  });

  it.each([
    [0, 120, -120, -100, "decrease"],
    [120, 0, 120, null, "increase"],
  ] as const)(
    "keeps a %s-second current and %s-second previous median directional",
    async (currentSeconds, previousSeconds, delta, percentChange, kind) => {
      mockConversationReads(
        [],
        [
          {
            first_inbound_at: new Date("2026-07-09T10:00:00.000Z"),
            first_response_seconds: currentSeconds,
          },
          {
            first_inbound_at: new Date("2026-07-02T10:00:00.000Z"),
            first_response_seconds: previousSeconds,
          },
        ]
      );

      const result = await calculateDashboardMetrics(
        "workspace-1",
        customComparisonPeriod(
          new Date("2026-07-08T00:00:00.000Z"),
          new Date("2026-07-15T00:00:00.000Z")
        )
      );

      expect(
        result.stats.find(stat => stat.id === "first_response")?.comparison
      ).toEqual({
        current: currentSeconds,
        previous: previousSeconds,
        delta,
        percentChange,
        kind,
      });
    }
  );

  it("labels unmapped WhatsApp Business app replies without exposing synthetic ids as unknown managers", async () => {
    mockConversationReads(
      [],
      [
        {
          first_inbound_at: new Date("2026-07-09T10:00:00.000Z"),
          first_response_seconds: 120,
          first_response_manager_id: "whatsapp_business_123",
          first_response_manager_name: "Business Account",
        },
      ]
    );

    const result = await calculateDashboardMetrics(
      "workspace-1",
      customComparisonPeriod(
        new Date("2026-07-08T00:00:00.000Z"),
        new Date("2026-07-15T00:00:00.000Z")
      )
    );

    expect(result.managerPerformance).toEqual([
      expect.objectContaining({
        id: "whatsapp_business_123",
        name: "WhatsApp Business app",
        firstResponseCount: 1,
        medianFirstResponseSeconds: 120,
      }),
    ]);
  });
});
