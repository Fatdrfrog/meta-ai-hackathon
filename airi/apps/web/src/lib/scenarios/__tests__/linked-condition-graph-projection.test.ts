import {
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  getScenarioActionOutcomeVirtualNodeId,
} from "@icecore/scenario-contracts";
import {
  buildLinkedChildTriggerData,
  computeLinkedConditionDedupeFacts,
  findTriggerNodeForScenario,
  projectApplyLinkedConditionToChildGraph,
  projectClearLinkedConditionFromChildGraph,
  projectLinkedConditionParentCountsByNodeId,
  projectLinkedConditionToParentGraph,
  resolveChildScenarioLinkedConditionId,
} from "../linked-condition-graph-projection";
import { LINKED_CONDITION_ERROR_CODES } from "../linked-conditions-types";
import { getPostActionConditionHandleId } from "@icecore/scenario-contracts";

describe("linked-condition graph projection", () => {
  it("projects linked parent counts separately from persisted node data", () => {
    const nodes = [
      {
        id: "trigger-1",
        data: {
          kind: "trigger",
          linkedConditionId: "condition-1",
        },
      },
    ];

    const counts = projectLinkedConditionParentCountsByNodeId({
      nodes,
      records: [
        {
          _id: "condition-1",
          parentRefs: [
            {
              parentScenarioId: "parent-1",
              conditionNodeId: "logic-1",
              branchType: "user_replied",
              sourceActionNodeId: "action-1",
              scenarioLinkNodeId: "link-1",
            },
            {
              parentScenarioId: "parent-2",
              conditionNodeId: "logic-2",
              branchType: "no_reply_timeout",
              sourceActionNodeId: "action-2",
              scenarioLinkNodeId: "link-2",
            },
          ],
        },
      ],
    });

    expect(counts).toEqual({ "trigger-1": 2 });
    expect(nodes[0]?.data).not.toHaveProperty("uiLinkedConditionParentCount");
  });

  it("selects the preferred trigger, then falls back to the first trigger", () => {
    const scenario = {
      nodes: [
        { id: "trigger-a", data: { kind: "trigger" } },
        { id: "trigger-b", data: { kind: "trigger" } },
      ],
    };

    expect(
      findTriggerNodeForScenario({
        scenario,
        preferredTriggerNodeId: "trigger-b",
      })?.id
    ).toBe("trigger-b");
    expect(findTriggerNodeForScenario({ scenario })?.id).toBe("trigger-a");
  });

  it("builds canonical child entry data without retaining retired matcher fields", () => {
    expect(
      buildLinkedChildTriggerData({
        linkedConditionId: "condition-1",
        data: {
          kind: "trigger",
          triggerConfig: {
            enabled: false,
            messageMatchMode: "contains",
            keywordPattern: "legacy",
          },
          internalLabel: "keep-this",
        },
      })
    ).toEqual({
      kind: "trigger",
      linkedConditionId: "condition-1",
      triggerConfig: {
        enabled: true,
        messageMatchMode: "any",
        keywordMatchMode: "contains",
      },
      internalLabel: "keep-this",
    });
  });

  it("applies child linkage immutably and becomes idempotent", () => {
    const nodes = [
      {
        id: "trigger-1",
        position: { x: 12, y: 24 },
        data: {
          kind: "trigger",
          triggerConfig: { messageMatchMode: "exact", keywordPattern: "hi" },
          custom: { keep: true },
        },
      },
    ];
    const edges = [
      {
        id: "edge-1",
        source: "trigger-1",
        target: "action-1",
        custom: "keep",
      },
    ];
    const scenario = { nodes, edges };

    const applied = projectApplyLinkedConditionToChildGraph({
      childScenario: scenario,
      recordId: "record-1",
    });

    expect(applied.changed).toBe(true);
    expect(applied.triggerNodeId).toBe("trigger-1");
    expect(applied.nodes).not.toBe(nodes);
    expect(applied.nodes[0]).not.toBe(nodes[0]);
    expect(applied.edges).not.toBe(edges);
    expect(applied.edges[0]).not.toBe(edges[0]);
    expect(applied.nodes[0]).toMatchObject({
      position: { x: 12, y: 24 },
      data: {
        linkedConditionId: "record-1",
        custom: { keep: true },
        triggerConfig: {
          enabled: true,
          messageMatchMode: "any",
          keywordMatchMode: "contains",
        },
      },
    });
    expect(nodes[0]?.data).not.toHaveProperty("linkedConditionId");

    const reapplied = projectApplyLinkedConditionToChildGraph({
      childScenario: {
        ...scenario,
        nodes: applied.nodes,
        edges: applied.edges,
      },
      recordId: "record-1",
      childTriggerNodeId: "trigger-1",
    });
    expect(reapplied.changed).toBe(false);
    expect(reapplied.nodes).not.toBe(applied.nodes);
    expect(reapplied.edges).not.toBe(applied.edges);
  });

  it("rewrites a canonical-looking raw legacy trigger through the factory", () => {
    const projected = projectApplyLinkedConditionToChildGraph({
      childScenario: {
        nodes: [
          {
            id: "trigger-1",
            data: {
              kind: "trigger",
              triggerType: "incoming_message",
              linkedConditionId: "record-1",
              triggerConfig: {
                enabled: true,
                messageMatchMode: "any",
                keywordMatchMode: "contains",
              },
            },
          },
        ],
      },
      recordId: "record-1",
    });

    expect(projected.changed).toBe(true);
    expect(projected.nodes[0]?.data).not.toHaveProperty("triggerType");
    expect(projected.nodes[0]?.data).toMatchObject({
      kind: "trigger",
      linkedConditionId: "record-1",
      triggerConfig: {
        enabled: true,
        messageMatchMode: "any",
        keywordMatchMode: "contains",
      },
    });
  });

  it("clears only the matching child linkage immutably", () => {
    const scenario = {
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            linkedConditionId: "record-1",
            custom: "keep",
          },
        },
        {
          id: "trigger-2",
          data: {
            kind: "trigger",
            linkedConditionId: "record-2",
          },
        },
      ],
      edges: [{ id: "edge-1", source: "trigger-1", target: "trigger-2" }],
    };

    const cleared = projectClearLinkedConditionFromChildGraph({
      childScenario: scenario,
      linkedConditionId: "record-1",
    });

    expect(cleared.changed).toBe(true);
    expect(cleared.nodes[0]?.data).toEqual({
      kind: "trigger",
      custom: "keep",
    });
    expect(cleared.nodes[1]?.data).toMatchObject({
      linkedConditionId: "record-2",
    });
    expect(scenario.nodes[0]?.data).toHaveProperty(
      "linkedConditionId",
      "record-1"
    );
  });

  it("projects legacy condition-node metadata and repairs its edge handle", () => {
    const projected = projectLinkedConditionToParentGraph({
      scenario: {
        _id: "parent-1",
        nodes: [
          {
            id: "condition-1",
            data: {
              kind: "logic",
              logicType: "post_action_condition",
              conditionBranches: [
                { id: "reply", type: "user_replied" },
                {
                  id: "timeout",
                  type: "no_reply_timeout",
                  timeoutMinutes: 30,
                },
              ],
            },
          },
          {
            id: "link-1",
            data: { kind: "scenario_link", linkedScenarioId: "child-1" },
          },
        ],
        edges: [
          {
            id: "edge-1",
            source: "condition-1",
            sourceHandle: "wrong-handle",
            target: "link-1",
          },
        ],
      },
      recordId: "record-1",
      childScenarioId: "child-1",
      conditionType: "no_reply_timeout",
      conditionConfig: { timeoutMinutes: 90 },
      parentRefs: [
        {
          parentScenarioId: "parent-1",
          conditionNodeId: "condition-1",
          branchType: "no_reply_timeout",
          sourceActionNodeId: "action-1",
          scenarioLinkNodeId: "link-1",
        },
      ],
    });

    expect(projected.changed).toBe(true);
    expect(projected.nodes[0]?.data).toMatchObject({
      conditionBranches: [
        { type: "user_replied" },
        {
          type: "no_reply_timeout",
          timeoutMinutes: 90,
          linkedConditionId: "record-1",
        },
      ],
    });
    expect(projected.edges[0]?.sourceHandle).toBe(
      getPostActionConditionHandleId("no_reply_timeout")
    );
  });

  it("projects virtual action outcomes and is idempotent", () => {
    const scenario = {
      _id: "parent-1",
      nodes: [
        {
          id: "action-1",
          data: {
            kind: "action",
            actionOutcomes: {
              version: 1,
              noReply: { enabled: true, timeoutMinutes: 30 },
            },
          },
        },
        {
          id: "link-1",
          data: { kind: "scenario_link", linkedScenarioId: "child-1" },
        },
      ],
      edges: [
        {
          id: "edge-1",
          source: "action-1",
          sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
          target: "link-1",
        },
      ],
    };
    const params = {
      recordId: "record-1",
      childScenarioId: "child-1",
      conditionType: "no_reply_timeout" as const,
      conditionConfig: {
        timeoutMinutes: 90,
        missingTextPhrases: ["stop"],
      },
      parentRefs: [
        {
          parentScenarioId: "parent-1",
          conditionNodeId: getScenarioActionOutcomeVirtualNodeId("action-1"),
          branchType: "no_reply_timeout" as const,
          sourceActionNodeId: "action-1",
          scenarioLinkNodeId: "link-1",
        },
      ],
    };

    const applied = projectLinkedConditionToParentGraph({
      scenario,
      ...params,
    });
    expect(applied.changed).toBe(true);
    expect(applied.nodes[0]?.data).toMatchObject({
      actionOutcomes: {
        noReply: {
          enabled: true,
          timeoutMinutes: 90,
          cancelIfPhrases: ["stop"],
          linkedConditionId: "record-1",
        },
      },
    });

    const reapplied = projectLinkedConditionToParentGraph({
      scenario: {
        ...scenario,
        nodes: applied.nodes,
        edges: applied.edges,
      },
      ...params,
    });
    expect(reapplied.changed).toBe(false);
    expect(reapplied.nodes).not.toBe(applied.nodes);
    expect(reapplied.edges).not.toBe(applied.edges);
  });

  it("rejects a parent branch handle already targeting another node", () => {
    expect(() =>
      projectLinkedConditionToParentGraph({
        scenario: {
          nodes: [
            {
              id: "action-1",
              data: {
                kind: "action",
                actionOutcomes: {
                  version: 1,
                  anyReply: { enabled: true },
                },
              },
            },
            { id: "link-1", data: { kind: "scenario_link" } },
            { id: "link-2", data: { kind: "scenario_link" } },
          ],
          edges: [
            {
              id: "edge-conflict",
              source: "action-1",
              sourceHandle: ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
              target: "link-2",
            },
          ],
        },
        recordId: "record-1",
        childScenarioId: "child-1",
        conditionType: "user_replied",
        conditionConfig: {},
        parentRefs: [
          {
            parentScenarioId: "parent-1",
            conditionNodeId: getScenarioActionOutcomeVirtualNodeId("action-1"),
            branchType: "user_replied",
            sourceActionNodeId: "action-1",
            scenarioLinkNodeId: "link-1",
          },
        ],
      })
    ).toThrow(LINKED_CONDITION_ERROR_CODES.conflictingParentBranchTarget);
  });

  it("keeps missing-trigger and linked-ID resolution behavior", () => {
    expect(() =>
      projectApplyLinkedConditionToChildGraph({
        childScenario: { _id: "child-1", nodes: [] },
        recordId: "record-1",
      })
    ).toThrow(LINKED_CONDITION_ERROR_CODES.missingChildTrigger);
    expect(
      resolveChildScenarioLinkedConditionId({
        nodes: [
          {
            id: "trigger-1",
            data: {
              kind: "trigger",
              linkedConditionId: " record-1 ",
            },
          },
        ],
      })
    ).toBe("record-1");
  });

  it("computes deterministic duplicate winner, parent merge, and deletions", () => {
    const facts = computeLinkedConditionDedupeFacts({
      childScenario: {
        nodes: [
          {
            id: "trigger-1",
            data: { kind: "trigger", linkedConditionId: "record-preferred" },
          },
        ],
      },
      records: [
        {
          _id: "record-newer",
          updatedAt: "2026-06-01T00:00:00.000Z",
          parentRefs: [
            {
              parentScenarioId: "parent-2",
              conditionNodeId: "condition-2",
              branchType: "user_replied",
              sourceActionNodeId: "action-2",
              scenarioLinkNodeId: "link-2",
            },
          ],
        },
        {
          _id: "record-preferred",
          updatedAt: "2026-01-01T00:00:00.000Z",
          parentRefs: [
            {
              parentScenarioId: "parent-1",
              conditionNodeId: "condition-1",
              branchType: "user_replied",
              sourceActionNodeId: "action-1",
              scenarioLinkNodeId: "link-1",
            },
          ],
        },
      ],
    });

    expect(facts?.canonicalRecordId).toBe("record-preferred");
    expect(facts?.duplicateRecordIds).toEqual(["record-newer"]);
    expect(facts?.mergedParentRefs.map(ref => ref.parentScenarioId)).toEqual([
      "parent-1",
      "parent-2",
    ]);
  });
});
