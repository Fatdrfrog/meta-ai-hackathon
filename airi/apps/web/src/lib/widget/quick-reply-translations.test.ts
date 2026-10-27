const mockChatCompletionWithFallback = jest.fn();
const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();

jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: (...args: unknown[]) =>
    mockChatCompletionWithFallback(...args),
  getLightTextModel: () => "light-text-model",
}));

jest.mock("@/lib/cache", () => ({
  buildCacheKey: (prefix: string, parts: string[]) =>
    [prefix, ...parts].join(":"),
  cache: {
    get: (...args: unknown[]) => mockCacheGet(...args),
    set: (...args: unknown[]) => mockCacheSet(...args),
  },
}));

import { translateWidgetQuickRepliesSet } from "./quick-reply-translations";

describe("translateWidgetQuickRepliesSet", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockResolvedValue(undefined);
  });

  it("translates on the light text tier with a schema naming every target locale", async () => {
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        translations: {
          ru: ["Цены", "Доставка"],
          kz: ["Бағалар", "Жеткізу"],
        },
      }),
    });

    const result = await translateWidgetQuickRepliesSet({
      quickReplies: ["Prices", "Delivery"],
      sourceLocale: "en",
      targetLocales: ["ru", "kz", "en"],
    });

    expect(result).toEqual({
      ru: ["Цены", "Доставка"],
      kz: ["Бағалар", "Жеткізу"],
    });
    expect(mockChatCompletionWithFallback).toHaveBeenCalledTimes(1);
    const request = mockChatCompletionWithFallback.mock.calls[0][0];
    expect(request.model).toBe("light-text-model");
    expect(request.responseFormat).toEqual({ type: "json_object" });
    expect(request.generationConfig.responseSchema).toEqual({
      type: "OBJECT",
      properties: {
        translations: {
          type: "OBJECT",
          properties: {
            ru: { type: "ARRAY", items: { type: "STRING" } },
            kz: { type: "ARRAY", items: { type: "STRING" } },
          },
          required: ["ru", "kz"],
        },
      },
      required: ["translations"],
    });
    expect(mockCacheSet).toHaveBeenCalledWith(
      expect.stringContaining("widget:quick-replies:i18n:v1"),
      result,
      24 * 60 * 60
    );
  });

  it("does not call the model when no target differs from the source locale", async () => {
    await expect(
      translateWidgetQuickRepliesSet({
        quickReplies: ["Prices"],
        sourceLocale: "en",
        targetLocales: ["en"],
      })
    ).resolves.toEqual({});
    expect(mockChatCompletionWithFallback).not.toHaveBeenCalled();
  });
});
