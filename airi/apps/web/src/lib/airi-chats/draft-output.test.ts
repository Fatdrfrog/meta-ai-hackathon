import {
  buildAnthropicMessageParams,
  convertGeminiSchemaToJsonSchema,
} from "@/lib/ai/anthropic-messages";
import {
  AIRI_FLOW_DRAFT_RESPONSE_SCHEMA,
  airiBuilderFlowConfigSchema,
  airiBuilderTemplateDraftSchema,
} from "./builder-state";
import {
  mergeAiriDraftOverActive,
  parseAiriDraftJson,
  type AiriDraftResponseSchema,
} from "./draft-output";
import {
  AIRI_CAMPAIGN_PACKAGE_RESPONSE_SCHEMA,
  airiMarketingCheckSchema,
  airiMarketingStepSchema,
  normalizeAiriCampaignPackage,
} from "./marketing-package";
import {
  AIRI_OPPORTUNITY_SCAN_RESPONSE_SCHEMA,
  airiOpportunityScanSchema,
  normalizeAiriOpportunityScan,
} from "./opportunity-scan";
import {
  AIRI_TEMPLATE_DRAFT_BUTTON_TYPES,
  AIRI_TEMPLATE_DRAFT_HEADER_FORMATS,
  AIRI_TEMPLATE_DRAFT_RESPONSE_SCHEMA,
  normalizeAiriWhatsAppTemplateDraft,
  normalizeGeneratedAiriWhatsAppTemplateDraft,
} from "./whatsapp-template-drafts";
import { sanitizeWhatsAppFlowConfig } from "@/lib/scenarios/whatsapp-flow-config";

const SCHEMAS: Array<[string, AiriDraftResponseSchema]> = [
  ["whatsapp template", AIRI_TEMPLATE_DRAFT_RESPONSE_SCHEMA],
  ["whatsapp flow", AIRI_FLOW_DRAFT_RESPONSE_SCHEMA],
  ["opportunity scan", AIRI_OPPORTUNITY_SCAN_RESPONSE_SCHEMA],
  ["campaign package", AIRI_CAMPAIGN_PACKAGE_RESPONSE_SCHEMA],
];

type JsonSchema = Record<string, unknown>;

/** Every object node of a converted JSON Schema. */
function objectNodes(schema: JsonSchema): JsonSchema[] {
  const nodes: JsonSchema[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as JsonSchema;
    if (record.type === "object") nodes.push(record);
    Object.values((record.properties as JsonSchema | undefined) ?? {}).forEach(
      visit
    );
    visit(record.items);
  };
  visit(schema);
  return nodes;
}

const ALLOWED_KEYWORDS = new Set([
  "type",
  "description",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "items",
]);

function keywordsOf(schema: JsonSchema): string[] {
  const keys = new Set<string>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as JsonSchema;
    Object.keys(record).forEach(key => keys.add(key));
    Object.values((record.properties as JsonSchema | undefined) ?? {}).forEach(
      visit
    );
    visit(record.items);
  };
  visit(schema);
  return [...keys];
}

describe("draft response schemas on Claude structured outputs", () => {
  it.each(SCHEMAS)(
    "the %s schema enables output_config json_schema",
    (_name, schema) => {
      const params = buildAnthropicMessageParams({
        model: "claude-sonnet-5-5",
        messages: [{ role: "user", content: "Draft it" }],
        forceJson: true,
        generationConfig: { responseSchema: schema },
      });

      // A free-form object anywhere would drop the format and leave only
      // the prompt-level JSON instruction.
      expect(params.output_config?.format).toEqual({
        type: "json_schema",
        schema: convertGeminiSchemaToJsonSchema(schema),
      });
    }
  );

  it.each(SCHEMAS)(
    "the %s schema stays inside the structured-output limits",
    (_name, schema) => {
      const converted = convertGeminiSchemaToJsonSchema(schema);
      const objects = objectNodes(converted);

      expect(objects.length).toBeGreaterThan(0);
      for (const node of objects) {
        expect(node.additionalProperties).toBe(false);
        expect(
          Object.keys(node.properties as JsonSchema).length
        ).toBeGreaterThan(0);
      }
      const optionalCount = objects.reduce(
        (count, node) =>
          count +
          Object.keys(node.properties as JsonSchema).filter(
            key => !(node.required as string[]).includes(key)
          ).length,
        0
      );
      expect(optionalCount).toBeLessThanOrEqual(24);
      // No unions (type arrays, anyOf) and no unsupported constraints.
      expect(
        keywordsOf(converted).every(key => ALLOWED_KEYWORDS.has(key))
      ).toBe(true);
      expect(JSON.stringify(converted)).not.toMatch(/"type":\[/);
    }
  );
});

describe("draft response schemas match the draft validators", () => {
  function enumOf(schema: AiriDraftResponseSchema, path: string[]) {
    let node: AiriDraftResponseSchema | undefined = schema;
    for (const key of path) {
      node = key === "[]" ? node?.items : node?.properties?.[key];
    }
    return node?.enum;
  }

  it("uses the validators' enums", () => {
    expect(enumOf(AIRI_TEMPLATE_DRAFT_RESPONSE_SCHEMA, ["category"])).toEqual(
      airiBuilderTemplateDraftSchema.shape.category.options
    );
    expect(
      enumOf(AIRI_FLOW_DRAFT_RESPONSE_SCHEMA, [
        "screens",
        "[]",
        "fields",
        "[]",
        "fieldType",
      ])
    ).toEqual(
      airiBuilderFlowConfigSchema.shape.screens.element.shape.fields.element
        .shape.fieldType.options
    );
    expect(
      enumOf(AIRI_OPPORTUNITY_SCAN_RESPONSE_SCHEMA, [
        "opportunities",
        "[]",
        "priority",
      ])
    ).toEqual(
      airiOpportunityScanSchema.shape.opportunities.element.shape.priority
        .options
    );
    expect(
      enumOf(AIRI_OPPORTUNITY_SCAN_RESPONSE_SCHEMA, [
        "opportunities",
        "[]",
        "recommendedArtifacts",
        "[]",
      ])
    ).toEqual(
      airiOpportunityScanSchema.shape.opportunities.element.shape
        .recommendedArtifacts.element.options
    );
    for (const key of ["kind", "status", "tool"] as const) {
      expect(
        enumOf(AIRI_CAMPAIGN_PACKAGE_RESPONSE_SCHEMA, ["steps", "[]", key])
      ).toEqual(airiMarketingStepSchema.shape[key].options);
    }
    expect(
      enumOf(AIRI_CAMPAIGN_PACKAGE_RESPONSE_SCHEMA, ["checks", "[]", "status"])
    ).toEqual(airiMarketingCheckSchema.shape.status.options);
  });

  it("requires every key the scan validator requires", () => {
    expect(AIRI_OPPORTUNITY_SCAN_RESPONSE_SCHEMA.required).toEqual(
      Object.keys(airiOpportunityScanSchema.shape)
    );
    expect(
      AIRI_OPPORTUNITY_SCAN_RESPONSE_SCHEMA.properties?.opportunities.items
        ?.required
    ).toEqual(
      Object.keys(airiOpportunityScanSchema.shape.opportunities.element.shape)
    );
  });

  it("leaves tool access to the server in the campaign package", () => {
    expect(AIRI_CAMPAIGN_PACKAGE_RESPONSE_SCHEMA.properties).not.toHaveProperty(
      "tools"
    );
    const stepKeys = Object.keys(
      AIRI_CAMPAIGN_PACKAGE_RESPONSE_SCHEMA.properties?.steps.items
        ?.properties ?? {}
    );
    expect(stepKeys).not.toContain("actionHref");
    expect(
      stepKeys.every(key =>
        Object.prototype.hasOwnProperty.call(airiMarketingStepSchema.shape, key)
      )
    ).toBe(true);
  });

  it("only declares Flow keys the Flow validator accepts", () => {
    const flowShape = airiBuilderFlowConfigSchema.shape;
    const screenShape = flowShape.screens.element.shape;
    const fieldShape = screenShape.fields.element.shape;
    const schema = AIRI_FLOW_DRAFT_RESPONSE_SCHEMA;
    const screen = schema.properties?.screens.items;
    const field = screen?.properties?.fields.items;
    for (const [keys, shape] of [
      [Object.keys(schema.properties ?? {}), flowShape],
      [Object.keys(screen?.properties ?? {}), screenShape],
      [Object.keys(field?.properties ?? {}), fieldShape],
    ] as const) {
      for (const key of keys) {
        expect(Object.prototype.hasOwnProperty.call(shape, key)).toBe(true);
      }
    }
  });

  it("keeps every template kind the schema allows through the normalizer", () => {
    for (const format of AIRI_TEMPLATE_DRAFT_HEADER_FORMATS) {
      const draft = normalizeAiriWhatsAppTemplateDraft({
        name: "header_check",
        components: [
          { type: "HEADER", format, text: "Header" },
          { type: "BODY", text: "Body" },
        ],
      });
      expect(draft?.components[0]).toEqual(
        expect.objectContaining({ type: "HEADER", format })
      );
    }
    const buttonSamples: Record<string, Record<string, string>> = {
      QUICK_REPLY: {},
      URL: { url: "https://example.com" },
      PHONE_NUMBER: { phone_number: "+77010000000" },
      FLOW: { flow_id: "123", flow_action: "navigate" },
    };
    for (const type of AIRI_TEMPLATE_DRAFT_BUTTON_TYPES) {
      const draft = normalizeAiriWhatsAppTemplateDraft({
        name: "button_check",
        components: [
          { type: "BODY", text: "Body" },
          {
            type: "BUTTONS",
            buttons: [{ type, text: "Go", ...buttonSamples[type] }],
          },
        ],
      });
      expect(draft?.components[1]).toEqual({
        type: "BUTTONS",
        buttons: [expect.objectContaining({ type })],
      });
    }
  });

  it("accepts schema-shaped answers in every draft validator", () => {
    expect(
      normalizeGeneratedAiriWhatsAppTemplateDraft({
        name: "spring_offer",
        language: "ru",
        category: "UTILITY",
        components: [{ type: "BODY", text: "Ваш заказ готов." }],
        rationale: "Order update",
        missingDetails: [],
      })
    ).toEqual(expect.objectContaining({ category: "UTILITY", language: "ru" }));
    expect(
      airiBuilderFlowConfigSchema.safeParse(
        sanitizeWhatsAppFlowConfig({
          templateId: "lead_generation",
          ctaText: "Open",
          bodyText: "Fill in",
          flowUiLocale: "kk",
          screens: [
            {
              id: "CONTACT",
              title: "Contact",
              fields: [
                {
                  id: "city",
                  label: "City",
                  fieldType: "Dropdown",
                  required: true,
                  options: [{ id: "almaty", title: "Almaty" }],
                },
              ],
            },
          ],
        })
      ).success
    ).toBe(true);
    expect(
      normalizeAiriOpportunityScan({
        title: "Scan",
        summary: "Summary",
        opportunities: [
          {
            id: "one",
            title: "One",
            priority: "low",
            problem: "Problem",
            customerSignal: "Signal",
            recommendedAction: "Action",
            evidence: ["Evidence"],
            recommendedArtifacts: ["kb_article"],
            missingInputs: [],
          },
        ],
        nextAction: "Next",
      })
    ).not.toBeNull();
    expect(
      normalizeAiriCampaignPackage({
        title: "Package",
        goal: "Goal",
        audience: "Audience",
        angle: "Angle",
        evidence: [],
        tools: {
          whatsapp: { available: true, label: "WhatsApp" },
          scenarios: { available: true, label: "Scenarios" },
          bulkCampaigns: { available: true, label: "Bulk" },
          canva: { available: true, label: "Canva" },
          visualGeneration: { available: true, label: "Visual" },
          audioGeneration: { available: true, label: "Audio" },
          metaAds: { available: true, label: "Meta Ads" },
        },
        steps: [
          {
            id: "audience",
            kind: "audience",
            title: "Audience",
            description: "Pick the segment",
            status: "needs_input",
            tool: "bulkCampaigns",
            blockers: [],
          },
        ],
        checks: [{ label: "Policy", status: "pending", detail: "" }],
        nextAction: "Next",
      })
    ).not.toBeNull();
  });

  it("never turns a template answer without a body into a draft", () => {
    expect(
      normalizeGeneratedAiriWhatsAppTemplateDraft({
        name: "no_body",
        components: [{ type: "FOOTER", text: "Footer" }],
      })
    ).toBeNull();
  });
});

describe("parseAiriDraftJson", () => {
  it("reads bare and fenced JSON objects", () => {
    expect(parseAiriDraftJson({ content: '{"a":1}' })).toEqual({
      ok: true,
      value: { a: 1 },
    });
    expect(
      parseAiriDraftJson({ content: 'Here:\n```json\n{"a":[1]}\n```' })
    ).toEqual({ ok: true, value: { a: [1] } });
  });

  it.each(["max_tokens", "MAX_TOKENS", "length"])(
    "treats finishReason %s as a truncated answer",
    finishReason => {
      expect(parseAiriDraftJson({ content: '{"a":1}', finishReason })).toEqual({
        ok: false,
        reason: "truncated",
      });
    }
  );

  it.each(["", "no json here", '{"a":', "[1,2]", '{"a":1} trailing }'])(
    "rejects %j",
    content => {
      expect(parseAiriDraftJson({ content })).toEqual({
        ok: false,
        reason: "unparseable",
      });
    }
  );
});

describe("mergeAiriDraftOverActive", () => {
  const schema = AIRI_FLOW_DRAFT_RESPONSE_SCHEMA;

  it("keeps keys the schema does not declare, matching screens by id", () => {
    const merged = mergeAiriDraftOverActive(
      schema,
      {
        ctaText: "Old",
        headerText: "Old header",
        metaFlowId: "meta-1",
        flowBranchRules: { A: { pick: { yes: "B" } } },
        screens: [
          { id: "A", title: "Old A", terminal: false, fields: [] },
          { id: "B", title: "Old B", success: true, fields: [] },
        ],
      },
      {
        ctaText: "New",
        screens: [
          { id: "B", title: "New B", fields: [] },
          { id: "C", title: "New C", fields: [] },
        ],
      }
    );

    expect(merged).toEqual({
      ctaText: "New",
      metaFlowId: "meta-1",
      flowBranchRules: { A: { pick: { yes: "B" } } },
      screens: [
        { id: "B", title: "New B", success: true, fields: [] },
        { id: "C", title: "New C", fields: [] },
      ],
    });
  });

  it("returns the generated value when nothing is open", () => {
    const generated = { ctaText: "New", screens: [] };
    expect(mergeAiriDraftOverActive(schema, undefined, generated)).toBe(
      generated
    );
  });
});
