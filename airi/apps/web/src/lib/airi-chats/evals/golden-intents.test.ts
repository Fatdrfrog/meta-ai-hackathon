const mockChatCompletionWithFallback = jest.fn();

jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: (...args: unknown[]) =>
    mockChatCompletionWithFallback(...args),
  getDefaultAIChatProviderOrder: jest.fn(() => ["anthropic", "vertex"]),
  getLightTextModel: jest.fn(() => "light-text-model"),
  getLightStructuredJsonGenerationConfig: jest.fn(() => ({})),
}));

import {
  classifyAiriChatIntent,
  resolveDeterministicAiriChatIntent,
} from "@/lib/airi-chats/intent-classifier";
import {
  AIRI_GOLDEN_INTENT_KINDS,
  AIRI_GOLDEN_LANGUAGES,
  loadAiriGoldenIntents,
} from "./golden-intents";

/**
 * Golden entries where a deterministic rule fires with the wrong intent.
 * They pin real router gaps instead of hiding them; fixing the rule must
 * remove the id here (the test fails while the list is stale).
 */
const KNOWN_DETERMINISTIC_GAPS: Record<string, string> = {
  // isAiriPlatformHowToRequest: «добав» + WhatsApp reads as "connect".
  "tr-24": "product_capability",
  // CREATE_ARTIFACT_RE: "build a ... flow" ignores reminder/no-show wording.
  "tr-25": "whatsapp_flow",
};

const golden = loadAiriGoldenIntents();

describe("Airi routing golden set", () => {
  it("covers every intent and language with realistic volume", () => {
    expect(golden.length).toBeGreaterThanOrEqual(140);
    const gaps: string[] = [];
    for (const intent of AIRI_GOLDEN_INTENT_KINDS) {
      const items = golden.filter(item => item.expectedIntent === intent);
      if (items.length < 15) gaps.push(`${intent}: ${items.length} prompts`);
      for (const lang of AIRI_GOLDEN_LANGUAGES) {
        if (!items.some(item => item.lang === lang)) {
          gaps.push(`${intent}: no ${lang} prompt`);
        }
      }
    }
    expect(gaps).toEqual([]);
  });

  it("rejects malformed entries and duplicate ids", () => {
    const valid = {
      id: "ga-99",
      lang: "en",
      text: "Hello",
      expectedIntent: "general_answer",
    };
    expect(() => loadAiriGoldenIntents([valid, valid])).toThrow(
      "Duplicate Airi golden intent id: ga-99"
    );
    expect(() =>
      loadAiriGoldenIntents([{ ...valid, expectedIntent: "campaign" }])
    ).toThrow();
    expect(() => loadAiriGoldenIntents([{ ...valid, lang: "uz" }])).toThrow();
    expect(() => loadAiriGoldenIntents([{ ...valid, extra: 1 }])).toThrow();
  });

  it("never lets resolveDeterministicAiriChatIntent contradict the golden intent", () => {
    const contradictions: string[] = [];
    let fired = 0;
    for (const item of golden) {
      const decided = resolveDeterministicAiriChatIntent({
        userMessage: item.text,
      });
      if (!decided) continue;
      fired += 1;
      if (decided.intent === item.expectedIntent) continue;
      if (KNOWN_DETERMINISTIC_GAPS[item.id] === decided.intent) continue;
      contradictions.push(
        `${item.id}: expected ${item.expectedIntent}, rule chose ${decided.intent}`
      );
    }
    expect(contradictions).toEqual([]);
    // The check is only meaningful while the rules still fire on the set.
    expect(fired).toBeGreaterThanOrEqual(15);
  });

  it("never lets the model-free routing chain contradict the golden intent", async () => {
    mockChatCompletionWithFallback.mockReset();
    mockChatCompletionWithFallback.mockRejectedValue(
      new Error("model routing is out of scope for this test")
    );
    const contradictions: string[] = [];
    const observedGaps: Record<string, string> = {};
    let fired = 0;
    for (const item of golden) {
      const callsBefore = mockChatCompletionWithFallback.mock.calls.length;
      const result = await classifyAiriChatIntent({
        workspaceId: "",
        threadId: "golden",
        userMessage: item.text,
        selectedSources: [],
      });
      // A model call means no deterministic rule decided this prompt.
      if (mockChatCompletionWithFallback.mock.calls.length > callsBefore) {
        continue;
      }
      fired += 1;
      if (result.intent === item.expectedIntent) continue;
      if (item.id in KNOWN_DETERMINISTIC_GAPS) {
        observedGaps[item.id] = result.intent;
        continue;
      }
      contradictions.push(
        `${item.id}: expected ${item.expectedIntent}, ${result.reason} chose ${result.intent}`
      );
    }
    expect(contradictions).toEqual([]);
    // A fixed gap must leave the list, so it cannot hide a later regression.
    expect(observedGaps).toEqual(KNOWN_DETERMINISTIC_GAPS);
    expect(fired).toBeGreaterThanOrEqual(30);
  });
});
