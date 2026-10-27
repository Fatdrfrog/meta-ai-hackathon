import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WhatsAppComponent } from "./whatsapp-template-types.ts";
import {
  getScenarioWhatsAppTemplateDefaultContextKey,
  getScenarioWhatsAppTemplateFallbackContextKey,
  listScenarioWhatsAppTemplateParameters,
  renderScenarioWhatsAppTemplateBindingPreview,
  resolveScenarioWhatsAppTemplateBindings,
  validateScenarioWhatsAppTemplateBindings,
  type ScenarioWhatsAppTemplateBindings,
} from "./scenario-whatsapp-template-bindings.ts";

const components: WhatsAppComponent[] = [
  { type: "HEADER", format: "TEXT", text: "Order {{ 1 }}" },
  { type: "BODY", text: "Hello {{1}}, {{status}} / {{status}}" },
  {
    type: "BUTTONS",
    buttons: [
      { type: "QUICK_REPLY", text: "Help" },
      { type: "URL", text: "Track", url: "https://shop.example/track/{{1}}" },
    ],
  },
];
const bindings: ScenarioWhatsAppTemplateBindings = {
  version: 1,
  parameters: {
    "header:1": { source: "literal", value: "ORD-42" },
    "body:1": { source: "context", key: "first_name" },
    "body:status": { source: "prompt_input", key: "status" },
    "button:1:1": { source: "literal", value: "tracking-token" },
  },
};

describe("explicit scenario template parameter bindings", () => {
  it("does not treat authentication creation fields as editable scenario text parameters", () => {
    const preset: WhatsAppComponent[] = [
      { type: "BODY", add_security_recommendation: true },
      { type: "FOOTER", code_expiration_minutes: 5 },
      { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE" }] },
    ];
    assert.deepEqual(listScenarioWhatsAppTemplateParameters(preset), []);
    assert.deepEqual(
      renderScenarioWhatsAppTemplateBindingPreview(preset, {}),
      [],
    );
    assert.equal(Object.hasOwn(preset[0]!, "text"), false);
  });

  it("keeps repeated component placeholders independent and deduplicates within a component", () => {
    assert.deepEqual(
      listScenarioWhatsAppTemplateParameters(components).map((slot) => slot.id),
      ["header:1", "body:1", "body:status", "button:1:1"],
    );
  });

  it("resolves exact component bindings from their separate sources", () => {
    assert.deepEqual(
      resolveScenarioWhatsAppTemplateBindings({
        components,
        bindings,
        values: { first_name: "Amina", status: "wrong source" },
        promptInputs: { status: "Ready" },
      }),
      {
        values: {
          "header:1": "ORD-42",
          "body:1": "Amina",
          "body:status": "Ready",
          "button:1:1": "tracking-token",
        },
        issues: [],
      },
    );
  });

  it("retains literal template-looking text without evaluating it", () => {
    const result = resolveScenarioWhatsAppTemplateBindings({
      components: [{ type: "BODY", text: "{{1}}" }],
      bindings: {
        version: 1,
        parameters: {
          "body:1": { source: "literal", value: "{{input.secret}}" },
        },
      },
      promptInputs: { secret: "must not interpolate" },
    });
    assert.equal(result.values["body:1"], "{{input.secret}}");
  });

  it("does not replace missing context or answers with the customer name", () => {
    const result = resolveScenarioWhatsAppTemplateBindings({
      components,
      bindings,
      values: { name: "Amina" },
    });
    assert.deepEqual(result.issues, [
      { code: "binding_value_missing", parameterId: "body:1" },
      { code: "binding_value_missing", parameterId: "body:status" },
    ]);
    assert.equal(result.values["body:1"], undefined);
  });

  it("does not read inherited context or prompt input values", () => {
    const result = resolveScenarioWhatsAppTemplateBindings({
      components,
      bindings,
      values: Object.create({ first_name: "Inherited" }),
      promptInputs: Object.create({ status: "Inherited" }),
    });
    assert.equal(
      result.issues.filter((issue) => issue.code === "binding_value_missing")
        .length,
      2,
    );
  });

  it("reports a missing runtime value once when components repeat a parameter identity", () => {
    assert.deepEqual(
      resolveScenarioWhatsAppTemplateBindings({
        components: [
          { type: "BODY", text: "{{1}} {{2}}" },
          { type: "BODY", text: "{{1}}" },
        ],
        bindings: {
          version: 1,
          parameters: {
            "body:1": { source: "context", key: "first_name" },
            "body:2": { source: "literal", value: "Ready" },
          },
        },
      }),
      {
        values: { "body:2": "Ready" },
        issues: [{ code: "binding_value_missing", parameterId: "body:1" }],
      },
    );
  });

  it("resolves valid entries while preserving validation then runtime issue order", () => {
    assert.deepEqual(
      resolveScenarioWhatsAppTemplateBindings({
        components: [
          { type: "BODY", text: "{{1}} {{2}} {{3}} {{4}} {{5}} {{6}}" },
        ],
        bindings: {
          version: 1,
          parameters: {
            obsolete: { source: "literal", value: "Old mapping" },
            "body:1": { source: "literal", value: "Ready" },
            "body:2": { source: "context", key: "order.status" },
            "body:3": { source: "prompt_input", key: "status" },
            "body:4": { source: "context", key: "first_name" },
            "body:5": { source: "literal", value: " " },
          },
        },
        availablePromptInputKeys: [],
      }),
      {
        values: { "body:1": "Ready" },
        issues: [
          { code: "binding_unknown_parameter", parameterId: "obsolete" },
          { code: "binding_source_invalid", parameterId: "body:2" },
          { code: "binding_input_unavailable", parameterId: "body:3" },
          { code: "binding_value_missing", parameterId: "body:5" },
          { code: "binding_required", parameterId: "body:6" },
          { code: "binding_value_missing", parameterId: "body:4" },
        ],
      },
    );
  });

  it("keeps absent legacy config distinct from empty explicit config", () => {
    assert.deepEqual(
      validateScenarioWhatsAppTemplateBindings({
        components,
        bindings: undefined,
      }),
      [],
    );
    assert.equal(
      validateScenarioWhatsAppTemplateBindings({
        components,
        bindings: { version: 1, parameters: {} },
      }).length,
      4,
    );
  });

  it("rejects malformed configs, unknown fields and unsupported versions", () => {
    for (const invalid of [
      null,
      [],
      { version: 2, parameters: {} },
      { version: 1, parameters: [] },
      { version: 1, parameters: {}, extra: true },
    ]) {
      assert.deepEqual(
        validateScenarioWhatsAppTemplateBindings({
          components,
          bindings: invalid,
        }),
        [{ code: "bindings_invalid" }],
      );
    }
    assert.deepEqual(validateScenarioWhatsAppTemplateBindings({ bindings }), [
      { code: "bindings_invalid" },
    ]);
  });

  it("rejects stale mappings and missing fields after template schema changes", () => {
    const issues = validateScenarioWhatsAppTemplateBindings({
      components: [{ type: "BODY", text: "{{new_field}}" }],
      bindings,
    });
    assert.ok(
      issues.some((issue) => issue.code === "binding_unknown_parameter"),
    );
    assert.ok(
      issues.some(
        (issue) =>
          issue.code === "binding_required" &&
          issue.parameterId === "body:new_field",
      ),
    );
  });

  it("rejects malformed parameter schemas without throwing in validation or previews", () => {
    for (const malformed of [
      {},
      [null],
      [{ type: "BODY", text: 42 }],
      [{ type: "HEADER", format: "TEXT" }],
      [{ type: "BUTTONS" }],
      [{ type: "BUTTONS", buttons: [null] }],
      [{ type: "BUTTONS", buttons: [{ type: "URL", text: "Track" }] }],
      [{ type: "CAROUSEL" }],
      [{ type: "CAROUSEL", cards: [{}] }],
      [
        {
          type: "CAROUSEL",
          cards: [{ components: [{ type: "CAROUSEL", cards: [] }] }],
        },
      ],
    ]) {
      const schema = malformed as unknown as WhatsAppComponent[];
      assert.deepEqual(
        resolveScenarioWhatsAppTemplateBindings({
          components: schema,
          bindings,
        }),
        { values: {}, issues: [{ code: "bindings_invalid" }] },
      );
      assert.deepEqual(listScenarioWhatsAppTemplateParameters(schema), []);
      assert.deepEqual(
        renderScenarioWhatsAppTemplateBindingPreview(schema, {}),
        [],
      );
    }
  });

  it("validates source keys, empty constants and unavailable collected answers", () => {
    for (const binding of [
      { source: "context", key: "order.status" },
      { source: "context", key: "__proto__" },
      { source: "context", key: "reply" },
      { source: "prompt_input", key: "../secret" },
      { source: "literal", value: 42 },
    ]) {
      assert.equal(
        validateScenarioWhatsAppTemplateBindings({
          components: [{ type: "BODY", text: "{{1}}" }],
          bindings: { version: 1, parameters: { "body:1": binding } },
        })[0]?.code,
        "binding_source_invalid",
      );
    }
    assert.equal(
      validateScenarioWhatsAppTemplateBindings({
        components: [{ type: "BODY", text: "{{1}}" }],
        bindings: {
          version: 1,
          parameters: { "body:1": { source: "literal", value: "  " } },
        },
      })[0]?.code,
      "binding_value_missing",
    );
    assert.ok(
      validateScenarioWhatsAppTemplateBindings({
        components,
        bindings,
        availablePromptInputKeys: [],
      }).some((issue) => issue.code === "binding_input_unavailable"),
    );
  });

  it("distinguishes carousel body and URL slots from top-level parameters", () => {
    const carousel: WhatsAppComponent[] = [
      { type: "BODY", text: "{{1}}" },
      {
        type: "CAROUSEL",
        cards: [0, 1].map(() => ({
          components: [
            { type: "BODY", text: "{{1}}" },
            {
              type: "BUTTONS",
              buttons: [
                {
                  type: "URL",
                  text: "View",
                  url: "https://shop.example/{{1}}",
                },
              ],
            },
          ],
        })),
      },
    ];
    assert.deepEqual(
      listScenarioWhatsAppTemplateParameters(carousel).map((slot) => slot.id),
      [
        "body:1",
        "card:0:body:1",
        "card:0:button:0:1",
        "card:1:body:1",
        "card:1:button:0:1",
      ],
    );
  });

  it("previews exact component values, including whitespace placeholders, without mutating the template", () => {
    const original = structuredClone(components);
    const preview = renderScenarioWhatsAppTemplateBindingPreview(components, {
      "header:1": "ORD-42",
      "body:1": "Amina",
      "button:1:1": "abc",
    });
    assert.equal(
      preview[0]?.type === "HEADER" && preview[0].text,
      "Order ORD-42",
    );
    assert.equal(
      preview[1]?.type === "BODY" && preview[1].text,
      "Hello Amina, {{status}} / {{status}}",
    );
    const button =
      preview[2]?.type === "BUTTONS" ? preview[2].buttons[1] : null;
    assert.equal(
      button?.type === "URL" && button.url,
      "https://shop.example/track/abc",
    );
    assert.deepEqual(components, original);
  });
});

describe("template variable defaults", () => {
  it("fills positions with the name, phone and conversation id", () => {
    assert.deepEqual(
      ["1", "2", "3", "4", " 01 "].map(
        getScenarioWhatsAppTemplateFallbackContextKey,
      ),
      [
        "customer_name",
        "phone",
        "conversation_id",
        "customer_name",
        "customer_name",
      ],
    );
  });

  it("reads what a named variable mentions, else the name", () => {
    assert.deepEqual(
      [
        "Guest_Name",
        "whatsapp",
        "chat_ref",
        "conversation",
        "promo_link",
        "promo",
      ].map(getScenarioWhatsAppTemplateFallbackContextKey),
      [
        "customer_name",
        "phone",
        "chat_id",
        "conversation_id",
        "link",
        "customer_name",
      ],
    );
  });

  it("reads customer data a variable is named after first", () => {
    assert.deepEqual(
      ["first_name", "First Name", "last-name", "preferred_language", "1"].map(
        getScenarioWhatsAppTemplateDefaultContextKey,
      ),
      [
        "first_name",
        "first_name",
        "last_name",
        "preferred_language",
        "customer_name",
      ],
    );
  });
});
