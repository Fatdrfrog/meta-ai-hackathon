import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyScenarioPromptInputExtraction,
  buildFlowPromptInputInboundText,
  isScenarioPromptInputCapacityError,
  listScenarioFlowTextPromptInputs,
  mergePromptInputAnswersIntoScenarioState,
  normalizeCollectedPromptInputs,
  readFlowTextPromptInputAnswers,
  resolveServiceMessagePromptInputDispatch,
  type ScenarioPromptInputField,
} from "./scenario-prompt-inputs.ts";

const field = (key: string): ScenarioPromptInputField => ({ key, label: key, prompt: key });
const full = () => Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`old_${i}`, String(i)]));
const waiting = (values: Record<string, string> = {}) => ({
  scenarioId: "scenario", sourceActionNodeId: "ask", awaitingReply: true,
  resumeActionNodeId: "generate", sourcePathNodeIds: ["start", "ask"], values,
});
const dispatch = (extractedValues: Record<string, string | null> | null | undefined) => resolveServiceMessagePromptInputDispatch({
  config: { version: 1, message: { kind: "text", body: { mode: "fixed", text: "Name?" } }, promptInputs: [field("name")] },
  collection: waiting({ city: "Astana" }), scenarioId: "scenario", sourceActionNodeId: "ask",
  resumeActionNodeId: "generate", sourcePathNodeIds: ["start", "ask"], consumeInbound: true, extractedValues,
});

describe("prompt input safety", () => {
  it("does not count inherited constructor as a collected answer", () => {
    assert.deepEqual(applyScenarioPromptInputExtraction({ fields: [field("constructor")], priorValues: {}, extracted: null }), { values: {}, met: false, supplied: false });
  });
  it("accepts constructor when it is an own string answer", () => {
    const result = applyScenarioPromptInputExtraction({ fields: [field("constructor")], priorValues: {}, extracted: { constructor: "Amina" } });
    assert.equal(result.met, true);
    assert.equal(Object.hasOwn(result.values, "constructor"), true);
    assert.equal(result.values.constructor, "Amina");
  });
  it("ignores inherited extracted values", () => {
    const extracted = Object.create({ name: "not from customer" }) as Record<string, string>;
    assert.deepEqual(applyScenarioPromptInputExtraction({ fields: [field("name")], priorValues: {}, extracted }), { values: {}, met: false, supplied: false });
  });
  it("computes completeness after normalization", () => {
    const result = applyScenarioPromptInputExtraction({ fields: [field("name")], priorValues: { name: " \r\n " }, extracted: null });
    assert.deepEqual(result, { values: {}, met: false, supplied: false });
  });
  it("rejects overflow explicitly and leaves the prior state untouched", () => {
    const priorValues = full();
    assert.throws(() => applyScenarioPromptInputExtraction({ fields: [field("name")], priorValues, extracted: { name: "Amina" } }), /SCENARIO_PROMPT_INPUT_CAPACITY_EXCEEDED/);
    assert.deepEqual(priorValues, full());
  });
  it("can update an existing answer at capacity without eviction", () => {
    const result = applyScenarioPromptInputExtraction({ fields: [field("old_0")], priorValues: full(), extracted: { old_0: "updated" } });
    assert.equal(result.met, true);
    assert.equal(Object.keys(result.values).length, 24);
    assert.equal(result.values.old_0, "updated");
    assert.equal(result.values.old_23, "23");
  });
  it("rejects a Flow merge that would lose an answer at capacity", () => {
    const state = { collectedPromptInputs: waiting(full()) };
    assert.throws(() => mergePromptInputAnswersIntoScenarioState({ state, scenarioId: "scenario", sourceActionNodeId: "flow", sourcePathNodeIds: ["flow"], values: { name: "Amina" } }), /SCENARIO_PROMPT_INPUT_CAPACITY_EXCEEDED/);
    // The runtime recognizes it by code, logs it and keeps the turn going.
    assert.throws(() => mergePromptInputAnswersIntoScenarioState({ state, scenarioId: "scenario", sourceActionNodeId: "flow", sourcePathNodeIds: ["flow"], values: { name: "Amina" } }), isScenarioPromptInputCapacityError);
    assert.equal(isScenarioPromptInputCapacityError(Object.assign(new Error("copy"), { code: "SCENARIO_PROMPT_INPUT_CAPACITY_EXCEEDED" })), true);
    assert.equal(isScenarioPromptInputCapacityError(new Error("SCENARIO_PROMPT_INPUT_CAPACITY_EXCEEDED")), false);
    assert.deepEqual(state.collectedPromptInputs.values, full());
  });
  it("does not silently truncate an oversized persisted collection", () => {
    assert.throws(() => normalizeCollectedPromptInputs(waiting({ ...full(), name: "Amina" })), /SCENARIO_PROMPT_INPUT_CAPACITY_EXCEEDED/);
  });
  it("never silently hides the 25th declared Flow text field", () => {
    const fields = Array.from({ length: 25 }, (_, i) => ({ id: `answer_${i}`, label: `Answer ${i}`, fieldType: "TextInput" }));
    assert.equal(listScenarioFlowTextPromptInputs({ actionWhatsAppServiceMessage: { message: { kind: "flow", flowConfig: { screens: [{ fields }] } } } }).length, 25);
  });
  for (const result of [null, undefined]) {
    it(`silently holds on an unavailable extraction (${result})`, () => {
      const plan = dispatch(result);
      assert.equal(plan.type, "hold");
      if (plan.type !== "hold") return;
      assert.equal(plan.collection.awaitingReply, true);
      assert.deepEqual(plan.collection.values, { city: "Astana" });
      assert.equal(plan.collection.resumeActionNodeId, "generate");
    });
  }
  it("uses the unmet branch for a successful extraction with missing details", () => {
    const plan = dispatch({ name: null });
    assert.equal(plan.type, "unmet");
  });
  it("continues normally for a complete extraction", () => {
    const plan = dispatch({ name: " Amina " });
    assert.equal(plan.type, "met");
    if (plan.type !== "met") return;
    assert.deepEqual(plan.collection.values, { city: "Astana", name: "Amina" });
  });
  it("does not stringify inherited properties into a Flow prompt", () => {
    assert.equal(buildFlowPromptInputInboundText({ fields: [field("constructor")], values: {} }), "");
  });
  it("bounds and normalizes Flow answers without interpreting tokens", () => {
    assert.deepEqual(readFlowTextPromptInputAnswers({ fields: [field("name")], responseJson: JSON.stringify({ name: " \r\n{{input.city}}\r\n " }) }), { name: "{{input.city}}" });
    assert.equal(readFlowTextPromptInputAnswers({ fields: [field("name")], responseJson: JSON.stringify({ name: "a".repeat(2100) }) }).name?.length, 2000);
  });
  it("does not carry answers into a different scenario", () => {
    const state = mergePromptInputAnswersIntoScenarioState({ state: { collectedPromptInputs: waiting({ city: "old" }) }, scenarioId: "new", sourceActionNodeId: "flow", sourcePathNodeIds: ["flow"], values: { name: "Amina" } });
    assert.deepEqual((state?.collectedPromptInputs as { values: unknown }).values, { name: "Amina" });
  });
});
