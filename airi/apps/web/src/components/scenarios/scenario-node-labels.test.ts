import type { ScenarioNodeData } from "@/components/scenarios/types";
import { createDefaultScenarioWhatsAppServiceMessage } from "@icecore/scenario-contracts";
import {
  WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS,
  WHATSAPP_SERVICE_MESSAGE_MEDIA_MENU_LABEL_KEYS,
} from "./builders/whatsapp/service-message/service-message-labels";
import {
  resolveActionPreview,
  resolveCompactActionTitle,
  resolveScenarioDestinationLabel,
  sanitizeScenarioDestinationLabel,
} from "./scenario-node-labels";

const resolveCompactActionPreviewText = (
  params: Parameters<typeof resolveActionPreview>[0]
) => resolveActionPreview(params).text;

const t = (key: string) => key;

const action = (message: ScenarioNodeData["actionWhatsAppServiceMessage"]) =>
  ({
    kind: "action",
    actionType: "reply",
    actionReplyChannel: "whatsapp",
    actionWhatsAppServiceMessage: message,
  }) satisfies ScenarioNodeData;

const serviceMessage = (message: Record<string, unknown>) =>
  action({
    version: 1,
    message,
  } as ScenarioNodeData["actionWhatsAppServiceMessage"]);

const flowConfig = {
  templateId: "lead-form",
  screens: [],
  ctaText: "Open",
  metaFlowId: "1234567890",
};

describe("canonical WhatsApp service-message compact summaries", () => {
  it("labels End scenario destinations without stale message content", () => {
    expect(
      resolveCompactActionPreviewText({
        nodeData: {
          kind: "action",
          actionType: "end_scenario",
          actionReplyText: "Old message",
        },
        t,
      })
    ).toBe("actionTypeEndScenario");
  });

  it("uses canonical body copy after legacy fields are cleared", () => {
    expect(
      resolveCompactActionPreviewText({
        nodeData: action({
          version: 1,
          message: {
            kind: "text",
            body: { mode: "fixed", text: "Canonical welcome" },
          },
        }),
        t,
      })
    ).toBe("Canonical welcome");
  });

  it.each(["image", "video", "document", "audio", "sticker"] as const)(
    "names %s media by its type, never by a file name or storage path",
    mediaType => {
      const label = WHATSAPP_SERVICE_MESSAGE_MEDIA_MENU_LABEL_KEYS[mediaType];
      const preview = resolveActionPreview({
        nodeData: serviceMessage({
          kind: "media",
          attachment: {
            url: "https://cdn.test/guide.bin",
            mediaType,
            fileName: "guide.bin",
            path: "workspaces/w1/guide.bin",
          },
        }),
        t,
      });
      expect(preview).toEqual({ text: label, state: "content" });
    }
  );

  it("names a form by its name or as untitled, never by its provider ID", () => {
    expect(
      resolveActionPreview({
        nodeData: serviceMessage({
          kind: "flow",
          body: { mode: "fixed", text: "" },
          flowConfig: { ...flowConfig, metaFlowName: "Lead qualification" },
        }),
        t,
      })
    ).toEqual({ text: "Lead qualification", state: "content" });
    const untitled = serviceMessage({
      kind: "flow",
      body: { mode: "fixed", text: "" },
      flowConfig,
    });
    expect(resolveActionPreview({ nodeData: untitled, t })).toEqual({
      text: "untitledForm",
      state: "content",
    });
    expect(
      resolveCompactActionTitle({
        actionLabel: "whatsappActionKindFlow",
        actionType: "reply",
        nodeData: untitled,
      })
    ).toBe("whatsappActionKindFlow");
  });

  it.each([
    "location_request",
    "request_contact_info",
    "voice_call",
    "appointment",
    "commerce",
  ] as const)("names an empty %s message by its type", kind => {
    const label = WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS[kind];
    expect(
      resolveActionPreview({
        nodeData: action(createDefaultScenarioWhatsAppServiceMessage(kind)),
        t,
      })
    ).toEqual({ text: label, state: "content" });
  });

  it("flags an empty text message as blocking", () => {
    expect(
      resolveActionPreview({
        nodeData: serviceMessage({
          kind: "text",
          body: { mode: "fixed", text: " " },
        }),
        t,
      })
    ).toEqual({ text: "actionPreviewEmpty", state: "blocking_empty" });
  });

  it("uses canonical contact and Flow titles", () => {
    expect(
      resolveCompactActionTitle({
        actionLabel: "Reply",
        actionType: "reply",
        nodeData: action({
          version: 1,
          message: {
            kind: "contacts",
            contacts: [{ formattedName: "Airi Support" }],
          },
        }),
      })
    ).toBe("Airi Support");

    expect(
      resolveCompactActionTitle({
        actionLabel: "Reply",
        actionType: "reply",
        nodeData: action({
          version: 1,
          message: {
            kind: "flow",
            body: { mode: "fixed", text: "Start" },
            flowConfig: {
              templateId: "lead-form",
              screens: [],
              ctaText: "Open",
              metaFlowId: "flow-1",
              metaFlowName: "Lead qualification",
            },
          },
        }),
      })
    ).toBe("Lead qualification");
  });
});

describe("action previews", () => {
  it.each<[string, ScenarioNodeData, string, string]>([
    [
      "a fixed reply with no text",
      { kind: "action", actionType: "reply", actionReplyMode: "fixed" },
      "actionPreviewEmpty",
      "blocking_empty",
    ],
    [
      "an AI step with no instructions",
      {
        kind: "action",
        actionType: "generative_ai",
        actionGenerativeAIConfig: {
          version: 1,
          mode: "text_to_image",
          prompt: " ",
        },
      },
      "generativeAIPromptEmptyPreview",
      "blocking_empty",
    ],
    [
      "a handoff with no message",
      { kind: "action", actionType: "assign_human" },
      "handoffPreviewEmpty",
      "info_empty",
    ],
    [
      "a template step with no template",
      { kind: "action", actionType: "whatsapp_template" },
      "templatePreviewEmpty",
      "blocking_empty",
    ],
    [
      "a reply the AI writes",
      { kind: "action", actionType: "reply", actionReplyMode: "ai" },
      "actionPreviewAiReply",
      "content",
    ],
    [
      "a reply the AI writes from instructions",
      {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "ai",
        actionReplyInstruction: "Be friendly",
      },
      "actionPreviewAiReply · Be friendly",
      "content",
    ],
  ])("previews %s", (_label, nodeData, text, state) => {
    expect(resolveActionPreview({ nodeData, t })).toEqual({ text, state });
  });

  it("shows AI prompt variables as readable names", () => {
    expect(
      resolveActionPreview({
        nodeData: {
          kind: "action",
          actionType: "generative_ai",
          actionGenerativeAIConfig: {
            version: 1,
            mode: "text_to_image",
            prompt: "Make a poster with {{input.card_text}} for {{first_name}}",
          },
          uiScenarioPromptInputs: [
            { key: "card_text", label: "Card text", prompt: "Text?" },
          ],
        },
        t,
      })
    ).toEqual({
      text: "Make a poster with [Card text] for [First Name]",
      state: "content",
    });
  });

  it("names a form answer with its form in AI previews", () => {
    expect(
      resolveActionPreview({
        nodeData: {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "ai",
          actionReplyInstruction:
            "Confirm {{form.order.size}} and {{form.order.colour}}",
          uiScenarioFormAnswerSources: [
            {
              nodeId: "order",
              formKey: "order",
              formLabel: "Order",
              label: "Order details",
              availability: "always" as const,
              schema: "known" as const,
              fields: [
                {
                  key: "size",
                  responseKey: "size",
                  label: "Size",
                  description: "",
                  fieldType: "Dropdown" as const,
                  required: true,
                  screenIndex: 0,
                  options: [],
                  mayBeEmpty: false,
                },
              ],
            },
          ],
        },
        t,
      }).text
    ).toBe(
      "actionPreviewAiReply · Confirm [Size · Order details] and [Colour]"
    );
  });

  it("prefers the enriched preview text of a template", () => {
    expect(
      resolveActionPreview({
        nodeData: {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: "promo",
          actionPreviewText: "Hello Aigerim",
        },
        t,
      })
    ).toEqual({ text: "Hello Aigerim", state: "content" });
    expect(
      resolveActionPreview({
        nodeData: {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: "promo",
        },
        t,
      })
    ).toEqual({ text: "promo", state: "content" });
  });
});

describe("Generative AI compact summaries", () => {
  const generativeAction = {
    kind: "action",
    actionType: "generative_ai",
    actionGenerativeAIConfig: {
      version: 1,
      mode: "image_to_video",
      prompt:
        "Turn the supplied product image into a polished launch animation",
    },
    actionReplyText: "Stale reply content",
  } satisfies ScenarioNodeData;

  it("uses the canonical prompt instead of stale generic action copy", () => {
    expect(
      resolveCompactActionPreviewText({ nodeData: generativeAction, t })
    ).toBe("Turn the supplied product image into a polished launch animation");
  });

  it("keeps the dedicated action title ahead of stale template metadata", () => {
    expect(
      resolveCompactActionTitle({
        actionLabel: "Generative AI",
        actionType: "generative_ai",
        nodeData: {
          ...generativeAction,
          actionWhatsAppTemplateName: "stale-template",
        },
      })
    ).toBe("Generative AI");
  });
});

describe("scenario destination labels", () => {
  it("shows variables as an ellipsis on the first visible line", () => {
    expect(sanitizeScenarioDestinationLabel("Размеры *{(Model)} chart")).toBe(
      "Размеры … chart"
    );
    expect(sanitizeScenarioDestinationLabel("Size {{model}}\nMore")).toBe(
      "Size …"
    );
    expect(sanitizeScenarioDestinationLabel("Hi {{name}} , welcome !")).toBe(
      "Hi …, welcome!"
    );
  });

  it("prefers a node title over body preview with variables", () => {
    expect(
      resolveScenarioDestinationLabel({
        nodeData: action({
          version: 1,
          message: {
            kind: "contacts",
            contacts: [{ formattedName: "Airi Support" }],
          },
        }),
        t,
      })
    ).toBe("Airi Support");

    expect(
      resolveScenarioDestinationLabel({
        nodeData: {
          kind: "action",
          actionType: "reply",
          actionReplyText: "Choose a size *{(Mo",
        },
        t,
      })
    ).toBe("Choose a size …");
  });

  it.each<[string, ScenarioNodeData, string]>([
    [
      "an empty fixed reply",
      { kind: "action", actionType: "reply", actionReplyMode: "fixed" },
      "presetActionReply",
    ],
    [
      "a handoff with no message",
      { kind: "action", actionType: "assign_human" },
      "presetActionAssignHuman",
    ],
    [
      "an AI step with no instructions",
      { kind: "action", actionType: "generative_ai" },
      "presetActionGenerativeAI",
    ],
    [
      "a template step with no template",
      { kind: "action", actionType: "whatsapp_template" },
      "whatsappActionKindTemplate",
    ],
    [
      "a message that is only a variable",
      {
        kind: "action",
        actionType: "reply",
        actionReplyText: "{{first_name}}",
      },
      "presetActionReply",
    ],
  ])("never names %s with empty-state copy", (_label, nodeData, expected) => {
    expect(resolveScenarioDestinationLabel({ nodeData, t })).toBe(expected);
  });

  it.each<[string, ScenarioNodeData, string]>([
    [
      "a linked sub-scenario",
      { kind: "scenario_link", linkedScenarioName: "Delivery" },
      "Delivery",
    ],
    [
      "an unlinked sub-scenario",
      { kind: "scenario_link" },
      "scenarioLinkPlaceholder",
    ],
    ["a knowledge step", { kind: "context" }, "badgeContext"],
    [
      "a Reply or no reply check",
      { kind: "logic", logicType: "post_action_condition" },
      "postActionConditionLabel",
    ],
    [
      "a column split",
      { kind: "logic", logicType: "recipient_column_split" },
      "presetLogicRecipientColumnSplit",
    ],
    [
      "an audience filter",
      { kind: "logic", logicType: "audience_filter" },
      "scenarioGate",
    ],
  ])("names %s by its kind", (_label, nodeData, expected) => {
    expect(resolveScenarioDestinationLabel({ nodeData, t })).toBe(expected);
  });
});
