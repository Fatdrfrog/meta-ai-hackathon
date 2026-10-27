jest.mock("./vertex-embeddings", () => ({
  getVertexEmbeddingModel: () => "gemini-embedding-001",
  normalizeEmbeddingText: (text: string) => text.trim(),
  getVertexTextEmbedding: jest.fn(),
}));
jest.mock("./gcp-ai-gateway", () => ({
  canCallGcpAIGateway: jest.fn(() => false),
  getRemoteDocumentEmbeddingResult: jest.fn(),
  getRemoteQueryEmbeddingResultWithCache: jest.fn(),
}));
const mockCache = new Map<string, unknown>();
jest.mock("@/lib/cache", () => ({
  buildCacheKey: (prefix: string, parts: string[]) =>
    [prefix, ...parts].join(":"),
  cache: {
    get: async (key: string) => mockCache.get(key),
    set: async (key: string, value: unknown) => mockCache.set(key, value),
  },
}));
import {
  getDocumentEmbeddingResult,
  getDocumentEmbeddingResultsBatch,
  getQueryEmbeddingResultWithCache,
} from "./embeddings";
import {
  getWorkspaceTextAiAction,
  withWorkspaceTextAiAction,
  WorkspaceAiSourceRequiredError,
} from "./workspace-ai-policy";
import { getVertexTextEmbedding } from "./vertex-embeddings";
import {
  canCallGcpAIGateway,
  getRemoteDocumentEmbeddingResult,
} from "./gcp-ai-gateway";
import type { GeneratedEmbedding } from "./embedding-types";
import { EMBEDDING_DIMENSIONS } from "./embedding-config";
const result: GeneratedEmbedding = {
  embedding: Array(EMBEDDING_DIMENSIONS).fill(0.1),
  provider: "vertex",
  model: "gemini-embedding-001",
  dimensions: EMBEDDING_DIMENSIONS,
  taskType: "RETRIEVAL_QUERY" as const,
};
describe("embedding action ownership", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCache.clear();
    jest.mocked(canCallGcpAIGateway).mockReturnValue(false);
    jest.mocked(getVertexTextEmbedding).mockResolvedValue(result);
  });
  it("uses one explicit action for the entire document batch", async () => {
    const actions: unknown[] = [];
    jest.mocked(getVertexTextEmbedding).mockImplementation(async () => {
      actions.push(getWorkspaceTextAiAction());
      return result;
    });
    await getDocumentEmbeddingResultsBatch(
      ["first document", "second document"],
      { workspaceId: "w", actionId: "publish:1" }
    );
    expect(actions).toEqual([
      { workspaceId: "w", actionId: "publish:1" },
      { workspaceId: "w", actionId: "publish:1" },
    ]);
  });
  it("retains an existing semantic action and rejects workspace changes", async () => {
    await withWorkspaceTextAiAction(
      { workspaceId: "w", actionId: "message:1" },
      async () => {
        jest.mocked(getVertexTextEmbedding).mockImplementation(async () => {
          expect(getWorkspaceTextAiAction()?.actionId).toBe("message:1");
          return result;
        });
        await getDocumentEmbeddingResult("document", {
          action: { workspaceId: "w", actionId: "child" },
        });
        await expect(
          getDocumentEmbeddingResult("document", {
            action: { workspaceId: "other", actionId: "child" },
          })
        ).rejects.toThrow("cannot change workspace");
      }
    );
  });
  it("isolates query cache and in-flight ownership by workspace", async () => {
    await Promise.all([
      getQueryEmbeddingResultWithCache("same query", {
        workspaceId: "one",
        actionId: "1",
      }),
      getQueryEmbeddingResultWithCache("same query", {
        workspaceId: "two",
        actionId: "1",
      }),
    ]);
    expect(getVertexTextEmbedding).toHaveBeenCalledTimes(2);
    await getQueryEmbeddingResultWithCache("same query", {
      workspaceId: "one",
      actionId: "2",
    });
    expect(getVertexTextEmbedding).toHaveBeenCalledTimes(2);
  });
  it("does not hide policy denial or retry an unknown gateway outcome locally", async () => {
    jest
      .mocked(getVertexTextEmbedding)
      .mockRejectedValue(new WorkspaceAiSourceRequiredError("w"));
    await expect(
      getDocumentEmbeddingResult("document", {
        action: { workspaceId: "w", actionId: "1" },
      })
    ).rejects.toMatchObject({ code: "own_ai_source_required" });
    jest.mocked(getVertexTextEmbedding).mockClear();
    jest.mocked(canCallGcpAIGateway).mockReturnValue(true);
    jest
      .mocked(getRemoteDocumentEmbeddingResult)
      .mockRejectedValue(new Error("response lost"));
    await expect(
      getDocumentEmbeddingResult("document", {
        action: { workspaceId: "w", actionId: "2" },
      })
    ).rejects.toThrow("response lost");
    expect(getVertexTextEmbedding).not.toHaveBeenCalled();
  });
});
