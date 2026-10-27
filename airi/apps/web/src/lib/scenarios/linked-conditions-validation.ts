import {
  resolveConditionalScenarioLinkRefs,
  type ConditionalScenarioLinkRef,
} from "@icecore/scenario-contracts";
import { findTriggerNodeForScenario } from "@/lib/scenarios/linked-condition-graph-projection";
import {
  loadChildScenarioGraphsByIds,
  loadLinkedConditionRecordsForChildren,
} from "@/lib/scenarios/linked-condition-repository";
import {
  areConditionDefinitionsEqual,
  LINKED_CONDITION_ERROR_CODES,
  normalizeConditionConfigValue,
  normalizeConditionType,
  normalizeParentRefs,
  normalizeString,
  serializeComparableCondition,
  type LinkedConditionErrorCode,
  type LinkedConditionRecord,
  type ScenarioGraphEdgeRecord,
  type ScenarioGraphNodeRecord,
  type ScenarioRecord,
} from "@/lib/scenarios/linked-conditions-types";

export function groupRefsByChildScenario(
  refs: ConditionalScenarioLinkRef[]
): Map<string, ConditionalScenarioLinkRef[]> {
  const refsByChildScenario = new Map<string, ConditionalScenarioLinkRef[]>();
  for (const ref of refs) {
    const childScenarioId = normalizeString(ref.childScenarioId);
    if (!childScenarioId) continue;
    const current = refsByChildScenario.get(childScenarioId) || [];
    current.push(ref);
    refsByChildScenario.set(childScenarioId, current);
  }
  return refsByChildScenario;
}

export async function validateConditionalScenarioLinks(params: {
  workspaceId: string;
  scenarioId: string;
  nodes: ScenarioGraphNodeRecord[];
  edges: ScenarioGraphEdgeRecord[];
}): Promise<LinkedConditionErrorCode[]> {
  const validationErrors = new Set<LinkedConditionErrorCode>();
  const resolved = resolveConditionalScenarioLinkRefs({
    nodes: params.nodes,
    edges: params.edges,
  });

  const refsByChildScenario = groupRefsByChildScenario(resolved.refs);
  for (const refs of refsByChildScenario.values()) {
    const firstRef = refs[0];
    if (!firstRef) continue;
    const firstComparable = serializeComparableCondition({
      type: firstRef.branchType,
      config: {
        timeoutMinutes: firstRef.branchConfig.timeoutMinutes,
        missingTextPhrases: firstRef.branchConfig.missingTextPhrases,
      },
    });
    if (
      refs.some(
        ref =>
          serializeComparableCondition({
            type: ref.branchType,
            config: {
              timeoutMinutes: ref.branchConfig.timeoutMinutes,
              missingTextPhrases: ref.branchConfig.missingTextPhrases,
            },
          }) !== firstComparable
      )
    ) {
      validationErrors.add(LINKED_CONDITION_ERROR_CODES.conflictingChildReuse);
    }
  }

  const childScenarioIds = Array.from(refsByChildScenario.keys());
  if (childScenarioIds.length === 0) {
    return Array.from(validationErrors);
  }

  const [existingRecords, childScenarios] = await Promise.all([
    loadLinkedConditionRecordsForChildren({
      workspaceId: params.workspaceId,
      childScenarioIds,
    }),
    loadChildScenarioGraphsByIds({
      workspaceId: params.workspaceId,
      scenarioIds: childScenarioIds,
    }),
  ]);

  const recordByChildId = new Map<string, LinkedConditionRecord>(
    existingRecords.map(record => [
      normalizeString(record.childScenarioId),
      record,
    ])
  );
  const childScenarioById = new Map<string, ScenarioRecord>(
    childScenarios.map(scenario => [
      normalizeString(String(scenario._id || "")),
      scenario,
    ])
  );

  for (const [childScenarioId, refs] of refsByChildScenario.entries()) {
    const childScenario = childScenarioById.get(childScenarioId);
    if (
      !childScenario ||
      !findTriggerNodeForScenario({ scenario: childScenario })
    ) {
      validationErrors.add(LINKED_CONDITION_ERROR_CODES.missingChildTrigger);
      continue;
    }

    const existingRecord = recordByChildId.get(childScenarioId);
    if (!existingRecord || refs.length === 0) continue;

    const desiredRef = refs[0];
    const desiredType = desiredRef.branchType;
    const desiredConfig = normalizeConditionConfigValue(desiredType, {
      timeoutMinutes: desiredRef.branchConfig.timeoutMinutes,
      missingTextPhrases: desiredRef.branchConfig.missingTextPhrases,
    });
    const existingType = normalizeConditionType(existingRecord.conditionType);
    const otherParentRefs = normalizeParentRefs(
      existingRecord.parentRefs
    ).filter(parentRef => parentRef.parentScenarioId !== params.scenarioId);

    if (
      existingType &&
      otherParentRefs.length > 0 &&
      !areConditionDefinitionsEqual({
        leftType: existingType,
        leftConfig: existingRecord.conditionConfig || {},
        rightType: desiredType,
        rightConfig: desiredConfig,
      })
    ) {
      validationErrors.add(LINKED_CONDITION_ERROR_CODES.conflictingChildReuse);
    }
  }

  return Array.from(validationErrors);
}
