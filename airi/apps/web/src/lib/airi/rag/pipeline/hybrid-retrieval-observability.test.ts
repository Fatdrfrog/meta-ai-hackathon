const mockOrchestrate = jest.fn();

jest.mock("@/lib/airi/rag/pipeline/retrieval-orchestrator", () => ({
  RetrievalOrchestrator: jest.fn().mockImplementation(() => ({
    orchestrate: mockOrchestrate,
  })),
}));

import {
  configureTracingAdapter,
  type TraceRequest,
} from "@icecore/airi-runtime/tracing";
import { retrieveHybridContext } from "./hybrid-retrieval";

describe("hybrid retrieval observability", () => {
  afterEach(() => {
    configureTracingAdapter(null);
    jest.clearAllMocks();
  });

  it("creates a retrieval span with correlation metadata but no query content", async () => {
    const requests: TraceRequest[] = [];
    const metadata: Array<Record<string, unknown>> = [];
    mockOrchestrate.mockResolvedValue({ retrievalStats: {} });
    configureTracingAdapter({
      trace(request, execute) {
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
      retrieveHybridContext("workspace-1", "private customer query", "kk")
    ).resolves.toEqual({ retrievalStats: {} });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.operation).toBe("retriever");
    expect(requests[0]?.name).toBe("airi.rag.hybrid_retrieval");
    expect(metadata).toEqual([
      {
        operation: "hybrid_retrieval",
        preferred_language: "kk",
        source_service: "web",
        workspace_id: "workspace-1",
      },
    ]);
    expect(JSON.stringify(metadata)).not.toContain("private customer query");
  });
});
