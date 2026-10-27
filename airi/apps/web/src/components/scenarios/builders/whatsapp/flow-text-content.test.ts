import {
  listScenarioFormFields,
  validateWhatsAppFlowStaticGraph,
  type WhatsAppFlowTextType,
} from "@icecore/scenario-contracts";
import { generateFlowJson, type FlowJson } from "./flow-json-generator";
import { parseFlowJsonToWhatsAppFlowConfig } from "./flow-json-parser";
import { META_STARTER_FLOW_JSON } from "./flow-json-fixtures";
import { validateWhatsAppFlowConfig } from "./flow-validation";
import { sanitizeWhatsAppFlowConfig } from "@/lib/scenarios/whatsapp-flow-config";

const parse = (flowJson: unknown) =>
  parseFlowJsonToWhatsAppFlowConfig({ flowJson, flowId: "starter" });
const starter = () => structuredClone(META_STARTER_FLOW_JSON);

describe("lossless static text Flow authoring", () => {
  it("imports Meta's exact saved Welcome starter without creating answer fields", () => {
    const config = parse(META_STARTER_FLOW_JSON);
    expect(config).not.toBeNull();
    expect(config!.screens[0]!.fields).toEqual([]);
    expect(config!.screens[0]!.success).toBe(true);
    expect(config!.screens[0]!.layoutContent).toEqual([
      expect.objectContaining({
        kind: "text",
        type: "TextHeading",
        text: "Hello World",
        id: expect.any(String),
      }),
      expect.objectContaining({
        kind: "text",
        type: "TextBody",
        text: "Let's start building things!",
        id: expect.any(String),
      }),
    ]);
    expect(listScenarioFormFields(config)).toEqual([]);
    expect(validateWhatsAppFlowConfig(config).issues).toEqual([]);
    expect(generateFlowJson(config!)).toEqual(META_STARTER_FLOW_JSON);
    expect(generateFlowJson(sanitizeWhatsAppFlowConfig(config)!)).toEqual(
      META_STARTER_FLOW_JSON
    );
    expect(JSON.stringify(generateFlowJson(config!))).not.toContain(
      '"layoutContent"'
    );
  });

  it("preserves text/field ordering, Form wrappers and exact literal whitespace", () => {
    const json = starter();
    json.screens[0]!.layout.children = [
      {
        type: "Form",
        name: "welcome_form",
        children: [
          { type: "TextHeading", text: "  Welcome <friend>  " },
          {
            type: "TextInput",
            name: "name",
            label: "Name",
            required: true,
            "input-type": "text",
          },
          { type: "TextSubheading", text: "More details" },
          { type: "TextBody", text: "Line one\nLine two" },
          {
            type: "TextInput",
            name: "city",
            label: "City",
            required: false,
            "input-type": "text",
          },
          { type: "TextCaption", text: "A short note" },
          {
            type: "Footer",
            label: "Complete",
            "on-click-action": {
              name: "complete",
              payload: { name: "${form.name}", city: "${form.city}" },
            },
          },
        ],
      },
    ];
    const config = parse(json);
    expect(config).not.toBeNull();
    expect(config!.screens[0]!.fields.map(field => field.id)).toEqual([
      "name",
      "city",
    ]);
    expect(
      listScenarioFormFields(config).map(field => field.responseKey)
    ).toEqual(["name", "city"]);
    expect(generateFlowJson(config!)).toEqual(json);
    expect(generateFlowJson(sanitizeWhatsAppFlowConfig(config)!)).toEqual(json);
  });

  it.each([undefined, false, true])(
    "preserves success=%s without inserting its default",
    success => {
      const json = starter();
      if (success === undefined) delete json.screens[0]!.success;
      else json.screens[0]!.success = success;
      const config = parse(json);
      expect(config).not.toBeNull();
      expect(generateFlowJson(config!)).toEqual(json);
    }
  );

  it.each([
    ["TextHeading", 80],
    ["TextSubheading", 80],
    ["TextBody", 4096],
    ["TextCaption", 409],
  ] as Array<[WhatsAppFlowTextType, number]>)(
    "accepts the %s boundary and rejects longer text",
    (type, limit) => {
      const json = starter();
      json.screens[0]!.layout.children[0] = { type, text: "x".repeat(limit) };
      expect(parse(json)).not.toBeNull();
      json.screens[0]!.layout.children[0] = {
        type,
        text: "x".repeat(limit + 1),
      };
      expect(parse(json)).toBeNull();
    }
  );

  it.each([
    { type: "TextHeading", text: " " },
    { type: "TextHeading", text: "${data.heading}" },
    { type: "TextHeading", text: "Hello", visible: true },
    { type: "TextBody", text: "Hello", "font-weight": "bold" },
    { type: "TextBody", text: "Hello", markdown: true },
    { type: "TextCaption", text: "Hello", unknown: true },
  ])("keeps unsupported text content in complete JSON mode: %j", component => {
    const json = starter();
    json.screens[0]!.layout.children[0] = component;
    expect(parse(json)).toBeNull();
  });

  it("rejects success on non-terminal screens and text alongside NavigationLists", () => {
    const config = parse(META_STARTER_FLOW_JSON)!;
    config.screens[0]!.terminal = false;
    expect(
      validateWhatsAppFlowStaticGraph(config).some(
        issue => issue.code === "flow_screen_success_invalid"
      )
    ).toBe(true);
    config.screens[0]!.fields = [
      {
        id: "choices",
        label: "",
        fieldType: "NavigationList",
        navigationItems: [
          {
            id: "next",
            title: "Next",
            action: { name: "navigate", nextScreenId: "NEXT" },
          },
        ],
      },
    ];
    config.screens[0]!.success = undefined;
    config.screens[0]!.footer = undefined;
    config.screens[0]!.layoutContent!.push({
      kind: "field",
      fieldId: "choices",
    });
    expect(
      validateWhatsAppFlowStaticGraph(config).some(
        issue => issue.code === "flow_navigation_composition_invalid"
      )
    ).toBe(true);
  });

  it("bounds the complete ordered component list, including the Footer", () => {
    const json = starter();
    const footer = json.screens[0]!.layout.children.at(-1)!;
    json.screens[0]!.layout.children = [
      ...Array.from({ length: 49 }, () => ({ type: "TextBody", text: "Note" })),
      footer,
    ];
    expect(parse(json)).not.toBeNull();
    json.screens[0]!.layout.children.splice(0, 0, {
      type: "TextBody",
      text: "Too many",
    });
    expect(parse(json)).toBeNull();
  });

  it("retains the existing JSON-only boundary for explicit static routing models", () => {
    const json: FlowJson = {
      ...starter(),
      routing_model: { WELCOME_SCREEN: [] },
    };
    expect(parse(json)).toBeNull();
  });
});
