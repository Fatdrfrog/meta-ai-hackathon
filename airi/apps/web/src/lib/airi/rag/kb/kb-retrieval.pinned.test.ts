const mockIn = jest.fn();
const mockQuery = {
  select: jest.fn(),
  eq: jest.fn(),
  in: (...args: unknown[]) => mockIn(...args),
};
mockQuery.select.mockReturnValue(mockQuery);
mockQuery.eq.mockReturnValue(mockQuery);

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: jest.fn(() => mockQuery) },
}));
jest.mock("@/lib/ai", () => ({ getQueryEmbeddingWithCache: jest.fn() }));
jest.mock("@/lib/kb/article-url", () => ({
  fetchArticleURLData: jest.fn(async () => new Map()),
  generateArticleURL: jest.fn(() => null),
}));

import { retrievePinnedKBArticles } from "./kb-retrieval";

const ARTICLE_ID = "3f0c8a52-6a5e-4c1f-9f0e-1c2d3e4f5a6b";

describe("retrievePinnedKBArticles", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIn.mockResolvedValue({
      data: [
        {
          id: ARTICLE_ID,
          title: "Delivery",
          kb_article_versions: [
            { content_mdx: "Delivery takes 2 days.", version: 1 },
          ],
        },
      ],
      error: null,
    });
  });

  // One Mongo-style id made Postgres reject the whole query (invalid input
  // syntax for type uuid), so no pinned article reached the reply.
  it("queries only UUID ids and keeps the valid pinned article", async () => {
    const results = await retrievePinnedKBArticles("ws_1", [
      "64b7f0c2a1b2c3d4e5f60718",
      ARTICLE_ID,
      "",
    ]);

    expect(mockIn).toHaveBeenCalledWith("id", [ARTICLE_ID]);
    expect(results.map(result => result.id)).toEqual([ARTICLE_ID]);
  });

  it("skips the query when no pinned id is a UUID", async () => {
    await expect(
      retrievePinnedKBArticles("ws_1", ["64b7f0c2a1b2c3d4e5f60718"])
    ).resolves.toEqual([]);
    expect(mockIn).not.toHaveBeenCalled();
  });
});
