import { isDeepStrictEqual } from "node:util";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  getScenarioActionOutcomeVirtualNodeId,
} from "@icecore/scenario-contracts";
import {
  compileScenarioGraph,
  getCompiledScenarioGraph,
  type ScenarioRuntimeEdge,
  type ScenarioRuntimeNode,
} from "./scenario-graph";

function actionWithNoReply(id: string): ScenarioRuntimeNode {
  return {
    id,
    data: {
      kind: "action",
      actionType: "reply",
      actionOutcomes: {
        version: 1,
        noReply: { enabled: true, timeoutMinutes: 30 },
      },
    },
  };
}

describe("compiled scenario action routing", () => {
  it("indexes virtual outcome conditions without mutating parsed inputs", () => {
    const nodes: ScenarioRuntimeNode[] = [
      actionWithNoReply("action-1"),
      {
        id: "follow-up",
        data: { kind: "action", actionType: "reply" },
      },
    ];
    const edges: ScenarioRuntimeEdge[] = [
      {
        source: "action-1",
        target: "follow-up",
        sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
      },
    ];
    const nodesSnapshot = structuredClone(nodes);
    const edgesSnapshot = structuredClone(edges);
    const virtualId = getScenarioActionOutcomeVirtualNodeId("action-1");

    const graph = compileScenarioGraph(nodes, edges);

    assert.deepEqual(graph.diagnostics, []);
    assert.equal(graph.nodesById.has(virtualId), true);
    assert.deepEqual(graph.adjacency.get("action-1"), [virtualId]);
    assert.deepEqual(graph.adjacency.get(virtualId), ["follow-up"]);
    assert.deepEqual(nodes, nodesSnapshot);
    assert.deepEqual(edges, edgesSnapshot);
  });

  it("keeps canonical parsed IDs and cache identity while lowering", () => {
    const scenario = {
      _id: "scenario-cache-action-routing",
      updatedAt: "2026-07-10T00:00:00.000Z",
      nodes: [
        {
          id: " action-1 ",
          data: actionWithNoReply("ignored").data,
        },
        {
          id: "follow-up",
          data: { kind: "action", actionType: "reply" },
        },
      ],
      edges: [
        {
          source: "action-1",
          target: "follow-up",
          sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
        },
      ],
    };

    const first = getCompiledScenarioGraph(scenario);
    const second = getCompiledScenarioGraph(scenario);

    assert.equal(first.nodesById.has("action-1"), true);
    assert.equal(
      first.nodesById.has(getScenarioActionOutcomeVirtualNodeId("action-1")),
      true,
    );
    assert.equal(second, first);
  });

  it("exposes compiler diagnostics", () => {
    const graph = compileScenarioGraph(
      [
        {
          id: "__system:persisted",
          data: { kind: "trigger" },
        },
      ],
      [],
    );

    assert.ok(
      graph.diagnostics.some((value) =>
        isDeepStrictEqual(value, {
          code: "reserved_persisted_node_id",
          severity: "error",
          nodeId: "__system:persisted",
        }),
      ),
    );
  });
});
