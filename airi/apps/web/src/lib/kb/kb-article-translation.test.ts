const mockChatCompletionWithFallback = jest.fn();

jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: (...args: unknown[]) =>
    mockChatCompletionWithFallback(...args),
  getHeavyTextModel: () => "heavy-text-model",
}));

import {
  getKBArticleTranslationTimeoutMs,
  translateKBArticleLocalization,
} from "./kb-article-translation";

describe("translateKBArticleLocalization", () => {
  beforeEach(() => {
    mockChatCompletionWithFallback.mockReset();
  });

  it("translates article title and HTML content on the heavy model with JSON response format", async () => {
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        title: "Бастау",
        content_mdx: "<h2>Сәлем</h2><p>{{name}} үшін нұсқаулық.</p>",
      }),
    });

    const result = await translateKBArticleLocalization({
      sourceLocale: "en",
      targetLocale: "kz",
      title: "Getting started",
      contentMdx: "<h2>Hello</h2><p>Guide for {{name}}.</p>",
    });

    expect(result).toEqual({
      title: "Бастау",
      contentMdx: "<h2>Сәлем</h2><p>{{name}} үшін нұсқаулық.</p>",
    });
    expect(mockChatCompletionWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "heavy-text-model",
        responseFormat: { type: "json_object" },
        generationConfig: {
          responseSchema: {
            type: "OBJECT",
            properties: {
              title: { type: "STRING" },
              content_mdx: { type: "STRING" },
            },
            required: ["title", "content_mdx"],
          },
        },
      })
    );
    expect(
      mockChatCompletionWithFallback.mock.calls[0][0].messages[0].content
    ).toContain("Preserve HTML/Tiptap structure");
  });

  it("gives the call a length-scaled deadline above the 30 s AI default", async () => {
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({ title: "T", content_mdx: "<p>x</p>" }),
    });

    await translateKBArticleLocalization({
      sourceLocale: "en",
      targetLocale: "ru",
      title: "Short",
      contentMdx: "<p>Hello</p>",
    });
    await translateKBArticleLocalization({
      sourceLocale: "en",
      targetLocale: "ru",
      title: "Medium",
      contentMdx: "x".repeat(12_000),
    });
    await translateKBArticleLocalization({
      sourceLocale: "en",
      targetLocale: "ru",
      title: "Longest",
      contentMdx: "x".repeat(30_000),
    });

    const timeouts = mockChatCompletionWithFallback.mock.calls.map(
      ([request]) => request.resilience?.timeoutMs
    );
    expect(timeouts).toEqual([120_048, 168_000, 240_000]);
    // The Gemini fallback (35% after a non-final Claude attempt) keeps >= 30 s,
    // and the deadline stays inside the localizations route's 300 s.
    for (const timeout of timeouts) {
      expect(timeout * 0.35).toBeGreaterThanOrEqual(30_000);
      expect(timeout).toBeLessThan(300_000);
    }
    expect(getKBArticleTranslationTimeoutMs(Number.NaN)).toBe(120_000);
  });

  it("rejects overly long source articles before calling the model", async () => {
    await expect(
      translateKBArticleLocalization({
        sourceLocale: "en",
        targetLocale: "ru",
        title: "Long",
        contentMdx: "x".repeat(30001),
      })
    ).rejects.toThrow("Article is too long for automatic translation");

    expect(mockChatCompletionWithFallback).not.toHaveBeenCalled();
  });
});
