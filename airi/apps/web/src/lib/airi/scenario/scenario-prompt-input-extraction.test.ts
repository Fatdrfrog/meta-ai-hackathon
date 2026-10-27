import { chatCompletionWithFallback, getLightTextModel } from "@/lib/ai";
import { extractScenarioPromptInputs } from "./scenario-prompt-input-extraction";

jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: jest.fn(),
  getLightTextModel: () => "light-test-model",
  getLightStructuredJsonGenerationConfig: () => ({
    thinkingConfig: { thinkingLevel: "LOW" },
  }),
}));

jest.mock("@/lib/ai/workspace-ai-policy", () => ({
  withWorkspaceTextAiAction: (_params: unknown, run: () => Promise<unknown>) =>
    run(),
}));

jest.mock("@/lib/airi/reply/runtime/reply-logging", () => ({
  airiOrchestrationLogger: { warn: jest.fn() },
}));

const fields = [
  { key: "name", label: "Name", prompt: "the customer's name" },
  { key: "sport", label: "Sport", prompt: "the sport they play" },
];

describe("extractScenarioPromptInputs", () => {
  const complete = chatCompletionWithFallback as jest.MockedFunction<
    typeof chatCompletionWithFallback
  >;

  beforeEach(() => {
    complete.mockReset();
  });

  it("asks the cheap model to read text, audio, and video together", async () => {
    complete.mockResolvedValue({
      content: '{"name":"Amina","sport":null}',
      provider: "vertex",
      model: "light-test-model",
      latencyMs: 1,
    });

    await expect(
      extractScenarioPromptInputs({
        workspaceId: "workspace-1",
        fields,
        sourceText: "Text:\nhello\n\nAudio:\nI am Amina",
        choices: [],
      })
    ).resolves.toEqual({
      values: { name: "Amina", sport: null },
      choiceOptionId: null,
    });

    expect(getLightTextModel()).toBe("light-test-model");
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "light-test-model",
        temperature: 0,
        responseFormat: { type: "json_object" },
        generationConfig: { thinkingConfig: { thinkingLevel: "LOW" } },
        resilience: expect.objectContaining({
          disableInternalFallbacks: true,
        }),
      })
    );
    const messages = complete.mock.calls[0]?.[0].messages ?? [];
    const userMessage = messages.find(message => message.role === "user");
    expect(userMessage?.content).toContain(
      "- name (at most 2000 characters): the customer's name"
    );
    expect(userMessage?.content).toContain(
      JSON.stringify("Text:\nhello\n\nAudio:\nI am Amina")
    );
    expect(userMessage?.content).not.toContain("_option");
  });

  it("describes each detail's rules and the options the customer may name", async () => {
    complete.mockResolvedValue({
      content: '{"name":"Aya","sport":"Judo","_option":2}',
      provider: "vertex",
      model: "light-test-model",
      latencyMs: 1,
    });

    await expect(
      extractScenarioPromptInputs({
        workspaceId: "workspace-1",
        fields: [
          { ...fields[0]!, format: "name" },
          { ...fields[1]!, format: "choice", choices: ["Judo", "Boxing"] },
        ],
        sourceText: "Text:\nAya, judo, the silver one",
        choices: [
          {
            id: "wsc:ask:gold",
            label: "Choose",
            cardIndex: 0,
            cardBodyText: "Gold medal",
          },
          { id: "wsc:ask:silver", label: "Choose", cardIndex: 1 },
        ],
      })
    ).resolves.toEqual({
      values: { name: "Aya", sport: "Judo" },
      choiceOptionId: "wsc:ask:silver",
    });
    const messages = complete.mock.calls[0]?.[0].messages ?? [];
    const content = messages.find(message => message.role === "user")?.content;
    expect(content).toContain(
      "- name (a person's name, at most 40 characters): the customer's name"
    );
    expect(content).toContain("- sport (exactly one of: Judo, Boxing)");
    expect(content).toContain("1. Choose (card 1: Gold medal)");
    expect(content).toContain("2. Choose (card 2)");
  });

  it("returns no values when the model reply cannot be read", async () => {
    complete.mockResolvedValue({
      content: "not json",
      provider: "vertex",
      model: "light-test-model",
      latencyMs: 1,
    });

    await expect(
      extractScenarioPromptInputs({
        workspaceId: "workspace-1",
        fields,
        sourceText: "Amina plays judo",
        choices: [],
      })
    ).resolves.toBeNull();
  });
});
