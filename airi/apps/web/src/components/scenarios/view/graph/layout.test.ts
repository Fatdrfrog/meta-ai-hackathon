import type {
  ScenarioFlowEdge,
  ScenarioFlowNode,
  ScenarioNodeData,
} from "../../types";
import {
  applyNormalizedScenarioPositions,
  computeNormalizedScenarioNodePositions,
  normalizeScenarioGraphLayout,
} from "@/lib/scenarios/graph-layout";
import { createGraphTestNode as createNode } from "./test-utils";

const READABLE_HORIZONTAL_GAP = 140;
const READABLE_VERTICAL_GAP = 80;

const FALLBACK_NODE_SIZE_BY_KIND: Record<
  ScenarioNodeData["kind"],
  { width: number; height: number }
> = {
  action: { width: 384, height: 300 },
  bulk: { width: 440, height: 360 },
  context: { width: 360, height: 220 },
  logic: { width: 360, height: 220 },
  scenario_link: { width: 300, height: 180 },
  trigger: { width: 360, height: 220 },
};

function getNodeSize(node: ScenarioFlowNode) {
  return FALLBACK_NODE_SIZE_BY_KIND[(node.data as ScenarioNodeData).kind];
}

function centerY(
  nodes: ScenarioFlowNode[],
  positions: Map<string, { x: number; y: number }>,
  id: string
) {
  const node = nodes.find(candidate => candidate.id === id)!;
  return positions.get(id)!.y + getNodeSize(node).height / 2;
}

describe("computeNormalizedScenarioNodePositions", () => {
  it("keeps shared destinations after every forward parent while preserving a return loop", () => {
    const nodes = [
      createNode("root", { kind: "trigger" }),
      ...["menu", "long", "short", "shared", "end"].map(id =>
        createNode(id, { kind: "action", actionType: "reply" })
      ),
    ];
    const edges = [
      { id: "entry", source: "root", target: "menu" },
      { id: "long", source: "menu", target: "long" },
      { id: "short", source: "menu", target: "short" },
      { id: "merge", source: "long", target: "shared" },
      { id: "end-short", source: "short", target: "end" },
      { id: "end-shared", source: "shared", target: "end" },
      { id: "return", source: "shared", target: "menu" },
    ];
    const positions = computeNormalizedScenarioNodePositions(nodes, edges);
    for (const edge of edges.filter(edge => edge.id !== "return")) {
      expect(positions.get(edge.target)!.x).toBeGreaterThan(
        positions.get(edge.source)!.x +
          getNodeSize(nodes.find(node => node.id === edge.source)!).width
      );
    }
    expect(positions.get("menu")!.x).toBeLessThan(positions.get("shared")!.x);
    expect(
      computeNormalizedScenarioNodePositions(
        applyNormalizedScenarioPositions(nodes, positions),
        edges
      )
    ).toEqual(positions);
  });

  it("separates measured compact and expanded siblings without using fallback heights", () => {
    const root = createNode("root", { kind: "trigger" });
    const compact = {
      ...createNode("compact", { kind: "action", actionType: "reply" }),
      measured: { width: 300, height: 284 },
    };
    const expanded = {
      ...createNode("expanded", { kind: "action", actionType: "reply" }),
      measured: { width: 460, height: 980 },
    };
    const last = {
      ...createNode("last", { kind: "action", actionType: "reply" }),
      measured: { width: 300, height: 150 },
    };
    const nodes = [root, compact, expanded, last];
    const edges = nodes
      .slice(1)
      .map(node => ({ id: node.id, source: "root", target: node.id }));
    const positions = computeNormalizedScenarioNodePositions(nodes, edges);
    expect(
      positions.get("expanded")!.y -
        positions.get("compact")!.y -
        compact.measured.height
    ).toBeGreaterThanOrEqual(80);
    expect(
      positions.get("last")!.y -
        positions.get("expanded")!.y -
        expanded.measured.height
    ).toBeGreaterThanOrEqual(80);
  });

  it("places trigger in column 0 and children in column 1", () => {
    const t = createNode("t", {
      kind: "trigger",
    });
    const a = createNode("a", { kind: "action", actionType: "reply" });
    const nodes = [t, a];
    const edges: ScenarioFlowEdge[] = [
      {
        id: "e1",
        source: "t",
        target: "a",
        sourceHandle: "right-source",
        targetHandle: "left-target",
      },
    ];
    const map = computeNormalizedScenarioNodePositions(nodes, edges);
    expect(map.get("t")?.x).toBe(80);
    expect(map.get("t")?.y).toBeGreaterThanOrEqual(120);
    const triggerPosition = map.get("t");
    const actionPosition = map.get("a");
    expect(actionPosition?.y).toBe(120);
    expect(
      (actionPosition?.x ?? 0) -
        ((triggerPosition?.x ?? 0) + getNodeSize(t).width)
    ).toBeGreaterThanOrEqual(READABLE_HORIZONTAL_GAP);
  });

  it("places a bulk root in column 0 when a generated bulk scenario has no trigger", () => {
    const root = createNode("bulk", {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "Generated launch",
        recipientSourceSummary: "Manual select",
        generationStatus: "complete",
      },
    } as unknown as ScenarioNodeData);
    const action = createNode("action", {
      kind: "action",
      actionType: "reply",
    });
    const nodes = [root, action];
    const edges: ScenarioFlowEdge[] = [
      {
        id: "e1",
        source: "bulk",
        target: "action",
        sourceHandle: "right-source",
        targetHandle: "left-target",
      },
    ];

    const map = computeNormalizedScenarioNodePositions(nodes, edges);

    expect(map.get("bulk")).toEqual({ x: 80, y: 120 });
    expect(
      (map.get("action")?.x ?? 0) -
        ((map.get("bulk")?.x ?? 0) + getNodeSize(root).width)
    ).toBeGreaterThanOrEqual(READABLE_HORIZONTAL_GAP);
  });

  it("stacks siblings vertically under the same parent instead of one global depth pile", () => {
    const t = createNode("t", {
      kind: "trigger",
    });
    const b = createNode("b", {
      kind: "logic",
      logicType: "audience_filter",
    });
    const c = createNode("c", {
      kind: "logic",
      logicType: "audience_filter",
    });
    const d1 = createNode("d1", { kind: "action", actionType: "reply" });
    const d2 = createNode("d2", { kind: "action", actionType: "reply" });
    const nodes = [t, b, c, d1, d2];
    const edges: ScenarioFlowEdge[] = [
      {
        id: "e1",
        source: "t",
        target: "b",
        sourceHandle: "right-source",
        targetHandle: "left-target",
      },
      {
        id: "e2",
        source: "t",
        target: "c",
        sourceHandle: "right-source",
        targetHandle: "left-target",
      },
      {
        id: "e3",
        source: "b",
        target: "d1",
        sourceHandle: "right-source",
        targetHandle: "left-target",
      },
      {
        id: "e4",
        source: "c",
        target: "d2",
        sourceHandle: "right-source",
        targetHandle: "left-target",
      },
    ];
    const map = computeNormalizedScenarioNodePositions(nodes, edges);
    expect(map.get("d1")?.x).toBe(map.get("d2")?.x);
    expect(map.get("d1")?.y).not.toBe(map.get("d2")?.y);
  });

  it("keeps tall sibling action nodes separated by a readable gap", () => {
    const t = createNode("t", {
      kind: "trigger",
    });
    const a = createNode("a", { kind: "action", actionType: "reply" });
    const b = createNode("b", { kind: "action", actionType: "reply" });
    const c = createNode("c", { kind: "action", actionType: "reply" });
    const nodes = [t, a, b, c];
    const edges: ScenarioFlowEdge[] = [
      {
        id: "e1",
        source: "t",
        target: "a",
        sourceHandle: "right-source",
        targetHandle: "left-target",
      },
      {
        id: "e2",
        source: "t",
        target: "b",
        sourceHandle: "right-source",
        targetHandle: "left-target",
      },
      {
        id: "e3",
        source: "t",
        target: "c",
        sourceHandle: "right-source",
        targetHandle: "left-target",
      },
    ];

    const map = computeNormalizedScenarioNodePositions(nodes, edges);
    const actionNodes = [a, b, c].sort(
      (left, right) => (map.get(left.id)?.y ?? 0) - (map.get(right.id)?.y ?? 0)
    );

    for (let index = 1; index < actionNodes.length; index += 1) {
      const previous = actionNodes[index - 1];
      const current = actionNodes[index];
      expect(
        (map.get(current.id)?.y ?? 0) -
          ((map.get(previous.id)?.y ?? 0) + getNodeSize(previous).height)
      ).toBeGreaterThanOrEqual(READABLE_VERTICAL_GAP);
    }
  });

  it("returns empty map when there is no trigger or bulk root", () => {
    const nodes = [createNode("a", { kind: "action", actionType: "reply" })];
    const map = computeNormalizedScenarioNodePositions(nodes, []);
    expect(map.size).toBe(0);
  });

  it("lays out every trigger as its own left-to-right row in canvas order", () => {
    // Regression: only the first trigger in the array was laid out, and every
    // other trigger and its chain was stacked into one column at x = 80.
    const rows = ["medal", "elit", "shezhire", "orteke"];
    const nodes = rows.flatMap((row, index) => [
      {
        ...createNode(`${row}-trigger`, { kind: "trigger" }),
        position: { x: 900, y: (rows.length - index) * 50 },
      },
      ...[1, 2, 3].map(step =>
        createNode(`${row}-${step}`, { kind: "action", actionType: "reply" })
      ),
    ]);
    const edges = rows.flatMap(row => [
      { id: `${row}-e1`, source: `${row}-trigger`, target: `${row}-1` },
      { id: `${row}-e2`, source: `${row}-1`, target: `${row}-2` },
      { id: `${row}-e3`, source: `${row}-2`, target: `${row}-3` },
    ]);

    const positions = computeNormalizedScenarioNodePositions(nodes, edges);
    const bounds = (row: string) => {
      const ids = [`${row}-trigger`, `${row}-1`, `${row}-2`, `${row}-3`];
      return {
        top: Math.min(...ids.map(id => positions.get(id)!.y)),
        bottom: Math.max(
          ...ids.map(
            id =>
              positions.get(id)!.y +
              getNodeSize(nodes.find(node => node.id === id)!).height
          )
        ),
      };
    };

    for (const row of rows) {
      expect(positions.get(`${row}-trigger`)!.x).toBe(80);
      for (const edge of edges.filter(edge => edge.id.startsWith(row))) {
        expect(positions.get(edge.target)!.x).toBeGreaterThan(
          positions.get(edge.source)!.x
        );
        expect(centerY(nodes, positions, edge.target)).toBe(
          centerY(nodes, positions, edge.source)
        );
      }
    }
    // The trigger nearest the top of the canvas keeps the first row.
    const rowOrder = [...rows].reverse();
    for (let index = 1; index < rowOrder.length; index += 1) {
      expect(bounds(rowOrder[index]).top).toBeGreaterThanOrEqual(
        bounds(rowOrder[index - 1]).bottom + READABLE_VERTICAL_GAP
      );
    }
    expect(
      computeNormalizedScenarioNodePositions(
        applyNormalizedScenarioPositions(nodes, positions),
        edges
      )
    ).toEqual(positions);
  });

  it("places a node shared by two triggers once, in the first row", () => {
    const nodes = [
      {
        ...createNode("first", { kind: "trigger" }),
        position: { x: 0, y: 0 },
      },
      {
        ...createNode("second", { kind: "trigger" }),
        position: { x: 0, y: 500 },
      },
      createNode("shared", { kind: "action", actionType: "reply" }),
      createNode("own", { kind: "action", actionType: "reply" }),
    ];
    const edges = [
      { id: "first-shared", source: "first", target: "shared" },
      { id: "second-own", source: "second", target: "own" },
      { id: "second-shared", source: "second", target: "shared" },
    ];

    const positions = computeNormalizedScenarioNodePositions(nodes, edges);

    expect(centerY(nodes, positions, "shared")).toBe(
      centerY(nodes, positions, "first")
    );
    expect(centerY(nodes, positions, "own")).toBe(
      centerY(nodes, positions, "second")
    );
    expect(positions.get("second")!.y).toBeGreaterThan(
      positions.get("shared")!.y
    );
  });

  it("lays out chains no trigger reaches left to right below the trigger rows", () => {
    const nodes = [
      createNode("trigger", { kind: "trigger" }),
      createNode("reached", { kind: "action", actionType: "reply" }),
      createNode("loose-1", { kind: "action", actionType: "reply" }),
      createNode("loose-2", { kind: "action", actionType: "reply" }),
      createNode("cycle-a", { kind: "action", actionType: "reply" }),
      createNode("cycle-b", { kind: "action", actionType: "reply" }),
    ];
    const edges = [
      { id: "entry", source: "trigger", target: "reached" },
      { id: "loose", source: "loose-1", target: "loose-2" },
      { id: "cycle-forward", source: "cycle-a", target: "cycle-b" },
      { id: "cycle-back", source: "cycle-b", target: "cycle-a" },
    ];

    const positions = computeNormalizedScenarioNodePositions(nodes, edges);

    expect(positions.size).toBe(nodes.length);
    expect(positions.get("loose-1")!.x).toBe(80);
    expect(positions.get("loose-2")!.x).toBe(positions.get("reached")!.x);
    expect(positions.get("loose-2")!.y).toBe(positions.get("loose-1")!.y);
    expect(positions.get("loose-1")!.y).toBeGreaterThan(
      positions.get("trigger")!.y
    );
    expect(positions.get("cycle-b")!.x).toBeGreaterThan(
      positions.get("cycle-a")!.x
    );
    expect(
      computeNormalizedScenarioNodePositions(
        applyNormalizedScenarioPositions(nodes, positions),
        edges
      )
    ).toEqual(positions);
  });
});

describe("applyNormalizedScenarioPositions", () => {
  it("updates node positions immutably", () => {
    const n = createNode("n", {
      kind: "logic",
      logicType: "audience_filter",
    });
    const positions = new Map([["n", { x: 10, y: 20 }]]);
    const next = applyNormalizedScenarioPositions([n], positions);
    expect(next[0]).not.toBe(n);
    expect(next[0].position).toEqual({ x: 10, y: 20 });
  });

  it("preserves rich generic node and edge fields through normalization", () => {
    type RichNode = ScenarioFlowNode & { auditId: string };
    type RichEdge = ScenarioFlowEdge & { ruleId: string };

    const trigger = {
      ...createNode("trigger", { kind: "trigger" }),
      auditId: "audit-trigger",
    } satisfies RichNode;
    const action = {
      ...createNode("action", { kind: "action", actionType: "reply" }),
      auditId: "audit-action",
    } satisfies RichNode;
    const edge = {
      id: "edge-rich",
      source: trigger.id,
      target: action.id,
      ruleId: "rule-rich",
    } satisfies RichEdge;
    const nodes: RichNode[] = [trigger, action];
    const edges: RichEdge[] = [edge];

    const result = normalizeScenarioGraphLayout({
      nodes,
      edges,
      options: {
        getNodeSize(node) {
          const auditId: string = node.auditId;
          expect(auditId).toContain("audit-");
          return getNodeSize(node);
        },
      },
    });
    const inferredNodes: RichNode[] = result.nodes;
    const inferredEdges: RichEdge[] = result.edges;

    expect(inferredNodes.map(node => node.auditId)).toEqual([
      "audit-trigger",
      "audit-action",
    ]);
    expect(inferredEdges).toBe(edges);
    expect(inferredEdges[0]).toBe(edge);
    expect(inferredEdges[0].ruleId).toBe("rule-rich");
  });
});
