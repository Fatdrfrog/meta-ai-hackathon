const mockChatCompletionWithFallback = jest.fn();
const mockRerankerInfo = jest.fn();
const mockRerankerError = jest.fn();
const mockRerankerDebug = jest.fn();
const mockGetLightTextModel = jest.fn(() => "gemini-3.5-flash");

jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: (...args: unknown[]) =>
    mockChatCompletionWithFallback(...args),
  formatScore: (value: number | null | undefined) => value ?? null,
  getLightTextModel: () => mockGetLightTextModel(),
  // The real per-family config, so assertions cover Gemini and Claude ids.
  getStructuredJsonGenerationConfig: (model: string) =>
    jest
      .requireActual<
        typeof import("@/lib/ai/text-models")
      >("@/lib/ai/text-models")
      .getStructuredJsonGenerationConfig(model),
  truncateText: (value: string) => value,
}));

jest.mock("@/lib/ai/text-provider-config", () => ({
  canUseTextAI: () => true,
}));

jest.mock("@/lib/airi/shared/logger", () => ({
  ragLogger: {
    reranker: {
      info: (...args: unknown[]) => mockRerankerInfo(...args),
      error: (...args: unknown[]) => mockRerankerError(...args),
      debug: (...args: unknown[]) => mockRerankerDebug(...args),
    },
  },
}));

import { buildAnthropicMessageParams } from "@/lib/ai/anthropic-messages";
import {
  hasClearKbLeader,
  rerankDocuments,
  rerankKBArticles,
} from "@/lib/airi/rag/pipeline/reranker";

describe("rerankDocuments", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("propagates allowance denial instead of treating it as an optional rerank failure", async () => {
    const denial = Object.assign(new Error("Source required"), {
      code: "own_ai_source_required",
    });
    mockChatCompletionWithFallback.mockRejectedValueOnce(denial);
    await expect(
      rerankDocuments("pricing", [{ text: "Pricing is $10" }])
    ).rejects.toBe(denial);
  });

  it("requests structured output for reranking", async () => {
    mockChatCompletionWithFallback.mockResolvedValue({
      content: '{"results":[{"index":1,"score":0.91}]}',
      provider: "vertex",
      model: "gemini-3.5-flash",
      latencyMs: 10,
      usage: { total_tokens: 42 },
    });

    await rerankDocuments(
      "как выиграть грант?",
      [{ text: "Фонд Ержана Татишева" }, { text: "Программа Получи ремесло" }],
      1
    );

    expect(mockChatCompletionWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        generationConfig: expect.objectContaining({
          responseMimeType: "application/json",
          responseSchema: expect.objectContaining({
            type: "OBJECT",
            required: ["results"],
          }),
        }),
      })
    );
  });

  it("repairs truncated JSON responses instead of failing the rerank", async () => {
    mockChatCompletionWithFallback.mockResolvedValue({
      content: '{"results":[{"index":1,"score":0.91},{"index":0,"score":0.27}',
      provider: "vertex",
      model: "gemini-3.5-flash",
      latencyMs: 10,
      usage: { total_tokens: 42 },
    });

    const result = await rerankDocuments(
      "как выиграть грант?",
      [{ text: "Фонд Ержана Татишева" }, { text: "Программа Получи ремесло" }],
      2
    );

    expect(result).not.toBeNull();
    expect(result?.results).toHaveLength(2);
    expect(result?.results[0]).toMatchObject({
      index: 1,
      relevanceScore: 0.91,
    });
    expect(result?.results[1]).toMatchObject({
      index: 0,
      relevanceScore: 0.27,
    });
    expect(mockRerankerError).not.toHaveBeenCalled();
  });
  it("bounds ranking output and selects minimal thinking without changing the ranking model", async () => {
    mockChatCompletionWithFallback.mockResolvedValue({
      content: '{"results":[{"index":0,"score":0.9}]}',
      provider: "vertex",
      model: "gemini-3.5-flash",
    });
    await rerankDocuments("pricing", [{ text: "Pricing is $10" }], 1);
    expect(mockGetLightTextModel).toHaveBeenCalled();
    expect(mockChatCompletionWithFallback).toHaveBeenCalledTimes(1);
    expect(mockChatCompletionWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemini-3.5-flash",
        generationConfig: expect.objectContaining({
          maxOutputTokens: 512,
          thinkingConfig: { thinkingLevel: "MINIMAL" },
        }),
      })
    );
  });

  it("ranks on the Claude light tier with a timeout and a schema Claude can enforce", async () => {
    mockGetLightTextModel.mockReturnValueOnce("claude-haiku-4-5");
    mockChatCompletionWithFallback.mockResolvedValue({
      content: '{"results":[{"index":0,"score":0.9}]}',
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });

    const result = await rerankDocuments(
      "pricing",
      [{ text: "Pricing is $10" }],
      1
    );

    expect(result?.results).toEqual([
      expect.objectContaining({ index: 0, relevanceScore: 0.9 }),
    ]);
    const [request] = mockChatCompletionWithFallback.mock.calls[0]!;
    expect(request).toMatchObject({
      model: "claude-haiku-4-5",
      generationConfig: { maxOutputTokens: 512 },
      resilience: { maxRetries: 0, timeoutMs: 3_000 },
    });
    const params = buildAnthropicMessageParams({
      model: request.model,
      messages: request.messages,
      generationConfig: {
        temperature: request.temperature,
        ...request.generationConfig,
      },
    });
    expect(params).not.toHaveProperty("thinking");
    expect(params.output_config).toEqual({
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            results: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  index: { type: "integer", description: expect.any(String) },
                  score: { type: "number", description: expect.any(String) },
                },
                required: ["index", "score"],
                additionalProperties: false,
              },
            },
          },
          required: ["results"],
          additionalProperties: false,
        },
      },
    });
    expect(mockRerankerInfo).toHaveBeenCalledWith(
      "Reranked documents (LLM)",
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-haiku-4-5",
      })
    );
  });

  it("keeps the embedding order when the rerank times out", async () => {
    mockChatCompletionWithFallback.mockRejectedValueOnce(
      Object.assign(new Error("AI request timeout"), { code: "timeout" })
    );
    const articles = [
      { title: "Доставка", content: "2000 ₸", similarity: 0.7 },
      { title: "Оплата", content: "Картой", similarity: 0.6 },
    ];
    await expect(rerankKBArticles("доставка", articles, 2)).resolves.toEqual(
      articles
    );
  });
});

describe("hasClearKbLeader", () => {
  it.each([
    ["a single strong match", [{ similarity: 0.9 }], true],
    [
      "a strong match well ahead",
      [{ similarity: 0.9 }, { similarity: 0.8 }],
      true,
    ],
    [
      "a strong match with a close second",
      [{ similarity: 0.9 }, { similarity: 0.86 }],
      false,
    ],
    [
      "typical production scores (0.6–0.74)",
      [{ similarity: 0.74 }, { similarity: 0.6 }],
      false,
    ],
    [
      "a pinned article's fixed similarity",
      [{ similarity: 0.9, retrievalMethod: "pinned" }],
      false,
    ],
    ["no candidates", [], false],
  ])("%s → %s", (_label, articles, expected) => {
    expect(hasClearKbLeader(articles)).toBe(expected);
  });
});
