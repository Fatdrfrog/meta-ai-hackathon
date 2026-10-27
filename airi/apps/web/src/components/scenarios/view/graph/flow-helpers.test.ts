import {
  getPostActionAnswerMatchHandleId,
  getPostActionConditionHandleId,
} from "@icecore/scenario-contracts";
import {
  PROMPT_INPUTS_UNMET_HANDLE,
  ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
  ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
  GENERATIVE_AI_FAILURE_HANDLE,
  GENERATIVE_AI_SUCCESS_HANDLE,
  buildFlowBranchSourceHandleId,
  buildTelegramBranchSourceHandleId,
  buildWhatsAppSessionChoiceSourceHandleId,
  buildWhatsAppTemplateButtonSourceHandleId,
} from "@icecore/scenario-contracts";
import { normalizeScenarioEdges } from "../../graph/edge-normalization";
import { createScenarioGraphId } from "../../graph/id";
import {
  isValidSourceHandleForNode,
  resolveAvailableSourceHandleIds,
  resolveConnectionSourceHandleId,
} from "../../graph/source-handles";
import type {
  ScenarioFlowNode,
  ScenarioNodeData,
  WhatsAppFlowConfig,
} from "../../types";

function createNode(id: string, data: ScenarioNodeData): ScenarioFlowNode {
  return {
    id,
    type:
      data.kind === "action"
        ? "actionNode"
        : data.kind === "trigger"
          ? "triggerNode"
          : data.kind === "scenario_link"
            ? "scenarioLinkNode"
            : "scenarioNode",
    position: { x: 0, y: 0 },
    data,
  };
}

function createWhatsAppFlowAction(
  flowConfig: WhatsAppFlowConfig
): ScenarioNodeData {
  return {
    kind: "action",
    actionType: "reply",
    actionWhatsAppServiceMessage: {
      version: 1,
      message: {
        kind: "flow",
        body: { mode: "fixed", text: "Open the form" },
        flowConfig,
      },
    },
  };
}

function createWhatsAppReplyButtonsAction(
  options: Array<{ id: string; label: string }>
): ScenarioNodeData {
  return {
    kind: "action",
    actionType: "reply",
    actionWhatsAppServiceMessage: {
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Choose" },
        options,
      },
    },
  };
}

const ONE = [{ id: "one", title: "One" }];

function radioFlowConfig(
  options = [
    { id: "one", title: "One" },
    { id: "two", title: "Two" },
  ]
): WhatsAppFlowConfig {
  return {
    templateId: "template-1",
    ctaText: "Open",
    screens: [
      {
        id: "screen-1",
        title: "Screen",
        fields: [
          {
            id: "field-1",
            label: "Choose",
            fieldType: "RadioButtonsGroup",
            options,
          },
        ],
      },
    ],
  };
}

function replyNode(id: string, binding: Record<string, unknown> = {}) {
  return createNode(id, {
    kind: "action",
    actionType: "reply",
    ...binding,
  } as ScenarioNodeData);
}

function kazakhTemplateAction() {
  return createNode("template-action", {
    kind: "action",
    actionType: "whatsapp_template",
    actionWhatsAppTemplateComponents: [
      { type: "BODY", text: "Choose language" },
      {
        type: "BUTTONS",
        buttons: [{ type: "QUICK_REPLY", text: "Kazakh" }],
      },
    ],
  });
}

function yesTelegramAction() {
  return createNode("telegram-action", {
    kind: "action",
    actionType: "reply",
    actionTelegramQuickReplies: [{ text: "Yes", payload: "yes" }],
  });
}

/** Normalizes one source-to-target edge and expects it on expectedHandle. */
function expectNormalizedEdge(
  source: ScenarioFlowNode,
  target: ScenarioFlowNode,
  edge: { id: string; sourceHandle: string },
  expectedHandle = edge.sourceHandle
) {
  expect(
    normalizeScenarioEdges(
      [source, target],
      [{ ...edge, source: source.id, target: target.id }]
    )
  ).toMatchObject([
    {
      id: edge.id,
      source: source.id,
      target: target.id,
      sourceHandle: expectedHandle,
      targetHandle: "left-target",
    },
  ]);
}

describe("createScenarioGraphId", () => {
  it("keeps ids unique when multiple graph nodes are created in the same tick", () => {
    const dateSpy = jest.spyOn(Date, "now").mockReturnValue(1234567890);
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.123);

    try {
      const ids = [
        createScenarioGraphId("node"),
        createScenarioGraphId("node"),
        createScenarioGraphId("node"),
      ];

      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      dateSpy.mockRestore();
      randomSpy.mockRestore();
    }
  });
});

describe("resolveAvailableSourceHandleIds", () => {
  it("keeps the default continuation and adds the unmet detail handle", () => {
    const node = createNode("ask", {
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "text",
          body: { mode: "fixed", text: "Tell me your name and sport." },
          previewUrl: false,
        },
        promptInputs: [{ key: "name", label: "Name", prompt: "customer name" }],
      },
    });

    expect(resolveAvailableSourceHandleIds(node)).toEqual([
      "right-source",
      PROMPT_INPUTS_UNMET_HANDLE,
    ]);
  });

  it("keeps a choice ask on its options and adds only the unmet detail handle", () => {
    const node = createNode("ask", {
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Pick a frame, then send the name." },
          options: [{ id: "wsc:ask:gold", label: "Gold" }],
        },
        promptInputs: [{ key: "name", label: "Name", prompt: "customer name" }],
      },
    });

    const handles = resolveAvailableSourceHandleIds(node);
    expect(handles).toContain(PROMPT_INPUTS_UNMET_HANDLE);
    expect(handles).toContain(
      buildWhatsAppSessionChoiceSourceHandleId("wsc:ask:gold")
    );
    expect(handles).not.toContain("right-source");
  });

  it("exposes only fixed Generative AI outcomes", () => {
    const node = createNode("generate", {
      kind: "action",
      actionType: "generative_ai",
      actionGenerativeAIConfig: {
        version: 1,
        mode: "text_to_video",
        prompt: "Create a launch video",
      },
      actionOutcomes: {
        version: 1,
        anyReply: { enabled: true },
      },
      actionWhatsAppTemplateComponents: [
        {
          type: "BUTTONS",
          buttons: [{ type: "QUICK_REPLY", text: "Stale" }],
        },
      ],
    });

    expect(resolveAvailableSourceHandleIds(node)).toEqual([
      GENERATIVE_AI_SUCCESS_HANDLE,
      GENERATIVE_AI_FAILURE_HANDLE,
    ]);
  });

  it("exposes one right-side source handle for bulk campaign nodes", () => {
    const node = createNode("bulk-1", {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "VIP reactivation",
        recipientSourceSummary: "Upload recipients",
        generationStatus: "idle",
      },
    });

    expect(resolveAvailableSourceHandleIds(node)).toEqual([
      BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
    ]);
  });

  it("exposes canonical Telegram branch handles for Telegram builders", () => {
    const node = createNode("telegram-action", {
      kind: "action",
      actionType: "reply",
      actionTelegramQuickReplies: [
        { text: "Yes", payload: "yes" },
        { text: "No", payload: "no" },
      ],
    });

    expect(resolveAvailableSourceHandleIds(node)).toEqual([
      ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID,
      buildTelegramBranchSourceHandleId("yes"),
      buildTelegramBranchSourceHandleId("no"),
    ]);
  });

  it("exposes Flow branch handles for WhatsApp template actions with flow-only buttons and RadioButtonsGroup config", () => {
    const node = createNode("template-flow-action", {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateComponents: [
        {
          type: "BUTTONS",
          buttons: [{ type: "FLOW", text: "Open", flow_id: "flow-123" }],
        },
      ],
      actionFlowConfig: radioFlowConfig(),
    });

    const sourceHandles = resolveAvailableSourceHandleIds(node);
    expect(sourceHandles).toEqual([
      ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
      buildFlowBranchSourceHandleId("field-1", "one"),
      buildFlowBranchSourceHandleId("field-1", "two"),
    ]);
  });

  it("exposes Flow branch handles for mixed WhatsApp template buttons when the linked flow id is shared", () => {
    const node = createNode("mixed-template-flow-action", {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateComponents: [
        {
          type: "BUTTONS",
          buttons: [
            { type: "QUICK_REPLY", text: "Talk to agent" },
            { type: "FLOW", text: "Open", flow_id: "flow-123" },
          ],
        },
      ],
      actionFlowConfig: radioFlowConfig(),
    });

    expect(resolveAvailableSourceHandleIds(node)).toEqual([
      ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
      buildFlowBranchSourceHandleId("field-1", "one"),
      buildFlowBranchSourceHandleId("field-1", "two"),
      ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID,
      buildWhatsAppTemplateButtonSourceHandleId(0),
    ]);
  });

  it("exposes both reply continuation and branch handles for WhatsApp template quick-reply buttons", () => {
    const node = createNode("template-action", {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Choose language" },
        {
          type: "BUTTONS",
          buttons: [
            { type: "QUICK_REPLY", text: "Kazakh" },
            { type: "URL", text: "Website", url: "https://example.com" },
            { type: "PHONE_NUMBER", text: "Call", phone_number: "7700" },
            { type: "QUICK_REPLY", text: "Russian" },
          ],
        },
      ],
    });

    expect(resolveAvailableSourceHandleIds(node)).toEqual([
      "right-source",
      ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID,
      buildWhatsAppTemplateButtonSourceHandleId(0),
      buildWhatsAppTemplateButtonSourceHandleId(3),
    ]);
  });

  it("exposes canonical WhatsApp session choice branch handles", () => {
    const node = createNode(
      "whatsapp-session-action",
      createWhatsAppReplyButtonsAction([
        { id: "wsc:action:pricing", label: "Pricing" },
        { id: "wsc:action:support", label: "Support" },
      ])
    );

    expect(resolveAvailableSourceHandleIds(node)).toEqual([
      ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID,
      buildWhatsAppSessionChoiceSourceHandleId("wsc:action:pricing"),
      buildWhatsAppSessionChoiceSourceHandleId("wsc:action:support"),
    ]);
  });

  it("exposes only canonical Flow branch handles for WhatsApp Flow builders", () => {
    const node = createNode(
      "flow-action",
      createWhatsAppFlowAction(radioFlowConfig())
    );

    expect(resolveAvailableSourceHandleIds(node)).toEqual([
      ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
      buildFlowBranchSourceHandleId("field-1", "one"),
      buildFlowBranchSourceHandleId("field-1", "two"),
    ]);
  });

  it("exposes only the timeout branch handle for dedicated interactive no-reply nodes", () => {
    const node = createNode("no-reply", {
      kind: "logic",
      logicType: "post_action_condition",
      postActionConditionVariant: "interactive_no_reply",
      interactiveNoReplySurface: "telegram_builder",
    });

    expect(resolveAvailableSourceHandleIds(node)).toEqual([
      getPostActionConditionHandleId("no_reply_timeout"),
    ]);
  });

  it("exposes configured no-reply answer match handles on standard condition nodes", () => {
    const node = createNode("condition-answers", {
      kind: "logic",
      logicType: "post_action_condition",
      conditionBranches: [
        { id: "user_replied", type: "user_replied" },
        {
          id: "no_reply_timeout",
          type: "no_reply_timeout",
          answerMatchRules: [
            { id: "yes", mode: "exact", text: "yes" },
            { id: "pricing", mode: "intent", text: "asking about price" },
          ],
        },
      ],
    });

    expect(resolveAvailableSourceHandleIds(node)).toEqual([
      getPostActionConditionHandleId("user_replied"),
      getPostActionConditionHandleId("no_reply_timeout"),
      getPostActionAnswerMatchHandleId("yes"),
      getPostActionAnswerMatchHandleId("pricing"),
    ]);
  });

  it("exposes configured no-reply answer match handles on interactive no-reply nodes", () => {
    const node = createNode("interactive-answers", {
      kind: "logic",
      logicType: "post_action_condition",
      postActionConditionVariant: "interactive_no_reply",
      interactiveNoReplySurface: "telegram_builder",
      conditionBranches: [
        {
          id: "no_reply_timeout",
          type: "no_reply_timeout",
          answerMatchRules: [{ id: "yes", mode: "exact", text: "yes" }],
        },
      ],
    });

    expect(resolveAvailableSourceHandleIds(node)).toEqual([
      getPostActionConditionHandleId("no_reply_timeout"),
      getPostActionAnswerMatchHandleId("yes"),
    ]);
  });

  it("drops legacy payment branch edges from post-action condition nodes", () => {
    const conditionNode = createNode("condition-1", {
      kind: "logic",
      logicType: "post_action_condition",
    });
    const targetNode = replyNode("target-1");

    const normalizedEdges = normalizeScenarioEdges(
      [conditionNode, targetNode],
      [
        {
          id: "edge-payment",
          source: conditionNode.id,
          target: targetNode.id,
          sourceHandle: getPostActionConditionHandleId("payment_detected"),
        },
      ]
    );

    expect(normalizedEdges).toEqual([]);
  });

  it("preserves configured answer match branch edges and drops stale deleted rule edges", () => {
    const conditionNode = createNode("condition-answers", {
      kind: "logic",
      logicType: "post_action_condition",
      conditionBranches: [
        { id: "user_replied", type: "user_replied" },
        {
          id: "no_reply_timeout",
          type: "no_reply_timeout",
          answerMatchRules: [{ id: "yes", mode: "exact", text: "yes" }],
        },
      ],
    });
    const targetNode = replyNode("target-yes");

    const normalizedEdges = normalizeScenarioEdges(
      [conditionNode, targetNode],
      [
        {
          id: "edge-yes",
          source: conditionNode.id,
          target: targetNode.id,
          sourceHandle: getPostActionAnswerMatchHandleId("yes"),
        },
        {
          id: "edge-stale",
          source: conditionNode.id,
          target: targetNode.id,
          sourceHandle: getPostActionAnswerMatchHandleId("deleted"),
        },
      ]
    );

    expect(normalizedEdges).toMatchObject([
      {
        id: "edge-yes",
        source: conditionNode.id,
        target: targetNode.id,
        sourceHandle: getPostActionAnswerMatchHandleId("yes"),
        targetHandle: "left-target",
      },
    ]);
  });

  it("preserves option-specific WhatsApp flow branch handles", () => {
    expectNormalizedEdge(
      createNode("flow-action", createWhatsAppFlowAction(radioFlowConfig(ONE))),
      replyNode("target-1"),
      {
        id: "edge-one",
        sourceHandle: buildFlowBranchSourceHandleId("field-1", "one"),
      }
    );
  });

  it("canonicalizes the historical generic Flow no-reply alias", () => {
    const sourceNode = createNode(
      "flow-action",
      createWhatsAppFlowAction(radioFlowConfig(ONE))
    );
    const targetNode = createNode("condition-1", {
      kind: "logic",
      logicType: "post_action_condition",
      postActionConditionVariant: "interactive_no_reply",
      interactiveNoReplySurface: "whatsapp_flow",
    });
    const specificHandle = buildFlowBranchSourceHandleId("field-1", "one");

    const normalizedEdges = normalizeScenarioEdges(
      [sourceNode, targetNode],
      [
        {
          id: "legacy-flow-alias",
          source: sourceNode.id,
          target: targetNode.id,
          sourceHandle: ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
        },
        {
          id: "specific-flow-option",
          source: sourceNode.id,
          target: targetNode.id,
          sourceHandle: specificHandle,
        },
      ]
    );

    expect(normalizedEdges.map(edge => edge.sourceHandle)).toEqual([
      ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
      specificHandle,
    ]);
  });

  it("migrates canonical WhatsApp flow branch edges to the target option handle when binding data exists", () => {
    expectNormalizedEdge(
      createNode("flow-action", createWhatsAppFlowAction(radioFlowConfig(ONE))),
      replyNode("target-1", {
        flowBranchSourceFieldId: "field-1",
        flowBranchOptionId: "one",
        flowBranchOptionLabel: "One",
      }),
      { id: "edge-one", sourceHandle: ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID },
      buildFlowBranchSourceHandleId("field-1", "one")
    );
  });

  it("preserves option-specific WhatsApp template button branch handles", () => {
    expectNormalizedEdge(kazakhTemplateAction(), replyNode("target-1"), {
      id: "edge-template-button",
      sourceHandle: buildWhatsAppTemplateButtonSourceHandleId(0),
    });
  });

  it("preserves WhatsApp template no-reply source handles", () => {
    expectNormalizedEdge(
      kazakhTemplateAction(),
      createNode("no-reply", {
        kind: "logic",
        logicType: "post_action_condition",
      }),
      {
        id: "edge-no-reply",
        sourceHandle: ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
      }
    );
  });

  it("migrates canonical WhatsApp session choice edges to the target option handle when binding data exists", () => {
    expectNormalizedEdge(
      createNode(
        "whatsapp-session-action",
        createWhatsAppReplyButtonsAction([
          { id: "wsc:action:pricing", label: "Pricing" },
        ])
      ),
      replyNode("target-1", {
        whatsAppSessionChoicePayload: "wsc:action:pricing",
        whatsAppSessionChoiceLabel: "Pricing",
      }),
      {
        id: "edge-pricing",
        sourceHandle: ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID,
      },
      buildWhatsAppSessionChoiceSourceHandleId("wsc:action:pricing")
    );
  });

  it("preserves option-specific Telegram branch handles", () => {
    expectNormalizedEdge(yesTelegramAction(), replyNode("target-1"), {
      id: "edge-yes",
      sourceHandle: buildTelegramBranchSourceHandleId("yes"),
    });
  });

  it("migrates canonical Telegram branch edges to the target option handle when binding data exists", () => {
    expectNormalizedEdge(
      yesTelegramAction(),
      replyNode("target-1", {
        telegramBranchPayload: "yes",
        telegramBranchLabel: "Yes",
      }),
      { id: "edge-yes", sourceHandle: ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID },
      buildTelegramBranchSourceHandleId("yes")
    );
  });
});

describe("a template's Form submitted route", () => {
  const FORM_SUBMITTED = ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID;
  // Meta returns DemoShop's Flow id as a number.
  const formButton = {
    type: "FLOW" as const,
    text: "Open form",
    flow_id: 1571793974235171,
  };
  const quickReply = { type: "QUICK_REPLY" as const, text: "Yes" };
  const template = (
    buttons: Array<typeof formButton | typeof quickReply>,
    extra: Partial<ScenarioNodeData> = {}
  ) =>
    createNode("template", {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Tell us about the athlete" },
        { type: "BUTTONS", buttons },
      ],
      ...extra,
    });
  const formOnly = template([formButton]);
  const mixed = template([quickReply, formButton]);
  const quickRepliesOnly = template([quickReply]);
  const flowChoices = template([formButton], {
    actionReplyCtaType: "flow",
    actionFlowConfig: {
      templateId: "pick",
      ctaText: "Open form",
      metaFlowId: "1571793974235171",
      screens: [
        {
          id: "PICK",
          title: "Pick",
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
  });
  const reply = createNode("reply", { kind: "action", actionType: "reply" });
  const serviceForm = createNode(
    "service-form",
    createWhatsAppFlowAction({
      templateId: "form",
      ctaText: "Open form",
      metaFlowId: "1571793974235171",
      screens: [],
    })
  );
  const next = createNode("next", { kind: "action", actionType: "reply" });
  const normalizedHandles = (source: ScenarioFlowNode) =>
    normalizeScenarioEdges(
      [source, next],
      [
        {
          id: "edge-form",
          source: source.id,
          target: next.id,
          sourceHandle: FORM_SUBMITTED,
        },
      ]
    ).map(edge => edge.sourceHandle);

  it("is offered beside Then on a form-only template and beside quick replies", () => {
    expect(resolveAvailableSourceHandleIds(formOnly)).toEqual([
      "right-source",
      FORM_SUBMITTED,
    ]);
    expect(resolveAvailableSourceHandleIds(mixed)).toEqual([
      "right-source",
      ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID,
      buildWhatsAppTemplateButtonSourceHandleId(0),
      FORM_SUBMITTED,
    ]);
    for (const node of [quickRepliesOnly, flowChoices, reply, serviceForm]) {
      expect(resolveAvailableSourceHandleIds(node)).not.toContain(
        FORM_SUBMITTED
      );
    }
  });

  it("keeps a saved route on its template instead of turning it into Then", () => {
    expect(normalizedHandles(formOnly)).toEqual([FORM_SUBMITTED]);
    expect(normalizedHandles(mixed)).toEqual([FORM_SUBMITTED]);
    // A template that no longer opens one form keeps the edge, so the step
    // can flag it.
    expect(normalizedHandles(quickRepliesOnly)).toEqual([FORM_SUBMITTED]);
    expect(normalizedHandles(flowChoices)).toEqual([FORM_SUBMITTED]);
  });

  it("drops a saved route from steps that are not templates", () => {
    expect(normalizedHandles(reply)).toEqual([]);
    expect(normalizedHandles(serviceForm)).toEqual([]);
  });

  it("connects only where the template offers it, never on another route", () => {
    const connect = (node: ScenarioFlowNode) =>
      resolveConnectionSourceHandleId({
        node,
        requestedSourceHandle: FORM_SUBMITTED,
      });
    expect(connect(formOnly)).toBe(FORM_SUBMITTED);
    expect(connect(mixed)).toBe(FORM_SUBMITTED);
    expect(isValidSourceHandleForNode(formOnly, FORM_SUBMITTED)).toBe(true);
    for (const node of [quickRepliesOnly, flowChoices, reply, serviceForm]) {
      expect(connect(node)).toBeNull();
      expect(isValidSourceHandleForNode(node, FORM_SUBMITTED)).toBe(false);
    }
  });
});
