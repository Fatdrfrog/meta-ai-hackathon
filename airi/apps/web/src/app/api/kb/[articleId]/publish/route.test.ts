const mockBuildEmbeddingMetadata = jest.fn();
const mockGetDocumentEmbeddingResult = jest.fn();
const mockGetCurrentEmbeddingMetadata = jest.fn();
const mockInvalidateKbWorkspaceCaches = jest.fn();
const mockBuildKBArticleEmbeddingText = jest.fn();
const mockRunKnowledgeCanonicalSync = jest.fn();
const mockTryStartKnowledgeCanonicalSyncWorkflow = jest.fn();
const mockGetLocaleFromCookie = jest.fn();
const mockRequireKBRouteAccess = jest.fn();
const mockGetAccessibleKBArticle = jest.fn();
const mockFetchKBAncestors = jest.fn();
const mockGetCompanySlugByWorkspaceId = jest.fn();
const mockCreateClient = jest.fn();
const mockRevalidatePath = jest.fn();
const mockRevalidateTag = jest.fn();
const mockSupabaseAdminFrom = jest.fn();
const mockSupabaseAdminRpc = jest.fn();

jest.mock("@/lib/ai", () => ({
  buildEmbeddingMetadata: (...args: unknown[]) =>
    mockBuildEmbeddingMetadata(...args),
  getDocumentEmbeddingResult: (...args: unknown[]) =>
    mockGetDocumentEmbeddingResult(...args),
  getCurrentEmbeddingMetadata: (...args: unknown[]) => mockGetCurrentEmbeddingMetadata(...args),
}));

jest.mock("@/lib/ai/vertex-embeddings", () => ({
  normalizeEmbeddingText: (text: string) => text.replace(/\s+/g, " ").trim(),
}));

jest.mock("@/lib/airi/rag/cache-invalidation", () => ({
  invalidateKbWorkspaceCaches: (...args: unknown[]) =>
    mockInvalidateKbWorkspaceCaches(...args),
}));

jest.mock("@/lib/airi/rag/kb/kb-article-embedding", () => ({
  buildKBArticleEmbeddingText: (...args: unknown[]) =>
    mockBuildKBArticleEmbeddingText(...args),
}));

jest.mock(
  "@/lib/airi/rag/knowledge/canonical-sync/knowledge-canonical-sync-runner",
  () => ({
    runKnowledgeCanonicalSync: (...args: unknown[]) =>
      mockRunKnowledgeCanonicalSync(...args),
  })
);

jest.mock("@/lib/temporal/knowledge-canonical-sync-client", () => ({
  tryStartKnowledgeCanonicalSyncWorkflow: (...args: unknown[]) =>
    mockTryStartKnowledgeCanonicalSyncWorkflow(...args),
}));

jest.mock("@/i18n/message-loader", () => ({
  getLocaleFromCookie: (...args: unknown[]) => mockGetLocaleFromCookie(...args),
}));

jest.mock("@/lib/kb/article-access", () => ({
  requireKBRouteAccess: (...args: unknown[]) =>
    mockRequireKBRouteAccess(...args),
  getAccessibleKBArticle: (...args: unknown[]) =>
    mockGetAccessibleKBArticle(...args),
}));

jest.mock("@/lib/kb/fetch-ancestors", () => ({
  fetchKBAncestors: (...args: unknown[]) => mockFetchKBAncestors(...args),
}));

jest.mock("@/lib/kb/get-company-slug", () => ({
  getCompanySlugByWorkspaceId: (...args: unknown[]) =>
    mockGetCompanySlugByWorkspaceId(...args),
}));

jest.mock("@/lib/kb/public-kb", () => ({
  getPublicKBArticleTag: (articleId: string) =>
    `public-kb-article:${articleId}`,
  getPublicKBNavigationTag: (workspaceId: string) =>
    `public-kb-navigation:${workspaceId}`,
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseAdminFrom(...args),
    rpc: (...args: unknown[]) => mockSupabaseAdminRpc(...args),
  },
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
  revalidateTag: (...args: unknown[]) => mockRevalidateTag(...args),
}));

import { POST } from "./route";

function createQueryChain({
  data = null,
  error = null,
  maybeSingleData = null,
}: {
  data?: unknown;
  error?: unknown;
  maybeSingleData?: unknown;
} = {}) {
  const chain: Record<string, unknown> = {
    data,
    error,
  };
  chain.select = jest.fn(() => chain);
  chain.eq = jest.fn(() => chain);
  chain.in = jest.fn(() => chain);
  chain.order = jest.fn(() => chain);
  chain.limit = jest.fn(() => chain);
  chain.maybeSingle = jest.fn(async () => ({
    data: maybeSingleData,
    error: null,
  }));
  chain.insert = jest.fn(async () => ({ error: null }));
  chain.upsert = jest.fn(async () => ({ error: null }));
  chain.update = jest.fn(() => chain);
  chain.delete = jest.fn(() => chain);
  return chain;
}

function createPublishSupabaseMock() {
  const localizationQuery = createQueryChain({
    maybeSingleData: {
      locale: "en",
      title: "Published title",
      status: "published",
      published_at: "2026-05-01T10:00:00.000Z",
      draft_title: null,
      draft_content_mdx: null,
      updated_at: "2026-05-01T10:00:00.000Z",
    },
  });
  const localizationVersionsQuery = createQueryChain({
    maybeSingleData: {
      content_mdx: "<p>Existing published content</p>",
    },
  });
  const legacyVersionsQuery = createQueryChain({
    maybeSingleData: {
      version: 1,
      content_mdx: "<p>Existing legacy published content</p>",
    },
  });
  const articlesQuery = createQueryChain();

  return {
    queries: {
      localizationQuery,
      localizationVersionsQuery,
      legacyVersionsQuery,
      articlesQuery,
    },
    from: jest.fn((table: string) => {
      if (table === "kb_article_localizations") return localizationQuery;
      if (table === "kb_article_localization_versions")
        return localizationVersionsQuery;
      if (table === "kb_article_versions") return legacyVersionsQuery;
      if (table === "kb_articles") return articlesQuery;
      throw new Error(`Unexpected Supabase table: ${table}`);
    }),
  };
}

function createAdminEmbeddingQuery({
  data = [],
  error = null,
  upsertError = null,
  deleteError = null,
}: {
  data?: unknown;
  error?: unknown;
  upsertError?: unknown;
  deleteError?: unknown;
} = {}) {
  const chain = createQueryChain({ data, error });
  chain.upsert = jest.fn(async () => ({ error: upsertError }));
  chain.delete = jest.fn(() => {
    const deleteChain = createQueryChain({ data: null, error: deleteError });
    return deleteChain;
  });
  return chain;
}

describe("POST /api/kb/[articleId]/publish", () => {
  let consoleWarnSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockGetLocaleFromCookie.mockResolvedValue("en");
    mockRequireKBRouteAccess.mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
      workspaceIds: ["workspace-1"],
    });
    mockGetAccessibleKBArticle.mockResolvedValue({
      id: "article-1",
      title: "Published title",
      status: "published",
      published_at: "2026-05-01T10:00:00.000Z",
      is_featured: false,
      workspace_id: "workspace-1",
      parent_id: null,
      draft_title: null,
      draft_content_mdx: null,
      default_locale: "en",
    });
    mockFetchKBAncestors.mockResolvedValue([]);
    mockBuildKBArticleEmbeddingText.mockReturnValue("Published title\nContent");
    mockGetDocumentEmbeddingResult.mockResolvedValue(null);
    mockBuildEmbeddingMetadata.mockReturnValue({
      embeddingProvider: "test",
      embeddingModel: "test",
      embeddingTaskType: "retrieval_document",
      embeddingDimensions: 3,
    });
    mockGetCurrentEmbeddingMetadata.mockReturnValue({
      embeddingProvider: "vertex", embeddingModel: "gemini-embedding-001",
      embeddingTaskType: "RETRIEVAL_DOCUMENT", embeddingDimensions: 1536,
    });
    mockInvalidateKbWorkspaceCaches.mockResolvedValue(undefined);
    mockGetCompanySlugByWorkspaceId.mockResolvedValue("company");
    mockTryStartKnowledgeCanonicalSyncWorkflow.mockResolvedValue({ ok: true });
    mockRunKnowledgeCanonicalSync.mockResolvedValue(undefined);
    mockSupabaseAdminFrom.mockReturnValue(createAdminEmbeddingQuery());
    mockSupabaseAdminRpc.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it.each(["unchanged", "content", "model", "invalid vector"])("reuses only unchanged valid stored embeddings: %s", async change => {
    const supabase = createPublishSupabaseMock();
    mockCreateClient.mockResolvedValue(supabase);
    const query = createAdminEmbeddingQuery();
    mockSupabaseAdminFrom.mockReturnValue(query);
    mockGetDocumentEmbeddingResult.mockResolvedValue({ embedding: new Array(1536).fill(0.1) });
    mockBuildEmbeddingMetadata.mockReturnValue(mockGetCurrentEmbeddingMetadata());
    const publish = () => POST(new Request("http://localhost/api/kb/article-1/publish", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "en", publishMode: "public_with_auto_link" }),
    }) as never, { params: Promise.resolve({ articleId: "article-1" }) });
    expect((await publish()).status).toBe(200);
    const saved = (query.upsert as jest.Mock).mock.calls[0][0];
    expect(saved.embedding_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    query.data = [saved];
    if (change === "content") mockBuildKBArticleEmbeddingText.mockReturnValue("Changed title and content");
    if (change === "model") mockGetCurrentEmbeddingMetadata.mockReturnValue({ ...mockGetCurrentEmbeddingMetadata(), embeddingModel: "new-model" });
    if (change === "invalid vector") saved.embedding = [NaN];
    mockGetDocumentEmbeddingResult.mockClear();
    (query.upsert as jest.Mock).mockClear();
    expect((await publish()).status).toBe(200);
    expect(mockGetDocumentEmbeddingResult).toHaveBeenCalledTimes(change === "unchanged" ? 0 : 1);
    if (change === "unchanged") expect(query.upsert).not.toHaveBeenCalled();
  });

  it("publishes the current locale even when embedding generation returns no vector", async () => {
    const supabase = createPublishSupabaseMock();
    mockCreateClient.mockResolvedValue(supabase);

    const response = await POST(
      new Request("http://localhost/api/kb/article-1/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publishMode: "public_with_auto_link",
          locale: "en",
        }),
      }) as never,
      { params: Promise.resolve({ articleId: "article-1" }) }
    );

    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      success: true,
      warnings: ["embedding_unavailable"],
      publishedLocalization: {
        locale: "en",
        status: "published",
        published_at: "2026-05-01T10:00:00.000Z",
        hasDraft: false,
        isDefault: true,
      },
    });
    expect(mockTryStartKnowledgeCanonicalSyncWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRecordIds: ["article-1"] })
    );
    expect(supabase.queries.localizationQuery.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        article_id: "article-1",
        locale: "en",
        status: "published",
        published_at: "2026-05-01T10:00:00.000Z",
      }),
      { onConflict: "article_id,locale" }
    );
    expect(supabase.queries.articlesQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "published",
      })
    );
  });

  it("publishes default locale article draft content instead of stale localization content", async () => {
    const supabase = createPublishSupabaseMock();
    mockCreateClient.mockResolvedValue(supabase);
    mockGetAccessibleKBArticle.mockResolvedValue({
      id: "article-1",
      title: "Old canonical title",
      status: "published",
      published_at: "2026-05-01T10:00:00.000Z",
      is_featured: false,
      workspace_id: "workspace-1",
      parent_id: null,
      draft_title: "Fresh canonical title",
      draft_content_mdx: "<p>Fresh canonical draft</p>",
      default_locale: "en",
    });

    const response = await POST(
      new Request("http://localhost/api/kb/article-1/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publishMode: "public_with_auto_link",
          locale: "en",
        }),
      }) as never,
      { params: Promise.resolve({ articleId: "article-1" }) }
    );

    expect(response.status).toBe(200);
    expect(
      supabase.queries.localizationVersionsQuery.insert
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        article_id: "article-1",
        locale: "en",
        version: 1,
        title: "Fresh canonical title",
        content_mdx: "<p>Fresh canonical draft</p>",
      })
    );
    expect(supabase.queries.legacyVersionsQuery.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        article_id: "article-1",
        version: 2,
        content_mdx: "<p>Fresh canonical draft</p>",
      })
    );
    expect(supabase.queries.localizationQuery.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Fresh canonical title",
        draft_content_mdx: null,
      }),
      { onConflict: "article_id,locale" }
    );
    expect(supabase.queries.articlesQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Fresh canonical title",
        draft_title: null,
        draft_content_mdx: null,
      })
    );
  });

  it("fails publish when storing a generated embedding fails", async () => {
    const supabase = createPublishSupabaseMock();
    const embeddingQuery = createAdminEmbeddingQuery({
      upsertError: new Error("embedding upsert failed"),
    });
    mockCreateClient.mockResolvedValue(supabase);
    mockSupabaseAdminFrom.mockReturnValue(embeddingQuery);
    mockGetDocumentEmbeddingResult.mockResolvedValue({
      embedding: [0.1, 0.2, 0.3],
    });

    const response = await POST(
      new Request("http://localhost/api/kb/article-1/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publishMode: "public_with_auto_link",
          locale: "en",
        }),
      }) as never,
      { params: Promise.resolve({ articleId: "article-1" }) }
    );

    expect(response.status).toBe(500);
    expect(supabase.queries.localizationQuery.upsert).not.toHaveBeenCalled();
    expect(supabase.queries.articlesQuery.update).not.toHaveBeenCalled();
    expect(mockInvalidateKbWorkspaceCaches).not.toHaveBeenCalled();
    expect(embeddingQuery.upsert).toHaveBeenCalled();
  });

  it("fails publish when stale embedding cleanup fails after embedding generation is unavailable", async () => {
    const supabase = createPublishSupabaseMock();
    const embeddingQuery = createAdminEmbeddingQuery({
      data: [
        {
          locale: "en",
          embedding: [0.1, 0.2, 0.3],
          embedding_provider: "test",
          embedding_model: "test",
          embedding_task_type: "retrieval_document",
          embedding_dimensions: 3,
          updated_at: "2026-05-01T10:00:00.000Z",
        },
      ],
      deleteError: new Error("stale cleanup failed"),
    });
    mockCreateClient.mockResolvedValue(supabase);
    mockSupabaseAdminFrom.mockReturnValue(embeddingQuery);
    mockGetDocumentEmbeddingResult.mockResolvedValue(null);

    const response = await POST(
      new Request("http://localhost/api/kb/article-1/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publishMode: "public_with_auto_link",
          locale: "en",
        }),
      }) as never,
      { params: Promise.resolve({ articleId: "article-1" }) }
    );

    expect(response.status).toBe(500);
    expect(supabase.queries.localizationQuery.upsert).not.toHaveBeenCalled();
    expect(supabase.queries.articlesQuery.update).not.toHaveBeenCalled();
    expect(mockInvalidateKbWorkspaceCaches).not.toHaveBeenCalled();
  });
});
