const mockEnsureReplyLanguage = jest.fn();

jest.mock("@/lib/airi/reply/generation/reply-language", () => ({
  ensureReplyLanguage: (...args: unknown[]) => mockEnsureReplyLanguage(...args),
}));

import {
  normalizeScenarioCopyLanguage,
  resolveDefaultScenarioFlowReplyCta,
  resolveDefaultScenarioLinkCta,
} from "@/lib/airi/reply/runtime/scenario-localization";

describe("scenario localization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureReplyLanguage.mockImplementation(
      async ({ text }: { text: string }) => ({
        text,
        translated: false,
        targetLanguage: "en",
        detectedSourceLanguage: "en",
        translationFallbackUsed: false,
      })
    );
  });

  it("normalizes Kazakh locale aliases for scenario copy", () => {
    expect(normalizeScenarioCopyLanguage("kk")).toBe("kz");
    expect(normalizeScenarioCopyLanguage("kk_KZ")).toBe("kz");
    expect(normalizeScenarioCopyLanguage("ru")).toBe("ru");
  });

  it("localizes default scenario CTA labels", () => {
    expect(resolveDefaultScenarioFlowReplyCta("kz")).toBe("Форманы ашу");
    expect(resolveDefaultScenarioLinkCta("kz")).toBe("Сілтемені ашу");
  });
});
