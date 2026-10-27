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

import type {
  ScenarioRoutedLocationEntry,
  ScenarioRoutedLocationOffice,
} from "@icecore/scenario-contracts";
import {
  completeLockedScenarioAndPersist,
  persistScenarioState,
  reconcileRagScenarioSelectionAndPersist,
  recordScenarioLocationDecisionAndPersist,
} from "@/lib/airi/reply/runtime/auto-reply-scenario-state";

const WAIT_STARTED_AT = new Date("2026-10-05T10:00:00.000Z");
const WAIT_NODE_ID = "__system:action-outcomes:ask-location";

const abay: ScenarioRoutedLocationOffice = {
  key: "almaty_abay",
  name: "Abay",
  country: "KZ",
  city: "Almaty",
  cityKey: "almaty",
  address: "Abay Ave 10",
  phone: "+7 727 000 00 00",
  tags: ["flagship"],
  latitude: 43.24,
  longitude: 76.91,
};

const routedShare: ScenarioRoutedLocationEntry = {
  sourceActionNodeId: "ask-location",
  inboundMessageId: "651f1f77bcf86cd799439011",
  sharedAt: "2026-10-05T10:01:00.000Z",
  decidedAt: "2026-10-05T10:01:02.000Z",
  source: "turn",
  outcome: "route",
  routeId: "loc_kz",
  office: abay,
  distanceMeters: 2100,
};

const unroutedShare: ScenarioRoutedLocationEntry = {
  sourceActionNodeId: "ask-location",
  inboundMessageId: "651f1f77bcf86cd799439010",
  sharedAt: "2026-10-05T10:00:30.000Z",
  decidedAt: "2026-10-05T10:00:31.000Z",
  source: "lookup",
  outcome: "unrouted",
  reason: "step_not_built",
};

const waitingState = {
  lockedScenarioId: "delivery",
  lockedScenarioName: "Delivery",
  currentActionNodeId: "ask-location",
  pendingConditionNodeId: WAIT_NODE_ID,
  pendingSourceActionNodeId: "ask-location",
  pendingStartedAt: WAIT_STARTED_AT,
  pendingLastOutboundMessageId: "outbound-1",
};

const expectedPendingState = {
  scenarioId: "delivery",
  conditionNodeId: WAIT_NODE_ID,
  sourceActionNodeId: "ask-location",
  pendingStartedAt: WAIT_STARTED_AT,
  lastOutboundMessageId: "outbound-1",
};

const ledger = { scenarioId: "delivery", entries: [routedShare] };

function savedScenarioState(call = 0): Record<string, unknown> {
  return mockConversationUpdateOne.mock.calls[call][1].$set.airi_scenario_state;
}

describe("scenario location ledger persistence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConversationUpdateOne.mockResolvedValue({ matchedCount: 1 });
  });

  it("records a decision only while its wait holds and writes only the ledger", async () => {
    const result = await recordScenarioLocationDecisionAndPersist({
      conversationId: "conversation-1",
      baseState: {
        ...waitingState,
        routedLocations: { scenarioId: "delivery", entries: [unroutedShare] },
      },
      entry: routedShare,
      expectedPendingState,
    });

    expect(mockConversationUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      {
        _id: "conversation-1",
        "airi_scenario_state.lockedScenarioId": "delivery",
        "airi_scenario_state.pendingConditionNodeId": WAIT_NODE_ID,
        "airi_scenario_state.pendingSourceActionNodeId": "ask-location",
        "airi_scenario_state.pendingStartedAt": WAIT_STARTED_AT,
        "airi_scenario_state.pendingLastOutboundMessageId": "outbound-1",
      },
      {
        $set: {
          "airi_scenario_state.routedLocations": {
            scenarioId: "delivery",
            entries: [unroutedShare, routedShare],
          },
        },
      }
    );
    expect(result.persisted).toBe(true);
    expect(result.state).toMatchObject({
      ...waitingState,
      routedLocations: {
        scenarioId: "delivery",
        entries: [unroutedShare, routedShare],
      },
    });
  });

  it("reports a decision as not recorded once the wait has moved on", async () => {
    mockConversationUpdateOne.mockResolvedValue({ matchedCount: 0 });

    const result = await recordScenarioLocationDecisionAndPersist({
      conversationId: "conversation-1",
      baseState: waitingState,
      entry: unroutedShare,
      expectedPendingState,
    });

    expect(result.persisted).toBe(false);
  });

  it("replaces another scenario's ledger with the deciding scenario's", async () => {
    const result = await recordScenarioLocationDecisionAndPersist({
      conversationId: "conversation-1",
      baseState: {
        ...waitingState,
        routedLocations: {
          scenarioId: "other",
          entries: [{ ...unroutedShare, sourceActionNodeId: "other-ask" }],
        },
      },
      entry: routedShare,
      expectedPendingState,
    });

    expect(mockConversationUpdateOne.mock.calls[0][1]).toEqual({
      $set: { "airi_scenario_state.routedLocations": ledger },
    });
    expect(result.state).toMatchObject({ routedLocations: ledger });
  });

  it("writes the ledger as the conversation schema stores it", async () => {
    await recordScenarioLocationDecisionAndPersist({
      conversationId: "conversation-1",
      baseState: waitingState,
      entry: {
        ...routedShare,
        office: { ...abay, sortOrder: 4, isActive: true },
        distanceMeters: 2100.4,
        latitude: 43.2401,
        longitude: 76.9102,
      } as ScenarioRoutedLocationEntry,
      expectedPendingState,
    });

    expect(mockConversationUpdateOne.mock.calls[0][1]).toEqual({
      $set: { "airi_scenario_state.routedLocations": ledger },
    });
  });

  it("keeps the ledger while its scenario runs on and drops another scenario's", async () => {
    const persist = (scenarioRuntime: Record<string, unknown>) =>
      persistScenarioState({
        conversationId: "conversation-1",
        scenarioRuntime: {
          scenarioName: "Delivery",
          actionType: "reply",
          selectedActionNodeId: "office-reply",
          ...scenarioRuntime,
        } as never,
        messageId: "651f1f77bcf86cd799439011",
        baseState: { ...waitingState, routedLocations: ledger },
      });

    await persist({ scenarioId: "delivery", nextActionNodeId: "office-reply" });
    expect(savedScenarioState(0).routedLocations).toEqual(ledger);

    await persist({
      scenarioId: "delivery",
      nextActionNodeId: "ask-location",
      pendingConditionNodeId: WAIT_NODE_ID,
      pendingSourceActionNodeId: "ask-location",
    });
    expect(mockConversationUpdateOne.mock.calls[1][0]).toEqual({
      _id: "conversation-1",
    });
    expect(savedScenarioState(1)).toMatchObject({
      pendingConditionNodeId: WAIT_NODE_ID,
      routedLocations: ledger,
    });

    await persist({ scenarioId: "other", nextActionNodeId: "next" });
    expect(savedScenarioState(2).routedLocations).toBeNull();
  });

  it("clears the ledger when its scenario ends", async () => {
    await persistScenarioState({
      conversationId: "conversation-1",
      scenarioRuntime: {
        scenarioId: "delivery",
        scenarioName: "Delivery",
        actionType: "end_scenario",
        selectedActionNodeId: "end",
        completesScenario: true,
        nextActionNodeId: null,
      } as never,
      messageId: "651f1f77bcf86cd799439011",
      baseState: { ...waitingState, routedLocations: ledger },
    });
    expect(savedScenarioState(0).routedLocations).toBeNull();

    const result = await completeLockedScenarioAndPersist({
      conversationId: "conversation-1",
      baseState: { ...waitingState, routedLocations: ledger },
      scenarioId: "delivery",
      scenarioName: "Delivery",
      lastActionNodeId: "ask-location",
      lastMessageId: "outbound-1",
      expectedPendingState: {
        conditionNodeId: WAIT_NODE_ID,
        sourceActionNodeId: "ask-location",
        pendingStartedAt: WAIT_STARTED_AT,
        lastOutboundMessageId: "outbound-1",
      },
    });
    expect(result.persisted).toBe(true);
    expect(result.state.routedLocations).toBeNull();
    expect(savedScenarioState(1)).toMatchObject({
      lockedScenarioId: null,
      pendingConditionNodeId: null,
      routedLocations: null,
    });
  });

  it("clears the ledger with the lock when unrestricted fallback wins", async () => {
    mockConversationFindById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({
        airi_scenario_state: { ...waitingState, routedLocations: ledger },
      }),
    });

    await reconcileRagScenarioSelectionAndPersist({
      conversationId: "conversation-1",
      initialScenarioRuntime: {
        scenarioId: "delivery",
        scenarioName: "Delivery",
      } as never,
      finalScenarioRuntime: null,
      messageId: "message-1",
    });

    expect(savedScenarioState(0)).toMatchObject({
      lockedScenarioId: null,
      routedLocations: null,
    });
  });
});
