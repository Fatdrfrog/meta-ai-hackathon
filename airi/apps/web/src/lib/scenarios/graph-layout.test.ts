import { getScenarioLayoutReturnEdges } from "./graph-layout";
import type { ScenarioCanvasNode, ScenarioGraphEdge } from "@icecore/scenario-contracts";

describe("getScenarioLayoutReturnEdges", () => {
  it("ignores dangling edges whose source or target is missing", () => {
    const nodes = [
      {
        id: "root",
        data: { kind: "trigger" },
        position: { x: 0, y: 0 },
      },
      {
        id: "a",
        data: { kind: "action", actionType: "reply" },
        position: { x: 120, y: 0 },
      },
    ] as ScenarioCanvasNode[];
    const edges = [
      { id: "root-a", source: "root", target: "a" },
      { id: "ghost", source: "missing", target: "a" },
      { id: "loop", source: "a", target: "root" },
    ] as ScenarioGraphEdge[];

    expect(
      [...getScenarioLayoutReturnEdges(nodes, edges)].map(edge => edge.id)
    ).toEqual(["loop"]);
  });
});
