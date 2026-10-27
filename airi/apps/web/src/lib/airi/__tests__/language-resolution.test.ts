import { buildHeuristicTips } from "@/lib/airi/coach/coach-utils";
import { getLanguageName } from "@/lib/airi/language-detector";
import {
  ensureReplyLanguage,
  resolveCustomerReplyLanguage,
  resolveCustomerReplyLanguageContext,
} from "@/lib/airi/reply/generation/reply-language";
import {
  canonicalLanguageCode,
  isSameLanguage,
  normalizeLanguageCandidateText,
} from "@/lib/airi/shared/language-utils";

const mockDetectLanguage = jest.fn();
const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();
const mockChatCompletionWithFallback = jest.fn();

jest.mock("@/lib/airi/language-detector-server", () => ({
  detectLanguage: (...args: unknown[]) => mockDetectLanguage(...args),
}));

jest.mock("@/lib/cache", () => ({
  buildCacheKey: (...parts: unknown[]) => parts.join(":"),
  cache: {
    get: (...args: unknown[]) => mockCacheGet(...args),
    set: (...args: unknown[]) => mockCacheSet(...args),
  },
}));

jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: (...args: unknown[]) =>
    mockChatCompletionWithFallback(...args),
  getLightTextModel: () => "claude-haiku-4-5",
}));

describe("airi language resolution", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDetectLanguage.mockResolvedValue("en");
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockResolvedValue(undefined);
    mockChatCompletionWithFallback.mockResolvedValue({
      content: "Нужна помощь с ценами",
    });
  });

  it("uses the already-detected inbound language before re-parsing raw text when the conversation has no recent language", () => {
    expect(
      resolveCustomerReplyLanguageContext({
        latestInboundText: "reply in english please",
        latestInboundDetectedLanguage: "ru",
        workspaceLanguage: "uz",
      })
    ).toEqual({
      inboundLanguage: "ru",
      replyLanguage: "ru",
    });

    expect(
      resolveCustomerReplyLanguage({
        latestInboundText: "assalom, yordam kerak",
        latestInboundDetectedLanguage: null,
        conversationPreferredLanguage: "ru",
        workspaceLanguage: "en",
      })
    ).toBe("ru");

    expect(
      resolveCustomerReplyLanguage({
        latestInboundText: "",
        latestInboundDetectedLanguage: null,
        recentCustomerLanguage: "kz",
        conversationPreferredLanguage: "ru",
        workspaceLanguage: "en",
      })
    ).toBe("kz");

    expect(
      resolveCustomerReplyLanguageContext({
        latestInboundText:
          "\u00ab\u0411\u0435\u0441\u0422\u0456\u0440\u0435\u043a\u00bb",
        latestInboundDetectedLanguage: "kz",
        conversationPreferredLanguage: "ru",
        workspaceLanguage: "en",
      })
    ).toEqual({
      inboundLanguage: "kz",
      replyLanguage: "kz",
    });
  });

  it("keeps the established recent customer language when latest detection conflicts", () => {
    expect(
      resolveCustomerReplyLanguageContext({
        latestInboundText:
          "Sonra, iyi, dursun biraz zirtba. nefes verme Roziza bahasi ya",
        latestInboundDetectedLanguage: "tr",
        recentCustomerLanguage: "kz",
        conversationPreferredLanguage: "kz",
        workspaceLanguage: "kz",
      })
    ).toEqual({
      inboundLanguage: "kz",
      replyLanguage: "kz",
    });

    expect(
      resolveCustomerReplyLanguage({
        latestInboundText: "reply in english please",
        latestInboundDetectedLanguage: "en",
        recentCustomerLanguage: "ru",
        conversationPreferredLanguage: "ru",
      })
    ).toBe("ru");
  });

  it("ignores deleted-message placeholders for reply language selection", () => {
    expect(
      normalizeLanguageCandidateText(
        "[Flow response: flow] message: opt_2; flow_token: abc123"
      )
    ).toBe("");
    expect(normalizeLanguageCandidateText("[Template: shezhire_pick_1]")).toBe(
      ""
    );

    expect(
      resolveCustomerReplyLanguage({
        latestInboundText: "[Message deleted]",
        latestInboundDetectedLanguage: "en",
        recentCustomerLanguage: "kz",
        conversationPreferredLanguage: "en",
        workspaceLanguage: "en",
      })
    ).toBe("kz");

    expect(
      resolveCustomerReplyLanguage({
        latestInboundText: "ok",
        latestInboundDetectedLanguage: "en",
        recentCustomerLanguage: "kz",
        conversationPreferredLanguage: "en",
        workspaceLanguage: "en",
      })
    ).toBe("kz");
  });

  it("inherits the recent strong language for ambiguous short follow-ups", () => {
    expect(
      resolveCustomerReplyLanguage({
        latestInboundText: "Qazinnovation",
        latestInboundDetectedLanguage: null,
        recentCustomerLanguage: "ru",
        conversationPreferredLanguage: "kz",
        workspaceLanguage: "kz",
        workspaceLanguageBias: "kz",
      })
    ).toBe("ru");
  });

  it("keeps replying with the best available language when provider detection is missing", () => {
    expect(
      resolveCustomerReplyLanguage({
        latestInboundText: "Need help with pricing",
        latestInboundDetectedLanguage: null,
        recentCustomerLanguage: null,
        conversationPreferredLanguage: "en",
      })
    ).toBe("en");

    expect(
      resolveCustomerReplyLanguage({
        latestInboundText:
          "\u0417\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0443\u0439\u0442\u0435! \u0425\u043e\u0447\u0443 \u0443\u0437\u043d\u0430\u0442\u044c \u043e\u0431 \u0430\u0432\u0442\u043e\u043c\u0430\u0442\u0438\u0437\u0430\u0446\u0438\u0438 \u043f\u0440\u043e\u0434\u0430\u0436",
        latestInboundDetectedLanguage: null,
        recentCustomerLanguage: null,
        conversationPreferredLanguage: "ru",
      })
    ).toBe("ru");

    expect(
      resolveCustomerReplyLanguage({
        latestInboundText: "2",
        latestInboundDetectedLanguage: null,
        recentCustomerLanguage: "ru",
        conversationPreferredLanguage: "en",
      })
    ).toBe("ru");
  });

  it("never answers Cyrillic messages in English when detection is missing or stale", () => {
    // 2026-10-15: new conversations default preferred_language to "en".
    expect(
      resolveCustomerReplyLanguageContext({
        latestInboundText: "Послушала вас питчинг, очень понравилось",
        latestInboundDetectedLanguage: null,
        recentCustomerLanguage: null,
        conversationPreferredLanguage: "en",
      })
    ).toEqual({ inboundLanguage: "ru", replyLanguage: "ru" });

    expect(
      resolveCustomerReplyLanguage({
        latestInboundText: "Бағасын айтасызба?",
        latestInboundDetectedLanguage: null,
        conversationPreferredLanguage: "en",
      })
    ).toBe("kz");

    expect(
      resolveCustomerReplyLanguage({
        latestInboundText: "Стоирмость подписки в квартал ?",
        latestInboundDetectedLanguage: "ru",
        recentCustomerLanguage: "en",
        conversationPreferredLanguage: "en",
      })
    ).toBe("ru");

    expect(
      resolveCustomerReplyLanguage({
        latestInboundText: "хэлоу",
        latestInboundDetectedLanguage: null,
        recentCustomerLanguage: "kz",
        conversationPreferredLanguage: "en",
      })
    ).toBe("kz");

    expect(
      resolveCustomerReplyLanguage({
        latestInboundText: "Need help with pricing",
        latestInboundDetectedLanguage: null,
        recentCustomerLanguage: "ru",
        conversationPreferredLanguage: "en",
      })
    ).toBe("ru");
  });

  it("short-circuits translation when the text is already in the target language", async () => {
    mockDetectLanguage.mockResolvedValue("en");

    await expect(
      ensureReplyLanguage({
        text: "Need help with pricing",
        targetLanguage: "en",
      })
    ).resolves.toEqual({
      text: "Need help with pricing",
      translated: false,
      targetLanguage: "en",
      detectedSourceLanguage: "en",
      translationFallbackUsed: false,
    });
  });

  it("uses Google Cloud detection during reply translation", async () => {
    mockDetectLanguage.mockResolvedValue("ru");

    await expect(
      ensureReplyLanguage({
        text: "Need help with pricing",
        targetLanguage: "en",
      })
    ).resolves.toEqual(
      expect.objectContaining({
        detectedSourceLanguage: "ru",
        targetLanguage: "en",
      })
    );
    expect(mockDetectLanguage).toHaveBeenCalledWith("Need help with pricing", {
      timeoutMs: expect.any(Number),
    });
    const timeoutMs = mockDetectLanguage.mock.calls[0][1].timeoutMs;
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(10000);
  });

  it("treats locale variants and Kazakh aliases as the same language", () => {
    expect(isSameLanguage("en", "en-US")).toBe(true);
    expect(isSameLanguage("ru", "ru_RU")).toBe(true);
    expect(isSameLanguage("kk", "kz")).toBe(true);
    expect(isSameLanguage("kz", "KK")).toBe(true);
    expect(isSameLanguage("ru", "kz")).toBe(false);
    expect(isSameLanguage("", "en")).toBe(false);
    expect(canonicalLanguageCode("kk")).toBe("kz");
    expect(canonicalLanguageCode(null)).toBe("");
  });

  it("keeps display names aligned", () => {
    expect(getLanguageName("kk")).toBe("KK");
    expect(getLanguageName("kz")).toBe("Kazakh");
    expect(getLanguageName("ru")).toBe("Russian");
  });

  it("uses shared language display names in coaching mismatch tips", () => {
    const tips = buildHeuristicTips(
      "I can help with that",
      "ru",
      {
        stage: "middle",
        priority: "normal",
        customerSentiment: "neutral",
        riskLevel: 0,
        interactionCount: 2,
      },
      "en"
    );

    expect(tips[0]?.suggestion).toContain("Customer: Russian");
    expect(tips[0]?.suggestion).toContain("Your draft: English");
    expect(tips[0]?.reasoning).toContain("Customer writes in Russian");
  });
});
