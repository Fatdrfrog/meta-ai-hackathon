// Uses the real anthropic-config latch: a model-specific 403 must not move the
// other Claude tiers to Gemini for the rest of the runtime.
const mockGenerateVertexGeminiContentResponse = jest.fn();
const mockGenerateAnthropicText = jest.fn();
jest.mock("@/lib/llm-analytics/events", () => ({
  recordLlmTraceAnalyticsEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("./workspace-ai-policy", () => ({
  resolveWorkspaceTextAiBilling: () => Promise.resolve(null),
  hasWorkspaceTextAiAction: () => false,
}));
jest.mock("./embeddings", () => ({}));
jest.mock("./vertex-config", () => ({
  canUseVertexAI: () => true,
  markVertexUnavailableForRuntime: jest.fn(),
}));
jest.mock("./vertex-gemini-rest", () => {
  const actual = jest.requireActual("./vertex-gemini-rest");
  return {
    ...actual,
    generateVertexGeminiContentResponse: (...args: unknown[]) =>
      mockGenerateVertexGeminiContentResponse(...args),
  };
});
jest.mock("./anthropic-messages", () => {
  const actual = jest.requireActual("./anthropic-messages");
  return {
    ...actual,
    generateAnthropicText: (...args: unknown[]) =>
      mockGenerateAnthropicText(...args),
  };
});

import { PermissionDeniedError } from "@anthropic-ai/sdk";
import {
  canUseAnthropicAI,
  resetAnthropicRuntimeAvailabilityForTesting,
} from "./anthropic-config";
import {
  chatCompletionWithFallback,
  getDefaultAIChatProviderOrder,
} from "./index";

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AI_ENABLED",
  "AI_CHAT_PROVIDER_ORDER",
  "ANTHROPIC_LIGHT_MODEL",
  "ANTHROPIC_HEAVY_MODEL",
  "ANTHROPIC_REASONING_MODEL",
] as const;

describe("chatCompletionWithFallback after a model-specific Claude 403", () => {
  const previous = Object.fromEntries(
    ENV_KEYS.map(key => [key, process.env[key]])
  );

  beforeEach(() => {
    jest.clearAllMocks();
    resetAnthropicRuntimeAvailabilityForTesting();
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockGenerateVertexGeminiContentResponse.mockResolvedValue({
      text: "Gemini answer",
      finishReason: "STOP",
    });
    mockGenerateAnthropicText.mockImplementation(
      async (request: { model: string }) => {
        if (/^claude-opus-/.test(request.model)) {
          throw new PermissionDeniedError(
            403,
            {
              type: "error",
              error: {
                type: "permission_error",
                message:
                  "Access to this model requires an access grant your request does not have.",
              },
            },
            undefined,
            new Headers()
          );
        }
        return {
          text: "Claude answer",
          finishReason: "end_turn",
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          servedModel: request.model,
        };
      }
    );
  });

  afterAll(() => {
    resetAnthropicRuntimeAvailabilityForTesting();
    for (const key of ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("falls back for the Opus call only and keeps Haiku and Sonnet on Claude", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const opus = await chatCompletionWithFallback({
        model: "claude-opus-5-5",
        messages: [{ role: "user", content: "Plan" }],
        resilience: { maxRetries: 0, disableInternalFallbacks: true },
      });
      expect(opus.provider).toBe("vertex");

      expect(canUseAnthropicAI()).toBe(true);
      expect(getDefaultAIChatProviderOrder()).toEqual(["anthropic", "vertex"]);

      for (const model of ["claude-haiku-4-5", "claude-sonnet-5-5"]) {
        const result = await chatCompletionWithFallback({
          model,
          messages: [{ role: "user", content: "Hello" }],
          resilience: { maxRetries: 0, disableInternalFallbacks: true },
        });
        expect(result).toMatchObject({
          provider: "anthropic",
          model,
          content: "Claude answer",
        });
      }
      expect(
        mockGenerateAnthropicText.mock.calls.map(([request]) => request.model)
      ).toEqual(["claude-opus-5-5", "claude-haiku-4-5", "claude-sonnet-5-5"]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("claude-opus-5-5");
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(
        "ANTHROPIC_API_KEY"
      );
    } finally {
      warn.mockRestore();
    }
  });
});
