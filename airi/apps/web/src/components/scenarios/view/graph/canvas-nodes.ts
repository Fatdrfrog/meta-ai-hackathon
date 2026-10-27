import type { ScenarioEditorFlowNode } from "../node-enrichment/types";

const ROUTE_HIGHLIGHT_CLASS = "scenario-route-highlight";

type ScenarioCanvasNodeEntry = {
  source: ScenarioEditorFlowNode;
  selected: boolean;
  highlighted: boolean;
  output: ScenarioEditorFlowNode;
};

/** Each node's last canvas node, by node id. */
export type ScenarioCanvasNodeCache = Map<string, ScenarioCanvasNodeEntry>;

export function createScenarioCanvasNodeCache(): ScenarioCanvasNodeCache {
  return new Map();
}

function toCanvasNode(
  node: ScenarioEditorFlowNode,
  selected: boolean,
  highlighted: boolean
): ScenarioEditorFlowNode {
  return {
    ...node,
    selected,
    className: highlighted
      ? `${node.className ?? ""} ${ROUTE_HIGHLIGHT_CLASS}`
      : node.className,
  };
}

/**
 * The editor nodes React Flow draws, with canvas selection and route
 * highlights. A node that did not change keeps its previous object, so React
 * Flow keeps its internal node and does not re-render it.
 */
export function projectScenarioCanvasNodes(
  displayNodes: readonly ScenarioEditorFlowNode[],
  selectedNodeIds: ReadonlySet<string>,
  highlightedNodeIds: ReadonlySet<string>,
  cache: ScenarioCanvasNodeCache
): ScenarioEditorFlowNode[] {
  const nodeIds = new Set<string>();
  const canvasNodes = displayNodes.map(node => {
    nodeIds.add(node.id);
    const selected = selectedNodeIds.has(node.id);
    const highlighted = highlightedNodeIds.has(node.id);
    const entry = cache.get(node.id);
    if (
      entry?.source === node &&
      entry.selected === selected &&
      entry.highlighted === highlighted
    ) {
      return entry.output;
    }
    const output = toCanvasNode(node, selected, highlighted);
    cache.set(node.id, { source: node, selected, highlighted, output });
    return output;
  });
  for (const nodeId of cache.keys()) {
    if (!nodeIds.has(nodeId)) cache.delete(nodeId);
  }
  return canvasNodes;
}
