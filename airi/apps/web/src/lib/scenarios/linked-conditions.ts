import {
  collectLinkedConditionIdsFromNodes,
  projectLinkedConditionParentCountsByNodeId,
} from "@/lib/scenarios/linked-condition-graph-projection";
import { loadLinkedConditionRecordsByIds } from "@/lib/scenarios/linked-condition-repository";

export {
  isLinkedConditionRevisionConflict,
  LINKED_CONDITION_ERROR_CODES,
} from "@/lib/scenarios/linked-conditions-types";
export {
  detachScenarioLinkedConditionsForScenarioDeletion,
  syncScenarioLinkedConditions,
} from "@/lib/scenarios/linked-condition-reconciler";
export { validateConditionalScenarioLinks } from "@/lib/scenarios/linked-conditions-validation";

export async function loadLinkedConditionParentCountByNodeId(params: {
  nodes: unknown;
}): Promise<Record<string, number>> {
  const recordIds = collectLinkedConditionIdsFromNodes(params.nodes);
  if (recordIds.length === 0) return {};

  const records = await loadLinkedConditionRecordsByIds({ recordIds });
  return projectLinkedConditionParentCountsByNodeId({
    nodes: params.nodes,
    records,
  });
}
