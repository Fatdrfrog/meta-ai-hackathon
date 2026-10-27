import type {
  ScenarioEntryPolicy,
  ScenarioGraphNode,
  ScenarioNodeData,
  ScenarioNodeKind,
  ScenarioRoutingCompilerDiagnostic,
} from "@icecore/scenario-contracts";
import {
  lowerScenarioRoutingGraph,
  PROMPT_INPUTS_UNMET_HANDLE,
} from "@icecore/scenario-contracts";
import { resolveScenarioActionTypeFromNodeData } from "./scenario-action-semantics";
import type { GenerativeAIInboundDisposition } from "./scenario-generative-ai-input-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScenarioRuntimeNode = ScenarioGraphNode;

export type ScenarioRuntimeEdge = {
  source?: string;
  target?: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

export type ScenarioFlowMatch = {
  selectedAction: ScenarioRuntimeNode;
  selectedActionType: import("@icecore/scenario-contracts").ScenarioActionType;
  pathNodeIds: string[];
  branchNodeIds: string[];
  generativeAI?: {
    config: import("@icecore/scenario-contracts").GenerativeAIActionConfig;
    input: GenerativeAIInboundDisposition;
  };
};

export type CompiledScenarioGraph = {
  nodes: ScenarioRuntimeNode[];
  edges: ScenarioRuntimeEdge[];
  diagnostics: ScenarioRoutingCompilerDiagnostic[];
  nodesById: Map<string, ScenarioRuntimeNode>;
  adjacency: Map<string, string[]>;
  nodeOrder: Map<string, number>;
  triggerNodeIds: string[];
  runtimeActionNodes: ScenarioRuntimeNode[];
};

type CompiledScenarioCacheEntry = {
  updatedAtMs: number;
  graph: CompiledScenarioGraph;
};

export type ScenarioGraphRecord = {
  graphProjection?: "triggers";
  _id?: unknown;
  name?: unknown;
  nodes?: unknown;
  edges?: unknown;
  updatedAt?: unknown;
};

export type ScenarioRecord = ScenarioGraphRecord & {
  priority?: unknown;
  matchingRole?: unknown;
  entryPolicy: ScenarioEntryPolicy;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMPILED_SCENARIO_CACHE_MAX_ENTRIES = 300;
const compiledScenarioCache = new Map<string, CompiledScenarioCacheEntry>();
const SCENARIO_NODE_KIND_SET = new Set<ScenarioNodeKind>([
  "bulk",
  "trigger",
  "context",
  "logic",
  "action",
  "scenario_link",
]);

function isScenarioNodeData(value: unknown): value is ScenarioNodeData {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<ScenarioNodeData>;
  return SCENARIO_NODE_KIND_SET.has(data.kind as ScenarioNodeKind);
}

// ---------------------------------------------------------------------------
// Parsing functions
// ---------------------------------------------------------------------------

/**
 * Parse raw node data into typed ScenarioRuntimeNode[].
 *
 * This is the single canonical implementation – previously duplicated across
 * scenario-runtime, scenario-timeouts, and scenario-timeout-processor.
 */
export function parseNodes(rawNodes: unknown): ScenarioRuntimeNode[] {
  if (!Array.isArray(rawNodes)) return [];
  return rawNodes.flatMap((rawNode) => {
    const node = parseRawScenarioNode(rawNode);
    return node ? [node] : [];
  });
}

export function parseRawScenarioNode(
  rawNode: unknown,
): ScenarioRuntimeNode | null {
  if (!rawNode || typeof rawNode !== "object") return null;
  const node = rawNode as Record<string, unknown>;
  const id = typeof node.id === "string" ? node.id.trim() : "";
  if (!id) return null;
  if (!isScenarioNodeData(node.data)) return null;
  return { id, data: node.data };
}

export function findRawScenarioNode(params: {
  scenario: ScenarioGraphRecord;
  nodeId?: string | null;
  kind?: ScenarioNodeKind | null;
}): ScenarioRuntimeNode | null {
  const nodeId = typeof params.nodeId === "string" ? params.nodeId.trim() : "";
  if (!nodeId || !Array.isArray(params.scenario.nodes)) return null;

  for (const rawNode of params.scenario.nodes) {
    const node = parseRawScenarioNode(rawNode);
    if (!node) continue;
    if (node.id !== nodeId) continue;
    if (params.kind && node.data.kind !== params.kind) continue;
    return node;
  }

  return null;
}

export function getPrimaryRawScenarioTriggerNode(
  scenario: ScenarioGraphRecord,
): ScenarioRuntimeNode | null {
  if (!Array.isArray(scenario.nodes)) return null;

  for (const rawNode of scenario.nodes) {
    const node = parseRawScenarioNode(rawNode);
    if (node?.data.kind === "trigger") {
      return node;
    }
  }

  return null;
}

export function parseEdges(rawEdges: unknown): ScenarioRuntimeEdge[] {
  if (!Array.isArray(rawEdges)) return [];
  return rawEdges.flatMap((rawEdge) => {
    if (!rawEdge || typeof rawEdge !== "object") return [];
    const edge = rawEdge as Record<string, unknown>;
    return [
      {
        source: typeof edge.source === "string" ? edge.source : undefined,
        target: typeof edge.target === "string" ? edge.target : undefined,
        sourceHandle:
          typeof edge.sourceHandle === "string" ? edge.sourceHandle : null,
        targetHandle:
          typeof edge.targetHandle === "string" ? edge.targetHandle : null,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

export function buildAdjacencyMap(
  edges: ScenarioRuntimeEdge[],
): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  edges.forEach((edge) => {
    if (!edge.source || !edge.target) return;
    if (edge.sourceHandle === PROMPT_INPUTS_UNMET_HANDLE) return;
    const current = adjacency.get(edge.source) || [];
    current.push(edge.target);
    adjacency.set(edge.source, current);
  });
  return adjacency;
}

export function getNodeOrderMap(
  nodes: ScenarioRuntimeNode[],
): Map<string, number> {
  const order = new Map<string, number>();
  nodes.forEach((node, index) => {
    order.set(node.id, index);
  });
  return order;
}

export function getUpdatedAtMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Graph compilation & caching
// ---------------------------------------------------------------------------

export function compileScenarioGraph(
  nodes: ScenarioRuntimeNode[],
  edges: ScenarioRuntimeEdge[],
): CompiledScenarioGraph {
  const lowered = lowerScenarioRoutingGraph({ nodes, edges });
  const loweredNodes = lowered.nodes as ScenarioRuntimeNode[];
  const loweredEdges = lowered.edges as ScenarioRuntimeEdge[];
  const nodesById = new Map(loweredNodes.map((node) => [node.id, node]));
  const runtimeActionNodes = loweredNodes.filter((node) => {
    if (node.data.kind !== "action") return false;
    const actionType = resolveScenarioActionTypeFromNodeData(node.data);
    return Boolean(actionType);
  });

  return {
    nodes: loweredNodes,
    edges: loweredEdges,
    diagnostics: lowered.diagnostics,
    nodesById,
    adjacency: buildAdjacencyMap(loweredEdges),
    nodeOrder: getNodeOrderMap(loweredNodes),
    triggerNodeIds: loweredNodes
      .filter((node) => node.data.kind === "trigger")
      .map((node) => node.id),
    runtimeActionNodes,
  };
}

function enforceCompiledScenarioCacheLimit(): void {
  if (compiledScenarioCache.size <= COMPILED_SCENARIO_CACHE_MAX_ENTRIES) {
    return;
  }

  const overflow =
    compiledScenarioCache.size - COMPILED_SCENARIO_CACHE_MAX_ENTRIES;
  let removed = 0;
  for (const key of compiledScenarioCache.keys()) {
    compiledScenarioCache.delete(key);
    removed += 1;
    if (removed >= overflow) break;
  }
}

export function getCompiledScenarioGraph(
  scenario: ScenarioGraphRecord,
): CompiledScenarioGraph {
  const scenarioId = scenario.graphProjection === "triggers" ? "" : String(scenario._id || "");
  const updatedAtMs = getUpdatedAtMs(scenario.updatedAt);

  if (scenarioId) {
    const cached = compiledScenarioCache.get(scenarioId);
    if (cached && cached.updatedAtMs === updatedAtMs) {
      return cached.graph;
    }
  }

  const graph = compileScenarioGraph(
    parseNodes(scenario.nodes),
    parseEdges(scenario.edges),
  );

  if (scenarioId) {
    compiledScenarioCache.set(scenarioId, {
      updatedAtMs,
      graph,
    });
    enforceCompiledScenarioCacheLimit();
  }

  return graph;
}

// ---------------------------------------------------------------------------
// Graph traversal helpers
// ---------------------------------------------------------------------------

export function getPrimaryTriggerNode(
  graph: CompiledScenarioGraph,
): ScenarioRuntimeNode | null {
  return getTriggerNodes(graph)[0] || null;
}

export function getTriggerNodes(
  graph: CompiledScenarioGraph,
): ScenarioRuntimeNode[] {
  if (graph.triggerNodeIds.length === 0) return [];
  const sortedTriggerIds = [...graph.triggerNodeIds].sort(
    (a, b) => (graph.nodeOrder.get(a) || 0) - (graph.nodeOrder.get(b) || 0),
  );
  return sortedTriggerIds.flatMap((triggerId) => {
    const node = graph.nodesById.get(triggerId);
    return node?.data.kind === "trigger" ? [node] : [];
  });
}

export function reconstructPathFromPrevious(params: {
  previous: Map<string, string | null>;
  targetNodeId: string;
}): string[] {
  if (!params.previous.has(params.targetNodeId)) return [];
  const path: string[] = [];
  let cursor: string | null = params.targetNodeId;
  while (cursor) {
    path.push(cursor);
    cursor = params.previous.get(cursor) ?? null;
  }
  return path.reverse();
}

/**
 * Forward walk from `startId` to `targetId` using adjacency, recording one
 * parent per node. Used when the trigger-BFS `previous` tree takes a shortcut
 * that skips the action node whose keyboard/flow produced the user's tap.
 */
export function reconstructForwardPath(params: {
  adjacency: Map<string, string[]>;
  startId: string;
  targetId: string;
  canVisit: (nodeId: string) => boolean;
}): string[] | null {
  if (!params.canVisit(params.startId)) return null;
  const forwardPrev = new Map<string, string | null>();
  const queue: string[] = [];
  forwardPrev.set(params.startId, null);
  queue.push(params.startId);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (id === params.targetId) {
      const tail: string[] = [];
      let c: string | null = params.targetId;
      while (c) {
        tail.push(c);
        c = forwardPrev.get(c) ?? null;
      }
      tail.reverse();
      return tail;
    }
    const outs = params.adjacency.get(id) ?? [];
    for (const next of outs) {
      if (forwardPrev.has(next)) continue;
      if (!params.canVisit(next)) continue;
      forwardPrev.set(next, id);
      queue.push(next);
    }
  }
  return null;
}

/**
 * When multiple routes exist to the same branch target, BFS from triggers may
 * record a `previous` chain that skips `preferredId` (e.g. direct t1→t3 while
 * the user tapped a button on t2). For interactive replies, prefer a path that
 * includes the node that actually sent the message with the keyboard/flow.
 */
export function stitchTriggerPathThroughPreferred(params: {
  previous: Map<string, string | null>;
  adjacency: Map<string, string[]>;
  targetId: string;
  preferredId: string;
  canVisit: (nodeId: string) => boolean;
}): string[] {
  const base = reconstructPathFromPrevious({
    previous: params.previous,
    targetNodeId: params.targetId,
  });
  if (base.includes(params.preferredId)) {
    return base;
  }

  const pathToPreferred = reconstructPathFromPrevious({
    previous: params.previous,
    targetNodeId: params.preferredId,
  });
  if (pathToPreferred.length === 0) {
    return base;
  }

  const suffix = reconstructForwardPath({
    adjacency: params.adjacency,
    startId: params.preferredId,
    targetId: params.targetId,
    canVisit: params.canVisit,
  });
  if (!suffix || suffix.length === 0) {
    return base;
  }

  return [...pathToPreferred.slice(0, -1), ...suffix];
}
