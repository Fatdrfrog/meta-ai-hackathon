import type { WhatsAppFlowConfig } from "@/components/scenarios/types";
import { generateFlowJson } from "./flow-json-generator";
import { parseFlowJsonToWhatsAppFlowConfig } from "./flow-json-parser";

const COMPATIBLE_FLOW_JSON = {
  version: "6.3",
  screens: [
    {
      id: "LEAD_FORM",
      title: "Lead form",
      terminal: true,
      layout: {
        type: "SingleColumnLayout",
        children: [
          {
            type: "Form",
            name: "LEAD_FORM_form",
            children: [
              {
                type: "TextInput",
                name: "email",
                label: "Email",
                required: true,
                "input-type": "text",
              },
              {
                type: "Footer",
                label: "Submit",
                "on-click-action": {
                  name: "complete",
                  payload: {
                    email: "${form.email}",
                  },
                },
              },
            ],
          },
        ],
      },
    },
  ],
};

const COMPATIBLE_TWO_SCREEN_FLOW_JSON = {
  version: "6.3",
  screens: [
    {
      id: "FIRST",
      title: "First",
      layout: {
        type: "SingleColumnLayout",
        children: [
          {
            type: "Form",
            name: "FIRST_form",
            children: [
              {
                type: "TextInput",
                name: "name",
                label: "Name",
                required: true,
                "input-type": "text",
              },
              {
                type: "Footer",
                label: "Submit",
                "on-click-action": {
                  name: "navigate",
                  payload: { name: "${form.name}" },
                  next: { type: "screen", name: "SECOND" },
                },
              },
            ],
          },
        ],
      },
    },
    {
      id: "SECOND",
      title: "Second",
      terminal: true,
      data: {
        name: { type: "string", __example__: " " },
      },
      layout: {
        type: "SingleColumnLayout",
        children: [
          {
            type: "Form",
            name: "SECOND_form",
            children: [
              {
                type: "TextInput",
                name: "email",
                label: "Email",
                required: true,
                "input-type": "text",
              },
              {
                type: "Footer",
                label: "Submit",
                "on-click-action": {
                  name: "complete",
                  payload: {
                    name: "${data.name}",
                    email: "${form.email}",
                  },
                },
              },
            ],
          },
        ],
      },
    },
  ],
};

const COMPATIBLE_ENDPOINT_FLOW_JSON = {
  version: "7.3",
  data_api_version: "4.0",
  routing_model: {
    FIRST: ["SECOND"],
    SECOND: [],
  },
  screens: [
    {
      id: "FIRST",
      title: "First",
      layout: {
        type: "SingleColumnLayout",
        children: [
          {
            type: "Form",
            name: "FIRST_form",
            children: [
              {
                type: "TextInput",
                name: "name",
                label: "Name",
                required: true,
                "input-type": "text",
              },
              {
                type: "Footer",
                label: "Submit",
                "on-click-action": {
                  name: "data_exchange",
                  payload: { name: "${form.name}" },
                },
              },
            ],
          },
        ],
      },
    },
    {
      id: "SECOND",
      title: "Second",
      terminal: true,
      data: {
        name: { type: "string", __example__: " " },
      },
      layout: {
        type: "SingleColumnLayout",
        children: [
          {
            type: "Form",
            name: "SECOND_form",
            children: [
              {
                type: "TextInput",
                name: "email",
                label: "Email",
                required: true,
                "input-type": "text",
              },
              {
                type: "Footer",
                label: "Submit",
                "on-click-action": {
                  name: "complete",
                  payload: {
                    name: "${data.name}",
                    email: "${form.email}",
                  },
                },
              },
            ],
          },
        ],
      },
    },
  ],
};

function parse(flowJson: unknown) {
  return parseFlowJsonToWhatsAppFlowConfig({
    flowJson,
    flowId: "flow-1",
    flowName: "Lead form",
    flowStatus: "DRAFT",
  });
}

describe("parseFlowJsonToWhatsAppFlowConfig", () => {
  it.each(["linear", "data_endpoint"] as const)(
    "round-trips typed checkbox answers from a hand-authored %s Flow",
    flowNavigationMode => {
      const flowJson = {
        ...structuredClone(COMPATIBLE_TWO_SCREEN_FLOW_JSON),
        ...(flowNavigationMode === "data_endpoint"
          ? {
              version: "7.3",
              data_api_version: "4.0",
              routing_model: { FIRST: ["SECOND"], SECOND: [] },
            }
          : {}),
      };
      const firstForm = flowJson.screens[0]!.layout.children[0]!;
      firstForm.children[0] = {
        type: "CheckboxGroup",
        name: "interests",
        label: "Products",
        required: true,
        "data-source": [
          { id: "phone", title: "Phones" },
          { id: "laptop", title: "Laptops" },
        ],
      } as never;
      firstForm.children[1]!["on-click-action"] = {
        name:
          flowNavigationMode === "data_endpoint" ? "data_exchange" : "navigate",
        payload: { interests: "${form.interests}" },
        ...(flowNavigationMode === "linear"
          ? { next: { type: "screen", name: "SECOND" } }
          : {}),
      } as never;
      flowJson.screens[1]!.data = {
        interests: {
          type: "array",
          items: { type: "string" },
          __example__: [],
        },
      } as never;
      const finalFooter = flowJson.screens[1]!.layout.children[0]!.children[1]!;
      finalFooter["on-click-action"]!.payload = {
        interests: "${data.interests}",
        email: "${form.email}",
      } as never;

      const config = parse(flowJson);
      expect(config?.screens[0]?.fields[0]).toEqual({
        id: "interests",
        label: "Products",
        fieldType: "CheckboxGroup",
        required: true,
        options: [
          { id: "phone", title: "Phones" },
          { id: "laptop", title: "Laptops" },
        ],
      });
      expect(generateFlowJson(config!)).toEqual(flowJson);
    }
  );

  it("accepts Flow JSON that the local model can reproduce exactly", () => {
    expect(parse(COMPATIBLE_FLOW_JSON)).toEqual(
      expect.objectContaining({
        metaFlowId: "flow-1",
        metaFlowName: "Lead form",
        metaFlowStatus: "DRAFT",
        screens: [
          expect.objectContaining({
            id: "LEAD_FORM",
            fields: [
              expect.objectContaining({
                id: "email",
                fieldType: "TextInput",
              }),
            ],
          }),
        ],
      })
    );
  });

  it("accepts the app's exact two-screen linear Flow JSON", () => {
    expect(parse(COMPATIBLE_TWO_SCREEN_FLOW_JSON)).toEqual(
      expect.objectContaining({
        metaFlowId: "flow-1",
        screens: [
          expect.objectContaining({ id: "FIRST" }),
          expect.objectContaining({ id: "SECOND" }),
        ],
      })
    );
  });

  it("rejects an unsupported property before reading its value", () => {
    const flowJson = structuredClone(COMPATIBLE_FLOW_JSON);
    const form = flowJson.screens[0]!.layout.children[0]!;
    const textInput = form.children![0]! as Record<string, unknown>;
    let unsupportedPropertyReads = 0;
    Object.defineProperty(textInput, "unsupported", {
      enumerable: true,
      get() {
        unsupportedPropertyReads += 1;
        return "not-supported";
      },
    });

    expect(parse(flowJson)).toBeNull();
    expect(unsupportedPropertyReads).toBe(0);
  });

  it("rejects an unsupported component instead of dropping it", () => {
    const flowJson = structuredClone(COMPATIBLE_FLOW_JSON);
    flowJson.screens[0]!.layout.children.unshift({
      type: "TextHeading",
      text: "Tell us about yourself",
    } as never);

    expect(parse(flowJson)).toBeNull();
  });

  it("rejects an unsupported component property instead of changing it", () => {
    const flowJson = structuredClone(COMPATIBLE_FLOW_JSON);
    const form = flowJson.screens[0]!.layout.children[0]!;
    const textInput = form.children![0]!;
    textInput["input-type"] = "email";

    expect(parse(flowJson)).toBeNull();
  });

  it("imports hand-authored endpoint Flow JSON without losing routing metadata", () => {
    const imported = parse(COMPATIBLE_ENDPOINT_FLOW_JSON);

    expect(imported).toEqual(
      expect.objectContaining({
        flowNavigationMode: "data_endpoint",
        screenRoutes: { FIRST: ["SECOND"] },
        screens: [
          expect.objectContaining({ id: "FIRST" }),
          expect.objectContaining({ id: "SECOND" }),
        ],
      })
    );
  });

  it("preserves either supported JSON version independently of endpoint navigation", () => {
    const source = {
      ...structuredClone(COMPATIBLE_ENDPOINT_FLOW_JSON),
      version: "6.3",
    };
    const config = parse(source);
    expect(config).toMatchObject({
      flowJsonVersion: "6.3",
      flowNavigationMode: "data_endpoint",
    });
    expect(generateFlowJson(config!)).toEqual(source);
  });

  it("preserves JSON 7.3 with static navigation and no data API metadata", () => {
    const source = { ...structuredClone(COMPATIBLE_FLOW_JSON), version: "7.3" };
    const config = parse(source);
    expect(config).not.toBeNull();
    expect(generateFlowJson(config!)).toEqual(source);
  });

  it("rejects endpoint routing metadata without a valid endpoint topology", () => {
    const flowJson = {
      ...structuredClone(COMPATIBLE_FLOW_JSON),
      data_api_version: "4.0",
      routing_model: {
        LEAD_FORM: [],
      },
    };

    expect(parse(flowJson)).toBeNull();
  });

  it("rejects oversized routing arrays before reading their entries", () => {
    const flowJson = structuredClone(COMPATIBLE_ENDPOINT_FLOW_JSON);
    let routeEntryReads = 0;
    const oversizedTargets = new Proxy(
      Array.from({ length: 11 }, () => "SECOND"),
      {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            routeEntryReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      }
    );
    flowJson.routing_model.FIRST = oversizedTargets;

    expect(parse(flowJson)).toBeNull();
    expect(routeEntryReads).toBe(0);
  });

  it("rejects numeric versions before inspecting the remaining Flow JSON", () => {
    const flowJson: Record<string, unknown> = structuredClone(
      COMPATIBLE_ENDPOINT_FLOW_JSON
    );
    const screens = flowJson.screens;
    let screenReads = 0;
    flowJson.version = 7.3;
    Object.defineProperty(flowJson, "screens", {
      enumerable: true,
      get() {
        screenReads += 1;
        return screens;
      },
    });

    expect(parse(flowJson)).toBeNull();
    expect(screenReads).toBe(0);
  });

  it("rejects a screen that would otherwise become a synthetic placeholder", () => {
    const flowJson = structuredClone(COMPATIBLE_FLOW_JSON);
    flowJson.screens[0]!.layout.children = [
      {
        type: "TextHeading",
        text: "Unsupported-only screen",
      },
    ] as never;

    expect(parse(flowJson)).toBeNull();
  });

  it("rejects Flow JSON instead of truncating fields or screens", () => {
    const fieldHeavyConfig: WhatsAppFlowConfig = {
      templateId: "existing_flow",
      ctaText: "Open",
      flowUiLocale: "en",
      screens: [
        {
          id: "FIELD_HEAVY",
          title: "Field heavy",
          fields: Array.from({ length: 51 }, (_, index) => ({
            id: `field_${index + 1}`,
            label: `Field ${index + 1}`,
            fieldType: "TextInput" as const,
            required: false,
          })),
        },
      ],
    };
    const screenHeavyConfig: WhatsAppFlowConfig = {
      templateId: "existing_flow",
      ctaText: "Open",
      flowUiLocale: "en",
      screens: Array.from({ length: 21 }, (_, index) => ({
        id: `SCREEN_${String.fromCharCode(65 + index)}`,
        title: `Screen ${index + 1}`,
        fields: [
          {
            id: `field_${index + 1}`,
            label: `Field ${index + 1}`,
            fieldType: "TextInput" as const,
            required: false,
          },
        ],
      })),
    };

    expect(parse(generateFlowJson(fieldHeavyConfig))).toBeNull();
    expect(parse(generateFlowJson(screenHeavyConfig))).toBeNull();
  });
});
