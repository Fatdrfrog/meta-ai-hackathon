import assert from "node:assert/strict";
import { extractScenarioPromptInputs, parseScenarioPromptInputExtraction } from "./scenario-prompt-input-extraction";

let mockModelResponse: string | Error = "";
let mockPolicyDenied = false;
let mockProviderCalls = 0;
jest.mock("@/lib/ai", () => ({
  getLightTextModel: () => "test-model",
  getLightStructuredJsonGenerationConfig: () => ({}),
  chatCompletionWithFallback: async () => {
    mockProviderCalls += 1;
    if (mockModelResponse instanceof Error) throw mockModelResponse;
    return { content: mockModelResponse };
  },
}));
jest.mock("@/lib/ai/workspace-ai-policy", () => ({
  withWorkspaceTextAiAction: async (_params: unknown, run: () => Promise<unknown>) => {
    if (mockPolicyDenied) throw new Error("policy denied");
    return run();
  },
}));
jest.mock("@/lib/airi/reply/runtime/reply-logging", () => ({
  airiOrchestrationLogger: { warn: () => undefined },
}));

const fields = [{ key: "name", label: "Name", prompt: "customer name" }];
const params = { workspaceId: "test", fields, sourceText: "Amina", choices: [] };

describe("prompt input extraction response contract", () => {
  it("requires an own value for every requested key", () => {
    assert.throws(() => parseScenarioPromptInputExtraction("{}", fields));
    assert.throws(() => parseScenarioPromptInputExtraction("{}", [{ key: "constructor", label: "Name", prompt: "customer name" }]));
  });
  it("rejects non-string/non-null values instead of reporting missing details", () => {
    assert.throws(() => parseScenarioPromptInputExtraction('{"name":42}', fields));
    assert.throws(() => parseScenarioPromptInputExtraction('{"name":{}}', fields));
  });
  it("rejects unexpected response keys", () => {
    assert.throws(() => parseScenarioPromptInputExtraction('{"name":"Amina","other":"yes"}', fields));
  });
  it("accepts fenced JSON with an explicit missing detail", () => {
    assert.deepEqual(
      parseScenarioPromptInputExtraction('```json\n{"name":null}\n```', fields),
      { values: { name: null }, choiceOptionId: null }
    );
  });
  it("reads a named option only when options were offered, and only by its number", () => {
    const choices = [
      { id: "wsc:ask:gold", label: "Gold" },
      { id: "wsc:ask:silver", label: "Silver" },
    ];
    assert.throws(() =>
      parseScenarioPromptInputExtraction('{"name":"Amina","_option":1}', fields)
    );
    assert.equal(
      parseScenarioPromptInputExtraction(
        '{"name":"Amina","_option":"2"}',
        fields,
        choices
      ).choiceOptionId,
      "wsc:ask:silver"
    );
    for (const option of ["3", "0", "1.5", '"wsc:ask:gold"', "null", "true"]) {
      assert.equal(
        parseScenarioPromptInputExtraction(
          `{"name":"Amina","_option":${option}}`,
          fields,
          choices
        ).choiceOptionId,
        null,
        option
      );
    }
    // The option is optional; the details are not.
    assert.equal(
      parseScenarioPromptInputExtraction('{"name":"Amina"}', fields, choices)
        .choiceOptionId,
      null
    );
    assert.throws(() =>
      parseScenarioPromptInputExtraction('{"_option":1}', fields, choices)
    );
  });
  it("returns unavailable on malformed schema or provider timeout", async () => {
    for (const response of ['{"name":42}', "not json", new Error("timeout")]) {
      mockModelResponse = response;
      assert.equal(await extractScenarioPromptInputs(params), null);
    }
  });
  it("does not call the provider when workspace policy denies extraction", async () => {
    mockPolicyDenied = true;
    mockProviderCalls = 0;
    try {
      assert.equal(await extractScenarioPromptInputs(params), null);
      assert.equal(mockProviderCalls, 0);
    } finally {
      mockPolicyDenied = false;
    }
  });
});
