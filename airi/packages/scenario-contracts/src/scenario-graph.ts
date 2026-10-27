import type { ScenarioNodeData } from "./scenario-node-data";
import type { ScenarioNodeKind } from "./scenario-triggers";
import { isRecord } from "./value-guards";

/** Structurally readable persistence input, before legacy or draft normalization. */
export type ScenarioRawGraphNode = Record<string, unknown> & {
  id: string;
  data: Record<string, unknown> & { kind: ScenarioNodeKind };
  position?: { x: number; y: number };
};

export type ScenarioRawGraphEdge = Record<string, unknown> & {
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

export type ScenarioGraphEnvelope = {
  nodes: ScenarioRawGraphNode[];
  edges: ScenarioRawGraphEdge[];
};

function isCanonicalId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value === value.trim()
  );
}

export function isScenarioNodeKind(value: unknown): value is ScenarioNodeKind {
  return (
    value === "bulk" ||
    value === "trigger" ||
    value === "context" ||
    value === "logic" ||
    value === "action" ||
    value === "scenario_link"
  );
}

function isRawNode(value: unknown): value is ScenarioRawGraphNode {
  if (
    !isRecord(value) ||
    !isCanonicalId(value.id) ||
    !isRecord(value.data) ||
    !isScenarioNodeKind(value.data.kind)
  )
    return false;
  return (
    value.position === undefined ||
    (isRecord(value.position) &&
      typeof value.position.x === "number" &&
      Number.isFinite(value.position.x) &&
      typeof value.position.y === "number" &&
      Number.isFinite(value.position.y))
  );
}

function isOptionalHandle(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function isRawEdge(value: unknown): value is ScenarioRawGraphEdge {
  return (
    isRecord(value) &&
    isCanonicalId(value.source) &&
    isCanonicalId(value.target) &&
    (value.id === undefined || isCanonicalId(value.id)) &&
    isOptionalHandle(value.sourceHandle) &&
    isOptionalHandle(value.targetHandle)
  );
}

/** Reads the envelope without dropping fields or claiming action payloads are runnable. */
export function readScenarioGraphEnvelope(
  value: unknown,
): ScenarioGraphEnvelope | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges)
  )
    return null;
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const node of value.nodes) {
    if (!isRawNode(node)) return null;
    if (nodeIds.has(node.id)) return null;
    nodeIds.add(node.id);
  }
  for (const edge of value.edges) {
    if (!isRawEdge(edge)) return null;
    if (edge.id !== undefined) {
      if (edgeIds.has(edge.id)) return null;
      edgeIds.add(edge.id);
    }
  }
  return { nodes: value.nodes, edges: value.edges };
}

export type ScenarioGraphNode<
  TData extends ScenarioNodeData = ScenarioNodeData,
> = {
  id: string;
  data: TData;
};

export type ScenarioCanvasNode<
  TData extends ScenarioNodeData = ScenarioNodeData,
> = ScenarioGraphNode<TData> & {
  position: { x: number; y: number };
  type?: string;
  width?: number;
  height?: number;
  measured?: {
    width?: number;
    height?: number;
  };
};

export type ScenarioGraphEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};
