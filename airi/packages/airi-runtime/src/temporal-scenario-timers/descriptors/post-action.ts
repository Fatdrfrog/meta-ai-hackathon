import type {
  AiriConversationProjection,
  AiriConversationTimerDescriptor,
} from "@icecore/temporal";
import {
  normalizeOptionalString,
  parseDate,
} from "../../internal/value-normalization";
import { loadScenarioForTimer } from "../context";
import {
  getPostActionConditionBranch,
  normalizeScenarioActionOutcomes,
  resolvePostActionQuietPeriodDueAt,
  SCENARIO_LOCATION_RESCUE_DELAY_MS,
} from "@icecore/scenario-contracts";
import { getCompiledScenarioGraph } from "../../scenario-graph";
import { isScenarioOutboundCheckpointConfirmed } from "../../scenario-state";
import { findUndecidedScenarioLocationShare } from "../../scenario-location-turn";
import type { ScenarioSharedLocationMessage } from "../../scenario-runtime-dependencies";
import type { AiriScenarioTimerDependencies } from "../dependencies";
import { resolvePendingPostActionWait } from "../graph/post-action";
import { findLatestConversationMessageDateAfter } from "../messages/index";
import type { TimerConversationRecord } from "../types";

/**
 * A rescue timer routes a location share no turn decided. It names that
 * share; the wait's No reply timer names no inbound message.
 */
export function readPostActionLocationRescueMessageId(
  timer: Pick<AiriConversationTimerDescriptor, "kind" | "lastInboundMessageId">,
): string | null {
  return timer.kind === "post_action_no_reply_timeout"
    ? normalizeOptionalString(timer.lastInboundMessageId)
    : null;
}

/** The share a location step's wait has not decided yet, if any. */
async function findLocationRescueShare(
  params: {
    graph: ReturnType<typeof getCompiledScenarioGraph>;
    workspaceId: string;
    conversationId: string;
    scenarioState: unknown;
    scenarioId: string;
    sourceActionNodeId: string;
    waitStartedAt: Date;
  },
  dependencies: AiriScenarioTimerDependencies,
): Promise<ScenarioSharedLocationMessage | null> {
  if (!dependencies.findLatestInboundLocation) return null;
  const sourceAction = params.graph.nodesById.get(params.sourceActionNodeId);
  const outcomes = normalizeScenarioActionOutcomes(
    sourceAction?.data.kind === "action"
      ? sourceAction.data.actionOutcomes
      : undefined,
  );
  if (outcomes.status !== "supported" || !outcomes.value.locationRoutes) {
    return null;
  }
  return findUndecidedScenarioLocationShare({
    findLatestInboundLocation: dependencies.findLatestInboundLocation,
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    scenarioState: params.scenarioState,
    scenarioId: params.scenarioId,
    waitStartedAt: params.waitStartedAt,
    until: new Date(),
  });
}

export async function buildPostActionTimerDescriptor(
  params: {
    conversation: TimerConversationRecord;
    projection: AiriConversationProjection;
    latestActivityAt?: Date | null;
    scenario?: Parameters<typeof getCompiledScenarioGraph>[0];
    graph?: ReturnType<typeof getCompiledScenarioGraph>;
  },
  dependencies: AiriScenarioTimerDependencies,
): Promise<AiriConversationTimerDescriptor | null> {
  const scenarioState = params.conversation.airi_scenario_state || null;
  const workspaceId = normalizeOptionalString(params.conversation.workspaceId);
  const conversationId = normalizeOptionalString(params.conversation._id);
  const scenarioId = normalizeOptionalString(scenarioState?.lockedScenarioId);
  const conditionNodeId = normalizeOptionalString(
    scenarioState?.pendingConditionNodeId,
  );
  const sourceActionNodeId = normalizeOptionalString(
    scenarioState?.pendingSourceActionNodeId,
  );
  const waitStartedAt = parseDate(scenarioState?.pendingStartedAt);

  if (
    !workspaceId ||
    !conversationId ||
    !scenarioId ||
    !conditionNodeId ||
    !sourceActionNodeId ||
    !waitStartedAt
  ) {
    return null;
  }

  const scenario =
    params.scenario ||
    (await loadScenarioForTimer(workspaceId, scenarioId, dependencies));
  if (!scenario) {
    return null;
  }

  const graph = params.graph || getCompiledScenarioGraph(scenario);
  const wait = resolvePendingPostActionWait({ graph, conditionNodeId });
  if (wait.status !== "waiting") {
    return null;
  }

  // A location step's wait routes a share its own turn missed a minute after
  // it arrived, unless the No reply reminder is due first; that turn routes
  // the share instead of reminding. A wait without No reply still rescues.
  const rescueShare = await findLocationRescueShare(
    {
      graph,
      workspaceId,
      conversationId,
      scenarioState,
      scenarioId,
      sourceActionNodeId,
      waitStartedAt,
    },
    dependencies,
  );
  if (!wait.hasNoReplyBranch && !rescueShare) {
    return null;
  }

  let latestActivityAt: Date | null = null;
  let noReplyDueAt: Date | null = null;
  if (wait.hasNoReplyBranch) {
    const noReplyBranch = getPostActionConditionBranch(
      wait.conditionNode.data,
      "no_reply_timeout",
    );
    const timeoutMinutes = Math.max(
      1,
      Math.floor(Number(noReplyBranch.timeoutMinutes || 0) || 0),
    );
    latestActivityAt =
      "latestActivityAt" in params
        ? params.latestActivityAt || null
        : await findLatestConversationMessageDateAfter(
            {
              conversationId,
              after: waitStartedAt,
            },
            dependencies,
          );
    noReplyDueAt = resolvePostActionQuietPeriodDueAt({
      waitStartedAt,
      latestActivityAt,
      timeoutMinutes,
    });
  }

  const rescueDueAt = rescueShare
    ? new Date(rescueShare.date.getTime() + SCENARIO_LOCATION_RESCUE_DELAY_MS)
    : null;
  const rescue =
    rescueShare &&
    rescueDueAt &&
    (!noReplyDueAt || rescueDueAt.getTime() < noReplyDueAt.getTime())
      ? { share: rescueShare, dueAt: rescueDueAt }
      : null;
  if (rescue || noReplyDueAt) {
    // Preparation records the selected action before delivery. Its wait is not
    // eligible to follow up until that exact action has a persisted outbound.
    const pendingOutboundMessageId = normalizeOptionalString(
      scenarioState?.pendingLastOutboundMessageId,
    );
    const pendingOutbound = pendingOutboundMessageId
      ? await dependencies.findPendingOutbound({
          messageId: pendingOutboundMessageId,
          workspaceId,
          conversationId,
          scenarioId,
          sourceActionNodeId,
        })
      : null;
    if (!isScenarioOutboundCheckpointConfirmed(pendingOutbound)) {
      return null;
    }
  }
  const dueAt = rescue?.dueAt ?? noReplyDueAt;
  if (!dueAt) {
    return null;
  }

  return {
    kind: "post_action_no_reply_timeout",
    workspaceId,
    conversationId,
    channel: normalizeOptionalString(params.conversation.channel),
    sourceId: normalizeOptionalString(params.conversation.sourceId),
    scenarioId,
    scenarioName:
      normalizeOptionalString(scenario.name) ||
      params.projection.activeScenarioName,
    dueAt: dueAt.toISOString(),
    triggerNodeId: null,
    conditionNodeId,
    sourceActionNodeId,
    linkedConditionId:
      normalizeOptionalString(scenarioState?.pendingLinkedConditionId) ||
      params.projection.pendingLinkedConditionId,
    waitStartedAt: waitStartedAt.toISOString(),
    pendingLastOutboundMessageId: normalizeOptionalString(
      scenarioState?.pendingLastOutboundMessageId,
    ),
    lastInboundMessageId: rescue?.share.messageId ?? null,
    lastInboundAt: latestActivityAt ? latestActivityAt.toISOString() : null,
    lastInboundText: null,
  };
}
