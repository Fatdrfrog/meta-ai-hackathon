jest.mock("@/lib/ai", () => ({
  getDocumentEmbeddingResultsBatch: jest.fn(),
  isEmbeddingMetadataCurrent: jest.requireActual("@/lib/ai/embeddings")
    .isEmbeddingMetadataCurrent,
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: jest.fn() },
}));

import { getDocumentEmbeddingResultsBatch } from "@/lib/ai";
import {
  buildConversationSummarySlotId,
  buildConversationSummarySourceRevisionSortKey,
} from "@/lib/airi/rag/conversation-summary/conversation-summary-versioning";
import { persistConversationSummaryRevision } from "@/lib/airi/rag/conversation-summary/conversation-summary-storage";
import { supabaseAdmin } from "@/lib/supabase/admin";

type StoredRow = Record<string, unknown> & { id: string };
type FakeError = { code?: string; message: string };

class FakeConversationSummaryTable {
  readonly rows = new Map<string, StoredRow>();
  readonly mutations: Array<{ operation: string; id: string }> = [];
  beforeInsert: ((row: StoredRow) => void | Promise<void>) | null = null;
  beforeUpdate:
    | ((payload: Record<string, unknown>) => void | Promise<void>)
    | null = null;
  afterUpdate: ((rows: StoredRow[]) => void | Promise<void>) | null = null;
  afterSelect: ((rows: StoredRow[]) => void | Promise<void>) | null = null;
  beforeDelete: (() => void | Promise<void>) | null = null;
  failNext: { operation: string; error: FakeError } | null = null;
  forceZeroUpdates = 0;
  activeDeletes = 0;
  maxActiveDeletes = 0;

  seed(row: StoredRow): void {
    this.rows.set(row.id, structuredClone(row));
  }

  from(table: string): FakeQuery {
    if (table !== "conversation_summaries") {
      throw new Error(`Unexpected table ${table}`);
    }
    return new FakeQuery(this);
  }
}

class FakeQuery
  implements PromiseLike<{ data: unknown; error: FakeError | null }>
{
  private operation: "select" | "insert" | "update" | "delete" = "select";
  private payload: StoredRow[] | Record<string, unknown> | null = null;
  private readonly filters: Array<(row: StoredRow) => boolean> = [];
  private orderColumn: string | null = null;
  private limitCount: number | null = null;

  constructor(private readonly table: FakeConversationSummaryTable) {}

  select(_columns?: string): this {
    return this;
  }

  insert(payload: StoredRow | StoredRow[]): this {
    this.operation = "insert";
    this.payload = Array.isArray(payload) ? payload : [payload];
    return this;
  }

  update(payload: Record<string, unknown>): this {
    this.operation = "update";
    this.payload = payload;
    return this;
  }

  delete(): this {
    this.operation = "delete";
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push(row => readColumn(row, column) === value);
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push(row => values.includes(readColumn(row, column)));
    return this;
  }

  gt(column: string, value: unknown): this {
    this.filters.push(row => String(readColumn(row, column)) > String(value));
    return this;
  }

  order(column: string): this {
    this.orderColumn = column;
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  async single(): Promise<{ data: unknown; error: FakeError | null }> {
    const result = await this.execute();
    if (result.error) return result;
    const rows = result.data as StoredRow[];
    if (rows.length !== 1) {
      return {
        data: null,
        error: { code: "PGRST116", message: "Expected exactly one row" },
      };
    }
    return { data: rows[0], error: null };
  }

  async maybeSingle(): Promise<{ data: unknown; error: FakeError | null }> {
    const result = await this.execute();
    if (result.error) return result;
    const rows = result.data as StoredRow[];
    if (rows.length > 1) {
      return {
        data: null,
        error: { code: "PGRST116", message: "Expected at most one row" },
      };
    }
    return { data: rows[0] ?? null, error: null };
  }

  then<TResult1 = { data: unknown; error: FakeError | null }, TResult2 = never>(
    onfulfilled?:
      | ((value: {
          data: unknown;
          error: FakeError | null;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private matchingRows(): StoredRow[] {
    let rows = [...this.table.rows.values()].filter(row =>
      this.filters.every(filter => filter(row))
    );
    if (this.orderColumn) {
      const column = this.orderColumn;
      rows = rows.sort((left, right) =>
        String(readColumn(left, column)).localeCompare(
          String(readColumn(right, column))
        )
      );
    }
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    return rows;
  }

  private async execute(): Promise<{
    data: StoredRow[] | null;
    error: FakeError | null;
  }> {
    if (this.table.failNext?.operation === this.operation) {
      const { error } = this.table.failNext;
      this.table.failNext = null;
      return { data: null, error };
    }
    if (this.operation === "select") {
      const rows = structuredClone(this.matchingRows());
      await this.table.afterSelect?.(rows);
      return { data: rows, error: null };
    }
    if (this.operation === "insert") {
      const rows = this.payload as StoredRow[];
      for (const row of rows) {
        await this.table.beforeInsert?.(structuredClone(row));
        if (this.table.rows.has(row.id)) {
          return {
            data: null,
            error: { code: "23505", message: "duplicate key" },
          };
        }
      }
      for (const row of rows) {
        const stored = {
          created_at: "2026-08-10T06:06:04.000Z",
          updated_at: "2026-08-10T06:06:04.000Z",
          ...structuredClone(row),
        };
        this.table.rows.set(row.id, stored);
        this.table.mutations.push({ operation: "insert", id: row.id });
      }
      return { data: structuredClone(rows), error: null };
    }
    if (this.operation === "update") {
      await this.table.beforeUpdate?.(
        structuredClone(this.payload as Record<string, unknown>)
      );
      if (this.table.forceZeroUpdates > 0) {
        this.table.forceZeroUpdates -= 1;
        return { data: [], error: null };
      }
      const rows = this.matchingRows();
      for (const row of rows) {
        const updated = {
          ...row,
          ...structuredClone(this.payload as Record<string, unknown>),
          updated_at: "2026-08-10T06:06:05.000Z",
        } as StoredRow;
        this.table.rows.set(row.id, updated);
        this.table.mutations.push({ operation: "update", id: row.id });
      }
      await this.table.afterUpdate?.(structuredClone(rows));
      return { data: structuredClone(rows), error: null };
    }

    this.table.activeDeletes += 1;
    this.table.maxActiveDeletes = Math.max(
      this.table.maxActiveDeletes,
      this.table.activeDeletes
    );
    try {
      await this.table.beforeDelete?.();
      const rows = this.matchingRows();
      for (const row of rows) {
        this.table.rows.delete(row.id);
        this.table.mutations.push({ operation: "delete", id: row.id });
      }
      return { data: structuredClone(rows), error: null };
    } finally {
      this.table.activeDeletes -= 1;
    }
  }
}

function readColumn(row: StoredRow, column: string): unknown {
  const jsonTextMatch = column.match(/^metadata->>(.+)$/u);
  if (jsonTextMatch) {
    const metadata = row.metadata as Record<string, unknown> | undefined;
    const value = metadata?.[jsonTextMatch[1]];
    return value === null || value === undefined ? null : String(value);
  }
  return row[column];
}

const mockEmbeddingBatch = getDocumentEmbeddingResultsBatch as jest.Mock;
const mockFrom = supabaseAdmin.from as jest.Mock;
const workspaceId = "workspace-storage-test";
const conversationId = "507f1f77bcf86cd799439012";

function vector(seed = 0.01): number[] {
  return Array.from({ length: 1536 }, (_, index) => seed + index / 1_000_000);
}

function sparseVector(): number[] {
  const result = new Array<number>(1536);
  result[0] = 0.5;
  return result;
}

function embedding(seed = 0.01) {
  return {
    embedding: vector(seed),
    provider: "vertex" as const,
    model: "gemini-embedding-001",
    dimensions: 1536,
    taskType: "RETRIEVAL_DOCUMENT" as const,
  };
}

function input(sourceRevision = 7, analysisRevisionId = `${conversationId}:7`) {
  return {
    workspaceId,
    conversationId,
    analysisRevisionId,
    sourceRevision,
    completedAt: new Date(
      `2026-08-10T06:06:${String(sourceRevision).padStart(2, "0")}.000Z`
    ),
    ragSummary: {
      mode: "replace" as const,
      language: "en" as const,
      summary: `Main revision ${sourceRevision}`,
      chunks: [
        `Chunk zero revision ${sourceRevision}`,
        `Chunk one revision ${sourceRevision}`,
      ],
      metadata: {
        wordCount: 120,
        messageCount: 12,
        chunkCount: 2,
        generationTimeMs: 42,
      },
    },
  };
}

function metadata(
  sourceRevision: number,
  chunkIndex: number | null,
  overrides: Record<string, unknown> = {}
) {
  return {
    analysis_revision_id: `${conversationId}:${sourceRevision}`,
    source_revision: sourceRevision,
    source_revision_sort_key:
      buildConversationSummarySourceRevisionSortKey(sourceRevision),
    analysis_completed_at: `2026-08-10T06:06:${String(sourceRevision).padStart(2, "0")}.000Z`,
    language: "en",
    word_count: 120,
    message_count: 12,
    chunk_count: 2,
    generation_time_ms: 42,
    embedding_provider: "vertex",
    embedding_model: "gemini-embedding-001",
    embedding_task_type: "RETRIEVAL_DOCUMENT",
    embedding_dimensions: 1536,
    ...(chunkIndex === null ? {} : { chunk_index: chunkIndex }),
    ...overrides,
  };
}

function storedRow(inputValue: {
  sourceRevision: number;
  chunkIndex: number | null;
  text?: string;
  id?: string;
  metadataOverrides?: Record<string, unknown>;
}): StoredRow {
  return {
    id:
      inputValue.id ??
      buildConversationSummarySlotId({
        workspaceId,
        conversationId,
        chunkIndex: inputValue.chunkIndex,
      }),
    workspace_id: workspaceId,
    conversation_id: conversationId,
    summary_text:
      inputValue.text ??
      (inputValue.chunkIndex === null
        ? `Main revision ${inputValue.sourceRevision}`
        : `Chunk ${inputValue.chunkIndex === 0 ? "zero" : "one"} revision ${inputValue.sourceRevision}`),
    chunk_index: inputValue.chunkIndex,
    embedding: vector(inputValue.sourceRevision / 100),
    metadata: metadata(
      inputValue.sourceRevision,
      inputValue.chunkIndex,
      inputValue.metadataOverrides
    ),
    created_at: "2026-08-10T06:06:04.000Z",
    updated_at: "2026-08-10T06:06:04.000Z",
  };
}

describe("persistConversationSummaryRevision", () => {
  let table: FakeConversationSummaryTable;

  beforeEach(() => {
    jest.clearAllMocks();
    table = new FakeConversationSummaryTable();
    mockFrom.mockImplementation((name: string) => table.from(name));
    mockEmbeddingBatch.mockResolvedValue([
      embedding(0.01),
      embedding(0.02),
      embedding(0.03),
    ]);
  });

  it("embeds every summary under the platform-sponsored classification action", async () => {
    await persistConversationSummaryRevision(input());
    expect(mockEmbeddingBatch).toHaveBeenCalledWith(
      ["Main revision 7", "Chunk zero revision 7", "Chunk one revision 7"],
      {
        workspaceId,
        actionId: `classification:${conversationId}:7`,
        sponsorship: "platform",
      }
    );
  });

  it("replays committed summary effects without another paid operation", async () => {
    await persistConversationSummaryRevision(input());
    mockEmbeddingBatch.mockClear();
    mockEmbeddingBatch.mockRejectedValue(
      new Error("Paid operation already reserved")
    );
    await expect(persistConversationSummaryRevision(input())).resolves.toEqual({
      status: "completed",
    });
    expect(mockEmbeddingBatch).not.toHaveBeenCalled();
  });

  it("reuses persisted chunks and keeps an uncertain missing result blocked", async () => {
    table.beforeInsert = row => {
      if (row.chunk_index === null) throw new Error("main write unavailable");
    };
    await expect(persistConversationSummaryRevision(input())).rejects.toThrow(
      "main write unavailable"
    );
    table.beforeInsert = null;
    mockEmbeddingBatch.mockClear();
    mockEmbeddingBatch.mockRejectedValue(
      new Error("Paid operation already reserved")
    );
    await expect(persistConversationSummaryRevision(input())).rejects.toThrow(
      "Paid operation already reserved"
    );
    expect(mockEmbeddingBatch).toHaveBeenCalledWith(["Main revision 7"], {
      workspaceId,
      actionId: `classification:${conversationId}:7`,
      sponsorship: "platform",
    });
  });

  it("reuses the already persisted classifier embedding for matching summary text", async () => {
    mockEmbeddingBatch.mockResolvedValue([embedding(0.02), embedding(0.03)]);
    await expect(
      persistConversationSummaryRevision({
        ...input(),
        existingEmbedding: { text: "Main revision 7", result: embedding(0.01) },
      })
    ).resolves.toEqual({ status: "completed" });
    expect(mockEmbeddingBatch).toHaveBeenCalledWith(
      ["Chunk zero revision 7", "Chunk one revision 7"],
      {
        workspaceId,
        actionId: `classification:${conversationId}:7`,
        sponsorship: "platform",
      }
    );
  });

  it.each(["different text", "different model"])(
    "does not reuse classifier projection with %s",
    async mismatch => {
      await persistConversationSummaryRevision({
        ...input(),
        existingEmbedding: {
          text:
            mismatch === "different text"
              ? "Another summary"
              : "Main revision 7",
          result:
            mismatch === "different model"
              ? { ...embedding(), model: "old-model" }
              : embedding(),
        },
      });
      expect(mockEmbeddingBatch).toHaveBeenCalledWith(
        ["Main revision 7", "Chunk zero revision 7", "Chunk one revision 7"],
        expect.any(Object)
      );
    }
  );

  it("embeds repeated text only once within the same summary revision", async () => {
    const request = input();
    request.ragSummary.chunks = [request.ragSummary.summary, "Unique chunk"];
    mockEmbeddingBatch.mockResolvedValue([embedding(0.01), embedding(0.02)]);
    await expect(persistConversationSummaryRevision(request)).resolves.toEqual({
      status: "completed",
    });
    expect(mockEmbeddingBatch).toHaveBeenCalledWith(
      ["Main revision 7", "Unique chunk"],
      expect.any(Object)
    );
  });

  it.each([
    ["missing result", [embedding(), embedding()]],
    ["null result", [embedding(), null, embedding()]],
    [
      "non-finite vector",
      [
        embedding(),
        { ...embedding(), embedding: [...vector().slice(0, 1535), Number.NaN] },
        embedding(),
      ],
    ],
    [
      "wrong vector width",
      [
        embedding(),
        { ...embedding(), embedding: vector().slice(0, 1535) },
        embedding(),
      ],
    ],
    [
      "sparse vector",
      [embedding(), { ...embedding(), embedding: sparseVector() }, embedding()],
    ],
    [
      "wrong task",
      [
        embedding(),
        { ...embedding(), taskType: "RETRIEVAL_QUERY" },
        embedding(),
      ],
    ],
    [
      "incoherent model",
      [embedding(), { ...embedding(), model: "other-model" }, embedding()],
    ],
  ])(
    "validates the entire embedding batch before mutation: %s",
    async (_label, results) => {
      mockEmbeddingBatch.mockResolvedValueOnce(results);

      await expect(persistConversationSummaryRevision(input())).rejects.toThrow(
        "Conversation summary embedding batch is invalid"
      );
      expect(table.mutations).toEqual([]);
    }
  );

  it("writes all chunks before the deterministic main commit pointer", async () => {
    await expect(persistConversationSummaryRevision(input())).resolves.toEqual({
      status: "completed",
    });

    const mainId = buildConversationSummarySlotId({
      workspaceId,
      conversationId,
      chunkIndex: null,
    });
    expect(table.mutations.map(item => item.id)).toEqual([
      buildConversationSummarySlotId({
        workspaceId,
        conversationId,
        chunkIndex: 0,
      }),
      buildConversationSummarySlotId({
        workspaceId,
        conversationId,
        chunkIndex: 1,
      }),
      mainId,
    ]);
    expect(table.rows.get(mainId)).toMatchObject({
      summary_text: "Main revision 7",
      chunk_index: null,
      metadata: metadata(7, null),
    });
    expect(mockEmbeddingBatch).toHaveBeenCalledWith(
      ["Main revision 7", "Chunk zero revision 7", "Chunk one revision 7"],
      {
        workspaceId,
        actionId: `classification:${conversationId}:7`,
        sponsorship: "platform",
      }
    );
  });

  it("fills a missing same-revision chunk without rewriting identical slots", async () => {
    mockEmbeddingBatch.mockResolvedValue([embedding(0.03)]);
    const main = storedRow({ sourceRevision: 7, chunkIndex: null });
    const chunk0 = storedRow({ sourceRevision: 7, chunkIndex: 0 });
    table.seed(main);
    table.seed(chunk0);

    await expect(persistConversationSummaryRevision(input())).resolves.toEqual({
      status: "completed",
    });
    expect(table.mutations).toEqual([
      {
        operation: "insert",
        id: buildConversationSummarySlotId({
          workspaceId,
          conversationId,
          chunkIndex: 1,
        }),
      },
    ]);
  });

  it("rejects an immutable same-revision payload conflict", async () => {
    table.seed(
      storedRow({
        sourceRevision: 7,
        chunkIndex: 0,
        text: "Conflicting same-revision chunk",
      })
    );

    await expect(persistConversationSummaryRevision(input())).rejects.toThrow(
      "Conversation summary immutable revision conflict"
    );
    expect(
      [...table.rows.values()].some(
        row =>
          row.chunk_index === null && row.summary_text === "Main revision 7"
      )
    ).toBe(false);
  });

  it("rejects a conflicting same-revision main before mutating any chunk", async () => {
    table.seed(
      storedRow({
        sourceRevision: 7,
        chunkIndex: null,
        text: "Conflicting same-revision main",
      })
    );
    table.seed(storedRow({ sourceRevision: 6, chunkIndex: 0 }));

    await expect(persistConversationSummaryRevision(input())).rejects.toThrow(
      "Conversation summary immutable revision conflict"
    );
    expect(table.mutations).toEqual([]);
    expect(
      table.rows.get(
        buildConversationSummarySlotId({
          workspaceId,
          conversationId,
          chunkIndex: 0,
        })
      )
    ).toMatchObject({ metadata: { source_revision: 6 } });
  });

  it("recovers a unique insert race and lets N+1 supersede N", async () => {
    let raced = false;
    table.beforeInsert = row => {
      if (!raced && row.chunk_index === 0) {
        raced = true;
        table.seed(storedRow({ sourceRevision: 8, chunkIndex: 0 }));
      }
    };

    await expect(persistConversationSummaryRevision(input())).resolves.toEqual({
      status: "superseded",
    });
    expect(
      table.rows.get(storedRow({ sourceRevision: 8, chunkIndex: 0 }).id)
    ).toMatchObject({
      metadata: { source_revision: 8 },
    });
    expect(
      table.rows.has(
        buildConversationSummarySlotId({
          workspaceId,
          conversationId,
          chunkIndex: null,
        })
      )
    ).toBe(false);
  });

  it("rereads a zero-row observed-identity update and cannot overwrite N+1", async () => {
    table.seed(storedRow({ sourceRevision: 6, chunkIndex: null }));
    table.seed(storedRow({ sourceRevision: 6, chunkIndex: 0 }));
    let raced = false;
    table.beforeUpdate = payload => {
      if (!raced && payload.chunk_index === 0) {
        raced = true;
        table.seed(storedRow({ sourceRevision: 8, chunkIndex: 0 }));
      }
    };

    await expect(persistConversationSummaryRevision(input())).resolves.toEqual({
      status: "superseded",
    });
    expect(
      table.rows.get(storedRow({ sourceRevision: 8, chunkIndex: 0 }).id)
    ).toMatchObject({
      metadata: { source_revision: 8 },
    });
  });

  it("maps N+1 after a successful observed-identity update to superseded", async () => {
    table.seed(storedRow({ sourceRevision: 6, chunkIndex: null }));
    table.seed(storedRow({ sourceRevision: 6, chunkIndex: 0 }));
    let raced = false;
    table.afterUpdate = rows => {
      if (!raced && rows.some(row => row.chunk_index === 0)) {
        raced = true;
        table.seed(storedRow({ sourceRevision: 8, chunkIndex: 0 }));
      }
    };

    await expect(persistConversationSummaryRevision(input())).resolves.toEqual({
      status: "superseded",
    });
    expect(
      table.rows.get(storedRow({ sourceRevision: 8, chunkIndex: 0 }).id)
    ).toMatchObject({
      metadata: { source_revision: 8 },
    });
  });

  it("short-circuits without touching any slot when the main pointer is newer", async () => {
    table.seed(storedRow({ sourceRevision: 8, chunkIndex: null }));

    await expect(persistConversationSummaryRevision(input())).resolves.toEqual({
      status: "superseded",
    });
    expect(table.mutations).toEqual([]);
  });

  it("rejects a malformed newer main slot instead of trusting its revision", async () => {
    table.seed({
      ...storedRow({ sourceRevision: 8, chunkIndex: null }),
      workspace_id: "wrong-workspace",
    });

    await expect(persistConversationSummaryRevision(input())).rejects.toThrow(
      "Conversation summary immutable revision conflict"
    );
    expect(table.mutations).toEqual([]);
  });

  it("rejects a malformed newer slot observed after a successful CAS", async () => {
    const request = input();
    request.ragSummary.chunks = ["Chunk zero revision 7"];
    request.ragSummary.metadata.chunkCount = 1;
    mockEmbeddingBatch.mockResolvedValueOnce([
      embedding(0.01),
      embedding(0.02),
    ]);
    table.seed(storedRow({ sourceRevision: 6, chunkIndex: null }));
    table.seed(storedRow({ sourceRevision: 6, chunkIndex: 0 }));
    table.afterUpdate = rows => {
      if (rows.some(row => row.chunk_index === 0)) {
        table.seed({
          ...storedRow({
            sourceRevision: 8,
            chunkIndex: 0,
            metadataOverrides: { chunk_count: 1 },
          }),
          conversation_id: "507f1f77bcf86cd799439099",
        });
      }
    };

    await expect(persistConversationSummaryRevision(request)).rejects.toThrow(
      "Conversation summary immutable revision conflict"
    );
    expect(
      table.rows.get(
        buildConversationSummarySlotId({
          workspaceId,
          conversationId,
          chunkIndex: null,
        })
      )
    ).toMatchObject({ metadata: { source_revision: 6 } });
  });

  it("leaves the prior main pointer intact when a chunk write fails", async () => {
    table.seed(storedRow({ sourceRevision: 6, chunkIndex: null }));
    table.seed(storedRow({ sourceRevision: 6, chunkIndex: 0 }));
    table.seed(storedRow({ sourceRevision: 6, chunkIndex: 1 }));
    let updateCalls = 0;
    table.beforeUpdate = () => {
      updateCalls += 1;
      if (updateCalls === 2) {
        table.failNext = {
          operation: "update",
          error: { message: "chunk transport failed" },
        };
      }
    };

    await expect(persistConversationSummaryRevision(input())).rejects.toThrow(
      "chunk transport failed"
    );
    expect(
      table.rows.get(
        buildConversationSummarySlotId({
          workspaceId,
          conversationId,
          chunkIndex: null,
        })
      )
    ).toMatchObject({ metadata: { source_revision: 6 } });
  });

  it("deletes only observed legacy and excess identities after main succeeds", async () => {
    const legacyId = "00000000-0000-4000-8000-000000000099";
    const excessId = buildConversationSummarySlotId({
      workspaceId,
      conversationId,
      chunkIndex: 3,
    });
    table.seed({
      ...storedRow({ sourceRevision: 6, chunkIndex: null, id: legacyId }),
      metadata: { message_count: 5 },
    });
    table.seed(
      storedRow({
        sourceRevision: 6,
        chunkIndex: 3,
        id: excessId,
        metadataOverrides: { chunk_count: 4 },
      })
    );

    await expect(persistConversationSummaryRevision(input())).resolves.toEqual({
      status: "completed",
    });
    expect(table.rows.has(legacyId)).toBe(false);
    expect(table.rows.has(excessId)).toBe(false);
  });

  it("does not delete a cleanup slot concurrently advanced to N+1", async () => {
    const excessId = buildConversationSummarySlotId({
      workspaceId,
      conversationId,
      chunkIndex: 3,
    });
    table.seed(
      storedRow({
        sourceRevision: 6,
        chunkIndex: 3,
        id: excessId,
        metadataOverrides: { chunk_count: 4 },
      })
    );
    let raced = false;
    table.beforeDelete = () => {
      if (!raced) {
        raced = true;
        table.seed(
          storedRow({
            sourceRevision: 8,
            chunkIndex: 3,
            id: excessId,
            metadataOverrides: { chunk_count: 4 },
          })
        );
      }
    };

    await expect(persistConversationSummaryRevision(input())).resolves.toEqual({
      status: "superseded",
    });
    expect(table.rows.get(excessId)).toMatchObject({
      metadata: { source_revision: 8 },
    });
  });

  it("maps a target slot advanced to N+1 during cleanup verification to superseded", async () => {
    let raced = false;
    table.afterSelect = rows => {
      if (!raced && rows.length === 3) {
        raced = true;
        table.seed(storedRow({ sourceRevision: 8, chunkIndex: 0 }));
      }
    };

    await expect(persistConversationSummaryRevision(input())).resolves.toEqual({
      status: "superseded",
    });
    expect(
      table.rows.get(storedRow({ sourceRevision: 8, chunkIndex: 0 }).id)
    ).toMatchObject({
      metadata: { source_revision: 8 },
    });
  });

  it("bounds observed-identity cleanup deletes to concurrency eight", async () => {
    for (let index = 0; index < 20; index += 1) {
      table.seed({
        ...storedRow({
          sourceRevision: 6,
          chunkIndex: null,
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        }),
        metadata: { message_count: index },
      });
    }
    table.beforeDelete = () =>
      new Promise<void>(resolve => {
        setTimeout(resolve, 2);
      });

    await expect(
      persistConversationSummaryRevision({ ...input(), ragSummary: null })
    ).resolves.toEqual({ status: "completed" });
    expect(table.maxActiveDeletes).toBeGreaterThan(1);
    expect(table.maxActiveDeletes).toBeLessThanOrEqual(8);
  });

  it("rejects 513 cleanup observations before any mutation", async () => {
    for (let index = 0; index < 513; index += 1) {
      table.seed({
        ...storedRow({
          sourceRevision: 6,
          chunkIndex: null,
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        }),
        metadata: { message_count: index },
      });
    }

    await expect(
      persistConversationSummaryRevision({ ...input(), ragSummary: null })
    ).rejects.toThrow(
      "Conversation summary cleanup observation limit exceeded"
    );
    expect(table.mutations).toEqual([]);
    expect(table.rows.size).toBe(513);
  });

  it("admits exactly 512 cleanup observations", async () => {
    for (let index = 0; index < 512; index += 1) {
      table.seed({
        ...storedRow({
          sourceRevision: 6,
          chunkIndex: null,
          id: `00000000-0000-4000-8001-${String(index).padStart(12, "0")}`,
        }),
        metadata: { message_count: index },
      });
    }

    await expect(
      persistConversationSummaryRevision({ ...input(), ragSummary: null })
    ).resolves.toEqual({ status: "completed" });
    expect(table.mutations).toHaveLength(512);
    expect(table.rows.size).toBe(0);
  });

  it("cleans a null summary without an embedding call and repeats as a no-op", async () => {
    table.seed(storedRow({ sourceRevision: 6, chunkIndex: null }));
    table.seed(storedRow({ sourceRevision: 6, chunkIndex: 0 }));
    const nullInput = { ...input(), ragSummary: null };

    await expect(
      persistConversationSummaryRevision(nullInput)
    ).resolves.toEqual({
      status: "completed",
    });
    await expect(
      persistConversationSummaryRevision(nullInput)
    ).resolves.toEqual({
      status: "completed",
    });
    expect(table.rows.size).toBe(0);
    expect(mockEmbeddingBatch).not.toHaveBeenCalled();
  });

  it("protects a newer slot during null-summary cleanup", async () => {
    table.seed(storedRow({ sourceRevision: 8, chunkIndex: null }));

    await expect(
      persistConversationSummaryRevision({ ...input(), ragSummary: null })
    ).resolves.toEqual({ status: "superseded" });
    expect(table.rows.size).toBe(1);
    expect(mockEmbeddingBatch).not.toHaveBeenCalled();
  });

  it("throws on non-unique transport errors and bounded CAS exhaustion", async () => {
    table.failNext = {
      operation: "select",
      error: { code: "503", message: "summary read unavailable" },
    };
    await expect(persistConversationSummaryRevision(input())).rejects.toThrow(
      "summary read unavailable"
    );

    table.forceZeroUpdates = 100;
    table.seed(storedRow({ sourceRevision: 6, chunkIndex: null }));
    table.seed(storedRow({ sourceRevision: 6, chunkIndex: 0 }));
    table.seed(storedRow({ sourceRevision: 6, chunkIndex: 1 }));
    await expect(persistConversationSummaryRevision(input())).rejects.toThrow(
      "Conversation summary slot CAS exhausted"
    );
  });
});
