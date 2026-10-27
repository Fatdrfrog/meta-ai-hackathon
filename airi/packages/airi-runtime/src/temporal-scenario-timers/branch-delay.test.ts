import assert from "node:assert/strict";
import test from "node:test";
import type {
  AiriConversationTimerDescriptor,
  AiriConversationTurnSignal,
} from "@icecore/temporal";
import {
  buildWhatsAppTemplateButtonSourceHandleId,
  getScenarioActionBranchDelayVirtualNodeId,
} from "@icecore/scenario-contracts";
import type { AiriScenarioTimerDependencies } from "./dependencies";
import { planAiriConversationTimer } from "./plan/index";
import { buildAiriConversationTimerTurn } from "./prepare/index";
import {
  LATEST_ACTIVITY_AT,
  WAIT_STARTED_AT,
  timerHost,
  waitingConversation,
  withAutoReplyEnv,
} from "./testing";
import type { ScenarioRecord } from "./types";

const kazakh = buildWhatsAppTemplateButtonSourceHandleId(0);
const delayWaitId = getScenarioActionBranchDelayVirtualNodeId("menu", kazakh);
const DELAY_MINUTES = 90;

/** A tapped Kazakh button waits 90 quiet minutes unless "Order accepted" appears. */
function delayedScenario(): ScenarioRecord {
  return {
    _id: "scenario-1",
    name: "Follow-up scenario",
    nodes: [
      {
        id: "menu",
        data: {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: "pick_lang",
          actionWhatsAppTemplateComponents: [
            {
              type: "BUTTONS",
              buttons: [{ type: "QUICK_REPLY", text: "Kazakh" }],
            },
          ],
          actionOutcomes: {
            version: 1,
            branchDelays: [
              {
                sourceHandle: kazakh,
                delayMinutes: DELAY_MINUTES,
                cancelIfPhrases: ["Order accepted"],
              },
            ],
          },
        },
      },
      { id: "kazakh", data: { kind: "action", actionType: "reply" } },
    ],
    edges: [{ source: "menu", sourceHandle: kazakh, target: "kazakh" }],
  };
}

const tappedConversation = () =>
  waitingConversation({
    airi_scenario_state: {
      lockedScenarioId: "scenario-1",
      lockedScenarioName: "Follow-up scenario",
      currentActionNodeId: "menu",
      pendingConditionNodeId: delayWaitId,
      pendingSourceActionNodeId: "menu",
      pendingStartedAt: WAIT_STARTED_AT,
      pendingLastOutboundMessageId: "message-out-1",
    },
  });

const turn: AiriConversationTurnSignal = {
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  messageId: "message-tap-1",
  channel: "whatsapp",
  triggerEventKind: "whatsapp_button_reply",
};

function delayHost(
  overrides: Partial<AiriScenarioTimerDependencies> = {},
): AiriScenarioTimerDependencies {
  return timerHost({
    loadConversation: async () => tappedConversation(),
    loadScenario: async () => delayedScenario(),
    findPendingOutbound: async ({ messageId, sourceActionNodeId }) =>
      messageId === "message-out-1" && sourceActionNodeId === "menu"
        ? { delivery: { status: "read" } }
        : null,
    ...overrides,
  });
}

async function planDelayTimer(): Promise<AiriConversationTimerDescriptor> {
  const plan = await withAutoReplyEnv(undefined, () =>
    planAiriConversationTimer({ turn }, delayHost()),
  );
  assert.ok(plan.timer, `expected a timer, got ${plan.reason}`);
  return plan.timer;
}

test("plans a tapped CTA's quiet period from its own delay", async () => {
  const timer = await planDelayTimer();

  assert.equal(timer.conditionNodeId, delayWaitId);
  assert.equal(timer.sourceActionNodeId, "menu");
  assert.equal(timer.waitStartedAt, WAIT_STARTED_AT);
  assert.equal(timer.pendingLastOutboundMessageId, "message-out-1");
  assert.equal(
    timer.dueAt,
    new Date(
      Date.parse(LATEST_ACTIVITY_AT) + DELAY_MINUTES * 60_000,
    ).toISOString(),
  );
});

test("prepares the follow-up turn after the quiet period", async () => {
  const timer = await planDelayTimer();
  const signals: unknown[] = [];

  const result = await withAutoReplyEnv(undefined, () =>
    buildAiriConversationTimerTurn(
      timer,
      delayHost({
        findTextMessagesAfter: async () => [{ text: "Thanks!" }],
        buildTimerTurnSignal: async (input) => {
          signals.push(input);
          return { ...turn, messageId: input.messageId };
        },
      }),
    ),
  );

  assert.equal(result.reason, "timer_turn_ready");
  assert.equal(signals.length, 1);
  assert.equal(
    result.turn?.messageId,
    `scenario-timeout:post_action_no_reply_timeout:scenario-1:${WAIT_STARTED_AT}`,
  );
});

test("cancels the follow-up when a stop phrase appears, including in the business's own message", async () => {
  const timer = await planDelayTimer();
  const completions: unknown[] = [];

  const result = await withAutoReplyEnv(undefined, () =>
    buildAiriConversationTimerTurn(
      timer,
      delayHost({
        // The host reads chat text in both directions.
        findTextMessagesAfter: async () => [
          { text: "Спасибо!" },
          { text: "Your ORDER accepted, we will call you" },
        ],
        completeLockedScenarioAndPersist: async (input) => {
          completions.push(input);
          return { state: {}, completedAt: new Date(), persisted: true };
        },
      }),
    ),
  );

  assert.equal(result.turn, null);
  assert.equal(result.reason, "missing_text_phrase_detected");
  assert.deepEqual(completions, [
    {
      conversationId: "conversation-1",
      baseState: tappedConversation().airi_scenario_state,
      scenarioId: "scenario-1",
      scenarioName: "Follow-up scenario",
      completionTimestamp: (completions[0] as { completionTimestamp: Date })
        .completionTimestamp,
      lastActionNodeId: "menu",
      lastMessageId: "message-out-1",
      expectedPendingState: {
        conditionNodeId: delayWaitId,
        sourceActionNodeId: "menu",
        pendingStartedAt: WAIT_STARTED_AT,
        lastOutboundMessageId: "message-out-1",
      },
    },
  ]);
});
