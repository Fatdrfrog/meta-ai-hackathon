import { validateEditorScenarioFlowStructure } from "@/lib/scenarios/flow-structure-validation";
import { resolveWhatsAppTemplateFormRouteIssue } from "@/lib/scenarios/graph-validation";
import {
  CONDITIONAL_SCENARIO_LINK_ERROR_CODES,
  isPostActionConditionNodeData,
  parsePostActionAnswerMatchHandleId,
  resolvePostActionConditionTypeFromHandle,
} from "@icecore/scenario-contracts";
import {
  ACTION_OUTCOME_TRANSITION,
  getScenarioActionOutputTransitionForSourceHandle,
} from "@/lib/scenarios/transition-registry";
import { parseScenarioActionOutcomeHandleId } from "@icecore/scenario-contracts";
import { type Connection, type EdgeChange } from "@xyflow/react";
import { SCENARIO_HANDLE_RULES } from "../../graph/config";
import { normalizeScenarioEdges } from "../../graph/edge-normalization";
import {
  getNodeKind,
  isValidSourceHandleForNode,
  resolveConnectionSourceHandleId,
} from "../../graph/source-handles";
import type {
  ScenarioFlowEdge,
  ScenarioFlowNode,
  ScenarioNodeData,
} from "../../types";
import {
  hasSameBranchBindingData,
  resolveBranchBindingForConnection,
  resolveBranchBindingForTargetNode,
} from "./branch-sync";

type ScenarioTranslationValues = Record<string, string | number>;

export type ScenarioGraphSnapshot = {
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
};

export type ScenarioCanvasSelection = {
  nodeIds: ReadonlySet<string>;
  edgeIds: ReadonlySet<string>;
};

export type ScenarioGraphEdit = ScenarioGraphSnapshot & {
  history: "record" | "skip";
  /** "keep" commits positions as given, e.g. a node placed where the user clicked. */
  layout?: "auto" | "keep";
};

/** Transitions return immutable graph replacements; the document owner commits them. */
export type ScenarioGraphEditor = {
  read: () => ScenarioGraphSnapshot;
  edit: (
    transition: (graph: ScenarioGraphSnapshot) => ScenarioGraphEdit | null
  ) => boolean;
};

type ScenarioConnectionValidationResult =
  | {
      kind: "valid";
      conditionBranchType: string | null;
    }
  | {
      kind: "invalid";
      errorKey: string;
      errorValues?: ScenarioTranslationValues;
    };

export type ScenarioConnectionPlan =
  | {
      kind: "valid";
      sourceHandleId: string;
      targetHandleId: string;
      targetPatch: Partial<ScenarioNodeData> | null;
    }
  | {
      kind: "invalid";
      errorKey: string;
      errorValues?: ScenarioTranslationValues;
    };

function appendTargetPatch(
  currentPatch: Partial<ScenarioNodeData> | null,
  nextPatch: Partial<ScenarioNodeData> | null
): Partial<ScenarioNodeData> | null {
  if (!nextPatch) return currentPatch;
  if (!currentPatch) return nextPatch;
  return {
    ...currentPatch,
    ...nextPatch,
  };
}

function validateConditionBranchConnection(params: {
  sourceNode: ScenarioFlowNode;
  sourceOutputHandleId: string;
  targetNode: ScenarioFlowNode;
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
}): ScenarioConnectionValidationResult {
  const { sourceNode, sourceOutputHandleId, targetNode, nodes, edges } = params;
  const sourceData = sourceNode.data as ScenarioNodeData;
  const targetData = targetNode.data as ScenarioNodeData;
  const answerMatchRuleId = isPostActionConditionNodeData(sourceData)
    ? parsePostActionAnswerMatchHandleId(sourceOutputHandleId)
    : null;
  const conditionBranchType = isPostActionConditionNodeData(sourceData)
    ? (resolvePostActionConditionTypeFromHandle(sourceOutputHandleId) ??
      (answerMatchRuleId ? `answer_match:${answerMatchRuleId}` : null))
    : null;

  if (!conditionBranchType) {
    return {
      kind: "valid",
      conditionBranchType: null,
    };
  }

  if (targetData.kind === "trigger") {
    return {
      kind: "invalid",
      errorKey: "conditionBranchTriggerTargetError",
    };
  }

  const incomingActionIds = edges
    .filter(edge => edge.target === sourceNode.id)
    .map(edge => nodes.find(node => node.id === edge.source))
    .filter(
      (node): node is ScenarioFlowNode =>
        Boolean(node) &&
        (node?.data as ScenarioNodeData | undefined)?.kind === "action"
    )
    .map(node => node.id);
  const uniqueIncomingActionIds = Array.from(new Set(incomingActionIds));

  if (uniqueIncomingActionIds.length === 0) {
    return {
      kind: "invalid",
      errorKey:
        CONDITIONAL_SCENARIO_LINK_ERROR_CODES.branchRequiresActionSource,
    };
  }

  const existingTargetCount = edges.filter(
    edge =>
      edge.source === sourceNode.id &&
      edge.sourceHandle === sourceOutputHandleId &&
      edge.target !== targetNode.id
  ).length;
  if (existingTargetCount > 0) {
    return {
      kind: "invalid",
      errorKey: CONDITIONAL_SCENARIO_LINK_ERROR_CODES.branchAllowsSingleTarget,
    };
  }

  return {
    kind: "valid",
    conditionBranchType,
  };
}

function validateActionOutcomeConnection(params: {
  sourceNode: ScenarioFlowNode;
  sourceOutputHandleId: string;
  targetNode: ScenarioFlowNode;
  edges: ScenarioFlowEdge[];
}): ScenarioConnectionValidationResult {
  const sourceData = params.sourceNode.data as ScenarioNodeData;
  const outputTransition =
    sourceData.kind === "action"
      ? getScenarioActionOutputTransitionForSourceHandle(
          sourceData,
          params.sourceOutputHandleId
        )
      : null;
  if (!outputTransition) {
    return { kind: "valid", conditionBranchType: null };
  }

  const targetData = params.targetNode.data as ScenarioNodeData;
  if (targetData.kind === "trigger") {
    return {
      kind: "invalid",
      errorKey: "actionOutcomeTriggerTargetError",
    };
  }

  const alreadyTargetsAnotherNode = params.edges.some(
    edge =>
      edge.source === params.sourceNode.id &&
      edge.sourceHandle === params.sourceOutputHandleId &&
      edge.target !== params.targetNode.id
  );
  return alreadyTargetsAnotherNode
    ? {
        kind: "invalid",
        errorKey: outputTransition.limitReachedKey,
      }
    : { kind: "valid", conditionBranchType: null };
}

function validateScenarioLinkConnection(params: {
  sourceNode: ScenarioFlowNode;
  sourceOutputHandleId: string;
  targetNode: ScenarioFlowNode;
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
  sourceConditionBranchType: string | null;
}): ScenarioConnectionValidationResult {
  const {
    sourceNode,
    sourceOutputHandleId,
    targetNode,
    sourceConditionBranchType,
  } = params;
  const targetData = targetNode.data as ScenarioNodeData;

  if (targetData.kind !== "scenario_link") {
    return {
      kind: "valid",
      conditionBranchType: sourceConditionBranchType,
    };
  }

  const sourceData = sourceNode.data as ScenarioNodeData;
  const actionOutcome =
    sourceData.kind === "action"
      ? parseScenarioActionOutcomeHandleId(sourceOutputHandleId)
      : null;
  const supportsLinkedScenario =
    Boolean(sourceConditionBranchType) ||
    actionOutcome?.type === "any_reply" ||
    actionOutcome?.type === "no_reply";
  if (!supportsLinkedScenario) {
    return {
      kind: "invalid",
      errorKey: "scenarioLinkConnectOnlyConditionBranches",
    };
  }

  return {
    kind: "valid",
    conditionBranchType: sourceConditionBranchType,
  };
}

export function resolveScenarioConnectionPlan(params: {
  connection: Pick<Connection, "sourceHandle">;
  sourceNode: ScenarioFlowNode;
  targetNode: ScenarioFlowNode;
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
}): ScenarioConnectionPlan | null {
  const { connection, sourceNode, targetNode, nodes, edges } = params;
  const sourceOutputHandleId = resolveConnectionSourceHandleId({
    node: sourceNode,
    requestedSourceHandle: connection.sourceHandle,
  });
  const targetRule = SCENARIO_HANDLE_RULES[getNodeKind(targetNode)];

  if (!sourceOutputHandleId) {
    return null;
  }

  const conditionValidation = validateConditionBranchConnection({
    sourceNode,
    sourceOutputHandleId,
    targetNode,
    nodes,
    edges,
  });
  if (conditionValidation.kind === "invalid") {
    return conditionValidation;
  }

  const actionOutcomeValidation = validateActionOutcomeConnection({
    sourceNode,
    sourceOutputHandleId,
    targetNode,
    edges,
  });
  if (actionOutcomeValidation.kind === "invalid") {
    return actionOutcomeValidation;
  }

  const formRouteIssue = resolveWhatsAppTemplateFormRouteIssue({
    sourceHandle: sourceOutputHandleId,
    sourceData: sourceNode.data as ScenarioNodeData,
    targetData: targetNode.data as ScenarioNodeData,
  });
  if (formRouteIssue) {
    return { kind: "invalid", errorKey: formRouteIssue };
  }

  if (!targetRule.inputHandleId) {
    return null;
  }

  let plannedSourceHandleId = sourceOutputHandleId;
  let targetPatch: Partial<ScenarioNodeData> | null = null;
  const branchResolution = resolveBranchBindingForConnection({
    sourceNode,
    targetNode,
    nodes,
    edges,
    requestedSourceHandle: connection.sourceHandle,
  });

  if (branchResolution && !branchResolution.patch) {
    return {
      kind: "invalid",
      errorKey: branchResolution.descriptor.limitReachedKey,
      errorValues: {
        count: branchResolution.optionCount,
      },
    };
  }

  if (branchResolution) {
    targetPatch = appendTargetPatch(targetPatch, branchResolution.patch);
    plannedSourceHandleId =
      branchResolution.sourceHandleId ?? plannedSourceHandleId;
  }

  const scenarioLinkValidation = validateScenarioLinkConnection({
    sourceNode,
    sourceOutputHandleId,
    targetNode,
    nodes,
    edges,
    sourceConditionBranchType: conditionValidation.conditionBranchType,
  });
  if (scenarioLinkValidation.kind === "invalid") {
    return scenarioLinkValidation;
  }

  const flowStructureError = validateEditorScenarioFlowStructure({
    nodes: nodes.map(node => ({
      id: node.id,
      data: node.data as ScenarioNodeData,
    })),
    edges: [
      ...edges.map(edge => ({
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? null,
      })),
      {
        source: sourceNode.id,
        target: targetNode.id,
        sourceHandle: plannedSourceHandleId,
      },
    ],
  });
  if (flowStructureError) {
    return {
      kind: "invalid",
      errorKey: flowStructureError,
    };
  }

  return {
    kind: "valid",
    sourceHandleId: plannedSourceHandleId,
    targetHandleId: targetRule.inputHandleId,
    targetPatch,
  };
}

export function normalizeNodesAfterEdgeChanges(params: {
  changes: EdgeChange<ScenarioFlowEdge>[];
  currentEdges: ScenarioFlowEdge[];
  nextEdges: ScenarioFlowEdge[];
  currentNodes: ScenarioFlowNode[];
}) {
  const { changes, currentEdges, nextEdges, currentNodes } = params;
  const targetNodeIdsToNormalize = new Set<string>();

  for (const change of changes) {
    if (change.type !== "remove") continue;

    const removedEdge = currentEdges.find(edge => edge.id === change.id);
    if (removedEdge) {
      targetNodeIdsToNormalize.add(removedEdge.target);
    }
  }

  if (targetNodeIdsToNormalize.size === 0) {
    return currentNodes;
  }

  let didChange = false;
  const nextNodes = currentNodes.map(node => {
    if (!targetNodeIdsToNormalize.has(node.id)) return node;

    const patch = resolveBranchBindingForTargetNode({
      targetNodeId: node.id,
      nodes: currentNodes,
      edges: nextEdges,
    });
    if (!patch) return node;

    const nodeData = node.data as ScenarioNodeData;
    const nextData = {
      ...nodeData,
      ...patch,
    };
    const branchBindingUnchanged = hasSameBranchBindingData(nodeData, nextData);

    if (branchBindingUnchanged) return node;

    didChange = true;
    return {
      ...node,
      data: nextData,
    };
  });

  return didChange ? nextNodes : currentNodes;
}

/** Route edits remove only this socket's edge; shared targets retain their owners. */
export function removeScenarioSourceConnections(
  graph: ScenarioGraphSnapshot,
  sourceNodeId: string,
  requestedSourceHandle: string | null | undefined
): ScenarioGraphSnapshot {
  const source = graph.nodes.find(node => node.id === sourceNodeId);
  if (!source) return graph;
  const sourceHandle = isValidSourceHandleForNode(source, requestedSourceHandle)
    ? requestedSourceHandle!.trim()
    : resolveConnectionSourceHandleId({ node: source, requestedSourceHandle });
  if (!sourceHandle) return graph;
  const normalizedSourceHandles = new Map(
    normalizeScenarioEdges(graph.nodes, graph.edges).map(edge => [
      edge.id,
      edge.sourceHandle,
    ])
  );
  const removedEdges = graph.edges.filter(
    edge =>
      edge.source === sourceNodeId &&
      (normalizedSourceHandles.get(edge.id) ?? edge.sourceHandle?.trim()) ===
        sourceHandle
  );
  if (!removedEdges.length) return graph;
  const removedIds = new Set(removedEdges.map(edge => edge.id));
  const edges = graph.edges.filter(edge => !removedIds.has(edge.id));
  return {
    nodes: normalizeNodesAfterEdgeChanges({
      changes: removedEdges.map(edge => ({
        id: edge.id,
        type: "remove" as const,
      })),
      currentEdges: graph.edges,
      nextEdges: edges,
      currentNodes: graph.nodes,
    }),
    edges,
  };
}

export function removeUnconfiguredActionOutcomeEdges(params: {
  nodeId: string;
  nodeData: ScenarioNodeData;
  edges: ScenarioFlowEdge[];
}): ScenarioFlowEdge[] {
  const configuredHandles = new Set(
    ACTION_OUTCOME_TRANSITION.getSourceHandleIds(params.nodeData)
  );
  let changed = false;
  const nextEdges = params.edges.filter(edge => {
    const isRemovedOutcomeEdge =
      edge.source === params.nodeId &&
      parseScenarioActionOutcomeHandleId(edge.sourceHandle) !== null &&
      !configuredHandles.has(edge.sourceHandle?.trim() ?? "");
    if (isRemovedOutcomeEdge) changed = true;
    return !isRemovedOutcomeEdge;
  });
  return changed ? nextEdges : params.edges;
}
