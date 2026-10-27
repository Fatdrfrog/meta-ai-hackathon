import { chatCompletionWithFallback } from "@/lib/ai";
import { canUseAnthropicAI } from "@/lib/ai/anthropic-config";
import { getAnthropicLightModel } from "@/lib/ai/text-models";
import { cache } from "@/lib/cache";
import {
  buildHeuristicRagQueryPreparation,
  prepareQueryForRagWithLlm,
} from "@/lib/airi/rag/query/query-cleaner";

jest.mock("@/lib/ai/anthropic-config", () => ({
  ...jest.requireActual<typeof import("@/lib/ai/anthropic-config")>(
    "@/lib/ai/anthropic-config"
  ),
  canUseAnthropicAI: jest.fn(() => false),
}));

jest.mock("@/lib/cache", () => ({
  buildCacheKey: (prefix: string, parts: string[]) =>
    `${prefix}:${parts.join(":")}`,
  cache: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
  },
}));

jest.mock("@/lib/ai", () => {
  const actual = jest.requireActual<typeof import("@/lib/ai")>("@/lib/ai");
  return {
    ...actual,
    chatCompletionWithFallback: jest.fn(),
  };
});

describe("query cleaner (LLM prep)", () => {
  beforeEach(() => {
    jest.mocked(chatCompletionWithFallback).mockReset();
    jest.mocked(cache.get).mockReset();
    jest.mocked(cache.set).mockReset();
    jest.mocked(cache.get).mockResolvedValue(null);
    jest.mocked(canUseAnthropicAI).mockReturnValue(false);
  });

  it("runs on the Claude light tier and reads a fenced JSON reply", async () => {
    jest.mocked(canUseAnthropicAI).mockReturnValue(true);
    jest.mocked(chatCompletionWithFallback).mockResolvedValue({
      content: `\`\`\`json\n${JSON.stringify({
        cleanedQuery: "What does delivery cost?",
        subQueries: [],
        hypotheticalAnswer: "Delivery usually costs a flat fee.",
      })}\n\`\`\``,
      provider: "anthropic",
      model: getAnthropicLightModel(),
      latencyMs: 1,
    });

    const result = await prepareQueryForRagWithLlm(
      "Hello! What does delivery cost?",
      { language: "en" }
    );

    expect(chatCompletionWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        model: getAnthropicLightModel(),
        responseFormat: { type: "json_object" },
        generationConfig: { thinkingConfig: { thinkingLevel: "LOW" } },
      })
    );
    expect(result).toMatchObject({
      cleanedQuery: "What does delivery cost?",
      hypotheticalAnswer: "Delivery usually costs a flat fee.",
      source: "llm",
    });
  });

  it("parses RAG prep JSON from the model", async () => {
    jest.mocked(chatCompletionWithFallback).mockResolvedValue({
      content: JSON.stringify({
        cleanedQuery: "Хочу узнать об Airi.chat и WhatsApp",
        subQueries: [],
      }),
      provider: "vertex",
      model: "gemini-test",
      latencyMs: 1,
    });

    const result = await prepareQueryForRagWithLlm(
      "Здравствуйте! Хочу узнать об Airi.chat и WhatsApp",
      { language: "ru" }
    );

    expect(result.cleanedQuery).toBe("Хочу узнать об Airi.chat и WhatsApp");
    expect(result.subQueries).toEqual([]);
    expect(result.source).toBe("llm");
    expect(jest.mocked(cache.set)).toHaveBeenCalledTimes(1);
  });

  it("preserves empty cleanedQuery when the model marks a non-searchable turn", async () => {
    jest.mocked(chatCompletionWithFallback).mockResolvedValue({
      content: JSON.stringify({ cleanedQuery: "", subQueries: [] }),
      provider: "vertex",
      model: "gemini-test",
      latencyMs: 1,
    });

    const result = await prepareQueryForRagWithLlm("Привет! Как дела?", {
      language: "ru",
    });

    expect(result.cleanedQuery).toBe("");
    expect(result.subQueries).toEqual([]);
    expect(result.source).toBe("llm");
    expect(result.wasCleaned).toBe(true);
    expect(jest.mocked(cache.set)).toHaveBeenCalledTimes(1);
  });

  it("uses whitespace fallback when the prep model fails", async () => {
    jest
      .mocked(chatCompletionWithFallback)
      .mockRejectedValue(new Error("provider offline"));

    const result = await prepareQueryForRagWithLlm("  hello   world  ", {
      language: "en",
    });

    expect(result.cleanedQuery).toBe("hello world");
    expect(result.source).toBe("fallback");
    expect(jest.mocked(cache.set)).not.toHaveBeenCalled();
  });

  it("does not cache RAG prep when the model returns unparseable JSON", async () => {
    jest.mocked(chatCompletionWithFallback).mockResolvedValue({
      content: "not valid json",
      provider: "vertex",
      model: "gemini-test",
      latencyMs: 1,
    });

    const result = await prepareQueryForRagWithLlm("hello there", {
      language: "en",
    });

    expect(result.source).toBe("fallback");
    expect(jest.mocked(cache.set)).not.toHaveBeenCalled();
  });
});

describe("buildHeuristicRagQueryPreparation", () => {
  it("normalizes whitespace without LLM", () => {
    const p = buildHeuristicRagQueryPreparation("  foo   bar  ");
    expect(p.cleanedQuery).toBe("foo bar");
    expect(p.source).toBe("fallback");
    expect(p.subQueries).toEqual([]);
    expect(p.originalQuery).toBe("foo   bar");
  });
});
