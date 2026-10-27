import type { ScenarioFlowNode, ScenarioNodeData } from "../../types";
import type { ScenarioNodeEnrichmentContextValue } from "../scenario-node-enrichment-context";
import {
  enrichScenarioNodeData,
  readScenarioNodeKind,
  selectScenarioNodeEnrichmentView,
  toScenarioEditorNode,
} from "./enrich-scenario-node";
import { isSameEnrichmentView } from "./enrichment-view";
import type { ScenarioEditorFlowNode, ScenarioEditorNodeData } from "./types";

type ScenarioNodeEnrichmentCacheEntry = {
  rawData: ScenarioNodeData;
  /** Null: the node reads live state, so its data is built on every pass. */
  view: object | null;
  data: ScenarioEditorNodeData;
  source: ScenarioFlowNode;
  output: ScenarioEditorFlowNode;
};

/**
 * Each node's last editor node, by node id. A pass keeps a node's editor
 * data while its persisted data and enrichment view are unchanged, and its
 * editor node while its placement is unchanged too, so memoized node
 * renderers skip it.
 */
export type ScenarioNodeEnrichmentCache = Map<
  string,
  ScenarioNodeEnrichmentCacheEntry
>;

export function createScenarioNodeEnrichmentCache(): ScenarioNodeEnrichmentCache {
  return new Map();
}

/** Same placement and flags; editor data and selection are compared apart. */
function isSameNodeFrame(
  left: ScenarioFlowNode,
  right: ScenarioFlowNode
): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left).filter(isFrameKey);
  if (leftKeys.length !== Object.keys(right).filter(isFrameKey).length) {
    return false;
  }
  return leftKeys.every(
    key =>
      Object.hasOwn(right, key) &&
      Object.is(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key]
      )
  );
}

function isFrameKey(key: string): boolean {
  return key !== "data" && key !== "selected";
}

function reuseEditorData(
  entry: ScenarioNodeEnrichmentCacheEntry | undefined,
  rawData: ScenarioNodeData,
  view: object | null
): ScenarioEditorNodeData | null {
  if (!entry || !view || !entry.view || entry.rawData !== rawData) return null;
  return isSameEnrichmentView(entry.view, view) ? entry.data : null;
}

function enrichCachedNode(
  node: ScenarioFlowNode,
  ctx: ScenarioNodeEnrichmentContextValue,
  cache: ScenarioNodeEnrichmentCache
): ScenarioEditorFlowNode | null {
  const kind = readScenarioNodeKind(node);
  if (!kind) return null;
  const rawData = node.data as ScenarioNodeData & { kind: typeof kind };
  const view = selectScenarioNodeEnrichmentView(kind, node.id, rawData, ctx);
  const entry = cache.get(node.id);
  const data =
    reuseEditorData(entry, rawData, view) ??
    enrichScenarioNodeData(kind, node.id, rawData, view ?? ctx);
  const output =
    entry && entry.data === data && isSameNodeFrame(entry.source, node)
      ? entry.output
      : toScenarioEditorNode(node, kind, data);
  cache.set(node.id, { rawData, view, data, source: node, output });
  return output;
}

/**
 * Projects persisted nodes into editor nodes, keeping every unchanged
 * node's previous editor node. Nodes no longer present leave the cache.
 */
export function enrichScenarioEditorNodesWithCache(
  nodes: readonly ScenarioFlowNode[],
  ctx: ScenarioNodeEnrichmentContextValue,
  cache: ScenarioNodeEnrichmentCache
): ScenarioEditorFlowNode[] {
  const nodeIds = new Set<string>();
  const editorNodes = nodes.flatMap(node => {
    const editorNode = enrichCachedNode(node, ctx, cache);
    if (!editorNode) return [];
    nodeIds.add(node.id);
    return [editorNode];
  });
  for (const nodeId of cache.keys()) {
    if (!nodeIds.has(nodeId)) cache.delete(nodeId);
  }
  return editorNodes;
}
