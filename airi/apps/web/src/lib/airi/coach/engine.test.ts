const mockChat = jest.fn();
const mockGetHeavyTextModel = jest.fn(() => "claude-sonnet-5-5");
jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: (...args: unknown[]) => mockChat(...args),
  getHeavyTextModel: () => mockGetHeavyTextModel(),
}));
jest.mock("@/lib/ai/text-provider-config", () => ({
  canUseTextAI: () => true,
}));
jest.mock("@/lib/airi/conversation", () => ({
  hasGreetedToday: async () => false,
}));

import { estimateLlmCostUsd } from "@icecore/airi-runtime/llm-pricing";

import { SimpleCoachEngine } from "./engine";
import { COACH_RESPONSE_SCHEMA } from "./prompts";

beforeEach(() => {
  mockChat.mockReset();
  mockGetHeavyTextModel.mockClear();
});

it.each(["own_ai_source_required", "workspace_ai_policy_unavailable"])(
  "preserves %s for the coach UI",
  async code => {
    const denial = Object.assign(new Error("AI billing unavailable"), { code });
    mockChat.mockRejectedValue(denial);
    await expect(
      new SimpleCoachEngine().generate("Here is the price", {
        workspaceId: "w",
        conversationId: "c",
      })
    ).rejects.toBe(denial);
  }
);

const llmOutput = JSON.stringify({
  tips: [
    {
      title: "Name the delivery date",
      suggestion: "Tell the customer the exact delivery day.",
      type: "clarity",
      confidence: 0.82,
      reasoning: "The draft has no date.",
    },
  ],
  suggestedEdit: "Your order arrives on Friday; I will send tracking today.",
});

it("asks the heavy text tier with the coach schema and reports the serving provider", async () => {
  mockChat.mockResolvedValue({
    content: llmOutput,
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    latencyMs: 40,
    usage: {
      prompt_tokens: 2_000,
      completion_tokens: 300,
      total_tokens: 2_300,
      cached_prompt_tokens: 1_500,
    },
  });

  const result = await new SimpleCoachEngine().generate("It will come soon", {
    workspaceId: "w",
    conversationId: "c",
  });

  expect(mockGetHeavyTextModel).toHaveBeenCalledTimes(1);
  expect(mockChat).toHaveBeenCalledTimes(1);
  expect(mockChat.mock.calls[0][0]).toMatchObject({
    model: "claude-sonnet-5-5",
    responseFormat: { type: "json_object" },
    generationConfig: { responseSchema: COACH_RESPONSE_SCHEMA },
  });
  expect(result.tips[0]).toMatchObject({ title: "Name the delivery date" });
  expect(result.suggestedEdit).toContain("Friday");

  const cachedAware = estimateLlmCostUsd({
    model: "claude-sonnet-5-5",
    promptTokens: 2_000,
    completionTokens: 300,
    cachedPromptTokens: 1_500,
  }).totalCostUsd;
  const uncached = estimateLlmCostUsd({
    model: "claude-sonnet-5-5",
    promptTokens: 2_000,
    completionTokens: 300,
  }).totalCostUsd;
  expect(cachedAware).toBeLessThan(uncached);
  expect(result.inference).toEqual({
    model: "claude-sonnet-5-5",
    provider: "anthropic",
    latencyMs: 40,
    promptTokens: 2_000,
    completionTokens: 300,
    totalTokens: 2_300,
    estimatedCostUsd: cachedAware,
  });
});

it("reports the Gemini fallback model and provider when Vertex served the call", async () => {
  mockChat.mockResolvedValue({
    content: llmOutput,
    provider: "vertex",
    model: "gemini-3.5-flash",
    latencyMs: 55,
  });

  const result = await new SimpleCoachEngine().generate("It will come soon", {
    workspaceId: "w",
    conversationId: "c",
  });

  expect(result.inference).toMatchObject({
    model: "gemini-3.5-flash",
    provider: "vertex",
  });
});

it("returns heuristic tips without a provider when every provider fails", async () => {
  mockChat.mockRejectedValue(new Error("AI chat provider attempts failed"));

  const result = await new SimpleCoachEngine().generate("It will come soon", {
    workspaceId: "w",
    conversationId: "c",
  });

  expect(result.tips.length).toBeGreaterThan(0);
  expect(result.inference?.model).toBe("heuristic-fallback");
  expect(result.inference).not.toHaveProperty("provider");
});
