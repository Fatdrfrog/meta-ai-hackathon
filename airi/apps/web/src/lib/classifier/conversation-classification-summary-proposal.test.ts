jest.mock("@/lib/ai", () => ({
  generateConversationSummary: jest.fn(),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: jest.fn() },
}));

import { generateConversationSummary } from "@/lib/ai";
import {
  buildConversationSummarySlotId,
  buildConversationSummarySourceRevisionSortKey,
} from "@/lib/airi/rag/conversation-summary/conversation-summary-versioning";
import { resolveConversationClassificationSummaryProposal } from "@/lib/classifier/conversation-classification-summary-proposal";
import { supabaseAdmin } from "@/lib/supabase/admin";

type Row = Record<string, unknown> & { id: string };

class SummaryQuery
  implements PromiseLike<{ data: Row[] | null; error: unknown }>
{
  private readonly filters: Array<(row: Row) => boolean> = [];
  private orderColumn: string | null = null;
  private nullsFirst = false;
  private limitCount: number | null = null;

  constructor(
    private readonly rows: Row[],
    private readonly error: unknown,
    private readonly limits: number[]
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

  order(
    column: string,
    options?: { ascending?: boolean; nullsFirst?: boolean }
  ): this {
    this.orderColumn = column;
    this.nullsFirst = options?.nullsFirst === true;
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    this.limits.push(count);
    return this;
  }

  async maybeSingle(): Promise<{ data: Row | null; error: unknown }> {
    const result = await this.execute();
    if (result.error) return { data: null, error: result.error };
    const rows = result.data ?? [];
    if (rows.length > 1) {
      return {
        data: null,
        error: { code: "PGRST116", message: "Expected at most one row" },
      };
    }
    return { data: rows[0] ?? null, error: null };
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
    return this.execute().then(onfulfilled, onrejected);
  }

  private execute(): Promise<{ data: Row[] | null; error: unknown }> {
    if (this.error) return Promise.resolve({ data: null, error: this.error });
    let rows = this.rows.filter(row =>
      this.filters.every(filter => filter(row))
    );
    if (this.orderColumn) {
      const column = this.orderColumn;
      rows = rows.sort((left, right) => {
        const leftValue = left[column];
        const rightValue = right[column];
        if (leftValue === null || rightValue === null) {
          if (leftValue === rightValue) return 0;
          return leftValue === null
            ? this.nullsFirst
              ? -1
              : 1
            : this.nullsFirst
              ? 1
              : -1;
        }
        return Number(leftValue) - Number(rightValue);
      });
    }
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    return Promise.resolve({ data: structuredClone(rows), error: null });
  }
}

const mockGenerateSummary = generateConversationSummary as jest.Mock;
const mockFrom = supabaseAdmin.from as jest.Mock;
const conversationId = "conversation-1";
const workspaceId = "workspace-1";

function messages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    text: `message ${index}`,
    date: new Date(
      `2026-08-10T00:${String(index % 60).padStart(2, "0")}:00.000Z`
    ),
  }));
}

function legacyRows(overrides: Record<string, unknown> = {}): Row[] {
  return [
    {
      id: "00000000-0000-4000-8000-000000000001",
      workspace_id: workspaceId,
      conversation_id: conversationId,
      summary_text: "Stored canonical summary",
      chunk_index: null,
      metadata: {
        word_count: 12,
        message_count: 80,
        chunk_count: 2,
        generation_time_ms: 17,
      },
      created_at: "2026-08-09T00:00:00.000Z",
      updated_at: "2026-08-09T00:00:01.000Z",
      ...overrides,
    },
    {
      id: "00000000-0000-4000-8000-000000000003",
      workspace_id: workspaceId,
      conversation_id: conversationId,
      summary_text: "Second chunk",
      chunk_index: 1,
      metadata: {},
      created_at: "2026-08-09T00:00:00.000Z",
      updated_at: "2026-08-09T00:00:01.000Z",
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      workspace_id: workspaceId,
      conversation_id: conversationId,
      summary_text: "First chunk",
      chunk_index: 0,
      metadata: {},
      created_at: "2026-08-09T00:00:00.000Z",
      updated_at: "2026-08-09T00:00:01.000Z",
    },
  ];
}

function versionedRows(
  input: {
    chunkCount?: number;
    analysisCompletedAt?: string;
    createdAt?: string;
  } = {}
): Row[] {
  const chunkCount = input.chunkCount ?? 1;
  const baseMetadata = {
    analysis_revision_id: `${conversationId}:7`,
    source_revision: 7,
    source_revision_sort_key: buildConversationSummarySourceRevisionSortKey(7),
    analysis_completed_at:
      input.analysisCompletedAt ?? "2026-08-09T00:00:00.000Z",
    language: "en",
    word_count: 14,
    message_count: 80,
    chunk_count: chunkCount,
    generation_time_ms: 19,
    embedding_provider: "vertex",
    embedding_model: "gemini-embedding-001",
    embedding_task_type: "RETRIEVAL_DOCUMENT",
    embedding_dimensions: 1536,
  };
  return [
    {
      id: buildConversationSummarySlotId({
        workspaceId,
        conversationId,
        chunkIndex: null,
      }),
      workspace_id: workspaceId,
      conversation_id: conversationId,
      summary_text: "Versioned committed summary",
      chunk_index: null,
      metadata: baseMetadata,
      created_at: input.createdAt ?? "2026-07-01T00:00:00.000Z",
      updated_at: "2026-08-09T00:00:01.000Z",
    },
    ...Array.from({ length: chunkCount }, (_, chunkIndex) => ({
      id: buildConversationSummarySlotId({
        workspaceId,
        conversationId,
        chunkIndex,
      }),
      workspace_id: workspaceId,
      conversation_id: conversationId,
      summary_text: `Versioned chunk ${chunkIndex}`,
      chunk_index: chunkIndex,
      metadata: { ...baseMetadata, chunk_index: chunkIndex },
      created_at: input.createdAt ?? "2026-07-01T00:00:00.000Z",
      updated_at: "2026-08-09T00:00:01.000Z",
    })),
  ];
}

describe("conversation classification summary proposal", () => {
  let tableRows: Row[];
  let tableError: unknown;
  let limits: number[];

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    tableRows = [];
    tableError = null;
    limits = [];
    mockFrom.mockImplementation((table: string) => {
      if (table !== "conversation_summaries") {
        throw new Error(`Unexpected table ${table}`);
      }
      return new SummaryQuery(tableRows, tableError, limits);
    });
    mockGenerateSummary.mockResolvedValue({
      summary: "Generated canonical summary",
      chunks: ["Generated chunk"],
      provider: "vertex",
      metadata: {
        wordCount: 999,
        messageCount: 999,
        chunkCount: 999,
        generationTimeMs: 21,
      },
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns null below both product thresholds without any RAG or provider call", async () => {
    await expect(
      resolveConversationClassificationSummaryProposal({
        conversationId,
        workspaceId,
        messages: messages(3),
        historySummary: null,
        language: "en",
      })
    ).resolves.toBeNull();
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockGenerateSummary).not.toHaveBeenCalled();
  });

  it("returns an immutable replace proposal when a threshold is reached", async () => {
    await expect(
      resolveConversationClassificationSummaryProposal({
        conversationId,
        workspaceId,
        messages: messages(100),
        historySummary: null,
        language: "ru",
      })
    ).resolves.toEqual({
      mode: "replace",
      language: "ru",
      summary: "Generated canonical summary",
      chunks: ["Generated chunk"],
      metadata: {
        wordCount: 200,
        messageCount: 100,
        chunkCount: 1,
        generationTimeMs: 21,
      },
    });
    expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("fails strictly when current summary rows cannot be read", async () => {
    tableError = { message: "summary transport failed" };

    await expect(
      resolveConversationClassificationSummaryProposal({
        conversationId,
        workspaceId,
        messages: messages(3),
        historySummary: "Legacy summary",
        language: "en",
      })
    ).rejects.toMatchObject({
      code: "summary_input_read_failed",
      retryable: true,
    });
    expect(mockGenerateSummary).not.toHaveBeenCalled();
  });

  it("regenerates when the projection has a summary but no stored main exists", async () => {
    await expect(
      resolveConversationClassificationSummaryProposal({
        conversationId,
        workspaceId,
        messages: messages(3),
        historySummary: "Legacy summary",
        language: "en",
      })
    ).resolves.toMatchObject({ mode: "replace" });
    expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
  });

  it("fails strictly instead of arbitrarily choosing duplicate legacy mains", async () => {
    tableRows = [
      legacyRows()[0],
      {
        ...legacyRows()[0],
        id: "00000000-0000-4000-8000-000000000099",
        summary_text: "Conflicting main",
      },
    ];

    await expect(
      resolveConversationClassificationSummaryProposal({
        conversationId,
        workspaceId,
        messages: messages(3),
        historySummary: "Legacy summary",
        language: "en",
      })
    ).rejects.toMatchObject({ code: "summary_input_read_failed" });
    expect(mockGenerateSummary).not.toHaveBeenCalled();
  });

  it("bounds the legacy read to one main, sixty-four chunks, and a sentinel", async () => {
    tableRows = [
      legacyRows()[0],
      ...Array.from({ length: 65 }, (_, chunkIndex) => ({
        id: `00000000-0000-4000-8000-${String(chunkIndex + 100).padStart(12, "0")}`,
        workspace_id: workspaceId,
        conversation_id: conversationId,
        summary_text: `chunk ${chunkIndex}`,
        chunk_index: chunkIndex,
        metadata: {},
        created_at: "2026-08-09T00:00:00.000Z",
        updated_at: "2026-08-09T00:00:01.000Z",
      })),
    ];

    await expect(
      resolveConversationClassificationSummaryProposal({
        conversationId,
        workspaceId,
        messages: messages(3),
        historySummary: "Legacy summary",
        language: "en",
      })
    ).rejects.toMatchObject({ code: "summary_input_read_failed" });
    expect(limits).toContain(66);
  });

  it("promotes the exact legacy main and contiguous ordered chunks", async () => {
    tableRows = legacyRows();

    await expect(
      resolveConversationClassificationSummaryProposal({
        conversationId,
        workspaceId,
        messages: messages(100),
        historySummary: "Potentially stale Mongo summary",
        language: "kz",
      })
    ).resolves.toEqual({
      mode: "promote",
      language: "kz",
      summary: "Stored canonical summary",
      chunks: ["First chunk", "Second chunk"],
      metadata: {
        wordCount: 12,
        messageCount: 80,
        chunkCount: 2,
        generationTimeMs: 17,
      },
    });
    expect(mockGenerateSummary).not.toHaveBeenCalled();
  });

  it("gives the deterministic main precedence over five legacy main duplicates", async () => {
    tableRows = [
      ...Array.from({ length: 5 }, (_, index) => ({
        ...legacyRows()[0],
        id: `00000000-0000-4000-8000-${String(index + 200).padStart(12, "0")}`,
        summary_text: `Legacy duplicate ${index}`,
      })),
      ...versionedRows(),
    ];

    await expect(
      resolveConversationClassificationSummaryProposal({
        conversationId,
        workspaceId,
        messages: messages(10),
        historySummary: "Last good projection",
        language: "en",
      })
    ).resolves.toEqual({
      mode: "promote",
      language: "en",
      summary: "Versioned committed summary",
      chunks: ["Versioned chunk 0"],
      metadata: {
        wordCount: 14,
        messageCount: 80,
        chunkCount: 1,
        generationTimeMs: 19,
      },
    });
    expect(mockGenerateSummary).not.toHaveBeenCalled();
    expect(limits).not.toContain(66);
  });

  it("fails closed for missing versioned chunks without falling back to legacy", async () => {
    const [main] = versionedRows({ chunkCount: 1 });
    tableRows = [main, legacyRows()[0]];

    await expect(
      resolveConversationClassificationSummaryProposal({
        conversationId,
        workspaceId,
        messages: messages(10),
        historySummary: "Last good projection",
        language: "en",
      })
    ).rejects.toMatchObject({ code: "summary_input_read_failed" });
    expect(mockGenerateSummary).not.toHaveBeenCalled();
    expect(limits).not.toContain(66);
  });

  it("uses analysis_completed_at rather than legacy created_at for version age", async () => {
    tableRows = versionedRows({
      analysisCompletedAt: "2026-08-09T00:00:00.000Z",
      createdAt: "2020-01-01T00:00:00.000Z",
    });

    await expect(
      resolveConversationClassificationSummaryProposal({
        conversationId,
        workspaceId,
        messages: messages(10),
        historySummary: "Last good projection",
        language: "en",
      })
    ).resolves.toMatchObject({
      mode: "promote",
      summary: "Versioned committed summary",
    });
  });

  it("uses verifiable counts when legacy metadata is absent", async () => {
    tableRows = legacyRows({ metadata: {} });

    await expect(
      resolveConversationClassificationSummaryProposal({
        conversationId,
        workspaceId,
        messages: messages(5),
        historySummary: "Legacy summary",
        language: "uz",
      })
    ).resolves.toMatchObject({
      mode: "promote",
      metadata: {
        wordCount: 10,
        messageCount: 5,
        chunkCount: 2,
        generationTimeMs: 0,
      },
    });
  });

  it("regenerates when the conversation grew by at least fifty percent", async () => {
    tableRows = legacyRows({ metadata: { message_count: 60 } });

    await expect(
      resolveConversationClassificationSummaryProposal({
        conversationId,
        workspaceId,
        messages: messages(90),
        historySummary: "Legacy summary",
        language: "en",
      })
    ).resolves.toMatchObject({ mode: "replace" });
    expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
  });

  it("regenerates when the legacy main is older than seven days", async () => {
    tableRows = legacyRows({ created_at: "2026-08-01T00:00:00.000Z" });

    await expect(
      resolveConversationClassificationSummaryProposal({
        conversationId,
        workspaceId,
        messages: messages(3),
        historySummary: "Legacy summary",
        language: "en",
      })
    ).resolves.toMatchObject({ mode: "replace" });
  });

  it("maps provider and malformed generated output to a bounded generation failure", async () => {
    mockGenerateSummary
      .mockRejectedValueOnce(new Error("provider raw secret"))
      .mockResolvedValueOnce({
        summary: "x".repeat(32_001),
        chunks: [],
        provider: "vertex",
        metadata: {},
      });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        resolveConversationClassificationSummaryProposal({
          conversationId,
          workspaceId,
          messages: messages(100),
          historySummary: null,
          language: "en",
        })
      ).rejects.toMatchObject({
        code: "summary_generation_failed",
        message: "Conversation summary generation failed",
        retryable: true,
      });
    }
  });
});
