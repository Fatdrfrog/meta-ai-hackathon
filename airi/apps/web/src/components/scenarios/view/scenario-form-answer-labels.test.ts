import type { ScenarioFormAnswerChoice } from "./node-enrichment/scenario-node-graph-index";
import {
  buildScenarioFormAnswerSourceNames,
  buildScenarioFormAnswerTokenLabels,
  describeScenarioFormAnswerNotices,
  listScenarioFormAnswerChips,
} from "./scenario-form-answer-labels";

// Quotes and "and N more" read as the en copy does; other keys stay visible.
const t = (key: string, values?: Record<string, unknown>) => {
  if (key === "whatsappTemplateButtonQuoted") return `“${values?.label}”`;
  if (key === "formAnswersListMore") return `and ${values?.count} more`;
  return values ? `${key}(${JSON.stringify(values)})` : key;
};

function field(
  key: string,
  label: string,
  mayBeEmpty = false
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

const order: ScenarioFormAnswerChoice = {
  nodeId: "order",
  formKey: "order",
  formLabel: "Order",
  label: "Order details",
  availability: "always",
  schema: "known",
  fields: [field("size", "Size"), field("note", "Note", true)],
};

const contact: ScenarioFormAnswerChoice = {
  nodeId: "contact",
  formKey: "contact",
  formLabel: "Contact",
  label: "",
  availability: "some_paths",
  schema: "known",
  fields: [field("email", "Email", true)],
};

const linked: ScenarioFormAnswerChoice = {
  ...order,
  nodeId: "linked",
  formKey: "medal_pick_1",
  label: "Medal pick",
  schema: "unknown",
  fields: [],
};

describe("form answer chips", () => {
  it("names each answer with its form, by the step's name or else the Flow name", () => {
    expect(listScenarioFormAnswerChips([order, contact, linked])).toEqual([
      {
        token: "form.order.size",
        label: "Size · Order details",
        mayBeEmpty: false,
      },
      {
        token: "form.order.note",
        label: "Note · Order details",
        mayBeEmpty: true,
      },
      {
        token: "form.contact.email",
        label: "Email · Contact",
        mayBeEmpty: true,
      },
    ]);
    expect(
      buildScenarioFormAnswerTokenLabels([order]).get("form.order.size")
    ).toBe("Size · Order details");
    expect(listScenarioFormAnswerChips(undefined)).toEqual([]);
  });

  it("tells forms with the same name apart by their key", () => {
    const second = { ...order, nodeId: "order-2", formKey: "order_2" };
    expect(
      Object.fromEntries(
        buildScenarioFormAnswerSourceNames([order, second, contact])
      )
    ).toEqual({
      order: "Order details (order)",
      "order-2": "Order details (order_2)",
      contact: "Contact",
    });
    expect(
      listScenarioFormAnswerChips([order, second]).map(chip => chip.label)
    ).toEqual([
      "Size · Order details (order)",
      "Note · Order details (order)",
      "Size · Order details (order_2)",
      "Note · Order details (order_2)",
    ]);
  });
});

describe("describeScenarioFormAnswerNotices", () => {
  it("says nothing when every answer is always there", () => {
    expect(
      describeScenarioFormAnswerNotices(
        "Size {{form.order.size}} for {{input.name}}",
        [order],
        "ai_reply",
        t
      )
    ).toEqual({ unavailable: null, mayBeEmpty: null });
  });

  it("warns about answers no earlier form has, and says a Meta form's can't be used yet", () => {
    expect(
      describeScenarioFormAnswerNotices(
        "{{form.order.colour}} {{form.medal_pick_1.medal}} {{form.order.size}}",
        [order, linked],
        "generative",
        t
      ).unavailable
    ).toBe(
      [
        'formAnswersUnavailableNotice({"count":1,"tokens":"{{form.order.colour}}"})',
        'formAnswersMetaFormNotice({"formCount":1,"forms":"“Medal pick”","tokens":"{{form.medal_pick_1.medal}}"})',
      ].join(" ")
    );
  });

  it("lists at most three answers, then how many more", () => {
    expect(
      describeScenarioFormAnswerNotices(
        "{{form.gone.a}} {{form.gone.b}} {{form.gone.c}} {{form.gone.d}} {{form.gone.e}}",
        [order],
        "ai_reply",
        t
      ).unavailable
    ).toBe(
      'formAnswersUnavailableNotice({"count":5,"tokens":"{{form.gone.a}}, {{form.gone.b}}, {{form.gone.c}} and 2 more"})'
    );
  });

  it("tells AI writes which answers may be empty, grouped by form", () => {
    expect(
      describeScenarioFormAnswerNotices(
        "{{form.order.note}} {{form.contact.email}}",
        [order, contact],
        "ai_reply",
        t
      ).mayBeEmpty
    ).toBe(
      'formAnswersMayBeEmptyReply({"fields":"“Order details” (Note), “Contact” (Email)"})'
    );
    const survey: ScenarioFormAnswerChoice = {
      ...order,
      nodeId: "survey",
      formKey: "survey",
      label: "Survey",
      fields: ["a", "b", "c", "d", "e"].map(key => field(key, key, true)),
    };
    expect(
      describeScenarioFormAnswerNotices(
        "{{form.survey.a}} {{form.survey.b}} {{form.survey.c}} {{form.survey.d}} {{form.survey.e}}",
        [survey],
        "ai_reply",
        t
      ).mayBeEmpty
    ).toBe(
      'formAnswersMayBeEmptyReply({"fields":"“Survey” (a, b, c) and 2 more"})'
    );
  });

  it("tells an image or video step both that a skipped form makes it fail and what may be empty", () => {
    expect(
      describeScenarioFormAnswerNotices(
        "{{form.order.note}} {{form.contact.email}}",
        [order, contact],
        "generative",
        t
      ).mayBeEmpty
    ).toBe(
      [
        'formAnswersMaySkipForm({"forms":"“Contact”"})',
        'formAnswersMayBeEmpty({"fields":"“Order details” (Note)"})',
      ].join(" ")
    );
    expect(
      describeScenarioFormAnswerNotices(
        "{{form.order.note}}",
        [order],
        "generative",
        t
      ).mayBeEmpty
    ).toBe('formAnswersMayBeEmpty({"fields":"“Order details” (Note)"})');
  });
});
