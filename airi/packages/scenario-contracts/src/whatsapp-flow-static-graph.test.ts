import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateWhatsAppFlowPayload,
  isWhatsAppFlowPayloadValue,
  parseWhatsAppFlowDataSchema,
  parseWhatsAppFlowScreenAction,
  validateWhatsAppFlowStaticGraph,
} from "./whatsapp-flow-static-graph.ts";
import type {
  WhatsAppFlowConfig,
  WhatsAppFlowDataSchema,
  WhatsAppFlowPayloadValue,
} from "./scenario-channel-configs.ts";

describe("static Flow action contracts", () => {
  const navigationGraph = (): WhatsAppFlowConfig => ({
    templateId: "test",
    ctaText: "Open",
    flowNavigationMode: "static_graph",
    screens: [
      {
        id: "START",
        title: "Start",
        fields: [
          {
            id: "choices",
            label: "",
            fieldType: "NavigationList",
            navigationItems: [
              {
                id: "one",
                title: "One",
                action: { name: "navigate", nextScreenId: "END" },
              },
            ],
          },
        ],
      },
      {
        id: "END",
        title: "End",
        terminal: true,
        fields: [],
        footer: { label: "Done", action: { name: "complete", payload: {} } },
      },
    ],
  });
  it("rejects NavigationLists mixed with ordinary fields or a Footer", () => {
    for (const mixedField of [true, false]) {
      const config = navigationGraph();
      if (mixedField)
        config.screens[0]!.fields.push({
          id: "name",
          label: "Name",
          fieldType: "TextInput",
        });
      else
        config.screens[0]!.footer = {
          label: "Next",
          action: { name: "navigate", nextScreenId: "END" },
        };
      assert.ok(
        validateWhatsAppFlowStaticGraph(config).some(
          (issue) => issue.code === "flow_navigation_composition_invalid",
        ),
      );
    }
  });
  it("rejects more than two NavigationLists and terminal NavigationLists", () => {
    for (const terminal of [true, false]) {
      const config = navigationGraph();
      if (terminal) config.screens[0]!.terminal = true;
      else
        for (const id of ["second", "third"])
          config.screens[0]!.fields.push({
            ...config.screens[0]!.fields[0]!,
            id,
          });
      assert.ok(
        validateWhatsAppFlowStaticGraph(config).some(
          (issue) => issue.code === "flow_navigation_composition_invalid",
        ),
      );
    }
  });
  it("allows two NavigationLists inside the preserved Form wrapper", () => {
    const config = navigationGraph();
    config.screens[0]!.layoutForm = { name: "choices_form" };
    config.screens[0]!.fields.push({
      ...config.screens[0]!.fields[0]!,
      id: "second",
    });
    assert.deepEqual(validateWhatsAppFlowStaticGraph(config), []);
  });
  const carriedSchemaGraph = (
    source: WhatsAppFlowDataSchema,
    target: WhatsAppFlowDataSchema,
  ): WhatsAppFlowConfig => ({
    templateId: "test",
    ctaText: "Open",
    flowNavigationMode: "static_graph",
    screens: [
      {
        id: "START",
        title: "Start",
        fields: [],
        data: { value: source },
        footer: {
          label: "Next",
          action: {
            name: "navigate",
            nextScreenId: "END",
            payload: { carried: "${data.value}" },
          },
        },
      },
      {
        id: "END",
        title: "End",
        terminal: true,
        fields: [],
        data: { carried: target },
        footer: { label: "Done", action: { name: "complete", payload: {} } },
      },
    ],
  });
  it("rejects transported arrays with incompatible item schemas", () => {
    const config = carriedSchemaGraph(
      { type: "array", items: { type: "number" } },
      { type: "array", items: { type: "string" } },
    );
    assert.ok(
      validateWhatsAppFlowStaticGraph(config).some(
        (issue) => issue.code === "flow_graph_payload_invalid",
      ),
    );
  });
  it("rejects transported objects with incompatible nested property schemas", () => {
    const config = carriedSchemaGraph(
      {
        type: "object",
        properties: {
          nested: { type: "object", properties: { score: { type: "number" } } },
        },
      },
      {
        type: "object",
        properties: {
          nested: { type: "object", properties: { score: { type: "string" } } },
        },
      },
    );
    assert.ok(
      validateWhatsAppFlowStaticGraph(config).some(
        (issue) => issue.code === "flow_graph_payload_invalid",
      ),
    );
  });
  it("accepts compatible transported schemas with additional source properties", () => {
    const config = carriedSchemaGraph(
      {
        type: "object",
        properties: {
          choices: { type: "array", items: { type: "string" } },
          extra: { type: "number" },
        },
      },
      {
        type: "object",
        properties: { choices: { type: "array", items: { type: "string" } } },
      },
    );
    assert.equal(
      validateWhatsAppFlowStaticGraph(config).some(
        (issue) => issue.code === "flow_graph_payload_invalid",
      ),
      false,
    );
  });
  it("rejects non-string schema types without coercing them", () => {
    let conversions = 0;
    assert.equal(
      parseWhatsAppFlowDataSchema({
        type: {
          toString: () => {
            conversions++;
            return "string";
          },
        },
      }),
      null,
    );
    assert.equal(conversions, 0);
  });
  it("decodes only supported navigation structures and preserves omitted versus empty payload", () => {
    assert.deepEqual(
      parseWhatsAppFlowScreenAction({
        name: "navigate",
        next: { type: "screen", name: "END" },
      }),
      { name: "navigate", nextScreenId: "END" },
    );
    assert.deepEqual(
      parseWhatsAppFlowScreenAction({ name: "complete", payload: {} }),
      { name: "complete", payload: {} },
    );
    assert.equal(
      parseWhatsAppFlowScreenAction({
        name: "complete",
        next: { type: "screen", name: "END" },
      }),
      null,
    );
    assert.equal(
      parseWhatsAppFlowScreenAction({
        name: "navigate",
        next: { type: "screen", name: "END" },
        unknown: true,
      }),
      null,
    );
  });
  it("preserves recursive constants, aliases and arrays while resolving only declared references", () => {
    assert.deepEqual(
      evaluateWhatsAppFlowPayload(
        {
          __answer: "${form.choice}",
          nested: { city: "${data.city}", constant: "4_Басқа", count: 3 },
        },
        { form: { choice: ["a", "b"] }, data: { city: "Shymkent" } },
      ),
      {
        ok: true,
        value: {
          __answer: ["a", "b"],
          nested: { city: "Shymkent", constant: "4_Басқа", count: 3 },
        },
      },
    );
    assert.deepEqual(
      evaluateWhatsAppFlowPayload(
        { missing: "${data.missing}" },
        { form: {}, data: {} },
      ),
      { ok: false },
    );
  });
  it("rejects a non-object root payload instead of returning a false success", () => {
    assert.deepEqual(
      evaluateWhatsAppFlowPayload(
        "bad" as unknown as Record<string, WhatsAppFlowPayloadValue>,
        { form: {}, data: {} },
      ),
      { ok: false },
    );
  });
  it("rejects schema examples whose declared types disagree", () => {
    assert.equal(
      parseWhatsAppFlowDataSchema({ type: "string", __example__: true }),
      null,
    );
    assert.equal(
      parseWhatsAppFlowDataSchema({
        type: "array",
        items: { type: "string" },
        __example__: [7],
      }),
      null,
    );
  });
  it("bounds oversized payload objects before evaluating getters", () => {
    const payload: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: 2001 }, (_, index) => [`key_${index}`, null]),
    );
    let reads = 0;
    Object.defineProperty(payload, "key_0", {
      enumerable: true,
      get: () => {
        reads++;
        return "value";
      },
    });
    assert.equal(isWhatsAppFlowPayloadValue(payload), false);
    assert.equal(reads, 0);
  });
  it("reports oversized screen graphs without traversing actions", () => {
    let reads = 0;
    const screen = { id: "SCREEN", title: "Screen", fields: [] };
    Object.defineProperty(screen, "footer", {
      get: () => {
        reads++;
        throw new Error("should not inspect");
      },
    });
    const config = {
      templateId: "test",
      ctaText: "Open",
      flowNavigationMode: "static_graph",
      screens: Array.from({ length: 21 }, () => screen),
    } as WhatsAppFlowConfig;
    assert.equal(
      validateWhatsAppFlowStaticGraph(config).some(
        (issue) => issue.code === "flow_graph_bounds_exceeded",
      ),
      true,
    );
    assert.equal(reads, 0);
  });
});
