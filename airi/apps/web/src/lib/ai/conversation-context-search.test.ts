const mockAggregate = jest.fn();
const mockFind = jest.fn();

jest.mock("@/models/conversation", () => ({
  Conversation: {
    aggregate: (...args: unknown[]) => mockAggregate(...args),
    find: (...args: unknown[]) => mockFind(...args),
  },
}));

import { hasCurrentConversationClassification } from "@icecore/shared/lib/conversation-classification-freshness";
import {
  FILTERED_CONVERSATION_VECTOR_INDEX,
  searchConversationContext,
} from "./conversation-context-search";

const CURRENT_CLASSIFICATION_FILTER = {
  is_classified: true,
  "classification_state.contractVersion": 2,
  "classification_state.status": "ready",
  "classification_meta.provenance_kind": "v2",
  "classification_meta.analysis_revision_id": {
    $type: "string",
    $regex: /\S/u,
  },
  $expr: {
    $and: [
      { $isNumber: "$classification_revision" },
      { $gt: ["$classification_revision", 0] },
      { $lte: ["$classification_revision", Number.MAX_SAFE_INTEGER] },
      {
        $eq: [
          { $trunc: "$classification_revision" },
          "$classification_revision",
        ],
      },
      {
        $eq: [
          "$classification_revision",
          "$classification_state.requestedRevision",
        ],
      },
      {
        $eq: [
          "$classification_revision",
          "$classification_state.appliedRevision",
        ],
      },
      {
        $eq: [
          "$classification_revision",
          "$classification_meta.source_revision",
        ],
      },
    ],
  },
};

const VECTOR_PROJECTION = {
  _id: 1,
  summary: "$classification.summary",
  history_summary: 1,
  category: "$classification.category",
  priority: "$classification.priority",
  createdAt: 1,
  lastMessageAt: 1,
};

const PROJECTED_VECTOR_ROW = {
  _id: "vector-conversation",
  summary: "Current vector summary",
  category: "Pricing",
  priority: "medium",
  lastMessageAt: new Date("2026-08-10T10:00:00.000Z"),
};

function currentConversation(overrides: Record<string, unknown> = {}) {
  return {
    _id: "current-conversation",
    is_classified: true,
    classification_revision: 4,
    classification_state: {
      contractVersion: 2,
      status: "ready",
      requestedRevision: 4,
      appliedRevision: 4,
    },
    classification_meta: {
      provenance_kind: "v2",
      source_revision: 4,
      analysis_revision_id: "analysis-4",
    },
    classification: {
      summary: "Current classification summary",
      category: "Pricing",
      priority: "medium",
    },
    lastMessageAt: new Date("2026-08-10T10:00:00.000Z"),
    ...overrides,
  };
}

function configureFindRows(rows: unknown[]) {
  const lean = jest.fn().mockResolvedValue(rows);
  const select = jest.fn().mockReturnValue({ lean });
  const limit = jest.fn().mockReturnValue({ select });
  const sort = jest.fn().mockReturnValue({ limit });
  mockFind.mockReturnValue({ sort });
  return { sort, limit, select, lean };
}

describe("searchConversationContext", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAggregate.mockResolvedValue([PROJECTED_VECTOR_ROW]);
    configureFindRows([]);
  });

  it.each([
    { requested: Number.NaN, result: 1, vector: 8, candidates: 160 },
    { requested: -10, result: 1, vector: 8, candidates: 160 },
    { requested: 3.9, result: 3, vector: 24, candidates: 480 },
    { requested: 5, result: 5, vector: 40, candidates: 800 },
    { requested: 50, result: 50, vector: 400, candidates: 8000 },
    { requested: 5000, result: 50, vector: 400, candidates: 8000 },
  ])(
    "normalizes limit $requested to $result and bounds vector oversampling",
    async ({ requested, result, vector, candidates }) => {
      await searchConversationContext({
        workspaceId: "workspace-1",
        query: "pricing",
        limit: requested,
        queryEmbedding: [0.1, 0.2],
      });

      const pipeline = mockAggregate.mock.calls[0]?.[0] as Array<
        Record<string, unknown>
      >;
      expect(pipeline[0]).toEqual({
        $vectorSearch: {
          index: FILTERED_CONVERSATION_VECTOR_INDEX,
          path: "embedding",
          queryVector: [0.1, 0.2],
          numCandidates: candidates,
          limit: vector,
          filter: { workspaceId: "workspace-1" },
        },
      });
      expect(pipeline[2]).toEqual({ $limit: result });
    }
  );

  it("uses the exact vector, currentness, result-limit, projection order", async () => {
    await searchConversationContext({
      workspaceId: "workspace-1",
      query: "pricing",
      limit: 5,
      sourceIds: [" source-1 ", "source-1", ""],
      queryEmbedding: [0.1, 0.2],
    });

    expect(mockAggregate).toHaveBeenCalledWith([
      {
        $vectorSearch: {
          index: "vector_search_conversations_v2",
          path: "embedding",
          queryVector: [0.1, 0.2],
          numCandidates: 800,
          limit: 40,
          filter: {
            workspaceId: "workspace-1",
            sourceId: { $in: ["source-1"] },
          },
        },
      },
      { $match: CURRENT_CLASSIFICATION_FILTER },
      { $limit: 5 },
      { $project: VECTOR_PROJECTION },
    ]);
  });

  it.each([
    [
      "pending",
      currentConversation({
        classification_state: {
          contractVersion: 2,
          status: "pending",
          requestedRevision: 4,
          appliedRevision: 4,
        },
      }),
    ],
    [
      "legacy",
      currentConversation({
        classification_meta: {
          provenance_kind: "legacy_unknown",
          source_revision: 4,
          analysis_revision_id: "analysis-4",
        },
      }),
    ],
    [
      "revision mismatch",
      currentConversation({
        classification_state: {
          contractVersion: 2,
          status: "ready",
          requestedRevision: 5,
          appliedRevision: 4,
        },
      }),
    ],
    [
      "blank analysis identity",
      currentConversation({
        classification_meta: {
          provenance_kind: "v2",
          source_revision: 4,
          analysis_revision_id: "   ",
        },
      }),
    ],
    ["partial", { is_classified: true, classification_revision: 4 }],
  ])("uses the shared filter that rejects %s state", async (_label, value) => {
    await searchConversationContext({
      workspaceId: "workspace-1",
      query: "pricing",
      limit: 5,
      queryEmbedding: [0.1, 0.2],
    });

    const pipeline = mockAggregate.mock.calls[0]?.[0] as Array<
      Record<string, unknown>
    >;
    expect(pipeline[1]).toEqual({ $match: CURRENT_CLASSIFICATION_FILTER });
    expect(hasCurrentConversationClassification(value)).toBe(false);
  });

  it.each([
    { requested: 1, candidates: 100 },
    { requested: 5, candidates: 100 },
    { requested: 26, candidates: 500 },
    { requested: 5000, candidates: 500 },
  ])(
    "uses one bounded recent fallback query for limit $requested",
    async ({ requested, candidates }) => {
      mockAggregate.mockRejectedValue(new Error("vector index unavailable"));
      const chain = configureFindRows([currentConversation()]);

      await searchConversationContext({
        workspaceId: "workspace-1",
        query: "pricing",
        limit: requested,
        sourceIds: ["source-1"],
        queryEmbedding: [0.1, 0.2],
      });

      expect(mockFind).toHaveBeenCalledTimes(1);
      expect(mockFind).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        sourceId: { $in: ["source-1"] },
        ...CURRENT_CLASSIFICATION_FILTER,
      });
      expect(chain.sort).toHaveBeenCalledWith({
        lastMessageAt: -1,
        updatedAt: -1,
      });
      expect(chain.limit).toHaveBeenCalledWith(candidates);
      expect(chain.select).toHaveBeenCalledWith(
        "_id classification.summary classification.category classification.priority history_summary subject rename internal_labels createdAt lastMessageAt"
      );

      const fallbackFilter = mockFind.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(fallbackFilter).not.toHaveProperty("$or");
      expect(fallbackFilter["classification.summary"]).toBeUndefined();
      expect(fallbackFilter["classification.category"]).toBeUndefined();
      expect(fallbackFilter.history_summary).toBeUndefined();
      expect(fallbackFilter.subject).toBeUndefined();
      expect(fallbackFilter.rename).toBeUndefined();
      expect(fallbackFilter.internal_labels).toBeUndefined();
    }
  );

  it("ranks keyword matches first, preserves recency within ranks, and deduplicates", async () => {
    mockAggregate.mockRejectedValue(new Error("vector index unavailable"));
    configureFindRows([
      currentConversation({
        _id: "recent-non-match",
        classification: {
          summary: "General account update",
          category: "Support",
          priority: "low",
        },
      }),
      currentConversation({
        _id: "subject-match",
        subject: "PRICING renewal details",
        classification: {
          summary: "Customer requested a quote",
          category: "Sales",
          priority: "medium",
        },
      }),
      currentConversation({
        _id: "subject-match",
        rename: "duplicate pricing row",
        classification: {
          summary: "Duplicate row must not escape",
          category: "Sales",
          priority: "medium",
        },
      }),
      currentConversation({
        _id: "label-match",
        internal_labels: ["refund_requested"],
        classification: {
          summary: "Customer asked for help",
          category: "Support",
          priority: "high",
        },
      }),
      currentConversation({
        _id: "older-non-match",
        classification: {
          summary: "Delivery timing question",
          category: "Delivery",
          priority: "low",
        },
      }),
    ]);

    const result = await searchConversationContext({
      workspaceId: "workspace-1",
      query: " Pricing, REFUND!!! ",
      limit: 4,
      queryEmbedding: [0.1, 0.2],
    });

    expect(result.conversations.map(conversation => conversation.id)).toEqual([
      "subject-match",
      "label-match",
      "recent-non-match",
      "older-non-match",
    ]);
    expect(result.metadata).toEqual({
      retrievalPath: "fallback_keyword_recent",
      vectorIndex: "vector_search_conversations_v2",
      vectorConversationCount: 0,
      fallbackConversationCount: 4,
    });
  });

  it("normalizes at most eight query terms before keyword ranking", async () => {
    mockAggregate.mockResolvedValue([]);
    configureFindRows([
      currentConversation({
        _id: "ninth-term",
        subject: "ninth",
        classification: {
          summary: "Ninth term row",
          category: "Support",
          priority: "low",
        },
      }),
      currentConversation({
        _id: "eighth-term",
        subject: "eight",
        classification: {
          summary: "Eighth term row",
          category: "Support",
          priority: "low",
        },
      }),
      currentConversation({
        _id: "recent-row",
        classification: {
          summary: "Recent neutral row",
          category: "Support",
          priority: "low",
        },
      }),
    ]);

    const result = await searchConversationContext({
      workspaceId: "workspace-1",
      query: "one two three four five six seven eight ninth",
      limit: 3,
      queryEmbedding: [0.1, 0.2],
    });

    expect(result.conversations.map(conversation => conversation.id)).toEqual([
      "eighth-term",
      "ninth-term",
      "recent-row",
    ]);
  });

  it("keeps embedding-unavailable and vector-failure metadata fail-soft", async () => {
    configureFindRows([currentConversation({ _id: "fallback-row" })]);

    const unavailable = await searchConversationContext({
      workspaceId: "workspace-1",
      query: "pricing",
      limit: 5,
      queryEmbedding: null,
    });
    expect(mockAggregate).not.toHaveBeenCalled();
    expect(unavailable.metadata).toEqual({
      retrievalPath: "embedding_unavailable",
      vectorIndex: null,
      vectorConversationCount: 0,
      fallbackConversationCount: 1,
    });

    jest.clearAllMocks();
    mockAggregate.mockRejectedValue(new Error("vector index unavailable"));
    configureFindRows([currentConversation({ _id: "fallback-row" })]);
    const vectorFailure = await searchConversationContext({
      workspaceId: "workspace-1",
      query: "pricing",
      limit: 5,
      queryEmbedding: [0.1, 0.2],
    });
    expect(vectorFailure.metadata).toEqual({
      retrievalPath: "fallback_keyword_recent",
      vectorIndex: "vector_search_conversations_v2",
      vectorConversationCount: 0,
      fallbackConversationCount: 1,
    });
  });
});
