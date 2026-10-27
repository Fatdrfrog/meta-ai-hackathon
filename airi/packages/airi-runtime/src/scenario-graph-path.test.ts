import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findRawScenarioNode,
  getPrimaryRawScenarioTriggerNode,
  parseNodes,
  parseRawScenarioNode,
  reconstructForwardPath,
  reconstructPathFromPrevious,
  stitchTriggerPathThroughPreferred,
} from "./scenario-graph";

describe("parseNodes", () => {
  it("preserves bulk campaign nodes in compiled scenario graphs", () => {
    assert.deepEqual(
      parseNodes([
        {
          id: "bulk-1",
          data: {
            kind: "bulk",
            bulkRootConfig: {
              workflowKind: "bulk_campaign",
              sendMode: "immediate",
              channels: ["whatsapp"],
              campaignName: "VIP reactivation",
              recipientSourceSummary: "Upload recipients",
              generationStatus: "idle",
            },
          },
        },
      ]).map((node) => ({ id: node.id, kind: node.data.kind })),
      [{ id: "bulk-1", kind: "bulk" }],
    );
  });
});

describe("raw scenario node helpers", () => {
  it("parses one raw scenario node with the same validation as parseNodes", () => {
    assert.deepEqual(
      parseRawScenarioNode({
        id: " action-1 ",
        data: { kind: "action", actionType: "reply" },
      }),
      {
        id: "action-1",
        data: { kind: "action", actionType: "reply" },
      },
    );

    assert.equal(parseRawScenarioNode({ id: "missing-data" }), null);
    assert.equal(
      parseRawScenarioNode({ id: "bad-kind", data: { kind: "unknown" } }),
      null,
    );
  });

  it("finds raw nodes by id and kind without compiling the whole graph", () => {
    const scenario = {
      nodes: [
        { id: "trigger-1", data: { kind: "trigger" } },
        { id: "action-1", data: { kind: "action", actionType: "reply" } },
      ],
    };

    assert.deepEqual(
      findRawScenarioNode({
        scenario,
        nodeId: " action-1 ",
        kind: "action",
      }),
      {
        id: "action-1",
        data: { kind: "action", actionType: "reply" },
      },
    );
    assert.equal(
      findRawScenarioNode({
        scenario,
        nodeId: "trigger-1",
        kind: "action",
      }),
      null,
    );
  });

  it("returns the primary raw trigger node in persisted order", () => {
    assert.deepEqual(
      getPrimaryRawScenarioTriggerNode({
        nodes: [
          { id: "", data: { kind: "trigger" } },
          { id: "context-1", data: { kind: "context" } },
          {
            id: "trigger-1",
            data: { kind: "trigger", linkedConditionId: "condition-1" },
          },
          { id: "trigger-2", data: { kind: "trigger" } },
        ],
      }),
      {
        id: "trigger-1",
        data: { kind: "trigger", linkedConditionId: "condition-1" },
      },
    );
  });
});

describe("stitchTriggerPathThroughPreferred", () => {
  const adjacency = new Map<string, string[]>([
    ["trigger", ["t1"]],
    ["t1", ["t2", "t3"]],
    ["t2", ["t3"]],
  ]);

  it("returns BFS path when it already contains preferred", () => {
    const previous = new Map<string, string | null>([
      ["trigger", null],
      ["t1", "trigger"],
      ["t2", "t1"],
      ["t3", "t2"],
    ]);
    const path = stitchTriggerPathThroughPreferred({
      previous,
      adjacency,
      targetId: "t3",
      preferredId: "t2",
      canVisit: () => true,
    });
    assert.deepEqual(path, ["trigger", "t1", "t2", "t3"]);
  });

  it("stitches when BFS shortcut skips preferred (t3 parent t1 while t2 also visited)", () => {
    const previous = new Map<string, string | null>([
      ["trigger", null],
      ["t1", "trigger"],
      ["t2", "t1"],
      ["t3", "t1"],
    ]);
    const path = stitchTriggerPathThroughPreferred({
      previous,
      adjacency,
      targetId: "t3",
      preferredId: "t2",
      canVisit: () => true,
    });
    assert.deepEqual(path, ["trigger", "t1", "t2", "t3"]);
  });

  it("falls back when no forward path from preferred to target", () => {
    const previous = new Map<string, string | null>([
      ["trigger", null],
      ["t1", "trigger"],
      ["t3", "t1"],
    ]);
    const isolated = new Map<string, string[]>([
      ["trigger", ["t1"]],
      ["t1", ["t3"]],
    ]);
    const path = stitchTriggerPathThroughPreferred({
      previous,
      adjacency: isolated,
      targetId: "t3",
      preferredId: "t2",
      canVisit: () => true,
    });
    assert.deepEqual(path, ["trigger", "t1", "t3"]);
  });
});

describe("reconstructForwardPath", () => {
  it("finds shortest forward path with canVisit filter", () => {
    const adjacency = new Map<string, string[]>([
      ["a", ["b", "c"]],
      ["b", ["d"]],
      ["c", ["d"]],
    ]);
    const path = reconstructForwardPath({
      adjacency,
      startId: "a",
      targetId: "d",
      canVisit: (id) => id !== "c",
    });
    assert.deepEqual(path, ["a", "b", "d"]);
  });
});

describe("reconstructPathFromPrevious", () => {
  it("reconstructs chain from BFS parent map", () => {
    const previous = new Map<string, string | null>([
      ["a", null],
      ["b", "a"],
      ["c", "b"],
    ]);
    assert.deepEqual(
      reconstructPathFromPrevious({ previous, targetNodeId: "c" }),
      ["a", "b", "c"],
    );
  });
});
