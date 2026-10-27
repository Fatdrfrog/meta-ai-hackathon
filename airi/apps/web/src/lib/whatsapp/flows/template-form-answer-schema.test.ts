import {
  MAX_SCENARIO_FORM_LABEL_CHARACTERS,
  MAX_SCENARIO_WHATSAPP_TEMPLATE_FORM_FIELDS,
  normalizeScenarioWhatsAppTemplateForm,
} from "@icecore/scenario-contracts";
import { DEMOSHOP_FLOW_JSON } from "@/components/scenarios/builders/whatsapp/flow-json-fixtures";
import { buildTemplateFormAnswerSchema } from "./template-form-answer-schema";

const FLOW_NAME = "demoshop_ai_case";

function schemaOf(flowJson: unknown) {
  return buildTemplateFormAnswerSchema({ flowJson, flowName: FLOW_NAME });
}

function demoshopJson(): typeof DEMOSHOP_FLOW_JSON {
  return JSON.parse(JSON.stringify(DEMOSHOP_FLOW_JSON));
}

type Component = Record<string, unknown>;

/** One terminal screen that sends `payload` from its Footer. */
function oneScreenFlow(
  children: Component[],
  payload: Record<string, unknown>
) {
  return {
    version: "7.3",
    screens: [
      {
        id: "FORM",
        title: "Form",
        terminal: true,
        layout: {
          type: "SingleColumnLayout",
          children: [
            ...children,
            {
              type: "Footer",
              label: "Send",
              "on-click-action": { name: "complete", payload },
            },
          ],
        },
      },
    ],
  };
}

describe("buildTemplateFormAnswerSchema", () => {
  it("lists every answer of the DemoShop Flow with the Flow's labels", () => {
    const schema = schemaOf(DEMOSHOP_FLOW_JSON);

    expect(schema).toMatchObject({
      flowName: FLOW_NAME,
      coverage: "complete",
      endpoint: false,
    });
    expect(schema?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      schema?.fields.map(field => [
        field.responseKey,
        field.label,
        field.conditional === true,
      ])
    ).toEqual([
      ["__9ba1c9", "Choose a sport", false],
      ["____133f36", "Design", false],
      ["_68d224", "Athlete's name", false],
      ["_ebfcfb", "City / region", false],
      ["other_sport", "Which sport?", true],
    ]);
    expect(schema?.fields[0]).not.toHaveProperty("key");
  });

  it("is the saved form as the step stores it, unchanged by normalizing", () => {
    const schema = schemaOf(DEMOSHOP_FLOW_JSON)!;
    const saved = {
      version: 1,
      flowId: "1571793974235171",
      answersKey: "demoshop_ai_case",
      readAt: "2026-10-05T08:00:00.000Z",
      ...schema,
    };

    const normalized = normalizeScenarioWhatsAppTemplateForm(saved);

    expect(normalized.status).toBe("supported");
    expect(normalized.value).toEqual(saved);
    expect(normalized.value?.fields).toEqual(schema.fields);
  });

  it("changes its digest only when the saved fields would change", () => {
    const digest = schemaOf(DEMOSHOP_FLOW_JSON)?.digest;
    const withText = demoshopJson();
    withText.screens[1].layout.children.unshift({
      type: "TextBody",
      text: "Tell us about the medal",
    });
    const otherText = demoshopJson();
    otherText.screens[1].layout.children.unshift({
      type: "TextBody",
      text: "Another sentence",
    });
    const relabelled = demoshopJson();
    relabelled.screens[1].layout.children[1] = {
      ...relabelled.screens[1].layout.children[1],
      label: "Name on the medal",
    };

    expect(schemaOf(DEMOSHOP_FLOW_JSON)?.digest).toBe(digest);
    expect(schemaOf(withText)?.digest).toBe(digest);
    expect(schemaOf(otherText)?.digest).toBe(digest);
    expect(schemaOf(relabelled)?.digest).not.toBe(digest);
  });

  it("keeps a conditionally shown field as optional and leaves out answers it can't describe", () => {
    const schema = schemaOf(
      oneScreenFlow(
        [
          { type: "TextInput", name: "always", label: "Always" },
          {
            type: "TextInput",
            name: "maybe",
            label: "Maybe",
            required: true,
            visible: "${form.always}",
          },
          {
            type: "Dropdown",
            name: "dyn",
            label: "Dyn",
            "data-source": "${data.items}",
          },
          {
            type: "If",
            condition: "${form.always}",
            then: [{ type: "TextInput", name: "inif", label: "In if" }],
          },
        ],
        {
          always: "${form.always}",
          maybe: "${form.maybe}",
          dyn: "${form.dyn}",
          inif: "${form.inif}",
        }
      )
    );

    expect(
      schema?.fields.map(field => [
        field.responseKey,
        field.label,
        field.required,
      ])
    ).toEqual([
      ["always", "Always", false],
      ["maybe", "Maybe", false],
    ]);
    expect(schema?.coverage).toBe("partial");
  });

  it("stays complete around images and text it can't show", () => {
    const schema = schemaOf(
      oneScreenFlow(
        [
          { type: "Image", src: "https://example.test/medal.png" },
          { type: "TextBody", text: "Pick one", "font-weight": "bold" },
          { type: "TextInput", name: "name", label: "Name", required: true },
        ],
        { name: "${form.name}" }
      )
    );

    expect(schema?.coverage).toBe("complete");
    expect(schema?.fields.map(field => field.responseKey)).toEqual(["name"]);
  });

  it("marks a Flow with an endpoint partial", () => {
    const schema = schemaOf({ ...demoshopJson(), data_api_version: "3.0" });

    expect(schema).toMatchObject({ coverage: "partial", endpoint: true });
    expect(schema?.fields).toHaveLength(5);
  });

  it("marks a Flow partial when screens past the read limit are cut", () => {
    const flow = demoshopJson();
    const screens = [
      ...flow.screens,
      ...Array.from({ length: 18 }, (_, index) => ({
        id: `EXTRA_${index}`,
        title: "Extra",
        layout: {
          type: "SingleColumnLayout",
          children: [{ type: "TextBody", text: "More" }],
        },
      })),
    ];

    expect(schemaOf({ ...flow, screens })?.coverage).toBe("partial");
    expect(schemaOf({ ...flow, screens: screens.slice(0, 20) })?.coverage).toBe(
      "complete"
    );
  });

  it("marks a Flow partial when its finishing button can't be read", () => {
    const flow = demoshopJson();
    flow.screens[2].layout.children.pop();

    expect(schemaOf(flow)?.coverage).toBe("partial");
  });

  it("marks a Flow partial when a completion sends more answers than are kept", () => {
    const payload = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `answer_${index}`,
          `value_${index}`,
        ])
      );

    const kept = schemaOf(oneScreenFlow([], payload(40)));
    const cut = schemaOf(oneScreenFlow([], payload(41)));

    expect(kept?.coverage).toBe("complete");
    expect(cut?.coverage).toBe("partial");
    expect(cut?.fields).toHaveLength(
      MAX_SCENARIO_WHATSAPP_TEMPLATE_FORM_FIELDS
    );
  });

  it("keeps the saved fields within 32 KB and option titles to a label's length", () => {
    const dropdown = (name: string) => ({
      type: "Dropdown",
      name,
      label: name,
      "data-source": Array.from({ length: 100 }, (_, index) => ({
        id: `${name}_${index}_${"x".repeat(140)}`,
        title: `Option ${index} `.repeat(12),
      })),
    });
    const schema = schemaOf(
      oneScreenFlow([dropdown("first"), dropdown("second")], {
        first: "${form.first}",
        second: "${form.second}",
      })
    );

    expect(schema?.fields.map(field => field.responseKey)).toEqual(["first"]);
    expect(schema?.fields[0].options).toHaveLength(100);
    expect(
      schema?.fields[0].options.every(
        option =>
          option.title.length <= MAX_SCENARIO_FORM_LABEL_CHARACTERS &&
          option.title.endsWith("…")
      )
    ).toBe(true);
    expect(
      new TextEncoder().encode(JSON.stringify(schema?.fields)).length
    ).toBeLessThanOrEqual(32 * 1024);
    expect(schema?.coverage).toBe("partial");
  });

  it("reads nothing from JSON without screens", () => {
    expect(schemaOf(null)).toBeNull();
    expect(schemaOf({ version: "7.3", screens: [] })).toBeNull();
  });
});
