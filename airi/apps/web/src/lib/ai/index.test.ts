const mockCanUseVertexAI = jest.fn();
const mockMarkVertexUnavailableForRuntime = jest.fn();
const mockGenerateVertexGeminiContentResponse = jest.fn();
const mockGetVertexChatModel = jest.fn();
const mockResolveBilling = jest.fn();
const mockHasWorkspaceAction = jest.fn();
const mockRecordLlmTraceAnalyticsEvent = jest.fn();
jest.mock("@/lib/llm-analytics/events", () => ({
  recordLlmTraceAnalyticsEvent: (...args: unknown[]) =>
    mockRecordLlmTraceAnalyticsEvent(...args),
}));
jest.mock("./workspace-ai-policy", () => ({
  resolveWorkspaceTextAiBilling: () => mockResolveBilling(),
  hasWorkspaceTextAiAction: () => mockHasWorkspaceAction(),
}));

jest.mock("./embeddings", () => ({}));
jest.mock("./vertex-config", () => ({
  canUseVertexAI: (...args: unknown[]) => mockCanUseVertexAI(...args),
  markVertexUnavailableForRuntime: (...args: unknown[]) =>
    mockMarkVertexUnavailableForRuntime(...args),
}));
jest.mock("./vertex-gemini-rest", () => {
  const actual = jest.requireActual("./vertex-gemini-rest");
  return {
    ...actual,
    generateVertexGeminiContentResponse: (...args: unknown[]) =>
      mockGenerateVertexGeminiContentResponse(...args),
    getVertexChatModel: (...args: unknown[]) => mockGetVertexChatModel(...args),
  };
});
const mockCanUseAnthropicAI = jest.fn();
const mockMarkAnthropicUnavailableForRuntime = jest.fn();
const mockGenerateAnthropicText = jest.fn();
jest.mock("./anthropic-config", () => ({
  canUseAnthropicAI: () => mockCanUseAnthropicAI(),
  markAnthropicUnavailableForRuntime: (...args: unknown[]) =>
    mockMarkAnthropicUnavailableForRuntime(...args),
}));
jest.mock("./anthropic-messages", () => {
  const actual = jest.requireActual("./anthropic-messages");
  return {
    ...actual,
    generateAnthropicText: (...args: unknown[]) =>
      mockGenerateAnthropicText(...args),
  };
});

import {
  AIChatProviderAggregateError,
  chatCompletionWithFallback,
  getDefaultAIChatProviderOrder,
  getStructuredJsonGenerationConfig,
} from "./index";
import { AnthropicEmptyContentError } from "./anthropic-messages";
import {
  configureTracingAdapter,
  type JsonRecord,
  type TraceRequest,
  type UsageMetadata,
} from "@/lib/observability/tracing";
import { VertexGeminiEmptyContentError } from "./vertex-gemini-rest";

describe("chatCompletionWithFallback", () => {
  it("inherits analytics ownership from admitted billing when optional analytics are absent", async () => {
    mockResolveBilling.mockResolvedValue({
      billingSource: "platform",
      workspaceId: "workspace-a",
      companyId: "company-a",
      actionId: "action-a",
      sourceId: null,
    });
    mockGenerateVertexGeminiContentResponse.mockResolvedValue({
      text: "answer",
      raw: { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 } },
    });
    await chatCompletionWithFallback({
      messages: [{ role: "user", content: "hello" }],
    });
    expect(mockRecordLlmTraceAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-a",
        companyId: "company-a",
        actionId: "action-a",
        billingSource: "platform",
      })
    );
  });
  it("rejects analytics ownership that differs from admitted billing before inference", async () => {
    mockResolveBilling.mockResolvedValue({
      billingSource: "platform",
      workspaceId: "workspace-a",
      companyId: "company-a",
      actionId: "action-a",
      sourceId: null,
    });
    await expect(
      chatCompletionWithFallback({
        messages: [{ role: "user", content: "hello" }],
        analytics: { workspaceId: "workspace-b" },
      })
    ).rejects.toThrow("workspace");
    expect(mockGenerateVertexGeminiContentResponse).not.toHaveBeenCalled();
  });
  const billedProviderResponse = {
    text: "private provider answer",
    finishReason: "STOP",
    raw: {
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 3,
        thoughtsTokenCount: 7,
        cachedContentTokenCount: 5,
        totalTokenCount: 20,
      },
      privateProviderPayload: "private provider payload",
    },
  };
  const billedUsage = {
    prompt_tokens: 10,
    completion_tokens: 3,
    thinking_tokens: 7,
    cached_prompt_tokens: 5,
    total_tokens: 20,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockCanUseVertexAI.mockReturnValue(true);
    mockCanUseAnthropicAI.mockReturnValue(false);
    mockResolveBilling.mockResolvedValue(null);
    mockHasWorkspaceAction.mockReturnValue(false);
    mockRecordLlmTraceAnalyticsEvent.mockResolvedValue(undefined);
    mockGetVertexChatModel.mockReturnValue("gemini-3.5-flash");
    mockGenerateVertexGeminiContentResponse.mockResolvedValue({
      text: '{"ok":true}',
      finishReason: "STOP",
    });
  });

  afterEach(() => {
    configureTracingAdapter(null);
  });

  it("does not spend a provider call after caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      chatCompletionWithFallback({
        messages: [{ role: "user", content: "hello" }],
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mockGenerateVertexGeminiContentResponse).not.toHaveBeenCalled();
  });

  it("forwards cancellation and never retries or changes models after cancellation", async () => {
    const controller = new AbortController();
    mockGenerateVertexGeminiContentResponse.mockImplementationOnce(async () => {
      controller.abort();
      throw Object.assign(new Error("temporary upstream error"), {
        status: 503,
      });
    });
    await expect(
      chatCompletionWithFallback({
        messages: [{ role: "user", content: "hello" }],
        signal: controller.signal,
        resilience: { maxRetries: 2, fallbackModels: ["gemini-fallback"] },
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mockGenerateVertexGeminiContentResponse).toHaveBeenCalledTimes(1);
    expect(
      mockGenerateVertexGeminiContentResponse.mock.calls[0][0].signal
    ).toBe(controller.signal);
    expect(mockMarkVertexUnavailableForRuntime).not.toHaveBeenCalled();
  });

  it("does not return a provider result that completed after cancellation", async () => {
    const controller = new AbortController();
    mockGenerateVertexGeminiContentResponse.mockImplementationOnce(async () => {
      controller.abort();
      return { text: "late result", finishReason: "STOP" };
    });
    await expect(
      chatCompletionWithFallback({
        messages: [{ role: "user", content: "hello" }],
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each(["vertex", "google"])(
    "accounts completed %s usage when cancellation precedes the provider return",
    async provider => {
      const controller = new AbortController();
      const lifecycle = jest.fn();
      if (provider === "google") {
        mockResolveBilling.mockResolvedValue({
          billingSource: "customer",
          apiKey: "private customer key",
        });
      }
      mockGenerateVertexGeminiContentResponse.mockImplementationOnce(
        async () => {
          controller.abort();
          return billedProviderResponse;
        }
      );
      await expect(
        chatCompletionWithFallback({
          messages: [{ role: "user", content: "private prompt" }],
          signal: controller.signal,
          analytics: {
            workspaceId: "workspace-a",
            metadata: { privateCallerMetadata: "private caller metadata" },
          },
          resilience: { maxRetries: 2, fallbackModels: ["gemini-fallback"] },
          onLifecycle: lifecycle,
        })
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(mockRecordLlmTraceAnalyticsEvent).toHaveBeenCalledTimes(1);
      expect(mockRecordLlmTraceAnalyticsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          provider,
          model: "gemini-3.5-flash",
          status: "cancelled",
          usage: billedUsage,
          finishReason: "STOP",
        })
      );
      const event = mockRecordLlmTraceAnalyticsEvent.mock.calls[0][0];
      expect(event.inputText).toBeUndefined();
      expect(event.outputText).toBeUndefined();
      expect(event.errorMessage).toBeUndefined();
      expect(JSON.stringify(event)).not.toContain("private");
      expect(lifecycle.mock.calls.map(([event]) => event.type)).toEqual([
        "attempt_start",
      ]);
      expect(mockGenerateVertexGeminiContentResponse).toHaveBeenCalledTimes(1);
      expect(mockMarkVertexUnavailableForRuntime).not.toHaveBeenCalled();
    }
  );

  it("accounts completed usage after cancellation during the success lifecycle callback", async () => {
    const controller = new AbortController();
    mockGenerateVertexGeminiContentResponse.mockResolvedValueOnce(
      billedProviderResponse
    );
    await expect(
      chatCompletionWithFallback({
        messages: [{ role: "user", content: "hello" }],
        signal: controller.signal,
        analytics: { workspaceId: "workspace-a" },
        onLifecycle: async event => {
          if (event.type === "attempt_success") controller.abort();
        },
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mockRecordLlmTraceAnalyticsEvent).toHaveBeenCalledTimes(1);
    expect(mockRecordLlmTraceAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled", usage: billedUsage })
    );
    expect(mockGenerateVertexGeminiContentResponse).toHaveBeenCalledTimes(1);
    expect(mockMarkVertexUnavailableForRuntime).not.toHaveBeenCalled();
  });

  it("does not return success after cancellation during the analytics trace write", async () => {
    const controller = new AbortController();
    mockGenerateVertexGeminiContentResponse.mockResolvedValueOnce(
      billedProviderResponse
    );
    mockRecordLlmTraceAnalyticsEvent.mockImplementationOnce(async () => {
      controller.abort();
    });
    await expect(
      chatCompletionWithFallback({
        messages: [{ role: "user", content: "hello" }],
        signal: controller.signal,
        analytics: { workspaceId: "workspace-a" },
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mockRecordLlmTraceAnalyticsEvent).toHaveBeenCalledTimes(1);
    expect(mockRecordLlmTraceAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ok", usage: billedUsage })
    );
    expect(mockGenerateVertexGeminiContentResponse).toHaveBeenCalledTimes(1);
    expect(mockMarkVertexUnavailableForRuntime).not.toHaveBeenCalled();
  });

  it("accounts normalized error usage after cancellation without exposing provider errors", async () => {
    const controller = new AbortController();
    mockResolveBilling.mockResolvedValue({
      billingSource: "customer",
      apiKey: "private customer key",
    });
    mockGenerateVertexGeminiContentResponse.mockImplementationOnce(async () => {
      controller.abort();
      throw Object.assign(new Error("private provider error"), {
        code: "google_text_provider_failed",
        status: 503,
        usage: { ...billedUsage, privateUsageField: "private usage" },
      });
    });
    const lifecycle = jest.fn();
    await expect(
      chatCompletionWithFallback({
        messages: [{ role: "user", content: "private prompt" }],
        signal: controller.signal,
        analytics: { workspaceId: "workspace-a" },
        resilience: { maxRetries: 2, fallbackModels: ["gemini-fallback"] },
        onLifecycle: lifecycle,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mockRecordLlmTraceAnalyticsEvent).toHaveBeenCalledTimes(1);
    const event = mockRecordLlmTraceAnalyticsEvent.mock.calls[0][0];
    expect(event).toMatchObject({ status: "cancelled", usage: billedUsage });
    expect(JSON.stringify(event)).not.toContain("private");
    expect(lifecycle.mock.calls.map(([event]) => event.type)).toEqual([
      "attempt_start",
    ]);
    expect(mockGenerateVertexGeminiContentResponse).toHaveBeenCalledTimes(1);
    expect(mockMarkVertexUnavailableForRuntime).not.toHaveBeenCalled();
  });

  it("does not return success after cancellation while the outer trace finishes", async () => {
    const controller = new AbortController();
    configureTracingAdapter({
      trace(request, execute) {
        const result = execute();
        if (request.operation === "chain" && result instanceof Promise) {
          void result.then(
            () => controller.abort(),
            () => {}
          );
        }
        return result;
      },
      mergeMetadata: jest.fn(),
      setUsage: jest.fn(),
    });
    await expect(
      chatCompletionWithFallback({
        messages: [{ role: "user", content: "hello" }],
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mockGenerateVertexGeminiContentResponse).toHaveBeenCalledTimes(1);
    expect(mockMarkVertexUnavailableForRuntime).not.toHaveBeenCalled();
  });

  it("reports customer Google billing in results, lifecycle and traces without exposing its key", async () => {
    mockResolveBilling.mockResolvedValue({
      billingSource: "customer",
      workspaceId: "workspace-a",
      sourceId: "source-a",
      apiKey: "customer-secret",
    });
    mockHasWorkspaceAction.mockReturnValue(true);
    mockCanUseVertexAI.mockReturnValue(false);
    const requests: TraceRequest[] = [];
    configureTracingAdapter({
      trace(request, execute) {
        requests.push(request);
        return execute();
      },
      mergeMetadata: jest.fn(),
      setUsage: jest.fn(),
    });
    const lifecycle = jest.fn();

    const result = await chatCompletionWithFallback({
      messages: [{ role: "user", content: "hello" }],
      providerOrder: ["vertex"],
      onLifecycle: lifecycle,
    });

    expect(result.provider).toBe("google");
    expect(lifecycle.mock.calls.map(([event]) => event.provider)).toEqual([
      "google",
      "google",
    ]);
    expect(requests[1]?.getMetadata?.()).toMatchObject({ provider: "google" });
    expect(
      JSON.stringify(
        requests.map(request => ({
          metadata: request.getMetadata?.(),
        }))
      )
    ).not.toContain("customer-secret");
  });

  it("retries customer transient errors with the same billing and never disables Vertex", async () => {
    mockResolveBilling.mockResolvedValue({
      billingSource: "customer",
      workspaceId: "workspace-a",
      sourceId: "source-a",
      apiKey: "customer-secret",
    });
    mockGenerateVertexGeminiContentResponse.mockRejectedValueOnce(
      Object.assign(new Error("Google AI request failed"), { status: 429 })
    );
    const result = await chatCompletionWithFallback({
      messages: [{ role: "user", content: "hello" }],
      resilience: { maxRetries: 1, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
    });
    expect(result.provider).toBe("google");
    expect(mockGenerateVertexGeminiContentResponse).toHaveBeenCalledTimes(2);
    expect(mockMarkVertexUnavailableForRuntime).not.toHaveBeenCalled();
  });

  it("propagates allowance rejection before a provider attempt", async () => {
    const denial = Object.assign(new Error("Own AI source required"), {
      code: "own_ai_source_required",
    });
    mockResolveBilling.mockRejectedValue(denial);
    await expect(
      chatCompletionWithFallback({
        messages: [{ role: "user", content: "hello" }],
      })
    ).rejects.toBe(denial);
    expect(mockGenerateVertexGeminiContentResponse).not.toHaveBeenCalled();
  });

  it("does not aggregate a source revocation discovered by the lower adapter", async () => {
    mockResolveBilling.mockResolvedValue({
      billingSource: "customer",
      apiKey: "secret",
    });
    const denial = Object.assign(new Error("Source required"), {
      code: "own_ai_source_required",
    });
    mockGenerateVertexGeminiContentResponse.mockRejectedValueOnce(denial);
    await expect(
      chatCompletionWithFallback({
        messages: [{ role: "user", content: "hello" }],
      })
    ).rejects.toBe(denial);
  });

  it("annotates the manual provider span with allowlisted model and token metadata", async () => {
    const requests: TraceRequest[] = [];
    const mergedMetadata: JsonRecord[] = [];
    const usage: Array<UsageMetadata | undefined> = [];
    configureTracingAdapter({
      trace(request, execute) {
        requests.push(request);
        return execute();
      },
      mergeMetadata(metadata) {
        mergedMetadata.push(metadata);
      },
      setUsage(value) {
        usage.push(value);
      },
    });
    mockGenerateVertexGeminiContentResponse.mockResolvedValue({
      text: "private answer",
      finishReason: "STOP",
      raw: {
        usageMetadata: {
          promptTokenCount: 7,
          candidatesTokenCount: 3,
          totalTokenCount: 10,
        },
      },
    });

    await chatCompletionWithFallback({
      messages: [{ role: "user", content: "private prompt" }],
    });

    expect(requests.map(request => request.operation)).toEqual([
      "chain",
      "llm",
    ]);
    expect(requests[1]?.getMetadata?.()).toEqual(
      expect.objectContaining({
        model: "gemini-3.5-flash",
        provider: "vertex",
      })
    );
    expect(mergedMetadata).toEqual([
      expect.objectContaining({
        fallback_index: 0,
        finish_reason: "STOP",
        model: "gemini-3.5-flash",
        outcome: "success",
        provider: "vertex",
        retry_count: 0,
      }),
    ]);
    expect(usage).toEqual([
      {
        input_tokens: 7,
        output_tokens: 3,
        total_tokens: 10,
      },
    ]);
    expect(JSON.stringify({ mergedMetadata, usage })).not.toContain(
      "private prompt"
    );
    expect(JSON.stringify({ mergedMetadata, usage })).not.toContain(
      "private answer"
    );
  });

  it("passes native session identity separately from provider metadata", async () => {
    const requests: TraceRequest[] = [];
    configureTracingAdapter({
      trace(request, execute) {
        requests.push(request);
        return execute();
      },
      mergeMetadata() {},
      setUsage() {},
    });

    await chatCompletionWithFallback({
      analytics: {
        conversationId: "conversation-1",
        messageId: "message-1",
        traceId: "workspace-1:conversation-1:message-1",
        workspaceId: "workspace-1",
      },
      messages: [{ role: "user", content: "private prompt" }],
    });

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.sessionIdentity).toEqual({
        conversationId: "conversation-1",
        workspaceId: "workspace-1",
      });
      expect(request.getMetadata?.()).not.toEqual(
        expect.objectContaining({
          conversation_id: expect.anything(),
          message_id: expect.anything(),
          trace_id: expect.anything(),
          workspace_id: expect.anything(),
        })
      );
    }
  });

  it("records thinking/cache usage for successful and empty-content attempts", async () => {
    const usage = {
      prompt_tokens: 1000,
      completion_tokens: 100,
      thinking_tokens: 200,
      cached_prompt_tokens: 800,
      total_tokens: 1300,
    };
    const setUsage = jest.fn();
    configureTracingAdapter({
      trace: (_request, execute) => execute(),
      mergeMetadata: jest.fn(),
      setUsage,
    });
    const raw = {
      usageMetadata: {
        promptTokenCount: 1000,
        candidatesTokenCount: 100,
        thoughtsTokenCount: 200,
        cachedContentTokenCount: 800,
        totalTokenCount: 1300,
      },
    };
    mockGenerateVertexGeminiContentResponse.mockResolvedValueOnce({
      text: "answer",
      finishReason: "STOP",
      raw,
    });
    const options = {
      model: "gemini-3.5-flash",
      messages: [{ role: "user" as const, content: "private prompt" }],
      analytics: { workspaceId: "workspace-a" },
      resilience: { maxRetries: 0, disableInternalFallbacks: true },
    };
    expect((await chatCompletionWithFallback(options)).usage).toEqual(usage);
    mockGenerateVertexGeminiContentResponse.mockRejectedValueOnce(
      new VertexGeminiEmptyContentError({ finishReason: "MAX_TOKENS", raw })
    );
    await expect(chatCompletionWithFallback(options)).rejects.toBeInstanceOf(
      AIChatProviderAggregateError
    );
    expect(
      mockRecordLlmTraceAnalyticsEvent.mock.calls.map(([event]) => ({
        status: event.status,
        usage: event.usage,
      }))
    ).toEqual([
      { status: "ok", usage },
      { status: "error", usage },
    ]);
    expect(setUsage.mock.calls.map(([value]) => value)).toEqual([
      {
        input_tokens: 1000,
        output_tokens: 100,
        total_tokens: 1300,
        input_token_details: { cached_tokens: 800 },
        output_token_details: { reasoning_tokens: 200 },
      },
      {
        input_tokens: 1000,
        output_tokens: 100,
        total_tokens: 1300,
        input_token_details: { cached_tokens: 800 },
        output_token_details: { reasoning_tokens: 200 },
      },
    ]);
  });

  it("retains only normalized counters from a sanitized customer provider failure", async () => {
    mockResolveBilling.mockResolvedValue({
      billingSource: "customer",
      apiKey: "private-key",
    });
    mockGenerateVertexGeminiContentResponse.mockRejectedValue(
      Object.assign(new Error("Google AI request failed"), {
        code: "google_text_provider_failed",
        usage: {
          prompt_tokens: 10,
          thinking_tokens: 20,
          cached_prompt_tokens: 5,
        },
      })
    );
    await expect(
      chatCompletionWithFallback({
        messages: [{ role: "user", content: "private prompt" }],
        analytics: { workspaceId: "workspace-a" },
        resilience: { maxRetries: 0, disableInternalFallbacks: true },
      })
    ).rejects.toBeInstanceOf(AIChatProviderAggregateError);
    expect(mockRecordLlmTraceAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        status: "error",
        usage: {
          prompt_tokens: 10,
          thinking_tokens: 20,
          cached_prompt_tokens: 5,
        },
      })
    );
  });

  it("adds model-aware structured JSON generation config for Gemini", async () => {
    const requests: TraceRequest[] = [];
    configureTracingAdapter({
      trace(request, execute) {
        requests.push(request);
        return execute();
      },
      mergeMetadata() {},
      setUsage() {},
    });

    await chatCompletionWithFallback({
      messages: [{ role: "user", content: "Return JSON." }],
      responseFormat: { type: "json_object" },
    });

    expect(mockGenerateVertexGeminiContentResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemini-3.5-flash",
        generationConfig: expect.objectContaining({
          responseMimeType: "application/json",
          thinkingConfig: { thinkingLevel: "MINIMAL" },
        }),
      })
    );
    expect(
      mockGenerateVertexGeminiContentResponse.mock.calls[0]?.[0]
        ?.generationConfig
    ).not.toHaveProperty("temperature");
    expect(requests[1]?.getMetadata?.()).not.toHaveProperty("temperature");
  });

  it("forwards the configured end-to-end request deadline", async () => {
    await chatCompletionWithFallback({
      messages: [{ role: "user", content: "Hello" }],
      resilience: { timeoutMs: 12_000 },
    });

    expect(mockGenerateVertexGeminiContentResponse).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    expect(
      mockGenerateVertexGeminiContentResponse.mock.calls[0]?.[0]?.timeoutMs
    ).toBeLessThanOrEqual(12_000);
    expect(
      mockGenerateVertexGeminiContentResponse.mock.calls[0]?.[0]?.timeoutMs
    ).toBeGreaterThan(0);
  });

  it("returns an actionable error when Vertex is unavailable before any provider attempt", async () => {
    mockCanUseVertexAI.mockReturnValue(false);

    await expect(
      chatCompletionWithFallback({
        messages: [{ role: "user", content: "Hello" }],
      })
    ).rejects.toThrow(
      /AI text provider is unavailable in this runtime. Set ANTHROPIC_API_KEY/
    );

    expect(mockGenerateVertexGeminiContentResponse).not.toHaveBeenCalled();
  });

  it("retries transient Vertex capacity errors before returning a result", async () => {
    const quotaError = new Error(
      'Vertex Gemini HTTP 429: { "error": { "status": "RESOURCE_EXHAUSTED" } }'
    );
    mockGenerateVertexGeminiContentResponse
      .mockRejectedValueOnce(quotaError)
      .mockResolvedValueOnce({
        text: "Recovered",
        finishReason: "STOP",
      });

    await expect(
      chatCompletionWithFallback({
        messages: [{ role: "user", content: "Hello" }],
        resilience: {
          maxRetries: 1,
          initialRetryDelayMs: 1,
          maxRetryDelayMs: 1,
        },
        trace: false,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        content: "Recovered",
        model: "gemini-3.5-flash",
      })
    );

    expect(mockGenerateVertexGeminiContentResponse).toHaveBeenCalledTimes(2);
    expect(mockMarkVertexUnavailableForRuntime).toHaveBeenCalledWith(
      quotaError,
      "AI"
    );
  });

  it("falls back to another model after the primary model is exhausted", async () => {
    mockGenerateVertexGeminiContentResponse
      .mockRejectedValueOnce(
        new Error(
          'Vertex Gemini HTTP 429: { "error": { "status": "RESOURCE_EXHAUSTED" } }'
        )
      )
      .mockResolvedValueOnce({
        text: "Fallback model answer",
        finishReason: "STOP",
      });

    await expect(
      chatCompletionWithFallback({
        model: "gemini-primary",
        messages: [{ role: "user", content: "Hello" }],
        resilience: {
          maxRetries: 0,
          fallbackModels: ["gemini-fallback"],
        },
        trace: false,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        content: "Fallback model answer",
        model: "gemini-fallback",
      })
    );

    expect(
      mockGenerateVertexGeminiContentResponse.mock.calls.map(
        call => call[0].model
      )
    ).toEqual(["gemini-primary", "gemini-fallback"]);
  });

  it("preserves the typed aggregate through the normal traced path", async () => {
    mockGenerateVertexGeminiContentResponse
      .mockRejectedValueOnce(
        Object.assign(new Error("Vertex HTTP 429 with raw payload"), {
          status: 429,
          raw: "must-not-survive",
        })
      )
      .mockRejectedValueOnce(
        new VertexGeminiEmptyContentError({
          finishReason: "SAFETY",
          promptBlockReason: null,
        })
      );

    let error: unknown;
    try {
      await chatCompletionWithFallback({
        model: "gemini-primary",
        messages: [{ role: "user", content: "Hello" }],
        resilience: {
          maxRetries: 1,
          initialRetryDelayMs: 1,
          maxRetryDelayMs: 1,
          disableInternalFallbacks: true,
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AIChatProviderAggregateError);
    if (!(error instanceof AIChatProviderAggregateError)) {
      throw new Error("Expected AIChatProviderAggregateError");
    }
    expect(error.message).toBe("AI chat provider attempts failed");
    expect(error.providerErrors).toHaveLength(2);
    expect(error.providerErrors[0]).toMatchObject({
      provider: "vertex",
      model: "gemini-primary",
      attempt: 1,
      fallbackIndex: 0,
      retryable: true,
      finishReason: null,
      promptBlockReason: null,
      httpStatus: 429,
    });
    expect(error.providerErrors[1]).toMatchObject({
      provider: "vertex",
      model: "gemini-primary",
      attempt: 2,
      fallbackIndex: 0,
      retryable: false,
      finishReason: "SAFETY",
      promptBlockReason: null,
    });
    expect(JSON.stringify(error.providerErrors)).not.toContain(
      "must-not-survive"
    );
    expect(
      error.providerErrors.map(component => Object.keys(component))
    ).toEqual([
      [
        "provider",
        "model",
        "attempt",
        "fallbackIndex",
        "retryable",
        "finishReason",
        "promptBlockReason",
        "httpStatus",
      ],
      [
        "provider",
        "model",
        "attempt",
        "fallbackIndex",
        "retryable",
        "finishReason",
        "promptBlockReason",
        "httpStatus",
      ],
    ]);
  });

  it("can disable explicit, configured, and default model fallbacks", async () => {
    const previousConfiguredFallbacks = process.env.AI_CHAT_FALLBACK_MODELS;
    process.env.AI_CHAT_FALLBACK_MODELS = "gemini-configured";
    mockGenerateVertexGeminiContentResponse.mockRejectedValue(
      Object.assign(new Error("Vertex HTTP 429"), { status: 429 })
    );

    try {
      await expect(
        chatCompletionWithFallback({
          model: "gemini-primary",
          messages: [{ role: "user", content: "Hello" }],
          resilience: {
            maxRetries: 0,
            fallbackModels: ["gemini-explicit"],
            disableInternalFallbacks: true,
          },
          trace: false,
        })
      ).rejects.toBeInstanceOf(AIChatProviderAggregateError);
    } finally {
      if (previousConfiguredFallbacks === undefined) {
        delete process.env.AI_CHAT_FALLBACK_MODELS;
      } else {
        process.env.AI_CHAT_FALLBACK_MODELS = previousConfiguredFallbacks;
      }
    }

    expect(
      mockGenerateVertexGeminiContentResponse.mock.calls.map(
        call => call[0].model
      )
    ).toEqual(["gemini-primary"]);
  });
});

describe("chatCompletionWithFallback provider order", () => {
  const claudeUsage = {
    prompt_tokens: 160,
    completion_tokens: 20,
    total_tokens: 180,
    cached_prompt_tokens: 50,
  };
  const previousEnv = {
    order: process.env.AI_CHAT_PROVIDER_ORDER,
    light: process.env.VERTEX_GEMINI_LIGHT_MODEL,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.AI_CHAT_PROVIDER_ORDER;
    process.env.VERTEX_GEMINI_LIGHT_MODEL = "gemini-light-test";
    mockCanUseVertexAI.mockReturnValue(true);
    mockCanUseAnthropicAI.mockReturnValue(true);
    mockResolveBilling.mockResolvedValue(null);
    mockHasWorkspaceAction.mockReturnValue(false);
    mockRecordLlmTraceAnalyticsEvent.mockResolvedValue(undefined);
    mockGetVertexChatModel.mockReturnValue("gemini-3.5-flash");
    mockGenerateAnthropicText.mockResolvedValue({
      text: "Claude answer",
      finishReason: "end_turn",
      usage: claudeUsage,
      servedModel: "claude-sonnet-5-5",
    });
    mockGenerateVertexGeminiContentResponse.mockResolvedValue({
      text: "Gemini answer",
      finishReason: "STOP",
    });
  });

  afterEach(() => {
    configureTracingAdapter(null);
  });

  afterAll(() => {
    for (const [name, value] of [
      ["AI_CHAT_PROVIDER_ORDER", previousEnv.order],
      ["VERTEX_GEMINI_LIGHT_MODEL", previousEnv.light],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("runs platform calls on Claude first with the heavy tier by default", async () => {
    const requests: TraceRequest[] = [];
    configureTracingAdapter({
      trace(request, execute) {
        requests.push(request);
        return execute();
      },
      mergeMetadata() {},
      setUsage() {},
    });
    const result = await chatCompletionWithFallback({
      messages: [
        { role: "system", content: "Rules" },
        { role: "user", content: "Hello" },
      ],
      temperature: 0.4,
      analytics: { workspaceId: "workspace-a" },
      resilience: { timeoutMs: 9_000 },
    });

    expect(result).toMatchObject({
      content: "Claude answer",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      finishReason: "end_turn",
      usage: claudeUsage,
    });
    expect(mockGenerateVertexGeminiContentResponse).not.toHaveBeenCalled();
    const [request, callbacks] = mockGenerateAnthropicText.mock.calls[0];
    expect(request).toMatchObject({
      model: "claude-sonnet-5-5",
      messages: [
        { role: "system", content: "Rules" },
        { role: "user", content: "Hello" },
      ],
      forceJson: false,
      generationConfig: { temperature: 0.4 },
    });
    expect(request.timeoutMs).toBeLessThanOrEqual(9_000);
    expect(callbacks).toBeUndefined();
    expect(requests.map(item => item.name)).toEqual([
      "ai.chat_completion",
      "anthropic.messages",
    ]);
    expect(requests[1]?.tags).toEqual(["ai", "llm", "anthropic"]);
    expect(requests[1]?.getMetadata?.()).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
    });
    // Sonnet 5.5 rejects sampling params, so no temperature is reported.
    expect(requests[1]?.getMetadata?.()).not.toHaveProperty("temperature");
    expect(mockRecordLlmTraceAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        status: "ok",
        usage: claudeUsage,
      })
    );
  });

  it("maps a Gemini light model to the Claude light tier and adds JSON config", async () => {
    await chatCompletionWithFallback({
      model: "gemini-light-test",
      messages: [{ role: "user", content: "Classify" }],
      responseFormat: { type: "json_object" },
      generationConfig: { maxOutputTokens: 64 },
    });
    expect(mockGenerateAnthropicText.mock.calls[0][0]).toMatchObject({
      model: "claude-haiku-4-5",
      forceJson: true,
      generationConfig: {
        thinkingConfig: { thinkingLevel: "LOW" },
        maxOutputTokens: 64,
      },
    });
    expect(
      mockGenerateAnthropicText.mock.calls[0][0].generationConfig
    ).not.toHaveProperty("responseMimeType");
  });

  it.each([
    [
      "retryable",
      Object.assign(new Error("529 overloaded_error"), { status: 529 }),
      true,
    ],
    [
      "non-retryable",
      Object.assign(new Error("400 invalid_request_error"), { status: 400 }),
      false,
    ],
  ])(
    "falls back to Vertex Gemini after a %s Claude failure",
    async (_label, error, retryable) => {
      mockGenerateAnthropicText.mockRejectedValue(error);
      const lifecycle = jest.fn();
      const result = await chatCompletionWithFallback({
        model: "claude-haiku-4-5",
        messages: [{ role: "user", content: "Hello" }],
        analytics: { workspaceId: "workspace-a" },
        resilience: {
          maxRetries: 0,
          disableInternalFallbacks: true,
        },
        onLifecycle: lifecycle,
      });
      expect(result).toMatchObject({
        provider: "vertex",
        model: "gemini-light-test",
        content: "Gemini answer",
      });
      expect(mockGenerateAnthropicText).toHaveBeenCalledTimes(1);
      expect(mockMarkAnthropicUnavailableForRuntime).toHaveBeenCalledWith(
        error,
        "AI",
        "claude-haiku-4-5"
      );
      expect(lifecycle.mock.calls.map(([event]) => event)).toEqual([
        expect.objectContaining({
          type: "attempt_start",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          fallbackIndex: 0,
        }),
        expect.objectContaining({
          type: "attempt_error",
          provider: "anthropic",
          retryable,
        }),
        {
          type: "model_fallback",
          provider: "vertex",
          fromModel: "claude-haiku-4-5",
          toModel: "gemini-light-test",
          fallbackIndex: 1,
        },
        expect.objectContaining({
          type: "attempt_start",
          provider: "vertex",
          model: "gemini-light-test",
          fallbackIndex: 1,
        }),
        expect.objectContaining({
          type: "attempt_success",
          provider: "vertex",
        }),
      ]);
      expect(
        mockRecordLlmTraceAnalyticsEvent.mock.calls.map(([event]) => [
          event.provider,
          event.status,
        ])
      ).toEqual([
        ["anthropic", "error"],
        ["vertex", "ok"],
      ]);
    }
  );

  it("retries Claude on transient failures before falling back", async () => {
    mockGenerateAnthropicText
      .mockRejectedValueOnce(new Error("Connection error."))
      .mockResolvedValueOnce({
        text: "Recovered",
        finishReason: "end_turn",
        servedModel: "claude-sonnet-5-5",
      });
    const result = await chatCompletionWithFallback({
      messages: [{ role: "user", content: "Hello" }],
      resilience: { maxRetries: 1, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
      trace: false,
    });
    expect(result).toMatchObject({
      provider: "anthropic",
      content: "Recovered",
    });
    expect(mockGenerateAnthropicText).toHaveBeenCalledTimes(2);
    expect(mockGenerateVertexGeminiContentResponse).not.toHaveBeenCalled();
  });

  it("aggregates failures from both providers with refusal details", async () => {
    mockGenerateAnthropicText.mockRejectedValue(
      new AnthropicEmptyContentError({
        finishReason: "refusal",
        usage: claudeUsage,
      })
    );
    mockGenerateVertexGeminiContentResponse.mockRejectedValue(
      Object.assign(new Error("Vertex HTTP 400"), { status: 400 })
    );
    let error: unknown;
    try {
      await chatCompletionWithFallback({
        messages: [{ role: "user", content: "Hello" }],
        analytics: { workspaceId: "workspace-a" },
        resilience: { maxRetries: 0, disableInternalFallbacks: true },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AIChatProviderAggregateError);
    expect((error as AIChatProviderAggregateError).providerErrors).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        finishReason: "refusal",
        retryable: false,
      }),
      expect.objectContaining({
        provider: "vertex",
        model: "gemini-3.5-flash",
        httpStatus: 400,
      }),
    ]);
    expect(mockRecordLlmTraceAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        status: "error",
        usage: claudeUsage,
        finishReason: "refusal",
      })
    );
  });

  it("keeps customer-billed calls on the customer Google key with Gemini models", async () => {
    mockResolveBilling.mockResolvedValue({
      billingSource: "customer",
      workspaceId: "workspace-a",
      sourceId: "source-a",
      apiKey: "customer-secret",
    });
    const result = await chatCompletionWithFallback({
      model: "claude-sonnet-5-5",
      messages: [{ role: "user", content: "Hello" }],
      providerOrder: ["anthropic", "vertex"],
    });
    expect(result).toMatchObject({
      provider: "google",
      model: "gemini-3.5-flash",
    });
    expect(mockGenerateAnthropicText).not.toHaveBeenCalled();
    expect(mockGenerateVertexGeminiContentResponse).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-3.5-flash" })
    );
  });

  it("honours AI_CHAT_PROVIDER_ORDER", async () => {
    process.env.AI_CHAT_PROVIDER_ORDER = " vertex , anthropic, bogus";
    expect(getDefaultAIChatProviderOrder()).toEqual(["vertex", "anthropic"]);
    const result = await chatCompletionWithFallback({
      model: "claude-sonnet-5-5",
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result).toMatchObject({
      provider: "vertex",
      model: "gemini-3.5-flash",
    });
    expect(mockGenerateAnthropicText).not.toHaveBeenCalled();
  });

  it("skips Claude when Anthropic is not configured", async () => {
    mockCanUseAnthropicAI.mockReturnValue(false);
    expect(getDefaultAIChatProviderOrder()).toEqual(["vertex"]);
    const result = await chatCompletionWithFallback({
      messages: [{ role: "user", content: "Hello" }],
      providerOrder: ["anthropic", "vertex"],
    });
    expect(result.provider).toBe("vertex");
    expect(mockGenerateAnthropicText).not.toHaveBeenCalled();
  });

  it("streams Claude deltas without retries", async () => {
    mockGenerateAnthropicText.mockImplementationOnce(
      async (
        _request: unknown,
        callbacks: { onDelta: (chunk: unknown) => Promise<void> }
      ) => {
        await callbacks.onDelta({ delta: " Hi", accumulated: " Hi" });
        throw Object.assign(new Error("529 overloaded"), { status: 529 });
      }
    );
    mockCanUseVertexAI.mockReturnValue(false);
    const onDelta = jest.fn();
    await expect(
      chatCompletionWithFallback({
        messages: [{ role: "user", content: "Hello" }],
        onDelta,
        resilience: { maxRetries: 3, disableInternalFallbacks: true },
      })
    ).rejects.toBeInstanceOf(AIChatProviderAggregateError);
    expect(onDelta).toHaveBeenCalledWith({ delta: " Hi", accumulated: " Hi" });
    expect(mockGenerateAnthropicText).toHaveBeenCalledTimes(1);
    expect(mockGenerateAnthropicText.mock.calls[0][1]).toEqual({
      onDelta: expect.any(Function),
    });
  });

  it("retries a streaming call until the first delta is delivered", async () => {
    mockGenerateAnthropicText
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error("529 overloaded"), { status: 529 });
      })
      .mockImplementationOnce(
        async (
          _request: unknown,
          callbacks: { onDelta: (chunk: unknown) => Promise<void> }
        ) => {
          await callbacks.onDelta({ delta: "Hi", accumulated: "Hi" });
          throw Object.assign(new Error("529 overloaded"), { status: 529 });
        }
      );
    mockCanUseVertexAI.mockReturnValue(false);
    mockCanUseAnthropicAI.mockReturnValue(true);
    const onDelta = jest.fn();
    await expect(
      chatCompletionWithFallback({
        messages: [{ role: "user", content: "Hello" }],
        onDelta,
        providerOrder: ["anthropic"],
        resilience: {
          maxRetries: 3,
          initialRetryDelayMs: 25,
          maxRetryDelayMs: 25,
          disableInternalFallbacks: true,
        },
      })
    ).rejects.toBeInstanceOf(AIChatProviderAggregateError);
    // The pre-delta 529 is retried; the post-delta 529 is not.
    expect(mockGenerateAnthropicText).toHaveBeenCalledTimes(2);
    expect(onDelta).toHaveBeenCalledTimes(1);
  });

  it("returns a streamed answer after a retried pre-delta failure", async () => {
    mockGenerateAnthropicText
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error("429 rate limited"), { status: 429 });
      })
      .mockImplementationOnce(
        async (
          _request: unknown,
          callbacks: { onDelta: (chunk: unknown) => Promise<void> }
        ) => {
          await callbacks.onDelta({ delta: "Hi", accumulated: "Hi" });
          return { text: "Hi", finishReason: "end_turn" };
        }
      );
    mockCanUseVertexAI.mockReturnValue(false);
    mockCanUseAnthropicAI.mockReturnValue(true);
    const onDelta = jest.fn();
    const result = await chatCompletionWithFallback({
      messages: [{ role: "user", content: "Hello" }],
      onDelta,
      providerOrder: ["anthropic"],
      resilience: {
        maxRetries: 1,
        initialRetryDelayMs: 25,
        maxRetryDelayMs: 25,
        disableInternalFallbacks: true,
      },
    });
    expect(result.content).toBe("Hi");
    expect(onDelta).toHaveBeenCalledWith({ delta: "Hi", accumulated: "Hi" });
  });

  it("accounts completed Claude usage when cancellation precedes the return", async () => {
    const controller = new AbortController();
    mockGenerateAnthropicText.mockImplementationOnce(async () => {
      controller.abort();
      return {
        text: "private answer",
        finishReason: "end_turn",
        usage: claudeUsage,
        servedModel: "claude-sonnet-5-5",
      };
    });
    await expect(
      chatCompletionWithFallback({
        messages: [{ role: "user", content: "private prompt" }],
        signal: controller.signal,
        analytics: { workspaceId: "workspace-a" },
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mockRecordLlmTraceAnalyticsEvent).toHaveBeenCalledTimes(1);
    const event = mockRecordLlmTraceAnalyticsEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      provider: "anthropic",
      status: "cancelled",
      usage: claudeUsage,
    });
    expect(JSON.stringify(event)).not.toContain("private");
    expect(mockGenerateVertexGeminiContentResponse).not.toHaveBeenCalled();
  });

  it("caps a non-final provider at 65% of the call deadline so the fallback keeps the rest", async () => {
    mockGenerateAnthropicText.mockImplementation(
      async (request: { timeoutMs: number }) => {
        await new Promise(resolve => setTimeout(resolve, request.timeoutMs));
        throw Object.assign(new Error("Anthropic request timeout"), {
          name: "AnthropicTimeoutError",
        });
      }
    );
    const startedAt = Date.now();
    const result = await chatCompletionWithFallback({
      messages: [{ role: "user", content: "Hello" }],
      resilience: { timeoutMs: 1_000, disableInternalFallbacks: true },
      trace: false,
    });
    expect(result.provider).toBe("vertex");
    const anthropicTimeout =
      mockGenerateAnthropicText.mock.calls[0][0].timeoutMs;
    expect(anthropicTimeout).toBeLessThanOrEqual(650);
    expect(anthropicTimeout).toBeGreaterThan(550);
    // Claude used its whole budget; Gemini still gets the remaining >= 35%.
    expect(mockGenerateAnthropicText).toHaveBeenCalledTimes(1);
    const vertexTimeout =
      mockGenerateVertexGeminiContentResponse.mock.calls[0][0].timeoutMs;
    expect(vertexTimeout).toBeGreaterThan(250);
    expect(vertexTimeout).toBeLessThanOrEqual(
      1_000 - (Date.now() - startedAt) + 650
    );
  });

  it("gives the last usable provider the whole remaining deadline", async () => {
    mockCanUseVertexAI.mockReturnValue(false);
    await chatCompletionWithFallback({
      messages: [{ role: "user", content: "Hello" }],
      resilience: { timeoutMs: 10_000 },
      trace: false,
    });
    expect(
      mockGenerateAnthropicText.mock.calls[0][0].timeoutMs
    ).toBeGreaterThan(9_000);

    jest.clearAllMocks();
    mockCanUseVertexAI.mockReturnValue(true);
    mockGenerateAnthropicText.mockRejectedValueOnce(
      Object.assign(new Error("400 invalid_request_error"), { status: 400 })
    );
    await chatCompletionWithFallback({
      messages: [{ role: "user", content: "Hello" }],
      resilience: { timeoutMs: 10_000, disableInternalFallbacks: true },
      trace: false,
    });
    expect(
      mockGenerateAnthropicText.mock.calls[0][0].timeoutMs
    ).toBeLessThanOrEqual(6_500);
    // Claude failed fast, so the final provider gets nearly the whole call.
    expect(
      mockGenerateVertexGeminiContentResponse.mock.calls[0][0].timeoutMs
    ).toBeGreaterThan(9_000);
  });

  it("stops same-model retries at the provider budget", async () => {
    mockGenerateAnthropicText.mockImplementation(
      async (request: { timeoutMs: number }) => {
        await new Promise(resolve =>
          setTimeout(resolve, Math.min(request.timeoutMs, 200))
        );
        throw Object.assign(new Error("529 overloaded"), { status: 529 });
      }
    );
    const result = await chatCompletionWithFallback({
      messages: [{ role: "user", content: "Hello" }],
      resilience: {
        timeoutMs: 1_000,
        maxRetries: 10,
        initialRetryDelayMs: 25,
        maxRetryDelayMs: 25,
        disableInternalFallbacks: true,
      },
      trace: false,
    });
    expect(result.provider).toBe("vertex");
    for (const [request] of mockGenerateAnthropicText.mock.calls) {
      expect(request.timeoutMs).toBeLessThanOrEqual(650);
    }
    expect(mockGenerateAnthropicText.mock.calls.length).toBeLessThanOrEqual(4);
    expect(
      mockGenerateVertexGeminiContentResponse.mock.calls[0][0].timeoutMs
    ).toBeGreaterThan(250);
  });

  it("reports the server-side fallback model that served a Claude answer", async () => {
    mockGenerateAnthropicText.mockResolvedValueOnce({
      text: "Fallback answer",
      finishReason: "end_turn",
      usage: claudeUsage,
      servedModel: "claude-sonnet-5",
    });
    const lifecycle = jest.fn();
    const result = await chatCompletionWithFallback({
      messages: [{ role: "user", content: "Hello" }],
      analytics: { workspaceId: "workspace-a" },
      onLifecycle: lifecycle,
    });
    expect(result).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      content: "Fallback answer",
    });
    expect(mockGenerateAnthropicText.mock.calls[0][0].model).toBe(
      "claude-sonnet-5-5"
    );
    expect(mockRecordLlmTraceAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-sonnet-5",
        status: "ok",
        usage: claudeUsage,
      })
    );
    // Lifecycle events identify the attempt, which targeted the requested id.
    expect(lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "attempt_success",
        model: "claude-sonnet-5-5",
      })
    );
  });

  it("re-derives a tier-helper thinking config for a Gemini fallback attempt", async () => {
    process.env.VERTEX_GEMINI_LIGHT_MODEL = "gemini-3.5-flash";
    try {
      mockGenerateAnthropicText.mockRejectedValueOnce(
        Object.assign(new Error("400 invalid_request_error"), { status: 400 })
      );
      await chatCompletionWithFallback({
        model: "claude-haiku-4-5",
        messages: [{ role: "user", content: "Classify" }],
        responseFormat: { type: "json_object" },
        generationConfig: {
          ...getStructuredJsonGenerationConfig("claude-haiku-4-5"),
          maxOutputTokens: 64,
        },
        resilience: { maxRetries: 0, disableInternalFallbacks: true },
        trace: false,
      });
      expect(
        mockGenerateAnthropicText.mock.calls[0][0].generationConfig
      ).toMatchObject({
        thinkingConfig: { thinkingLevel: "LOW" },
        maxOutputTokens: 64,
      });
      expect(mockGenerateVertexGeminiContentResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gemini-3.5-flash",
          generationConfig: expect.objectContaining({
            thinkingConfig: { thinkingLevel: "MINIMAL" },
            maxOutputTokens: 64,
          }),
        })
      );
    } finally {
      process.env.VERTEX_GEMINI_LIGHT_MODEL = "gemini-light-test";
    }
  });

  it("drops a Claude tier thinking config on a Gemini model without one", async () => {
    mockGenerateAnthropicText.mockRejectedValueOnce(
      Object.assign(new Error("400 invalid_request_error"), { status: 400 })
    );
    await chatCompletionWithFallback({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "Classify" }],
      generationConfig: {
        ...getStructuredJsonGenerationConfig("claude-haiku-4-5"),
      },
      resilience: { maxRetries: 0, disableInternalFallbacks: true },
      trace: false,
    });
    const vertexRequest =
      mockGenerateVertexGeminiContentResponse.mock.calls[0][0];
    expect(vertexRequest.model).toBe("gemini-light-test");
    expect(vertexRequest.generationConfig ?? {}).not.toHaveProperty(
      "thinkingConfig"
    );
  });

  it("re-derives a Gemini tier thinking config for a Claude attempt", async () => {
    await chatCompletionWithFallback({
      model: "gemini-3.5-flash",
      messages: [{ role: "user", content: "Classify" }],
      generationConfig: {
        ...getStructuredJsonGenerationConfig("gemini-3.5-flash"),
      },
      trace: false,
    });
    expect(
      mockGenerateAnthropicText.mock.calls[0][0].generationConfig
    ).toMatchObject({ thinkingConfig: { thinkingLevel: "LOW" } });
  });

  it("leaves an explicitly chosen thinking config alone across families", async () => {
    mockGenerateAnthropicText.mockRejectedValueOnce(
      Object.assign(new Error("400 invalid_request_error"), { status: 400 })
    );
    await chatCompletionWithFallback({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "Plan" }],
      generationConfig: { thinkingConfig: { thinkingLevel: "HIGH" } },
      resilience: { maxRetries: 0, disableInternalFallbacks: true },
      trace: false,
    });
    expect(
      mockGenerateAnthropicText.mock.calls[0][0].generationConfig
    ).toMatchObject({ thinkingConfig: { thinkingLevel: "HIGH" } });
    expect(
      mockGenerateVertexGeminiContentResponse.mock.calls[0][0].generationConfig
    ).toMatchObject({ thinkingConfig: { thinkingLevel: "HIGH" } });
  });
});
