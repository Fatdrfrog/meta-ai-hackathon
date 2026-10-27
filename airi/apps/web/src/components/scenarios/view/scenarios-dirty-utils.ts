import type { EdgeChange, NodeChange } from "@xyflow/react";
import type { ScenarioFlowEdge, ScenarioFlowNode } from "../types";

export function hasStructuralNodeChanges(
  changes: NodeChange<ScenarioFlowNode>[]
): boolean {
  return changes.some(change => {
    return (
      change.type !== "select" &&
      change.type !== "dimensions" &&
      change.type !== "position"
    );
  });
}

export function clearScenarioNodeSelection(
  nodes: ScenarioFlowNode[],
  options: { forceClone?: boolean } = {}
): ScenarioFlowNode[] {
  if (nodes.length === 0) return nodes;

  let hasSelectedState = false;
  const nextNodes = nodes.map(node => {
    if (node.selected !== undefined) {
      hasSelectedState = true;
    }

    const nodeWithoutSelection = { ...node };
    delete nodeWithoutSelection.selected;
    return nodeWithoutSelection as ScenarioFlowNode;
  });

  return hasSelectedState || options.forceClone ? nextNodes : nodes;
}

export function hasStructuralEdgeChanges(
  changes: EdgeChange<ScenarioFlowEdge>[]
): boolean {
  return changes.some(change => change.type !== "select");
}

export function omitSelectionEdgeChanges(
  changes: EdgeChange<ScenarioFlowEdge>[]
): EdgeChange<ScenarioFlowEdge>[] {
  return changes.filter(change => change.type !== "select");
}

export function clearScenarioEdgeSelection(
  edges: ScenarioFlowEdge[],
  options: { forceClone?: boolean } = {}
): ScenarioFlowEdge[] {
  if (edges.length === 0) return edges;

  let hasSelectedState = false;
  const nextEdges = edges.map(edge => {
    if (edge.selected !== undefined) {
      hasSelectedState = true;
    }

    const edgeWithoutSelection = { ...edge };
    delete edgeWithoutSelection.selected;
    return edgeWithoutSelection as ScenarioFlowEdge;
  });

  return hasSelectedState || options.forceClone ? nextEdges : edges;
}
