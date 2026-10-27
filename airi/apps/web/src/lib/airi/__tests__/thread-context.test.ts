import {
  buildThreadReplyContext,
  type AiriContextMemory,
  type ThreadMessage,
} from "@/lib/airi/reply/thread/thread-context";
import {
  EMPTY_THREAD_SCAFFOLD,
  type TurnUnderstanding,
} from "@/lib/airi/reply/turn/understand-customer-turn";

function buildTurnUnderstanding(
  overrides: Partial<TurnUnderstanding>
): TurnUnderstanding {
  return {
    kind: "question",
    proceedWithRag: true,
    calendarAvailabilityRelevant: false,
    dependsOnPriorContext: false,
    safeReplyKey: null,
    confidence: "high",
    selectionTransition: { action: "none", selectionLabel: null },
    asks: [],
    coverageHints: [],
    followUpMode: "none",
    followUpAnchor: null,
    queryVariants: [],
    planningSource: "model",
    threadScaffold: {
      ...EMPTY_THREAD_SCAFFOLD,
      trackThreadNeed: true,
    },
    ...overrides,
  };
}

describe("thread reply context", () => {
  it("treats greeting-prefixed product questions as substantive asks", () => {
    const text = "Здравствуйте! Хочу узнать об Airi.chat и WhatsApp";
    const messages: ThreadMessage[] = [
      {
        id: "1",
        direction: "inbound",
        text,
        date: "2026-03-30T13:58:39.000Z",
      },
    ];

    const context = buildThreadReplyContext({
      messages,
      latestInboundText: text,
      turnUnderstanding: buildTurnUnderstanding({
        asks: ["об Airi.chat", "об WhatsApp"],
        coverageHints: ["Airi.chat", "WhatsApp"],
        queryVariants: ["Airi.chat. WhatsApp", "об Airi.chat", "об WhatsApp"],
      }),
      mode: "adaptive",
      includeHistoryInContext: true,
      conversationPreferredLanguage: "ru",
      workspaceLanguage: "ru",
    });

    expect(context.currentGoal).toContain("Airi.chat");
    expect(context.retrievalQuery).toContain("WhatsApp");
    expect(context.queryVariants[0]).toContain("Airi.chat");
    expect(context.hasUnresolvedNeed).toBe(true);
  });

  it("carries the prior unresolved intent through impatience follow-ups", () => {
    const messages: ThreadMessage[] = [
      {
        id: "1",
        direction: "inbound",
        text: "Я хочу снова узнать какие нужны документы",
        date: "2026-03-27T11:26:00.000Z",
      },
      {
        id: "2",
        direction: "outbound",
        text: "Airi: Уточните, пожалуйста, для какого этапа?",
        date: "2026-03-27T11:27:00.000Z",
      },
      {
        id: "3",
        direction: "inbound",
        text: "Я жду",
        date: "2026-03-27T11:30:00.000Z",
      },
    ];

    const context = buildThreadReplyContext({
      messages,
      latestInboundText: "Я жду",
      turnUnderstanding: buildTurnUnderstanding({
        kind: "followup_question",
        dependsOnPriorContext: true,
        asks: ["документы для второго тура"],
        coverageHints: ["документы"],
        followUpMode: "resume_unresolved_need",
        followUpAnchor: "документы для второго тура",
        queryVariants: ["документы для второго тура"],
      }),
      mode: "adaptive",
      includeHistoryInContext: true,
      conversationPreferredLanguage: "ru",
      workspaceLanguage: "en",
    });

    expect(context.hasUnresolvedNeed).toBe(true);
    expect(context.followUpMode).toBe("resume_unresolved_need");
    expect(context.intentAnchor).toContain("документы");
    expect(context.retrievalQuery).toContain("документы");
    expect(context.retrievalQuery).not.toBe("Я жду");
  });

  it("keeps the dominant conversation language when the latest short entity is in another language", () => {
    const messages: ThreadMessage[] = [
      {
        id: "1",
        direction: "inbound",
        text: "подскажи пж как подать заявку?",
        date: "2026-03-27T10:30:00.000Z",
      },
      {
        id: "2",
        direction: "inbound",
        text: "«БесТірек»",
        date: "2026-03-27T10:31:00.000Z",
      },
    ];

    const context = buildThreadReplyContext({
      messages,
      latestInboundText: "«БесТірек»",
      turnUnderstanding: buildTurnUnderstanding({
        asks: ["как подать заявку в БесТірек"],
        coverageHints: ["подать заявку", "БесТірек"],
        queryVariants: ["как подать заявку в БесТірек", "БесТірек"],
      }),
      mode: "adaptive",
      includeHistoryInContext: true,
      conversationPreferredLanguage: "ru",
      workspaceLanguage: "en",
    });

    expect(context.dominantLanguage).toBe("ru");
    expect(context.retrievalQuery).toContain("подать заявку");
    expect(context.retrievalQuery).toContain("БесТірек");
  });

  it("merges a prior short program mention into a later standalone application question", () => {
    const messages: ThreadMessage[] = [
      {
        id: "1",
        direction: "inbound",
        text: "Получи ремесло",
        date: "2026-03-27T14:15:00.000Z",
      },
      {
        id: "2",
        direction: "outbound",
        text: "Airi: Расскажу про программу.",
        date: "2026-03-27T14:15:10.000Z",
      },
      {
        id: "3",
        direction: "inbound",
        text: "Как подать заявку?",
        date: "2026-03-27T14:15:26.000Z",
      },
    ];

    const context = buildThreadReplyContext({
      messages,
      latestInboundText: "Как подать заявку?",
      turnUnderstanding: buildTurnUnderstanding({
        asks: ["Как подать заявку в Получи ремесло"],
        coverageHints: ["подать заявку", "Получи ремесло"],
        queryVariants: ["Как подать заявку в Получи ремесло", "Получи ремесло"],
      }),
      mode: "adaptive",
      includeHistoryInContext: true,
      conversationPreferredLanguage: "ru",
      workspaceLanguage: "ru",
    });

    expect(context.retrievalQuery).toContain("Как подать заявку");
    expect(context.retrievalQuery).toContain("Получи ремесло");
    expect(context.intentAnchor).toContain("Как подать заявку");
  });

  it("prepends stored thread memory before newer raw messages", () => {
    const memory: AiriContextMemory = {
      version: 1,
      summary: "Earlier the customer asked about contest stages and documents.",
      currentGoal: "Documents for the second stage",
      unresolvedNeeds: ["Documents for the second stage"],
      resolvedNeeds: ["How many stages there are"],
      preferredLanguage: "ru",
      coveredThroughMessageId: "10",
      coveredMessageCount: 10,
      updatedAt: "2026-03-27T11:00:00.000Z",
    };
    const messages: ThreadMessage[] = [
      {
        id: "11",
        direction: "outbound",
        text: "Airi: уточните, пожалуйста, для какого этапа нужны документы?",
        date: "2026-03-27T11:05:00.000Z",
      },
      {
        id: "12",
        direction: "inbound",
        text: "интересуют документы для второго этапа",
        date: "2026-03-27T11:06:00.000Z",
      },
    ];

    const context = buildThreadReplyContext({
      messages,
      memory,
      latestInboundText: "интересуют документы для второго этапа",
      turnUnderstanding: buildTurnUnderstanding({
        asks: ["документы для второго этапа"],
        coverageHints: ["документы", "второй этап"],
        queryVariants: ["документы для второго этапа"],
      }),
      mode: "adaptive",
      includeHistoryInContext: true,
      conversationPreferredLanguage: "ru",
      workspaceLanguage: "en",
    });

    expect(context.threadMemorySummary).toContain("Current goal:");
    expect(context.recentConversationTail).toContain(
      "[CUSTOMER] интересуют документы для второго этапа"
    );
  });

  it("suppresses stale stored memory when newer turns switch the program context", () => {
    const memory: AiriContextMemory = {
      version: 1,
      summary: "Customer was previously interested in BesTirek.",
      currentGoal: "How to apply?",
      unresolvedNeeds: ["How to apply?"],
      resolvedNeeds: [],
      preferredLanguage: "ru",
      coveredThroughMessageId: "10",
      coveredMessageCount: 10,
      updatedAt: "2026-03-27T13:40:32.620Z",
    };
    const messages: ThreadMessage[] = [
      {
        id: "11",
        direction: "inbound",
        text: "Получи ремесло",
        date: "2026-03-27T14:15:00.000Z",
      },
      {
        id: "12",
        direction: "inbound",
        text: "Как подать заявку?",
        date: "2026-03-27T14:15:26.000Z",
      },
    ];

    const context = buildThreadReplyContext({
      messages,
      memory,
      latestInboundText: "Как подать заявку?",
      turnUnderstanding: buildTurnUnderstanding({
        asks: ["Как подать заявку в Получи ремесло"],
        coverageHints: ["подать заявку", "Получи ремесло"],
        queryVariants: ["Как подать заявку в Получи ремесло"],
      }),
      mode: "adaptive",
      includeHistoryInContext: true,
      conversationPreferredLanguage: "ru",
      workspaceLanguage: "ru",
    });

    expect(context.threadMemorySummary).not.toContain("BesTirek");
    expect(context.threadMemorySummary).toContain("Как подать заявку");
    expect(context.retrievalQuery).toContain("Получи ремесло");
  });

  it("detects compound asks from turn-understanding and keeps them in the retrieval plan", () => {
    const text = "Хочу узнать про гранты и стоимость";
    const context = buildThreadReplyContext({
      messages: [
        {
          id: "1",
          direction: "inbound",
          text,
          date: "2026-03-31T10:00:00.000Z",
        },
      ],
      latestInboundText: text,
      turnUnderstanding: buildTurnUnderstanding({
        asks: ["про гранты", "про стоимость"],
        coverageHints: ["гранты", "стоимость"],
        queryVariants: [
          "про гранты и стоимость",
          "про гранты",
          "про стоимость",
        ],
      }),
      mode: "adaptive",
      includeHistoryInContext: true,
      conversationPreferredLanguage: "ru",
      workspaceLanguage: "ru",
    });

    expect(context.openAsks).toEqual(["про гранты", "про стоимость"]);
    expect(context.coverageHints).toEqual(["гранты", "стоимость"]);
    expect(context.queryVariants).toEqual([
      "про гранты и стоимость",
      "про гранты",
      "про стоимость",
    ]);
    expect(context.retrievalQuery).toContain("гранты");
    expect(context.retrievalQuery).toContain("стоимость");
  });

  it("anchors generic follow-ups to the last grounded topic", () => {
    const memory: AiriContextMemory = {
      version: 1,
      summary: "Customer asked about turnkey service.",
      currentGoal: "Turnkey service",
      unresolvedNeeds: [],
      resolvedNeeds: ["Turnkey service"],
      preferredLanguage: "ru",
      coveredThroughMessageId: "2",
      coveredMessageCount: 2,
      lastGrounding: {
        sourceKind: "kb",
        sourceIds: ["kb-turnkey"],
        intentAnchor: "Под ключ",
        answeredAsks: ["Под ключ"],
        updatedAt: "2026-03-31T12:00:00.000Z",
      },
      updatedAt: "2026-03-31T12:00:00.000Z",
    };

    const context = buildThreadReplyContext({
      messages: [
        {
          id: "3",
          direction: "outbound",
          text: "Airi: yes, we can help turnkey.",
          date: "2026-03-31T12:01:00.000Z",
        },
        {
          id: "4",
          direction: "inbound",
          text: "Расскажи подробнее?",
          date: "2026-03-31T12:02:00.000Z",
        },
      ],
      memory,
      latestInboundText: "Расскажи подробнее?",
      turnUnderstanding: buildTurnUnderstanding({
        kind: "followup_question",
        dependsOnPriorContext: true,
        asks: ["Подробнее о работе под ключ"],
        coverageHints: ["Под ключ", "как работает"],
        followUpMode: "expand_last_grounding",
        followUpAnchor: "Под ключ",
        queryVariants: ["Под ключ", "Подробнее о работе под ключ"],
      }),
      mode: "adaptive",
      includeHistoryInContext: true,
      conversationPreferredLanguage: "ru",
      workspaceLanguage: "ru",
    });

    expect(context.followUpMode).toBe("expand_last_grounding");
    expect(context.followUpAnchor).toBe("Под ключ");
    expect(context.openAsks).toEqual(["Подробнее о работе под ключ"]);
    expect(context.retrievalQuery).toBe("Под ключ");
    expect(context.lastGrounding?.sourceIds).toEqual(["kb-turnkey"]);
  });
  it("keeps a substantive new ask primary even when a prior anchor remains in context", () => {
    const memory: AiriContextMemory = {
      version: 1,
      summary: "Customer asked about QazInnovation.",
      currentGoal: "QazInnovation",
      unresolvedNeeds: ["QazInnovation"],
      resolvedNeeds: ["Какие возможности есть"],
      preferredLanguage: "ru",
      coveredThroughMessageId: "10",
      coveredMessageCount: 10,
      lastGrounding: {
        sourceKind: "kb",
        sourceIds: ["kb-grants"],
        intentAnchor: "QazInnovation",
        answeredAsks: ["Хочу выиграть QazInnovation"],
        updatedAt: "2026-04-02T14:14:00.000Z",
      },
      updatedAt: "2026-04-02T14:14:00.000Z",
    };

    const context = buildThreadReplyContext({
      messages: [
        {
          id: "11",
          direction: "outbound",
          text: "Airi: Вот что я нашла по вашему вопросу про QazInnovation.",
          date: "2026-04-02T14:14:30.000Z",
        },
        {
          id: "12",
          direction: "inbound",
          text: "А есть индивидуальная работа",
          date: "2026-04-02T14:15:25.000Z",
        },
      ],
      memory,
      latestInboundText: "А есть индивидуальная работа",
      turnUnderstanding: buildTurnUnderstanding({
        kind: "followup_question",
        dependsOnPriorContext: true,
        asks: ["А есть индивидуальная работа"],
        coverageHints: ["индивидуальная работа", "QazInnovation"],
        followUpMode: "resume_unresolved_need",
        followUpAnchor: "QazInnovation",
        queryVariants: [
          "QazInnovation",
          "А есть индивидуальная работа",
          "А есть индивидуальная работа QazInnovation",
        ],
        threadScaffold: {
          ...EMPTY_THREAD_SCAFFOLD,
          trackThreadNeed: true,
          preferStandaloneAskOverFollowUpAnchor: true,
        },
      }),
      mode: "adaptive",
      includeHistoryInContext: true,
      conversationPreferredLanguage: "ru",
      workspaceLanguage: "ru",
    });

    expect(context.openAsks).toEqual(["А есть индивидуальная работа"]);
    expect(context.retrievalQuery).toBe("А есть индивидуальная работа");
    expect(context.intentAnchor).toBe("А есть индивидуальная работа");
    expect(context.queryVariants).toContain("QazInnovation");
  });

  // An eight-day-old "invest" topic must not anchor a scenario answer today.
  const staleInvestMemory: AiriContextMemory = {
    version: 2,
    summary: null,
    currentGoal: null,
    unresolvedNeeds: [],
    resolvedNeeds: [],
    preferredLanguage: "ru",
    coveredThroughMessageId: null,
    coveredMessageCount: 0,
    lastGrounding: {
      sourceKind: "kb",
      sourceIds: ["kb-partnership"],
      intentAnchor: "Хочу в вас инвестировать",
      answeredAsks: [],
      updatedAt: "2026-10-15T03:00:30.000Z",
    },
    updatedAt: "2026-10-15T03:00:30.000Z",
  };
  const scenarioMessages: ThreadMessage[] = [
    {
      id: "1",
      direction: "outbound",
      text: "Отправьте свою локацию, запланируем поездку к вам",
      date: "2026-10-23T14:08:09.409Z",
    },
    {
      id: "2",
      direction: "inbound",
      text: "[Location] 51.105938, 71.396126",
      date: "2026-10-23T14:08:15.000Z",
    },
  ];

  it("ignores a stale last grounding for anchoring, context and pinning", () => {
    const context = buildThreadReplyContext({
      messages: scenarioMessages,
      memory: staleInvestMemory,
      latestInboundText: "[Location] 51.105938, 71.396126",
      mode: "adaptive",
      includeHistoryInContext: true,
      conversationPreferredLanguage: "ru",
      workspaceLanguage: "ru",
    });

    expect(context.lastGrounding).toBeNull();
    expect(context.conversationWindow).not.toContain(
      "Хочу в вас инвестировать"
    );
    expect(context.activeGoals).not.toContain("Хочу в вас инвестировать");
    expect(context.intentAnchor).not.toBe("Хочу в вас инвестировать");
  });

  it("keeps a grounding from the same day as the latest turn", () => {
    const context = buildThreadReplyContext({
      messages: scenarioMessages,
      memory: {
        ...staleInvestMemory,
        lastGrounding: {
          ...staleInvestMemory.lastGrounding!,
          updatedAt: "2026-10-23T09:00:00.000Z",
        },
      },
      latestInboundText: "[Location] 51.105938, 71.396126",
      mode: "adaptive",
      includeHistoryInContext: true,
      conversationPreferredLanguage: "ru",
      workspaceLanguage: "ru",
    });

    expect(context.lastGrounding?.sourceIds).toEqual(["kb-partnership"]);
  });

  it("keeps the latest turns when the window is over its limit", () => {
    const longHistory: ThreadMessage[] = Array.from(
      { length: 60 },
      (_, index) => ({
        id: String(index + 1),
        direction: index % 2 ? "outbound" : "inbound",
        text: `старое сообщение ${index} ${"подробности ".repeat(12)}`,
        date: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
      })
    );
    const context = buildThreadReplyContext({
      messages: [...longHistory, ...scenarioMessages],
      latestInboundText: "[Location] 51.105938, 71.396126",
      mode: "adaptive",
      includeHistoryInContext: true,
      conversationPreferredLanguage: "ru",
      workspaceLanguage: "ru",
    });

    expect(context.conversationWindow.length).toBeLessThanOrEqual(4000);
    expect(context.conversationWindow).toContain(
      "Отправьте свою локацию, запланируем поездку к вам"
    );
    // The oldest raw turn gives way; memory may still name its topic.
    expect(context.conversationWindow).not.toContain(
      "2026-10-01T00:00:00.000Z [CUSTOMER]"
    );
  });
});
