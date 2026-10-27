const mockSupabaseAdminFrom = jest.fn();
const mockSupabaseAdminRpc = jest.fn();

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseAdminFrom(...args),
    rpc: (...args: unknown[]) => mockSupabaseAdminRpc(...args),
  },
}));

import { GET, POST } from "./route";

function createArticleQuery({
  data = { id: "article-1" },
  error = null,
}: {
  data?: unknown;
  error?: unknown;
} = {}) {
  const chain: Record<string, jest.Mock> = {
    select: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    not: jest.fn(() => chain),
    maybeSingle: jest.fn(async () => ({ data, error })),
  };
  return chain;
}

describe("POST /api/kb/[articleId]/views", () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockSupabaseAdminFrom.mockReturnValue(createArticleQuery());
    mockSupabaseAdminRpc.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("records views for published public articles", async () => {
    const response = await POST(
      new Request("http://localhost/api/kb/a/views"),
      {
        params: Promise.resolve({ articleId: "article-1" }),
      }
    );

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      recorded: true,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mockSupabaseAdminFrom).toHaveBeenCalledWith("kb_articles");
    expect(mockSupabaseAdminRpc).toHaveBeenCalledWith("kb_increment_view", {
      p_article_id: "article-1",
      p_day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });

  it("returns 404 and skips the counter for non-public articles", async () => {
    mockSupabaseAdminFrom.mockReturnValue(createArticleQuery({ data: null }));

    const response = await POST(
      new Request("http://localhost/api/kb/a/views"),
      {
        params: Promise.resolve({ articleId: "missing-article" }),
      }
    );

    await expect(response.json()).resolves.toMatchObject({
      error: "Article not found",
    });
    expect(response.status).toBe(404);
    expect(mockSupabaseAdminRpc).not.toHaveBeenCalled();
  });

  it("does not surface counter write failures as public article failures", async () => {
    mockSupabaseAdminRpc.mockResolvedValue({
      error: new Error("counter unavailable"),
    });

    const response = await POST(
      new Request("http://localhost/api/kb/a/views"),
      {
        params: Promise.resolve({ articleId: "article-1" }),
      }
    );

    await expect(response.json()).resolves.toMatchObject({
      success: false,
      recorded: false,
    });
    expect(response.status).toBe(202);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[KB Views] Failed to record article view:",
      expect.any(Error)
    );
  });
});

describe("GET /api/kb/[articleId]/views", () => {
  it("returns an explicit method response for direct browser visits", async () => {
    const response = await GET();

    await expect(response.json()).resolves.toMatchObject({
      error: "Method not allowed. Use POST to record a view.",
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});
