import {
  areConversationSummaryVersionMetadataEqual,
  assertConversationSummaryStoredRowIdentity,
  buildConversationSummarySlotId,
  buildConversationSummarySourceRevisionSortKey,
  CONVERSATION_SUMMARY_MAX_CHUNKS,
  CONVERSATION_SUMMARY_SLOT_NAMESPACE,
  isDenseFiniteNumberVector,
  parseConversationSummaryVersionMetadata,
  selectCommittedConversationSummaryVersion,
} from "@/lib/airi/rag/conversation-summary/conversation-summary-versioning";

const workspaceId = "workspace-1";
const conversationId = "507f1f77bcf86cd799439011";

function versionMetadata(overrides: Record<string, unknown> = {}) {
  return {
    analysis_revision_id: `${conversationId}:7`,
    source_revision: 7,
    source_revision_sort_key: "0000000000000007",
    analysis_completed_at: "2026-08-10T06:06:03.645Z",
    language: "en",
    word_count: 120,
    message_count: 12,
    chunk_count: 2,
    generation_time_ms: 42,
    embedding_provider: "vertex",
    embedding_model: "gemini-embedding-001",
    embedding_task_type: "RETRIEVAL_DOCUMENT",
    embedding_dimensions: 1536,
    ...overrides,
  };
}

function row(input: {
  id: string;
  text: string;
  chunkIndex: number | null;
  metadata: Record<string, unknown>;
}) {
  return {
    id: input.id,
    workspace_id: workspaceId,
    conversation_id: conversationId,
    summary_text: input.text,
    chunk_index: input.chunkIndex,
    metadata: input.metadata,
    created_at: "2026-08-10T06:06:04.000Z",
    updated_at: "2026-08-10T06:06:04.000Z",
  };
}

describe("conversation summary versioning", () => {
  it("builds stable RFC UUIDv5 slot IDs with workspace and slot isolation", () => {
    expect(CONVERSATION_SUMMARY_SLOT_NAMESPACE).toBe(
      "93850bd8-947e-5b03-8df7-8cb385daf97f"
    );
    expect(
      buildConversationSummarySlotId({
        workspaceId,
        conversationId,
        chunkIndex: null,
      })
    ).toBe("cb43a49a-58ab-5c22-a2ce-a706cc78c152");
    expect(
      buildConversationSummarySlotId({
        workspaceId,
        conversationId,
        chunkIndex: 0,
      })
    ).toBe("c2d39bf1-5046-5731-89e0-ce355d08f495");
    expect(
      buildConversationSummarySlotId({
        workspaceId: "workspace-2",
        conversationId,
        chunkIndex: null,
      })
    ).toBe("6022e7e7-b797-5b55-bcd7-33ebb1f099be");
  });

  it("encodes positive safe source revisions as exact 16-digit decimal keys", () => {
    expect(CONVERSATION_SUMMARY_MAX_CHUNKS).toBe(64);
    expect(buildConversationSummarySourceRevisionSortKey(1)).toBe(
      "0000000000000001"
    );
    expect(
      buildConversationSummarySourceRevisionSortKey(Number.MAX_SAFE_INTEGER)
    ).toBe("9007199254740991");
    expect(() => buildConversationSummarySourceRevisionSortKey(0)).toThrow(
      "positive safe integer"
    );
  });

  it("owns exact metadata equality and canonical stored-row validation", () => {
    const main = row({
      id: buildConversationSummarySlotId({
        workspaceId,
        conversationId,
        chunkIndex: null,
      }),
      text: "Committed main",
      chunkIndex: null,
      metadata: versionMetadata(),
    });
    const parsedMain = parseConversationSummaryVersionMetadata(main.metadata, {
      chunkIndex: null,
    });
    const parsedChunk = parseConversationSummaryVersionMetadata(
      versionMetadata({ chunk_index: 0 }),
      { chunkIndex: 0 }
    );
    expect(parsedMain).not.toBeNull();
    expect(parsedChunk).not.toBeNull();
    expect(
      areConversationSummaryVersionMetadataEqual(parsedMain!, parsedChunk!, {
        includeChunkIndex: false,
      })
    ).toBe(true);
    expect(
      areConversationSummaryVersionMetadataEqual(parsedMain!, parsedChunk!, {
        includeChunkIndex: true,
      })
    ).toBe(false);
    expect(() =>
      assertConversationSummaryStoredRowIdentity(main, {
        workspaceId,
        conversationId,
        chunkIndex: null,
      })
    ).not.toThrow();
    expect(() =>
      assertConversationSummaryStoredRowIdentity(
        { ...main, summary_text: " \t " },
        { workspaceId, conversationId, chunkIndex: null }
      )
    ).toThrow("Conversation summary deterministic slot is invalid");
  });

  it("rejects sparse and non-number vectors despite an exact array length", () => {
    const sparse = new Array<number>(1536);
    sparse[0] = 1;
    expect(isDenseFiniteNumberVector(sparse, 1536)).toBe(false);
    expect(
      isDenseFiniteNumberVector(
        Array.from({ length: 1536 }, () => 0.5),
        1536
      )
    ).toBe(true);
    expect(
      isDenseFiniteNumberVector(
        [...Array.from({ length: 1535 }, () => 0.5), Number.POSITIVE_INFINITY],
        1536
      )
    ).toBe(false);
  });

  it.each([
    ["blank analysis ID", { analysis_revision_id: " " }],
    ["unsafe source revision", { source_revision: Number.MAX_VALUE }],
    ["mismatched sort key", { source_revision_sort_key: "0000000000000008" }],
    ["non-canonical timestamp", { analysis_completed_at: "2026-08-10" }],
    ["incomplete embedding metadata", { embedding_model: "" }],
    ["wrong embedding task", { embedding_task_type: "RETRIEVAL_QUERY" }],
    ["wrong embedding dimensions", { embedding_dimensions: 768 }],
    ["unexpected metadata", { extra: true }],
  ])("rejects malformed version metadata: %s", (_label, override) => {
    expect(() =>
      parseConversationSummaryVersionMetadata(versionMetadata(override), {
        chunkIndex: null,
      })
    ).toThrow("Conversation summary version metadata is invalid");
  });

  it("rejects chunk metadata whose index or count does not match its slot", () => {
    expect(() =>
      parseConversationSummaryVersionMetadata(
        versionMetadata({ chunk_index: 1 }),
        { chunkIndex: 0 }
      )
    ).toThrow("Conversation summary version metadata is invalid");
    expect(() =>
      parseConversationSummaryVersionMetadata(
        versionMetadata({ chunk_count: 1, chunk_index: 1 }),
        { chunkIndex: 1 }
      )
    ).toThrow("Conversation summary version metadata is invalid");
  });

  it("selects the deterministic main and only contiguous same-revision slots", () => {
    const mainId = buildConversationSummarySlotId({
      workspaceId,
      conversationId,
      chunkIndex: null,
    });
    const chunk0Id = buildConversationSummarySlotId({
      workspaceId,
      conversationId,
      chunkIndex: 0,
    });
    const chunk1Id = buildConversationSummarySlotId({
      workspaceId,
      conversationId,
      chunkIndex: 1,
    });
    const selected = selectCommittedConversationSummaryVersion({
      workspaceId,
      conversationId,
      rows: [
        row({
          id: chunk1Id,
          text: "Chunk one",
          chunkIndex: 1,
          metadata: versionMetadata({ chunk_index: 1 }),
        }),
        row({
          id: mainId,
          text: "Committed main",
          chunkIndex: null,
          metadata: versionMetadata(),
        }),
        row({
          id: chunk0Id,
          text: "Chunk zero",
          chunkIndex: 0,
          metadata: versionMetadata({ chunk_index: 0 }),
        }),
      ],
    });

    expect(selected).toMatchObject({
      main: { id: mainId, summary_text: "Committed main" },
      chunks: [
        { id: chunk0Id, summary_text: "Chunk zero" },
        { id: chunk1Id, summary_text: "Chunk one" },
      ],
      metadata: {
        analysisRevisionId: `${conversationId}:7`,
        sourceRevision: 7,
      },
    });
  });

  it("fails closed for missing or cross-revision deterministic chunks", () => {
    const mainId = buildConversationSummarySlotId({
      workspaceId,
      conversationId,
      chunkIndex: null,
    });
    const chunk0Id = buildConversationSummarySlotId({
      workspaceId,
      conversationId,
      chunkIndex: 0,
    });
    const main = row({
      id: mainId,
      text: "Committed main",
      chunkIndex: null,
      metadata: versionMetadata(),
    });

    expect(() =>
      selectCommittedConversationSummaryVersion({
        workspaceId,
        conversationId,
        rows: [main],
      })
    ).toThrow("Conversation summary committed chunks are invalid");
    expect(() =>
      selectCommittedConversationSummaryVersion({
        workspaceId,
        conversationId,
        rows: [
          main,
          row({
            id: chunk0Id,
            text: "Wrong revision chunk",
            chunkIndex: 0,
            metadata: versionMetadata({
              analysis_revision_id: `${conversationId}:8`,
              source_revision: 8,
              source_revision_sort_key: "0000000000000008",
              chunk_index: 0,
            }),
          }),
        ],
      })
    ).toThrow("Conversation summary committed chunks are invalid");
  });

  it("gives a deterministic versioned main precedence over five legacy mains", () => {
    const mainId = buildConversationSummarySlotId({
      workspaceId,
      conversationId,
      chunkIndex: null,
    });
    const legacyRows = Array.from({ length: 5 }, (_, index) =>
      row({
        id: `00000000-0000-4000-8000-00000000000${index}`,
        text: `Legacy main ${index}`,
        chunkIndex: null,
        metadata: { message_count: 10 },
      })
    );

    const selected = selectCommittedConversationSummaryVersion({
      workspaceId,
      conversationId,
      rows: [
        ...legacyRows,
        row({
          id: mainId,
          text: "Versioned main",
          chunkIndex: null,
          metadata: versionMetadata({ chunk_count: 0 }),
        }),
      ],
    });

    expect(selected?.main.summary_text).toBe("Versioned main");
    expect(selected?.chunks).toEqual([]);
  });
});
