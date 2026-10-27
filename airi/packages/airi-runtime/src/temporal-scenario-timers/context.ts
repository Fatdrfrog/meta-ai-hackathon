import type { AiriConversationProjection } from "@icecore/temporal";
import {
  normalizeDateIso,
  normalizeOptionalString,
  normalizeStringArray,
} from "../internal/value-normalization";
import { isScenarioAutomationPausedByHandoff } from "../scenario-handoff-policy";
import type { AiriScenarioTimerDependencies } from "./dependencies";
import type {
  ScenarioRecord,
  TimerContext,
  TimerConversationRecord,
} from "./types";

function normalizeConversationProjection(
  conversation: TimerConversationRecord,
): AiriConversationProjection {
  const scenarioState = conversation.airi_scenario_state || null;
  const contextMemory = conversation.airi_context_memory || null;

  return {
    currentGoal:
      normalizeOptionalString(contextMemory?.currentGoal) ||
      normalizeOptionalString(scenarioState?.lockedScenarioName),
    preferredLanguage:
      normalizeOptionalString(contextMemory?.preferredLanguage) ||
      normalizeOptionalString(conversation.preferred_language),
    activeScenarioId: normalizeOptionalString(scenarioState?.lockedScenarioId),
    activeScenarioName: normalizeOptionalString(
      scenarioState?.lockedScenarioName,
    ),
    currentActionNodeId: normalizeOptionalString(
      scenarioState?.currentActionNodeId,
    ),
    currentPathNodeIds: normalizeStringArray(scenarioState?.currentPathNodeIds),
    currentBranchNodeIds: normalizeStringArray(
      scenarioState?.currentBranchNodeIds,
    ),
    pendingConditionNodeId: normalizeOptionalString(
      scenarioState?.pendingConditionNodeId,
    ),
    pendingSourceActionNodeId: normalizeOptionalString(
      scenarioState?.pendingSourceActionNodeId,
    ),
    pendingLinkedConditionId: normalizeOptionalString(
      scenarioState?.pendingLinkedConditionId,
    ),
    handoffActive: isScenarioAutomationPausedByHandoff(
      conversation.airi_handoff_active,
    ),
    handoffSource: normalizeOptionalString(conversation.airi_handoff_source),
    handoffReason: normalizeOptionalString(conversation.airi_handoff_reason),
    handoffStartedAt: normalizeDateIso(conversation.airi_handoff_started_at),
    updatedAt: normalizeDateIso(conversation.updatedAt),
  };
}

export function buildTimerProjection(
  conversation: TimerConversationRecord,
): AiriConversationProjection {
  return normalizeConversationProjection(conversation);
}

export async function loadTimerContext(
  conversationId: string,
  dependencies: Pick<AiriScenarioTimerDependencies, "loadConversation">,
): Promise<TimerContext | null> {
  const conversation = await dependencies.loadConversation(conversationId);
  return conversation
    ? {
        conversation,
        projection: buildTimerProjection(conversation),
      }
    : null;
}

export function loadScenarioForTimer(
  workspaceId: string,
  scenarioId: string,
  dependencies: Pick<AiriScenarioTimerDependencies, "loadScenario">,
): Promise<ScenarioRecord | null> {
  return dependencies.loadScenario({ workspaceId, scenarioId });
}
