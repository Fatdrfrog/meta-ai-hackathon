import type { ScenarioFlowEdge, ScenarioFlowNode } from "../../types";

export function getScenarioRouteKey(
  source: string,
  sourceHandle?: string | null
) {
  return JSON.stringify([source, sourceHandle ?? "right-source"]);
}

/** Display only. Reachability after cutting routes preserves shared descendants. */
export function projectScenarioBranchVisibility(params: {
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
  collapsedRoutes: ReadonlySet<string>;
  focusedNodeId?: string | null;
}) {
  const { nodes, edges, focusedNodeId } = params;
  const cuts = new Set(params.collapsedRoutes);
  if (!cuts.size) return { nodes, edges };
  const outgoing = new Map<string, ScenarioFlowEdge[]>();
  const incoming = new Set<string>();
  for (const edge of edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge);
    outgoing.set(edge.source, list);
    incoming.add(edge.target);
  }
  let roots = nodes
    .filter(node => node.data.kind === "trigger" || node.data.kind === "bulk")
    .map(node => node.id);
  if (!roots.length)
    roots = nodes.filter(node => !incoming.has(node.id)).map(node => node.id);
  if (!roots.length && nodes.length) roots = [nodes[0].id];

  const originalReachable = new Set(roots);
  const parent = new Map<string, ScenarioFlowEdge>();
  const queue = [...roots];
  for (let index = 0; index < queue.length; index++) {
    for (const edge of outgoing.get(queue[index]) ?? []) {
      if (originalReachable.has(edge.target)) continue;
      originalReachable.add(edge.target);
      parent.set(edge.target, edge);
      queue.push(edge.target);
    }
  }
  const collectVisible = (activeCuts: ReadonlySet<string>) => {
    const visible = new Set(roots);
    const visibleQueue = [...roots];
    for (let index = 0; index < visibleQueue.length; index++) {
      for (const edge of outgoing.get(visibleQueue[index]) ?? []) {
        if (
          activeCuts.has(getScenarioRouteKey(edge.source, edge.sourceHandle)) ||
          visible.has(edge.target)
        )
          continue;
        visible.add(edge.target);
        visibleQueue.push(edge.target);
      }
    }
    return visible;
  };

  // Simulator/focus navigation opens only the collapsed ancestry needed to
  // reach a hidden target. A leaf still reachable through another path stays cut.
  if (focusedNodeId && originalReachable.has(focusedNodeId)) {
    const visibleWithCuts = collectVisible(cuts);
    if (!visibleWithCuts.has(focusedNodeId)) {
      let focused = focusedNodeId;
      while (focused && parent.has(focused)) {
        const edge = parent.get(focused)!;
        cuts.delete(getScenarioRouteKey(edge.source, edge.sourceHandle));
        focused = edge.source;
      }
    }
  }
  const visible = collectVisible(cuts);
  // Orphan drafts stay discoverable so collapsing never conceals invalid nodes.
  for (const node of nodes)
    if (!originalReachable.has(node.id)) visible.add(node.id);
  return {
    nodes: nodes.filter(node => visible.has(node.id)),
    edges: edges.filter(
      edge =>
        visible.has(edge.source) &&
        visible.has(edge.target) &&
        !cuts.has(getScenarioRouteKey(edge.source, edge.sourceHandle))
    ),
  };
}
