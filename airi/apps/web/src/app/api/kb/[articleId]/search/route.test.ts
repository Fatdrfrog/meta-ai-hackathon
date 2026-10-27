jest.mock("@/lib/ai", () => ({ getQueryEmbeddingWithCache: jest.fn() }));
jest.mock("@/lib/cache", () => ({
  buildCacheKey: (prefix: string, parts: string[]) =>
    [prefix, ...parts].join(":"),
  cache: { get: jest.fn(async () => null), set: jest.fn() },
}));
jest.mock("@/lib/kb/article-access", () => ({
  requireKBRouteAccess: jest.fn(),
  getAccessibleKBArticle: jest.fn(),
}));
jest.mock("@/lib/supabase/server", () => ({ createClient: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { rpc: jest.fn() },
}));

import { getQueryEmbeddingWithCache } from "@/lib/ai";
import {
  getAccessibleKBArticle,
  requireKBRouteAccess,
} from "@/lib/kb/article-access";
import { createClient } from "@/lib/supabase/server";
import { GET } from "./route";

beforeEach(() => {
  jest.clearAllMocks();
  (requireKBRouteAccess as jest.Mock).mockResolvedValue({
    ok: true,
    workspaceIds: ["workspace-a"],
  });
  (getAccessibleKBArticle as jest.Mock).mockResolvedValue({
    workspace_id: "workspace-a",
  });
  (getQueryEmbeddingWithCache as jest.Mock).mockResolvedValue(null);
  const query = {
    select: () => query,
    eq: () => query,
    textSearch: () => query,
    limit: async () => ({ data: [], error: null }),
  };
  (createClient as jest.Mock).mockResolvedValue({ from: () => query });
});

it("uses the accessible article workspace for metered search", async () => {
  const response = await GET(
    new Request("http://localhost/api/kb/article-1/search?q=refund"),
    { params: Promise.resolve({ articleId: "article-1" }) }
  );
  expect(response.status).toBe(200);
  expect(getQueryEmbeddingWithCache).toHaveBeenCalledWith("refund", {
    workspaceId: "workspace-a",
    actionId: expect.stringMatching(/^kb-search:/),
  });
});

it("does not start paid work for an inaccessible article", async () => {
  (getAccessibleKBArticle as jest.Mock).mockResolvedValue(null);
  const response = await GET(
    new Request("http://localhost/api/kb/article-1/search?q=refund"),
    { params: Promise.resolve({ articleId: "article-1" }) }
  );
  expect(response.status).toBe(200);
  expect(getQueryEmbeddingWithCache).not.toHaveBeenCalled();
});
