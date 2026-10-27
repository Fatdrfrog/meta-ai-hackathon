jest.mock("@/lib/ai", () => ({
  getDocumentEmbeddingResult: jest.fn(),
  getCurrentEmbeddingMetadata: jest.fn(() => ({
    embeddingProvider: "vertex",
    embeddingModel: "gemini-embedding-001",
    embeddingTaskType: "RETRIEVAL_DOCUMENT",
    embeddingDimensions: 1536,
  })),
}));
jest.mock("@/lib/crawler/url-safety", () => ({ safeCrawlFetch: jest.fn() }));
jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentials: jest.fn(),
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: jest.fn() },
}));

import { getDocumentEmbeddingResult } from "@/lib/ai";
import { safeCrawlFetch } from "./url-safety";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { runWebsiteCrawl } from "./website-crawl-runner";
import { indexExternalUrl } from "@/lib/kb/url-indexer";

const embed = jest.mocked(getDocumentEmbeddingResult);
const fetchPage = jest.mocked(safeCrawlFetch);
let html: string;
let workspaceExists: boolean;
let storedUrl: Record<string, unknown> | null;
const upsert = jest.fn();
const filters = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  html = `<html><head><title>Products</title></head><body><main>${"Product information. ".repeat(25)}</main></body></html>`;
  workspaceExists = true;
  storedUrl = null;
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    if (table === "kb_indexed_urls") {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: storedUrl, error: null }),
        upsert,
      };
      return query;
    }
    if (table !== "workspaces") throw new Error(`Unexpected table ${table}`);
    const query = {
      select: () => query,
      eq: (...args: unknown[]) => {
        filters(...args);
        return query;
      },
      maybeSingle: async () => ({
        data: workspaceExists
          ? { id: "workspace-a", company_id: "company-a" }
          : null,
        error: null,
      }),
    };
    return query;
  });
  upsert.mockImplementation(async row => {
    storedUrl = { ...storedUrl, ...row };
    return { error: null };
  });
  fetchPage.mockImplementation(
    async url =>
      new Response(String(url).endsWith("sitemap.xml") ? "<urlset />" : html, {
        headers: { "content-type": "text/html" },
      })
  );
  embed.mockResolvedValue({
    embedding: [1, ...new Array<number>(1535).fill(0)],
    provider: "vertex",
    model: "gemini-embedding-001",
    dimensions: 1536,
    taskType: "RETRIEVAL_DOCUMENT",
  });
});

it("uses a durable source-content action on crawl retries and separates changed content", async () => {
  const input = {
    workspaceId: "workspace-a",
    websites: ["https://example.com"],
    maxPagesPerSite: 1,
  };
  const first = await runWebsiteCrawl(input);
  await runWebsiteCrawl(input);
  html = html.replace("Products", "Changed Products");
  await runWebsiteCrawl(input);
  expect(first.seeds[0]?.status).toBe("completed");
  const actions = embed.mock.calls.map(call => call[1]?.action);
  expect(actions[0]).toEqual({
    workspaceId: "workspace-a",
    actionId: expect.stringMatching(/^url-index:[a-f0-9]{64}$/),
  });
  expect(actions).toHaveLength(2);
  expect(actions[1]).not.toEqual(actions[0]);
});

it("reuses a persisted crawl result when the outer job acknowledgement is lost", async () => {
  const input = {
    workspaceId: "workspace-a",
    websites: ["https://example.com"],
    maxPagesPerSite: 1,
  };
  await runWebsiteCrawl(input);
  embed.mockClear();
  embed.mockRejectedValue(new Error("Paid operation already reserved"));
  const retry = await runWebsiteCrawl(input);
  expect(retry.seeds[0]?.status).toBe("completed");
  expect(embed).not.toHaveBeenCalled();
  expect(storedUrl?.embedding_fingerprint).toMatch(/^[a-f0-9]{64}$/);
});

it("does not claim historical URL vectors as a known result without a fingerprint", async () => {
  storedUrl = {
    embedding: [1, ...new Array<number>(1535).fill(0)],
    index_status: "indexed",
  };
  await indexExternalUrl("company-a", "https://example.com", "workspace-a");
  expect(embed).toHaveBeenCalledTimes(1);
  expect(storedUrl?.embedding_fingerprint).toMatch(/^[a-f0-9]{64}$/);
});

it("rejects company/workspace mismatches before URL fetching or embedding", async () => {
  workspaceExists = false;
  const result = await indexExternalUrl(
    "company-a",
    "https://example.com",
    "workspace-b"
  );
  expect(result.success).toBe(false);
  expect(result.error).toBe("Workspace does not belong to the company");
  expect(filters).toHaveBeenCalledWith("id", "workspace-b");
  expect(filters).toHaveBeenCalledWith("company_id", "company-a");
  expect(fetchPage).not.toHaveBeenCalled();
  expect(embed).not.toHaveBeenCalled();
});

it("binds standalone URL indexing to its verified workspace", async () => {
  const result = await indexExternalUrl(
    "company-a",
    "https://example.com",
    "workspace-a"
  );
  expect(result.success).toBe(true);
  expect(embed.mock.calls[0]?.[1]?.action).toEqual({
    workspaceId: "workspace-a",
    actionId: expect.stringMatching(/^url-index:[a-f0-9]{64}$/),
  });
});

it("does not persist a current fingerprint for a result from a different model", async () => {
  embed.mockResolvedValue({
    embedding: [1, ...new Array<number>(1535).fill(0)],
    provider: "vertex",
    model: "unexpected-model",
    dimensions: 1536,
    taskType: "RETRIEVAL_DOCUMENT",
  });
  const result = await indexExternalUrl(
    "company-a",
    "https://example.com",
    "workspace-a"
  );
  expect(result.success).toBe(false);
  expect(storedUrl?.embedding_fingerprint).toBeUndefined();
});
