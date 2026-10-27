import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildScenarioFormAnswerFieldMap,
  buildScenarioFormSubmission,
  claimScenarioFormKey,
  formatScenarioFormAnswerValue,
  humanizeScenarioAnswerKey,
  isScenarioFormAnswerMissingError,
  listScenarioActionFormFields,
  listScenarioActionFormFieldSchemas,
  listScenarioFormFieldSchemas,
  listScenarioFormFields,
  listScenarioFormFieldsWithCoverage,
  listScenarioFormNames,
  MAX_SCENARIO_FORM_ANSWER_CHARACTERS,
  MAX_SCENARIO_FORM_LABEL_CHARACTERS,
  MAX_SCENARIO_FORM_SUBMISSION_CHARACTERS,
  MAX_SCENARIO_FORM_SUBMISSION_FIELDS,
  MAX_SCENARIO_FORM_SUBMISSIONS,
  MAX_SCENARIO_WHATSAPP_TEMPLATE_FORM_FIELDS,
  MAX_SCENARIO_WHATSAPP_TEMPLATE_FORM_OPTIONS,
  normalizeScenarioFormAnswers,
  normalizeScenarioWhatsAppTemplateForm,
  normalizeWhatsAppFlowReplyValues,
  parseScenarioFormAnswerToken,
  readScenarioActionForm,
  readScenarioActionFormForFlow,
  readScenarioFormAnswerTemplateValues,
  readScenarioFormLabel,
  readScenarioFormSubmissions,
  readScenarioStoredFormKey,
  recordScenarioFormSubmission,
  resolveScenarioFormFieldKeys,
  resolveScenarioFormKeys,
  ScenarioFormAnswerMissingError,
  scenarioFormAnswerToken,
  sliceScenarioAnswerText,
  type ScenarioFormSubmission,
} from "./scenario-form-answers.ts";
import { readScenarioActionFlowConfig } from "./scenario-prompt-inputs.ts";

const SUBMITTED_AT = new Date("2026-09-30T10:00:00.000Z");

const ORDER_FIELDS = [
  { id: "name", label: "Name", fieldType: "TextInput", required: true },
  {
    id: "size",
    label: "Size",
    fieldType: "Dropdown",
    required: true,
    options: [
      { id: "opt_s", title: "Small" },
      { id: "opt_l", title: "Large" },
    ],
  },
  {
    id: "colours",
    label: "Colours",
    fieldType: "CheckboxGroup",
    options: [
      { id: "red", title: "Red" },
      { id: "blue", title: "Blue" },
    ],
  },
  { id: "day", label: "Delivery day", fieldType: "DatePicker" },
  {
    id: "notes",
    label: "Notes",
    fieldType: "TextArea",
    helperText: "Anything else",
  },
  {
    id: "wrap",
    label: "Gift wrap",
    fieldType: "RadioButtonsGroup",
    options: [
      { id: "yes", title: "Yes, wrap it" },
      { id: "no", title: "No" },
    ],
  },
];

function branchingAnswerConfig() {
  const common = [
    {
      id: "_name",
      label: "Athlete name",
      fieldType: "TextInput",
      required: true,
    },
    {
      id: "_design",
      label: "Design",
      fieldType: "RadioButtonsGroup",
      required: true,
      options: [
        { id: "personal", title: "Personalised" },
        { id: "classic", title: "Classic" },
      ],
    },
  ];
  return {
    templateId: "custom",
    answersKey: "medals",
    ctaText: "Open",
    flowNavigationMode: "static_graph",
    screens: [
      {
        id: "START",
        title: "Sport",
        fields: [
          {
            id: "sports",
            label: "Sport",
            fieldType: "NavigationList",
            navigationItems: [
              {
                id: "football",
                title: "Football",
                action: {
                  name: "navigate",
                  nextScreenId: "DETAILS",
                  payload: { sport: "sport_0" },
                },
              },
              {
                id: "other",
                title: "Other sport",
                action: { name: "navigate", nextScreenId: "OTHER" },
              },
            ],
          },
        ],
      },
      {
        id: "DETAILS",
        title: "Details",
        terminal: true,
        fields: common,
        data: { sport: { type: "string", __example__: "sport_0" } },
        footer: {
          label: "Send",
          action: {
            name: "complete",
            payload: {
              __sport: "${data.sport}",
              athlete: "${form._name}",
              design: "${form._design}",
            },
          },
        },
      },
      {
        id: "OTHER",
        title: "Other sport",
        terminal: true,
        fields: [
          ...common,
          {
            id: "custom_sport",
            label: "Your sport",
            fieldType: "TextInput",
            required: true,
          },
        ],
        footer: {
          label: "Send",
          action: {
            name: "complete",
            payload: {
              __sport: "sport_other",
              athlete: "${form._name}",
              design: "${form._design}",
              custom_sport: "${form.custom_sport}",
            },
          },
        },
      },
    ],
  };
}

describe("static graph submission fields", () => {
  const transported = (
    firstRequired: boolean,
    secondRequired: boolean,
    fieldType = "TextInput",
  ) => ({
    flowNavigationMode: "static_graph",
    screens: [
      {
        id: "FIRST",
        fields: [
          {
            id: "input",
            label: "Choice",
            fieldType,
            required: firstRequired,
            options: [{ id: "a", title: "Alpha" }],
          },
        ],
        footer: {
          action: {
            name: "navigate",
            nextScreenId: "END",
            payload: { carried: "${form.input}" },
          },
        },
      },
      {
        id: "SECOND",
        fields: [
          {
            id: "input",
            label: "Choice",
            fieldType,
            required: secondRequired,
            options: [{ id: "a", title: "Alpha" }],
          },
        ],
        footer: {
          action: {
            name: "navigate",
            nextScreenId: "END",
            payload: { carried: "${form.input}" },
          },
        },
      },
      {
        id: "END",
        terminal: true,
        fields: [],
        footer: {
          action: { name: "complete", payload: { result: "${data.carried}" } },
        },
      },
    ],
  });

  it("keeps transported answers optional if any incoming field is optional, independent of branch order", () => {
    for (const required of [
      [false, true],
      [true, false],
    ]) {
      assert.equal(
        listScenarioFormFields(transported(required[0]!, required[1]!))[0]
          ?.required,
        false,
      );
    }
  });
  it("resolves layered graphs with repeated incoming navigation rows in bounded work", () => {
    let reads = 0;
    const screens = Array.from({ length: 6 }, (_, index) => {
      const terminal = index === 5;
      return {
        id: `SCREEN_${String.fromCharCode(65 + index)}`,
        title: "Sport",
        terminal,
        fields: terminal
          ? []
          : [
              {
                id: "sports",
                label: "Sport",
                fieldType: "NavigationList",
                navigationItems: Array.from({ length: 20 }, (_, item) => {
                  const payload: Record<string, unknown> = {};
                  Object.defineProperty(payload, "sport", {
                    enumerable: true,
                    get: () => {
                      if (++reads > 200)
                        throw new Error("metadata work exceeded graph bounds");
                      return index === 0 ? "sport_0" : "${data.sport}";
                    },
                  });
                  return {
                    id: `item_${item}`,
                    title: "Football",
                    action: {
                      name: "navigate",
                      nextScreenId: `SCREEN_${String.fromCharCode(66 + index)}`,
                      payload,
                    },
                  };
                }),
              },
            ],
        ...(terminal
          ? {
              footer: {
                action: {
                  name: "complete",
                  payload: { result: "${data.sport}" },
                },
              },
            }
          : {}),
      };
    });
    assert.equal(
      listScenarioFormFields({ flowNavigationMode: "static_graph", screens })[0]
        ?.required,
      true,
    );
    assert.ok(reads <= 100);
  });
  it("retains the type of transported radio and checkbox questions", () => {
    for (const type of ["RadioButtonsGroup", "CheckboxGroup"]) {
      const fields = listScenarioFormFields(transported(true, true, type));
      assert.equal(fields[0]?.fieldType, type);
      assert.deepEqual(fields[0]?.options, [{ id: "a", title: "Alpha" }]);
    }
  });
  it("does not promise data supplied on only one incoming path", () => {
    const config = transported(true, true);
    Object.assign(config.screens[1]!.footer!.action, { payload: {} });
    assert.equal(listScenarioFormFields(config)[0]?.required, false);
  });
  it("counts completion paths with omitted payloads when deciding answer availability", () => {
    const config = branchingAnswerConfig();
    Object.assign(config.screens[2]!.footer!.action, { payload: undefined });
    assert.equal(
      listScenarioFormFields(config).find(
        (field) => field.responseKey === "athlete",
      )?.conditional,
      true,
    );
  });
  it("does not label a constant completion value using an unrelated first navigation choice", () => {
    const config = branchingAnswerConfig();
    const first = config.screens[0]!;
    for (const item of first.fields[0]!.navigationItems!)
      item.action.nextScreenId = "DETAILS";
    config.screens = config.screens.slice(0, 2);
    Object.assign(config.screens[1]!.footer!.action, {
      payload: { status: "done" },
    });
    assert.deepEqual(listScenarioFormFields(config)[0]?.options, [
      { id: "done", title: "done" },
    ]);
  });
  it("keeps a constant answer literal even with exactly one incoming navigation choice", () => {
    const config = branchingAnswerConfig();
    config.screens[0]!.fields[0]!.navigationItems =
      config.screens[0]!.fields[0]!.navigationItems!.slice(0, 1);
    config.screens = config.screens.slice(0, 2);
    Object.assign(config.screens[1]!.footer!.action, {
      payload: { status: "done" },
    });
    assert.deepEqual(listScenarioFormFields(config)[0]?.options, [
      { id: "done", title: "done" },
    ]);
    const submission = buildScenarioFormSubmission({
      sourceActionNodeId: "form",
      inboundMessageId: "reply",
      submittedAt: SUBMITTED_AT,
      flowConfig: config,
      responseJson: JSON.stringify({ status: "done" }),
    });
    assert.equal(submission?.fields[0]?.value, "done");
  });
  it("uses conservative metadata when terminal aliases refer to different questions", () => {
    const config = branchingAnswerConfig();
    Object.assign(config.screens[2]!.fields, {
      0: { ...config.screens[2]!.fields[0]!, label: "Customer name" },
      1: {
        ...config.screens[2]!.fields[1]!,
        fieldType: "TextInput",
        options: undefined,
      },
    });
    const fields = listScenarioFormFields(config);
    assert.equal(
      fields.find((field) => field.responseKey === "athlete")?.label,
      "Athlete",
    );
    assert.equal(
      fields.find((field) => field.responseKey === "design")?.fieldType,
      "TextInput",
    );
  });
  it("describes actual completion keys and navigation values without exposing internal answer IDs", () => {
    const fields = listScenarioFormFields(branchingAnswerConfig());
    assert.deepEqual(
      fields.map((field) => field.responseKey),
      ["__sport", "athlete", "design", "custom_sport"],
    );
    assert.equal(
      fields.find((field) => field.responseKey === "athlete")?.label,
      "Athlete name",
    );
    assert.deepEqual(
      fields.find((field) => field.responseKey === "__sport")?.options,
      [
        { id: "sport_0", title: "Football" },
        { id: "sport_other", title: "sport_other" },
      ],
    );
    assert.equal(
      fields.find((field) => field.responseKey === "__sport")?.key,
      "sport",
    );
    assert.equal(
      fields.find((field) => field.responseKey === "design")?.fieldType,
      "RadioButtonsGroup",
    );
  });

  it("marks only answers omitted by another completion path as conditional", () => {
    const fields = listScenarioFormFields(branchingAnswerConfig());
    assert.deepEqual(
      fields.map((field) => [field.responseKey, field.conditional === true]),
      [
        ["__sport", false],
        ["athlete", false],
        ["design", false],
        ["custom_sport", true],
      ],
    );
  });
});

describe("what a form's fields leave out", () => {
  /** A Flow read for display: fields inside an If and data-source lists are dropped. */
  const probeConfig = () => ({
    flowNavigationMode: "static_graph",
    screens: [
      {
        id: "FIRST",
        title: "First",
        fields: [{ id: "shown", label: "Shown", fieldType: "TextInput" }],
        footer: {
          label: "Next",
          action: {
            name: "navigate",
            nextScreenId: "LAST",
            payload: { carried: "${form.shown}", lost: "${form.dyn}" },
          },
        },
      },
      {
        id: "LAST",
        title: "Last",
        terminal: true,
        fields: [
          {
            id: "always",
            label: "Always",
            fieldType: "TextInput",
            required: true,
          },
        ],
        footer: {
          label: "Send",
          action: {
            name: "complete",
            payload: {
              always: "${form.always}",
              inif: "${form.inif}",
              carried: "${data.carried}",
              lost: "${data.lost}",
              source: "flow",
            },
          },
        },
      },
    ],
  });
  const completing = (count: number) => ({
    flowNavigationMode: "static_graph",
    screens: [
      {
        id: "LAST",
        terminal: true,
        fields: [],
        footer: {
          action: {
            name: "complete",
            payload: Object.fromEntries(
              Array.from({ length: count }, (_, index) => [
                `answer_${index}`,
                `value_${index}`,
              ]),
            ),
          },
        },
      },
    ],
  });

  it("names the answers nothing in the config describes, still listing them", () => {
    const coverage = listScenarioFormFieldsWithCoverage(probeConfig());
    assert.deepEqual(coverage.undescribedResponseKeys, ["inif", "lost"]);
    assert.equal(coverage.truncated, false);
    assert.deepEqual(
      coverage.fields.map((field) => [field.responseKey, field.label]),
      [
        ["always", "Always"],
        ["inif", "Inif"],
        ["carried", "Shown"],
        ["lost", "Lost"],
        ["source", "Source"],
      ],
    );
    assert.deepEqual(coverage.fields, listScenarioFormFields(probeConfig()));
  });

  it("tells when a completion sends more answers than a submission keeps", () => {
    const kept = listScenarioFormFieldsWithCoverage(
      completing(MAX_SCENARIO_FORM_SUBMISSION_FIELDS),
    );
    const cut = listScenarioFormFieldsWithCoverage(
      completing(MAX_SCENARIO_FORM_SUBMISSION_FIELDS + 1),
    );
    assert.equal(kept.truncated, false);
    assert.equal(cut.truncated, true);
    assert.equal(cut.fields.length, MAX_SCENARIO_FORM_SUBMISSION_FIELDS);
    assert.deepEqual(cut.undescribedResponseKeys, []);
  });

  it("leaves nothing out of forms whose every answer is described", () => {
    for (const config of [
      branchingAnswerConfig(),
      medalFlowConfig(),
      flowConfig(),
    ]) {
      const coverage = listScenarioFormFieldsWithCoverage(config);
      assert.deepEqual(coverage.fields, listScenarioFormFields(config));
      assert.deepEqual(coverage.undescribedResponseKeys, []);
      assert.equal(coverage.truncated, false);
    }
    assert.deepEqual(listScenarioFormFieldsWithCoverage(null), {
      fields: [],
      undescribedResponseKeys: [],
      truncated: false,
    });
  });
});

describe("scalar Flow completion values", () => {
  it("captures zero and false consistently with existing string form answers", () => {
    assert.deepEqual(normalizeWhatsAppFlowReplyValues(0), ["0"]);
    assert.deepEqual(normalizeWhatsAppFlowReplyValues(false), ["false"]);
    assert.deepEqual(
      normalizeWhatsAppFlowReplyValues(Number.POSITIVE_INFINITY),
      [],
    );
    const submitted = buildScenarioFormSubmission({
      sourceActionNodeId: "form",
      inboundMessageId: "reply",
      submittedAt: SUBMITTED_AT,
      responseJson: JSON.stringify({ score: 0, consent: false }),
    });
    assert.deepEqual(
      submitted?.fields.map((field) => [field.key, field.value]),
      [
        ["score", "0"],
        ["consent", "no"],
      ],
    );
  });
});

function flowConfig(extra: Record<string, unknown> = {}) {
  return {
    templateId: "order",
    ctaText: "Order",
    screens: [{ id: "ORDER", title: "Order details", fields: ORDER_FIELDS }],
    ...extra,
  };
}

function serviceForm(
  id: string,
  config: Record<string, unknown> = flowConfig(),
) {
  return {
    id,
    data: {
      kind: "action",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "flow",
          body: { mode: "fixed", text: "Fill in" },
          flowConfig: config,
        },
      },
    },
  };
}

function templateForm(
  id: string,
  config: Record<string, unknown> = flowConfig(),
) {
  return {
    id,
    data: {
      kind: "action",
      actionType: "whatsapp_template",
      actionFlowConfig: config,
    },
  };
}

function submission(
  sourceActionNodeId: string,
  fields: ScenarioFormSubmission["fields"] = [
    { key: "name", label: "Name", fieldType: "TextInput", value: "Amina" },
  ],
): ScenarioFormSubmission {
  return {
    sourceActionNodeId,
    flowId: "flow-1",
    inboundMessageId: `in-${sourceActionNodeId}`,
    submittedAt: SUBMITTED_AT.toISOString(),
    fields,
  };
}

describe("form answer tokens", () => {
  it("parses exactly form.<formKey>.<fieldKey> with answer keys", () => {
    assert.deepEqual(
      parseScenarioFormAnswerToken(
        scenarioFormAnswerToken(" order ", " size "),
      ),
      { formKey: "order", fieldKey: "size" },
    );
    for (const token of [
      "form",
      "form.order",
      "form.order.size.extra",
      "form..order.size",
      "form.Order.size",
      "form.order.Size",
      "form.order.1size",
      "forms.order.size",
      "input.size",
    ]) {
      assert.equal(parseScenarioFormAnswerToken(token), null, token);
    }
  });

  it("recognizes a missing-form error by its code", () => {
    const error = new ScenarioFormAnswerMissingError("form.order.size");
    assert.equal(isScenarioFormAnswerMissingError(error), true);
    assert.equal(error.token, "form.order.size");
    assert.equal(
      isScenarioFormAnswerMissingError(
        Object.assign(new Error("copy"), {
          code: "SCENARIO_FORM_ANSWER_MISSING",
        }),
      ),
      true,
    );
    assert.equal(isScenarioFormAnswerMissingError(new Error("other")), false);
  });
});

describe("Flow reply values", () => {
  it("reads text, lists and selection objects as routing always did", () => {
    assert.deepEqual(normalizeWhatsAppFlowReplyValues("  M "), ["M"]);
    assert.deepEqual(normalizeWhatsAppFlowReplyValues(" "), []);
    assert.deepEqual(normalizeWhatsAppFlowReplyValues(["a", ["b", ""]]), [
      "a",
      "b",
    ]);
    assert.deepEqual(normalizeWhatsAppFlowReplyValues({ selected: ["x"] }), [
      "x",
    ]);
    assert.deepEqual(normalizeWhatsAppFlowReplyValues({ value: "y" }), ["y"]);
    assert.deepEqual(normalizeWhatsAppFlowReplyValues({ id: "z" }), ["z"]);
    assert.deepEqual(
      normalizeWhatsAppFlowReplyValues({ media_id: "1", cdn_url: "https://x" }),
      [],
    );
    assert.deepEqual(normalizeWhatsAppFlowReplyValues(true), ["true"]);
  });

  it("formats answers as the customer saw them", () => {
    const [, size, colours, day, , wrap] = ORDER_FIELDS;
    assert.equal(formatScenarioFormAnswerValue("opt_l", size), "Large");
    assert.equal(formatScenarioFormAnswerValue("opt_x", size), "opt_x");
    assert.equal(
      formatScenarioFormAnswerValue(["red", "blue"], colours),
      "Red, Blue",
    );
    assert.equal(
      formatScenarioFormAnswerValue({ selected: ["blue"] }, colours),
      "Blue",
    );
    assert.equal(formatScenarioFormAnswerValue("yes", wrap), "Yes, wrap it");
    assert.equal(
      formatScenarioFormAnswerValue("2026-09-30", day),
      "2026-09-30",
    );
    assert.equal(formatScenarioFormAnswerValue(true, null), "yes");
    assert.equal(formatScenarioFormAnswerValue(false, null), "no");
    assert.equal(formatScenarioFormAnswerValue(3, null), "3");
    assert.equal(formatScenarioFormAnswerValue("a\r\nb ", null), "a\nb");
    assert.equal(formatScenarioFormAnswerValue([{ media_id: "1" }], null), "");
    assert.equal(
      formatScenarioFormAnswerValue("x".repeat(5000), null).length,
      MAX_SCENARIO_FORM_ANSWER_CHARACTERS,
    );
  });

  it("reads an epoch date as its day, whatever the customer's time zone", () => {
    const [, , , day] = ORDER_FIELDS;
    // Midnight on 30 September in Almaty (UTC+5) and in New York (UTC-4).
    for (const epoch of [
      Date.UTC(2026, 8, 29, 19),
      Date.UTC(2026, 8, 30, 4),
      Date.UTC(2026, 8, 30),
    ]) {
      assert.equal(
        formatScenarioFormAnswerValue(String(epoch), day),
        "2026-09-30",
      );
      assert.equal(formatScenarioFormAnswerValue(epoch, day), "2026-09-30");
    }
    assert.equal(
      formatScenarioFormAnswerValue("1727654400000", null),
      "1727654400000",
    );
  });
});

describe("form fields", () => {
  it("lists all six field types in screen order with their options", () => {
    const fields = listScenarioFormFields(
      flowConfig({
        screens: [
          { id: "ORDER", title: "Order details", fields: ORDER_FIELDS },
          {
            id: "MORE",
            title: "More",
            fields: [
              { id: "name", label: "Repeated", fieldType: "TextInput" },
              { id: "flow_token", label: "Token", fieldType: "TextInput" },
              { id: "photo", label: "Photo", fieldType: "PhotoPicker" },
              {
                id: "Second_Name",
                label: "",
                fieldType: "TextInput",
                required: true,
              },
            ],
          },
        ],
      }),
    );
    assert.deepEqual(
      fields.map((field) => [field.key, field.responseKey, field.fieldType]),
      [
        ["name", "name", "TextInput"],
        ["size", "size", "Dropdown"],
        ["colours", "colours", "CheckboxGroup"],
        ["day", "day", "DatePicker"],
        ["notes", "notes", "TextArea"],
        ["wrap", "wrap", "RadioButtonsGroup"],
        ["second_name", "Second_Name", "TextInput"],
      ],
    );
    assert.deepEqual(fields[1], {
      key: "size",
      responseKey: "size",
      label: "Size",
      description: "Order details",
      fieldType: "Dropdown",
      required: true,
      screenIndex: 0,
      options: [
        { id: "opt_s", title: "Small" },
        { id: "opt_l", title: "Large" },
      ],
    });
    assert.equal(fields[4]?.description, "Anything else");
    assert.equal(fields[6]?.label, "Second name");
    assert.equal(fields[6]?.screenIndex, 1);
    assert.equal(fields[6]?.required, true);
    assert.deepEqual(listScenarioFormFields(null), []);
    assert.deepEqual(listScenarioFormFields({ screens: "x" }), []);
  });

  it("gives keys that are not answer keys a stable alias, unique in the form", () => {
    const keys = resolveScenarioFormFieldKeys([
      "screen_0_First_name_0",
      "first_name",
      "First Name",
      "2nd choice",
      "Имя",
      "Имя2",
      "Café",
      "x".repeat(40),
      "X".repeat(40),
    ]);
    assert.deepEqual(Object.fromEntries(keys), {
      screen_0_First_name_0: "screen_0_first_name_0",
      first_name: "first_name",
      "First Name": "first_name_2",
      "2nd choice": "f_2nd_choice",
      Имя: "field",
      Имя2: "f_2",
      Café: "cafe",
      ["x".repeat(40)]: "x".repeat(32),
      ["X".repeat(40)]: `${"x".repeat(30)}_2`,
    });
  });

  it("names a form by its Flow, else its first screen", () => {
    assert.equal(
      readScenarioFormLabel(flowConfig({ metaFlowName: "Order form" })),
      "Order form",
    );
    assert.equal(
      readScenarioFormLabel(
        flowConfig({ providerReference: { flowName: "Linked form" } }),
      ),
      "Linked form",
    );
    assert.equal(readScenarioFormLabel(flowConfig()), "Order details");
    assert.equal(readScenarioFormLabel(null), "Form");
  });

  it("ends a long label at a word with an ellipsis", () => {
    const [address] = listScenarioFormFields(
      flowConfig({
        screens: [
          {
            id: "DELIVERY",
            title: "Delivery",
            fields: [
              {
                id: "address",
                label:
                  "Please tell us your full delivery address including apartment and entrance",
                fieldType: "TextArea",
              },
            ],
          },
        ],
      }),
    );
    assert.equal(
      address?.label,
      "Please tell us your full delivery address including…",
    );
    assert.equal(
      readScenarioFormLabel(
        flowConfig({ metaFlowName: `Order ${"x".repeat(80)}` }),
      ),
      `Order ${"x".repeat(MAX_SCENARIO_FORM_LABEL_CHARACTERS - 7)}…`,
    );
    const exact = "y".repeat(MAX_SCENARIO_FORM_LABEL_CHARACTERS);
    assert.equal(
      readScenarioFormLabel(flowConfig({ metaFlowName: exact })),
      exact,
    );
  });

  it("describes a form's fields for capture, as the Flow config lists them", () => {
    const schemas = listScenarioFormFieldSchemas(flowConfig());
    assert.deepEqual(
      schemas.map((field) => [field.id, field.label, field.fieldType]),
      [
        ["name", "Name", "TextInput"],
        ["size", "Size", "Dropdown"],
        ["colours", "Colours", "CheckboxGroup"],
        ["day", "Delivery day", "DatePicker"],
        ["notes", "Notes", "TextArea"],
        ["wrap", "Gift wrap", "RadioButtonsGroup"],
      ],
    );
    assert.deepEqual(schemas[1]?.options, [
      { id: "opt_s", title: "Small" },
      { id: "opt_l", title: "Large" },
    ]);
    assert.deepEqual(listScenarioFormFieldSchemas({ fields: [] }), []);
    assert.equal(
      humanizeScenarioAnswerKey("deliveryAddress"),
      "Delivery address",
    );
  });
});

describe("form keys", () => {
  it("keeps a stored key and derives one from the Flow name otherwise", () => {
    const keys = resolveScenarioFormKeys([
      { id: "trigger", data: { kind: "trigger" } },
      serviceForm(
        "stored",
        flowConfig({ answersKey: "order", metaFlowName: "Other" }),
      ),
      serviceForm("named", flowConfig({ metaFlowName: "Delivery Address!" })),
      templateForm(
        "linked",
        flowConfig({ providerReference: { flowName: "2024 Survey" } }),
      ),
      serviceForm("cyrillic", flowConfig({ metaFlowName: "Заказ" })),
      serviceForm("plain"),
      {
        id: "text",
        data: {
          kind: "action",
          actionWhatsAppServiceMessage: { message: { kind: "text" } },
        },
      },
      {
        id: "template",
        data: { kind: "action", actionType: "whatsapp_template" },
      },
    ]);
    assert.deepEqual(Object.fromEntries(keys), {
      stored: "order",
      named: "delivery_address",
      linked: "form_2024_survey",
      cyrillic: "form",
      plain: "form_2",
    });
  });

  it("lets stored keys win, so adding a named form never renames an unnamed one", () => {
    const legacy = [serviceForm("a"), serviceForm("b")];
    const before = resolveScenarioFormKeys(legacy);
    const after = resolveScenarioFormKeys([
      serviceForm("new", flowConfig({ answersKey: "order" })),
      ...legacy,
    ]);
    assert.deepEqual(Object.fromEntries(before), { a: "form", b: "form_2" });
    assert.equal(after.get("a"), "form");
    assert.equal(after.get("b"), "form_2");
    assert.equal(after.get("new"), "order");

    const clash = resolveScenarioFormKeys([
      serviceForm("derived", flowConfig({ metaFlowName: "Order" })),
      serviceForm("first", flowConfig({ answersKey: "order" })),
      serviceForm("second", flowConfig({ answersKey: "order" })),
      serviceForm("invalid", flowConfig({ answersKey: "Order form" })),
    ]);
    assert.deepEqual(Object.fromEntries(clash), {
      first: "order",
      derived: "order_2",
      second: "order_3",
      invalid: "form",
    });
  });

  it("claims a new form a key from its name that no other form has", () => {
    assert.equal(claimScenarioFormKey(["Order details"], []), "order_details");
    assert.equal(
      claimScenarioFormKey(["lead_generation"], ["lead_generation"]),
      "lead_generation_2",
    );
    assert.equal(claimScenarioFormKey(["2024 Survey"], []), "form_2024_survey");
    assert.equal(claimScenarioFormKey(["Заказ"], ["form", "form_2"]), "form_3");
    assert.equal(claimScenarioFormKey([], new Set(["order"])), "form");
    // A name with no slug gives way to the next one, as derived keys do.
    assert.equal(claimScenarioFormKey(["Заказ", "Order"], []), "order");
  });

  it("reads a form's stored key and names as keys are made from them", () => {
    assert.equal(readScenarioStoredFormKey({ answersKey: " order " }), "order");
    assert.equal(readScenarioStoredFormKey({ answersKey: "Order!" }), "");
    assert.equal(readScenarioStoredFormKey(null), "");
    assert.deepEqual(
      listScenarioFormNames({
        metaFlowName: "Order",
        providerReference: { flowName: "Linked order" },
      }),
      ["Order", "Linked order"],
    );
    assert.deepEqual(listScenarioFormNames("nope"), []);
  });

  it("reads a template's attached Flow only on a template action", () => {
    assert.ok(readScenarioActionFlowConfig(templateForm("t").data));
    assert.equal(
      readScenarioActionFlowConfig({
        kind: "action",
        actionFlowConfig: flowConfig(),
      }),
      null,
    );
  });
});

describe("form submissions", () => {
  it("records every answer in field order, formatted as the form was sent", () => {
    const built = buildScenarioFormSubmission({
      sourceActionNodeId: " order-node ",
      flowId: "flow-1",
      inboundMessageId: "wamid.in",
      submittedAt: SUBMITTED_AT,
      responseJson: JSON.stringify({
        flow_token: "airi1.token",
        wrap: "no",
        extra_Field: "kept",
        token: "ignored",
        values: { name: " Amina ", size: "opt_l", colours: ["red", "blue"] },
        notes: "",
        photo: [{ media_id: "1" }],
      }),
      fields: ORDER_FIELDS,
    });
    assert.deepEqual(built, {
      sourceActionNodeId: "order-node",
      flowId: "flow-1",
      inboundMessageId: "wamid.in",
      submittedAt: "2026-09-30T10:00:00.000Z",
      fields: [
        { key: "name", label: "Name", fieldType: "TextInput", value: "Amina" },
        { key: "size", label: "Size", fieldType: "Dropdown", value: "Large" },
        {
          key: "colours",
          label: "Colours",
          fieldType: "CheckboxGroup",
          value: "Red, Blue",
        },
        {
          key: "wrap",
          label: "Gift wrap",
          fieldType: "RadioButtonsGroup",
          value: "No",
        },
        {
          key: "extra_Field",
          label: "Extra field",
          fieldType: "unknown",
          value: "kept",
        },
      ],
    });
  });

  it("reads a stored field snapshot, which has no field types", () => {
    const built = buildScenarioFormSubmission({
      sourceActionNodeId: "template-node",
      inboundMessageId: "wamid.in",
      submittedAt: SUBMITTED_AT,
      responseJson: JSON.stringify({ flow_token: "t", size: "opt_s" }),
      fields: [
        {
          id: "size",
          label: "Size",
          options: [{ id: "opt_s", title: "Small" }],
        },
      ],
    });
    assert.deepEqual(built?.fields, [
      { key: "size", label: "Size", fieldType: "unknown", value: "Small" },
    ]);
    assert.equal(built?.flowId, null);
  });

  it("records a form submitted with every answer blank, and nothing for unreadable replies", () => {
    const blank = buildScenarioFormSubmission({
      sourceActionNodeId: "order-node",
      inboundMessageId: "wamid.in",
      submittedAt: SUBMITTED_AT,
      responseJson: JSON.stringify({ flow_token: "t", notes: " " }),
      fields: ORDER_FIELDS,
    });
    assert.deepEqual(blank?.fields, []);
    for (const responseJson of [null, "", "not json", "[1]", '"text"']) {
      assert.equal(
        buildScenarioFormSubmission({
          sourceActionNodeId: "order-node",
          inboundMessageId: "wamid.in",
          submittedAt: SUBMITTED_AT,
          responseJson,
          fields: ORDER_FIELDS,
        }),
        null,
        String(responseJson),
      );
    }
    assert.equal(
      buildScenarioFormSubmission({
        sourceActionNodeId: " ",
        inboundMessageId: "wamid.in",
        submittedAt: SUBMITTED_AT,
        responseJson: "{}",
      }),
      null,
    );
  });

  it("bounds each submission: fields, characters and labels", () => {
    const many = Object.fromEntries(
      Array.from({ length: 50 }, (_, index) => [
        `field_${index}`,
        `answer ${index}`,
      ]),
    );
    const built = buildScenarioFormSubmission({
      sourceActionNodeId: "order-node",
      inboundMessageId: "wamid.in",
      submittedAt: SUBMITTED_AT,
      responseJson: JSON.stringify(many),
    });
    assert.equal(built?.fields.length, MAX_SCENARIO_FORM_SUBMISSION_FIELDS);

    const long = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        `long_${index}`,
        "y".repeat(2000),
      ]),
    );
    const bounded = buildScenarioFormSubmission({
      sourceActionNodeId: "order-node",
      inboundMessageId: "wamid.in",
      submittedAt: SUBMITTED_AT,
      responseJson: JSON.stringify(long),
      fields: [{ id: "long_0", label: "L".repeat(200) }],
    });
    const lengths = bounded?.fields.map((field) => field.value.length) ?? [];
    assert.equal(
      lengths.every((length) => length <= MAX_SCENARIO_FORM_ANSWER_CHARACTERS),
      true,
    );
    assert.equal(
      lengths.reduce((sum, length) => sum + length, 0),
      MAX_SCENARIO_FORM_SUBMISSION_CHARACTERS,
    );
    assert.equal(
      bounded?.fields[0]?.label,
      `${"L".repeat(MAX_SCENARIO_FORM_LABEL_CHARACTERS - 1)}…`,
    );
  });

  it("cuts the answer that crosses the submission budget to what is left", () => {
    const answers = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [
        `part_${index}`,
        "z".repeat(900),
      ]),
    );
    const bounded = buildScenarioFormSubmission({
      sourceActionNodeId: "order-node",
      inboundMessageId: "wamid.in",
      submittedAt: SUBMITTED_AT,
      responseJson: JSON.stringify(answers),
    });
    // Eight whole answers, then the ninth cut to the 800 characters left.
    assert.deepEqual(
      bounded?.fields.map((field) => field.value.length),
      [900, 900, 900, 900, 900, 900, 900, 900, 800],
    );
  });

  it("never cuts a character in half at a bound", () => {
    const emoji = String.fromCodePoint(0x1f600);
    assert.equal(sliceScenarioAnswerText(`ab`, 5), "ab");
    assert.equal(sliceScenarioAnswerText(`a${emoji}`, 3), `a${emoji}`);
    assert.equal(sliceScenarioAnswerText(`a${emoji}`, 2), "a");
    assert.equal(sliceScenarioAnswerText(`${emoji}b`, 1), "");

    const built = buildScenarioFormSubmission({
      sourceActionNodeId: "order-node",
      inboundMessageId: "wamid.in",
      submittedAt: SUBMITTED_AT,
      responseJson: JSON.stringify({
        // An emoji across the answer limit, then across the budget.
        answer: `${"a".repeat(MAX_SCENARIO_FORM_ANSWER_CHARACTERS - 1)}${emoji}`,
        ...Object.fromEntries(
          Array.from({ length: 6 }, (_, index) => [
            `full_${index}`,
            "f".repeat(1000),
          ]),
        ),
        one: "o",
        last: `${"d".repeat(998)}${emoji}`,
      }),
      fields: [
        {
          id: "answer",
          label: `${"L".repeat(MAX_SCENARIO_FORM_LABEL_CHARACTERS - 2)}${emoji}x`,
        },
      ],
    });
    const [answer] = built?.fields ?? [];
    assert.equal(
      answer?.value,
      "a".repeat(MAX_SCENARIO_FORM_ANSWER_CHARACTERS - 1),
    );
    assert.equal(
      answer?.label,
      `${"L".repeat(MAX_SCENARIO_FORM_LABEL_CHARACTERS - 2)}…`,
    );
    // 999 + 6000 + 1 leaves 1000 for the last answer, whose emoji ends at
    // 1000 and is kept; the budget has no room for a cut here.
    const last = built?.fields.at(-1);
    assert.equal(last?.key, "last");
    assert.equal(last?.value, `${"d".repeat(998)}${emoji}`);
    assert.equal(
      built?.fields.every((field) => isWellFormedText(field.value)),
      true,
    );

    const crossing = buildScenarioFormSubmission({
      sourceActionNodeId: "order-node",
      inboundMessageId: "wamid.in",
      submittedAt: SUBMITTED_AT,
      responseJson: JSON.stringify({
        ...Object.fromEntries(
          Array.from({ length: 7 }, (_, index) => [
            `full_${index}`,
            "f".repeat(1000),
          ]),
        ),
        one: "o",
        last: `${"d".repeat(998)}${emoji}`,
      }),
    });
    // 7001 used leaves 999: the emoji would straddle it, so it goes whole.
    assert.equal(crossing?.fields.at(-1)?.value, "d".repeat(998));
  });
});

/** No lone half of a surrogate pair. */
function isWellFormedText(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

describe("form answer ledger", () => {
  it("keeps the latest submission per node and replaces it as a whole", () => {
    let state: Record<string, unknown> = { lockedScenarioId: "s1" };
    state = recordScenarioFormSubmission(state, {
      scenarioId: "s1",
      submission: submission("order", [
        { key: "name", label: "Name", fieldType: "TextInput", value: "Amina" },
        {
          key: "notes",
          label: "Notes",
          fieldType: "TextArea",
          value: "Ring twice",
        },
      ]),
    });
    state = recordScenarioFormSubmission(state, {
      scenarioId: "s1",
      submission: submission("contact"),
    });
    state = recordScenarioFormSubmission(state, {
      scenarioId: "s1",
      submission: submission("order", [
        { key: "name", label: "Name", fieldType: "TextInput", value: "Aru" },
      ]),
    });
    assert.equal(state.lockedScenarioId, "s1");
    const submissions = readScenarioFormSubmissions(state, "s1");
    assert.deepEqual(
      submissions.map((item) => item.sourceActionNodeId),
      ["contact", "order"],
    );
    // The blank optional answer of the resubmission clears the old one.
    assert.deepEqual(submissions[1]?.fields, [
      { key: "name", label: "Name", fieldType: "TextInput", value: "Aru" },
    ]);
  });

  it("drops the oldest submission past the limit instead of failing", () => {
    let state: unknown = null;
    for (let index = 0; index < MAX_SCENARIO_FORM_SUBMISSIONS + 3; index += 1) {
      state = recordScenarioFormSubmission(state, {
        scenarioId: "s1",
        submission: submission(`form-${index}`),
      });
    }
    const submissions = readScenarioFormSubmissions(state, "s1");
    assert.equal(submissions.length, MAX_SCENARIO_FORM_SUBMISSIONS);
    assert.equal(submissions[0]?.sourceActionNodeId, "form-3");
    assert.equal(submissions.at(-1)?.sourceActionNodeId, "form-12");
  });

  it("keeps each scenario's answers to itself", () => {
    let state = recordScenarioFormSubmission(
      {},
      { scenarioId: "s1", submission: submission("order") },
    );
    assert.deepEqual(readScenarioFormSubmissions(state, "s2"), []);
    assert.deepEqual(readScenarioFormSubmissions(state, null), []);
    state = recordScenarioFormSubmission(state, {
      scenarioId: "s2",
      submission: submission("contact"),
    });
    assert.deepEqual(readScenarioFormSubmissions(state, "s1"), []);
    assert.deepEqual(
      readScenarioFormSubmissions(state, "s2").map(
        (item) => item.sourceActionNodeId,
      ),
      ["contact"],
    );
  });

  it("leaves state as it was for an unusable submission or scenario", () => {
    const state = recordScenarioFormSubmission(
      {},
      { scenarioId: "s1", submission: submission("order") },
    );
    for (const params of [
      { scenarioId: " ", submission: submission("contact") },
      {
        scenarioId: "s1",
        submission: { ...submission("contact"), sourceActionNodeId: "" },
      },
      {
        scenarioId: "s1",
        submission: null as unknown as ScenarioFormSubmission,
      },
    ]) {
      assert.deepEqual(recordScenarioFormSubmission(state, params), state);
    }
  });

  it("normalizes stored answers and drops what it cannot read", () => {
    assert.equal(normalizeScenarioFormAnswers(null), null);
    assert.equal(
      normalizeScenarioFormAnswers({ scenarioId: "s1", submissions: [] }),
      null,
    );
    assert.equal(
      normalizeScenarioFormAnswers({
        scenarioId: "",
        submissions: [submission("a")],
      }),
      null,
    );
    assert.deepEqual(
      normalizeScenarioFormAnswers({
        scenarioId: " s1 ",
        submissions: [
          "junk",
          {
            sourceActionNodeId: "a",
            submittedAt: new Date(SUBMITTED_AT),
            fields: [
              { key: "flow_token", value: "t" },
              { key: "x", value: "  " },
              { key: "size", label: "Size", fieldType: "OptIn", value: "M" },
              { key: "size", value: "duplicate" },
            ],
          },
        ],
      }),
      {
        scenarioId: "s1",
        submissions: [
          {
            sourceActionNodeId: "a",
            flowId: null,
            inboundMessageId: "",
            submittedAt: "2026-09-30T10:00:00.000Z",
            fields: [
              { key: "size", label: "Size", fieldType: "unknown", value: "M" },
            ],
          },
        ],
      },
    );
  });
});

describe("form answer template values", () => {
  const nodes = [
    { id: "trigger", data: { kind: "trigger" } },
    serviceForm(
      "order",
      flowConfig({ answersKey: "order", metaFlowName: "Order form" }),
    ),
    templateForm("contact"),
  ];

  it("maps each form node to its keys and labels", () => {
    const map = buildScenarioFormAnswerFieldMap(nodes);
    assert.deepEqual(Object.keys(map), ["order", "contact"]);
    assert.equal(map.order?.formKey, "order");
    assert.equal(map.order?.formLabel, "Order form");
    assert.equal(map.contact?.formKey, "form");
    assert.equal(map.contact?.formLabel, "Order details");
    assert.deepEqual(map.order?.fields.size, { key: "size", label: "Size" });
  });

  it("gives every submitted form a group, even with its answers blank", () => {
    const map = buildScenarioFormAnswerFieldMap(nodes);
    assert.deepEqual(
      readScenarioFormAnswerTemplateValues(
        [
          submission("order", [
            {
              key: "size",
              label: "Size",
              fieldType: "Dropdown",
              value: "Large",
            },
            {
              key: "removed",
              label: "Removed",
              fieldType: "TextInput",
              value: "x",
            },
          ]),
          submission("contact", []),
          submission("unknown-node"),
        ],
        map,
      ),
      { order: { size: "Large" }, form: {} },
    );
    assert.deepEqual(
      readScenarioFormAnswerTemplateValues([submission("order")], null),
      {},
    );
  });
});

/** medal_pick_1's Flow; the saved template holds it as a BSON double. */
const MEDAL_FLOW_ID = 2244981489363579;
const MEDAL_DETAILS_FIELDS = [
  {
    id: "____133f36",
    label: "Design",
    fieldType: "RadioButtonsGroup",
    required: true,
    options: [
      { id: "0_Есімі_жазылатын_(Именная)", title: "Personalised" },
      { id: "1_Классикалық", title: "Classic" },
    ],
  },
  {
    id: "_68d224",
    label: "Athlete's name",
    fieldType: "TextInput",
    required: true,
    helperText: "Write every name",
  },
  { id: "_ebfcfb", label: "City / region", fieldType: "TextInput" },
];

/** DemoShop's medal form: a sport list, then design and names per path. */
function medalFlowConfig() {
  const sport = (id: string, title: string, value: string) => ({
    id,
    title,
    action: {
      name: "navigate",
      nextScreenId: "DETAILS",
      payload: { sport: value },
    },
  });
  return {
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
              sport("sport_0", "Football", "0_Футбол_/_Баскетбол_/_Волейбол"),
              sport(
                "sport_1",
                "Taekwondo, karate, wrestling",
                "1_Таэквондо_/_Каратэ_/_Күрес",
              ),
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
        fields: MEDAL_DETAILS_FIELDS,
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
          ...MEDAL_DETAILS_FIELDS,
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
}

/** The saved form the builder reads from the medal Flow. */
function medalForm(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    flowId: String(MEDAL_FLOW_ID),
    flowName: "demoshop_ai_case",
    answersKey: "demoshop_ai_case",
    digest: "a".repeat(64),
    coverage: "complete",
    endpoint: false,
    readAt: "2026-10-04T08:00:00.000Z",
    fields: listScenarioFormFields(medalFlowConfig()).map(
      ({ key: _key, ...field }) => field,
    ),
    ...overrides,
  };
}

function medalStep(
  form: unknown = medalForm(),
  extra: Record<string, unknown> = {},
) {
  return {
    id: "medal",
    data: {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Pick your medal" },
        {
          type: "BUTTONS",
          buttons: [{ type: "FLOW", text: "Choose", flow_id: MEDAL_FLOW_ID }],
        },
      ],
      actionWhatsAppTemplateForm: form,
      ...extra,
    },
  };
}

describe("a template's saved form", () => {
  it("bounds a saved form and drops the fields it cannot read", () => {
    const normalized = normalizeScenarioWhatsAppTemplateForm(
      medalForm({
        flowId: " 2244981489363579 ",
        answersKey: " demoshop_ai_case ",
        flowName: "",
        coverage: "unknown",
        endpoint: "yes",
        readAt: "not a time",
        fields: [
          {
            responseKey: "choice",
            label: `Pick ${"one long label ".repeat(8)}`,
            description: " Pick one ",
            fieldType: "Dropdown",
            required: true,
            screenIndex: 2,
            options: Array.from({ length: 120 }, (_, index) => ({
              id: `option_${index}`,
              title: `Option ${index}`,
            })),
            conditional: true,
          },
          { responseKey: "choice", label: "Again", fieldType: "TextInput" },
          { responseKey: "photo", label: "Photo", fieldType: "PhotoPicker" },
          { responseKey: "flow_token", label: "Token", fieldType: "TextInput" },
          {
            responseKey: "note",
            fieldType: "TextArea",
            required: "yes",
            screenIndex: -1,
          },
          ...Array.from({ length: 45 }, (_, index) => ({
            responseKey: `extra_${index}`,
            label: `Extra ${index}`,
            fieldType: "TextInput",
          })),
        ],
      }),
    );
    assert.equal(normalized.status, "supported");
    const form = normalized.value!;
    assert.equal(form.flowId, "2244981489363579");
    assert.equal(form.answersKey, "demoshop_ai_case");
    assert.equal(form.flowName, null);
    assert.equal(form.coverage, "partial");
    assert.equal(form.endpoint, false);
    assert.equal(form.readAt, "");
    assert.equal(
      form.fields.length,
      MAX_SCENARIO_WHATSAPP_TEMPLATE_FORM_FIELDS,
    );
    const [choice, note] = form.fields;
    assert.deepEqual(
      form.fields.slice(0, 3).map((field) => field.responseKey),
      ["choice", "note", "extra_0"],
    );
    assert.equal(
      choice?.options.length,
      MAX_SCENARIO_WHATSAPP_TEMPLATE_FORM_OPTIONS,
    );
    assert.ok(
      (choice?.label.length ?? 0) <= MAX_SCENARIO_FORM_LABEL_CHARACTERS &&
        choice?.label.endsWith("…"),
    );
    assert.equal(choice?.description, "Pick one");
    assert.equal(choice?.conditional, true);
    assert.deepEqual(note, {
      responseKey: "note",
      label: "Note",
      description: "",
      fieldType: "TextArea",
      required: false,
      screenIndex: 0,
      options: [],
    });
  });

  it("keeps a saved form it cannot read as it is", () => {
    const cases: Array<[string, unknown]> = [
      ["a newer version", medalForm({ version: 2 })],
      ["a Flow id that is not digits", medalForm({ flowId: "flow-1" })],
      ["a Flow id saved as a number", medalForm({ flowId: MEDAL_FLOW_ID })],
      ["a key that is not an answer key", medalForm({ answersKey: "Medal" })],
      ["no field list", medalForm({ fields: "none" })],
      ["not an object", "form"],
    ];
    for (const [name, raw] of cases) {
      const normalized = normalizeScenarioWhatsAppTemplateForm(raw);
      assert.equal(normalized.status, "unsupported", name);
      assert.equal(
        normalized.status === "unsupported" ? normalized.raw : null,
        raw,
        name,
      );
    }
    assert.equal(normalizeScenarioWhatsAppTemplateForm(null).status, "absent");
    assert.equal(
      normalizeScenarioWhatsAppTemplateForm(undefined).status,
      "absent",
    );
  });

  it("reads a template's saved form while its FLOW button opens that Flow", () => {
    const step = medalStep();
    const form = readScenarioActionForm(step.data);
    assert.equal(form?.sender, "template");
    assert.equal(form?.snapshotFlowId, "2244981489363579");
    // The config only names the form; it is never saved.
    assert.deepEqual(form?.flowConfig, {
      screens: [],
      answersKey: "demoshop_ai_case",
      metaFlowName: "demoshop_ai_case",
    });

    const map = buildScenarioFormAnswerFieldMap([
      { id: "trigger", data: { kind: "trigger" } },
      step,
    ]);
    assert.equal(map.medal?.formKey, "demoshop_ai_case");
    assert.equal(map.medal?.formLabel, "demoshop_ai_case");
    assert.deepEqual(
      Object.entries(map.medal?.fields ?? {}).map(([responseKey, field]) => [
        responseKey,
        field.key,
      ]),
      [
        ["__9ba1c9", "f_9ba1c9"],
        ["____133f36", "f_133f36"],
        ["_68d224", "f_68d224"],
        ["_ebfcfb", "ebfcfb"],
        ["other_sport", "other_sport"],
      ],
    );
    assert.equal(
      readScenarioActionForm(medalStep(medalForm({ endpoint: true })).data)
        ?.flowConfig.flowNavigationMode,
      "data_endpoint",
    );
    assert.equal(form?.partial, undefined);
    assert.equal(
      readScenarioActionForm(medalStep(medalForm({ coverage: "partial" })).data)
        ?.partial,
      true,
    );
    assert.deepEqual(listScenarioActionFormFields(null), []);
    assert.deepEqual(listScenarioActionFormFieldSchemas(undefined), []);
  });

  it("ignores a saved form for another Flow, version or step", () => {
    const cases: Array<[string, ReturnType<typeof medalStep>]> = [
      ["another Flow", medalStep(medalForm({ flowId: "1571793974235171" }))],
      [
        "quick replies only",
        medalStep(medalForm(), {
          actionWhatsAppTemplateComponents: [
            {
              type: "BUTTONS",
              buttons: [{ type: "QUICK_REPLY", text: "Yes" }],
            },
          ],
        }),
      ],
      ["a newer version", medalStep(medalForm({ version: 2 }))],
      ["another action", medalStep(medalForm(), { actionType: "reply" })],
      [
        "a service message",
        medalStep(medalForm(), {
          actionWhatsAppServiceMessage: {
            version: 1,
            message: { kind: "text", body: { mode: "fixed", text: "Hi" } },
          },
        }),
      ],
    ];
    for (const [name, step] of cases) {
      assert.equal(readScenarioActionForm(step.data), null, name);
      assert.deepEqual(buildScenarioFormAnswerFieldMap([step]), {}, name);
    }
  });

  it("reads a template's form while its message key is left undefined", () => {
    // The builder's type change leaves the key on the step, set to undefined,
    // until a save drops it. The step reads as it does after a reload.
    const unsaved = medalStep(medalForm(), {
      actionWhatsAppServiceMessage: undefined,
    });
    assert.ok(Object.hasOwn(unsaved.data, "actionWhatsAppServiceMessage"));
    assert.deepEqual(
      readScenarioActionForm(unsaved.data),
      readScenarioActionForm(medalStep().data),
    );
    assert.equal(readScenarioActionForm(unsaved.data)?.sender, "template");
    assert.deepEqual(
      buildScenarioFormAnswerFieldMap([unsaved]),
      buildScenarioFormAnswerFieldMap([medalStep()]),
    );
    const linked = templateForm("t").data;
    assert.equal(
      readScenarioActionFlowConfig({
        ...linked,
        actionWhatsAppServiceMessage: undefined,
      }),
      linked.actionFlowConfig,
    );

    // A saved null still counts as a service message, as it did.
    const saved = medalStep(medalForm(), {
      actionWhatsAppServiceMessage: null,
    });
    assert.equal(readScenarioActionForm(saved.data), null);
    assert.equal(
      readScenarioActionFlowConfig({
        ...linked,
        actionWhatsAppServiceMessage: null,
      }),
      null,
    );
  });

  it("lets a Flow config with fields win, and keeps a linked Flow's own key", () => {
    const built = readScenarioActionForm(
      medalStep(medalForm(), {
        actionFlowConfig: flowConfig({ answersKey: "order" }),
      }).data,
    );
    assert.equal(built?.fields, undefined);
    assert.equal(built?.snapshotFlowId, undefined);
    assert.equal(built?.flowConfig.answersKey, "order");
    assert.deepEqual(
      listScenarioActionFormFields(built).map((field) => field.responseKey),
      ["name", "size", "colours", "day", "notes", "wrap"],
    );

    const linkedConfig = {
      templateId: "",
      ctaText: "Choose",
      screens: [],
      answersKey: "medals",
      providerReference: {
        flowId: String(MEDAL_FLOW_ID),
        flowName: "Medal form",
      },
    };
    const linked = readScenarioActionForm(
      medalStep(medalForm(), { actionFlowConfig: linkedConfig }).data,
    );
    assert.equal(linked?.flowConfig.answersKey, "medals");
    assert.equal(linked?.snapshotFlowId, "2244981489363579");
    assert.deepEqual(
      listScenarioActionFormFields(linked).map((field) => field.key),
      ["f_9ba1c9", "f_133f36", "f_68d224", "ebfcfb", "other_sport"],
    );
    const { answersKey: _answersKey, ...unkeyedConfig } = linkedConfig;
    assert.equal(
      readScenarioActionForm(
        medalStep(medalForm(), { actionFlowConfig: unkeyedConfig }).data,
      )?.flowConfig.answersKey,
      "demoshop_ai_case",
    );
    // Without a saved form, the linked Flow reads as before.
    assert.deepEqual(
      readScenarioActionForm(
        medalStep(null, { actionFlowConfig: linkedConfig }).data,
      ),
      { flowConfig: linkedConfig, sender: "template" },
    );
  });

  it("reads a saved form for a send only of the Flow it was read from", () => {
    const saved = medalStep().data;
    assert.deepEqual(
      readScenarioActionFormForFlow(saved, " 2244981489363579 "),
      readScenarioActionForm(saved),
    );
    assert.equal(
      readScenarioActionFormForFlow(saved, "1571793974235171"),
      null,
    );
    // A send of no known Flow reads the node's form.
    assert.deepEqual(
      readScenarioActionFormForFlow(saved, null),
      readScenarioActionForm(saved),
    );
    // A Flow config with fields has no saved Flow to differ from.
    const built = medalStep(medalForm(), {
      actionFlowConfig: flowConfig(),
    }).data;
    assert.deepEqual(
      readScenarioActionFormForFlow(built, "1571793974235171"),
      readScenarioActionForm(built),
    );
  });

  it("records answers to a saved form with its option titles", () => {
    const step = medalStep();
    const submitted = buildScenarioFormSubmission({
      sourceActionNodeId: "medal",
      flowId: String(MEDAL_FLOW_ID),
      inboundMessageId: "wamid.in",
      submittedAt: SUBMITTED_AT,
      responseJson: JSON.stringify({
        flow_token: "flow_1727654400000_abcdefghij",
        __9ba1c9: "1_Таэквондо_/_Каратэ_/_Күрес",
        ____133f36: "1_Классикалық",
        _68d224: "Amina",
        _ebfcfb: "Shymkent",
      }),
      fields: listScenarioActionFormFieldSchemas(
        readScenarioActionForm(step.data),
      ),
    });
    assert.ok(submitted);
    assert.deepEqual(
      readScenarioFormAnswerTemplateValues(
        [submitted],
        buildScenarioFormAnswerFieldMap([step]),
      ),
      {
        demoshop_ai_case: {
          f_9ba1c9: "Taekwondo, karate, wrestling",
          f_133f36: "Classic",
          f_68d224: "Amina",
          ebfcfb: "Shymkent",
        },
      },
    );
  });
});
