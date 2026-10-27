const mockConversationLean = jest.fn();
const mockConversationUpdateOne = jest.fn();
const mockMessageFindArgs = jest.fn();
const mockMessageFindSort = jest.fn();
const mockMessageLean = jest.fn();
const mockMessageFindById = jest.fn();
const mockMessageFindByIdLean = jest.fn();
const understandCustomerTurn = jest.fn();
const chatCompletionWithFallback = jest.fn();

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: () => ({
      select: () => ({
        lean: () => mockConversationLean(),
      }),
    }),
    updateOne: (...args: unknown[]) => mockConversationUpdateOne(...args),
  },
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    find: (...args: unknown[]) => {
      mockMessageFindArgs(...args);
      return {
        sort: (sortArg: unknown) => {
          mockMessageFindSort(sortArg);
          return {
            select: () => ({
              lean: () => mockMessageLean(),
            }),
          };
        },
      };
    },
    findById: (...args: unknown[]) => {
      mockMessageFindById(...args);
      return {
        select: () => ({
          lean: () => mockMessageFindByIdLean(),
        }),
      };
    },
  },
}));

jest.mock("@/lib/airi/reply/turn/understand-customer-turn", () => ({
  understandCustomerTurn: (...args: unknown[]) =>
    understandCustomerTurn(...args),
}));

jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: (...args: unknown[]) =>
    chatCompletionWithFallback(...args),
  getLightTextModel: jest.fn(() => "claude-haiku-4-5"),
}));

import { loadThreadReplyContext } from "@/lib/airi/reply/thread/thread-memory";

describe("thread memory refresh", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    chatCompletionWithFallback.mockReset();
    mockMessageFindByIdLean.mockResolvedValue(null);
    understandCustomerTurn.mockResolvedValue({
      kind: "question",
      proceedWithRag: true,
      dependsOnPriorContext: false,
      safeReplyKey: null,
      confidence: "medium",
      selectionTransition: {
        action: "none",
        selectionLabel: null,
      },
      asks: ["grants and pricing"],
      coverageHints: ["grants and pricing"],
      followUpMode: "none",
      followUpAnchor: null,
      queryVariants: ["grants and pricing"],
      planningSource: "model",
    });
  });

  it("refreshes persisted memory when the goal drifts even if the full thread still fits the prompt window", async () => {
    mockConversationLean.mockResolvedValue({
      preferred_language: "ru",
      airi_last_customer_language: "ru",
      airi_context_memory: {
        version: 1,
        summary: "Customer only had an idea before.",
        currentGoal: "\u0423 \u043c\u0435\u043d\u044f \u0438\u0434\u0435\u044f",
        unresolvedNeeds: [
          "\u0423 \u043c\u0435\u043d\u044f \u0438\u0434\u0435\u044f",
        ],
        resolvedNeeds: [],
        preferredLanguage: "ru",
        coveredThroughMessageId: "2",
        coveredMessageCount: 2,
        updatedAt: "2026-03-31T09:00:00.000Z",
      },
    });

    mockMessageLean.mockResolvedValue([
      {
        _id: "1",
        direction: "inbound",
        text: "\u0423 \u043c\u0435\u043d\u044f \u0438\u0434\u0435\u044f",
        date: "2026-03-31T08:55:00.000Z",
      },
      {
        _id: "2",
        direction: "outbound",
        text: "Airi: tell me more.",
        date: "2026-03-31T08:56:00.000Z",
      },
      {
        _id: "3",
        direction: "inbound",
        text: "\u0425\u043e\u0447\u0443 \u0443\u0437\u043d\u0430\u0442\u044c \u043f\u0440\u043e \u0433\u0440\u0430\u043d\u0442\u044b \u0438 \u0441\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c",
        date: "2026-03-31T10:00:00.000Z",
      },
      {
        _id: "4",
        direction: "outbound",
        text: "Airi: checking.",
        date: "2026-03-31T10:00:30.000Z",
      },
    ]);
    mockConversationUpdateOne.mockResolvedValue({ acknowledged: true });

    const context = await loadThreadReplyContext({
      conversationId: "conversation-1",
      latestInboundText:
        "\u0425\u043e\u0447\u0443 \u0443\u0437\u043d\u0430\u0442\u044c \u043f\u0440\u043e \u0433\u0440\u0430\u043d\u0442\u044b \u0438 \u0441\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c",
      mode: "adaptive",
      includeHistoryInContext: true,
      conversationPreferredLanguage: "ru",
      workspaceLanguage: "ru",
    });

    expect(context.currentGoal).toContain("\u0433\u0440\u0430\u043d\u0442");
    expect(mockConversationUpdateOne).toHaveBeenCalledTimes(1);
    expect(
      mockConversationUpdateOne.mock.calls[0][1].$set.airi_context_memory
    ).toMatchObject({
      currentGoal: expect.stringContaining("\u0433\u0440\u0430\u043d\u0442"),
      coveredMessageCount: 4,
    });
  });

  it("returns immediately for long threads while the richer memory summary refresh runs in background", async () => {
    chatCompletionWithFallback.mockImplementation(
      () => new Promise(() => undefined)
    );
    mockConversationLean.mockResolvedValue({
      preferred_language: "en",
      airi_last_customer_language: "en",
      airi_context_memory: null,
    });

    const longQuestion =
      "I need a detailed explanation about grants, deadlines, pricing, documents, and application steps for this program.";
    const filler = " Details ".repeat(220);

    mockMessageLean.mockResolvedValue(
      Array.from({ length: 16 }, (_, index) => ({
        _id: String(index + 1),
        direction: index % 2 === 0 ? "inbound" : "outbound",
        text:
          index === 14
            ? longQuestion
            : `${index % 2 === 0 ? "Customer" : "Airi"} ${index}${filler}`,
        date: `2026-04-01T10:${String(index).padStart(2, "0")}:00.000Z`,
      }))
    );
    mockConversationUpdateOne.mockResolvedValue({ acknowledged: true });

    const context = await loadThreadReplyContext({
      conversationId: "conversation-long",
      latestInboundText: longQuestion,
      mode: "adaptive",
      includeHistoryInContext: true,
      conversationPreferredLanguage: "en",
      workspaceLanguage: "en",
    });

    expect(context.threadMemorySummary).toContain("Current goal:");
    expect(context.threadMemorySummary).toContain("grants");
    expect(chatCompletionWithFallback).toHaveBeenCalledTimes(1);
    // Memory folding is a light-tier summary.
    expect(chatCompletionWithFallback.mock.calls[0][0].model).toBe(
      "claude-haiku-4-5"
    );
    expect(mockConversationUpdateOne).toHaveBeenCalledTimes(1);
    expect(
      mockConversationUpdateOne.mock.calls[0][1].$set.airi_context_memory
        .summary
    ).toContain("Current goal:");
  });

  it("keeps analyzed video context in the thread window without letting it override language scoring", async () => {
    mockConversationLean.mockResolvedValue({
      preferred_language: "ru",
      airi_last_customer_language: "ru",
      airi_context_memory: null,
    });

    mockMessageLean.mockResolvedValue([
      {
        _id: "1",
        direction: "inbound",
        text: "",
        mediaType: "video",
        videoAnalysis:
          "Video shows a cracked display and checkout error screen.",
        date: "2026-04-01T10:00:00.000Z",
      },
      {
        _id: "2",
        direction: "outbound",
        text: "Airi: checking.",
        date: "2026-04-01T10:00:30.000Z",
      },
    ]);

    const context = await loadThreadReplyContext({
      conversationId: "conversation-2",
      latestInboundText: null,
      mode: "adaptive",
      includeHistoryInContext: true,
      conversationPreferredLanguage: "ru",
      workspaceLanguage: "ru",
    });

    expect(context.recentConversationTail).toContain("Video message summary:");
    expect(context.recentConversationTail).toContain(
      "cracked display and checkout error screen"
    );
    expect(context.dominantLanguage).toBe("ru");
  });

  it("keeps the full raw thread in the live window while it still fits the threshold", async () => {
    mockConversationLean.mockResolvedValue({
      preferred_language: "en",
      airi_last_customer_language: "en",
      airi_context_memory: {
        version: 2,
        summary: "Old compact memory",
        currentGoal: "Old compact memory",
        unresolvedNeeds: ["Old compact memory"],
        resolvedNeeds: [],
        preferredLanguage: "en",
        coveredThroughMessageId: "2",
        coveredMessageCount: 2,
        updatedAt: "2026-04-01T10:00:00.000Z",
      },
    });

    mockMessageLean.mockResolvedValue([
      {
        _id: "1",
        direction: "inbound",
        text: "Hello",
        date: "2026-04-01T10:00:00.000Z",
      },
      {
        _id: "2",
        direction: "outbound",
        text: "Airi: Hi there.",
        date: "2026-04-01T10:00:30.000Z",
      },
      {
        _id: "3",
        direction: "inbound",
        text: "I want to know about grants",
        date: "2026-04-01T10:01:00.000Z",
      },
    ]);

    const context = await loadThreadReplyContext({
      conversationId: "conversation-full-raw",
      latestInboundText: "I want to know about grants",
      mode: "adaptive",
      includeHistoryInContext: true,
      conversationPreferredLanguage: "en",
      workspaceLanguage: "en",
    });

    expect(context.historyCompacted).toBe(false);
    expect(context.conversationWindow).toContain("[CUSTOMER] Hello");
    expect(context.conversationWindow).toContain("[AGENT] Hi there.");
    expect(context.conversationWindow).toContain(
      "[CUSTOMER] I want to know about grants"
    );
    expect(context.recentConversationTail).toBe(context.conversationWindow);
    expect(context.threadMemorySummary).not.toContain("THREAD MEMORY SUMMARY:");
  });

  it("loads only messages after compact memory cursor when the retained window is fresh", async () => {
    mockConversationLean.mockResolvedValue({
      preferred_language: "en",
      airi_last_customer_language: "en",
      airi_context_memory: {
        version: 2,
        summary: "Customer already discussed pricing context.",
        currentGoal: "price",
        unresolvedNeeds: ["price"],
        resolvedNeeds: [],
        preferredLanguage: "en",
        coveredThroughMessageId: "2",
        coveredMessageCount: 2,
        updatedAt: "2026-04-01T10:00:00.000Z",
      },
    });
    mockMessageFindByIdLean.mockResolvedValue({
      _id: "2",
      date: "2026-04-01T10:00:30.000Z",
    });
    mockMessageLean.mockResolvedValue([
      {
        _id: "2",
        direction: "outbound",
        text: "Airi: older answer.",
        date: "2026-04-01T10:00:30.000Z",
      },
      {
        _id: "3",
        direction: "inbound",
        text: "What is the price?",
        date: "2026-04-01T10:01:00.000Z",
      },
    ]);

    const context = await loadThreadReplyContext({
      conversationId: "conversation-cursor",
      latestInboundText: "What is the price?",
      mode: "adaptive",
      includeHistoryInContext: true,
      conversationPreferredLanguage: "en",
      workspaceLanguage: "en",
    });

    expect(mockMessageFindById).toHaveBeenCalledWith("2");
    expect(mockMessageFindArgs).toHaveBeenCalledWith({
      conversation: "conversation-cursor",
      date: { $gte: new Date("2026-04-01T10:00:30.000Z") },
    });
    expect(mockMessageFindSort).toHaveBeenCalledWith({ date: 1, _id: 1 });
    expect(context.conversationWindow).toContain(
      "[CUSTOMER] What is the price?"
    );
    expect(context.conversationWindow).not.toContain("older answer");
    expect(context.threadMemorySummary).toContain(
      "Customer already discussed pricing context."
    );
  });

  it("derives and persists an active selection when the customer explicitly chooses a grounded offer", async () => {
    understandCustomerTurn.mockResolvedValueOnce({
      kind: "followup_question",
      proceedWithRag: true,
      dependsOnPriorContext: true,
      safeReplyKey: null,
      confidence: "high",
      selectionTransition: {
        action: "select_offer",
        selectionLabel: "гайд",
      },
      asks: ["гайд"],
      coverageHints: ["гайд"],
      followUpMode: "expand_last_grounding",
      followUpAnchor: "QazInnovation guide",
      queryVariants: ["QazInnovation guide"],
      planningSource: "model",
    });

    mockConversationLean.mockResolvedValue({
      preferred_language: "ru",
      airi_last_customer_language: "ru",
      airi_context_memory: {
        version: 2,
        summary: null,
        currentGoal: "QazInnovation guide",
        unresolvedNeeds: ["QazInnovation guide"],
        resolvedNeeds: [],
        preferredLanguage: "ru",
        coveredThroughMessageId: null,
        coveredMessageCount: 0,
        lastGrounding: {
          sourceKind: "kb",
          sourceIds: ["kb-qazinnovation-guide"],
          intentAnchor: "QazInnovation guide",
          answeredAsks: ["guide"],
          updatedAt: "2026-04-01T10:00:00.000Z",
        },
        updatedAt: "2026-04-01T10:00:00.000Z",
      },
    });
    mockMessageLean.mockResolvedValue([
      {
        _id: "1",
        direction: "outbound",
        text: "Airi: У нас есть гайд по QazInnovation за 7000 тг. Хотите оформить?",
        date: "2026-04-01T10:00:00.000Z",
      },
      {
        _id: "2",
        direction: "inbound",
        text: "я хочу гайд",
        date: "2026-04-01T10:01:00.000Z",
      },
    ]);
    mockConversationUpdateOne.mockResolvedValue({ acknowledged: true });

    const context = await loadThreadReplyContext({
      conversationId: "conversation-selection",
      latestInboundText: "я хочу гайд",
      mode: "adaptive",
      includeHistoryInContext: true,
      conversationPreferredLanguage: "ru",
      workspaceLanguage: "ru",
    });

    expect(context.activeSelection).toEqual(
      expect.objectContaining({
        label: expect.stringContaining("гайд"),
        sourceKind: "kb",
        sourceIds: ["kb-qazinnovation-guide"],
        quotedPriceText: expect.stringContaining("7000"),
      })
    );
    expect(mockConversationUpdateOne).toHaveBeenCalled();
    expect(
      mockConversationUpdateOne.mock.calls.at(-1)?.[1]?.$set
        ?.airi_context_memory?.activeSelection
    ).toEqual(
      expect.objectContaining({
        sourceIds: ["kb-qazinnovation-guide"],
      })
    );
  });

  it("keeps the locked selection on a short commitment turn when turn understanding says keep_existing", async () => {
    understandCustomerTurn.mockResolvedValueOnce({
      kind: "followup_question",
      proceedWithRag: true,
      dependsOnPriorContext: true,
      safeReplyKey: null,
      confidence: "high",
      selectionTransition: {
        action: "keep_existing",
        selectionLabel: null,
      },
      asks: ["оформляем guide payment"],
      coverageHints: ["оформляем"],
      followUpMode: "expand_last_grounding",
      followUpAnchor: "QazInnovation guide",
      queryVariants: ["QazInnovation guide payment"],
      planningSource: "model",
    });

    mockConversationLean.mockResolvedValue({
      preferred_language: "ru",
      airi_last_customer_language: "ru",
      airi_context_memory: {
        version: 2,
        summary: null,
        currentGoal: "QazInnovation guide",
        unresolvedNeeds: ["QazInnovation guide"],
        resolvedNeeds: [],
        preferredLanguage: "ru",
        coveredThroughMessageId: null,
        coveredMessageCount: 0,
        lastGrounding: {
          sourceKind: "kb",
          sourceIds: ["kb-qazinnovation-guide"],
          intentAnchor: "QazInnovation guide",
          answeredAsks: ["guide"],
          updatedAt: "2026-04-01T10:00:00.000Z",
        },
        activeSelection: {
          kind: "offer",
          label: "QazInnovation guide",
          normalizedLabel: "qazinnovation guide",
          sourceKind: "kb",
          sourceIds: ["kb-qazinnovation-guide"],
          quotedPriceText: "7000 тг",
          quotedPriceAmount: 7000,
          quotedPriceCurrency: "KZT",
          updatedAt: "2026-04-01T10:00:00.000Z",
        },
        updatedAt: "2026-04-01T10:00:00.000Z",
      },
    });
    mockMessageLean.mockResolvedValue([
      {
        _id: "1",
        direction: "outbound",
        text: "Airi: У нас есть гайд по QazInnovation за 7000 тг. Хотите оформить?",
        date: "2026-04-01T10:00:00.000Z",
      },
      {
        _id: "2",
        direction: "inbound",
        text: "оформляем",
        date: "2026-04-01T10:01:00.000Z",
      },
    ]);

    const context = await loadThreadReplyContext({
      conversationId: "conversation-selection-keep",
      latestInboundText: "оформляем",
      mode: "adaptive",
      includeHistoryInContext: true,
      conversationPreferredLanguage: "ru",
      workspaceLanguage: "ru",
    });

    expect(context.activeSelection).toEqual(
      expect.objectContaining({
        label: "QazInnovation guide",
        sourceIds: ["kb-qazinnovation-guide"],
      })
    );
  });

  it("compacts a long chat so the latest turns, not the oldest, reach the reply", async () => {
    chatCompletionWithFallback.mockImplementation(
      () => new Promise(() => undefined)
    );
    mockConversationLean.mockResolvedValue({
      preferred_language: "ru",
      airi_last_customer_language: "ru",
      airi_context_memory: null,
    });
    const filler = " подробности".repeat(25);
    const messages = Array.from({ length: 40 }, (_, index) => ({
      _id: String(index + 1),
      direction: index % 2 === 0 ? "inbound" : "outbound",
      text: `старое сообщение ${index}${filler}`,
      date: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
    }));
    messages.push(
      {
        _id: "41",
        direction: "outbound",
        text: "Отправьте свою локацию, запланируем поездку к вам",
        date: "2026-10-23T14:08:09.409Z",
      },
      {
        _id: "42",
        direction: "inbound",
        text: "[Location] 51.105938, 71.396126",
        date: "2026-10-23T14:08:15.000Z",
      }
    );
    mockMessageLean.mockResolvedValue(messages);
    mockConversationUpdateOne.mockResolvedValue({ acknowledged: true });

    const context = await loadThreadReplyContext({
      conversationId: "conversation-scenario",
      latestInboundText: "[Location] 51.105938, 71.396126",
      scenarioStepAnswer: "location",
      mode: "adaptive",
      includeHistoryInContext: true,
      conversationPreferredLanguage: "ru",
      workspaceLanguage: "ru",
    });

    // Compaction used to fold one message and keep the oldest 4000 chars.
    expect(context.conversationWindow).toContain(
      "Отправьте свою локацию, запланируем поездку к вам"
    );
    expect(context.recentConversationTail.length).toBeLessThanOrEqual(4000);
    expect(context.recentConversationTail).toContain(
      "Отправьте свою локацию, запланируем поездку к вам"
    );
    expect(context.recentConversationTail).not.toContain("старое сообщение 1 ");
    const persisted =
      mockConversationUpdateOne.mock.calls[0]?.[1]?.$set?.airi_context_memory;
    expect(persisted?.coveredMessageCount).toBeGreaterThan(1);
    // The step's own question is what the location answers.
    expect(understandCustomerTurn.mock.calls[0][3]).toMatchObject({
      scenarioStepAnswer: {
        kind: "location",
        question: "Отправьте свою локацию, запланируем поездку к вам",
      },
    });
  });

  it("passes a tapped offer button to understanding and locks that offer", async () => {
    const { buildGroundedReplyOptionPayload } = await import(
      "@/lib/airi/reply/selection"
    );
    const payload = buildGroundedReplyOptionPayload({
      id: "offer-pro",
      label: "Тариф Про",
      sourceKind: "kb",
      sourceIds: ["kb-pricing"],
      quotedPriceText: "9 900 ₸",
    });
    mockConversationLean.mockResolvedValue({
      preferred_language: "ru",
      airi_last_customer_language: "ru",
      airi_context_memory: null,
    });
    mockMessageLean.mockResolvedValue([
      {
        _id: "1",
        direction: "outbound",
        text: "Выберите тариф: Старт или Про",
        date: "2026-10-23T10:00:00.000Z",
      },
      {
        _id: "2",
        direction: "inbound",
        text: "Тариф Про",
        date: "2026-10-23T10:01:00.000Z",
      },
    ]);
    mockConversationUpdateOne.mockResolvedValue({ acknowledged: true });
    understandCustomerTurn.mockResolvedValue({
      kind: "followup_question",
      proceedWithRag: true,
      dependsOnPriorContext: true,
      safeReplyKey: null,
      confidence: "high",
      selectionTransition: { action: "select_offer", selectionLabel: null },
      asks: ["Тариф Про"],
      coverageHints: ["Тариф Про"],
      followUpMode: "resume_current_goal",
      followUpAnchor: "Тариф Про",
      queryVariants: ["Тариф Про 9 900 ₸"],
      planningSource: "fallback",
    });

    const context = await loadThreadReplyContext({
      conversationId: "conversation-offer",
      latestInboundText: "Тариф Про",
      quickReplyPayload: payload,
      mode: "adaptive",
      includeHistoryInContext: true,
      conversationPreferredLanguage: "ru",
      workspaceLanguage: "ru",
    });

    expect(understandCustomerTurn.mock.calls[0][3]).toMatchObject({
      quickReplyPayload: payload,
    });
    expect(context.activeSelection).toMatchObject({
      label: "Тариф Про",
      sourceIds: ["kb-pricing"],
      quotedPriceText: "9 900 ₸",
    });
  });
});
