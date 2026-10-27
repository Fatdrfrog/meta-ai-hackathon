import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_SCENARIO_PROMPT_INPUTS,
  listRunnableScenarioPromptInputs,
  readScenarioPromptInputDraft,
  validateScenarioPromptInputs,
} from "./scenario-prompt-inputs.ts";

const fields = (count: number) => Array.from({ length: count }, (_, index) => ({
  key: `detail_${index}`, label: "", prompt: `Requested detail ${index}`,
}));

const config = (value: unknown) => ({
  version: 1 as const,
  message: { kind: "text" as const, body: { mode: "fixed" as const, text: "Your details?" } },
  promptInputs: readScenarioPromptInputDraft(value),
});

describe("prompt input draft capacity", () => {
  it("does not turn seven configured details into a runnable six-detail ask", () => {
    const normalized = config(fields(MAX_SCENARIO_PROMPT_INPUTS + 1));
    assert.equal(listRunnableScenarioPromptInputs(normalized), null);
    assert.ok(
      validateScenarioPromptInputs({
        fields: normalized.promptInputs,
        message: normalized.message,
      }).some((item) => item.code === "prompt_input_count_invalid"),
    );
  });

  it("retains an overflow row so validation survives repeated normalization", () => {
    const first = readScenarioPromptInputDraft(fields(100));
    const second = readScenarioPromptInputDraft(first);
    assert.equal(first?.length, MAX_SCENARIO_PROMPT_INPUTS + 1);
    assert.deepEqual(second, first);
  });

  it("does not hide overflow behind skipped malformed entries", () => {
    assert.equal(listRunnableScenarioPromptInputs(config([null, "bad", ...fields(7)])), null);
  });

  it("keeps six valid details runnable without mutating the source", () => {
    const input = fields(6);
    const original = JSON.stringify(input);
    assert.equal(listRunnableScenarioPromptInputs(config(input))?.length, 6);
    assert.equal(JSON.stringify(input), original);
  });

  it("still preserves invalid draft rows for inline validation", () => {
    assert.deepEqual(readScenarioPromptInputDraft([null, { key: "Bad", prompt: "" }]), [
      { key: "Bad", label: "", prompt: "" },
    ]);
  });
});
