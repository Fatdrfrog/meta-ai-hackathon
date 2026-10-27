import connectDB from "@/lib/mongoose";
import { signalWithStartAiriConversationExternalEvent } from "@/lib/temporal/client";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import { Scenario } from "@/models/scenario";
import type { Channel } from "@/types/models";
import { persistRecoveredPendingConditionState } from "@/lib/airi/reply/runtime/auto-reply-scenario-state";
import { isScenarioPendingWriteCoordinationError } from "@icecore/airi-runtime/scenario-runtime-dependencies";

import {
  compileScenarioGraph,
  parseEdges,
  parseNodes,
} from "@icecore/airi-runtime/scenario-graph";
import {
  normalizeConversationScenarioState,
  type ConversationScenarioState,
} from "@icecore/airi-runtime/scenario-state";
import { readId } from "@/lib/scenarios/read-id";
import { planPostActionTimerRecovery } from "./plan";
import { buildTimerReplanMessageId } from "./identity";

type RecoveryConversation = {
  _id: unknown;
  channel?: string | null;
  sourceId?: string | null;
  airi_handoff_active?: boolean | null;
  airi_scenario_state?: unknown;
};

type RecoveryScenario = {
  nodes?: unknown;
  edges?: unknown;
};

type RecoveryMessage = {
  _id: unknown;
  date?: Date | string | null;
  origin?: {
    scenarioId?: string | null;
    nodeId?: string | null;
  } | null;
  delivery?: { status?: string | null } | null;
};

export type RecoverPostActionTimerResult = {
  conversationId: string;
  status:
    | "conflict"
    | "dry_run_recover"
    | "dry_run_replan"
    | "recovered"
    | "replanned"
    | "skipped";
  reason?: string;
  dueAt?: string;
  conditionNodeId?: string;
  sourceActionNodeId?: string;
};

async function signalTimerReplan(params: {
  workspaceId: string;
  conversationId: string;
  channel: Channel;
  sourceId: string | null;
  messageId: string;
  messageDate: string;
  enqueuedAt: string;
}) {
  return signalWithStartAiriConversationExternalEvent({
    kind: "timer_replan",
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    channel: params.channel,
    sourceId: params.sourceId,
    messageId: params.messageId,
    messageDate: params.messageDate,
    enqueuedAt: params.enqueuedAt,
  });
}

async function replanPendingPostActionTimer(params: {
  workspaceId: string;
  conversationId: string;
  conversation: RecoveryConversation;
  state: ConversationScenarioState;
  apply: boolean;
  now: Date;
}): Promise<RecoverPostActionTimerResult> {
  const scenarioId = params.state.lockedScenarioId?.trim() || "";
  const sourceActionNodeId =
    params.state.pendingSourceActionNodeId?.trim() || "";
  const channel = String(params.conversation.channel || "") as Channel;
  const sourceId = params.conversation.sourceId?.trim() || null;
  if (!scenarioId || !sourceActionNodeId || !channel) {
    return {
      conversationId: params.conversationId,
      status: "skipped",
      reason: "scenario_state_mismatch",
    };
  }

  const messageId = buildTimerReplanMessageId({
    scenarioId,
    actionNodeId: sourceActionNodeId,
    anchorId:
      params.state.pendingLastOutboundMessageId ||
      String(params.state.pendingStartedAt || "pending"),
  });
  const { planAiriConversationTimer } = await import(
    "@icecore/airi-runtime/temporal-scenario-timers"
  );
  const { airiScenarioTimerDependencies } = await import(
    "@/lib/airi/scenario/timer-runtime-dependencies"
  );
  const timerPlan = await planAiriConversationTimer(
    {
      turn: {
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        channel,
        sourceId,
        messageId,
        triggerEventKind: "timer_replan",
        messageDate: params.now.toISOString(),
        enqueuedAt: params.now.toISOString(),
      },
    },
    airiScenarioTimerDependencies
  );
  if (!timerPlan.timer) {
    return {
      conversationId: params.conversationId,
      status: "skipped",
      reason: timerPlan.reason || "timer_not_plannable",
    };
  }
  const isPastDue =
    new Date(timerPlan.timer.dueAt).getTime() <= params.now.getTime();
  if (isPastDue) {
    return {
      conversationId: params.conversationId,
      status: "skipped",
      reason: timerPlan.reason || "deadline_expired",
    };
  }
  if (!params.apply) {
    return {
      conversationId: params.conversationId,
      status: "dry_run_replan",
      dueAt: timerPlan.timer.dueAt,
      conditionNodeId: timerPlan.timer.conditionNodeId || undefined,
      sourceActionNodeId: timerPlan.timer.sourceActionNodeId || undefined,
    };
  }

  await signalTimerReplan({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    channel,
    sourceId,
    messageId,
    messageDate: params.now.toISOString(),
    enqueuedAt: params.now.toISOString(),
  });
  return {
    conversationId: params.conversationId,
    status: "replanned",
    dueAt: timerPlan.timer.dueAt,
    conditionNodeId: timerPlan.timer.conditionNodeId || undefined,
    sourceActionNodeId: timerPlan.timer.sourceActionNodeId || undefined,
  };
}

export async function replanRemappedPostActionTimer(params: {
  workspaceId: string;
  conversationId: string;
  expectedScenarioId: string;
  expectedConditionNodeId: string;
  expectedSourceActionNodeId: string;
  apply?: boolean;
  now?: Date;
  event?: {
    messageId: string;
    messageDate: string;
    enqueuedAt: string;
  };
}): Promise<RecoverPostActionTimerResult> {
  await connectDB();

  const conversation = await Conversation.findOne({
    _id: params.conversationId,
    workspaceId: params.workspaceId,
  })
    .select("_id channel sourceId airi_handoff_active airi_scenario_state")
    .lean<RecoveryConversation | null>();
  if (!conversation) {
    return {
      conversationId: params.conversationId,
      status: "conflict",
      reason: "conversation_state_changed",
    };
  }

  const state = normalizeConversationScenarioState(
    conversation.airi_scenario_state
  );
  if (
    !state ||
    state.lockedScenarioId?.trim() !== params.expectedScenarioId.trim() ||
    state.pendingConditionNodeId?.trim() !==
      params.expectedConditionNodeId.trim() ||
    state.pendingSourceActionNodeId?.trim() !==
      params.expectedSourceActionNodeId.trim()
  ) {
    return {
      conversationId: params.conversationId,
      status: "conflict",
      reason: "conversation_state_changed",
    };
  }

  const channel = String(conversation.channel || "") as Channel;
  if (!channel) {
    return {
      conversationId: params.conversationId,
      status: "conflict",
      reason: "conversation_state_changed",
    };
  }
  const now = params.now || new Date();
  const messageId =
    params.event?.messageId ||
    buildTimerReplanMessageId({
      scenarioId: params.expectedScenarioId,
      actionNodeId: params.expectedSourceActionNodeId,
      anchorId:
        state.pendingLastOutboundMessageId ||
        String(state.pendingStartedAt || "pending"),
    });
  if (params.apply !== true) {
    return {
      conversationId: params.conversationId,
      status: "dry_run_replan",
      conditionNodeId: params.expectedConditionNodeId,
      sourceActionNodeId: params.expectedSourceActionNodeId,
    };
  }

  await signalTimerReplan({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    channel,
    sourceId: conversation.sourceId?.trim() || null,
    messageId,
    messageDate: params.event?.messageDate || now.toISOString(),
    enqueuedAt: params.event?.enqueuedAt || now.toISOString(),
  });
  return {
    conversationId: params.conversationId,
    status: "replanned",
    conditionNodeId: params.expectedConditionNodeId,
    sourceActionNodeId: params.expectedSourceActionNodeId,
  };
}

export async function recoverPostActionTimer(params: {
  workspaceId: string;
  conversationId: string;
  apply?: boolean;
  now?: Date;
}): Promise<RecoverPostActionTimerResult> {
  await connectDB();

  const now = params.now || new Date();
  const conversation = await Conversation.findOne({
    _id: params.conversationId,
    workspaceId: params.workspaceId,
  })
    .select("_id channel sourceId airi_handoff_active airi_scenario_state")
    .lean<RecoveryConversation | null>();
  if (!conversation) {
    return {
      conversationId: params.conversationId,
      status: "skipped",
      reason: "conversation_not_found",
    };
  }

  const state = normalizeConversationScenarioState(
    conversation.airi_scenario_state
  );
  const scenarioId = state?.lockedScenarioId?.trim() || "";
  const actionNodeId = state?.currentActionNodeId?.trim() || "";
  const channel = String(conversation.channel || "") as Channel;
  const sourceId = conversation.sourceId?.trim() || null;
  if (!scenarioId || !channel) {
    return {
      conversationId: params.conversationId,
      status: "skipped",
      reason: !channel ? "invalid_channel" : "scenario_state_mismatch",
    };
  }

  if (state?.pendingConditionNodeId) {
    return replanPendingPostActionTimer({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      conversation,
      state,
      apply: params.apply === true,
      now,
    });
  }

  if (!actionNodeId) {
    return {
      conversationId: params.conversationId,
      status: "skipped",
      reason: "scenario_state_mismatch",
    };
  }

  const scenario = await Scenario.findOne({
    _id: scenarioId,
    workspaceId: params.workspaceId,
    status: "active",
    deletedAt: null,
  })
    .select("nodes edges")
    .lean<RecoveryScenario | null>();
  if (!scenario) {
    return {
      conversationId: params.conversationId,
      status: "skipped",
      reason: "active_scenario_not_found",
    };
  }

  const [outbound, latestMessage] = await Promise.all([
    Message.findOne({
      workspaceId: params.workspaceId,
      conversation: params.conversationId,
      direction: "outbound",
      "origin.kind": "scenario",
      "origin.scenarioId": scenarioId,
      "origin.nodeId": actionNodeId,
    })
      .sort({ date: -1 })
      .select("_id date origin delivery.status")
      .lean<RecoveryMessage | null>(),
    Message.findOne({
      workspaceId: params.workspaceId,
      conversation: params.conversationId,
    })
      .sort({ date: -1 })
      .select("date")
      .lean<Pick<RecoveryMessage, "date"> | null>(),
  ]);
  const graph = compileScenarioGraph(
    parseNodes(scenario.nodes),
    parseEdges(scenario.edges)
  );
  const recoveryPlan = planPostActionTimerRecovery({
    graph,
    state,
    scenarioId,
    conversation: { _id: conversation._id } as never,
    channel,
    handoffActive: Boolean(conversation.airi_handoff_active),
    outbound: outbound
      ? {
          id: readId(outbound._id),
          date: outbound.date || "",
          scenarioId: outbound.origin?.scenarioId || null,
          actionNodeId: outbound.origin?.nodeId || null,
          deliveryStatus: outbound.delivery?.status || null,
        }
      : null,
    latestMessageAt: latestMessage?.date || null,
    now,
  });
  if (recoveryPlan.status === "skip") {
    return {
      conversationId: params.conversationId,
      status: "skipped",
      reason: recoveryPlan.reason,
    };
  }
  if (!params.apply) {
    return {
      conversationId: params.conversationId,
      status: "dry_run_recover",
      dueAt: recoveryPlan.dueAt,
      conditionNodeId: recoveryPlan.patch.pendingConditionNodeId,
      sourceActionNodeId: recoveryPlan.patch.pendingSourceActionNodeId,
    };
  }

  let persistedPending: Awaited<
    ReturnType<typeof persistRecoveredPendingConditionState>
  >;
  try {
    persistedPending = await persistRecoveredPendingConditionState({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      scenarioId,
      sourceActionNodeId: recoveryPlan.patch.pendingSourceActionNodeId,
      conditionNodeId: recoveryPlan.patch.pendingConditionNodeId,
      pendingStartedAt: recoveryPlan.patch.pendingStartedAt,
      pendingLastOutboundMessageId:
        recoveryPlan.patch.pendingLastOutboundMessageId,
      pendingLinkedConditionId: recoveryPlan.patch.pendingLinkedConditionId,
      pendingLegacyRouting: recoveryPlan.patch.pendingLegacyRouting,
      expectedCurrentActionNodeId: actionNodeId,
    });
  } catch (error) {
    if (
      isScenarioPendingWriteCoordinationError(error) &&
      error.code === "conversation_state_changed"
    ) {
      return {
        conversationId: params.conversationId,
        status: "conflict",
        reason: "conversation_state_changed",
      };
    }
    throw error;
  }

  const messageId = buildTimerReplanMessageId({
    scenarioId,
    actionNodeId: persistedPending.sourceActionNodeId,
    anchorId: recoveryPlan.patch.pendingLastOutboundMessageId,
  });
  await signalTimerReplan({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    channel,
    sourceId,
    messageId,
    messageDate: now.toISOString(),
    enqueuedAt: now.toISOString(),
  });

  return {
    conversationId: params.conversationId,
    status: "recovered",
    dueAt: recoveryPlan.dueAt,
    conditionNodeId: persistedPending.conditionNodeId,
    sourceActionNodeId: persistedPending.sourceActionNodeId,
  };
}
