const mockRequireKBRouteAccess = jest.fn();
const mockGetAccessibleKBArticle = jest.fn();
const mockGetKBLocalizationSourceContent = jest.fn();
const mockRemoveUnpublishedKBContentFromSearch = jest.fn();
const mockCreateClient = jest.fn();

jest.mock("@/lib/kb/article-access", () => ({
  requireKBRouteAccess: (...args: unknown[]) =>
    mockRequireKBRouteAccess(...args),
  getAccessibleKBArticle: (...args: unknown[]) =>
    mockGetAccessibleKBArticle(...args),
}));

jest.mock("@/lib/kb/kb-localization-server", () => ({
  getKBLocalizationSourceContent: (...args: unknown[]) =>
    mockGetKBLocalizationSourceContent(...args),
  removeUnpublishedKBContentFromSearch: (...args: unknown[]) =>
    mockRemoveUnpublishedKBContentFromSearch(...args),
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

import { POST } from "./route";

function createQueryChain(result: { data?: unknown; error?: unknown }) {
  const chain: Record<string, unknown> = {};
  chain.select = jest.fn(() => chain);
  chain.eq = jest.fn(() => chain);
  chain.in = jest.fn(() => chain);
  chain.update = jest.fn(() => chain);
  chain.upsert = jest.fn(async () => ({ error: null }));
  chain.then = (
    resolve: (value: unknown) => unknown,
    reject: (reason: unknown) => unknown
  ) =>
    Promise.resolve({ data: null, error: null, ...result }).then(
      resolve,
      reject
    );
  return chain;
}

function createSupabase() {
  return {
    from: jest.fn((table: string) =>
      table === "kb_article_localizations"
        ? createQueryChain({
            data: [
              { locale: "en", status: "published" },
              { locale: "ru", status: "published" },
            ],
          })
        : createQueryChain({})
    ),
  };
}

function unpublish(locale: string) {
  return POST(new Request("http://localhost/api/kb", { method: "POST" }), {
    params: Promise.resolve({ articleId: "article-1", locale }),
  });
}

describe("POST /api/kb/[articleId]/localizations/[locale]/unpublish", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateClient.mockResolvedValue(createSupabase());
    mockRequireKBRouteAccess.mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
      workspaceIds: ["workspace-1"],
    });
    mockGetAccessibleKBArticle.mockResolvedValue({
      id: "article-1",
      title: "Refunds",
      status: "published",
      published_at: "2026-10-01T00:00:00Z",
      workspace_id: "workspace-1",
      default_locale: "en",
      draft_title: null,
      draft_content_mdx: null,
    });
    mockGetKBLocalizationSourceContent.mockResolvedValue({
      title: "Refunds",
      contentMdx: "Refunds take five business days.",
    });
    mockRemoveUnpublishedKBContentFromSearch.mockResolvedValue(undefined);
  });

  it("retires the canonical chunks when the default language is unpublished", async () => {
    const response = await unpublish("en");

    expect(response.status).toBe(200);
    expect(mockRemoveUnpublishedKBContentFromSearch).toHaveBeenCalledWith({
      articleId: "article-1",
      workspaceId: "workspace-1",
      locale: "en",
      retireCanonicalKnowledge: true,
    });
  });

  it("keeps the canonical chunks when another language is unpublished", async () => {
    const response = await unpublish("ru");

    expect(response.status).toBe(200);
    expect(mockRemoveUnpublishedKBContentFromSearch).toHaveBeenCalledWith({
      articleId: "article-1",
      workspaceId: "workspace-1",
      locale: "ru",
      retireCanonicalKnowledge: false,
    });
  });
});
