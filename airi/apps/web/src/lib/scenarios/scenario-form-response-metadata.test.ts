import { readScenarioActionForm } from "@icecore/scenario-contracts";
import { buildStoredWhatsAppFlowResponseFieldMetadata } from "@icecore/shared/lib/whatsapp-flow-response-metadata";
import { buildScenarioFormResponseFieldMetadata } from "./scenario-form-response-metadata";
import {
  DESIGN_FIELD,
  MEDAL_GRAPH_CONFIG,
  medalTemplateStep,
} from "./__tests__/scenario-form-fixtures";

const LINEAR_CONFIG = {
  templateId: "order",
  ctaText: "Order",
  screens: [
    {
      id: "ORDER",
      title: "Order details",
      fields: [
        { id: "name", label: "Name", fieldType: "TextInput", required: true },
        {
          id: "size",
          label: "Size",
          fieldType: "Dropdown",
          helperText: "Pick one",
          options: [
            { id: "opt_s", title: "Small" },
            { id: "opt_l", title: "Large" },
          ],
        },
        { id: "day", label: "Delivery day", fieldType: "DatePicker" },
        { id: "agree", label: "I agree", fieldType: "OptIn" },
      ],
    },
  ],
};

describe("form fields a send stores", () => {
  it("stores a static-graph form's reply keys, each once, with its type", () => {
    const metadata = buildScenarioFormResponseFieldMetadata(
      readScenarioActionForm(
        medalTemplateStep({ actionFlowConfig: MEDAL_GRAPH_CONFIG })
      )
    );
    expect(metadata?.map(field => field.id)).toEqual([
      "__9ba1c9",
      "____133f36",
      "_68d224",
      "_ebfcfb",
      "other_sport",
    ]);
    expect(metadata?.map(field => field.fieldType)).toEqual([
      "Dropdown",
      "RadioButtonsGroup",
      "TextInput",
      "TextInput",
      "TextInput",
    ]);
    expect(metadata?.[1]).toEqual({
      id: "____133f36",
      label: "Design",
      helperText: "Design and name",
      screenTitle: null,
      options: DESIGN_FIELD.options,
      fieldType: "RadioButtonsGroup",
    });
    expect(metadata?.[0]?.options).toEqual(
      expect.arrayContaining([
        {
          id: "1_Таэквондо_/_Каратэ_/_Күрес",
          title: "Taekwondo, karate, wrestling",
        },
      ])
    );
    expect(metadata?.[2]?.options).toBeNull();
  });

  it("stores the fields of a template's saved form", () => {
    const metadata = buildScenarioFormResponseFieldMetadata(
      readScenarioActionForm(
        medalTemplateStep({
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
                responseKey: "_68d224",
                label: "Athlete's name",
                description: "Write every name",
                fieldType: "TextInput",
                required: true,
                screenIndex: 1,
                options: [],
              },
              {
                responseKey: "day",
                label: "Day",
                description: "",
                fieldType: "DatePicker",
                required: false,
                screenIndex: 1,
                options: [],
              },
            ],
          },
        })
      )
    );
    expect(metadata).toEqual([
      {
        id: "_68d224",
        label: "Athlete's name",
        helperText: "Write every name",
        screenTitle: null,
        options: null,
        fieldType: "TextInput",
      },
      {
        id: "day",
        label: "Day",
        helperText: null,
        screenTitle: null,
        options: null,
        fieldType: "DatePicker",
      },
    ]);
  });

  it("keeps any other form's stored fields as they were, with their types", () => {
    const stored = buildStoredWhatsAppFlowResponseFieldMetadata(LINEAR_CONFIG);
    const metadata = buildScenarioFormResponseFieldMetadata(
      readScenarioActionForm(
        medalTemplateStep({ actionFlowConfig: LINEAR_CONFIG })
      )
    );
    expect(metadata).toEqual(
      stored?.map((field, index) => ({
        ...field,
        fieldType: ["TextInput", "Dropdown", "DatePicker", null][index],
      }))
    );
  });

  it("stores nothing for a step that sends no form, or a form without fields", () => {
    expect(buildScenarioFormResponseFieldMetadata(null)).toBeNull();
    expect(
      buildScenarioFormResponseFieldMetadata(
        readScenarioActionForm(
          medalTemplateStep({
            actionFlowConfig: { templateId: "", ctaText: "", screens: [] },
          })
        )
      )
    ).toBeNull();
  });
});
