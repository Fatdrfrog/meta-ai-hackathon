import {
  generateFlowJson,
  convertWhatsAppFlowToStaticGraph,
} from "./flow-json-generator";
import { parseFlowJsonToWhatsAppFlowConfig } from "./flow-json-parser";
import { DEMOSHOP_FLOW_JSON } from "./flow-json-fixtures";
import { validateWhatsAppFlowConfig } from "./flow-validation";
import {
  sanitizeWhatsAppFlowConfig,
  renameWhatsAppFlowScreen,
} from "@/lib/scenarios/whatsapp-flow-config";
import { evaluateWhatsAppFlowPayload } from "@icecore/scenario-contracts";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";

const parse = (flowJson: unknown) =>
  parseFlowJsonToWhatsAppFlowConfig({ flowJson, flowId: "synthetic-flow" });

describe("static Flow graph import and generation", () => {
  it("preserves NavigationList branches and exact completion aliases across both terminal screens", () => {
    const config = parse(DEMOSHOP_FLOW_JSON);
    expect(config).not.toBeNull();
    expect(config).toMatchObject({
      flowNavigationMode: "static_graph",
      flowJsonVersion: "6.3",
    });
    expect(generateFlowJson(config!)).toEqual(DEMOSHOP_FLOW_JSON);
    expect(validateWhatsAppFlowConfig(config).issues).toEqual([]);
    expect(generateFlowJson(sanitizeWhatsAppFlowConfig(config)!)).toEqual(
      DEMOSHOP_FLOW_JSON
    );
  });

  it("keeps the JSON version independent of static navigation", () => {
    const source = { ...DEMOSHOP_FLOW_JSON, version: "7.3" };
    const config = parse(source);
    expect(config).not.toBeNull();
    expect(generateFlowJson(config!)).toEqual(source);
  });

  it("preserves explicit form names, false terminal markers and empty payload objects", () => {
    const source = structuredClone(DEMOSHOP_FLOW_JSON);
    const first = source.screens[0]!;
    Object.assign(first, { terminal: false });
    const navigation = first.layout.children[0]!;
    Object.assign(navigation["list-items"]![3]!["on-click-action"], {
      payload: {},
    });
    Object.assign(first.layout, {
      children: [{ type: "Form", name: "custom_form", children: [navigation] }],
    });
    const config = parse(source);
    expect(config).not.toBeNull();
    expect(generateFlowJson(config!)).toEqual(source);
  });

  it("rejects unknown NavigationList content instead of silently losing it", () => {
    const source = structuredClone(DEMOSHOP_FLOW_JSON);
    Object.assign(source.screens[0]!.layout.children[0]!["list-items"]![0]!, {
      badge: "new",
    });
    expect(parse(source)).toBeNull();
  });
});

describe("static graph validation and editing", () => {
  const config = () => parse(structuredClone(DEMOSHOP_FLOW_JSON))!;
  it("rejects NavigationList authoring outside explicit static graph mode", () => {
    const source = config();
    source.screens = source.screens.slice(0, 2);
    source.flowNavigationMode = "linear";
    expect(validateWhatsAppFlowConfig(source).isValid).toBe(false);
  });

  it("does not mutate the imported source document while editing payloads", () => {
    const source = structuredClone(DEMOSHOP_FLOW_JSON);
    const imported = parse(source)!;
    imported.screens[1]!.footer!.action.payload!.__9ba1c9 = "changed";
    expect(
      source.screens[1]!.layout.children.at(-1)!["on-click-action"]!.payload!
        .__9ba1c9
    ).toBe("${data.sport}");
  });

  it("rejects duplicate input names within a screen while allowing mutually exclusive branch names", () => {
    const source = config();
    source.screens[1]!.fields.push({ ...source.screens[1]!.fields[0]! });
    expect(validateWhatsAppFlowConfig(source).issues).toContainEqual({
      code: "flow_field_id_duplicate_within_screen",
      path: "screens[1].fields[3].id",
    });
    expect(parse(generateFlowJson(source))).toBeNull();
  });

  it.each([
    "target",
    "unreachable",
    "cycle",
    "nonterminal",
    "reference",
    "undeclared",
    "type",
  ])("rejects invalid %s topology or payload", failure => {
    const source = config();
    const navigation = source.screens[0]!.fields[0]!.navigationItems!;
    if (failure === "target")
      navigation[0]!.action = { name: "navigate", nextScreenId: "MISSING" };
    if (failure === "unreachable") navigation.pop();
    if (failure === "cycle") {
      source.screens[1]!.terminal = false;
      source.screens[1]!.footer!.action = {
        name: "navigate",
        nextScreenId: "QUESTION_ONE",
      };
    }
    if (failure === "nonterminal") source.screens[1]!.terminal = false;
    if (failure === "reference")
      source.screens[1]!.footer!.action.payload!.__9ba1c9 = "${form.missing}";
    if (failure === "undeclared")
      navigation[0]!.action.payload = { wrong: "sport" };
    if (failure === "type") navigation[0]!.action.payload = { sport: true };
    expect(validateWhatsAppFlowConfig(source).isValid).toBe(false);
    expect(parse(generateFlowJson(source))).toBeNull();
  });

  it("rejects duplicate item ids and overlong descriptions without truncating content", () => {
    const source = config();
    const navigation = source.screens[0]!.fields[0]!.navigationItems!;
    navigation[1]!.id = navigation[0]!.id;
    navigation[0]!.description = "x".repeat(21);
    source.screens[1]!.fields[0]!.options![0]!.description = "x".repeat(301);
    expect(
      validateWhatsAppFlowConfig(source).issues.map(issue => issue.code)
    ).toEqual(
      expect.arrayContaining([
        "flow_navigation_items_invalid",
        "flow_navigation_item_text_invalid",
        "flow_option_description_max_length",
      ])
    );
    expect(parse(generateFlowJson(source))).toBeNull();
  });

  it("rejects unsupported expressions and deeply nested payloads", () => {
    const source = config();
    source.screens[1]!.footer!.action.payload!.__9ba1c9 =
      "${data.sport == 'football'}";
    expect(validateWhatsAppFlowConfig(source).isValid).toBe(false);
    expect(parse(generateFlowJson(source))).toBeNull();
    let nested: unknown = "constant";
    for (let index = 0; index < 14; index++) nested = { value: nested };
    Object.assign(source.screens[1]!.footer!.action, { payload: { nested } });
    expect(validateWhatsAppFlowConfig(source).isValid).toBe(false);
  });

  it("rejects blank NavigationList names instead of generating a replacement name", () => {
    const source = config();
    source.screens[0]!.fields[0]!.id = "";
    expect(validateWhatsAppFlowConfig(source).isValid).toBe(false);
  });
  it("rejects out-of-bounds footer labels on visual import", () => {
    const oversized = structuredClone(DEMOSHOP_FLOW_JSON);
    oversized.screens[1]!.layout.children.at(-1)!.label = "x".repeat(36);
    expect(parse(oversized)).toBeNull();
  });

  it("bounds item and component counts before inspecting their values", () => {
    const oversized = structuredClone(DEMOSHOP_FLOW_JSON);
    Object.assign(oversized.screens[0]!.layout.children[0]!, {
      "list-items": Array.from({ length: 21 }, () => null),
    });
    expect(parse(oversized)).toBeNull();
    const source = config();
    source.screens[1]!.fields = Array.from({ length: 51 }, (_, index) => ({
      id: `f_${index}`,
      label: "Name",
      fieldType: "TextInput" as const,
    }));
    expect(validateWhatsAppFlowConfig(source).isValid).toBe(false);
  });

  it("does not substitute a normalised action or schema for unknown metadata", () => {
    const source = structuredClone(DEMOSHOP_FLOW_JSON);
    Object.assign(source.screens[1]!.data!.sport, { unsupported: true });
    expect(parse(source)).toBeNull();
    const customAction = structuredClone(DEMOSHOP_FLOW_JSON);
    Object.assign(
      customAction.screens[0]!.layout.children[0]!["list-items"]![0]![
        "on-click-action"
      ],
      { custom: true }
    );
    expect(parse(customAction)).toBeNull();
  });

  it("renames one graph screen and rewrites every navigation target without changing payloads", () => {
    const before = config();
    const renamed = renameWhatsAppFlowScreen(before, 1, "details_2");
    expect(renamed.screens[1]!.id).toBe("details_TWO");
    expect(
      renamed.screens[0]!.fields[0]!.navigationItems!.slice(0, 3).map(
        item => item.action
      )
    ).toEqual(
      before.screens[0]!.fields[0]!.navigationItems!.slice(0, 3).map(item => ({
        ...item.action,
        nextScreenId: "details_TWO",
      }))
    );
    expect(before.screens[1]!.id).toBe("DETAILS");
    expect(validateWhatsAppFlowConfig(renamed).isValid).toBe(true);
  });

  it("promotes a legacy sequential config without changing the generated wire document", () => {
    const linear = {
      templateId: "simple",
      ctaText: "Open",
      screens: [
        {
          id: "FIRST",
          title: "First",
          fields: [
            { id: "name", label: "Name", fieldType: "TextInput" as const },
          ],
        },
        {
          id: "SECOND",
          title: "Second",
          fields: [
            { id: "city", label: "City", fieldType: "TextInput" as const },
          ],
        },
      ],
    };
    const promoted = convertWhatsAppFlowToStaticGraph(linear);
    expect(promoted?.flowNavigationMode).toBe("static_graph");
    expect(generateFlowJson(promoted!)).toEqual(generateFlowJson(linear));
    expect(validateWhatsAppFlowConfig(promoted).isValid).toBe(true);
    expect(
      convertWhatsAppFlowToStaticGraph({
        ...linear,
        flowNavigationMode: "data_endpoint",
      })
    ).toBeNull();
  });
  it("preserves scenario sending and provider metadata while promoting linear navigation", () => {
    const linear: WhatsAppFlowConfig = {
      templateId: "simple",
      ctaText: "Open",
      flowMode: "draft",
      categories: ["OTHER"],
      flowActionPayload: { screen: "FIRST", data: { customer: "Ada" } },
      answersKey: "registration",
      providerReference: {
        flowId: "123",
        sourceId: "source",
        wabaId: "waba",
        providerStatus: "DRAFT",
      },
      screens: [
        {
          id: "FIRST",
          title: "First",
          fields: [{ id: "name", label: "Name", fieldType: "TextInput" }],
        },
      ],
    };
    const promoted = convertWhatsAppFlowToStaticGraph(linear);
    expect(promoted).toMatchObject({
      flowMode: linear.flowMode,
      categories: linear.categories,
      flowActionPayload: linear.flowActionPayload,
      answersKey: linear.answersKey,
      providerReference: linear.providerReference,
    });
    expect(generateFlowJson(promoted!)).toEqual(generateFlowJson(linear));
  });
});

describe("static payload evaluation", () => {
  it("emits exact completion aliases, constants and selected branch data", () => {
    const source = parse(DEMOSHOP_FLOW_JSON)!;
    const result = evaluateWhatsAppFlowPayload(
      source.screens[1]!.footer!.action.payload,
      {
        data: { sport: "1_Таэквондо_/_Каратэ_/_Күрес" },
        form: {
          ____133f36: "1_Классикалық",
          _68d224: "Aruzhan",
          _ebfcfb: "Shymkent",
        },
      }
    );
    expect(result).toEqual({
      ok: true,
      value: {
        __9ba1c9: "1_Таэквондо_/_Каратэ_/_Күрес",
        ____133f36: "1_Классикалық",
        _68d224: "Aruzhan",
        _ebfcfb: "Shymkent",
      },
    });
  });
  it("preserves user answer text containing expression-like text as literal input", () => {
    expect(
      evaluateWhatsAppFlowPayload(
        { answer: "${form.answer}" },
        { data: {}, form: { answer: "My name is ${unknown}" } }
      )
    ).toEqual({ ok: true, value: { answer: "My name is ${unknown}" } });
  });
  it("fails closed on missing references instead of submitting partial answers", () => {
    expect(
      evaluateWhatsAppFlowPayload(
        { answer: "${form.missing}" },
        { data: {}, form: {} }
      )
    ).toEqual({ ok: false });
  });
});
