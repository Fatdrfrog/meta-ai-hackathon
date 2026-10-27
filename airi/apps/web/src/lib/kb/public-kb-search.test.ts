const mockRpc = jest.fn();
const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

jest.mock("@/lib/cache", () => ({
  buildCacheKey: (namespace: string, parts: unknown[]) =>
    `${namespace}:${parts.join(":")}`,
  cache: {
    get: (...args: unknown[]) => mockCacheGet(...args),
    set: (...args: unknown[]) => mockCacheSet(...args),
  },
}));

import {
  normalizePublicKBSearchLimit,
  normalizePublicKBSearchQuery,
  searchPublicKBArticles,
} from "./public-kb-search";

describe("public KB search", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCacheGet.mockResolvedValue(null);
    mockRpc.mockResolvedValue({ data: [], error: null });
  });

  it("normalizes search input and bounds result limits", () => {
    expect(normalizePublicKBSearchQuery("  refund\n policy  ")).toBe(
      "refund policy"
    );
    expect(normalizePublicKBSearchQuery("a".repeat(140))).toHaveLength(120);
    expect(normalizePublicKBSearchLimit("0")).toBe(1);
    expect(normalizePublicKBSearchLimit("200")).toBe(20);
    expect(normalizePublicKBSearchLimit("bad")).toBe(8);
  });

  it("skips the database for short queries", async () => {
    await expect(
      searchPublicKBArticles({
        companySlug: "airichat",
        query: "r",
      })
    ).resolves.toEqual([]);

    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("maps ranked database rows into public article links", async () => {
    mockRpc.mockResolvedValue({
      error: null,
      data: [
        {
          id: "article-1",
          title: "Refund policy",
          excerpt: "Before <b>refund</b> after",
          article_url: "/airichat/kb/article-1",
          published_at: "2026-07-01T00:00:00.000Z",
          updated_at: "2026-07-02T00:00:00.000Z",
          locale: "en",
        },
      ],
    });

    await expect(
      searchPublicKBArticles({
        companySlug: "airichat",
        query: " refund ",
        locale: "en",
        limit: 4,
      })
    ).resolves.toEqual([
      {
        id: "article-1",
        title: "Refund policy",
        excerpt: "Before refund after",
        href: "/airichat/kb/article-1?locale=en",
        publishedAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-02T00:00:00.000Z",
        locale: "en",
      },
    ]);

    expect(mockRpc).toHaveBeenCalledWith("search_public_kb_articles", {
      p_company_slug: "airichat",
      p_query: "refund",
      p_locale: "en",
      p_limit: 4,
    });
    expect(mockCacheSet).toHaveBeenCalled();
  });

  it("links search results to the resolved public locale", async () => {
    mockRpc.mockResolvedValue({
      error: null,
      data: [
        {
          id: "article-1",
          title: "Q/A",
          excerpt: "",
          article_url: "/airichat/kb/article-1",
          published_at: "2026-07-01T00:00:00.000Z",
          updated_at: "2026-07-02T00:00:00.000Z",
          locale: "ru",
        },
      ],
    });

    await expect(
      searchPublicKBArticles({
        companySlug: "airichat",
        query: "Demosh",
        locale: "en",
      })
    ).resolves.toMatchObject([
      {
        title: "Q/A",
        href: "/airichat/kb/article-1?locale=ru",
        locale: "ru",
      },
    ]);
  });
});
