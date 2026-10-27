import assert from "node:assert/strict";
import test from "node:test";
import { resolveScenarioDeliveryOwnership } from "./delivery-gates";

const captured = {
  last_inbound_at: "2026-10-10T10:00:00.000Z",
  airi_scenario_state: {
    lockedScenarioId: "scenario",
    currentActionNodeId: "previous",
  },
};
const current = {
  ...captured,
  airi_scenario_state: {
    lockedScenarioId: "scenario",
    currentActionNodeId: "follow-up",
    pendingConditionNodeId: "wait",
  },
};
const check = (
  live: unknown,
  snapshot: unknown = captured,
  capturedMessageDate?: unknown,
) =>
  resolveScenarioDeliveryOwnership({
    capturedConversation: snapshot,
    currentConversation: live,
    scenarioId: "scenario",
    actionNodeId: "follow-up",
    capturedMessageDate,
  });

test("scenario delivery keeps the selected action owner and rejects a newer inbound during preparation", () => {
  assert.deepEqual(check(current), { allow: true });
  assert.deepEqual(
    check({ ...current, last_inbound_at: "2026-10-10T10:00:01.000Z" }),
    { allow: false, reason: "newer_inbound" },
  );
  assert.deepEqual(
    check({
      ...current,
      airi_scenario_state: {
        lockedScenarioId: "scenario",
        currentActionNodeId: "new-step",
        pendingConditionNodeId: "new-wait",
      },
    }),
    { allow: false, reason: "scenario_changed" },
  );
  assert.deepEqual(check({ ...current, airi_scenario_state: null }), {
    allow: false,
    reason: "scenario_changed",
  });
  assert.deepEqual(check(null), {
    allow: false,
    reason: "conversation_missing",
  });
});

test("scenario delivery respects a new handoff while preserving an already captured scenario bypass", () => {
  const handoff = {
    airi_handoff_active: true,
    airi_handoff_started_at: "2026-10-10T10:00:01.000Z",
  };
  assert.deepEqual(check({ ...current, ...handoff }), {
    allow: false,
    reason: "manual_handoff_started",
  });
  assert.deepEqual(
    check({ ...current, ...handoff }, { ...captured, ...handoff }),
    { allow: true },
  );
  assert.deepEqual(
    check(
      { ...current, ...handoff },
      {
        ...captured,
        airi_handoff_active: true,
        airi_handoff_started_at: "2026-10-10T09:00:00.000Z",
      },
    ),
    { allow: false, reason: "manual_handoff_started" },
  );
});

test("scenario delivery uses a legacy message timestamp but cannot accept an invalid inbound checkpoint", () => {
  assert.deepEqual(check(current, {}, captured.last_inbound_at), {
    allow: true,
  });
  assert.deepEqual(check(current, {}), {
    allow: false,
    reason: "inbound_checkpoint_invalid",
  });
  assert.deepEqual(check({ ...current, last_inbound_at: "invalid" }), {
    allow: false,
    reason: "inbound_checkpoint_invalid",
  });
  assert.deepEqual(check({ ...current, last_inbound_at: null }, {}), {
    allow: true,
  });
});
