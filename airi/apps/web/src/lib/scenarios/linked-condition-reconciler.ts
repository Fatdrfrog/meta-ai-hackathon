import { resolveConditionalScenarioLinkRefs } from "@icecore/scenario-contracts";
import {
  computeLinkedConditionDedupeFacts,
  findTriggerNodeForScenario,
  projectApplyLinkedConditionToChildGraph,
  projectClearLinkedConditionFromChildGraph,
  projectLinkedConditionToParentGraph,
} from "@/lib/scenarios/linked-condition-graph-projection";
import {
  createLinkedConditionRecordId,
  loadChildScenarioGraphsByIds,
  loadLinkedConditionRecordForChild,
  loadLinkedConditionRecordsForChild,
  loadLinkedConditionRecordsForChildren,
  loadLinkedConditionRecordsForParent,
  loadScenarioForLinkedConditionSync,
  mutateLinkedConditionScenarioGraph,
  reconcileLinkedConditionRecordWithParentFence,
  updateLinkedConditionDefinition,
} from "@/lib/scenarios/linked-condition-repository";
import {
  areConditionDefinitionsEqual,
  asEdges,
  asNodes,
  LinkedConditionRevisionConflictError,
  LINKED_CONDITION_ERROR_CODES,
  normalizeConditionConfigValue,
  normalizeConditionType,
  normalizeParentRefs,
  normalizeString,
  type LinkedConditionRecord,
  type ScenarioRecord,
} from "@/lib/scenarios/linked-conditions-types";
import { groupRefsByChildScenario } from "@/lib/scenarios/linked-conditions-validation";

export async function applyLinkedConditionToChildScenario(params: {
  workspaceId: string;
  childScenario: ScenarioRecord;
  recordId: string;
  childTriggerNodeId?: string | null;
}): Promise<string> {
  const childScenarioId = normalizeString(
    String(params.childScenario._id || "")
  );
  if (!childScenarioId) {
    throw new Error(LINKED_CONDITION_ERROR_CODES.missingChildTrigger);
  }
  const result = await mutateLinkedConditionScenarioGraph({
    workspaceId: params.workspaceId,
    scenarioId: childScenarioId,
    project: childScenario => {
      const projection = projectApplyLinkedConditionToChildGraph({
        childScenario,
        recordId: params.recordId,
        childTriggerNodeId: params.childTriggerNodeId,
      });
      return projection.changed
        ? {
            changed: true,
            nodes: projection.nodes,
            edges: projection.edges,
            value: projection.triggerNodeId,
          }
        : {
            changed: false,
            value: projection.triggerNodeId,
          };
    },
  });
  if (result.status === "conflict") {
    throw new LinkedConditionRevisionConflictError("graph");
  }
  if (result.status === "not_found") {
    throw new Error(LINKED_CONDITION_ERROR_CODES.missingChildTrigger);
  }

  return result.value;
}

export async function clearLinkedConditionFromChildScenario(params: {
  workspaceId: string;
  childScenarioId: string;
  linkedConditionId: string;
}): Promise<void> {
  const result = await mutateLinkedConditionScenarioGraph({
    workspaceId: params.workspaceId,
    scenarioId: params.childScenarioId,
    project: childScenario => {
      const projection = projectClearLinkedConditionFromChildGraph({
        childScenario,
        linkedConditionId: params.linkedConditionId,
      });
      return projection.changed
        ? {
            changed: true,
            nodes: projection.nodes,
            edges: projection.edges,
            value: undefined,
          }
        : {
            changed: false,
            value: undefined,
          };
    },
  });
  if (result.status === "conflict") {
    throw new LinkedConditionRevisionConflictError("graph");
  }
}

export async function syncParentScenariosForRecord(params: {
  workspaceId: string;
  record: LinkedConditionRecord;
}): Promise<void> {
  const recordId = normalizeString(String(params.record._id || ""));
  const childScenarioId = normalizeString(params.record.childScenarioId);
  const conditionType = normalizeConditionType(params.record.conditionType);
  const parentRefs = normalizeParentRefs(params.record.parentRefs);
  if (
    !recordId ||
    !childScenarioId ||
    !conditionType ||
    parentRefs.length === 0
  ) {
    return;
  }

  const parentScenarioIds = Array.from(
    new Set(parentRefs.map(parentRef => parentRef.parentScenarioId))
  );

  for (const parentScenarioId of parentScenarioIds) {
    const matchingParentRefs = parentRefs.filter(
      parentRef => parentRef.parentScenarioId === parentScenarioId
    );
    if (matchingParentRefs.length === 0) continue;

    const result = await mutateLinkedConditionScenarioGraph({
      workspaceId: params.workspaceId,
      scenarioId: parentScenarioId,
      project: parentScenario => {
        const projection = projectLinkedConditionToParentGraph({
          scenario: parentScenario,
          recordId,
          childScenarioId,
          conditionType,
          conditionConfig: params.record.conditionConfig || {},
          parentRefs: matchingParentRefs,
        });
        return projection.changed
          ? {
              changed: true,
              nodes: projection.nodes,
              edges: projection.edges,
              value: undefined,
            }
          : {
              changed: false,
              value: undefined,
            };
      },
    });
    if (result.status === "conflict") {
      throw new LinkedConditionRevisionConflictError("graph");
    }
  }
}

export async function syncRecordFromChildScenario(params: {
  workspaceId: string;
  childScenario: ScenarioRecord;
  record: LinkedConditionRecord;
}): Promise<LinkedConditionRecord> {
  const recordId = normalizeString(String(params.record._id || ""));
  const childScenarioId = normalizeString(
    String(params.childScenario._id || "")
  );
  if (!recordId || !childScenarioId) {
    throw new Error(LINKED_CONDITION_ERROR_CODES.invalidChildTrigger);
  }

  const triggerNode = findTriggerNodeForScenario({
    scenario: params.childScenario,
    preferredTriggerNodeId: normalizeString(params.record.childTriggerNodeId),
  });
  const triggerNodeId = normalizeString(triggerNode?.id);
  if (!triggerNode?.data || !triggerNodeId) {
    throw new Error(LINKED_CONDITION_ERROR_CODES.missingChildTrigger);
  }

  const conditionType = normalizeConditionType(params.record.conditionType);
  if (!conditionType) {
    throw new Error(LINKED_CONDITION_ERROR_CODES.invalidChildTrigger);
  }
  const conditionConfig = normalizeConditionConfigValue(
    conditionType,
    params.record.conditionConfig
  );
  const nextRecord: LinkedConditionRecord = {
    ...params.record,
    childTriggerNodeId: triggerNodeId,
    conditionType,
    conditionConfig,
  };

  const needsRecordUpdate =
    normalizeString(params.record.childTriggerNodeId) !== triggerNodeId ||
    !areConditionDefinitionsEqual({
      leftType: conditionType,
      leftConfig: params.record.conditionConfig || {},
      rightType: conditionType,
      rightConfig: nextRecord.conditionConfig || {},
    });

  if (needsRecordUpdate) {
    await updateLinkedConditionDefinition({
      workspaceId: params.workspaceId,
      recordId,
      childTriggerNodeId: triggerNodeId,
      conditionType,
      conditionConfig: nextRecord.conditionConfig || {},
    });
  }

  await applyLinkedConditionToChildScenario({
    workspaceId: params.workspaceId,
    childScenario: params.childScenario,
    recordId,
    childTriggerNodeId: triggerNodeId,
  });
  await syncParentScenariosForRecord({
    workspaceId: params.workspaceId,
    record: nextRecord,
  });

  return nextRecord;
}

export async function dedupeLinkedConditionRecords(params: {
  workspaceId: string;
  childScenario: ScenarioRecord;
  records: LinkedConditionRecord[];
}): Promise<LinkedConditionRecord | null> {
  if (params.records.length === 0) return null;
  if (params.records.length === 1) return params.records[0] || null;

  const facts = computeLinkedConditionDedupeFacts({
    childScenario: params.childScenario,
    records: params.records,
  });
  if (!facts) return params.records[0] || null;

  const nextRecord: LinkedConditionRecord = {
    ...facts.canonicalRecord,
    parentRefs: facts.mergedParentRefs,
  };
  const canonicalRecord = await reconcileLinkedConditionRecordWithParentFence({
    workspaceId: params.workspaceId,
    childScenarioId: normalizeString(
      String(
        params.childScenario._id || facts.canonicalRecord.childScenarioId || ""
      )
    ),
    preferredRecord: {
      recordId: facts.canonicalRecordId,
      childTriggerNodeId:
        normalizeString(facts.canonicalRecord.childTriggerNodeId) ||
        normalizeString(
          findTriggerNodeForScenario({ scenario: params.childScenario })?.id
        ),
    },
  });
  if (!canonicalRecord) {
    for (const record of params.records) {
      const recordId = normalizeString(String(record._id || ""));
      if (!recordId) continue;
      await clearLinkedConditionFromChildScenario({
        workspaceId: params.workspaceId,
        childScenarioId: normalizeString(
          String(params.childScenario._id || "")
        ),
        linkedConditionId: recordId,
      });
    }
    return null;
  }

  const syncedRecord = await syncRecordFromChildScenario({
    workspaceId: params.workspaceId,
    childScenario: params.childScenario,
    record: { ...nextRecord, ...canonicalRecord },
  });

  return syncedRecord;
}

export async function syncScenarioLinkedConditions(params: {
  workspaceId: string;
  scenarioId: string;
  scenario?: ScenarioRecord | null;
}): Promise<void> {
  const scenarioId = normalizeString(params.scenarioId);
  if (!scenarioId) return;

  const scenario =
    params.scenario ||
    (await loadScenarioForLinkedConditionSync({
      scenarioId,
      workspaceId: params.workspaceId,
    }));
  if (!scenario) return;

  const currentChildRecords = await loadLinkedConditionRecordsForChild({
    workspaceId: params.workspaceId,
    childScenarioId: scenarioId,
  });
  const currentChildRecord = await dedupeLinkedConditionRecords({
    workspaceId: params.workspaceId,
    childScenario: scenario,
    records: currentChildRecords,
  });

  if (currentChildRecord) {
    await syncRecordFromChildScenario({
      workspaceId: params.workspaceId,
      childScenario: scenario,
      record: currentChildRecord,
    });
  }

  const resolvedRefs = resolveConditionalScenarioLinkRefs({
    nodes: asNodes(scenario.nodes),
    edges: asEdges(scenario.edges),
  });
  const refsByChildScenario = groupRefsByChildScenario(resolvedRefs.refs);
  const existingParentRecords = await loadLinkedConditionRecordsForParent({
    workspaceId: params.workspaceId,
    parentScenarioId: scenarioId,
  });

  const childScenarioIds = Array.from(refsByChildScenario.keys());
  const [childScenarios, existingRecords] = await Promise.all([
    loadChildScenarioGraphsByIds({
      workspaceId: params.workspaceId,
      scenarioIds: childScenarioIds,
    }),
    loadLinkedConditionRecordsForChildren({
      workspaceId: params.workspaceId,
      childScenarioIds,
    }),
  ]);

  const childScenarioById = new Map<string, ScenarioRecord>(
    childScenarios.map(childScenario => [
      normalizeString(String(childScenario._id || "")),
      childScenario,
    ])
  );
  const recordsByChildId = new Map<string, LinkedConditionRecord[]>();
  for (const record of existingRecords) {
    const childScenarioId = normalizeString(record.childScenarioId);
    if (!childScenarioId) continue;
    const currentRecords = recordsByChildId.get(childScenarioId) || [];
    currentRecords.push(record);
    recordsByChildId.set(childScenarioId, currentRecords);
  }

  const recordByChildId = new Map<string, LinkedConditionRecord>();
  for (const [childScenarioId, childScenario] of childScenarioById.entries()) {
    const consolidatedRecord = await dedupeLinkedConditionRecords({
      workspaceId: params.workspaceId,
      childScenario,
      records: recordsByChildId.get(childScenarioId) || [],
    });
    if (consolidatedRecord) {
      recordByChildId.set(childScenarioId, consolidatedRecord);
    }
  }

  for (const [childScenarioId, childRefs] of refsByChildScenario.entries()) {
    const desiredRef = childRefs[0];
    const childScenario = childScenarioById.get(childScenarioId);
    if (!desiredRef || !childScenario) {
      throw new Error(LINKED_CONDITION_ERROR_CODES.missingChildTrigger);
    }

    const existingRecord = recordByChildId.get(childScenarioId);
    const existingRecordId = normalizeString(String(existingRecord?._id || ""));
    const recordId = existingRecordId || createLinkedConditionRecordId();
    const triggerNodeId =
      normalizeString(existingRecord?.childTriggerNodeId) ||
      normalizeString(
        findTriggerNodeForScenario({ scenario: childScenario })?.id
      );
    if (!triggerNodeId) {
      throw new Error(LINKED_CONDITION_ERROR_CODES.missingChildTrigger);
    }

    const nextRecord = await reconcileLinkedConditionRecordWithParentFence({
      workspaceId: params.workspaceId,
      childScenarioId,
      preferredRecord: { recordId, childTriggerNodeId: triggerNodeId },
      expectedParent: {
        parentScenarioId: scenarioId,
        updatedAt: scenario.updatedAt,
      },
    });
    if (!nextRecord) {
      throw new LinkedConditionRevisionConflictError("parent");
    }
    const persistedRecordId = normalizeString(String(nextRecord._id || ""));
    if (!persistedRecordId) {
      throw new Error(LINKED_CONDITION_ERROR_CODES.invalidChildTrigger);
    }
    await applyLinkedConditionToChildScenario({
      workspaceId: params.workspaceId,
      childScenario,
      recordId: persistedRecordId,
      childTriggerNodeId: triggerNodeId,
    });
    await syncParentScenariosForRecord({
      workspaceId: params.workspaceId,
      record: nextRecord,
    });
  }

  const desiredChildIds = new Set(childScenarioIds);
  for (const existingRecord of existingParentRecords) {
    const childScenarioId = normalizeString(existingRecord.childScenarioId);
    if (!childScenarioId || desiredChildIds.has(childScenarioId)) continue;

    const recordId = normalizeString(String(existingRecord._id || ""));
    const nextRecord = await reconcileLinkedConditionRecordWithParentFence({
      workspaceId: params.workspaceId,
      childScenarioId,
      preferredRecord: {
        recordId,
        childTriggerNodeId: normalizeString(existingRecord.childTriggerNodeId),
      },
      expectedParent: {
        parentScenarioId: scenarioId,
        updatedAt: scenario.updatedAt,
      },
    });
    if (nextRecord) continue;
    if (recordId && childScenarioId) {
      await clearLinkedConditionFromChildScenario({
        workspaceId: params.workspaceId,
        childScenarioId,
        linkedConditionId: recordId,
      });
    }
  }
}

export async function detachScenarioLinkedConditionsForScenarioDeletion(params: {
  workspaceId: string;
  scenarioId: string;
  expectedUpdatedAt: unknown;
}): Promise<void> {
  const scenarioId = normalizeString(params.scenarioId);
  if (!scenarioId) return;

  const [childRecord, parentRecords] = await Promise.all([
    loadLinkedConditionRecordForChild({
      workspaceId: params.workspaceId,
      childScenarioId: scenarioId,
    }),
    loadLinkedConditionRecordsForParent({
      workspaceId: params.workspaceId,
      parentScenarioId: scenarioId,
    }),
  ]);

  if (childRecord?._id) {
    await reconcileLinkedConditionRecordWithParentFence({
      workspaceId: params.workspaceId,
      childScenarioId: scenarioId,
      forceDelete: true,
    });
  }

  const handledChildScenarioIds = new Set<string>();
  for (const record of parentRecords) {
    const recordId = normalizeString(String(record._id || ""));
    const childScenarioId = normalizeString(record.childScenarioId);
    if (!childScenarioId || handledChildScenarioIds.has(childScenarioId)) {
      continue;
    }
    handledChildScenarioIds.add(childScenarioId);
    const nextRecord = await reconcileLinkedConditionRecordWithParentFence({
      workspaceId: params.workspaceId,
      childScenarioId,
      preferredRecord: {
        recordId,
        childTriggerNodeId: normalizeString(record.childTriggerNodeId),
      },
      expectedParent: {
        parentScenarioId: scenarioId,
        updatedAt: params.expectedUpdatedAt,
        deleted: true,
      },
    });
    if (!nextRecord && recordId) {
      await clearLinkedConditionFromChildScenario({
        workspaceId: params.workspaceId,
        childScenarioId,
        linkedConditionId: recordId,
      });
    }
  }
}
