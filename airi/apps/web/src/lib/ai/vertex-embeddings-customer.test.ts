const mockAnalytics = jest.fn();
const mockResolveBilling = jest.fn();
const mockReserve = jest.fn();
const mockSettle = jest.fn();
const mockHttpFetch = jest.fn();
const mockPlatformEmbedContent = jest.fn();
const mockMarkVertexUnavailable = jest.fn();

jest.mock("@/lib/llm-analytics/events", () => ({
  recordLlmTraceAnalyticsEvent: (...args: unknown[]) => mockAnalytics(...args),
}));
jest.mock("./workspace-ai-policy", () => ({
  resolveWorkspaceTextAiBilling: () => mockResolveBilling(),
  reserveWorkspaceTextAiSpend: (...args: unknown[]) => mockReserve(...args),
  settleWorkspaceTextAiSpend: (...args: unknown[]) => mockSettle(...args),
}));
jest.mock("./vertex-auth", () => ({
  canUseVertexEmbeddings: () => true,
  getVertexEmbeddingLocation: () => "us-central1",
  markVertexEmbeddingsUnavailableForRuntime: (...args: unknown[]) =>
    mockMarkVertexUnavailable(...args),
  resolveVertexEmbeddingProjectId: async () => "project-1",
}));
jest.mock("./vertex-genai-client", () => ({
  getVertexGenAI: async () => ({
    models: { embedContent: mockPlatformEmbedContent },
  }),
}));
jest.mock("@google/genai", () => {
  const actual =
    jest.requireActual<typeof import("@google/genai")>("@google/genai");
  return {
    ...actual,
    GoogleGenAI: function (
      options: ConstructorParameters<typeof actual.GoogleGenAI>[0]
    ) {
      // Keep SDK request validation/serialization real; only replace transport.
      return new actual.GoogleGenAI({
        ...options,
        httpOptions: { fetch: (...args) => mockHttpFetch(...args) },
      });
    },
  };
});

import {
  configureTracingAdapter,
  type TraceRequest,
} from "@/lib/observability/tracing";
import { getVertexTextEmbedding } from "./vertex-embeddings";

describe("customer Google embeddings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveBilling.mockResolvedValue({
      billingSource: "customer",
      workspaceId: "w",
      companyId: "c",
      actionId: "a",
      apiKey: "secret-key",
    });
    mockReserve.mockResolvedValue(null);
    mockSettle.mockResolvedValue(undefined);
    mockHttpFetch.mockImplementation(async () =>
      Response.json({ embeddings: [{ values: [0.1, 0.2] }] })
    );
    mockPlatformEmbedContent.mockResolvedValue({
      embeddings: [{ values: [0.1, 0.2] }],
    });
  });

  afterEach(() => {
    configureTracingAdapter(null);
  });

  it.each(["RETRIEVAL_QUERY", "RETRIEVAL_DOCUMENT"] as const)(
    "submits %s through the real Developer API SDK without Vertex-only config",
    async taskType => {
      await expect(
        getVertexTextEmbedding({
          text: "private text",
          title: "private title",
          taskType,
          dimensions: 2,
        })
      ).resolves.toEqual({
        embedding: [0.1, 0.2],
        provider: "vertex",
        model: "gemini-embedding-001",
        taskType,
        dimensions: 2,
      });
      expect(mockHttpFetch).toHaveBeenCalledTimes(1);
      expect(mockPlatformEmbedContent).not.toHaveBeenCalled();
    }
  );

  it("retains Vertex auto-truncation for platform embeddings", async () => {
    mockResolveBilling.mockResolvedValue({
      billingSource: "platform",
      workspaceId: "w",
      companyId: "c",
      actionId: "a",
    });
    await getVertexTextEmbedding({
      text: "private text",
      taskType: "RETRIEVAL_QUERY",
      dimensions: 2,
    });
    expect(mockPlatformEmbedContent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ autoTruncate: true }),
      })
    );
    expect(mockHttpFetch).not.toHaveBeenCalled();
    expect(mockAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "vertex", billingSource: "platform" })
    );
  });

  it("attributes the request to Google in analytics and tracing without credentials", async () => {
    const requests: TraceRequest[] = [];
    const metadata: unknown[] = [];
    configureTracingAdapter({
      trace<T>(request: TraceRequest, execute: () => T): T {
        requests.push(request);
        metadata.push(request.getMetadata?.());
        return execute();
      },
      mergeMetadata() {},
      setUsage() {},
    });

    await getVertexTextEmbedding({
      text: "private text",
      taskType: "RETRIEVAL_QUERY",
      dimensions: 2,
    });

    expect(mockAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        billingSource: "customer",
        workspaceId: "w",
        companyId: "c",
        actionId: "a",
        status: "ok",
      })
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      name: "google.embed_content",
      tags: ["ai", "embedding", "google"],
    });
    expect(metadata).toEqual([expect.objectContaining({ provider: "google" })]);
    const telemetry = JSON.stringify([
      mockAnalytics.mock.calls,
      requests,
      metadata,
    ]);
    expect(telemetry).not.toContain("secret-key");
    expect(telemetry).not.toContain("private text");
  });

  it.each([401, 402, 403, 429, 503])(
    "retains safe HTTP %s diagnostics without exposing provider bodies or retrying",
    async status => {
      mockHttpFetch.mockImplementation(async () =>
        Response.json(
          { error: { code: status, message: "private text secret-key" } },
          { status }
        )
      );

      const error = await getVertexTextEmbedding({
        text: "private text",
        taskType: "RETRIEVAL_QUERY",
        dimensions: 2,
      }).catch((failure: unknown) => failure);

      expect(error).toMatchObject({
        name: "GoogleEmbeddingProviderError",
        code: "google_embedding_provider_failed",
        status,
        message: `Customer Google embedding request failed (HTTP ${status}).`,
      });
      expect(mockAnalytics).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "google",
          status: "error",
          errorMessage: `Customer Google embedding request failed (HTTP ${status}).`,
          metadata: expect.objectContaining({ httpStatus: status }),
        })
      );
      expect(mockHttpFetch).toHaveBeenCalledTimes(1);
      expect(mockPlatformEmbedContent).not.toHaveBeenCalled();
      expect(mockMarkVertexUnavailable).not.toHaveBeenCalled();
      expect(mockSettle).toHaveBeenCalledWith(
        null,
        "gemini-embedding-001",
        undefined
      );
      const diagnostics = JSON.stringify([error, mockAnalytics.mock.calls]);
      expect(diagnostics).not.toContain("secret-key");
      expect(diagnostics).not.toContain("private text");
    }
  );

  it("still marks platform Vertex unavailable on its own authentication failure", async () => {
    mockResolveBilling.mockResolvedValue({
      billingSource: "platform",
      workspaceId: "w",
      companyId: "c",
      actionId: "a",
    });
    const providerError = Object.assign(new Error("permission denied"), {
      status: 403,
    });
    mockPlatformEmbedContent.mockRejectedValue(providerError);
    await expect(
      getVertexTextEmbedding({
        text: "private text",
        taskType: "RETRIEVAL_QUERY",
        dimensions: 2,
      })
    ).rejects.toBe(providerError);
    expect(mockMarkVertexUnavailable).toHaveBeenCalledWith(
      providerError,
      "Vertex Embeddings"
    );
  });

  it("preserves timeout classification while stripping the provider message", async () => {
    mockHttpFetch.mockRejectedValue(
      Object.assign(new Error("deadline exceeded private text secret-key"), {
        name: "TimeoutError",
      })
    );
    const error = await getVertexTextEmbedding({
      text: "private text",
      taskType: "RETRIEVAL_QUERY",
      dimensions: 2,
    }).catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      name: "GoogleEmbeddingProviderError",
      code: "google_embedding_timeout",
      message: "Customer Google embedding request timeout.",
    });
    expect(mockAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        status: "error",
        errorMessage: "Customer Google embedding request timeout.",
      })
    );
    expect(mockHttpFetch).toHaveBeenCalledTimes(1);
    const diagnostics = JSON.stringify([error, mockAnalytics.mock.calls]);
    expect(diagnostics).not.toContain("secret-key");
    expect(diagnostics).not.toContain("private text");
  });
});
