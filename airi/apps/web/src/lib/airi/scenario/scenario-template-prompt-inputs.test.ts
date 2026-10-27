import assert from "node:assert/strict";
import {
  isScenarioFormAnswerMissingError,
  isScenarioPromptInputMissingError,
  listUnsupportedScenarioTemplateTokens,
} from "@icecore/scenario-contracts";
import { applyScenarioReplyTemplate } from "./scenario-template";

type TemplateParams = Parameters<typeof applyScenarioReplyTemplate>[0];
const base = {
  channel: "whatsapp" as const,
  conversation: { _id: "private-conversation-id", chat: "customer-id" } as unknown as TemplateParams["conversation"],
  chatDocument: {} as TemplateParams["chatDocument"],
  promptInputs: { name: "Amina" },
};

describe("collected answer template safety", () => {
  it("never interprets tokens inside the customer's answer", () => {
    const answer = "{conversation.id} {{input.city}}";
    assert.equal(applyScenarioReplyTemplate({ ...base, reply: "Name: {{input.name}}", promptInputs: { name: answer } }), `Name: ${answer}`);
  });
  it("fails before sending a template with a missing valid input", () => {
    assert.throws(() => applyScenarioReplyTemplate({ ...base, reply: "Hello {{input.city}}" }), /SCENARIO_PROMPT_INPUT_MISSING/);
    assert.throws(
      () =>
        applyScenarioReplyTemplate({ ...base, reply: "Hello {{input.city}}" }),
      error =>
        isScenarioPromptInputMissingError(error) && error.token === "input.city"
    );
  });
  it("renders a missing answer empty in generated text instead of failing", () => {
    assert.equal(
      applyScenarioReplyTemplate({
        ...base,
        reply: "Thanks {{input.name}}, your {{input.city}} order is ready.",
        requirePromptInputs: false,
      }),
      "Thanks Amina, your  order is ready."
    );
  });
  it("keeps an empty model prompt empty instead of returning template syntax", () => {
    const reply = "{{customer.username}}";
    assert.equal(applyScenarioReplyTemplate({ ...base, reply }), reply);
    assert.equal(
      applyScenarioReplyTemplate({ ...base, reply, allowEmptyRender: true }),
      ""
    );
  });
  it("does not resolve constructor through the object prototype", () => {
    assert.throws(() => applyScenarioReplyTemplate({ ...base, reply: "Hello {input.constructor}" }), /SCENARIO_PROMPT_INPUT_MISSING/);
  });
  it("still resolves an own constructor answer", () => {
    assert.equal(applyScenarioReplyTemplate({ ...base, reply: "{{input.constructor}}", promptInputs: { constructor: "Amina" } }), "Amina");
  });
  it("renders a wrongly cased input name empty, and validation flags it", () => {
    const reply = "{{input.name}} / {{input.Name}} / {input.name}";
    // Resolution stays case-sensitive in both syntaxes, so sent text is unchanged.
    assert.equal(
      applyScenarioReplyTemplate({ ...base, reply }),
      "Amina /  / Amina"
    );
    // B4: the editor checks the same grammar, so the empty slot is not silent.
    assert.deepEqual(listUnsupportedScenarioTemplateTokens(reply), [
      "input.Name",
    ]);
  });
  it("does not change a plain reply", () => {
    assert.equal(applyScenarioReplyTemplate({ ...base, reply: "Hello!" }), "Hello!");
  });
});

describe("form answer template safety", () => {
  const formAnswers = { order: { size: "Large", notes: "{{input.name}} {form.order.size}" }, contact: {} };
  it("renders submitted answers once, never as tokens", () => {
    assert.equal(applyScenarioReplyTemplate({ ...base, reply: "{{form.order.size}}: {{form.order.notes}}", formAnswers }), "Large: {{input.name}} {form.order.size}");
  });
  it("never fails authored or generated text on a missing form answer", () => {
    for (const requirePromptInputs of [true, false]) {
      assert.equal(applyScenarioReplyTemplate({ ...base, reply: "Size {{form.billing.size}}.", formAnswers, requirePromptInputs }), "Size .");
    }
  });
  it("fails a generative prompt only for a form the customer never submitted", () => {
    const render = (reply: string) => applyScenarioReplyTemplate({ ...base, reply, formAnswers, requireFormAnswers: true, allowEmptyRender: true });
    assert.throws(() => render("Size {{form.billing.size}}"), error => isScenarioFormAnswerMissingError(error) && error.token === "form.billing.size");
    // A blank answer of a submitted form is empty, not missing.
    assert.equal(render("Name {{form.contact.name}}, size {{form.order.size}}"), "Name , size Large");
    // Collected details still fail closed there.
    assert.throws(() => render("{{input.city}}"), isScenarioPromptInputMissingError);
  });
  it("reads only answer keys, through own properties", () => {
    const forms = JSON.parse('{"Order":{"size":"x"},"order":{"Size":"y","__proto__":{"size":"z"}},"constructor":{"name":"w"}}');
    assert.equal(applyScenarioReplyTemplate({ ...base, reply: "[{{form.Order.size}}|{{form.order.Size}}|{{form.order.size}}|{{form.constructor.name}}]", formAnswers: forms }), "[|||w]");
  });
});
