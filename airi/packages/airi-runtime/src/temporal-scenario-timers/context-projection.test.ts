import assert from "node:assert/strict";
import test from "node:test";

import type { TimerConversationRecord } from "./types";

type RetiredTimerField =
  | "classification"
  | "internal_labels"
  | "history_summary"
  | "estimated_customer_ltv"
  | "revenue_attribution_id";
type TimerRecordHasNoRetiredFields =
  Extract<keyof TimerConversationRecord, RetiredTimerField> extends never
    ? true
    : false;

const TIMER_RECORD_HAS_NO_RETIRED_FIELDS: TimerRecordHasNoRetiredFields = true;
test("loads timer context with only runtime-owned Conversation fields", async () => {
  assert.equal(TIMER_RECORD_HAS_NO_RETIRED_FIELDS, true);
  const { loadTimerContext } = await import("./context");
  const conversation = {
    _id: "conversation-1",
    workspaceId: "workspace-1",
    channel: "whatsapp",
    preferred_language: "kk",
    updatedAt: new Date("2026-08-11T06:00:00.000Z"),
    airi_context_memory: {
      currentGoal: "Retain account",
      preferredLanguage: "kk",
    },
    airi_scenario_state: {
      lockedScenarioId: "scenario-1",
      lockedScenarioName: "Retention",
      currentActionNodeId: "action-2",
      currentPathNodeIds: ["path-1"],
      currentBranchNodeIds: ["branch-1"],
      pendingConditionNodeId: "condition-1",
      pendingSourceActionNodeId: "action-1",
      pendingLinkedConditionId: "linked-1",
    },
    airi_handoff_active: true,
    airi_handoff_source: "agent",
    airi_handoff_reason: "requested",
    airi_handoff_started_at: new Date("2026-08-11T05:55:00.000Z"),
  };
  const context = await loadTimerContext("conversation-1", {
    loadConversation: async (id) => {
      assert.equal(id, "conversation-1");
      return conversation;
    },
  });

  assert.deepEqual(context, {
    conversation,
    projection: {
      currentGoal: "Retain account",
      preferredLanguage: "kk",
      activeScenarioId: "scenario-1",
      activeScenarioName: "Retention",
      currentActionNodeId: "action-2",
      currentPathNodeIds: ["path-1"],
      currentBranchNodeIds: ["branch-1"],
      pendingConditionNodeId: "condition-1",
      pendingSourceActionNodeId: "action-1",
      pendingLinkedConditionId: "linked-1",
      handoffActive: true,
      handoffSource: "agent",
      handoffReason: "requested",
      handoffStartedAt: "2026-08-11T05:55:00.000Z",
      updatedAt: "2026-08-11T06:00:00.000Z",
    },
  });
});

test("keeps concurrent timer invocations bound to their supplied host", async () => {
  const { loadTimerContext } = await import("./context");
  const [first, second] = await Promise.all([
    loadTimerContext("same-conversation", {
      loadConversation: async () => ({
        workspaceId: "workspace-a",
        airi_scenario_state: { lockedScenarioId: "scenario-a" },
      }),
    }),
    loadTimerContext("same-conversation", {
      loadConversation: async () => ({
        workspaceId: "workspace-b",
        airi_scenario_state: { lockedScenarioId: "scenario-b" },
      }),
    }),
  ]);
  assert.equal(first?.projection.activeScenarioId, "scenario-a");
  assert.equal(second?.projection.activeScenarioId, "scenario-b");
});
