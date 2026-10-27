import {
  projectScenarioReturnEdges,
  getScenarioReturnEdgePath,
} from "./return-edges";
import {
  createGraphTestNode as node,
  createGraphTestEdge as edge,
} from "./test-utils";

describe("return connection presentation", () => {
  const nodes = [
    node("start", { kind: "trigger" }),
    node("menu", { kind: "action" }),
    node("details", { kind: "action" }),
    node("help", { kind: "action" }),
  ];
  it("routes cyclic connections separately without changing saved edges", () => {
    const edges = [
      edge("start", "menu"),
      edge("menu", "details"),
      edge("details", "menu"),
      edge("menu", "help"),
      edge("help", "menu"),
    ];
    const projected = projectScenarioReturnEdges(nodes, edges);
    expect(
      projected.filter(e => e.type === "scenarioReturn").map(e => e.id)
    ).toEqual(["details-menu", "help-menu"]);
    expect(projected[2].data?.scenarioReturn).toMatchObject({ lane: 0 });
    expect(projected[4].data?.scenarioReturn).toMatchObject({ lane: 1 });
    expect(projected[2].data?.scenarioReturn).toMatchObject({
      showLabel: false,
      destinationReturnCount: 2,
    });
    expect(projected[4].data?.scenarioReturn).toMatchObject({
      showLabel: true,
      destinationReturnCount: 2,
    });
    expect(projected[2].data?.scenarioReturn).not.toEqual(
      projected[4].data?.scenarioReturn
    );
    expect(edges.every(e => e.type === undefined && e.data === undefined)).toBe(
      true
    );
  });
  it("distinguishes a loop from a node that was only moved to the left", () => {
    const moved = nodes.map(n => ({
      ...n,
      position: { x: n.id === "menu" ? 800 : 0, y: 10 },
    }));
    expect(
      projectScenarioReturnEdges(moved, [
        edge("start", "menu"),
        edge("menu", "details"),
      ]).every(e => e.type !== "scenarioReturn")
    ).toBe(true);
    expect(
      projectScenarioReturnEdges(nodes, [
        edge("start", "menu"),
        edge("menu", "menu"),
      ])[1].type
    ).toBe("scenarioReturn");
  });
  it("handles deep loops iteratively", () => {
    const many = Array.from({ length: 5000 }, (_, i) =>
      node(`n${i}`, { kind: i ? "action" : "trigger" })
    );
    const edges = many.slice(1).map((n, i) => edge(many[i].id, n.id));
    edges.push(edge("n4999", "n1"));
    expect(
      projectScenarioReturnEdges(many, edges).filter(
        e => e.type === "scenarioReturn"
      )
    ).toHaveLength(1);
  });
  it("places the return rail and label above cards with clearance at both ends", () => {
    const result = getScenarioReturnEdgePath({
      sourceX: 910,
      sourceY: 460,
      targetX: 400,
      targetY: 320,
      sourceRight: 960,
      targetLeft: 400,
      routeY: 40,
    });
    expect(result.labelY).toBe(40);
    expect(result.path).toContain("M 910 460");
    expect(result.path).toContain("984");
    expect(result.path).toContain("376");
    expect(result.path.endsWith("L 400 320")).toBe(true);
  });
});
