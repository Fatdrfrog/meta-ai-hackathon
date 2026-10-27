const mockResolveAuthorizedWidgetSource = jest.fn();
const mockGetCompanySlugByWorkspaceId = jest.fn();
const mockVisitorFrom = jest.fn();
const mockVisitorRpc = jest.fn();
const mockWidgetLoggerError = jest.fn();
const mockSupabaseAdmin = { client: "server" };

jest.mock("@/lib/widget/source-context", () => ({
  resolveAuthorizedWidgetSource: (...args: unknown[]) =>
    mockResolveAuthorizedWidgetSource(...args),
}));

jest.mock("@/lib/kb/get-company-slug", () => ({
  getCompanySlugByWorkspaceId: (...args: unknown[]) =>
    mockGetCompanySlugByWorkspaceId(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  get supabaseAdmin() {
    return mockSupabaseAdmin;
  },
}));

// Widget visitors have no Airi session: the cookie client is anon, which can
// read published KB rows but not companies.
jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (...args: unknown[]) => mockVisitorFrom(...args),
    rpc: (...args: unknown[]) => mockVisitorRpc(...args),
  }),
}));

jest.mock("@/lib/logger", () => ({
  widgetLogger: {
    error: (...args: unknown[]) => mockWidgetLoggerError(...args),
    rateLimitExceeded: jest.fn(),
  },
}));

jest.mock("@icecore/shared/lib/rate-limiter", () => ({
  createRateLimiter: () => ({}),
  checkRateLimit: async () => ({ success: true, limit: 30, remaining: 29 }),
  rateLimitPresets: { widgetConfig: {} },
}));

import { NextRequest } from "next/server";
import { GET as getCollectionArticles } from "./collections/[collectionId]/articles/route";
import { GET as getCollections } from "./collections/route";
import { GET as searchHelp } from "./search/route";

type QueryResult = { data: unknown; error: unknown };

function visitorQuery(table: string) {
  const anonDenied: QueryResult = {
    data: null,
    error: { code: "42501", message: `permission denied for table ${table}` },
  };
  const list: QueryResult =
    table === "kb_articles"
      ? {
          data: [{ id: "collection-1", title: "Guides", sort_order: 1 }],
          error: null,
        }
      : anonDenied;
  const single: QueryResult =
    table === "kb_articles"
      ? {
          data: { id: "collection-1", workspace_id: "workspace-1" },
          error: null,
        }
      : anonDenied;
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "not", "is", "in", "ilike", "or"]) {
    query[method] = () => query;
  }
  query.order = () => query;
  query.limit = () => query;
  query.single = async () => single;
  query.maybeSingle = async () => single;
  query.then = (
    resolve: (value: QueryResult) => unknown,
    reject: (reason: unknown) => unknown
  ) => Promise.resolve(list).then(resolve, reject);
  return query;
}

function widgetRequest(path: string) {
  return new NextRequest(`https://www.airi.chat${path}`, {
    headers: { origin: "https://shop.example" },
  });
}

describe("widget help center links", () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.NEXT_PUBLIC_APP_URL;
    mockResolveAuthorizedWidgetSource.mockResolvedValue({
      ok: true,
      source: {
        id: "source-1",
        workspace_id: "workspace-1",
        company_id: "company-1",
        credentials: {},
      },
      credentials: {},
      origin: "https://shop.example",
    });
    mockGetCompanySlugByWorkspaceId.mockResolvedValue("acme");
    mockVisitorFrom.mockImplementation((table: string) => visitorQuery(table));
    mockVisitorRpc.mockResolvedValue({
      data: [{ id: "collection-1", title: "Guides", article_count: 2 }],
      error: null,
    });
  });

  afterAll(() => {
    if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
  });

  function expectServerSlugLookup() {
    expect(mockGetCompanySlugByWorkspaceId).toHaveBeenCalledWith(
      mockSupabaseAdmin,
      "workspace-1"
    );
    expect(mockVisitorFrom).not.toHaveBeenCalledWith("companies");
  }

  it("builds collection links with the company slug resolved on the server", async () => {
    const response = await getCollections(
      widgetRequest("/api/widget/help/collections?client_key=widget_test")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      collections: [
        {
          id: "collection-1",
          title: "Guides",
          description: null,
          articleCount: 2,
          url: "https://www.airi.chat/acme/kb/collection-1",
        },
      ],
    });
    expectServerSlugLookup();
  });

  it("builds collection article links with the company slug resolved on the server", async () => {
    const response = await getCollectionArticles(
      widgetRequest(
        "/api/widget/help/collections/collection-1/articles?client_key=widget_test"
      ),
      { params: Promise.resolve({ collectionId: "collection-1" }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      articles: [
        {
          id: "collection-1",
          title: "Guides",
          url: "https://www.airi.chat/acme/kb/collection-1",
        },
      ],
      nextCursor: null,
    });
    expectServerSlugLookup();
  });

  it("builds search result links with the company slug resolved on the server", async () => {
    const response = await searchHelp(
      widgetRequest("/api/widget/help/search?client_key=widget_test&q=gu")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      results: [
        {
          id: "collection-1",
          title: "Guides",
          url: "https://www.airi.chat/acme/kb/collection-1",
        },
      ],
    });
    expectServerSlugLookup();
  });

  it("still reports a configuration error when the workspace has no company slug", async () => {
    mockGetCompanySlugByWorkspaceId.mockResolvedValue(null);

    const response = await searchHelp(
      widgetRequest("/api/widget/help/search?client_key=widget_test&q=gu")
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Configuration error",
    });
  });
});
