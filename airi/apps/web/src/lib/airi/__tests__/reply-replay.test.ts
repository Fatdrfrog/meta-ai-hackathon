import {
  lowConfidenceWhatsAppReplay,
  march30GreetingOnlyReplay,
  march30GreetingPlusWhatsAppReplay,
  unresolvedDocumentsFollowupReplay,
} from "@/lib/airi/__tests__/reply-replay-fixtures";
import { resolveReplyFallbackDecision } from "@/lib/airi/reply/generation/reply-fallback-policy";
import { resolveIntentPolicy } from "@/lib/airi/reply/intent/intent-policy";
import { buildThreadReplyContext } from "@/lib/airi/reply/thread/thread-context";
import { understandCustomerTurn } from "@/lib/airi/reply/turn/understand-customer-turn";

const chatCompletionWithFallback = jest.fn();

jest.mock("@/lib/kb/content-utils", () => ({
  extractPlainText: (content: string) => content,
}));

jest.mock("@/lib/ai", () => {
  const actual = jest.requireActual<typeof import("@/lib/ai")>("@/lib/ai");
  return {
    ...actual,
    chatCompletionWithFallback: (...args: unknown[]) =>
      chatCompletionWithFallback(...args),
    getDefaultAIChatProviderOrder: jest.fn(() => ["vertex"]),
    formatError: jest.fn((error: unknown) =>
      error instanceof Error ? error.message : String(error)
    ),
  };
});

describe("reply replay fixtures", () => {
  beforeEach(() => {
    chatCompletionWithFallback.mockReset();
  });

  it("replays the March 30 greeting-plus-WhatsApp path; offline mode skips safe-reply classification", async () => {
    chatCompletionWithFallback.mockRejectedValue(new Error("provider offline"));

    const greetingContext = buildThreadReplyContext({
      messages: march30GreetingOnlyReplay.messages,
      latestInboundText: march30GreetingOnlyReplay.latestInboundText,
    });
    const greetingTurn = await understandCustomerTurn(
      march30GreetingOnlyReplay.latestInboundText,
      march30GreetingOnlyReplay.language,
      greetingContext.conversationWindow
    );
    const greetingPolicy = resolveIntentPolicy({
      turnUnderstanding: greetingTurn,
      threadContext: greetingContext,
      language: march30GreetingOnlyReplay.language,
      alreadyGreetedToday: false,
    });

    expect(greetingTurn.kind).toBe("unknown");
    expect(greetingPolicy.proceedWithRag).toBe(true);
    expect(greetingPolicy.safeReplyType).toBeUndefined();

    const whatsAppContext = buildThreadReplyContext({
      messages: march30GreetingPlusWhatsAppReplay.messages,
      latestInboundText: march30GreetingPlusWhatsAppReplay.latestInboundText,
    });
    const whatsAppTurn = await understandCustomerTurn(
      march30GreetingPlusWhatsAppReplay.latestInboundText,
      march30GreetingPlusWhatsAppReplay.language,
      whatsAppContext.conversationWindow,
      {
        intentAnchor: whatsAppContext.intentAnchor,
        hasUnresolvedNeed: whatsAppContext.hasUnresolvedNeed,
      }
    );
    const whatsAppPolicy = resolveIntentPolicy({
      turnUnderstanding: whatsAppTurn,
      threadContext: whatsAppContext,
      language: march30GreetingPlusWhatsAppReplay.language,
      alreadyGreetedToday: true,
    });
    const groundedDecision = resolveReplyFallbackDecision({
      language: march30GreetingPlusWhatsAppReplay.language,
      latestCustomerMessage:
        march30GreetingPlusWhatsAppReplay.latestInboundText,
      intentAnchor: whatsAppContext.intentAnchor,
      kbContext: march30GreetingPlusWhatsAppReplay.kbContext,
      generatedReply: "Airi.chat поддерживает WhatsApp и",
      finishReason: "MAX_TOKENS",
      markedIncomplete: true,
    });

    expect(whatsAppContext.conversationWindow).toContain("Здравствуйте");
    expect(whatsAppTurn.kind).toBe("unknown");
    expect(whatsAppPolicy.proceedWithRag).toBe(true);
    expect(groundedDecision.action).toBe("grounded_recovery");
    expect(groundedDecision.hasGroundedContext).toBe(true);
    expect(groundedDecision.recoveryContext?.kbExcerpt).toContain(
      "WhatsApp Business"
    );
  });

  it("keeps unresolved follow-up turns on the RAG path when prior context is required", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        kind: "followup_question",
        proceedWithRag: false,
        dependsOnPriorContext: true,
        safeReplyKey: null,
        confidence: "high",
      }),
      provider: "vertex",
      model: "gemini-3.5-flash",
      latencyMs: 25,
    });

    const context = buildThreadReplyContext({
      messages: unresolvedDocumentsFollowupReplay.messages,
      latestInboundText: unresolvedDocumentsFollowupReplay.latestInboundText,
    });
    const turn = await understandCustomerTurn(
      unresolvedDocumentsFollowupReplay.latestInboundText,
      unresolvedDocumentsFollowupReplay.language,
      context.conversationWindow,
      {
        intentAnchor: context.intentAnchor,
        hasUnresolvedNeed: context.hasUnresolvedNeed,
      }
    );
    const policy = resolveIntentPolicy({
      turnUnderstanding: turn,
      threadContext: context,
      language: unresolvedDocumentsFollowupReplay.language,
      alreadyGreetedToday: true,
    });

    expect(context.currentGoal).toContain("документы");
    expect(context.hasUnresolvedNeed).toBe(true);
    expect(turn.dependsOnPriorContext).toBe(true);
    expect(policy.proceedWithRag).toBe(true);
  });

  it("routes low-confidence unknowns through conversation context into grounded recovery", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        kind: "unknown",
        proceedWithRag: false,
        dependsOnPriorContext: false,
        safeReplyKey: null,
        confidence: "low",
      }),
      provider: "vertex",
      model: "gemini-3.5-flash",
      latencyMs: 25,
    });

    const context = buildThreadReplyContext({
      messages: lowConfidenceWhatsAppReplay.messages,
      latestInboundText: lowConfidenceWhatsAppReplay.latestInboundText,
    });
    const turn = await understandCustomerTurn(
      lowConfidenceWhatsAppReplay.latestInboundText,
      lowConfidenceWhatsAppReplay.language,
      context.conversationWindow,
      {
        intentAnchor: context.intentAnchor,
        hasUnresolvedNeed: context.hasUnresolvedNeed,
      }
    );
    const policy = resolveIntentPolicy({
      turnUnderstanding: turn,
      threadContext: context,
      language: lowConfidenceWhatsAppReplay.language,
      alreadyGreetedToday: true,
    });
    const groundedDecision = resolveReplyFallbackDecision({
      language: lowConfidenceWhatsAppReplay.language,
      latestCustomerMessage: lowConfidenceWhatsAppReplay.latestInboundText,
      intentAnchor: context.intentAnchor,
      kbContext: lowConfidenceWhatsAppReplay.kbContext,
      generatedReply: "",
      finishReason: "MAX_TOKENS",
      markedIncomplete: true,
    });

    expect(context.currentGoal).toContain("WhatsApp");
    expect(context.retrievalQuery).toContain("Airi.chat");
    expect(turn.kind).toBe("unknown");
    expect(turn.confidence).toBe("low");
    expect(policy.proceedWithRag).toBe(true);
    expect(groundedDecision.action).toBe("grounded_recovery");
    expect(groundedDecision.hasGroundedContext).toBe(true);
    expect(groundedDecision.recoveryContext?.kbExcerpt).toContain(
      "WhatsApp Business"
    );
  });
});
