const getEmbeddingWithCache = jest.fn();
const chatCompletionWithFallback = jest.fn();
const cacheGet = jest.fn();
const cacheSet = jest.fn();
const rpcMock = jest.fn();
const fromMock = jest.fn();
const fetchArticleURLData = jest.fn();
const generateArticleURL = jest.fn();
jest.mock("@/lib/ai", () => {
  const actual = jest.requireActual<typeof import("@/lib/ai")>("@/lib/ai");
  return {
    ...actual,
    getQueryEmbeddingWithCache: (...args: unknown[]) =>
      getEmbeddingWithCache(...args),
    chatCompletionWithFallback: (...args: unknown[]) =>
      chatCompletionWithFallback(...args),
  };
});

jest.mock("@/lib/cache", () => ({
  buildCacheKey: (prefix: string, parts: string[]) =>
    `${prefix}:${parts.join(":")}`,
  cache: {
    get: (...args: unknown[]) => cacheGet(...args),
    set: (...args: unknown[]) => cacheSet(...args),
  },
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

jest.mock("@/lib/kb/article-url", () => ({
  fetchArticleURLData: (...args: unknown[]) => fetchArticleURLData(...args),
  generateArticleURL: (...args: unknown[]) => generateArticleURL(...args),
}));

jest.mock("@/lib/kb/content-utils", () => ({
  extractPlainText: (content: string) => content,
}));

jest.mock("@/lib/airi/rag/pipeline/hyde", () => {
  const actual = jest.requireActual<
    typeof import("@/lib/airi/rag/pipeline/hyde")
  >("@/lib/airi/rag/pipeline/hyde");
  return {
    ...actual,
    generateHypotheticalAnswer: jest.fn(),
  };
});

import { generateHypotheticalAnswer } from "@/lib/airi/rag/pipeline/hyde";
import { KB_RETRIEVAL_CACHE_VERSION } from "@/lib/airi/rag/kb/kb-cache";
import { retrieveRelevantKBArticles } from "@/lib/airi/rag/kb/kb-retrieval";
import type { KBRetrievalOptions } from "@/lib/airi/rag/kb/kb-types";
import { queryKnowledgeChunks } from "@/lib/airi/rag/knowledge/knowledge-chunks-retrieval";
import {
  getWorkspaceTextAiAction,
  withWorkspaceTextAiAction,
} from "@/lib/ai/workspace-ai-policy";

type FromConfig = {
  workspacesSingleData?: unknown;
  kbLimitData?: unknown[];
  kbVisibleIds?: string[];
  knowledgeDocumentsData?: unknown[];
  knowledgeChunksData?: unknown[];
};

function configureSupabaseFrom(config: FromConfig = {}) {
  fromMock.mockImplementation((table: string) => {
    if (table === "workspaces") {
      const builder: {
        select: jest.Mock;
        eq: jest.Mock;
        single: jest.Mock;
      } = {
        select: jest.fn(() => builder),
        eq: jest.fn(() => builder),
        single: jest.fn(async () => ({
          data: config.workspacesSingleData ?? { company_id: null },
          error: null,
        })),
      };
      return builder;
    }

    if (table === "kb_articles") {
      const builder: {
        select: jest.Mock;
        eq: jest.Mock;
        textSearch: jest.Mock;
        limit: jest.Mock;
        in: jest.Mock;
      } = {
        select: jest.fn(() => builder),
        eq: jest.fn(() => builder),
        textSearch: jest.fn(() => builder),
        limit: jest.fn(async () => ({
          data: config.kbLimitData ?? [],
          error: null,
        })),
        // Without kbVisibleIds, every requested article counts as published.
        in: jest.fn(async (_column: string, ids: string[]) => ({
          data: (config.kbVisibleIds ?? ids).map(id => ({ id })),
          error: null,
        })),
      };
      return builder;
    }

    if (table === "knowledge_documents") {
      const builder: {
        select: jest.Mock;
        eq: jest.Mock;
        in: jest.Mock;
        then: Promise<{ data: unknown[]; error: null }>["then"];
      } = {
        select: jest.fn(() => builder),
        eq: jest.fn(() => builder),
        in: jest.fn(() => builder),
        then: (resolve, reject) =>
          Promise.resolve({
            data: config.knowledgeDocumentsData ?? [],
            error: null,
          }).then(resolve, reject),
      };
      return builder;
    }

    if (table === "knowledge_chunks") {
      const builder: {
        select: jest.Mock;
        eq: jest.Mock;
        in: jest.Mock;
        order: jest.Mock;
        limit: jest.Mock;
      } = {
        select: jest.fn(() => builder),
        eq: jest.fn(() => builder),
        in: jest.fn(() => builder),
        order: jest.fn(() => builder),
        limit: jest.fn(async () => ({
          data: config.knowledgeChunksData ?? [],
          error: null,
        })),
      };
      return builder;
    }

    throw new Error(`Unexpected table access in test: ${table}`);
  });
}

describe("retrieveRelevantKBArticles", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    chatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        cleanedQuery: "Хочу узнать о грантах для инвалидов",
        subQueries: [],
      }),
      provider: "vertex",
      model: "test",
      latencyMs: 0,
    });
    cacheGet.mockResolvedValue(null);
    cacheSet.mockResolvedValue(undefined);
    fetchArticleURLData.mockResolvedValue(new Map());
    generateArticleURL.mockReturnValue(undefined);
    jest
      .mocked(generateHypotheticalAnswer)
      .mockImplementation(async (q: string) => ({
        applied: false,
        originalQuery: q,
        textForEmbedding: q,
      }));
    configureSupabaseFrom();
  });

  it("scopes standalone query preparation and embeddings to one action", async () => {
    const actions: ReturnType<typeof getWorkspaceTextAiAction>[] = [];
    chatCompletionWithFallback.mockImplementation(async () => {
      actions.push(getWorkspaceTextAiAction());
      return {
        content: JSON.stringify({
          cleanedQuery: "query scope",
          subQueries: [],
          searchable: true,
        }),
      };
    });
    getEmbeddingWithCache.mockImplementation(async () => {
      actions.push(getWorkspaceTextAiAction());
      return null;
    });
    await retrieveRelevantKBArticles("workspace-scope", "query scope", "en", {
      enableHyDERescue: false,
    });
    expect(actions.length).toBeGreaterThanOrEqual(2);
    expect(actions[0]).toEqual({
      workspaceId: "workspace-scope",
      actionId: expect.stringMatching(/^kb-retrieval:/),
    });
    expect(
      actions.every(action => action?.actionId === actions[0]?.actionId)
    ).toBe(true);
  });

  it("keeps the originating semantic action for nested retrieval", async () => {
    const action = {
      workspaceId: "workspace-scope",
      actionId: "auto-reply:message-42",
    };
    let embeddingAction: ReturnType<typeof getWorkspaceTextAiAction>;
    getEmbeddingWithCache.mockImplementation(async () => {
      embeddingAction = getWorkspaceTextAiAction();
      return null;
    });
    await withWorkspaceTextAiAction(action, () =>
      retrieveRelevantKBArticles("workspace-scope", "ambient query", "en", {
        enableHyDERescue: false,
      })
    );
    expect(embeddingAction).toEqual(action);
  });

  it("uses a bounded HyDE rescue when primary KB retrieval misses", async () => {
    getEmbeddingWithCache.mockImplementation(async (text: string) => {
      if (text === "Хочу узнать о грантах для инвалидов") {
        return [0.1, 0.2, 0.3];
      }
      if (text.includes("Получи ремесло")) {
        return [0.9, 0.8, 0.7];
      }
      return null;
    });

    (generateHypotheticalAnswer as jest.Mock).mockResolvedValue({
      applied: true,
      originalQuery: "Хочу узнать о грантах для инвалидов",
      hypotheticalAnswer:
        "Для людей с инвалидностью доступны специальные программы и поддержка, включая Получи ремесло.",
      textForEmbedding:
        "Хочу узнать о грантах для инвалидов\n\nДля людей с инвалидностью доступны специальные программы и поддержка, включая Получи ремесло.",
    });

    configureSupabaseFrom({
      kbLimitData: [],
      kbVisibleIds: ["kb-1"],
    });

    rpcMock.mockImplementation(
      async (fn: string, payload: Record<string, unknown>) => {
        if (fn === "match_knowledge_chunks") {
          expect(payload.query_text).toBeTruthy();
          const emb = payload.query_embedding as number[];
          if (emb[0] === 0.9) {
            return {
              data: [
                {
                  chunk_id: "chunk-kb-1",
                  document_id: "doc-kb-1",
                  chunk_index: 0,
                  content:
                    "Программа доступна для людей с инвалидностью и помогает освоить ремесло.",
                  locale: "ru",
                  source_kind: "kb_article",
                  source_record_id: "kb-1",
                  title: "Получи ремесло",
                  canonical_url: null,
                  authority_score: 0.82,
                  freshness_at: null,
                  distance: 0.08,
                  fused_score: 0.42,
                },
              ],
              error: null,
            };
          }
          return { data: [], error: null };
        }

        if (fn === "match_indexed_urls") {
          return { data: [], error: null };
        }

        throw new Error(`Unexpected RPC in test: ${fn}`);
      }
    );

    const results = await retrieveRelevantKBArticles(
      "workspace-1",
      "Хочу узнать о грантах для инвалидов",
      "ru",
      {
        queryEmbedding: [0.1, 0.2, 0.3],
      }
    );

    expect(generateHypotheticalAnswer).toHaveBeenCalledWith(
      "Хочу узнать о грантах для инвалидов",
      expect.objectContaining({ language: "ru" })
    );
    expect(results).toEqual([
      expect.objectContaining({
        id: "chunk-kb-1",
        sourceRecordId: "kb-1",
        title: "Получи ремесло",
        similarity: 0.92,
        retrievalMethod: "knowledge_chunk",
      }),
    ]);

    const chunkCalls = rpcMock.mock.calls.filter(
      call => call[0] === "match_knowledge_chunks"
    );
    expect(chunkCalls.length).toBeGreaterThanOrEqual(2);
    expect(
      chunkCalls.some(
        c => (c[1] as { query_embedding: number[] }).query_embedding[0] === 0.9
      )
    ).toBe(true);
    const firstChunkPayload = chunkCalls[0][1] as {
      match_allowed_visibilities?: string[];
    };
    expect(firstChunkPayload.match_allowed_visibilities).toEqual(
      expect.arrayContaining(["workspace", "public"])
    );
    expect(
      (chunkCalls[0][1] as { match_source_kinds?: string[] }).match_source_kinds
    ).toEqual(["kb_article", "indexed_url", "curated_snippet"]);
    expect(
      rpcMock.mock.calls.filter(call => call[0] === "search_kb_articles")
    ).toHaveLength(0);
  });

  it("does not run HyDE rescue when primary KB retrieval already succeeds", async () => {
    getEmbeddingWithCache.mockResolvedValue([0.1, 0.2, 0.3]);
    configureSupabaseFrom({
      kbVisibleIds: ["kb-1"],
    });

    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === "match_knowledge_chunks") {
        return {
          data: [
            {
              chunk_id: "chunk-kb-1",
              document_id: "doc-1",
              chunk_index: 0,
              content: "Программа для людей с инвалидностью.",
              locale: "ru",
              source_kind: "kb_article",
              source_record_id: "kb-1",
              title: "Получи ремесло",
              canonical_url: null,
              authority_score: 0.82,
              freshness_at: null,
              distance: 0.1,
              fused_score: 0.35,
            },
          ],
          error: null,
        };
      }

      if (fn === "match_indexed_urls") {
        return { data: [], error: null };
      }

      throw new Error(`Unexpected RPC in test: ${fn}`);
    });

    const results = await retrieveRelevantKBArticles(
      "workspace-1",
      "Для людей с инвалидностью есть программы?",
      "ru"
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("chunk-kb-1");
    expect(generateHypotheticalAnswer).not.toHaveBeenCalled();
  });

  it("retries KB vector retrieval across all locales before lexical fallback", async () => {
    getEmbeddingWithCache.mockResolvedValue([0.1, 0.2, 0.3]);
    configureSupabaseFrom({
      kbVisibleIds: ["kb-2"],
    });

    rpcMock.mockImplementation(
      async (fn: string, payload: Record<string, unknown>) => {
        if (fn === "match_knowledge_chunks") {
          if (payload.match_locale === "ru") {
            return { data: [], error: null };
          }
          return {
            data: [
              {
                chunk_id: "chunk-kb-2",
                document_id: "doc-2",
                chunk_index: 0,
                content:
                  "Грантовые программы фонда помогают абитуриентам и студентам.",
                locale: "ru",
                source_kind: "kb_article",
                source_record_id: "kb-2",
                title: "Фонд Ержана Татишева",
                canonical_url: null,
                authority_score: 0.82,
                freshness_at: null,
                distance: 0.19,
                fused_score: 0.38,
              },
            ],
            error: null,
          };
        }

        if (fn === "match_indexed_urls") {
          return { data: [], error: null };
        }

        throw new Error(`Unexpected RPC in test: ${fn}`);
      }
    );

    const results = await retrieveRelevantKBArticles(
      "workspace-1",
      "Какие есть гранты? Для людей с инвалидностью",
      "ru"
    );

    expect(results).toEqual([
      expect.objectContaining({
        id: "chunk-kb-2",
        sourceRecordId: "kb-2",
        title: "Фонд Ержана Татишева",
        similarity: 0.81,
        retrievalMethod: "knowledge_chunk",
      }),
    ]);
    expect(generateHypotheticalAnswer).not.toHaveBeenCalled();

    const chunkCalls = rpcMock.mock.calls.filter(
      call => call[0] === "match_knowledge_chunks"
    );
    expect(chunkCalls).toHaveLength(2);
    expect(chunkCalls[0]?.[1]).toEqual(
      expect.objectContaining({
        match_locale: "ru",
      })
    );
    expect(chunkCalls[1]?.[1]).toEqual(
      expect.objectContaining({
        match_locale: null,
      })
    );
  });

  it("skips HyDE when hydeRecommended is false even if rescue is enabled", async () => {
    getEmbeddingWithCache.mockResolvedValue([0.1, 0.2, 0.3]);
    configureSupabaseFrom();

    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === "match_knowledge_chunks") {
        return { data: [], error: null };
      }
      if (fn === "match_indexed_urls") {
        return { data: [], error: null };
      }
      if (fn === "search_kb_articles") {
        return { data: [], error: null };
      }
      throw new Error(`Unexpected RPC in test: ${fn}`);
    });

    await retrieveRelevantKBArticles(
      "workspace-1",
      "Хочу узнать о грантах для инвалидов",
      "ru",
      {
        enableHyDERescue: true,
        hydeRecommended: false,
      }
    );

    expect(generateHypotheticalAnswer).not.toHaveBeenCalled();
  });

  it("respects the KB HyDE rescue flag", async () => {
    getEmbeddingWithCache.mockResolvedValue([0.1, 0.2, 0.3]);
    configureSupabaseFrom();

    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === "match_knowledge_chunks") {
        return { data: [], error: null };
      }
      if (fn === "match_indexed_urls") {
        return { data: [], error: null };
      }
      if (fn === "search_kb_articles") {
        return { data: [], error: null };
      }
      throw new Error(`Unexpected RPC in test: ${fn}`);
    });

    const results = await retrieveRelevantKBArticles(
      "workspace-1",
      "Хочу узнать о грантах для инвалидов",
      "ru",
      {
        enableHyDERescue: false,
      }
    );

    expect(results).toEqual([]);
    expect(generateHypotheticalAnswer).not.toHaveBeenCalled();
  });

  it("orders canonical chunks by fused_score ahead of raw RPC row order", async () => {
    getEmbeddingWithCache.mockResolvedValue([0.1, 0.2, 0.3]);
    configureSupabaseFrom({ kbVisibleIds: ["kb-a", "kb-b"] });

    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === "match_knowledge_chunks") {
        return {
          data: [
            {
              chunk_id: "chunk-worse",
              document_id: "doc-a",
              chunk_index: 0,
              content: "Later chunk",
              locale: "en",
              source_kind: "kb_article",
              source_record_id: "kb-a",
              title: "A",
              canonical_url: null,
              authority_score: 0.99,
              freshness_at: null,
              distance: 0.05,
              fused_score: 0.02,
            },
            {
              chunk_id: "chunk-better",
              document_id: "doc-b",
              chunk_index: 0,
              content: "First chunk",
              locale: "en",
              source_kind: "kb_article",
              source_record_id: "kb-b",
              title: "B",
              canonical_url: null,
              authority_score: 0.5,
              freshness_at: null,
              distance: 0.1,
              fused_score: 0.06,
            },
          ],
          error: null,
        };
      }
      if (fn === "match_indexed_urls") {
        return { data: [], error: null };
      }
      if (fn === "search_kb_articles") {
        return { data: [], error: null };
      }
      throw new Error(`Unexpected RPC in test: ${fn}`);
    });

    const results = await retrieveRelevantKBArticles(
      "workspace-1",
      "What is the refund policy for SKU-123?",
      "en",
      { queryEmbedding: [0.1, 0.2, 0.3] }
    );

    expect(results.map(r => r.id)).toEqual(["chunk-better", "chunk-worse"]);
    expect(results[0]?.chunkFusedScore).toBe(0.06);
    expect(results[0]?.similarity).toBeCloseTo(0.9, 5);
  });

  it("expands tight canonical windows with sibling chunks from the top matched document", async () => {
    getEmbeddingWithCache.mockResolvedValue([0.1, 0.2, 0.3]);
    configureSupabaseFrom({
      knowledgeDocumentsData: [
        {
          id: "doc-bestirek",
          source_kind: "kb_article",
          source_record_id: "kb-bestirek",
          title: "БесТірек",
          canonical_url: null,
          locale: "ru",
          authority_score: 0.9,
          freshness_at: null,
        },
      ],
      knowledgeChunksData: [
        {
          id: "chunk-bestirek-overview",
          document_id: "doc-bestirek",
          chunk_index: 0,
          content: "БесТірек поддерживает бизнес-проекты.",
          locale: "ru",
          authority_score: 0.9,
          document_title: "БесТірек",
        },
        {
          id: "chunk-bestirek-requirements",
          document_id: "doc-bestirek",
          chunk_index: 2,
          content:
            "Для участия в БесТірек нужно подготовить заявку, бизнес-план и документы участника.",
          locale: "ru",
          authority_score: 0.9,
          document_title: "БесТірек",
        },
      ],
    });

    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === "match_knowledge_chunks") {
        return {
          data: [
            {
              chunk_id: "chunk-bestirek-overview",
              document_id: "doc-bestirek",
              chunk_index: 0,
              content: "БесТірек поддерживает бизнес-проекты.",
              locale: "ru",
              source_kind: "kb_article",
              source_record_id: "kb-bestirek",
              title: "БесТірек",
              canonical_url: null,
              authority_score: 0.9,
              freshness_at: null,
              distance: 0.1,
              fused_score: 0.5,
            },
            {
              chunk_id: "chunk-scholarship",
              document_id: "doc-scholarship",
              chunk_index: 1,
              content: "Стипендия требует отдельный пакет документов.",
              locale: "ru",
              source_kind: "kb_article",
              source_record_id: "kb-scholarship",
              title: "Программа стипендий",
              canonical_url: null,
              authority_score: 0.9,
              freshness_at: null,
              distance: 0.11,
              fused_score: 0.49,
            },
          ],
          error: null,
        };
      }
      if (fn === "match_indexed_urls") {
        return { data: [], error: null };
      }
      throw new Error(`Unexpected RPC in test: ${fn}`);
    });

    const results = await retrieveRelevantKBArticles(
      "workspace-1",
      "Что нужно для участия в БесТірек?",
      "ru",
      { queryEmbedding: [0.1, 0.2, 0.3], limit: 2 }
    );

    expect(results.map(result => result.id).slice(0, 2)).toEqual([
      "chunk-bestirek-overview",
      "chunk-bestirek-requirements",
    ]);
  });

  it("when fused_score ties, orders canonical chunks by authority_score", async () => {
    getEmbeddingWithCache.mockResolvedValue([0.1, 0.2, 0.3]);
    configureSupabaseFrom({ kbVisibleIds: ["kb-a", "kb-b"] });

    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === "match_knowledge_chunks") {
        return {
          data: [
            {
              chunk_id: "chunk-low-auth",
              document_id: "doc-a",
              chunk_index: 0,
              content: "Low",
              locale: "en",
              source_kind: "kb_article",
              source_record_id: "kb-a",
              title: "A",
              canonical_url: null,
              authority_score: 0.4,
              freshness_at: null,
              distance: 0.08,
              fused_score: 0.04,
            },
            {
              chunk_id: "chunk-high-auth",
              document_id: "doc-b",
              chunk_index: 0,
              content: "High",
              locale: "en",
              source_kind: "kb_article",
              source_record_id: "kb-b",
              title: "B",
              canonical_url: null,
              authority_score: 0.95,
              fused_score: 0.04,
              distance: 0.08,
              freshness_at: null,
            },
          ],
          error: null,
        };
      }
      if (fn === "match_indexed_urls") {
        return { data: [], error: null };
      }
      if (fn === "search_kb_articles") {
        return { data: [], error: null };
      }
      throw new Error(`Unexpected RPC in test: ${fn}`);
    });

    const results = await retrieveRelevantKBArticles(
      "workspace-1",
      "refund policy details",
      "en",
      { queryEmbedding: [0.1, 0.2, 0.3] }
    );

    expect(results[0]?.id).toBe("chunk-high-auth");
    expect(results[1]?.id).toBe("chunk-low-auth");
  });

  it("separates KB retrieval cache keys by HyDE rescue mode", async () => {
    getEmbeddingWithCache.mockResolvedValue([0.1, 0.2, 0.3]);
    configureSupabaseFrom();

    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === "match_knowledge_chunks") {
        return { data: [], error: null };
      }
      if (fn === "match_indexed_urls") {
        return { data: [], error: null };
      }
      if (fn === "search_kb_articles") {
        return { data: [], error: null };
      }
      throw new Error(`Unexpected RPC in test: ${fn}`);
    });

    await retrieveRelevantKBArticles(
      "workspace-1",
      "Хочу узнать о грантах для инвалидов",
      "ru",
      {
        enableHyDERescue: false,
      }
    );

    await retrieveRelevantKBArticles(
      "workspace-1",
      "Хочу узнать о грантах для инвалидов",
      "ru",
      {
        enableHyDERescue: true,
      }
    );

    const retrievalCacheLookups = cacheGet.mock.calls
      .map(call => String(call[0] || ""))
      .filter(key =>
        key.startsWith(`kb:retrieval:${KB_RETRIEVAL_CACHE_VERSION}:`)
      );

    expect(retrievalCacheLookups.some(key => key.includes(":no-hyde"))).toBe(
      true
    );
    expect(retrievalCacheLookups.some(key => key.includes(":hyde"))).toBe(true);
  });

  describe("retrieval cache isolation", () => {
    const query = "What does the support policy include?";
    const documents = [
      {
        id: "public-article",
        workspaceId: "workspace-1",
        visibility: "public",
        sourceKind: "kb_article",
      },
      {
        id: "workspace-article",
        workspaceId: "workspace-1",
        visibility: "workspace",
        sourceKind: "kb_article",
      },
      {
        id: "internal-article",
        workspaceId: "workspace-1",
        visibility: "internal",
        sourceKind: "kb_article",
      },
      {
        id: "public-url",
        workspaceId: "workspace-1",
        visibility: "public",
        sourceKind: "indexed_url",
      },
      {
        id: "other-workspace-article",
        workspaceId: "workspace-2",
        visibility: "public",
        sourceKind: "kb_article",
      },
    ];

    beforeEach(() => {
      const stored = new Map<string, unknown>();
      cacheGet.mockImplementation(
        async (key: string) => stored.get(key) ?? null
      );
      cacheSet.mockImplementation(async (key: string, value: unknown) => {
        stored.set(key, value);
      });
      rpcMock.mockImplementation(
        async (name: string, payload: Record<string, unknown>) => {
          if (name !== "match_knowledge_chunks") {
            return { data: [], error: null };
          }
          const allowedVisibilities = payload.match_allowed_visibilities as
            | string[]
            | undefined;
          const sourceKinds = payload.match_source_kinds as string[];
          return {
            data: documents
              .filter(
                document =>
                  document.workspaceId === payload.match_workspace &&
                  sourceKinds.includes(document.sourceKind) &&
                  (allowedVisibilities === undefined ||
                    allowedVisibilities.includes(document.visibility))
              )
              .map(document => ({
                chunk_id: document.id,
                document_id: `document-${document.id}`,
                chunk_index: 0,
                content: `Support policy for ${document.id}.`,
                locale: "en",
                source_kind: document.sourceKind,
                source_record_id: document.id,
                title: document.id,
                canonical_url: null,
                authority_score: 0.8,
                freshness_at: null,
                distance: 0.08,
                fused_score: 0.4,
              })),
            error: null,
          };
        }
      );
    });

    async function retrieveIds(
      options: KBRetrievalOptions = {},
      workspaceId = "workspace-1"
    ) {
      const results = await retrieveRelevantKBArticles(
        workspaceId,
        query,
        "en",
        {
          queryEmbedding: [0.1, 0.2, 0.3],
          enableHyDERescue: false,
          ragQueryPreparation: {
            originalQuery: query,
            cleanedQuery: query,
            subQueries: [],
            wasCleaned: false,
            source: "fallback",
          },
          ...options,
        }
      );
      return results.map(result => result.id).sort();
    }

    function chunkSearchCount() {
      return rpcMock.mock.calls.filter(
        call => call[0] === "match_knowledge_chunks"
      ).length;
    }

    it("keeps member-only evidence out of customer retrieval after a cache fill", async () => {
      const memberOptions: KBRetrievalOptions = {
        knowledgeSearchPrincipal: "workspace_member_tool",
      };
      const memberIds = await retrieveIds(memberOptions);
      expect(memberIds).toEqual([
        "internal-article",
        "public-article",
        "public-url",
        "workspace-article",
      ]);
      expect(await retrieveIds()).toEqual([
        "public-article",
        "public-url",
        "workspace-article",
      ]);
      expect(await retrieveIds(memberOptions)).toEqual(memberIds);
      expect(chunkSearchCount()).toBe(2);
    });

    it("separates unrestricted, public-only, and empty visibility requests", async () => {
      const unrestrictedIds = await retrieveIds({
        knowledgeSearchPrincipal: "system_unrestricted",
      });
      expect(unrestrictedIds).toContain("internal-article");
      expect(
        await retrieveIds({ matchAllowedVisibilities: ["public"] })
      ).toEqual(["public-article", "public-url"]);
      expect(await retrieveIds({ matchAllowedVisibilities: [] })).toEqual([]);

      const searchesAfterMisses = chunkSearchCount();
      expect(await retrieveIds({ matchAllowedVisibilities: null })).toEqual(
        unrestrictedIds
      );
      expect(await retrieveIds({ matchAllowedVisibilities: [] })).toEqual([]);
      expect(chunkSearchCount()).toBe(searchesAfterMisses);
    });

    it("reuses evidence for equivalent resolved visibility lists", async () => {
      const customerIds = await retrieveIds();
      expect(customerIds).not.toContain("internal-article");
      expect(
        await retrieveIds({
          knowledgeSearchPrincipal: "workspace_member_tool",
          matchAllowedVisibilities: ["public", "workspace"],
        })
      ).toEqual(customerIds);
      expect(
        await retrieveIds({
          matchAllowedVisibilities: ["workspace", "public"],
        })
      ).toEqual(customerIds);
      expect(chunkSearchCount()).toBe(1);
    });

    it("does not reuse another workspace's cached evidence", async () => {
      const firstWorkspaceIds = await retrieveIds();
      expect(await retrieveIds({}, "workspace-2")).toEqual([
        "other-workspace-article",
      ]);
      expect(await retrieveIds()).toEqual(firstWorkspaceIds);
      expect(chunkSearchCount()).toBe(2);
    });

    it("keeps cached articles separate from indexed URL requests", async () => {
      const articleIds = await retrieveIds({
        matchSourceKinds: ["kb_article"],
      });
      expect(articleIds).toEqual(["public-article", "workspace-article"]);
      expect(await retrieveIds({ matchSourceKinds: ["indexed_url"] })).toEqual([
        "public-url",
      ]);
      expect(await retrieveIds({ matchSourceKinds: ["kb_article"] })).toEqual(
        articleIds
      );
      expect(chunkSearchCount()).toBe(2);
    });
  });

  it("always sends the exact three defaults and drops retired RPC rows", async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          chunk_id: "legacy-summary-chunk",
          document_id: "legacy-summary-document",
          chunk_index: 0,
          content: "Duplicated conversation memory",
          locale: "en",
          source_kind: "conversation_summary",
          source_record_id: "conversation-1",
          title: "Overview",
          canonical_url: null,
          authority_score: 0.35,
          freshness_at: null,
          distance: 0.1,
          fused_score: 0.5,
        },
        {
          chunk_id: "kb-chunk",
          document_id: "kb-document",
          chunk_index: 0,
          content: "Supported KB content",
          locale: "en",
          source_kind: "kb_article",
          source_record_id: "article-1",
          title: "Policy",
          canonical_url: null,
          authority_score: 0.8,
          freshness_at: null,
          distance: 0.12,
          fused_score: 0.4,
        },
      ],
      error: null,
    });

    const rows = await queryKnowledgeChunks({
      workspaceId: "workspace-1",
      queryText: "policy",
      queryEmbedding: [0.1, 0.2, 0.3],
      matchCount: 5,
      matchThreshold: 0.5,
      matchLocale: "en",
      matchSourceKinds: null,
    });

    expect(rpcMock).toHaveBeenCalledWith(
      "match_knowledge_chunks",
      expect.objectContaining({
        match_source_kinds: ["kb_article", "indexed_url", "curated_snippet"],
      })
    );
    expect(rows.map(row => row.chunk_id)).toEqual(["kb-chunk"]);
  });

  it("filters a mixed runtime source request and post-filters against the request", async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          chunk_id: "kb-chunk",
          document_id: "kb-document",
          chunk_index: 0,
          content: "KB content the caller did not request",
          locale: "en",
          source_kind: "kb_article",
          source_record_id: "article-1",
          title: "Policy",
          canonical_url: null,
          authority_score: 0.8,
          freshness_at: null,
          distance: 0.12,
          fused_score: 0.4,
        },
        {
          chunk_id: "url-chunk",
          document_id: "url-document",
          chunk_index: 0,
          content: "Requested indexed content",
          locale: "en",
          source_kind: "indexed_url",
          source_record_id: "url-1",
          title: "Pricing",
          canonical_url: "https://example.com/pricing",
          authority_score: 0.5,
          freshness_at: null,
          distance: 0.15,
          fused_score: 0.3,
        },
      ],
      error: null,
    });

    const rows = await queryKnowledgeChunks({
      workspaceId: "workspace-1",
      queryText: "pricing",
      queryEmbedding: [0.1, 0.2, 0.3],
      matchCount: 5,
      matchThreshold: 0.5,
      matchLocale: "en",
      matchSourceKinds: [
        "conversation_summary",
        "indexed_url",
        "future_source",
      ],
    });

    expect(rpcMock).toHaveBeenCalledWith(
      "match_knowledge_chunks",
      expect.objectContaining({ match_source_kinds: ["indexed_url"] })
    );
    expect(rows.map(row => row.chunk_id)).toEqual(["url-chunk"]);
  });

  it("maps all-unsupported runtime input to the exact safe defaults", async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });

    await queryKnowledgeChunks({
      workspaceId: "workspace-1",
      queryText: "anything",
      queryEmbedding: [0.1, 0.2, 0.3],
      matchCount: 5,
      matchThreshold: 0.5,
      matchLocale: null,
      matchSourceKinds: ["conversation_summary", "future_source"],
    });

    expect(rpcMock).toHaveBeenCalledWith(
      "match_knowledge_chunks",
      expect.objectContaining({
        match_source_kinds: ["kb_article", "indexed_url", "curated_snippet"],
      })
    );
  });

  describe("canonical chunks of KB articles that are no longer published", () => {
    function chunkRow(
      chunkId: string,
      sourceKind: string,
      sourceRecordId: string
    ) {
      return {
        chunk_id: chunkId,
        document_id: `${chunkId}-document`,
        chunk_index: 0,
        content: `${chunkId} content`,
        locale: "en",
        source_kind: sourceKind,
        source_record_id: sourceRecordId,
        title: chunkId,
        canonical_url: null,
        authority_score: 0.8,
        freshness_at: null,
        distance: 0.1,
        fused_score: 0.4,
      };
    }

    function query() {
      return queryKnowledgeChunks({
        workspaceId: "workspace-1",
        queryText: "refunds",
        queryEmbedding: [0.1, 0.2, 0.3],
        matchCount: 5,
        matchThreshold: 0.5,
        matchLocale: "en",
        matchSourceKinds: null,
      });
    }

    it("drops chunks of unpublished and deleted articles but keeps other sources", async () => {
      configureSupabaseFrom({ kbVisibleIds: ["article-live"] });
      rpcMock.mockResolvedValue({
        data: [
          chunkRow("live-chunk", "kb_article", "article-live"),
          chunkRow("unpublished-chunk", "kb_article", "article-unpublished"),
          chunkRow("deleted-chunk", "kb_article", "article-deleted"),
          chunkRow("url-chunk", "indexed_url", "url-1"),
        ],
        error: null,
      });

      const rows = await query();

      expect(rows.map(row => row.chunk_id)).toEqual([
        "live-chunk",
        "url-chunk",
      ]);
      const kbArticlesQuery = fromMock.mock.results.find(
        (_result, index) => fromMock.mock.calls[index]?.[0] === "kb_articles"
      )?.value as { eq: jest.Mock; in: jest.Mock };
      expect(kbArticlesQuery.eq).toHaveBeenCalledWith(
        "workspace_id",
        "workspace-1"
      );
      expect(kbArticlesQuery.eq).toHaveBeenCalledWith("status", "published");
      expect(kbArticlesQuery.in).toHaveBeenCalledWith("id", [
        "article-live",
        "article-unpublished",
        "article-deleted",
      ]);
    });

    it("fails closed for KB chunks when publication can't be checked", async () => {
      fromMock.mockImplementation((table: string) => {
        if (table !== "kb_articles") throw new Error(`Unexpected ${table}`);
        const builder: Record<string, jest.Mock> = {};
        builder.select = jest.fn(() => builder);
        builder.eq = jest.fn(() => builder);
        builder.in = jest.fn(async () => ({
          data: null,
          error: { message: "timeout" },
        }));
        return builder;
      });
      rpcMock.mockResolvedValue({
        data: [
          chunkRow("live-chunk", "kb_article", "article-live"),
          chunkRow("url-chunk", "indexed_url", "url-1"),
        ],
        error: null,
      });

      const rows = await query();

      expect(rows.map(row => row.chunk_id)).toEqual(["url-chunk"]);
    });

    it("skips the publication lookup when no KB chunks match", async () => {
      rpcMock.mockResolvedValue({
        data: [chunkRow("url-chunk", "indexed_url", "url-1")],
        error: null,
      });

      const rows = await query();

      expect(rows.map(row => row.chunk_id)).toEqual(["url-chunk"]);
      expect(fromMock).not.toHaveBeenCalledWith("kb_articles");
    });
  });
});
