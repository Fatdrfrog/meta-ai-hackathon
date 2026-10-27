import assert from "node:assert/strict";
import test from "node:test";
import type { AiriConversationTurnSignal } from "@icecore/temporal";
import {
  timerHost,
  waitingConversation,
  waitTimer,
  withAutoReplyEnv,
} from "../testing";
import type { TimerConversationRecord } from "../types";
import { planAiriConversationTimer } from "./index";
import { buildAiriConversationTimerTurn } from "../prepare/index";

const turn: AiriConversationTurnSignal = {
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  messageId:
    "scenario-timeout:post_action_no_reply_timeout:scenario-1:2026-05-01T00:00:00.000Z",
  channel: "whatsapp",
  triggerEventKind: "no_human_reply_timeout",
};

test("plans the waiting conversation's timer while automation is on", async () => {
  const toggles: TimerConversationRecord[] = [];
  const result = await withAutoReplyEnv(undefined, () =>
    planAiriConversationTimer(
      { turn },
      timerHost({
        resolveScenariosEnabled: async (conversation) => {
          toggles.push(conversation);
          return true;
        },
      }),
    ),
  );

  assert.deepEqual(result.timer, waitTimer());
  assert.equal(result.reason, "pending_post_action_condition");
  assert.deepEqual(toggles, [waitingConversation()]);
});

for (const checkpoint of ["missing_id", "missing_message", "failed"] as const) {
  test(`does not arm a follow-up after an unsent action (${checkpoint})`, async () => {
    const conversation = waitingConversation();
    if (checkpoint === "missing_id")
      conversation.airi_scenario_state!.pendingLastOutboundMessageId = null;
    const result = await withAutoReplyEnv(undefined, () =>
      planAiriConversationTimer(
        { turn },
        timerHost({
          loadConversation: async () => conversation,
          findPendingOutbound: async () =>
            checkpoint === "failed" ? { delivery: { status: "failed" } } : null,
        }),
      ),
    );

    assert.equal(result.timer, null);
    assert.equal(result.projection?.activeScenarioId, "scenario-1");
    assert.equal(result.projection?.pendingConditionNodeId, "condition-1");
  });
}

for (const checkpoint of [
  "missing_id",
  "missing_message",
  "reserved",
  "failed",
] as const) {
  test(`a previously armed timer cannot consume an unsent action (${checkpoint})`, async () => {
    const conversation = waitingConversation();
    const timer = waitTimer();
    if (checkpoint === "missing_id") {
      conversation.airi_scenario_state!.pendingLastOutboundMessageId = null;
      timer.pendingLastOutboundMessageId = null;
    }
    let completed = false;
    const result = await withAutoReplyEnv(undefined, () =>
      buildAiriConversationTimerTurn(
        timer,
        timerHost({
          loadConversation: async () => conversation,
          findPendingOutbound: async () =>
            checkpoint === "reserved"
              ? { channel: "whatsapp", temporalDispatch: { state: "reserved" } }
              : checkpoint === "failed"
                ? { delivery: { status: "failed" } }
                : null,
          completeLockedScenarioAndPersist: async () => {
            completed = true;
            return { persisted: true, state: {}, completedAt: new Date() };
          },
        }),
      ),
    );
    assert.equal(result.turn, null);
    assert.equal(completed, false);
    assert.equal(result.reason, "pending_outbound_unconfirmed");
    assert.equal(result.projection?.pendingConditionNodeId, "condition-1");
  });
}

test("plans no timer when the conversation's scenarios are disabled", async () => {
  const result = await withAutoReplyEnv(undefined, () =>
    planAiriConversationTimer(
      { turn },
      timerHost({ resolveScenariosEnabled: async () => false }),
    ),
  );

  assert.equal(result.timer, null);
  assert.equal(result.reason, "scenarios_disabled");
  // The projection still refreshes the workflow's view of the paused wait.
  assert.equal(result.projection?.activeScenarioId, "scenario-1");
  assert.equal(result.projection?.pendingConditionNodeId, "condition-1");
});

test("plans no timer while AIRI_AUTO_REPLY is off, without resolving the toggle", async () => {
  for (const value of ["false", "0", ""]) {
    const result = await withAutoReplyEnv(value, () =>
      planAiriConversationTimer(
        { turn },
        timerHost({
          resolveScenariosEnabled: async () => {
            throw new Error("The toggle must not be read");
          },
        }),
      ),
    );

    assert.equal(result.timer, null, `AIRI_AUTO_REPLY=${value}`);
    assert.equal(result.reason, "auto_reply_disabled");
  }
});

test("reads no toggle for a conversation without a wait", async () => {
  const result = await withAutoReplyEnv(undefined, () =>
    planAiriConversationTimer(
      { turn },
      timerHost({
        loadConversation: async () =>
          waitingConversation({ airi_scenario_state: null }),
        resolveScenariosEnabled: async () => {
          throw new Error("The toggle must not be read");
        },
      }),
    ),
  );

  assert.equal(result.timer, null);
  assert.equal(result.reason, "no_timer");
});

test("propagates a toggle read failure so the planning activity retries", async () => {
  const failure = new Error("workspace settings unavailable");
  await assert.rejects(
    withAutoReplyEnv(undefined, () =>
      planAiriConversationTimer(
        { turn },
        timerHost({
          resolveScenariosEnabled: async () => {
            throw failure;
          },
        }),
      ),
    ),
    (error) => error === failure,
  );
});
