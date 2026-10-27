const mockGenerateResponse = jest.fn();
const mockResolveActiveScenarioRuntime = jest.fn();
const mockConversationUpdateOne = jest.fn();
const mockConversationFindById = jest.fn();

jest.mock("@/lib/airi/rag/response/rag-response-service", () => ({
  RagResponseService: {
    generateResponse: (...args: unknown[]) => mockGenerateResponse(...args),
  },
}));
jest.mock("@/lib/airi/scenario/scenario-runtime", () => ({
  resolveActiveScenarioRuntime: (...args: unknown[]) =>
    mockResolveActiveScenarioRuntime(...args),
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    updateOne: (...args: unknown[]) => mockConversationUpdateOne(...args),
    findById: (...args: unknown[]) => mockConversationFindById(...args),
  },
}));
jest.mock("@/lib/observability/tracing", () => ({
  traceableChain: (fn: unknown) => fn,
}));
jest.mock("@/lib/airi/reply/runtime/reply-logging", () => ({
  airiReplyLogger: { info: jest.fn(), error: jest.fn() },
  compactLogList: (value: unknown) => value,
}));
jest.mock("@/lib/airi/reply/runtime/reply-operator-metrics", () => ({
  trackRagOutcomeMetrics: jest.fn(),
}));
jest.mock("@/lib/airi/reply/runtime/auto-reply-template-utils", () => ({
  firstValidHttpUrl: jest.fn(),
}));
jest.mock("@/lib/airi/reply/runtime/scenario-localization", () => ({
  resolveDefaultScenarioFlowReplyCta: jest.fn(),
  resolveDefaultScenarioLinkCta: jest.fn(),
}));
jest.mock("@/lib/whatsapp/referral-enrichment", () => ({
  buildWhatsAppReferralPromptContext: jest.fn(),
}));

import { runRagReplyFlow } from "./rag";

const terminalRuntime = {
  scenarioId: "end-scenario",
  scenarioName: "End scenario",
  selectedActionNodeId: "end",
  actionType: "end_scenario",
  scenarioPriority: 1,
  completesScenario: true,
};

function input(): Parameters<typeof runRagReplyFlow>[0] {
  return {
    workspaceId: "workspace",
    conversation: { _id: "conversation", channel: "whatsapp" } as never,
    currentMessageId: "inbound",
    channel: "whatsapp",
    runtimeChannel: "whatsapp",
    scenarioRuntime: {
      scenarioId: "initial-scenario",
      scenarioName: "Initial scenario",
      selectedActionNodeId: "initial-action",
      actionType: "reply",
      scenarioPriority: 1,
    } as never,
    scenarioStateForResolution: null,
    effectiveInputText: "Help",
    customerReplyLanguage: "en",
    threadReplyContext: {} as never,
    workspaceBotSettings: {
      retrievalQueryMode: "adaptive",
      includeRecentConversationInRetrievalContext: false,
    },
    companyContext: { dynamicTags: [] },
    widgetRagContext: "",
    fastMode: false,
    autoReplyParams: {
      triggerEventKind: "inbound_message",
      newMessage: { _id: "inbound", text: "Help" } as never,
    },
    checkPoint: jest.fn().mockResolvedValue(true),
  };
}

describe("RAG sibling terminal selection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateResponse.mockReset().mockResolvedValue({
      type: "fallback",
      content: "Generic fallback",
      decision: { priority: "generic" },
    });
    mockResolveActiveScenarioRuntime
      .mockReset()
      .mockResolvedValueOnce({ runtime: terminalRuntime })
      .mockResolvedValue({ runtime: null });
    mockConversationFindById.mockReturnValue({
      select: () => ({
        lean: async () => ({
          airi_scenario_state: {
            lockedScenarioId: "initial-scenario",
            currentActionNodeId: "initial-action",
            lastMessageId: "inbound",
          },
        }),
      }),
    });
    mockConversationUpdateOne
      .mockReset()
      .mockResolvedValue({ matchedCount: 1 });
  });

  it("commits an ending selected after a fallback without generating or returning another reply", async () => {
    const result = await runRagReplyFlow(input());
    expect(mockGenerateResponse).toHaveBeenCalledTimes(1);
    expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledTimes(1);
    expect(await result.handledResponse?.json()).toEqual({
      status: "ok",
      scenario_ended: true,
    });
    expect(result.ragResult).toBeUndefined();
    expect(mockConversationUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockConversationUpdateOne.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        "airi_scenario_state.lockedScenarioId": "initial-scenario",
        "airi_scenario_state.currentActionNodeId": "initial-action",
        "airi_scenario_state.lastMessageId": "inbound",
        "airi_scenario_state.pendingSourceActionNodeId": null,
        "airi_scenario_state.pendingLinkedConditionId": null,
        "airi_scenario_state.scenarioRevisionFingerprint": null,
      })
    );
    expect(mockConversationUpdateOne.mock.calls[0][1]).toEqual({
      $set: {
        airi_scenario_state: expect.objectContaining({
          lockedScenarioId: null,
          currentActionNodeId: null,
          pendingConditionNodeId: null,
          pendingSourceActionNodeId: null,
          completedScenarios: [
            expect.objectContaining({
              scenarioId: "end-scenario",
              lastActionNodeId: "end",
              lastMessageId: "inbound",
            }),
          ],
        }),
      },
    });
  });

  it("propagates a failed terminal commit without generating or returning a fallback", async () => {
    const failure = new Error("terminal commit failed");
    mockConversationUpdateOne.mockRejectedValue(failure);
    await expect(runRagReplyFlow(input())).rejects.toMatchObject({
      code: "conversation_write_failed",
      cause: failure,
    });
    expect(mockGenerateResponse).toHaveBeenCalledTimes(1);
    expect(mockResolveActiveScenarioRuntime).toHaveBeenCalledTimes(1);
  });

  it("honors cancellation before committing the selected ending", async () => {
    const params = input();
    params.checkPoint = jest.fn().mockResolvedValue(false);
    const result = await runRagReplyFlow(params);
    expect(await result.handledResponse?.json()).toEqual({
      status: "ok",
      cancelled: true,
    });
    expect(mockGenerateResponse).toHaveBeenCalledTimes(1);
    expect(mockConversationUpdateOne).not.toHaveBeenCalled();
  });
});

describe("customer answers in the AI reply instruction", () => {
  const SIBLING = "65f0000000000000000000b2";
  const formAnswerFields = {
    "order-form": {
      formKey: "order",
      formLabel: "Order details",
      fields: { size: { key: "size", label: "Size" } },
    },
  };
  function answeredInput(): Parameters<typeof runRagReplyFlow>[0] {
    const params = input();
    params.scenarioRuntime = {
      ...params.scenarioRuntime,
      actionReplyInstruction: "Confirm size {{form.order.size}}.",
      formAnswerFields,
    } as never;
    params.scenarioStateForResolution = {
      lockedScenarioId: "initial-scenario",
      formAnswers: {
        scenarioId: "initial-scenario",
        submissions: [
          {
            sourceActionNodeId: "order-form",
            flowId: null,
            inboundMessageId: "message-0",
            submittedAt: "2026-09-30T10:00:00.000Z",
            fields: [
              {
                key: "size",
                label: "Size",
                fieldType: "Dropdown",
                value: "Large",
              },
            ],
          },
        ],
      },
    };
    return params;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveActiveScenarioRuntime.mockReset();
    mockGenerateResponse.mockReset();
    mockConversationFindById.mockReturnValue({
      select: () => ({ lean: async () => null }),
    });
    mockConversationUpdateOne
      .mockReset()
      .mockResolvedValue({ matchedCount: 1 });
  });

  it("names the answer in the instruction and sends its value as customer data", async () => {
    mockGenerateResponse.mockResolvedValue({
      type: "ai_reply",
      content: "Large it is.",
      decision: { priority: "kb" },
    });

    const result = await runRagReplyFlow(answeredInput());

    expect(mockGenerateResponse).toHaveBeenCalledTimes(1);
    const [request] = mockGenerateResponse.mock.calls[0];
    expect(request.scenarioRuntime.actionReplyInstruction).toBe(
      "Confirm size [Order details › Size]."
    );
    expect(request.customerAnswersBlock).toBe(
      "[Order details › Size]: \u201CLarge\u201D"
    );
    // The runtime the turn goes on with keeps the merchant's own words.
    expect(result.scenarioRuntime?.actionReplyInstruction).toBe(
      "Confirm size {{form.order.size}}."
    );
  });

  it("gives a sibling scenario only its own answers and the open fallback none", async () => {
    mockGenerateResponse.mockResolvedValue({
      type: "fallback",
      content: "Generic fallback",
      decision: { priority: "generic" },
    });
    mockResolveActiveScenarioRuntime
      .mockResolvedValueOnce({
        runtime: {
          scenarioId: SIBLING,
          scenarioName: "Sibling",
          selectedActionNodeId: "sibling-action",
          actionType: "reply",
          scenarioPriority: 1,
          actionReplyInstruction: "Mention {{form.order.size}}.",
          formAnswerFields,
        },
      })
      .mockResolvedValue({ runtime: null });

    await runRagReplyFlow(answeredInput());

    const requests = mockGenerateResponse.mock.calls.map(([request]) => ({
      scenarioId: request.scenarioRuntime?.scenarioId ?? null,
      instruction: request.scenarioRuntime?.actionReplyInstruction ?? null,
      answers: request.customerAnswersBlock ?? null,
    }));
    expect(requests).toEqual([
      {
        scenarioId: "initial-scenario",
        instruction: "Confirm size [Order details › Size].",
        answers: "[Order details › Size]: \u201CLarge\u201D",
      },
      {
        scenarioId: SIBLING,
        instruction: "Mention [Order details › Size].",
        answers: expect.stringContaining(
          "[Order details › Size]: (not answered)"
        ),
      },
      { scenarioId: null, instruction: null, answers: null },
    ]);
  });
});

describe("what the reply writer is told the customer said", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateResponse.mockReset().mockResolvedValue({
      type: "ai_reply",
      content: "Thanks!",
      decision: { priority: "kb" },
    });
    mockConversationFindById.mockReturnValue({
      select: () => ({ lean: async () => null }),
    });
  });

  it("sends the customer's own words, not the plan's retrieval query", async () => {
    const params = input();
    params.effectiveInputText = "Да";
    params.threadReplyContext = {
      retrievalQuery: "Сможете запустить на 2500 контактов?",
      lastMessageQuery: "Да",
    } as never;

    await runRagReplyFlow(params);

    const [request] = mockGenerateResponse.mock.calls[0];
    expect(request.text).toBe("Сможете запустить на 2500 контактов?");
    expect(request.customerMessage).toBe("Да");
  });

  it("names the step question a location answers", async () => {
    const params = input();
    params.effectiveInputText = "[Location] 51.105938, 71.396126";
    params.threadReplyContext = {
      retrievalQuery: "Отправьте свою локацию, запланируем поездку к вам",
      lastMessageQuery: "[Location] 51.105938, 71.396126",
      turnUnderstanding: {
        scenarioStepQuestion:
          "Отправьте свою локацию, запланируем поездку к вам",
      },
    } as never;

    await runRagReplyFlow(params);

    const [request] = mockGenerateResponse.mock.calls[0];
    expect(request.customerMessage).toBe(
      '[Location] 51.105938, 71.396126\n(This answers your question: "Отправьте свою локацию, запланируем поездку к вам")'
    );
  });
});
