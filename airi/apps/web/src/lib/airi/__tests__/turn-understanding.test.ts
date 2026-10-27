import { buildGroundedReplyOptionPayload } from "@/lib/airi/reply/selection";
import { understandCustomerTurn } from "@/lib/airi/reply/turn/understand-customer-turn";

const chatCompletionWithFallback = jest.fn();

jest.mock("@/lib/ai", () => {
  const actual = jest.requireActual<typeof import("@/lib/ai")>("@/lib/ai");
  return {
    ...actual,
    chatCompletionWithFallback: (...args: unknown[]) =>
      chatCompletionWithFallback(...args),
    getDefaultAIChatProviderOrder: jest.fn(() => ["vertex"]),
    getLightTextModel: jest.fn(() => "claude-haiku-4-5"),
    formatError: jest.fn((error: unknown) =>
      error instanceof Error ? error.message : String(error)
    ),
  };
});

describe("turn understanding", () => {
  beforeEach(() => {
    chatCompletionWithFallback.mockReset();
  });

  it("preserves Google classification through the metered facade for a Kazakh turn", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        kind: "question",
        proceedWithRag: true,
        confidence: "high",
        asks: ["Бағасы қанша?"],
        cleanedQuery: "Бағасы қанша?",
      }),
      provider: "google",
      model: "gemini-test",
    });
    await understandCustomerTurn("Бағасы қанша?", "kz", "", {
      elevenlabsAgentId: "kz-agent",
    });
    expect(chatCompletionWithFallback).toHaveBeenCalledTimes(1);
  });

  it("classifies sponsored Kazakh turns through the metered facade despite legacy agent settings", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        kind: "question",
        proceedWithRag: true,
        confidence: "high",
        asks: ["Бағасы қанша?"],
        cleanedQuery: "Бағасы қанша?",
      }),
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
    const result = await understandCustomerTurn("Бағасы қанша?", "kz", "", {
      elevenlabsAgentId: "legacy-agent",
    });
    expect(result.kind).toBe("question");
    expect(result.asks).toEqual(["Бағасы қанша?"]);
    expect(chatCompletionWithFallback).toHaveBeenCalledTimes(1);
  });

  it.each([
    "own_ai_source_required",
    "workspace_ai_policy_unavailable",
    "workspace_ai_spend_limit",
    "workspace_ai_operation_replayed",
  ])("preserves %s from the metered turn classifier", async code => {
    const error = Object.assign(new Error("AI billing unavailable"), {
      code,
    });
    chatCompletionWithFallback.mockRejectedValue(error);
    await expect(
      understandCustomerTurn("Бағасы қанша?", "kz", "", {
        elevenlabsAgentId: "kz-agent",
      })
    ).rejects.toBe(error);
    expect(chatCompletionWithFallback).toHaveBeenCalledTimes(1);
  });

  it("uses offline structural planning when the classifier is unavailable", async () => {
    const latestMessage = "Hello, I want to know about Airi.chat and WhatsApp";
    chatCompletionWithFallback.mockRejectedValue(new Error("provider offline"));

    const result = await understandCustomerTurn(latestMessage, "en", "", {
      intentAnchor: "",
      hasUnresolvedNeed: false,
    });

    expect(result.kind).toBe("unknown");
    expect(result.proceedWithRag).toBe(true);
    expect(result.safeReplyKey).toBeNull();
    expect(result.threadScaffold.trackThreadNeed).toBe(true);
    expect(result.asks.length).toBeGreaterThan(0);
    expect(result.queryVariants.length).toBeGreaterThan(0);
    expect(result.planningSource).toBe("fallback");
    expect(result.ragQueryPreparation).toEqual({
      cleanedQuery: latestMessage,
      subQueries: [],
      originalQuery: latestMessage,
      wasCleaned: false,
      source: "fallback",
    });
  });

  it("offline mode avoids thread-memory tracking for a very short inbound", async () => {
    chatCompletionWithFallback.mockRejectedValue(new Error("provider offline"));

    const result = await understandCustomerTurn("Hello", "en", "");

    expect(result.kind).toBe("unknown");
    expect(result.proceedWithRag).toBe(true);
    expect(result.threadScaffold.trackThreadNeed).toBe(false);
    expect(result.planningSource).toBe("fallback");
    expect(result.ragQueryPreparation).toEqual({
      cleanedQuery: "Hello",
      subQueries: [],
      originalQuery: "Hello",
      wasCleaned: false,
      source: "fallback",
    });
  });

  it("uses structured multi-ask planning from the model when available", async () => {
    const latestMessage = "I want to know about grants and pricing";

    chatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        kind: "question",
        proceedWithRag: true,
        dependsOnPriorContext: false,
        safeReplyKey: null,
        confidence: "high",
        asks: ["about grants", "about pricing"],
        coverageHints: ["grants", "pricing"],
        followUpMode: "none",
        followUpAnchor: null,
        queryVariants: [
          "about grants and pricing",
          "about grants",
          "about pricing",
        ],
        cleanedQuery: "about grants and pricing",
        subQueries: ["about grants", "about pricing"],
      }),
      provider: "vertex",
      model: "gemini-3.5-flash",
      latencyMs: 50,
    });

    const result = await understandCustomerTurn(latestMessage, "en", "");

    expect(result.kind).toBe("question");
    expect(result.planningSource).toBe("model");
    expect(result.asks).toEqual(["about grants", "about pricing"]);
    expect(result.coverageHints).toEqual(["grants", "pricing"]);
    expect(result.queryVariants[0]).toBe("about grants and pricing");
    expect(result.ragQueryPreparation).toEqual({
      cleanedQuery: "about grants and pricing",
      subQueries: ["about grants", "about pricing"],
      originalQuery: latestMessage,
      wasCleaned: true,
      source: "llm",
    });
    expect(chatCompletionWithFallback).toHaveBeenCalledTimes(1);
  });

  it("reuses the model turn as the retrieval-intent decision", async () => {
    const latestMessage = "How much does the business plan cost?";

    chatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        kind: "question",
        proceedWithRag: true,
        calendarAvailabilityRelevant: false,
        dependsOnPriorContext: false,
        safeReplyKey: null,
        confidence: "high",
        asks: ["business plan price"],
        coverageHints: ["price", "business plan"],
        followUpMode: "none",
        followUpAnchor: null,
        queryVariants: ["business plan price"],
        cleanedQuery: "business plan price",
        subQueries: [],
        retrievalIntent: {
          label: "pricing",
          confidence: "high",
          language: "en",
          queryVariants: [],
          reason: "The customer asks for a specific plan price.",
        },
        trackThreadNeed: true,
        conversationalFollowup: false,
        shortEntityReference: false,
        contextDependentGenericQuestion: false,
        preferStandaloneAskOverFollowUpAnchor: false,
        genericResumeContinuation: false,
        selectionTransitionAction: "none",
        selectionLabel: null,
      }),
      provider: "vertex",
      model: "gemini-3.5-flash",
      latencyMs: 50,
    });

    const result = await understandCustomerTurn(latestMessage, "en", "");

    expect(result.retrievalIntent).toEqual({
      query: "business plan price",
      language: "en",
      label: "pricing",
      confidence: "high",
      shouldUseBroadRetrieval: false,
      shouldUseOverviewVariants: false,
      queryVariants: [],
      reason: "The customer asks for a specific plan price.",
      source: "turn_understanding",
    });
    expect(chatCompletionWithFallback).toHaveBeenCalledTimes(1);
  });

  it("uses model-provided calendar availability relevance as the scheduling gate", async () => {
    const latestMessage = "Can we book a demo call this week?";

    chatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        kind: "question",
        proceedWithRag: true,
        calendarAvailabilityRelevant: true,
        dependsOnPriorContext: false,
        safeReplyKey: null,
        confidence: "high",
        asks: ["book a demo call this week"],
        coverageHints: ["demo call", "this week"],
        followUpMode: "none",
        followUpAnchor: null,
        queryVariants: ["book a demo call this week"],
        cleanedQuery: "book a demo call this week",
        subQueries: [],
        trackThreadNeed: true,
        conversationalFollowup: false,
        shortEntityReference: false,
        contextDependentGenericQuestion: false,
        preferStandaloneAskOverFollowUpAnchor: false,
        genericResumeContinuation: false,
        selectionTransitionAction: "none",
        selectionLabel: null,
      }),
      provider: "vertex",
      model: "gemini-3.5-flash",
      latencyMs: 50,
    });

    const result = await understandCustomerTurn(latestMessage, "en", "");

    expect(result.calendarAvailabilityRelevant).toBe(true);
    const schema =
      chatCompletionWithFallback.mock.calls[0]?.[0]?.generationConfig
        ?.responseSchema;
    expect(schema.required).toContain("calendarAvailabilityRelevant");
  });

  it("returns deterministic planning for a grounded option payload without another model call", async () => {
    const result = await understandCustomerTurn(
      "QazInnovation guide",
      "en",
      "",
      {
        quickReplyPayload: buildGroundedReplyOptionPayload({
          id: "kb-qazinnovation-guide",
          label: "QazInnovation guide",
          selectionKind: "offer",
          sourceKind: "kb",
          sourceIds: ["kb-qazinnovation-guide", "doc-qazinnovation-guide"],
          sourceRecordId: "kb-qazinnovation-guide",
          sourceDocumentId: "doc-qazinnovation-guide",
          quotedPriceText: "7000 KZT",
          quotedPriceAmount: 7000,
          quotedPriceCurrency: "KZT",
        }),
      }
    );

    expect(result.kind).toBe("followup_question");
    expect(result.planningSource).toBe("fallback");
    expect(result.followUpMode).toBe("resume_current_goal");
    expect(result.selectionTransition).toEqual({
      action: "select_offer",
      selectionLabel: "QazInnovation guide",
    });
    expect(result.ragQueryPreparation).toEqual({
      cleanedQuery: "QazInnovation guide 7000 KZT",
      subQueries: [],
      originalQuery: "QazInnovation guide",
      wasCleaned: true,
      source: "fallback",
    });
    expect(chatCompletionWithFallback).not.toHaveBeenCalled();
  });

  it("sends a response schema Claude accepts: no enum under a type list", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({ kind: "thanks", proceedWithRag: false }),
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
    await understandCustomerTurn("Спасибо", "ru", "");

    const { convertGeminiSchemaToJsonSchema } = jest.requireActual<
      typeof import("@/lib/ai/anthropic-messages")
    >("@/lib/ai/anthropic-messages");
    const converted = convertGeminiSchemaToJsonSchema(
      chatCompletionWithFallback.mock.calls[0]?.[0]?.generationConfig
        ?.responseSchema
    );
    const rejected: string[] = [];
    const visit = (node: unknown, path: string) => {
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (Array.isArray(record.enum) && Array.isArray(record.type)) {
        rejected.push(path);
      }
      for (const [key, child] of Object.entries(record)) {
        visit(child, `${path}.${key}`);
      }
    };
    visit(converted, "schema");
    expect(rejected).toEqual([]);
  });

  it.each([
    [
      "the model is unavailable",
      () =>
        chatCompletionWithFallback.mockRejectedValue(
          new Error("provider offline")
        ),
    ],
    [
      "the model gives no retrieval label",
      () =>
        chatCompletionWithFallback.mockResolvedValue({
          content: JSON.stringify({
            kind: "question",
            proceedWithRag: true,
            confidence: "high",
            cleanedQuery: "доставка в Астану",
          }),
          provider: "anthropic",
          model: "claude-haiku-4-5",
        }),
    ],
  ])(
    "hands retrieval a routing intent when %s, so it skips its own classifier",
    async (_label, arrange) => {
      arrange();
      const result = await understandCustomerTurn(
        "Сколько стоит доставка в Астану?",
        "ru",
        ""
      );
      expect(result.proceedWithRag).toBe(true);
      expect(result.retrievalIntent).toMatchObject({
        label: "unclear",
        confidence: "low",
        shouldUseBroadRetrieval: false,
        source: "turn_understanding",
      });
    }
  );

  it("hands retrieval a routing intent for a grounded option pick", async () => {
    const result = await understandCustomerTurn("Guide", "en", "", {
      quickReplyPayload: buildGroundedReplyOptionPayload({
        id: "kb-guide",
        label: "Guide",
        selectionKind: "offer",
        sourceKind: "kb",
        sourceIds: ["kb-guide"],
        sourceRecordId: "kb-guide",
      }),
    });
    expect(result.retrievalIntent).toMatchObject({
      query: "Guide",
      source: "turn_understanding",
    });
  });

  it("sends recent conversation context and a response schema to the model", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        kind: "followup_question",
        proceedWithRag: true,
        dependsOnPriorContext: true,
        safeReplyKey: null,
        confidence: "high",
        asks: ["БесТірек"],
        coverageHints: ["клиент подтвердил БесТірек"],
        followUpMode: "expand_last_grounding",
        followUpAnchor: "БесТірек",
        queryVariants: ["БесТірек грант"],
        cleanedQuery: "БесТірек грант",
        subQueries: [],
        trackThreadNeed: true,
        conversationalFollowup: false,
        shortEntityReference: false,
        contextDependentGenericQuestion: true,
        preferStandaloneAskOverFollowUpAnchor: false,
        genericResumeContinuation: false,
        selectionTransitionAction: "select_offer",
        selectionLabel: "БесТірек",
      }),
      provider: "vertex",
      model: "gemini-3.5-flash",
      latencyMs: 50,
    });

    const longWindow = [
      `Old context ${"x".repeat(2600)}`,
      "Airi: Подскажите, вас интересует именно грант «БесТірек» для обучения в AlmaU?",
      "Customer: Да",
    ].join("\n");

    await understandCustomerTurn("Да", "ru", longWindow);

    const call = chatCompletionWithFallback.mock.calls[0]?.[0];
    // Turn understanding is a light-tier JSON classification.
    expect(call.model).toBe("claude-haiku-4-5");
    expect(call.responseFormat).toEqual({ type: "json_object" });
    expect(call.generationConfig?.responseSchema).toEqual(
      expect.objectContaining({ type: "OBJECT" })
    );
    expect(call.messages[1].content).toContain("Recent context excerpt");
    expect(call.messages[1].content).toContain("БесТірек");
  });

  it("reads a turn verdict wrapped in a markdown fence", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content: [
        "```json",
        JSON.stringify({
          kind: "question",
          proceedWithRag: true,
          calendarAvailabilityRelevant: false,
          dependsOnPriorContext: false,
          safeReplyKey: null,
          confidence: "high",
          asks: ["What does the premium plan cost?"],
          coverageHints: [],
          followUpMode: "none",
          followUpAnchor: null,
          queryVariants: ["premium plan price"],
          cleanedQuery: "premium plan price",
          subQueries: [],
          trackThreadNeed: true,
          conversationalFollowup: false,
          shortEntityReference: false,
          contextDependentGenericQuestion: false,
          preferStandaloneAskOverFollowUpAnchor: false,
          genericResumeContinuation: false,
          selectionTransitionAction: "none",
          selectionLabel: null,
        }),
        "```",
      ].join("\n"),
      provider: "anthropic",
      model: "claude-haiku-4-5",
      latencyMs: 40,
    });

    const result = await understandCustomerTurn(
      "What does the premium plan cost?",
      "en",
      ""
    );

    expect(result.planningSource).toBe("model");
    expect(result.kind).toBe("question");
    expect(result.confidence).toBe("high");
    expect(result.asks).toEqual(["What does the premium plan cost?"]);
  });

  it("anchors generic follow-ups to the last grounded topic", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        kind: "followup_question",
        proceedWithRag: true,
        dependsOnPriorContext: true,
        safeReplyKey: null,
        confidence: "high",
        asks: ["Tell me more about turnkey support"],
        coverageHints: ["turnkey", "how it works"],
        followUpMode: "expand_last_grounding",
        followUpAnchor: "Turnkey",
        queryVariants: ["Turnkey", "Tell me more about turnkey support"],
        cleanedQuery: "Turnkey",
        subQueries: ["Tell me more about turnkey support"],
      }),
      provider: "vertex",
      model: "gemini-3.5-flash",
      latencyMs: 50,
    });

    const result = await understandCustomerTurn(
      "Tell me more?",
      "en",
      "2026-03-31T12:01:00.000Z [AGENT] Airi: yes, we can help turnkey.",
      {
        intentAnchor: "Turnkey",
        currentGoal: "Turnkey",
        hasUnresolvedNeed: true,
        lastGrounding: {
          intentAnchor: "Turnkey",
          answeredAsks: ["Turnkey"],
        },
      }
    );

    expect(result.kind).toBe("followup_question");
    expect(result.dependsOnPriorContext).toBe(true);
    expect(result.followUpMode).toBe("expand_last_grounding");
    expect(result.followUpAnchor).toBe("Turnkey");
    expect(result.queryVariants[0]).toBe("Turnkey");
    expect(result.ragQueryPreparation).toEqual({
      cleanedQuery: "Turnkey",
      subQueries: ["Tell me more about turnkey support"],
      originalQuery: "Tell me more?",
      wasCleaned: true,
      source: "llm",
    });
  });

  it("falls back to deterministic planning when the model output is malformed", async () => {
    const latestMessage = "Tell me more?";

    chatCompletionWithFallback.mockResolvedValue({
      content: "{not valid json",
      provider: "vertex",
      model: "gemini-3.5-flash",
      latencyMs: 50,
    });

    const result = await understandCustomerTurn(latestMessage, "en", "", {
      intentAnchor: "Turnkey",
      currentGoal: "Turnkey",
      hasUnresolvedNeed: true,
      lastGrounding: {
        intentAnchor: "Turnkey",
        answeredAsks: ["Turnkey"],
      },
    });

    expect(result.proceedWithRag).toBe(true);
    expect(result.planningSource).toBe("fallback");
    expect(result.followUpMode).toBe("expand_last_grounding");
    expect(result.followUpAnchor).toBe("Turnkey");
    expect(result.queryVariants).toContain(latestMessage);
    expect(result.ragQueryPreparation).toEqual({
      cleanedQuery: latestMessage,
      subQueries: [],
      originalQuery: latestMessage,
      wasCleaned: false,
      source: "fallback",
    });
  });

  it("keeps a substantive service ask primary when low-confidence follow-up planning falls back", async () => {
    const latestMessage = "Do you offer individual work?";

    chatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        kind: "followup_question",
        proceedWithRag: true,
        dependsOnPriorContext: true,
        safeReplyKey: null,
        confidence: "low",
        asks: ["Do you offer individual work for QazInnovation"],
        coverageHints: ["individual work", "QazInnovation"],
        followUpMode: "resume_unresolved_need",
        followUpAnchor: "QazInnovation",
        queryVariants: [
          "QazInnovation",
          "Do you offer individual work for QazInnovation",
        ],
      }),
      provider: "vertex",
      model: "gemini-3.5-flash",
      latencyMs: 50,
    });

    const result = await understandCustomerTurn(latestMessage, "en", "", {
      intentAnchor: "QazInnovation",
      currentGoal: "QazInnovation",
      hasUnresolvedNeed: true,
      unresolvedNeeds: ["QazInnovation"],
      lastGrounding: {
        intentAnchor: "QazInnovation",
        answeredAsks: ["I want to win QazInnovation"],
      },
    });

    expect(result.planningSource).toBe("fallback");
    expect(result.asks).toEqual([latestMessage]);
    expect(result.queryVariants[0]).toBe(latestMessage);
    expect(result.queryVariants).toContain("QazInnovation");
    expect(result.ragQueryPreparation).toEqual({
      cleanedQuery: latestMessage,
      subQueries: [],
      originalQuery: latestMessage,
      wasCleaned: false,
      source: "fallback",
    });
  });

  it("keeps detailed how-questions standalone when stale small talk remains in memory", async () => {
    const latestAsk = "How can I win the Bestirek grant?";
    const currentGoal = "Find out whether I qualify";

    chatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        kind: "followup_question",
        proceedWithRag: true,
        dependsOnPriorContext: true,
        safeReplyKey: null,
        confidence: "low",
        asks: ["How are you?"],
        coverageHints: ["How are you?"],
        followUpMode: "resume_unresolved_need",
        followUpAnchor: "How are you?",
        queryVariants: ["How are you?"],
      }),
      provider: "vertex",
      model: "gemini-3.5-flash",
      latencyMs: 50,
    });

    const result = await understandCustomerTurn(latestAsk, "en", "", {
      intentAnchor: currentGoal,
      currentGoal,
      hasUnresolvedNeed: true,
      unresolvedNeeds: [
        "How are you?",
        "Are there tricks that help me get accepted?",
        currentGoal,
      ],
      lastGrounding: {
        intentAnchor: currentGoal,
        answeredAsks: [currentGoal],
      },
    });

    expect(result.planningSource).toBe("fallback");
    expect(result.asks).toEqual([latestAsk]);
    expect(result.followUpAnchor).toBe(currentGoal);
    expect(result.queryVariants[0]).toBe(latestAsk);
    expect(result.queryVariants).not.toContain("How are you?");
    expect(result.ragQueryPreparation).toEqual({
      cleanedQuery: latestAsk,
      subQueries: [],
      originalQuery: latestAsk,
      wasCleaned: false,
      source: "fallback",
    });
  });

  it("anchors a scenario location answer on the step's question without a model call", async () => {
    const result = await understandCustomerTurn(
      "[Location] 51.105938, 71.396126",
      "ru",
      "",
      {
        hasUnresolvedNeed: true,
        intentAnchor: "Хочу в вас инвестировать",
        lastGrounding: { intentAnchor: "Хочу в вас инвестировать" },
        scenarioStepAnswer: {
          kind: "location",
          question: "Отправьте свою локацию, запланируем поездку к вам",
        },
      }
    );

    expect(chatCompletionWithFallback).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: "data_sharing",
      dependsOnPriorContext: true,
      asks: [],
      followUpMode: "resume_current_goal",
      followUpAnchor: "Отправьте свою локацию, запланируем поездку к вам",
      queryVariants: ["Отправьте свою локацию, запланируем поездку к вам"],
    });
    expect(JSON.stringify(result)).not.toContain("инвестировать");
    expect(result.scenarioStepQuestion).toBe(
      "Отправьте свою локацию, запланируем поездку к вам"
    );
    // Retrieval reuses this decision instead of calling its own classifier.
    expect(result.retrievalIntent?.source).toBe("turn_understanding");
  });
});
