import type {
  AiriConversationPreparedTimerTurnResult,
  AiriConversationProjection,
  AiriConversationTimerDescriptor,
} from "@icecore/temporal";
import {
  normalizeDateIso,
  normalizeOptionalString,
  parseDate,
} from "../../internal/value-normalization";
import { loadScenarioForTimer, loadTimerContext } from "../context";
import { getNoReplyMissingTextPhrases } from "@icecore/scenario-contracts";
import { getCompiledScenarioGraph } from "../../scenario-graph";
import { isScenarioOutboundCheckpointConfirmed } from "../../scenario-state";
import type { AiriScenarioTimerDependencies } from "../dependencies";
import {
  buildPostActionTimerDescriptor,
  readPostActionLocationRescueMessageId,
} from "../descriptors/post-action";
import { resolvePendingPostActionWait } from "../graph/post-action";
import { scanPostActionTimerWindow } from "../messages/index";
import { buildTimerTurn } from "../payload/index";
import type { TimerConversationRecord } from "../types";

export async function preparePostActionTimerTurn(
  params: {
    timer: AiriConversationTimerDescriptor;
    conversation: TimerConversationRecord;
    projection: AiriConversationProjection;
  },
  dependencies: AiriScenarioTimerDependencies,
): Promise<AiriConversationPreparedTimerTurnResult> {
  const scenarioState = params.conversation.airi_scenario_state || null;
  const waitStartedAt = parseDate(params.timer.waitStartedAt);

  if (!waitStartedAt) {
    return {
      turn: null,
      projection: params.projection,
      reason: "missing_wait_started_at",
    };
  }

  const pendingOutboundMessageId = normalizeOptionalString(
    params.timer.pendingLastOutboundMessageId,
  );
  const matchesPendingState =
    normalizeOptionalString(scenarioState?.lockedScenarioId) ===
      params.timer.scenarioId &&
    normalizeOptionalString(scenarioState?.pendingConditionNodeId) ===
      params.timer.conditionNodeId &&
    normalizeOptionalString(scenarioState?.pendingSourceActionNodeId) ===
      params.timer.sourceActionNodeId &&
    normalizeDateIso(scenarioState?.pendingStartedAt) ===
      params.timer.waitStartedAt &&
    normalizeOptionalString(scenarioState?.pendingLastOutboundMessageId) ===
      pendingOutboundMessageId;

  if (!matchesPendingState) {
    return {
      turn: null,
      projection: params.projection,
      reason: "stale_pending_condition_state",
    };
  }

  const completePendingState = async (paramsToComplete: {
    reason: string;
    completionTimestamp?: Date;
  }): Promise<AiriConversationPreparedTimerTurnResult> => {
    const completion = await dependencies.completeLockedScenarioAndPersist({
      conversationId: params.timer.conversationId,
      baseState: scenarioState,
      scenarioId: params.timer.scenarioId,
      scenarioName:
        normalizeOptionalString(params.projection.activeScenarioName) ||
        normalizeOptionalString(params.timer.scenarioName) ||
        "Scenario",
      completionTimestamp: paramsToComplete.completionTimestamp,
      lastActionNodeId: params.timer.sourceActionNodeId,
      lastMessageId: pendingOutboundMessageId,
      expectedPendingState: {
        conditionNodeId: params.timer.conditionNodeId || "",
        sourceActionNodeId: params.timer.sourceActionNodeId || "",
        pendingStartedAt: params.timer.waitStartedAt,
        lastOutboundMessageId: pendingOutboundMessageId,
      },
    });

    return {
      turn: null,
      projection:
        (await loadTimerContext(params.timer.conversationId, dependencies))
          ?.projection || params.projection,
      reason: completion.persisted
        ? paramsToComplete.reason
        : "stale_pending_condition_state",
    };
  };

  // A rescue routes a stored location, but it is still a synthetic turn. The
  // preceding action must have been accepted before any timer advances it.
  const isLocationRescue = Boolean(
    readPostActionLocationRescueMessageId(params.timer),
  );

  const pendingOutbound = !pendingOutboundMessageId
    ? null
    : await dependencies.findPendingOutbound({
        messageId: pendingOutboundMessageId,
        workspaceId: params.timer.workspaceId,
        conversationId: params.timer.conversationId,
        scenarioId: params.timer.scenarioId,
        sourceActionNodeId: params.timer.sourceActionNodeId,
      });

  if (!isScenarioOutboundCheckpointConfirmed(pendingOutbound)) {
    return {
      turn: null,
      projection: params.projection,
      reason: "pending_outbound_unconfirmed",
    };
  }

  const workspaceId = normalizeOptionalString(params.conversation.workspaceId);
  const scenario = workspaceId
    ? await loadScenarioForTimer(
        workspaceId,
        params.timer.scenarioId,
        dependencies,
      )
    : null;
  if (!workspaceId || !scenario) {
    return {
      turn: null,
      projection: params.projection,
      reason: "scenario_inactive",
    };
  }

  const graph = getCompiledScenarioGraph(scenario);
  const wait = resolvePendingPostActionWait({
    graph,
    conditionNodeId: params.timer.conditionNodeId || "",
  });
  // A builder edit can remove the wait while conversations still hold it.
  // Nothing could end such a wait, so release the conversation.
  if (wait.status === "removed") {
    return completePendingState({ reason: "post_action_wait_removed" });
  }
  if (
    wait.status === "waiting" &&
    !wait.hasNoReplyBranch &&
    !wait.hasOtherOutcome
  ) {
    return completePendingState({
      reason: "post_action_wait_without_outcomes",
    });
  }
  // Blocking diagnostics leave the wait untouched. A wait whose other
  // outcomes remain keeps waiting, without a no-reply timer; a location
  // rescue can still run there.
  if (
    wait.status === "blocked" ||
    (!wait.hasNoReplyBranch && !isLocationRescue)
  ) {
    return {
      turn: null,
      projection: params.projection,
      reason: "post_action_timer_invalidated",
    };
  }
  const conditionNode = wait.conditionNode;

  let latestActivity: { latestActivityAt?: Date | null } = {};
  if (!isLocationRescue) {
    const missingTextPhrases = getNoReplyMissingTextPhrases(conditionNode.data);
    const messageScan = await scanPostActionTimerWindow(
      {
        conversationId: params.timer.conversationId,
        after: waitStartedAt,
        phrases: missingTextPhrases,
      },
      dependencies,
    );

    if (messageScan.matchedTextPhrase) {
      return completePendingState({
        reason: "missing_text_phrase_detected",
        completionTimestamp: new Date(),
      });
    }
    latestActivity = { latestActivityAt: messageScan.latestMessageDate };
  }

  const refreshedTimer = await buildPostActionTimerDescriptor(
    {
      conversation: params.conversation,
      projection: params.projection,
      ...latestActivity,
      scenario,
      graph,
    },
    dependencies,
  );
  if (!refreshedTimer) {
    return {
      turn: null,
      projection: params.projection,
      reason: "post_action_timer_invalidated",
    };
  }
  // The share was settled since the rescue was armed. The wait's own No
  // reply timer takes over and fires through its checks, even if it's due.
  if (
    isLocationRescue &&
    !readPostActionLocationRescueMessageId(refreshedTimer)
  ) {
    return {
      turn: null,
      projection: params.projection,
      timer: refreshedTimer,
      reason: "location_rescue_settled",
    };
  }

  const refreshedDueAt = parseDate(refreshedTimer?.dueAt);
  if (
    refreshedTimer &&
    refreshedTimer.dueAt !== params.timer.dueAt &&
    refreshedDueAt &&
    refreshedDueAt.getTime() > Date.now()
  ) {
    return {
      turn: null,
      projection: params.projection,
      timer: refreshedTimer,
      reason: "newer_message_rescheduled",
    };
  }

  const turn = await buildTimerTurn(
    {
      timer: refreshedTimer,
      conversation: params.conversation,
    },
    dependencies,
  );

  return {
    turn,
    projection: params.projection,
    reason: turn ? "timer_turn_ready" : "missing_channel_context",
  };
}
