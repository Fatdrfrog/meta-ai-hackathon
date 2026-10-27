import { getDefaultAIChatProviderOrder, getHeavyTextModel } from "@/lib/ai";
import { generateAssistantReply } from "@/lib/airi/reply/generation/reply-generation";

const chatCompletionWithFallback = jest.fn();
const hasGreetedToday = jest.fn();
const canUseTextAI = jest.fn();

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
    getHeavyTextModel: jest.fn(() => actual.getHeavyTextModel()),
  };
  it("repairs a reply that drifts away from the locked selected price", async () => {
    chatCompletionWithFallback
      .mockResolvedValueOnce({
        content: "The selected guide costs 10000 KZT.",
        provider: "vertex",
        model: "gemini-3.5-flash",
        latencyMs: 80,
        finishReason: "stop",
      })
      .mockResolvedValueOnce({
        content: "The selected guide costs 7000 KZT.",
        provider: "vertex",
        model: "gemini-3.5-flash",
        latencyMs: 70,
        finishReason: "stop",
      });

    const result = await generateAssistantReply("yes", {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      preferredLanguage: "en",
      activeSelection: {
        kind: "offer",
        label: "QazInnovation guide",
        normalizedLabel: "qazinnovation guide",
        sourceKind: "kb",
        sourceIds: ["kb-guide"],
        quotedPriceText: "7000 KZT",
        quotedPriceAmount: 7000,
        quotedPriceCurrency: "KZT",
      },
      retrievalMetadata: {
        hasSnippet: false,
        hasKB: true,
        priority: "kb",
      },
      kbContext: [
        {
          id: "kb-guide",
          title: "Guide",
          fullContent: "The QazInnovation guide costs 7000 KZT.",
          similarity: 0.94,
          locale: "en",
        },
      ],
    });

    expect(chatCompletionWithFallback).toHaveBeenCalledTimes(2);
    expect(result.reply).toContain("7000 KZT");
    expect(
      chatCompletionWithFallback.mock.calls[0][0].messages[1].content
    ).toContain("LOCKED CUSTOMER SELECTION:");
    expect(
      chatCompletionWithFallback.mock.calls[1][0].messages[1].content
    ).toContain("SELECTION CONSISTENCY REPAIR:");
  });
});

jest.mock("@/lib/ai/text-provider-config", () => ({
  canUseTextAI: () => canUseTextAI(),
}));

jest.mock("@/lib/airi/conversation", () => ({
  hasGreetedToday: (...args: unknown[]) => hasGreetedToday(...args),
}));

jest.mock("@/lib/airi/coach/coach-utils", () => ({
  redactPII: jest.fn((text: string) => ({ redacted: text, map: {} })),
  unredact: jest.fn((text: string) => text),
}));

describe("reply generation", () => {
  beforeEach(() => {
    chatCompletionWithFallback.mockReset();
    hasGreetedToday.mockReset();
    canUseTextAI.mockReset();

    hasGreetedToday.mockResolvedValue(false);
    canUseTextAI.mockReturnValue(true);
  });

  it.each([
    {
      label: "complete",
      reply: "The standard plan includes email support.",
      finishReason: "end_turn",
      isIncomplete: false,
      fallbackAction: "use_generated_reply",
    },
    {
      label: "incomplete",
      reply: "The standard plan includes email support and",
      finishReason: "max_tokens",
      isIncomplete: true,
      fallbackAction: "grounded_recovery",
    },
  ])(
    "classifies the $label recovered answer instead of the failed original draft",
    async ({ reply, finishReason, isIncomplete, fallbackAction }) => {
      chatCompletionWithFallback
        .mockRejectedValueOnce(new Error("Primary writer unavailable"))
        .mockResolvedValue({
          content: reply,
          provider: "anthropic",
          model: "claude-sonnet-5-5",
          latencyMs: 10,
          finishReason,
        });

      const result = await generateAssistantReply("What does my plan include?", {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        preferredLanguage: "en",
        kbContext: [
          {
            id: "kb-plan",
            title: "Plan benefits",
            fullContent: "The standard plan includes email support.",
            similarity: 0.95,
            locale: "en",
          },
        ],
        retrievalMetadata: { hasSnippet: false, hasKB: true, priority: "kb" },
      });

      expect(result).toMatchObject({
        reply,
        isIncomplete,
        finishReason,
        fallbackAction,
        inference: { provider: "anthropic", model: "claude-sonnet-5-5" },
      });
    }
  );

  it("preserves Google output from the metered writer for a Kazakh reply", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content: "Бағдарлама қысқа формадан басталады.",
      provider: "google",
      model: "gemini-test",
      finishReason: "STOP",
      latencyMs: 10,
    });
    const result = await generateAssistantReply(
      "Бағдарлама туралы айтып беріңіз",
      {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        preferredLanguage: "kz",
        elevenlabsAgentId: "agent_kazakh_writer",
        kbContext: [
          {
            id: "kb-1",
            title: "Program",
            fullContent: "Бағдарлама қысқа формадан басталады.",
            similarity: 0.9,
            locale: "kz",
          },
        ],
        retrievalMetadata: { hasSnippet: false, hasKB: true, priority: "kb" },
      }
    );
    expect(result.inference?.provider).toBe("google");
  });

  it("keeps sponsored Kazakh replies on the metered writer when a legacy agent is configured", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content: "Бағдарлама қысқа формадан басталады.",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      finishReason: "STOP",
      latencyMs: 10,
    });
    const result = await generateAssistantReply(
      "Бағдарлама туралы айтып беріңіз",
      {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        preferredLanguage: "kz",
        elevenlabsAgentId: "legacy-agent",
      }
    );
    expect(result.reply).toBe("Бағдарлама қысқа формадан басталады.");
    expect(result.inference?.provider).toBe("anthropic");
    expect(chatCompletionWithFallback).toHaveBeenCalledTimes(1);
  });

  it.each([
    "own_ai_source_required",
    "workspace_ai_policy_unavailable",
    "workspace_ai_spend_limit",
    "workspace_ai_operation_replayed",
  ])("rejects %s from the metered writer", async code => {
    const denial = Object.assign(new Error("AI billing unavailable"), {
      code,
    });
    chatCompletionWithFallback.mockRejectedValue(denial);
    await expect(
      generateAssistantReply("Бағдарлама туралы айтып беріңіз", {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        preferredLanguage: "kz",
        elevenlabsAgentId: "agent_kazakh_writer",
      })
    ).rejects.toBe(denial);
    expect(chatCompletionWithFallback).toHaveBeenCalledTimes(1);
  });

  it("propagates allowance denial without attempting a fallback writer", async () => {
    const denial = Object.assign(new Error("Source required"), {
      code: "own_ai_source_required",
    });
    chatCompletionWithFallback.mockRejectedValue(denial);
    await expect(
      generateAssistantReply("What is the price?", {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        preferredLanguage: "en",
        kbContext: [
          {
            id: "kb-1",
            title: "Pricing",
            fullContent: "Pricing starts at $10.",
            similarity: 0.9,
            locale: "en",
          },
        ],
        retrievalMetadata: { hasSnippet: false, hasKB: true, priority: "kb" },
      })
    ).rejects.toBe(denial);
    expect(chatCompletionWithFallback).toHaveBeenCalledTimes(1);
  });

  it("keeps non-Kazakh replies on Vertex when an ElevenLabs Kazakh writer is configured", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content: "The program starts with a short form.",
      provider: "vertex",
      model: "gemini-3.5-flash",
      latencyMs: 80,
      finishReason: "stop",
    });

    const result = await generateAssistantReply("Tell me about the program", {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      preferredLanguage: "en",
      elevenlabsAgentId: "agent_kazakh_writer",
      retrievalMetadata: {
        hasSnippet: false,
        hasKB: true,
        priority: "kb",
      },
      kbContext: [
        {
          id: "kb-1",
          title: "Program",
          fullContent: "The program starts with a short form.",
          similarity: 0.9,
          locale: "en",
        },
      ],
    });

    expect(chatCompletionWithFallback).toHaveBeenCalledTimes(1);
    expect(result.inference?.provider).toBe("vertex");
  });

  it("falls back to a generic clarification when both the initial draft and repair remain incomplete without grounded context", async () => {
    chatCompletionWithFallback
      .mockResolvedValueOnce({
        content:
          "Unfortunately, I do not have the full document list for the second stage yet, but I can help with another part",
        provider: "vertex",
        model: "gemini-3.5-flash",
        latencyMs: 100,
        finishReason: "MAX_TOKENS",
      })
      .mockResolvedValueOnce({
        content: "1. Doc",
        provider: "vertex",
        model: "gemini-3.5-flash",
        latencyMs: 90,
        finishReason: "MAX_TOKENS",
      });

    const result = await generateAssistantReply(
      "I need the documents for the second stage",
      {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        preferredLanguage: "en",
        retrievalMetadata: {
          hasSnippet: false,
          hasKB: true,
          priority: "kb",
        },
      }
    );

    expect(chatCompletionWithFallback).toHaveBeenCalledTimes(2);
    expect(result.fallbackAction).toBe("generic_clarification");
    expect(
      chatCompletionWithFallback.mock.calls[0][0].generationConfig
    ).toMatchObject({
      maxOutputTokens: 1400,
      thinkingConfig: { thinkingLevel: "MINIMAL" },
    });
    expect(
      chatCompletionWithFallback.mock.calls[1][0].generationConfig
    ).toMatchObject({
      maxOutputTokens: 1600,
      thinkingConfig: { thinkingLevel: "MINIMAL" },
    });
    expect(result.fallbackReason).toBe("incomplete_generated_reply");
    expect(result.recoveryContext).toBeDefined();
    expect(result.finishReason).toBe("MAX_TOKENS");
    expect(result.promptDiagnostics?.usedOutputMaxTokens).toBeGreaterThan(0);
  });

  it("uses grounded KB recovery text instead of a generic clarification when KB context exists", async () => {
    chatCompletionWithFallback
      .mockResolvedValueOnce({
        content: "Yes, Airi.chat supports WhatsApp and",
        provider: "vertex",
        model: "gemini-3.5-flash",
        latencyMs: 100,
        finishReason: "MAX_TOKENS",
      })
      .mockResolvedValueOnce({
        content: "Integration",
        provider: "vertex",
        model: "gemini-3.5-flash",
        latencyMs: 90,
        finishReason: "MAX_TOKENS",
      });

    const result = await generateAssistantReply(
      "Hello, I want to know about Airi.chat and WhatsApp",
      {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        preferredLanguage: "en",
        kbContext: [
          {
            id: "kb-1",
            title: "WhatsApp for Business integration",
            fullContent:
              "Airi.chat lets you connect WhatsApp Business and manage customer conversations from one inbox.",
            similarity: 0.9,
            locale: "en",
          },
        ],
        retrievalMetadata: {
          hasSnippet: false,
          hasKB: true,
          priority: "kb",
        },
      }
    );

    expect(chatCompletionWithFallback).toHaveBeenCalledTimes(2);
    expect(result.fallbackAction).toBe("grounded_recovery");
    expect(result.fallbackReason).toBe("incomplete_generated_reply");
    expect(result.recoveryContext?.kbExcerpt).toContain("WhatsApp Business");
    expect(result.finishReason).toBe("MAX_TOKENS");
  });

  it("uses grounded recovery when the provider is unavailable but KB context exists", async () => {
    canUseTextAI.mockReturnValue(false);

    const result = await generateAssistantReply(
      "Hello, I want to know about Airi.chat and WhatsApp",
      {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        preferredLanguage: "en",
        kbContext: [
          {
            id: "kb-1",
            title: "WhatsApp for Business integration",
            fullContent:
              "Airi.chat lets you connect WhatsApp Business and manage customer conversations from one inbox.",
            similarity: 0.9,
            locale: "en",
          },
        ],
        retrievalMetadata: {
          hasSnippet: false,
          hasKB: true,
          priority: "kb",
        },
      }
    );

    expect(chatCompletionWithFallback).not.toHaveBeenCalled();
    expect(result.fallbackAction).toBe("grounded_recovery");
    expect(result.fallbackReason).toBe("grounded_context_available");
    expect(result.recoveryContext?.kbExcerpt).toContain("WhatsApp Business");
  });

  it("falls back to grounded recovery when a multi-ask draft still misses an ask after retry", async () => {
    chatCompletionWithFallback
      .mockResolvedValueOnce({
        content: "There are grant options available for this request.",
        provider: "vertex",
        model: "gemini-3.5-flash",
        latencyMs: 80,
        finishReason: "stop",
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          items: [
            {
              askIndex: 1,
              ask: "grants",
              status: "answered",
              confidence: "high",
              answerSpan: "grant options",
              reason: "Grants are mentioned.",
            },
            {
              askIndex: 2,
              ask: "pricing",
              status: "not_answered",
              confidence: "high",
              answerSpan: "",
              reason: "Pricing is missing.",
            },
          ],
          repairInstruction: "Add pricing.",
        }),
        provider: "vertex",
        model: "gemini-light",
        latencyMs: 20,
        finishReason: "stop",
      })
      .mockResolvedValueOnce({
        content:
          "There are grant options available for this request. More details coming soon.",
        provider: "vertex",
        model: "gemini-3.5-flash",
        latencyMs: 90,
        finishReason: "stop",
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          items: [
            {
              askIndex: 1,
              ask: "grants",
              status: "answered",
              confidence: "high",
              answerSpan: "grant options",
              reason: "Grants are mentioned.",
            },
            {
              askIndex: 2,
              ask: "pricing",
              status: "not_answered",
              confidence: "high",
              answerSpan: "",
              reason: "Pricing is still missing.",
            },
          ],
          repairInstruction: "Add pricing.",
        }),
        provider: "vertex",
        model: "gemini-light",
        latencyMs: 20,
        finishReason: "stop",
      });

    const result = await generateAssistantReply(
      "I want to know about grants and pricing",
      {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        preferredLanguage: "en",
        openAsks: ["grants", "pricing"],
        retrievalMetadata: {
          hasSnippet: false,
          hasKB: true,
          priority: "kb",
        },
        kbContext: [
          {
            id: "kb-1",
            title: "Grants",
            fullContent: "Grant programs are available.",
            similarity: 0.9,
            locale: "en",
          },
        ],
      }
    );

    expect(chatCompletionWithFallback).toHaveBeenCalledTimes(4);
    expect(result.fallbackAction).toBe("grounded_recovery");
    expect(result.recoveryContext?.kbExcerpt).toBeDefined();
  });

  it.each([
    ["empty", ""],
    ["identical", "Grant programs are available for qualifying applicants."],
    ["rejected shorter", "Grant programs are available."],
  ])(
    "reuses coverage judgment when the %s repair leaves the chosen reply unchanged",
    async (_repairKind, repairText) => {
      const initialReply =
        "Grant programs are available for qualifying applicants.";
      const partialCoverageResponse = {
        content: JSON.stringify({
          items: [
            {
              askIndex: 1,
              ask: "grants",
              status: "answered",
              confidence: "high",
              answerSpan: "Grant programs are available",
              reason: "Grant availability is answered.",
            },
            {
              askIndex: 2,
              ask: "pricing",
              status: "not_answered",
              confidence: "high",
              answerSpan: "",
              reason: "Pricing is missing.",
            },
          ],
          repairInstruction: "Answer pricing from the grounded context.",
        }),
        provider: "vertex",
        model: "gemini-light",
        latencyMs: 20,
        finishReason: "stop",
      };
      chatCompletionWithFallback
        .mockResolvedValueOnce({
          content: initialReply,
          provider: "vertex",
          model: "gemini-3.5-flash",
          latencyMs: 80,
          finishReason: "stop",
        })
        .mockResolvedValueOnce(partialCoverageResponse)
        .mockResolvedValueOnce({
          content: repairText,
          provider: "vertex",
          model: "gemini-3.5-flash",
          latencyMs: 70,
          finishReason: "stop",
        })
        .mockResolvedValue(partialCoverageResponse);

      const result = await generateAssistantReply(
        "Tell me about grants and pricing",
        {
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          preferredLanguage: "en",
          openAsks: ["grants", "pricing"],
          retrievalMetadata: {
            hasSnippet: false,
            hasKB: true,
            priority: "kb",
          },
          kbContext: [
            {
              id: "kb-1",
              title: "Grant programs",
              fullContent: initialReply,
              similarity: 0.91,
              locale: "en",
            },
          ],
        }
      );

      const coverageCalls = chatCompletionWithFallback.mock.calls.filter(
        ([request]) =>
          request.analytics?.operation === "airi.reply.answer_coverage_judge"
      );
      expect(coverageCalls).toHaveLength(1);
      expect(chatCompletionWithFallback).toHaveBeenCalledTimes(3);
      expect(coverageCalls[0][0].messages[1].content).toContain(initialReply);
      expect(
        chatCompletionWithFallback.mock.calls[2][0].messages[1].content
      ).toContain(initialReply);
      expect(result.coverage?.missingAsks).toEqual(["pricing"]);
      expect(result.fallbackAction).toBe("grounded_recovery");
      expect(result.recoveryContext?.kbExcerpt).toContain(initialReply);
    }
  );

  it("writes the final reply on the heavy Claude tier with the platform provider order", async () => {
    jest
      .mocked(getDefaultAIChatProviderOrder)
      .mockReturnValueOnce(["anthropic", "vertex"]);
    jest.mocked(getHeavyTextModel).mockReturnValueOnce("claude-sonnet-5-5");
    chatCompletionWithFallback.mockResolvedValue({
      content: "Airi.chat supports WhatsApp.",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      latencyMs: 80,
      finishReason: "end_turn",
      usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 },
    });

    const result = await generateAssistantReply("Tell me about WhatsApp", {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      preferredLanguage: "en",
      retrievalMetadata: {
        hasSnippet: false,
        hasKB: true,
        priority: "kb",
      },
      kbContext: [
        {
          id: "kb-1",
          title: "WhatsApp",
          fullContent: "Airi.chat supports WhatsApp.",
          similarity: 0.9,
          locale: "en",
        },
      ],
    });

    expect(chatCompletionWithFallback).toHaveBeenCalledTimes(1);
    const request = chatCompletionWithFallback.mock.calls[0][0];
    expect(request).toMatchObject({
      model: "claude-sonnet-5-5",
      providerOrder: ["anthropic", "vertex"],
      resilience: { maxRetries: 0 },
      analytics: { operation: "airi.reply.final_generation" },
    });
    // Claude ids get low thinking (adaptive at low effort); the visible
    // output cap from the prompt envelope is unchanged.
    expect(request.generationConfig).toEqual({
      thinkingConfig: { thinkingLevel: "LOW" },
      maxOutputTokens: 1400,
    });
    expect(result.reply).toBe("Airi.chat supports WhatsApp.");
    // Persisted inference metadata reports the provider that served the call.
    expect(result.inference).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      promptTokens: 900,
      completionTokens: 40,
      totalTokens: 940,
      finishReason: "end_turn",
    });
  });

  it("uses the platform default provider order for the final writer", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content: "Airi.chat supports WhatsApp.",
      provider: "vertex",
      model: "gemini-3.5-flash",
      latencyMs: 80,
      finishReason: "stop",
    });

    await generateAssistantReply("Tell me about WhatsApp", {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      preferredLanguage: "en",
      retrievalMetadata: {
        hasSnippet: false,
        hasKB: true,
        priority: "kb",
      },
      kbContext: [
        {
          id: "kb-1",
          title: "WhatsApp",
          fullContent: "Airi.chat supports WhatsApp.",
          similarity: 0.9,
          locale: "en",
        },
      ],
    });

    expect(chatCompletionWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOrder: ["vertex"],
      })
    );
  });

  it("does not run the verifier or repair pass for a single ambiguous ask", async () => {
    chatCompletionWithFallback
      .mockResolvedValueOnce({
        content: "The grant process starts with a short form.",
        provider: "vertex",
        model: "gemini-3.5-flash",
        latencyMs: 80,
        finishReason: "stop",
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          items: [
            {
              askIndex: 1,
              ask: "grant application process",
              status: "partially_answered",
              confidence: "medium",
              answerSpan: "grant process starts with a short form",
              reason: "It partly answers the process.",
            },
          ],
          repairInstruction: "Clarify the full application process.",
        }),
        provider: "vertex",
        model: "gemini-light",
        latencyMs: 20,
        finishReason: "stop",
      });

    const result = await generateAssistantReply(
      "Tell me about the grant application process",
      {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        preferredLanguage: "en",
        openAsks: ["grant application process"],
        retrievalMetadata: {
          hasSnippet: false,
          hasKB: true,
          priority: "kb",
        },
        kbContext: [
          {
            id: "kb-1",
            title: "Grant process",
            fullContent: "The grant process starts with a short form.",
            similarity: 0.91,
            locale: "en",
          },
        ],
      }
    );

    expect(chatCompletionWithFallback).toHaveBeenCalledTimes(1);
    expect(result.fallbackAction).toBe("use_generated_reply");
    expect(result.reply).toContain("short form");
    expect(
      chatCompletionWithFallback.mock.calls[0][0].messages[1].content
    ).not.toContain("Answer coverage plan:");
  });

  it("repairs missing multi-ask coverage using the structured coverage judge", async () => {
    chatCompletionWithFallback
      .mockResolvedValueOnce({
        content:
          "The grant process starts with a short form. Pricing depends on the package.",
        provider: "vertex",
        model: "gemini-3.5-flash",
        latencyMs: 80,
        finishReason: "stop",
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          items: [
            {
              askIndex: 1,
              ask: "grant application process",
              status: "partially_answered",
              confidence: "medium",
              answerSpan: "grant process starts with a short form",
              reason: "The reply gives only part of the process.",
            },
            {
              askIndex: 2,
              ask: "pricing",
              status: "answered",
              confidence: "high",
              answerSpan: "Pricing depends on the package",
              reason: "Pricing is answered.",
            },
          ],
          repairInstruction: "Answer the full grant application process.",
        }),
        provider: "vertex",
        model: "gemini-light",
        latencyMs: 20,
        finishReason: "stop",
      })
      .mockResolvedValueOnce({
        content:
          "The grant application process starts with a short form, and pricing depends on the package.",
        provider: "vertex",
        model: "gemini-3.5-flash",
        latencyMs: 70,
        finishReason: "stop",
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          items: [
            {
              askIndex: 1,
              ask: "grant application process",
              status: "answered",
              confidence: "high",
              answerSpan: "grant application process starts with a short form",
              reason: "The process ask is answered.",
            },
            {
              askIndex: 2,
              ask: "pricing",
              status: "answered",
              confidence: "high",
              answerSpan: "pricing depends on the package",
              reason: "Pricing is answered.",
            },
          ],
          repairInstruction: null,
        }),
        provider: "vertex",
        model: "gemini-light",
        latencyMs: 20,
        finishReason: "stop",
      });

    const result = await generateAssistantReply(
      "Tell me about the grant application process and pricing",
      {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        preferredLanguage: "en",
        openAsks: ["grant application process", "pricing"],
        retrievalMetadata: {
          hasSnippet: false,
          hasKB: true,
          priority: "kb",
        },
        kbContext: [
          {
            id: "kb-1",
            title: "Grant process",
            fullContent: "The grant process starts with a short form.",
            similarity: 0.91,
            locale: "en",
          },
          {
            id: "kb-2",
            title: "Pricing",
            fullContent: "Pricing depends on the package.",
            similarity: 0.89,
            locale: "en",
          },
        ],
      }
    );

    expect(chatCompletionWithFallback).toHaveBeenCalledTimes(4);
    expect(result.reply).toContain("grant application process");
    expect(result.reply.toLowerCase()).toContain("pricing");
    expect(result.fallbackAction).toBe("use_generated_reply");
    expect(
      chatCompletionWithFallback.mock.calls[2][0].messages[1].content
    ).toContain(
      "Missing asks from the previous draft: grant application process"
    );
    expect(
      chatCompletionWithFallback.mock.calls[2][0].responseFormat
    ).toBeUndefined();
  });

  it("strips ask and goal paragraphs from agent context when answer coverage is already present", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content: "Grants are available and pricing depends on the package.",
      provider: "vertex",
      model: "gemini-3.5-flash",
      latencyMs: 80,
      finishReason: "stop",
    });

    await generateAssistantReply("Tell me about grants and pricing", {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      preferredLanguage: "en",
      openAsks: ["grants", "pricing"],
      followUpAnchor: "pricing",
      retrievalMetadata: {
        hasSnippet: false,
        hasKB: true,
        priority: "kb",
      },
      kbContext: [
        {
          id: "kb-1",
          title: "Pricing and grants",
          fullContent:
            "Grant programs are available. Pricing depends on the package.",
          similarity: 0.92,
          locale: "en",
        },
      ],
      agentContextBlock: [
        "CURRENT CUSTOMER GOAL: grants and pricing",
        "ACTIVE THREAD GOALS:\n- grants\n- pricing",
        "LATEST ASKS TO COVER:\n- grants\n- pricing",
        "FOLLOW-UP ANCHOR: pricing",
        "AVAILABLE ACTIONS:\n- Answer with grounded facts: Use the KB",
      ].join("\n\n"),
    });

    const prompt = chatCompletionWithFallback.mock.calls[0][0].messages[1]
      .content as string;

    expect(prompt).toContain("Answer coverage plan:");
    expect(prompt).not.toContain("CURRENT CUSTOMER GOAL:");
    expect(prompt).not.toContain("ACTIVE THREAD GOALS:");
    expect(prompt).not.toContain("LATEST ASKS TO COVER:");
    expect(prompt).not.toContain("FOLLOW-UP ANCHOR:");
    expect(prompt).toContain("AVAILABLE ACTIONS:");
  });

  it("merges cross-conversation context and summaries into one related-context section", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content:
        "The customer previously asked about grant conditions and deadlines.",
      provider: "vertex",
      model: "gemini-3.5-flash",
      latencyMs: 80,
      finishReason: "stop",
    });

    await generateAssistantReply("Can you continue?", {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      preferredLanguage: "en",
      retrievalMetadata: {
        hasSnippet: false,
        hasKB: true,
        priority: "kb",
      },
      kbContext: [
        {
          id: "kb-1",
          title: "Grant support",
          fullContent:
            "We help with grant conditions and application deadlines.",
          similarity: 0.91,
          locale: "en",
        },
      ],
      crossConversationContext:
        "Customer already asked about grant conditions.",
      conversationSummaries: [
        {
          conversationId: "conv-1",
          summaryText: "Customer already asked about grant conditions.",
          similarity: 0.95,
        },
        {
          conversationId: "conv-2",
          summaryText: "They also asked about deadlines last week.",
          similarity: 0.88,
        },
      ],
    });

    const prompt = chatCompletionWithFallback.mock.calls[0][0].messages[1]
      .content as string;

    expect(prompt).toContain("Related conversation context:");
    expect(prompt).not.toContain("Relevant past conversations:");
    expect(prompt).toContain("Relevant past conversation summaries:");
    expect(
      (prompt.match(/Customer already asked about grant conditions\./g) || [])
        .length
    ).toBe(1);
    expect(prompt).toContain("They also asked about deadlines last week.");
  });

  it("switches broad services questions into the overview output profile", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content: `• Бесплатный канал с грантами

• Индивидуальная консультация

• Написание заявки под ключ`,
      provider: "vertex",
      model: "gemini-3.5-flash",
      latencyMs: 70,
      finishReason: "stop",
    });

    const result = await generateAssistantReply("Какие есть услуги?", {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      preferredLanguage: "ru",
      retrievalMetadata: {
        hasSnippet: false,
        hasKB: true,
        priority: "kb",
      },
      kbContext: [
        {
          id: "kb-1",
          title: "Бесплатный канал",
          fullContent: "Бесплатный канал с грантами.",
          similarity: 0.92,
          locale: "ru",
        },
        {
          id: "kb-2",
          title: "Консультация",
          fullContent: "Индивидуальная консультация.",
          similarity: 0.9,
          locale: "ru",
        },
        {
          id: "kb-3",
          title: "Под ключ",
          fullContent: "Написание заявки под ключ.",
          similarity: 0.88,
          locale: "ru",
        },
      ],
      openAsks: ["Какие есть услуги?"],
    });

    expect(result.promptDiagnostics?.outputProfile).toBe("grounded_overview");
  });

  it("uses a grounded output profile when KB context exists even without retrieval metadata", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content: `• Бесплатный канал с грантами

• Индивидуальная консультация

• Написание заявки под ключ`,
      provider: "vertex",
      model: "gemini-3.5-flash",
      latencyMs: 70,
      finishReason: "stop",
    });

    const result = await generateAssistantReply("Какие есть услуги?", {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      preferredLanguage: "ru",
      kbContext: [
        {
          id: "kb-1",
          title: "Бесплатный канал",
          fullContent: "Бесплатный канал с грантами.",
          similarity: 0.92,
          locale: "ru",
        },
        {
          id: "kb-2",
          title: "Консультация",
          fullContent: "Индивидуальная консультация.",
          similarity: 0.9,
          locale: "ru",
        },
        {
          id: "kb-3",
          title: "Под ключ",
          fullContent: "Написание заявки под ключ.",
          similarity: 0.88,
          locale: "ru",
        },
      ],
      openAsks: ["Какие есть услуги?"],
    });

    expect(result.promptDiagnostics?.outputProfile).toBe("grounded_overview");
  });

  it("does not append an unconfirmed-details disclaimer when disability wording is already covered", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content: `У Фонда есть программа для молодых людей с ограниченными возможностями:

• Программа «Получи ремесло!»
• Цель: поддержка молодых людей с ограниченными возможностями из малообеспеченных семей.
• Назначение: обучение в лицеях, училищах и колледжах Казахстана.`,
      provider: "vertex",
      model: "gemini-3.5-flash",
      latencyMs: 70,
      finishReason: "stop",
    });

    const result = await generateAssistantReply(
      "А что по программе для инвалидов?",
      {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        preferredLanguage: "ru",
        retrievalMetadata: {
          hasSnippet: false,
          hasKB: true,
          priority: "kb",
        },
        kbContext: [
          {
            id: "kb-1",
            title: "Получи ремесло",
            fullContent:
              "Программа «Получи ремесло!» поддерживает молодых людей с ограниченными возможностями из малообеспеченных семей.",
            similarity: 0.94,
            locale: "ru",
          },
        ],
        openAsks: ["А что по программе для инвалидов?"],
      }
    );

    expect(result.fallbackAction).toBe("use_generated_reply");
    expect(result.reply).toContain("Получи ремесло");
    expect(result.reply).not.toContain("Отдельно отмечу");
    expect(result.reply).not.toContain("нет подтвержденных деталей");
  });
});
