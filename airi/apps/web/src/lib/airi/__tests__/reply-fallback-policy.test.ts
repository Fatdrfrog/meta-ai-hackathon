jest.mock("@/lib/kb/content-utils", () => ({
  extractPlainText: (content: string) => content,
}));

import {
  latestConversationTurns,
  resolveReplyFallbackDecision,
} from "@/lib/airi/reply/generation/reply-fallback-policy";

describe("reply fallback policy", () => {
  it("returns grounded recovery with KB context when generation is incomplete", () => {
    const result = resolveReplyFallbackDecision({
      language: "ru",
      latestCustomerMessage:
        "Здравствуйте! Хочу узнать об Airi.chat и WhatsApp",
      kbContext: [
        {
          id: "kb-1",
          title: "Интеграция с WhatsApp for Business",
          fullContent:
            "Airi.chat позволяет подключить WhatsApp Business и вести переписку с клиентами из единой панели.",
          similarity: 0.92,
          locale: "ru",
        },
      ],
      generatedReply: "Да, Airi.chat поддерживает WhatsApp и",
      finishReason: "MAX_TOKENS",
      markedIncomplete: true,
    });

    expect(result.action).toBe("grounded_recovery");
    expect(result.reason).toBe("incomplete_generated_reply");
    expect(result.reply).toBe("Да, Airi.chat поддерживает WhatsApp и");
    expect(result.hasGroundedContext).toBe(true);
    expect(result.recoveryContext).toBeDefined();
    expect(result.recoveryContext?.kbExcerpt).toContain("WhatsApp Business");
  });

  it("returns intent fallback with missing knowledge context for factual requests", () => {
    const result = resolveReplyFallbackDecision({
      language: "ru",
      latestCustomerMessage: "Сколько стоит?",
      missingKnowledgeSignal: {
        intent: "pricing",
        topic: null,
        reason: "missing_pricing_info",
      },
    });

    expect(result.action).toBe("intent_fallback");
    expect(result.reason).toBe("missing_knowledge_signal");
    expect(result.usedMissingKnowledgeSignal).toBe(true);
    expect(result.recoveryContext?.missingKnowledgeIntent).toBe("pricing");
    expect(result.reply).toBeUndefined();
  });

  it("allows clarifying generation for ambiguous ungrounded turns", () => {
    const result = resolveReplyFallbackDecision({
      language: "ru",
      latestCustomerMessage: "Мне интересно подробнее",
      allowClarifyingGeneration: true,
    });

    expect(result.action).toBe("clarifying_generation");
    expect(result.reason).toBe("clarifying_generation_allowed");
    expect(result.reply).toBeUndefined();
  });

  it("provides recovery context with KB excerpt for services questions", () => {
    const result = resolveReplyFallbackDecision({
      language: "ru",
      latestCustomerMessage: "Какие есть услуги?",
      kbContext: [
        {
          id: "kb-1",
          title: "Услуги",
          fullContent: `Intro

Special grant

QazInnovation support.

Situation 4

Под ключ для полной подготовки заявки.

Situation 5

Индивидуальное менторство.`,
          similarity: 0.92,
          locale: "ru",
        },
      ],
      generatedReply: "",
      finishReason: "MAX_TOKENS",
      markedIncomplete: true,
    });

    expect(result.action).toBe("grounded_recovery");
    expect(result.hasGroundedContext).toBe(true);
    expect(result.recoveryContext).toBeDefined();
    expect(result.recoveryContext?.kbExcerpt).toContain("Под ключ");
    expect(result.reply).toBeUndefined();
  });

  it("returns generic clarification with recovery context when no grounding exists", () => {
    const result = resolveReplyFallbackDecision({
      language: "en",
      latestCustomerMessage: "Tell me about your integration options",
    });

    expect(result.action).toBe("generic_clarification");
    expect(result.hasGroundedContext).toBe(false);
    expect(result.recoveryContext?.latestCustomerMessage).toBe(
      "Tell me about your integration options"
    );
    expect(result.reply).toBeUndefined();
  });

  it("passes through a valid generated reply unchanged", () => {
    const generatedReply =
      "Here is the information you requested about our services.";
    const result = resolveReplyFallbackDecision({
      language: "en",
      latestCustomerMessage: "What services do you offer?",
      generatedReply,
      finishReason: "stop",
    });

    expect(result.action).toBe("use_generated_reply");
    expect(result.reason).toBe("generated_reply_complete");
    expect(result.reply).toBe(generatedReply);
  });

  it("hands grounded recovery the turn context and the writer's draft", () => {
    const decision = resolveReplyFallbackDecision({
      language: "ru",
      latestCustomerMessage: "[Location] 51.105938, 71.396126",
      turnContext: {
        stepInstruction: "Будь вежливым",
        recentConversation: "[AGENT] Отправьте свою локацию",
      },
      kbContext: [
        {
          id: "kb-1",
          title: "Доставка",
          fullContent: "Доставляем за 1 день.",
          similarity: 0.9,
          locale: "ru",
        },
      ],
      generatedReply: "Спасибо! Получили вашу локацию,",
      finishReason: "end_turn",
    });

    expect(decision.action).toBe("grounded_recovery");
    expect(decision.recoveryContext).toMatchObject({
      stepInstruction: "Будь вежливым",
      recentConversation: "[AGENT] Отправьте свою локацию",
      draftReply: "Спасибо! Получили вашу локацию,",
    });
  });

  it("keeps the latest turns of a long transcript, cut at a line start", () => {
    const lines = Array.from(
      { length: 60 },
      (_, index) =>
        `2026-10-23T10:${String(index).padStart(2, "0")}:00.000Z [CUSTOMER] сообщение ${index}`
    );
    const turns = latestConversationTurns(lines.join("\n"))!;
    expect(turns.length).toBeLessThanOrEqual(1500);
    expect(turns.endsWith("сообщение 59")).toBe(true);
    expect(turns.startsWith("2026-10-23T10:")).toBe(true);
    expect(turns).not.toContain("сообщение 0\n");
  });
});
