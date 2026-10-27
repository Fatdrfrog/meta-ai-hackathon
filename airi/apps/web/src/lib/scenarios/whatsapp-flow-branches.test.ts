import { parseFlowJsonToWhatsAppFlowConfig } from "@/components/scenarios/builders/whatsapp/flow-json-parser";
import { DEMOSHOP_FLOW_JSON } from "@/components/scenarios/builders/whatsapp/flow-json-fixtures";
import {
  collectRadioFields,
  extractFlowBranchOptions,
} from "./whatsapp-flow-branches";
import {
  readScenarioActionForm,
  type ScenarioNodeData,
  type WhatsAppFlowConfig,
} from "@icecore/scenario-contracts";
import { FLOW_BRANCH_TRANSITION } from "./transition-registry";

it("uses the completion alias of a transported radio answer for scenario branching", () => {
  const config: WhatsAppFlowConfig = {
    templateId: "custom",
    ctaText: "Open",
    flowNavigationMode: "static_graph",
    screens: [
      {
        id: "START",
        title: "Choose",
        fields: [
          {
            id: "design",
            label: "Design",
            fieldType: "RadioButtonsGroup",
            required: true,
            options: [{ id: "classic", title: "Classic" }],
          },
        ],
        footer: {
          label: "Next",
          action: {
            name: "navigate",
            nextScreenId: "END",
            payload: { carried: "${form.design}" },
          },
        },
      },
      {
        id: "END",
        title: "End",
        terminal: true,
        fields: [],
        data: { carried: { type: "string" } },
        footer: {
          label: "Done",
          action: {
            name: "complete",
            payload: { design_result: "${data.carried}" },
          },
        },
      },
    ],
  };
  expect(extractFlowBranchOptions(config)).toEqual([
    {
      fieldId: "design_result",
      fieldLabel: "Design",
      optionId: "classic",
      optionTitle: "Classic",
    },
  ]);
});

it("lists repeated graph questions once using the actual completion response key", () => {
  const json = JSON.parse(JSON.stringify(DEMOSHOP_FLOW_JSON));
  for (const screen of json.screens.slice(1)) {
    const payload = screen.layout.children.at(-1)["on-click-action"].payload;
    payload.design_result = payload.____133f36;
    delete payload.____133f36;
  }
  const config = parseFlowJsonToWhatsAppFlowConfig({
    flowJson: json,
    flowId: "123",
  });
  expect(config).not.toBeNull();
  expect(collectRadioFields(config)).toHaveLength(1);
  expect(extractFlowBranchOptions(config)).toEqual([
    expect.objectContaining({
      fieldId: "design_result",
      optionId: "0_Есімі_жазылатын_(Именная)",
    }),
    expect.objectContaining({
      fieldId: "design_result",
      optionId: "1_Классикалық",
    }),
  ]);
});

it("never makes Flow branch routes from a template's saved form", () => {
  const data = {
    kind: "action",
    actionType: "whatsapp_template",
    actionWhatsAppTemplateComponents: [
      {
        type: "BUTTONS",
        buttons: [{ type: "FLOW", text: "Choose", flow_id: 2244981489363579 }],
      },
    ],
    actionWhatsAppTemplateForm: {
      version: 1,
      flowId: "2244981489363579",
      flowName: "demoshop_ai_case",
      answersKey: "demoshop_ai_case",
      digest: null,
      coverage: "complete",
      endpoint: false,
      readAt: "",
      fields: [
        {
          responseKey: "____133f36",
          label: "Design",
          description: "",
          fieldType: "RadioButtonsGroup",
          required: true,
          screenIndex: 1,
          options: [{ id: "1_Классикалық", title: "Classic" }],
        },
      ],
    },
  } satisfies ScenarioNodeData;

  // AI steps read the radio question; routing never sees it.
  expect(readScenarioActionForm(data)?.fields?.[0]?.fieldType).toBe(
    "RadioButtonsGroup"
  );
  expect(FLOW_BRANCH_TRANSITION.usesBranchHandles(data)).toBe(false);
  expect(FLOW_BRANCH_TRANSITION.extractOptions(data)).toEqual([]);
});
