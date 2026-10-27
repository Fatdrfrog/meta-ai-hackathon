const mockConnectDb = jest.fn();
const mockConversationLean = jest.fn();
const mockConversationSelect = jest.fn();
const mockScenarioLean = jest.fn();
const mockMessageFindLean = jest.fn();
const mockMessageFindOneLean = jest.fn();
const mockResolveChatDocument = jest.fn();
const mockBuildChannelSpecificParams = jest.fn();
const mockCreateAiriConversationTurnContext = jest.fn();
const mockBuildAiriConversationTurnSignalFromContext = jest.fn();
const mockCompleteLockedScenarioAndPersist = jest.fn();
const mockPersistRecoveredPendingConditionState = jest.fn();
const mockRecoveryConversationLean = jest.fn();
const mockSignalWithStartAiriConversationExternalEvent = jest.fn();
const mockGetWorkspaceScenariosDefault = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDb(...args),
}));

jest.mock("@/lib/airi/workspace-bot-default", () => ({
  getWorkspaceScenariosDefault: (...args: unknown[]) =>
    mockGetWorkspaceScenariosDefault(...args),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => ({
      select: (selection: string) => {
        mockConversationSelect(selection);
        return { lean: () => mockConversationLean(...args) };
      },
    }),
    findOne: (...args: unknown[]) => ({
      select: () => ({
        lean: () => mockRecoveryConversationLean(...args),
      }),
    }),
  },
}));

jest.mock("@/lib/temporal/client", () => ({
  signalWithStartAiriConversationExternalEvent: (...args: unknown[]) =>
    mockSignalWithStartAiriConversationExternalEvent(...args),
}));

jest.mock("@/models/scenario", () => ({
  Scenario: {
    findOne: (...args: unknown[]) => ({
      select: () => ({
        lean: () => mockScenarioLean(...args),
      }),
    }),
  },
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    find: (...args: unknown[]) => ({
      sort: () => ({
        limit: () => ({
          select: () => ({
            lean: () => mockMessageFindLean(...args),
          }),
        }),
        select: () => ({
          lean: () => mockMessageFindLean(...args),
        }),
      }),
    }),
    findOne: (...args: unknown[]) => ({
      select: () => ({
        lean: () => mockMessageFindOneLean(...args),
      }),
      sort: () => ({
        select: () => ({
          lean: () => mockMessageFindOneLean(...args),
        }),
      }),
    }),
  },
}));

jest.mock("@/lib/airi/scenario/scenario-channel-utils", () => ({
  resolveChatDocument: (...args: unknown[]) => mockResolveChatDocument(...args),
  buildChannelSpecificParams: (...args: unknown[]) =>
    mockBuildChannelSpecificParams(...args),
}));

jest.mock("@/lib/temporal/airi-turn-context", () => ({
  createAiriConversationTurnContext: (...args: unknown[]) =>
    mockCreateAiriConversationTurnContext(...args),
  buildAiriConversationTurnSignalFromContext: (...args: unknown[]) =>
    mockBuildAiriConversationTurnSignalFromContext(...args),
}));

jest.mock("@/lib/airi/reply/runtime/auto-reply-scenario-state", () => ({
  completeLockedScenarioAndPersist: (...args: unknown[]) =>
    mockCompleteLockedScenarioAndPersist(...args),
  persistRecoveredPendingConditionState: (...args: unknown[]) =>
    mockPersistRecoveredPendingConditionState(...args),
}));

jest.mock("@/lib/airi/scenario/scenario-runtime", () => ({
  resolveActiveScenarioRuntime: jest.fn(),
}));

import type { AiriConversationTimerDescriptor } from "@icecore/temporal";
import {
  buildAiriConversationTimerTurn as buildRuntimeTimerTurn,
  handleAiriConversationExternalEvent as handleRuntimeExternalEvent,
  planAiriConversationTimer as planRuntimeTimer,
} from "@icecore/airi-runtime/temporal-scenario-timers";
import { airiScenarioTimerDependencies } from "@/lib/airi/scenario/timer-runtime-dependencies";
const buildAiriConversationTimerTurn = (
  timer: Parameters<typeof buildRuntimeTimerTurn>[0]
) => buildRuntimeTimerTurn(timer, airiScenarioTimerDependencies);
const handleAiriConversationExternalEvent = (
  event: Parameters<typeof handleRuntimeExternalEvent>[0]
) => handleRuntimeExternalEvent(event, airiScenarioTimerDependencies);
const planAiriConversationTimer = (
  params: Parameters<typeof planRuntimeTimer>[0]
) => planRuntimeTimer(params, airiScenarioTimerDependencies);
import {
  buildScenarioActionOutcomeHandleId,
  getScenarioActionOutcomeVirtualNodeId,
} from "@icecore/scenario-contracts";
import { resolveActiveScenarioRuntime } from "@/lib/airi/scenario/scenario-runtime";
import {
  recoverPostActionTimer,
  replanRemappedPostActionTimer,
} from "@/lib/airi/scenario/timer-recovery/recover";

const workspaceId = "workspace-1";
const conversationId = "conversation-1";
const scenarioId = "scenario-1";
const conditionNodeId = "condition-1";
const sourceActionNodeId = "action-1";
const pendingStartedAt = "2026-05-01T00:00:00.000Z";
const latestActivityAt = "2026-05-01T00:30:00.000Z";
const mockResolveActiveScenarioRuntime =
  resolveActiveScenarioRuntime as jest.Mock;

it("loads only the existing timer Conversation projection through the production host", async () => {
  mockConversationSelect.mockClear();
  mockConversationLean.mockResolvedValueOnce(null);
  await expect(
    airiScenarioTimerDependencies.loadConversation("conversation-1")
  ).resolves.toBeNull();
  expect(mockConversationSelect).toHaveBeenCalledWith(
    "workspaceId channel sourceId chat user business_connection_id preferred_language updatedAt external_thread airi_context_memory airi_scenario_state airi_handoff_active airi_handoff_source airi_handoff_reason airi_handoff_started_at airi_scenarios_enabled airi_bot_enabled airi_enabled"
  );
});

function createPendingConversation(params?: {
  scenarioId?: string;
  conditionNodeId?: string;
  sourceActionNodeId?: string;
  pendingLastOutboundMessageId?: string | null;
  handoffActive?: boolean;
}) {
  const handoffActive = params?.handoffActive === true;
  return {
    _id: conversationId,
    workspaceId,
    channel: "whatsapp",
    sourceId: "source-1",
    chat: "chat-1",
    airi_handoff_active: handoffActive,
    airi_handoff_source: handoffActive ? "manual" : null,
    airi_handoff_reason: handoffActive ? "manager_reply" : null,
    airi_handoff_started_at: handoffActive ? "2026-05-01T00:15:00.000Z" : null,
    airi_scenario_state: {
      lockedScenarioId: params?.scenarioId || scenarioId,
      lockedScenarioName: "Follow-up scenario",
      pendingConditionNodeId: params?.conditionNodeId || conditionNodeId,
      pendingSourceActionNodeId:
        params?.sourceActionNodeId || sourceActionNodeId,
      pendingStartedAt,
      pendingLastOutboundMessageId:
        params && "pendingLastOutboundMessageId" in params
          ? (params.pendingLastOutboundMessageId ?? null)
          : "message-out-1",
    },
  };
}

function createScenario() {
  return {
    _id: scenarioId,
    name: "Follow-up scenario",
    nodes: [
      {
        id: conditionNodeId,
        data: {
          kind: "logic",
          logicType: "post_action_condition",
          conditionBranches: [
            {
              id: "no_reply_timeout",
              type: "no_reply_timeout",
              timeoutMinutes: 60,
              missingTextPhrases: ["paid"],
            },
          ],
        },
      },
      {
        id: "follow-up-action",
        data: {
          kind: "action",
          actionType: "reply",
        },
      },
    ],
    edges: [
      {
        source: conditionNodeId,
        target: "follow-up-action",
        sourceHandle: "right-source-condition-no_reply_timeout",
      },
    ],
  };
}

function createActionOutcomeScenario(params: {
  scenarioId: string;
  includeTarget?: boolean;
  actionOutcomes?: unknown;
}) {
  const targetId = "follow-up-action";

  return {
    _id: params.scenarioId,
    name: "Action outcome follow-up scenario",
    nodes: [
      {
        id: sourceActionNodeId,
        data: {
          kind: "action",
          actionType: "reply",
          actionOutcomes: params.actionOutcomes ?? {
            version: 1,
            noReply: {
              enabled: true,
              timeoutMinutes: 60,
              cancelIfPhrases: ["paid"],
            },
          },
        },
      },
      ...(params.includeTarget === false
        ? []
        : [
            {
              id: targetId,
              data: {
                kind: "action",
                actionType: "reply",
              },
            },
          ]),
    ],
    edges: [
      {
        source: sourceActionNodeId,
        target: targetId,
        sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
      },
    ],
  };
}

function createRootNoReplyConversation() {
  return {
    ...createPendingConversation(),
    airi_scenario_state: null,
  };
}

function createPostActionTimer(params?: {
  scenarioId?: string;
  conditionNodeId?: string;
  sourceActionNodeId?: string;
  pendingLastOutboundMessageId?: string | null;
}): AiriConversationTimerDescriptor {
  return {
    kind: "post_action_no_reply_timeout",
    workspaceId,
    conversationId,
    channel: "whatsapp",
    sourceId: "source-1",
    scenarioId: params?.scenarioId || scenarioId,
    scenarioName: "Follow-up scenario",
    dueAt: "2026-05-01T01:30:00.000Z",
    triggerNodeId: null,
    conditionNodeId: params?.conditionNodeId || conditionNodeId,
    sourceActionNodeId: params?.sourceActionNodeId || sourceActionNodeId,
    linkedConditionId: null,
    waitStartedAt: pendingStartedAt,
    pendingLastOutboundMessageId:
      params && "pendingLastOutboundMessageId" in params
        ? (params.pendingLastOutboundMessageId ?? null)
        : "message-out-1",
    lastInboundMessageId: null,
    lastInboundAt: latestActivityAt,
    lastInboundText: null,
  };
}

function arrangeRecoverableTimerRepair() {
  mockRecoveryConversationLean.mockResolvedValue({
    _id: conversationId,
    workspaceId,
    channel: "whatsapp",
    sourceId: "source-1",
    airi_handoff_active: false,
    airi_scenario_state: {
      lockedScenarioId: scenarioId,
      lockedScenarioName: "Follow-up scenario",
      currentActionNodeId: sourceActionNodeId,
      currentPathNodeIds: [sourceActionNodeId, conditionNodeId],
      pendingConditionNodeId: null,
      pendingSourceActionNodeId: null,
      lastMatchedAt: "2026-05-01T00:00:00.000Z",
    },
  });
  mockScenarioLean.mockResolvedValue({
    _id: scenarioId,
    name: "Follow-up scenario",
    nodes: [
      {
        id: sourceActionNodeId,
        data: { kind: "action", actionType: "reply" },
      },
      ...createScenario().nodes,
    ],
    edges: [
      { source: sourceActionNodeId, target: conditionNodeId },
      ...createScenario().edges,
    ],
  });
  mockMessageFindOneLean.mockImplementation(
    (query?: Record<string, unknown>) =>
      query?.direction === "outbound"
        ? {
            _id: "message-out-1",
            date: new Date("2026-05-01T00:00:00.000Z"),
            origin: {
              scenarioId,
              nodeId: sourceActionNodeId,
            },
            delivery: { status: "sent" },
          }
        : { date: new Date("2026-05-01T00:00:00.000Z") }
  );
}

describe("temporal scenario timers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDb.mockResolvedValue(undefined);
    mockConversationLean.mockResolvedValue(createPendingConversation());
    mockRecoveryConversationLean.mockResolvedValue(createPendingConversation());
    mockScenarioLean.mockResolvedValue(createScenario());
    mockMessageFindLean.mockResolvedValue([]);
    mockMessageFindOneLean.mockImplementation(
      (query?: Record<string, unknown>) =>
        query && "_id" in query
          ? { delivery: { status: "sent" } }
          : { date: new Date(latestActivityAt) }
    );
    mockResolveActiveScenarioRuntime.mockResolvedValue({ runtime: null });
    mockResolveChatDocument.mockResolvedValue({
      chatDocument: { _id: "chat-1", sourceId: "source-1", type: "private" },
      chatId: "chat-1",
      chatType: "private",
    });
    mockBuildChannelSpecificParams.mockResolvedValue({
      ok: true,
      whatsAppInfo: {
        phoneNumberId: "phone-1",
        accessToken: "wa-token",
        contactData: { waId: "77015551212" },
      },
    });
    mockCreateAiriConversationTurnContext.mockResolvedValue({
      turnContextId: "turn-1",
    });
    mockCompleteLockedScenarioAndPersist.mockResolvedValue({ persisted: true });
    mockPersistRecoveredPendingConditionState.mockResolvedValue({
      conditionNodeId,
      sourceActionNodeId,
    });
    mockSignalWithStartAiriConversationExternalEvent.mockResolvedValue({
      accepted: true,
    });
    mockGetWorkspaceScenariosDefault.mockResolvedValue(true);
    mockBuildAiriConversationTurnSignalFromContext.mockImplementation(
      ({ autoReplyParams, turnContextId }) => ({
        workspaceId: autoReplyParams.workspaceId,
        conversationId,
        messageId: autoReplyParams.newMessage._id,
        channel: autoReplyParams.type,
        turnContextId,
        triggerEventKind: autoReplyParams.triggerEventKind,
        scenarioOverrideId: autoReplyParams.scenarioOverrideId,
      })
    );
  });

  it("resolves a conversation's scenario toggle the way the reply runtime does", async () => {
    mockGetWorkspaceScenariosDefault.mockResolvedValue(false);
    const resolve = airiScenarioTimerDependencies.resolveScenariosEnabled;

    await expect(
      resolve({ workspaceId, airi_scenarios_enabled: true })
    ).resolves.toBe(true);
    await expect(
      resolve({
        workspaceId,
        airi_scenarios_enabled: false,
        airi_bot_enabled: true,
      })
    ).resolves.toBe(false);
    // Legacy toggles still decide before the workspace default.
    await expect(
      resolve({ workspaceId, airi_bot_enabled: true })
    ).resolves.toBe(true);
    await expect(resolve({ workspaceId, airi_enabled: false })).resolves.toBe(
      false
    );
    await expect(resolve({ workspaceId })).resolves.toBe(false);
    expect(mockGetWorkspaceScenariosDefault).toHaveBeenCalledWith(workspaceId);
  });

  it("plans no timer for a waiting conversation whose scenarios were turned off", async () => {
    mockConversationLean.mockResolvedValue({
      ...createPendingConversation(),
      airi_scenarios_enabled: false,
    });

    const result = await planAiriConversationTimer({
      turn: {
        workspaceId,
        conversationId,
        messageId: "customer-message-1",
        channel: "whatsapp",
        sourceId: "source-1",
        messageDate: latestActivityAt,
        enqueuedAt: latestActivityAt,
      },
    });

    expect(result).toEqual(
      expect.objectContaining({ timer: null, reason: "scenarios_disabled" })
    );
  });

  it("skips invalid timer planner turns before loading database state", async () => {
    const result = await planAiriConversationTimer({
      turn: undefined,
    });

    expect(result).toEqual({
      timer: null,
      projection: null,
      reason: "invalid_turn",
    });
    expect(mockConnectDb).not.toHaveBeenCalled();
    expect(mockConversationLean).not.toHaveBeenCalled();
  });

  it("drops persisted retired root timers before loading database state", async () => {
    const result = await buildAiriConversationTimerTurn({
      ...createPostActionTimer(),
      kind: "no_human_reply_timeout",
    } as unknown as AiriConversationTimerDescriptor);

    expect(result).toEqual({
      turn: null,
      projection: null,
      reason: "retired_timer_kind",
    });
    expect(mockConnectDb).not.toHaveBeenCalled();
    expect(mockConversationLean).not.toHaveBeenCalled();
  });

  it("does not build a follow-up when a configured stop phrase appears after the wait starts", async () => {
    mockMessageFindLean.mockResolvedValue([
      { text: "Customer already paid yesterday" },
    ]);

    const result = await buildAiriConversationTimerTurn(
      createPostActionTimer()
    );

    expect(result.reason).toBe("missing_text_phrase_detected");
    expect(result.turn).toBeNull();
    expect(mockCompleteLockedScenarioAndPersist).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId,
        scenarioId,
        lastActionNodeId: sourceActionNodeId,
        lastMessageId: "message-out-1",
      })
    );
    expect(mockBuildChannelSpecificParams).not.toHaveBeenCalled();
  });

  it("does not complete a newer wait when a stop phrase invalidates the old timer", async () => {
    mockMessageFindLean.mockResolvedValue([
      { text: "Customer already paid yesterday" },
    ]);
    mockCompleteLockedScenarioAndPersist.mockResolvedValue({
      persisted: false,
    });
    const result = await buildAiriConversationTimerTurn(
      createPostActionTimer()
    );
    expect(result.reason).toBe("stale_pending_condition_state");
    expect(result.turn).toBeNull();
    expect(mockCompleteLockedScenarioAndPersist).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPendingState: {
          conditionNodeId,
          sourceActionNodeId,
          pendingStartedAt,
          lastOutboundMessageId: "message-out-1",
        },
      })
    );
  });

  it("keeps the scenario pending without following up after the outbound fails", async () => {
    mockMessageFindOneLean.mockImplementation(
      (query?: Record<string, unknown>) =>
        query && "_id" in query
          ? {
              delivery: {
                status: "failed",
                errorCode: "131042",
                failedAt: new Date("2026-05-01T00:00:10.000Z"),
              },
            }
          : { date: new Date(latestActivityAt) }
    );

    const result = await buildAiriConversationTimerTurn(
      createPostActionTimer()
    );

    expect(result).toEqual(
      expect.objectContaining({
        turn: null,
        reason: "pending_outbound_unconfirmed",
      })
    );
    expect(result).not.toHaveProperty("timer");
    expect(mockMessageFindOneLean).toHaveBeenCalledWith({
      _id: "message-out-1",
      workspaceId,
      conversation: conversationId,
      direction: "outbound",
      "origin.scenarioId": scenarioId,
      "origin.nodeId": sourceActionNodeId,
    });
    expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
    expect(mockBuildChannelSpecificParams).not.toHaveBeenCalled();
  });

  it("fails closed when a post-action timer has no pending outbound anchor", async () => {
    mockConversationLean.mockResolvedValue(
      createPendingConversation({ pendingLastOutboundMessageId: null })
    );

    const result = await buildAiriConversationTimerTurn(
      createPostActionTimer({ pendingLastOutboundMessageId: null })
    );

    expect(result).toEqual(
      expect.objectContaining({
        turn: null,
        reason: "pending_outbound_unconfirmed",
      })
    );
    expect(result).not.toHaveProperty("timer");
    expect(mockMessageFindOneLean).not.toHaveBeenCalled();
    expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
    expect(mockBuildChannelSpecificParams).not.toHaveBeenCalled();
  });

  it("fails closed when the exact pending outbound cannot be found", async () => {
    mockMessageFindOneLean.mockImplementation(
      (query?: Record<string, unknown>) =>
        query && "_id" in query ? null : { date: new Date(latestActivityAt) }
    );

    const result = await buildAiriConversationTimerTurn(
      createPostActionTimer()
    );

    expect(result).toEqual(
      expect.objectContaining({
        turn: null,
        reason: "pending_outbound_unconfirmed",
      })
    );
    expect(result).not.toHaveProperty("timer");
    expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
    expect(mockBuildChannelSpecificParams).not.toHaveBeenCalled();
  });

  it("plans post-action scenario follow-up timers even when manual handoff is active", async () => {
    mockConversationLean.mockResolvedValue(
      createPendingConversation({ handoffActive: true })
    );

    const result = await planAiriConversationTimer({
      turn: {
        workspaceId,
        conversationId,
        messageId: "manager-message-1",
        channel: "whatsapp",
        sourceId: "source-1",
        triggerEventKind: "human_outbound",
        messageDate: latestActivityAt,
        enqueuedAt: latestActivityAt,
      },
    });

    expect(result.reason).toBe("pending_post_action_condition");
    expect(result.projection?.handoffActive).toBe(true);
    expect(result.timer).toEqual(
      expect.objectContaining({
        kind: "post_action_no_reply_timeout",
        dueAt: "2026-05-01T01:30:00.000Z",
        conditionNodeId,
        sourceActionNodeId,
      })
    );
  });

  it("plans a post-action timer from a virtual action outcome condition", async () => {
    const actionOutcomeScenarioId = "action-outcome-scenario";
    const virtualConditionNodeId =
      getScenarioActionOutcomeVirtualNodeId(sourceActionNodeId);
    mockConversationLean.mockResolvedValue(
      createPendingConversation({
        scenarioId: actionOutcomeScenarioId,
        conditionNodeId: virtualConditionNodeId,
      })
    );
    mockScenarioLean.mockResolvedValue(
      createActionOutcomeScenario({ scenarioId: actionOutcomeScenarioId })
    );

    const result = await planAiriConversationTimer({
      turn: {
        workspaceId,
        conversationId,
        messageId: "manager-message-1",
        channel: "whatsapp",
        sourceId: "source-1",
        triggerEventKind: "human_outbound",
        messageDate: latestActivityAt,
        enqueuedAt: latestActivityAt,
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        reason: "pending_post_action_condition",
        timer: expect.objectContaining({
          kind: "post_action_no_reply_timeout",
          conditionNodeId: virtualConditionNodeId,
          sourceActionNodeId,
          waitStartedAt: pendingStartedAt,
          pendingLastOutboundMessageId: "message-out-1",
        }),
      })
    );
  });

  it("replans a remapped virtual wait during handoff with its original anchor and deterministic identity", async () => {
    const actionOutcomeScenarioId = "action-outcome-scenario";
    const virtualConditionNodeId =
      getScenarioActionOutcomeVirtualNodeId(sourceActionNodeId);
    const remappedConversation = createPendingConversation({
      scenarioId: actionOutcomeScenarioId,
      conditionNodeId: virtualConditionNodeId,
    });
    mockRecoveryConversationLean.mockResolvedValue(remappedConversation);
    mockConversationLean.mockResolvedValue(remappedConversation);
    mockScenarioLean.mockResolvedValue(
      createActionOutcomeScenario({ scenarioId: actionOutcomeScenarioId })
    );
    const now = new Date("2026-05-01T02:00:00.000Z");

    const first = await replanRemappedPostActionTimer({
      workspaceId,
      conversationId,
      expectedScenarioId: actionOutcomeScenarioId,
      expectedConditionNodeId: virtualConditionNodeId,
      expectedSourceActionNodeId: sourceActionNodeId,
      apply: true,
      now,
    });
    const second = await replanRemappedPostActionTimer({
      workspaceId,
      conversationId,
      expectedScenarioId: actionOutcomeScenarioId,
      expectedConditionNodeId: virtualConditionNodeId,
      expectedSourceActionNodeId: sourceActionNodeId,
      apply: true,
      now,
    });

    expect(first).toEqual(
      expect.objectContaining({
        conversationId,
        status: "replanned",
        conditionNodeId: virtualConditionNodeId,
        sourceActionNodeId,
      })
    );
    expect(second).toEqual(first);
    expect(
      mockSignalWithStartAiriConversationExternalEvent
    ).toHaveBeenCalledTimes(2);
    expect(mockConversationLean).not.toHaveBeenCalled();
    expect(mockScenarioLean).not.toHaveBeenCalled();
    expect(mockSignalWithStartAiriConversationExternalEvent.mock.calls).toEqual(
      [
        [
          expect.objectContaining({
            kind: "timer_replan",
            messageId:
              "timer-replan:action-outcome-scenario:action-1:message-out-1",
          }),
        ],
        [
          expect.objectContaining({
            kind: "timer_replan",
            messageId:
              "timer-replan:action-outcome-scenario:action-1:message-out-1",
          }),
        ],
      ]
    );
  });

  it("reuses a durable ingress event identity and timestamps across timer-replan retries", async () => {
    const actionOutcomeScenarioId = "action-outcome-scenario";
    const virtualConditionNodeId =
      getScenarioActionOutcomeVirtualNodeId(sourceActionNodeId);
    const remappedConversation = createPendingConversation({
      scenarioId: actionOutcomeScenarioId,
      conditionNodeId: virtualConditionNodeId,
    });
    mockRecoveryConversationLean.mockResolvedValue(remappedConversation);
    mockConversationLean.mockResolvedValue(remappedConversation);
    mockScenarioLean.mockResolvedValue(
      createActionOutcomeScenario({ scenarioId: actionOutcomeScenarioId })
    );

    await replanRemappedPostActionTimer({
      workspaceId,
      conversationId,
      expectedScenarioId: actionOutcomeScenarioId,
      expectedConditionNodeId: virtualConditionNodeId,
      expectedSourceActionNodeId: sourceActionNodeId,
      apply: true,
      now: new Date("2026-05-01T02:05:00.000Z"),
      event: {
        messageId:
          "timer-replan:action-outcome-scenario:action-1:message-out-1",
        messageDate: "2026-05-01T02:00:00.000Z",
        enqueuedAt: "2026-05-01T02:00:01.000Z",
      },
    });

    expect(
      mockSignalWithStartAiriConversationExternalEvent
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId:
          "timer-replan:action-outcome-scenario:action-1:message-out-1",
        messageDate: "2026-05-01T02:00:00.000Z",
        enqueuedAt: "2026-05-01T02:00:01.000Z",
      })
    );
  });

  it("routes timer repair through the pending-write fence and reports a concurrent remap", async () => {
    arrangeRecoverableTimerRepair();
    mockPersistRecoveredPendingConditionState.mockResolvedValue({
      conditionNodeId: "__system:action-outcomes:action-1",
      sourceActionNodeId,
    });

    const result = await recoverPostActionTimer({
      workspaceId,
      conversationId,
      apply: true,
      now: new Date("2026-05-01T00:30:00.000Z"),
    });

    expect(mockPersistRecoveredPendingConditionState).toHaveBeenCalledWith({
      workspaceId,
      conversationId,
      scenarioId,
      sourceActionNodeId,
      conditionNodeId,
      pendingStartedAt: new Date("2026-05-01T00:00:00.000Z"),
      pendingLastOutboundMessageId: "message-out-1",
      pendingLinkedConditionId: null,
      pendingLegacyRouting: null,
      expectedCurrentActionNodeId: sourceActionNodeId,
    });
    expect(result).toEqual(
      expect.objectContaining({
        status: "recovered",
        conditionNodeId: "__system:action-outcomes:action-1",
        sourceActionNodeId,
      })
    );
  });

  it("returns a per-conversation conflict when timer repair loses its CAS", async () => {
    arrangeRecoverableTimerRepair();
    mockPersistRecoveredPendingConditionState.mockRejectedValue({
      scenarioPendingWriteCoordinationError: true,
      code: "conversation_state_changed",
    });

    const result = await recoverPostActionTimer({
      workspaceId,
      conversationId,
      apply: true,
      now: new Date("2026-05-01T00:30:00.000Z"),
    });

    expect(result).toEqual({
      conversationId,
      status: "conflict",
      reason: "conversation_state_changed",
    });
    expect(
      mockSignalWithStartAiriConversationExternalEvent
    ).not.toHaveBeenCalled();
  });

  it("propagates timer-repair transaction failures for activity retry", async () => {
    arrangeRecoverableTimerRepair();
    const failure = {
      scenarioPendingWriteCoordinationError: true,
      code: "scenario_write_conflict",
    };
    mockPersistRecoveredPendingConditionState.mockRejectedValue(failure);

    await expect(
      recoverPostActionTimer({
        workspaceId,
        conversationId,
        apply: true,
        now: new Date("2026-05-01T00:30:00.000Z"),
      })
    ).rejects.toBe(failure);
    expect(
      mockSignalWithStartAiriConversationExternalEvent
    ).not.toHaveBeenCalled();
  });

  it("fails a strict remapped replan closed when the pending identity changed", async () => {
    const result = await replanRemappedPostActionTimer({
      workspaceId,
      conversationId,
      expectedScenarioId: scenarioId,
      expectedConditionNodeId: "__system:action-outcomes:action-1",
      expectedSourceActionNodeId: sourceActionNodeId,
      apply: true,
      now: new Date("2026-05-01T00:45:00.000Z"),
    });

    expect(result).toEqual({
      conversationId,
      status: "conflict",
      reason: "conversation_state_changed",
    });
    expect(
      mockSignalWithStartAiriConversationExternalEvent
    ).not.toHaveBeenCalled();
  });

  it("does not plan a virtual action outcome timer when the branch target is missing", async () => {
    const actionOutcomeScenarioId = "action-outcome-missing-target";
    mockConversationLean.mockResolvedValue(
      createPendingConversation({
        scenarioId: actionOutcomeScenarioId,
        conditionNodeId:
          getScenarioActionOutcomeVirtualNodeId(sourceActionNodeId),
      })
    );
    mockScenarioLean.mockResolvedValue(
      createActionOutcomeScenario({
        scenarioId: actionOutcomeScenarioId,
        includeTarget: false,
      })
    );

    const result = await planAiriConversationTimer({
      turn: {
        workspaceId,
        conversationId,
        messageId: "manager-message-1",
        channel: "whatsapp",
        sourceId: "source-1",
        triggerEventKind: "human_outbound",
        messageDate: latestActivityAt,
        enqueuedAt: latestActivityAt,
      },
    });

    expect(result.timer).toBeNull();
  });

  it("does not plan a virtual action outcome timer after its action configuration changes", async () => {
    const actionOutcomeScenarioId = "action-outcome-removed";
    mockConversationLean.mockResolvedValue(
      createPendingConversation({
        scenarioId: actionOutcomeScenarioId,
        conditionNodeId:
          getScenarioActionOutcomeVirtualNodeId(sourceActionNodeId),
      })
    );
    mockScenarioLean.mockResolvedValue(
      createActionOutcomeScenario({
        scenarioId: actionOutcomeScenarioId,
        actionOutcomes: { version: 1 },
      })
    );

    const result = await planAiriConversationTimer({
      turn: {
        workspaceId,
        conversationId,
        messageId: "manager-message-1",
        channel: "whatsapp",
        sourceId: "source-1",
        triggerEventKind: "human_outbound",
        messageDate: latestActivityAt,
        enqueuedAt: latestActivityAt,
      },
    });

    expect(result.timer).toBeNull();
  });

  it("builds post-action scenario follow-up turns even when manual handoff is active", async () => {
    mockConversationLean.mockResolvedValue(
      createPendingConversation({ handoffActive: true })
    );

    const result = await buildAiriConversationTimerTurn(
      createPostActionTimer()
    );

    expect(result.reason).toBe("timer_turn_ready");
    expect(result.projection?.handoffActive).toBe(true);
    expect(result.turn).toEqual(
      expect.objectContaining({
        messageId: expect.stringContaining(
          "scenario-timeout:post_action_no_reply_timeout"
        ),
        scenarioOverrideId: scenarioId,
        triggerEventKind: "no_human_reply_timeout",
      })
    );
  });

  it("builds post-action scenario follow-up turns when handoff is not active", async () => {
    const result = await buildAiriConversationTimerTurn(
      createPostActionTimer()
    );

    expect(result.reason).toBe("timer_turn_ready");
    expect(result.projection?.handoffActive).toBe(false);
    expect(result.turn).toEqual(
      expect.objectContaining({
        messageId: expect.stringContaining(
          "scenario-timeout:post_action_no_reply_timeout"
        ),
        scenarioOverrideId: scenarioId,
        triggerEventKind: "no_human_reply_timeout",
      })
    );
  });

  it("prepares a virtual action-outcome timer for target dispatch at fire time", async () => {
    const actionOutcomeScenarioId = "action-outcome-fire";
    const virtualConditionNodeId =
      getScenarioActionOutcomeVirtualNodeId(sourceActionNodeId);
    mockConversationLean.mockResolvedValue(
      createPendingConversation({
        scenarioId: actionOutcomeScenarioId,
        conditionNodeId: virtualConditionNodeId,
      })
    );
    mockScenarioLean.mockResolvedValue(
      createActionOutcomeScenario({ scenarioId: actionOutcomeScenarioId })
    );

    const result = await buildAiriConversationTimerTurn(
      createPostActionTimer({
        scenarioId: actionOutcomeScenarioId,
        conditionNodeId: virtualConditionNodeId,
      })
    );

    expect(result.reason).toBe("timer_turn_ready");
    expect(result.turn).toEqual(
      expect.objectContaining({
        scenarioOverrideId: actionOutcomeScenarioId,
        triggerEventKind: "no_human_reply_timeout",
      })
    );
  });

  it.each([
    [
      "a legacy wait whose no-reply target is removed",
      scenarioId,
      conditionNodeId,
      {
        ...createScenario(),
        nodes: createScenario().nodes.slice(0, 1),
        updatedAt: "2026-05-02T00:00:00.000Z",
      },
    ],
    [
      "a virtual wait whose only outcome target is removed",
      "action-outcome-dangling-target",
      getScenarioActionOutcomeVirtualNodeId(sourceActionNodeId),
      createActionOutcomeScenario({
        scenarioId: "action-outcome-dangling-target",
        includeTarget: false,
      }),
    ],
  ])(
    "releases %s because no outcome is left",
    async (_, waitScenarioId, waitConditionNodeId, editedScenario) => {
      mockConversationLean.mockResolvedValue(
        createPendingConversation({
          scenarioId: waitScenarioId,
          conditionNodeId: waitConditionNodeId,
        })
      );
      mockScenarioLean.mockResolvedValue(editedScenario);

      const result = await buildAiriConversationTimerTurn(
        createPostActionTimer({
          scenarioId: waitScenarioId,
          conditionNodeId: waitConditionNodeId,
        })
      );

      expect(result).toEqual(
        expect.objectContaining({
          reason: "post_action_wait_without_outcomes",
          turn: null,
        })
      );
      expect(result).not.toHaveProperty("timer");
      expect(mockCompleteLockedScenarioAndPersist).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId,
          scenarioId: waitScenarioId,
          lastActionNodeId: sourceActionNodeId,
          expectedPendingState: {
            conditionNodeId: waitConditionNodeId,
            sourceActionNodeId,
            pendingStartedAt,
            lastOutboundMessageId: "message-out-1",
          },
        })
      );
      expect(mockBuildChannelSpecificParams).not.toHaveBeenCalled();
      expect(mockCreateAiriConversationTurnContext).not.toHaveBeenCalled();
    }
  );

  it("does not prepare a virtual timer after its action outcome is removed", async () => {
    const actionOutcomeScenarioId = "action-outcome-fire-removed";
    const virtualConditionNodeId =
      getScenarioActionOutcomeVirtualNodeId(sourceActionNodeId);
    mockConversationLean.mockResolvedValue(
      createPendingConversation({
        scenarioId: actionOutcomeScenarioId,
        conditionNodeId: virtualConditionNodeId,
      })
    );
    mockScenarioLean.mockResolvedValue(
      createActionOutcomeScenario({
        scenarioId: actionOutcomeScenarioId,
        actionOutcomes: { version: 1 },
      })
    );

    const result = await buildAiriConversationTimerTurn(
      createPostActionTimer({
        scenarioId: actionOutcomeScenarioId,
        conditionNodeId: virtualConditionNodeId,
      })
    );

    expect(result).toEqual(
      expect.objectContaining({
        reason: "post_action_timer_invalidated",
        turn: null,
      })
    );
    // The leftover outcome edge is a blocking diagnostic, not a removed wait.
    expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
    expect(mockBuildChannelSpecificParams).not.toHaveBeenCalled();
  });

  it("does not prepare a timer when the compiled graph has blocking diagnostics", async () => {
    mockScenarioLean.mockResolvedValue({
      ...createScenario(),
      nodes: [
        ...createScenario().nodes,
        {
          id: "invalid-action-outcome",
          data: {
            kind: "action",
            actionType: "reply",
            actionOutcomes: { version: 99 },
          },
        },
      ],
      updatedAt: "2026-05-03T00:00:00.000Z",
    });

    const result = await buildAiriConversationTimerTurn(
      createPostActionTimer()
    );

    expect(result).toEqual(
      expect.objectContaining({
        reason: "post_action_timer_invalidated",
        turn: null,
      })
    );
    expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
    expect(mockBuildChannelSpecificParams).not.toHaveBeenCalled();
    expect(mockCreateAiriConversationTurnContext).not.toHaveBeenCalled();
  });

  it("keeps a removed wait untouched while the graph has blocking diagnostics", async () => {
    mockScenarioLean.mockResolvedValue({
      ...createScenario(),
      nodes: [
        {
          id: "invalid-action-outcome",
          data: {
            kind: "action",
            actionType: "reply",
            actionOutcomes: { version: 99 },
          },
        },
      ],
      edges: [],
      updatedAt: "2026-05-05T00:00:00.000Z",
    });

    const result = await buildAiriConversationTimerTurn(
      createPostActionTimer()
    );

    expect(result).toEqual(
      expect.objectContaining({
        reason: "post_action_timer_invalidated",
        turn: null,
      })
    );
    expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
    expect(mockBuildChannelSpecificParams).not.toHaveBeenCalled();
  });

  describe("timers armed before a builder edit", () => {
    const humanOutboundTurn = {
      workspaceId,
      conversationId,
      messageId: "manager-message-1",
      channel: "whatsapp",
      sourceId: "source-1",
      triggerEventKind: "human_outbound",
      messageDate: latestActivityAt,
      enqueuedAt: latestActivityAt,
    };
    const virtualConditionNodeId =
      getScenarioActionOutcomeVirtualNodeId(sourceActionNodeId);
    const replyTarget = {
      id: "reply-target",
      data: { kind: "action", actionType: "reply" },
    };

    async function armTimer(params: {
      waitScenarioId: string;
      waitConditionNodeId: string;
      scenario: Record<string, unknown>;
    }) {
      mockConversationLean.mockResolvedValue(
        createPendingConversation({
          scenarioId: params.waitScenarioId,
          conditionNodeId: params.waitConditionNodeId,
        })
      );
      mockScenarioLean.mockResolvedValue(params.scenario);
      const planned = await planAiriConversationTimer({
        turn: humanOutboundTurn,
      });
      expect(planned.timer).toEqual(
        expect.objectContaining({
          scenarioId: params.waitScenarioId,
          conditionNodeId: params.waitConditionNodeId,
        })
      );
      return planned.timer as AiriConversationTimerDescriptor;
    }

    it.each([
      [
        "its action's outcome edges were removed",
        "wait-removed-outcome-edges",
        virtualConditionNodeId,
        (id: string) => ({
          ...createActionOutcomeScenario({ scenarioId: id }),
          edges: [],
        }),
      ],
      [
        "its action was deleted",
        "wait-removed-action",
        virtualConditionNodeId,
        (id: string) => ({
          ...createActionOutcomeScenario({ scenarioId: id }),
          nodes: createActionOutcomeScenario({ scenarioId: id }).nodes.slice(1),
          edges: [],
        }),
      ],
      [
        "its legacy condition node was deleted",
        "wait-removed-legacy-node",
        conditionNodeId,
        (id: string) => ({
          ...createScenario(),
          _id: id,
          nodes: createScenario().nodes.slice(1),
          edges: [],
        }),
      ],
    ])(
      "releases the conversation when the timer fires after %s",
      async (_, waitScenarioId, waitConditionNodeId, editScenario) => {
        const original =
          waitConditionNodeId === conditionNodeId
            ? { ...createScenario(), _id: waitScenarioId }
            : createActionOutcomeScenario({ scenarioId: waitScenarioId });
        const timer = await armTimer({
          waitScenarioId,
          waitConditionNodeId,
          scenario: original,
        });
        mockScenarioLean.mockResolvedValue({
          ...editScenario(waitScenarioId),
          updatedAt: "2026-05-06T00:00:00.000Z",
        });

        const result = await buildAiriConversationTimerTurn(timer);

        expect(result).toEqual(
          expect.objectContaining({
            reason: "post_action_wait_removed",
            turn: null,
          })
        );
        expect(result).not.toHaveProperty("timer");
        expect(mockCompleteLockedScenarioAndPersist).toHaveBeenCalledTimes(1);
        expect(mockCompleteLockedScenarioAndPersist).toHaveBeenCalledWith(
          expect.objectContaining({
            conversationId,
            scenarioId: waitScenarioId,
            lastActionNodeId: sourceActionNodeId,
            lastMessageId: "message-out-1",
            expectedPendingState: {
              conditionNodeId: waitConditionNodeId,
              sourceActionNodeId,
              pendingStartedAt,
              lastOutboundMessageId: "message-out-1",
            },
          })
        );
        expect(mockBuildChannelSpecificParams).not.toHaveBeenCalled();
        expect(mockCreateAiriConversationTurnContext).not.toHaveBeenCalled();
      }
    );

    it("does not release a removed wait that a newer wait replaced", async () => {
      const waitScenarioId = "wait-removed-then-replaced";
      const timer = await armTimer({
        waitScenarioId,
        waitConditionNodeId: virtualConditionNodeId,
        scenario: createActionOutcomeScenario({ scenarioId: waitScenarioId }),
      });
      mockScenarioLean.mockResolvedValue({
        ...createActionOutcomeScenario({ scenarioId: waitScenarioId }),
        edges: [],
        updatedAt: "2026-05-06T00:00:00.000Z",
      });
      mockCompleteLockedScenarioAndPersist.mockResolvedValue({
        persisted: false,
      });

      const result = await buildAiriConversationTimerTurn(timer);

      expect(result).toEqual(
        expect.objectContaining({
          reason: "stale_pending_condition_state",
          turn: null,
        })
      );
      expect(mockCompleteLockedScenarioAndPersist).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedPendingState: expect.objectContaining({
            conditionNodeId: virtualConditionNodeId,
          }),
        })
      );
    });

    it.each([
      [
        "an action",
        "no-reply-removed-action",
        virtualConditionNodeId,
        (id: string) => {
          const scenario = createActionOutcomeScenario({
            scenarioId: id,
            actionOutcomes: {
              version: 1,
              anyReply: { enabled: true },
              noReply: {
                enabled: true,
                timeoutMinutes: 60,
                cancelIfPhrases: ["paid"],
              },
            },
          });
          return { ...scenario, nodes: [...scenario.nodes, replyTarget] };
        },
        (scenario: { nodes: unknown[] }) => ({
          ...scenario,
          edges: [
            {
              source: sourceActionNodeId,
              target: replyTarget.id,
              sourceHandle: buildScenarioActionOutcomeHandleId("any_reply"),
            },
          ],
        }),
      ],
      [
        "a legacy condition",
        "no-reply-removed-legacy",
        conditionNodeId,
        (id: string) => ({
          ...createScenario(),
          _id: id,
          nodes: [...createScenario().nodes, replyTarget],
        }),
        (scenario: { nodes: unknown[] }) => ({
          ...scenario,
          edges: [
            {
              source: conditionNodeId,
              target: replyTarget.id,
              sourceHandle: "right-source-condition-user_replied",
            },
          ],
        }),
      ],
    ])(
      "keeps waiting without a timer when only the no-reply branch of %s is removed",
      async (
        _,
        waitScenarioId,
        waitConditionNodeId,
        buildScenario,
        removeNoReplyBranch
      ) => {
        const original = buildScenario(waitScenarioId);
        const timer = await armTimer({
          waitScenarioId,
          waitConditionNodeId,
          scenario: {
            ...original,
            edges: [...removeNoReplyBranch(original).edges, ...original.edges],
          },
        });
        mockScenarioLean.mockResolvedValue({
          ...removeNoReplyBranch(original),
          updatedAt: "2026-05-06T00:00:00.000Z",
        });

        const result = await buildAiriConversationTimerTurn(timer);
        const replanned = await planAiriConversationTimer({
          turn: humanOutboundTurn,
        });

        expect(result).toEqual(
          expect.objectContaining({
            reason: "post_action_timer_invalidated",
            turn: null,
          })
        );
        expect(result).not.toHaveProperty("timer");
        expect(replanned.timer).toBeNull();
        expect(mockCompleteLockedScenarioAndPersist).not.toHaveBeenCalled();
        expect(mockBuildChannelSpecificParams).not.toHaveBeenCalled();
      }
    );
  });

  it("does not resolve or plan retired root no-human-reply trigger timers", async () => {
    mockConversationLean.mockResolvedValue(createRootNoReplyConversation());

    const result = await planAiriConversationTimer({
      turn: {
        workspaceId,
        conversationId,
        messageId: "customer-message-1",
        channel: "whatsapp",
        sourceId: "source-1",
        textPreview: "hello",
        messageDate: "2026-05-01T00:00:00.000Z",
        enqueuedAt: "2026-05-01T00:00:00.000Z",
      },
    });

    expect(result.reason).toBe("no_timer");
    expect(result.projection?.handoffActive).toBe(false);
    expect(result.timer).toBeNull();
    expect(mockResolveActiveScenarioRuntime).not.toHaveBeenCalled();
    expect(mockScenarioLean).not.toHaveBeenCalled();
  });

  it("refreshes post-action follow-up timers when a human outbound message is saved", async () => {
    mockMessageFindOneLean.mockResolvedValue({
      date: new Date("2026-05-01T00:45:00.000Z"),
    });

    const result = await handleAiriConversationExternalEvent({
      kind: "human_outbound",
      workspaceId,
      conversationId,
      messageId: "manager-message-2",
      channel: "whatsapp",
      messageDate: "2026-05-01T00:45:00.000Z",
      enqueuedAt: "2026-05-01T00:45:00.000Z",
    });

    expect(result.handled).toBe(true);
    expect(result.clearTimer).toBe(false);
    expect(result.timer).toEqual(
      expect.objectContaining({
        kind: "post_action_no_reply_timeout",
        dueAt: "2026-05-01T01:45:00.000Z",
        conditionNodeId,
        sourceActionNodeId,
      })
    );
  });

  it("refreshes post-action follow-up timers when a human outbound arrives during handoff", async () => {
    mockConversationLean.mockResolvedValue(
      createPendingConversation({ handoffActive: true })
    );
    mockMessageFindOneLean.mockResolvedValue({
      date: new Date("2026-05-01T00:45:00.000Z"),
    });

    const result = await handleAiriConversationExternalEvent({
      kind: "human_outbound",
      workspaceId,
      conversationId,
      messageId: "manager-message-2",
      channel: "whatsapp",
      messageDate: "2026-05-01T00:45:00.000Z",
      enqueuedAt: "2026-05-01T00:45:00.000Z",
    });

    expect(result.handled).toBe(true);
    expect(result.clearTimer).toBe(false);
    expect(result.projection?.handoffActive).toBe(true);
    expect(result.timer).toEqual(
      expect.objectContaining({
        kind: "post_action_no_reply_timeout",
        dueAt: "2026-05-01T01:45:00.000Z",
        conditionNodeId,
        sourceActionNodeId,
      })
    );
  });

  it("replans a persisted post-action timer without processing another turn", async () => {
    mockMessageFindOneLean.mockResolvedValue({
      date: new Date("2026-05-01T00:45:00.000Z"),
    });

    const result = await handleAiriConversationExternalEvent({
      kind: "timer_replan",
      workspaceId,
      conversationId,
      messageId: "timer-replan:scenario-1:message-out-1",
      channel: "whatsapp",
      messageDate: "2026-05-01T00:45:00.000Z",
      enqueuedAt: "2026-05-01T00:45:00.000Z",
    });

    expect(result).toEqual(
      expect.objectContaining({
        handled: true,
        clearTimer: false,
        timer: expect.objectContaining({
          kind: "post_action_no_reply_timeout",
          dueAt: "2026-05-01T01:45:00.000Z",
          conditionNodeId,
          sourceActionNodeId,
        }),
      })
    );
  });

  it("replans a persisted post-action timer during handoff from the latest message", async () => {
    mockConversationLean.mockResolvedValue(
      createPendingConversation({ handoffActive: true })
    );
    mockMessageFindOneLean.mockResolvedValue({
      date: new Date("2026-05-01T00:45:00.000Z"),
    });

    const result = await handleAiriConversationExternalEvent({
      kind: "timer_replan",
      workspaceId,
      conversationId,
      messageId: "timer-replan:scenario-1:message-out-1",
      channel: "whatsapp",
      messageDate: "2026-05-01T00:45:00.000Z",
      enqueuedAt: "2026-05-01T00:45:00.000Z",
    });

    expect(result).toEqual(
      expect.objectContaining({
        handled: true,
        clearTimer: false,
        projection: expect.objectContaining({ handoffActive: true }),
        timer: expect.objectContaining({
          kind: "post_action_no_reply_timeout",
          dueAt: "2026-05-01T01:45:00.000Z",
        }),
      })
    );
  });

  it("refreshes stale post-action timer fires from the latest conversation activity", async () => {
    const nowSpy = jest
      .spyOn(Date, "now")
      .mockReturnValue(new Date("2026-05-01T01:00:00.000Z").getTime());
    mockMessageFindOneLean.mockImplementation(
      (query?: Record<string, unknown>) =>
        query && "_id" in query
          ? { delivery: { status: "sent" } }
          : { date: new Date("2026-05-01T01:10:00.000Z") }
    );

    const result = await buildAiriConversationTimerTurn({
      ...createPostActionTimer(),
      dueAt: "2026-05-01T01:00:00.000Z",
      lastInboundAt: pendingStartedAt,
    });

    expect(result.reason).toBe("newer_message_rescheduled");
    expect(result.turn).toBeNull();
    expect(result.timer).toEqual(
      expect.objectContaining({
        dueAt: "2026-05-01T02:10:00.000Z",
        lastInboundAt: "2026-05-01T01:10:00.000Z",
      })
    );
    expect(mockBuildChannelSpecificParams).not.toHaveBeenCalled();

    nowSpy.mockRestore();
  });
});
