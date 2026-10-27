const mockConversationUpdateOne = jest.fn();
const mockConversationFindById = jest.fn();

jest.mock("@/models/conversation", () => ({
  Conversation: {
    updateOne: (...args: unknown[]) => mockConversationUpdateOne(...args),
    findById: (...args: unknown[]) => mockConversationFindById(...args),
  },
}));

jest.mock("@/lib/airi/scenario/scenario-runtime", () => ({
  resolveActiveScenarioRuntime: jest.fn(),
}));

import {
  completeLockedScenarioAndPersist,
  completeScenarioAfterDispatch,
  clearPendingConditionStateAndPersist,
  persistPendingConditionState,
  persistRecoveredPendingConditionState,
  persistScenarioFormSubmission,
  persistScenarioState,
  reconcileRagScenarioSelectionAndPersist,
} from "@/lib/airi/reply/runtime/auto-reply-scenario-state";
import { resolveScenarioDeliveryOwnership } from "@icecore/airi-runtime/delivery-gates";

function createFindByIdQuery(value: unknown) {
  return {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(value),
  };
}

describe("auto-reply scenario state reconciliation", () => {
  it.each([null, "next"])(
    "allows a prepared send whose canonical next action is %s",
    async nextActionNodeId => {
      mockConversationUpdateOne
        .mockClear()
        .mockResolvedValue({ matchedCount: 1 });
      await persistScenarioState({
        conversationId: "conversation",
        scenarioRuntime: {
          scenarioId: "scenario",
          scenarioName: "Scenario",
          actionType: "whatsapp_template",
          selectedActionNodeId: "send",
          nextActionNodeId,
          completesScenario: nextActionNodeId === null,
        } as never,
        messageId: "inbound",
        baseState: {},
      });
      const state =
        mockConversationUpdateOne.mock.calls[0][1].$set.airi_scenario_state;
      expect(state.currentActionNodeId).toBe(nextActionNodeId ?? "send");
      expect(
        resolveScenarioDeliveryOwnership({
          capturedConversation: {},
          currentConversation: { airi_scenario_state: state },
          scenarioId: "scenario",
          actionNodeId: "send",
        })
      ).toEqual({ allow: true });
    }
  );
  it("commits an explicit ending and clears its pending wait in one state write", async () => {
    mockConversationUpdateOne.mockResolvedValue({ matchedCount: 1 });
    await persistScenarioState({
      conversationId: "conversation",
      scenarioRuntime: {
        scenarioId: "scenario",
        scenarioName: "Scenario",
        actionType: "end_scenario",
        selectedActionNodeId: "end",
        completesScenario: true,
        nextActionNodeId: null,
      } as never,
      messageId: "last-reply",
      baseState: {
        lockedScenarioId: "scenario",
        currentActionNodeId: "menu",
        pendingConditionNodeId: "wait",
        pendingSourceActionNodeId: "menu",
        pendingStartedAt: new Date(),
        pendingLastOutboundMessageId: "outbound",
        completedScenarios: [{ scenarioId: "other", completedAt: new Date() }],
      },
    });
    expect(mockConversationUpdateOne).toHaveBeenCalledTimes(1);
    const update = mockConversationUpdateOne.mock.calls[0][1];
    expect(Object.keys(update.$set)).toEqual(["airi_scenario_state"]);
    expect(update.$set.airi_scenario_state).toMatchObject({
      lockedScenarioId: null,
      currentActionNodeId: null,
      pendingConditionNodeId: null,
      pendingSourceActionNodeId: null,
      pendingStartedAt: null,
      pendingLastOutboundMessageId: null,
      currentPathNodeIds: [],
      currentBranchNodeIds: [],
      lastMessageId: "last-reply",
      startedScenarios: [expect.objectContaining({ scenarioId: "scenario" })],
      completedScenarios: [
        expect.objectContaining({
          scenarioId: "scenario",
          lastActionNodeId: "end",
          lastMessageId: "last-reply",
        }),
        expect.objectContaining({ scenarioId: "other" }),
      ],
    });
  });
  it("refuses an explicit ending if another turn has moved the conversation", async () => {
    mockConversationUpdateOne.mockResolvedValue({ matchedCount: 0 });
    await expect(
      persistScenarioState({
        conversationId: "conversation",
        messageId: "finish-reply",
        scenarioRuntime: {
          scenarioId: "scenario",
          scenarioName: "Scenario",
          actionType: "end_scenario",
          selectedActionNodeId: "end",
        } as never,
        baseState: {
          lockedScenarioId: "scenario",
          currentActionNodeId: "menu",
          lastMessageId: "previous",
        },
      })
    ).rejects.toMatchObject({ code: "conversation_state_changed" });
    expect(mockConversationUpdateOne.mock.calls[0][0]).toMatchObject({
      "airi_scenario_state.lockedScenarioId": "scenario",
      "airi_scenario_state.currentActionNodeId": "menu",
      "airi_scenario_state.lastMessageId": "previous",
    });
  });
  it("fences behavior cancellation so it cannot clear a newer episode", async () => {
    mockConversationUpdateOne.mockResolvedValue({ matchedCount: 0 });
    const result = await completeLockedScenarioAndPersist({
      conversationId: "conversation",
      scenarioId: "scenario",
      scenarioName: "Scenario",
      baseState: {
        lockedScenarioId: "scenario",
        behaviorRunId: "a".repeat(24),
      },
      expectedBehaviorRunId: "a".repeat(24),
    });
    expect(result.persisted).toBe(false);
    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      {
        _id: "conversation",
        "airi_scenario_state.behaviorRunId": "a".repeat(24),
      },
      expect.anything()
    );
  });
  it("keeps form answers for their own scenario only and clears them when it ends", async () => {
    mockConversationUpdateOne
      .mockClear()
      .mockResolvedValue({ matchedCount: 1 });
    const formAnswers = {
      scenarioId: "orders",
      submissions: [
        {
          sourceActionNodeId: "order-form",
          flowId: null,
          inboundMessageId: "message-1",
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
    };
    const baseState = { lockedScenarioId: "orders", formAnswers };
    const persist = (scenarioRuntime: Record<string, unknown>) =>
      persistScenarioState({
        conversationId: "conversation",
        scenarioRuntime: {
          scenarioName: "Scenario",
          actionType: "reply",
          selectedActionNodeId: "answer",
          ...scenarioRuntime,
        } as never,
        messageId: "reply",
        baseState,
      });
    const saved = (call: number) =>
      mockConversationUpdateOne.mock.calls[call][1].$set.airi_scenario_state
        .formAnswers;

    await persist({ scenarioId: "orders", nextActionNodeId: "next" });
    expect(saved(0)).toEqual(formAnswers);
    await persist({ scenarioId: "other", nextActionNodeId: "next" });
    expect(saved(1)).toBeNull();
    await persist({
      scenarioId: "orders",
      actionType: "end_scenario",
      completesScenario: true,
      nextActionNodeId: null,
    });
    expect(saved(2)).toBeNull();
  });

  it("keeps behavior episode identity through replies and clears it on a new scenario", async () => {
    mockConversationUpdateOne
      .mockClear()
      .mockResolvedValue({ acknowledged: true });
    const scenarioRuntime = {
      scenarioId: "behavior",
      scenarioName: "Behavior",
      actionType: "reply",
      selectedActionNodeId: "action",
    } as never;
    const behaviorRunId = "a".repeat(24);
    await persistScenarioState({
      conversationId: "conversation",
      scenarioRuntime,
      messageId: `customer-behavior:${behaviorRunId}`,
      baseState: null,
    });
    const first =
      mockConversationUpdateOne.mock.calls[0][1].$set.airi_scenario_state;
    expect(first.behaviorRunId).toBe(behaviorRunId);
    await persistScenarioState({
      conversationId: "conversation",
      scenarioRuntime,
      messageId: "real-customer-reply",
      baseState: first,
    });
    expect(
      mockConversationUpdateOne.mock.calls[1][1].$set.airi_scenario_state
        .behaviorRunId
    ).toBe(behaviorRunId);
    await persistScenarioState({
      conversationId: "conversation",
      scenarioRuntime: {
        ...(scenarioRuntime as object),
        scenarioId: "other",
      } as never,
      messageId: "another-reply",
      baseState: first,
    });
    expect(
      mockConversationUpdateOne.mock.calls[2][1].$set.airi_scenario_state
        .behaviorRunId
    ).toBeNull();
  });
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("persists the final sibling scenario only once after routing settles", async () => {
    mockConversationFindById.mockReturnValue(
      createFindByIdQuery({
        airi_scenario_state: {
          lockedScenarioId: "scenario-a",
          lockedScenarioName: "Scenario A",
          currentActionNodeId: "action-a",
          scenarioRevisionFingerprint: "revision-a",
        },
      })
    );
    mockConversationUpdateOne.mockResolvedValue({ acknowledged: true });

    await reconcileRagScenarioSelectionAndPersist({
      conversationId: "conversation-1",
      initialScenarioRuntime: {
        scenarioId: "scenario-a",
        scenarioName: "Scenario A",
        actionType: "reply",
        includeConversationTimeline: true,
        includeConversationSummaries: true,
        includeSnippets: true,
        includeKBArticles: true,
        includeIndexedUrls: true,
        includeQuickReplies: true,
        includeCustomerProfile: true,
        includePurchaseHistory: true,
        includeActiveSubscriptions: true,
        includeDynamicBusinessTags: true,
      },
      finalScenarioRuntime: {
        scenarioId: "scenario-b",
        scenarioName: "Scenario B",
        selectedActionNodeId: "action-b",
        actionType: "reply",
        includeConversationTimeline: true,
        includeConversationSummaries: true,
        includeSnippets: true,
        includeKBArticles: true,
        includeIndexedUrls: true,
        includeQuickReplies: true,
        includeCustomerProfile: true,
        includePurchaseHistory: true,
        includeActiveSubscriptions: true,
        includeDynamicBusinessTags: true,
      },
      messageId: "message-1",
      candidateScenarioIds: ["scenario-a", "scenario-b"],
    });

    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      { _id: "conversation-1" },
      expect.objectContaining({
        $set: {
          airi_scenario_state: expect.objectContaining({
            lockedScenarioId: "scenario-b",
            lockedScenarioName: "Scenario B",
            currentActionNodeId: "action-b",
            scenarioRevisionFingerprint: null,
            lastMessageId: "message-1",
          }),
        },
      })
    );
    const persistedState = (
      mockConversationUpdateOne.mock.calls[0]?.[1] as {
        $set: { airi_scenario_state: Record<string, unknown> };
      }
    ).$set.airi_scenario_state;
    expect(persistedState).not.toHaveProperty("journeyPools");
  });

  it("clears a routed scenario lock when unrestricted fallback wins", async () => {
    mockConversationFindById.mockReturnValue(
      createFindByIdQuery({
        airi_scenario_state: {
          lockedScenarioId: "scenario-b",
          lockedScenarioName: "Scenario B",
          currentActionNodeId: "action-b",
          scenarioRevisionFingerprint: "revision-b",
          startedScenarios: [
            {
              scenarioId: "scenario-a",
              scenarioName: "Scenario A",
              startedAt: "2026-04-01T10:00:00.000Z",
            },
            {
              scenarioId: "scenario-b",
              scenarioName: "Scenario B",
              startedAt: "2026-04-01T10:05:00.000Z",
            },
          ],
          journeyPools: [
            {
              poolKey: "product_entry",
              ownerScenarioId: "scenario-b",
              ownerScenarioName: "Scenario B",
              lockedAt: "2026-04-01T10:05:00.000Z",
            },
          ],
        },
      })
    );
    mockConversationUpdateOne.mockResolvedValue({ acknowledged: true });

    await reconcileRagScenarioSelectionAndPersist({
      conversationId: "conversation-1",
      initialScenarioRuntime: {
        scenarioId: "scenario-a",
        scenarioName: "Scenario A",
        actionType: "reply",
        includeConversationTimeline: true,
        includeConversationSummaries: true,
        includeSnippets: true,
        includeKBArticles: true,
        includeIndexedUrls: true,
        includeQuickReplies: true,
        includeCustomerProfile: true,
        includePurchaseHistory: true,
        includeActiveSubscriptions: true,
        includeDynamicBusinessTags: true,
      },
      finalScenarioRuntime: null,
      messageId: "message-1",
      candidateScenarioIds: ["scenario-a", "scenario-b"],
    });

    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      { _id: "conversation-1" },
      expect.objectContaining({
        $set: {
          airi_scenario_state: expect.objectContaining({
            lockedScenarioId: null,
            lockedScenarioName: null,
            currentActionNodeId: null,
            scenarioRevisionFingerprint: null,
            pendingConditionNodeId: null,
          }),
        },
      })
    );
    const persistedState = (
      mockConversationUpdateOne.mock.calls[0]?.[1] as {
        $set: { airi_scenario_state: Record<string, unknown> };
      }
    ).$set.airi_scenario_state;
    expect(persistedState).not.toHaveProperty("journeyPools");
  });

  it("persists pending interactive conditions immediately to avoid fast-reply resend races", async () => {
    mockConversationUpdateOne.mockResolvedValue({ acknowledged: true });

    await persistScenarioState({
      conversationId: "conversation-1",
      scenarioRuntime: {
        scenarioId: "scenario-flow",
        scenarioName: "Scenario Flow",
        scenarioUpdatedAt: "2026-09-09T09:00:00.000Z",
        selectedActionNodeId: "flow-1",
        nextActionNodeId: "flow-1",
        pendingConditionNodeId: "__system:action-outcomes:flow-1",
        pendingSourceActionNodeId: "flow-1",
        pendingLinkedConditionId: "child-timeout-1",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "flow",
            body: { mode: "fixed", text: "Open the form" },
            flowConfig: {
              templateId: "flow-template",
              ctaText: "Open",
              screens: [],
            },
          },
        },
        includeConversationTimeline: true,
        includeConversationSummaries: true,
        includeSnippets: true,
        includeKBArticles: true,
        includeIndexedUrls: true,
        includeQuickReplies: true,
        includeCustomerProfile: true,
        includePurchaseHistory: true,
        includeActiveSubscriptions: true,
        includeDynamicBusinessTags: true,
      },
      messageId: "message-1",
      baseState: {},
    });

    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      { _id: "conversation-1" },
      expect.objectContaining({
        $set: {
          airi_scenario_state: expect.objectContaining({
            lockedScenarioId: "scenario-flow",
            currentActionNodeId: "flow-1",
            pendingConditionNodeId: "__system:action-outcomes:flow-1",
            pendingSourceActionNodeId: "flow-1",
            pendingLinkedConditionId: "child-timeout-1",
            pendingScenarioUpdatedAt: new Date("2026-09-09T09:00:00.000Z"),
          }),
        },
      })
    );
  });

  it("keeps the start and anchor of a wait a silent turn holds", async () => {
    mockConversationUpdateOne.mockResolvedValue({ acknowledged: true });
    const startedAt = new Date("2026-09-20T08:00:00.000Z");

    await persistScenarioState({
      conversationId: "conversation-1",
      scenarioRuntime: {
        scenarioId: "scenario-ask",
        scenarioName: "Ask",
        selectedActionNodeId: "ask",
        nextActionNodeId: "ask",
        pendingConditionNodeId: "__system:action-outcomes:ask",
        pendingSourceActionNodeId: "ask",
        actionType: "reply",
        includeConversationTimeline: false,
        includeConversationSummaries: false,
        includeSnippets: false,
        includeKBArticles: false,
        includeIndexedUrls: false,
        includeQuickReplies: false,
        includeCustomerProfile: false,
        includePurchaseHistory: false,
        includeActiveSubscriptions: false,
        includeDynamicBusinessTags: false,
      },
      messageId: "message-2",
      baseState: {},
      keepPendingWait: { startedAt, lastOutboundMessageId: "outbound-1" },
    });

    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      { _id: "conversation-1" },
      expect.objectContaining({
        $set: {
          airi_scenario_state: expect.objectContaining({
            pendingConditionNodeId: "__system:action-outcomes:ask",
            pendingStartedAt: startedAt,
            pendingLastOutboundMessageId: "outbound-1",
          }),
        },
      })
    );
  });

  it("retains the selected revision when dispatch creates a wait after an edit", async () => {
    mockConversationUpdateOne.mockResolvedValue({ matchedCount: 1 });
    mockConversationFindById.mockReturnValue(
      createFindByIdQuery({
        airi_scenario_state: {
          lockedScenarioId: "scenario-flow",
          currentActionNodeId: "flow-1",
          pendingScenarioUpdatedAt: new Date("2026-09-09T10:00:00Z"),
        },
      })
    );
    await completeScenarioAfterDispatch({
      conversationId: "conversation-1",
      baseState: {},
      scenarioRuntime: {
        scenarioId: "scenario-flow",
        scenarioName: "Scenario Flow",
        scenarioUpdatedAt: "2026-09-09T09:00:00.000Z",
        selectedActionNodeId: "flow-1",
        pendingConditionNodeId: "__system:action-outcomes:flow-1",
        pendingSourceActionNodeId: "flow-1",
        actionType: "reply",
        includeConversationTimeline: false,
        includeConversationSummaries: false,
        includeSnippets: false,
        includeKBArticles: false,
        includeIndexedUrls: false,
        includeQuickReplies: false,
        includeCustomerProfile: false,
        includePurchaseHistory: false,
        includeActiveSubscriptions: false,
        includeDynamicBusinessTags: false,
      },
      completionTimestamp: "2026-09-09T11:00:00Z",
      lastMessageId: "outbound-1",
    });
    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      { _id: "conversation-1" },
      {
        $set: {
          airi_scenario_state: expect.objectContaining({
            pendingScenarioUpdatedAt: new Date("2026-09-09T09:00:00Z"),
            pendingLastOutboundMessageId: "outbound-1",
          }),
        },
      }
    );
  });

  it("clears the payment revision with its pending wait", async () => {
    mockConversationUpdateOne.mockResolvedValue({ matchedCount: 1 });
    await clearPendingConditionStateAndPersist({
      conversationId: "conversation-1",
      baseState: {
        lockedScenarioId: "scenario-flow",
        pendingConditionNodeId: "wait-1",
        pendingScenarioUpdatedAt: "2026-09-09T09:00:00.000Z",
      },
    });
    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      { _id: "conversation-1" },
      {
        $set: {
          airi_scenario_state: expect.objectContaining({
            pendingConditionNodeId: null,
            pendingScenarioUpdatedAt: null,
          }),
        },
      }
    );
  });

  it("does not manufacture a payment revision while recovering an old outbound wait", async () => {
    mockConversationUpdateOne.mockResolvedValue({ matchedCount: 1 });
    await persistRecoveredPendingConditionState({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      scenarioId: "scenario-flow",
      sourceActionNodeId: "flow-1",
      conditionNodeId: "__system:action-outcomes:flow-1",
      pendingStartedAt: new Date("2026-09-09T11:00:00Z"),
      pendingLastOutboundMessageId: "outbound-1",
      pendingLinkedConditionId: null,
      expectedCurrentActionNodeId: "flow-1",
    });
    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1" }),
      {
        $set: expect.objectContaining({
          "airi_scenario_state.pendingScenarioUpdatedAt": null,
          "airi_scenario_state.pendingLastOutboundMessageId": "outbound-1",
        }),
      }
    );
  });

  it("preserves an explicitly verified outbound anchor when an interactive reply re-arms a wait", async () => {
    mockConversationUpdateOne.mockResolvedValue({ acknowledged: true });

    await persistPendingConditionState({
      conversationId: "conversation-1",
      baseState: {
        lockedScenarioId: "scenario-flow",
        currentActionNodeId: "flow-1",
        pendingConditionNodeId: "wait-1",
        pendingSourceActionNodeId: "flow-1",
        pendingStartedAt: "2026-05-01T00:00:00.000Z",
        pendingScenarioUpdatedAt: "2026-04-30T00:00:00.000Z",
        pendingLastOutboundMessageId: "message-out-1",
      },
      scenarioId: "scenario-flow",
      scenarioName: "Scenario Flow",
      sourceActionNodeId: "flow-1",
      conditionNodeId: "__system:action-outcomes:flow-1",
      pendingLastOutboundMessageId: "message-out-1",
      messageId: "interactive-reply-1",
      startedAt: "2026-05-01T00:05:00.000Z",
    });

    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      { _id: "conversation-1" },
      expect.objectContaining({
        $set: {
          airi_scenario_state: expect.objectContaining({
            pendingConditionNodeId: "__system:action-outcomes:flow-1",
            pendingSourceActionNodeId: "flow-1",
            pendingLastOutboundMessageId: "message-out-1",
            pendingScenarioUpdatedAt: new Date("2026-04-30T00:00:00.000Z"),
            lastMessageId: "interactive-reply-1",
          }),
        },
      })
    );
  });

  it("does not inherit a stale outbound anchor when re-arm does not provide one", async () => {
    mockConversationUpdateOne.mockResolvedValue({ acknowledged: true });

    await persistPendingConditionState({
      conversationId: "conversation-1",
      baseState: {
        lockedScenarioId: "scenario-flow",
        currentActionNodeId: "flow-1",
        pendingConditionNodeId: "wait-1",
        pendingSourceActionNodeId: "flow-1",
        pendingLastOutboundMessageId: "stale-message-out",
      },
      scenarioId: "scenario-flow",
      scenarioName: "Scenario Flow",
      sourceActionNodeId: "flow-2",
      conditionNodeId: "__system:action-outcomes:flow-2",
    });

    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      { _id: "conversation-1" },
      expect.objectContaining({
        $set: {
          airi_scenario_state: expect.objectContaining({
            pendingLastOutboundMessageId: null,
          }),
        },
      })
    );
  });

  it("compare-and-sets terminal pending-state completion against the timer anchor", async () => {
    mockConversationUpdateOne.mockResolvedValue({ matchedCount: 1 });

    const result = await completeLockedScenarioAndPersist({
      conversationId: "conversation-1",
      baseState: {
        lockedScenarioId: "scenario-1",
        lockedScenarioName: "Scenario 1",
        pendingConditionNodeId: "condition-1",
        pendingSourceActionNodeId: "action-1",
        pendingStartedAt: "2026-05-01T00:00:00.000Z",
        pendingLastOutboundMessageId: "message-out-1",
      },
      scenarioId: "scenario-1",
      scenarioName: "Scenario 1",
      lastActionNodeId: "action-1",
      lastMessageId: "message-out-1",
      expectedPendingState: {
        conditionNodeId: "condition-1",
        sourceActionNodeId: "action-1",
        pendingStartedAt: "2026-05-01T00:00:00.000Z",
        lastOutboundMessageId: "message-out-1",
      },
    });

    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      {
        _id: "conversation-1",
        "airi_scenario_state.lockedScenarioId": "scenario-1",
        "airi_scenario_state.pendingConditionNodeId": "condition-1",
        "airi_scenario_state.pendingSourceActionNodeId": "action-1",
        "airi_scenario_state.pendingStartedAt": "2026-05-01T00:00:00.000Z",
        "airi_scenario_state.pendingLastOutboundMessageId": "message-out-1",
      },
      expect.objectContaining({
        $set: {
          airi_scenario_state: expect.objectContaining({
            lockedScenarioId: null,
            pendingConditionNodeId: null,
            pendingLastOutboundMessageId: null,
          }),
        },
      })
    );
    expect(result.persisted).toBe(true);
  });

  it("reports a stale terminal completion when the pending start changed", async () => {
    mockConversationUpdateOne.mockResolvedValue({ matchedCount: 0 });

    const result = await completeLockedScenarioAndPersist({
      conversationId: "conversation-1",
      baseState: {
        lockedScenarioId: "scenario-1",
        lockedScenarioName: "Scenario 1",
        pendingConditionNodeId: "condition-1",
        pendingSourceActionNodeId: "action-1",
        pendingStartedAt: "2026-05-01T01:00:00.000Z",
        pendingLastOutboundMessageId: "message-out-1",
      },
      scenarioId: "scenario-1",
      scenarioName: "Scenario 1",
      lastActionNodeId: "action-1",
      lastMessageId: "message-out-1",
      expectedPendingState: {
        conditionNodeId: "condition-1",
        sourceActionNodeId: "action-1",
        pendingStartedAt: "2026-05-01T00:00:00.000Z",
        lastOutboundMessageId: "message-out-1",
      },
    });

    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        "airi_scenario_state.pendingStartedAt": "2026-05-01T00:00:00.000Z",
      }),
      expect.any(Object)
    );
    expect(result.persisted).toBe(false);
  });

  it("preserves the revision carrier without touching the top-level execution owner", async () => {
    mockConversationUpdateOne.mockResolvedValue({ acknowledged: true });

    await persistScenarioState({
      conversationId: "conversation-1",
      scenarioRuntime: {
        scenarioId: "scenario-video",
        scenarioName: "Scenario Video",
        selectedActionNodeId: "generate-video",
        actionType: "generative_ai",
        scenarioRevisionFingerprint: "revision-1",
        includeConversationTimeline: false,
        includeConversationSummaries: false,
        includeSnippets: false,
        includeKBArticles: false,
        includeIndexedUrls: false,
        includeQuickReplies: false,
        includeCustomerProfile: false,
        includePurchaseHistory: false,
        includeActiveSubscriptions: false,
        includeDynamicBusinessTags: false,
      },
      messageId: "message-1",
      baseState: {
        lockedScenarioId: null,
      },
    });

    const [, update] = mockConversationUpdateOne.mock.calls[0] as [
      unknown,
      { $set: Record<string, unknown> },
    ];
    expect(update).toEqual({
      $set: {
        airi_scenario_state: expect.objectContaining({
          scenarioRevisionFingerprint: "revision-1",
        }),
      },
    });
    expect(update.$set).not.toHaveProperty("airi_pending_generative_execution");
  });
});

describe("a form saved on a turn that routes nowhere", () => {
  const submission = (sourceActionNodeId: string, value: string) => ({
    sourceActionNodeId,
    flowId: "flow-1",
    inboundMessageId: `message-${value}`,
    submittedAt: "2026-09-30T10:00:00.000Z",
    fields: [
      { key: "size", label: "Size", fieldType: "Dropdown" as const, value },
    ],
  });
  const contact = submission("contact-form", "Aya");
  const pendingStartedAt = new Date("2026-09-30T09:00:00.000Z");
  const waitingState = {
    lockedScenarioId: "orders",
    lockedScenarioName: "Orders",
    currentActionNodeId: "order-form",
    currentPathNodeIds: ["trigger", "contact-form", "order-form"],
    pendingConditionNodeId: "order-form-no-reply",
    pendingSourceActionNodeId: "order-form",
    pendingStartedAt,
    pendingLastOutboundMessageId: "outbound-order",
    lastMessageId: "outbound-order",
    formAnswers: {
      scenarioId: "orders",
      submissions: [contact, submission("order-form", "Medium")],
    },
  };
  const save = (baseState: unknown, value = "Large") =>
    persistScenarioFormSubmission({
      conversationId: "conversation",
      baseState,
      submitted: {
        scenarioId: "orders",
        submission: submission("order-form", value),
      },
    });

  beforeEach(() => {
    jest.clearAllMocks();
    mockConversationUpdateOne.mockResolvedValue({ matchedCount: 1 });
  });

  it("writes only over the state the turn began with, keeping the wait", async () => {
    expect(await save(waitingState)).toBe(true);

    expect(mockConversationUpdateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = mockConversationUpdateOne.mock.calls[0];
    expect(filter).toEqual({
      _id: "conversation",
      "airi_scenario_state.lockedScenarioId": "orders",
      "airi_scenario_state.lockedScenarioName": "Orders",
      "airi_scenario_state.currentActionNodeId": "order-form",
      "airi_scenario_state.scenarioRevisionFingerprint": null,
      "airi_scenario_state.currentPathNodeIds": [
        "trigger",
        "contact-form",
        "order-form",
      ],
      "airi_scenario_state.currentBranchNodeIds": [],
      "airi_scenario_state.lastMessageId": "outbound-order",
      "airi_scenario_state.pendingConditionNodeId": "order-form-no-reply",
      "airi_scenario_state.pendingSourceActionNodeId": "order-form",
      "airi_scenario_state.pendingStartedAt": pendingStartedAt,
      "airi_scenario_state.pendingLastOutboundMessageId": "outbound-order",
      "airi_scenario_state.pendingLinkedConditionId": null,
    });
    expect(Object.keys(update.$set)).toEqual(["airi_scenario_state"]);
    // A newer submission from the same step replaces its earlier one.
    expect(update.$set.airi_scenario_state).toEqual(
      expect.objectContaining({
        lockedScenarioId: "orders",
        currentActionNodeId: "order-form",
        pendingConditionNodeId: "order-form-no-reply",
        pendingSourceActionNodeId: "order-form",
        pendingStartedAt,
        pendingLastOutboundMessageId: "outbound-order",
        lastMatchedAt: null,
        lastMessageId: "outbound-order",
        formAnswers: {
          scenarioId: "orders",
          submissions: [contact, submission("order-form", "Large")],
        },
      })
    );
  });

  it("writes the same answers again for a repeated submission", async () => {
    await save(waitingState);
    const saved =
      mockConversationUpdateOne.mock.calls[0][1].$set.airi_scenario_state;
    await save(saved);

    expect(
      mockConversationUpdateOne.mock.calls[1][1].$set.airi_scenario_state
    ).toEqual(saved);
  });

  it.each([
    ["no state", null],
    ["no scenario holds the conversation", { lockedScenarioId: null }],
    [
      "another scenario holds the conversation",
      { ...waitingState, lockedScenarioId: "other" },
    ],
    [
      "the scenario already ended",
      {
        lockedScenarioId: null,
        completedScenarios: [
          { scenarioId: "orders", completedAt: "2026-09-30T09:59:00.000Z" },
        ],
      },
    ],
  ])("writes nothing when %s", async (_, baseState) => {
    expect(await save(baseState)).toBe(false);
    expect(mockConversationUpdateOne).not.toHaveBeenCalled();
  });

  it("reports a write the conversation changed before", async () => {
    mockConversationUpdateOne.mockResolvedValue({ matchedCount: 0 });

    expect(await save(waitingState)).toBe(false);
    expect(mockConversationUpdateOne).toHaveBeenCalledTimes(1);
  });
});
