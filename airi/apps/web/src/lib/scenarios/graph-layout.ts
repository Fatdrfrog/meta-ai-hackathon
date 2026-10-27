import type {
  ScenarioCanvasNode,
  ScenarioGraphEdge,
  ScenarioNodeData,
} from "@icecore/scenario-contracts";

export type ScenarioLayoutNodeSize = {
  width: number;
  height: number;
};

type ScenarioLayoutOptions<
  TNode extends ScenarioCanvasNode = ScenarioCanvasNode,
> = {
  origin?: { x: number; y: number };
  horizontalGap?: number;
  verticalGap?: number;
  getNodeSize?: (node: TNode) => ScenarioLayoutNodeSize | null;
};

type SubtreeLayout = {
  topById: Map<string, number>;
  height: number;
};

const DEFAULT_HORIZONTAL_GAP = 160;
const DEFAULT_VERTICAL_GAP = 96;
const DEFAULT_ORIGIN = { x: 80, y: 120 };

const FALLBACK_NODE_SIZE_BY_KIND: Record<
  ScenarioNodeData["kind"],
  ScenarioLayoutNodeSize
> = {
  action: { width: 384, height: 300 },
  bulk: { width: 440, height: 360 },
  context: { width: 360, height: 220 },
  logic: { width: 360, height: 220 },
  scenario_link: { width: 300, height: 180 },
  trigger: { width: 360, height: 220 },
};

function readPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function getMeasuredNodeSize(
  node: ScenarioCanvasNode
): Partial<ScenarioLayoutNodeSize> {
  return {
    width:
      readPositiveNumber(node.measured?.width) ??
      readPositiveNumber(node.width) ??
      undefined,
    height:
      readPositiveNumber(node.measured?.height) ??
      readPositiveNumber(node.height) ??
      undefined,
  };
}

export function getScenarioLayoutNodeSize(
  node: ScenarioCanvasNode
): ScenarioLayoutNodeSize {
  const nodeData = node.data as ScenarioNodeData;
  const fallback =
    FALLBACK_NODE_SIZE_BY_KIND[nodeData.kind] ??
    FALLBACK_NODE_SIZE_BY_KIND.logic;
  const measured = getMeasuredNodeSize(node);

  return {
    width: measured.width ?? fallback.width,
    height: measured.height ?? fallback.height,
  };
}

function compareNodeByCurrentCanvasOrder<
  TNode extends ScenarioCanvasNode,
>(params: {
  leftId: string;
  rightId: string;
  nodeById: Map<string, TNode>;
  nodeIndexById: Map<string, number>;
}) {
  const left = params.nodeById.get(params.leftId);
  const right = params.nodeById.get(params.rightId);
  const leftY = left?.position?.y ?? 0;
  const rightY = right?.position?.y ?? 0;
  if (Math.abs(leftY - rightY) > 0.5) return leftY - rightY;

  const leftX = left?.position?.x ?? 0;
  const rightX = right?.position?.x ?? 0;
  if (Math.abs(leftX - rightX) > 0.5) return leftX - rightX;

  const indexDiff =
    (params.nodeIndexById.get(params.leftId) ?? 0) -
    (params.nodeIndexById.get(params.rightId) ?? 0);
  if (indexDiff !== 0) return indexDiff;

  return params.leftId.localeCompare(params.rightId);
}

/** Share cycle detection with return-edge rendering; canvas positions do not identify loops. */
export function getScenarioLayoutReturnEdges<
  TNode extends ScenarioCanvasNode,
  TEdge extends ScenarioGraphEdge,
>(nodes: TNode[], edges: TEdge[]): Set<TEdge> {
  const nodeIds = new Set(nodes.map(node => node.id));
  const outgoing = new Map<string, TEdge[]>();
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge);
    outgoing.set(edge.source, list);
  }
  const state = new Map<string, "visiting" | "visited">();
  const returns = new Set<TEdge>();
  const roots = nodes.filter(
    node => node.data.kind === "trigger" || node.data.kind === "bulk"
  );
  for (const root of [...roots, ...nodes]) {
    if (state.has(root.id)) continue;
    const stack = [{ id: root.id, index: 0 }];
    state.set(root.id, "visiting");
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const edge = outgoing.get(frame.id)?.[frame.index++];
      if (!edge) {
        state.set(frame.id, "visited");
        stack.pop();
      } else if (state.get(edge.target) === "visiting") {
        returns.add(edge);
      } else if (!state.has(edge.target)) {
        state.set(edge.target, "visiting");
        stack.push({ id: edge.target, index: 0 });
      }
    }
  }
  return returns;
}

function isScenarioLayoutRoot(node: ScenarioCanvasNode): boolean {
  const kind = (node.data as ScenarioNodeData).kind;
  return kind === "trigger" || kind === "bulk";
}

/**
 * Normalize layout into one left-to-right row per trigger/bulk root.
 *
 * Rows keep the roots' current top-to-bottom canvas order. A node reachable
 * from several roots is placed once, in the first row that reaches it.
 * Chains no root reaches follow as rows of their own.
 *
 * X positions use graph depth plus the widest node in each earlier layer, so
 * wide bulk roots cannot collide with first action nodes. Y positions are
 * computed as top-left rectangles: child subtrees are stacked with a readable
 * gap and parents are centered against their child block.
 */
export function computeNormalizedScenarioNodePositions<
  TNode extends ScenarioCanvasNode,
  TEdge extends ScenarioGraphEdge,
>(
  nodes: TNode[],
  edges: TEdge[],
  options: ScenarioLayoutOptions<TNode> = {}
): Map<string, { x: number; y: number }> {
  if (!nodes.some(isScenarioLayoutRoot)) {
    return new Map();
  }

  const origin = options.origin ?? DEFAULT_ORIGIN;
  const horizontalGap = options.horizontalGap ?? DEFAULT_HORIZONTAL_GAP;
  const verticalGap = options.verticalGap ?? DEFAULT_VERTICAL_GAP;
  const rowGap = verticalGap * 2;
  const nodeById = new Map(nodes.map(node => [node.id, node] as const));
  const nodeIndexById = new Map(
    nodes.map((node, index) => [node.id, index] as const)
  );
  const sizeById = new Map(
    nodes.map(node => [
      node.id,
      options.getNodeSize?.(node) ?? getScenarioLayoutNodeSize(node),
    ])
  );
  const adjacency = new Map<string, string[]>();
  const returnEdges = getScenarioLayoutReturnEdges(nodes, edges);

  for (const edge of edges) {
    if (returnEdges.has(edge)) continue;
    if (!edge.source || !edge.target) continue;
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    const next = adjacency.get(edge.source) ?? [];
    if (!next.includes(edge.target)) {
      next.push(edge.target);
    }
    adjacency.set(edge.source, next);
  }

  for (const list of adjacency.values()) {
    list.sort((leftId, rightId) =>
      compareNodeByCurrentCanvasOrder({
        leftId,
        rightId,
        nodeById,
        nodeIndexById,
      })
    );
  }

  const byCanvasOrder = (leftId: string, rightId: string) =>
    compareNodeByCurrentCanvasOrder({
      leftId,
      rightId,
      nodeById,
      nodeIndexById,
    });
  const depth = new Map<string, number>();
  const treeParent = new Map<string, string>();
  const rowRootIds: string[] = [];

  // Claim every unplaced node reachable from rootId as one row. Earlier rows
  // keep shared nodes, and anything beyond a claimed node is already claimed.
  function claimRow(rootId: string) {
    rowRootIds.push(rootId);
    depth.set(rootId, 0);
    const members = [rootId];
    for (let index = 0; index < members.length; index += 1) {
      const id = members[index];
      for (const nextId of adjacency.get(id) ?? []) {
        if (depth.has(nextId)) continue;
        depth.set(nextId, depth.get(id)! + 1);
        treeParent.set(nextId, id);
        members.push(nextId);
      }
    }

    // A merge belongs after its longest forward path, even when another branch
    // reaches it sooner. Excluding the same returns drawn above the canvas keeps
    // this pass acyclic without changing any persisted edge or branch binding.
    const memberIds = new Set(members);
    const remainingParents = new Map(members.map(id => [id, 0]));
    for (const id of members) {
      for (const child of adjacency.get(id) ?? []) {
        if (memberIds.has(child))
          remainingParents.set(child, remainingParents.get(child)! + 1);
      }
    }
    const forwardQueue = members.filter(id => remainingParents.get(id) === 0);
    for (let index = 0; index < forwardQueue.length; index += 1) {
      const id = forwardQueue[index];
      for (const child of adjacency.get(id) ?? []) {
        if (!memberIds.has(child)) continue;
        depth.set(child, Math.max(depth.get(child)!, depth.get(id)! + 1));
        const remaining = remainingParents.get(child)! - 1;
        remainingParents.set(child, remaining);
        if (remaining === 0) forwardQueue.push(child);
      }
    }
  }

  for (const node of nodes
    .filter(isScenarioLayoutRoot)
    .sort((left, right) => byCanvasOrder(left.id, right.id))) {
    if (!depth.has(node.id)) claimRow(node.id);
  }

  // Chains no root reaches start at their entry nodes. Return edges are
  // already excluded, so every unplaced node is reachable from one of them.
  const hasUnplacedParent = new Set<string>();
  for (const [id, children] of adjacency) {
    if (depth.has(id)) continue;
    for (const child of children) hasUnplacedParent.add(child);
  }
  for (const id of nodes
    .map(node => node.id)
    .filter(id => !depth.has(id) && !hasUnplacedParent.has(id))
    .sort(byCanvasOrder)) {
    if (!depth.has(id)) claimRow(id);
  }

  const treeChildren = new Map<string, string[]>();
  for (const [child, parent] of treeParent) {
    const list = treeChildren.get(parent) ?? [];
    list.push(child);
    treeChildren.set(parent, list);
  }
  for (const list of treeChildren.values()) {
    list.sort(byCanvasOrder);
  }

  function layoutSubtree(nodeId: string): SubtreeLayout {
    const nodeSize = sizeById.get(nodeId) ?? FALLBACK_NODE_SIZE_BY_KIND.logic;
    const children = treeChildren.get(nodeId) ?? [];
    if (children.length === 0) {
      return {
        topById: new Map([[nodeId, 0]]),
        height: nodeSize.height,
      };
    }

    const childLayouts = children.map(childId => ({
      childId,
      layout: layoutSubtree(childId),
    }));
    const childrenBlockHeight =
      childLayouts.reduce((sum, item) => sum + item.layout.height, 0) +
      Math.max(0, childLayouts.length - 1) * verticalGap;
    const height = Math.max(nodeSize.height, childrenBlockHeight);
    const nodeTop = (height - nodeSize.height) / 2;
    const childBlockTop = (height - childrenBlockHeight) / 2;
    const topById = new Map<string, number>([[nodeId, nodeTop]]);
    let cursor = childBlockTop;

    for (const { layout } of childLayouts) {
      for (const [id, top] of layout.topById) {
        topById.set(id, cursor + top);
      }
      cursor += layout.height + verticalGap;
    }

    return {
      topById,
      height,
    };
  }

  const layerWidths: number[] = [];
  for (const [id, layer] of depth) {
    const size = sizeById.get(id) ?? FALLBACK_NODE_SIZE_BY_KIND.logic;
    layerWidths[layer] = Math.max(layerWidths[layer] ?? 0, size.width);
  }

  const maxLayer = layerWidths.length > 0 ? layerWidths.length - 1 : 0;
  const layerX: number[] = [origin.x];
  for (let layer = 1; layer <= maxLayer; layer += 1) {
    layerX[layer] =
      layerX[layer - 1] + (layerWidths[layer - 1] ?? 0) + horizontalGap;
  }

  const positions = new Map<string, { x: number; y: number }>();
  let rowTop = origin.y;
  for (const rootId of rowRootIds) {
    const row = layoutSubtree(rootId);
    for (const [id, top] of row.topById) {
      positions.set(id, {
        x: layerX[depth.get(id) ?? 0] ?? origin.x,
        y: rowTop + top,
      });
    }
    rowTop += row.height + rowGap;
  }

  return positions;
}

export function applyNormalizedScenarioPositions<
  TNode extends ScenarioCanvasNode,
>(nodes: TNode[], positions: Map<string, { x: number; y: number }>): TNode[] {
  return nodes.map(node => {
    const next = positions.get(node.id);
    if (!next) return node;
    return { ...node, position: { ...next } };
  });
}

export function normalizeScenarioGraphLayout<
  TNode extends ScenarioCanvasNode,
  TEdge extends ScenarioGraphEdge,
>(params: {
  nodes: TNode[];
  edges: TEdge[];
  options?: ScenarioLayoutOptions<TNode>;
}): { nodes: TNode[]; edges: TEdge[] } {
  const positions = computeNormalizedScenarioNodePositions(
    params.nodes,
    params.edges,
    params.options
  );

  return {
    nodes:
      positions.size > 0
        ? applyNormalizedScenarioPositions(params.nodes, positions)
        : params.nodes,
    edges: params.edges,
  };
}
