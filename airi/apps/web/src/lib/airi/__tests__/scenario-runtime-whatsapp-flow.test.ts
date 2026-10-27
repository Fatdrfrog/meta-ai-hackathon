import {
  evaluateScenarioFlow,
  resolveInteractiveReplyConditionTarget,
  resolvePreferredContinuationActionNodeId,
  shouldPinLockedScenarioForEvent,
} from "@/lib/airi/scenario/scenario-interactive-replies";
import { resolveScenarioDispatchTransition } from "@/lib/airi/scenario/scenario-post-action-routing";
import { classifyGenerativeAIInbound } from "@/lib/airi/reply/runtime/generative-ai-input";
import { buildGenerativeAIInboundCandidate } from "@/lib/airi/reply/runtime/scenario";
import { getWhatsAppInboundMessageText } from "@icecore/airi-runtime/whatsapp-message-processor";
import type { WhatsAppMessage } from "@icecore/shared/lib/whatsapp/webhook-payload";
import { buildScenarioTemplateComponents } from "@/lib/airi/reply/runtime/auto-reply-template-utils";
import { resolveScenarioStructuredReplyActionNodeId } from "@/lib/scenarios/structured-replies";
import {
  compileScenarioGraph,
  type ScenarioRuntimeNode,
} from "@icecore/airi-runtime/scenario-graph";
import {
  MEDAL_FLOW_ID,
  medalTemplateStep,
} from "@/lib/scenarios/__tests__/scenario-form-fixtures";
import { makeClientMessageTriggerNode } from "@/lib/scenarios/__tests__/scenario-trigger-fixtures";
import { createDemoShopInteractiveNoReplyFixture } from "../../../../test-fixtures/scenarios/demoshop-interactive-no-reply";
import {
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  buildFlowBranchSourceHandleId,
  buildScenarioActionOutcomeHandleId,
  buildWhatsAppSessionChoicePayload,
  buildWhatsAppSessionChoiceSourceHandleId,
  buildWhatsAppTemplateButtonPayload,
  buildWhatsAppTemplateButtonSourceHandleId,
  getPostActionConditionHandleId,
  getScenarioActionBranchDelayVirtualNodeId,
  getScenarioActionOutcomeVirtualNodeId,
  resolveWhatsAppInteractiveReplyTriggerEventKind,
  type WhatsAppComponent,
} from "@icecore/scenario-contracts";

// The template send helpers load the Mongo client; CI runs without MONGODB_URI.
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn().mockRejectedValue(new Error("Unexpected database access")),
}));
// So does the webhook message processor, which writes a Flow reply's text.
jest.mock("@icecore/airi-runtime/mongoose", () => {
  const connectDB = jest
    .fn()
    .mockRejectedValue(new Error("Unexpected database access"));
  return { __esModule: true, default: connectDB, connectDB };
});
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));

function createNode(
  id: string,
  data: Record<string, unknown>
): ScenarioRuntimeNode {
  return {
    id,
    data: data as ScenarioRuntimeNode["data"],
  };
}

function bulkRootNode(campaignName: string) {
  return createNode("bulk-1", {
    kind: "bulk",
    bulkRootConfig: {
      workflowKind: "bulk_campaign",
      sendMode: "immediate",
      channels: ["whatsapp"],
      campaignName,
      recipientSourceSummary: "CSV upload",
      generationStatus: "idle",
    },
  });
}

// A fixed WhatsApp reply-buttons session message.
function replyButtonsNode(
  id: string,
  text: string,
  options: Array<{ id: string; label: string }>,
  extra: Record<string, unknown> = {}
) {
  return createNode(id, {
    kind: "action",
    actionType: "reply",
    actionReplyMode: "fixed",
    actionReplyChannel: "whatsapp",
    actionWhatsAppServiceMessage: {
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text },
        options,
      },
    },
    ...extra,
  });
}

// A post-action wait with a user-replied branch and a no-reply timeout.
function postActionWait(
  id: string,
  timeoutMinutes: number,
  linkedConditionId?: string,
  extra: Record<string, unknown> = {}
) {
  return createNode(id, {
    kind: "logic",
    logicType: "post_action_condition",
    ...extra,
    conditionBranches: [
      { id: "user_replied", type: "user_replied" },
      {
        id: "no_reply_timeout",
        type: "no_reply_timeout",
        timeoutMinutes,
        ...(linkedConditionId ? { linkedConditionId } : {}),
      },
    ],
  });
}

it("marks only an exact legacy interactive no-reply assignment for fenced persistence", () => {
  const fixture = createDemoShopInteractiveNoReplyFixture();
  const graph = compileScenarioGraph(fixture.nodes, fixture.edges);
  const selectedAction = graph.nodesById.get("action-alpha");

  expect(selectedAction).toBeDefined();
  const transition = resolveScenarioDispatchTransition({
    graph,
    selectedAction: selectedAction!,
    selectedActionType: "reply",
    conversation: { _id: "conv-legacy" } as never,
    channel: "whatsapp",
  });

  expect(transition).toMatchObject({
    pendingConditionNodeId: "legacy-alpha",
    pendingSourceActionNodeId: "action-alpha",
    pendingLegacyRouting: {
      kind: "interactive_no_reply_assignment",
      conditionNodeId: "legacy-alpha",
      sourceActionNodeId: "action-alpha",
    },
  });
});

it("keeps an ordinary single-owner post-action wait off the legacy fence", () => {
  const graph = compileScenarioGraph(
    [
      createNode("action-ordinary", {
        kind: "action",
        actionType: "reply",
      }),
      createNode("condition-ordinary", {
        kind: "logic",
        logicType: "post_action_condition",
        conditionBranches: [
          { id: "timeout", type: "no_reply_timeout", timeoutMinutes: 30 },
        ],
      }),
      createNode("follow-up", { kind: "action", actionType: "reply" }),
    ],
    [
      {
        source: "action-ordinary",
        target: "condition-ordinary",
        sourceHandle: "right-source",
      },
      {
        source: "condition-ordinary",
        target: "follow-up",
        sourceHandle: getPostActionConditionHandleId("no_reply_timeout"),
      },
    ]
  );
  const selectedAction = graph.nodesById.get("action-ordinary");

  expect(selectedAction).toBeDefined();
  const transition = resolveScenarioDispatchTransition({
    graph,
    selectedAction: selectedAction!,
    selectedActionType: "reply",
    conversation: { _id: "conv-ordinary" } as never,
    channel: "whatsapp",
  });

  expect(transition).toMatchObject({
    pendingConditionNodeId: "condition-ordinary",
    pendingSourceActionNodeId: "action-ordinary",
  });
  expect(transition).not.toHaveProperty("pendingLegacyRouting");
});

function createCanonicalWhatsAppFlowActionData(
  flowConfig: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    kind: "action",
    actionType: "reply",
    actionReplyChannel: "whatsapp",
    actionWhatsAppServiceMessage: {
      version: 1,
      message: {
        kind: "flow",
        body: { mode: "fixed", text: "Open the form" },
        flowConfig,
      },
    },
    ...extra,
  };
}

const CANONICAL_SERVICE_BRANCH_MESSAGES = [
  {
    label: "reply buttons",
    message: {
      kind: "reply_buttons",
      body: { mode: "fixed", text: "Choose" },
      options: [{ id: "pricing", label: "Pricing" }],
    },
  },
  {
    label: "list rows",
    message: {
      kind: "list",
      body: { mode: "fixed", text: "Choose" },
      buttonLabel: "View",
      sections: [
        {
          id: "plans",
          rows: [{ id: "pricing", title: "Pricing" }],
        },
      ],
    },
  },
  {
    label: "carousel quick replies",
    message: {
      kind: "media_carousel",
      body: { mode: "fixed", text: "Choose" },
      cards: [
        {
          id: "one",
          media: { url: "https://cdn.test/one.jpg", mediaType: "image" },
          interaction: {
            kind: "quick_replies",
            options: [{ id: "pricing", label: "Pricing" }],
          },
        },
        {
          id: "two",
          media: { url: "https://cdn.test/two.jpg", mediaType: "image" },
          interaction: {
            kind: "quick_replies",
            options: [{ id: "support", label: "Support" }],
          },
        },
      ],
    },
  },
] as const;

describe("scenario runtime whatsapp flow replies", () => {
  it.each([
    ...CANONICAL_SERVICE_BRANCH_MESSAGES,
    {
      label: "Flow",
      message: {
        kind: "flow",
        body: { mode: "fixed", text: "Open the form" },
        flowConfig: {
          templateId: "flow-template",
          ctaText: "Open",
          screens: [],
        },
      },
    },
  ])("sends pending $label after an ordinary prompt reply", ({ message }) => {
    const trigger = createNode("trigger-1", makeClientMessageTriggerNode());
    const prompt = createNode("prompt-1", {
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "text",
          body: { mode: "fixed", text: "Company name?" },
        },
      },
    });
    const service = createNode("service-1", {
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: { version: 1, message },
    });
    const context = createNode("context-1", { kind: "context" });
    const unrelatedAction = createNode("unrelated-action", {
      kind: "action",
      actionType: "reply",
    });
    const scenario = {
      entryPolicy: "repeatable" as const,
      nodes: [trigger, prompt, context, service, unrelatedAction],
      edges: [
        { source: trigger.id, target: prompt.id, sourceHandle: "right-source" },
        { source: prompt.id, target: context.id, sourceHandle: "right-source" },
        {
          source: context.id,
          target: service.id,
          sourceHandle: "right-source",
        },
      ],
    };
    const graph = compileScenarioGraph(scenario.nodes, scenario.edges);
    const conversation = { _id: "conv-1" } as never;
    const transition = resolveScenarioDispatchTransition({
      graph,
      selectedAction: prompt,
      selectedActionType: "reply",
      selectedPathNodeIds: [trigger.id, prompt.id],
      conversation,
      channel: "whatsapp",
    });
    expect(transition.nextActionNodeId).toBe(service.id);

    const continuation = {
      scenario,
      currentActionNodeId: transition.nextActionNodeId,
      currentPathNodeIds: [trigger.id, prompt.id],
      eventKind: "inbound_message" as const,
    };
    const preferredActionNodeId =
      resolvePreferredContinuationActionNodeId(continuation);
    expect(preferredActionNodeId).toBe(service.id);
    expect(shouldPinLockedScenarioForEvent(continuation)).toBe(true);
    expect(
      evaluateScenarioFlow({
        graph,
        conversation,
        channel: "whatsapp",
        preferredActionNodeId,
        triggerEventKind: continuation.eventKind,
      })?.selectedAction.id
    ).toBe(service.id);

    const alreadySent = {
      ...continuation,
      currentPathNodeIds: [trigger.id, prompt.id, context.id, service.id],
    };
    expect(
      resolvePreferredContinuationActionNodeId(alreadySent)
    ).toBeUndefined();
    expect(shouldPinLockedScenarioForEvent(alreadySent)).toBe(false);
    for (const currentPathNodeIds of [
      undefined,
      [],
      ["deleted-action"],
      [trigger.id],
      [unrelatedAction.id],
    ]) {
      const staleContinuation = { ...continuation, currentPathNodeIds };
      expect(
        resolvePreferredContinuationActionNodeId(staleContinuation)
      ).toBeUndefined();
      expect(shouldPinLockedScenarioForEvent(staleContinuation)).toBe(false);
    }
    expect(
      evaluateScenarioFlow({
        graph,
        conversation,
        channel: "whatsapp",
        preferredActionNodeId: service.id,
        triggerEventKind: "whatsapp_button_reply",
        quickReplyPayload: "unknown-choice",
      })
    ).toBeNull();
  });

  it("keeps a WhatsApp Flow branch ahead of broad action outcomes", () => {
    const nodes: ScenarioRuntimeNode[] = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerConfig: { enabled: true },
      }),
      createNode(
        "flow-1",
        createCanonicalWhatsAppFlowActionData(
          {
            screens: [
              {
                id: "LEAD_FORM",
                fields: [
                  {
                    id: "product",
                    fieldType: "RadioButtonsGroup",
                    options: [{ id: "opt_1", title: "Option 1" }],
                  },
                ],
              },
            ],
          },
          {
            actionOutcomes: {
              version: 1,
              anyReply: { enabled: true },
              noReply: { enabled: true, timeoutMinutes: 15 },
              answerMatches: [{ id: "exact", mode: "exact", text: "opt_1" }],
              paymentDetected: { enabled: true },
            },
          }
        )
      ),
      createNode("flow-branch", {
        kind: "logic",
        logicType: "post_action_condition",
        flowBranchSourceFieldId: "product",
        flowBranchOptionId: "opt_1",
      }),
      createNode("flow-target", { kind: "action", actionType: "reply" }),
      createNode("reply-target", { kind: "action", actionType: "reply" }),
      createNode("exact-target", { kind: "action", actionType: "reply" }),
      createNode("payment-target", { kind: "action", actionType: "reply" }),
      createNode("timeout-target", { kind: "action", actionType: "reply" }),
    ];
    const graph = compileScenarioGraph(nodes, [
      { source: "trigger-1", target: "flow-1" },
      { source: "flow-1", target: "flow-branch" },
      { source: "flow-branch", target: "flow-target" },
      {
        source: "flow-1",
        sourceHandle: buildScenarioActionOutcomeHandleId("any_reply"),
        target: "reply-target",
      },
      {
        source: "flow-1",
        sourceHandle: buildScenarioActionOutcomeHandleId({
          type: "answer",
          ruleId: "exact",
        }),
        target: "exact-target",
      },
      {
        source: "flow-1",
        sourceHandle: buildScenarioActionOutcomeHandleId("payment_detected"),
        target: "payment-target",
      },
      {
        source: "flow-1",
        sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
        target: "timeout-target",
      },
    ]);

    expect(graph.diagnostics).toEqual([]);
    expect(
      evaluateScenarioFlow({
        graph,
        conversation: { _id: "conv-1" } as never,
        channel: "whatsapp",
        preferredActionNodeId: "flow-1",
        triggerEventKind: "whatsapp_flow_reply",
        whatsAppFlowResponseJson: JSON.stringify({
          product: "opt_1",
          flow_token: "flow_123",
        }),
      })
    ).toHaveProperty("selectedAction.id", "flow-target");
  });

  it("uses canonical service Flow metadata to match provider option titles", () => {
    const nodes: ScenarioRuntimeNode[] = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerConfig: { enabled: true },
      }),
      createNode("flow-1", {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "flow",
            body: { mode: "fixed", text: "Choose" },
            flowConfig: {
              templateId: "flow-template",
              ctaText: "Open",
              screens: [
                {
                  id: "LEAD_FORM",
                  fields: [
                    {
                      id: "product",
                      fieldType: "RadioButtonsGroup",
                      options: [{ id: "opt_1", title: "Option 1" }],
                    },
                  ],
                },
              ],
            },
          },
        },
      }),
      createNode("flow-branch", {
        kind: "logic",
        logicType: "post_action_condition",
        flowBranchSourceFieldId: "product",
        flowBranchOptionId: "opt_1",
      }),
      createNode("flow-target", { kind: "action", actionType: "reply" }),
    ];
    const graph = compileScenarioGraph(nodes, [
      { source: "trigger-1", target: "flow-1" },
      { source: "flow-1", target: "flow-branch" },
      { source: "flow-branch", target: "flow-target" },
    ]);

    expect(graph.diagnostics).toEqual([]);
    expect(
      evaluateScenarioFlow({
        graph,
        conversation: { _id: "conv-1" } as never,
        channel: "whatsapp",
        preferredActionNodeId: "flow-1",
        triggerEventKind: "whatsapp_flow_reply",
        whatsAppFlowResponseJson: JSON.stringify({
          product: "Option 1",
          flow_token: "flow_123",
        }),
      })
    ).toHaveProperty("selectedAction.id", "flow-target");
  });

  it("fails closed before resolving an interactive pending target from an errored graph", () => {
    const source = createNode(
      "flow-1",
      createCanonicalWhatsAppFlowActionData({
        screens: [
          {
            id: "LEAD_FORM",
            fields: [
              {
                id: "product",
                fieldType: "RadioButtonsGroup",
                options: [{ id: "opt_1", title: "Option 1" }],
              },
            ],
          },
        ],
      })
    );
    const condition = createNode("flow-condition", {
      kind: "logic",
      logicType: "post_action_condition",
      conditionBranches: [{ id: "user_replied", type: "user_replied" }],
    });
    const invalid = createNode("invalid", {
      kind: "action",
      actionType: "reply",
      actionOutcomes: { version: 99 },
    });
    const graph = compileScenarioGraph(
      [source, condition, invalid],
      [
        {
          source: source.id,
          sourceHandle: buildFlowBranchSourceHandleId("product", "opt_1"),
          target: condition.id,
        },
      ]
    );

    expect(graph.diagnostics).toHaveLength(1);
    expect(
      resolveInteractiveReplyConditionTarget({
        graph,
        conversation: { _id: "conv-1" } as never,
        channel: "whatsapp",
        preferredActionNodeId: source.id,
        triggerEventKind: "whatsapp_flow_reply",
        whatsAppFlowResponseJson: JSON.stringify({ product: "opt_1" }),
      })
    ).toBeNull();
  });

  it("keeps provider-specific template buttons ahead of broad action outcomes", () => {
    const payload = buildWhatsAppTemplateButtonPayload("tpl-1", 0);
    const nodes: ScenarioRuntimeNode[] = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerConfig: { enabled: true },
      }),
      createNode("tpl-1", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "choose",
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Choose" },
          {
            type: "BUTTONS",
            buttons: [{ type: "QUICK_REPLY", text: "Button" }],
          },
        ],
        actionOutcomes: {
          version: 1,
          anyReply: { enabled: true },
          noReply: { enabled: true, timeoutMinutes: 15 },
          answerMatches: [
            { id: "exact", mode: "exact", text: "button" },
            { id: "intent", mode: "intent", text: "chooses button" },
          ],
          paymentDetected: { enabled: true },
        },
      }),
      createNode("button-target", {
        kind: "action",
        actionType: "reply",
        whatsAppTemplateButtonPayload: payload,
      }),
      createNode("reply-target", { kind: "action", actionType: "reply" }),
      createNode("exact-target", { kind: "action", actionType: "reply" }),
      createNode("intent-target", { kind: "action", actionType: "reply" }),
      createNode("payment-target", { kind: "action", actionType: "reply" }),
      createNode("timeout-target", { kind: "action", actionType: "reply" }),
    ];
    const graph = compileScenarioGraph(nodes, [
      { source: "trigger-1", target: "tpl-1" },
      {
        source: "tpl-1",
        sourceHandle: buildWhatsAppTemplateButtonSourceHandleId(0),
        target: "button-target",
      },
      {
        source: "tpl-1",
        sourceHandle: buildScenarioActionOutcomeHandleId("any_reply"),
        target: "reply-target",
      },
      {
        source: "tpl-1",
        sourceHandle: buildScenarioActionOutcomeHandleId({
          type: "answer",
          ruleId: "exact",
        }),
        target: "exact-target",
      },
      {
        source: "tpl-1",
        sourceHandle: buildScenarioActionOutcomeHandleId({
          type: "answer",
          ruleId: "intent",
        }),
        target: "intent-target",
      },
      {
        source: "tpl-1",
        sourceHandle: buildScenarioActionOutcomeHandleId("payment_detected"),
        target: "payment-target",
      },
      {
        source: "tpl-1",
        sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
        target: "timeout-target",
      },
    ]);

    const match = evaluateScenarioFlow({
      graph,
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      preferredActionNodeId: "tpl-1",
      triggerEventKind: "whatsapp_button_reply",
      quickReplyPayload: payload,
    });

    expect(match).toHaveProperty("selectedAction.id", "button-target");
  });

  it("routes bulk-campaign template quick replies from the bulk root to the branch follow-up", () => {
    const payload = buildWhatsAppTemplateButtonPayload("tpl-1", 0);
    const nodes: ScenarioRuntimeNode[] = [
      bulkRootNode("VIP bulk"),
      createNode("tpl-1", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "vip_offer",
        actionWhatsAppTemplateLanguage: "en",
        actionWhatsAppTemplateComponents: [
          {
            type: "BUTTONS",
            buttons: [{ type: "QUICK_REPLY", text: "Interested" }],
          },
        ],
      }),
      createNode("follow-1", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Thanks, here is the next step.",
        actionImageUrls: ["https://cdn.example.com/create-ai-agent.pdf"],
        whatsAppTemplateButtonPayload: payload,
      }),
    ];

    const graph = compileScenarioGraph(nodes, [
      { source: "bulk-1", sourceHandle: "right-source", target: "tpl-1" },
      {
        source: "tpl-1",
        sourceHandle: "right-source-whatsapp-template-button-branch::0",
        target: "follow-1",
      },
    ]);

    const match = evaluateScenarioFlow({
      graph,
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      triggerEventKind: "whatsapp_button_reply",
      quickReplyPayload: payload,
    });

    expect(match).not.toBeNull();
    expect(match?.selectedAction.id).toBe("follow-1");
    expect(match?.selectedAction.data.actionImageUrls).toEqual([
      "https://cdn.example.com/create-ai-agent.pdf",
    ]);
    expect(match?.pathNodeIds).toEqual(["bulk-1", "tpl-1", "follow-1"]);
  });

  it("routes template quick replies to a follow-up that is also bound to another action's session choice", () => {
    const templatePayload = buildWhatsAppTemplateButtonPayload("tpl-1", 0);
    const otherSessionPayload = buildWhatsAppSessionChoicePayload({
      actionNodeId: "other-1",
      choiceId: "still-interested",
    });
    const nodes: ScenarioRuntimeNode[] = [
      bulkRootNode("EduDemo-like bulk"),
      createNode("tpl-1", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "rass1407",
        actionWhatsAppTemplateLanguage: "kk",
        actionWhatsAppTemplateComponents: [
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "Yes, info" },
              { type: "QUICK_REPLY", text: "No thanks" },
            ],
          },
        ],
      }),
      replyButtonsNode("other-1", "Last chance", [
        { id: otherSessionPayload, label: "Still interested" },
      ]),
      createNode("follow-1", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyChannel: "whatsapp",
        actionReplyText: "Are you a student or parent?",
        // Stamped by the other action's session-choice parent; template QR
        // parent only wires via edge handle (EduDemo production shape).
        whatsAppSessionChoicePayload: otherSessionPayload,
        whatsAppSessionChoiceLabel: "Still interested",
      }),
    ];

    const graph = compileScenarioGraph(nodes, [
      { source: "bulk-1", sourceHandle: "right-source", target: "tpl-1" },
      {
        source: "tpl-1",
        sourceHandle: buildWhatsAppTemplateButtonSourceHandleId(0),
        target: "follow-1",
      },
      {
        source: "tpl-1",
        sourceHandle: buildWhatsAppTemplateButtonSourceHandleId(1),
        target: "other-1",
      },
      {
        source: "other-1",
        sourceHandle:
          buildWhatsAppSessionChoiceSourceHandleId(otherSessionPayload),
        target: "follow-1",
      },
    ]);

    const fromTemplate = evaluateScenarioFlow({
      graph,
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      preferredActionNodeId: "tpl-1",
      triggerEventKind: "whatsapp_button_reply",
      quickReplyPayload: templatePayload,
    });
    expect(fromTemplate?.selectedAction.id).toBe("follow-1");
    expect(fromTemplate?.pathNodeIds).toEqual(["bulk-1", "tpl-1", "follow-1"]);

    const fromOther = evaluateScenarioFlow({
      graph,
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      preferredActionNodeId: "other-1",
      triggerEventKind: "whatsapp_button_reply",
      quickReplyPayload: otherSessionPayload,
    });
    expect(fromOther?.selectedAction.id).toBe("follow-1");
    expect(fromOther?.pathNodeIds).toEqual([
      "bulk-1",
      "tpl-1",
      "other-1",
      "follow-1",
    ]);
  });

  it("routes a session choice when the follow-up is also stamped by another session parent", () => {
    const priceFromNo = buildWhatsAppSessionChoicePayload({
      actionNodeId: "no-1",
      choiceId: "price",
    });
    const priceFromTimeout = buildWhatsAppSessionChoicePayload({
      actionNodeId: "timeout-1",
      choiceId: "price-alt",
    });
    const nodes: ScenarioRuntimeNode[] = [
      bulkRootNode("EduDemo next-step"),
      replyButtonsNode("no-1", "Why not?", [
        { id: priceFromNo, label: "Price" },
      ]),
      replyButtonsNode("timeout-1", "Still there?", [
        { id: priceFromTimeout, label: "Price" },
      ]),
      createNode("price-1", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyChannel: "whatsapp",
        actionReplyText: "Is installment hard?",
        // Stamped by timeout parent; no-1 wires via edge handle only.
        whatsAppSessionChoicePayload: priceFromTimeout,
        whatsAppSessionChoiceLabel: "Price",
      }),
    ];

    const graph = compileScenarioGraph(nodes, [
      { source: "bulk-1", sourceHandle: "right-source", target: "no-1" },
      {
        source: "no-1",
        sourceHandle: buildWhatsAppSessionChoiceSourceHandleId(priceFromNo),
        target: "price-1",
      },
      {
        source: "timeout-1",
        sourceHandle:
          buildWhatsAppSessionChoiceSourceHandleId(priceFromTimeout),
        target: "price-1",
      },
    ]);

    const match = evaluateScenarioFlow({
      graph,
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      preferredActionNodeId: "no-1",
      triggerEventKind: "whatsapp_button_reply",
      quickReplyPayload: priceFromNo,
    });

    expect(match?.selectedAction.id).toBe("price-1");
    expect(match?.pathNodeIds).toEqual(["bulk-1", "no-1", "price-1"]);
  });

  // timeout→price is listed before the path from no-1 so BFS can record the
  // wrong parent; logic bridges are not action candidates, so the branch still
  // lands on price-1.
  it.each([
    {
      name: "routes a dual-parent session choice even when BFS records the other parent first",
      campaignName: "EduDemo deep dual-parent",
      bridges: [] as string[],
    },
    {
      name: "routes dual-parent session choice through logic bridges (no direct edge)",
      campaignName: "bridge dual-parent",
      bridges: ["mid-1", "mid-2"],
    },
  ])("$name", ({ campaignName, bridges }) => {
    const priceFromNo = buildWhatsAppSessionChoicePayload({
      actionNodeId: "no-1",
      choiceId: "price",
    });
    const priceFromTimeout = buildWhatsAppSessionChoicePayload({
      actionNodeId: "timeout-1",
      choiceId: "price-alt",
    });
    const nodes: ScenarioRuntimeNode[] = [
      bulkRootNode(campaignName),
      replyButtonsNode(
        "no-1",
        "Why not?",
        [{ id: priceFromNo, label: "Price" }],
        {
          actionOutcomes: {
            version: 1,
            anyReply: { enabled: false },
            noReply: { enabled: true, timeoutMinutes: 60 },
            answerMatches: [],
            paymentDetected: { enabled: false },
          },
        }
      ),
      replyButtonsNode("timeout-1", "Still there?", [
        { id: priceFromTimeout, label: "Price" },
      ]),
      ...bridges.map(id =>
        createNode(id, { kind: "logic", logicType: "post_action_condition" })
      ),
      createNode("price-1", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyChannel: "whatsapp",
        actionReplyText: "Is installment hard?",
        whatsAppSessionChoicePayload: priceFromTimeout,
        whatsAppSessionChoiceLabel: "Price",
      }),
    ];
    const pathFromNo = ["no-1", ...bridges, "price-1"];

    const graph = compileScenarioGraph(nodes, [
      { source: "bulk-1", sourceHandle: "right-source", target: "no-1" },
      {
        source: "no-1",
        sourceHandle: buildScenarioActionOutcomeHandleId("no_reply"),
        target: "timeout-1",
      },
      {
        source: "timeout-1",
        sourceHandle:
          buildWhatsAppSessionChoiceSourceHandleId(priceFromTimeout),
        target: "price-1",
      },
      ...pathFromNo.slice(1).map((target, index) => ({
        source: pathFromNo[index],
        sourceHandle:
          index === 0
            ? buildWhatsAppSessionChoiceSourceHandleId(priceFromNo)
            : "right-source",
        target,
      })),
    ]);

    const match = evaluateScenarioFlow({
      graph,
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      preferredActionNodeId: "no-1",
      triggerEventKind: "whatsapp_button_reply",
      quickReplyPayload: priceFromNo,
    });

    expect(match?.selectedAction.id).toBe("price-1");
    expect(match?.pathNodeIds).toEqual(["bulk-1", ...pathFromNo]);
  });

  it("still rejects an unrelated session choice when no preferred edge matches", () => {
    const priceFromNo = buildWhatsAppSessionChoicePayload({
      actionNodeId: "no-1",
      choiceId: "price",
    });
    const unrelated = buildWhatsAppSessionChoicePayload({
      actionNodeId: "other",
      choiceId: "x",
    });
    const nodes: ScenarioRuntimeNode[] = [
      bulkRootNode("reject unrelated"),
      replyButtonsNode("no-1", "Why not?", [
        { id: priceFromNo, label: "Price" },
      ]),
      createNode("price-1", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "next",
        whatsAppSessionChoicePayload: priceFromNo,
      }),
    ];
    const graph = compileScenarioGraph(nodes, [
      { source: "bulk-1", sourceHandle: "right-source", target: "no-1" },
      {
        source: "no-1",
        sourceHandle: buildWhatsAppSessionChoiceSourceHandleId(priceFromNo),
        target: "price-1",
      },
    ]);

    expect(
      evaluateScenarioFlow({
        graph,
        conversation: { _id: "conv-1" } as never,
        channel: "whatsapp",
        preferredActionNodeId: "no-1",
        triggerEventKind: "whatsapp_button_reply",
        quickReplyPayload: unrelated,
      })
    ).toBeNull();
  });

  it("continues to the next action when a template-linked flow reply has no explicit branch nodes", () => {
    const nodes: ScenarioRuntimeNode[] = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerConfig: { enabled: true },
      }),
      createNode("flow-1", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "medal_pick_1",
        actionWhatsAppTemplateLanguage: "kk",
      }),
      createNode("reply-1", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Thanks, we are reviewing your request.",
      }),
    ];

    const graph = compileScenarioGraph(nodes, [
      { source: "trigger-1", target: "flow-1" },
      { source: "flow-1", target: "reply-1" },
    ]);

    const match = evaluateScenarioFlow({
      graph,
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      preferredActionNodeId: "flow-1",
      triggerEventKind: "whatsapp_flow_reply",
      whatsAppFlowResponseJson: JSON.stringify({
        message: "opt_1",
        flow_token: "flow_123",
      }),
    });

    expect(match).not.toBeNull();
    expect(match?.selectedAction.id).toBe("reply-1");
    expect(match?.pathNodeIds).toEqual(["trigger-1", "flow-1", "reply-1"]);
  });

  it("matches a flow reply branch when the branch binding is on an intermediate logic node", () => {
    const nodes: ScenarioRuntimeNode[] = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerConfig: { enabled: true },
      }),
      createNode(
        "flow-1",
        createCanonicalWhatsAppFlowActionData({
          screens: [
            {
              id: "LEAD_FORM",
              fields: [
                {
                  id: "message",
                  fieldType: "RadioButtonsGroup",
                  options: [
                    { id: "opt_1", title: "Option 1" },
                    { id: "opt_2", title: "Option 2" },
                  ],
                },
              ],
            },
          ],
        })
      ),
      createNode("branch-1", {
        kind: "logic",
        logicType: "post_action_condition",
        flowBranchSourceFieldId: "message",
        flowBranchOptionId: "opt_1",
      }),
      createNode("branch-2", {
        kind: "logic",
        logicType: "post_action_condition",
        flowBranchSourceFieldId: "message",
        flowBranchOptionId: "opt_2",
      }),
      createNode("action-1", {
        kind: "action",
        actionType: "whatsapp_template",
      }),
      createNode("action-2", {
        kind: "action",
        actionType: "assign_human",
      }),
    ];

    const graph = compileScenarioGraph(nodes, [
      { source: "trigger-1", target: "flow-1" },
      { source: "flow-1", target: "branch-1" },
      { source: "flow-1", target: "branch-2" },
      { source: "branch-1", target: "action-1" },
      { source: "branch-2", target: "action-2" },
    ]);

    const match = evaluateScenarioFlow({
      graph,
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      preferredActionNodeId: "flow-1",
      triggerEventKind: "whatsapp_flow_reply",
      whatsAppFlowResponseJson: JSON.stringify({
        message: "opt_1",
        flow_token: "flow_123",
      }),
    });

    expect(match).not.toBeNull();
    expect(match?.selectedAction.id).toBe("action-1");
    expect(match?.pathNodeIds).toEqual([
      "trigger-1",
      "flow-1",
      "branch-1",
      "action-1",
    ]);
  });

  it("matches a flow reply branch when Meta returns the selected option title", () => {
    const nodes: ScenarioRuntimeNode[] = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerConfig: { enabled: true },
      }),
      createNode(
        "flow-1",
        createCanonicalWhatsAppFlowActionData({
          screens: [
            {
              id: "screen-1",
              title: "Choose",
              fields: [
                {
                  id: "product",
                  fieldType: "RadioButtonsGroup",
                  options: [
                    { id: "medal", title: "Медальницы" },
                    { id: "exclusive", title: "Эксклюзив шежире" },
                  ],
                },
              ],
            },
          ],
        })
      ),
      createNode("branch-1", {
        kind: "logic",
        logicType: "post_action_condition",
        flowBranchSourceFieldId: "product",
        flowBranchOptionId: "exclusive",
      }),
      createNode("reply-1", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Exclusive selected",
      }),
    ];

    const graph = compileScenarioGraph(nodes, [
      { source: "trigger-1", target: "flow-1" },
      { source: "flow-1", target: "branch-1" },
      { source: "branch-1", target: "reply-1" },
    ]);

    const match = evaluateScenarioFlow({
      graph,
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      preferredActionNodeId: "flow-1",
      triggerEventKind: "whatsapp_flow_reply",
      whatsAppFlowResponseJson: JSON.stringify({
        message: "Эксклюзив шежире",
        flow_token: "flow_123",
      }),
    });

    expect(match).not.toBeNull();
    expect(match?.selectedAction.id).toBe("reply-1");
  });

  it("keeps nextActionNodeId on whatsapp_template when template has Flow CTA (dispatch transition)", () => {
    const nodes: ScenarioRuntimeNode[] = [
      createNode("tpl-1", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "shezhire_elit_pick_1",
        actionReplyCtaType: "flow",
        actionReplyCtaFlowId: "123456789",
      }),
    ];
    const graph = compileScenarioGraph(nodes, []);
    const transition = resolveScenarioDispatchTransition({
      graph,
      selectedAction: nodes[0],
      selectedActionType: "whatsapp_template",
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
    });
    expect(transition.nextActionNodeId).toBe("tpl-1");
    expect(transition.completesScenario).toBe(false);
  });

  it("routes a locked WhatsApp template quick-reply button to the matching branch", () => {
    const payload = buildWhatsAppTemplateButtonPayload("tpl-1", 1);
    const nodes: ScenarioRuntimeNode[] = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerConfig: { enabled: true },
      }),
      createNode("tpl-1", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "language_pick",
        actionWhatsAppTemplateLanguage: "kk",
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Choose language" },
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "Kazakh" },
              { type: "QUICK_REPLY", text: "Russian" },
            ],
          },
        ],
      }),
      createNode("reply-kz", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Kazakh selected",
        whatsAppTemplateButtonPayload: buildWhatsAppTemplateButtonPayload(
          "tpl-1",
          0
        ),
        whatsAppTemplateButtonLabel: "Kazakh",
      }),
      createNode("reply-ru", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Russian selected",
        whatsAppTemplateButtonPayload: payload,
        whatsAppTemplateButtonLabel: "Russian",
      }),
    ];

    const graph = compileScenarioGraph(nodes, [
      { source: "trigger-1", target: "tpl-1" },
      { source: "tpl-1", target: "reply-kz" },
      { source: "tpl-1", target: "reply-ru" },
    ]);

    const match = evaluateScenarioFlow({
      graph,
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      preferredActionNodeId: "tpl-1",
      triggerEventKind: "whatsapp_button_reply",
      quickReplyPayload: payload,
    });

    expect(match).not.toBeNull();
    expect(match?.selectedAction.id).toBe("reply-ru");
    expect(match?.pathNodeIds).toEqual(["trigger-1", "tpl-1", "reply-ru"]);
  });

  it("prefers the nearest reachable action over an older downstream follow-up", () => {
    const nodes: ScenarioRuntimeNode[] = [
      createNode("trigger-1", {
        ...makeClientMessageTriggerNode({
          triggerConfig: {
            enabled: true,
            messageMatchMode: "exact",
            keywordPattern: "Shezhire",
            keywordMatchMode: "contains",
          },
        }),
      }),
      createNode("older-follow-up", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "older_follow_up",
      }),
      postActionWait("wait-1", 1440),
      createNode("pick-lang", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "pick_lang",
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Choose language" },
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "Kazakh" },
              { type: "QUICK_REPLY", text: "Russian" },
            ],
          },
        ],
      }),
    ];

    const graph = compileScenarioGraph(nodes, [
      { source: "trigger-1", target: "pick-lang" },
      {
        source: "pick-lang",
        sourceHandle: "right-source-whatsapp-template-button-branch::0",
        target: "wait-1",
      },
      {
        source: "wait-1",
        sourceHandle: "right-source-condition-no_reply_timeout",
        target: "older-follow-up",
      },
    ]);

    const match = evaluateScenarioFlow({
      graph,
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      matchedTriggerNodeId: "trigger-1",
      triggerEventKind: "inbound_message",
    });

    expect(match).not.toBeNull();
    expect(match?.selectedAction.id).toBe("pick-lang");
    expect(match?.pathNodeIds).toEqual(["trigger-1", "pick-lang"]);
  });

  it("routes a template button through a post-action condition user-replied branch", () => {
    const payload = buildWhatsAppTemplateButtonPayload("pick-lang", 0);
    const nodes: ScenarioRuntimeNode[] = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerConfig: { enabled: true },
      }),
      createNode("pick-lang", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "pick_lang",
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Choose language" },
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "Kazakh" },
              { type: "QUICK_REPLY", text: "Russian" },
            ],
          },
        ],
      }),
      createNode("medal-follow-up", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "medal_dozhim_1",
      }),
      postActionWait("wait-1", 1440),
      createNode("pick-product-kz", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "pick_product_kz",
      }),
    ];

    const graph = compileScenarioGraph(nodes, [
      { source: "trigger-1", target: "pick-lang" },
      {
        source: "pick-lang",
        sourceHandle: "right-source-whatsapp-template-button-branch::0",
        target: "wait-1",
      },
      {
        source: "pick-lang",
        sourceHandle: "right-source",
        target: "wait-1",
      },
      {
        source: "wait-1",
        sourceHandle: "right-source-condition-no_reply_timeout",
        target: "medal-follow-up",
      },
      {
        source: "wait-1",
        sourceHandle: "right-source-condition-user_replied",
        target: "pick-product-kz",
      },
    ]);

    const match = evaluateScenarioFlow({
      graph,
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      preferredActionNodeId: "pick-lang",
      triggerEventKind: "whatsapp_button_reply",
      quickReplyPayload: payload,
    });

    expect(match).not.toBeNull();
    expect(match?.selectedAction.id).toBe("pick-product-kz");
    expect(match?.pathNodeIds).toEqual([
      "trigger-1",
      "pick-lang",
      "wait-1",
      "pick-product-kz",
    ]);
  });

  it("routes a locked WhatsApp session choice button to the matching branch", () => {
    const payload = buildWhatsAppSessionChoicePayload({
      actionNodeId: "choice-1",
      choiceId: "support",
    });
    const nodes: ScenarioRuntimeNode[] = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerConfig: { enabled: true },
      }),
      replyButtonsNode("choice-1", "Choose a path", [
        { id: "pricing", label: "Pricing" },
        { id: "support", label: "Support" },
      ]),
      createNode("reply-pricing", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Pricing selected",
        whatsAppSessionChoicePayload: buildWhatsAppSessionChoicePayload({
          actionNodeId: "choice-1",
          choiceId: "pricing",
        }),
        whatsAppSessionChoiceLabel: "Pricing",
      }),
      createNode("reply-support", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Support selected",
        whatsAppSessionChoicePayload: payload,
        whatsAppSessionChoiceLabel: "Support",
      }),
    ];

    const graph = compileScenarioGraph(nodes, [
      { source: "trigger-1", target: "choice-1" },
      { source: "choice-1", target: "reply-pricing" },
      { source: "choice-1", target: "reply-support" },
    ]);

    const match = evaluateScenarioFlow({
      graph,
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      preferredActionNodeId: "choice-1",
      triggerEventKind: "whatsapp_button_reply",
      quickReplyPayload: payload,
    });

    expect(match).not.toBeNull();
    expect(match?.selectedAction.id).toBe("reply-support");
    expect(match?.pathNodeIds).toEqual([
      "trigger-1",
      "choice-1",
      "reply-support",
    ]);
  });

  it("routes each canonical WhatsApp service message reply button to its branch", () => {
    const optionOne = buildWhatsAppSessionChoicePayload({
      actionNodeId: "service-1",
      choiceId: "option-one",
    });
    const optionTwo = buildWhatsAppSessionChoicePayload({
      actionNodeId: "service-1",
      choiceId: "option-two",
    });
    const serviceMessage = {
      version: 1 as const,
      message: {
        kind: "reply_buttons" as const,
        body: { mode: "fixed" as const, text: "Choose a path" },
        options: [
          { id: optionOne, label: "Path one" },
          { id: optionTwo, label: "Path two" },
        ],
      },
    };
    const nodes: ScenarioRuntimeNode[] = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerConfig: { enabled: true },
      }),
      createNode("service-1", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyChannel: "whatsapp",
        actionWhatsAppServiceMessage: serviceMessage,
      }),
      createNode("reply-one", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Path one selected",
        whatsAppSessionChoicePayload: optionOne,
        whatsAppSessionChoiceLabel: "Path one",
      }),
      createNode("reply-two", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Path two selected",
        whatsAppSessionChoicePayload: optionTwo,
        whatsAppSessionChoiceLabel: "Path two",
      }),
    ];

    const graph = compileScenarioGraph(nodes, [
      { source: "trigger-1", target: "service-1" },
      { source: "service-1", target: "reply-one" },
      { source: "service-1", target: "reply-two" },
    ]);

    const secondMatch = evaluateScenarioFlow({
      graph,
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      preferredActionNodeId: "service-1",
      triggerEventKind: "whatsapp_button_reply",
      quickReplyPayload: optionTwo,
    });

    expect(secondMatch).not.toBeNull();
    expect(secondMatch?.selectedAction.id).toBe("reply-two");
    expect(secondMatch?.pathNodeIds).toEqual([
      "trigger-1",
      "service-1",
      "reply-two",
    ]);
  });

  it.each(CANONICAL_SERVICE_BRANCH_MESSAGES)(
    "keeps canonical $label pending after dispatch",
    ({ message }) => {
      const service = createNode("service-1", {
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "whatsapp",
        actionWhatsAppServiceMessage: {
          version: 1,
          message,
        },
      });
      const graph = compileScenarioGraph([service], []);

      expect(
        resolveScenarioDispatchTransition({
          graph,
          selectedAction: service,
          selectedActionType: "reply",
          conversation: { _id: "conv-1" } as never,
          channel: "whatsapp",
        })
      ).toMatchObject({
        nextActionNodeId: "service-1",
        completesScenario: false,
      });
    }
  );

  it.each(CANONICAL_SERVICE_BRANCH_MESSAGES)(
    "pins canonical $label for WhatsApp button replies, not plain inbound",
    ({ message }) => {
      const scenario = {
        _id: "scenario-service-buttons",
        nodes: [
          createNode("trigger-1", {
            kind: "trigger",
            triggerConfig: { enabled: true },
          }),
          createNode("service-1", {
            kind: "action",
            actionType: "reply",
            actionReplyChannel: "whatsapp",
            actionWhatsAppServiceMessage: {
              version: 1,
              message,
            },
          }),
        ],
        edges: [{ source: "trigger-1", target: "service-1" }],
      } as never;

      expect(
        resolvePreferredContinuationActionNodeId({
          scenario,
          currentActionNodeId: "service-1",
          eventKind: "whatsapp_button_reply",
        })
      ).toBe("service-1");
      expect(
        resolvePreferredContinuationActionNodeId({
          scenario,
          currentActionNodeId: "service-1",
          eventKind: "post_action_user_reply",
        })
      ).toBeUndefined();
      expect(
        shouldPinLockedScenarioForEvent({
          scenario,
          currentActionNodeId: "service-1",
          eventKind: "whatsapp_button_reply",
        })
      ).toBe(true);
      expect(
        shouldPinLockedScenarioForEvent({
          scenario,
          currentActionNodeId: "service-1",
          eventKind: "post_action_user_reply",
        })
      ).toBe(false);
    }
  );

  it("pins a canonical service Flow only for its Flow response", () => {
    const scenario = {
      _id: "scenario-service-flow",
      nodes: [
        createNode("trigger-1", {
          kind: "trigger",
          triggerConfig: { enabled: true },
        }),
        createNode("flow-1", {
          kind: "action",
          actionType: "reply",
          actionReplyChannel: "whatsapp",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "flow",
              body: { mode: "fixed", text: "Open" },
              flowConfig: {
                templateId: "flow-template",
                ctaText: "Open",
                screens: [],
              },
            },
          },
        }),
      ],
      edges: [{ source: "trigger-1", target: "flow-1" }],
    } as never;

    expect(
      resolvePreferredContinuationActionNodeId({
        scenario,
        currentActionNodeId: "flow-1",
        eventKind: "whatsapp_flow_reply",
      })
    ).toBe("flow-1");
    expect(
      resolvePreferredContinuationActionNodeId({
        scenario,
        currentActionNodeId: "flow-1",
        eventKind: "post_action_user_reply",
      })
    ).toBeUndefined();
  });

  it("does not match unrelated WhatsApp template button payloads", () => {
    const nodes: ScenarioRuntimeNode[] = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerConfig: { enabled: true },
      }),
      createNode("tpl-1", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Choose language" },
          {
            type: "BUTTONS",
            buttons: [{ type: "QUICK_REPLY", text: "Kazakh" }],
          },
        ],
      }),
      createNode("reply-kz", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Kazakh selected",
        whatsAppTemplateButtonPayload: buildWhatsAppTemplateButtonPayload(
          "tpl-1",
          0
        ),
        whatsAppTemplateButtonLabel: "Kazakh",
      }),
    ];

    const graph = compileScenarioGraph(nodes, [
      { source: "trigger-1", target: "tpl-1" },
      { source: "tpl-1", target: "reply-kz" },
    ]);

    const match = evaluateScenarioFlow({
      graph,
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      preferredActionNodeId: "tpl-1",
      triggerEventKind: "whatsapp_button_reply",
      quickReplyPayload: buildWhatsAppTemplateButtonPayload("other-action", 0),
    });

    expect(match).toBeNull();
  });

  it("keeps nextActionNodeId on whatsapp_template when template has quick-reply branches", () => {
    const nodes: ScenarioRuntimeNode[] = [
      createNode("tpl-1", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Choose language" },
          {
            type: "BUTTONS",
            buttons: [{ type: "QUICK_REPLY", text: "Kazakh" }],
          },
        ],
      }),
    ];
    const graph = compileScenarioGraph(nodes, []);
    const transition = resolveScenarioDispatchTransition({
      graph,
      selectedAction: nodes[0],
      selectedActionType: "whatsapp_template",
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
    });
    expect(transition.nextActionNodeId).toBe("tpl-1");
    expect(transition.completesScenario).toBe(false);
  });

  it("arms a no-reply gate connected through a template quick-reply branch after dispatch", () => {
    const payload = buildWhatsAppTemplateButtonPayload("tpl-1", 0);
    const nodes: ScenarioRuntimeNode[] = [
      createNode("tpl-1", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "follow_up_2",
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Start today?" },
          {
            type: "BUTTONS",
            buttons: [{ type: "QUICK_REPLY", text: "Start today" }],
          },
        ],
      }),
      postActionWait("wait-1", 5760, "linked-timeout", {
        whatsAppTemplateButtonPayload: payload,
        whatsAppTemplateButtonLabel: "Start today",
      }),
      createNode("tpl-3", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "follow_up_3",
      }),
    ];
    const graph = compileScenarioGraph(nodes, [
      {
        source: "tpl-1",
        sourceHandle: "right-source-whatsapp-template-button-branch::0",
        target: "wait-1",
      },
      {
        source: "wait-1",
        sourceHandle: "right-source-condition-no_reply_timeout",
        target: "tpl-3",
      },
    ]);

    const transition = resolveScenarioDispatchTransition({
      graph,
      selectedAction: nodes[0],
      selectedActionType: "whatsapp_template",
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
    });

    expect(transition.pendingConditionNodeId).toBe("wait-1");
    expect(transition.pendingSourceActionNodeId).toBe("tpl-1");
    expect(transition.pendingLinkedConditionId).toBe("linked-timeout");
    expect(transition.completesScenario).toBe(false);
  });

  it("counts converging template output handles as one no-reply condition", () => {
    const nodes: ScenarioRuntimeNode[] = [
      createNode("tpl-1", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "pick_language",
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Choose language" },
          {
            type: "BUTTONS",
            buttons: [{ type: "QUICK_REPLY", text: "Kazakh" }],
          },
        ],
      }),
      postActionWait("wait-1", 1220, "pick-language-timeout"),
      createNode("follow-up-1", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "pick_product",
      }),
    ];
    const graph = compileScenarioGraph(nodes, [
      { source: "tpl-1", sourceHandle: "right-source", target: "wait-1" },
      {
        source: "tpl-1",
        sourceHandle: buildWhatsAppTemplateButtonSourceHandleId(0),
        target: "wait-1",
      },
      {
        source: "wait-1",
        sourceHandle: "right-source-condition-no_reply_timeout",
        target: "follow-up-1",
      },
    ]);

    const transition = resolveScenarioDispatchTransition({
      graph,
      selectedAction: nodes[0],
      selectedActionType: "whatsapp_template",
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
    });

    expect(transition.pendingConditionNodeId).toBe("wait-1");
    expect(transition.pendingSourceActionNodeId).toBe("tpl-1");
    expect(transition.pendingLinkedConditionId).toBe("pick-language-timeout");
    expect(transition.completesScenario).toBe(false);
  });

  it("counts converging WhatsApp session choices as one no-reply condition", () => {
    const pricingPayload = buildWhatsAppSessionChoicePayload({
      actionNodeId: "choice-1",
      choiceId: "pricing",
    });
    const supportPayload = buildWhatsAppSessionChoicePayload({
      actionNodeId: "choice-1",
      choiceId: "support",
    });
    const nodes: ScenarioRuntimeNode[] = [
      replyButtonsNode("choice-1", "Choose a path", [
        { id: "pricing", label: "Pricing" },
        { id: "support", label: "Support" },
      ]),
      postActionWait("wait-1", 60, "session-choice-timeout"),
      createNode("follow-up-1", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Still need help?",
      }),
    ];
    const graph = compileScenarioGraph(nodes, [
      {
        source: "choice-1",
        sourceHandle: buildWhatsAppSessionChoiceSourceHandleId(pricingPayload),
        target: "wait-1",
      },
      {
        source: "choice-1",
        sourceHandle: buildWhatsAppSessionChoiceSourceHandleId(supportPayload),
        target: "wait-1",
      },
      {
        source: "wait-1",
        sourceHandle: "right-source-condition-no_reply_timeout",
        target: "follow-up-1",
      },
    ]);

    const transition = resolveScenarioDispatchTransition({
      graph,
      selectedAction: nodes[0],
      selectedActionType: "reply",
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
    });

    expect(transition.pendingConditionNodeId).toBe("wait-1");
    expect(transition.pendingSourceActionNodeId).toBe("choice-1");
    expect(transition.pendingLinkedConditionId).toBe("session-choice-timeout");
    expect(transition.completesScenario).toBe(false);
  });

  it("arms a standard post-action no-reply condition for single-output whatsapp templates with Flow CTA", () => {
    const nodes: ScenarioRuntimeNode[] = [
      createNode("tpl-1", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "shezhire_elit_pick_1",
        actionWhatsAppTemplateLanguage: "kk",
        actionReplyCtaType: "flow",
        actionReplyCtaFlowId: "flow_meta_id",
        actionFlowConfig: {
          screens: [
            {
              id: "screen-1",
              fields: [
                {
                  id: "region",
                  fieldType: "TextInput",
                  required: true,
                },
              ],
            },
          ],
        },
      }),
      postActionWait("wait-1", 3, "linked-child-timeout"),
      createNode("handoff-1", {
        kind: "action",
        actionType: "assign_human",
      }),
    ];
    const graph = compileScenarioGraph(nodes, [
      { source: "tpl-1", target: "wait-1" },
      { source: "wait-1", target: "handoff-1" },
    ]);

    const transition = resolveScenarioDispatchTransition({
      graph,
      selectedAction: nodes[0],
      selectedActionType: "whatsapp_template",
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
    });

    expect(transition.pendingConditionNodeId).toBe("wait-1");
    expect(transition.pendingSourceActionNodeId).toBe("tpl-1");
    expect(transition.pendingLinkedConditionId).toBe("linked-child-timeout");
    expect(transition.completesScenario).toBe(false);
  });

  it("selects assign_human after whatsapp_template+flow CTA when preferred node is the template", () => {
    const nodes: ScenarioRuntimeNode[] = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerConfig: { enabled: true },
      }),
      createNode("tpl-1", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "shezhire_elit_pick_1",
        actionWhatsAppTemplateLanguage: "kk",
        actionReplyCtaType: "flow",
        actionReplyCtaFlowId: "flow_meta_id",
      }),
      createNode("handoff-1", {
        kind: "action",
        actionType: "assign_human",
      }),
    ];
    const graph = compileScenarioGraph(nodes, [
      { source: "trigger-1", target: "tpl-1" },
      { source: "tpl-1", target: "handoff-1" },
    ]);
    const match = evaluateScenarioFlow({
      graph,
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      preferredActionNodeId: "tpl-1",
      triggerEventKind: "whatsapp_flow_reply",
      whatsAppFlowResponseJson: JSON.stringify({
        screen_2__0: "6",
        flow_token: "tok",
      }),
    });
    expect(match).not.toBeNull();
    expect(match?.selectedAction.id).toBe("handoff-1");
  });

  it("arms the branch-specific no-reply condition for the selected flow option path", () => {
    const nodes: ScenarioRuntimeNode[] = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerConfig: { enabled: true },
      }),
      createNode(
        "flow-1",
        createCanonicalWhatsAppFlowActionData({
          screens: [
            {
              id: "screen-1",
              title: "Choose",
              fields: [
                {
                  id: "product",
                  fieldType: "RadioButtonsGroup",
                  options: [
                    { id: "opt_1", title: "Option 1" },
                    { id: "opt_2", title: "Option 2" },
                  ],
                },
              ],
            },
          ],
        })
      ),
      postActionWait("branch-1", 15, "child-timeout-1", {
        flowBranchSourceFieldId: "product",
        flowBranchOptionId: "opt_1",
      }),
      postActionWait("branch-2", 20, "child-timeout-2", {
        flowBranchSourceFieldId: "product",
        flowBranchOptionId: "opt_2",
      }),
      createNode("reply-1", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Reply for option 1",
      }),
      createNode("reply-2", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Reply for option 2",
      }),
    ];

    const graph = compileScenarioGraph(nodes, [
      { source: "trigger-1", target: "flow-1" },
      { source: "flow-1", target: "branch-1" },
      { source: "flow-1", target: "branch-2" },
      { source: "branch-1", target: "reply-1" },
      { source: "branch-2", target: "reply-2" },
    ]);

    const match = evaluateScenarioFlow({
      graph,
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      preferredActionNodeId: "flow-1",
      triggerEventKind: "whatsapp_flow_reply",
      whatsAppFlowResponseJson: JSON.stringify({
        product: "opt_2",
        flow_token: "flow_123",
      }),
    });

    expect(match).not.toBeNull();
    expect(match?.selectedAction.id).toBe("reply-2");

    const transition = resolveScenarioDispatchTransition({
      graph,
      selectedAction: match!.selectedAction,
      selectedActionType: match!.selectedActionType,
      selectedPathNodeIds: match!.pathNodeIds,
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
    });

    expect(transition.pendingConditionNodeId).toBe("branch-2");
    expect(transition.pendingSourceActionNodeId).toBe("reply-2");
    expect(transition.pendingLinkedConditionId).toBe("child-timeout-2");
  });

  it("does not re-arm a condition after its no-reply branch selected a terminal action", () => {
    const nodes: ScenarioRuntimeNode[] = [
      createNode("follow-up-2", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "medal_dozhim_2_ru",
      }),
      postActionWait("wait-2", 5760),
      createNode("follow-up-3", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "medal_dozhim_3_ru",
      }),
    ];
    const graph = compileScenarioGraph(nodes, [
      {
        source: "follow-up-2",
        sourceHandle: "right-source-whatsapp-template-button-branch::0",
        target: "wait-2",
      },
      {
        source: "wait-2",
        sourceHandle: "right-source-condition-no_reply_timeout",
        target: "follow-up-3",
      },
    ]);

    const transition = resolveScenarioDispatchTransition({
      graph,
      selectedAction: nodes[2],
      selectedActionType: "whatsapp_template",
      selectedPathNodeIds: ["follow-up-2", "wait-2", "follow-up-3"],
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
    });

    expect(transition.pendingConditionNodeId).toBeUndefined();
    expect(transition.pendingSourceActionNodeId).toBeUndefined();
    expect(transition.pendingLinkedConditionId).toBeUndefined();
    expect(transition.completesScenario).toBe(true);
  });

  it("returns null for flow reply when persisted currentActionNodeId wrongly points at assign_human (not the template)", () => {
    const nodes: ScenarioRuntimeNode[] = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerConfig: { enabled: true },
      }),
      createNode("tpl-1", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "t",
        actionReplyCtaType: "flow",
        actionReplyCtaFlowId: "flow_meta_id",
      }),
      createNode("handoff-1", {
        kind: "action",
        actionType: "assign_human",
      }),
    ];
    const graph = compileScenarioGraph(nodes, [
      { source: "trigger-1", target: "tpl-1" },
      { source: "tpl-1", target: "handoff-1" },
    ]);
    const match = evaluateScenarioFlow({
      graph,
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      preferredActionNodeId: "handoff-1",
      triggerEventKind: "whatsapp_flow_reply",
      whatsAppFlowResponseJson: JSON.stringify({ flow_token: "tok" }),
    });
    expect(match).toBeNull();
  });

  it("does not keep a canonical Flow action as the preferred continuation on ordinary inbound replies", () => {
    const scenario = {
      _id: "scenario-1",
      nodes: [
        createNode("trigger-1", {
          kind: "trigger",
          triggerConfig: { enabled: true },
        }),
        createNode(
          "flow-1",
          createCanonicalWhatsAppFlowActionData({
            ctaText: "Open",
            screens: [],
          })
        ),
      ],
      edges: [{ source: "trigger-1", target: "flow-1" }],
    } as never;

    expect(
      resolvePreferredContinuationActionNodeId({
        scenario,
        currentActionNodeId: "flow-1",
        eventKind: "post_action_user_reply",
      })
    ).toBeUndefined();
    expect(
      shouldPinLockedScenarioForEvent({
        scenario,
        currentActionNodeId: "flow-1",
        eventKind: "post_action_user_reply",
      })
    ).toBe(false);
  });

  it("keeps a WhatsApp template action pinned for WhatsApp button replies only", () => {
    const scenario = {
      _id: "scenario-template-buttons",
      nodes: [
        createNode("trigger-1", {
          kind: "trigger",
          triggerConfig: { enabled: true },
        }),
        createNode("tpl-1", {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateComponents: [
            { type: "BODY", text: "Choose language" },
            {
              type: "BUTTONS",
              buttons: [{ type: "QUICK_REPLY", text: "Kazakh" }],
            },
          ],
        }),
      ],
      edges: [{ source: "trigger-1", target: "tpl-1" }],
    } as never;

    expect(
      resolvePreferredContinuationActionNodeId({
        scenario,
        currentActionNodeId: "tpl-1",
        eventKind: "whatsapp_button_reply",
      })
    ).toBe("tpl-1");
    expect(
      shouldPinLockedScenarioForEvent({
        scenario,
        currentActionNodeId: "tpl-1",
        eventKind: "post_action_user_reply",
      })
    ).toBe(false);
  });

  it("treats a connected flow's text answers as the generative prompt input", () => {
    const nodes: ScenarioRuntimeNode[] = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerConfig: { enabled: true },
      }),
      createNode("flow-1", {
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
                  ],
                },
              ],
            },
          },
        },
      }),
      createNode("generate", {
        kind: "action",
        actionType: "generative_ai",
        actionGenerativeAIConfig: {
          version: 1,
          mode: "text_to_video",
          prompt: "Film {{input.name}} playing {{input.sport}}",
        },
      }),
      createNode("image-video", {
        kind: "action",
        actionType: "generative_ai",
        actionGenerativeAIConfig: {
          version: 1,
          mode: "image_to_video",
          prompt: "Animate the photo",
        },
      }),
    ];
    const graph = compileScenarioGraph(nodes, [
      { source: "trigger-1", target: "flow-1" },
      { source: "flow-1", target: "generate" },
    ]);
    const responseJson = JSON.stringify({
      name: "Amina",
      sport: "tennis",
      flow_token: "flow_123",
    });
    const inbound = {
      messageId: "message-1",
      kind: "interactive",
      textOrCaption: "[Flow response: flow] name: Amina",
      whatsappMediaId: null,
      declaredMimeType: null,
      fileName: null,
    };

    const match = evaluateScenarioFlow({
      graph,
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      preferredActionNodeId: "flow-1",
      triggerEventKind: "whatsapp_flow_reply",
      whatsAppFlowResponseJson: responseJson,
      generativeInbound: inbound,
    });

    expect(match?.selectedAction.id).toBe("generate");
    expect(match?.generativeAI?.input).toMatchObject({
      status: "compatible",
      input: {
        kind: "text",
        textOrCaption: "Name: Amina\nSport: tennis",
      },
    });

    const imageGraph = compileScenarioGraph(nodes, [
      { source: "trigger-1", target: "flow-1" },
      { source: "flow-1", target: "image-video" },
    ]);
    expect(
      evaluateScenarioFlow({
        graph: imageGraph,
        conversation: { _id: "conv-1" } as never,
        channel: "whatsapp",
        preferredActionNodeId: "flow-1",
        triggerEventKind: "whatsapp_flow_reply",
        whatsAppFlowResponseJson: responseJson,
        generativeInbound: inbound,
      })?.generativeAI?.input.status
    ).toBe("wrong_type");
  });

  describe("a Flow reply to a prompt that reads form answers", () => {
    /**
     * The reply as the webhook stores it: plain text summarizing every
     * answer, flow token included, which reads as typed text.
     */
    function storedFlowReply(answers: object) {
      const responseJson = JSON.stringify({
        ...answers,
        flow_token: "airi1.token-secret",
      });
      const text = getWhatsAppInboundMessageText({
        id: "wamid.reply",
        from: "77001234567",
        timestamp: "1727690000",
        type: "interactive",
        interactive: {
          type: "nfm_reply",
          nfm_reply: {
            name: "flow",
            body: "Sent",
            response_json: responseJson,
          },
        },
      } as WhatsAppMessage);
      const inbound = buildGenerativeAIInboundCandidate({
        _id: "message-1",
        text,
      } as never);
      expect(inbound).toMatchObject({
        kind: "text",
        textOrCaption: expect.stringContaining("airi1.token-secret"),
      });
      return { responseJson, inbound: inbound! };
    }
    function evaluate(fields: unknown[], prompt: string, answers: object) {
      const { responseJson, inbound } = storedFlowReply(answers);
      const graph = compileScenarioGraph(
        [
          createNode("trigger-1", {
            kind: "trigger",
            triggerConfig: { enabled: true },
          }),
          createNode("flow-1", {
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
                  answersKey: "details",
                  screens: [{ id: "FORM", title: "Details", fields }],
                },
              },
            },
          }),
          createNode("generate", {
            kind: "action",
            actionType: "generative_ai",
            actionGenerativeAIConfig: {
              version: 1,
              mode: "text_to_video",
              prompt,
            },
          }),
        ],
        [
          { source: "trigger-1", target: "flow-1" },
          { source: "flow-1", target: "generate" },
        ]
      );
      return evaluateScenarioFlow({
        graph,
        conversation: { _id: "conv-1" } as never,
        channel: "whatsapp",
        preferredActionNodeId: "flow-1",
        triggerEventKind: "whatsapp_flow_reply",
        whatsAppFlowResponseJson: responseJson,
        generativeInbound: inbound,
      })?.generativeAI?.input;
    }
    /** What the step did with this reply before form answers existed. */
    function asBefore(answers: object) {
      return classifyGenerativeAIInbound({
        expectedInputKind: "text",
        inbound: storedFlowReply(answers).inbound,
      });
    }
    const TEXT_FIELDS = [
      { id: "name", label: "Name", fieldType: "TextInput" },
      { id: "sport", label: "Sport", fieldType: "TextArea" },
      {
        id: "size",
        label: "Size",
        fieldType: "Dropdown",
        options: [{ id: "opt_l", title: "Large" }],
      },
    ];

    it("leaves out only the answers the prompt already names", () => {
      const answers = { name: "Amina", sport: "tennis", size: "opt_l" };
      // Never the stored summary: no flow token, option id or named answer.
      expect(
        evaluate(TEXT_FIELDS, "Film {{form.details.name}}", answers)
      ).toEqual({
        status: "compatible",
        input: {
          messageId: "message-1",
          kind: "text",
          textOrCaption: "Sport: tennis",
          whatsappMediaId: null,
          declaredMimeType: null,
          fileName: null,
        },
      });
      // Every answer named: the reply still starts the generation.
      expect(
        evaluate(
          TEXT_FIELDS,
          "Film {{form.details.name}} playing {{form.details.sport}}",
          answers
        )
      ).toMatchObject({
        status: "compatible",
        input: { messageId: "message-1", kind: "text", textOrCaption: null },
      });
      // A prompt with collected-detail tokens only is handled as before.
      expect(evaluate(TEXT_FIELDS, "Film {{input.name}}", answers)).toEqual(
        asBefore(answers)
      );
    });

    it("starts from a form with no text fields when the prompt reads it", () => {
      const fields = [
        {
          id: "sport",
          label: "Sport",
          fieldType: "Dropdown",
          options: [{ id: "tennis", title: "Tennis" }],
        },
      ];
      expect(
        evaluate(fields, "Film {{form.details.sport}}", { sport: "tennis" })
      ).toMatchObject({
        status: "compatible",
        input: { kind: "text", textOrCaption: null },
      });
      // A prompt that reads no answer is handled as before.
      expect(
        evaluate(fields, "Film a tennis match", { sport: "tennis" })
      ).toEqual(asBefore({ sport: "tennis" }));
    });
  });
});

describe("delayed CTA follow-up routing", () => {
  const kazakh = buildWhatsAppTemplateButtonSourceHandleId(0);
  const russian = buildWhatsAppTemplateButtonSourceHandleId(1);
  const delayWaitId = getScenarioActionBranchDelayVirtualNodeId("menu", kazakh);
  const conversation = { _id: "conv-1" } as never;
  const delayedMenu = createNode("menu", {
    kind: "action",
    actionType: "whatsapp_template",
    actionWhatsAppTemplateName: "pick_lang",
    actionWhatsAppTemplateComponents: [
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Kazakh" },
          { type: "QUICK_REPLY", text: "Russian" },
        ],
      },
    ],
    actionOutcomes: {
      version: 1,
      branchDelays: [{ sourceHandle: kazakh, delayMinutes: 30 }],
    },
  });
  type MenuEntry = "trigger" | "no_reply" | "button";
  const welcome = (entry: MenuEntry) =>
    createNode("welcome", {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "welcome",
      actionWhatsAppTemplateComponents: [
        {
          type: "BUTTONS",
          buttons: [{ type: "QUICK_REPLY", text: "Choose a language" }],
        },
      ],
      ...(entry === "no_reply"
        ? {
            actionOutcomes: {
              version: 1,
              noReply: { enabled: true, timeoutMinutes: 60 },
            },
          }
        : {}),
    });
  const buildGraph = (entry: MenuEntry = "trigger") =>
    compileScenarioGraph(
      [
        createNode("trigger-1", makeClientMessageTriggerNode()),
        ...(entry === "trigger" ? [] : [welcome(entry)]),
        delayedMenu,
        createNode("kazakh", { kind: "action", actionType: "reply" }),
        createNode("russian", { kind: "action", actionType: "reply" }),
      ],
      [
        {
          source: "trigger-1",
          target: entry === "trigger" ? "menu" : "welcome",
        },
        ...(entry === "trigger"
          ? []
          : [
              {
                source: "welcome",
                sourceHandle:
                  entry === "no_reply"
                    ? buildScenarioActionOutcomeHandleId("no_reply")
                    : buildWhatsAppTemplateButtonSourceHandleId(0),
                target: "menu",
              },
            ]),
        { source: "menu", sourceHandle: kazakh, target: "kazakh" },
        { source: "menu", sourceHandle: russian, target: "russian" },
      ]
    );

  it("resolves a tap on the delayed CTA to its wait, not to its target", () => {
    const graph = buildGraph();
    const tap = {
      graph,
      conversation,
      channel: "whatsapp" as const,
      preferredActionNodeId: "menu",
      matchedTriggerNodeId: "trigger-1",
      triggerEventKind: "whatsapp_button_reply" as const,
      quickReplyPayload: buildWhatsAppTemplateButtonPayload("menu", 0),
    };

    expect(graph.diagnostics).toEqual([]);
    const target = resolveInteractiveReplyConditionTarget(tap);
    expect(target?.conditionNode.id).toBe(delayWaitId);
    expect(target?.sourceActionNode.id).toBe("menu");
    expect(target?.pathNodeIds).toEqual(["trigger-1", "menu", delayWaitId]);
    expect(evaluateScenarioFlow(tap)?.selectedAction.id).not.toBe("kazakh");
    const russianTap = {
      ...tap,
      quickReplyPayload: buildWhatsAppTemplateButtonPayload("menu", 1),
    };
    expect(resolveInteractiveReplyConditionTarget(russianTap)).toBeNull();
    expect(evaluateScenarioFlow(russianTap)?.selectedAction.id).toBe("russian");
  });

  it("resolves a tap on a delayed session choice to its wait", () => {
    const choiceHandle =
      buildWhatsAppSessionChoiceSourceHandleId("wsc:menu:help");
    const graph = compileScenarioGraph(
      [
        createNode("trigger-1", makeClientMessageTriggerNode()),
        createNode("menu", {
          kind: "action",
          actionType: "reply",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "reply_buttons",
              body: { mode: "fixed", text: "Choose" },
              options: [{ id: "wsc:menu:help", label: "Help" }],
            },
          },
          actionOutcomes: {
            version: 1,
            branchDelays: [{ sourceHandle: choiceHandle, delayMinutes: 5 }],
          },
        }),
        createNode("help", { kind: "action", actionType: "reply" }),
      ],
      [
        { source: "trigger-1", target: "menu" },
        { source: "menu", sourceHandle: choiceHandle, target: "help" },
      ]
    );

    expect(graph.diagnostics).toEqual([]);
    expect(
      resolveInteractiveReplyConditionTarget({
        graph,
        conversation,
        channel: "whatsapp",
        preferredActionNodeId: "menu",
        triggerEventKind: "whatsapp_button_reply",
        quickReplyPayload: "wsc:menu:help",
      })?.conditionNode.id
    ).toBe(getScenarioActionBranchDelayVirtualNodeId("menu", choiceHandle));
  });

  it.each([
    ["directly after the trigger", "trigger"],
    ["after an earlier action's no-reply outcome", "no_reply"],
    ["after an earlier template button", "button"],
  ] as const)(
    "continues to the CTA's target when the quiet period ends %s",
    (_, entry) => {
      const graph = buildGraph(entry);
      const match = evaluateScenarioFlow({
        graph,
        conversation,
        channel: "whatsapp",
        preferredActionNodeId: "kazakh",
        requiredActionNodeId: "kazakh",
        matchedTriggerNodeId: "trigger-1",
        triggerEventKind: "no_human_reply_timeout",
      });

      expect(graph.diagnostics).toEqual([]);
      expect(match?.selectedAction.id).toBe("kazakh");
      expect(match?.pathNodeIds.slice(-3)).toEqual([
        "menu",
        delayWaitId,
        "kazakh",
      ]);
      expect(
        resolveScenarioDispatchTransition({
          graph,
          selectedAction: match!.selectedAction,
          selectedActionType: match!.selectedActionType,
          selectedPathNodeIds: match!.pathNodeIds,
          conversation,
          channel: "whatsapp",
        })
      ).toEqual({ nextActionNodeId: null, completesScenario: true });
    }
  );
});

describe("template reply buttons with stored ids", () => {
  const conversation = { _id: "conv-1" } as never;
  // As the builder saves the step after Basic is removed from [Basic, Premium]
  // and Gold is added: Premium keeps id 1 and Gold gets the first minted id.
  const premium = buildWhatsAppTemplateButtonSourceHandleId(1);
  const gold = buildWhatsAppTemplateButtonSourceHandleId(10);
  const menuComponents: WhatsAppComponent[] = [
    { type: "BODY", text: "Which plan do you want?" },
    {
      type: "BUTTONS",
      buttons: [
        { type: "QUICK_REPLY", text: "Premium" },
        { type: "QUICK_REPLY", text: "Gold" },
      ],
    },
  ];
  const menuButtonIds = {
    version: 1 as const,
    nextId: 11,
    buttons: [
      { id: 1, index: 0, text: "Premium" },
      { id: 10, index: 1, text: "Gold" },
    ],
  };
  const followUp = (id: string, buttonId: number, label: string) =>
    createNode(id, {
      kind: "action",
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyText: `${label} follow-up`,
      whatsAppTemplateButtonPayload: buildWhatsAppTemplateButtonPayload(
        "menu",
        buttonId
      ),
      whatsAppTemplateButtonLabel: label,
    });
  const buildGraph = (actionOutcomes?: Record<string, unknown>) =>
    compileScenarioGraph(
      [
        createNode("trigger-1", makeClientMessageTriggerNode()),
        createNode("menu", {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: "pick_plan",
          actionWhatsAppTemplateComponents: menuComponents,
          actionWhatsAppTemplateButtonIds: menuButtonIds,
          ...(actionOutcomes ? { actionOutcomes } : {}),
        }),
        followUp("premium-follow-up", 1, "Premium"),
        followUp("gold-follow-up", 10, "Gold"),
      ],
      [
        { source: "trigger-1", target: "menu" },
        { source: "menu", sourceHandle: premium, target: "premium-follow-up" },
        { source: "menu", sourceHandle: gold, target: "gold-follow-up" },
      ]
    );
  const tap = (
    graph: ReturnType<typeof buildGraph>,
    quickReplyPayload: string
  ) => ({
    graph,
    conversation,
    channel: "whatsapp" as const,
    preferredActionNodeId: "menu",
    matchedTriggerNodeId: "trigger-1",
    triggerEventKind: "whatsapp_button_reply" as const,
    quickReplyPayload,
  });

  it("sends each button's id and routes the tap by it", () => {
    const graph = buildGraph();
    const sent = buildScenarioTemplateComponents({
      templateComponents: menuComponents,
      values: {},
      actionNodeId: "menu",
      nodeTemplateComponents: menuComponents,
      templateButtonIds: menuButtonIds,
    });

    expect(graph.diagnostics).toEqual([]);
    expect(sent).toMatchObject([
      { index: "0", parameters: [{ payload: "stb:menu:1" }] },
      { index: "1", parameters: [{ payload: "stb:menu:10" }] },
    ]);
    expect(
      evaluateScenarioFlow(tap(graph, "stb:menu:10"))?.selectedAction.id
    ).toBe("gold-follow-up");
  });

  it("routes a tap sent before the edit to the button it was sent for", () => {
    const graph = buildGraph();

    // Premium's messages sent before Basic was removed carry position 1.
    expect(
      evaluateScenarioFlow(tap(graph, "stb:menu:1"))?.selectedAction.id
    ).toBe("premium-follow-up");
    // Basic's own old tap has no route any more.
    expect(["premium-follow-up", "gold-follow-up"]).not.toContain(
      evaluateScenarioFlow(tap(graph, "stb:menu:0"))?.selectedAction.id
    );
  });

  it("keeps the delay wait id of a button that kept its id", () => {
    const graph = buildGraph({
      version: 1,
      branchDelays: [{ sourceHandle: premium, delayMinutes: 30 }],
    });

    expect(graph.diagnostics).toEqual([]);
    // The id the wait had before the edit, when Premium sat at position 1.
    expect(
      resolveInteractiveReplyConditionTarget(tap(graph, "stb:menu:1"))
        ?.conditionNode.id
    ).toBe(
      "__system:action-branch-delay:menu:right-source-whatsapp-template-button-branch%3A%3A1"
    );
    expect(
      resolveInteractiveReplyConditionTarget(tap(graph, "stb:menu:10"))
    ).toBeNull();
  });

  it("handles a tap on a button sent without a payload as a typed reply", () => {
    // WhatsApp returns the label as the payload when the send had none.
    const graph = buildGraph();
    const triggerEventKind = resolveWhatsAppInteractiveReplyTriggerEventKind({
      isWhatsAppFlowReply: false,
      messageType: "button",
      quickReplyPayload: "Silver",
    });
    const typedReply = {
      graph,
      conversation,
      channel: "whatsapp" as const,
      matchedTriggerNodeId: "trigger-1",
    };

    expect(triggerEventKind).toBeUndefined();
    expect(
      resolveScenarioStructuredReplyActionNodeId({
        triggerEventKind,
        quickReplyPayload: "Silver",
      })
    ).toBeNull();
    for (const preferredActionNodeId of [undefined, "menu"]) {
      expect(
        evaluateScenarioFlow({
          ...typedReply,
          preferredActionNodeId,
          triggerEventKind,
          quickReplyPayload: "Silver",
        })
      ).toEqual(evaluateScenarioFlow({ ...typedReply, preferredActionNodeId }));
    }
  });
});

describe("a template's Form submitted route", () => {
  const conversation = { _id: "conv-form" } as never;
  const channel = "whatsapp" as const;
  const formSubmitted = ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID;
  const noReply = buildScenarioActionOutcomeHandleId("no_reply");
  const outcomeWaitId = getScenarioActionOutcomeVirtualNodeId("medal");
  const reply = (id: string, data: Record<string, unknown> = {}) =>
    createNode(id, {
      kind: "action",
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyText: id,
      ...data,
    });
  const medal = (data: Record<string, unknown> = {}) =>
    createNode(
      "medal",
      medalTemplateStep({
        actionWhatsAppTemplateName: "medal_pick_1",
        actionOutcomes: {
          version: 1,
          noReply: { enabled: true, timeoutMinutes: 30 },
        },
        ...data,
      })
    );
  // DemoShop's medal_pick_1 --Form submitted--> carousel --> AI, with the
  // template's other output listed first so node order alone would pick it.
  const scenario = (
    template = medal(),
    extraEdges: Array<{
      source: string;
      target: string;
      sourceHandle?: string;
    }> = []
  ) => ({
    entryPolicy: "repeatable" as const,
    nodes: [
      createNode("trigger-1", makeClientMessageTriggerNode()),
      reply("then"),
      template,
      reply("carousel", {
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: { mode: "fixed", text: "Pick a frame" },
            options: [{ id: "wsc:carousel:gold", label: "Gold" }],
          },
        },
      }),
      reply("ai"),
      reply("reminder"),
    ],
    edges: [
      { source: "trigger-1", target: "medal" },
      { source: "medal", sourceHandle: "right-source", target: "then" },
      { source: "medal", sourceHandle: formSubmitted, target: "carousel" },
      {
        source: "carousel",
        sourceHandle:
          buildWhatsAppSessionChoiceSourceHandleId("wsc:carousel:gold"),
        target: "ai",
      },
      { source: "medal", sourceHandle: noReply, target: "reminder" },
      ...extraEdges,
    ],
  });
  const graphOf = (record: ReturnType<typeof scenario>) =>
    compileScenarioGraph(record.nodes, record.edges);
  const waitingOnMedal = {
    currentActionNodeId: "medal",
    currentPathNodeIds: ["trigger-1", "medal"],
  };
  const flowReply = {
    triggerEventKind: "whatsapp_flow_reply" as const,
    whatsAppFlowResponseJson: JSON.stringify({
      __9ba1c9: "1_Таэквондо_/_Каратэ_/_Күрес",
      flow_token: "flow_1",
    }),
  };

  it("follows the route when the reply submits the template's own form", () => {
    const record = scenario();
    const continuation = {
      scenario: record,
      ...waitingOnMedal,
      eventKind: flowReply.triggerEventKind,
      flowReplySourceActionNodeId: "medal",
    };

    expect(resolvePreferredContinuationActionNodeId(continuation)).toBe(
      "medal"
    );
    expect(shouldPinLockedScenarioForEvent(continuation)).toBe(true);
    const match = evaluateScenarioFlow({
      graph: graphOf(record),
      conversation,
      channel,
      preferredActionNodeId: "medal",
      flowReplySourceActionNodeId: "medal",
      ...flowReply,
    });
    expect(match?.selectedAction.id).toBe("carousel");
    expect(match?.pathNodeIds).toEqual(["trigger-1", "medal", "carousel"]);
  });

  it.each([
    ["linked", MEDAL_FLOW_ID],
    ["stale", "1571793974235171"],
  ])(
    "takes no route from a template with a %s Flow config for a reply to another form",
    (_, metaFlowId) => {
      const record = scenario(
        medal({
          actionFlowConfig: {
            templateId: "",
            ctaText: "",
            screens: [],
            metaFlowId,
          },
        })
      );
      const fromMedal = {
        graph: graphOf(record),
        conversation,
        channel,
        preferredActionNodeId: "medal",
        ...flowReply,
      };

      for (const flowReplySourceActionNodeId of [undefined, "then", "ai"]) {
        // The Flow config keeps the template waiting on any Flow reply...
        expect(
          resolvePreferredContinuationActionNodeId({
            scenario: record,
            ...waitingOnMedal,
            eventKind: flowReply.triggerEventKind,
            flowReplySourceActionNodeId,
          })
        ).toBe("medal");
        // ...yet only a reply to its own form takes its route.
        expect(
          evaluateScenarioFlow({ ...fromMedal, flowReplySourceActionNodeId })
        ).toBeNull();
      }
      expect(
        evaluateScenarioFlow({
          ...fromMedal,
          flowReplySourceActionNodeId: "medal",
        })?.selectedAction.id
      ).toBe("carousel");
    }
  );

  it("does not pin a reply whose form no step of this scenario is known to have sent", () => {
    const record = scenario();
    for (const flowReplySourceActionNodeId of [undefined, "then", "ai"]) {
      const continuation = {
        scenario: record,
        ...waitingOnMedal,
        eventKind: flowReply.triggerEventKind,
        flowReplySourceActionNodeId,
      };
      expect(
        resolvePreferredContinuationActionNodeId(continuation)
      ).toBeUndefined();
      expect(shouldPinLockedScenarioForEvent(continuation)).toBe(false);
    }
    // Without the waiting step, a Flow reply crosses no route.
    expect(
      evaluateScenarioFlow({
        graph: graphOf(record),
        conversation,
        channel,
        ...flowReply,
      })
    ).toBeNull();
  });

  it("reaches the first step through the route, past steps that only pass it on", () => {
    const record = scenario();
    const withContext = {
      ...record,
      nodes: [...record.nodes, createNode("context-1", { kind: "context" })],
      edges: [
        ...record.edges.filter(edge => edge.sourceHandle !== formSubmitted),
        { source: "medal", sourceHandle: formSubmitted, target: "context-1" },
        { source: "context-1", target: "carousel" },
      ],
    };

    expect(
      evaluateScenarioFlow({
        graph: graphOf(withContext),
        conversation,
        channel,
        preferredActionNodeId: "medal",
        flowReplySourceActionNodeId: "medal",
        ...flowReply,
      })?.pathNodeIds
    ).toEqual(["trigger-1", "medal", "context-1", "carousel"]);
    // A route back to the template never sends the form it answered again.
    const loop = {
      ...withContext,
      edges: withContext.edges.map(edge =>
        edge.source === "context-1" ? { ...edge, target: "medal" } : edge
      ),
    };
    expect(
      evaluateScenarioFlow({
        graph: graphOf(loop),
        conversation,
        channel,
        preferredActionNodeId: "medal",
        flowReplySourceActionNodeId: "medal",
        ...flowReply,
      })
    ).toBeNull();
  });

  it("reaches a step that other steps' buttons also lead to", () => {
    const record = scenario();
    const stamped = {
      ...record,
      nodes: record.nodes.map(item =>
        item.id === "carousel"
          ? createNode("carousel", {
              ...item.data,
              // Stamped by a template button and a session choice that also
              // lead here from other steps.
              whatsAppTemplateButtonPayload: buildWhatsAppTemplateButtonPayload(
                "promo",
                0
              ),
              whatsAppSessionChoicePayload: buildWhatsAppSessionChoicePayload({
                actionNodeId: "then",
                choiceId: "frame",
              }),
            })
          : item
      ),
    };

    expect(
      evaluateScenarioFlow({
        graph: graphOf(stamped),
        conversation,
        channel,
        preferredActionNodeId: "medal",
        flowReplySourceActionNodeId: "medal",
        ...flowReply,
      })?.pathNodeIds
    ).toEqual(["trigger-1", "medal", "carousel"]);
    // A reply to another form still takes no route.
    expect(
      evaluateScenarioFlow({
        graph: graphOf(stamped),
        conversation,
        channel,
        preferredActionNodeId: "medal",
        flowReplySourceActionNodeId: "then",
        ...flowReply,
      })
    ).toBeNull();
  });

  it("keeps a typed reply waiting on the template, as on a template with buttons", () => {
    const record = scenario();
    const typed = {
      scenario: record,
      ...waitingOnMedal,
      eventKind: "inbound_message" as const,
    };

    expect(resolvePreferredContinuationActionNodeId(typed)).toBeUndefined();
    expect(shouldPinLockedScenarioForEvent(typed)).toBe(false);
    // Without the route, typed text continued on the template.
    const withoutRoute = {
      ...record,
      edges: record.edges.filter(edge => edge.sourceHandle !== formSubmitted),
    };
    expect(
      resolvePreferredContinuationActionNodeId({
        ...typed,
        scenario: withoutRoute,
      })
    ).toBe("medal");
  });

  it("does not send the route's step on typed text after an older worker queued it", () => {
    // An older worker walked the route right after sending the template.
    const record = scenario(medal({ actionOutcomes: undefined }));
    const queued = {
      scenario: record,
      currentActionNodeId: "carousel",
      currentPathNodeIds: ["trigger-1", "medal"],
      eventKind: "inbound_message" as const,
    };

    expect(resolvePreferredContinuationActionNodeId(queued)).toBeUndefined();
    expect(shouldPinLockedScenarioForEvent(queued)).toBe(false);
    // A plain output still sends the buttons queued after the template.
    expect(
      resolvePreferredContinuationActionNodeId({
        ...queued,
        scenario: {
          ...record,
          edges: record.edges.map(edge =>
            edge.sourceHandle === formSubmitted
              ? { ...edge, sourceHandle: "right-source" }
              : edge
          ),
        },
      })
    ).toBe("carousel");
  });

  it("sends the No reply step past the form's route, even to the same step", () => {
    const record = scenario();
    const timer = {
      graph: graphOf(record),
      conversation,
      channel,
      continuationSourceActionNodeId: "medal",
      triggerEventKind: "no_human_reply_timeout" as const,
    };

    expect(
      evaluateScenarioFlow({ ...timer, requiredActionNodeId: "reminder" })
        ?.pathNodeIds
    ).toEqual(["trigger-1", "medal", outcomeWaitId, "reminder"]);
    // Only the form's route leads to its step: a timer cannot take it.
    expect(
      evaluateScenarioFlow({ ...timer, requiredActionNodeId: "carousel" })
    ).toBeNull();
    // When No reply leads there too, the timer goes through the wait.
    const sameStep = {
      ...record,
      edges: record.edges.map(edge =>
        edge.sourceHandle === noReply ? { ...edge, target: "carousel" } : edge
      ),
    };
    expect(
      evaluateScenarioFlow({
        ...timer,
        graph: graphOf(sameStep),
        requiredActionNodeId: "carousel",
      })?.pathNodeIds
    ).toEqual(["trigger-1", "medal", outcomeWaitId, "carousel"]);
  });

  // DemoShop after linking the route and before deleting Then: both lead to
  // the carousel.
  describe("while Then still leads to the same step", () => {
    const withThenToCarousel = (template = medal()) => {
      const record = scenario(template);
      return {
        ...record,
        edges: record.edges.map(edge =>
          edge.source === "medal" && edge.sourceHandle === "right-source"
            ? { ...edge, target: "carousel" }
            : edge
        ),
      };
    };

    it.each([
      ["with", medal(), outcomeWaitId],
      ["without", medal({ actionOutcomes: undefined }), null],
    ])(
      "holds the template after the send %s outcomes",
      (_, template, pendingConditionNodeId) => {
        const record = withThenToCarousel(template);
        const graph = graphOf({
          ...record,
          // No reply's route needs its outcome.
          edges: record.edges.filter(
            edge => pendingConditionNodeId || edge.sourceHandle !== noReply
          ),
        });
        expect(graph.diagnostics).toEqual([]);
        expect(
          resolveScenarioDispatchTransition({
            graph,
            selectedAction: graph.nodesById.get("medal")!,
            selectedActionType: "whatsapp_template",
            conversation,
            channel,
          })
        ).toMatchObject({
          nextActionNodeId: "medal",
          completesScenario: false,
          pendingConditionNodeId,
        });
      }
    );

    it("keeps a typed reply waiting on the template", () => {
      const typed = {
        scenario: withThenToCarousel(),
        ...waitingOnMedal,
        eventKind: "inbound_message" as const,
      };

      expect(resolvePreferredContinuationActionNodeId(typed)).toBeUndefined();
      expect(shouldPinLockedScenarioForEvent(typed)).toBe(false);
    });

    it("sends the carousel for a reply to the template's own form", () => {
      const record = withThenToCarousel();
      const continuation = {
        scenario: record,
        ...waitingOnMedal,
        eventKind: flowReply.triggerEventKind,
        flowReplySourceActionNodeId: "medal",
      };

      expect(resolvePreferredContinuationActionNodeId(continuation)).toBe(
        "medal"
      );
      expect(shouldPinLockedScenarioForEvent(continuation)).toBe(true);
      expect(
        evaluateScenarioFlow({
          graph: graphOf(record),
          conversation,
          channel,
          preferredActionNodeId: "medal",
          flowReplySourceActionNodeId: "medal",
          ...flowReply,
        })?.pathNodeIds
      ).toEqual(["trigger-1", "medal", "carousel"]);
    });

    it("does not pin a Flow reply no step of this scenario is known to have sent", () => {
      const record = withThenToCarousel();
      for (const flowReplySourceActionNodeId of [undefined, "ai"]) {
        const continuation = {
          scenario: record,
          ...waitingOnMedal,
          eventKind: flowReply.triggerEventKind,
          flowReplySourceActionNodeId,
        };
        expect(
          resolvePreferredContinuationActionNodeId(continuation)
        ).toBeUndefined();
        expect(shouldPinLockedScenarioForEvent(continuation)).toBe(false);
        expect(
          evaluateScenarioFlow({
            graph: graphOf(record),
            conversation,
            channel,
            preferredActionNodeId: "medal",
            flowReplySourceActionNodeId,
            ...flowReply,
          })
        ).toBeNull();
      }
    });

    it("sends the No reply step when No reply times out", () => {
      expect(
        evaluateScenarioFlow({
          graph: graphOf(withThenToCarousel()),
          conversation,
          channel,
          continuationSourceActionNodeId: "medal",
          triggerEventKind: "no_human_reply_timeout",
          requiredActionNodeId: "reminder",
        })?.pathNodeIds
      ).toEqual(["trigger-1", "medal", outcomeWaitId, "reminder"]);
    });
  });

  it("keeps the template's buttons and its form on their own routes", () => {
    const callMe = buildWhatsAppTemplateButtonPayload("medal", 0);
    const mixed = medal({
      actionWhatsAppTemplateComponents: [
        {
          type: "BUTTONS",
          buttons: [
            { type: "QUICK_REPLY", text: "Call me" },
            { type: "FLOW", text: "Choose", flow_id: 2244981489363579 },
          ],
        },
      ],
    });
    const graph = graphOf(
      scenario(mixed, [
        {
          source: "medal",
          sourceHandle: buildWhatsAppTemplateButtonSourceHandleId(0),
          target: "ai",
        },
      ])
    );
    const fromMedal = {
      graph,
      conversation,
      channel,
      preferredActionNodeId: "medal",
    };

    expect(
      evaluateScenarioFlow({
        ...fromMedal,
        ...flowReply,
        flowReplySourceActionNodeId: "medal",
      })?.selectedAction.id
    ).toBe("carousel");
    expect(
      evaluateScenarioFlow({
        ...fromMedal,
        triggerEventKind: "whatsapp_button_reply",
        quickReplyPayload: callMe,
      })?.pathNodeIds
    ).toEqual(["trigger-1", "medal", "ai"]);
    // A tap on a button with no route of its own never takes the form's.
    expect(
      evaluateScenarioFlow({
        ...fromMedal,
        graph: graphOf(scenario(mixed)),
        triggerEventKind: "whatsapp_button_reply",
        quickReplyPayload: callMe,
      })
    ).toBeNull();
  });

  it("routes later replies along a path that took the form's route", () => {
    const record = scenario();
    const graph = graphOf(record);

    // A tap on the step the form's route led to.
    expect(
      evaluateScenarioFlow({
        graph,
        conversation,
        channel,
        preferredActionNodeId: "carousel",
        triggerEventKind: "whatsapp_button_reply",
        quickReplyPayload: "wsc:carousel:gold",
      })?.pathNodeIds
    ).toEqual(["trigger-1", "medal", "carousel", "ai"]);
    // Typed text that sends the step queued after a plain message.
    const plain = {
      ...record,
      nodes: record.nodes.map(item =>
        item.id === "carousel" ? reply("carousel") : item
      ),
      edges: [
        ...record.edges.filter(edge => edge.source !== "carousel"),
        { source: "carousel", target: "ai" },
      ],
    };
    const queued = {
      scenario: plain,
      currentActionNodeId: "ai",
      currentPathNodeIds: ["trigger-1", "medal", "carousel"],
      eventKind: "inbound_message" as const,
    };
    expect(resolvePreferredContinuationActionNodeId(queued)).toBe("ai");
    expect(
      evaluateScenarioFlow({
        graph: graphOf(plain),
        conversation,
        channel,
        preferredActionNodeId: "ai",
        triggerEventKind: "inbound_message",
      })?.pathNodeIds
    ).toEqual(["trigger-1", "medal", "carousel", "ai"]);
  });
});
