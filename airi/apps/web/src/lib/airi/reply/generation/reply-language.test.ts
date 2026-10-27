const mockChat = jest.fn();
const mockDetectLanguage = jest.fn();
jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: (...args: unknown[]) => mockChat(...args),
  getLightTextModel: () => "claude-haiku-4-5",
}));
jest.mock("@/lib/airi/language-detector-server", () => ({
  detectLanguage: (...args: unknown[]) => mockDetectLanguage(...args),
}));
jest.mock("@/lib/cache", () => ({
  cache: { get: async () => null, set: async () => undefined },
  buildCacheKey: () => "test-key",
}));

import { ensureReplyLanguage } from "./reply-language";

beforeEach(() => {
  jest.resetAllMocks();
  mockDetectLanguage.mockResolvedValue("en");
});

it("preserves Google translation output through the metered facade", async () => {
  mockChat.mockResolvedValue({
    content: "Бағасы 100 теңге.",
    provider: "google",
  });
  const result = await ensureReplyLanguage({
    text: "It costs 100 tenge.",
    targetLanguage: "kz",
    elevenlabsAgentId: "kz-agent",
  });
  expect(result.text).toBe("Бағасы 100 теңге.");
  // Translation runs on the light text tier; the provider maps the id.
  expect(mockChat).toHaveBeenCalledWith(
    expect.objectContaining({ model: "claude-haiku-4-5", temperature: 0.1 })
  );
});

it("translates sponsored replies through the metered facade despite legacy agent settings", async () => {
  mockChat.mockResolvedValue({
    content: "Бағасы 100 теңге.",
    provider: "anthropic",
  });
  const result = await ensureReplyLanguage({
    text: "It costs 100 tenge.",
    targetLanguage: "kz",
    elevenlabsAgentId: "legacy-agent",
  });
  expect(result.text).toBe("Бағасы 100 теңге.");
  expect(result.translationFallbackUsed).toBe(false);
  expect(mockChat).toHaveBeenCalledTimes(1);
});

it.each([
  "own_ai_source_required",
  "workspace_ai_policy_unavailable",
  "workspace_ai_spend_limit",
  "workspace_ai_operation_replayed",
])("does not swallow %s while translating", async code => {
  const error = Object.assign(new Error("AI billing unavailable"), { code });
  mockChat.mockRejectedValue(error);
  await expect(
    ensureReplyLanguage({
      text: "It costs 100 tenge.",
      targetLanguage: "kz",
      elevenlabsAgentId: "kz-agent",
    })
  ).rejects.toBe(error);
  expect(mockChat).toHaveBeenCalledTimes(1);
});

it("shares the reply translation deadline with detection and skips translation when language matches", async () => {
  const result = await ensureReplyLanguage({
    text: "It costs 100 tenge.",
    targetLanguage: "en",
  });
  expect(mockDetectLanguage).toHaveBeenCalledWith(
    "It costs 100 tenge.",
    expect.objectContaining({
      timeoutMs: expect.any(Number),
    })
  );
  expect(mockDetectLanguage.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(
    10_000
  );
  expect(result).toMatchObject({
    text: "It costs 100 tenge.",
    translated: false,
    detectedSourceLanguage: "en",
    translationFallbackUsed: false,
  });
  expect(mockChat).not.toHaveBeenCalled();
});

it("does not swallow detector cancellation or attempt paid translation after it", async () => {
  const reason = new DOMException("caller cancelled", "AbortError");
  mockDetectLanguage.mockRejectedValueOnce(reason);
  await expect(
    ensureReplyLanguage({
      text: "It costs 100 tenge.",
      targetLanguage: "kz",
    })
  ).rejects.toBe(reason);
  expect(mockChat).not.toHaveBeenCalled();
});
