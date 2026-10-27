import { canonicalizeLegacyInteractiveNoReplyAssignmentEdges } from "@/lib/scenarios/legacy-action-routing";
import { extractWhatsAppTemplateQuickReplyBranchOptions } from "@/lib/scenarios/whatsapp-template-button-branches";
import {
  ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID,
  buildFlowBranchSourceHandleId,
  buildTelegramBranchSourceHandleId,
  buildWhatsAppSessionChoiceSourceHandleId,
  buildWhatsAppTemplateButtonSourceHandleId,
} from "@icecore/scenario-contracts";
import { readTrimmedString } from "@icecore/shared/lib/value-utils";
import { DEFAULT_SCENARIO_EDGE_STYLE, SCENARIO_HANDLE_RULES } from "./config";
import type {
  ScenarioFlowEdge,
  ScenarioFlowNode,
  ScenarioNodeData,
} from "../types";
import { ACTION_BRANCH_SOURCE_HANDLE_DESCRIPTORS } from "./source-handle-descriptors";
import {
  getNodeKind,
  isValidSourceHandleForNode,
  resolvePersistedConnectionSourceHandleId,
} from "./source-handles";

type TargetSourceHandleResolver = (params: {
  sourceNode: ScenarioFlowNode;
  targetNode: ScenarioFlowNode;
}) => string | null;

const TARGET_SOURCE_HANDLE_RESOLVERS: Partial<
  Record<string, TargetSourceHandleResolver>
> = {
  [ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID]: ({ targetNode }) => {
    const targetData = targetNode.data as ScenarioNodeData;
    const fieldId = readTrimmedString(targetData.flowBranchSourceFieldId);
    const optionId = readTrimmedString(targetData.flowBranchOptionId);
    return fieldId && optionId
      ? buildFlowBranchSourceHandleId(fieldId, optionId)
      : null;
  },
  [ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID]: ({
    sourceNode,
    targetNode,
  }) => {
    const targetData = targetNode.data as ScenarioNodeData;
    const payload = readTrimmedString(targetData.whatsAppTemplateButtonPayload);
    if (!payload) return null;

    const matchingOption = extractWhatsAppTemplateQuickReplyBranchOptions({
      actionNodeId: sourceNode.id,
      nodeData: sourceNode.data as ScenarioNodeData,
    }).find(option => option.payload === payload);

    return matchingOption
      ? buildWhatsAppTemplateButtonSourceHandleId(matchingOption.buttonId)
      : null;
  },
  [ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID]: ({
    targetNode,
  }) => {
    const targetData = targetNode.data as ScenarioNodeData;
    const payload = readTrimmedString(targetData.whatsAppSessionChoicePayload);
    return payload ? buildWhatsAppSessionChoiceSourceHandleId(payload) : null;
  },
  [ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID]: ({ targetNode }) => {
    const targetData = targetNode.data as ScenarioNodeData;
    const payload = readTrimmedString(targetData.telegramBranchPayload);
    return payload ? buildTelegramBranchSourceHandleId(payload) : null;
  },
};

function resolveNormalizedActionBranchSourceHandle(params: {
  sourceNode: ScenarioFlowNode;
  targetNode: ScenarioFlowNode;
  requestedSourceHandle?: string | null;
  resolvedSourceHandle: string;
}): string {
  const {
    sourceNode,
    targetNode,
    requestedSourceHandle,
    resolvedSourceHandle,
  } = params;
  const sourceData = sourceNode.data as ScenarioNodeData;
  const requestedOptionHandle = readTrimmedString(requestedSourceHandle);

  for (const descriptor of ACTION_BRANCH_SOURCE_HANDLE_DESCRIPTORS) {
    if (
      resolvedSourceHandle !== descriptor.outputHandleId ||
      !descriptor.usesBranchHandles(sourceData)
    ) {
      continue;
    }

    if (
      descriptor.parseSourceHandleId?.(requestedOptionHandle) &&
      isValidSourceHandleForNode(sourceNode, requestedOptionHandle)
    ) {
      return requestedOptionHandle;
    }

    const targetOptionHandle =
      TARGET_SOURCE_HANDLE_RESOLVERS[descriptor.outputHandleId]?.({
        sourceNode,
        targetNode,
      }) ?? null;
    return targetOptionHandle &&
      isValidSourceHandleForNode(sourceNode, targetOptionHandle)
      ? targetOptionHandle
      : resolvedSourceHandle;
  }

  return resolvedSourceHandle;
}

export function normalizeScenarioEdges(
  nodes: ScenarioFlowNode[],
  edges: Array<Omit<ScenarioFlowEdge, "id"> & { id?: string }>
): ScenarioFlowEdge[] {
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const canonicalEdges = canonicalizeLegacyInteractiveNoReplyAssignmentEdges({
    nodes,
    edges,
  });

  return canonicalEdges.flatMap((edge, index) => {
    const sourceNode = nodesById.get(edge.source);
    const targetNode = nodesById.get(edge.target);
    if (!sourceNode || !targetNode) return [];
    const requestedSourceHandle = edge.sourceHandle;

    const sourceOutputHandleId = resolvePersistedConnectionSourceHandleId({
      node: sourceNode,
      requestedSourceHandle,
    });
    const targetRule = SCENARIO_HANDLE_RULES[getNodeKind(targetNode)];
    if (!sourceOutputHandleId || !targetRule?.inputHandleId) {
      return [];
    }

    const sourceHandleId = resolveNormalizedActionBranchSourceHandle({
      sourceNode,
      targetNode,
      requestedSourceHandle,
      resolvedSourceHandle: sourceOutputHandleId,
    });

    return [
      {
        ...edge,
        id: edge.id || `edge-${edge.source}-${edge.target}-${index}`,
        sourceHandle: sourceHandleId,
        targetHandle: targetRule.inputHandleId,
        type: DEFAULT_SCENARIO_EDGE_STYLE.type,
        markerEnd: edge.markerEnd ?? DEFAULT_SCENARIO_EDGE_STYLE.markerEnd,
      },
    ];
  });
}
