const mockConnectDB = jest.fn();
const mockEnsureAnswerSnippetIndexes = jest.fn();
const mockAnswerSnippetFind = jest.fn();
const mockStartKnowledgeSyncRun = jest.fn(
  async (_input: unknown) => "sync-run-1"
);

jest.mock("@/lib/ai", () => ({
  getDocumentEmbeddingResultsBatch: jest.fn(),
  getCurrentEmbeddingMetadata: jest.fn(),
  buildEmbeddingMetadata: jest.fn(),
  isEmbeddingMetadataCurrent: jest.fn(),
}));

jest.mock(
  "@/lib/airi/rag/knowledge/canonical-sync/knowledge-canonical-repository",
  () => ({
    deleteChunksForDocument: jest.fn(),
    finishKnowledgeSyncRun: jest.fn(),
    insertKnowledgeChunks: jest.fn(),
    startKnowledgeSyncRun: (input: unknown) => mockStartKnowledgeSyncRun(input),
    upsertKnowledgeDocument: jest.fn(),
    getKnowledgeDocumentSnapshot: jest.fn(),
    getKnowledgeDocumentsForReconciliation: jest.fn(),
    replaceKnowledgeDocumentChunks: jest.fn(),
    reconcileKnowledgeDocuments: jest.fn(),
  })
);

jest.mock("@/lib/airi/shared/logger", () => ({
  ragLogger: {
    general: {
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    },
  },
}));

jest.mock("@/lib/kb/article-url", () => ({
  fetchArticleURLData: jest.fn(),
  generateArticleURL: jest.fn(),
}));

jest.mock(
  "@/lib/mongoose",
  () =>
    (...args: unknown[]) =>
      mockConnectDB(...args)
);

jest.mock("@/models/answer-snippet", () => ({
  __esModule: true,
  default: {
    find: (...args: unknown[]) => mockAnswerSnippetFind(...args),
  },
  ensureAnswerSnippetIndexes: (...args: unknown[]) =>
    mockEnsureAnswerSnippetIndexes(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

import {
  retireKbArticleCanonicalKnowledge,
  runKnowledgeCanonicalSync,
} from "./knowledge-canonical-sync-runner";

const { supabaseAdmin } = jest.requireMock("@/lib/supabase/admin") as {
  supabaseAdmin: { from: jest.Mock };
};

describe("runKnowledgeCanonicalSync", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    supabaseAdmin.from.mockReset();
    mockConnectDB.mockResolvedValue(undefined);
    mockEnsureAnswerSnippetIndexes.mockResolvedValue(undefined);
    mockAnswerSnippetFind.mockReturnValue({
      select: jest.fn(() => ({
        lean: jest.fn(async () => []),
      })),
    });
  });

  function configureEmptyCanonicalSources() {
    supabaseAdmin.from.mockImplementation((table: string) => {
      if (table === "kb_articles") {
        const builder = {
          select: jest.fn(),
          eq: jest.fn(),
        };
        builder.select.mockReturnValue(builder);
        builder.eq
          .mockReturnValueOnce(builder)
          .mockResolvedValueOnce({ data: [], error: null });
        return builder;
      }

      if (table === "workspaces") {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              single: jest.fn(async () => ({
                data: { company_id: "company-1" },
                error: null,
              })),
            })),
          })),
        };
      }

      if (table === "kb_indexed_urls") {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              neq: jest.fn(async () => ({ data: [], error: null })),
            })),
          })),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });
  }

  it("defaults to exactly the three supported product source kinds", async () => {
    configureEmptyCanonicalSources();

    const result = await runKnowledgeCanonicalSync({
      workspaceId: "workspace-1",
      dryRun: true,
    });

    expect(Object.keys(result.bySource)).toEqual([
      "kb_article",
      "indexed_url",
      "curated_snippet",
    ]);
    expect(
      mockStartKnowledgeSyncRun.mock.calls.map(
        ([input]) => (input as { sourceKind: string }).sourceKind
      )
    ).toEqual(["kb_article", "indexed_url", "curated_snippet"]);
    expect(supabaseAdmin.from).not.toHaveBeenCalledWith(
      "conversation_summaries"
    );
  });

  it("keeps explicit empty and all-unsupported lists as successful empty runs", async () => {
    configureEmptyCanonicalSources();

    for (const sourceKinds of [
      [],
      ["conversation_summary"],
      ["conversation_summary", "future_source"],
    ]) {
      mockStartKnowledgeSyncRun.mockClear();

      const result = await runKnowledgeCanonicalSync({
        workspaceId: "workspace-1",
        sourceKinds: sourceKinds as never,
        dryRun: true,
      });

      expect(result).toEqual({
        workspaceId: "workspace-1",
        bySource: {},
        syncRunIds: [],
      });
      expect(mockStartKnowledgeSyncRun).not.toHaveBeenCalled();
    }
  });

  it("filters retired and unknown runtime kinds without broadening a mixed request", async () => {
    configureEmptyCanonicalSources();

    const result = await runKnowledgeCanonicalSync({
      workspaceId: "workspace-1",
      sourceKinds: [
        "conversation_summary",
        "kb_article",
        "future_source",
        "kb_article",
      ] as never,
      dryRun: true,
    });

    expect(Object.keys(result.bySource)).toEqual(["kb_article"]);
    expect(mockStartKnowledgeSyncRun).toHaveBeenCalledTimes(1);
    expect(mockStartKnowledgeSyncRun).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKind: "kb_article" })
    );
  });

  it("syncs indexed URLs from content_text without selecting the removed content column", async () => {
    let indexedUrlSelectColumns = "";

    supabaseAdmin.from.mockImplementation((table: string) => {
      if (table === "workspaces") {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              single: jest.fn(async () => ({
                data: { company_id: "company-1" },
                error: null,
              })),
            })),
          })),
        };
      }

      if (table === "kb_indexed_urls") {
        return {
          select: jest.fn((columns: string) => {
            indexedUrlSelectColumns = columns;
            return {
              eq: jest.fn(() => ({
                neq: jest.fn(async () => {
                  const selectedColumns = columns
                    .split(",")
                    .map(column => column.trim());

                  if (selectedColumns.includes("content")) {
                    return {
                      data: null,
                      error: {
                        message:
                          "column kb_indexed_urls.content does not exist",
                      },
                    };
                  }

                  return {
                    data: [
                      {
                        id: "indexed-url-1",
                        title: "Pricing",
                        url: "https://example.com/pricing",
                        content_text:
                          "Pricing plans include a starter plan and a growth plan for customer support automation.",
                        index_status: "indexed",
                      },
                    ],
                    error: null,
                  };
                }),
              })),
            };
          }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });

    const result = await runKnowledgeCanonicalSync({
      workspaceId: "workspace-1",
      sourceKinds: ["indexed_url"],
      dryRun: true,
    });

    expect(
      indexedUrlSelectColumns.split(",").map(column => column.trim())
    ).toEqual([
      "id",
      "title",
      "url",
      "content_text",
      "index_status",
      "updated_at",
    ]);
    expect(result.bySource.indexed_url).toMatchObject({
      documentsTouched: 1,
      status: "completed",
    });
  });
});
describe("canonical embedding reuse and safe replacement", () => {
  const ai = jest.requireMock("@/lib/ai") as {
    getDocumentEmbeddingResultsBatch: jest.Mock;
    getCurrentEmbeddingMetadata: jest.Mock;
    buildEmbeddingMetadata: jest.Mock;
    isEmbeddingMetadataCurrent: jest.Mock;
  };
  const repository = jest.requireMock("./knowledge-canonical-repository") as {
    getKnowledgeDocumentSnapshot: jest.Mock;
    getKnowledgeDocumentsForReconciliation: jest.Mock;
    replaceKnowledgeDocumentChunks: jest.Mock;
    reconcileKnowledgeDocuments: jest.Mock;
    deleteChunksForDocument: jest.Mock;
    upsertKnowledgeDocument: jest.Mock;
  };
  let currentModel = "gemini-embedding-001";
  const embedding = () => ({
    embedding: Array(1536).fill(0.01),
    provider: "vertex",
    model: currentModel,
    dimensions: 1536,
    taskType: "RETRIEVAL_DOCUMENT",
  });
  let snippet = {
    _id: "snippet-1",
    question: "Refund policy?",
    answer:
      "Refunds are available within thirty days after the confirmed payment.",
    language: "en",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    currentModel = "gemini-embedding-001";
    snippet = {
      _id: "snippet-1",
      question: "Refund policy?",
      answer:
        "Refunds are available within thirty days after the confirmed payment.",
      language: "en",
    };
    mockConnectDB.mockResolvedValue(undefined);
    mockEnsureAnswerSnippetIndexes.mockResolvedValue(undefined);
    mockAnswerSnippetFind.mockImplementation(() => ({
      select: () => ({ lean: async () => [snippet] }),
    }));
    repository.getKnowledgeDocumentSnapshot.mockResolvedValue(null);
    repository.getKnowledgeDocumentsForReconciliation.mockResolvedValue([]);
    repository.upsertKnowledgeDocument.mockResolvedValue({ id: "document-1" });
    repository.reconcileKnowledgeDocuments.mockResolvedValue(0);
    repository.replaceKnowledgeDocumentChunks.mockResolvedValue({
      chunksUpserted: 1,
      chunksDeleted: 1,
    });
    ai.getCurrentEmbeddingMetadata.mockImplementation(() => ({
      embeddingProvider: "vertex",
      embeddingModel: currentModel,
      embeddingDimensions: 1536,
      embeddingTaskType: "RETRIEVAL_DOCUMENT",
    }));
    ai.buildEmbeddingMetadata.mockImplementation(
      (result: ReturnType<typeof embedding>) => ({
        embeddingProvider: result.provider,
        embeddingModel: result.model,
        embeddingDimensions: result.dimensions,
        embeddingTaskType: result.taskType,
      })
    );
    ai.isEmbeddingMetadataCurrent.mockImplementation(
      (metadata: { embeddingModel?: string }) =>
        metadata?.embeddingModel === currentModel
    );
    ai.getDocumentEmbeddingResultsBatch.mockImplementation(
      async (texts: string[]) => texts.map(embedding)
    );
  });

  async function sync() {
    return runKnowledgeCanonicalSync({
      workspaceId: "workspace-1",
      sourceKinds: ["curated_snippet"],
    });
  }

  async function captureGoodSnapshot() {
    await sync();
    const replacement = repository.replaceKnowledgeDocumentChunks.mock
      .calls[0]?.[0] ?? {
      document: { metadata: {} },
      chunks: [],
    };
    repository.getKnowledgeDocumentSnapshot.mockResolvedValue({
      id: "document-1",
      updatedAt: "2026-10-01T00:00:00Z",
      metadata: replacement.document.metadata,
      chunks: replacement.chunks,
    });
    repository.getKnowledgeDocumentsForReconciliation.mockResolvedValue([
      {
        id: "document-1",
        sourceRecordId: "snippet-1",
        updatedAt: "2026-10-01T00:00:00Z",
      },
    ]);
    jest.clearAllMocks();
  }

  it("skips unchanged complete chunks without embedding or rewriting them", async () => {
    await captureGoodSnapshot();
    const result = await sync();
    expect(result.bySource.curated_snippet).toMatchObject({
      status: "completed",
      chunksUpserted: 0,
      chunksDeleted: 0,
    });
    expect(ai.getDocumentEmbeddingResultsBatch).not.toHaveBeenCalled();
    expect(repository.replaceKnowledgeDocumentChunks).not.toHaveBeenCalled();
  });

  it("invalidates embeddings when the model changes", async () => {
    await captureGoodSnapshot();
    currentModel = "new-embedding-model";
    await sync();
    expect(ai.getDocumentEmbeddingResultsBatch).toHaveBeenCalledTimes(1);
    expect(repository.replaceKnowledgeDocumentChunks).toHaveBeenCalledTimes(1);
  });

  it("invalidates embedding reuse when chunk configuration changes", async () => {
    await captureGoodSnapshot();
    const { RAG_CONFIG } = jest.requireActual("@/lib/airi/rag/config");
    const previous = RAG_CONFIG.chunking.targetChunkChars;
    try {
      RAG_CONFIG.chunking.targetChunkChars = previous - 1;
      await sync();
      expect(ai.getDocumentEmbeddingResultsBatch).toHaveBeenCalledTimes(1);
    } finally {
      RAG_CONFIG.chunking.targetChunkChars = previous;
    }
  });

  it("updates changed source text instead of reusing its previous embedding", async () => {
    await captureGoodSnapshot();
    snippet.answer =
      "Refunds are now available within fourteen days after payment.";
    await sync();
    expect(ai.getDocumentEmbeddingResultsBatch).toHaveBeenCalledWith([
      expect.stringContaining("fourteen days"),
    ], expect.objectContaining({ workspaceId: "workspace-1", actionId: expect.stringMatching(/^knowledge:curated_snippet:snippet-1:/) }));
  });

  it("preserves old good chunks and reports failure when an embedding is unavailable", async () => {
    ai.getDocumentEmbeddingResultsBatch.mockResolvedValue([null]);
    const result = await sync();
    expect(result.bySource.curated_snippet.status).toBe("failed");
    expect(repository.deleteChunksForDocument).not.toHaveBeenCalled();
    expect(repository.upsertKnowledgeDocument).not.toHaveBeenCalled();
    expect(repository.replaceKnowledgeDocumentChunks).not.toHaveBeenCalled();
  });

  it("passes the observed document version to the atomic replacement boundary", async () => {
    repository.getKnowledgeDocumentSnapshot.mockResolvedValue({
      id: "document-1",
      updatedAt: "2026-10-01T00:00:00Z",
      metadata: {},
      chunks: [],
    });
    repository.getKnowledgeDocumentsForReconciliation.mockResolvedValue([
      {
        id: "document-1",
        sourceRecordId: "snippet-1",
        updatedAt: "2026-10-01T00:00:00Z",
      },
    ]);
    await sync();
    expect(repository.replaceKnowledgeDocumentChunks).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedUpdatedAt: "2026-10-01T00:00:00Z",
        document: expect.objectContaining({
          workspaceId: "workspace-1",
          sourceKind: "curated_snippet",
          sourceRecordId: "snippet-1",
        }),
      })
    );
  });

  it("propagates replacement failure without running a separate destructive delete", async () => {
    repository.replaceKnowledgeDocumentChunks.mockRejectedValueOnce(
      new Error("atomic replacement failed")
    );
    const result = await sync();
    expect(result.bySource.curated_snippet.status).toBe("failed");
    expect(repository.deleteChunksForDocument).not.toHaveBeenCalled();
  });

  it("reconciles deleted sources only inside the explicitly requested scope", async () => {
    mockAnswerSnippetFind.mockImplementation(() => ({
      select: () => ({ lean: async () => [] }),
    }));
    await runKnowledgeCanonicalSync({
      workspaceId: "workspace-1",
      sourceKinds: ["curated_snippet"],
      sourceRecordIds: ["snippet-deleted"],
    });
    expect(mockAnswerSnippetFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      _id: { $in: ["snippet-deleted"] },
    });
    expect(repository.reconcileKnowledgeDocuments).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceKind: "curated_snippet",
      sourceRecordIds: ["snippet-deleted"],
      activeSourceRecordIds: [],
      observedDocuments: [],
    });
  });

  it("captures canonical IDs and versions before reading Mongo and forwards only that snapshot", async () => {
    const events: string[] = [];
    const observed = [
      {
        id: "old-document",
        sourceRecordId: "snippet-deleted",
        updatedAt: "2026-10-01T00:00:00Z",
      },
    ];
    repository.getKnowledgeDocumentsForReconciliation.mockImplementation(
      async () => {
        events.push("canonical snapshot");
        return observed;
      }
    );
    mockAnswerSnippetFind.mockImplementation(() => {
      events.push("Mongo source read");
      return { select: () => ({ lean: async () => [] }) };
    });
    await runKnowledgeCanonicalSync({
      workspaceId: "workspace-1",
      sourceKinds: ["curated_snippet"],
      sourceRecordIds: ["snippet-deleted"],
    });
    expect(events).toEqual(["canonical snapshot", "Mongo source read"]);
    expect(
      repository.getKnowledgeDocumentsForReconciliation
    ).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceKind: "curated_snippet",
      sourceRecordIds: ["snippet-deleted"],
    });
    expect(repository.reconcileKnowledgeDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        observedDocuments: observed,
        activeSourceRecordIds: [],
      })
    );
  });

  it.each([
    {
      observed: [
        {
          id: "document-1",
          sourceRecordId: "snippet-1",
          updatedAt: "2026-10-01T00:00:00Z",
        },
      ],
    },
    { observed: [] },
  ])(
    "rejects a newer completed canonical sync after the Mongo source snapshot (initial=$observed)",
    async ({ observed }) => {
      repository.getKnowledgeDocumentsForReconciliation.mockResolvedValue(
        observed
      );
      repository.getKnowledgeDocumentSnapshot.mockResolvedValue({
        id: "document-1",
        updatedAt: "2026-10-02T00:00:00Z",
        metadata: {},
        chunks: [],
      });
      const result = await sync();
      expect(result.bySource.curated_snippet.status).toBe("failed");
      expect(ai.getDocumentEmbeddingResultsBatch).not.toHaveBeenCalled();
      expect(repository.replaceKnowledgeDocumentChunks).not.toHaveBeenCalled();
      expect(repository.reconcileKnowledgeDocuments).not.toHaveBeenCalled();
    }
  );

  it("invalidates incomplete cached vectors rather than accepting a fingerprint alone", async () => {
    await captureGoodSnapshot();
    const snapshot = await repository.getKnowledgeDocumentSnapshot();
    snapshot.chunks[0].embedding = [0.01];
    await sync();
    expect(ai.getDocumentEmbeddingResultsBatch).toHaveBeenCalledTimes(1);
  });
  describe("KB articles that leave the published set", () => {
    const articleUrl = jest.requireMock("@/lib/kb/article-url") as {
      fetchArticleURLData: jest.Mock;
    };
    const logger = jest.requireMock("@/lib/airi/shared/logger") as {
      ragLogger: { general: { warn: jest.Mock } };
    };
    let kbArticlesSelect = "";

    function configureKbArticles(rows: unknown[]) {
      supabaseAdmin.from.mockImplementation((table: string) => {
        if (table !== "kb_articles") throw new Error(`Unexpected ${table}`);
        const builder: Record<string, jest.Mock> = {};
        builder.select = jest.fn((columns: string) => {
          kbArticlesSelect = columns;
          return builder;
        });
        builder.eq = jest.fn(() => builder);
        builder.in = jest.fn(async () => ({ data: rows, error: null }));
        return builder;
      });
    }

    function kbArticle(
      id: string,
      localizations: Array<{ locale: string; status: string }>
    ) {
      return {
        id,
        title: `Article ${id}`,
        workspace_id: "workspace-1",
        updated_at: "2026-10-22T00:00:00Z",
        default_locale: "en",
        kb_article_versions: [
          { content_mdx: "Refunds take five business days.", version: 1 },
        ],
        kb_article_localizations: localizations,
      };
    }

    beforeEach(() => {
      kbArticlesSelect = "";
      articleUrl.fetchArticleURLData.mockResolvedValue(new Map());
    });

    it("deletes the canonical document of an article that is no longer published", async () => {
      // The status filter runs in the database, so the article is not returned.
      configureKbArticles([]);

      await runKnowledgeCanonicalSync({
        workspaceId: "workspace-1",
        sourceKinds: ["kb_article"],
        sourceRecordIds: ["article-unpublished"],
      });

      expect(repository.reconcileKnowledgeDocuments).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        sourceKind: "kb_article",
        sourceRecordIds: ["article-unpublished"],
        activeSourceRecordIds: [],
      });
      expect(repository.replaceKnowledgeDocumentChunks).not.toHaveBeenCalled();
    });

    it("retires an article whose default language was unpublished and keeps articles without a default localization row", async () => {
      configureKbArticles([
        kbArticle("article-default-unpublished", [
          { locale: "en", status: "draft" },
          { locale: "ru", status: "published" },
        ]),
        kbArticle("article-legacy", []),
      ]);

      const result = await runKnowledgeCanonicalSync({
        workspaceId: "workspace-1",
        sourceKinds: ["kb_article"],
        sourceRecordIds: ["article-default-unpublished", "article-legacy"],
      });

      expect(kbArticlesSelect).toContain(
        "kb_article_localizations ( locale, status )"
      );
      expect(result.bySource.kb_article).toMatchObject({
        status: "completed",
        documentsTouched: 1,
      });
      expect(repository.replaceKnowledgeDocumentChunks).toHaveBeenCalledTimes(
        1
      );
      expect(
        repository.replaceKnowledgeDocumentChunks.mock.calls[0][0].document
      ).toMatchObject({ sourceRecordId: "article-legacy" });
      expect(repository.reconcileKnowledgeDocuments).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceRecordIds: ["article-default-unpublished", "article-legacy"],
          activeSourceRecordIds: ["article-legacy"],
        })
      );
    });

    it("retires one article inline without throwing when the sync fails", async () => {
      supabaseAdmin.from.mockImplementation(() => {
        throw new Error("supabase unavailable");
      });

      await expect(
        retireKbArticleCanonicalKnowledge({
          workspaceId: "workspace-1",
          articleId: "article-1",
        })
      ).resolves.toBeUndefined();

      expect(logger.ragLogger.general.warn).toHaveBeenCalledWith(
        "knowledge_canonical_sync.kb_article_retire_failed",
        expect.objectContaining({
          workspaceId: "workspace-1",
          articleId: "article-1",
          error: "supabase unavailable",
        })
      );
      expect(repository.reconcileKnowledgeDocuments).not.toHaveBeenCalled();
    });
  });
});
