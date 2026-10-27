import type {
  ScenarioNodeData,
  ScenarioPostActionConditionType,
} from "@icecore/scenario-contracts";
import {
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  createClientMessageTriggerData,
  getScenarioActionOutcomeVirtualNodeId,
  normalizeScenarioActionOutcomes,
} from "@icecore/scenario-contracts";
import {
  getPostActionConditionHandleId,
  normalizeConditionBranchConfig,
  normalizeMissingTextPhrases,
  normalizePostActionConditionBranches,
} from "@icecore/scenario-contracts";
import { parseNodes } from "@icecore/airi-runtime/scenario-graph";
import {
  asEdges,
  asNodes,
  dedupeParentRefs,
  LINKED_CONDITION_ERROR_CODES,
  normalizeParentRefs,
  normalizeString,
  normalizeTimestampMs,
  type LinkedConditionParentRef,
  type LinkedConditionRecord,
  type ScenarioGraphEdgeRecord,
  type ScenarioGraphNodeRecord,
  type ScenarioRecord,
} from "@/lib/scenarios/linked-conditions-types";

type ScenarioGraphProjection = {
  nodes: ScenarioGraphNodeRecord[];
  edges: ScenarioGraphEdgeRecord[];
  changed: boolean;
};

function cloneScenarioGraph(scenario: ScenarioRecord): {
  nodes: ScenarioGraphNodeRecord[];
  edges: ScenarioGraphEdgeRecord[];
} {
  return {
    nodes: asNodes(scenario.nodes).map(node => ({
      ...node,
      data: node.data ? { ...node.data } : undefined,
    })),
    edges: asEdges(scenario.edges).map(edge => ({ ...edge })),
  };
}

export function findTriggerNodeForScenario(params: {
  scenario: ScenarioRecord;
  preferredTriggerNodeId?: string | null;
}): ScenarioGraphNodeRecord | null {
  const nodes = parseNodes(params.scenario.nodes);
  const preferredId = normalizeString(params.preferredTriggerNodeId);

  if (preferredId) {
    const preferredNode = nodes.find(node => node.id === preferredId);
    if (preferredNode?.data?.kind === "trigger") {
      return preferredNode as unknown as ScenarioGraphNodeRecord;
    }
  }

  const triggerNode = nodes.find(node => node.data.kind === "trigger");
  return triggerNode
    ? ({
        id: triggerNode.id,
        data: triggerNode.data as unknown as Record<string, unknown>,
      } satisfies ScenarioGraphNodeRecord)
    : null;
}

export function buildLinkedChildTriggerData(params: {
  data: ScenarioNodeData;
  linkedConditionId: string;
}): ScenarioNodeData {
  return createClientMessageTriggerData({
    ...params.data,
    linkedConditionId: params.linkedConditionId,
    triggerConfig: {
      enabled: true,
      messageMatchMode: "any",
      keywordMatchMode: "contains",
    },
  });
}

export function isCanonicalLinkedChildTriggerData(
  data: ScenarioNodeData,
  linkedConditionId: string
): boolean {
  const triggerConfig = data.triggerConfig;
  const triggerConfigKeys =
    triggerConfig && typeof triggerConfig === "object"
      ? Object.keys(triggerConfig)
      : [];

  return (
    data.kind === "trigger" &&
    !Object.prototype.hasOwnProperty.call(data, "triggerType") &&
    normalizeString(data.linkedConditionId) === linkedConditionId &&
    triggerConfig?.enabled === true &&
    triggerConfig.messageMatchMode === "any" &&
    triggerConfig.keywordMatchMode === "contains" &&
    triggerConfigKeys.every(key =>
      ["enabled", "messageMatchMode", "keywordMatchMode"].includes(key)
    )
  );
}

export function projectApplyLinkedConditionToChildGraph(params: {
  childScenario: ScenarioRecord;
  recordId: string;
  childTriggerNodeId?: string | null;
}): ScenarioGraphProjection & { triggerNodeId: string } {
  const triggerNode = findTriggerNodeForScenario({
    scenario: params.childScenario,
    preferredTriggerNodeId: params.childTriggerNodeId,
  });
  if (!triggerNode?.id || !triggerNode.data) {
    throw new Error(LINKED_CONDITION_ERROR_CODES.missingChildTrigger);
  }

  const triggerNodeId = normalizeString(triggerNode.id);
  const currentTriggerData = triggerNode.data as ScenarioNodeData;
  const changed = !isCanonicalLinkedChildTriggerData(
    currentTriggerData,
    params.recordId
  );
  const { nodes, edges } = cloneScenarioGraph(params.childScenario);

  if (changed) {
    const targetNode = nodes.find(
      node => normalizeString(node.id) === triggerNodeId
    );
    if (targetNode?.data) {
      targetNode.data = buildLinkedChildTriggerData({
        data: targetNode.data as ScenarioNodeData,
        linkedConditionId: params.recordId,
      }) as unknown as Record<string, unknown>;
    }
  }

  return { nodes, edges, changed, triggerNodeId };
}

export function projectClearLinkedConditionFromChildGraph(params: {
  childScenario: ScenarioRecord;
  linkedConditionId: string;
}): ScenarioGraphProjection {
  const { nodes, edges } = cloneScenarioGraph(params.childScenario);
  let changed = false;

  for (const node of nodes) {
    const data = node.data as ScenarioNodeData | undefined;
    if (
      !data ||
      normalizeString(data.linkedConditionId) !== params.linkedConditionId
    ) {
      continue;
    }

    const nextData = { ...data };
    delete nextData.linkedConditionId;
    node.data = nextData;
    changed = true;
  }

  return { nodes, edges, changed };
}

export function projectLinkedConditionToParentGraph(params: {
  scenario: ScenarioRecord;
  recordId: string;
  childScenarioId: string;
  conditionType: ScenarioPostActionConditionType;
  conditionConfig: Record<string, unknown>;
  parentRefs: LinkedConditionParentRef[];
}): ScenarioGraphProjection {
  const { nodes, edges } = cloneScenarioGraph(params.scenario);
  const nodeById = new Map(nodes.map(node => [normalizeString(node.id), node]));
  let changed = false;

  for (const parentRef of params.parentRefs) {
    const conditionNode = nodeById.get(parentRef.conditionNodeId);
    let expectedSourceNodeId = parentRef.conditionNodeId;
    let expectedHandleId = getPostActionConditionHandleId(params.conditionType);

    if (conditionNode?.data) {
      const nodeData = conditionNode.data as ScenarioNodeData;
      const existingBranches = normalizePostActionConditionBranches(
        nodeData.conditionBranches
      );
      const nextBranches = existingBranches.map(branch => {
        if (branch.type === params.conditionType) {
          return normalizeConditionBranchConfig(params.conditionType, {
            ...branch,
            linkedConditionId: params.recordId,
            timeoutMinutes:
              params.conditionType === "no_reply_timeout"
                ? Number(params.conditionConfig.timeoutMinutes)
                : undefined,
          });
        }
        if (branch.linkedConditionId === params.recordId) {
          return normalizeConditionBranchConfig(branch.type, {
            ...branch,
            linkedConditionId: undefined,
          });
        }
        return branch;
      });

      if (JSON.stringify(existingBranches) !== JSON.stringify(nextBranches)) {
        conditionNode.data = {
          ...nodeData,
          kind: "logic",
          logicType: "post_action_condition",
          conditionBranches: nextBranches,
        } as unknown as Record<string, unknown>;
        changed = true;
      }
    } else {
      const actionNode = nodeById.get(parentRef.sourceActionNodeId);
      const actionData = actionNode?.data as ScenarioNodeData | undefined;
      if (
        !actionNode?.data ||
        actionData?.kind !== "action" ||
        parentRef.conditionNodeId !==
          getScenarioActionOutcomeVirtualNodeId(parentRef.sourceActionNodeId) ||
        (params.conditionType !== "user_replied" &&
          params.conditionType !== "no_reply_timeout")
      ) {
        continue;
      }

      const normalizedOutcomes = normalizeScenarioActionOutcomes(
        actionData.actionOutcomes
      );
      if (normalizedOutcomes.status !== "supported") continue;
      const outcomes = normalizedOutcomes.value;
      const normalizedNoReplyConfig = normalizeConditionBranchConfig(
        "no_reply_timeout",
        {
          timeoutMinutes: Number(params.conditionConfig.timeoutMinutes),
          missingTextPhrases: normalizeMissingTextPhrases(
            params.conditionConfig.missingTextPhrases
          ),
        }
      );
      const nextOutcomes =
        params.conditionType === "user_replied"
          ? {
              ...outcomes,
              anyReply: {
                enabled: true as const,
                linkedConditionId: params.recordId,
              },
              ...(outcomes.noReply?.linkedConditionId === params.recordId
                ? {
                    noReply: {
                      ...outcomes.noReply,
                      linkedConditionId: undefined,
                    },
                  }
                : {}),
            }
          : {
              ...outcomes,
              noReply: {
                enabled: true as const,
                timeoutMinutes:
                  normalizedNoReplyConfig.timeoutMinutes ??
                  outcomes.noReply?.timeoutMinutes ??
                  30,
                cancelIfPhrases: normalizeMissingTextPhrases(
                  normalizedNoReplyConfig.missingTextPhrases
                ),
                linkedConditionId: params.recordId,
              },
              ...(outcomes.anyReply?.linkedConditionId === params.recordId
                ? {
                    anyReply: {
                      ...outcomes.anyReply,
                      linkedConditionId: undefined,
                    },
                  }
                : {}),
            };

      if (
        JSON.stringify(actionData.actionOutcomes) !==
        JSON.stringify(nextOutcomes)
      ) {
        actionNode.data = {
          ...actionData,
          actionOutcomes: nextOutcomes,
        } as unknown as Record<string, unknown>;
        changed = true;
      }
      expectedSourceNodeId = parentRef.sourceActionNodeId;
      expectedHandleId =
        params.conditionType === "user_replied"
          ? ACTION_ANY_REPLY_OUTCOME_HANDLE_ID
          : ACTION_NO_REPLY_OUTCOME_HANDLE_ID;
    }

    const conflictingEdge = edges.find(
      edge =>
        normalizeString(edge.source) === expectedSourceNodeId &&
        normalizeString(edge.sourceHandle) === expectedHandleId &&
        normalizeString(edge.target) !== parentRef.scenarioLinkNodeId
    );
    if (conflictingEdge) {
      throw new Error(
        LINKED_CONDITION_ERROR_CODES.conflictingParentBranchTarget
      );
    }

    const targetEdge = edges.find(
      edge =>
        normalizeString(edge.source) === expectedSourceNodeId &&
        normalizeString(edge.target) === parentRef.scenarioLinkNodeId
    );
    if (targetEdge && targetEdge.sourceHandle !== expectedHandleId) {
      targetEdge.sourceHandle = expectedHandleId;
      changed = true;
    }
  }

  return { nodes, edges, changed };
}

export function resolveChildScenarioLinkedConditionId(
  scenario: ScenarioRecord
): string {
  const triggerNode = findTriggerNodeForScenario({ scenario });
  return normalizeString(
    (triggerNode?.data as ScenarioNodeData | undefined)?.linkedConditionId
  );
}

export function compareLinkedConditionRecords(params: {
  preferredRecordId: string;
  left: LinkedConditionRecord;
  right: LinkedConditionRecord;
}): number {
  const leftId = normalizeString(String(params.left._id || ""));
  const rightId = normalizeString(String(params.right._id || ""));
  const leftPreferred =
    params.preferredRecordId.length > 0 && leftId === params.preferredRecordId;
  const rightPreferred =
    params.preferredRecordId.length > 0 && rightId === params.preferredRecordId;
  if (leftPreferred !== rightPreferred) {
    return leftPreferred ? -1 : 1;
  }

  const updatedAtDelta =
    normalizeTimestampMs(params.right.updatedAt) -
    normalizeTimestampMs(params.left.updatedAt);
  if (updatedAtDelta !== 0) {
    return updatedAtDelta;
  }

  return leftId.localeCompare(rightId);
}

export function computeLinkedConditionDedupeFacts(params: {
  childScenario: ScenarioRecord;
  records: LinkedConditionRecord[];
}): {
  canonicalRecord: LinkedConditionRecord;
  canonicalRecordId: string;
  mergedParentRefs: LinkedConditionParentRef[];
  duplicateRecordIds: string[];
} | null {
  if (params.records.length === 0) return null;

  const preferredRecordId = resolveChildScenarioLinkedConditionId(
    params.childScenario
  );
  const sortedRecords = [...params.records].sort((left, right) =>
    compareLinkedConditionRecords({
      preferredRecordId,
      left,
      right,
    })
  );
  const canonicalRecord = sortedRecords[0];
  const canonicalRecordId = normalizeString(String(canonicalRecord?._id || ""));
  if (!canonicalRecord || !canonicalRecordId) return null;

  return {
    canonicalRecord,
    canonicalRecordId,
    mergedParentRefs: dedupeParentRefs(
      sortedRecords.flatMap(record => normalizeParentRefs(record.parentRefs))
    ),
    duplicateRecordIds: sortedRecords
      .slice(1)
      .map(record => normalizeString(String(record._id || "")))
      .filter(Boolean),
  };
}

export function collectLinkedConditionIdsFromNodes(nodes: unknown): string[] {
  return Array.from(
    new Set(
      asNodes(nodes)
        .map(node =>
          normalizeString(
            (node.data as ScenarioNodeData | undefined)?.linkedConditionId
          )
        )
        .filter(Boolean)
    )
  );
}

export function projectLinkedConditionParentCountsByNodeId(params: {
  nodes: unknown;
  records: LinkedConditionRecord[];
}): Record<string, number> {
  const recordById = new Map<string, LinkedConditionRecord>(
    params.records.map(record => [
      normalizeString(String(record._id || "")),
      record,
    ])
  );
  const parentCountByNodeId: Record<string, number> = {};

  for (const node of asNodes(params.nodes)) {
    const nodeData = (node.data || {}) as ScenarioNodeData;
    const linkedConditionId = normalizeString(nodeData.linkedConditionId);
    const record = linkedConditionId
      ? recordById.get(linkedConditionId)
      : undefined;
    const nodeId = normalizeString(node.id);
    if (!record || !nodeId) continue;
    parentCountByNodeId[nodeId] = normalizeParentRefs(record.parentRefs).length;
  }

  return parentCountByNodeId;
}
