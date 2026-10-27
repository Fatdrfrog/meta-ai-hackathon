/** Synthetic test fixture: Demoshop's topology and response contract, no customer data. */
import type { FlowJson } from "./flow-json-generator";

/** Meta's saved starter document, without customer content or provider identifiers. */
export const META_STARTER_FLOW_JSON: FlowJson = {
  version: "7.3",
  screens: [
    {
      id: "WELCOME_SCREEN",
      title: "Welcome",
      terminal: true,
      success: true,
      data: {},
      layout: {
        type: "SingleColumnLayout",
        children: [
          { type: "TextHeading", text: "Hello World" },
          { type: "TextBody", text: "Let's start building things!" },
          {
            type: "Footer",
            label: "Complete",
            "on-click-action": { name: "complete", payload: {} },
          },
        ],
      },
    },
  ],
};

export const DEMOSHOP_FLOW_JSON: FlowJson = {
  version: "6.3",
  screens: [
    {
      id: "QUESTION_ONE",
      title: "Choose a sport",
      layout: {
        type: "SingleColumnLayout",
        children: [
          {
            type: "NavigationList",
            name: "sport_list",
            "list-items": [
              {
                id: "sport_0",
                "main-content": { title: "Football, basketball" },
                "on-click-action": {
                  name: "navigate",
                  next: { type: "screen", name: "DETAILS" },
                  payload: { sport: "0_Футбол_/_Баскетбол_/_Волейбол" },
                },
              },
              {
                id: "sport_1",
                "main-content": { title: "Taekwondo, karate, wrestling" },
                "on-click-action": {
                  name: "navigate",
                  next: { type: "screen", name: "DETAILS" },
                  payload: { sport: "1_Таэквондо_/_Каратэ_/_Күрес" },
                },
              },
              {
                id: "sport_2",
                "main-content": { title: "Gymnastics, dance" },
                "on-click-action": {
                  name: "navigate",
                  next: { type: "screen", name: "DETAILS" },
                  payload: { sport: "2_Гимнастика_/_Би" },
                },
              },
              {
                id: "sport_other",
                "main-content": {
                  title: "Other sport",
                  description: "Write your sport",
                },
                "on-click-action": {
                  name: "navigate",
                  next: { type: "screen", name: "OTHER_DETAILS" },
                },
              },
            ],
          },
        ],
      },
    },
    {
      id: "DETAILS",
      title: "Design and name",
      terminal: true,
      data: {
        sport: { type: "string", __example__: "1_Таэквондо_/_Каратэ_/_Күрес" },
      },
      layout: {
        type: "SingleColumnLayout",
        children: [
          {
            type: "RadioButtonsGroup",
            name: "____133f36",
            label: "Design",
            required: true,
            "data-source": [
              {
                id: "0_Есімі_жазылатын_(Именная)",
                title: "Personalised",
                description: "With the athlete's name",
              },
              {
                id: "1_Классикалық",
                title: "Classic",
                description: "Standard design for this sport",
              },
            ],
          },
          {
            type: "TextInput",
            name: "_68d224",
            label: "Athlete's name",
            required: true,
            "input-type": "text",
            "helper-text": "Write every name",
          },
          {
            type: "TextInput",
            name: "_ebfcfb",
            label: "City / region",
            required: true,
            "input-type": "text",
            "helper-text": "For example: Shymkent",
          },
          {
            type: "Footer",
            label: "Send",
            "on-click-action": {
              name: "complete",
              payload: {
                __9ba1c9: "${data.sport}",
                ____133f36: "${form.____133f36}",
                _68d224: "${form._68d224}",
                _ebfcfb: "${form._ebfcfb}",
              },
            },
          },
        ],
      },
    },
    {
      id: "OTHER_DETAILS",
      title: "Design and name",
      terminal: true,
      layout: {
        type: "SingleColumnLayout",
        children: [
          {
            type: "TextInput",
            name: "other_sport",
            label: "Which sport?",
            required: true,
            "input-type": "text",
            "helper-text": "For example: boxing, chess",
          },
          {
            type: "RadioButtonsGroup",
            name: "____133f36",
            label: "Design",
            required: true,
            "data-source": [
              {
                id: "0_Есімі_жазылатын_(Именная)",
                title: "Personalised",
                description: "With the athlete's name",
              },
              {
                id: "1_Классикалық",
                title: "Classic",
                description: "Standard design for this sport",
              },
            ],
          },
          {
            type: "TextInput",
            name: "_68d224",
            label: "Athlete's name",
            required: true,
            "input-type": "text",
            "helper-text": "Write every name",
          },
          {
            type: "TextInput",
            name: "_ebfcfb",
            label: "City / region",
            required: true,
            "input-type": "text",
            "helper-text": "For example: Shymkent",
          },
          {
            type: "Footer",
            label: "Send",
            "on-click-action": {
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
        ],
      },
    },
  ],
};
