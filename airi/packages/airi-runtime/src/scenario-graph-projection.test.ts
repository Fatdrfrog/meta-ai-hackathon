import assert from "node:assert/strict";
import test from "node:test";
import { getCompiledScenarioGraph } from "./scenario-graph";

test("trigger projections never reuse or poison the full graph cache", () => {
  const scenario = {
    _id: "projection-cache-1",
    updatedAt: "2026-10-10T00:00:00Z",
    nodes: [
      {
        id: "trigger",
        data: {
          kind: "trigger",
          triggerConfig: { enabled: true, messageMatchMode: "any" },
        },
      },
      {
        id: "action",
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "fixed",
          actionReplyText: "Hello",
        },
      },
    ],
    edges: [{ source: "trigger", target: "action" }],
  };
  const full = getCompiledScenarioGraph(scenario);
  const projection = {
    ...scenario,
    nodes: scenario.nodes.slice(0, 1),
    edges: [],
    graphProjection: "triggers" as const,
  };
  assert.equal(
    getCompiledScenarioGraph(projection).nodesById.has("action"),
    false,
  );
  assert.equal(getCompiledScenarioGraph(scenario), full);
  const otherId = { ...projection, _id: "projection-cache-2" };
  getCompiledScenarioGraph(otherId);
  assert.equal(
    getCompiledScenarioGraph({ ...scenario, _id: otherId._id }).nodesById.has(
      "action",
    ),
    true,
  );
});
