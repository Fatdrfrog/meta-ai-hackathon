jest.mock("@/lib/ai", () => ({
  getQueryEmbeddingWithCache: jest.fn(),
  cosineSimilarity: (left: number[], right: number[]) => {
    const dot = left.reduce(
      (sum, value, index) => sum + value * right[index],
      0
    );
    const leftMagnitude = Math.sqrt(
      left.reduce((sum, value) => sum + value * value, 0)
    );
    const rightMagnitude = Math.sqrt(
      right.reduce((sum, value) => sum + value * value, 0)
    );
    return dot / (leftMagnitude * rightMagnitude);
  },
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { rpc: jest.fn(), from: jest.fn() },
}));

jest.mock("@/models/conversation", () => {
  const actual = jest.requireActual("@/models/conversation");
  return {
    ...actual,
    Conversation: { find: jest.fn() },
  };
});

import { getQueryEmbeddingWithCache } from "@/lib/ai";
import {
  retrieveConversationSummaries,
  type ConversationSummaryResult,
} from "@/lib/airi/rag/conversation-summary/conversation-summary-retrieval";
import {
  buildConversationSummarySlotId,
  buildConversationSummarySourceRevisionSortKey,
} from "@/lib/airi/rag/conversation-summary/conversation-summary-versioning";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { Conversation } from "@/models/conversation";

type Row = Record<string, unknown> & { id: string };

class ReadQuery implements PromiseLike<{ data: Row[] | null; error: unknown }> {
  private readonly filters: Array<(row: Row) => boolean> = [];
  private limitCount: number | null = null;

  constructor(
    private readonly rows: Row[],
    private readonly queryError: unknown = null
  ) {}

  select(_columns?: string): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push(row => row[column] === value);
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push(row => values.includes(row[column]));
    return this;
  }

  not(column: string, operator: string, value: unknown): this {
    if (operator !== "is" || value !== null) {
      throw new Error("Unexpected not filter");
    }
    this.filters.push(row => row[column] !== null && row[column] !== undefined);
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  then<TResult1 = { data: Row[] | null; error: unknown }, TResult2 = never>(
    onfulfilled?:
      | ((value: {
          data: Row[] | null;
          error: unknown;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    let rows = this.rows.filter(row =>
      this.filters.every(filter => filter(row))
    );
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    return Promise.resolve({
      data: this.queryError ? null : structuredClone(rows),
      error: this.queryError,
    }).then(onfulfilled, onrejected);
  }
}

const mockQueryEmbedding = getQueryEmbeddingWithCache as jest.Mock;
const mockRpc = supabaseAdmin.rpc as jest.Mock;
const mockFrom = supabaseAdmin.from as jest.Mock;
const mockConversationFind = Conversation.find as jest.Mock;
const workspaceId = "workspace-retrieval-test";
const conversationIds = [
  "507f1f77bcf86cd799439021",
  "507f1f77bcf86cd799439022",
  "507f1f77bcf86cd799439023",
  "507f1f77bcf86cd799439024",
];

function queryVector(): number[] {
  return [1, ...Array.from({ length: 1535 }, () => 0)];
}

function versionMetadata(
  conversationId: string,
  sourceRevision = 7,
  chunkIndex: number | null = null,
  overrides: Record<string, unknown> = {}
) {
  return {
    analysis_revision_id: `${conversationId}:${sourceRevision}`,
    source_revision: sourceRevision,
    source_revision_sort_key:
      buildConversationSummarySourceRevisionSortKey(sourceRevision),
    analysis_completed_at: "2026-08-10T06:06:03.645Z",
    language: "en",
    word_count: 120,
    message_count: 12,
    chunk_count: chunkIndex === null ? 1 : 1,
    generation_time_ms: 42,
    embedding_provider: "vertex",
    embedding_model: "gemini-embedding-001",
    embedding_task_type: "RETRIEVAL_DOCUMENT",
    embedding_dimensions: 1536,
    ...(chunkIndex === null ? {} : { chunk_index: chunkIndex }),
    ...overrides,
  };
}

function versionRows(conversationId: string, sourceRevision = 7): Row[] {
  return [
    {
      id: buildConversationSummarySlotId({
        workspaceId,
        conversationId,
        chunkIndex: null,
      }),
      workspace_id: workspaceId,
      conversation_id: conversationId,
      summary_text: `Main ${conversationId}`,
      chunk_index: null,
      metadata: versionMetadata(conversationId, sourceRevision),
      embedding: queryVector(),
      created_at: "2026-08-10T06:06:04.000Z",
      updated_at: "2026-08-10T06:06:04.000Z",
    },
    {
      id: buildConversationSummarySlotId({
        workspaceId,
        conversationId,
        chunkIndex: 0,
      }),
      workspace_id: workspaceId,
      conversation_id: conversationId,
      summary_text: `Chunk ${conversationId}`,
      chunk_index: 0,
      metadata: versionMetadata(conversationId, sourceRevision, 0),
      embedding: queryVector(),
      created_at: "2026-08-10T06:06:04.000Z",
      updated_at: "2026-08-10T06:06:04.000Z",
    },
  ];
}

function rpcCandidate(
  conversationId: string,
  input: {
    chunkIndex?: number | null;
    summaryText?: string;
    similarity?: number;
    metadata?: Record<string, unknown>;
  } = {}
) {
  const chunkIndex = input.chunkIndex ?? null;
  return {
    conversation_id: conversationId,
    summary_text:
      input.summaryText ??
      (chunkIndex === null
        ? `Main ${conversationId}`
        : `Chunk ${conversationId}`),
    chunk_index: chunkIndex,
    similarity: input.similarity ?? 0.95,
    metadata: input.metadata ?? versionMetadata(conversationId, 7, chunkIndex),
  };
}

function currentConversation(
  conversationId: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    _id: conversationId,
    workspaceId,
    is_classified: true,
    classification_revision: 7,
    classification_state: {
      contractVersion: 2,
      status: "ready",
      requestedRevision: 7,
      appliedRevision: 7,
    },
    classification_meta: {
      provenance_kind: "v2",
      source_revision: 7,
      analysis_revision_id: `${conversationId}:7`,
    },
    ...overrides,
  };
}

function legacyConversation(conversationId: string) {
  return {
    _id: conversationId,
    workspaceId,
    is_classified: true,
    classification: { summary: "Legacy" },
    classification_meta: { provenance_kind: "legacy_unknown" },
  };
}

function installMongoRows(rows: Record<string, unknown>[]): void {
  mockConversationFind.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(rows),
      }),
    }),
  });
}

describe("retrieveConversationSummaries", () => {
  let tableRows: Row[];
  let tableError: unknown;

  beforeEach(() => {
    jest.clearAllMocks();
    tableRows = [];
    tableError = null;
    mockQueryEmbedding.mockResolvedValue(queryVector());
    mockRpc.mockResolvedValue({ data: [], error: null });
    mockFrom.mockImplementation((table: string) => {
      if (table !== "conversation_summaries") {
        throw new Error(`Unexpected table ${table}`);
      }
      return new ReadQuery(tableRows, tableError);
    });
    installMongoRows([]);
  });

  it("attributes standalone summary search to the requested workspace", async () => {
    await retrieveConversationSummaries(workspaceId, "refund policy");
    expect(mockQueryEmbedding).toHaveBeenCalledWith("refund policy", {
      workspaceId,
      actionId: expect.stringMatching(/^summary-retrieval:/),
    });
  });

  it("oversamples, verifies exact slots, queries Mongo once, then applies the limit", async () => {
    const [first, second, third] = conversationIds;
    tableRows = [
      ...versionRows(first),
      ...versionRows(second),
      ...versionRows(third),
    ];
    mockRpc.mockResolvedValue({
      data: [
        rpcCandidate(first, { similarity: 0.99 }),
        rpcCandidate(second, { similarity: 0.98 }),
        rpcCandidate(third, { similarity: 0.97 }),
      ],
      error: null,
    });
    installMongoRows([
      currentConversation(first, {
        classification_state: {
          contractVersion: 2,
          status: "pending",
          requestedRevision: 8,
          appliedRevision: 7,
        },
      }),
      currentConversation(second),
      currentConversation(third),
    ]);

    await expect(
      retrieveConversationSummaries(workspaceId, "refund policy", {
        limit: 1,
        queryEmbedding: queryVector(),
      })
    ).resolves.toEqual([
      expect.objectContaining({
        conversationId: second,
        summaryText: `Main ${second}`,
        similarity: 0.98,
        metadata: expect.objectContaining({
          analysis_revision_id: `${second}:7`,
          source_revision: 7,
        }),
      }),
    ]);
    expect(mockRpc).toHaveBeenCalledWith("match_conversation_summaries", {
      query_embedding: queryVector(),
      match_threshold: 0.8,
      match_count: 32,
      workspace_filter: workspaceId,
    });
    expect(mockConversationFind).toHaveBeenCalledTimes(1);
    expect(mockConversationFind).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId })
    );
  });

  it("rejects a candidate whose RPC payload does not match the exact slot row", async () => {
    const conversationId = conversationIds[0];
    tableRows = versionRows(conversationId);
    mockRpc.mockResolvedValue({
      data: [
        rpcCandidate(conversationId, { summaryText: "Tampered RPC text" }),
      ],
      error: null,
    });
    installMongoRows([currentConversation(conversationId)]);

    await expect(
      retrieveConversationSummaries(workspaceId, "query", {
        queryEmbedding: queryVector(),
      })
    ).resolves.toEqual([]);
  });

  it("rejects a versioned chunk without its same-revision deterministic main", async () => {
    const conversationId = conversationIds[0];
    tableRows = [versionRows(conversationId)[1]];
    mockRpc.mockResolvedValue({
      data: [rpcCandidate(conversationId, { chunkIndex: 0 })],
      error: null,
    });
    installMongoRows([currentConversation(conversationId)]);

    await expect(
      retrieveConversationSummaries(workspaceId, "query", {
        queryEmbedding: queryVector(),
      })
    ).resolves.toEqual([]);
  });

  it("rejects a versioned chunk when its deterministic main has blank text", async () => {
    const conversationId = conversationIds[0];
    const [main, chunk] = versionRows(conversationId);
    tableRows = [{ ...main, summary_text: " \t " }, chunk];
    mockRpc.mockResolvedValue({
      data: [rpcCandidate(conversationId, { chunkIndex: 0 })],
      error: null,
    });
    installMongoRows([currentConversation(conversationId)]);

    await expect(
      retrieveConversationSummaries(workspaceId, "query", {
        queryEmbedding: queryVector(),
      })
    ).resolves.toEqual([]);
  });

  it("keeps only the versioned candidate when legacy and versioned rows coexist", async () => {
    const conversationId = conversationIds[0];
    tableRows = [
      ...versionRows(conversationId),
      {
        id: "00000000-0000-4000-8000-000000000055",
        workspace_id: workspaceId,
        conversation_id: conversationId,
        summary_text: "Legacy duplicate",
        chunk_index: null,
        metadata: { message_count: 2 },
        embedding: queryVector(),
      },
    ];
    mockRpc.mockResolvedValue({
      data: [
        rpcCandidate(conversationId),
        rpcCandidate(conversationId, {
          summaryText: "Legacy duplicate",
          metadata: { message_count: 2 },
          similarity: 0.94,
        }),
      ],
      error: null,
    });
    installMongoRows([currentConversation(conversationId)]);

    const results = await retrieveConversationSummaries(workspaceId, "query", {
      queryEmbedding: queryVector(),
    });
    expect(results).toHaveLength(1);
    expect(results[0].summaryText).toBe(`Main ${conversationId}`);
  });

  it("allows legacy rows only before state, provenance, or a future contract enters v2", async () => {
    const [legacyId, stateId, provenanceId, futureId] = conversationIds;
    const legacyCandidates = [
      rpcCandidate(legacyId, {
        summaryText: "Readable legacy",
        metadata: { message_count: 2 },
      }),
      rpcCandidate(stateId, {
        summaryText: "Blocked state-only legacy",
        metadata: { message_count: 2 },
      }),
      rpcCandidate(provenanceId, {
        summaryText: "Blocked provenance-only legacy",
        metadata: { message_count: 2 },
      }),
      rpcCandidate(futureId, {
        summaryText: "Blocked future-contract legacy",
        metadata: { message_count: 2 },
      }),
    ];
    mockRpc.mockResolvedValue({ data: legacyCandidates, error: null });
    installMongoRows([
      legacyConversation(legacyId),
      {
        ...legacyConversation(stateId),
        classification_state: {
          contractVersion: 2,
          status: "processing",
        },
      },
      {
        ...legacyConversation(provenanceId),
        classification_meta: { provenance_kind: "v2" },
      },
      {
        ...legacyConversation(futureId),
        is_classified: false,
        classification_state: {
          contractVersion: 3,
          status: "processing",
        },
      },
    ]);

    await expect(
      retrieveConversationSummaries(workspaceId, "query", {
        queryEmbedding: queryVector(),
      })
    ).resolves.toEqual([
      expect.objectContaining<Partial<ConversationSummaryResult>>({
        conversationId: legacyId,
        summaryText: "Readable legacy",
      }),
    ]);
  });

  it("uses the identical gate in manual fallback and normalizes pgvector strings", async () => {
    const conversationId = conversationIds[0];
    tableRows = versionRows(conversationId).map(row => ({
      ...row,
      embedding: JSON.stringify(row.embedding),
    }));
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: "RPC unavailable" },
    });
    installMongoRows([currentConversation(conversationId)]);

    await expect(
      retrieveConversationSummaries(workspaceId, "query", {
        limit: 1,
        threshold: 0.9,
        queryEmbedding: queryVector(),
      })
    ).resolves.toEqual([
      expect.objectContaining({
        conversationId,
        summaryText: `Main ${conversationId}`,
        similarity: 1,
      }),
    ]);
  });

  it("throws when no valid query embedding exists", async () => {
    mockQueryEmbedding.mockResolvedValueOnce(null);

    await expect(
      retrieveConversationSummaries(workspaceId, "query")
    ).rejects.toThrow("Conversation summary query embedding is invalid");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("fails closed when the RPC returns more candidates than requested", async () => {
    mockRpc.mockResolvedValue({
      data: Array.from({ length: 33 }, () => rpcCandidate(conversationIds[0])),
      error: null,
    });

    await expect(
      retrieveConversationSummaries(workspaceId, "query", {
        limit: 1,
        queryEmbedding: queryVector(),
      })
    ).rejects.toThrow("Conversation summary RPC candidate limit exceeded");
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockConversationFind).not.toHaveBeenCalled();
  });

  it("rejects sparse query and stored pgvector arrays", async () => {
    const sparse = new Array<number>(1536);
    sparse[0] = 1;
    await expect(
      retrieveConversationSummaries(workspaceId, "query", {
        queryEmbedding: sparse,
      })
    ).rejects.toThrow("Conversation summary query embedding is invalid");
    expect(mockRpc).not.toHaveBeenCalled();

    const conversationId = conversationIds[0];
    tableRows = versionRows(conversationId).map(row => ({
      ...row,
      embedding: sparse,
    }));
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: "RPC unavailable" },
    });
    await expect(
      retrieveConversationSummaries(workspaceId, "query", {
        queryEmbedding: queryVector(),
      })
    ).rejects.toThrow("Conversation summary stored embedding is invalid");
  });

  it("throws for fallback transport and Mongo query failures", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: "RPC unavailable" },
    });
    tableError = { message: "fallback unavailable" };
    await expect(
      retrieveConversationSummaries(workspaceId, "query", {
        queryEmbedding: queryVector(),
      })
    ).rejects.toThrow("fallback unavailable");

    tableError = null;
    const conversationId = conversationIds[0];
    tableRows = versionRows(conversationId);
    mockRpc.mockResolvedValue({
      data: [rpcCandidate(conversationId)],
      error: null,
    });
    mockConversationFind.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockRejectedValue(new Error("Mongo unavailable")),
        }),
      }),
    });
    await expect(
      retrieveConversationSummaries(workspaceId, "query", {
        queryEmbedding: queryVector(),
      })
    ).rejects.toThrow("Mongo unavailable");
  });

  it("rejects invalid ObjectIds and applies exclusion after freshness filtering", async () => {
    const validId = conversationIds[0];
    tableRows = versionRows(validId);
    mockRpc.mockResolvedValue({
      data: [rpcCandidate("not-an-object-id"), rpcCandidate(validId)],
      error: null,
    });
    installMongoRows([currentConversation(validId)]);

    await expect(
      retrieveConversationSummaries(workspaceId, "query", {
        excludeConversationId: validId,
        queryEmbedding: queryVector(),
      })
    ).resolves.toEqual([]);
  });
});
