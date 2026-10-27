import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isScenarioOutboundCheckpointConfirmed,
  normalizeConversationScenarioState,
} from "./scenario-state";

describe("isScenarioOutboundCheckpointConfirmed", () => {
  it("requires provider acceptance for WhatsApp rather than a reserved message", () => {
    for (const checkpoint of [
      null,
      { channel: "whatsapp" },
      { channel: "whatsapp", messageId: "" },
      ...["reserved", "dispatching", "not_attempted", "outcome_unknown"].map(
        (state) => ({
          channel: "whatsapp",
          messageId: "wamid.accepted",
          temporalDispatch: { state },
        }),
      ),
      {
        channel: "whatsapp",
        messageId: "wamid.accepted",
        delivery: { status: "failed" },
      },
    ]) {
      assert.equal(isScenarioOutboundCheckpointConfirmed(checkpoint), false);
    }
    assert.equal(
      isScenarioOutboundCheckpointConfirmed({
        channel: "whatsapp",
        messageId: "wamid.accepted",
        temporalDispatch: { state: "sent" },
      }),
      true,
    );
    assert.equal(
      isScenarioOutboundCheckpointConfirmed({
        channel: "whatsapp",
        messageId: "wamid.legacy",
        delivery: { status: "read" },
      }),
      true,
    );
    assert.equal(
      isScenarioOutboundCheckpointConfirmed({ channel: "web_widget" }),
      true,
    );
  });
});
describe("normalizeConversationScenarioState", () => {
  it("preserves a journey identity only while its scenario remains locked", () => {
    const behaviorRunId = "a".repeat(24);
    assert.equal(
      normalizeConversationScenarioState({
        lockedScenarioId: "scenario",
        behaviorRunId,
      })?.behaviorRunId,
      behaviorRunId,
    );
    assert.equal(
      normalizeConversationScenarioState({
        lockedScenarioId: null,
        behaviorRunId,
      })?.behaviorRunId,
      null,
    );
    assert.equal(
      normalizeConversationScenarioState({
        lockedScenarioId: "scenario",
        behaviorRunId: "bad",
      })?.behaviorRunId,
      null,
    );
  });
  it("keeps exact legacy pending-routing provenance", () => {
    const normalized = normalizeConversationScenarioState({
      pendingConditionNodeId: "legacy-condition",
      pendingSourceActionNodeId: "source-action",
      pendingLegacyRouting: {
        kind: "interactive_no_reply_assignment",
        conditionNodeId: "legacy-condition",
        sourceActionNodeId: "source-action",
      },
    });

    assert.deepEqual(normalized?.pendingLegacyRouting, {
      kind: "interactive_no_reply_assignment",
      conditionNodeId: "legacy-condition",
      sourceActionNodeId: "source-action",
    });
  });

  it("drops stale or mismatched legacy pending-routing provenance", () => {
    const normalized = normalizeConversationScenarioState({
      pendingConditionNodeId: "current-condition",
      pendingSourceActionNodeId: "source-action",
      pendingLegacyRouting: {
        kind: "interactive_no_reply_assignment",
        conditionNodeId: "removed-condition",
        sourceActionNodeId: "source-action",
      },
    });

    assert.equal(normalized?.pendingLegacyRouting, null);
  });

  it("deduplicates explicit startedScenarios by scenarioId", () => {
    const normalized = normalizeConversationScenarioState({
      startedScenarios: [
        {
          scenarioId: "scenario-1",
          scenarioName: "Scenario 1",
          startedAt: "2026-03-27T10:00:00.000Z",
          firstActionNodeId: "action-1",
          firstMessageId: "msg-1",
        },
        {
          scenarioId: "scenario-1",
          scenarioName: "Scenario 1 duplicate",
          startedAt: "2026-03-27T11:00:00.000Z",
          firstActionNodeId: "action-2",
          firstMessageId: "msg-2",
        },
      ],
    });

    assert.deepEqual(normalized?.startedScenarios, [
      {
        scenarioId: "scenario-1",
        scenarioName: "Scenario 1",
        startedAt: "2026-03-27T10:00:00.000Z",
        firstActionNodeId: "action-1",
        firstMessageId: "msg-1",
      },
    ]);
  });

  it("keeps startedScenarios empty when the migrated field is absent", () => {
    const normalized = normalizeConversationScenarioState({
      lockedScenarioId: "locked-1",
      lockedScenarioName: "Locked scenario",
      currentActionNodeId: "action-locked",
      lastMatchedAt: "2026-03-27T12:00:00.000Z",
      lastMessageId: "msg-locked",
      completedScenarios: [
        {
          scenarioId: "completed-1",
          scenarioName: "Completed scenario",
          completedAt: "2026-03-27T10:00:00.000Z",
          lastActionNodeId: "action-completed",
          lastMessageId: "msg-completed",
        },
      ],
    });

    assert.deepEqual(normalized?.startedScenarios, []);
  });

  it("ignores retired journey pool state from older conversations", () => {
    const normalized = normalizeConversationScenarioState({
      journeyPools: [
        {
          poolKey: "product_entry",
          ownerScenarioId: "scenario-1",
          ownerScenarioName: "Scenario 1",
          lockedAt: "2026-03-27T10:00:00.000Z",
        },
        {
          poolKey: "product_entry",
          ownerScenarioId: "scenario-2",
          ownerScenarioName: "Scenario 2",
          lockedAt: "2026-03-27T11:00:00.000Z",
        },
      ],
    } as never);

    assert.equal(
      Object.prototype.hasOwnProperty.call(normalized, "journeyPools"),
      false,
    );
  });
});

it("keeps collected prompt answers and drops a broken collection", () => {
  const kept = normalizeConversationScenarioState({
    collectedPromptInputs: {
      scenarioId: "scenario-1",
      sourceActionNodeId: "ask",
      awaitingReply: true,
      pendingFieldKey: "name",
      resumeActionNodeId: "generate",
      sourcePathNodeIds: ["ask"],
      values: { name: "Amina", Bad: "no" },
    },
  });
  assert.deepEqual(kept?.collectedPromptInputs, {
    scenarioId: "scenario-1",
    sourceActionNodeId: "ask",
    awaitingReply: true,
    resumeActionNodeId: "generate",
    sourcePathNodeIds: ["ask"],
    values: { name: "Amina" },
    followsChoice: false,
    choiceOptionId: null,
    expiresAt: null,
    nudged: false,
  });
  assert.equal(
    normalizeConversationScenarioState({
      collectedPromptInputs: { scenarioId: "", sourceActionNodeId: "ask" },
    })?.collectedPromptInputs,
    null,
  );
});

it("keeps the customer's picks and drops a broken pick list", () => {
  const pick = {
    sourceActionNodeId: "carousel-1",
    optionId: "wsc:carousel-1:gold",
    label: "Buy",
    cardIndex: 0,
    cardBodyText: "Gold frame",
    pickedAt: "2026-09-27T10:00:00.000Z",
  };
  assert.deepEqual(
    normalizeConversationScenarioState({
      pickedOptions: {
        scenarioId: "scenario-1",
        picks: [pick, { label: "x" }],
      },
    })?.pickedOptions,
    { scenarioId: "scenario-1", picks: [pick] },
  );
  for (const pickedOptions of [
    undefined,
    { scenarioId: "", picks: [pick] },
    { scenarioId: "scenario-1", picks: [] },
  ]) {
    assert.equal(
      normalizeConversationScenarioState({ pickedOptions })?.pickedOptions,
      null,
    );
  }
});

it("keeps the customer's form answers and drops a broken ledger", () => {
  const submission = {
    sourceActionNodeId: "order-form",
    flowId: null,
    inboundMessageId: "message-1",
    submittedAt: "2026-09-30T10:00:00.000Z",
    fields: [
      { key: "size", label: "Size", fieldType: "Dropdown", value: "Large" },
    ],
  };
  assert.deepEqual(
    normalizeConversationScenarioState({
      formAnswers: {
        scenarioId: "scenario-1",
        submissions: [submission, { fields: [] }],
      },
    })?.formAnswers,
    { scenarioId: "scenario-1", submissions: [submission] },
  );
  for (const formAnswers of [
    undefined,
    null,
    { scenarioId: "", submissions: [submission] },
    { scenarioId: "scenario-1", submissions: [] },
    { scenarioId: "scenario-1", submissions: "broken" },
  ]) {
    assert.equal(
      normalizeConversationScenarioState({ formAnswers })?.formAnswers,
      null,
    );
  }
});

it("trims persisted path IDs without deduplicating or mutating them", () => {
  const pathIds = [" action-a ", null, "", 7, "action-a", " action-b"];
  const before = structuredClone(pathIds);
  const state = normalizeConversationScenarioState({
    currentPathNodeIds: pathIds,
    currentBranchNodeIds: pathIds,
  });
  assert.deepEqual(state?.currentPathNodeIds, [
    "action-a",
    "action-a",
    "action-b",
  ]);
  assert.deepEqual(state?.currentBranchNodeIds, [
    "action-a",
    "action-a",
    "action-b",
  ]);
  assert.deepEqual(pathIds, before);
});
