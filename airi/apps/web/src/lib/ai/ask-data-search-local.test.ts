const mockConnectDB = jest.fn();
const mockSearchConversationContext = jest.fn();
const mockGetQueryEmbeddingWithCache = jest.fn();
const mockRetrieveWorkspaceKbArticleSources = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("./conversation-context-search", () => ({
  searchConversationContext: (...args: unknown[]) =>
    mockSearchConversationContext(...args),
}));

jest.mock("./embeddings", () => ({
  getQueryEmbeddingWithCache: (...args: unknown[]) =>
    mockGetQueryEmbeddingWithCache(...args),
}));

jest.mock("@/lib/airi/rag/workspace-knowledge", () => ({
  retrieveWorkspaceKbArticleSources: (...args: unknown[]) =>
    mockRetrieveWorkspaceKbArticleSources(...args),
}));

import { searchAskDataContextLocal } from "./ask-data-search-local";
import {
  getWorkspaceTextAiAction,
  withWorkspaceTextAiAction,
} from "./workspace-ai-policy";

describe("searchAskDataContextLocal", () => {
  it("stops waiting for a shared embedding on cancellation without starting conversation search", async () => {
    const controller = new AbortController();
    let finish!: (value: number[]) => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    mockGetQueryEmbeddingWithCache.mockImplementationOnce(
      () =>
        new Promise<number[]>(resolve => {
          finish = resolve;
          markStarted();
        })
    );
    const work = searchAskDataContextLocal({
      workspaceId: "workspace-1",
      query: "pricing",
      includeKnowledge: false,
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await expect(work).rejects.toBe(controller.signal.reason);
    finish([0.1]);
    expect(mockSearchConversationContext).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockGetQueryEmbeddingWithCache.mockResolvedValue([0.1, 0.2]);
    mockSearchConversationContext.mockResolvedValue({
      conversations: [],
      metadata: {
        retrievalPath: "none",
        vectorIndex: "vector_search_conversations_v2",
        vectorConversationCount: 0,
        fallbackConversationCount: 0,
      },
    });
    mockRetrieveWorkspaceKbArticleSources.mockResolvedValue([]);
  });

  it("invokes conversation context search with the selected sources", async () => {
    const result = await searchAskDataContextLocal({
      workspaceId: "workspace-1",
      query: "pricing",
      sourceIds: ["source-1"],
      includeKnowledge: false,
    });

    expect(mockConnectDB).toHaveBeenCalledTimes(1);
    expect(mockGetQueryEmbeddingWithCache).toHaveBeenCalledWith("pricing", {
      workspaceId: "workspace-1",
      actionId: expect.stringMatching(/^ask-data:/),
    });
    expect(mockSearchConversationContext).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      query: "pricing",
      limit: 5,
      sourceIds: ["source-1"],
      queryEmbedding: [0.1, 0.2],
    });
    expect(mockRetrieveWorkspaceKbArticleSources).not.toHaveBeenCalled();
    expect(result).toEqual({
      conversations: [],
      kbArticles: [],
      metadata: {
        retrievalPath: "none",
        vectorIndex: "vector_search_conversations_v2",
        vectorConversationCount: 0,
        fallbackConversationCount: 0,
      },
    });
  });

  it("preserves fail-soft fallback results and metadata", async () => {
    mockSearchConversationContext.mockResolvedValue({
      conversations: [
        {
          id: "conversation-1",
          summary: "Customer asked about pricing.",
          category: "Pricing",
          priority: "medium",
          createdAt: "2026-06-12T00:00:00.000Z",
        },
      ],
      metadata: {
        retrievalPath: "fallback_keyword_recent",
        vectorIndex: "vector_search_conversations_v2",
        vectorConversationCount: 0,
        fallbackConversationCount: 1,
      },
    });

    const result = await searchAskDataContextLocal({
      workspaceId: "workspace-1",
      query: "pricing",
      includeKnowledge: false,
    });

    expect(result.conversations).toEqual([
      expect.objectContaining({
        id: "conversation-1",
        summary: "Customer asked about pricing.",
      }),
    ]);
    expect(result.metadata).toEqual({
      retrievalPath: "fallback_keyword_recent",
      vectorIndex: "vector_search_conversations_v2",
      vectorConversationCount: 0,
      fallbackConversationCount: 1,
    });
  });

  it("passes unavailable embeddings to conversation context search", async () => {
    mockGetQueryEmbeddingWithCache.mockResolvedValue(null);
    mockSearchConversationContext.mockResolvedValue({
      conversations: [
        {
          id: "conversation-1",
          summary: "Customer asked about delivery timing.",
        },
      ],
      metadata: {
        retrievalPath: "embedding_unavailable",
        vectorIndex: null,
        vectorConversationCount: 0,
        fallbackConversationCount: 1,
      },
    });

    const result = await searchAskDataContextLocal({
      workspaceId: "workspace-1",
      query: "delivery",
      includeKnowledge: false,
    });

    expect(mockSearchConversationContext).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      query: "delivery",
      limit: 5,
      sourceIds: undefined,
      queryEmbedding: null,
    });
    expect(result.conversations).toEqual([
      expect.objectContaining({
        id: "conversation-1",
        summary: "Customer asked about delivery timing.",
      }),
    ]);
    expect(result.metadata).toEqual({
      retrievalPath: "embedding_unavailable",
      vectorIndex: null,
      vectorConversationCount: 0,
      fallbackConversationCount: 1,
    });
  });

  it("can search only knowledge sources", async () => {
    await searchAskDataContextLocal({
      workspaceId: "workspace-1",
      query: "refund",
      includeConversations: false,
      includeKnowledge: true,
      kbLimit: 2,
    });

    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockGetQueryEmbeddingWithCache).not.toHaveBeenCalled();
    expect(mockSearchConversationContext).not.toHaveBeenCalled();
    expect(mockRetrieveWorkspaceKbArticleSources).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      query: "refund",
      limit: 2,
    });
  });

  it("retains the originating action across a gateway boundary", async () => {
    const action = { workspaceId: "workspace-1", actionId: "airi-message:42" };
    await searchAskDataContextLocal({
      workspaceId: "workspace-1",
      query: "pricing",
      action,
      includeKnowledge: false,
    });
    expect(mockGetQueryEmbeddingWithCache).toHaveBeenCalledWith(
      "pricing",
      action
    );
  });

  it("keeps knowledge and conversation retrieval in the same gateway action", async () => {
    const action = { workspaceId: "workspace-1", actionId: "airi-message:42" };
    let knowledgeAction: ReturnType<typeof getWorkspaceTextAiAction>;
    mockRetrieveWorkspaceKbArticleSources.mockImplementationOnce(async () => {
      knowledgeAction = getWorkspaceTextAiAction();
      return [];
    });
    await searchAskDataContextLocal({
      workspaceId: "workspace-1",
      query: "pricing",
      action,
    });
    expect(knowledgeAction).toEqual(action);
  });

  it("preserves the ambient semantic action over a same-workspace fallback", async () => {
    const action = { workspaceId: "workspace-1", actionId: "airi-message:42" };
    await withWorkspaceTextAiAction(action, () =>
      searchAskDataContextLocal({
        workspaceId: "workspace-1",
        query: "pricing",
        includeKnowledge: false,
        action: { workspaceId: "workspace-1", actionId: "fallback-search" },
      })
    );
    expect(mockGetQueryEmbeddingWithCache).toHaveBeenCalledWith(
      "pricing",
      action
    );
  });

  it("rejects an action from another workspace before data or provider access", async () => {
    await expect(
      searchAskDataContextLocal({
        workspaceId: "workspace-1",
        query: "pricing",
        action: { workspaceId: "workspace-2", actionId: "airi-message:42" },
      })
    ).rejects.toThrow("An AI action cannot change workspace.");
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockGetQueryEmbeddingWithCache).not.toHaveBeenCalled();
    expect(mockRetrieveWorkspaceKbArticleSources).not.toHaveBeenCalled();
  });
});
