const mockGenerateContent = jest.fn();
const mockCustomerGenerateContent = jest.fn();
const mockCustomerGenerateContentStream = jest.fn();
const mockResolveBilling = jest.fn();
const mockGoogleGenAI = jest.fn();
const mockWarn = jest.fn();
const mockRecordLlmTraceAnalyticsEvent = jest.fn();
const mockReserveSpend = jest.fn(async (..._args: unknown[]) => null);
const mockSettleSpend = jest.fn(async (..._args: unknown[]) => undefined);

jest.mock("./embeddings", () => ({}));
jest.mock("@/lib/llm-analytics/events", () => ({
  recordLlmTraceAnalyticsEvent: (...args: unknown[]) =>
    mockRecordLlmTraceAnalyticsEvent(...args),
}));

jest.mock("./workspace-ai-policy", () => ({
  resolveWorkspaceTextAiBilling: () => mockResolveBilling(),
  hasWorkspaceTextAiAction: () => true,
  reserveWorkspaceTextAiSpend: (...args: unknown[]) =>
    mockReserveSpend(...args),
  settleWorkspaceTextAiSpend: (...args: unknown[]) => mockSettleSpend(...args),
}));
jest.mock("@google/genai", () => ({
  GoogleGenAI: function (options: unknown) {
    mockGoogleGenAI(options);
    return {
      models: {
        generateContent: mockCustomerGenerateContent,
        generateContentStream: mockCustomerGenerateContentStream,
      },
    };
  },
}));

jest.mock("@icecore/shared/lib/logger", () => ({
  createLogger: () => ({
    warn: (...args: unknown[]) => mockWarn(...args),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.mock("./vertex-config", () => ({
  canUseVertexAI: jest.fn(() => true),
  markVertexUnavailableForRuntime: jest.fn(),
}));

jest.mock("./vertex-env", () => ({
  getVertexGeminiLocation: jest.fn(() => "us-central1"),
}));

jest.mock("./vertex-genai-client", () => ({
  getVertexGenAI: jest.fn(async () => ({
    models: { generateContent: mockGenerateContent },
  })),
}));

import {
  VertexGeminiEmptyContentError,
  generateVertexGeminiContentResponse,
  streamVertexGeminiContentResponse,
  generateVertexGeminiContentOrThrow,
  extractVertexGeminiUsage,
  getVertexGeminiHeavyModel,
  getVertexGeminiLightModel,
  getVertexGeminiStructuredJsonGenerationConfig,
  normalizeVertexGeminiGenerationConfig,
  getVertexGeminiErrorUsage,
} from "./vertex-gemini-rest";
import { getVertexGenAI } from "./vertex-genai-client";
import { chatCompletionWithFallback } from "./index";
import {
  canUseVertexAI,
  markVertexUnavailableForRuntime,
} from "./vertex-config";

describe("Gemini model roles and billable usage", () => {
  afterEach(() => jest.restoreAllMocks());

  it("keeps the heavy override independent from the light role", () => {
    jest.replaceProperty(process, "env", {
      ...process.env,
      VERTEX_GEMINI_LIGHT_MODEL: "gemini-3.5-flash-lite",
      VERTEX_GEMINI_HEAVY_MODEL: "gemini-3.8-flash",
      VERTEX_FALLBACK_MODEL: "gemini-3.5-flash",
    });
    expect(getVertexGeminiLightModel()).toBe("gemini-3.5-flash-lite");
    expect(getVertexGeminiHeavyModel()).toBe("gemini-3.8-flash");
    delete process.env.VERTEX_GEMINI_HEAVY_MODEL;
    expect(getVertexGeminiHeavyModel()).toBe("gemini-3.5-flash");
    delete process.env.VERTEX_FALLBACK_MODEL;
    expect(getVertexGeminiHeavyModel()).toBe("gemini-3.5-flash");
  });

  it.each(["gemini-3.7-flash", "gemini-3.8-flash"])(
    "uses the supported low thinking level for %s",
    model => {
      expect(getVertexGeminiStructuredJsonGenerationConfig(model)).toEqual({
        thinkingConfig: { thinkingLevel: "LOW" },
      });
    }
  );

  it("keeps visible completion separate from thinking and cached input", () => {
    expect(
      extractVertexGeminiUsage({
        usageMetadata: {
          promptTokenCount: 1000,
          candidatesTokenCount: 100,
          thoughtsTokenCount: 200,
          cachedContentTokenCount: 800,
          totalTokenCount: 1300,
        },
      })
    ).toEqual({
      prompt_tokens: 1000,
      completion_tokens: 100,
      thinking_tokens: 200,
      cached_prompt_tokens: 800,
      total_tokens: 1300,
    });
  });

  it("preserves the output cap while adapting thinking for a fallback model", () => {
    expect(
      normalizeVertexGeminiGenerationConfig("gemini-3.8-flash", {
        maxOutputTokens: 1400,
        temperature: 0.2,
        thinkingConfig: { thinkingLevel: "MINIMAL" },
      })
    ).toEqual({
      maxOutputTokens: 1400,
      thinkingConfig: { thinkingLevel: "LOW" },
    });
  });

  it.each(["gemini-2.5-flash", "gemini-2.5-pro"])(
    "removes an incompatible carried thinking level for %s without losing valid budgets",
    model => {
      const config = {
        maxOutputTokens: 1400,
        temperature: 0.2,
        thinkingConfig: {
          thinkingLevel: "MINIMAL",
          thinkingBudget: 512,
          includeThoughts: true,
        },
      };
      expect(normalizeVertexGeminiGenerationConfig(model, config)).toEqual({
        maxOutputTokens: 1400,
        temperature: 0.2,
        thinkingConfig: { thinkingBudget: 512, includeThoughts: true },
      });
      expect(config.thinkingConfig.thinkingLevel).toBe("MINIMAL");
      expect(
        normalizeVertexGeminiGenerationConfig(model, {
          maxOutputTokens: 1400,
          thinkingConfig: { thinkingLevel: "MINIMAL" },
        })
      ).toEqual({ maxOutputTokens: 1400 });
    }
  );

  it.each(["gemini-2.0-flash", "gemini-2.0-flash-lite"])(
    "removes unsupported thinking config for %s without changing output or sampling",
    model => {
      const config = {
        maxOutputTokens: 512,
        temperature: 0.2,
        thinkingConfig: {
          thinkingLevel: "MINIMAL",
          thinkingBudget: 256,
          includeThoughts: true,
        },
      };
      expect(normalizeVertexGeminiGenerationConfig(model, config)).toEqual({
        maxOutputTokens: 512,
        temperature: 0.2,
      });
      expect(config.thinkingConfig).toEqual({
        thinkingLevel: "MINIMAL",
        thinkingBudget: 256,
        includeThoughts: true,
      });
    }
  );

  it("rejects invalid provider counters and bounds cached input by total input", () => {
    expect(
      extractVertexGeminiUsage({
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: -1,
          thoughtsTokenCount: NaN,
          cachedContentTokenCount: 50,
          totalTokenCount: 1.5,
        },
      })
    ).toEqual({ prompt_tokens: 10, cached_prompt_tokens: 10 });
  });
});

describe("Vertex Gemini empty-content errors", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveBilling.mockResolvedValue(null);
  });

  it("throws typed safety metadata without the raw response or provider prose", async () => {
    mockGenerateContent.mockResolvedValue({
      candidates: [
        {
          finishReason: "SAFETY",
          finishMessage: "raw provider prose must not survive",
          content: { parts: [] },
        },
      ],
      promptFeedback: {
        blockReason: "PROHIBITED_CONTENT",
        blockReasonMessage: "raw block prose must not survive",
      },
      rawSecret: "must-not-survive",
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 0,
        thoughtsTokenCount: 20,
        cachedContentTokenCount: 5,
        totalTokenCount: 30,
      },
    });

    const promise = generateVertexGeminiContentResponse({
      model: "gemini-test",
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });

    await expect(promise).rejects.toBeInstanceOf(VertexGeminiEmptyContentError);
    await expect(promise).rejects.toMatchObject({
      code: "vertex_gemini_empty_content",
      finishReason: "SAFETY",
      promptBlockReason: "PROHIBITED_CONTENT",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 0,
        thinking_tokens: 20,
        cached_prompt_tokens: 5,
        total_tokens: 30,
      },
    });
    const error = await promise.catch(value => value);
    expect(error).not.toHaveProperty("raw");
    expect(error).not.toHaveProperty("finishMessage");
    expect(error).not.toHaveProperty("promptBlockReasonMessage");
    expect(JSON.stringify(error)).not.toContain("must-not-survive");
  });

  it("bounds both structured reason fields", async () => {
    mockGenerateContent.mockResolvedValue({
      candidates: [
        {
          finishReason: `SAFETY-${"x".repeat(300)}`,
          content: { parts: [] },
        },
      ],
      promptFeedback: {
        blockReason: `PROHIBITED-${"y".repeat(300)}`,
      },
    });

    let error: unknown;
    try {
      await generateVertexGeminiContentResponse({
        model: "gemini-test",
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(VertexGeminiEmptyContentError);
    if (!(error instanceof VertexGeminiEmptyContentError)) {
      throw new Error("Expected VertexGeminiEmptyContentError");
    }
    expect(error.finishReason?.length).toBeLessThanOrEqual(64);
    expect(error.promptBlockReason?.length).toBeLessThanOrEqual(64);
    expect(error.message.length).toBeLessThanOrEqual(240);
  });
});

describe("workspace customer Google text inference", () => {
  const request = {
    model: "gemini-3.5-flash",
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
    generationConfig: {
      responseMimeType: "application/json",
      maxOutputTokens: 900,
    },
    timeoutMs: 5000,
  };
  const customer = {
    billingSource: "customer",
    workspaceId: "workspace-a",
    sourceId: "source-a",
    apiKey: "customer-secret-a",
  };
  const response = (text: string) => ({
    candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveBilling.mockResolvedValue(customer);
    mockGenerateContent.mockResolvedValue(response("platform response"));
    mockCustomerGenerateContent.mockResolvedValue(response('{"ok":true}'));
    mockRecordLlmTraceAnalyticsEvent.mockResolvedValue(true);
    jest.mocked(canUseVertexAI).mockReturnValue(true);
  });

  it("bounds system instructions and schemas and refuses multiple platform candidates", async () => {
    mockResolveBilling.mockResolvedValue({ billingSource: "platform" });
    const generationConfig = {
      systemInstruction: "private system",
      responseSchema: { type: "string" },
      candidateCount: 1,
    };
    await generateVertexGeminiContentResponse({ ...request, generationConfig });
    expect(mockReserveSpend).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          contents: request.contents,
          generationConfig: expect.objectContaining(generationConfig),
        }),
      })
    );
    mockGenerateContent.mockClear();
    await expect(
      generateVertexGeminiContentResponse({
        ...request,
        generationConfig: { candidateCount: 2 },
      })
    ).rejects.toMatchObject({ code: "workspace_ai_spend_limit" });
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("disables hidden SDK retries so each facade attempt is separately admitted", async () => {
    await generateVertexGeminiContentResponse({
      ...request,
      timeoutMs: undefined,
      generationConfig: { httpOptions: { retryOptions: { attempts: 5 } } },
    });
    expect(
      mockCustomerGenerateContent.mock.calls[0][0].config.httpOptions
        .retryOptions.attempts
    ).toBe(1);
  });

  it("removes Gemini 3 thinking levels before a Gemini 2 fallback provider call", async () => {
    mockCustomerGenerateContent
      .mockRejectedValueOnce(
        Object.assign(new Error("Unavailable"), { status: 503 })
      )
      .mockResolvedValueOnce(response('{"ok":true}'));
    const generationConfig = {
      maxOutputTokens: 512,
      thinkingConfig: { thinkingLevel: "MINIMAL" },
    };

    await expect(
      chatCompletionWithFallback({
        model: "gemini-3.5-flash",
        messages: [{ role: "user", content: "Rank the supplied documents" }],
        generationConfig,
        resilience: { maxRetries: 0, fallbackModels: ["gemini-2.0-flash"] },
      })
    ).resolves.toMatchObject({ model: "gemini-2.0-flash" });

    expect(mockCustomerGenerateContent).toHaveBeenCalledTimes(2);
    const fallbackRequest = mockCustomerGenerateContent.mock.calls[1][0];
    expect(fallbackRequest).toMatchObject({
      model: "gemini-2.0-flash",
      config: { maxOutputTokens: 512 },
    });
    expect(fallbackRequest.config).not.toHaveProperty("thinkingConfig");
    expect(generationConfig.thinkingConfig.thinkingLevel).toBe("MINIMAL");
  });

  it("uses only the workspace key for JSON and multimodal requests with a deadline", async () => {
    const result = await generateVertexGeminiContentResponse({
      ...request,
      contents: [
        {
          role: "user",
          parts: [
            { text: "describe this" },
            { inlineData: { data: "image-base64", mimeType: "image/png" } },
          ],
        },
      ],
    });
    expect(result.text).toBe('{"ok":true}');
    expect(mockGoogleGenAI).toHaveBeenCalledWith({
      apiKey: "customer-secret-a",
      vertexai: false,
    });
    expect(mockCustomerGenerateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: [
          {
            role: "user",
            parts: [
              { text: "describe this" },
              { inlineData: { data: "image-base64", mimeType: "image/png" } },
            ],
          },
        ],
        config: expect.objectContaining({
          responseMimeType: "application/json",
          maxOutputTokens: 900,
          httpOptions: { timeout: 5000, retryOptions: { attempts: 1 } },
          abortSignal: expect.any(AbortSignal),
        }),
      })
    );
    expect(getVertexGenAI).not.toHaveBeenCalled();
  });

  it("combines caller cancellation with timeout and forwards it to the customer SDK", async () => {
    const controller = new AbortController();
    await generateVertexGeminiContentResponse({
      ...request,
      signal: controller.signal,
    });
    const signal = mockCustomerGenerateContent.mock.calls[0][0].config
      .abortSignal as AbortSignal;
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it("aborts the forwarded SDK signal when its deadline expires without caller cancellation", async () => {
    const controller = new AbortController();
    await generateVertexGeminiContentResponse({
      ...request,
      timeoutMs: 20,
      signal: controller.signal,
    });
    const signal = mockCustomerGenerateContent.mock.calls[0][0].config
      .abortSignal as AbortSignal;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("SDK deadline did not abort")),
        1000
      );
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({ name: "TimeoutError" });
    expect(controller.signal.aborted).toBe(false);
  });

  it("forwards caller cancellation to streamed generation without requiring a timeout", async () => {
    mockCustomerGenerateContentStream.mockResolvedValue(
      (async function* () {
        yield response("hello");
      })()
    );
    const controller = new AbortController();
    await streamVertexGeminiContentResponse(
      { ...request, timeoutMs: undefined, signal: controller.signal },
      {}
    );
    const signal = mockCustomerGenerateContentStream.mock.calls[0][0].config
      .abortSignal as AbortSignal;
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it("streams through the workspace key while preserving chunk whitespace and usage", async () => {
    mockCustomerGenerateContentStream.mockResolvedValue(
      (async function* () {
        yield response("hello");
        yield {
          ...response(" world"),
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 4,
            thoughtsTokenCount: 6,
            cachedContentTokenCount: 8,
            totalTokenCount: 20,
          },
        };
      })()
    );
    const onDelta = jest.fn();
    const result = await streamVertexGeminiContentResponse(request, {
      onDelta,
    });
    expect(result.text).toBe("hello world");
    expect(extractVertexGeminiUsage(result.raw)).toEqual({
      prompt_tokens: 10,
      completion_tokens: 4,
      thinking_tokens: 6,
      cached_prompt_tokens: 8,
      total_tokens: 20,
    });
    expect(
      mockCustomerGenerateContentStream.mock.calls[0][0].config
    ).toMatchObject({
      maxOutputTokens: 900,
    });
    expect(onDelta.mock.calls).toEqual([
      [{ delta: "hello", accumulated: "hello" }],
      [{ delta: " world", accumulated: "hello world" }],
    ]);
    expect(getVertexGenAI).not.toHaveBeenCalled();
  });

  it("never reuses another workspace's customer client", async () => {
    await generateVertexGeminiContentResponse(request);
    mockResolveBilling.mockResolvedValue({
      ...customer,
      workspaceId: "workspace-b",
      apiKey: "customer-secret-b",
    });
    await generateVertexGeminiContentResponse(request);
    expect(
      mockGoogleGenAI.mock.calls.map(([options]) => options.apiKey)
    ).toEqual(["customer-secret-a", "customer-secret-b"]);
  });

  it("sanitizes customer failures and never calls or disables Vertex", async () => {
    mockCustomerGenerateContent.mockRejectedValue(
      Object.assign(
        new Error(
          "Invalid customer-secret-a https://google.test/?key=customer-secret-a"
        ),
        { status: 403, apiKey: "customer-secret-a" }
      )
    );
    const error = await generateVertexGeminiContentOrThrow(
      request,
      "test"
    ).catch(value => value);
    expect(error).toMatchObject({
      status: 403,
      code: "google_text_provider_failed",
    });
    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(
      "customer-secret-a"
    );
    expect(error).not.toHaveProperty("cause");
    expect(getVertexGenAI).not.toHaveBeenCalled();
    expect(markVertexUnavailableForRuntime).not.toHaveBeenCalled();
  });

  it("does not log raw provider prose or secret-bearing diagnostics for customer failures", async () => {
    mockCustomerGenerateContent.mockResolvedValue({
      candidates: [
        {
          finishReason: "customer-secret-a",
          finishMessage: "customer-secret-a",
          content: { parts: [] },
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        thoughtsTokenCount: 20,
        cachedContentTokenCount: 5,
      },
    });
    const error = await generateVertexGeminiContentResponse(request).catch(
      value => value
    );
    expect(error).toMatchObject({ code: "google_text_provider_failed" });
    expect(getVertexGeminiErrorUsage(error)).toEqual({
      prompt_tokens: 10,
      thinking_tokens: 20,
      cached_prompt_tokens: 5,
    });
    expect(
      `${error.message} ${JSON.stringify(error)} ${JSON.stringify(mockWarn.mock.calls)}`
    ).not.toContain("customer-secret-a");
  });

  it.each(["regular", "streamed"])(
    "retains only billed counters in a cancelled empty %s customer response",
    async mode => {
      const controller = new AbortController();
      const billedEmptyResponse = {
        candidates: [
          {
            finishReason: "private provider reason",
            finishMessage: "private provider message",
            content: { parts: [] },
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 0,
          thoughtsTokenCount: 20,
          cachedContentTokenCount: 5,
          totalTokenCount: 30,
        },
      };
      if (mode === "streamed") {
        mockCustomerGenerateContentStream.mockResolvedValueOnce(
          (async function* () {
            yield billedEmptyResponse;
            controller.abort(
              new DOMException("private cancellation reason", "AbortError")
            );
          })()
        );
      } else {
        mockCustomerGenerateContent.mockImplementationOnce(async () => {
          controller.abort(
            new DOMException("private cancellation reason", "AbortError")
          );
          return billedEmptyResponse;
        });
      }
      const params = { ...request, signal: controller.signal };
      const error = await (
        mode === "streamed"
          ? streamVertexGeminiContentResponse(params, {})
          : generateVertexGeminiContentResponse(params)
      ).catch(value => value);

      expect(error).toMatchObject({ name: "AbortError" });
      expect(getVertexGeminiErrorUsage(error)).toEqual({
        prompt_tokens: 10,
        completion_tokens: 0,
        thinking_tokens: 20,
        cached_prompt_tokens: 5,
        total_tokens: 30,
      });
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(
        "private"
      );
      expect(error).not.toHaveProperty("raw");
      expect(error).not.toHaveProperty("cause");
      expect(controller.signal.reason).not.toHaveProperty("usage");
      expect(mockWarn).not.toHaveBeenCalled();
      expect(getVertexGenAI).not.toHaveBeenCalled();
    }
  );

  it.each(["regular", "streamed"])(
    "accounts a cancelled billed empty %s customer response through the real adapter and facade",
    async mode => {
      const controller = new AbortController();
      const billedEmptyResponse = {
        candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 0,
          thoughtsTokenCount: 20,
          cachedContentTokenCount: 5,
          totalTokenCount: 30,
        },
      };
      if (mode === "streamed") {
        mockCustomerGenerateContentStream.mockResolvedValueOnce(
          (async function* () {
            yield billedEmptyResponse;
            controller.abort();
          })()
        );
      } else {
        mockCustomerGenerateContent.mockImplementationOnce(async () => {
          controller.abort();
          return billedEmptyResponse;
        });
      }
      const onLifecycle = jest.fn();
      const error = await chatCompletionWithFallback({
        model: request.model,
        messages: [{ role: "user", content: "private prompt" }],
        signal: controller.signal,
        onDelta: mode === "streamed" ? jest.fn() : undefined,
        analytics: { workspaceId: "workspace-a" },
        resilience: { maxRetries: 2, fallbackModels: ["gemini-fallback"] },
        onLifecycle,
      }).catch(value => value);
      expect(error).toBe(controller.signal.reason);
      expect(mockRecordLlmTraceAnalyticsEvent).toHaveBeenCalledTimes(1);
      const event = mockRecordLlmTraceAnalyticsEvent.mock.calls[0][0];
      expect(event).toMatchObject({
        provider: "google",
        status: "cancelled",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 0,
          thinking_tokens: 20,
          cached_prompt_tokens: 5,
          total_tokens: 30,
        },
      });
      expect(JSON.stringify(event)).not.toContain("private");
      expect(onLifecycle.mock.calls.map(([event]) => event.type)).toEqual([
        "attempt_start",
      ]);
      expect(mockCustomerGenerateContent.mock.calls.length).toBe(
        mode === "streamed" ? 0 : 1
      );
      expect(mockCustomerGenerateContentStream.mock.calls.length).toBe(
        mode === "streamed" ? 1 : 0
      );
      expect(getVertexGenAI).not.toHaveBeenCalled();
      expect(markVertexUnavailableForRuntime).not.toHaveBeenCalled();
    }
  );

  it("preserves the caller cancellation reason when no billed counters are available", async () => {
    const controller = new AbortController();
    mockCustomerGenerateContent.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error("private transport error");
    });
    const error = await generateVertexGeminiContentResponse({
      ...request,
      signal: controller.signal,
    }).catch(value => value);
    expect(error).toBe(controller.signal.reason);
    expect(getVertexGeminiErrorUsage(error)).toBeUndefined();
    expect(controller.signal.reason).not.toHaveProperty("usage");
  });

  it("sanitizes errors raised while iterating a customer stream", async () => {
    mockCustomerGenerateContentStream.mockResolvedValue(
      (async function* () {
        yield response("hello");
        throw Object.assign(new Error("customer-secret-a"), { status: 503 });
      })()
    );
    const error = await streamVertexGeminiContentResponse(request, {}).catch(
      value => value
    );
    expect(error).toMatchObject({
      status: 503,
      code: "google_text_provider_failed",
    });
    expect(error.message).not.toContain("customer-secret-a");
    expect(getVertexGenAI).not.toHaveBeenCalled();
  });

  it("supports a customer key even when platform Vertex is unavailable", async () => {
    jest.mocked(canUseVertexAI).mockReturnValue(false);
    await expect(
      generateVertexGeminiContentOrThrow(request, "test")
    ).resolves.toBe('{"ok":true}');
    expect(getVertexGenAI).not.toHaveBeenCalled();
  });
});
