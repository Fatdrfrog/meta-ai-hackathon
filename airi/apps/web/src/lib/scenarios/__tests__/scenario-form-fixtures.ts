import {
  listScenarioFormFields,
  type ScenarioFormField,
  type ScenarioWhatsAppTemplateForm,
} from "@icecore/scenario-contracts";

/** The Flow DemoShop's medal_pick_1 template button opens. */
export const MEDAL_FLOW_ID = "2244981489363579";

export const DESIGN_FIELD = {
  id: "____133f36",
  label: "Design",
  fieldType: "RadioButtonsGroup",
  required: true,
  options: [
    { id: "0_Есімі_жазылатын_(Именная)", title: "Personalised" },
    { id: "1_Классикалық", title: "Classic" },
  ],
};
export const NAME_FIELD = {
  id: "_68d224",
  label: "Athlete's name",
  fieldType: "TextInput",
  required: true,
  helperText: "Write every name",
};
export const CITY_FIELD = {
  id: "_ebfcfb",
  label: "City / region",
  fieldType: "TextInput",
  required: true,
};

/** DemoShop's medal form: a sport list, then design and names per path. */
export const MEDAL_GRAPH_CONFIG = {
  templateId: "custom",
  ctaText: "Choose",
  flowNavigationMode: "static_graph",
  screens: [
    {
      id: "QUESTION_ONE",
      title: "Choose a sport",
      fields: [
        {
          id: "sport_list",
          label: "",
          fieldType: "NavigationList",
          navigationItems: [
            {
              id: "sport_0",
              title: "Football",
              action: {
                name: "navigate",
                nextScreenId: "DETAILS",
                payload: { sport: "0_Футбол_/_Баскетбол_/_Волейбол" },
              },
            },
            {
              id: "sport_1",
              title: "Taekwondo, karate, wrestling",
              action: {
                name: "navigate",
                nextScreenId: "DETAILS",
                payload: { sport: "1_Таэквондо_/_Каратэ_/_Күрес" },
              },
            },
            {
              id: "sport_other",
              title: "Other sport",
              action: { name: "navigate", nextScreenId: "OTHER_DETAILS" },
            },
          ],
        },
      ],
    },
    {
      id: "DETAILS",
      title: "Design and name",
      terminal: true,
      data: { sport: { type: "string" } },
      fields: [DESIGN_FIELD, NAME_FIELD, CITY_FIELD],
      footer: {
        label: "Send",
        action: {
          name: "complete",
          payload: {
            __9ba1c9: "${data.sport}",
            ____133f36: "${form.____133f36}",
            _68d224: "${form._68d224}",
            _ebfcfb: "${form._ebfcfb}",
          },
        },
      },
    },
    {
      id: "OTHER_DETAILS",
      title: "Design and name",
      terminal: true,
      fields: [
        {
          id: "other_sport",
          label: "Which sport?",
          fieldType: "TextInput",
          required: true,
        },
        DESIGN_FIELD,
        NAME_FIELD,
        CITY_FIELD,
      ],
      footer: {
        label: "Send",
        action: {
          name: "complete",
          payload: {
            __9ba1c9: "4_Басқа",
            other_sport: "${form.other_sport}",
            ____133f36: "${form.____133f36}",
            _68d224: "${form._68d224}",
            _ebfcfb: "${form._ebfcfb}",
          },
        },
      },
    },
  ],
};

/**
 * A template step whose one FLOW button opens the medal Flow, its id a
 * number as the production template stores it.
 */
export function medalTemplateStep(data: Record<string, unknown> = {}) {
  return {
    kind: "action",
    actionType: "whatsapp_template",
    actionWhatsAppTemplateComponents: [
      {
        type: "BUTTONS",
        buttons: [{ type: "FLOW", text: "Choose", flow_id: 2244981489363579 }],
      },
    ],
    ...data,
  };
}

/** The medal form's fields as the builder saves them from the Flow. */
export function medalTemplateForm(): ScenarioWhatsAppTemplateForm {
  return {
    version: 1,
    flowId: MEDAL_FLOW_ID,
    flowName: "demoshop_ai_case",
    answersKey: "demoshop_ai_case",
    digest: null,
    coverage: "complete",
    endpoint: false,
    readAt: "2026-10-04T00:00:00.000Z",
    fields: listScenarioFormFields(MEDAL_GRAPH_CONFIG).map(field => {
      const saved: Partial<ScenarioFormField> = { ...field };
      delete saved.key;
      return saved as Omit<ScenarioFormField, "key">;
    }),
  };
}
