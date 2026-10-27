const chatCompletionWithFallback = jest.fn();

jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: (...args: unknown[]) =>
    chatCompletionWithFallback(...args),
  getLightTextModel: () => "claude-haiku-4-5",
}));

jest.mock("@/lib/ai/text-provider-config", () => ({
  canUseTextAI: () => true,
}));

import { RAG_CONFIG } from "@/lib/airi/rag/config";
import { runLlmGroundingReflection } from "@/lib/airi/grounding/llm-grounding-reflection";

describe("runLlmGroundingReflection", () => {
  const prevFlag = RAG_CONFIG.features.enableLlmGroundingReflection;

  beforeEach(() => {
    jest.clearAllMocks();
    (
      RAG_CONFIG.features as { enableLlmGroundingReflection: boolean }
    ).enableLlmGroundingReflection = true;
  });

  afterAll(() => {
    (
      RAG_CONFIG.features as { enableLlmGroundingReflection: boolean }
    ).enableLlmGroundingReflection = prevFlag;
  });

  it("parses JSON and filters cited ids to the allowlist", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        citedChunkIds: ["a", "bogus"],
        unsupportedClaims: [],
        confidence: 0.88,
      }),
      provider: "vertex",
      model: "m",
      latencyMs: 1,
    });

    const out = await runLlmGroundingReflection({
      reply: "The fee is $99.",
      language: "en",
      sources: [{ chunkId: "a", excerpt: "Pro costs 99 dollars" }],
    });

    expect(out?.citedChunkIds).toEqual(["a"]);
    expect(out?.confidence).toBe(0.88);
    expect(chatCompletionWithFallback).toHaveBeenCalledTimes(1);
    expect(chatCompletionWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-haiku-4-5",
        responseFormat: { type: "json_object" },
        generationConfig: { maxOutputTokens: 512 },
      })
    );
  });

  it("parses a reflection wrapped in a markdown fence", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content: [
        "```json",
        JSON.stringify({
          citedChunkIds: ["a"],
          unsupportedClaims: ["The fee is waived for students."],
          confidence: 0.4,
        }),
        "```",
      ].join("\n"),
      provider: "anthropic",
      model: "claude-haiku-4-5",
      latencyMs: 1,
    });

    const out = await runLlmGroundingReflection({
      reply: "The fee is $99. The fee is waived for students.",
      language: "en",
      sources: [{ chunkId: "a", excerpt: "Pro costs 99 dollars" }],
    });

    expect(out).toEqual({
      citedChunkIds: ["a"],
      unsupportedClaims: ["The fee is waived for students."],
      confidence: 0.4,
    });
  });

  it("returns null when feature flag is off", async () => {
    (
      RAG_CONFIG.features as { enableLlmGroundingReflection: boolean }
    ).enableLlmGroundingReflection = false;
    const out = await runLlmGroundingReflection({
      reply: "Hi",
      language: "en",
      sources: [{ chunkId: "a", excerpt: "x" }],
    });
    expect(out).toBeNull();
    expect(chatCompletionWithFallback).not.toHaveBeenCalled();
  });
});
