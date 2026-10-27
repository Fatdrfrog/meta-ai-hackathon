import type { ScenarioFormAnswerChoice } from "./node-enrichment/scenario-node-graph-index";
import {
  buildScenarioFormAnswerVariableFields,
  buildScenarioPromptInputVariableFields,
  buildScenarioVariableGroups,
} from "./scenario-variable-groups";

const t = (key: string, values?: Record<string, string | number | Date>) =>
  values ? `${key}(${Object.values(values).join(",")})` : key;

function formField(
  key: string,
  label: string,
  mayBeEmpty: boolean
): ScenarioFormAnswerChoice["fields"][number] {
  return {
    key,
    responseKey: key,
    label,
    description: "",
    fieldType: "TextInput",
    required: !mayBeEmpty,
    screenIndex: 0,
    options: [],
    mayBeEmpty,
  };
}

const contactForm: ScenarioFormAnswerChoice = {
  nodeId: "contact-step",
  formKey: "contact",
  formLabel: "Contact",
  label: "Contact details",
  availability: "always",
  schema: "known",
  fields: [
    { ...formField("name", "Name", false), description: "Your name" },
    formField("email", "Email", true),
  ],
};

const orderForm: ScenarioFormAnswerChoice = {
  nodeId: "order-step",
  formKey: "order",
  formLabel: "Order",
  label: "Order details",
  availability: "some_paths",
  schema: "known",
  fields: [formField("size", "Size", true)],
};

const medalForm: ScenarioFormAnswerChoice = {
  nodeId: "medal-step",
  formKey: "medal_pick",
  formLabel: "Medal pick",
  label: "",
  availability: "always",
  schema: "unknown",
  fields: [],
};

describe("buildScenarioFormAnswerVariableFields", () => {
  it("lists each form's answers under its own group, badging the ones that may be empty", () => {
    expect(
      buildScenarioFormAnswerVariableFields([contactForm, orderForm], t)
    ).toEqual([
      {
        token: "form.contact.name",
        label: "Name",
        description: "Your name",
        group: {
          id: "form:contact-step",
          label: "variableGroupForm(Contact details)",
        },
        badge: undefined,
      },
      {
        token: "form.contact.email",
        label: "Email",
        description: "",
        group: {
          id: "form:contact-step",
          label: "variableGroupForm(Contact details)",
        },
        badge: "variableFieldMayBeEmpty",
      },
      {
        token: "form.order.size",
        label: "Size",
        description: "",
        group: {
          id: "form:order-step",
          label: "variableGroupForm(Order details)",
        },
        badge: "variableFieldMayBeEmpty",
      },
    ]);
  });

  it("gives a form whose fields aren't known one note, named by the form", () => {
    // A form built only in WhatsApp has no key; its step names the note.
    const whatsAppOnly = {
      ...medalForm,
      nodeId: "template-step",
      formKey: "",
      label: "promo_template",
    };
    expect(
      buildScenarioFormAnswerVariableFields([medalForm, whatsAppOnly], t)
    ).toEqual([
      {
        token: "form.medal_pick",
        label: "variableFormFieldsUnknown",
        description: "",
        group: {
          id: "form:medal-step",
          label: "variableGroupForm(Medal pick)",
        },
        note: true,
      },
      {
        token: "form.template-step",
        label: "variableFormFieldsUnknown",
        description: "",
        group: {
          id: "form:template-step",
          label: "variableGroupForm(promo_template)",
        },
        note: true,
      },
    ]);
  });

  it("ends a form whose fields leave answers out with one note after its fields", () => {
    const partialContact = { ...contactForm, partial: true as const };
    // It lists no answer at all; the note still names the form.
    const partialOrder = { ...orderForm, fields: [], partial: true as const };
    expect(
      buildScenarioFormAnswerVariableFields([partialContact, partialOrder], t)
    ).toEqual([
      ...buildScenarioFormAnswerVariableFields([contactForm], t),
      {
        token: "form.contact",
        label: "variableFormFieldsPartial",
        description: "",
        group: {
          id: "form:contact-step",
          label: "variableGroupForm(Contact details)",
        },
        note: true,
      },
      {
        token: "form.order",
        label: "variableFormFieldsPartial",
        description: "",
        group: {
          id: "form:order-step",
          label: "variableGroupForm(Order details)",
        },
        note: true,
      },
    ]);
  });

  it("shows a question's line only where it tells the questions apart", () => {
    const delivery: ScenarioFormAnswerChoice = {
      ...contactForm,
      label: "Delivery",
      fields: [
        // The screen title, repeated under every question.
        { ...formField("address", "Address", false), description: "Where to" },
        { ...formField("floor", "Floor", false), description: "Where to" },
        { ...formField("time", "Time", false), description: "Delivery" },
        { ...formField("gate", "Gate", false), description: "Code or bell" },
      ],
    };
    expect(
      buildScenarioFormAnswerVariableFields([delivery], t).map(
        item => item.description
      )
    ).toEqual(["", "", "", "Code or bell"]);
  });

  it("tells forms with the same name apart by their key", () => {
    const again = { ...orderForm, nodeId: "order-step-2", formKey: "order_2" };
    expect(
      buildScenarioFormAnswerVariableFields([orderForm, again], t).map(
        item => item.group?.label
      )
    ).toEqual([
      "variableGroupForm(Order details (order))",
      "variableGroupForm(Order details (order_2))",
    ]);
  });

  it("offers nothing without forms", () => {
    expect(buildScenarioFormAnswerVariableFields(undefined, t)).toEqual([]);
  });
});

describe("buildScenarioPromptInputVariableFields", () => {
  it("marks a form's text field read as an input answer as legacy", () => {
    expect(
      buildScenarioPromptInputVariableFields([
        { key: "name", label: "Name", prompt: "Your name?" },
        { key: "sport", label: "Sport", prompt: "Sport", fromForm: true },
      ])
    ).toEqual([
      { token: "input.name", label: "Name", description: "Your name?" },
      {
        token: "input.sport",
        label: "Sport",
        description: "Sport",
        legacy: true,
      },
    ]);
  });
});

describe("buildScenarioVariableGroups", () => {
  const answers = [
    ...buildScenarioPromptInputVariableFields([
      { key: "city", label: "City", prompt: "Your city?" },
      { key: "sport", label: "Sport", prompt: "Sport", fromForm: true },
    ]),
    ...buildScenarioFormAnswerVariableFields(
      [contactForm, orderForm, medalForm],
      t
    ),
  ];

  it("puts collected details first, then one group per form, then the catalog", () => {
    const groups = buildScenarioVariableGroups(
      { extraFields: answers, excludeSources: [], answersOnly: false },
      t
    );
    expect(groups.slice(0, 4).map(group => [group.id, group.label])).toEqual([
      ["prompt_inputs", "variableGroupPromptInputs"],
      ["form:contact-step", "variableGroupForm(Contact details)"],
      ["form:order-step", "variableGroupForm(Order details)"],
      ["form:medal-step", "variableGroupForm(Medal pick)"],
    ]);
    expect(groups.slice(4).map(group => group.id)).toContain("contact");
    expect(groups[1]?.fields).toEqual([
      {
        token: "form.contact.name",
        label: "Name",
        description: "Your name",
        badge: undefined,
      },
      {
        token: "form.contact.email",
        label: "Email",
        description: "",
        badge: "variableFieldMayBeEmpty",
      },
    ]);
  });

  it("hides a form's text fields read as input answers", () => {
    const tokens = buildScenarioVariableGroups(
      { extraFields: answers, excludeSources: [], answersOnly: true },
      t
    ).flatMap(group => group.fields.map(field => field.token));
    expect(tokens).toEqual([
      "input.city",
      "form.contact.name",
      "form.contact.email",
      "form.order.size",
      "form.medal_pick",
    ]);
  });

  it("offers only the answers in answers-only mode, and nothing without them", () => {
    expect(
      buildScenarioVariableGroups(
        { extraFields: answers, excludeSources: [], answersOnly: true },
        t
      ).map(group => group.id)
    ).toEqual([
      "prompt_inputs",
      "form:contact-step",
      "form:order-step",
      "form:medal-step",
    ]);
    expect(
      buildScenarioVariableGroups(
        {
          extraFields: buildScenarioPromptInputVariableFields([
            { key: "sport", label: "Sport", prompt: "Sport", fromForm: true },
          ]),
          excludeSources: [],
          answersOnly: true,
        },
        t
      )
    ).toEqual([]);
  });

  it("keeps a form that lists no answer but leaves some out, with only its note", () => {
    const groups = buildScenarioVariableGroups(
      {
        extraFields: buildScenarioFormAnswerVariableFields(
          [{ ...orderForm, fields: [], partial: true }],
          t
        ),
        excludeSources: [],
        answersOnly: true,
      },
      t
    );
    // A note row is one the menu never inserts.
    expect(groups).toEqual([
      {
        id: "form:order-step",
        label: "variableGroupForm(Order details)",
        keywords: [],
        fields: [
          {
            token: "form.order",
            label: "variableFormFieldsPartial",
            description: "",
            note: true,
          },
        ],
      },
    ]);
  });

  it("leaves out excluded catalog groups and drops an empty collected group", () => {
    const ids = buildScenarioVariableGroups(
      { extraFields: [], excludeSources: ["picked"], answersOnly: false },
      t
    ).map(group => group.id);
    expect(ids).not.toContain("picked");
    expect(ids).not.toContain("prompt_inputs");
    expect(ids).toContain("contact");
  });
});
