import {
  getScenarioRouteKey,
  projectScenarioBranchVisibility,
} from "./branch-visibility";
import {
  createGraphTestNode as node,
  createGraphTestEdge as edge,
} from "./test-utils";

const nodes = [
  node("root", { kind: "trigger" }),
  ...["a", "b", "shared", "leaf", "orphan"].map(id =>
    node(id, { kind: "action", actionType: "reply" })
  ),
];
const edges = [
  edge("root", "a", { sourceHandle: "a" }),
  edge("root", "b", { sourceHandle: "b" }),
  edge("a", "shared"),
  edge("b", "shared"),
  edge("a", "leaf"),
  edge("shared", "root"),
];

describe("branch visibility", () => {
  it("hides only descendants exclusively reached through the collapsed route, retaining shared nodes, loops and orphans", () => {
    const result = projectScenarioBranchVisibility({
      nodes,
      edges,
      collapsedRoutes: new Set([getScenarioRouteKey("root", "a")]),
    });
    expect(result.nodes.map(node => node.id)).toEqual([
      "root",
      "b",
      "shared",
      "orphan",
    ]);
    expect(result.edges.map(edge => edge.id)).toContain("shared-root");
  });
  it("expands a path to a focused hidden node without changing persisted graph", () => {
    const nodesBefore = structuredClone(nodes);
    const edgesBefore = structuredClone(edges);
    const result = projectScenarioBranchVisibility({
      nodes,
      edges,
      collapsedRoutes: new Set([getScenarioRouteKey("root", "a")]),
      focusedNodeId: "leaf",
    });
    expect(result.nodes.map(node => node.id)).toContain("leaf");
    expect(nodes).toEqual(nodesBefore);
    expect(edges).toEqual(edgesBefore);
  });
  it("does not expand a collapsed exclusive path when the focused node is still reachable", () => {
    const extraEdges = [...edges, edge("b", "leaf")];
    const result = projectScenarioBranchVisibility({
      nodes,
      edges: extraEdges,
      collapsedRoutes: new Set([getScenarioRouteKey("root", "a")]),
      focusedNodeId: "leaf",
    });
    expect(result.nodes.map(node => node.id)).toContain("leaf");
    expect(result.edges.map(item => item.id)).not.toContain("root-a");
  });
  it("keeps a shared destination visible while hiding the collapsed edge", () => {
    const result = projectScenarioBranchVisibility({
      nodes,
      edges,
      collapsedRoutes: new Set([getScenarioRouteKey("a", undefined)]),
    });
    expect(result.nodes.map(node => node.id)).toContain("shared");
    expect(result.edges.map(edge => edge.id)).not.toContain("a-shared");
  });
  it("snapshots collapse, shared reachability, loops and orphans together", () => {
    expect(
      projectScenarioBranchVisibility({
        nodes,
        edges,
        collapsedRoutes: new Set([getScenarioRouteKey("root", "a")]),
      })
    ).toMatchSnapshot();
  });
});
