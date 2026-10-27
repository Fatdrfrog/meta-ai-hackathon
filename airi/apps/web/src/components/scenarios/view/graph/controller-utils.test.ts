import { getPostActionConditionHandleId } from "@icecore/scenario-contracts";
import { buildWhatsAppTemplateButtonPayload } from "@icecore/scenario-contracts";
import {
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  BULK_CAMPAIGN_ACTION_SOURCE_HANDLE_ID,
  BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
  GENERATIVE_AI_SUCCESS_HANDLE,
  buildFlowBranchSourceHandleId,
  buildTelegramBranchSourceHandleId,
  buildWhatsAppTemplateButtonSourceHandleId,
} from "@icecore/scenario-contracts";
import type {
  ScenarioFlowEdge,
  ScenarioNodeData,
  WhatsAppFlowConfig,
} from "../../types";
import {
  normalizeNodesAfterEdgeChanges,
  removeUnconfiguredActionOutcomeEdges,
  resolveScenarioConnectionPlan,
} from "./controller-utils";
import { createGraphTestNode as createNode } from "./test-utils";

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

describe("resolveScenarioConnectionPlan", () => {
  it("rejects ending a bulk campaign before its primary outbound action", () => {
    const sourceNode = createNode("bulk", {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "Welcome",
        recipientSourceSummary: "Uploaded",
        generationStatus: "idle",
      },
    });
    const targetNode = createNode("end", {
      kind: "action",
      actionType: "end_scenario",
    });
    expect(
      resolveScenarioConnectionPlan({
        sourceNode,
        targetNode,
        nodes: [sourceNode, targetNode],
        edges: [],
        connection: { sourceHandle: "right-source" },
      })
    ).toMatchObject({
      kind: "invalid",
      errorKey: "bulkPrimaryActionRequiresAction",
    });
  });
  it("allows one target from each exact Generative AI outcome handle", () => {
    const sourceNode = createNode("generate", {
      kind: "action",
      actionType: "generative_ai",
      actionGenerativeAIConfig: {
        version: 1,
        mode: "text_to_video",
        prompt: "Create a launch video",
      },
    });
    const firstTargetNode = createNode("first", {
      kind: "action",
      actionType: "reply",
    });
    const secondTargetNode = createNode("second", {
      kind: "action",
      actionType: "reply",
    });

    expect(
      resolveScenarioConnectionPlan({
        connection: { sourceHandle: GENERATIVE_AI_SUCCESS_HANDLE },
        sourceNode,
        targetNode: firstTargetNode,
        nodes: [sourceNode, firstTargetNode],
        edges: [],
      })
    ).toEqual({
      kind: "valid",
      sourceHandleId: GENERATIVE_AI_SUCCESS_HANDLE,
      targetHandleId: "left-target",
      targetPatch: null,
    });

    expect(
      resolveScenarioConnectionPlan({
        connection: { sourceHandle: GENERATIVE_AI_SUCCESS_HANDLE },
        sourceNode,
        targetNode: secondTargetNode,
        nodes: [sourceNode, firstTargetNode, secondTargetNode],
        edges: [
          {
            id: "existing-success",
            source: sourceNode.id,
            sourceHandle: GENERATIVE_AI_SUCCESS_HANDLE,
            target: firstTargetNode.id,
          },
        ],
      })
    ).toEqual({
      kind: "invalid",
      errorKey: "actionOutcomeAlreadyConnected",
    });
  });

  it.each(["right-source", "right-source-generative-ai::completed"])(
    "rejects unavailable Generative AI handle %s",
    sourceHandle => {
      const sourceNode = createNode("generate", {
        kind: "action",
        actionType: "generative_ai",
        actionGenerativeAIConfig: {
          version: 1,
          mode: "text_to_video",
          prompt: "Create a launch video",
        },
      });
      const targetNode = createNode("target", {
        kind: "action",
        actionType: "reply",
      });

      expect(
        resolveScenarioConnectionPlan({
          connection: { sourceHandle },
          sourceNode,
          targetNode,
          nodes: [sourceNode, targetNode],
          edges: [],
        })
      ).toBeNull();
    }
  );

  it("connects a configured action outcome directly to its target", () => {
    const sourceNode = createNode("action-1", {
      kind: "action",
      actionType: "reply",
      actionOutcomes: {
        version: 1,
        anyReply: { enabled: true },
      },
    });
    const targetNode = createNode("action-2", {
      kind: "action",
      actionType: "reply",
    });

    expect(
      resolveScenarioConnectionPlan({
        connection: { sourceHandle: ACTION_ANY_REPLY_OUTCOME_HANDLE_ID },
        sourceNode,
        targetNode,
        nodes: [sourceNode, targetNode],
        edges: [],
      })
    ).toEqual({
      kind: "valid",
      sourceHandleId: ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
      targetHandleId: "left-target",
      targetPatch: null,
    });
  });

  it("allows link nodes only from linkable action outcomes", () => {
    const sourceNode = createNode("action-1", {
      kind: "action",
      actionType: "reply",
      actionOutcomes: {
        version: 1,
        noReply: { enabled: true, timeoutMinutes: 30 },
      },
    });
    const targetNode = createNode("scenario-link", {
      kind: "scenario_link",
      linkedScenarioId: "child-scenario",
    });

    expect(
      resolveScenarioConnectionPlan({
        connection: { sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID },
        sourceNode,
        targetNode,
        nodes: [sourceNode, targetNode],
        edges: [],
      })
    ).toMatchObject({
      kind: "valid",
      sourceHandleId: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
      targetHandleId: "left-target",
    });
  });

  it("rejects unconfigured and multiply-connected action outcomes", () => {
    const sourceNode = createNode("action-1", {
      kind: "action",
      actionType: "reply",
      actionOutcomes: {
        version: 1,
        anyReply: { enabled: true },
      },
    });
    const firstTargetNode = createNode("action-2", {
      kind: "action",
      actionType: "reply",
    });
    const secondTargetNode = createNode("action-3", {
      kind: "action",
      actionType: "reply",
    });
    const triggerNode = createNode("trigger-1", {
      kind: "trigger",
    });

    expect(
      resolveScenarioConnectionPlan({
        connection: { sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID },
        sourceNode,
        targetNode: firstTargetNode,
        nodes: [sourceNode, firstTargetNode],
        edges: [],
      })
    ).toBeNull();

    expect(
      resolveScenarioConnectionPlan({
        connection: { sourceHandle: ACTION_ANY_REPLY_OUTCOME_HANDLE_ID },
        sourceNode,
        targetNode: triggerNode,
        nodes: [sourceNode, triggerNode],
        edges: [],
      })
    ).toEqual({
      kind: "invalid",
      errorKey: "actionOutcomeTriggerTargetError",
    });

    expect(
      resolveScenarioConnectionPlan({
        connection: { sourceHandle: ACTION_ANY_REPLY_OUTCOME_HANDLE_ID },
        sourceNode,
        targetNode: secondTargetNode,
        nodes: [sourceNode, firstTargetNode, secondTargetNode],
        edges: [
          {
            id: "edge-existing",
            source: sourceNode.id,
            sourceHandle: ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
            target: firstTargetNode.id,
          },
        ],
      })
    ).toEqual({
      kind: "invalid",
      errorKey: "actionOutcomeAlreadyConnected",
    });
  });

  it("allows trigger nodes to feed a bulk campaign node", () => {
    const sourceNode = createNode("trigger-1", {
      kind: "trigger",
    });
    const targetNode = createNode("bulk-1", {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "VIP reactivation",
        recipientSourceSummary: "Upload recipients",
        generationStatus: "idle",
      },
    } as ScenarioNodeData);

    expect(
      resolveScenarioConnectionPlan({
        connection: { sourceHandle: "right-source" },
        sourceNode,
        targetNode,
        nodes: [sourceNode, targetNode],
        edges: [],
      })
    ).toMatchObject({
      kind: "valid",
      sourceHandleId: "right-source",
      targetHandleId: "left-target",
      targetPatch: null,
    });
  });

  it("rejects legacy top bulk handle requests", () => {
    const sourceNode = createNode("bulk-1", {
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
    const targetNode = createNode("action-1", {
      kind: "action",
      actionType: "whatsapp_template",
    });

    expect(
      resolveScenarioConnectionPlan({
        connection: {
          sourceHandle: BULK_CAMPAIGN_ACTION_SOURCE_HANDLE_ID,
        },
        sourceNode,
        targetNode,
        nodes: [sourceNode, targetNode],
        edges: [],
      })
    ).toBeNull();
  });

  it("keeps the right bulk handle as a follow-up connection", () => {
    const sourceNode = createNode("bulk-1", {
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
    const targetNode = createNode("action-1", {
      kind: "action",
      actionType: "reply",
    });

    expect(
      resolveScenarioConnectionPlan({
        connection: {
          sourceHandle: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
        },
        sourceNode,
        targetNode,
        nodes: [sourceNode, targetNode],
        edges: [],
      })
    ).toMatchObject({
      kind: "valid",
      sourceHandleId: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
      targetHandleId: "left-target",
      targetPatch: null,
    });
  });

  it("allows multiple right-side bulk connections because the first template is selected as the send action", () => {
    const sourceNode = createNode("bulk-1", {
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
    const firstActionNode = createNode("action-1", {
      kind: "action",
      actionType: "whatsapp_template",
    });
    const secondActionNode = createNode("action-2", {
      kind: "action",
      actionType: "whatsapp_template",
    });

    expect(
      resolveScenarioConnectionPlan({
        connection: {
          sourceHandle: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
        },
        sourceNode,
        targetNode: secondActionNode,
        nodes: [sourceNode, firstActionNode, secondActionNode],
        edges: [
          {
            id: "edge-primary",
            source: "bulk-1",
            sourceHandle: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
            target: "action-1",
            targetHandle: "left-target",
          },
        ],
      })
    ).toMatchObject({
      kind: "valid",
      sourceHandleId: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
      targetHandleId: "left-target",
      targetPatch: null,
    });
  });

  it("allows right-side bulk connections to non-action nodes", () => {
    const sourceNode = createNode("bulk-1", {
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
    const targetNode = createNode("logic-1", {
      kind: "logic",
      logicType: "audience_filter",
    });

    expect(
      resolveScenarioConnectionPlan({
        connection: {
          sourceHandle: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
        },
        sourceNode,
        targetNode,
        nodes: [sourceNode, targetNode],
        edges: [],
      })
    ).toMatchObject({
      kind: "valid",
      sourceHandleId: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
      targetHandleId: "left-target",
      targetPatch: null,
    });
  });

  it("rejects new connections from the persisted legacy interactive no-reply handle", () => {
    const sourceNode = createNode("action-1", {
      kind: "action",
      actionType: "reply",
      actionTelegramQuickReplies: [
        { text: "Yes", payload: "yes" },
        { text: "No", payload: "no" },
      ],
    });
    const targetNode = createNode("action-2", {
      kind: "action",
      actionType: "reply",
    });

    expect(
      resolveScenarioConnectionPlan({
        connection: {
          sourceHandle: ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
        },
        sourceNode,
        targetNode,
        nodes: [sourceNode, targetNode],
        edges: [],
      })
    ).toBeNull();
  });

  it("assigns the next free Telegram branch option for a new connection", () => {
    const sourceNode = createNode("action-1", {
      kind: "action",
      actionType: "reply",
      actionTelegramQuickReplies: [
        { text: "Yes", payload: "yes" },
        { text: "No", payload: "no" },
      ],
    });
    const existingBranchNode = createNode("branch-yes", {
      kind: "action",
      actionType: "reply",
      telegramBranchPayload: "yes",
      telegramBranchLabel: "Yes",
    });
    const targetNode = createNode("branch-no", {
      kind: "action",
      actionType: "reply",
    });
    const edges: ScenarioFlowEdge[] = [
      {
        id: "edge-yes",
        source: sourceNode.id,
        target: existingBranchNode.id,
        sourceHandle: ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID,
      },
    ];

    expect(
      resolveScenarioConnectionPlan({
        connection: {
          sourceHandle: ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID,
        },
        sourceNode,
        targetNode,
        nodes: [sourceNode, existingBranchNode, targetNode],
        edges,
      })
    ).toEqual({
      kind: "valid",
      sourceHandleId: buildTelegramBranchSourceHandleId("no"),
      targetHandleId: "left-target",
      targetPatch: {
        flowBranchSourceFieldId: undefined,
        flowBranchOptionId: undefined,
        flowBranchOptionLabel: undefined,
        telegramBranchPayload: "no",
        telegramBranchLabel: "No",
        instagramBranchPayload: undefined,
        instagramBranchLabel: undefined,
        whatsAppTemplateButtonPayload: undefined,
        whatsAppTemplateButtonLabel: undefined,
      },
    });
  });

  it("assigns the exact Telegram branch option from a quick-reply handle", () => {
    const sourceNode = createNode("action-1", {
      kind: "action",
      actionType: "reply",
      actionTelegramQuickReplies: [
        { text: "Yes", payload: "yes" },
        { text: "No", payload: "no" },
      ],
    });
    const targetNode = createNode("branch-no", {
      kind: "action",
      actionType: "reply",
    });

    expect(
      resolveScenarioConnectionPlan({
        connection: {
          sourceHandle: buildTelegramBranchSourceHandleId("no"),
        },
        sourceNode,
        targetNode,
        nodes: [sourceNode, targetNode],
        edges: [],
      })
    ).toEqual({
      kind: "valid",
      sourceHandleId: buildTelegramBranchSourceHandleId("no"),
      targetHandleId: "left-target",
      targetPatch: {
        flowBranchSourceFieldId: undefined,
        flowBranchOptionId: undefined,
        flowBranchOptionLabel: undefined,
        telegramBranchPayload: "no",
        telegramBranchLabel: "No",
        instagramBranchPayload: undefined,
        instagramBranchLabel: undefined,
        whatsAppTemplateButtonPayload: undefined,
        whatsAppTemplateButtonLabel: undefined,
      },
    });
  });

  it("assigns the exact WhatsApp flow branch option from an option handle", () => {
    const sourceNode = createNode(
      "action-flow",
      createWhatsAppFlowAction({
        templateId: "flow-template",
        ctaText: "Open",
        screens: [
          {
            id: "s1",
            title: "T",
            fields: [
              {
                id: "field-1",
                label: "Pick",
                fieldType: "RadioButtonsGroup",
                options: [
                  { id: "one", title: "One" },
                  { id: "two", title: "Two" },
                ],
              },
            ],
          },
        ],
      })
    );
    const targetNode = createNode("branch-two", {
      kind: "action",
      actionType: "reply",
    });

    expect(
      resolveScenarioConnectionPlan({
        connection: {
          sourceHandle: buildFlowBranchSourceHandleId("field-1", "two"),
        },
        sourceNode,
        targetNode,
        nodes: [sourceNode, targetNode],
        edges: [],
      })
    ).toEqual({
      kind: "valid",
      sourceHandleId: buildFlowBranchSourceHandleId("field-1", "two"),
      targetHandleId: "left-target",
      targetPatch: {
        flowBranchSourceFieldId: "field-1",
        flowBranchOptionId: "two",
        flowBranchOptionLabel: "Two",
        telegramBranchPayload: undefined,
        telegramBranchLabel: undefined,
        whatsAppTemplateButtonPayload: undefined,
        whatsAppTemplateButtonLabel: undefined,
      },
    });
  });

  it("assigns exact inline template flow options from an option handle", () => {
    const sourceNode = createNode("template-action", {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Template body" },
        {
          type: "BUTTONS",
          buttons: [
            {
              type: "FLOW",
              text: "Open flow",
              flow_id: "flow-1",
              flow_action: "navigate",
            },
          ],
        },
      ],
      actionFlowConfig: {
        templateId: "flow-template",
        metaFlowId: "flow-1",
        ctaText: "Open",
        screens: [
          {
            id: "s1",
            title: "T",
            fields: [
              {
                id: "field-1",
                label: "Pick",
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
    });
    const targetNode = createNode("branch-one", {
      kind: "action",
      actionType: "reply",
    });

    expect(
      resolveScenarioConnectionPlan({
        connection: {
          sourceHandle: buildFlowBranchSourceHandleId("field-1", "one"),
        },
        sourceNode,
        targetNode,
        nodes: [sourceNode, targetNode],
        edges: [],
      })
    ).toEqual({
      kind: "valid",
      sourceHandleId: buildFlowBranchSourceHandleId("field-1", "one"),
      targetHandleId: "left-target",
      targetPatch: {
        flowBranchSourceFieldId: "field-1",
        flowBranchOptionId: "one",
        flowBranchOptionLabel: "One",
        telegramBranchPayload: undefined,
        telegramBranchLabel: undefined,
        whatsAppTemplateButtonPayload: undefined,
        whatsAppTemplateButtonLabel: undefined,
      },
    });
  });

  it("assigns exact WhatsApp template quick-reply button branches from an option handle", () => {
    const sourceNode = createNode("template-action", {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Choose language" },
        {
          type: "BUTTONS",
          buttons: [
            { type: "QUICK_REPLY", text: "Kazakh" },
            { type: "URL", text: "Website", url: "https://example.com" },
            { type: "QUICK_REPLY", text: "Russian" },
          ],
        },
      ],
    });
    const targetNode = createNode("branch-russian", {
      kind: "action",
      actionType: "reply",
    });

    expect(
      resolveScenarioConnectionPlan({
        connection: {
          sourceHandle: buildWhatsAppTemplateButtonSourceHandleId(2),
        },
        sourceNode,
        targetNode,
        nodes: [sourceNode, targetNode],
        edges: [],
      })
    ).toEqual({
      kind: "valid",
      sourceHandleId: buildWhatsAppTemplateButtonSourceHandleId(2),
      targetHandleId: "left-target",
      targetPatch: {
        flowBranchSourceFieldId: undefined,
        flowBranchOptionId: undefined,
        flowBranchOptionLabel: undefined,
        telegramBranchPayload: undefined,
        telegramBranchLabel: undefined,
        whatsAppTemplateButtonPayload: buildWhatsAppTemplateButtonPayload(
          sourceNode.id,
          2
        ),
        whatsAppTemplateButtonLabel: "Russian",
      },
    });
  });

  it("keeps the normal reply continuation handle for WhatsApp templates with quick-reply buttons", () => {
    const sourceNode = createNode("template-action", {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Choose language" },
        {
          type: "BUTTONS",
          buttons: [
            { type: "QUICK_REPLY", text: "Kazakh" },
            { type: "URL", text: "Website", url: "https://example.com" },
          ],
        },
      ],
    });
    const targetNode = createNode("reply-condition", {
      kind: "logic",
      logicType: "post_action_condition",
    });

    expect(
      resolveScenarioConnectionPlan({
        connection: {
          sourceHandle: "right-source",
        },
        sourceNode,
        targetNode,
        nodes: [sourceNode, targetNode],
        edges: [],
      })
    ).toEqual({
      kind: "valid",
      sourceHandleId: "right-source",
      targetHandleId: "left-target",
      targetPatch: null,
    });
  });

  it("uses the generic WhatsApp flow handle as the direct reply fallback", () => {
    const sourceNode = createNode(
      "action-flow",
      createWhatsAppFlowAction({
        templateId: "flow-template",
        ctaText: "Open",
        screens: [
          {
            id: "s1",
            title: "T",
            fields: [
              {
                id: "field-1",
                label: "Pick",
                fieldType: "RadioButtonsGroup",
                options: [
                  { id: "one", title: "One" },
                  { id: "two", title: "Two" },
                ],
              },
            ],
          },
        ],
      })
    );
    const existingBranchNode = createNode("branch-one", {
      kind: "action",
      actionType: "reply",
      flowBranchSourceFieldId: "field-1",
      flowBranchOptionId: "one",
      flowBranchOptionLabel: "One",
    });
    const targetNode = createNode("direct-reply", {
      kind: "action",
      actionType: "reply",
      flowBranchSourceFieldId: "field-1",
      flowBranchOptionId: "two",
      flowBranchOptionLabel: "Two",
    });

    expect(
      resolveScenarioConnectionPlan({
        connection: {
          sourceHandle: ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
        },
        sourceNode,
        targetNode,
        nodes: [sourceNode, existingBranchNode, targetNode],
        edges: [
          {
            id: "edge-one",
            source: sourceNode.id,
            target: existingBranchNode.id,
            sourceHandle: ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
          },
        ],
      })
    ).toEqual({
      kind: "valid",
      sourceHandleId: ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
      targetHandleId: "left-target",
      targetPatch: {
        flowBranchSourceFieldId: undefined,
        flowBranchOptionId: undefined,
        flowBranchOptionLabel: undefined,
        telegramBranchPayload: undefined,
        telegramBranchLabel: undefined,
        whatsAppTemplateButtonPayload: undefined,
        whatsAppTemplateButtonLabel: undefined,
      },
    });
  });

  it("keeps option-specific WhatsApp flow handles assigning exact radio branches", () => {
    const sourceNode = createNode(
      "action-flow",
      createWhatsAppFlowAction({
        templateId: "flow-template",
        ctaText: "Open",
        screens: [
          {
            id: "s1",
            title: "T",
            fields: [
              {
                id: "field-1",
                label: "Pick",
                fieldType: "RadioButtonsGroup",
                options: [
                  { id: "one", title: "One" },
                  { id: "two", title: "Two" },
                ],
              },
            ],
          },
        ],
      })
    );
    const existingBranchNode = createNode("branch-one", {
      kind: "action",
      actionType: "reply",
      flowBranchSourceFieldId: "field-1",
      flowBranchOptionId: "one",
      flowBranchOptionLabel: "One",
    });
    const targetNode = createNode("branch-two", {
      kind: "action",
      actionType: "reply",
    });

    expect(
      resolveScenarioConnectionPlan({
        connection: {
          sourceHandle: buildFlowBranchSourceHandleId("field-1", "two"),
        },
        sourceNode,
        targetNode,
        nodes: [sourceNode, existingBranchNode, targetNode],
        edges: [
          {
            id: "edge-one",
            source: sourceNode.id,
            target: existingBranchNode.id,
            sourceHandle: buildFlowBranchSourceHandleId("field-1", "one"),
          },
        ],
      })
    ).toEqual({
      kind: "valid",
      sourceHandleId: buildFlowBranchSourceHandleId("field-1", "two"),
      targetHandleId: "left-target",
      targetPatch: {
        flowBranchSourceFieldId: "field-1",
        flowBranchOptionId: "two",
        flowBranchOptionLabel: "Two",
        telegramBranchPayload: undefined,
        telegramBranchLabel: undefined,
        whatsAppTemplateButtonPayload: undefined,
        whatsAppTemplateButtonLabel: undefined,
      },
    });
  });

  it("rejects condition-branch connections that target trigger nodes", () => {
    const sourceNode = createNode("logic-1", {
      kind: "logic",
      logicType: "post_action_condition",
    });
    const targetNode = createNode("trigger-1", {
      kind: "trigger",
    });
    const actionNode = createNode("action-1", {
      kind: "action",
      actionType: "reply",
    });
    const edges: ScenarioFlowEdge[] = [
      {
        id: "edge-to-condition",
        source: actionNode.id,
        target: sourceNode.id,
        sourceHandle: "right-source",
      },
    ];

    expect(
      resolveScenarioConnectionPlan({
        connection: {
          sourceHandle: getPostActionConditionHandleId("user_replied"),
        },
        sourceNode,
        targetNode,
        nodes: [actionNode, sourceNode, targetNode],
        edges,
      })
    ).toEqual({
      kind: "invalid",
      errorKey: "conditionBranchTriggerTargetError",
    });
  });

  it("allows reply and no-reply condition branches to target separate actions", () => {
    const sourceActionNode = createNode("action-source", {
      kind: "action",
      actionType: "reply",
    });
    const conditionNode = createNode("logic-wait", {
      kind: "logic",
      logicType: "post_action_condition",
    });
    const userRepliedActionNode = createNode("action-replied", {
      kind: "action",
      actionType: "reply",
    });
    const timeoutActionNode = createNode("action-timeout", {
      kind: "action",
      actionType: "reply",
    });
    const edges: ScenarioFlowEdge[] = [
      {
        id: "edge-to-condition",
        source: sourceActionNode.id,
        target: conditionNode.id,
        sourceHandle: "right-source",
      },
      {
        id: "edge-user-replied",
        source: conditionNode.id,
        target: userRepliedActionNode.id,
        sourceHandle: getPostActionConditionHandleId("user_replied"),
      },
    ];

    expect(
      resolveScenarioConnectionPlan({
        connection: {
          sourceHandle: getPostActionConditionHandleId("no_reply_timeout"),
        },
        sourceNode: conditionNode,
        targetNode: timeoutActionNode,
        nodes: [
          sourceActionNode,
          conditionNode,
          userRepliedActionNode,
          timeoutActionNode,
        ],
        edges,
      })
    ).toMatchObject({
      kind: "valid",
      sourceHandleId: getPostActionConditionHandleId("no_reply_timeout"),
      targetHandleId: "left-target",
      targetPatch: null,
    });
  });

  it("allows condition branches when multiple actions can feed the wait node", () => {
    const firstSourceActionNode = createNode("action-source-a", {
      kind: "action",
      actionType: "reply",
    });
    const secondSourceActionNode = createNode("action-source-b", {
      kind: "action",
      actionType: "reply",
    });
    const conditionNode = createNode("logic-wait", {
      kind: "logic",
      logicType: "post_action_condition",
    });
    const targetActionNode = createNode("action-replied", {
      kind: "action",
      actionType: "reply",
    });
    const edges: ScenarioFlowEdge[] = [
      {
        id: "edge-a-to-condition",
        source: firstSourceActionNode.id,
        target: conditionNode.id,
        sourceHandle: "right-source",
      },
      {
        id: "edge-b-to-condition",
        source: secondSourceActionNode.id,
        target: conditionNode.id,
        sourceHandle: "right-source",
      },
    ];

    expect(
      resolveScenarioConnectionPlan({
        connection: {
          sourceHandle: getPostActionConditionHandleId("user_replied"),
        },
        sourceNode: conditionNode,
        targetNode: targetActionNode,
        nodes: [
          firstSourceActionNode,
          secondSourceActionNode,
          conditionNode,
          targetActionNode,
        ],
        edges,
      })
    ).toMatchObject({
      kind: "valid",
      sourceHandleId: getPostActionConditionHandleId("user_replied"),
      targetHandleId: "left-target",
      targetPatch: null,
    });
  });

  it("rejects scenario-link connections from non-condition branches", () => {
    const sourceNode = createNode("action-1", {
      kind: "action",
      actionType: "reply",
    });
    const existingChildNode = createNode("link-a", {
      kind: "scenario_link",
      linkedScenarioId: "scenario-a",
    });
    const targetNode = createNode("link-b", {
      kind: "scenario_link",
      linkedScenarioId: "scenario-b",
    });
    const edges: ScenarioFlowEdge[] = [
      {
        id: "edge-link-a",
        source: sourceNode.id,
        target: existingChildNode.id,
        sourceHandle: "right-source",
      },
    ];

    expect(
      resolveScenarioConnectionPlan({
        connection: {
          sourceHandle: "right-source",
        },
        sourceNode,
        targetNode,
        nodes: [sourceNode, existingChildNode, targetNode],
        edges,
      })
    ).toEqual({
      kind: "invalid",
      errorKey: "scenarioLinkConnectOnlyConditionBranches",
    });
  });

  it("allows creating an unselected scenario-link from a condition branch", () => {
    const sourceActionNode = createNode("action-1", {
      kind: "action",
      actionType: "reply",
    });
    const conditionNode = createNode("condition-1", {
      kind: "logic",
      logicType: "post_action_condition",
    });
    const targetNode = createNode("link-new", {
      kind: "scenario_link",
    });

    expect(
      resolveScenarioConnectionPlan({
        connection: {
          sourceHandle: getPostActionConditionHandleId("user_replied"),
        },
        sourceNode: conditionNode,
        targetNode,
        nodes: [sourceActionNode, conditionNode, targetNode],
        edges: [
          {
            id: "edge-action-condition",
            source: sourceActionNode.id,
            target: conditionNode.id,
            sourceHandle: "right-source",
          },
        ],
      })
    ).toMatchObject({
      kind: "valid",
      sourceHandleId: getPostActionConditionHandleId("user_replied"),
      targetHandleId: "left-target",
    });
  });

  describe("a template's Form submitted route", () => {
    const FORM_SUBMITTED = ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID;
    const formButton = {
      type: "FLOW" as const,
      text: "Open form",
      flow_id: 1571793974235171,
    };
    const quickReply = { type: "QUICK_REPLY" as const, text: "Call me" };
    const template = (
      ...buttons: Array<typeof formButton | typeof quickReply>
    ) =>
      createNode("template", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateComponents: [{ type: "BUTTONS", buttons }],
      });
    const formTemplate = template(formButton);
    const carousel = createNode("carousel", {
      kind: "action",
      actionType: "reply",
    });
    const reminder = createNode("reminder", {
      kind: "action",
      actionType: "reply",
    });
    const plan = (
      sourceNode: ReturnType<typeof createNode>,
      targetNode: ReturnType<typeof createNode>,
      edges: ScenarioFlowEdge[] = []
    ) =>
      resolveScenarioConnectionPlan({
        connection: { sourceHandle: FORM_SUBMITTED },
        sourceNode,
        targetNode,
        nodes: [sourceNode, carousel, reminder, targetNode],
        edges,
      });

    it("connects on its own handle", () => {
      expect(plan(formTemplate, carousel)).toEqual({
        kind: "valid",
        sourceHandleId: FORM_SUBMITTED,
        targetHandleId: "left-target",
        targetPatch: null,
      });
    });

    it("leads to one step, never to a trigger or a linked scenario", () => {
      expect(
        plan(formTemplate, reminder, [
          {
            id: "edge-form",
            source: formTemplate.id,
            sourceHandle: FORM_SUBMITTED,
            target: carousel.id,
          },
        ])
      ).toEqual({ kind: "invalid", errorKey: "actionOutcomeAlreadyConnected" });
      expect(
        plan(formTemplate, createNode("trigger", { kind: "trigger" }))
      ).toEqual({
        kind: "invalid",
        errorKey: "actionOutcomeTriggerTargetError",
      });
      expect(
        plan(
          formTemplate,
          createNode("link", {
            kind: "scenario_link",
            linkedScenarioId: "child-scenario",
          })
        )
      ).toEqual({
        kind: "invalid",
        errorKey: "scenarioLinkConnectOnlyConditionBranches",
      });
    });

    it("is refused where the template doesn't offer it", () => {
      expect(plan(template(quickReply), carousel)).toBeNull();
      expect(
        plan(
          createNode("reply", { kind: "action", actionType: "reply" }),
          carousel
        )
      ).toBeNull();
    });

    it("never leads to a Reply or no reply block, though Then may", () => {
      const wait = createNode("wait", {
        kind: "logic",
        logicType: "post_action_condition",
      });
      expect(plan(formTemplate, wait)).toEqual({
        kind: "invalid",
        errorKey: "whatsappTemplateFormRouteConditionTarget",
      });
      expect(
        resolveScenarioConnectionPlan({
          connection: { sourceHandle: "right-source" },
          sourceNode: formTemplate,
          targetNode: wait,
          nodes: [formTemplate, wait],
          edges: [],
        })
      ).toMatchObject({ kind: "valid", sourceHandleId: "right-source" });
    });

    it("is refused on a bulk send", () => {
      const bulk = createNode("bulk", {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          campaignName: "Medal day",
          recipientSourceSummary: "Upload recipients",
          generationStatus: "idle",
        },
      });
      expect(
        resolveScenarioConnectionPlan({
          connection: { sourceHandle: FORM_SUBMITTED },
          sourceNode: formTemplate,
          targetNode: carousel,
          nodes: [bulk, formTemplate, carousel],
          edges: [
            {
              id: "edge-primary",
              source: bulk.id,
              sourceHandle: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
              target: formTemplate.id,
            },
          ],
        })
      ).toEqual({
        kind: "invalid",
        errorKey: "whatsappTemplateFormRouteInBulk",
      });
    });
  });
});

describe("removeUnconfiguredActionOutcomeEdges", () => {
  it("removes only outcome edges whose owning configuration was deleted", () => {
    const edges: ScenarioFlowEdge[] = [
      {
        id: "edge-any",
        source: "action-1",
        sourceHandle: ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
        target: "action-2",
      },
      {
        id: "edge-no-reply",
        source: "action-1",
        sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
        target: "action-3",
      },
      {
        id: "edge-legacy",
        source: "action-1",
        sourceHandle: "right-source",
        target: "action-4",
      },
    ];

    expect(
      removeUnconfiguredActionOutcomeEdges({
        nodeId: "action-1",
        nodeData: {
          kind: "action",
          actionOutcomes: {
            version: 1,
            anyReply: { enabled: true },
          },
        },
        edges,
      }).map(edge => edge.id)
    ).toEqual(["edge-any", "edge-legacy"]);
  });
});

describe("normalizeNodesAfterEdgeChanges", () => {
  it("clears branch binding data when a branch edge is removed", () => {
    const sourceNode = createNode("action-1", {
      kind: "action",
      actionType: "reply",
      actionTelegramQuickReplies: [
        { text: "Yes", payload: "yes" },
        { text: "No", payload: "no" },
      ],
    });
    const targetNode = createNode("branch-yes", {
      kind: "action",
      actionType: "reply",
      telegramBranchPayload: "yes",
      telegramBranchLabel: "Yes",
    });
    const currentEdges: ScenarioFlowEdge[] = [
      {
        id: "edge-yes",
        source: sourceNode.id,
        target: targetNode.id,
        sourceHandle: ACTION_TELEGRAM_BRANCH_OUTPUT_HANDLE_ID,
      },
    ];

    const nextNodes = normalizeNodesAfterEdgeChanges({
      changes: [{ id: "edge-yes", type: "remove" }],
      currentEdges,
      nextEdges: [],
      currentNodes: [sourceNode, targetNode],
    });
    const normalizedTargetNode = nextNodes.find(
      node => node.id === targetNode.id
    );

    expect(
      (normalizedTargetNode?.data as ScenarioNodeData).telegramBranchPayload
    ).toBeUndefined();
    expect(
      (normalizedTargetNode?.data as ScenarioNodeData).telegramBranchLabel
    ).toBeUndefined();
  });

  it("clears WhatsApp template button branch data when that branch edge is removed", () => {
    const sourceNode = createNode("template-action", {
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
    const targetNode = createNode("branch-kazakh", {
      kind: "action",
      actionType: "reply",
      whatsAppTemplateButtonPayload: buildWhatsAppTemplateButtonPayload(
        sourceNode.id,
        0
      ),
      whatsAppTemplateButtonLabel: "Kazakh",
    });
    const currentEdges: ScenarioFlowEdge[] = [
      {
        id: "edge-kazakh",
        source: sourceNode.id,
        target: targetNode.id,
        sourceHandle: buildWhatsAppTemplateButtonSourceHandleId(0),
      },
    ];

    const nextNodes = normalizeNodesAfterEdgeChanges({
      changes: [{ id: "edge-kazakh", type: "remove" }],
      currentEdges,
      nextEdges: [],
      currentNodes: [sourceNode, targetNode],
    });
    const normalizedTargetNode = nextNodes.find(
      node => node.id === targetNode.id
    );

    expect(
      (normalizedTargetNode?.data as ScenarioNodeData)
        .whatsAppTemplateButtonPayload
    ).toBeUndefined();
    expect(
      (normalizedTargetNode?.data as ScenarioNodeData)
        .whatsAppTemplateButtonLabel
    ).toBeUndefined();
  });
});
