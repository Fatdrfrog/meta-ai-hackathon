import type { ScenarioWhatsAppTemplate } from "../../types";
import {
  buildDraftActionPreviewText,
  buildScenarioPreviewContext,
  buildWhatsAppTemplatePreview,
  canEditFlowForWhatsAppTemplateComponents,
  getSingleFlowIdFromWhatsAppTemplateComponents,
} from "./utils";

const LABELS: Record<string, string> = {
  variableFieldLastMessage: "Last customer message",
  variableFieldCalendarNextSlot: "Next free slot",
  variableFieldCountdown: "Time left",
  variableFieldCampaignName: "Ad campaign name",
};
const translate = (key: string) => LABELS[key] ?? key;

function preview(
  reply: string,
  overrides: Partial<Parameters<typeof buildScenarioPreviewContext>[0]> = {}
) {
  return buildDraftActionPreviewText({
    reply,
    context: buildScenarioPreviewContext({
      reply,
      links: [],
      images: [],
      translate,
      profile: { customerName: "Ada Lovelace", customerFirstName: "Ada" },
      ...overrides,
    }),
  });
}

describe("scenario preview rendering", () => {
  it("renders what the runtime renders, in one pass", () => {
    expect(
      preview("Hi {{customer.name}}", {
        profile: { customerName: "{customer.id} {{channel}}" },
      })
    ).toBe("Hi {customer.id} {{channel}}");
    expect(preview("Hi {{first_name}} {customer.firstName}!")).toBe(
      "Hi Ada Ada!"
    );
    expect(preview("[{{customer.firstname}}][{{Customer.name}}]")).toBe("[][]");
  });

  it("shows a labelled sample for data the preview cannot know", () => {
    expect(
      preview(
        "{{trigger.message.text}} | {{calendar.next_free_slot}} | {{countdown}} | {{trigger.whatsappReferral.campaignName}}"
      )
    ).toBe(
      "[Last customer message] | [Next free slot] | [Time left] | [Ad campaign name]"
    );
    expect(preview("{{whatsappclient.user_id}}")).toBe("[User Id]");
  });

  it("previews each answer this step can use by its label", () => {
    expect(
      preview("Medal for {{input.name}} ({input.sport}) in [{{input.city}}]", {
        promptInputs: [
          { key: "name", label: "Name on the medal" },
          { key: "sport", label: "" },
        ],
      })
    ).toBe("Medal for [Name on the medal] ([sport]) in []");
  });

  it("previews each earlier form's answer by its question", () => {
    expect(
      preview("Size {{form.order.size}}, colour [{{form.order.colour}}]", {
        formAnswers: [
          {
            nodeId: "order",
            formKey: "order",
            formLabel: "Order",
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
      })
    ).toBe("Size [Size], colour []");
  });

  it("fills the numbered link slots the runtime fills", () => {
    const links = Array.from({ length: 7 }, (_, i) => `https://a.test/${i}`);
    expect(preview("{{link}} {{link5}} [{{link6}}]", { links })).toBe(
      "https://a.test/0 https://a.test/4 []"
    );
    expect(preview("{{link}} {{link1}} [{{link2}}]")).toBe(
      "https://example.com/book https://example.com/book []"
    );
  });

  it("renders template components with the same grammar", () => {
    const components = [
      { type: "BODY", text: "Hi {{first_name}}, {{countdown}}" },
    ] as ScenarioWhatsAppTemplate["components"];
    expect(
      buildWhatsAppTemplatePreview({
        components,
        context: buildScenarioPreviewContext({
          reply: "",
          links: [],
          images: [],
          translate,
          profile: { customerName: "Ada", customerFirstName: "Ada" },
        }),
      })?.bodyText
    ).toBe("Hi Ada, [Time left]");
    // A literal preview context keeps each token as written.
    expect(
      buildWhatsAppTemplatePreview({
        components: [
          { type: "BODY", text: "{{customer.name}} {{1}}" },
        ] as ScenarioWhatsAppTemplate["components"],
        context: { customer: { name: "{{customer.name}}" }, 1: "{{1}}" },
      })?.bodyText
    ).toBe("{{customer.name}} {{1}}");
  });
});

type TemplateComponents = ScenarioWhatsAppTemplate["components"];

function createTemplateComponents(
  buttons: Array<Record<string, unknown>>
): TemplateComponents {
  return [
    {
      type: "BUTTONS",
      buttons,
    },
  ] as TemplateComponents;
}

describe("scenario preview linked flow helpers", () => {
  it("allows mixed template buttons when exactly one concrete Flow button exists", () => {
    const components = createTemplateComponents([
      {
        type: "QUICK_REPLY",
        text: "Ask manager",
      },
      {
        type: "FLOW",
        text: "Open flow",
        flow_id: " flow-1 ",
        flow_action: "navigate",
      },
    ]);

    expect(canEditFlowForWhatsAppTemplateComponents(components)).toBe(true);
    expect(getSingleFlowIdFromWhatsAppTemplateComponents(components)).toBe(
      "flow-1"
    );
  });

  it("normalizes a numeric Meta Flow id", () => {
    const components = createTemplateComponents([
      {
        type: "FLOW",
        text: "Open flow",
        flow_id: 12345,
        flow_action: "navigate",
      },
    ]);

    expect(canEditFlowForWhatsAppTemplateComponents(components)).toBe(true);
    expect(getSingleFlowIdFromWhatsAppTemplateComponents(components)).toBe(
      "12345"
    );
  });

  it("rejects multiple Flow buttons even when they repeat the same id", () => {
    const components = createTemplateComponents([
      {
        type: "FLOW",
        text: "Open flow",
        flow_id: "flow-1",
        flow_action: "navigate",
      },
      {
        type: "FLOW",
        text: "Open flow again",
        flow_id: "flow-1",
        flow_action: "navigate",
      },
    ]);

    expect(canEditFlowForWhatsAppTemplateComponents(components)).toBe(false);
    expect(
      getSingleFlowIdFromWhatsAppTemplateComponents(components)
    ).toBeNull();
  });

  it("rejects linked flow editing when a template links to multiple flow ids", () => {
    const components = createTemplateComponents([
      {
        type: "FLOW",
        text: "Open first flow",
        flow_id: "flow-1",
        flow_action: "navigate",
      },
      {
        type: "FLOW",
        text: "Open second flow",
        flow_id: "flow-2",
        flow_action: "navigate",
      },
    ]);

    expect(canEditFlowForWhatsAppTemplateComponents(components)).toBe(false);
    expect(
      getSingleFlowIdFromWhatsAppTemplateComponents(components)
    ).toBeNull();
  });

  it("rejects linked flow editing when any flow button has no flow id", () => {
    const components = createTemplateComponents([
      {
        type: "FLOW",
        text: "Open flow",
        flow_id: "",
        flow_action: "navigate",
      },
    ]);

    expect(canEditFlowForWhatsAppTemplateComponents(components)).toBe(false);
    expect(
      getSingleFlowIdFromWhatsAppTemplateComponents(components)
    ).toBeNull();
  });
});
