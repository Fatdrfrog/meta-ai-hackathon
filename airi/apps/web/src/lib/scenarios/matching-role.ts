import type {
  ScenarioMatchingRole,
  ScenarioNodeData,
} from "@icecore/scenario-contracts";
import { normalizeScenarioMatchingRole } from "@icecore/scenario-contracts";
import {
  isClientMessageCatchAll,
  projectActiveClientMessageFilters,
  type ClientMessageTriggerCriteria,
} from "@/lib/scenarios/client-message-trigger-criteria";
import { resolveScenarioTrigger } from "@/lib/scenarios/trigger-utils";

function projectTriggerNodeCriteria(
  nodeData: Partial<ScenarioNodeData> | null | undefined
): ClientMessageTriggerCriteria | null {
  if (!nodeData || nodeData.kind !== "trigger") return null;
  return projectActiveClientMessageFilters(
    resolveScenarioTrigger(nodeData as ScenarioNodeData)
  );
}

export function isCatchAllCustomerMessageTriggerNodeData(
  nodeData: Partial<ScenarioNodeData> | null | undefined
): boolean {
  const criteria = projectTriggerNodeCriteria(nodeData);
  return criteria ? isClientMessageCatchAll(criteria) : false;
}

export function resolveEffectiveScenarioMatchingRole(params: {
  matchingRole: unknown;
  triggerNodeData: Partial<ScenarioNodeData> | null | undefined;
}): ScenarioMatchingRole {
  const normalizedRole = normalizeScenarioMatchingRole(params.matchingRole);
  if (normalizedRole !== "fallback") return "default";
  return isCatchAllCustomerMessageTriggerNodeData(params.triggerNodeData)
    ? "fallback"
    : "default";
}

export function resolveEffectiveScenarioMatchingRoleForTriggerNodes(params: {
  matchingRole: unknown;
  triggerNodeData: Array<Partial<ScenarioNodeData> | null | undefined>;
}): ScenarioMatchingRole {
  const criteria = params.triggerNodeData.flatMap(nodeData => {
    const criteria = projectTriggerNodeCriteria(nodeData);
    return criteria ? [criteria] : [];
  });

  return resolveEffectiveScenarioMatchingRoleForCriteria({
    matchingRole: params.matchingRole,
    criteria,
  });
}

export function resolveEffectiveScenarioMatchingRoleForCriteria(params: {
  matchingRole: unknown;
  criteria: readonly ClientMessageTriggerCriteria[];
}): ScenarioMatchingRole {
  const normalizedRole = normalizeScenarioMatchingRole(params.matchingRole);
  if (normalizedRole !== "fallback") return "default";
  const enabledCriteria = params.criteria.filter(criteria => criteria.enabled);
  if (enabledCriteria.length === 0) return "default";
  return enabledCriteria.every(isClientMessageCatchAll)
    ? "fallback"
    : "default";
}
