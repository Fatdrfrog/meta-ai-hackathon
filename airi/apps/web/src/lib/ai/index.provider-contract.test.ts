/**
 * Contract test for the text facade's failure shape. Only the provider SDK
 * boundary is faked (`@anthropic-ai/sdk` client and `@google/genai` client);
 * the SDKs' own error classes and every `lib/ai` module stay real, so a
 * change in how the facade aggregates or classifies provider failures breaks
 * here instead of in callers that mock the classifier.
 */
const mockAnthropicCreate = jest.fn();
const mockAnthropicStream = jest.fn();
const mockGeminiGenerateContent = jest.fn();
const mockGeminiGenerateContentStream = jest.fn();
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    rpc: async (name: string, args: Record<string, unknown>) => ({
      error: null,
      data:
        name === "admit_workspace_text_ai_action"
          ? {
              workspace_id: args.p_workspace_id,
              company_id: "company-contract",
              plan: "pro",
              billing_source: "platform",
              source_id: null,
              allowance_period: "lifetime",
              reset_at: null,
            }
          : name === "reserve_workspace_ai_spend"
            ? {
                code: "reserved",
                workspace_id: args.p_workspace_id,
                action_id: args.p_action_id,
                operation_id: args.p_operation_id,
                max_cost_micros: args.p_max_cost_micros,
              }
            : {
                code:
                  args.p_actual_cost_micros === null ? "uncertain" : "settled",
              },
    }),
  },
}));

jest.mock("@anthropic-ai/sdk", () => {
  const actual = jest.requireActual("@anthropic-ai/sdk");
  class MockAnthropic {
    messages = {
      create: (...args: unknown[]) => mockAnthropicCreate(...args),
      stream: (...args: unknown[]) => mockAnthropicStream(...args),
    };
    // Sonnet/Opus 5.5 go through the server-side-fallback beta endpoint.
    beta = {
      messages: {
        create: (...args: unknown[]) => mockAnthropicCreate(...args),
        stream: (...args: unknown[]) => mockAnthropicStream(...args),
      },
    };
  }
  return { ...actual, __esModule: true, default: MockAnthropic };
});

jest.mock("@google/genai", () => {
  const actual = jest.requireActual("@google/genai");
  return {
    ...actual,
    GoogleGenAI: function MockGoogleGenAI() {
      return {
        models: {
          generateContent: (...args: unknown[]) =>
            mockGeminiGenerateContent(...args),
          generateContentStream: (...args: unknown[]) =>
            mockGeminiGenerateContentStream(...args),
        },
      };
    },
  };
});

import { APIError } from "@anthropic-ai/sdk";
import { ApiError as GeminiApiError } from "@google/genai";

type Facade = typeof import("./index");

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AI_ENABLED",
  "ANTHROPIC_WORKSPACE_ID",
  "ANTHROPIC_LIGHT_MODEL",
  "ANTHROPIC_HEAVY_MODEL",
  "ANTHROPIC_REASONING_MODEL",
  "AI_CHAT_PROVIDER_ORDER",
  "AI_CHAT_FALLBACK_MODELS",
  "AI_CHAT_MAX_RETRIES",
  "VERTEX_FALLBACK_MODEL",
  "VERTEX_AI_ENABLED",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "GCP_PROJECT",
  "LLM_ANALYTICS_EVENTS_ENABLED",
] as const;

const previousEnv = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]])
);

// A provider body that must never reach the aggregate (prompt echo, ids).
const RAW_BODY_SENTINEL = "raw-provider-body-sentinel";

function claudeError(status: number, type: string): APIError {
  return APIError.generate(
    status,
    {
      type: "error",
      error: { type, message: `${type} ${RAW_BODY_SENTINEL}` },
    },
    undefined,
    new Headers({ "request-id": "req_contract" })
  );
}

function geminiError(status: number, statusText: string): GeminiApiError {
  return new GeminiApiError({
    status,
    message: JSON.stringify({
      error: {
        code: status,
        message: `${statusText} ${RAW_BODY_SENTINEL}`,
        status: statusText,
      },
    }),
  });
}

const CLAUDE_OVERLOADED = () => claudeError(529, "overloaded_error");
const CLAUDE_INVALID = () => claudeError(400, "invalid_request_error");
const GEMINI_RATE_LIMITED = () => geminiError(429, "RESOURCE_EXHAUSTED");
const GEMINI_INVALID = () => geminiError(400, "INVALID_ARGUMENT");

const COMPONENT_KEYS = [
  "attempt",
  "fallbackIndex",
  "finishReason",
  "httpStatus",
  "model",
  "promptBlockReason",
  "provider",
  "retryable",
].sort();

function failingStream(error: unknown) {
  return {
    on() {
      return this;
    },
    finalMessage: () => Promise.reject(error),
  };
}

async function captureFailure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the facade call to fail");
}

describe("chatCompletionWithFallback provider failure contract", () => {
  let facade: Facade;
  let heavyModel: string;
  let warn: jest.SpyInstance;

  beforeAll(async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.ANTHROPIC_API_KEY = "contract-test-key";
    process.env.GOOGLE_CLOUD_PROJECT = "contract-test-project";
    // Admitted calls record per-attempt analytics and, outside a request,
    // await the gateway/Mongo outbox write. Keep this contract off that store.
    process.env.LLM_ANALYTICS_EVENTS_ENABLED = "false";
    // Vertex flags are read when the modules load, so import after the env.
    facade = await import("./index");
    heavyModel = (await import("./text-models")).getHeavyTextModel();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    (
      await import("./anthropic-config")
    ).resetAnthropicRuntimeAvailabilityForTesting();
    (await import("./anthropic-messages")).resetAnthropicClientForTesting();
  });

  afterEach(() => {
    warn.mockRestore();
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function callFacade(
    overrides: Partial<Parameters<Facade["chatCompletionWithFallback"]>[0]> = {}
  ) {
    const { withWorkspaceTextAiAction } = await import("./workspace-ai-policy");
    return withWorkspaceTextAiAction(
      { workspaceId: "workspace-contract", actionId: "provider-contract" },
      () =>
        facade.chatCompletionWithFallback({
          model: heavyModel,
          messages: [
            { role: "user", content: "Summarize last week's campaign" },
          ],
          resilience: {
            maxRetries: 1,
            initialRetryDelayMs: 25,
            maxRetryDelayMs: 25,
          },
          ...overrides,
        })
    );
  }

  function attemptedModels() {
    return {
      claude: mockAnthropicCreate.mock.calls.map(([params]) => params.model),
      gemini: mockGeminiGenerateContent.mock.calls.map(
        ([params]) => params.model
      ),
    };
  }

  it("aggregates Claude 529 then Gemini 429 into a retryable typed error", async () => {
    mockAnthropicCreate.mockRejectedValue(CLAUDE_OVERLOADED());
    mockGeminiGenerateContent.mockRejectedValue(GEMINI_RATE_LIMITED());

    const error = await captureFailure(() => callFacade());

    expect(error).toBeInstanceOf(facade.AIChatProviderAggregateError);
    const aggregate = error as InstanceType<
      Facade["AIChatProviderAggregateError"]
    >;
    expect(aggregate).toMatchObject({
      name: "AIChatProviderAggregateError",
      code: "ai_chat_provider_failed",
      message: "AI chat provider attempts failed",
    });

    const { claude, gemini } = attemptedModels();
    // One retry per provider, then the outage fallback.
    expect(claude).toEqual([heavyModel, heavyModel]);
    expect(gemini).toHaveLength(2);
    expect(gemini[0]).toMatch(/^gemini-/);
    expect(gemini[1]).toBe(gemini[0]);

    expect(aggregate.providerErrors).toEqual([
      {
        provider: "anthropic",
        model: heavyModel,
        attempt: 1,
        fallbackIndex: 0,
        retryable: true,
        finishReason: null,
        promptBlockReason: null,
        httpStatus: 529,
      },
      {
        provider: "anthropic",
        model: heavyModel,
        attempt: 2,
        fallbackIndex: 0,
        retryable: true,
        finishReason: null,
        promptBlockReason: null,
        httpStatus: 529,
      },
      {
        provider: "vertex",
        model: gemini[0],
        attempt: 1,
        fallbackIndex: 1,
        retryable: true,
        finishReason: null,
        promptBlockReason: null,
        httpStatus: 429,
      },
      {
        provider: "vertex",
        model: gemini[0],
        attempt: 2,
        fallbackIndex: 1,
        retryable: true,
        finishReason: null,
        promptBlockReason: null,
        httpStatus: 429,
      },
    ]);
    expect(facade.isRetryableAIProviderError(aggregate)).toBe(true);
  });

  it("fails fast on non-retryable 400s from both providers", async () => {
    mockAnthropicCreate.mockRejectedValue(CLAUDE_INVALID());
    mockGeminiGenerateContent.mockRejectedValue(GEMINI_INVALID());

    const error = await captureFailure(() => callFacade());

    expect(error).toBeInstanceOf(facade.AIChatProviderAggregateError);
    const aggregate = error as InstanceType<
      Facade["AIChatProviderAggregateError"]
    >;
    // A rejection is never retried on the same provider.
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    expect(mockGeminiGenerateContent).toHaveBeenCalledTimes(1);
    expect(
      aggregate.providerErrors.map(component => ({
        provider: component.provider,
        attempt: component.attempt,
        retryable: component.retryable,
        httpStatus: component.httpStatus,
      }))
    ).toEqual([
      { provider: "anthropic", attempt: 1, retryable: false, httpStatus: 400 },
      { provider: "vertex", attempt: 1, retryable: false, httpStatus: 400 },
    ]);
    expect(facade.isRetryableAIProviderError(aggregate)).toBe(false);
  });

  it.each([
    {
      label: "Claude rejected and Gemini was rate limited",
      claude: CLAUDE_INVALID,
      gemini: GEMINI_RATE_LIMITED,
      claudeCalls: 1,
      geminiCalls: 2,
    },
    {
      label: "Claude was overloaded and Gemini rejected",
      claude: CLAUDE_OVERLOADED,
      gemini: GEMINI_INVALID,
      claudeCalls: 2,
      geminiCalls: 1,
    },
  ])(
    "stays retryable when $label",
    async ({ claude, gemini, claudeCalls, geminiCalls }) => {
      mockAnthropicCreate.mockRejectedValue(claude());
      mockGeminiGenerateContent.mockRejectedValue(gemini());

      const error = await captureFailure(() => callFacade());

      expect(error).toBeInstanceOf(facade.AIChatProviderAggregateError);
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(claudeCalls);
      expect(mockGeminiGenerateContent).toHaveBeenCalledTimes(geminiCalls);
      expect(facade.isRetryableAIProviderError(error)).toBe(true);
    }
  );

  it("keeps raw provider bodies out of the aggregate and freezes its components", async () => {
    mockAnthropicCreate.mockRejectedValue(CLAUDE_OVERLOADED());
    mockGeminiGenerateContent.mockRejectedValue(GEMINI_INVALID());

    const error = (await captureFailure(() =>
      callFacade({ resilience: { maxRetries: 0 } })
    )) as InstanceType<Facade["AIChatProviderAggregateError"]>;

    expect(error.message).not.toContain(RAW_BODY_SENTINEL);
    expect(JSON.stringify(error)).not.toContain(RAW_BODY_SENTINEL);
    expect(String(error.stack)).not.toContain(RAW_BODY_SENTINEL);
    expect(Object.isFrozen(error.providerErrors)).toBe(true);
    for (const component of error.providerErrors) {
      expect(Object.keys(component).sort()).toEqual(COMPONENT_KEYS);
      expect(Object.isFrozen(component)).toBe(true);
      expect(JSON.stringify(component)).not.toContain(RAW_BODY_SENTINEL);
    }
  });

  // Before any delta reaches the caller, a streaming call retries the same
  // model like a plain call (resilience.maxRetries = 1 here).
  it("aggregates streaming failures, retrying each provider before any delta", async () => {
    mockAnthropicStream.mockImplementation(() =>
      failingStream(CLAUDE_OVERLOADED())
    );
    mockGeminiGenerateContentStream.mockRejectedValue(GEMINI_RATE_LIMITED());
    const onDelta = jest.fn();

    const error = await captureFailure(() => callFacade({ onDelta }));

    expect(error).toBeInstanceOf(facade.AIChatProviderAggregateError);
    expect(mockAnthropicStream).toHaveBeenCalledTimes(2);
    expect(mockGeminiGenerateContentStream).toHaveBeenCalledTimes(2);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
    expect(mockGeminiGenerateContent).not.toHaveBeenCalled();
    expect(onDelta).not.toHaveBeenCalled();
    expect(
      (
        error as InstanceType<Facade["AIChatProviderAggregateError"]>
      ).providerErrors.map(component => [
        component.provider,
        component.attempt,
        component.httpStatus,
        component.retryable,
      ])
    ).toEqual([
      ["anthropic", 1, 529, true],
      ["anthropic", 2, 529, true],
      ["vertex", 1, 429, true],
      ["vertex", 2, 429, true],
    ]);
    expect(facade.isRetryableAIProviderError(error)).toBe(true);
  });

  it("answers from Gemini when Claude is overloaded, without an aggregate", async () => {
    mockAnthropicCreate.mockRejectedValue(CLAUDE_OVERLOADED());
    mockGeminiGenerateContent.mockResolvedValue({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Fallback answer" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 4,
        candidatesTokenCount: 2,
        totalTokenCount: 6,
      },
    });

    const result = await callFacade();

    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      provider: "vertex",
      content: "Fallback answer",
    });
    expect(result.model).toMatch(/^gemini-/);
  });
});
