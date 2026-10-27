import {
  compileScenarioGraph,
  type ScenarioRuntimeNode,
} from "@icecore/airi-runtime/scenario-graph";
import {
  getCompiledScenarioFlowStructureIssue,
  hasAmbiguousFirstActionsFromStart,
  hasUnprotectedPathBetween,
  listBulkPrimaryWhatsAppTemplateIds,
  validateCompiledScenarioFlowStructure,
  validateScenarioFlowStructure,
} from "./flow-structure-validation";
import type { ScenarioNodeData } from "@icecore/scenario-contracts";
import {
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  buildPostActionLocationRouteHandleId,
  buildScenarioActionOutcomeHandleId,
  getPostActionAnswerMatchHandleId,
  getPostActionConditionHandleId,
} from "@icecore/scenario-contracts";
import { buildRecipientColumnSplitPathHandleId } from "@icecore/scenario-contracts";

function node(id: string, data: ScenarioNodeData): ScenarioRuntimeNode {
  return { id, data };
}

function canonicalFlowAction(): ScenarioNodeData {
  return {
    kind: "action",
    actionType: "reply",
    actionReplyChannel: "whatsapp",
    actionWhatsAppServiceMessage: {
      version: 1,
      message: {
        kind: "flow",
        body: { mode: "fixed", text: "Open" },
        flowConfig: {
          templateId: "lead-form",
          ctaText: "Open",
          screens: [],
        },
      },
    },
  };
}

describe("hasAmbiguousFirstActionsFromStart", () => {
  it("returns true when two actions are reached at the same distance from a fork", () => {
    const nodes = [
      node("t", { kind: "trigger" }),
      node("c", { kind: "logic", logicType: "audience_filter" }),
      node("a1", { kind: "action", actionType: "reply" }),
      node("a2", { kind: "action", actionType: "reply" }),
    ];
    const edges = [
      { source: "t", target: "c" },
      { source: "c", target: "a1" },
      { source: "c", target: "a2" },
    ];
    const graph = compileScenarioGraph(nodes, edges);
    expect(hasAmbiguousFirstActionsFromStart({ graph, startId: "c" })).toBe(
      true
    );
  });

  it("returns false when actions are on different depths", () => {
    const nodes = [
      node("c", { kind: "logic", logicType: "audience_filter" }),
      node("m", { kind: "logic", logicType: "audience_filter" }),
      node("a1", { kind: "action", actionType: "reply" }),
      node("a2", { kind: "action", actionType: "reply" }),
    ];
    const edges = [
      { source: "c", target: "a1" },
      { source: "c", target: "m" },
      { source: "m", target: "a2" },
    ];
    const graph = compileScenarioGraph(nodes, edges);
    expect(hasAmbiguousFirstActionsFromStart({ graph, startId: "c" })).toBe(
      false
    );
  });
});

describe("hasUnprotectedPathBetween", () => {
  it("detects direct edge between two interactive actions without post-action condition", () => {
    const nodes = [
      node("w1", canonicalFlowAction()),
      node("w2", canonicalFlowAction()),
    ];
    const edges = [{ source: "w1", target: "w2" }];
    const graph = compileScenarioGraph(nodes, edges);
    expect(hasUnprotectedPathBetween({ graph, fromId: "w1", toId: "w2" })).toBe(
      true
    );
  });

  it("returns false when a post-action condition sits between", () => {
    const nodes = [
      node("w1", canonicalFlowAction()),
      node("pac", {
        kind: "logic",
        logicType: "post_action_condition",
      }),
      node("w2", canonicalFlowAction()),
    ];
    const edges = [
      { source: "w1", target: "pac" },
      { source: "pac", target: "w2" },
    ];
    const graph = compileScenarioGraph(nodes, edges);
    expect(hasUnprotectedPathBetween({ graph, fromId: "w1", toId: "w2" })).toBe(
      false
    );
  });
});

describe("validateCompiledScenarioFlowStructure", () => {
  const boundTemplate: ScenarioNodeData = {
    kind: "action",
    actionType: "whatsapp_template",
    actionWhatsAppTemplateBindings: { version: 1, parameters: {} },
  };

  it.each([false, true])(
    "blocks conversation bindings on a bulk primary action (intermediate logic: %s)",
    intermediate => {
      const graph = compileScenarioGraph(
        [
          node("bulk", { kind: "bulk" }),
          ...(intermediate
            ? [node("logic", { kind: "logic", logicType: "audience_filter" })]
            : []),
          node("send", boundTemplate),
        ],
        intermediate
          ? [
              { source: "bulk", target: "logic" },
              { source: "logic", target: "send" },
            ]
          : [{ source: "bulk", target: "send" }]
      );
      expect(getCompiledScenarioFlowStructureIssue(graph)).toEqual({
        errorKey: "whatsappTemplateBindingsRequireConversation",
        relatedNodeIds: ["bulk", "send"],
      });
    }
  );

  it("allows conversation bindings on a bulk conversation follow-up", () => {
    const graph = compileScenarioGraph(
      [
        node("bulk", { kind: "bulk" }),
        node("primary", { kind: "action", actionType: "whatsapp_template" }),
        node("follow-up", boundTemplate),
      ],
      [
        { source: "bulk", target: "primary" },
        { source: "primary", target: "follow-up" },
      ]
    );
    expect(getCompiledScenarioFlowStructureIssue(graph)).toBeNull();
  });

  describe("a template's Form submitted route", () => {
    const formTemplate: ScenarioNodeData = {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateComponents: [
        {
          type: "BUTTONS",
          buttons: [
            { type: "FLOW", text: "Open form", flow_id: 1571793974235171 },
          ],
        },
      ],
    };
    const formRoute = {
      source: "send",
      target: "thanks",
      sourceHandle: ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
    };
    const thanks = node("thanks", { kind: "action", actionType: "reply" });

    it.each([false, true])(
      "blocks it on a bulk primary action (intermediate logic: %s)",
      intermediate => {
        const graph = compileScenarioGraph(
          [
            node("bulk", { kind: "bulk" }),
            ...(intermediate
              ? [node("logic", { kind: "logic", logicType: "audience_filter" })]
              : []),
            node("send", formTemplate),
            thanks,
          ],
          [
            ...(intermediate
              ? [
                  { source: "bulk", target: "logic" },
                  { source: "logic", target: "send" },
                ]
              : [{ source: "bulk", target: "send" }]),
            formRoute,
          ]
        );
        expect(getCompiledScenarioFlowStructureIssue(graph)).toEqual({
          errorKey: "whatsappTemplateFormRouteInBulk",
          relatedNodeIds: ["bulk", "send"],
        });
      }
    );

    it("allows it on a step after the bulk send", () => {
      const graph = compileScenarioGraph(
        [
          node("bulk", { kind: "bulk" }),
          node("primary", { kind: "action", actionType: "whatsapp_template" }),
          node("send", formTemplate),
          thanks,
        ],
        [
          { source: "bulk", target: "primary" },
          { source: "primary", target: "send" },
          formRoute,
        ]
      );
      expect(getCompiledScenarioFlowStructureIssue(graph)).toBeNull();
    });

    it("lists the templates it refuses the route on, for the builder", () => {
      const template: ScenarioNodeData = {
        kind: "action",
        actionType: "whatsapp_template",
      };
      expect(
        listBulkPrimaryWhatsAppTemplateIds({
          nodes: [
            node("bulk", { kind: "bulk" }),
            node("logic", { kind: "logic", logicType: "audience_filter" }),
            node("direct", formTemplate),
            node("behind-logic", formTemplate),
            node("after-send", template),
          ],
          edges: [
            { source: "bulk", target: "direct" },
            { source: "bulk", target: "logic" },
            { source: "logic", target: "behind-logic" },
            { source: "direct", target: "after-send" },
          ],
        })
      ).toEqual(new Set(["direct", "behind-logic"]));
      expect(
        listBulkPrimaryWhatsAppTemplateIds({
          nodes: [node("trigger", { kind: "trigger" }), node("send", template)],
          edges: [{ source: "trigger", target: "send" }],
        })
      ).toEqual(new Set());
    });
  });

  it("rejects Generative AI actions reachable from a bulk campaign root", () => {
    const graph = compileScenarioGraph(
      [
        node("bulk", {
          kind: "bulk",
          bulkRootConfig: {
            workflowKind: "bulk_campaign",
            sendMode: "immediate",
            channels: ["whatsapp"],
            campaignName: "Unsupported generation",
            recipientSourceSummary: "Uploaded recipients",
            generationStatus: "complete",
          },
        }),
        node("generate", {
          kind: "action",
          actionType: "generative_ai",
          actionGenerativeAIConfig: {
            version: 1,
            mode: "text_to_video",
            prompt: "Create one video per recipient",
          },
        }),
      ],
      [{ source: "bulk", target: "generate" }]
    );

    expect(getCompiledScenarioFlowStructureIssue(graph)).toEqual({
      errorKey: "generativeAIUnsupportedInBulk",
      relatedNodeIds: ["bulk", "generate"],
    });
  });

  it("returns ambiguousNextActionFork for a diamond from a logic node", () => {
    const nodes = [
      node("t", { kind: "trigger" }),
      node("c", { kind: "logic", logicType: "audience_filter" }),
      node("a1", { kind: "action", actionType: "reply" }),
      node("a2", { kind: "action", actionType: "reply" }),
    ];
    const edges = [
      { source: "t", target: "c" },
      { source: "c", target: "a1" },
      { source: "c", target: "a2" },
    ];
    const graph = compileScenarioGraph(nodes, edges);
    expect(validateCompiledScenarioFlowStructure(graph)).toBe(
      "ambiguousNextActionFork"
    );
  });

  it("allows bulk campaign roots to fan out to multiple actions", () => {
    const nodes = [
      node("bulk", {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp", "telegram"],
          campaignName: "Multi-source campaign",
          recipientSourceSummary: "2 selected sources",
          generationStatus: "complete",
        },
      }),
      node("whatsapp-action", {
        kind: "action",
        actionType: "whatsapp_template",
      }),
      node("telegram-action", {
        kind: "action",
        actionType: "reply",
        actionTelegramQuickReplies: [[{ text: "Start", payload: "start" }]],
      }),
    ];
    const edges = [
      { source: "bulk", target: "whatsapp-action" },
      { source: "bulk", target: "telegram-action" },
    ];
    const graph = compileScenarioGraph(nodes, edges);

    expect(validateCompiledScenarioFlowStructure(graph)).toBeNull();
  });

  it("allows multiple right-side bulk campaign actions", () => {
    const nodes = [
      node("bulk", {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          campaignName: "WhatsApp campaign",
          recipientSourceSummary: "Upload recipients",
          generationStatus: "idle",
        },
      }),
      node("first-action", {
        kind: "action",
        actionType: "whatsapp_template",
      }),
      node("second-action", {
        kind: "action",
        actionType: "whatsapp_template",
      }),
    ];
    const graph = compileScenarioGraph(nodes, [
      {
        source: "bulk",
        sourceHandle: "right-source",
        target: "first-action",
      },
      {
        source: "bulk",
        sourceHandle: "right-source",
        target: "second-action",
      },
    ]);

    expect(validateCompiledScenarioFlowStructure(graph)).toBeNull();
  });

  it("allows right-side bulk campaign links to logic nodes", () => {
    const nodes = [
      node("bulk", {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          campaignName: "WhatsApp campaign",
          recipientSourceSummary: "Upload recipients",
          generationStatus: "idle",
        },
      }),
      node("logic", {
        kind: "logic",
        logicType: "audience_filter",
      }),
    ];
    const graph = compileScenarioGraph(nodes, [
      {
        source: "bulk",
        sourceHandle: "right-source",
        target: "logic",
      },
    ]);

    expect(validateCompiledScenarioFlowStructure(graph)).toBeNull();
  });

  it("rejects chained canonical service Flows without wait logic", () => {
    const canonicalFlow = {
      version: 1 as const,
      message: {
        kind: "flow" as const,
        body: { mode: "fixed" as const, text: "Open" },
        flowConfig: {
          templateId: "lead-form",
          ctaText: "Open",
          screens: [],
        },
      },
    };
    const graph = compileScenarioGraph(
      [
        node("w1", {
          kind: "action",
          actionType: "reply",
          actionWhatsAppServiceMessage: canonicalFlow,
        }),
        node("w2", {
          kind: "action",
          actionType: "reply",
          actionWhatsAppServiceMessage: canonicalFlow,
        }),
      ],
      [{ source: "w1", target: "w2" }]
    );

    expect(validateCompiledScenarioFlowStructure(graph)).toBe(
      "stackedInteractiveActions"
    );
  });

  it("accepts a second form connected from the first form's reply route", () => {
    const firstForm: ScenarioNodeData = {
      ...canonicalFlowAction(),
      actionOutcomes: { version: 1, anyReply: { enabled: true } },
    };
    const graph = compileScenarioGraph(
      [node("form-a", firstForm), node("form-b", canonicalFlowAction())],
      [
        {
          source: "form-a",
          sourceHandle: buildScenarioActionOutcomeHandleId("any_reply"),
          target: "form-b",
        },
      ]
    );

    expect(validateCompiledScenarioFlowStructure(graph)).toBeNull();
  });

  it("exposes related node ids for ambiguous fork and stacked cases", () => {
    const ambiguousNodes = [
      node("t", { kind: "trigger" }),
      node("c", { kind: "logic", logicType: "audience_filter" }),
      node("a1", { kind: "action", actionType: "reply" }),
      node("a2", { kind: "action", actionType: "reply" }),
    ];
    const ambiguousEdges = [
      { source: "t", target: "c" },
      { source: "c", target: "a1" },
      { source: "c", target: "a2" },
    ];
    const ambiguousGraph = compileScenarioGraph(ambiguousNodes, ambiguousEdges);
    expect(getCompiledScenarioFlowStructureIssue(ambiguousGraph)).toEqual({
      errorKey: "ambiguousNextActionFork",
      relatedNodeIds: ["c", "a1", "a2"],
    });

    const stackedNodes = [
      node("t", { kind: "trigger" }),
      node("c", { kind: "logic", logicType: "audience_filter" }),
      node("w1", canonicalFlowAction()),
      node("w2", canonicalFlowAction()),
    ];
    const stackedEdges = [
      { source: "t", target: "c" },
      { source: "c", target: "w1" },
      { source: "w1", target: "w2" },
    ];
    const stackedGraph = compileScenarioGraph(stackedNodes, stackedEdges);
    expect(getCompiledScenarioFlowStructureIssue(stackedGraph)).toEqual({
      errorKey: "stackedInteractiveActions",
      relatedNodeIds: ["w1", "w2"],
    });
  });

  it("returns null for a valid linear flow with wait between interactives", () => {
    const nodes = [
      node("t", { kind: "trigger" }),
      node("c", { kind: "logic", logicType: "audience_filter" }),
      node("w1", canonicalFlowAction()),
      node("pac", {
        kind: "logic",
        logicType: "post_action_condition",
      }),
      node("w2", canonicalFlowAction()),
    ];
    const edges = [
      { source: "t", target: "c" },
      { source: "c", target: "w1" },
      { source: "w1", target: "pac" },
      { source: "pac", target: "w2" },
    ];
    const graph = compileScenarioGraph(nodes, edges);
    expect(validateCompiledScenarioFlowStructure(graph)).toBeNull();
  });

  it("allows post-action replied and no-reply branches to run separate actions", () => {
    const nodes = [
      node("source", { kind: "action", actionType: "reply" }),
      node("condition", {
        kind: "logic",
        logicType: "post_action_condition",
      }),
      node("reply-action", { kind: "action", actionType: "reply" }),
      node("timeout-action", { kind: "action", actionType: "reply" }),
    ];
    const edges = [
      { source: "source", target: "condition" },
      {
        source: "condition",
        target: "reply-action",
        sourceHandle: getPostActionConditionHandleId("user_replied"),
      },
      {
        source: "condition",
        target: "timeout-action",
        sourceHandle: getPostActionConditionHandleId("no_reply_timeout"),
      },
    ];
    const graph = compileScenarioGraph(nodes, edges);

    expect(validateCompiledScenarioFlowStructure(graph)).toBeNull();
  });

  it("still flags two runnable actions on the same post-action branch", () => {
    const nodes = [
      node("condition", {
        kind: "logic",
        logicType: "post_action_condition",
      }),
      node("timeout-a", { kind: "action", actionType: "reply" }),
      node("timeout-b", { kind: "action", actionType: "reply" }),
    ];
    const edges = [
      {
        source: "condition",
        target: "timeout-a",
        sourceHandle: getPostActionConditionHandleId("no_reply_timeout"),
      },
      {
        source: "condition",
        target: "timeout-b",
        sourceHandle: getPostActionConditionHandleId("no_reply_timeout"),
      },
    ];
    const graph = compileScenarioGraph(nodes, edges);

    expect(validateCompiledScenarioFlowStructure(graph)).toBe(
      "ambiguousNextActionFork"
    );
  });

  it("allows separate no-reply answer match branches to run separate actions", () => {
    const nodes = [
      node("condition", {
        kind: "logic",
        logicType: "post_action_condition",
        conditionBranches: [
          { id: "user_replied", type: "user_replied" },
          {
            id: "no_reply_timeout",
            type: "no_reply_timeout",
            answerMatchRules: [
              { id: "yes", mode: "exact", text: "yes" },
              { id: "pricing", mode: "intent", text: "asking price" },
            ],
          },
        ],
      }),
      node("yes-action", { kind: "action", actionType: "reply" }),
      node("pricing-action", { kind: "action", actionType: "reply" }),
    ];
    const graph = compileScenarioGraph(nodes, [
      {
        source: "condition",
        target: "yes-action",
        sourceHandle: getPostActionAnswerMatchHandleId("yes"),
      },
      {
        source: "condition",
        target: "pricing-action",
        sourceHandle: getPostActionAnswerMatchHandleId("pricing"),
      },
    ]);

    expect(validateCompiledScenarioFlowStructure(graph)).toBeNull();
  });

  it("allows separate recipient column split paths to run separate actions", () => {
    const nodes = [
      node("bulk", { kind: "bulk" }),
      node("split", {
        kind: "logic",
        logicType: "recipient_column_split",
        recipientColumnSplit: {
          version: 1,
          paths: [
            {
              id: "vip",
              label: "VIP",
              rules: [{ id: "r1", column: "tier", op: "equals", value: "vip" }],
            },
            {
              id: "standard",
              label: "Standard",
              rules: [
                { id: "r2", column: "tier", op: "equals", value: "standard" },
              ],
            },
          ],
        },
      }),
      node("vip-action", {
        kind: "action",
        actionType: "whatsapp_template",
      }),
      node("standard-action", {
        kind: "action",
        actionType: "whatsapp_template",
      }),
    ];
    const graph = compileScenarioGraph(nodes, [
      { source: "bulk", target: "split" },
      {
        source: "split",
        target: "vip-action",
        sourceHandle: buildRecipientColumnSplitPathHandleId("vip"),
      },
      {
        source: "split",
        target: "standard-action",
        sourceHandle: buildRecipientColumnSplitPathHandleId("standard"),
      },
    ]);

    expect(validateCompiledScenarioFlowStructure(graph)).toBeNull();
  });

  it("still flags two runnable actions on the same recipient column split branch", () => {
    const nodes = [
      node("split", {
        kind: "logic",
        logicType: "recipient_column_split",
        recipientColumnSplit: {
          version: 1,
          paths: [
            {
              id: "vip",
              label: "VIP",
              rules: [{ id: "r1", column: "tier", op: "equals", value: "vip" }],
            },
          ],
        },
      }),
      node("vip-a", { kind: "action", actionType: "whatsapp_template" }),
      node("vip-b", { kind: "action", actionType: "whatsapp_template" }),
    ];
    const graph = compileScenarioGraph(nodes, [
      {
        source: "split",
        target: "vip-a",
        sourceHandle: buildRecipientColumnSplitPathHandleId("vip"),
      },
      {
        source: "split",
        target: "vip-b",
        sourceHandle: buildRecipientColumnSplitPathHandleId("vip"),
      },
    ]);

    expect(validateCompiledScenarioFlowStructure(graph)).toBe(
      "ambiguousNextActionFork"
    );
  });
});

describe("validateScenarioFlowStructure", () => {
  it("treats compiled payment, reply and reminder outcomes as separate branches", () => {
    const nodes = [
      node("trigger", { kind: "trigger" }),
      node("offer", {
        kind: "action",
        actionType: "reply",
        actionOutcomes: {
          version: 1,
          anyReply: { enabled: true },
          noReply: { enabled: true, timeoutMinutes: 60 },
          paymentDetected: { enabled: true },
        },
      }),
      node("paid", { kind: "action", actionType: "reply" }),
      node("help", { kind: "action", actionType: "assign_human" }),
      node("reminder", { kind: "action", actionType: "reply" }),
    ];
    expect(
      validateScenarioFlowStructure({
        nodes,
        edges: [
          { source: "trigger", target: "offer" },
          {
            source: "offer",
            target: "paid",
            sourceHandle:
              buildScenarioActionOutcomeHandleId("payment_detected"),
          },
          {
            source: "offer",
            target: "help",
            sourceHandle: buildScenarioActionOutcomeHandleId("any_reply"),
          },
          {
            source: "offer",
            target: "reminder",
            sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
          },
        ],
      })
    ).toBeNull();
  });

  it("treats each location route as its own branch", () => {
    const locationRoute = (routeId: string) =>
      buildScenarioActionOutcomeHandleId({ type: "location_route", routeId });
    const nodes = [
      node("trigger", { kind: "trigger" }),
      node("ask", {
        kind: "action",
        actionType: "reply",
        actionOutcomes: {
          version: 2,
          noReply: { enabled: true, timeoutMinutes: 60 },
          locationRoutes: {
            routes: [
              { id: "kz", match: { by: "country", values: ["KZ"] } },
              { id: "uz", match: { by: "country", values: ["UZ"] } },
            ],
            outside: { maxDistanceKm: 100 },
          },
        },
      }),
      node("kz-office", { kind: "action", actionType: "reply" }),
      node("uz-office", { kind: "action", actionType: "reply" }),
      node("any-office", { kind: "action", actionType: "reply" }),
      node("far-away", { kind: "action", actionType: "reply" }),
      node("reminder", { kind: "action", actionType: "reply" }),
    ];
    expect(
      validateScenarioFlowStructure({
        nodes,
        edges: [
          { source: "trigger", target: "ask" },
          {
            source: "ask",
            target: "kz-office",
            sourceHandle: locationRoute("kz"),
          },
          {
            source: "ask",
            target: "uz-office",
            sourceHandle: locationRoute("uz"),
          },
          {
            source: "ask",
            target: "any-office",
            sourceHandle: buildScenarioActionOutcomeHandleId(
              "location_any_office"
            ),
          },
          {
            source: "ask",
            target: "far-away",
            sourceHandle:
              buildScenarioActionOutcomeHandleId("location_outside"),
          },
          {
            source: "ask",
            target: "reminder",
            sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
          },
        ],
      })
    ).toBeNull();
  });

  it("still rejects two actions on the same location route", () => {
    const graph = compileScenarioGraph(
      [
        node("wait", { kind: "logic", logicType: "post_action_condition" }),
        node("kz-a", { kind: "action", actionType: "reply" }),
        node("kz-b", { kind: "action", actionType: "reply" }),
      ],
      [
        {
          source: "wait",
          target: "kz-a",
          sourceHandle: buildPostActionLocationRouteHandleId("kz"),
        },
        {
          source: "wait",
          target: "kz-b",
          sourceHandle: buildPostActionLocationRouteHandleId("kz"),
        },
      ]
    );
    expect(validateCompiledScenarioFlowStructure(graph)).toBe(
      "ambiguousNextActionFork"
    );
  });

  it("still rejects two actions on the same payment branch", () => {
    const graph = compileScenarioGraph(
      [
        node("wait", { kind: "logic", logicType: "post_action_condition" }),
        node("paid-a", { kind: "action", actionType: "reply" }),
        node("paid-b", { kind: "action", actionType: "reply" }),
      ],
      [
        {
          source: "wait",
          target: "paid-a",
          sourceHandle: getPostActionConditionHandleId("payment_detected"),
        },
        {
          source: "wait",
          target: "paid-b",
          sourceHandle: getPostActionConditionHandleId("payment_detected"),
        },
      ]
    );
    expect(validateCompiledScenarioFlowStructure(graph)).toBe(
      "ambiguousNextActionFork"
    );
  });

  it("allows chained Telegram keyboard actions without a post-action wait node", () => {
    const nodes = [
      node("t", { kind: "trigger" }),
      node("c", { kind: "logic", logicType: "audience_filter" }),
      node("tg1", {
        kind: "action",
        actionType: "reply",
        actionTelegramQuickReplies: [[{ text: "A", payload: "a" }]],
      }),
      node("tg2", {
        kind: "action",
        actionType: "reply",
        actionTelegramQuickReplies: [[{ text: "B", payload: "b" }]],
      }),
    ];
    const edges = [
      { source: "t", target: "c" },
      { source: "c", target: "tg1" },
      { source: "tg1", target: "tg2" },
    ];
    expect(
      validateScenarioFlowStructure({
        nodes,
        edges,
      })
    ).toBeNull();
  });
});
