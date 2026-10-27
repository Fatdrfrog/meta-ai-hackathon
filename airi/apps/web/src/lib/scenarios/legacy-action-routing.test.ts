import {
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  buildFlowBranchSourceHandleId,
  buildScenarioActionAnswerOutcomeHandleId,
} from "@icecore/scenario-contracts";
import {
  getPostActionAnswerMatchHandleId,
  getPostActionConditionHandleId,
  lowerScenarioRoutingGraph,
} from "@icecore/scenario-contracts";
import {
  analyzeLegacyActionRouting,
  analyzeLegacyAudienceGate,
  collectEligibleLegacyRoutingConversions,
  convertLegacyActionRouting,
  convertLegacyAudienceGate,
  hasNewLegacyActionRoutingAssignments,
  getLegacyRoutingOwnedNodeIds,
  prepareLegacyRoutingGraphForDeletion,
  projectLegacyActionRoutingForDisplay,
  type LegacyActionRoutingGraph,
} from "./legacy-action-routing";
import { createDemoShopInteractiveNoReplyFixture } from "../../../test-fixtures/scenarios/demoshop-interactive-no-reply";

function createLegacyFlowAliasGraph(): LegacyActionRoutingGraph {
  return {
    nodes: [
      {
        id: "flow-action",
        data: {
          kind: "action",
          actionType: "reply",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "flow",
              body: { mode: "fixed", text: "Choose" },
              flowConfig: {
                templateId: "flow-1",
                ctaText: "Open",
                screens: [
                  {
                    id: "screen-1",
                    title: "Choose",
                    fields: [
                      {
                        id: "plan",
                        label: "Plan",
                        fieldType: "RadioButtonsGroup",
                        options: [{ id: "one", title: "One" }],
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
      {
        id: "condition-1",
        data: {
          kind: "logic",
          logicType: "post_action_condition",
          postActionConditionVariant: "interactive_no_reply",
          interactiveNoReplySurface: "whatsapp_flow",
          conditionBranches: [
            {
              id: "timeout",
              type: "no_reply_timeout",
              timeoutMinutes: 30,
            },
          ],
        },
      },
      {
        id: "timeout-target",
        data: { kind: "action", actionType: "reply" },
      },
    ],
    edges: [
      {
        id: "legacy-flow-alias",
        source: "flow-action",
        target: "condition-1",
        sourceHandle: ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
      },
      {
        id: "specific-flow-option",
        source: "flow-action",
        target: "condition-1",
        sourceHandle: buildFlowBranchSourceHandleId("plan", "one"),
      },
      {
        id: "timeout",
        source: "condition-1",
        target: "timeout-target",
        sourceHandle: getPostActionConditionHandleId("no_reply_timeout"),
      },
    ],
  };
}

describe("hasNewLegacyActionRoutingAssignments", () => {
  const legacyEdge = {
    id: "legacy-edge",
    source: "action-1",
    target: "condition-1",
    sourceHandle: ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
  };

  it("rejects a newly introduced legacy assignment", () => {
    expect(
      hasNewLegacyActionRoutingAssignments({
        previousNodes: [],
        previousEdges: [],
        nextNodes: [],
        nextEdges: [legacyEdge],
      })
    ).toBe(true);
  });

  it("allows an existing assignment to survive normalization or edge id changes", () => {
    expect(
      hasNewLegacyActionRoutingAssignments({
        previousNodes: [],
        previousEdges: [legacyEdge],
        nextNodes: [],
        nextEdges: [{ ...legacyEdge, id: "normalized-edge" }],
      })
    ).toBe(false);
  });

  it("rejects an additional duplicate while ignoring canonical outcomes", () => {
    expect(
      hasNewLegacyActionRoutingAssignments({
        previousNodes: [],
        previousEdges: [legacyEdge],
        nextNodes: [],
        nextEdges: [
          legacyEdge,
          { ...legacyEdge, id: "new-duplicate" },
          {
            source: "action-1",
            target: "canonical-target",
            sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
          },
        ],
      })
    ).toBe(true);
  });

  it("ignores malformed edge entries while evaluating untrusted graph payloads", () => {
    expect(
      hasNewLegacyActionRoutingAssignments({
        previousNodes: [],
        previousEdges: [null, "invalid", legacyEdge],
        nextNodes: [],
        nextEdges: [undefined, 42, { ...legacyEdge, id: "normalized-edge" }],
      })
    ).toBe(false);
  });

  it("preserves a stored generic Flow alias when the client canonicalizes it", () => {
    const previousGraph = createLegacyFlowAliasGraph();
    const nextEdges = previousGraph.edges.map(edge =>
      edge.id === "legacy-flow-alias"
        ? {
            ...edge,
            id: "normalized-alias",
            sourceHandle: ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
          }
        : edge
    );

    expect(
      hasNewLegacyActionRoutingAssignments({
        previousNodes: previousGraph.nodes,
        previousEdges: previousGraph.edges,
        nextNodes: previousGraph.nodes,
        nextEdges,
      })
    ).toBe(false);
  });

  it("rejects a newly authored generic Flow alias", () => {
    const nextGraph = createLegacyFlowAliasGraph();

    expect(
      hasNewLegacyActionRoutingAssignments({
        previousNodes: [],
        previousEdges: [],
        nextNodes: nextGraph.nodes,
        nextEdges: nextGraph.edges,
      })
    ).toBe(true);
  });

  it("does not reclassify a generic Flow edge without option-edge proof", () => {
    const nextGraph = createLegacyFlowAliasGraph();
    nextGraph.edges = nextGraph.edges.filter(
      edge => edge.id !== "specific-flow-option"
    );

    expect(
      hasNewLegacyActionRoutingAssignments({
        previousNodes: [],
        previousEdges: [],
        nextNodes: nextGraph.nodes,
        nextEdges: nextGraph.edges,
      })
    ).toBe(false);
  });
});

function createLegacyGraph(): LegacyActionRoutingGraph {
  return {
    nodes: [
      {
        id: "action-1",
        data: { kind: "action", actionType: "reply" },
      },
      {
        id: "condition-1",
        data: {
          kind: "logic",
          logicType: "post_action_condition",
          conditionBranches: [
            {
              id: "reply",
              type: "user_replied",
              linkedConditionId: "linked-reply",
            },
            {
              id: "timeout",
              type: "no_reply_timeout",
              timeoutMinutes: 120,
              missingTextPhrases: ["stop"],
              answerMatchRules: [
                { id: "interested", mode: "intent", text: "Interested" },
              ],
              linkedConditionId: "linked-timeout",
            },
          ],
        },
      },
      { id: "reply-target", data: { kind: "action", actionType: "reply" } },
      { id: "timeout-target", data: { kind: "scenario_link" } },
      { id: "answer-target", data: { kind: "action", actionType: "reply" } },
    ],
    edges: [
      {
        id: "edge-input",
        source: "action-1",
        target: "condition-1",
        sourceHandle: "right-source",
      },
      {
        id: "edge-reply",
        source: "condition-1",
        sourceHandle: getPostActionConditionHandleId("user_replied"),
        target: "reply-target",
      },
      {
        id: "edge-timeout",
        source: "condition-1",
        sourceHandle: getPostActionConditionHandleId("no_reply_timeout"),
        target: "timeout-target",
      },
      {
        id: "edge-answer",
        source: "condition-1",
        sourceHandle: getPostActionAnswerMatchHandleId("interested"),
        target: "answer-target",
      },
    ],
  };
}

describe("collectEligibleLegacyRoutingConversions", () => {
  it("converts DemoShop dedicated waits and keeps the shared Flow condition", () => {
    const graph = createDemoShopInteractiveNoReplyFixture();
    const plan = collectEligibleLegacyRoutingConversions(graph);

    expect(plan.conversions).toEqual([
      expect.objectContaining({
        sourceActionNodeId: "action-alpha",
        sourceNodeId: "legacy-alpha",
        sourceKind: "post_action_condition",
      }),
      expect.objectContaining({
        sourceActionNodeId: "action-beta",
        sourceNodeId: "legacy-beta",
        sourceKind: "post_action_condition",
      }),
    ]);
    expect(plan.leftovers).toEqual([
      {
        nodeId: "flow-condition-shared",
        sourceKind: "post_action_condition",
        reason: "multiple_sources",
      },
    ]);
    expect(
      plan.convertedGraph.nodes.some(node => node.id === "legacy-alpha")
    ).toBe(false);
    expect(
      plan.convertedGraph.nodes.some(node => node.id === "legacy-beta")
    ).toBe(false);
    expect(
      plan.convertedGraph.nodes.some(
        node => node.id === "flow-condition-shared"
      )
    ).toBe(true);
    expect(
      plan.convertedGraph.nodes.find(node => node.id === "action-alpha")?.data
    ).toMatchObject({
      actionOutcomes: {
        noReply: {
          enabled: true,
          timeoutMinutes: 45,
          cancelIfPhrases: ["cancel"],
        },
      },
    });
  });

  it("converts a unary audience gate after eligible post-action waits", () => {
    const graph = createLegacyGraph();
    graph.nodes.push({
      id: "gate-1",
      data: {
        kind: "logic",
        logicType: "audience_filter",
        audienceMode: "classification",
        classificationCategory: "lead",
      },
    });
    graph.edges.push(
      { id: "edge-trigger", source: "trigger-1", target: "gate-1" },
      { id: "edge-gate", source: "gate-1", target: "action-1" }
    );
    graph.nodes.push({
      id: "trigger-1",
      data: { kind: "trigger" },
    });

    const plan = collectEligibleLegacyRoutingConversions(graph);
    expect(plan.conversions.map(conversion => conversion.sourceKind)).toEqual([
      "post_action_condition",
      "audience_filter",
    ]);
    expect(plan.leftovers).toEqual([]);
    expect(plan.convertedGraph.nodes.some(node => node.id === "condition-1")).toBe(
      false
    );
    expect(plan.convertedGraph.nodes.some(node => node.id === "gate-1")).toBe(
      false
    );
    expect(
      plan.convertedGraph.nodes.find(node => node.id === "action-1")?.data
    ).toMatchObject({
      actionRunConditions: {
        version: 1,
        match: "all",
        conditions: [
          expect.objectContaining({ type: "classification", category: "lead" }),
        ],
      },
    });
    expect(plan.convertedGraph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "edge-trigger", target: "action-1" }),
      ])
    );
  });
});

describe("legacy action routing display projection identity", () => {
  it("keeps every node and edge no conversion changes", () => {
    const graph = createLegacyGraph();
    graph.nodes.push({
      id: "extra",
      data: { kind: "action", actionType: "reply" },
    });
    graph.edges.push({
      id: "edge-extra",
      source: "reply-target",
      target: "extra",
    });
    const projected = projectLegacyActionRoutingForDisplay(graph);
    const byId = new Map(graph.nodes.map(node => [node.id, node]));

    for (const node of projected.nodes) {
      if (node.id === "action-1") {
        expect(node).not.toBe(byId.get(node.id));
      } else {
        expect(node).toBe(byId.get(node.id));
      }
    }
    expect(projected.edges.find(edge => edge.id === "edge-extra")).toBe(
      graph.edges.at(-1)
    );
    expect(projected.nodes).not.toBe(graph.nodes);
  });

  it("returns the persisted nodes and edges of a graph without legacy routing", () => {
    const graph: LegacyActionRoutingGraph = {
      nodes: [
        { id: "trigger", data: { kind: "trigger" } },
        { id: "action", data: { kind: "action", actionType: "reply" } },
      ],
      edges: [{ id: "edge", source: "trigger", target: "action" }],
    };
    const projected = projectLegacyActionRoutingForDisplay(graph);

    expect(projected.nodes).toEqual(graph.nodes);
    projected.nodes.forEach((node, index) =>
      expect(node).toBe(graph.nodes[index])
    );
    expect(projected.edges[0]).toBe(graph.edges[0]);
    expect(projected.legacyRoutingByActionId.size).toBe(0);
  });

  it("keeps a converted step's display data while its inputs are unchanged", () => {
    const graph = createLegacyGraph();
    const first = projectLegacyActionRoutingForDisplay(graph);
    // React Flow measured the nodes: new node objects, same data.
    const measured = {
      nodes: graph.nodes.map(node => ({ ...node, measured: { width: 1 } })),
      edges: graph.edges,
    };
    const second = projectLegacyActionRoutingForDisplay(measured);
    const firstAction = first.nodes.find(node => node.id === "action-1");
    const secondAction = second.nodes.find(node => node.id === "action-1");

    expect(secondAction?.data).toBe(firstAction?.data);
    expect(secondAction).toMatchObject({ measured: { width: 1 } });
    expect(second.legacyRoutingByActionId.get("action-1")).toBe(
      first.legacyRoutingByActionId.get("action-1")
    );

    const conditionData = graph.nodes[1].data;
    const edited = {
      nodes: graph.nodes.map(node =>
        node.id === "condition-1"
          ? {
              ...node,
              data: {
                ...conditionData,
                conditionBranches: conditionData.conditionBranches?.slice(0, 1),
              },
            }
          : node
      ),
      edges: graph.edges.filter(
        edge => edge.id !== "edge-timeout" && edge.id !== "edge-answer"
      ),
    };
    const third = projectLegacyActionRoutingForDisplay(edited);
    const thirdAction = third.nodes.find(node => node.id === "action-1");

    expect(thirdAction?.data).not.toBe(firstAction?.data);
    // The same result as projecting the edited graph from scratch.
    expect(thirdAction?.data).toEqual(
      projectLegacyActionRoutingForDisplay(structuredClone(edited)).nodes.find(
        node => node.id === "action-1"
      )?.data
    );
    expect(thirdAction?.data.actionOutcomes).not.toEqual(
      firstAction?.data.actionOutcomes
    );
  });
});

describe("legacy action routing", () => {
  it("projects a single-owner condition without mutating the persisted graph", () => {
    const graph = createLegacyGraph();
    const before = JSON.stringify(graph);
    const projected = projectLegacyActionRoutingForDisplay(graph);

    expect(JSON.stringify(graph)).toBe(before);
    expect(projected.nodes.some(node => node.id === "condition-1")).toBe(false);
    expect(
      projected.nodes.find(node => node.id === "action-1")?.data
    ).toMatchObject({
      actionOutcomes: {
        version: 1,
        anyReply: { enabled: true, linkedConditionId: "linked-reply" },
        noReply: {
          enabled: true,
          timeoutMinutes: 120,
          cancelIfPhrases: ["stop"],
          linkedConditionId: "linked-timeout",
        },
      },
    });
    expect(
      projected.nodes.find(node => node.id === "action-1")?.data
    ).not.toHaveProperty("uiLegacyActionRouting");
    expect(projected.legacyRoutingByActionId.get("action-1")).toEqual({
      actionOutcomes: expect.objectContaining({
        version: 1,
      }),
      actionOutcomesSource: {
        sourceNodeId: "condition-1",
        sourceKind: "post_action_condition",
      },
    });
  });

  it("converts every branch while preserving edge and target ids", () => {
    const result = convertLegacyActionRouting({
      graph: createLegacyGraph(),
      sourceActionNodeId: "action-1",
      conditionNodeId: "condition-1",
    });

    expect(result.graph.nodes.some(node => node.id === "condition-1")).toBe(
      false
    );
    expect(result.graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "edge-reply",
          source: "action-1",
          sourceHandle: ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
          target: "reply-target",
        }),
        expect.objectContaining({
          id: "edge-timeout",
          source: "action-1",
          sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
          target: "timeout-target",
        }),
        expect.objectContaining({
          id: "edge-answer",
          source: "action-1",
          sourceHandle: buildScenarioActionAnswerOutcomeHandleId("interested"),
          target: "answer-target",
        }),
      ])
    );
    expect(result.graph.edges.some(edge => edge.id === "edge-input")).toBe(
      false
    );
  });

  it("drops the branch of an outcome the conversion patch turns off", () => {
    const result = convertLegacyActionRouting({
      graph: createLegacyGraph(),
      sourceActionNodeId: "action-1",
      conditionNodeId: "condition-1",
      patch: {
        actionOutcomes: {
          version: 1,
          anyReply: { enabled: true, linkedConditionId: "linked-reply" },
          answerMatches: [
            { id: "interested", mode: "intent", text: "Interested" },
          ],
        },
      },
    });

    expect(result.graph.edges.map(edge => edge.id).sort()).toEqual([
      "edge-answer",
      "edge-reply",
    ]);
    expect(
      lowerScenarioRoutingGraph({
        nodes: result.graph.nodes,
        edges: result.graph.edges,
      }).diagnostics
    ).toEqual([]);
  });

  it("converts only an interactive no-reply assignment without disturbing Flow option subtrees", () => {
    const graph: LegacyActionRoutingGraph = {
      nodes: [
        {
          id: "flow-action",
          data: {
            kind: "action",
            actionType: "reply",
            actionWhatsAppServiceMessage: {
              version: 1,
              message: {
                kind: "flow",
                body: { mode: "fixed", text: "Choose" },
                flowConfig: {
                  templateId: "flow-1",
                  ctaText: "Open",
                  screens: [
                    {
                      id: "screen-1",
                      title: "Choose",
                      fields: [
                        {
                          id: "plan",
                          label: "Plan",
                          fieldType: "RadioButtonsGroup",
                          options: [
                            { id: "one", title: "One" },
                            { id: "two", title: "Two" },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
        {
          id: "no-reply-condition",
          data: {
            kind: "logic",
            logicType: "post_action_condition",
            postActionConditionVariant: "interactive_no_reply",
            interactiveNoReplySurface: "whatsapp_flow",
            conditionBranches: [
              {
                id: "timeout",
                type: "no_reply_timeout",
                timeoutMinutes: 45,
              },
            ],
          },
        },
        {
          id: "option-one-condition",
          data: { kind: "logic", logicType: "post_action_condition" },
        },
        {
          id: "option-two-condition",
          data: { kind: "logic", logicType: "post_action_condition" },
        },
        { id: "timeout-target", data: { kind: "action", actionType: "reply" } },
        {
          id: "option-one-target",
          data: { kind: "action", actionType: "reply" },
        },
        {
          id: "option-two-target",
          data: { kind: "action", actionType: "reply" },
        },
      ],
      edges: [
        {
          id: "edge-dedicated",
          source: "flow-action",
          sourceHandle: ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
          target: "no-reply-condition",
        },
        {
          id: "edge-no-reply",
          source: "no-reply-condition",
          sourceHandle: getPostActionConditionHandleId("no_reply_timeout"),
          target: "timeout-target",
        },
        {
          id: "edge-flow-one",
          source: "flow-action",
          sourceHandle: buildFlowBranchSourceHandleId("plan", "one"),
          target: "option-one-condition",
        },
        {
          id: "edge-flow-one-subtree",
          source: "option-one-condition",
          sourceHandle: getPostActionConditionHandleId("user_replied"),
          target: "option-one-target",
        },
        {
          id: "edge-flow-two",
          source: "flow-action",
          sourceHandle: buildFlowBranchSourceHandleId("plan", "two"),
          target: "option-two-condition",
        },
        {
          id: "edge-flow-two-subtree",
          source: "option-two-condition",
          sourceHandle: getPostActionConditionHandleId("user_replied"),
          target: "option-two-target",
        },
      ],
    };
    const flowOptionSubtrees = {
      nodes: graph.nodes.filter(node =>
        [
          "option-one-condition",
          "option-one-target",
          "option-two-condition",
          "option-two-target",
        ].includes(node.id)
      ),
      edges: graph.edges.filter(edge =>
        [
          "edge-flow-one",
          "edge-flow-one-subtree",
          "edge-flow-two",
          "edge-flow-two-subtree",
        ].includes(edge.id ?? "")
      ),
    };

    expect(
      analyzeLegacyActionRouting({
        graph,
        conditionNodeId: "no-reply-condition",
      })
    ).toMatchObject({ eligible: true, sourceActionNodeId: "flow-action" });

    const converted = convertLegacyActionRouting({
      graph,
      sourceActionNodeId: "flow-action",
      conditionNodeId: "no-reply-condition",
    });

    expect(
      converted.graph.nodes.some(node => node.id === "no-reply-condition")
    ).toBe(false);
    expect(
      converted.graph.nodes.find(node => node.id === "flow-action")?.data
    ).toMatchObject({
      actionOutcomes: {
        version: 1,
        noReply: { enabled: true, timeoutMinutes: 45 },
      },
    });
    expect(
      converted.graph.nodes.find(node => node.id === "flow-action")?.data
        .actionOutcomes
    ).not.toHaveProperty("anyReply");
    expect(converted.graph.edges).toContainEqual({
      id: "edge-no-reply",
      source: "flow-action",
      sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
      target: "timeout-target",
    });
    expect({
      nodes: converted.graph.nodes.filter(node =>
        flowOptionSubtrees.nodes.some(original => original.id === node.id)
      ),
      edges: converted.graph.edges.filter(edge =>
        flowOptionSubtrees.edges.some(original => original.id === edge.id)
      ),
    }).toEqual(flowOptionSubtrees);
  });

  it("keeps a dedicated interactive no-reply condition ineligible when a generic condition also belongs to the action", () => {
    const graph: LegacyActionRoutingGraph = {
      nodes: [
        {
          id: "action-1",
          data: { kind: "action", actionType: "reply" },
        },
        {
          id: "no-reply-condition",
          data: {
            kind: "logic",
            logicType: "post_action_condition",
            postActionConditionVariant: "interactive_no_reply",
            interactiveNoReplySurface: "whatsapp_flow",
          },
        },
        {
          id: "generic-condition",
          data: { kind: "logic", logicType: "post_action_condition" },
        },
      ],
      edges: [
        {
          id: "edge-dedicated",
          source: "action-1",
          sourceHandle: ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
          target: "no-reply-condition",
        },
        {
          id: "edge-generic",
          source: "action-1",
          sourceHandle: "right-source",
          target: "generic-condition",
        },
      ],
    };

    expect(
      analyzeLegacyActionRouting({
        graph,
        conditionNodeId: "no-reply-condition",
      })
    ).toMatchObject({ eligible: false, reason: "multiple_conditions" });
  });

  it("keeps a dedicated interactive no-reply condition ineligible when a Flow-shaped sibling is not configured", () => {
    const graph: LegacyActionRoutingGraph = {
      nodes: [
        {
          id: "flow-action",
          data: {
            kind: "action",
            actionType: "reply",
            actionWhatsAppServiceMessage: {
              version: 1,
              message: {
                kind: "flow",
                body: { mode: "fixed", text: "Choose" },
                flowConfig: {
                  templateId: "flow-1",
                  ctaText: "Open",
                  screens: [
                    {
                      id: "screen-1",
                      title: "Choose",
                      fields: [
                        {
                          id: "plan",
                          label: "Plan",
                          fieldType: "RadioButtonsGroup",
                          options: [{ id: "one", title: "One" }],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
        {
          id: "no-reply-condition",
          data: {
            kind: "logic",
            logicType: "post_action_condition",
            postActionConditionVariant: "interactive_no_reply",
            interactiveNoReplySurface: "whatsapp_flow",
          },
        },
        {
          id: "unconfigured-flow-condition",
          data: { kind: "logic", logicType: "post_action_condition" },
        },
      ],
      edges: [
        {
          id: "edge-dedicated",
          source: "flow-action",
          sourceHandle: ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
          target: "no-reply-condition",
        },
        {
          id: "edge-unconfigured-flow",
          source: "flow-action",
          sourceHandle: buildFlowBranchSourceHandleId(
            "missing-field",
            "missing-option"
          ),
          target: "unconfigured-flow-condition",
        },
      ],
    };

    expect(
      analyzeLegacyActionRouting({
        graph,
        conditionNodeId: "no-reply-condition",
      })
    ).toMatchObject({ eligible: false, reason: "multiple_conditions" });
  });

  it("keeps multi-source and multi-condition ownership explicit", () => {
    const multiSource = createLegacyGraph();
    multiSource.nodes.push({
      id: "action-2",
      data: { kind: "action", actionType: "reply" },
    });
    multiSource.edges.push({
      id: "edge-input-2",
      source: "action-2",
      target: "condition-1",
    });
    expect(
      analyzeLegacyActionRouting({
        graph: multiSource,
        conditionNodeId: "condition-1",
      })
    ).toMatchObject({ eligible: false, reason: "multiple_sources" });

    const multiCondition = createLegacyGraph();
    multiCondition.nodes.push({
      id: "condition-2",
      data: {
        kind: "logic",
        logicType: "post_action_condition",
      },
    });
    multiCondition.edges.push({
      id: "edge-input-2",
      source: "action-1",
      target: "condition-2",
    });
    expect(
      analyzeLegacyActionRouting({
        graph: multiCondition,
        conditionNodeId: "condition-1",
      })
    ).toMatchObject({ eligible: false, reason: "multiple_conditions" });
    const projected = projectLegacyActionRoutingForDisplay(multiSource);
    expect(projected.nodes).toEqual(multiSource.nodes);
    expect(projected.edges).toEqual(multiSource.edges);
    expect(projected.legacyRoutingByActionId.size).toBe(0);
  });

  it("identifies the hidden condition that must be deleted with its action", () => {
    expect(
      getLegacyRoutingOwnedNodeIds({
        graph: createLegacyGraph(),
        sourceActionNodeIds: new Set(["action-1"]),
      })
    ).toEqual(new Set(["condition-1"]));
  });

  it("keeps duplicate branch edges explicit even when they share a target", () => {
    const graph = createLegacyGraph();
    graph.edges.push({
      id: "edge-reply-duplicate",
      source: "condition-1",
      sourceHandle: getPostActionConditionHandleId("user_replied"),
      target: "reply-target",
    });

    expect(
      analyzeLegacyActionRouting({
        graph,
        conditionNodeId: "condition-1",
      })
    ).toMatchObject({ eligible: false, reason: "multiple_targets" });
  });
});

function createAudienceGateGraph(
  gateData: Record<string, unknown> = {
    audienceMode: "internalLabel",
    internalLabel: "vip",
  }
): LegacyActionRoutingGraph {
  return {
    nodes: [
      { id: "trigger-1", data: { kind: "trigger" } },
      {
        id: "gate-1",
        data: {
          kind: "logic",
          logicType: "audience_filter",
          ...gateData,
        },
      },
      {
        id: "action-1",
        data: { kind: "action", actionType: "reply" },
      },
    ],
    edges: [
      { id: "edge-in", source: "trigger-1", target: "gate-1" },
      { id: "edge-out", source: "gate-1", target: "action-1" },
    ],
  };
}

describe("legacy audience gates", () => {
  it.each([
    [
      { audienceMode: "classification", classificationCategory: "lead" },
      { type: "classification", category: "lead" },
    ],
    [
      { audienceMode: "internalLabel", internalLabel: "vip" },
      { type: "internal_label", label: "vip" },
    ],
    [
      { audienceMode: "specificCustomers", customerIds: ["a", "b"] },
      { type: "specific_customers", customerIds: ["a", "b"] },
    ],
    [
      { audienceMode: "has_purchase_history" },
      { type: "has_purchase_history" },
    ],
    [
      { audienceMode: "funnel_stage", audienceFunnelStage: "retention" },
      { type: "funnel_stage", stage: "retention" },
    ],
    [
      {
        audienceMode: "last_seen_greater_than_x_days",
        audienceLastSeenDays: 14.9,
      },
      { type: "last_seen_days", minimumDays: 14 },
    ],
    [
      { audienceMode: "last_seen_days", audienceLastSeenDays: 30 },
      { type: "last_seen_days", minimumDays: 30 },
    ],
  ])(
    "maps legacy audience mode %# with runtime parity",
    (gateData, expected) => {
      const analysis = analyzeLegacyAudienceGate({
        graph: createAudienceGateGraph(gateData),
        gateNodeId: "gate-1",
      });

      expect(analysis).toMatchObject({
        eligible: true,
        sourceActionNodeId: "action-1",
        actionRunConditions: {
          version: 1,
          match: "all",
          conditions: [expect.objectContaining(expected)],
        },
      });
    }
  );

  it("projects and converts a unary gate without mutating the input", () => {
    const graph = createAudienceGateGraph();
    const before = JSON.stringify(graph);
    const projected = projectLegacyActionRoutingForDisplay(graph);
    const converted = convertLegacyAudienceGate({
      graph,
      sourceActionNodeId: "action-1",
      gateNodeId: "gate-1",
    });

    expect(JSON.stringify(graph)).toBe(before);
    expect(projected.nodes.map(node => node.id)).toEqual([
      "trigger-1",
      "action-1",
    ]);
    expect(
      projected.nodes.find(node => node.id === "action-1")?.data
    ).toMatchObject({
      actionRunConditions: {
        conditions: [expect.objectContaining({ type: "internal_label" })],
      },
    });
    expect(
      projected.nodes.find(node => node.id === "action-1")?.data
    ).not.toHaveProperty("uiLegacyActionRouting");
    expect(projected.legacyRoutingByActionId.get("action-1")).toEqual({
      actionRunConditions: expect.objectContaining({
        conditions: [expect.objectContaining({ type: "internal_label" })],
      }),
      actionRunConditionsSource: {
        sourceNodeId: "gate-1",
        sourceKind: "audience_filter",
      },
    });
    expect(converted.graph.nodes.map(node => node.id)).toEqual([
      "trigger-1",
      "action-1",
    ]);
    expect(converted.graph.edges).toEqual([
      expect.objectContaining({
        id: "edge-in",
        source: "trigger-1",
        target: "action-1",
      }),
    ]);
  });

  it("combines a gate with existing action conditions using AND semantics", () => {
    const graph = createAudienceGateGraph();
    graph.nodes.find(node => node.id === "action-1")!.data.actionRunConditions =
      {
        version: 1,
        match: "all",
        conditions: [{ id: "purchase", type: "has_purchase_history" }],
      };

    expect(
      analyzeLegacyAudienceGate({ graph, gateNodeId: "gate-1" })
    ).toMatchObject({
      eligible: true,
      actionRunConditions: {
        match: "all",
        conditions: [
          expect.objectContaining({ type: "has_purchase_history" }),
          expect.objectContaining({ type: "internal_label", label: "vip" }),
        ],
      },
    });
  });

  it("keeps unsafe or unconfigured gate topologies explicit", () => {
    const multiTarget = createAudienceGateGraph();
    multiTarget.nodes.push({
      id: "action-2",
      data: { kind: "action", actionType: "reply" },
    });
    multiTarget.edges.push({
      id: "edge-out-2",
      source: "gate-1",
      target: "action-2",
    });
    expect(
      analyzeLegacyAudienceGate({ graph: multiTarget, gateNodeId: "gate-1" })
    ).toMatchObject({ eligible: false, reason: "multiple_targets" });

    const bypassedAction = createAudienceGateGraph();
    bypassedAction.edges.push({
      id: "edge-bypass",
      source: "trigger-1",
      target: "action-1",
    });
    expect(
      analyzeLegacyAudienceGate({
        graph: bypassedAction,
        gateNodeId: "gate-1",
      })
    ).toMatchObject({ eligible: false, reason: "shared_action" });

    const noPredecessor = createAudienceGateGraph();
    noPredecessor.edges = noPredecessor.edges.filter(
      edge => edge.id !== "edge-in"
    );
    expect(
      analyzeLegacyAudienceGate({
        graph: noPredecessor,
        gateNodeId: "gate-1",
      })
    ).toMatchObject({ eligible: false, reason: "multiple_sources" });

    expect(
      analyzeLegacyAudienceGate({
        graph: createAudienceGateGraph({ audienceMode: "all" }),
        gateNodeId: "gate-1",
      })
    ).toMatchObject({ eligible: false, reason: "unconfigured_gate" });

    expect(
      analyzeLegacyAudienceGate({
        graph: createAudienceGateGraph({
          audienceMode: "specificCustomers",
          customerIds: Array.from({ length: 21 }, (_, index) => `c-${index}`),
        }),
        gateNodeId: "gate-1",
      })
    ).toMatchObject({ eligible: false, reason: "unconfigured_gate" });

    const futureActionConditions = createAudienceGateGraph();
    futureActionConditions.nodes.find(node => node.id === "action-1")!.data = {
      kind: "action",
      actionType: "reply",
      actionRunConditions: { version: 99 } as never,
    };
    expect(
      analyzeLegacyAudienceGate({
        graph: futureActionConditions,
        gateNodeId: "gate-1",
      })
    ).toMatchObject({ eligible: false, reason: "mixed_ownership" });

    const futureLogic = createAudienceGateGraph();
    futureLogic.nodes.find(node => node.id === "gate-1")!.data.logicType =
      "future_logic" as never;
    expect(
      analyzeLegacyAudienceGate({
        graph: futureLogic,
        gateNodeId: "gate-1",
      })
    ).toMatchObject({ eligible: false, reason: "missing_gate" });
  });

  it("preserves separate legacy sources when an action owns both domains", () => {
    const graph = createLegacyGraph();
    graph.nodes.unshift(
      { id: "trigger-1", data: { kind: "trigger" } },
      {
        id: "gate-1",
        data: {
          kind: "logic",
          logicType: "audience_filter",
          audienceMode: "internalLabel",
          internalLabel: "vip",
        },
      }
    );
    graph.edges.unshift(
      { id: "entry", source: "trigger-1", target: "gate-1" },
      { id: "gate-action", source: "gate-1", target: "action-1" }
    );

    const projected = projectLegacyActionRoutingForDisplay(graph);
    expect(projected.legacyRoutingByActionId.get("action-1")).toMatchObject({
      actionOutcomesSource: {
        sourceNodeId: "condition-1",
        sourceKind: "post_action_condition",
      },
      actionRunConditionsSource: {
        sourceNodeId: "gate-1",
        sourceKind: "audience_filter",
      },
    });
    expect(
      getLegacyRoutingOwnedNodeIds({
        graph,
        sourceActionNodeIds: new Set(["action-1"]),
      })
    ).toEqual(new Set(["condition-1", "gate-1"]));
  });

  it("materializes a hidden gate before deleting its visible predecessor", () => {
    const prepared = prepareLegacyRoutingGraphForDeletion({
      graph: createAudienceGateGraph(),
      nodeIds: new Set(["trigger-1"]),
      edgeIds: new Set(),
    });

    expect(prepared.nodeIds).toEqual(new Set(["trigger-1"]));
    expect(prepared.graph.nodes.map(node => node.id)).toEqual([
      "trigger-1",
      "action-1",
    ]);
    expect(
      prepared.graph.nodes.find(node => node.id === "action-1")?.data
    ).toMatchObject({
      actionRunConditions: {
        conditions: [expect.objectContaining({ type: "internal_label" })],
      },
    });
    expect(prepared.graph.edges).toEqual([
      expect.objectContaining({
        id: "edge-in",
        source: "trigger-1",
        target: "action-1",
      }),
    ]);
  });

  it("expands action deletion to every hidden routing node it owns", () => {
    const graph = createAudienceGateGraph();
    const conditionGraph = createLegacyGraph();
    graph.nodes.push(
      conditionGraph.nodes.find(node => node.id === "condition-1")!
    );
    graph.edges.push({
      id: "condition-input",
      source: "action-1",
      target: "condition-1",
    });

    const prepared = prepareLegacyRoutingGraphForDeletion({
      graph,
      nodeIds: new Set(["action-1"]),
      edgeIds: new Set(),
    });

    expect(prepared.nodeIds).toEqual(
      new Set(["action-1", "condition-1", "gate-1"])
    );
  });
});
