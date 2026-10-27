const mockAnalytics = jest.fn();
jest.mock("@/lib/llm-analytics/events", () => ({
  recordLlmTraceAnalyticsEvent: (...args: unknown[]) => mockAnalytics(...args),
}));
const mockCanUseVertexEmbeddings = jest.fn();
const mockResolveVertexEmbeddingProjectId = jest.fn();
const mockMarkVertexEmbeddingsUnavailableForRuntime = jest.fn();
const mockEmbedContent = jest.fn();
const mockResolveBilling = jest.fn();
const mockReserve = jest.fn();
const mockSettle = jest.fn();
const mockCustomerClient = jest.fn();
jest.mock("./workspace-ai-policy", () => ({
  resolveWorkspaceTextAiBilling: () => mockResolveBilling(),
  reserveWorkspaceTextAiSpend: (...args: unknown[]) => mockReserve(...args),
  settleWorkspaceTextAiSpend: (...args: unknown[]) => mockSettle(...args),
}));

jest.mock("./vertex-auth", () => ({
  canUseVertexEmbeddings: () => mockCanUseVertexEmbeddings(),
  getVertexEmbeddingLocation: () => "us-central1",
  markVertexEmbeddingsUnavailableForRuntime: (...args: unknown[]) =>
    mockMarkVertexEmbeddingsUnavailableForRuntime(...args),
  resolveVertexEmbeddingProjectId: () => mockResolveVertexEmbeddingProjectId(),
}));
jest.mock("@google/genai", () => ({
  GoogleGenAI: function (options: unknown) {
    return mockCustomerClient(options);
  },
}));
jest.mock("./vertex-genai-client", () => ({
  getVertexGenAI: async () => ({
    models: { embedContent: mockEmbedContent },
  }),
}));

import {
  configureTracingAdapter,
  type TraceRequest,
} from "@/lib/observability/tracing";
import { getVertexTextEmbedding } from "./vertex-embeddings";

describe("Vertex embedding observability", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveBilling.mockResolvedValue({
      billingSource: "platform",
      workspaceId: "w",
      companyId: "c",
      actionId: "a",
    });
    mockReserve.mockResolvedValue({ operationId: "embedding" });
    mockSettle.mockResolvedValue(undefined);
    mockCustomerClient.mockReturnValue({
      models: { embedContent: mockEmbedContent },
    });
    mockCanUseVertexEmbeddings.mockReturnValue(true);
    mockResolveVertexEmbeddingProjectId.mockResolvedValue("project-1");
    mockEmbedContent.mockResolvedValue({
      embeddings: [{ values: [0.1, 0.2] }],
    });
  });

  afterEach(() => {
    configureTracingAdapter(null);
  });

  it.each(["disabled", "too_short", "project_unavailable"] as const)(
    "does not emit an embedding span when the provider attempt is %s",
    async skippedReason => {
      const requests: TraceRequest[] = [];
      configureTracingAdapter({
        trace(request, execute) {
          requests.push(request);
          return execute();
        },
        mergeMetadata() {},
        setUsage() {},
      });
      if (skippedReason === "disabled") {
        mockCanUseVertexEmbeddings.mockReturnValue(false);
      }
      if (skippedReason === "project_unavailable") {
        mockResolveVertexEmbeddingProjectId.mockResolvedValue(null);
      }

      await expect(
        getVertexTextEmbedding({
          text: skippedReason === "too_short" ? "x" : "private content",
          taskType: "RETRIEVAL_QUERY",
          dimensions: 2,
        })
      ).resolves.toBeNull();

      expect(requests).toHaveLength(0);
      expect(mockEmbedContent).not.toHaveBeenCalled();
    }
  );

  it("reserves before submission, disables SDK retries, and settles measured tokens", async () => {
    mockEmbedContent.mockImplementation(async () => {
      expect(mockReserve).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "vertex",
          model: "gemini-embedding-001",
          maxOutputTokens: 0,
        })
      );
      return {
        embeddings: [{ values: [0.1, 0.2], statistics: { tokenCount: 6 } }],
      };
    });
    await getVertexTextEmbedding({
      text: "document text",
      taskType: "RETRIEVAL_DOCUMENT",
      dimensions: 2,
    });
    expect(mockEmbedContent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          httpOptions: { timeout: 30000, retryOptions: { attempts: 1 } },
        }),
      })
    );
    expect(mockSettle).toHaveBeenCalledWith(
      { operationId: "embedding" },
      "gemini-embedding-001",
      { prompt_tokens: 6, completion_tokens: 0, total_tokens: 6 }
    );
  });
  it("returns the embedding without waiting for the spend settle", async () => {
    mockEmbedContent.mockResolvedValue({
      embeddings: [{ values: [0.1, 0.2], statistics: { tokenCount: 6 } }],
    });
    // A settle that never finishes must not hold retrieval.
    mockSettle.mockReturnValueOnce(new Promise(() => undefined));
    await expect(
      getVertexTextEmbedding({
        text: "доставка в Астану",
        taskType: "RETRIEVAL_QUERY",
        dimensions: 2,
      })
    ).resolves.toMatchObject({ embedding: [0.1, 0.2] });
    expect(mockSettle).toHaveBeenCalledTimes(1);
  });

  it("retains the reservation when the response is lost", async () => {
    mockEmbedContent.mockRejectedValue(new Error("connection lost"));
    await expect(
      getVertexTextEmbedding({
        text: "document text",
        taskType: "RETRIEVAL_DOCUMENT",
        dimensions: 2,
      })
    ).rejects.toThrow("connection lost");
    expect(mockSettle).toHaveBeenCalledWith(
      { operationId: "embedding" },
      "gemini-embedding-001",
      undefined
    );
  });
  it("uses the admitted customer key even without platform credentials", async () => {
    mockResolveBilling.mockResolvedValue({
      billingSource: "customer",
      apiKey: "customer-key",
    });
    mockCanUseVertexEmbeddings.mockReturnValue(false);
    mockResolveVertexEmbeddingProjectId.mockResolvedValue(null);
    await expect(
      getVertexTextEmbedding({
        text: "document text",
        taskType: "RETRIEVAL_DOCUMENT",
        dimensions: 2,
      })
    ).resolves.toEqual(expect.objectContaining({ embedding: [0.1, 0.2] }));
    expect(mockCustomerClient).toHaveBeenCalledWith({
      vertexai: false,
      apiKey: "customer-key",
    });
  });
  it("records the admitted payer without logging customer credentials", async () => {
    mockResolveBilling.mockResolvedValue({
      billingSource: "customer",
      workspaceId: "w",
      companyId: "c",
      actionId: "a",
      apiKey: "secret-key",
    });
    await getVertexTextEmbedding({
      text: "private text",
      taskType: "RETRIEVAL_DOCUMENT",
      dimensions: 2,
    });
    expect(mockAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        billingSource: "customer",
        workspaceId: "w",
        companyId: "c",
        actionId: "a",
        operation: "ai.embedding",
      })
    );
    expect(JSON.stringify(mockAnalytics.mock.calls)).not.toContain(
      "secret-key"
    );
    expect(JSON.stringify(mockAnalytics.mock.calls)).not.toContain(
      "private text"
    );
  });
  it("does not submit when admission fails", async () => {
    mockResolveBilling.mockRejectedValue(new Error("allowance exhausted"));
    await expect(
      getVertexTextEmbedding({
        text: "document text",
        taskType: "RETRIEVAL_DOCUMENT",
        dimensions: 2,
      })
    ).rejects.toThrow("allowance exhausted");
    expect(mockEmbedContent).not.toHaveBeenCalled();
  });
  it("emits one metadata-only span for an actual provider attempt", async () => {
    const requests: TraceRequest[] = [];
    const metadata: Array<Record<string, unknown>> = [];
    configureTracingAdapter({
      trace<T>(request: TraceRequest, execute: () => T): T {
        requests.push(request);
        metadata.push(
          (request.getMetadata?.() || {}) as Record<string, unknown>
        );
        return execute();
      },
      mergeMetadata() {},
      setUsage() {},
    });

    await expect(
      getVertexTextEmbedding({
        text: "private document content",
        taskType: "RETRIEVAL_DOCUMENT",
        dimensions: 2,
        title: "private title",
      })
    ).resolves.toEqual(
      expect.objectContaining({
        embedding: [0.1, 0.2],
        provider: "vertex",
      })
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.operation).toBe("embedding");
    expect(requests[0]?.name).toBe("vertex.embed_content");
    expect(metadata).toEqual([
      {
        embedding_dimensions: 2,
        embedding_task_type: "RETRIEVAL_DOCUMENT",
        model: "gemini-embedding-001",
        operation: "embed_content",
        provider: "vertex",
        source_service: "web",
      },
    ]);
    expect(JSON.stringify(metadata)).not.toContain("private document content");
    expect(JSON.stringify(metadata)).not.toContain("private title");
  });
});
