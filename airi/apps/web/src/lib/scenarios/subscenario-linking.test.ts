import {
  getPostActionAnswerMatchHandleId,
  getPostActionConditionHandleId,
  resolveConditionalScenarioLinkRefs,
} from "@icecore/scenario-contracts";
import {
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  getScenarioActionOutcomeVirtualNodeId,
} from "@icecore/scenario-contracts";
import { resolveSubscenarioLinkSummary } from "@/lib/scenarios/subscenario-linking";

describe("resolveSubscenarioLinkSummary", () => {
  it("resolves direct no-reply outcomes with the virtual condition identity", () => {
    const nodes = [
      {
        id: "action",
        data: {
          kind: "action" as const,
          actionType: "reply" as const,
          actionOutcomes: {
            version: 1 as const,
            noReply: {
              enabled: true as const,
              timeoutMinutes: 90,
              cancelIfPhrases: ["stop"],
            },
          },
        },
      },
      {
        id: "child-link",
        data: {
          kind: "scenario_link" as const,
          linkedScenarioId: "child",
        },
      },
    ];
    const edges = [
      {
        id: "edge-no-reply",
        source: "action",
        target: "child-link",
        sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
      },
    ];

    expect(resolveConditionalScenarioLinkRefs({ nodes, edges })).toEqual({
      refs: [
        expect.objectContaining({
          conditionNodeId: getScenarioActionOutcomeVirtualNodeId("action"),
          sourceActionNodeId: "action",
          branchType: "no_reply_timeout",
          childScenarioId: "child",
          branchConfig: expect.objectContaining({
            timeoutMinutes: 90,
            missingTextPhrases: ["stop"],
          }),
        }),
      ],
      errors: [],
    });
    expect(
      resolveSubscenarioLinkSummary({
        scenarioId: "parent",
        nodes,
        edges,
      })
    ).toMatchObject({
      errors: [],
      summary: {
        linkedChildScenarioIds: ["child"],
        actionNodeCount: 1,
        actionNodeIdsByChildScenarioId: { child: ["action"] },
      },
    });
  });

  it("allows dynamic no-reply answer match branches to target child scenarios", () => {
    const result = resolveSubscenarioLinkSummary({
      scenarioId: "parent",
      nodes: [
        { id: "action", data: { kind: "action", actionType: "reply" } },
        {
          id: "condition",
          data: {
            kind: "logic",
            logicType: "post_action_condition",
            conditionBranches: [
              { id: "user_replied", type: "user_replied" },
              {
                id: "no_reply_timeout",
                type: "no_reply_timeout",
                answerMatchRules: [
                  { id: "pricing", mode: "intent", text: "asking price" },
                ],
              },
            ],
          },
        },
        {
          id: "child-link",
          data: {
            kind: "scenario_link",
            linkedScenarioId: "child",
          },
        },
      ],
      edges: [
        { source: "action", target: "condition" },
        {
          source: "condition",
          target: "child-link",
          sourceHandle: getPostActionAnswerMatchHandleId("pricing"),
        },
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.summary).toEqual({
      linkedChildScenarioIds: ["child"],
      actionNodeCount: 1,
      actionNodeIdsByChildScenarioId: {
        child: ["action"],
      },
    });
  });

  it("summarizes every action that can feed a linked condition branch", () => {
    const result = resolveSubscenarioLinkSummary({
      scenarioId: "parent",
      nodes: [
        { id: "action-a", data: { kind: "action", actionType: "reply" } },
        { id: "action-b", data: { kind: "action", actionType: "reply" } },
        {
          id: "condition",
          data: {
            kind: "logic",
            logicType: "post_action_condition",
          },
        },
        {
          id: "child-link",
          data: {
            kind: "scenario_link",
            linkedScenarioId: "child",
          },
        },
      ],
      edges: [
        { source: "action-a", target: "condition" },
        { source: "action-b", target: "condition" },
        {
          source: "condition",
          target: "child-link",
          sourceHandle: getPostActionConditionHandleId("user_replied"),
        },
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.summary).toEqual({
      linkedChildScenarioIds: ["child"],
      actionNodeCount: 2,
      actionNodeIdsByChildScenarioId: {
        child: ["action-a", "action-b"],
      },
    });
  });

  it("keeps rejecting linked condition branches without an upstream action", () => {
    const result = resolveConditionalScenarioLinkRefs({
      nodes: [
        {
          id: "condition",
          data: {
            kind: "logic",
            logicType: "post_action_condition",
          },
        },
        {
          id: "child-link",
          data: {
            kind: "scenario_link",
            linkedScenarioId: "child",
          },
        },
      ],
      edges: [
        {
          source: "condition",
          target: "child-link",
          sourceHandle: getPostActionConditionHandleId("user_replied"),
        },
      ],
    });

    expect(result.refs).toEqual([]);
    expect(result.errors).toEqual(["condition_branch_requires_action_source"]);
  });
});
