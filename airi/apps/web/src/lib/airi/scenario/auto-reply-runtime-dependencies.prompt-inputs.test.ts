import assert from "node:assert/strict";
import {
  isScenarioPendingWriteCoordinationError,
  ScenarioPendingWriteCoordinationError,
  type PersistScenarioStateParams,
} from "@icecore/airi-runtime/scenario-runtime-dependencies";

let mockPersistError: unknown = null;
let mockPersistCalls: unknown[] = [];
jest.mock("@/lib/ai/workspace-ai-policy", () => ({
  withWorkspaceTextAiAction: async (_scope: unknown, run: () => Promise<unknown>) => run(),
}));
jest.mock("@/lib/temporal/airi-turn-execution", () => ({}));
jest.mock("./scenario-prompt-input-extraction", () => ({}));
jest.mock("./scenario-runtime", () => ({}));
jest.mock("./scenario-runtime-resources", () => ({}));
jest.mock("../reply/runtime/auto-reply-scenario-state", () => ({
  persistScenarioState: async (params: unknown) => {
    mockPersistCalls.push(params);
    if (mockPersistError !== null) throw mockPersistError;
  },
}));

import { scenarioRuntimeDependencies } from "./auto-reply-runtime-dependencies";

function params(awaitingReply: boolean, sourceActionNodeId = "ask"): PersistScenarioStateParams {
  return {
    conversationId: "conversation",
    messageId: "message",
    scenarioRuntime: { scenarioId: "scenario" } as PersistScenarioStateParams["scenarioRuntime"],
    baseState: {
      collectedPromptInputs: {
        scenarioId: "scenario", sourceActionNodeId, awaitingReply,
        resumeActionNodeId: "generate", sourcePathNodeIds: ["start", sourceActionNodeId],
        values: awaitingReply ? {} : { name: "Amina" },
      },
    },
  };
}

describe("prompt input persistence through the runtime host", () => {
  beforeEach(() => {
    mockPersistError = null;
    mockPersistCalls = [];
  });

  for (const [awaitingReply, source] of [[true, "ask"], [false, "ask"], [false, "flow"]] as const) {
    it(`makes a failed ${source} write (awaiting ${awaitingReply}) fatal before delivery`, async () => {
      const input = params(awaitingReply, source);
      const original = JSON.stringify(input);
      const failure = new Error("storage unavailable");
      mockPersistError = failure;
      await assert.rejects(scenarioRuntimeDependencies.persistScenarioState(input), error => {
        assert.ok(isScenarioPendingWriteCoordinationError(error));
        assert.equal(error.code, "conversation_write_failed");
        assert.equal(error.cause, failure);
        return true;
      });
      assert.equal(mockPersistCalls.length, 1);
      assert.equal(mockPersistCalls[0], input);
      assert.equal(JSON.stringify(input), original);
    });
  }

  it("keeps invalid over-capacity answer state failures fatal without masking the cause", async () => {
    const failure = new Error("storage unavailable");
    mockPersistError = failure;
    const input = params(false);
    const state = input.baseState as { collectedPromptInputs: { values: Record<string, string> } };
    state.collectedPromptInputs.values = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [`detail_${index}`, "answer"]),
    );
    await assert.rejects(scenarioRuntimeDependencies.persistScenarioState(input), error => {
      assert.ok(isScenarioPendingWriteCoordinationError(error));
      assert.equal(error.cause, failure);
      return true;
    });
  });

  it("preserves a successful write and does not send any extra writes", async () => {
    const input = params(false);
    await scenarioRuntimeDependencies.persistScenarioState(input);
    assert.deepEqual(mockPersistCalls, [input]);
  });

  it("preserves an existing coordination error, including its code", async () => {
    const failure = new ScenarioPendingWriteCoordinationError("conversation_state_changed", "changed");
    mockPersistError = failure;
    await assert.rejects(scenarioRuntimeDependencies.persistScenarioState(params(false)), error => error === failure);
  });

  it("does not change the error contract for scenarios without collected inputs", async () => {
    const failure = new Error("ordinary write failed");
    mockPersistError = failure;
    await assert.rejects(scenarioRuntimeDependencies.persistScenarioState({ ...params(false), baseState: {} }), error => error === failure);
  });

  it("does not apply an old scenario's durability scope to a new scenario", async () => {
    const failure = new Error("ordinary write failed");
    mockPersistError = failure;
    const input = params(false);
    input.scenarioRuntime = { ...input.scenarioRuntime, scenarioId: "other" };
    await assert.rejects(scenarioRuntimeDependencies.persistScenarioState(input), error => error === failure);
  });
});
