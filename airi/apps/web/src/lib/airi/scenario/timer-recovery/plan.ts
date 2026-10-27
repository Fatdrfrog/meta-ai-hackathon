import { resolveScenarioDispatchTransition } from "@/lib/airi/scenario/scenario-post-action-routing";
import type { CompiledScenarioGraph } from "@icecore/airi-runtime/scenario-graph";
import type { ConversationScenarioState } from "@icecore/airi-runtime/scenario-state";
import type { ScenarioPendingLegacyRouting } from "@icecore/airi-runtime/scenario-state";
import { normalizeActionType } from "@/lib/scenarios/normalization";
import {
  getPostActionConditionBranch,
  getPostActionConditionHandleId,
} from "@icecore/scenario-contracts";
import type { Channel, ConversationDocument } from "@/types/models";
import { readDate as parseDate } from "@icecore/shared/lib/value-utils";

export type PostActionTimerRecoverySkipReason =
  | "already_pending"
  | "deadline_expired"
  | "handoff_active"
  | "invalid_outbound_date"
  | "newer_activity"
  | "no_recoverable_condition"
  | "outbound_failed"
  | "outbound_not_current"
  | "scenario_state_mismatch";

export type PostActionTimerRecoveryPlan =
  | {
      status: "recover";
      dueAt: string;
      patch: {
        pendingConditionNodeId: string;
        pendingSourceActionNodeId: string;
        pendingStartedAt: Date;
        pendingLastOutboundMessageId: string;
        pendingLinkedConditionId: string | null;
        pendingLegacyRouting: ScenarioPendingLegacyRouting | null;
      };
    }
  | { status: "skip"; reason: PostActionTimerRecoverySkipReason };

type RecoveryOutbound = {
  id: string;
  date: Date | string;
  scenarioId: string | null;
  actionNodeId: string | null;
  deliveryStatus: string | null;
};

export function planPostActionTimerRecovery(params: {
  graph: CompiledScenarioGraph;
  state: ConversationScenarioState | null;
  scenarioId: string;
  conversation: Omit<Partial<ConversationDocument>, "_id"> & { _id: unknown };
  channel: Channel;
  handoffActive: boolean;
  outbound: RecoveryOutbound | null;
  latestMessageAt: Date | string | null;
  now: Date;
}): PostActionTimerRecoveryPlan {
  const state = params.state;
  const actionNodeId = state?.currentActionNodeId?.trim() || "";
  if (
    !state?.lockedScenarioId ||
    state.lockedScenarioId !== params.scenarioId ||
    !actionNodeId
  ) {
    return { status: "skip", reason: "scenario_state_mismatch" };
  }
  if (state.pendingConditionNodeId) {
    return { status: "skip", reason: "already_pending" };
  }

  const outbound = params.outbound;
  if (
    !outbound ||
    outbound.scenarioId !== params.scenarioId ||
    outbound.actionNodeId !== actionNodeId
  ) {
    return { status: "skip", reason: "outbound_not_current" };
  }
  if (outbound.deliveryStatus === "failed") {
    return { status: "skip", reason: "outbound_failed" };
  }

  const outboundAt = parseDate(outbound.date);
  if (!outboundAt) {
    return { status: "skip", reason: "invalid_outbound_date" };
  }
  const lastMatchedAt = parseDate(state.lastMatchedAt);
  if (!lastMatchedAt || outboundAt.getTime() < lastMatchedAt.getTime()) {
    return { status: "skip", reason: "outbound_not_current" };
  }
  const latestMessageAt = parseDate(params.latestMessageAt);
  if (latestMessageAt && latestMessageAt.getTime() > outboundAt.getTime()) {
    return { status: "skip", reason: "newer_activity" };
  }

  const actionNode = params.graph.nodesById.get(actionNodeId);
  const actionType = actionNode ? normalizeActionType(actionNode.data) : null;
  if (!actionNode || actionNode.data.kind !== "action" || !actionType) {
    return { status: "skip", reason: "no_recoverable_condition" };
  }

  const transition = resolveScenarioDispatchTransition({
    graph: params.graph,
    selectedAction: actionNode,
    selectedActionType: actionType,
    selectedPathNodeIds: state.currentPathNodeIds,
    conversation: params.conversation as ConversationDocument,
    channel: params.channel,
  });
  const conditionNodeId = transition.pendingConditionNodeId?.trim() || "";
  const sourceActionNodeId = transition.pendingSourceActionNodeId?.trim() || "";
  const conditionNode = conditionNodeId
    ? params.graph.nodesById.get(conditionNodeId)
    : null;
  const noReplyHandle = getPostActionConditionHandleId("no_reply_timeout");
  const hasNoReplyTarget = params.graph.edges.some(
    edge =>
      edge.source === conditionNodeId &&
      edge.sourceHandle === noReplyHandle &&
      typeof edge.target === "string" &&
      Boolean(params.graph.nodesById.get(edge.target))
  );
  if (
    !conditionNode ||
    conditionNode.data.kind !== "logic" ||
    !sourceActionNodeId ||
    !hasNoReplyTarget
  ) {
    return { status: "skip", reason: "no_recoverable_condition" };
  }

  const noReplyBranch = getPostActionConditionBranch(
    conditionNode.data,
    "no_reply_timeout"
  );
  const timeoutMinutes = Math.max(
    1,
    Math.floor(Number(noReplyBranch.timeoutMinutes || 0) || 0)
  );
  const dueAt = new Date(outboundAt.getTime() + timeoutMinutes * 60_000);
  if (dueAt.getTime() <= params.now.getTime()) {
    return { status: "skip", reason: "deadline_expired" };
  }

  return {
    status: "recover",
    dueAt: dueAt.toISOString(),
    patch: {
      pendingConditionNodeId: conditionNodeId,
      pendingSourceActionNodeId: sourceActionNodeId,
      pendingStartedAt: outboundAt,
      pendingLastOutboundMessageId: outbound.id,
      pendingLinkedConditionId: transition.pendingLinkedConditionId || null,
      pendingLegacyRouting: transition.pendingLegacyRouting || null,
    },
  };
}
