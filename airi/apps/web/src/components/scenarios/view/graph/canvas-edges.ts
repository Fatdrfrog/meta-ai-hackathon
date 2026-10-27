import { isPlainRecord } from "@icecore/shared/lib/value-utils";
import type { ScenarioFlowEdge } from "../../types";

type ScenarioCanvasEdgeEntry = {
  source: ScenarioFlowEdge;
  selected: boolean;
  highlighted: boolean;
  output: ScenarioFlowEdge;
};

/** Each edge's last canvas edge, by edge id. */
export type ScenarioCanvasEdgeCache = Map<string, ScenarioCanvasEdgeEntry>;

export function createScenarioCanvasEdgeCache(): ScenarioCanvasEdgeCache {
  return new Map();
}

/** Equal values, comparing plain objects key by key down to `depth` levels. */
function isSameValue(left: unknown, right: unknown, depth: number): boolean {
  if (Object.is(left, right)) return true;
  if (depth === 0 || !isPlainRecord(left) || !isPlainRecord(right)) {
    return false;
  }
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      key =>
        Object.hasOwn(right, key) &&
        isSameValue(left[key], right[key], depth - 1)
    )
  );
}

/**
 * Return edges are rebuilt on every pass (edge, its data, and the route in
 * it), so an edge counts as unchanged when it matches down to that route.
 */
const RETURN_EDGE_DEPTH = 3;

function toCanvasEdge(
  edge: ScenarioFlowEdge,
  selected: boolean,
  highlighted: boolean
): ScenarioFlowEdge {
  return {
    ...edge,
    selected,
    ...(highlighted
      ? {
          animated: true,
          style: {
            ...edge.style,
            stroke: "var(--primary)",
            strokeWidth: 3,
          },
        }
      : {}),
  };
}

/**
 * The edges React Flow draws, with canvas selection and route highlights.
 * An edge that did not change keeps its previous object, so React Flow does
 * not re-render it when a node is measured or moved elsewhere.
 */
export function projectScenarioCanvasEdges(
  edges: readonly ScenarioFlowEdge[],
  selectedEdgeIds: ReadonlySet<string>,
  highlightedEdgeIds: ReadonlySet<string>,
  cache: ScenarioCanvasEdgeCache
): ScenarioFlowEdge[] {
  const edgeIds = new Set<string>();
  const canvasEdges = edges.map(edge => {
    edgeIds.add(edge.id);
    const selected = selectedEdgeIds.has(edge.id);
    const highlighted = highlightedEdgeIds.has(edge.id);
    const entry = cache.get(edge.id);
    if (
      entry &&
      entry.selected === selected &&
      entry.highlighted === highlighted &&
      isSameValue(entry.source, edge, RETURN_EDGE_DEPTH)
    ) {
      return entry.output;
    }
    const output = toCanvasEdge(edge, selected, highlighted);
    cache.set(edge.id, { source: edge, selected, highlighted, output });
    return output;
  });
  for (const edgeId of cache.keys()) {
    if (!edgeIds.has(edgeId)) cache.delete(edgeId);
  }
  return canvasEdges;
}
