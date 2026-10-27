import { ScenarioOperationError } from "@/lib/scenarios/scenario-operation-error";
import { validateScenarioWriteGraph } from "@/lib/scenarios/scenario-write-validation";

// Linked conditions are loaded from the database; a graph error stops first.
jest.mock("@/lib/scenarios/linked-conditions", () => ({
  validateConditionalScenarioLinks: jest.fn(async () => []),
}));

const trigger = {
  id: "trigger",
  data: { kind: "trigger", triggerType: "incoming_customer_message" },
};

function form(id: string, answersKey: string) {
  return {
    id,
    data: {
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "whatsapp",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "flow",
          body: { mode: "fixed", text: "Fill in your order" },
          flowConfig: {
            templateId: "lead_generation",
            ctaText: "Open",
            metaFlowId: `legacy-${id}`,
            answersKey,
            screens: [
              {
                id: "DETAILS",
                title: "Details",
                fields: [
                  {
                    id: "size",
                    label: "Size",
                    fieldType: "TextInput",
                    required: true,
                  },
                ],
              },
            ],
          },
        },
      },
    },
  };
}

async function readWriteFailure(
  nodes: Array<{ id: string; data: Record<string, unknown> }>,
  edges: Array<{ source: string; target: string }>
) {
  try {
    await validateScenarioWriteGraph({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      nodes,
      edges,
      options: { mode: "runnable" },
    });
  } catch (error) {
    return error instanceof ScenarioOperationError ? error.failure : error;
  }
  return null;
}

describe("validateScenarioWriteGraph form answers", () => {
  it("rejects an AI step reading a form answer no earlier form has, naming the step", async () => {
    await expect(
      readWriteFailure(
        [
          trigger,
          form("order", "order"),
          {
            id: "reply",
            data: {
              kind: "action",
              actionType: "reply",
              actionReplyMode: "ai",
              actionReplyInstruction: "Confirm {{form.order.colour}}",
            },
          },
        ],
        [
          { source: "trigger", target: "order" },
          { source: "order", target: "reply" },
        ]
      )
    ).resolves.toEqual({
      kind: "graph_invalid",
      code: "formAnswerUnavailable",
      nodeIds: ["reply"],
    });
  });

  it("rejects two forms with the same variable name, naming the later", async () => {
    const templateForm = {
      id: "second",
      data: {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "second_template",
        actionWhatsAppTemplateLanguage: "en",
        actionFlowConfig: form("second", "order").data
          .actionWhatsAppServiceMessage.message.flowConfig,
      },
    };
    await expect(
      readWriteFailure(
        [trigger, form("first", "order"), templateForm],
        [
          { source: "trigger", target: "first" },
          { source: "first", target: "second" },
        ]
      )
    ).resolves.toEqual({
      kind: "graph_invalid",
      code: "formAnswersKeyDuplicate",
      nodeIds: ["second"],
    });
  });
});
