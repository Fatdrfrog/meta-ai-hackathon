import type {
  ScenarioCampaignRecipient,
  ScenarioFlowEdge,
  ScenarioFlowNode,
  ScenarioNodeData,
} from "../../types";
import {
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID,
  buildFlowBranchSourceHandleId,
  buildWhatsAppSessionChoiceSourceHandleId,
} from "@icecore/scenario-contracts";
import { buildScenarioNodeGraphIndex } from "./scenario-node-graph-index";

function createNode(id: string, data: ScenarioNodeData): ScenarioFlowNode {
  return {
    id,
    position: { x: 0, y: 0 },
    data,
  };
}

function createEdge(
  id: string,
  source: string,
  target: string,
  sourceHandle?: string
): ScenarioFlowEdge {
  return {
    id,
    source,
    target,
    sourceHandle,
    targetHandle: "left-target",
  };
}

describe("buildScenarioNodeGraphIndex", () => {
  it("collects insertable prompt answers from text service messages", () => {
    const index = buildScenarioNodeGraphIndex({
      nodes: [
        createNode("ask", {
          kind: "action",
          actionType: "reply",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "text",
              body: { mode: "fixed", text: "Hello" },
              previewUrl: true,
            },
            promptInputs: [
              { key: "name", label: "Name", prompt: "Your name?" },
              { key: "Name", label: "Bad", prompt: "" },
            ],
          },
        }),
      ],
      edges: [],
    });
    expect(index.scenarioPromptInputs.map(field => field.key)).toEqual([
      "name",
    ]);
  });

  it("offers flow text fields only on nodes connected to that flow", () => {
    const flow = createNode("flow", {
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "flow",
          body: { mode: "fixed", text: "Your details" },
          flowConfig: {
            templateId: "details",
            ctaText: "Open",
            screens: [
              {
                id: "FORM",
                title: "Details",
                fields: [
                  { id: "name", label: "Name", fieldType: "TextInput" },
                  { id: "sport", label: "Sport", fieldType: "TextArea" },
                  {
                    id: "plan",
                    label: "Plan",
                    fieldType: "RadioButtonsGroup",
                    options: [{ id: "pro", title: "Pro" }],
                  },
                ],
              },
            ],
          },
        },
      },
    });
    const generate = createNode("generate", {
      kind: "action",
      actionType: "generative_ai",
    });
    const other = createNode("other", {
      kind: "action",
      actionType: "generative_ai",
    });
    const index = buildScenarioNodeGraphIndex({
      nodes: [flow, generate, other],
      edges: [createEdge("to-generate", "flow", "generate")],
    });

    expect(
      index.scenarioPromptInputsByNodeId
        .get("generate")
        ?.map(field => [field.key, field.fromForm])
    ).toEqual([
      ["name", true],
      ["sport", true],
    ]);
    expect(
      index.scenarioPromptInputsByNodeId.get("other")?.map(field => field.key)
    ).toEqual([]);
    expect(index.scenarioPromptInputs).toEqual([]);
  });

  it("uses canonical destination handles for legacy aggregate choices and omitted default handles", () => {
    const source = createNode("source", {
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "whatsapp",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Choose" },
          options: [{ id: "yes", label: "Yes" }],
        },
      },
    });
    const plain = createNode("plain", { kind: "action", actionType: "reply" });
    const target = createNode("target", {
      kind: "action",
      actionType: "reply",
      whatsAppSessionChoicePayload: "yes",
    });
    const index = buildScenarioNodeGraphIndex({
      nodes: [source, plain, target],
      edges: [
        createEdge(
          "choice",
          "source",
          "target",
          ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID
        ),
        createEdge("default", "plain", "target"),
      ],
    });
    expect(
      index.destinationsBySourceHandleByNodeId
        .get("source")
        ?.get(buildWhatsAppSessionChoiceSourceHandleId("yes"))?.nodeId
    ).toBe("target");
    expect(
      index.destinationsBySourceHandleByNodeId.get("plain")?.get("right-source")
        ?.nodeId
    ).toBe("target");
  });
  it("marks a route into a post-action condition, the step's follow-up wait", () => {
    const index = buildScenarioNodeGraphIndex({
      nodes: [
        createNode("template", {
          kind: "action",
          actionType: "whatsapp_template",
        }),
        createNode("quiet", {
          kind: "logic",
          logicType: "post_action_condition",
        }),
        createNode("next", { kind: "action", actionType: "reply" }),
      ],
      edges: [
        createEdge("wait", "template", "quiet"),
        createEdge("after", "quiet", "next", "right-source-condition-no_reply"),
      ],
    });
    expect(
      index.destinationsBySourceHandleByNodeId
        .get("template")
        ?.get("right-source")?.postActionCondition
    ).toBe(true);
    expect(
      index.destinationsBySourceHandleByNodeId
        .get("quiet")
        ?.get("right-source-condition-no_reply")
    ).not.toHaveProperty("postActionCondition");
  });
  it("projects source handles to destination labels without duplicating shared targets", () => {
    const index = buildScenarioNodeGraphIndex({
      nodes: [
        createNode("source", { kind: "action", actionType: "reply" }),
        createNode("shared", {
          kind: "action",
          actionType: "reply",
          actionReplyText: "Choose a size",
        }),
      ],
      edges: [
        createEdge("a", "source", "shared", "choice-a"),
        createEdge("b", "source", "shared", "choice-b"),
      ],
    });
    expect(
      index.destinationsBySourceHandleByNodeId.get("source")?.get("choice-a")
    ).toEqual({ nodeId: "shared", label: "Choose a size" });
    expect(
      index.destinationsBySourceHandleByNodeId.get("source")?.get("choice-b")
        ?.nodeId
    ).toBe("shared");
  });
  it("marks steps an action's No reply reaches after a day or more", () => {
    const waiting = (timeoutMinutes: number): ScenarioNodeData => ({
      kind: "action",
      actionType: "reply",
      actionReplyText: "Still there?",
      actionOutcomes: {
        version: 1,
        noReply: { enabled: true, timeoutMinutes },
      },
    });
    const index = buildScenarioNodeGraphIndex({
      nodes: [
        createNode("day", waiting(1440)),
        createNode("hour", waiting(60)),
        createNode("after-day", { kind: "action", actionType: "reply" }),
        createNode("after-hour", { kind: "action", actionType: "reply" }),
        createNode("after-default", { kind: "action", actionType: "reply" }),
      ],
      edges: [
        createEdge(
          "long",
          "day",
          "after-day",
          ACTION_NO_REPLY_OUTCOME_HANDLE_ID
        ),
        createEdge(
          "short",
          "hour",
          "after-hour",
          ACTION_NO_REPLY_OUTCOME_HANDLE_ID
        ),
        createEdge("default", "day", "after-default", "right-source"),
      ],
    });

    expect([...index.reachedAfterLongNoReplyNodeIds]).toEqual(["after-day"]);
  });

  it("names destinations without empty-state copy or variables", () => {
    const t = (key: string) => key;
    const index = buildScenarioNodeGraphIndex({
      nodes: [
        createNode("source", { kind: "action", actionType: "reply" }),
        createNode("empty", {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "fixed",
        }),
        createNode("handoff", { kind: "action", actionType: "assign_human" }),
        createNode("greeting", {
          kind: "action",
          actionType: "reply",
          actionReplyText: "Hi {{first_name}}, welcome",
        }),
      ],
      edges: [
        createEdge("a", "source", "empty", "a"),
        createEdge("b", "source", "handoff", "b"),
        createEdge("c", "source", "greeting", "c"),
      ],
      translate: t,
    });
    const labels = index.destinationsBySourceHandleByNodeId.get("source");
    expect(labels?.get("a")?.label).toBe("presetActionReply");
    expect(labels?.get("b")?.label).toBe("presetActionAssignHuman");
    expect(labels?.get("c")?.label).toBe("Hi …, welcome");
  });

  it("indexes every Flow branch source handle without target metadata", () => {
    const nodes = [
      createNode("flow-action", {
        kind: "action",
        actionType: "reply",
      }),
      createNode("yes-target", {
        kind: "action",
        actionType: "reply",
      }),
      createNode("no-target", {
        kind: "action",
        actionType: "reply",
      }),
    ];
    const edges = [
      createEdge(
        "yes",
        "flow-action",
        "yes-target",
        buildFlowBranchSourceHandleId("field-1", "yes")
      ),
      createEdge(
        "no",
        "flow-action",
        "no-target",
        buildFlowBranchSourceHandleId("field-1", "no")
      ),
    ];

    const index = buildScenarioNodeGraphIndex({ nodes, edges });

    expect(index.connectedFlowBranchIdsByActionId.get("flow-action")).toEqual([
      '["field-1","yes"]',
      '["field-1","no"]',
    ]);
  });

  it("deduplicates connected action outcomes and interactive branch payloads", () => {
    const nodes = [
      createNode("action-1", {
        kind: "action",
        actionType: "reply",
      }),
      createNode("telegram-1", {
        kind: "action",
        telegramBranchPayload: "telegram-choice",
      }),
      createNode("telegram-2", {
        kind: "action",
        telegramBranchPayload: "telegram-choice",
      }),
      createNode("instagram-1", {
        kind: "action",
        instagramBranchPayload: "instagram-choice",
      }),
      createNode("whatsapp-1", {
        kind: "action",
        whatsAppSessionChoicePayload: "whatsapp-choice",
      }),
      createNode("flow-1", {
        kind: "action",
        flowBranchSourceFieldId: "field-1",
        flowBranchOptionId: "option-a",
      }),
      createNode("template-button-1", {
        kind: "action",
        whatsAppTemplateButtonPayload: "buy-now",
      }),
    ];
    const edges = [
      createEdge(
        "outcome-1",
        "action-1",
        "telegram-1",
        "right-source-action-outcome::any-reply"
      ),
      createEdge(
        "outcome-duplicate",
        "action-1",
        "telegram-2",
        "right-source-action-outcome::any-reply"
      ),
      createEdge(
        "generative-success",
        "action-1",
        "instagram-1",
        "right-source-generative-ai::success"
      ),
      createEdge(
        "interactive-no-reply",
        "action-1",
        "whatsapp-1",
        "right-source-interactive-no-reply"
      ),
      createEdge(
        "telegram-handle",
        "action-1",
        "telegram-1",
        "right-source-telegram-branch::telegram-choice"
      ),
      createEdge("telegram-data", "action-1", "telegram-2"),
      createEdge("instagram-data", "action-1", "instagram-1"),
      createEdge(
        "whatsapp-handle",
        "action-1",
        "whatsapp-1",
        "right-source-whatsapp-session-choice-branch::whatsapp-choice"
      ),
      createEdge("flow-data", "action-1", "flow-1"),
      createEdge("template-button-data", "action-1", "template-button-1"),
    ];

    const index = buildScenarioNodeGraphIndex({ nodes, edges });

    expect(index.connectedSourceHandleIdsByNodeId.get("action-1")).toEqual([
      "right-source-action-outcome::any-reply",
      "right-source-generative-ai::success",
      "right-source-interactive-no-reply",
      "right-source-telegram-branch::telegram-choice",
      "right-source-whatsapp-session-choice-branch::whatsapp-choice",
    ]);
    expect(
      index.connectedTelegramBranchPayloadsByActionId.get("action-1")
    ).toEqual(["telegram-choice"]);
    expect(
      index.connectedInstagramBranchPayloadsByActionId.get("action-1")
    ).toEqual(["instagram-choice"]);
    expect(
      index.connectedWhatsAppSessionChoicePayloadsByActionId.get("action-1")
    ).toEqual(["whatsapp-choice"]);
    expect(index.connectedFlowBranchIdsByActionId.get("action-1")).toEqual([
      '["field-1","option-a"]',
    ]);
    expect(
      index.connectedWhatsAppTemplateButtonPayloadsByActionId.get("action-1")
    ).toEqual(["buy-now"]);
  });

  it("indexes direct bulk actions without treating the legacy top handle as primary", () => {
    const uploadedRecipients = [
      {
        phone: "+10000000001",
        fields: { tier: "gold" },
      },
    ];
    const nodes = [
      createNode("bulk-1", {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          campaignName: "VIP",
          recipientSourceSummary: "Manual upload",
          generationStatus: "idle",
          uploadedRecipients,
        },
      }),
      createNode("template-1", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "vip_offer",
        actionWhatsAppTemplateLanguage: "en",
      }),
      createNode("template-legacy", {
        kind: "action",
        actionType: "whatsapp_template",
      }),
    ];
    const edges = [
      createEdge("primary", "bulk-1", "template-1", "right-source"),
      createEdge(
        "legacy",
        "bulk-1",
        "template-legacy",
        "top-source-bulk-action"
      ),
    ];

    const index = buildScenarioNodeGraphIndex({ nodes, edges });

    expect(index.bulkActionByRootId.get("bulk-1")).toMatchObject({
      nodeId: "template-1",
      actionType: "whatsapp_template",
      templateName: "vip_offer",
    });
    expect(Array.from(index.bulkPrimaryActionIds)).toEqual(["template-1"]);
    expect(index.bulkRouteRecipientsByActionId.get("template-1")).toEqual(
      uploadedRecipients
    );
    expect(index.actionNodeCount).toBe(2);
  });

  it("indexes a bulk column split and each connected recipient path", () => {
    const nodes = [
      createNode("bulk-1", { kind: "bulk" }),
      createNode("split-1", {
        kind: "logic",
        logicType: "recipient_column_split",
      }),
      createNode("template-gold", {
        kind: "action",
        actionType: "whatsapp_template",
      }),
      createNode("template-else", {
        kind: "action",
        actionType: "whatsapp_template",
      }),
    ];
    const edges = [
      createEdge("bulk-split", "bulk-1", "split-1", "right-source"),
      createEdge(
        "gold",
        "split-1",
        "template-gold",
        "right-source-column-split-gold"
      ),
      createEdge(
        "else",
        "split-1",
        "template-else",
        "right-source-column-split-else"
      ),
    ];

    const index = buildScenarioNodeGraphIndex({ nodes, edges });

    expect(index.bulkColumnSplitNodeByRootId.get("bulk-1")).toBe("split-1");
    expect(index.bulkActionByRootId.has("bulk-1")).toBe(false);
    expect(
      Array.from(
        index.connectedColumnSplitHandlesBySplitNodeId.get("split-1") ?? []
      )
    ).toEqual([
      "right-source-column-split-gold",
      "right-source-column-split-else",
    ]);
    expect(Array.from(index.bulkPrimaryActionIds)).toEqual([
      "template-gold",
      "template-else",
    ]);
  });

  it("indexes a connected fixed Telegram birthday reply as the primary bulk action", () => {
    const uploadedRecipients = [
      { chatId: "1280", birthday: "01-01", fields: { name: "Airi" } },
    ];
    const index = buildScenarioNodeGraphIndex({
      nodes: [
        createNode("bulk-1", {
          kind: "bulk",
          bulkRootConfig: {
            workflowKind: "bulk_campaign",
            sendMode: "immediate",
            channels: ["telegram"],
            campaignName: "Birthday",
            recipientSourceSummary: "Manual upload",
            generationStatus: "idle",
            recipientAudienceSource: "customer_birthdays",
            telegramSubscriberSourceId: "qa-bot1",
            uploadedRecipients,
          },
        }),
        createNode("action-1", {
          kind: "action",
          actionType: "reply",
          actionReplyChannel: "telegram",
          actionReplyMode: "fixed",
          actionReplyText: "Happy birthday {{name}}",
        }),
      ],
      edges: [createEdge("qa-edge", "bulk-1", "action-1", "right-source")],
    });
    expect(index.bulkActionByRootId.get("bulk-1")).toMatchObject({
      nodeId: "action-1",
      actionType: "reply",
      channel: "telegram",
      replyMode: "fixed",
      replyText: "Happy birthday {{name}}",
    });
    expect(Array.from(index.bulkPrimaryActionIds)).toEqual(["action-1"]);
    expect(index.bulkRouteRecipientsByActionId.get("action-1")).toEqual(
      uploadedRecipients
    );
    expect(Object.isFrozen(index.bulkActionByRootId.get("bulk-1"))).toBe(true);
  });

  it.each([
    ["AI Telegram reply", "telegram", "ai", "right-source"],
    ["WhatsApp service reply", "whatsapp", "fixed", "right-source"],
    ["Instagram reply", "instagram", "fixed", "right-source"],
    ["legacy top handle", "telegram", "fixed", "top-source-bulk-action"],
  ] as const)(
    "does not promote a %s to primary bulk action",
    (_label, channel, mode, handle) => {
      const index = buildScenarioNodeGraphIndex({
        nodes: [
          createNode("bulk-1", {
            kind: "bulk",
            bulkRootConfig: {
              workflowKind: "bulk_campaign",
              sendMode: "immediate",
              channels: ["telegram"],
              campaignName: "Birthday",
              recipientSourceSummary: "Manual upload",
              generationStatus: "idle",
            },
          }),
          createNode("action-1", {
            kind: "action",
            actionType: "reply",
            actionReplyChannel: channel,
            actionReplyMode: mode,
            actionReplyText: "Happy birthday {{name}}",
          }),
        ],
        edges: [createEdge("qa-edge", "bulk-1", "action-1", handle)],
      });
      expect(index.bulkActionByRootId.has("bulk-1")).toBe(false);
      expect(index.bulkPrimaryActionIds.has("action-1")).toBe(false);
      expect(index.bulkRouteRecipientsByActionId.has("action-1")).toBe(false);
    }
  );

  it.each([
    [
      {
        kind: "logic",
        logicType: "post_action_condition",
        interactiveNoReplySurface: "whatsapp_flow",
      } satisfies ScenarioNodeData,
      null,
      { scope: "flow_branch", branchLabel: null },
    ],
    [
      {
        kind: "logic",
        logicType: "post_action_condition",
      } satisfies ScenarioNodeData,
      {
        kind: "action",
        telegramBranchLabel: "Approve",
      } satisfies ScenarioNodeData,
      { scope: "telegram_branch", branchLabel: "Approve" },
    ],
    [
      {
        kind: "logic",
        logicType: "post_action_condition",
      } satisfies ScenarioNodeData,
      null,
      { scope: "default", branchLabel: null },
    ],
  ] as const)(
    "resolves post-action condition scope from its surface or incoming branch",
    (conditionData, incomingActionData, expected) => {
      const nodes = [
        ...(incomingActionData
          ? [createNode("incoming-action", incomingActionData)]
          : []),
        createNode("condition-1", conditionData),
      ];
      const edges = incomingActionData
        ? [createEdge("incoming", "incoming-action", "condition-1")]
        : [];

      const index = buildScenarioNodeGraphIndex({ nodes, edges });

      expect(index.postActionConditionScopeByNodeId.get("condition-1")).toEqual(
        expected
      );
    }
  );

  it("precomputes each action preview profile from its nearest ancestors", () => {
    const nodes = [
      createNode("trigger-whatsapp", {
        kind: "trigger",
        triggerConfig: { channelFilter: ["whatsapp"] },
      }),
      createNode("audience-vip", {
        kind: "logic",
        logicType: "audience_filter",
        audienceMode: "classification",
        classificationCategory: "VIP",
      }),
      createNode("bridge", { kind: "context" }),
      createNode("trigger-telegram", {
        kind: "trigger",
        triggerConfig: { channelFilter: ["telegram"] },
      }),
      createNode("audience-standard", {
        kind: "logic",
        logicType: "audience_filter",
        audienceMode: "classification",
        classificationCategory: "Standard",
      }),
      createNode("action-1", {
        kind: "action",
        actionType: "reply",
      }),
    ];
    const edges = [
      createEdge("wa-vip", "trigger-whatsapp", "audience-vip"),
      createEdge("vip-bridge", "audience-vip", "bridge"),
      createEdge("bridge-action", "bridge", "action-1"),
      createEdge("telegram-action", "trigger-telegram", "action-1"),
      createEdge("standard-action", "audience-standard", "action-1"),
      createEdge("cycle-safe", "action-1", "trigger-whatsapp"),
    ];

    const index = buildScenarioNodeGraphIndex({
      nodes,
      edges,
      audienceOptions: {
        channels: ["whatsapp"],
        classificationCategories: ["VIP", "Standard"],
        funnelStages: [],
        internalLabels: [],
        customers: [
          {
            id: "vip-wa",
            label: "WhatsApp VIP",
            channel: "whatsapp",
            category: "VIP",
          },
          {
            id: "standard-telegram",
            label: "Telegram Standard",
            channel: "telegram",
            category: "Standard",
          },
        ],
        metaReferralAds: [],
        metaReferralCampaigns: [],
        metaReferralAdSets: [],
        metaCampaignLabels: [],
      },
    });

    expect(index.previewProfileByActionId.get("action-1")).toMatchObject({
      channel: "telegram",
      customerId: "standard-telegram",
      customerName: "Telegram Standard",
    });
    expect(
      Object.isFrozen(index.previewProfileByActionId.get("action-1"))
    ).toBe(true);
  });

  it("does not mutate frozen graph inputs", () => {
    const data = Object.freeze<ScenarioNodeData>({
      kind: "action",
      actionType: "reply",
      actionReplyMode: "fixed",
    });
    const node = Object.freeze({
      ...createNode("action-1", data),
      position: Object.freeze({ x: 0, y: 0 }),
    }) as ScenarioFlowNode;
    const edge = Object.freeze(
      createEdge(
        "self-outcome",
        "action-1",
        "action-1",
        "right-source-action-outcome::any-reply"
      )
    ) as ScenarioFlowEdge;
    const nodes = Object.freeze([node]);
    const edges = Object.freeze([edge]);

    const index = buildScenarioNodeGraphIndex({ nodes, edges });

    expect(index.actionNodeCount).toBe(1);
    expect(node.data).toBe(data);
    expect(nodes).toEqual([node]);
    expect(edges).toEqual([edge]);
  });

  it("copies each uploaded recipient once across index builds", () => {
    const recipient = { phone: "+10000000001", fields: { tier: "gold" } };
    const bulkNode = createNode("bulk-1", {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "VIP",
        recipientSourceSummary: "Manual upload",
        generationStatus: "idle",
        uploadedRecipients: [recipient],
      },
    });
    const build = (actionData: ScenarioNodeData) =>
      buildScenarioNodeGraphIndex({
        nodes: [bulkNode, createNode("action-1", actionData)],
        edges: [createEdge("primary", "bulk-1", "action-1", "right-source")],
      });
    const templateAction: ScenarioNodeData = {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "vip_offer",
    };

    const first = build(templateAction);
    // An edit to another step rebuilds the index.
    const second = build({ ...templateAction, actionInstruction: "Edited" });
    const firstCopy = first.bulkRouteRecipientsByActionId.get("action-1")?.[0];

    expect(firstCopy).not.toBe(recipient);
    expect(Object.isFrozen(firstCopy)).toBe(true);
    expect(Object.isFrozen(firstCopy?.fields)).toBe(true);
    expect(second.bulkRouteRecipientsByActionId.get("action-1")?.[0]).toBe(
      firstCopy
    );
  });

  it("returns immutable snapshots detached from graph input objects", () => {
    const recipient = {
      phone: "+10000000001",
      fields: { tier: "gold" },
    };
    const actionData: ScenarioNodeData = {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "vip_offer",
      actionWhatsAppTemplateLanguage: "en",
      actionCampaignVariableConfigs: {
        "1": { mode: "custom", customValue: "Airi" },
      },
    };
    const index = buildScenarioNodeGraphIndex({
      nodes: [
        createNode("bulk-1", {
          kind: "bulk",
          bulkRootConfig: {
            workflowKind: "bulk_campaign",
            sendMode: "immediate",
            channels: ["whatsapp"],
            campaignName: "VIP",
            recipientSourceSummary: "Manual upload",
            generationStatus: "idle",
            uploadedRecipients: [recipient],
          },
        }),
        createNode("action-1", actionData),
      ],
      edges: [createEdge("primary", "bulk-1", "action-1", "right-source")],
    });

    actionData.actionWhatsAppTemplateName = "mutated_template";
    recipient.fields.tier = "silver";

    expect(index.bulkActionByRootId.get("bulk-1")?.templateName).toBe(
      "vip_offer"
    );
    expect(
      index.bulkRouteRecipientsByActionId.get("action-1")?.[0]?.fields?.tier
    ).toBe("gold");
    expect(() =>
      (
        index.bulkActionByRootId as Map<
          string,
          NonNullable<ReturnType<typeof index.bulkActionByRootId.get>>
        >
      ).set("other", index.bulkActionByRootId.get("bulk-1")!)
    ).toThrow("read-only");
    expect(() =>
      (index.bulkPrimaryActionIds as Set<string>).add("other")
    ).toThrow("read-only");
    expect(Object.isFrozen(index)).toBe(true);
    expect(() => {
      (index as { actionNodeCount: number }).actionNodeCount = 99;
    }).toThrow();
    expect(() =>
      (
        index.bulkRouteRecipientsByActionId.get(
          "action-1"
        ) as ScenarioCampaignRecipient[]
      ).push({ phone: "+10000000002" })
    ).toThrow();
  });
});

type TestFlowField = {
  id: string;
  label: string;
  fieldType: "TextInput" | "TextArea" | "Dropdown";
  required?: boolean;
};

function createForm(
  id: string,
  options: {
    name?: string;
    fields?: TestFlowField[];
    sender?: "service_message" | "template";
    linkedFlowName?: string;
  } = {}
): ScenarioFlowNode {
  const flowConfig = {
    templateId: id,
    ctaText: "Open",
    metaFlowName: options.name ?? null,
    answersKey: id,
    screens: [
      {
        id: "DETAILS",
        title: "Details",
        fields: options.fields ?? [
          { id: "size", label: "Size", fieldType: "TextInput", required: true },
        ],
      },
    ],
    ...(options.linkedFlowName
      ? {
          providerReference: {
            flowId: "flow-1",
            sourceId: "source-1",
            wabaId: "waba-1",
            flowName: options.linkedFlowName,
            providerStatus: "PUBLISHED" as const,
          },
        }
      : {}),
  };
  return createNode(
    id,
    options.sender === "template"
      ? {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: `${id}_template`,
          actionFlowConfig: flowConfig,
        }
      : {
          kind: "action",
          actionType: "reply",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "flow",
              body: { mode: "fixed", text: "Fill in" },
              flowConfig,
            },
          },
        }
  );
}

function createAsk(id: string, keys: string[]): ScenarioFlowNode {
  return createNode(id, {
    kind: "action",
    actionType: "reply",
    actionWhatsAppServiceMessage: {
      version: 1,
      message: {
        kind: "text",
        body: { mode: "fixed", text: "Tell us more" },
        previewUrl: false,
      },
      promptInputs: keys.map(key => ({
        key,
        label: `Asked ${key}`,
        prompt: `Your ${key}?`,
      })),
    },
  });
}

const trigger = createNode("trigger", { kind: "trigger" });
const aiStep = createNode("ai", {
  kind: "action",
  actionType: "reply",
  actionReplyMode: "ai",
});

describe("buildScenarioNodeGraphIndex form answers", () => {
  it("compounds earlier forms, each named as its step is on the canvas", () => {
    const index = buildScenarioNodeGraphIndex({
      nodes: [
        trigger,
        createForm("contact", { name: "Contact details" }),
        createForm("order", {
          name: "Order details",
          fields: [
            {
              id: "size",
              label: "Size",
              fieldType: "Dropdown",
              required: true,
            },
            { id: "note", label: "Note", fieldType: "TextArea" },
          ],
        }),
        aiStep,
      ],
      edges: [
        createEdge("e1", "trigger", "contact"),
        createEdge("e2", "contact", "order", "right-source"),
        createEdge("e3", "order", "ai", "right-source"),
      ],
    });

    const sources = index.scenarioFormAnswerSourcesByNodeId.get("ai") ?? [];
    expect(
      sources.map(source => [
        source.formKey,
        source.label,
        source.availability,
        source.schema,
      ])
    ).toEqual([
      ["contact", "Contact details", "always", "known"],
      ["order", "Order details", "always", "known"],
    ]);
    expect(
      sources[1]?.fields.map(field => [field.key, field.mayBeEmpty])
    ).toEqual([
      ["size", false],
      ["note", true],
    ]);
    expect(
      index.scenarioFormAnswerSourcesByNodeId
        .get("order")
        ?.map(source => source.formKey)
    ).toEqual(["contact"]);
    expect(index.scenarioFormAnswerSourcesByNodeId.get("contact")).toEqual([]);
  });

  it("offers a template form as may be empty and a linked form without fields", () => {
    const index = buildScenarioNodeGraphIndex({
      nodes: [
        trigger,
        createForm("order", { sender: "template" }),
        createForm("medal", {
          name: "Medal pick",
          fields: [],
          linkedFlowName: "medal_pick_1",
        }),
        aiStep,
      ],
      edges: [
        createEdge("e1", "trigger", "order"),
        createEdge("e2", "order", "medal", "right-source"),
        createEdge("e3", "medal", "ai", "right-source"),
      ],
    });

    const sources = index.scenarioFormAnswerSourcesByNodeId.get("ai") ?? [];
    expect(
      sources.map(source => [
        source.label,
        source.availability,
        source.schema,
        source.fields.map(field => [field.key, field.mayBeEmpty]),
      ])
    ).toEqual([
      ["order_template", "some_paths", "known", [["size", true]]],
      ["Medal pick", "always", "unknown", []],
    ]);
  });

  it("marks a form's text fields read as input answers, never an ask's", () => {
    const index = buildScenarioNodeGraphIndex({
      nodes: [
        trigger,
        createAsk("ask", ["name"]),
        createForm("details", {
          fields: [
            { id: "name", label: "Name", fieldType: "TextInput" },
            { id: "sport", label: "Sport", fieldType: "TextInput" },
          ],
        }),
        aiStep,
        createForm("alone", {
          fields: [{ id: "name", label: "Name", fieldType: "TextInput" }],
        }),
        createNode("after-alone", { kind: "action", actionType: "reply" }),
      ],
      edges: [
        createEdge("e1", "trigger", "ask"),
        createEdge("e2", "ask", "details"),
        createEdge("e3", "details", "ai", "right-source"),
        createEdge("e4", "alone", "after-alone", "right-source"),
      ],
    });

    const read = (nodeId: string) =>
      index.scenarioPromptInputsByNodeId
        .get(nodeId)
        ?.map(field => [field.key, field.label, field.fromForm ?? false]);
    expect(read("ai")).toEqual([
      ["name", "Asked name", false],
      ["sport", "Sport", true],
    ]);
    // An ask elsewhere with the same key doesn't reach this step.
    expect(read("after-alone")).toEqual([["name", "Name", true]]);
    expect(read("details")).toEqual([["name", "Asked name", false]]);
  });

  it("leaves answers unmarked when the scenario sends no form", () => {
    const index = buildScenarioNodeGraphIndex({
      nodes: [trigger, createAsk("ask", ["name"]), aiStep],
      edges: [
        createEdge("e1", "trigger", "ask"),
        createEdge("e2", "ask", "ai"),
      ],
    });

    expect(index.scenarioPromptInputsByNodeId.get("ai")).toEqual([
      { key: "name", label: "Asked name", prompt: "Your name?" },
    ]);
    expect(index.scenarioFormAnswerSourcesByNodeId.get("ai")).toEqual([]);
  });

  it("keeps every form's key by step as the runtime reads it, empty forms too", () => {
    const index = buildScenarioNodeGraphIndex({
      nodes: [
        trigger,
        createForm("contact"),
        createForm("empty", { fields: [] }),
        createForm("linked", { fields: [], linkedFlowName: "Survey" }),
        aiStep,
      ],
      edges: [createEdge("e1", "trigger", "contact")],
    });

    expect(Object.fromEntries(index.scenarioFormKeysByNodeId)).toEqual({
      contact: "contact",
      empty: "empty",
      linked: "linked",
    });
    // Every form stores its key, so none needs storing.
    expect(index.scenarioFormKeyStampsByFormKey.size).toBe(0);
    expect(() =>
      (index.scenarioFormKeysByNodeId as Map<string, string>).set("x", "y")
    ).toThrow("read-only");
  });

  it("stores the key of a form that has none once asked, by that key", () => {
    const unstamped = createForm("order");
    const flowConfig =
      unstamped.data.actionWhatsAppServiceMessage?.message.kind === "flow"
        ? unstamped.data.actionWhatsAppServiceMessage.message.flowConfig
        : undefined;
    delete flowConfig!.answersKey;
    const index = buildScenarioNodeGraphIndex({
      nodes: [trigger, unstamped, aiStep],
      edges: [createEdge("e1", "trigger", "order")],
    });
    expect(index.scenarioFormKeysByNodeId.get("order")).toBe("form");
    expect(index.scenarioFormKeyStampsByFormKey.get("form")?.nodeId).toBe(
      "order"
    );
  });

  it("lists a template's Flow button with no form built here, without fields", () => {
    const promo = createNode("promo", {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "medal_pick_1",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Pick your medal" },
        {
          type: "BUTTONS",
          buttons: [{ type: "FLOW", text: "Pick", flow_id: "123" }],
        },
      ],
    });
    const index = buildScenarioNodeGraphIndex({
      nodes: [trigger, createForm("contact"), promo, aiStep],
      edges: [
        createEdge("e1", "trigger", "contact"),
        createEdge("e2", "contact", "promo", "right-source"),
        createEdge("e3", "promo", "ai", "right-source"),
      ],
    });
    expect(
      index.scenarioFormAnswerSourcesByNodeId
        .get("ai")
        ?.map(source => [source.nodeId, source.formKey, source.schema])
    ).toEqual([
      ["contact", "contact", "known"],
      ["promo", "", "unknown"],
    ]);
    expect(
      index.scenarioFormAnswerSourcesByNodeId.get("ai")?.[1]?.label
    ).toBeTruthy();
  });

  it("returns read-only form snapshots detached from the graph", () => {
    const form = createForm("contact", { name: "Contact details" });
    const index = buildScenarioNodeGraphIndex({
      nodes: [trigger, form, aiStep],
      edges: [
        createEdge("e1", "trigger", "contact"),
        createEdge("e2", "contact", "ai", "right-source"),
      ],
    });
    const [source] = index.scenarioFormAnswerSourcesByNodeId.get("ai") ?? [];
    const flowConfig =
      form.data.actionWhatsAppServiceMessage?.message.kind === "flow"
        ? form.data.actionWhatsAppServiceMessage.message.flowConfig
        : undefined;
    flowConfig!.screens[0]!.fields[0]!.label = "Changed";

    expect(source?.fields[0]?.label).toBe("Size");
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source?.fields[0])).toBe(true);
    expect(() =>
      (
        index.scenarioFormAnswerSourcesByNodeId as Map<
          string,
          readonly unknown[]
        >
      ).set("other", [])
    ).toThrow("read-only");
  });
});
