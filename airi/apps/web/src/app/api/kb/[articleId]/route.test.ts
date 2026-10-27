const mockInvalidateKbWorkspaceCaches = jest.fn();
const mockRetireKbArticleCanonicalKnowledge = jest.fn();
const mockRemoveUnpublishedKBContentFromSearch = jest.fn();
const mockGetLocaleFromCookie = jest.fn();
const mockRequireKBRouteAccess = jest.fn();
const mockGetAccessibleKBArticle = jest.fn();
const mockGetCompanySlugByWorkspaceId = jest.fn();
const mockCreateClient = jest.fn();
const mockSupabaseAdminFrom = jest.fn();

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

jest.mock("@/lib/kb/kb-localization-server", () => ({
  removeUnpublishedKBContentFromSearch: (...args: unknown[]) =>
    mockRemoveUnpublishedKBContentFromSearch(...args),
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
  },
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("next/cache", () => ({
  revalidatePath: jest.fn(),
  revalidateTag: jest.fn(),
}));

import { DELETE, PUT } from "./route";

function createQueryChain() {
  const chain: Record<string, unknown> = {};
  chain.select = jest.fn(() => chain);
  chain.eq = jest.fn(() => chain);
  chain.in = jest.fn(() => chain);
  chain.update = jest.fn(() => chain);
  chain.delete = jest.fn(() => chain);
  chain.upsert = jest.fn(async () => ({ error: null }));
  chain.then = (
    resolve: (value: unknown) => unknown,
    reject: (reason: unknown) => unknown
  ) => Promise.resolve({ data: null, error: null }).then(resolve, reject);
  return chain;
}

const params = { params: Promise.resolve({ articleId: "article-1" }) };

function put(body: Record<string, unknown>) {
  return PUT(
    new Request("http://localhost/api/kb/article-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    params
  );
}

describe("/api/kb/[articleId]", () => {
  const events: string[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    events.length = 0;
    mockCreateClient.mockResolvedValue({ from: jest.fn(createQueryChain) });
    mockSupabaseAdminFrom.mockImplementation(createQueryChain);
    mockRequireKBRouteAccess.mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
      workspaceIds: ["workspace-1"],
    });
    mockGetAccessibleKBArticle.mockResolvedValue({
      id: "article-1",
      title: "Refunds",
      workspace_id: "workspace-1",
      default_locale: "en",
    });
    mockGetLocaleFromCookie.mockResolvedValue("en");
    mockGetCompanySlugByWorkspaceId.mockResolvedValue("acme");
    mockRemoveUnpublishedKBContentFromSearch.mockResolvedValue(undefined);
    mockRetireKbArticleCanonicalKnowledge.mockImplementation(async () => {
      events.push("retire-canonical");
    });
    mockInvalidateKbWorkspaceCaches.mockImplementation(async () => {
      events.push("invalidate-retrieval-cache");
    });
  });

  it("takes the whole article out of AI search when PUT unpublishes the default language", async () => {
    const response = await put({ status: "draft", locale: "en" });

    expect(response.status).toBe(200);
    expect(mockRemoveUnpublishedKBContentFromSearch).toHaveBeenCalledWith({
      articleId: "article-1",
      workspaceId: "workspace-1",
      locale: null,
      retireCanonicalKnowledge: true,
    });
  });

  it("takes only that language out of AI search when PUT unpublishes another language", async () => {
    const response = await put({ status: "draft", locale: "ru" });

    expect(response.status).toBe(200);
    expect(mockRemoveUnpublishedKBContentFromSearch).toHaveBeenCalledWith({
      articleId: "article-1",
      workspaceId: "workspace-1",
      locale: "ru",
      retireCanonicalKnowledge: false,
    });
  });

  it("leaves search data alone for a draft save without a status", async () => {
    const response = await put({ title: "Refunds v2", locale: "en" });

    expect(response.status).toBe(200);
    expect(mockRemoveUnpublishedKBContentFromSearch).not.toHaveBeenCalled();
  });

  it("deletes the canonical chunks of a deleted article before dropping cached retrieval results", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/kb/article-1", { method: "DELETE" }),
      params
    );

    expect(response.status).toBe(200);
    expect(mockRetireKbArticleCanonicalKnowledge).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      articleId: "article-1",
    });
    expect(events).toEqual(["retire-canonical", "invalidate-retrieval-cache"]);
  });
});
