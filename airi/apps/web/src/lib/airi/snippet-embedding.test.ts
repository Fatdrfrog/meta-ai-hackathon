jest.mock("@/lib/ai", () => ({
  getDocumentEmbeddingResult: jest.fn(),
  buildEmbeddingMetadata: jest.fn(() => ({})),
  getCurrentEmbeddingMetadata: jest.fn(() => ({})),
  isEmbeddingMetadataCurrent: jest.fn(() => true),
}));

import { getDocumentEmbeddingResult } from "@/lib/ai";
import { resolveSnippetEmbedding } from "./snippet-embedding";

const generate = jest.mocked(getDocumentEmbeddingResult);

describe("snippet embedding admission identity", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    generate.mockResolvedValue(null);
  });

  it("binds retries to the workspace and same content but changes identity for changed content", async () => {
    await resolveSnippetEmbedding({
      workspaceId: "workspace-a",
      question: "Hours?",
      answer: "Nine.",
    });
    await resolveSnippetEmbedding({
      workspaceId: "workspace-a",
      question: "Hours?",
      answer: "Nine.",
    });
    await resolveSnippetEmbedding({
      workspaceId: "workspace-a",
      question: "Hours?",
      answer: "Ten.",
    });
    const actions = generate.mock.calls.map(call => call[1]?.action);
    expect(actions[0]).toEqual({
      workspaceId: "workspace-a",
      actionId: expect.stringMatching(/^snippet-embedding:[a-f0-9]{64}$/),
    });
    expect(actions[1]).toEqual(actions[0]);
    expect(actions[2]).not.toEqual(actions[0]);
  });

  it("does not start paid work when a background caller has no workspace", async () => {
    await expect(
      resolveSnippetEmbedding({ workspaceId: "", text: "Content" })
    ).rejects.toThrow("workspaceId is required");
    expect(generate).not.toHaveBeenCalled();
  });

  it("reuses a persisted matching snippet after its outer request is retried", async () => {
    const vector = [0.25, ...new Array<number>(1535).fill(0)];
    generate.mockRejectedValue(new Error("Paid operation already reserved"));
    const result = await resolveSnippetEmbedding({
      workspaceId: "workspace-a",
      question: "Hours?",
      answer: "Nine.",
      existingContent: { question: "Hours?", answer: "Nine." },
      existingEmbedding: vector,
      existingEmbeddingFallback: false,
      existingMetadata: {
        embeddingProvider: "vertex",
        embeddingModel: "gemini-embedding-001",
        embeddingTaskType: "RETRIEVAL_DOCUMENT",
        embeddingDimensions: 1536,
      },
    });
    expect(result.embedding).toEqual(vector);
    expect(result.usedFallback).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });

  it("does not treat the historical placeholder vector as a paid result", async () => {
    await resolveSnippetEmbedding({
      workspaceId: "workspace-a",
      question: "Hours?",
      answer: "Nine.",
      existingContent: { question: "Hours?", answer: "Nine." },
      existingEmbedding: [1, ...new Array<number>(1535).fill(0)],
      existingEmbeddingFallback: false,
      existingMetadata: {
        embeddingProvider: "vertex",
        embeddingModel: "gemini-embedding-001",
        embeddingTaskType: "RETRIEVAL_DOCUMENT",
        embeddingDimensions: 1536,
      },
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each([true, undefined])(
    "does not reuse a stored fallback or unknown provenance (%s)",
    async existingEmbeddingFallback => {
      await resolveSnippetEmbedding({
        workspaceId: "workspace-a",
        question: "Hours?",
        answer: "Nine.",
        existingContent: { question: "Hours?", answer: "Nine." },
        existingEmbedding: [0.25, ...new Array<number>(1535).fill(0)],
        existingEmbeddingFallback,
        existingMetadata: {
          embeddingProvider: "vertex",
          embeddingModel: "gemini-embedding-001",
          embeddingTaskType: "RETRIEVAL_DOCUMENT",
          embeddingDimensions: 1536,
        },
      });
      expect(generate).toHaveBeenCalledTimes(1);
    }
  );
});
