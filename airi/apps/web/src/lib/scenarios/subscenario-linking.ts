import type { ScenarioNodeData } from "@icecore/scenario-contracts";
import { parseScenarioActionOutcomeHandleId } from "@icecore/scenario-contracts";
import {
  isPostActionConditionNodeData,
  parsePostActionAnswerMatchHandleId,
  resolveConditionalScenarioLinkRefs,
  resolvePostActionConditionTypeFromHandle,
} from "@icecore/scenario-contracts";
import { readTrimmedString as normalizeString } from "@icecore/shared/lib/value-utils";

export type ScenarioGraphNodeLike = { id?: string; data?: ScenarioNodeData };
export type ScenarioGraphEdgeLike = {
  source?: string;
  target?: string;
  sourceHandle?: string | null;
};

export type SubscenarioLinkSummary = {
  linkedChildScenarioIds: string[];
  actionNodeCount: number;
  actionNodeIdsByChildScenarioId: Record<string, string[]>;
};

export const SUBSCENARIO_LINK_ERROR_CODES = {
  selfLinkNotAllowed: "self_link_not_allowed",
  scenarioLinkRequiresConditionBranchSource:
    "scenario_link_requires_condition_branch_source",
  conditionBranchLinkedToMultipleSubscenarios:
    "condition_branch_linked_to_multiple_subscenarios",
} as const;

export type SubscenarioLinkErrorCode =
  (typeof SUBSCENARIO_LINK_ERROR_CODES)[keyof typeof SUBSCENARIO_LINK_ERROR_CODES];

function resolveIncomingActionNodeIds(params: {
  conditionNodeId: string;
  nodesById: Map<string, ScenarioGraphNodeLike>;
  edges: ScenarioGraphEdgeLike[];
}): string[] {
  return Array.from(
    new Set(
      params.edges
        .filter(edge => normalizeString(edge.target) === params.conditionNodeId)
        .flatMap(edge => {
          const sourceId = normalizeString(edge.source);
          if (!sourceId) return [];
          const sourceNode = params.nodesById.get(sourceId);
          return sourceNode?.data?.kind === "action" ? [sourceId] : [];
        })
    )
  );
}

export function resolveSubscenarioLinkSummary(params: {
  scenarioId: string;
  nodes: ScenarioGraphNodeLike[];
  edges: ScenarioGraphEdgeLike[];
}): {
  summary: SubscenarioLinkSummary;
  errors: SubscenarioLinkErrorCode[];
} {
  const scenarioId = params.scenarioId.trim();
  const nodeById = new Map<string, ScenarioGraphNodeLike>();
  for (const node of params.nodes) {
    const nodeId = normalizeString(node.id);
    if (!nodeId) continue;
    nodeById.set(nodeId, node);
  }

  const errors = new Set<SubscenarioLinkErrorCode>();
  const targetCountsByBranch = new Map<string, Set<string>>();
  const childToActionIds = new Map<string, Set<string>>();
  const uniqueActionNodeIds = new Set<string>();

  for (const edge of params.edges) {
    const targetId = normalizeString(edge.target);
    if (!targetId) continue;

    const targetNode = nodeById.get(targetId);
    if (targetNode?.data?.kind !== "scenario_link") {
      continue;
    }

    const linkedScenarioId = normalizeString(targetNode.data.linkedScenarioId);
    if (!linkedScenarioId) continue;
    if (linkedScenarioId === scenarioId) {
      errors.add(SUBSCENARIO_LINK_ERROR_CODES.selfLinkNotAllowed);
      continue;
    }

    const sourceId = normalizeString(edge.source);
    const sourceNode = sourceId ? nodeById.get(sourceId) : null;
    const branchType = resolvePostActionConditionTypeFromHandle(
      edge.sourceHandle
    );
    const answerMatchRuleId = parsePostActionAnswerMatchHandleId(
      edge.sourceHandle
    );
    const actionOutcome =
      sourceNode?.data?.kind === "action"
        ? parseScenarioActionOutcomeHandleId(edge.sourceHandle)
        : null;
    const linkedActionOutcomeType =
      actionOutcome?.type === "any_reply"
        ? "user_replied"
        : actionOutcome?.type === "no_reply"
          ? "no_reply_timeout"
          : null;
    if (
      !sourceId ||
      !sourceNode ||
      ((!isPostActionConditionNodeData(sourceNode.data) ||
        (!branchType && !answerMatchRuleId)) &&
        !linkedActionOutcomeType)
    ) {
      errors.add(
        SUBSCENARIO_LINK_ERROR_CODES.scenarioLinkRequiresConditionBranchSource
      );
      continue;
    }

    const branchKey = `${sourceId}:${
      linkedActionOutcomeType ??
      branchType ??
      `answer_match:${answerMatchRuleId}`
    }`;
    const currentTargets =
      targetCountsByBranch.get(branchKey) ?? new Set<string>();
    currentTargets.add(targetId);
    targetCountsByBranch.set(branchKey, currentTargets);
    if (currentTargets.size > 1) {
      errors.add(
        SUBSCENARIO_LINK_ERROR_CODES.conditionBranchLinkedToMultipleSubscenarios
      );
    }

    if (answerMatchRuleId && isPostActionConditionNodeData(sourceNode.data)) {
      for (const actionNodeId of resolveIncomingActionNodeIds({
        conditionNodeId: sourceId,
        nodesById: nodeById,
        edges: params.edges,
      })) {
        uniqueActionNodeIds.add(actionNodeId);
        const currentActionIds =
          childToActionIds.get(linkedScenarioId) ?? new Set<string>();
        currentActionIds.add(actionNodeId);
        childToActionIds.set(linkedScenarioId, currentActionIds);
      }
    }
  }

  const resolved = resolveConditionalScenarioLinkRefs({
    nodes: params.nodes,
    edges: params.edges,
  });

  for (const ref of resolved.refs) {
    if (ref.childScenarioId === scenarioId) {
      errors.add(SUBSCENARIO_LINK_ERROR_CODES.selfLinkNotAllowed);
      continue;
    }

    uniqueActionNodeIds.add(ref.sourceActionNodeId);
    const currentActionIds =
      childToActionIds.get(ref.childScenarioId) ?? new Set<string>();
    currentActionIds.add(ref.sourceActionNodeId);
    childToActionIds.set(ref.childScenarioId, currentActionIds);
  }

  const actionNodeIdsByChildScenarioId: Record<string, string[]> = {};
  for (const [childScenarioId, actionNodeIds] of childToActionIds.entries()) {
    actionNodeIdsByChildScenarioId[childScenarioId] = Array.from(actionNodeIds);
  }

  return {
    summary: {
      linkedChildScenarioIds: Array.from(childToActionIds.keys()),
      actionNodeCount: uniqueActionNodeIds.size,
      actionNodeIdsByChildScenarioId,
    },
    errors: Array.from(errors),
  };
}
