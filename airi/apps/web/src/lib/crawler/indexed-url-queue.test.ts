import {
  fetchIndexedUrlStatusRows,
  markIndexedUrlRowsFailed,
  markIndexedUrlRowsPending,
  type IndexedUrlClient,
} from "@/lib/crawler/indexed-url-queue";

function createIndexedUrlClient(params: {
  selectError?: { message?: string } | null;
  upsertError?: { message?: string } | null;
}): IndexedUrlClient {
  return {
    from: () => ({
      select: () => ({
        eq: async () => ({
          data: [],
          error: params.selectError ?? null,
        }),
      }),
      upsert: async () => ({
        error: params.upsertError ?? null,
      }),
    }),
  };
}

describe("indexed URL queue", () => {
  it("throws real Error instances for status-row Supabase errors", async () => {
    await expect(
      fetchIndexedUrlStatusRows(
        createIndexedUrlClient({
          selectError: { message: "permission denied" },
        }),
        "company-1"
      )
    ).rejects.toThrow("permission denied");
  });

  it("throws real Error instances for pending upsert Supabase errors", async () => {
    await expect(
      markIndexedUrlRowsPending({
        client: createIndexedUrlClient({
          upsertError: { message: "RLS blocked pending write" },
        }),
        companyId: "company-1",
        websites: ["https://example.com"],
      })
    ).rejects.toThrow("RLS blocked pending write");
  });

  it("does not silently ignore failed-status upsert errors", async () => {
    await expect(
      markIndexedUrlRowsFailed({
        client: createIndexedUrlClient({
          upsertError: { message: "RLS blocked failed write" },
        }),
        companyId: "company-1",
        websites: ["https://example.com"],
        message: "crawl failed",
      })
    ).rejects.toThrow("RLS blocked failed write");
  });
});
