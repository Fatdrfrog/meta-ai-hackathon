const mockAdminFrom = jest.fn();
const mockArticleFilters = jest.fn();
const mockArticleResult = jest.fn();
const mockCreateReadOnlyClient = jest.fn();

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockAdminFrom(...args),
  },
}));

// Crawlers are anonymous: the session client is anon, which cannot read the
// workspaces and companies that hold the public KB slug.
jest.mock("@/lib/supabase/server", () => ({
  createReadOnlyClient: (...args: unknown[]) =>
    mockCreateReadOnlyClient(...args),
}));

jest.mock("@/lib/public-seo", () => ({
  PUBLIC_MARKETING_ROUTES: [
    { path: "/", changeFrequency: "weekly", priority: 1 },
  ],
  getPublicUrl: (path: string) =>
    `https://www.airi.chat${path === "/" ? "" : path}`,
}));

import sitemap from "./sitemap";
import { PUBLIC_MARKETING_ROUTES } from "@/lib/public-seo";

const mockMarketingRoutes = PUBLIC_MARKETING_ROUTES as Array<{
  path: string;
  changeFrequency: string;
  priority: number;
}>;

function articleQuery() {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "not", "lte"]) {
    query[method] = (...args: unknown[]) => {
      mockArticleFilters(method, ...args);
      return query;
    };
  }
  query.order = (...args: unknown[]) => {
    mockArticleFilters("order", ...args);
    return mockArticleResult();
  };
  return query;
}

describe("sitemap", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAdminFrom.mockImplementation(() => articleQuery());
    mockMarketingRoutes.splice(1);
  });

  it("includes all canonical localized template pages even if the KB read fails", async () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mockMarketingRoutes.push({
      path: "/whatsapp-templates",
      changeFrequency: "weekly",
      priority: 0.9,
    });
    mockArticleResult.mockResolvedValue({
      data: null,
      error: { message: "offline" },
    });
    const entries = await sitemap();
    const templates = entries.filter(entry =>
      entry.url.includes("/whatsapp-templates")
    );
    expect(templates).toHaveLength(189);
    expect(templates.every(entry => entry.alternates?.languages?.kk)).toBe(
      true
    );
    expect(templates.every(entry => entry.lastModified === undefined)).toBe(
      true
    );
    consoleError.mockRestore();
  });

  it("lists product pages in every language", async () => {
    mockMarketingRoutes.push({
      path: "/mcp",
      changeFrequency: "monthly",
      priority: 0.8,
    });
    mockArticleResult.mockResolvedValue({ data: [], error: null });

    const urls = (await sitemap()).map(entry => entry.url);

    expect(urls).toEqual(
      expect.arrayContaining([
        "https://www.airi.chat/mcp",
        "https://www.airi.chat/mcp?locale=ru",
        "https://www.airi.chat/mcp?locale=kz",
      ])
    );
  });

  it("lists airi.chat's own published help-center articles without the anonymous client", async () => {
    mockArticleResult.mockResolvedValue({
      data: [
        {
          id: "article-1",
          published_at: "2026-09-01T00:00:00.000Z",
          updated_at: "2026-09-02T00:00:00.000Z",
          workspaces: { companies: { slug: "airichat" } },
        },
        {
          id: "article-2",
          published_at: "2026-09-03T00:00:00.000Z",
          updated_at: null,
          workspaces: [{ companies: [{ slug: "airichat" }] }],
        },
      ],
      error: null,
    });

    const entries = await sitemap();

    expect(mockCreateReadOnlyClient).not.toHaveBeenCalled();
    expect(mockAdminFrom).toHaveBeenCalledWith("kb_articles");
    expect(mockArticleFilters).toHaveBeenCalledWith(
      "eq",
      "workspaces.companies.slug",
      "airichat"
    );
    expect(entries.map(entry => entry.url)).toEqual([
      "https://www.airi.chat",
      "https://www.airi.chat/airichat/kb/article-1",
      "https://www.airi.chat/airichat/kb/article-2",
    ]);
    expect(entries[1]?.lastModified).toEqual(
      new Date("2026-09-02T00:00:00.000Z")
    );
  });

  // Regression: customers' help centers (grants guides, test workspaces,
  // shop FAQs) were listed as airi.chat pages in production.
  it("never lists a customer's help-center article", async () => {
    mockArticleResult.mockResolvedValue({
      data: [
        {
          id: "tenant-article",
          published_at: "2026-09-01T00:00:00.000Z",
          updated_at: null,
          workspaces: { companies: { slug: "test12" } },
        },
      ],
      error: null,
    });

    const entries = await sitemap();

    expect(entries.map(entry => entry.url)).toEqual(["https://www.airi.chat"]);
  });

  it("keeps the public visibility rule because the server read bypasses RLS", async () => {
    mockArticleResult.mockResolvedValue({ data: [], error: null });

    await sitemap();

    expect(mockArticleFilters).toHaveBeenCalledWith(
      "eq",
      "status",
      "published"
    );
    expect(mockArticleFilters).toHaveBeenCalledWith(
      "not",
      "published_at",
      "is",
      null
    );
    const lteCall = mockArticleFilters.mock.calls.find(
      ([method]) => method === "lte"
    );
    expect(lteCall?.[1]).toBe("published_at");
    expect(Date.parse(String(lteCall?.[2]))).not.toBeNaN();
    expect(Date.parse(String(lteCall?.[2]))).toBeLessThanOrEqual(Date.now());
  });

  it("falls back to the marketing pages when the KB read fails", async () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mockArticleResult.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "permission denied" },
    });

    const entries = await sitemap();

    expect(entries.map(entry => entry.url)).toEqual(["https://www.airi.chat"]);
    consoleError.mockRestore();
  });
});
