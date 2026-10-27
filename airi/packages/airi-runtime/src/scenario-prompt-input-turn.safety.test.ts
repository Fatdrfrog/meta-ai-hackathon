import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readCollectedPromptInputs } from "@icecore/scenario-contracts";
import {
  planServiceMessagePromptInputTurn,
  type ScenarioPromptInputExtractor,
} from "./scenario-prompt-input-turn";
import type { AiriScenarioRuntimeConfig } from "./scenario-runtime-types";

const runtime: AiriScenarioRuntimeConfig = {
  scenarioId: "scenario", scenarioName: "Details", actionType: "reply",
  selectedActionNodeId: "ask", nextActionNodeId: "generate",
  selectedPathNodeIds: ["start", "ask"],
  actionWhatsAppServiceMessage: {
    version: 1,
    message: { kind: "text", body: { mode: "fixed", text: "Your name?" } },
    promptInputs: [{ key: "name", label: "Name", prompt: "customer name" }],
  },
  actionPromptInputsUnmetTransition: { nextActionNodeId: "repeat", completesScenario: false },
  includeConversationTimeline: false, includeConversationSummaries: false,
  includeSnippets: false, includeKBArticles: false, includeIndexedUrls: false,
  includeQuickReplies: false, includeCustomerProfile: false,
  includePurchaseHistory: false, includeActiveSubscriptions: false,
  includeDynamicBusinessTags: false,
};
const named = (name: string | null) => ({ values: { name }, choiceOptionId: null });
const waiting = (values: Record<string, string> = { city: "Astana" }) => ({
  currentActionNodeId: "ask",
  collectedPromptInputs: {
    scenarioId: "scenario", sourceActionNodeId: "ask", awaitingReply: true,
    resumeActionNodeId: "generate", sourcePathNodeIds: ["start", "ask"], values,
  },
});

describe("prompt-input runtime safety", () => {
  const failures: Array<[string, ScenarioPromptInputExtractor | undefined]> = [
    ["no extractor", undefined],
    ["unavailable result", async () => null],
    ["provider exception", async () => { throw new Error("provider timeout"); }],
  ];
  for (const [name, extract] of failures) {
    it(`holds instead of following the configured unmet edge on ${name}`, async () => {
      const plan = await planServiceMessagePromptInputTurn({ runtime, scenarioState: waiting(), sourceText: "Amina", extract });
      assert.equal(plan.type, "hold");
      if (plan.type !== "hold") return;
      assert.equal(plan.runtime.nextActionNodeId, "ask");
      assert.equal(plan.runtime.completesScenario, false);
      assert.equal(readCollectedPromptInputs(plan.scenarioState)?.awaitingReply, true);
      assert.deepEqual(readCollectedPromptInputs(plan.scenarioState)?.values, { city: "Astana" });
    });
  }
  it("holds for a reply with no usable text without making an extraction call", async () => {
    let calls = 0;
    const plan = await planServiceMessagePromptInputTurn({ runtime, scenarioState: waiting(), sourceText: " ", extract: async () => { calls += 1; return named("Amina"); } });
    assert.equal(plan.type, "hold");
    assert.equal(calls, 0);
  });
  it("uses the unmet edge only when extraction succeeded and a detail is missing", async () => {
    const plan = await planServiceMessagePromptInputTurn({ runtime, scenarioState: waiting(), sourceText: "Hello", extract: async () => named(null) });
    assert.equal(plan.type, "resume");
    if (plan.type === "resume") assert.equal(plan.scenarioState.currentActionNodeId, "repeat");
  });
  it("can collect the next reply after an unavailable extraction", async () => {
    const held = await planServiceMessagePromptInputTurn({ runtime, scenarioState: waiting(), sourceText: "Amina", extract: async () => null });
    assert.equal(held.type, "hold");
    if (held.type !== "hold") return;
    const resumed = await planServiceMessagePromptInputTurn({ runtime, scenarioState: held.scenarioState, sourceText: "Amina", extract: async () => named("Amina") });
    assert.equal(resumed.type, "resume");
    if (resumed.type === "resume") assert.equal(resumed.scenarioState.currentActionNodeId, "generate");
  });
  it("rejects capacity overflow without changing the waiting state or advancing", async () => {
    const values = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`old_${index}`, String(index)]));
    const state = waiting(values);
    await assert.rejects(planServiceMessagePromptInputTurn({ runtime, scenarioState: state, sourceText: "Amina", extract: async () => named("Amina") }), /SCENARIO_PROMPT_INPUT_CAPACITY_EXCEEDED/);
    assert.deepEqual(state, waiting(values));
    assert.equal(Object.hasOwn(state.collectedPromptInputs.values, "name"), false);
  });
  it("does not extract from timers or consume a trigger as an answer", async () => {
    let calls = 0;
    const extract = async () => { calls += 1; return named("Amina"); };
    const timer = await planServiceMessagePromptInputTurn({ runtime, scenarioState: waiting(), sourceText: "Amina", triggerEventKind: "no_human_reply_timeout", extract });
    const first = await planServiceMessagePromptInputTurn({ runtime, scenarioState: null, sourceText: "Amina", extract });
    assert.equal(timer.type, "hold");
    assert.equal(first.type, "wait");
    assert.equal(calls, 0);
  });
});
