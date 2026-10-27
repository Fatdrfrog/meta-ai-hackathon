import type { AiriConversationTimerDescriptor } from "@icecore/temporal";
import type { AiriScenarioTimerDependencies } from "./dependencies";
import type { ScenarioRecord, TimerConversationRecord } from "./types";

/** Test fixtures: one conversation waiting 60 minutes on a no-reply branch. */
export const WAIT_STARTED_AT = "2026-05-01T00:00:00.000Z";
export const LATEST_ACTIVITY_AT = "2026-05-01T00:30:00.000Z";
export const WAIT_DUE_AT = "2026-05-01T01:30:00.000Z";

export function waitingConversation(
  overrides: Partial<TimerConversationRecord> = {},
): TimerConversationRecord {
  return {
    _id: "conversation-1",
    workspaceId: "workspace-1",
    channel: "whatsapp",
    sourceId: "source-1",
    airi_scenario_state: {
      lockedScenarioId: "scenario-1",
      lockedScenarioName: "Follow-up scenario",
      currentActionNodeId: "action-1",
      pendingConditionNodeId: "condition-1",
      pendingSourceActionNodeId: "action-1",
      pendingStartedAt: WAIT_STARTED_AT,
      pendingLastOutboundMessageId: "message-out-1",
    },
    ...overrides,
  };
}

export function noReplyScenario(): ScenarioRecord {
  return {
    _id: "scenario-1",
    name: "Follow-up scenario",
    nodes: [
      {
        id: "condition-1",
        data: {
          kind: "logic",
          logicType: "post_action_condition",
          conditionBranches: [
            {
              id: "no_reply_timeout",
              type: "no_reply_timeout",
              timeoutMinutes: 60,
            },
          ],
        },
      },
      { id: "follow-up-action", data: { kind: "action", actionType: "reply" } },
    ],
    edges: [
      {
        source: "condition-1",
        target: "follow-up-action",
        sourceHandle: "right-source-condition-no_reply_timeout",
      },
    ],
  };
}

export function waitTimer(): AiriConversationTimerDescriptor {
  return {
    kind: "post_action_no_reply_timeout",
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    channel: "whatsapp",
    sourceId: "source-1",
    scenarioId: "scenario-1",
    scenarioName: "Follow-up scenario",
    dueAt: WAIT_DUE_AT,
    triggerNodeId: null,
    conditionNodeId: "condition-1",
    sourceActionNodeId: "action-1",
    linkedConditionId: null,
    waitStartedAt: WAIT_STARTED_AT,
    pendingLastOutboundMessageId: "message-out-1",
    lastInboundMessageId: null,
    lastInboundAt: LATEST_ACTIVITY_AT,
    lastInboundText: null,
  };
}

/** Reads storage for the waiting conversation; any effect not overridden throws. */
export function timerHost(
  overrides: Partial<AiriScenarioTimerDependencies> = {},
): AiriScenarioTimerDependencies {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected host effect");
  };
  return {
    connectDB: async () => undefined,
    loadConversation: async () => waitingConversation(),
    resolveScenariosEnabled: async () => true,
    loadScenario: async () => noReplyScenario(),
    findLatestMessageAfter: async () => ({ date: LATEST_ACTIVITY_AT }),
    findTextMessagesAfter: async () => [],
    findPendingOutbound: async () => ({ delivery: { status: "sent" } }),
    completeLockedScenarioAndPersist: unexpected,
    buildTimerTurnSignal: unexpected,
    generativeAIResult: {
      readOwner: unexpected,
      loadAsset: unexpected,
      hydrateOriginalInbound: unexpected,
      captureOutbound: unexpected,
      claimDelivery: unexpected,
      nowIso: () => LATEST_ACTIVITY_AT,
    },
    ...overrides,
  };
}

/** Runs with AIRI_AUTO_REPLY set (or unset) and restores the previous value. */
export async function withAutoReplyEnv<T>(
  value: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env.AIRI_AUTO_REPLY;
  const assign = (next: string | undefined) => {
    if (next === undefined) delete process.env.AIRI_AUTO_REPLY;
    else process.env.AIRI_AUTO_REPLY = next;
  };
  assign(value);
  try {
    return await run();
  } finally {
    assign(previous);
  }
}
