import { NextRequest } from "next/server";
import mongoose from "mongoose";
import { createSupabaseQueryMock } from "@/test-support/supabase-query-test-utils";

const mockConnectDB = jest.fn(async () => undefined);
const mockRequireScenarioWorkspaceAccess = jest.fn(async () => ({
  ok: true,
}));
const mockConversationAggregate = jest.fn();
const mockConversationFind = jest.fn();
const mockMessageAggregate = jest.fn();
const mockMessageFind = jest.fn();
const mockTemplateFind = jest.fn();
const mockSupabaseFrom = jest.fn();
const mockCacheEntries = new Map<string, { value: unknown; expiresAt: number }>();
const mockCacheLocks = new Map<string, string>();
const mockFetchConversationIdsMatchingMessageText = jest.fn<
  Promise<{
    ids: string[];
    truncated: boolean;
    matchesByConversation: Map<string, unknown> | null;
  } | null>,
  unknown[]
>(async () => null);

function createSupabaseQuery() {
  return createSupabaseQueryMock({ data: [], error: null });
}

function createMongoQuery(data: unknown[] = []) {
  const query: Record<string, jest.Mock> = {};
  query.select = jest.fn(() => query);
  query.sort = jest.fn(() => query);
  query.limit = jest.fn(() => query);
  query.maxTimeMS = jest.fn(() => query);
  query.setOptions = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn(async () => data);
  query.then = jest.fn((resolve, reject) =>
    Promise.resolve(data).then(resolve, reject)
  );
  return query;
}

function createAggregateResult(result: unknown) {
  return {
    allowDiskUse: jest.fn().mockReturnThis(),
    option: jest.fn().mockReturnThis(),
    then: (
      resolve: (value: unknown) => unknown,
      reject?: (error: unknown) => unknown
    ) =>
      Promise.resolve(result).then(resolve, reject),
  };
}

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: Parameters<typeof mockConnectDB>) =>
    mockConnectDB(...args),
  connectDB: (...args: Parameters<typeof mockConnectDB>) =>
    mockConnectDB(...args),
}));

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (
    ...args: Parameters<typeof mockRequireScenarioWorkspaceAccess>
  ) => mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
  },
}));

jest.mock("@/models/whatsapp-template", () => ({
  WhatsAppTemplateModel: {
    find: (...args: unknown[]) => mockTemplateFind(...args),
  },
}));

jest.mock("@icecore/shared/lib/cache", () => ({
  cache: {
    get: async (key: string) => {
      const entry = mockCacheEntries.get(key);
      return entry && entry.expiresAt > Date.now()
        ? JSON.parse(JSON.stringify(entry.value))
        : null;
    },
    set: async (key: string, value: unknown, ttl: number) => {
      mockCacheEntries.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    },
    acquireLock: async (key: string, owner: string) => {
      if (mockCacheLocks.has(key)) return "contended";
      mockCacheLocks.set(key, owner);
      return "acquired";
    },
    compareAndDelete: async (key: string, owner: string) => {
      if (mockCacheLocks.get(key) === owner) mockCacheLocks.delete(key);
    },
  },
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    aggregate: (...args: unknown[]) => mockConversationAggregate(...args),
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

jest.mock("@/lib/logger", () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("@/lib/analytics/bulk-analytics-audience", () => {
  const actual = jest.requireActual("@/lib/analytics/bulk-analytics-audience");
  return {
    ...actual,
    fetchConversationIdsMatchingMessageText: (...args: unknown[]) =>
      mockFetchConversationIdsMatchingMessageText(...args),
  };
});

describe("bulk analytics route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCacheEntries.clear();
    mockCacheLocks.clear();
    mockFetchConversationIdsMatchingMessageText.mockResolvedValue(null);
    mockSupabaseFrom.mockImplementation(() => createSupabaseQuery());
    mockMessageFind.mockReturnValue(createMongoQuery());
    mockConversationFind.mockReturnValue(createMongoQuery());
    mockTemplateFind.mockReturnValue(createMongoQuery());
    mockMessageAggregate.mockReturnValue(
      createAggregateResult([
        {
          summary: [
            {
              totalAccepted: 2,
              uniqueConversations: 2,
              replied: 1,
              notReplied: 1,
              totalReplies: 1,
              replyRate: 0.5,
              read: 1,
              readRate: 0.5,
              delivered: 2,
              deliveryRate: 1,
              failed: 0,
              failedRate: 0,
              estimatedCost: 0.11,
              costPerReply: 0.11,
              avgReplyDelayMinutes: 12,
              firstSentAt: "2026-06-25T10:00:00.000Z",
              lastSentAt: "2026-06-25T11:00:00.000Z",
            },
          ],
          byTemplate: [],
          daily: [],
          replyCategories: [],
          outcomes: [{ bucket: "replied", count: 1 }],
          failures: [],
          detectedRuns: [],
          topConversations: [],
        },
      ])
    );
    mockConversationAggregate.mockReturnValue(createAggregateResult([]));
  });

  afterEach(() => jest.useRealTimers());

  it("runs message aggregates for campaign-send overview", async () => {
    const { GET } = await import("./route");

    const response = await GET(
      new NextRequest(
        "https://airi.chat/api/workspaces/ws-1/analytics/bulk?view=overview&conversationScope=campaign_sends"
      ),
      { params: Promise.resolve({ workspaceId: "ws-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.overview).toBeUndefined();
    expect(payload.summary).toEqual(
      expect.objectContaining({
        totalAccepted: 2,
        replied: 1,
        delivered: 2,
        deliveryRate: 1,
        estimatedCost: 0.11,
        costPerReply: 0.11,
      })
    );
    expect(payload.outcomes).toEqual([{ bucket: "replied", count: 1 }]);
    expect(payload.compare).toEqual(
      expect.objectContaining({
        summary: expect.objectContaining({
          totalAccepted: 2,
        }),
        outcomes: [{ bucket: "replied", count: 1 }],
      })
    );
    expect(mockConnectDB).toHaveBeenCalledTimes(1);
    expect(mockMessageAggregate).toHaveBeenCalled();
  });

  it("skips previous-period compare when compare=off", async () => {
    const { GET } = await import("./route");

    const response = await GET(
      new NextRequest(
        "https://airi.chat/api/workspaces/ws-1/analytics/bulk?view=overview&conversationScope=campaign_sends&compare=off"
      ),
      { params: Promise.resolve({ workspaceId: "ws-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.compare).toBeNull();
  });

  it("runs previous-period compare without current-window overview work", async () => {
    const { GET } = await import("./route");

    const response = await GET(
      new NextRequest(
        "https://airi.chat/api/workspaces/ws-1/analytics/bulk?view=compare&conversationScope=campaign_sends&compare=previous"
      ),
      { params: Promise.resolve({ workspaceId: "ws-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.summary).toBeUndefined();
    expect(payload.compare).toEqual(
      expect.objectContaining({
        summary: expect.objectContaining({
          totalAccepted: 2,
        }),
        outcomes: [{ bucket: "replied", count: 1 }],
      })
    );
    expect(mockTemplateFind).not.toHaveBeenCalled();
    expect(mockMessageAggregate).toHaveBeenCalledTimes(1);
  });

  it("nulls delivery economics for conversation-pool scopes", async () => {
    mockConversationAggregate.mockReturnValue(
      createAggregateResult([
        {
          summary: [
            {
              totalAccepted: 3,
              uniqueConversations: 3,
              replied: 2,
              notReplied: 1,
              totalReplies: 2,
              replyRate: 2 / 3,
              avgReplyDelayMinutes: 8,
              firstSentAt: "2026-06-25T10:00:00.000Z",
              lastSentAt: "2026-06-25T11:00:00.000Z",
            },
          ],
        },
      ])
    );
    // Poison send-pipeline facets so a regression would surface mismatched totals.
    mockMessageAggregate.mockReturnValue(
      createAggregateResult([
        {
          summary: [
            {
              totalAccepted: 99,
              uniqueConversations: 99,
              replied: 99,
              notReplied: 0,
              totalReplies: 99,
              replyRate: 1,
              avgReplyDelayMinutes: 1,
              firstSentAt: "2026-06-25T10:00:00.000Z",
              lastSentAt: "2026-06-25T11:00:00.000Z",
            },
          ],
          byTemplate: [{ templateName: "poison", accepted: 99 }],
          daily: [{ date: "2026-06-25", accepted: 99, replied: 99 }],
          replyCategories: [{ category: "text", count: 99 }],
          detectedRuns: [{ templateName: "poison", accepted: 99 }],
          topConversations: [{ conversationId: "poison", replyCount: 99 }],
        },
      ])
    );

    const { GET } = await import("./route");

    const response = await GET(
      new NextRequest(
        "https://airi.chat/api/workspaces/ws-1/analytics/bulk?view=overview&conversationScope=all"
      ),
      { params: Promise.resolve({ workspaceId: "ws-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.overview).toBeUndefined();
    expect(payload.summary).toEqual(
      expect.objectContaining({
        totalAccepted: 3,
        replied: 2,
        delivered: null,
        estimatedCost: null,
        read: null,
      })
    );
    expect(payload.byTemplate).toEqual([]);
    expect(payload.daily).toEqual([]);
    expect(payload.replyCategories).toEqual([]);
    expect(payload.outcomes).toEqual([]);
    expect(payload.failures).toEqual([]);
    expect(payload.detectedRuns).toEqual([]);
    expect(payload.topConversations).toEqual([]);
    expect(payload.compare).toBeNull();
    expect(mockConversationAggregate).toHaveBeenCalled();
    // Template-option aggregate may still run; send-facet overview must not.
    const overviewFacetCalls = mockMessageAggregate.mock.calls.filter(call => {
      const pipeline = call[0] as unknown[];
      return JSON.stringify(pipeline).includes('"byTemplate"');
    });
    expect(overviewFacetCalls).toHaveLength(0);
  });

  it("serves campaign-send records from message aggregates", async () => {
    mockMessageAggregate.mockReturnValue(
      createAggregateResult([
        {
          messageId: "wamid.1",
          recipient: "+77001234567",
          templateName: "promo_template",
          conversationId: new mongoose.Types.ObjectId().toString(),
          replied: false,
          replyCount: 0,
        },
      ])
    );

    const { GET } = await import("./route");

    const response = await GET(
      new NextRequest(
        "https://airi.chat/api/workspaces/ws-1/analytics/bulk?view=records&conversationScope=campaign_sends&from=2026-06-25T00:00:00.000Z&to=2026-06-26T00:00:00.000Z"
      ),
      { params: Promise.resolve({ workspaceId: "ws-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.records).toEqual([
      expect.objectContaining({
        messageId: "wamid.1",
        templateName: "promo_template",
      }),
    ]);
    expect(mockMessageAggregate).toHaveBeenCalled();
  });

  it("rejects truncated contains message filters", async () => {
    mockFetchConversationIdsMatchingMessageText.mockResolvedValue({
      ids: ["conv-1"],
      truncated: true,
      matchesByConversation: null,
    });

    const { GET } = await import("./route");

    const response = await GET(
      new NextRequest(
        "https://airi.chat/api/workspaces/ws-1/analytics/bulk?view=overview&conversationScope=campaign_sends&messageContains=promo&messageContainsMode=contains"
      ),
      { params: Promise.resolve({ workspaceId: "ws-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({
      error: expect.stringContaining("include safely"),
      code: "MESSAGE_CONTAINS_TOO_BROAD",
      dataQuality: {
        complete: false,
        reasons: ["MESSAGE_CONTAINS_TOO_BROAD"],
        observedAt: expect.any(String),
        consistency: "bounded_observation",
      },
    });
    expect(mockMessageAggregate).not.toHaveBeenCalled();
  });

  it("rejects truncated not_contains message filters", async () => {
    mockFetchConversationIdsMatchingMessageText.mockResolvedValue({
      ids: ["conv-1"],
      truncated: true,
      matchesByConversation: null,
    });

    const { GET } = await import("./route");

    const response = await GET(
      new NextRequest(
        "https://airi.chat/api/workspaces/ws-1/analytics/bulk?view=overview&conversationScope=campaign_sends&messageContains=promo&messageContainsMode=not_contains"
      ),
      { params: Promise.resolve({ workspaceId: "ws-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({
      error: expect.stringContaining("exclude safely"),
      code: "MESSAGE_CONTAINS_TOO_BROAD",
      dataQuality: {
        complete: false,
        reasons: ["MESSAGE_CONTAINS_TOO_BROAD"],
        observedAt: expect.any(String),
        consistency: "bounded_observation",
      },
    });
  });

  it("shares one deadline across SQL coverage, text search, and Mongo reads", async () => {
    jest.useFakeTimers({ now: new Date("2026-10-10T12:00:00Z") });
    let finishCoverage!: (value: { data: unknown[]; error: null }) => void;
    const coverage = new Promise(resolve => {
      finishCoverage = resolve;
    });
    const sqlQuery = createSupabaseQuery();
    Object.assign(sqlQuery, {
      then: (
        resolve: (value: unknown) => unknown,
        reject: (reason: unknown) => unknown
      ) => coverage.then(resolve, reject),
    });
    mockSupabaseFrom.mockReturnValue(sqlQuery);
    const aggregate = createAggregateResult([]);
    mockMessageAggregate.mockReturnValue(aggregate);
    const { GET } = await import("./route");

    const pending = GET(
      new NextRequest(
        "https://airi.chat/api/workspaces/ws-1/analytics/bulk?view=records&conversationScope=campaign_sends"
      ),
      { params: Promise.resolve({ workspaceId: "ws-1" }) }
    );
    await jest.advanceTimersByTimeAsync(0);
    const signal = sqlQuery.abortSignal.mock.calls[0][0] as AbortSignal;
    expect(signal.aborted).toBe(false);
    expect(mockMessageAggregate).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(5000);
    finishCoverage({ data: [], error: null });
    const response = await pending;

    expect(response.status).toBe(200);
    expect(mockFetchConversationIdsMatchingMessageText).toHaveBeenCalledWith(
      expect.objectContaining({ signal, maxTimeMS: 20_000 })
    );
    expect(aggregate.option).toHaveBeenCalledWith({
      signal,
      maxTimeMS: 20_000,
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it("times out stalled Mongo work and never caches its late result", async () => {
    jest.useFakeTimers({ now: new Date("2026-10-10T12:00:00Z") });
    let finishAggregate!: (value: unknown[]) => void;
    const stalled = createAggregateResult(
      new Promise(resolve => {
        finishAggregate = resolve;
      })
    );
    mockMessageAggregate.mockReturnValueOnce(stalled);
    const { GET } = await import("./route");
    const request = () =>
      new NextRequest(
        "https://airi.chat/api/workspaces/ws-1/analytics/bulk?view=records&conversationScope=campaign_sends"
      );
    const context = { params: Promise.resolve({ workspaceId: "ws-1" }) };

    const pending = GET(request(), context);
    await jest.advanceTimersByTimeAsync(0);
    const signal = stalled.option.mock.calls[0][0].signal as AbortSignal;
    await jest.advanceTimersByTimeAsync(25_000);
    const response = await pending;

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error: "Analytics query exceeded its execution budget",
      code: "ANALYTICS_TIMEOUT",
      dataQuality: {
        complete: false,
        reasons: ["ANALYTICS_TIMEOUT"],
        observedAt: expect.any(String),
        consistency: "bounded_observation",
      },
    });
    expect(signal.aborted).toBe(true);
    finishAggregate([{ messageId: "late-result" }]);
    await jest.advanceTimersByTimeAsync(0);
    expect(
      Array.from(mockCacheEntries.keys()).some(key =>
        key.startsWith("bulk-analytics:v2:")
      )
    ).toBe(false);
    expect(mockCacheLocks.size).toBe(0);

    mockMessageAggregate.mockReturnValue(createAggregateResult([]));
    const retry = await GET(request(), context);
    expect(retry.status).toBe(200);
    expect((await retry.json()).records).toEqual([]);
    expect(mockMessageAggregate).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("cancels one viewer without cancelling another viewer's shared aggregate", async () => {
    jest.useFakeTimers({ now: new Date("2026-10-10T12:00:00Z") });
    let finishAggregate!: (value: unknown[]) => void;
    const aggregate = createAggregateResult(
      new Promise(resolve => {
        finishAggregate = resolve;
      })
    );
    mockMessageAggregate.mockReturnValue(aggregate);
    const { GET } = await import("./route");
    const controller = new AbortController();
    const request = (signal?: AbortSignal) =>
      new NextRequest(
        "https://airi.chat/api/workspaces/ws-1/analytics/bulk?view=records&conversationScope=campaign_sends",
        { signal }
      );
    const context = { params: Promise.resolve({ workspaceId: "ws-1" }) };

    const first = GET(request(controller.signal), context);
    await jest.advanceTimersByTimeAsync(0);
    const second = GET(request(), context);
    await jest.advanceTimersByTimeAsync(0);
    controller.abort();
    const cancelled = await first;
    expect(cancelled.status).toBe(499);
    expect(await cancelled.json()).toEqual({
      error: "Analytics request cancelled",
      code: "ANALYTICS_CANCELLED",
    });
    expect(aggregate.option.mock.calls[0][0].signal.aborted).toBe(false);

    finishAggregate([{ messageId: "shared-result" }]);
    await jest.advanceTimersByTimeAsync(500);
    const completed = await second;
    expect(completed.status).toBe(200);
    expect((await completed.json()).records).toEqual([
      { messageId: "shared-result" },
    ]);
    const cached = await GET(request(), context);
    expect(cached.status).toBe(200);
    expect(mockMessageAggregate).toHaveBeenCalledTimes(1);
    expect(mockCacheLocks.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });
});
