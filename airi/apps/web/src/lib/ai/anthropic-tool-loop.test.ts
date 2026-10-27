const mockStream = jest.fn();
const mockReserveSpend = jest.fn(async (..._args: unknown[]) => null);
const mockSettleSpend = jest.fn(async (..._args: unknown[]) => undefined);
const mockResolveBilling = jest.fn(async (): Promise<unknown> => null);
const mockRecordTrace = jest.fn(async (..._args: unknown[]) => true);

jest.mock("./workspace-ai-policy", () => ({
  reserveWorkspaceTextAiSpend: (...args: unknown[]) =>
    mockReserveSpend(...args),
  settleWorkspaceTextAiSpend: (...args: unknown[]) => mockSettleSpend(...args),
  resolveWorkspaceTextAiBilling: () => mockResolveBilling(),
}));

jest.mock("@/lib/llm-analytics/events", () => ({
  recordLlmTraceAnalyticsEvent: (...args: unknown[]) =>
    mockRecordTrace(...args),
}));

jest.mock("@anthropic-ai/sdk", () => {
  const actual = jest.requireActual("@anthropic-ai/sdk");
  class MockAnthropic {
    messages = {
      stream: (...args: unknown[]) => mockStream(...args),
    };
  }
  return { ...actual, __esModule: true, default: MockAnthropic };
});

import {
  APIConnectionTimeoutError,
  InternalServerError,
} from "@anthropic-ai/sdk";
import { resetAnthropicRuntimeAvailabilityForTesting } from "./anthropic-config";
import { resetAnthropicClientForTesting } from "./anthropic-messages";
import {
  AnthropicToolLoopUnavailableError,
  runAnthropicToolLoop,
  type AnthropicToolLoopParams,
} from "./anthropic-tool-loop";
import { createInferenceDeadline } from "./inference-deadline";

type Block = Record<string, unknown>;
type ScriptedResponse = {
  content: Block[];
  stop_reason: string;
  usage?: Record<string, number>;
};

/** A scripted fake Claude: each stream() call serves the next response. */
function scriptClaude(...responses: Array<ScriptedResponse | Error>) {
  for (const response of responses) {
    mockStream.mockImplementationOnce(() => {
      const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
      return {
        on(event: string, listener: (...args: unknown[]) => void) {
          (listeners[event] ||= []).push(listener);
          return this;
        },
        async finalMessage() {
          if (response instanceof Error) throw response;
          let snapshot = "";
          for (const block of response.content) {
            if (block.type !== "text") continue;
            // Stream each text block in two chunks.
            const text = String(block.text);
            for (const delta of [
              text.slice(0, Math.ceil(text.length / 2)),
              text.slice(Math.ceil(text.length / 2)),
            ]) {
              if (!delta) continue;
              snapshot += delta;
              for (const listener of listeners.text || [])
                listener(delta, snapshot);
            }
          }
          return {
            id: "msg",
            model: "claude-sonnet-5-5",
            role: "assistant",
            usage: response.usage ?? { input_tokens: 10, output_tokens: 5 },
            ...response,
          };
        },
      };
    });
  }
}

const toolUse = (id: string, name: string, input: unknown): Block => ({
  type: "tool_use",
  id,
  name,
  input,
});
const thinking = (signature: string): Block => ({
  type: "thinking",
  thinking: "",
  signature,
});
const text = (value: string): Block => ({ type: "text", text: value });

function requestAt(index: number) {
  return mockStream.mock.calls[index]![0] as {
    messages: Array<{ role: string; content: unknown }>;
    tools: Array<Record<string, unknown>>;
    system: Array<Record<string, unknown>>;
    tool_choice: { type: string };
    output_config?: Record<string, unknown>;
    thinking?: unknown;
  };
}

function baseParams(
  overrides: Partial<AnthropicToolLoopParams> = {}
): AnthropicToolLoopParams {
  return {
    model: "claude-sonnet-5-5",
    system: "You read the weather.",
    userMessage: "Weather in Almaty?",
    tools: [
      {
        name: "lookup",
        description: "Look up",
        input_schema: { type: "object", properties: { q: { type: "string" } } },
      },
      {
        name: "forecast",
        description: "Forecast",
        input_schema: { type: "object", properties: {} },
      },
    ],
    executeTool: jest.fn(async () => ({ content: '{"temp":21}' })),
    maxIterations: 5,
    deadline: createInferenceDeadline(60_000),
    analytics: {
      workspaceId: "workspace-1",
      conversationId: "thread-1",
      messageId: "message-1",
      traceId: "trace-1",
      operation: "airi_chat.meta_ads_mcp.agent_step",
      inputText: "Weather in Almaty?",
      sourceService: "web.airi_chat",
    },
    ...overrides,
  };
}

describe("runAnthropicToolLoop", () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    jest.clearAllMocks();
    mockStream.mockReset();
    mockResolveBilling.mockResolvedValue(null);
    process.env.ANTHROPIC_API_KEY = "test-key";
    resetAnthropicClientForTesting();
    resetAnthropicRuntimeAvailabilityForTesting();
  });
  afterAll(() => {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  });

  it("runs a tool and answers with the final text, appending blocks unchanged", async () => {
    const first: ScriptedResponse = {
      content: [
        thinking("sig-1"),
        text("Checking."),
        toolUse("tu_1", "lookup", { q: "Almaty" }),
      ],
      stop_reason: "tool_use",
    };
    scriptClaude(first, {
      content: [thinking("sig-2"), text("It is 21 °C in Almaty.")],
      stop_reason: "end_turn",
    });
    const params = baseParams();

    const result = await runAnthropicToolLoop(params);

    expect(params.executeTool).toHaveBeenCalledWith(
      { id: "tu_1", name: "lookup", input: { q: "Almaty" } },
      expect.objectContaining({ iteration: 1 })
    );
    expect(result).toMatchObject({
      text: "It is 21 °C in Almaty.",
      stopReason: "end_turn",
      forcedFinalAnswer: null,
      iterations: 2,
      toolCalls: 1,
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    });
    const second = requestAt(1);
    // The assistant turn goes back exactly as received (thinking signatures included).
    expect(second.messages[1]!.content).toBe(first.content);
    expect(second.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: '{"temp":21}' },
      ],
    });
    // Append-only: the second request starts with the first one's messages.
    expect(second.messages.slice(0, 1)).toEqual(requestAt(0).messages);
    expect(result.messages).toHaveLength(4);
  });

  it("uses auto tool choice, caches the system and last tool, and never forces a tool", async () => {
    scriptClaude({ content: [text("Hi.")], stop_reason: "end_turn" });

    await runAnthropicToolLoop(baseParams());

    const request = requestAt(0);
    expect(request.tool_choice).toEqual({ type: "auto" });
    expect(request.system).toEqual([
      {
        type: "text",
        text: "You read the weather.",
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(request.tools[0]).not.toHaveProperty("cache_control");
    expect(request.tools[1]).toMatchObject({
      name: "forecast",
      cache_control: { type: "ephemeral" },
    });
    expect(request.output_config).toEqual({ effort: "medium" });
    expect(request).not.toHaveProperty("temperature");
  });

  it("sends tool errors back as is_error results so the model can correct the call", async () => {
    scriptClaude(
      {
        content: [toolUse("tu_1", "lookup", { q: 1 })],
        stop_reason: "tool_use",
      },
      {
        content: [toolUse("tu_2", "lookup", { q: "Almaty" })],
        stop_reason: "tool_use",
      },
      { content: [text("Done.")], stop_reason: "end_turn" }
    );
    const executeTool = jest
      .fn()
      .mockResolvedValueOnce({ content: "q must be a string", isError: true })
      .mockResolvedValueOnce({ content: "ok" });

    const result = await runAnthropicToolLoop(baseParams({ executeTool }));

    expect(requestAt(1).messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: "q must be a string",
          is_error: true,
        },
      ],
    });
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("Done.");
  });

  it("withholds tools on the last allowed step and reports the cut-off", async () => {
    scriptClaude(
      { content: [toolUse("tu_1", "lookup", {})], stop_reason: "tool_use" },
      { content: [toolUse("tu_2", "lookup", {})], stop_reason: "tool_use" },
      { content: [text("Partial answer.")], stop_reason: "end_turn" }
    );
    const params = baseParams({ maxIterations: 3 });

    const result = await runAnthropicToolLoop(params);

    expect(mockStream).toHaveBeenCalledTimes(3);
    expect(requestAt(2).tool_choice).toEqual({ type: "none" });
    expect(params.executeTool).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      text: "Partial answer.",
      forcedFinalAnswer: "iteration_limit",
      iterations: 3,
    });
  });

  it("forces the final answer when the deadline reserve is reached", async () => {
    scriptClaude({ content: [text("Quick answer.")], stop_reason: "end_turn" });

    const result = await runAnthropicToolLoop(
      baseParams({
        deadline: createInferenceDeadline(20_000),
        finalAnswerReserveMs: 25_000,
      })
    );

    expect(requestAt(0).tool_choice).toEqual({ type: "none" });
    expect(result.forcedFinalAnswer).toBe("deadline");
  });

  describe("final-answer reserve", () => {
    const RESERVE_MS = 25_000;
    let now = 0;
    const clockParams = (remainingMs: number) => {
      now = 0;
      return baseParams({
        deadline: createInferenceDeadline(remainingMs, () => now),
        finalAnswerReserveMs: RESERVE_MS,
      });
    };
    const timeoutOf = (index: number) =>
      (mockStream.mock.calls[index]![1] as { timeout: number }).timeout;

    it("caps a tool step at the time before the reserve, so the answer keeps it", async () => {
      scriptClaude(
        { content: [toolUse("tu_1", "lookup", {})], stop_reason: "tool_use" },
        { content: [text("Answer.")], stop_reason: "end_turn" }
      );
      const params = clockParams(50_000);
      // The tool step takes most of its capped time.
      params.executeTool = jest.fn(async () => {
        now += 24_500;
        return { content: "ok" };
      });

      const result = await runAnthropicToolLoop(params);

      expect(timeoutOf(0)).toBe(50_000 - RESERVE_MS);
      expect(requestAt(1).tool_choice).toEqual({ type: "none" });
      expect(timeoutOf(1)).toBe(25_500);
      expect(result).toMatchObject({
        text: "Answer.",
        stopReason: "end_turn",
        forcedFinalAnswer: "deadline",
      });
    });

    it("answers with tools withheld when a tool step times out at the reserve", async () => {
      mockStream.mockImplementationOnce(() => ({
        on() {
          return this;
        },
        async finalMessage() {
          now += 15_000;
          throw new APIConnectionTimeoutError();
        },
      }));
      scriptClaude({ content: [text("Answer.")], stop_reason: "end_turn" });

      const result = await runAnthropicToolLoop(clockParams(40_000));

      expect(timeoutOf(0)).toBe(15_000);
      expect(mockStream).toHaveBeenCalledTimes(2);
      expect(requestAt(1).tool_choice).toEqual({ type: "none" });
      expect(timeoutOf(1)).toBe(RESERVE_MS);
      expect(result).toMatchObject({
        text: "Answer.",
        forcedFinalAnswer: "deadline",
      });
    });

    it("does not retry a tool step into the reserve: it answers instead", async () => {
      scriptClaude(
        new InternalServerError(
          529,
          { type: "overloaded_error" },
          "Overloaded",
          new Headers()
        ),
        { content: [text("Answer.")], stop_reason: "end_turn" }
      );

      // 2 s before the reserve: enough for the step, not for its retry.
      const result = await runAnthropicToolLoop(clockParams(27_000));

      expect(mockStream).toHaveBeenCalledTimes(2);
      expect(requestAt(0).tool_choice).toEqual({ type: "auto" });
      expect(timeoutOf(0)).toBe(2_000);
      expect(requestAt(1).tool_choice).toEqual({ type: "none" });
      expect(timeoutOf(1)).toBe(27_000);
      expect(result.text).toBe("Answer.");
    });
  });

  it("shortens the newest tool results to fit the size bound and answers", async () => {
    scriptClaude(
      { content: [toolUse("tu_1", "lookup", {})], stop_reason: "tool_use" },
      { content: [text("Partial answer.")], stop_reason: "end_turn" }
    );
    const maxRequestBytes = 6_000;
    const params = baseParams({
      maxRequestBytes,
      executeTool: jest.fn(async () => ({ content: "Ж".repeat(20_000) })),
    });

    const result = await runAnthropicToolLoop(params);

    expect(mockStream).toHaveBeenCalledTimes(2);
    const second = requestAt(1);
    expect(second.tool_choice).toEqual({ type: "none" });
    expect(
      Buffer.byteLength(JSON.stringify(second), "utf8")
    ).toBeLessThanOrEqual(maxRequestBytes);
    const [shortened] = second.messages.at(-1)!.content as Array<{
      content: string;
    }>;
    expect(shortened!.content).toMatch(/Shortened to fit the request size/);
    // The assistant turn is still exactly what Claude sent.
    expect(second.messages[1]!.role).toBe("assistant");
    expect(result).toMatchObject({
      text: "Partial answer.",
      stopReason: "end_turn",
      forcedFinalAnswer: "context_limit",
    });
  });

  it("stops without calling Claude when no time is left", async () => {
    const result = await runAnthropicToolLoop(
      baseParams({ deadline: createInferenceDeadline(500) })
    );

    expect(mockStream).not.toHaveBeenCalled();
    expect(result).toMatchObject({ text: "", stopReason: "deadline" });
  });

  it("streams each step's text as the full text so far", async () => {
    scriptClaude(
      {
        content: [text("Let me check."), toolUse("tu_1", "lookup", {})],
        stop_reason: "tool_use",
      },
      { content: [text("Sunny, 21 °C.")], stop_reason: "end_turn" }
    );
    const deltas: string[] = [];

    await runAnthropicToolLoop(
      baseParams({ onTextDelta: value => void deltas.push(value) })
    );

    expect(deltas).toEqual([
      // Deltas are never trimmed: chunks split mid-whitespace.
      "Let me ",
      "Let me check.",
      "Sunny, ",
      "Sunny, 21 °C.",
    ]);
  });

  it("never runs a tool call cut off at max_tokens", async () => {
    scriptClaude({
      content: [toolUse("tu_1", "lookup", { q: "Alm" })],
      stop_reason: "max_tokens",
    });
    const params = baseParams();

    const result = await runAnthropicToolLoop(params);

    expect(params.executeTool).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("max_tokens");
  });

  it("does not use the content of a refusal", async () => {
    scriptClaude({ content: [text("partial")], stop_reason: "refusal" });

    const result = await runAnthropicToolLoop(baseParams());

    expect(result).toMatchObject({ text: "", stopReason: "refusal" });
  });

  it("fails closed when Claude is not configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    await expect(runAnthropicToolLoop(baseParams())).rejects.toMatchObject({
      reason: "not_configured",
    });
    expect(mockStream).not.toHaveBeenCalled();
  });

  it("fails closed for a non-Claude model id", async () => {
    await expect(
      runAnthropicToolLoop(baseParams({ model: "gemini-3-flash" }))
    ).rejects.toBeInstanceOf(AnthropicToolLoopUnavailableError);
  });

  it("fails closed when the workspace is billed on its own Google key", async () => {
    mockResolveBilling.mockResolvedValue({
      billingSource: "customer",
      workspaceId: "workspace-1",
    });

    await expect(runAnthropicToolLoop(baseParams())).rejects.toMatchObject({
      reason: "customer_billing",
    });
    expect(mockStream).not.toHaveBeenCalled();
  });

  it("retries a transient provider error once, then fails closed", async () => {
    const overloaded = () =>
      new InternalServerError(
        529,
        { type: "overloaded_error" },
        "Overloaded",
        new Headers()
      );
    scriptClaude(overloaded(), overloaded());

    await expect(runAnthropicToolLoop(baseParams())).rejects.toMatchObject({
      reason: "provider_failed",
      details: { httpStatus: 529, retryable: true },
    });
    expect(mockStream).toHaveBeenCalledTimes(2);
  });

  it("recovers when the retry succeeds", async () => {
    scriptClaude(
      new InternalServerError(
        529,
        { type: "overloaded_error" },
        "Overloaded",
        new Headers()
      ),
      { content: [text("Recovered.")], stop_reason: "end_turn" }
    );

    const result = await runAnthropicToolLoop(baseParams());

    expect(result.text).toBe("Recovered.");
  });

  it("meters and reserves spend for every model call", async () => {
    scriptClaude(
      { content: [toolUse("tu_1", "lookup", {})], stop_reason: "tool_use" },
      { content: [text("Done.")], stop_reason: "end_turn" }
    );

    await runAnthropicToolLoop(baseParams());

    expect(mockReserveSpend).toHaveBeenCalledTimes(2);
    expect(mockReserveSpend).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        maxOutputTokens: expect.any(Number),
      })
    );
    expect(mockSettleSpend).toHaveBeenCalledTimes(2);
    expect(mockRecordTrace).toHaveBeenCalledTimes(2);
    expect(mockRecordTrace.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        workspaceId: "workspace-1",
        conversationId: "thread-1",
        messageId: "message-1",
        traceId: "trace-1",
        operation: "airi_chat.meta_ads_mcp.agent_step",
        provider: "anthropic",
        status: "ok",
        finishReason: "tool_use",
        metadata: expect.objectContaining({
          toolLoopIteration: 1,
          toolUseCount: 1,
        }),
      }),
      expect.objectContaining({
        status: "ok",
        finishReason: "end_turn",
        outputText: "Done.",
        metadata: expect.objectContaining({ toolLoopIteration: 2 }),
      }),
    ]);
  });

  it("stops before a request that would exceed the size bound", async () => {
    const result = await runAnthropicToolLoop(
      baseParams({ maxRequestBytes: 100 })
    );

    expect(mockStream).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("context_limit");
  });

  it("propagates caller cancellation", async () => {
    const controller = new AbortController();
    scriptClaude({
      content: [toolUse("tu_1", "lookup", {})],
      stop_reason: "tool_use",
    });
    const executeTool = jest.fn(async () => {
      controller.abort();
      return { content: "ok" };
    });

    await expect(
      runAnthropicToolLoop(
        baseParams({ executeTool, signal: controller.signal })
      )
    ).rejects.toThrow();
    expect(mockStream).toHaveBeenCalledTimes(1);
  });
});
