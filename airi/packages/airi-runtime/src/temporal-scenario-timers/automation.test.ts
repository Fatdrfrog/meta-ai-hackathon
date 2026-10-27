import assert from "node:assert/strict";
import test from "node:test";
import type { AiriConversationControlExternalEvent } from "@icecore/temporal";
import { resolveTimerTurnSkipReason } from "./automation";
import { handleAiriConversationExternalEvent } from "./external-events/index";
import { buildAiriConversationTimerTurn } from "./prepare/index";
import {
  timerHost,
  waitingConversation,
  waitTimer,
  withAutoReplyEnv,
} from "./testing";

const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected host effect");
};

function controlEvent(
  kind: AiriConversationControlExternalEvent["kind"],
): AiriConversationControlExternalEvent {
  return {
    kind,
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    messageId: `${kind}:message-1`,
    channel: "whatsapp",
  };
}

test("the timer gate mirrors the reply runtime's switch and scenario toggle", async () => {
  const conversation = waitingConversation();
  for (const [value, expected] of [
    [undefined, null],
    ["true", null],
    ["TRUE", null],
    ["false", "auto_reply_disabled"],
    ["off", "auto_reply_disabled"],
  ] as const) {
    assert.equal(
      await withAutoReplyEnv(value, () =>
        resolveTimerTurnSkipReason(conversation, {
          resolveScenariosEnabled: async () => true,
        }),
      ),
      expected,
      `AIRI_AUTO_REPLY=${value}`,
    );
  }
  assert.equal(
    await withAutoReplyEnv(undefined, () =>
      resolveTimerTurnSkipReason(conversation, {
        resolveScenariosEnabled: async () => false,
      }),
    ),
    "scenarios_disabled",
  );
});

for (const [label, env, scenariosEnabled, reason] of [
  ["scenarios are disabled", undefined, false, "scenarios_disabled"],
  ["AIRI_AUTO_REPLY is off", "false", true, "auto_reply_disabled"],
] as const) {
  test(`a fired timer is dropped before any effect when ${label}`, async () => {
    // No scenario load, message scan, scenario completion, or turn context.
    const result = await withAutoReplyEnv(env, () =>
      buildAiriConversationTimerTurn(
        waitTimer(),
        timerHost({
          resolveScenariosEnabled: async () => scenariosEnabled,
          loadScenario: unexpected,
          findLatestMessageAfter: unexpected,
          findTextMessagesAfter: unexpected,
        }),
      ),
    );

    assert.equal(result.turn, null);
    assert.equal(result.timer, undefined);
    assert.equal(result.reason, reason);
    assert.equal(result.projection?.pendingConditionNodeId, "condition-1");
  });
}

test("timer replans and human replies do not arm the wait's timer when scenarios are disabled", async () => {
  const dependencies = timerHost({ resolveScenariosEnabled: async () => false });
  const replan = await withAutoReplyEnv(undefined, () =>
    handleAiriConversationExternalEvent(
      controlEvent("timer_replan"),
      dependencies,
    ),
  );
  assert.equal(replan.timer, null);
  assert.equal(replan.clearTimer, true);

  const humanReply = await withAutoReplyEnv(undefined, () =>
    handleAiriConversationExternalEvent(
      controlEvent("human_outbound"),
      dependencies,
    ),
  );
  assert.equal(humanReply.timer, null);
  assert.equal(humanReply.projection?.pendingConditionNodeId, "condition-1");
});

test("timer replans and human replies arm the wait's timer while automation is on", async () => {
  for (const kind of ["timer_replan", "human_outbound"] as const) {
    const result = await withAutoReplyEnv(undefined, () =>
      handleAiriConversationExternalEvent(controlEvent(kind), timerHost()),
    );
    assert.deepEqual(result.timer, waitTimer(), kind);
    assert.equal(result.clearTimer, false, kind);
  }
});
