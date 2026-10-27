import {
  buildSearchAttempts,
  tokenizeKBQuery,
} from "@/lib/airi/rag/kb/kb-query";

jest.mock("@/lib/airi/rag/query/query-cleaner", () => {
  const actual = jest.requireActual<
    typeof import("@/lib/airi/rag/query/query-cleaner")
  >("@/lib/airi/rag/query/query-cleaner");
  return {
    ...actual,
    prepareQueryForRagWithLlm: jest.fn(async (q: string) => ({
      cleanedQuery: q.trim(),
      subQueries: [] as string[],
      originalQuery: q,
      wasCleaned: false,
      source: "llm" as const,
    })),
  };
});

describe("kb-query", () => {
  it("filters common Cyrillic stop words without dropping meaningful tokens", () => {
    expect(tokenizeKBQuery("хочу узнать кто делает медаль ілгіш")).toEqual([
      "делает",
      "медаль",
      "ілгіш",
    ]);
  });

  it("keeps search attempts focused on meaningful tokens", async () => {
    await expect(
      buildSearchAttempts("хочу узнать про медаль ілгіш")
    ).resolves.toEqual(
      expect.arrayContaining([
        "хочу узнать про медаль ілгіш",
        "про медаль ілгіш",
        "медаль",
        "ілгіш",
      ])
    );
  });
});
