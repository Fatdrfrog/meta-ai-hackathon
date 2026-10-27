import { RagResponseService } from "@/lib/airi/rag/response/rag-response-service";
import type { RAGGenerateResponseParams } from "@/lib/airi/rag/response/types";
import { AIChatProviderAggregateError } from "@/lib/ai/provider-errors";

const chatCompletionWithFallback = jest.fn();
const retrieveHybridContext = jest.fn();
const selectBestContext = jest.fn();
const generateAssistantReply = jest.fn();
const generateFallbackRecoveryReply = jest.fn();
const evaluateFactualGroundingGuard = jest.fn();
const toMissingKnowledgeSignal = jest.fn();
const runLlmGroundingReflection = jest.fn();
const recordRagTurnAnalyticsEvents = jest.fn();
const classifyRetrievalIntent = jest.fn();

// Keep the cache boundary stateful: a miss-only mock would hide answer reuse
// if a future fast path bypasses retrieval or generation for repeated turns.
const cachedValues = new Map<string, { value: unknown; expiresAt: number }>();
let cacheTimeMs = 0;

async function waitForQueuedWork(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

jest.mock("@/lib/kb/content-utils", () => ({
  extractPlainText: (content: string) => content,
}));

jest.mock("@/lib/airi/rag/pipeline/hybrid-retrieval", () => ({
  retrieveHybridContext: (...args: unknown[]) => retrieveHybridContext(...args),
  // Minimal stand-in for the real getRetrievalSummary: pass through the
  // hyde provenance fields aggregated by the orchestrator, so rag-response
  // consumers see them without having to recompute them here.
  getRetrievalSummary: jest.fn(
    (context: { retrievalStats?: Record<string, unknown> } = {}) => ({
      kbArticlesFound: 0,
      topKBSimilarity: null,
      hydeApplied: Boolean(context.retrievalStats?.hydeApplied),
      hydeSources: Array.isArray(context.retrievalStats?.hydeSources)
        ? (context.retrievalStats?.hydeSources as string[])
        : [],
    })
  ),
}));

jest.mock("@/lib/airi/rag/query/retrieval-intent-classifier", () => ({
  classifyRetrievalIntent: (...args: unknown[]) =>
    classifyRetrievalIntent(...args),
}));

jest.mock("@/lib/airi/rag/decision/decision-engine", () => ({
  selectBestContext: (...args: unknown[]) => selectBestContext(...args),
}));

jest.mock("@/lib/cache", () => ({
  buildCacheKey: (prefix: string, parts: string[]) =>
    `${prefix}:${parts.join(":")}`,
  cache: {
    get: async (key: string) => {
      const entry = cachedValues.get(key);
      return entry && entry.expiresAt > cacheTimeMs
        ? structuredClone(entry.value)
        : null;
    },
    set: async (key: string, value: unknown, ttlSeconds: number) => {
      cachedValues.set(key, {
        value: structuredClone(value),
        expiresAt: cacheTimeMs + ttlSeconds * 1000,
      });
    },
    del: async (key: string) => cachedValues.delete(key),
  },
}));

jest.mock("@/lib/ai", () => {
  const models = jest.requireActual<typeof import("@/lib/ai/text-models")>(
    "@/lib/ai/text-models"
  );
  return {
    cosineSimilarity: jest.fn(),
    chatCompletionWithFallback: (...args: unknown[]) =>
      chatCompletionWithFallback(...args),
    getDefaultAIChatProviderOrder: () => ["anthropic"],
    getHeavyTextModel: () => "claude-sonnet-5-5",
    getStructuredJsonGenerationConfig: models.getStructuredJsonGenerationConfig,
  };
});
jest.mock("@/lib/ai/text-provider-config", () => ({
  canUseTextAI: () => true,
}));
jest.mock("@/lib/airi/conversation", () => ({
  hasGreetedToday: async () => false,
}));
jest.mock("@/lib/airi/coach/coach-utils", () => ({
  redactPII: (text: string) => ({ redacted: text, map: {} }),
  unredact: (text: string) => text,
}));

jest.mock("@/lib/posthog/server", () => ({
  getPostHogClient: () => null,
}));

jest.mock("@/lib/airi/agent-context", () => ({
  buildAgentContext: jest.fn(() => ({
    toPromptBlock: () => "AGENT CONTEXT",
  })),
}));

jest.mock("@/lib/airi/grounding/factual-grounding-guard", () => ({
  evaluateFactualGroundingGuard: (...args: unknown[]) =>
    evaluateFactualGroundingGuard(...args),
  toMissingKnowledgeSignal: (...args: unknown[]) =>
    toMissingKnowledgeSignal(...args),
}));

jest.mock("@/lib/airi/reply/generation/reply-generation", () => ({
  generateAssistantReply: (...args: unknown[]) =>
    generateAssistantReply(...args),
}));

jest.mock("@/lib/airi/reply/generation/fallback-recovery-reply", () => ({
  generateFallbackRecoveryReplyResult: (...args: unknown[]) =>
    generateFallbackRecoveryReply(...args),
}));

jest.mock("@/lib/airi/grounding/llm-grounding-reflection", () => ({
  runLlmGroundingReflection: (...args: unknown[]) =>
    runLlmGroundingReflection(...args),
}));

jest.mock("@/lib/llm-analytics/events", () => ({
  recordRagTurnAnalyticsEvents: (...args: unknown[]) =>
    recordRagTurnAnalyticsEvents(...args),
}));

describe("RagResponseService", () => {
  beforeEach(() => {
    chatCompletionWithFallback.mockReset();
    retrieveHybridContext.mockReset();
    selectBestContext.mockReset();
    cachedValues.clear();
    cacheTimeMs = 0;
    generateAssistantReply.mockReset();
    generateFallbackRecoveryReply.mockReset();
    evaluateFactualGroundingGuard.mockReset();
    toMissingKnowledgeSignal.mockReset();
    runLlmGroundingReflection.mockReset();
    recordRagTurnAnalyticsEvents.mockReset();
    classifyRetrievalIntent.mockReset();

    generateFallbackRecoveryReply.mockResolvedValue("");
    runLlmGroundingReflection.mockResolvedValue(null);
    classifyRetrievalIntent.mockResolvedValue({
      query: "test",
      language: "en",
      label: "unclear",
      confidence: "low",
      shouldUseBroadRetrieval: false,
      shouldUseOverviewVariants: false,
      queryVariants: [],
      reason: "test neutral",
      source: "llm_classifier",
    });

    retrieveHybridContext.mockResolvedValue({
      snippet: undefined,
      kbArticles: [],
      conversationSummaries: [],
      retrievalStats: {
        kbArticlesCount: 0,
        totalRetrievalTimeMs: 10,
      },
    });
    selectBestContext.mockReturnValue({
      useSnippet: false,
      useKB: false,
      priority: "generic",
      reasoning: "no strong context",
    });
    evaluateFactualGroundingGuard.mockReturnValue({
      intent: null,
      shouldBlock: false,
      reason: "query_not_in_fact_sensitive_scope",
    });
  });

  it("uses clarifying generation for ambiguous generic turns when business context exists", async () => {
    evaluateFactualGroundingGuard.mockReturnValue({
      intent: null,
      shouldBlock: false,
      reason: "not factual",
    });
    toMissingKnowledgeSignal.mockReturnValue(null);
    generateAssistantReply.mockResolvedValue({
      reply:
        "Конечно. Уточните, что именно вас интересует в Airi.chat и WhatsApp.",
      isIncomplete: false,
      finishReason: "stop",
      fallbackAction: "use_generated_reply",
      fallbackReason: "generated_reply_complete",
    });

    const result = await RagResponseService.generateResponse({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      text: "Здравствуйте! Хочу узнать подробнее",
      language: "ru",
      conversationWindow: "2026-03-30 [CUSTOMER] Здравствуйте!",
      companyContext: {
        businessContext: "We provide AI agents for WhatsApp and Telegram.",
      },
    });

    expect(generateAssistantReply).toHaveBeenCalledTimes(1);
    expect(
      generateAssistantReply.mock.calls[0][1].scenarioInstruction
    ).toContain("No specific documentation was found");
    expect(result.type).toBe("ai_reply");
    expect(result.content).toContain("Уточните");
    expect(result.fallbackAction).toBe("clarifying_generation");
    expect(result.fallbackReason).toBe("clarifying_generation_allowed");
  });

  describe("answer isolation", () => {
    const request: RAGGenerateResponseParams = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      channel: "whatsapp",
      text: "What does my plan include?",
      language: "en",
      conversationWindow: "Customer has the standard plan.",
      companyContext: { businessContext: "Customer support" },
    };
    const generation = {
      isIncomplete: false,
      finishReason: "stop",
      fallbackAction: "use_generated_reply",
      fallbackReason: "generated_reply_complete",
    };

    beforeEach(() => {
      retrieveHybridContext.mockResolvedValue({
        kbArticles: [
          {
            id: "kb-plan",
            title: "Plan benefits",
            fullContent: "The standard plan includes email support.",
            similarity: 0.95,
            locale: "en",
          },
        ],
        conversationSummaries: [],
        retrievalStats: { kbArticlesCount: 1, totalRetrievalTimeMs: 10 },
      });
      selectBestContext.mockReturnValue({
        useSnippet: false,
        useKB: true,
        priority: "kb",
        reasoning: "Relevant plan documentation",
      });
    });

    const providerFailure = new AIChatProviderAggregateError([
      {
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        attempt: 1,
        fallbackIndex: 0,
        retryable: true,
        finishReason: null,
        promptBlockReason: null,
        httpStatus: 503,
      },
    ]);

    function useRealReplyGeneration(): void {
      generateAssistantReply.mockImplementation(
        jest.requireActual<
          typeof import("@/lib/airi/reply/generation/reply-generation")
        >("@/lib/airi/reply/generation/reply-generation").generateAssistantReply
      );
      generateFallbackRecoveryReply.mockImplementation(
        jest.requireActual<
          typeof import("@/lib/airi/reply/generation/fallback-recovery-reply")
        >("@/lib/airi/reply/generation/fallback-recovery-reply")
          .generateFallbackRecoveryReplyResult
      );
    }

    it("delivers a complete recovered answer without a redundant failing generation", async () => {
      useRealReplyGeneration();
      chatCompletionWithFallback
        .mockRejectedValue(providerFailure)
        .mockRejectedValueOnce(providerFailure)
        .mockResolvedValueOnce({
          content: "The standard plan includes email support.",
          provider: "anthropic",
          model: "claude-sonnet-5-5",
          latencyMs: 10,
          finishReason: "end_turn",
        });

      const result = await RagResponseService.generateResponse(request);

      expect(result.content).toBe("The standard plan includes email support.");
      expect(result.generationInference).toMatchObject({
        provider: "anthropic",
        model: "claude-sonnet-5-5",
      });
      expect(chatCompletionWithFallback).toHaveBeenCalledTimes(2);
    });

    it("still propagates exhausted provider failure when recovery produced no answer", async () => {
      useRealReplyGeneration();
      chatCompletionWithFallback.mockRejectedValue(providerFailure);

      await expect(RagResponseService.generateResponse(request)).rejects.toBe(
        providerFailure
      );
    });

    it("keeps the completed reply trace serializable for persistence", async () => {
      generateAssistantReply.mockResolvedValue({
        ...generation,
        reply: "The standard plan includes email support.",
      });

      const result = await RagResponseService.generateResponse(request);
      const wideEvent = recordRagTurnAnalyticsEvents.mock.calls[0][0].wideEvent;

      expect(() => JSON.stringify(result)).not.toThrow();
      expect(result.retrievalSummary?.wideEvent).toBe(wideEvent);
      expect(wideEvent.retrieval).toEqual(
        expect.objectContaining({ selectedKbArticleIds: ["kb-plan"] })
      );
      expect(wideEvent.retrieval).not.toHaveProperty("wideEvent");
    });

    const changes: Array<{
      name: string;
      previous: Partial<RAGGenerateResponseParams>;
      current: Partial<RAGGenerateResponseParams>;
    }> = [
      {
        name: "conversation",
        previous: { conversationId: "alice" },
        current: { conversationId: "bob" },
      },
      {
        name: "conversation history",
        previous: { conversationWindow: "Customer has the standard plan." },
        current: {
          conversationWindow: "Customer upgraded to the premium plan.",
        },
      },
      {
        name: "thread memory",
        previous: { threadMemorySummary: "Customer prefers phone support." },
        current: { threadMemorySummary: "Customer now prefers email support." },
      },
      {
        name: "workspace instructions",
        previous: { customInstructions: "Use a formal tone." },
        current: { customInstructions: "Use a conversational tone." },
      },
      {
        name: "default retrieval principal",
        previous: { knowledgeSearchPrincipal: "workspace_member_tool" },
        current: { knowledgeSearchPrincipal: "rag_auto_reply" },
      },
      {
        name: "explicit visibility",
        previous: { matchAllowedVisibilities: ["internal"] },
        current: { matchAllowedVisibilities: ["public"] },
      },
      {
        name: "source kinds",
        previous: { matchSourceKinds: ["curated_snippet"] },
        current: { matchSourceKinds: ["kb_article"] },
      },
    ];

    // Exercise immediate repeats and repeats beyond the former 15-minute exact
    // answer TTL, when only the longer-lived semantic answer cache could hit.
    describe.each([0, 16 * 60 * 1000])("after %i ms", elapsedMs => {
      it.each(changes)(
        "uses the current $name for a repeated question",
        async change => {
          generateAssistantReply
            .mockResolvedValueOnce({
              ...generation,
              reply: "Previous scoped answer.",
            })
            .mockResolvedValueOnce({
              ...generation,
              reply: "Current scoped answer.",
            });

          const previous = await RagResponseService.generateResponse({
            ...request,
            ...change.previous,
          });
          await waitForQueuedWork();
          cacheTimeMs += elapsedMs;
          const current = await RagResponseService.generateResponse({
            ...request,
            ...change.current,
          });

          expect(previous.content).toBe("Previous scoped answer.");
          expect(current.content).toBe("Current scoped answer.");
          expect(retrieveHybridContext).toHaveBeenLastCalledWith(
            request.workspaceId,
            request.text,
            request.language,
            expect.objectContaining({
              excludeConversationSummaryId:
                change.current.conversationId ?? request.conversationId,
              knowledgeSearchPrincipal: change.current.knowledgeSearchPrincipal,
              matchAllowedVisibilities: change.current.matchAllowedVisibilities,
              matchSourceKinds: change.current.matchSourceKinds,
            })
          );
        }
      );
    });

    it("uses newly retrieved evidence when the same request is repeated", async () => {
      generateAssistantReply.mockImplementation(
        (
          _text: string,
          context: { kbContext: Array<{ fullContent: string }> }
        ) =>
          Promise.resolve({
            ...generation,
            reply: context.kbContext[0].fullContent,
          })
      );
      const previous = await RagResponseService.generateResponse(request);
      await waitForQueuedWork();
      retrieveHybridContext.mockResolvedValue({
        kbArticles: [
          {
            id: "kb-plan",
            title: "Plan benefits",
            fullContent: "The standard plan now includes phone support.",
            similarity: 0.95,
            locale: "en",
          },
        ],
        conversationSummaries: [],
        retrievalStats: { kbArticlesCount: 1, totalRetrievalTimeMs: 10 },
      });

      const current = await RagResponseService.generateResponse(request);

      expect(previous.content).toBe(
        "The standard plan includes email support."
      );
      expect(current.content).toBe(
        "The standard plan now includes phone support."
      );
    });

    it("does not return a previous answer when current retrieval has no permitted evidence", async () => {
      generateAssistantReply.mockResolvedValue({
        ...generation,
        reply: "The internal plan includes private support.",
      });
      await RagResponseService.generateResponse({
        ...request,
        matchAllowedVisibilities: null,
      });
      await waitForQueuedWork();
      retrieveHybridContext.mockResolvedValue({
        kbArticles: [],
        conversationSummaries: [],
        retrievalStats: { kbArticlesCount: 0, totalRetrievalTimeMs: 10 },
      });
      selectBestContext.mockReturnValue({
        useSnippet: false,
        useKB: false,
        priority: "generic",
        reasoning: "No allowed evidence",
      });
      evaluateFactualGroundingGuard.mockReturnValue({
        intent: "pricing",
        shouldBlock: true,
        reason: "No allowed plan evidence",
      });
      toMissingKnowledgeSignal.mockReturnValue({
        intent: "pricing",
        topic: null,
        reason: "missing_pricing_info",
      });
      generateFallbackRecoveryReply.mockResolvedValue(
        "Please contact support for plan details."
      );

      const current = await RagResponseService.generateResponse({
        ...request,
        matchAllowedVisibilities: [],
      });

      expect(current.type).toBe("fallback");
      expect(current.content).toBe("Please contact support for plan details.");
      expect(current.content).not.toContain("private support");
    });
  });

  it("uses a turn-understanding retrieval intent without another classifier call", async () => {
    evaluateFactualGroundingGuard.mockReturnValue({
      intent: null,
      shouldBlock: false,
      reason: "not factual",
    });
    toMissingKnowledgeSignal.mockReturnValue(null);
    generateAssistantReply.mockResolvedValue({
      reply: "The business plan costs 10 USD.",
      isIncomplete: false,
      finishReason: "stop",
      fallbackAction: "use_generated_reply",
      fallbackReason: "generated_reply_complete",
    });

    await RagResponseService.generateResponse({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      text: "How much is the business plan?",
      language: "en",
      conversationWindow: "",
      companyContext: { businessContext: "Customer support" },
      retrievalIntent: {
        query: "business plan price",
        language: "en",
        label: "pricing",
        confidence: "high",
        shouldUseBroadRetrieval: false,
        shouldUseOverviewVariants: false,
        queryVariants: [],
        reason: "Specific price question.",
        source: "turn_understanding",
      },
    });

    expect(classifyRetrievalIntent).not.toHaveBeenCalled();
    expect(retrieveHybridContext).toHaveBeenCalledWith(
      "workspace-1",
      "How much is the business plan?",
      "en",
      expect.objectContaining({
        retrievalIntent: expect.objectContaining({
          label: "pricing",
          source: "turn_understanding",
        }),
      })
    );
  });

  it("returns an intent fallback when factual knowledge is missing", async () => {
    evaluateFactualGroundingGuard.mockReturnValue({
      intent: "pricing",
      shouldBlock: true,
      reason: "missing pricing grounding",
    });
    toMissingKnowledgeSignal.mockReturnValue({
      intent: "pricing",
      topic: null,
      reason: "missing_pricing_info",
    });
    generateFallbackRecoveryReply.mockResolvedValue(
      "К сожалению, у меня нет подтвержденной информации о стоимости. Рекомендую обратиться в поддержку."
    );

    const result = await RagResponseService.generateResponse({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      text: "Сколько стоит?",
      language: "ru",
      conversationWindow: "2026-03-30 [CUSTOMER] Сколько стоит?",
      companyContext: {},
    });

    expect(generateAssistantReply).not.toHaveBeenCalled();
    expect(result.type).toBe("fallback");
    expect(result.fallbackAction).toBe("intent_fallback");
    expect(result.fallbackReason).toBe("missing_knowledge_signal");
    expect(generateFallbackRecoveryReply).toHaveBeenCalledWith(
      expect.objectContaining({ type: "missing_knowledge" })
    );
  });

  it("attaches grounded clarification options when KB clarification uses multiple viable articles", async () => {
    generateFallbackRecoveryReply.mockResolvedValue(
      "Which program are you asking about?"
    );
    generateAssistantReply.mockResolvedValue({
      reply: "Which program are you asking about?",
      isIncomplete: false,
      finishReason: "stop",
      fallbackAction: "generic_clarification",
      fallbackReason: "evidence_policy_clarify",
    });
    retrieveHybridContext.mockResolvedValue({
      snippet: undefined,
      kbArticles: [
        {
          id: "123e4567-e89b-12d3-a456-426614174000",
          sourceRecordId: "kb-qazinnovation",
          documentId: "doc-grants",
          title: "Grant programs",
          citationLabel: "QazInnovation grant",
          documentTitle: "Grant programs",
          fullContent:
            "Support for innovation projects and application guidance.",
          similarity: 0.78,
          locale: "en",
        },
        {
          id: "kb-bestirek",
          sourceRecordId: "kb-bestirek",
          documentId: "doc-grants",
          title: "Grant programs",
          citationLabel: "BesTirek program",
          documentTitle: "Grant programs",
          fullContent:
            "Educational grant program with mentoring and selection stages.",
          similarity: 0.76,
          locale: "en",
        },
        {
          id: "kb-craft",
          sourceRecordId: "kb-craft",
          documentId: "doc-craft",
          title: "Get a Craft program",
          fullContent: "Hands-on training program for practical professions.",
          similarity: 0.73,
          locale: "en",
        },
      ],
      conversationSummaries: [],
      retrievalStats: {
        kbArticlesCount: 3,
        topKBSimilarity: 0.78,
        totalRetrievalTimeMs: 10,
      },
    });
    selectBestContext.mockReturnValue({
      useSnippet: false,
      useKB: true,
      priority: "kb",
      reasoning: "Need clarification before selecting one KB branch",
    });

    const result = await RagResponseService.generateResponse({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      text: "Tell me about your programs",
      language: "en",
      conversationWindow: "",
      companyContext: {
        businessContext: "We provide grant and education support programs.",
      },
    });

    expect(result.fallbackAction).toBe("generic_clarification");
    expect(result.groundedReplyOptions).toEqual([
      expect.objectContaining({
        id: "123e4567-e89b-12d3-a456-426614174000",
        callbackKey: "o0",
        label: "QazInnovation grant",
        sourceKind: "kb",
        sourceIds: expect.arrayContaining([
          "kb-qazinnovation",
          "doc-grants",
          "123e4567-e89b-12d3-a456-426614174000",
        ]),
      }),
      expect.objectContaining({
        id: "kb-bestirek",
        callbackKey: "o1",
        label: "BesTirek program",
        sourceKind: "kb",
      }),
      expect.objectContaining({
        id: "kb-craft",
        label: "Get a Craft program",
        sourceKind: "kb",
      }),
    ]);
  });

  it("records only the sources used by the chosen snippet-only path", async () => {
    retrieveHybridContext.mockResolvedValue({
      snippet: {
        id: "snippet-1",
        answer: "We offer grant guidance.",
        question: "Tell me about grants",
        score: 0.96,
      },
      kbArticles: [
        {
          id: "kb-1",
          title: "Pricing",
          fullContent: "Pricing depends on the package.",
          similarity: 0.9,
          locale: "ru",
        },
      ],
      conversationSummaries: [],
      retrievalStats: {
        kbArticlesCount: 1,
        totalRetrievalTimeMs: 12,
      },
    });
    selectBestContext.mockReturnValue({
      useSnippet: true,
      useKB: false,
      priority: "snippet",
      reasoning: "Verified snippet is enough",
    });
    evaluateFactualGroundingGuard.mockReturnValue({
      intent: null,
      shouldBlock: false,
      reason: "not factual",
    });
    toMissingKnowledgeSignal.mockReturnValue(null);

    const result = await RagResponseService.generateResponse({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      text: "Расскажите про гранты",
      language: "ru",
      conversationWindow: "",
      companyContext: {},
    });

    expect(result.type).toBe("verified_snippet");
    expect(result.retrievalSummary).toEqual(
      expect.objectContaining({
        selectedSnippetId: "snippet-1",
        selectedKbArticleIds: [],
        chosenSourceIds: ["snippet-1"],
      })
    );
  });

  it("passes calendar availability context to the final writer when supplied", async () => {
    generateAssistantReply.mockResolvedValue({
      reply: "I can offer Tue 09:00 or 11:00 UTC. Which works best?",
      isIncomplete: false,
      finishReason: "stop",
      fallbackAction: "use_generated_reply",
      fallbackReason: "generated_reply_complete",
    });
    retrieveHybridContext.mockResolvedValue({
      snippet: undefined,
      kbArticles: [
        {
          id: "kb-1",
          title: "Consultations",
          fullContent: "The team offers onboarding consultations.",
          similarity: 0.92,
          locale: "en",
        },
      ],
      conversationSummaries: [],
      retrievalStats: {
        kbArticlesCount: 1,
        totalRetrievalTimeMs: 12,
      },
    });
    selectBestContext.mockReturnValue({
      useSnippet: false,
      useKB: true,
      priority: "kb",
      reasoning: "Relevant KB documentation found",
    });
    evaluateFactualGroundingGuard.mockReturnValue({
      intent: null,
      shouldBlock: false,
      reason: "not factual",
    });

    const calendarAvailabilityBlock =
      "Google Calendar availability (free/busy only):\nFree/busy horizon: 2026-06-02T09:00:00.000Z to 2026-06-09T09:00:00.000Z\n- Tue, Jun 2, 2026, 09:00-10:00 UTC";
    const calendarAvailabilitySignature = "calendar-hash-1";

    const result = await RagResponseService.generateResponse({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      text: "Can we book a call?",
      language: "en",
      conversationWindow: "",
      companyContext: {},
      calendarAvailabilityBlock,
      calendarAvailabilitySignature,
    });

    expect(result.type).toBe("ai_reply");
    expect(generateAssistantReply).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        calendarAvailabilityBlock,
      })
    );
  });

  it("forces blended retrieval for compound asks and pinned grounding", async () => {
    generateAssistantReply.mockResolvedValue({
      reply:
        "Про гранты доступно несколько программ. Про стоимость точные детали пока не подтверждены.",
      isIncomplete: false,
      finishReason: "stop",
      fallbackAction: "use_generated_reply",
      fallbackReason: "generated_reply_complete",
      coverage: {
        asksDetected: ["про гранты", "про стоимость"],
        asksAnswered: ["про гранты", "про стоимость"],
        missingAsks: [],
        ambiguousMissingAsks: [],
        fullyCovered: true,
      },
      inference: {
        provider: "vertex",
        model: "gemini-3.5-flash",
        latencyMs: 120,
        finishReason: "stop",
      },
    });
    retrieveHybridContext.mockResolvedValue({
      snippet: {
        id: "snippet-1",
        answer: "There are grants available.",
        question: "What grants do you offer?",
        score: 0.9,
      },
      kbArticles: [
        {
          id: "kb-1",
          title: "Pricing",
          fullContent: "Pricing depends on the package.",
          similarity: 0.9,
          locale: "ru",
        },
      ],
      conversationSummaries: [],
      retrievalStats: {
        kbArticlesCount: 1,
        totalRetrievalTimeMs: 12,
      },
    });
    selectBestContext.mockReturnValue({
      useSnippet: true,
      useKB: true,
      priority: "kb",
      reasoning: "Blended",
    });
    evaluateFactualGroundingGuard.mockReturnValue({
      intent: null,
      shouldBlock: false,
      reason: "not factual",
    });
    toMissingKnowledgeSignal.mockReturnValue(null);

    const result = await RagResponseService.generateResponse({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      text: "\u0425\u043e\u0447\u0443 \u0443\u0437\u043d\u0430\u0442\u044c \u043f\u0440\u043e \u0433\u0440\u0430\u043d\u0442\u044b \u0438 \u0441\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c",
      language: "ru",
      conversationWindow: "",
      lastMessageQuery:
        "\u0425\u043e\u0447\u0443 \u0443\u0437\u043d\u0430\u0442\u044c \u043f\u0440\u043e \u0433\u0440\u0430\u043d\u0442\u044b \u0438 \u0441\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c",
      openAsks: [
        "\u043f\u0440\u043e \u0433\u0440\u0430\u043d\u0442\u044b",
        "\u043f\u0440\u043e \u0441\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c",
      ],
      coverageHints: [
        "\u043f\u0440\u043e \u0433\u0440\u0430\u043d\u0442\u044b",
        "\u043f\u0440\u043e \u0441\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c",
      ],
      followUpAnchor: "\u0433\u0440\u0430\u043d\u0442\u044b",
      lastGrounding: {
        sourceKind: "kb",
        sourceIds: ["kb-pricing"],
        intentAnchor: "\u0441\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c",
        answeredAsks: [
          "\u0441\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c",
        ],
      },
      companyContext: {},
    });

    expect(retrieveHybridContext).toHaveBeenCalledWith(
      "workspace-1",
      expect.any(String),
      "ru",
      expect.objectContaining({
        forceBlendedRetrieval: true,
        queryVariants: expect.arrayContaining([
          "\u043f\u0440\u043e \u0433\u0440\u0430\u043d\u0442\u044b",
          "\u043f\u0440\u043e \u0441\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c",
        ]),
        pinnedGrounding: {
          sourceKind: "kb",
          sourceIds: ["kb-pricing"],
        },
      })
    );
    expect(result.coverage?.asksDetected).toHaveLength(2);
    expect(result.coverage?.asksAnswered).toEqual(
      expect.arrayContaining([
        "\u043f\u0440\u043e \u0433\u0440\u0430\u043d\u0442\u044b",
        "\u043f\u0440\u043e \u0441\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c",
      ])
    );
  });

  it("falls back to grounded recovery when a single ask is still uncovered", async () => {
    generateAssistantReply.mockResolvedValue({
      reply: "",
      isIncomplete: true,
      finishReason: "stop",
      fallbackAction: "grounded_recovery",
      fallbackReason: "missing_ask_coverage",
      coverage: {
        asksDetected: ["pricing"],
        asksAnswered: [],
        missingAsks: ["pricing"],
        ambiguousMissingAsks: [],
        fullyCovered: false,
      },
      recoveryContext: {
        kbExcerpt:
          "Pricing:\nPricing depends on the package and selected services.",
        latestCustomerMessage: "What is the pricing?",
      },
    });
    generateFallbackRecoveryReply.mockResolvedValue(
      "Pricing depends on the package and selected services."
    );
    retrieveHybridContext.mockResolvedValue({
      snippet: undefined,
      kbArticles: [
        {
          id: "kb-1",
          title: "Pricing",
          fullContent: "Pricing depends on the package and selected services.",
          similarity: 0.91,
          locale: "en",
          retrievalMethod: "vector",
        },
      ],
      conversationSummaries: [],
      retrievalStats: {
        kbArticlesCount: 1,
        totalRetrievalTimeMs: 12,
      },
    });
    selectBestContext.mockReturnValue({
      useSnippet: false,
      useKB: true,
      priority: "kb",
      reasoning: "Relevant KB documentation found",
    });
    evaluateFactualGroundingGuard.mockReturnValue({
      intent: null,
      shouldBlock: false,
      reason: "not factual",
    });
    toMissingKnowledgeSignal.mockReturnValue(null);

    const result = await RagResponseService.generateResponse({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      text: "What is the pricing?",
      language: "en",
      conversationWindow: "",
      openAsks: ["pricing"],
      coverageHints: ["pricing"],
      companyContext: {},
    });

    expect(result.type).toBe("ai_reply");
    expect(result.fallbackAction).toBe("grounded_recovery");
    expect(result.fallbackReason).toBe("missing_ask_coverage");
    expect(result.content).toContain("Pricing depends on the package");
    expect(generateFallbackRecoveryReply).toHaveBeenCalledWith(
      expect.objectContaining({ type: "grounded_recovery" })
    );
  });

  it("uses grounded recovery for generic turns when KB candidates still exist", async () => {
    generateFallbackRecoveryReply.mockResolvedValue(
      "Есть гранты для людей с инвалидностью. Например, доступна информация по фонду Ержана Татишева."
    );
    retrieveHybridContext.mockResolvedValue({
      snippet: undefined,
      kbArticles: [
        {
          id: "kb-1",
          title: "Фонд Ержана Татишева",
          fullContent:
            "Фонд Ержана Татишева предоставляет гранты и программы поддержки, в том числе для людей с инвалидностью.",
          similarity: 0.74,
          locale: "ru",
          retrievalMethod: "search_vector",
        },
      ],
      conversationSummaries: [],
      retrievalStats: {
        kbArticlesCount: 1,
        totalRetrievalTimeMs: 12,
        topKBSimilarity: 0.74,
      },
    });
    selectBestContext.mockReturnValue({
      useSnippet: false,
      useKB: false,
      priority: "generic",
      reasoning: "No high-confidence matches found",
    });
    evaluateFactualGroundingGuard.mockReturnValue({
      intent: null,
      shouldBlock: false,
      reason: "not factual",
    });
    toMissingKnowledgeSignal.mockReturnValue(null);

    const result = await RagResponseService.generateResponse({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      text: "Какие есть гранты? Для людей с инвалидностью",
      language: "ru",
      conversationWindow: "",
      intentAnchor: "гранты для людей с инвалидностью",
      companyContext: {},
    });

    expect(result.type).toBe("fallback");
    expect(result.fallbackAction).toBe("grounded_recovery");
    expect(result.fallbackReason).toBe("grounded_context_available");
    expect(result.content).toContain("гранты");
    expect(generateFallbackRecoveryReply).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "grounded_recovery",
        recoveryContext: expect.objectContaining({
          kbExcerpt: expect.stringContaining("Фонд Ержана Татишева"),
        }),
      })
    );
  });

  it("does not replace the final reply with an incomplete contextual fallback result", async () => {
    retrieveHybridContext.mockResolvedValue({
      snippet: undefined,
      kbArticles: [
        {
          id: "kb-grants",
          title: "Гранты",
          fullContent: "Информация о грантах для теста.",
          similarity: 0.94,
          locale: "ru",
        },
      ],
      conversationSummaries: [],
      retrievalStats: {
        kbArticlesCount: 1,
        totalRetrievalTimeMs: 10,
      },
    });
    selectBestContext.mockReturnValue({
      useSnippet: false,
      useKB: true,
      priority: "kb",
      reasoning: "Relevant KB documentation found",
    });
    generateAssistantReply.mockResolvedValue({
      reply: "",
      isIncomplete: true,
      finishReason: "MAX_TOKENS",
      fallbackAction: "generic_clarification",
      fallbackReason: "missing_ask_coverage",
      recoveryContext: {
        latestCustomerMessage: "Какие есть гранты? Для людей с инвалидностью",
        intentAnchor: "Какие есть гранты? Для людей с инвалидностью",
      },
      inference: {
        provider: "vertex",
        model: "gemini-3.5-flash",
        latencyMs: 100,
        finishReason: "MAX_TOKENS",
      },
    });
    generateFallbackRecoveryReply.mockResolvedValue({
      reply: "",
      finishReason: "MAX_TOKENS",
      provider: "vertex",
      model: "gemini-3.5-flash",
      latencyMs: 90,
      isIncomplete: true,
    });

    const result = await RagResponseService.generateResponse({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      text: "Какие есть гранты? Для людей с инвалидностью",
      language: "ru",
      conversationWindow: "",
      companyContext: {},
    });

    expect(result.content).toBe("");
    expect(result.generationFinishReason).toBe("MAX_TOKENS");
    expect(result.generationInference).toEqual(
      expect.objectContaining({
        model: "gemini-3.5-flash",
        finishReason: "MAX_TOKENS",
      })
    );
  });

  it("preserves locked selection KB sources even when generic decision logic would otherwise drop them", async () => {
    retrieveHybridContext.mockResolvedValue({
      snippet: undefined,
      kbArticles: [
        {
          id: "chunk-guide",
          sourceRecordId: "kb-guide",
          title: "QazInnovation Guide",
          fullContent:
            "QazInnovation guide costs 7000 тенге and can be оформлен directly.",
          similarity: 0.58,
          locale: "ru",
          retrievalMethod: "knowledge_chunk",
        },
        {
          id: "chunk-other",
          sourceRecordId: "kb-other",
          title: "Winner Package",
          fullContent: "Winner package costs 100000 тенге.",
          similarity: 0.55,
          locale: "ru",
          retrievalMethod: "knowledge_chunk",
        },
      ],
      conversationSummaries: [],
      retrievalStats: {
        kbArticlesCount: 2,
        topKBSimilarity: 0.58,
        totalRetrievalTimeMs: 9,
      },
    });
    selectBestContext.mockReturnValue({
      useSnippet: false,
      useKB: false,
      priority: "generic",
      reasoning: "No high-confidence matches found",
    });
    generateAssistantReply.mockResolvedValue({
      reply: "Оформляем гайд QazInnovation за 7000 тенге.",
      isIncomplete: false,
      finishReason: "stop",
      fallbackAction: "use_generated_reply",
      fallbackReason: "generated_reply_complete",
    });
    evaluateFactualGroundingGuard.mockReturnValue({
      intent: null,
      shouldBlock: false,
      reason: "not factual",
    });
    toMissingKnowledgeSignal.mockReturnValue(null);

    const result = await RagResponseService.generateResponse({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      text: "оформляем",
      language: "ru",
      conversationWindow: "",
      activeSelection: {
        kind: "offer",
        label: "QazInnovation guide",
        normalizedLabel: "qazinnovation guide",
        sourceKind: "kb",
        sourceIds: ["chunk-guide"],
        quotedPriceText: "7000 тенге",
        quotedPriceAmount: 7000,
        quotedPriceCurrency: "KZT",
      },
      companyContext: {},
    });

    expect(result.type).toBe("ai_reply");
    expect(generateAssistantReply).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        kbContext: expect.arrayContaining([
          expect.objectContaining({ id: "chunk-guide" }),
        ]),
      })
    );
    expect(result.retrievalSummary).toEqual(
      expect.objectContaining({
        lockedSelectionPreserved: true,
        selectedKbArticleIds: ["chunk-guide"],
        selectedKbSourceIds: ["kb-guide", "chunk-guide"],
        chosenSourceIds: ["kb-guide", "chunk-guide"],
      })
    );
  });

  it("uses broader KB retrieval settings for service-overview questions", async () => {
    generateAssistantReply.mockResolvedValue({
      reply: "• Бесплатный канал\n\n• Консультация\n\n• Под ключ",
      isIncomplete: false,
      finishReason: "stop",
      fallbackAction: "use_generated_reply",
      fallbackReason: "generated_reply_complete",
    });
    retrieveHybridContext.mockResolvedValue({
      snippet: undefined,
      kbArticles: [
        {
          id: "kb-1",
          title: "Услуги",
          fullContent: "Бесплатный канал. Консультация. Под ключ.",
          similarity: 0.94,
          locale: "ru",
        },
      ],
      conversationSummaries: [],
      retrievalStats: {
        kbArticlesCount: 1,
        totalRetrievalTimeMs: 10,
      },
    });
    selectBestContext.mockReturnValue({
      useSnippet: false,
      useKB: true,
      priority: "kb",
      reasoning: "Relevant KB documentation found",
    });
    evaluateFactualGroundingGuard.mockReturnValue({
      intent: null,
      shouldBlock: false,
      reason: "not factual",
    });
    toMissingKnowledgeSignal.mockReturnValue(null);
    classifyRetrievalIntent.mockResolvedValueOnce({
      query: "Какие есть услуги?",
      language: "ru",
      label: "service_overview",
      confidence: "high",
      shouldUseBroadRetrieval: true,
      shouldUseOverviewVariants: true,
      queryVariants: ["услуги", "форматы работы"],
      reason: "Broad service overview ask",
      source: "llm_classifier",
    });

    await RagResponseService.generateResponse({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      text: "Какие есть услуги?",
      language: "ru",
      conversationWindow: "",
      companyContext: {},
    });

    expect(retrieveHybridContext).toHaveBeenCalledWith(
      "workspace-1",
      "Какие есть услуги?",
      "ru",
      expect.objectContaining({
        preferBroadKbContext: true,
        forceBlendedRetrieval: true,
        forceBlendedReason: "service_overview",
      })
    );
  });

  it("replaces unsupported strict factual answers with a clarification and no attached links", async () => {
    generateAssistantReply.mockResolvedValue({
      reply:
        "Our standard monthly price is $10 per month for all customers. See https://docs.example.com/pricing",
      isIncomplete: false,
      finishReason: "stop",
      fallbackAction: "use_generated_reply",
      fallbackReason: "generated_reply_complete",
    });
    generateFallbackRecoveryReply.mockResolvedValue(
      "Which plan are you asking about?"
    );
    retrieveHybridContext.mockResolvedValue({
      snippet: undefined,
      kbArticles: [
        {
          id: "kb-1",
          title: "Grant Program Guide",
          fullContent:
            "We help founders find grant programs and prepare applications.",
          similarity: 0.92,
          locale: "en",
          url: "https://docs.example.com/grants",
          retrievalMethod: "knowledge_chunk",
          sourceType: "kb_article",
          allowAutoLinkEmbedding: true,
        },
      ],
      conversationSummaries: [],
      retrievalPlan: {
        normalizedQuery: "what does it cost",
        standaloneQuery: "what does it cost",
        subqueries: [],
        factualIntent: "factual",
        pinnedSourceIds: [],
        requiredCitationStrength: "strict",
        plannerMode: "heuristic",
        hydeRecommended: true,
        ragQueryPreparation: {
          cleanedQuery: "what does it cost",
          subQueries: [],
          originalQuery: "what does it cost",
          wasCleaned: false,
          source: "fallback",
        },
      },
      retrievalStats: {
        kbArticlesCount: 1,
        topKBSimilarity: 0.92,
        totalRetrievalTimeMs: 10,
      },
    });
    selectBestContext.mockReturnValue({
      useSnippet: false,
      useKB: true,
      priority: "kb",
      reasoning: "Relevant KB documentation found",
    });

    const result = await RagResponseService.generateResponse({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      text: "What does it cost?",
      language: "en",
      conversationWindow: "",
      companyContext: {
        businessContext: "We provide grant and startup support services.",
      },
    });

    expect(result.type).toBe("ai_reply");
    expect(result.content).toBe("Which plan are you asking about?");
    expect(result.fallbackAction).toBe("generic_clarification");
    expect(result.fallbackReason).toBe("evidence_policy_clarify");
    expect(result.attachedArticleLinks).toBeUndefined();
    expect(result.retrievalSummary).toEqual(
      expect.objectContaining({
        evidenceResponsePolicy: "clarify",
      })
    );
    expect(generateFallbackRecoveryReply).toHaveBeenCalledWith(
      expect.objectContaining({ type: "generic_clarification" })
    );
  });

  it("hands off strict factual turns without evidence instead of returning a free-form answer", async () => {
    generateAssistantReply.mockResolvedValue({
      reply: "It costs $10/month.",
      isIncomplete: false,
      finishReason: "stop",
      fallbackAction: "use_generated_reply",
      fallbackReason: "generated_reply_complete",
    });
    generateFallbackRecoveryReply.mockResolvedValue(
      "I don't have confirmed pricing information. Please contact support for the latest details."
    );
    retrieveHybridContext.mockResolvedValue({
      snippet: undefined,
      kbArticles: [],
      conversationSummaries: [],
      retrievalPlan: {
        normalizedQuery: "what does it cost",
        standaloneQuery: "what does it cost",
        subqueries: [],
        factualIntent: "factual",
        pinnedSourceIds: [],
        requiredCitationStrength: "strict",
        plannerMode: "heuristic",
        hydeRecommended: true,
        ragQueryPreparation: {
          cleanedQuery: "what does it cost",
          subQueries: [],
          originalQuery: "what does it cost",
          wasCleaned: false,
          source: "fallback",
        },
      },
      retrievalStats: {
        kbArticlesCount: 0,
        topKBSimilarity: null,
        totalRetrievalTimeMs: 8,
      },
    });
    selectBestContext.mockReturnValue({
      useSnippet: false,
      useKB: true,
      priority: "kb",
      reasoning: "KB path selected despite missing evidence",
    });

    const result = await RagResponseService.generateResponse({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      text: "What does it cost?",
      language: "en",
      conversationWindow: "",
      companyContext: {},
    });

    expect(result.type).toBe("ai_reply");
    expect(result.content).toContain("confirmed pricing information");
    expect(result.fallbackAction).toBe("intent_fallback");
    expect(result.fallbackReason).toBe("evidence_policy_handoff");
    expect(result.attachedArticleLinks).toBeUndefined();
    expect(result.retrievalSummary).toEqual(
      expect.objectContaining({
        evidenceResponsePolicy: "handoff",
      })
    );
    expect(generateFallbackRecoveryReply).toHaveBeenCalledWith(
      expect.objectContaining({ type: "missing_knowledge" })
    );
  });

  it("does not wait for deferred grounding reflection before returning the reply", async () => {
    runLlmGroundingReflection.mockImplementation(
      () => new Promise(() => undefined)
    );
    generateAssistantReply.mockResolvedValue({
      reply: "We help founders prepare grant applications.",
      isIncomplete: false,
      finishReason: "stop",
      fallbackAction: "use_generated_reply",
      fallbackReason: "generated_reply_complete",
    });
    retrieveHybridContext.mockResolvedValue({
      snippet: undefined,
      kbArticles: [
        {
          id: "kb-1",
          title: "Grant Support",
          fullContent:
            "We help founders prepare grant applications and supporting documents.",
          similarity: 0.93,
          locale: "en",
          url: "https://docs.example.com/grants",
          retrievalMethod: "knowledge_chunk",
          sourceType: "kb_article",
          allowAutoLinkEmbedding: true,
        },
      ],
      conversationSummaries: [],
      retrievalStats: {
        kbArticlesCount: 1,
        topKBSimilarity: 0.93,
        totalRetrievalTimeMs: 10,
      },
    });
    selectBestContext.mockReturnValue({
      useSnippet: false,
      useKB: true,
      priority: "kb",
      reasoning: "Relevant KB documentation found",
    });

    const result = await RagResponseService.generateResponse({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      text: "How can you help with grants?",
      language: "en",
      conversationWindow: "",
      companyContext: {},
    });

    expect(result.type).toBe("ai_reply");
    expect(result.content).toContain("grant applications");
    expect(runLlmGroundingReflection).toHaveBeenCalledTimes(1);
    expect(result.retrievalSummary).toEqual(
      expect.objectContaining({
        llmGroundingReflection: false,
        llmGroundingReflectionDeferred: true,
      })
    );
  });

  it("replaces a HyDE-like final draft with grounded recovery", async () => {
    generateAssistantReply.mockResolvedValue({
      reply:
        "The standard plan starts at 12,000 KZT per month and onboarding is billed separately during setup.",
      isIncomplete: false,
      finishReason: "stop",
      fallbackAction: "use_generated_reply",
      fallbackReason: "generated_reply_complete",
      inference: {
        provider: "vertex",
        model: "gemini-3.5-flash",
        latencyMs: 85,
        finishReason: "stop",
      },
    });
    generateFallbackRecoveryReply.mockResolvedValue(
      "Pricing depends on the selected package and services. I can help narrow it down if you tell me which plan you mean."
    );
    retrieveHybridContext.mockResolvedValue({
      snippet: undefined,
      kbArticles: [
        {
          id: "kb-pricing",
          title: "Pricing",
          fullContent:
            "Pricing depends on the selected package and services. Exact costs vary by scope.",
          similarity: 0.92,
          locale: "en",
          wasHydeApplied: true,
          hydeHypotheticalAnswer:
            "The standard plan starts at 12,000 KZT per month and onboarding is billed separately during setup.",
        },
      ],
      conversationSummaries: [],
      retrievalStats: {
        kbArticlesCount: 1,
        totalRetrievalTimeMs: 11,
        hydeApplied: true,
        hydeSources: ["kb"],
        hydeArtifacts: [
          {
            source: "kb",
            query: "What does it cost?",
            hypotheticalAnswer:
              "The standard plan starts at 12,000 KZT per month and onboarding is billed separately during setup.",
          },
        ],
      },
    });
    selectBestContext.mockReturnValue({
      useSnippet: false,
      useKB: true,
      priority: "kb",
      reasoning: "Relevant KB documentation found",
    });

    const result = await RagResponseService.generateResponse({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      text: "What does it cost?",
      language: "en",
      conversationWindow: "",
      companyContext: {},
    });

    expect(result.type).toBe("ai_reply");
    expect(result.content).toContain("Pricing depends on the selected package");
    expect(result.content).not.toContain("12,000 KZT per month");
    expect(result.fallbackAction).toBe("grounded_recovery");
    expect(result.fallbackReason).toBe("hyde_leakage_guard");
    expect(result.retrievalSummary).toEqual(
      expect.objectContaining({
        hydeApplied: true,
        hydeLeakageGuardTriggered: true,
        hydeLeakageGuardSource: "kb",
      })
    );
    expect(generateFallbackRecoveryReply).toHaveBeenCalledWith(
      expect.objectContaining({ type: "grounded_recovery" })
    );
  });

  it("prefers activeSelection source pinning over stale lastGrounding", async () => {
    generateAssistantReply.mockResolvedValue({
      reply: "The selected guide costs 7000 KZT.",
      isIncomplete: false,
      finishReason: "stop",
      fallbackAction: "use_generated_reply",
      fallbackReason: "generated_reply_complete",
      inference: {
        provider: "vertex",
        model: "gemini-3.5-flash",
        latencyMs: 90,
        finishReason: "stop",
      },
    });
    retrieveHybridContext.mockResolvedValue({
      snippet: undefined,
      kbArticles: [
        {
          id: "kb-guide",
          title: "Guide",
          fullContent: "The selected guide costs 7000 KZT.",
          similarity: 0.95,
          locale: "en",
          documentId: "doc-guide",
          chunkIndex: 1,
        },
      ],
      conversationSummaries: [],
      retrievalStats: {
        kbArticlesCount: 1,
        totalRetrievalTimeMs: 12,
      },
    });
    selectBestContext.mockReturnValue({
      useSnippet: false,
      useKB: true,
      priority: "kb",
      reasoning: "Pinned KB documentation found",
    });

    await RagResponseService.generateResponse({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      text: "yes",
      language: "en",
      conversationWindow: "",
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
      lastGrounding: {
        sourceKind: "kb",
        sourceIds: ["kb-old"],
        intentAnchor: "older selection",
        answeredAsks: ["pricing"],
      },
      companyContext: {},
    });

    expect(retrieveHybridContext).toHaveBeenCalledWith(
      "workspace-1",
      expect.any(String),
      "en",
      expect.objectContaining({
        pinnedGrounding: {
          sourceKind: "kb",
          sourceIds: ["kb-guide"],
        },
      })
    );
  });

  it("promotes broad generic discovery into a grounded overview when grouped KB candidates exist", async () => {
    generateAssistantReply.mockResolvedValue({
      reply: "Here are the main grant options, including QazInnovation.",
      isIncomplete: false,
      finishReason: "stop",
      fallbackAction: "use_generated_reply",
      fallbackReason: "generated_reply_complete",
      inference: {
        provider: "vertex",
        model: "gemini-3.5-flash",
        latencyMs: 95,
        finishReason: "stop",
      },
    });
    retrieveHybridContext.mockResolvedValue({
      snippet: undefined,
      kbArticles: [
        {
          id: "chunk-1",
          title: "Grant overview",
          fullContent: "QazInnovation grant up to 20 mln tenge.",
          similarity: 0.76,
          locale: "ru",
          documentId: "doc-grants",
          sourceRecordId: "doc-grants",
          chunkIndex: 1,
        },
        {
          id: "chunk-2",
          title: "Grant overview",
          fullContent: "Another grant option from the same article.",
          similarity: 0.74,
          locale: "ru",
          documentId: "doc-grants",
          sourceRecordId: "doc-grants",
          chunkIndex: 2,
        },
        {
          id: "chunk-3",
          title: "International opportunities",
          fullContent: "International funding opportunities.",
          similarity: 0.72,
          locale: "ru",
          documentId: "doc-global",
          sourceRecordId: "doc-global",
          chunkIndex: 1,
        },
      ],
      conversationSummaries: [],
      retrievalStats: {
        kbArticlesCount: 3,
        totalRetrievalTimeMs: 15,
        topKBSimilarity: 0.76,
      },
    });
    selectBestContext.mockReturnValue({
      useSnippet: false,
      useKB: false,
      priority: "generic",
      reasoning: "No single high-confidence hit",
    });

    const result = await RagResponseService.generateResponse({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      text: "привет, хочу узнать о грантах",
      language: "ru",
      conversationWindow: "",
      companyContext: {},
    });

    expect(generateAssistantReply).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        kbContext: expect.arrayContaining([
          expect.objectContaining({ id: "chunk-1" }),
          expect.objectContaining({ id: "chunk-3" }),
        ]),
      })
    );
    expect(result.type).toBe("ai_reply");
    expect(result.decision).toEqual(
      expect.objectContaining({
        priority: "kb",
        useKB: true,
      })
    );
    expect(result.retrievalSummary).toEqual(
      expect.objectContaining({
        broadOverviewRescue: true,
        selectedKbArticleIds: expect.arrayContaining(["chunk-1", "chunk-3"]),
      })
    );
  });

  it("gives the final writer the customer's message while retrieval uses the plan's query", async () => {
    generateAssistantReply.mockResolvedValue({
      reply: "Спасибо! Менеджер свяжется для доставки.",
      isIncomplete: false,
      finishReason: "end_turn",
      fallbackAction: "use_generated_reply",
      fallbackReason: "generated_reply_complete",
    });
    retrieveHybridContext.mockResolvedValue({
      snippet: undefined,
      kbArticles: [
        {
          id: "kb-1",
          title: "Доставка",
          fullContent: "Доставляем по городу за 1 день.",
          similarity: 0.92,
          locale: "ru",
        },
      ],
      conversationSummaries: [],
      retrievalStats: { kbArticlesCount: 1, totalRetrievalTimeMs: 12 },
    });
    selectBestContext.mockReturnValue({
      useSnippet: false,
      useKB: true,
      priority: "kb",
      reasoning: "Relevant KB documentation found",
    });
    evaluateFactualGroundingGuard.mockReturnValue({
      intent: null,
      shouldBlock: false,
      reason: "not factual",
    });

    await RagResponseService.generateResponse({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      text: "Отправьте свою локацию, запланируем поездку к вам",
      customerMessage: "[Location] 51.105938, 71.396126",
      language: "ru",
      conversationWindow: "",
      companyContext: {},
    });

    expect(retrieveHybridContext.mock.calls[0][1]).toBe(
      "Отправьте свою локацию, запланируем поездку к вам"
    );
    expect(generateAssistantReply.mock.calls[0][0]).toBe(
      "[Location] 51.105938, 71.396126"
    );
  });

  it("keeps the writer's draft when recovery comes back unfinished", async () => {
    retrieveHybridContext.mockResolvedValue({
      snippet: undefined,
      kbArticles: [
        {
          id: "kb-partners",
          title: "Партнёрство",
          fullContent: "Напишите, кто вы и какой формат сотрудничества.",
          similarity: 0.94,
          locale: "ru",
        },
      ],
      conversationSummaries: [],
      retrievalStats: { kbArticlesCount: 1, totalRetrievalTimeMs: 10 },
    });
    selectBestContext.mockReturnValue({
      useSnippet: false,
      useKB: true,
      priority: "kb",
      reasoning: "Relevant KB documentation found",
    });
    const draft =
      "Спасибо! Получили вашу локацию, менеджер свяжется с вами для доставки";
    generateAssistantReply.mockResolvedValue({
      reply: draft,
      isIncomplete: true,
      finishReason: "end_turn",
      fallbackAction: "grounded_recovery",
      fallbackReason: "incomplete_generated_reply",
      recoveryContext: {
        latestCustomerMessage: "[Location] 51.105938, 71.396126",
        draftReply: draft,
      },
    });
    generateFallbackRecoveryReply.mockResolvedValue({
      reply: "Как здорово, спасибо за интерес к нам! Напишите, кто вы и",
      finishReason: "max_tokens",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      latencyMs: 90,
      isIncomplete: true,
    });

    const result = await RagResponseService.generateResponse({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      text: "[Location] 51.105938, 71.396126",
      language: "ru",
      conversationWindow: "",
      companyContext: {},
    });

    expect(generateFallbackRecoveryReply).toHaveBeenCalledTimes(1);
    expect(result.content).toBe(draft);
  });

  it("gives a scenario step's recovery its instruction and the latest turns", async () => {
    generateFallbackRecoveryReply.mockResolvedValue({
      reply: "Спасибо! Локацию получили, курьер свяжется с вами.",
      finishReason: "end_turn",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      latencyMs: 80,
      isIncomplete: false,
    });
    const recentConversationTail = [
      "2026-10-23T14:08:04.000Z [CUSTOMER] Отправить футболку",
      "2026-10-23T14:08:09.409Z [AGENT] Отправьте свою локацию, запланируем поездку к вам",
    ].join("\n");

    await RagResponseService.generateResponse({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      text: "[Location] 51.105938, 71.396126",
      language: "ru",
      conversationWindow: "",
      recentConversationTail,
      companyContext: {},
      scenarioRuntime: {
        scenarioId: "scenario-1",
        scenarioName: "Futbolka_test",
        selectedActionNodeId: "node-ai",
        actionType: "reply",
        scenarioPriority: 1,
        actionReplyInstruction: "Будь вежливым",
      } as unknown as RAGGenerateResponseParams["scenarioRuntime"],
    });

    expect(generateFallbackRecoveryReply).toHaveBeenCalledTimes(1);
    expect(
      generateFallbackRecoveryReply.mock.calls[0][0].recoveryContext
    ).toMatchObject({
      stepInstruction: "Будь вежливым",
      recentConversation: recentConversationTail,
    });
  });
});
