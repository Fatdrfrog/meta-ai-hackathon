const mockRetrieveRelevantKBArticles = jest.fn();
const mockBuildHeuristicRagQueryPreparation = jest.fn();

jest.mock("@/lib/airi/rag/kb/kb-retrieval", () => ({
  retrieveRelevantKBArticles: (...args: unknown[]) =>
    mockRetrieveRelevantKBArticles(...args),
}));

jest.mock("@/lib/airi/rag/query/query-cleaner", () => ({
  buildHeuristicRagQueryPreparation: (...args: unknown[]) =>
    mockBuildHeuristicRagQueryPreparation(...args),
}));

import {
  retrieveWorkspaceIndexedUrlSources,
  retrieveWorkspaceKbArticleSources,
} from "./workspace-knowledge";

describe("workspace knowledge retrieval", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildHeuristicRagQueryPreparation.mockReturnValue({
      cleanedQuery: "pricing",
      subQueries: [],
      originalQuery: "pricing",
      wasCleaned: false,
      source: "fallback",
    });
  });

  it("adapts the production KB retriever for Airi workspace article context", async () => {
    mockRetrieveRelevantKBArticles.mockResolvedValue([
      {
        id: "chunk-1",
        sourceRecordId: "article-1",
        title: "Pricing",
        fullContent: "Pricing context",
        similarity: 0.82,
        sourceType: "kb_article",
        url: "https://example.com/kb/pricing",
      },
    ]);

    await expect(
      retrieveWorkspaceKbArticleSources({
        workspaceId: "workspace-1",
        query: "pricing",
        limit: 2,
      })
    ).resolves.toEqual([
      {
        id: "article-1",
        title: "Pricing",
        content: "Pricing context",
        relevance_score: 0.82,
        source_type: "article",
        url: "https://example.com/kb/pricing",
      },
    ]);

    expect(mockRetrieveRelevantKBArticles).toHaveBeenCalledWith(
      "workspace-1",
      "pricing",
      "en",
      expect.objectContaining({
        limit: 2,
        threshold: 0.72,
        enableHyDERescue: false,
        includeFullContent: false,
        matchSourceKinds: ["kb_article"],
      })
    );
    expect(mockBuildHeuristicRagQueryPreparation).toHaveBeenCalledWith(
      "pricing"
    );
  });

  it("forwards an explicit public visibility allowlist", async () => {
    mockRetrieveRelevantKBArticles.mockResolvedValue([]);

    await retrieveWorkspaceKbArticleSources({
      workspaceId: "workspace-1",
      query: "pricing",
      matchAllowedVisibilities: ["public"],
    });

    expect(mockRetrieveRelevantKBArticles).toHaveBeenCalledWith(
      "workspace-1",
      "pricing",
      "en",
      expect.objectContaining({
        matchSourceKinds: ["kb_article"],
        matchAllowedVisibilities: ["public"],
      })
    );
  });

  it("retrieves indexed URLs through the same workspace-scoped retriever", async () => {
    mockRetrieveRelevantKBArticles.mockResolvedValue([
      {
        id: "url-chunk-1",
        sourceRecordId: "url-1",
        title: "Landing page",
        fullContent: "Landing page context",
        similarity: 0.66,
        sourceType: "indexed_url",
        url: "https://example.com",
      },
    ]);

    await expect(
      retrieveWorkspaceIndexedUrlSources({
        workspaceId: "workspace-1",
        query: "landing",
        limit: 5,
      })
    ).resolves.toEqual([
      {
        id: "url-1",
        title: "Landing page",
        content: "Landing page context",
        relevance_score: 0.66,
        source_type: "external_url",
        url: "https://example.com",
      },
    ]);

    expect(mockRetrieveRelevantKBArticles).toHaveBeenCalledWith(
      "workspace-1",
      "landing",
      "en",
      expect.objectContaining({
        limit: 5,
        matchSourceKinds: ["indexed_url"],
      })
    );
  });
});
