const mockInvalidateKbWorkspaceCaches = jest.fn();
const mockRetireKbArticleCanonicalKnowledge = jest.fn();
const mockGetCompanySlugByWorkspaceId = jest.fn();
const mockSupabaseAdminFrom = jest.fn();
const mockSupabaseAdminRpc = jest.fn();
const mockRevalidatePath = jest.fn();
const mockRevalidateTag = jest.fn();

jest.mock("@/lib/airi/rag/cache-invalidation", () => ({
  invalidateKbWorkspaceCaches: (...args: unknown[]) =>
    mockInvalidateKbWorkspaceCaches(...args),
}));

jest.mock(
  "@/lib/airi/rag/knowledge/canonical-sync/knowledge-canonical-sync-runner",
  () => ({
    retireKbArticleCanonicalKnowledge: (...args: unknown[]) =>
      mockRetireKbArticleCanonicalKnowledge(...args),
  })
);

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

jest.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
  revalidateTag: (...args: unknown[]) => mockRevalidateTag(...args),
}));

import { removeUnpublishedKBContentFromSearch } from "./kb-localization-server";

function createEmbeddingDelete(error: unknown = null) {
  const chain: Record<string, unknown> = {};
  chain.delete = jest.fn(() => chain);
  chain.eq = jest.fn(() => chain);
  chain.then = (
    resolve: (value: { error: unknown }) => unknown,
    reject: (reason: unknown) => unknown
  ) => Promise.resolve({ error }).then(resolve, reject);
  return chain as { delete: jest.Mock; eq: jest.Mock };
}

describe("removeUnpublishedKBContentFromSearch", () => {
  const events: string[] = [];
  let embeddingDelete: ReturnType<typeof createEmbeddingDelete>;

  beforeEach(() => {
    jest.clearAllMocks();
    events.length = 0;
    embeddingDelete = createEmbeddingDelete();
    mockSupabaseAdminFrom.mockImplementation(() => {
      events.push("delete-embeddings");
      return embeddingDelete;
    });
    mockSupabaseAdminRpc.mockImplementation(async () => {
      events.push("refresh-search-vector");
      return { error: null };
    });
    mockRetireKbArticleCanonicalKnowledge.mockImplementation(async () => {
      events.push("retire-canonical");
    });
    mockInvalidateKbWorkspaceCaches.mockImplementation(async () => {
      events.push("invalidate-retrieval-cache");
    });
    mockGetCompanySlugByWorkspaceId.mockResolvedValue("acme");
  });

  it("clears every language and the canonical chunks before dropping cached retrieval results", async () => {
    await removeUnpublishedKBContentFromSearch({
      articleId: "article-1",
      workspaceId: "workspace-1",
      locale: null,
      retireCanonicalKnowledge: true,
    });

    expect(mockSupabaseAdminFrom).toHaveBeenCalledWith("kb_article_embeddings");
    expect(embeddingDelete.eq.mock.calls).toEqual([
      ["article_id", "article-1"],
    ]);
    expect(mockSupabaseAdminRpc).toHaveBeenCalledWith(
      "kb_refresh_article_search_vector",
      { p_article_id: "article-1" }
    );
    expect(mockRetireKbArticleCanonicalKnowledge).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      articleId: "article-1",
    });
    expect(events).toEqual([
      "delete-embeddings",
      "refresh-search-vector",
      "retire-canonical",
      "invalidate-retrieval-cache",
    ]);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/kb/article-1");
    expect(mockRevalidateTag).toHaveBeenCalledWith(
      "public-kb-article:article-1",
      "max"
    );
  });

  it("clears only one language and keeps canonical chunks for other languages", async () => {
    await removeUnpublishedKBContentFromSearch({
      articleId: "article-1",
      workspaceId: "workspace-1",
      locale: "ru",
      retireCanonicalKnowledge: false,
    });

    expect(embeddingDelete.eq.mock.calls).toEqual([
      ["article_id", "article-1"],
      ["locale", "ru"],
    ]);
    expect(mockRetireKbArticleCanonicalKnowledge).not.toHaveBeenCalled();
    expect(mockInvalidateKbWorkspaceCaches).toHaveBeenCalledWith("workspace-1");
  });

  it("stops before touching caches when the embeddings can't be deleted", async () => {
    embeddingDelete = createEmbeddingDelete({ message: "permission denied" });

    await expect(
      removeUnpublishedKBContentFromSearch({
        articleId: "article-1",
        workspaceId: "workspace-1",
        locale: null,
        retireCanonicalKnowledge: true,
      })
    ).rejects.toEqual({ message: "permission denied" });

    expect(mockRetireKbArticleCanonicalKnowledge).not.toHaveBeenCalled();
    expect(mockInvalidateKbWorkspaceCaches).not.toHaveBeenCalled();
  });
});
