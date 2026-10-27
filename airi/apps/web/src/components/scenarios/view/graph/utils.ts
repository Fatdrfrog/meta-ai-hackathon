import { getNodeKind } from "../../graph/source-handles";
import type {
  ScenarioFlowEdge,
  ScenarioFlowNode,
  ScenarioNodeData,
} from "../../types";
import {
  resolveReplyModeFromNodeData,
  resolveScenarioActionTypeFromNodeData,
} from "@icecore/airi-runtime/scenario-action-semantics";

function isInstagramReplyActionNode(nodeData: ScenarioNodeData): boolean {
  return (
    nodeData.kind === "action" &&
    resolveScenarioActionTypeFromNodeData(nodeData) === "reply" &&
    nodeData.actionReplyChannel === "instagram"
  );
}

export function findInstagramReplyActionIdsAttachedToBulkRoot(
  nodes: ScenarioFlowNode[],
  edges: ScenarioFlowEdge[]
): Set<string> {
  const nodesById = new Map(nodes.map(node => [node.id, node] as const));
  const attachedNodeIdsByNodeId = new Map<string, string[]>();

  for (const edge of edges) {
    if (!edge.source || !edge.target) continue;
    const sourceConnections = attachedNodeIdsByNodeId.get(edge.source) ?? [];
    sourceConnections.push(edge.target);
    attachedNodeIdsByNodeId.set(edge.source, sourceConnections);

    const targetConnections = attachedNodeIdsByNodeId.get(edge.target) ?? [];
    targetConnections.push(edge.source);
    attachedNodeIdsByNodeId.set(edge.target, targetConnections);
  }

  const blockedActionIds = new Set<string>();
  for (const node of nodes) {
    const nodeData = node.data as ScenarioNodeData;
    if (!isInstagramReplyActionNode(nodeData)) continue;

    const visited = new Set<string>();
    const stack = [...(attachedNodeIdsByNodeId.get(node.id) ?? [])];
    while (stack.length > 0) {
      const attachedNodeId = stack.pop();
      if (!attachedNodeId || visited.has(attachedNodeId)) continue;
      visited.add(attachedNodeId);

      const attachedNode = nodesById.get(attachedNodeId);
      const attachedData = attachedNode?.data as ScenarioNodeData | undefined;
      if (!attachedData) continue;

      if (attachedData.kind === "bulk") {
        blockedActionIds.add(node.id);
        break;
      }

      stack.push(...(attachedNodeIdsByNodeId.get(attachedNodeId) ?? []));
    }
  }

  return blockedActionIds;
}

// ---------------------------------------------------------------------------
// Knowledge node disabled state
// ---------------------------------------------------------------------------

/**
 * Returns true when **every** action node in the graph uses a non-AI reply
 * mode, meaning the knowledge/context node provides no value.
 *
 * Non-AI action types: `whatsapp_template`, `assign_human`, and `reply`
 * with replyMode === `"fixed"`.
 *
 * When there are no action nodes at all, returns false (default: knowledge
 * is potentially useful).
 */
export function isAllActionsNonAiReply(nodes: ScenarioFlowNode[]): boolean {
  const actionNodes = nodes.filter(node => getNodeKind(node) === "action");
  if (actionNodes.length === 0) return false;

  return actionNodes.every(node => {
    const nodeData = node.data as ScenarioNodeData;
    const actionType =
      resolveScenarioActionTypeFromNodeData(nodeData) ?? "reply";
    if (actionType === "whatsapp_template" || actionType === "assign_human") {
      return true;
    }
    // reply with fixed mode does not need AI context
    if (actionType === "reply") {
      const replyMode = resolveReplyModeFromNodeData(nodeData);
      return replyMode === "fixed";
    }
    return false;
  });
}
