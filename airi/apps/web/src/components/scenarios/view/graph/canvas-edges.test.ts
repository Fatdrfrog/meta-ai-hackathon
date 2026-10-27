import type { ScenarioFlowEdge } from "../../types";
import {
  createScenarioCanvasEdgeCache,
  projectScenarioCanvasEdges,
} from "./canvas-edges";

const NONE = new Set<string>();

const first: ScenarioFlowEdge = { id: "a-b", source: "a", target: "b" };
const second: ScenarioFlowEdge = {
  id: "b-c",
  source: "b",
  target: "c",
  style: { strokeDasharray: "4 2" },
};
const returnEdge = (routeY: number): ScenarioFlowEdge => ({
  id: "c-b",
  source: "c",
  target: "b",
  type: "scenarioReturn",
  data: {
    scenarioReturn: {
      lane: 0,
      routeY,
      destinationReturnCount: 1,
      showLabel: true,
    },
  },
});

describe("projectScenarioCanvasEdges", () => {
  it("keeps unchanged edges, including a return edge rebuilt with the same route", () => {
    const cache = createScenarioCanvasEdgeCache();
    const before = projectScenarioCanvasEdges(
      [first, second, returnEdge(-56)],
      NONE,
      NONE,
      cache
    );
    const after = projectScenarioCanvasEdges(
      [first, second, returnEdge(-56)],
      new Set(),
      new Set(),
      cache
    );

    after.forEach((edge, index) => expect(edge).toBe(before[index]));
    expect(before[0]).toEqual({ ...first, selected: false });
    expect(first).not.toHaveProperty("selected");
  });

  it("rebuilds only the edges whose selection, highlight or route changed", () => {
    const cache = createScenarioCanvasEdgeCache();
    const before = projectScenarioCanvasEdges(
      [first, second, returnEdge(-56)],
      NONE,
      NONE,
      cache
    );
    const after = projectScenarioCanvasEdges(
      [first, second, returnEdge(-96)],
      new Set(["a-b"]),
      new Set(["b-c"]),
      cache
    );

    expect(after[0]).not.toBe(before[0]);
    expect(after[0].selected).toBe(true);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1]).toMatchObject({
      animated: true,
      style: {
        strokeDasharray: "4 2",
        stroke: "var(--primary)",
        strokeWidth: 3,
      },
    });
    expect(second).not.toHaveProperty("animated");
    expect(after[2]).not.toBe(before[2]);
    expect(after[2].data).toMatchObject({ scenarioReturn: { routeY: -96 } });
  });

  it("forgets removed edges", () => {
    const cache = createScenarioCanvasEdgeCache();
    projectScenarioCanvasEdges([first, second], NONE, NONE, cache);
    projectScenarioCanvasEdges([second], NONE, NONE, cache);

    expect([...cache.keys()]).toEqual(["b-c"]);
  });
});
