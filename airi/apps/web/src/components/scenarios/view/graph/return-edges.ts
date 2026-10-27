import type { ScenarioFlowEdge, ScenarioFlowNode } from "../../types";
import { getScenarioLayoutReturnEdges } from "@/lib/scenarios/graph-layout";

export type ScenarioReturnEdgeData = {
  scenarioReturn: {
    lane: number;
    routeY: number;
    destinationReturnCount: number;
    showLabel: boolean;
  };
};

// Display projection only: keep persisted handles and routing bindings intact.
// An iterative DFS identifies ancestor returns regardless of canvas positions.
export function projectScenarioReturnEdges(
  nodes: ScenarioFlowNode[],
  edges: ScenarioFlowEdge[]
): ScenarioFlowEdge[] {
  const returns = getScenarioLayoutReturnEdges(nodes, edges);
  if (!returns.size) return edges;
  const byDestination = new Map<string, { count: number; lastId: string }>();
  for (const edge of edges) {
    if (returns.has(edge))
      byDestination.set(edge.target, {
        count: (byDestination.get(edge.target)?.count ?? 0) + 1,
        lastId: edge.id,
      });
  }
  const top = nodes.reduce(
    (min, node) => Math.min(min, node.position.y),
    Infinity
  );
  let lane = 0;
  return edges.map(edge => {
    if (!returns.has(edge)) return edge;
    const returnLane = lane++;
    return {
      ...edge,
      type: "scenarioReturn",
      data: {
        ...edge.data,
        scenarioReturn: {
          lane: returnLane,
          routeY: top - 56 - returnLane * 40,
          destinationReturnCount: byDestination.get(edge.target)!.count,
          showLabel: byDestination.get(edge.target)!.lastId === edge.id,
        },
      },
    };
  });
}

export function getScenarioReturnEdgePath(params: {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourceRight: number;
  targetLeft: number;
  routeY: number;
}) {
  const {
    sourceX: sx,
    sourceY: sy,
    targetX: tx,
    targetY: ty,
    routeY: y,
  } = params;
  const right = Math.max(params.sourceRight, sx) + 24;
  const left = Math.min(params.targetLeft, tx) - 24;
  const r = Math.min(12, (sy - y) / 2, (ty - y) / 2);
  return {
    path: `M ${sx} ${sy} L ${right - r} ${sy} Q ${right} ${sy} ${right} ${sy - r} L ${right} ${y + r} Q ${right} ${y} ${right - r} ${y} L ${left + r} ${y} Q ${left} ${y} ${left} ${y + r} L ${left} ${ty - r} Q ${left} ${ty} ${left + r} ${ty} L ${tx} ${ty}`,
    labelX: (right + left) / 2,
    labelY: y,
  };
}
