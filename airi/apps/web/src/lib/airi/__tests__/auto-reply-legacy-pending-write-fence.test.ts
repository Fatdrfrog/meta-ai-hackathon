const mockConversationFindOne = jest.fn();
const mockConversationUpdateOne = jest.fn();
const mockScenarioFindOne = jest.fn();
const mockScenarioUpdateOne = jest.fn();
const mockScenarioStartSession = jest.fn();

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindOne(...args),
    findOne: (...args: unknown[]) => mockConversationFindOne(...args),
    updateOne: (...args: unknown[]) => mockConversationUpdateOne(...args),
  },
}));

jest.mock("@/models/scenario", () => ({
  Scenario: {
    findOne: (...args: unknown[]) => mockScenarioFindOne(...args),
    updateOne: (...args: unknown[]) => mockScenarioUpdateOne(...args),
    startSession: (...args: unknown[]) => mockScenarioStartSession(...args),
  },
}));

jest.mock("@/lib/airi/scenario/scenario-runtime", () => ({
  resolveActiveScenarioRuntime: jest.fn(),
}));

import {
  completeScenarioAfterDispatch,
  persistPendingConditionState,
  persistScenarioState,
} from "@/lib/airi/reply/runtime/auto-reply-scenario-state";
import { ScenarioPendingWriteCoordinationError } from "@icecore/airi-runtime/scenario-runtime-dependencies";
import { createDemoShopInteractiveNoReplyFixture } from "../../../../test-fixtures/scenarios/demoshop-interactive-no-reply";
import { convertLegacyActionRouting } from "@/lib/scenarios/legacy-action-routing";
import { buildScenarioActionAnswerOutcomeHandleId } from "@icecore/scenario-contracts";

const startedAt = new Date("2026-08-05T10:00:00.000Z");

function createLegacyScenario(params?: {
  actionNodeId?: string;
  conditionNodeId?: string;
}) {
  const actionNodeId = params?.actionNodeId || "action-1";
  const conditionNodeId = params?.conditionNodeId || "condition-1";
  return {
    _id: "scenario-1",
    nodes: [
      {
        id: actionNodeId,
        data: { kind: "action", actionType: "reply" },
      },
      {
        id: conditionNodeId,
        data: {
          kind: "logic",
          logicType: "post_action_condition",
          postActionConditionVariant: "interactive_no_reply",
          conditionBranches: [
            {
              id: "no_reply_timeout",
              type: "no_reply_timeout",
              timeoutMinutes: 30,
            },
          ],
        },
      },
      {
        id: "follow-up",
        data: { kind: "action", actionType: "reply" },
      },
    ],
    edges: [
      {
        source: actionNodeId,
        target: conditionNodeId,
        sourceHandle: "right-source-interactive-no-reply",
      },
      {
        source: conditionNodeId,
        target: "follow-up",
        sourceHandle: "right-source-condition-no_reply_timeout",
      },
    ],
  };
}

function createOrdinaryConditionScenario() {
  const scenario = createLegacyScenario();
  const condition = scenario.nodes.find(node => node.id === "condition-1");
  if (condition) {
    const data = { ...condition.data } as Record<string, unknown>;
    delete data.postActionConditionVariant;
    condition.data = data as typeof condition.data;
  }
  scenario.edges[0] = {
    ...scenario.edges[0],
    sourceHandle: "right-source",
  };
  return scenario;
}

function createConvertedScenario() {
  return {
    _id: "scenario-1",
    nodes: [
      {
        id: "action-1",
        data: {
          kind: "action",
          actionType: "reply",
          actionOutcomes: {
            version: 1,
            noReply: { enabled: true, timeoutMinutes: 30 },
          },
        },
      },
      {
        id: "follow-up",
        data: { kind: "action", actionType: "reply" },
      },
    ],
    edges: [
      {
        source: "action-1",
        target: "follow-up",
        sourceHandle: "right-source-action-outcome::no-reply",
      },
    ],
  };
}

function createMatcherOnlyConvertedScenario() {
  return {
    _id: "scenario-1",
    nodes: [
      {
        id: "action-1",
        data: {
          kind: "action",
          actionType: "reply",
          actionOutcomes: {
            version: 1,
            answerMatches: [{ id: "accept", mode: "exact", text: "Accept" }],
          },
        },
      },
      {
        id: "follow-up",
        data: { kind: "action", actionType: "reply" },
      },
    ],
    edges: [
      {
        source: "action-1",
        target: "follow-up",
        sourceHandle: buildScenarioActionAnswerOutcomeHandleId("accept"),
      },
    ],
  };
}

function createConversation() {
  return {
    _id: "conversation-1",
    airi_scenario_state: {
      lockedScenarioId: "scenario-1",
      lockedScenarioName: "Scenario 1",
      currentActionNodeId: "action-1",
      currentPathNodeIds: ["action-1", "condition-1"],
      pendingConditionNodeId: null,
      pendingSourceActionNodeId: null,
    },
  };
}

function createLeanQuery<T>(value: T) {
  return {
    select: jest.fn().mockReturnThis(),
    session: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(value),
  };
}

function arrangeTransaction(params?: {
  scenarios?: unknown[];
  retryTouchOnce?: boolean;
}) {
  const scenarios = params?.scenarios || [createLegacyScenario()];
  let scenarioRead = 0;
  mockScenarioFindOne.mockImplementation(() =>
    createLeanQuery(scenarios[Math.min(scenarioRead++, scenarios.length - 1)])
  );
  mockConversationFindOne.mockImplementation(() =>
    createLeanQuery(createConversation())
  );
  mockConversationUpdateOne.mockResolvedValue({ matchedCount: 1 });

  const transientError = Object.assign(new Error("write conflict"), {
    errorLabels: ["TransientTransactionError"],
  });
  if (params?.retryTouchOnce) {
    mockScenarioUpdateOne
      .mockRejectedValueOnce(transientError)
      .mockResolvedValue({ matchedCount: 1 });
  } else {
    mockScenarioUpdateOne.mockResolvedValue({ matchedCount: 1 });
  }

  const session = {
    withTransaction: jest.fn(async callback => {
      try {
        return await callback();
      } catch (error) {
        if (error === transientError) return callback();
        throw error;
      }
    }),
    endSession: jest.fn().mockResolvedValue(undefined),
  };
  mockScenarioStartSession.mockResolvedValue(session);
  return session;
}

function createRuntime(conditionNodeId = "condition-1") {
  return {
    scenarioId: "scenario-1",
    scenarioName: "Scenario 1",
    selectedActionNodeId: "action-1",
    nextActionNodeId: "action-1",
    selectedPathNodeIds: ["action-1", conditionNodeId],
    pendingConditionNodeId: conditionNodeId,
    pendingSourceActionNodeId: "action-1",
    pendingLegacyRouting: {
      kind: "interactive_no_reply_assignment" as const,
      conditionNodeId,
      sourceActionNodeId: "action-1",
    },
    actionType: "reply" as const,
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
  };
}

describe("legacy pending-wait serialization fence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("keeps canonical action-outcome waits on the direct conversation update path", async () => {
    mockConversationUpdateOne.mockResolvedValue({ matchedCount: 1 });

    const state = await persistPendingConditionState({
      conversationId: "conversation-1",
      baseState: {},
      scenarioId: "scenario-1",
      scenarioName: "Scenario 1",
      sourceActionNodeId: "action-1",
      conditionNodeId: "__system:action-outcomes:action-1",
      startedAt,
    });

    expect(state.pendingConditionNodeId).toBe(
      "__system:action-outcomes:action-1"
    );
    expect(mockScenarioStartSession).not.toHaveBeenCalled();
    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      { _id: "conversation-1" },
      expect.objectContaining({
        $set: {
          airi_scenario_state: expect.objectContaining({
            pendingConditionNodeId: "__system:action-outcomes:action-1",
          }),
        },
      })
    );
  });

  it("classifies canonical pending-state write failures for caller retry", async () => {
    mockConversationUpdateOne.mockRejectedValue(new Error("database offline"));

    await expect(
      persistPendingConditionState({
        conversationId: "conversation-1",
        baseState: {},
        scenarioId: "scenario-1",
        scenarioName: "Scenario 1",
        sourceActionNodeId: "action-1",
        conditionNodeId: "__system:action-outcomes:action-1",
        startedAt,
      })
    ).rejects.toMatchObject<Partial<ScenarioPendingWriteCoordinationError>>({
      code: "conversation_write_failed",
      scenarioPendingWriteCoordinationError: true,
    });
  });

  it("serializes an exact legacy pair through the scenario document", async () => {
    const session = arrangeTransaction();

    const state = await persistPendingConditionState({
      conversationId: "conversation-1",
      baseState: {},
      scenarioId: "scenario-1",
      scenarioName: "Scenario 1",
      sourceActionNodeId: "action-1",
      conditionNodeId: "condition-1",
      pendingLegacyRouting: {
        kind: "interactive_no_reply_assignment",
        conditionNodeId: "condition-1",
        sourceActionNodeId: "action-1",
      },
      pathNodeIds: ["action-1", "condition-1"],
      startedAt,
    });

    expect(state.pendingConditionNodeId).toBe("condition-1");
    expect(mockScenarioUpdateOne).toHaveBeenCalledWith(
      { _id: "scenario-1", status: "active", deletedAt: null },
      { $inc: { __v: 1 } },
      { session, timestamps: false }
    );
    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      { _id: "conversation-1" },
      expect.objectContaining({
        $set: {
          airi_scenario_state: expect.objectContaining({
            pendingConditionNodeId: "condition-1",
            pendingSourceActionNodeId: "action-1",
          }),
        },
      }),
      { session }
    );
  });

  it("preserves a shared Flow branch with multiple source actions", async () => {
    arrangeTransaction({
      scenarios: [createDemoShopInteractiveNoReplyFixture()],
    });

    const state = await persistPendingConditionState({
      conversationId: "conversation-1",
      baseState: {},
      scenarioId: "scenario-1",
      scenarioName: "Scenario 1",
      sourceActionNodeId: "action-alpha",
      conditionNodeId: "flow-condition-shared",
      startedAt,
    });

    expect(state.pendingConditionNodeId).toBe("flow-condition-shared");
    expect(mockScenarioStartSession).not.toHaveBeenCalled();
    expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
    expect(mockConversationUpdateOne).toHaveBeenCalledTimes(1);
  });

  it("preserves a shared Flow branch after legacy outcomes are converted", async () => {
    const fixture = createDemoShopInteractiveNoReplyFixture();
    const alphaConversion = convertLegacyActionRouting({
      graph: fixture,
      sourceActionNodeId: "action-alpha",
      conditionNodeId: "legacy-alpha",
    });
    const betaConversion = convertLegacyActionRouting({
      graph: alphaConversion.graph,
      sourceActionNodeId: "action-beta",
      conditionNodeId: "legacy-beta",
    });
    arrangeTransaction({ scenarios: [betaConversion.graph] });

    const state = await persistPendingConditionState({
      conversationId: "conversation-1",
      baseState: {},
      scenarioId: "scenario-1",
      scenarioName: "Scenario 1",
      sourceActionNodeId: "action-beta",
      conditionNodeId: "flow-condition-shared",
      startedAt,
    });

    expect(state.pendingConditionNodeId).toBe("flow-condition-shared");
    expect(mockScenarioStartSession).not.toHaveBeenCalled();
    expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
    expect(mockConversationUpdateOne).toHaveBeenCalledTimes(1);
  });

  it("keeps an ordinary path-scoped wait on the direct persistence path", async () => {
    mockConversationUpdateOne.mockResolvedValue({ matchedCount: 1 });

    const state = await persistPendingConditionState({
      conversationId: "conversation-1",
      baseState: {},
      scenarioId: "scenario-1",
      scenarioName: "Scenario 1",
      sourceActionNodeId: "reply-2",
      conditionNodeId: "branch-2",
      startedAt,
    });

    expect(state.pendingConditionNodeId).toBe("branch-2");
    expect(mockScenarioStartSession).not.toHaveBeenCalled();
    expect(mockConversationUpdateOne).toHaveBeenCalledTimes(1);
  });

  it("remaps a stale legacy wait when the current graph proves the no-reply outcome", async () => {
    arrangeTransaction({ scenarios: [createConvertedScenario()] });

    const state = await persistPendingConditionState({
      conversationId: "conversation-1",
      baseState: {},
      scenarioId: "scenario-1",
      scenarioName: "Scenario 1",
      sourceActionNodeId: "action-1",
      conditionNodeId: "condition-1",
      pendingLegacyRouting: {
        kind: "interactive_no_reply_assignment",
        conditionNodeId: "condition-1",
        sourceActionNodeId: "action-1",
      },
      startedAt,
    });

    expect(state.pendingConditionNodeId).toBe(
      "__system:action-outcomes:action-1"
    );
    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      { _id: "conversation-1" },
      expect.objectContaining({
        $set: {
          airi_scenario_state: expect.objectContaining({
            pendingConditionNodeId: "__system:action-outcomes:action-1",
            pendingLegacyRouting: null,
          }),
        },
      }),
      expect.any(Object)
    );
  });

  it("remaps an exact legacy wait to matcher-only canonical outcomes", async () => {
    arrangeTransaction({ scenarios: [createMatcherOnlyConvertedScenario()] });

    const state = await persistPendingConditionState({
      conversationId: "conversation-1",
      baseState: {},
      scenarioId: "scenario-1",
      scenarioName: "Scenario 1",
      sourceActionNodeId: "action-1",
      conditionNodeId: "condition-1",
      pendingLegacyRouting: {
        kind: "interactive_no_reply_assignment",
        conditionNodeId: "condition-1",
        sourceActionNodeId: "action-1",
      },
      startedAt,
    });

    expect(state.pendingConditionNodeId).toBe(
      "__system:action-outcomes:action-1"
    );
    expect(state.pendingLegacyRouting).toBeNull();
  });

  it("never remaps an ordinary removed branch to an unrelated outcome", async () => {
    mockConversationUpdateOne.mockResolvedValue({ matchedCount: 1 });

    const state = await persistPendingConditionState({
      conversationId: "conversation-1",
      baseState: {},
      scenarioId: "scenario-1",
      scenarioName: "Scenario 1",
      sourceActionNodeId: "action-1",
      conditionNodeId: "removed-flow-branch",
      startedAt,
    });

    expect(state.pendingConditionNodeId).toBe("removed-flow-branch");
    expect(mockScenarioStartSession).not.toHaveBeenCalled();
  });

  it("fails closed when legacy provenance does not match the requested pair", async () => {
    await expect(
      persistPendingConditionState({
        conversationId: "conversation-1",
        baseState: {},
        scenarioId: "scenario-1",
        scenarioName: "Scenario 1",
        sourceActionNodeId: "action-1",
        conditionNodeId: "condition-1",
        pendingLegacyRouting: {
          kind: "interactive_no_reply_assignment",
          conditionNodeId: "another-condition",
          sourceActionNodeId: "action-1",
        },
        startedAt,
      })
    ).rejects.toMatchObject<Partial<ScenarioPendingWriteCoordinationError>>({
      code: "scenario_routing_changed",
    });
    expect(mockScenarioStartSession).not.toHaveBeenCalled();
    expect(mockConversationUpdateOne).not.toHaveBeenCalled();
  });

  it.each(["", false])(
    "fails closed for malformed legacy provenance %p",
    async pendingLegacyRouting => {
      mockConversationUpdateOne.mockResolvedValue({ matchedCount: 1 });

      await expect(
        persistPendingConditionState({
          conversationId: "conversation-1",
          baseState: {},
          scenarioId: "scenario-1",
          scenarioName: "Scenario 1",
          sourceActionNodeId: "action-1",
          conditionNodeId: "condition-1",
          pendingLegacyRouting: pendingLegacyRouting as never,
          startedAt,
        })
      ).rejects.toMatchObject<Partial<ScenarioPendingWriteCoordinationError>>({
        code: "scenario_routing_changed",
      });
      expect(mockScenarioStartSession).not.toHaveBeenCalled();
      expect(mockConversationUpdateOne).not.toHaveBeenCalled();
    }
  );

  it("fails closed when legacy provenance points to a canonical virtual wait", async () => {
    const conditionNodeId = "__system:action-outcomes:action-1";
    mockConversationUpdateOne.mockResolvedValue({ matchedCount: 1 });

    await expect(
      persistPendingConditionState({
        conversationId: "conversation-1",
        baseState: {},
        scenarioId: "scenario-1",
        scenarioName: "Scenario 1",
        sourceActionNodeId: "action-1",
        conditionNodeId,
        pendingLegacyRouting: {
          kind: "interactive_no_reply_assignment",
          conditionNodeId,
          sourceActionNodeId: "action-1",
        },
        startedAt,
      })
    ).rejects.toMatchObject<Partial<ScenarioPendingWriteCoordinationError>>({
      code: "scenario_routing_changed",
    });
    expect(mockScenarioStartSession).not.toHaveBeenCalled();
    expect(mockConversationUpdateOne).not.toHaveBeenCalled();
  });

  it("fails closed when provenance is forged for an ordinary condition", async () => {
    arrangeTransaction({ scenarios: [createOrdinaryConditionScenario()] });

    await expect(
      persistPendingConditionState({
        conversationId: "conversation-1",
        baseState: {},
        scenarioId: "scenario-1",
        scenarioName: "Scenario 1",
        sourceActionNodeId: "action-1",
        conditionNodeId: "condition-1",
        pendingLegacyRouting: {
          kind: "interactive_no_reply_assignment",
          conditionNodeId: "condition-1",
          sourceActionNodeId: "action-1",
        },
        startedAt,
      })
    ).rejects.toMatchObject<Partial<ScenarioPendingWriteCoordinationError>>({
      code: "scenario_routing_changed",
    });
    expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
    expect(mockConversationUpdateOne).not.toHaveBeenCalled();
  });

  it("fails closed when the current graph does not own the requested pair", async () => {
    arrangeTransaction({
      scenarios: [
        createLegacyScenario({
          actionNodeId: "another-action",
          conditionNodeId: "condition-1",
        }),
      ],
    });

    await expect(
      persistPendingConditionState({
        conversationId: "conversation-1",
        baseState: {},
        scenarioId: "scenario-1",
        scenarioName: "Scenario 1",
        sourceActionNodeId: "action-1",
        conditionNodeId: "condition-1",
        pendingLegacyRouting: {
          kind: "interactive_no_reply_assignment",
          conditionNodeId: "condition-1",
          sourceActionNodeId: "action-1",
        },
        startedAt,
      })
    ).rejects.toMatchObject<Partial<ScenarioPendingWriteCoordinationError>>({
      code: "scenario_routing_changed",
    });
    expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
    expect(mockConversationUpdateOne).not.toHaveBeenCalled();
  });

  it("reloads the graph when Mongo retries a conflicting transaction", async () => {
    arrangeTransaction({
      scenarios: [createLegacyScenario(), createConvertedScenario()],
      retryTouchOnce: true,
    });

    const state = await persistPendingConditionState({
      conversationId: "conversation-1",
      baseState: {},
      scenarioId: "scenario-1",
      scenarioName: "Scenario 1",
      sourceActionNodeId: "action-1",
      conditionNodeId: "condition-1",
      pendingLegacyRouting: {
        kind: "interactive_no_reply_assignment",
        conditionNodeId: "condition-1",
        sourceActionNodeId: "action-1",
      },
      startedAt,
    });

    expect(mockScenarioFindOne).toHaveBeenCalledTimes(2);
    expect(mockConversationFindOne).toHaveBeenCalledTimes(2);
    expect(mockConversationUpdateOne).toHaveBeenCalledTimes(1);
    expect(state.pendingConditionNodeId).toBe(
      "__system:action-outcomes:action-1"
    );
  });

  it("classifies an exhausted Mongo transaction as a coordination failure", async () => {
    const session = {
      withTransaction: jest
        .fn()
        .mockRejectedValue(new Error("transaction retries exhausted")),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    mockScenarioStartSession.mockResolvedValue(session);

    await expect(
      persistPendingConditionState({
        conversationId: "conversation-1",
        baseState: {},
        scenarioId: "scenario-1",
        scenarioName: "Scenario 1",
        sourceActionNodeId: "action-1",
        conditionNodeId: "condition-1",
        pendingLegacyRouting: {
          kind: "interactive_no_reply_assignment",
          conditionNodeId: "condition-1",
          sourceActionNodeId: "action-1",
        },
        startedAt,
      })
    ).rejects.toMatchObject<Partial<ScenarioPendingWriteCoordinationError>>({
      code: "scenario_write_conflict",
      scenarioPendingWriteCoordinationError: true,
    });
  });

  it("classifies session acquisition failure before callers can swallow it", async () => {
    mockScenarioStartSession.mockRejectedValue(new Error("database offline"));

    await expect(
      persistPendingConditionState({
        conversationId: "conversation-1",
        baseState: {},
        scenarioId: "scenario-1",
        scenarioName: "Scenario 1",
        sourceActionNodeId: "action-1",
        conditionNodeId: "condition-1",
        pendingLegacyRouting: {
          kind: "interactive_no_reply_assignment",
          conditionNodeId: "condition-1",
          sourceActionNodeId: "action-1",
        },
        startedAt,
      })
    ).rejects.toMatchObject<Partial<ScenarioPendingWriteCoordinationError>>({
      code: "scenario_write_conflict",
      scenarioPendingWriteCoordinationError: true,
    });
  });

  it.each([
    [
      "initial resolution",
      () =>
        persistScenarioState({
          conversationId: "conversation-1",
          scenarioRuntime: createRuntime(),
          messageId: "message-1",
          baseState: {},
        }),
    ],
    [
      "post-delivery completion",
      () =>
        completeScenarioAfterDispatch({
          conversationId: "conversation-1",
          scenarioRuntime: createRuntime(),
          baseState: {},
          completionTimestamp: startedAt,
          lastMessageId: "message-1",
        }),
    ],
  ])("uses the same legacy fence for %s", async (_, writeState) => {
    arrangeTransaction();

    await writeState();

    expect(mockScenarioStartSession).toHaveBeenCalledTimes(1);
    expect(mockScenarioUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      { _id: "conversation-1" },
      expect.any(Object),
      expect.objectContaining({ session: expect.any(Object) })
    );
  });
});
