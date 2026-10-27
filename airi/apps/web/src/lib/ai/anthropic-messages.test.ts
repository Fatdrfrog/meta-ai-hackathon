const mockCtor = jest.fn();
const mockCreate = jest.fn();
const mockStream = jest.fn();
const mockBetaCreate = jest.fn();
const mockBetaStream = jest.fn();
const mockReserveSpend = jest.fn(async (..._args: unknown[]) => null);
const mockSettleSpend = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock("./workspace-ai-policy", () => ({
  reserveWorkspaceTextAiSpend: (...args: unknown[]) =>
    mockReserveSpend(...args),
  settleWorkspaceTextAiSpend: (...args: unknown[]) => mockSettleSpend(...args),
}));

jest.mock("@anthropic-ai/sdk", () => {
  const actual = jest.requireActual("@anthropic-ai/sdk");
  class MockAnthropic {
    messages = {
      create: (...args: unknown[]) => mockCreate(...args),
      stream: (...args: unknown[]) => mockStream(...args),
    };
    beta = {
      messages: {
        create: (...args: unknown[]) => mockBetaCreate(...args),
        stream: (...args: unknown[]) => mockBetaStream(...args),
      },
    };
    constructor(options: unknown) {
      mockCtor(options);
    }
  }
  return { ...actual, __esModule: true, default: MockAnthropic };
});

import { APIConnectionTimeoutError, BadRequestError } from "@anthropic-ai/sdk";
import {
  AnthropicEmptyContentError,
  anthropicModelAcceptsSampling,
  buildAnthropicMessageParams,
  convertGeminiSchemaToJsonSchema,
  extractAnthropicUsage,
  generateAnthropicText,
  getAnthropicErrorUsage,
  resetAnthropicClientForTesting,
} from "./anthropic-messages";

const dialogue = [
  { role: "system" as const, content: " Be brief. " },
  { role: "user" as const, content: "hi" },
  { role: "assistant" as const, content: "hello" },
  { role: "user" as const, content: " next " },
];

function message(overrides: Record<string, unknown> = {}) {
  return {
    model: "claude-sonnet-5-5",
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: "  Answer  " },
    ],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 100,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 10,
      output_tokens: 20,
    },
    ...overrides,
  };
}

function fakeStream(deltas: string[], final: Record<string, unknown>) {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    on(event: string, listener: (...args: unknown[]) => void) {
      (listeners[event] ||= []).push(listener);
      return this;
    },
    async finalMessage() {
      for (const listener of listeners.streamEvent || []) {
        listener({ type: "message_start" }, { usage: final.usage });
      }
      let snapshot = "";
      for (const delta of deltas) {
        snapshot += delta;
        for (const listener of listeners.text || []) listener(delta, snapshot);
      }
      return final;
    },
  };
}

describe("buildAnthropicMessageParams", () => {
  it("flattens the dialogue into one user turn with a cached system block", () => {
    const params = buildAnthropicMessageParams({
      model: "claude-sonnet-5-5",
      messages: dialogue,
    });
    expect(params.system).toEqual([
      {
        type: "text",
        text: "Be brief.",
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(params.messages).toEqual([
      {
        role: "user",
        content: "USER:\nhi\n\nASSISTANT:\nhello\n\nUSER:\nnext",
      },
    ]);
  });

  it("never sends sampling params to claude-sonnet-5-5 and uses low effort by default", () => {
    const params = buildAnthropicMessageParams({
      model: "claude-sonnet-5-5",
      messages: dialogue,
      generationConfig: {
        temperature: 0.2,
        topP: 0.9,
        topK: 40,
        maxOutputTokens: 500,
        stopSequences: ["END"],
        safetySettings: [],
        httpOptions: { timeout: 1 },
        responseMimeType: "text/plain",
      },
    });
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("top_p");
    expect(params).not.toHaveProperty("top_k");
    expect(params).not.toHaveProperty("thinking");
    expect(params).not.toHaveProperty("safetySettings");
    expect(params).not.toHaveProperty("httpOptions");
    expect(params.output_config).toEqual({ effort: "low" });
    expect(params.stop_sequences).toEqual(["END"]);
    expect(params.max_tokens).toBe(500 + 4096);
  });

  it("maps MINIMAL thinking on claude-sonnet-5-5 to between_tools without headroom", () => {
    const params = buildAnthropicMessageParams({
      model: "claude-sonnet-5-5",
      messages: dialogue,
      generationConfig: {
        maxOutputTokens: 64,
        thinkingConfig: { thinkingLevel: "MINIMAL" },
      },
    });
    expect(params.thinking).toEqual({ type: "between_tools" });
    expect(params.output_config).toEqual({ effort: "low" });
    expect(params.max_tokens).toBe(64);
  });

  it.each([
    ["MEDIUM", "medium", 1000 + 8192],
    ["HIGH", "high", 1000 + 16384],
  ])(
    "maps claude-sonnet-5-5 thinkingLevel %s to effort %s",
    (level, effort, maxTokens) => {
      const params = buildAnthropicMessageParams({
        model: "claude-sonnet-5-5",
        messages: dialogue,
        generationConfig: {
          maxOutputTokens: 1000,
          thinkingConfig: { thinkingLevel: level },
        },
      });
      expect(params.output_config).toEqual({ effort });
      expect(params).not.toHaveProperty("thinking");
      expect(params.max_tokens).toBe(maxTokens);
    }
  );

  it("defaults the cap to 16000 plus thinking headroom", () => {
    expect(
      buildAnthropicMessageParams({
        model: "claude-sonnet-5-5",
        messages: dialogue,
      }).max_tokens
    ).toBe(16000 + 4096);
  });

  it.each([
    [undefined, "medium"],
    ["MINIMAL", "low"],
    ["LOW", "low"],
    ["MEDIUM", "medium"],
    ["HIGH", "high"],
  ])(
    "never disables thinking on claude-opus-5-5 (level %s -> effort %s)",
    (level, effort) => {
      const params = buildAnthropicMessageParams({
        model: "claude-opus-5-5",
        messages: dialogue,
        generationConfig: {
          temperature: 0.5,
          ...(level ? { thinkingConfig: { thinkingLevel: level } } : {}),
        },
      });
      expect(params).not.toHaveProperty("thinking");
      expect(params).not.toHaveProperty("temperature");
      expect(params.output_config).toEqual({ effort });
    }
  );

  it("caps max_tokens at 64000", () => {
    expect(
      buildAnthropicMessageParams({
        model: "claude-opus-5-5",
        messages: dialogue,
        generationConfig: { maxOutputTokens: 60_000 },
      }).max_tokens
    ).toBe(64_000);
  });

  it("sends sampling but no thinking or effort to claude-haiku-4-5", () => {
    const params = buildAnthropicMessageParams({
      model: "claude-haiku-4-5",
      messages: dialogue,
      generationConfig: {
        temperature: 1.5,
        topP: 0.9,
        thinkingConfig: { thinkingLevel: "HIGH" },
      },
    });
    expect(params.temperature).toBe(1);
    expect(params).not.toHaveProperty("top_p");
    expect(params).not.toHaveProperty("thinking");
    expect(params).not.toHaveProperty("output_config");
    expect(params.max_tokens).toBe(16000);
  });

  it("treats unknown modern Claude ids like sonnet-5-5 minus between_tools", () => {
    const params = buildAnthropicMessageParams({
      model: "claude-sonnet-6",
      messages: dialogue,
      generationConfig: {
        temperature: 0.3,
        thinkingConfig: { thinkingLevel: "MINIMAL" },
      },
    });
    expect(params).not.toHaveProperty("thinking");
    expect(params).not.toHaveProperty("temperature");
    expect(params.output_config).toEqual({ effort: "low" });
  });

  it("classifies sampling-capable models", () => {
    expect(anthropicModelAcceptsSampling("claude-haiku-4-5")).toBe(true);
    expect(anthropicModelAcceptsSampling("claude-sonnet-4-20250514")).toBe(
      true
    );
    expect(anthropicModelAcceptsSampling("claude-3-5-haiku-latest")).toBe(true);
    expect(anthropicModelAcceptsSampling("claude-sonnet-4-6")).toBe(false);
    expect(anthropicModelAcceptsSampling("claude-sonnet-5-5")).toBe(false);
    expect(anthropicModelAcceptsSampling("claude-opus-5-5")).toBe(false);
  });

  it("translates a Gemini responseSchema into structured outputs plus the JSON instruction", () => {
    const params = buildAnthropicMessageParams({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "Classify" }],
      forceJson: true,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: { label: { type: "STRING", enum: ["a", "b"] } },
          required: ["label"],
        },
      },
    });
    expect(params.output_config).toEqual({
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { label: { type: "string", enum: ["a", "b"] } },
          required: ["label"],
          additionalProperties: false,
        },
      },
    });
    expect(params.messages[0]?.content).toBe(
      "USER:\nClassify\n\nOutput MUST be a valid JSON object only. No markdown fences."
    );
  });

  it("keeps JSON mime type without schema as a prompt instruction only", () => {
    const params = buildAnthropicMessageParams({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "Return JSON" }],
      generationConfig: { responseMimeType: "application/json" },
    });
    expect(params).not.toHaveProperty("output_config");
    expect(params.messages[0]?.content).toContain(
      "Output MUST be a valid JSON object only."
    );
  });

  it("skips structured outputs for free-form object schemas", () => {
    const params = buildAnthropicMessageParams({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "Extract" }],
      generationConfig: {
        responseSchema: {
          type: "OBJECT",
          properties: { metadata: { type: "OBJECT" } },
        },
      },
    });
    expect(params).not.toHaveProperty("output_config");
  });

  it("moves system-only prompts into the user turn", () => {
    const params = buildAnthropicMessageParams({
      model: "claude-haiku-4-5",
      messages: [{ role: "system", content: "Only instructions" }],
    });
    expect(params).not.toHaveProperty("system");
    expect(params.messages).toEqual([
      { role: "user", content: "Only instructions" },
    ]);
  });
});

describe("convertGeminiSchemaToJsonSchema", () => {
  function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object") {
      Object.values(value).forEach(deepFreeze);
      Object.freeze(value);
    }
    return value;
  }

  it("converts types, nullability and objects without mutating input", () => {
    const input = deepFreeze({
      type: "OBJECT",
      description: "root",
      propertyOrdering: ["name", "tags"],
      properties: {
        name: {
          type: "STRING",
          nullable: true,
          minLength: 1,
          maxLength: 10,
          pattern: "^a",
          format: "email",
        },
        score: { type: "NUMBER", minimum: 0, maximum: 1, example: 0.5 },
        kind: { type: "STRING", enum: ["x", "y"], nullable: true },
        when: { type: "STRING", format: "enum" },
        tags: {
          type: "ARRAY",
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
          items: { type: "STRING", default: "z" },
        },
        nested: {
          type: "OBJECT",
          title: "Nested",
          properties: { ok: { type: "BOOLEAN" } },
          required: ["ok", "missing"],
        },
        either: {
          anyOf: [{ type: "STRING" }, { type: "INTEGER" }],
          nullable: true,
        },
      },
      required: ["name"],
    });
    const snapshot = JSON.stringify(input);
    expect(convertGeminiSchemaToJsonSchema(input)).toEqual({
      type: "object",
      description: "root",
      properties: {
        name: { type: ["string", "null"], format: "email" },
        score: { type: "number" },
        kind: {
          anyOf: [{ type: "string", enum: ["x", "y"] }, { type: "null" }],
        },
        when: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        nested: {
          title: "Nested",
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
        either: {
          anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }],
        },
      },
      required: ["name"],
      additionalProperties: false,
    });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("never puts an enum under a type list, which Claude rejects with HTTP 400", () => {
    // Turn understanding's `safeReplyKey`: every Claude call failed on it.
    const converted = convertGeminiSchemaToJsonSchema({
      type: "OBJECT",
      properties: {
        safeReplyKey: {
          type: "STRING",
          nullable: true,
          format: "enum",
          enum: ["greeting", "thanks"],
        },
        listed: { type: ["string", "null"], enum: ["a", null] },
      },
    });
    const properties = converted.properties as Record<string, unknown>;
    expect(properties.safeReplyKey).toEqual({
      anyOf: [
        { type: "string", enum: ["greeting", "thanks"] },
        { type: "null" },
      ],
    });
    expect(properties.listed).toEqual({
      anyOf: [{ type: "string", enum: ["a"] }, { type: "null" }],
    });
  });

  it("keeps const and returns an empty schema for non-objects", () => {
    expect(convertGeminiSchemaToJsonSchema({ const: "fixed" })).toEqual({
      const: "fixed",
    });
    expect(convertGeminiSchemaToJsonSchema(null)).toEqual({});
  });
});

describe("extractAnthropicUsage", () => {
  it("counts cache reads and writes as prompt tokens and reports writes for pricing", () => {
    expect(
      extractAnthropicUsage({
        input_tokens: 100,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10,
        output_tokens: 20,
      })
    ).toEqual({
      prompt_tokens: 160,
      completion_tokens: 20,
      total_tokens: 180,
      cached_prompt_tokens: 50,
      cache_write_prompt_tokens: 10,
    });
    expect(
      extractAnthropicUsage({
        input_tokens: 7,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        output_tokens: 3,
      })
    ).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
    expect(extractAnthropicUsage(undefined)).toBeUndefined();
  });
});

describe("generateAnthropicText", () => {
  it("does not call the provider after spending admission is denied", async () => {
    mockReserveSpend.mockRejectedValueOnce(
      Object.assign(new Error("budget"), { code: "workspace_ai_spend_limit" })
    );
    await expect(
      generateAnthropicText({ model: "claude-haiku-4-5", messages: dialogue })
    ).rejects.toMatchObject({ code: "workspace_ai_spend_limit" });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockBetaCreate).not.toHaveBeenCalled();
  });
  const previousKey = process.env.ANTHROPIC_API_KEY;
  const usage = {
    prompt_tokens: 160,
    completion_tokens: 20,
    total_tokens: 180,
    cached_prompt_tokens: 50,
    cache_write_prompt_tokens: 10,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    resetAnthropicClientForTesting();
    process.env.ANTHROPIC_API_KEY = " test-key ";
    delete process.env.ANTHROPIC_WORKSPACE_ID;
  });

  afterAll(() => {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  });

  it("keeps sponsored Claude inference on one explicitly reserved endpoint", async () => {
    mockCreate.mockResolvedValue(message());
    const controller = new AbortController();
    const result = await generateAnthropicText({
      model: "claude-sonnet-5-5",
      messages: dialogue,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    expect(result).toEqual({
      text: "Answer",
      finishReason: "end_turn",
      usage,
      servedModel: "claude-sonnet-5-5",
    });
    expect(mockCtor).toHaveBeenCalledWith({
      apiKey: "test-key",
      maxRetries: 0,
    });
    const [params, requestOptions] = mockCreate.mock.calls[0];
    expect(params).toMatchObject({
      model: "claude-sonnet-5-5",
    });
    expect(requestOptions.timeout).toBe(5_000);
    expect(requestOptions.signal).toBeInstanceOf(AbortSignal);
    expect(params).not.toHaveProperty("fallbacks");
    expect(mockBetaCreate).not.toHaveBeenCalled();
  });

  it("returns the answer without waiting for the spend settle, which still runs", async () => {
    const reservation = { operationId: "op-1" };
    mockReserveSpend.mockResolvedValueOnce(reservation as never);
    let finishSettle!: () => void;
    mockSettleSpend.mockReturnValueOnce(
      new Promise<undefined>(resolve => {
        finishSettle = () => resolve(undefined);
      })
    );
    mockCreate.mockResolvedValue(message());

    const result = await generateAnthropicText({
      model: "claude-sonnet-5-5",
      messages: dialogue,
    });

    expect(result.text).toBe("Answer");
    // Started, not awaited: the settle is a Supabase round trip.
    expect(mockSettleSpend).toHaveBeenCalledWith(
      reservation,
      "claude-sonnet-5-5",
      usage
    );
    finishSettle();
    const { drainPendingAfterResponseWork } = await import(
      "@/lib/after-response-work"
    );
    await expect(drainPendingAfterResponseWork(1_000)).resolves.toBe(true);
  });

  it("uses the plain endpoint without fallbacks for claude-haiku-4-5", async () => {
    mockCreate.mockResolvedValue(message({ model: "claude-haiku-4-5" }));
    await generateAnthropicText({
      model: "claude-haiku-4-5",
      messages: dialogue,
    });
    const [params] = mockCreate.mock.calls[0];
    expect(params).not.toHaveProperty("betas");
    expect(params).not.toHaveProperty("fallbacks");
    expect(mockBetaCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["refusal", [{ type: "text", text: "partial" }]],
    ["max_tokens", [{ type: "thinking", thinking: "" }]],
    ["end_turn", []],
  ])(
    "throws an empty-content error carrying %s and usage",
    async (stopReason, content) => {
      mockCreate.mockResolvedValue(
        message({ stop_reason: stopReason, content })
      );
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      let error: unknown;
      try {
        await generateAnthropicText({
          model: "claude-sonnet-5-5",
          messages: dialogue,
        });
      } catch (caught) {
        error = caught;
      } finally {
        warn.mockRestore();
      }
      expect(error).toBeInstanceOf(AnthropicEmptyContentError);
      expect(error).toMatchObject({ finishReason: stopReason, usage });
      expect(getAnthropicErrorUsage(error)).toEqual(usage);
    }
  );

  it("streams untrimmed deltas in order and returns the trimmed final text", async () => {
    mockStream.mockReturnValue(
      fakeStream([" Hel", "lo", " world "], {
        ...message(),
        content: [{ type: "text", text: " Hello world " }],
      })
    );
    const deltas: Array<{ delta: string; accumulated: string }> = [];
    const result = await generateAnthropicText(
      { model: "claude-sonnet-5-5", messages: dialogue },
      {
        onDelta: async chunk => {
          await new Promise(resolve => setTimeout(resolve, 1));
          deltas.push(chunk);
          if (chunk.delta === "lo") throw new Error("callback failure");
        },
      }
    );
    expect(deltas).toEqual([
      { delta: " Hel", accumulated: " Hel" },
      { delta: "lo", accumulated: " Hello" },
      { delta: " world ", accumulated: " Hello world " },
    ]);
    expect(result.text).toBe("Hello world");
    expect(mockStream.mock.calls[0][0]).not.toHaveProperty("fallbacks");
  });

  it("does not call the API after caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateAnthropicText({
        model: "claude-sonnet-5-5",
        messages: dialogue,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mockBetaCreate).not.toHaveBeenCalled();
  });

  it("retains the full reservation when a stream disconnects after provisional usage", async () => {
    const listeners: Record<string, (...args: unknown[]) => void> = {};
    mockStream.mockReturnValue({
      on: (event: string, listener: (...args: unknown[]) => void) => {
        listeners[event] = listener;
      },
      finalMessage: async () => {
        listeners.streamEvent?.(
          { type: "message_start" },
          { usage: { input_tokens: 100, output_tokens: 0 } }
        );
        listeners.text?.("partial answer", "partial answer");
        throw new Error("connection lost before terminal usage");
      },
    });
    await expect(
      generateAnthropicText(
        { model: "claude-sonnet-5-5", messages: dialogue },
        { onDelta: () => {} }
      )
    ).rejects.toThrow("connection lost");
    expect(mockSettleSpend).toHaveBeenLastCalledWith(
      null,
      "claude-sonnet-5-5",
      undefined
    );
  });

  it("rethrows the caller's abort when the request is cancelled", async () => {
    const controller = new AbortController();
    mockCreate.mockImplementation(async () => {
      controller.abort();
      throw new Error("Request was aborted.");
    });
    const error = await generateAnthropicText({
      model: "claude-sonnet-5-5",
      messages: dialogue,
      signal: controller.signal,
    }).catch(value => value);
    expect(error).toBe(controller.signal.reason);
  });

  it("carries completed usage across cancellation without content", async () => {
    const controller = new AbortController();
    mockCreate.mockImplementation(async () => {
      controller.abort();
      return message();
    });
    let error: unknown;
    try {
      await generateAnthropicText({
        model: "claude-sonnet-5-5",
        messages: dialogue,
        signal: controller.signal,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ name: "AbortError" });
    expect(getAnthropicErrorUsage(error)).toEqual(usage);
    expect(JSON.stringify(error)).not.toContain("Answer");
  });

  it("maps SDK timeouts to a retryable timeout error", async () => {
    mockCreate.mockRejectedValue(new APIConnectionTimeoutError());
    await expect(
      generateAnthropicText({
        model: "claude-sonnet-5-5",
        messages: dialogue,
        timeoutMs: 1_000,
      })
    ).rejects.toThrow("Anthropic request timeout");
  });

  it("keeps SDK API errors with their status", async () => {
    const apiError = Object.assign(new Error("529 overloaded"), {
      status: 529,
    });
    mockCreate.mockRejectedValue(apiError);
    await expect(
      generateAnthropicText({ model: "claude-sonnet-5-5", messages: dialogue })
    ).rejects.toBe(apiError);
  });

  it("fails clearly without an API key", async () => {
    process.env.ANTHROPIC_API_KEY = "";
    await expect(
      generateAnthropicText({ model: "claude-sonnet-5-5", messages: dialogue })
    ).rejects.toThrow("ANTHROPIC_API_KEY is not configured");
  });
});

describe("generateAnthropicText configuration and server-side fallbacks", () => {
  const previous = {
    key: process.env.ANTHROPIC_API_KEY,
    workspace: process.env.ANTHROPIC_WORKSPACE_ID,
  };

  function badRequest(errorMessage: string) {
    return new BadRequestError(
      400,
      {
        type: "error",
        error: { type: "invalid_request_error", message: errorMessage },
      },
      undefined,
      new Headers()
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    resetAnthropicClientForTesting();
    process.env.ANTHROPIC_API_KEY = "test-key";
    delete process.env.ANTHROPIC_WORKSPACE_ID;
  });

  afterAll(() => {
    resetAnthropicClientForTesting();
    for (const [name, value] of [
      ["ANTHROPIC_API_KEY", previous.key],
      ["ANTHROPIC_WORKSPACE_ID", previous.workspace],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("sends ANTHROPIC_WORKSPACE_ID as a default header and rebuilds the client when it changes", async () => {
    mockCreate.mockResolvedValue(message({ model: "claude-haiku-4-5" }));
    process.env.ANTHROPIC_WORKSPACE_ID = "  wrkspc_01ABC ";
    await generateAnthropicText({
      model: "claude-haiku-4-5",
      messages: dialogue,
    });
    await generateAnthropicText({
      model: "claude-haiku-4-5",
      messages: dialogue,
    });
    expect(mockCtor).toHaveBeenCalledTimes(1);
    expect(mockCtor).toHaveBeenLastCalledWith({
      apiKey: "test-key",
      maxRetries: 0,
      defaultHeaders: { "anthropic-workspace-id": "wrkspc_01ABC" },
    });

    process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_02DEF";
    await generateAnthropicText({
      model: "claude-haiku-4-5",
      messages: dialogue,
    });
    expect(mockCtor).toHaveBeenCalledTimes(2);
    expect(mockCtor).toHaveBeenLastCalledWith(
      expect.objectContaining({
        defaultHeaders: { "anthropic-workspace-id": "wrkspc_02DEF" },
      })
    );

    delete process.env.ANTHROPIC_WORKSPACE_ID;
    await generateAnthropicText({
      model: "claude-haiku-4-5",
      messages: dialogue,
    });
    expect(mockCtor).toHaveBeenCalledTimes(3);
    expect(mockCtor).toHaveBeenLastCalledWith({
      apiKey: "test-key",
      maxRetries: 0,
    });
  });

  it("leaves retries to the facade after provider rejection", async () => {
    const error = badRequest("fallbacks: Extra inputs are not permitted");
    mockCreate.mockRejectedValueOnce(error);
    await expect(
      generateAnthropicText({ model: "claude-sonnet-5-5", messages: dialogue })
    ).rejects.toBe(error);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockBetaCreate).not.toHaveBeenCalled();
  });
  it("returns the serving model text, model and whole-turn usage after a fallback", async () => {
    mockCreate.mockResolvedValue(
      message({
        model: "claude-sonnet-5",
        content: [
          {
            type: "fallback",
            from: { model: "claude-sonnet-5-5" },
            to: { model: "claude-sonnet-5" },
            trigger: { type: "refusal", category: "cyber" },
          },
          { type: "text", text: "Fallback answer" },
        ],
        usage: {
          input_tokens: 40,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 15,
          iterations: [
            {
              type: "message",
              model: "claude-sonnet-5-5",
              input_tokens: 100,
              cache_read_input_tokens: 50,
              cache_creation_input_tokens: 10,
              output_tokens: 5,
            },
            {
              type: "compaction",
              input_tokens: 999,
              output_tokens: 999,
            },
            {
              type: "fallback_message",
              model: "claude-sonnet-5",
              input_tokens: 40,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
              output_tokens: 15,
            },
          ],
        },
      })
    );
    const result = await generateAnthropicText({
      model: "claude-sonnet-5-5",
      messages: dialogue,
    });
    expect(result).toEqual({
      text: "Fallback answer",
      finishReason: "end_turn",
      servedModel: "claude-sonnet-5",
      usage: {
        prompt_tokens: 200,
        completion_tokens: 20,
        total_tokens: 220,
        cached_prompt_tokens: 50,
        cache_write_prompt_tokens: 10,
      },
    });
  });

  it("reports a sticky fallback (no block) through usage.iterations", async () => {
    mockCreate.mockResolvedValue(
      message({
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "Sticky answer" }],
        usage: {
          input_tokens: 30,
          output_tokens: 6,
          iterations: [
            {
              type: "fallback_message",
              model: "claude-sonnet-5",
              input_tokens: 30,
              output_tokens: 6,
            },
          ],
        },
      })
    );
    const result = await generateAnthropicText({
      model: "claude-sonnet-5-5",
      messages: dialogue,
    });
    expect(result.servedModel).toBe("claude-sonnet-5");
    expect(result.usage).toEqual({
      prompt_tokens: 30,
      completion_tokens: 6,
      total_tokens: 36,
    });
  });

  it("keeps the requested id when no fallback served, even if the API echoes another id", async () => {
    mockCreate.mockResolvedValue(
      message({ model: "claude-sonnet-5-5-20261001" })
    );
    const result = await generateAnthropicText({
      model: "claude-sonnet-5-5",
      messages: dialogue,
    });
    expect(result.servedModel).toBe("claude-sonnet-5-5");
  });

  it("streams a mid-stream fallback as one continuous text without restarting", async () => {
    mockStream.mockReturnValue(
      fakeStream(["Step one, ", "then step two."], {
        ...message(),
        model: "claude-sonnet-5",
        content: [
          { type: "text", text: "Step one, " },
          {
            type: "fallback",
            from: { model: "claude-sonnet-5-5" },
            to: { model: "claude-sonnet-5" },
            trigger: { type: "refusal", category: "frontier_llm" },
          },
          { type: "text", text: "then step two." },
        ],
        usage: {
          input_tokens: 45,
          output_tokens: 4,
          iterations: [
            {
              type: "message",
              model: "claude-sonnet-5-5",
              input_tokens: 40,
              output_tokens: 3,
            },
            {
              type: "fallback_message",
              model: "claude-sonnet-5",
              input_tokens: 45,
              output_tokens: 4,
            },
          ],
        },
      })
    );
    const deltas: Array<{ delta: string; accumulated: string }> = [];
    const result = await generateAnthropicText(
      { model: "claude-sonnet-5-5", messages: dialogue },
      { onDelta: chunk => void deltas.push(chunk) }
    );
    expect(result.text).toBe("Step one, then step two.");
    expect(deltas.at(-1)?.accumulated).toBe("Step one, then step two.");
    expect(result.servedModel).toBe("claude-sonnet-5");
    expect(result.usage).toEqual({
      prompt_tokens: 85,
      completion_tokens: 7,
      total_tokens: 92,
    });
  });
});
