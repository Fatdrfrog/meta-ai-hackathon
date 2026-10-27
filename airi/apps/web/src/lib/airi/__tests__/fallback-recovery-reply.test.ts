import { generateFallbackRecoveryReplyResult } from "@/lib/airi/reply/generation/fallback-recovery-reply";
import { AIChatProviderAggregateError } from "@/lib/ai/provider-errors";

const chatCompletionWithFallback = jest.fn();

jest.mock("@/lib/ai", () => {
  const actual = jest.requireActual<typeof import("@/lib/ai")>("@/lib/ai");
  return {
    ...actual,
    chatCompletionWithFallback: (...args: unknown[]) =>
      chatCompletionWithFallback(...args),
    getDefaultAIChatProviderOrder: jest.fn(() => ["vertex"]),
    getHeavyTextModel: jest.fn(() => "claude-sonnet-5-5"),
  };
});

describe("fallback recovery reply", () => {
  it.each([
    { httpStatus: 402, retryable: false },
    { httpStatus: 503, retryable: true },
  ])(
    "preserves provider failure $httpStatus instead of returning an empty successful reply",
    async ({ httpStatus, retryable }) => {
      const error = new AIChatProviderAggregateError([
        {
          provider: "anthropic",
          model: "claude-sonnet-5-5",
          attempt: 1,
          fallbackIndex: 0,
          retryable,
          finishReason: null,
          promptBlockReason: null,
          httpStatus,
        },
      ]);
      chatCompletionWithFallback.mockRejectedValueOnce(error);

      await expect(
        generateFallbackRecoveryReplyResult({
          type: "generic_clarification",
          language: "ru",
          channel: "whatsapp",
        })
      ).rejects.toBe(error);
    }
  );

  it.each(["own_ai_source_required", "workspace_ai_policy_unavailable"])(
    "preserves %s without retrying recovery generation",
    async code => {
      const error = Object.assign(new Error("Policy denied inference"), {
        code,
      });
      chatCompletionWithFallback.mockRejectedValueOnce(error);
      await expect(
        generateFallbackRecoveryReplyResult({
          type: "generic_clarification",
          language: "en",
        })
      ).rejects.toBe(error);
      expect(chatCompletionWithFallback).toHaveBeenCalledTimes(1);
    }
  );
  beforeEach(() => {
    chatCompletionWithFallback.mockReset();
  });

  it("retries an incomplete recovery reply and keeps the complete retry", async () => {
    chatCompletionWithFallback
      .mockResolvedValueOnce({
        content: "Please tell me which grant you",
        provider: "vertex",
        model: "gemini-3.5-flash",
        latencyMs: 80,
        finishReason: "MAX_TOKENS",
      })
      .mockResolvedValueOnce({
        content:
          "Please tell me which grant you mean: training, treatment, business launch, or another category.",
        provider: "vertex",
        model: "gemini-3.5-flash",
        latencyMs: 90,
        finishReason: "STOP",
      });

    const result = await generateFallbackRecoveryReplyResult({
      type: "generic_clarification",
      language: "en",
      channel: "telegram",
      recoveryContext: {
        latestCustomerMessage: "Which grants are available?",
        intentAnchor: "available grants",
      },
    });

    expect(chatCompletionWithFallback).toHaveBeenCalledTimes(2);
    expect(result.reply).toContain("training, treatment");
    expect(result.isIncomplete).toBe(false);
    expect(result.finishReason).toBe("STOP");
  });

  it("keeps the original incomplete reply when the recovery retry is worse", async () => {
    chatCompletionWithFallback
      .mockResolvedValueOnce({
        content: "Please tell me which grant you",
        provider: "vertex",
        model: "gemini-3.5-flash",
        latencyMs: 80,
        finishReason: "MAX_TOKENS",
      })
      .mockResolvedValueOnce({
        content: "Please tell me which",
        provider: "vertex",
        model: "gemini-3.5-flash",
        latencyMs: 70,
        finishReason: "MAX_TOKENS",
      });

    const result = await generateFallbackRecoveryReplyResult({
      type: "generic_clarification",
      language: "en",
      channel: "telegram",
      recoveryContext: {
        latestCustomerMessage: "Which grants are available?",
      },
    });

    expect(result.reply).toBe("Please tell me which grant you");
    expect(result.isIncomplete).toBe(true);
    expect(result.finishReason).toBe("MAX_TOKENS");
  });

  it("writes recovery replies on the heavy tier and retries a Claude max_tokens cut", async () => {
    chatCompletionWithFallback
      .mockResolvedValueOnce({
        content: "Please tell me which grant you",
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        latencyMs: 60,
        finishReason: "max_tokens",
      })
      .mockResolvedValueOnce({
        content: "Please tell me which grant you mean: training or business.",
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        latencyMs: 70,
        finishReason: "end_turn",
      });

    const result = await generateFallbackRecoveryReplyResult({
      type: "generic_clarification",
      language: "en",
      recoveryContext: {
        latestCustomerMessage: "Which grants are available?",
      },
    });

    expect(chatCompletionWithFallback).toHaveBeenCalledTimes(2);
    for (const [request] of chatCompletionWithFallback.mock.calls) {
      expect(request).toMatchObject({
        model: "claude-sonnet-5-5",
        providerOrder: ["vertex"],
      });
    }
    expect(result).toMatchObject({
      reply: "Please tell me which grant you mean: training or business.",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      finishReason: "end_turn",
      isIncomplete: false,
    });
  });

  it("writes grounded recovery from the step instruction, the chat and the draft", async () => {
    chatCompletionWithFallback.mockReset();
    chatCompletionWithFallback.mockResolvedValueOnce({
      content: "Спасибо! Локацию получили, курьер свяжется с вами.",
      finishReason: "end_turn",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      latencyMs: 50,
    });

    await generateFallbackRecoveryReplyResult({
      type: "grounded_recovery",
      language: "ru",
      channel: "whatsapp",
      recoveryContext: {
        stepInstruction: "Будь вежливым",
        recentConversation:
          "2026-10-23T14:08:09.409Z [AGENT] Отправьте свою локацию, запланируем поездку к вам",
        latestCustomerMessage: "[Location] 51.105938, 71.396126",
        draftReply: "Спасибо! Получили вашу локацию",
        intentAnchor: "Хочу в вас инвестировать",
        kbExcerpt: "Партнёрство:\nНапишите, кто вы и какой формат.",
      },
    });

    const prompt = chatCompletionWithFallback.mock.calls[0][0].messages[1]
      .content as string;
    expect(prompt).toContain(
      "Instruction for this reply (follow it): Будь вежливым"
    );
    expect(prompt).toContain(
      "Отправьте свою локацию, запланируем поездку к вам"
    );
    expect(prompt).toContain("Draft reply:\nСпасибо! Получили вашу локацию");
    expect(prompt).toContain("never switch to an unrelated topic");
    // The chat outranks an anchor that may come from an older topic.
    expect(prompt).not.toContain("Хочу в вас инвестировать");
    expect(prompt.indexOf("Instruction for this reply")).toBeLessThan(
      prompt.indexOf("Knowledge base excerpt")
    );
  });
});
