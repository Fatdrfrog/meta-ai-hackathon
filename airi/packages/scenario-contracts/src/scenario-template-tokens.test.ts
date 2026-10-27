import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isScenarioFormAnswerMissingError } from "./scenario-form-answers.ts";
import {
  isScenarioPromptInputMissingError,
  parseScenarioPromptInputToken,
  scenarioPromptInputToken,
} from "./scenario-prompt-inputs.ts";
import {
  buildScenarioTemplateSampleContext,
  buildScenarioTemplateSlots,
  formatScenarioAnswerReference,
  hasScenarioTemplateTokens,
  isSupportedScenarioTemplateToken,
  labelScenarioAnswerReference,
  listScenarioAnswerReferences,
  listScenarioTemplateContextPaths,
  listScenarioTemplateTokens,
  listUnsupportedScenarioTemplateTokens,
  parseScenarioTemplatePath,
  pickScenarioTemplateReferralAliases,
  readScenarioAnswerReferenceValue,
  renderScenarioAnswerReferences,
  renderScenarioTemplate,
  resolveScenarioTemplatePath,
  scenarioFormAnswerReferenceLabel,
  SCENARIO_TEMPLATE_REFERRAL_ALIAS_KEYS,
  SCENARIO_TEMPLATE_TOKEN_PATTERN,
  SCENARIO_TEMPLATE_VARIABLE_PATTERN,
  scenarioTemplateValueToString,
} from "./scenario-template-tokens.ts";

describe("scenario template grammar", () => {
  it("keeps the token syntax the renderer and validation already used", () => {
    assert.equal(
      SCENARIO_TEMPLATE_TOKEN_PATTERN.source,
      String.raw`\{\{\s*([a-zA-Z0-9_][a-zA-Z0-9_.-]*)\s*\}\}|\{([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_.-]+)+)\}`,
    );
    assert.equal(SCENARIO_TEMPLATE_TOKEN_PATTERN.flags, "g");
    assert.equal(
      SCENARIO_TEMPLATE_VARIABLE_PATTERN.source,
      String.raw`\{\{\s*([a-zA-Z0-9_][a-zA-Z0-9_.-]*)\s*\}\}`,
    );
  });

  it("reads both syntaxes in document order and needs a dot in single braces", () => {
    assert.deepEqual(
      listScenarioTemplateTokens(
        "{{ first_name }} {customer.name} {plain} {{input.name}} {{first_name}}",
      ),
      ["first_name", "customer.name", "input.name", "first_name"],
    );
    assert.deepEqual(listScenarioTemplateTokens("{{}} {{ }} {.a} {{-a}}"), []);
  });

  it("detects tokens on every call without a shared position", () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal(hasScenarioTemplateTokens("Hi {{first_name}}"), true);
      assert.equal(hasScenarioTemplateTokens("Hi {customer.name}"), true);
      assert.equal(hasScenarioTemplateTokens("Hi {name} and {}"), false);
    }
  });

  it("walks own properties, case-sensitively, skipping empty segments", () => {
    const context = {
      customer: { firstName: "Ada" },
      input: { constructor: "Own answer" },
    };
    assert.deepEqual(parseScenarioTemplatePath("customer..firstName."), [
      "customer",
      "firstName",
    ]);
    assert.equal(
      resolveScenarioTemplatePath(context, "customer.firstName"),
      "Ada",
    );
    assert.equal(
      resolveScenarioTemplatePath(context, "customer.firstname"),
      undefined,
    );
    assert.equal(
      resolveScenarioTemplatePath(context, "constructor"),
      undefined,
    );
    assert.equal(
      resolveScenarioTemplatePath(context, "customer.toString"),
      undefined,
    );
    assert.equal(
      resolveScenarioTemplatePath(context, "input.constructor"),
      "Own answer",
    );
    assert.equal(
      resolveScenarioTemplatePath(context, "customer.firstName.length"),
      undefined,
    );
  });

  it("renders primitives and a humanized group as text", () => {
    assert.equal(scenarioTemplateValueToString("text"), "text");
    assert.equal(scenarioTemplateValueToString(3), "3");
    assert.equal(scenarioTemplateValueToString(false), "false");
    assert.equal(scenarioTemplateValueToString(null), "");
    assert.equal(scenarioTemplateValueToString(undefined), "");
    assert.equal(
      scenarioTemplateValueToString({ hours: 2, humanized: "2 hours left" }),
      "2 hours left",
    );
    assert.equal(scenarioTemplateValueToString({ hours: 2 }), "");
    assert.equal(scenarioTemplateValueToString(["https://a.test"]), "");
  });
});

describe("renderScenarioTemplate", () => {
  const context = {
    customer: { name: "Ada" },
    countdown: { hours: 2, humanized: "2 hours left" },
    input: { name: "{customer.name} {{input.city}}" },
  };

  it("expands in one pass, so inserted values stay literal", () => {
    assert.equal(
      renderScenarioTemplate(
        "{{ customer.name }}: {input.name} ({{countdown}})",
        context,
        "empty",
      ),
      "Ada: {customer.name} {{input.city}} (2 hours left)",
    );
  });

  it("fails closed on a missing answer only under the authored-text policy", () => {
    assert.throws(
      () =>
        renderScenarioTemplate(
          "Hi {{input.city}}",
          context,
          "require_prompt_inputs",
        ),
      (error) =>
        isScenarioPromptInputMissingError(error) &&
        error.token === "input.city",
    );
    assert.throws(
      () =>
        renderScenarioTemplate(
          "Hi {input.constructor}",
          context,
          "require_prompt_inputs",
        ),
      /SCENARIO_PROMPT_INPUT_MISSING: input.constructor/,
    );
    assert.equal(
      renderScenarioTemplate("Hi {{input.city}}!", context, "empty"),
      "Hi !",
    );
  });

  it("renders other missing paths empty under every policy", () => {
    for (const policy of [
      "require_prompt_inputs",
      "require_answers",
      "empty",
    ] as const) {
      assert.equal(
        renderScenarioTemplate(
          "[{{customer.firstname}}][{{input.Name}}][{input.name.first}][{input}]",
          context,
          policy,
        ),
        "[][][][{input}]",
      );
    }
  });
});

describe("form answers in templates", () => {
  const context = {
    customer: { name: "Ada" },
    input: { name: "Amina" },
    form: {
      order: { size: "{{form.order.colour}} {customer.name}", colour: "Red" },
      contact: {},
    },
  };

  it("fails a generative prompt only when the form was never submitted", () => {
    assert.throws(
      () =>
        renderScenarioTemplate(
          "Draw {{form.survey.size}}",
          context,
          "require_answers",
        ),
      (error) =>
        isScenarioFormAnswerMissingError(error) &&
        error.token === "form.survey.size",
    );
    // A blank optional field of a submitted form reads as empty.
    assert.equal(
      renderScenarioTemplate(
        "Call {form.contact.phone}.",
        context,
        "require_answers",
      ),
      "Call .",
    );
    assert.equal(
      renderScenarioTemplate(
        "{{form.order.colour}}",
        context,
        "require_answers",
      ),
      "Red",
    );
    // Collected details still fail closed there too.
    assert.throws(
      () =>
        renderScenarioTemplate("{{input.city}}", context, "require_answers"),
      (error) =>
        isScenarioPromptInputMissingError(error) &&
        error.token === "input.city",
    );
  });

  it("never fails other text on a form answer", () => {
    for (const policy of ["require_prompt_inputs", "empty"] as const) {
      assert.equal(
        renderScenarioTemplate(
          "[{{form.survey.size}}][{{form.contact.phone}}][{{form.order.colour}}]",
          context,
          policy,
        ),
        "[][][Red]",
      );
    }
    assert.equal(
      renderScenarioTemplate(
        "[{{form.order.size}}]",
        { customer: {} },
        "empty",
      ),
      "[]",
    );
  });

  it("renders in one pass, so an answer that looks like a token stays literal", () => {
    assert.equal(
      renderScenarioTemplate("{{form.order.size}}", context, "require_answers"),
      "{{form.order.colour}} {customer.name}",
    );
  });

  it("reads the recorded value an answer token names, own properties only", () => {
    const [size, notes, phone, name, city, inherited] =
      listScenarioAnswerReferences(
        "{{form.order.size}} {{form.order.notes}} {{form.contact.phone}} " +
          "{{input.name}} {{input.city}} {{input.constructor}}",
      );
    const answers = {
      promptInputs: { name: "Aya" },
      formAnswers: { order: { size: "Large" } },
    };
    assert.equal(readScenarioAnswerReferenceValue(size!, answers), "Large");
    assert.equal(readScenarioAnswerReferenceValue(name!, answers), "Aya");
    // A blank field, a form never submitted, an unsaved detail.
    assert.equal(readScenarioAnswerReferenceValue(notes!, answers), null);
    assert.equal(readScenarioAnswerReferenceValue(phone!, answers), null);
    assert.equal(readScenarioAnswerReferenceValue(city!, answers), null);
    assert.equal(readScenarioAnswerReferenceValue(inherited!, answers), null);
  });

  it("shows answer tokens as labelled references and leaves other tokens literal", () => {
    const labels: string[] = [];
    const rendered = renderScenarioAnswerReferences(
      "Greet {{customer.name}}. Size: {{ form.order.size }}; name: {input.name}; " +
        "pick: {{picked.label}}; bad: {{form.Order.size}} {{input.Name}}.",
      (reference) => {
        labels.push(reference.token);
        return reference.kind === "form"
          ? scenarioFormAnswerReferenceLabel(
              " Order form ",
              `${reference.fieldKey}\n[x]`,
            )
          : `Name {{form.order.size}}`;
      },
    );
    assert.equal(
      rendered,
      "Greet {{customer.name}}. Size: [Order form › size x]; name: " +
        "[Name {{form.order.size}}]; pick: {{picked.label}}; bad: " +
        "{{form.Order.size}} {{input.Name}}.",
    );
    assert.deepEqual(labels, ["form.order.size", "input.name"]);
    assert.equal(formatScenarioAnswerReference("  Size \n "), "[Size]");
  });

  it("lists every answer token once, collected details and form answers alike", () => {
    assert.deepEqual(
      listScenarioAnswerReferences(
        "{{form.order.size}} {input.name} {{ form.order.size }} " +
          "{{input.Name}} {{customer.name}} {{form.contact.phone}}",
      ),
      [
        {
          kind: "form",
          token: "form.order.size",
          formKey: "order",
          fieldKey: "size",
        },
        { kind: "input", token: "input.name", key: "name" },
        {
          kind: "form",
          token: "form.contact.phone",
          formKey: "contact",
          fieldKey: "phone",
        },
      ],
    );
  });

  it("names answers with the scenario's current form labels", () => {
    const forms = {
      "node-order": {
        formKey: "order",
        formLabel: "Order details",
        fields: { size_id: { key: "size", label: "Your size" } },
      },
    };
    const form = (formKey: string, fieldKey: string) =>
      ({
        kind: "form",
        token: `form.${formKey}.${fieldKey}`,
        formKey,
        fieldKey,
      }) as const;
    // The field's own label, not its key made readable.
    assert.equal(
      labelScenarioAnswerReference(form("order", "size"), forms),
      "Order details › Your size",
    );
    // A renamed or removed form still gets a readable name.
    assert.equal(
      labelScenarioAnswerReference(form("order", "delivery_address"), forms),
      "Order details › Delivery address",
    );
    assert.equal(
      labelScenarioAnswerReference(form("contact_form", "phone"), null),
      "Contact form › Phone",
    );
    assert.equal(
      labelScenarioAnswerReference(
        { kind: "input", token: "input.full_name", key: "full_name" },
        forms,
      ),
      "Full name",
    );
  });
});

describe("scenario prompt-input tokens", () => {
  it("parses only valid input keys, as the token builder writes them", () => {
    assert.equal(
      parseScenarioPromptInputToken(scenarioPromptInputToken(" name ")),
      "name",
    );
    for (const token of [
      "input.Name",
      "input.name.first",
      "input.",
      "input",
      "inputs.name",
      "customer.name",
    ]) {
      assert.equal(parseScenarioPromptInputToken(token), null, token);
    }
  });
});

describe("scenario template context description", () => {
  it("supports exactly the paths the runtime renders, case-sensitively", () => {
    for (const token of [
      "first_name",
      "customer_name",
      "customer.firstName",
      "whatsappclient.wa_id",
      "whatsappclient.user_id",
      "conversation.internal_labels",
      "trigger.message.text",
      "trigger.whatsappReferral.campaignName",
      "whatsappReferral.campaignName",
      "meta_ad_campaign_name",
      "ctwa_ref",
      "calendar.next_free_slot",
      "countdown",
      "countdown.hours",
      "link",
      "link5",
      "image1",
      "links.count",
      "input.name",
      "input.constructor",
      "form.order.size",
      "form.order_2.f_2nd_choice",
    ]) {
      assert.equal(isSupportedScenarioTemplateToken(token), true, token);
    }
    for (const token of [
      "customer.firstname",
      "Customer.firstName",
      "input.Name",
      "input.name.first",
      "input",
      "form",
      "form.order",
      "form.order.size.extra",
      "form..order.size",
      "form.Order.size",
      "form.order.Size",
      "form.order.1size",
      "calendar",
      "calendar.foo",
      "countdown.foo",
      "trigger.whatsappreferral.campaignName",
      "meta_ad_campaign",
      "link6",
      "links.values",
      "constructor",
      "customer.toString",
      "customer.name.length",
    ]) {
      assert.equal(isSupportedScenarioTemplateToken(token), false, token);
    }
  });

  it("lists each unsupported token once, in order, in either syntax", () => {
    assert.deepEqual(
      listUnsupportedScenarioTemplateTokens(
        "{{input.Name}} {{customer.firstname}} {input.Name} {{first_name}} {{input.name}} {calendar.slot}",
      ),
      ["input.Name", "customer.firstname", "calendar.slot"],
    );
    assert.deepEqual(listUnsupportedScenarioTemplateTokens("Hello!"), []);
  });

  it("builds a complete sample context from the same description", () => {
    const samples = buildScenarioTemplateSampleContext((path) => `<${path}>`);
    const paths = listScenarioTemplateContextPaths();
    assert.equal(paths.length, new Set(paths).size);
    assert.ok(paths.includes("countdown"));
    assert.ok(paths.includes("trigger.whatsappReferral.hasReferral"));
    assert.equal(paths.includes("calendar" as never), false);
    for (const path of paths) {
      assert.equal(isSupportedScenarioTemplateToken(path), true, path);
      const expected = path === "countdown.humanized" ? "countdown" : path;
      assert.equal(
        renderScenarioTemplate(`{{${path}}}`, samples, "empty"),
        `<${expected}>`,
        path,
      );
    }
    assert.deepEqual(samples.input, {});
    assert.deepEqual(samples.form, {});
    assert.equal(
      paths.some((path) => path.startsWith("form")),
      false,
    );
  });

  it("fills numbered slots and reads every referral alias", () => {
    assert.deepEqual(buildScenarioTemplateSlots("link", ["a", "b"]), {
      link1: "a",
      link2: "b",
      link3: "",
      link4: "",
      link5: "",
    });
    const aliases = pickScenarioTemplateReferralAliases({
      meta_ad_campaign_name: "Summer",
      unknown_alias: "ignored",
    });
    assert.deepEqual(Object.keys(aliases), [
      ...SCENARIO_TEMPLATE_REFERRAL_ALIAS_KEYS,
    ]);
    assert.equal(aliases.meta_ad_campaign_name, "Summer");
    assert.equal(aliases.ctwa_ref, "");
    assert.equal(Object.hasOwn(aliases, "unknown_alias"), false);
  });
});
