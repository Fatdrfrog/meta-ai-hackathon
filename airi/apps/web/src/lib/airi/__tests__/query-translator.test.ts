import { chatCompletionWithFallback } from "@/lib/ai";
import { canUseAnthropicAI } from "@/lib/ai/anthropic-config";
import { getAnthropicLightModel } from "@/lib/ai/text-models";
import { getVertexGeminiLightModel } from "@/lib/ai/vertex-gemini-rest";
import { cache } from "@/lib/cache";
import {
  translateAnswerForReply,
  translateQueryForRAG,
} from "@/lib/airi/rag/query/query-translator";

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

describe("query translator", () => {
  beforeEach(() => {
    jest.mocked(chatCompletionWithFallback).mockReset();
    jest.mocked(cache.get).mockReset();
    jest.mocked(cache.set).mockReset();
    jest.mocked(cache.get).mockResolvedValue(null);
    jest.mocked(canUseAnthropicAI).mockReturnValue(false);
  });

  it("translates on the light tier: Claude when configured, else Gemini", async () => {
    jest.mocked(chatCompletionWithFallback).mockResolvedValue({
      content: "delivery price",
      provider: "anthropic",
      model: getAnthropicLightModel(),
      latencyMs: 1,
    });

    jest.mocked(canUseAnthropicAI).mockReturnValue(true);
    await translateQueryForRAG("цена доставки", "ru", "en");
    jest.mocked(canUseAnthropicAI).mockReturnValue(false);
    await translateQueryForRAG("стоимость доставки", "ru", "en");

    const models = jest
      .mocked(chatCompletionWithFallback)
      .mock.calls.map(([request]) => request.model);
    expect(models).toEqual([
      getAnthropicLightModel(),
      getVertexGeminiLightModel(),
    ]);
  });

  it("does not call the model when source and target languages match", async () => {
    const result = await translateQueryForRAG("hello", "en", "en");

    expect(result.translatedQuery).toBe("hello");
    expect(result.wasTranslated).toBe(false);
    expect(chatCompletionWithFallback).not.toHaveBeenCalled();
  });

  it("translates a retrieval query with one model call", async () => {
    jest.mocked(chatCompletionWithFallback).mockResolvedValue({
      content: "price guide",
      provider: "vertex",
      model: "gemini-test",
      latencyMs: 1,
    });

    const result = await translateQueryForRAG("  price   guide  ", "ru", "en");

    expect(result.translatedQuery).toBe("price guide");
    expect(result.wasTranslated).toBe(true);
    expect(chatCompletionWithFallback).toHaveBeenCalledTimes(1);
  });

  it("translates answer text without query-prep", async () => {
    jest.mocked(chatCompletionWithFallback).mockResolvedValue({
      content: "The guide costs 7,000 KZT.",
      provider: "vertex",
      model: "gemini-test",
      latencyMs: 1,
    });

    const result = await translateAnswerForReply(
      "Гайд стоит 7 000 тенге.",
      "ru",
      "en"
    );

    expect(result.translatedText).toBe("The guide costs 7,000 KZT.");
    expect(result.wasTranslated).toBe(true);
    expect(chatCompletionWithFallback).toHaveBeenCalledTimes(1);
  });
});
