import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readScenarioGraphEnvelope } from "./scenario-graph.ts";

describe("readScenarioGraphEnvelope", () => {
  it("preserves incomplete drafts, legacy omissions, and unknown fields without mutation", () => {
    const graph = {
      nodes: [
        {
          id: "legacy",
          data: { kind: "trigger", triggerType: "exact_incoming_message" },
        },
        {
          id: "draft",
          data: { kind: "action", futureConfig: { text: "" } },
          position: { x: 1, y: -2 },
          extension: true,
        },
      ],
      edges: [
        { source: "legacy", target: "draft", sourceHandle: null, extra: [1] },
      ],
    };
    const original = structuredClone(graph);
    const result = readScenarioGraphEnvelope(graph);
    assert.deepEqual(result, graph);
    assert.deepEqual(graph, original);
    assert.equal(result?.nodes[0], graph.nodes[0]);
    assert.equal(result?.edges[0], graph.edges[0]);
    assert.deepEqual(readScenarioGraphEnvelope({ nodes: [], edges: [] }), {
      nodes: [],
      edges: [],
    });
  });

  for (const id of [" padded", "padded ", "\tpadded\n"]) {
    for (const field of ["node", "edge", "source", "target"] as const) {
      it(`rejects a noncanonical ${field} id ${JSON.stringify(id)} without rewriting it`, () => {
        const graph = {
          nodes: [
            { id: field === "node" ? id : "a", data: { kind: "action" } },
          ],
          edges: [
            {
              id: field === "edge" ? id : "e",
              source: field === "source" ? id : "a",
              target: field === "target" ? id : "a",
            },
          ],
        };
        const original = structuredClone(graph);
        assert.equal(readScenarioGraphEnvelope(graph), null);
        assert.deepEqual(graph, original);
      });
    }
  }

  const node = { id: "a", data: { kind: "action" } };
  for (const [name, value] of [
    ["non-record envelope", null],
    ["missing nodes", { edges: [] }],
    ["non-array edges", { nodes: [], edges: {} }],
    ["null node", { nodes: [null], edges: [] }],
    ["blank node id", { nodes: [{ ...node, id: " " }], edges: [] }],
    ["missing data", { nodes: [{ id: "a" }], edges: [] }],
    ["array data", { nodes: [{ ...node, data: [] }], edges: [] }],
    [
      "unknown kind",
      { nodes: [{ ...node, data: { kind: "future" } }], edges: [] },
    ],
    ["duplicate node ids", { nodes: [node, node], edges: [] }],
    [
      "node ids that collide after runtime trimming",
      { nodes: [node, { ...node, id: " a " }], edges: [] },
    ],
    ["null position", { nodes: [{ ...node, position: null }], edges: [] }],
    [
      "nonfinite position",
      { nodes: [{ ...node, position: { x: Infinity, y: 0 } }], edges: [] },
    ],
    [
      "incomplete position",
      { nodes: [{ ...node, position: { x: 0 } }], edges: [] },
    ],
    ["null edge", { nodes: [node], edges: [null] }],
    [
      "blank endpoint",
      { nodes: [node], edges: [{ source: "a", target: " " }] },
    ],
    [
      "invalid edge id",
      { nodes: [node], edges: [{ source: "a", target: "b", id: 1 }] },
    ],
    [
      "blank explicit edge id",
      { nodes: [node], edges: [{ source: "a", target: "b", id: "" }] },
    ],
    [
      "invalid handle",
      {
        nodes: [node],
        edges: [{ source: "a", target: "b", sourceHandle: {} }],
      },
    ],
    [
      "duplicate explicit edge ids",
      {
        nodes: [node],
        edges: [
          { id: "e", source: "a", target: "b" },
          { id: "e", source: "b", target: "a" },
        ],
      },
    ],
    [
      "edge ids that collide after identity normalization",
      {
        nodes: [node],
        edges: [
          { id: "e", source: "a", target: "b" },
          { id: " e ", source: "b", target: "a" },
        ],
      },
    ],
  ] as const) {
    it(`rejects ${name} instead of dropping graph data`, () => {
      assert.equal(readScenarioGraphEnvelope(value), null);
    });
  }
});
