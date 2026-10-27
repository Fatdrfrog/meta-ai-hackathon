/**
 * Native Claude tool use: a Messages API loop with client-executed tools.
 *
 * - tool_choice is always `auto` (forced `any`/`tool` is a 400 on Claude
 *   Sonnet 5.5 and Opus 5.5); the last allowed step sends `none` so the model
 *   must answer from what it gathered.
 * - History is append-only: each response's `content` is appended unchanged,
 *   so thinking blocks (and their signatures) stay valid on the next request.
 * - The system block and the last tool definition carry `cache_control`, so
 *   every step after the first reads the tools and instructions from cache.
 * - Each model call is one paid attempt: its own spend reservation, its own
 *   llm_trace analytics event, and a timeout from the caller's deadline.
 *
 * Claude only. When Claude cannot serve the loop (not configured, the
 * workspace is on its own Google key, or the provider fails) it throws
 * {@link AnthropicToolLoopUnavailableError}; there is no Gemini fallback.
 *
 * @see https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
 */

import type Anthropic from "@anthropic-ai/sdk";
import { APIConnectionTimeoutError } from "@anthropic-ai/sdk";
import {
  normalizeLlmTokenUsage,
  type LlmTokenUsage,
} from "@icecore/airi-runtime/llm-analytics";
import { recordLlmTraceAnalyticsEvent } from "@/lib/llm-analytics/events";
import type { AIChatLifecycleEvent, AIChatOptions } from "./index";
import {
  canUseAnthropicAI,
  markAnthropicUnavailableForRuntime,
} from "./anthropic-config";
import {
  buildAnthropicMessageParams,
  extractAnthropicUsage,
  getAnthropicClient,
} from "./anthropic-messages";
import { sleepWithCancellation } from "./cancellation";
import type { InferenceDeadline } from "./inference-deadline";
import { isRetryableAIProviderError } from "./provider-errors";
import { isClaudeModel } from "./text-models";
import {
  reserveWorkspaceTextAiSpend,
  resolveWorkspaceTextAiBilling,
  settleWorkspaceTextAiSpend,
} from "./workspace-ai-policy";
import { isWorkspaceAiPolicyError } from "./workspace-ai-errors";

/** Stay under the 256 KiB request bound the spend reservation accepts. */
const DEFAULT_MAX_REQUEST_BYTES = 240_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const DEFAULT_MAX_CALL_MS = 120_000;
const DEFAULT_MAX_RETRIES = 1;
const MIN_CALL_MS = 2_000;
const RETRY_DELAY_MS = 400;
const MAX_ANALYTICS_OUTPUT_CHARS = 8_000;
/** A tool result is never shortened below this many characters. */
const MIN_TRIMMED_TOOL_RESULT_CHARS = 200;
const TRIMMED_TOOL_RESULT_NOTE =
  "\n[Shortened to fit the request size limit: this result is partial. Say so in the answer.]";

/** Returned by a tool step that would run into the final-answer reserve. */
const SWITCH_TO_FINAL_ANSWER = Symbol("switch_to_final_answer");

export type AnthropicToolDefinition = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};

export type AnthropicToolUseRequest = {
  id: string;
  name: string;
  input: unknown;
};

/** What the executor returns for one tool_use block. */
export type AnthropicToolExecution = {
  content: string;
  /** Sent as `is_error: true` so the model corrects the call. */
  isError?: boolean;
};

export type AnthropicToolLoopStopReason =
  /** The model finished its answer. */
  | "end_turn"
  | "stop_sequence"
  /** The model declined; its content is not used. */
  | "refusal"
  /** Output hit max_tokens; a truncated tool call is never executed. */
  | "max_tokens"
  /** No time was left for another model call. */
  | "deadline"
  /** The next request would exceed the request size bound. */
  | "context_limit";

export type AnthropicToolLoopResult = {
  /** Text of the last model response (the answer); empty when none. */
  text: string;
  stopReason: AnthropicToolLoopStopReason;
  /**
   * Set when the loop withheld tools from the last call (`tool_choice: none`)
   * because the step budget or the deadline ran out, or because the latest
   * tool results had to be shortened to fit the request size bound: the
   * answer is final but the model was not allowed to keep collecting.
   */
  forcedFinalAnswer: "iteration_limit" | "deadline" | "context_limit" | null;
  /** Model calls made. */
  iterations: number;
  /** Tool executions requested by the model. */
  toolCalls: number;
  model: string;
  usage?: LlmTokenUsage;
  /** The append-only transcript, including the first user message. */
  messages: Anthropic.MessageParam[];
};

export type AnthropicToolLoopUnavailableReason =
  /** ANTHROPIC_API_KEY missing/disabled, or the model is not a Claude id. */
  | "not_configured"
  /** The workspace runs on its own Google key, which cannot pay for Claude. */
  | "customer_billing"
  /** Claude failed (after bounded retries) or rejected the request. */
  | "provider_failed";

export class AnthropicToolLoopUnavailableError extends Error {
  readonly code = "anthropic_tool_loop_unavailable";

  constructor(
    readonly reason: AnthropicToolLoopUnavailableReason,
    readonly details: { httpStatus?: number; retryable?: boolean } = {}
  ) {
    super(`Claude tool use is unavailable: ${reason}`);
    this.name = "AnthropicToolLoopUnavailableError";
  }
}

export type AnthropicToolLoopParams = {
  model: string;
  system: string;
  userMessage: string;
  tools: AnthropicToolDefinition[];
  executeTool: (
    call: AnthropicToolUseRequest,
    context: { iteration: number; signal?: AbortSignal }
  ) => Promise<AnthropicToolExecution>;
  /** Model calls allowed; the last one runs with `tool_choice: none`. */
  maxIterations: number;
  /** One wall-clock budget; every call's timeout comes from it. */
  deadline: InferenceDeadline;
  /**
   * Time kept for the final answer: a tool step (and its retries) never runs
   * into it, and once only this much is left the next call is the final
   * answer (`tool_choice: none`) instead of another tool step.
   */
  finalAnswerReserveMs?: number;
  /** Upper bound for one model call (default 120 s). */
  maxCallMs?: number;
  /** Visible output cap; thinking headroom is added per model. */
  maxOutputTokens?: number;
  /** Mapped to effort/thinking per model (default MEDIUM: multistep tool use). */
  thinkingLevel?: "LOW" | "MEDIUM" | "HIGH";
  signal?: AbortSignal;
  /** The current step's answer text so far (full text, never an increment). */
  onTextDelta?: (text: string) => void | Promise<void>;
  onLifecycle?: (event: AIChatLifecycleEvent) => void | Promise<void>;
  /** llm_trace attribution; one event per model call. */
  analytics?: AIChatOptions["analytics"];
  /** Same-call retries for transient provider errors before any text streamed. */
  maxRetries?: number;
  maxRequestBytes?: number;
  /** Log context for runtime availability warnings. */
  logContext?: string;
};

type ToolLoopMessage = {
  content: Anthropic.ContentBlock[];
  stop_reason: string | null;
  usage?: unknown;
};

function addUsage(
  total: LlmTokenUsage | undefined,
  next: LlmTokenUsage | undefined
): LlmTokenUsage | undefined {
  if (!next) return total;
  if (!total) return { ...next };
  const sum = (a?: number, b?: number) =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  return normalizeLlmTokenUsage({
    prompt_tokens: sum(total.prompt_tokens, next.prompt_tokens),
    completion_tokens: sum(total.completion_tokens, next.completion_tokens),
    total_tokens: sum(total.total_tokens, next.total_tokens),
    thinking_tokens: sum(total.thinking_tokens, next.thinking_tokens),
    cached_prompt_tokens: sum(
      total.cached_prompt_tokens,
      next.cached_prompt_tokens
    ),
    cache_write_prompt_tokens: sum(
      total.cache_write_prompt_tokens,
      next.cache_write_prompt_tokens
    ),
  });
}

/** Read blocks by type: a response can start with thinking blocks. */
function joinText(content: Anthropic.ContentBlock[]): string {
  return content
    .flatMap(block => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
}

function readHttpStatus(error: unknown): number | undefined {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: unknown }).status)
      : NaN;
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : undefined;
}

/** Only an application-owned label leaves this module, never provider text. */
function safeErrorLabel(error: unknown): string {
  const status = readHttpStatus(error);
  const name =
    error instanceof Error && /^[A-Za-z]{1,64}$/.test(error.name)
      ? error.name
      : "Error";
  return status ? `${name} (HTTP ${status})` : name;
}

async function emitLifecycle(
  params: AnthropicToolLoopParams,
  event: AIChatLifecycleEvent
) {
  try {
    await params.onLifecycle?.(event);
  } catch {
    /* lifecycle callbacks must not break generation */
  }
}

/** Tool definitions with a cache breakpoint on the last one (tools render first). */
export function buildAnthropicToolParams(
  tools: AnthropicToolDefinition[]
): Anthropic.Tool[] {
  return tools.map((tool, index) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
    ...(index === tools.length - 1
      ? { cache_control: { type: "ephemeral" as const } }
      : {}),
  }));
}

export async function runAnthropicToolLoop(
  params: AnthropicToolLoopParams
): Promise<AnthropicToolLoopResult> {
  params.signal?.throwIfAborted();
  const model = String(params.model || "").trim();
  if (!canUseAnthropicAI() || !isClaudeModel(model)) {
    throw new AnthropicToolLoopUnavailableError("not_configured");
  }
  // Policy errors (allowance used up, policy unavailable) propagate as is.
  const billing = await resolveWorkspaceTextAiBilling();
  params.signal?.throwIfAborted();
  if (billing?.billingSource === "customer") {
    throw new AnthropicToolLoopUnavailableError("customer_billing");
  }
  let client: Anthropic;
  try {
    client = getAnthropicClient();
  } catch {
    throw new AnthropicToolLoopUnavailableError("not_configured");
  }

  // Reuse the adapter's per-model effort/thinking/max_tokens mapping.
  const base = buildAnthropicMessageParams({
    model,
    messages: [{ role: "user", content: "." }],
    generationConfig: {
      thinkingConfig: { thinkingLevel: params.thinkingLevel ?? "MEDIUM" },
      maxOutputTokens: params.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    },
  });
  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: params.system,
      cache_control: { type: "ephemeral" },
    },
  ];
  const tools = buildAnthropicToolParams(params.tools);
  const transcript: Anthropic.MessageParam[] = [
    { role: "user", content: params.userMessage },
  ];
  const maxIterations = Math.max(1, Math.floor(params.maxIterations));
  const maxRetries = Math.max(0, params.maxRetries ?? DEFAULT_MAX_RETRIES);
  const maxRequestBytes = params.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const analyticsWorkspaceId =
    billing?.workspaceId || params.analytics?.workspaceId || null;
  let usage: LlmTokenUsage | undefined;
  let iterations = 0;
  let toolCalls = 0;
  let forcedFinalAnswer: AnthropicToolLoopResult["forcedFinalAnswer"] = null;

  const recordCall = async (details: {
    iteration: number;
    attempt: number;
    status: "ok" | "error" | "cancelled";
    latencyMs: number;
    usage?: LlmTokenUsage;
    finishReason?: string | null;
    outputText?: string;
    errorMessage?: string;
    toolUseCount?: number;
    toolChoice: "auto" | "none";
  }) => {
    if (!analyticsWorkspaceId) return;
    const cancelled = details.status === "cancelled";
    try {
      await recordLlmTraceAnalyticsEvent({
        eventTs: new Date(),
        workspaceId: analyticsWorkspaceId,
        companyId: billing?.companyId,
        actionId: billing?.actionId,
        billingSource: billing?.billingSource,
        conversationId: params.analytics?.conversationId || null,
        messageId: params.analytics?.messageId || null,
        traceId: params.analytics?.traceId || null,
        operation: params.analytics?.operation || "ai.tool_loop",
        provider: "anthropic",
        model,
        status: details.status,
        latencyMs: details.latencyMs,
        usage: details.usage,
        finishReason: details.finishReason ?? null,
        inputText: cancelled ? undefined : params.analytics?.inputText,
        outputText: cancelled
          ? undefined
          : details.outputText?.slice(0, MAX_ANALYTICS_OUTPUT_CHARS),
        errorMessage: details.errorMessage,
        sourceService: params.analytics?.sourceService || "web",
        metadata: {
          toolLoopIteration: details.iteration,
          retryAttempt: details.attempt,
          toolChoice: details.toolChoice,
          ...(details.toolUseCount !== undefined
            ? { toolUseCount: details.toolUseCount }
            : {}),
          ...(cancelled ? {} : params.analytics?.metadata || {}),
        },
      });
    } catch {
      /* analytics must not break the turn */
    }
  };

  const finalAnswerReserveMs = Math.max(0, params.finalAnswerReserveMs ?? 0);
  /** What a tool step may use: the remaining time minus the answer's reserve. */
  const toolStepBudgetMs = () =>
    params.deadline.remainingMs() - finalAnswerReserveMs;

  /**
   * One model call with bounded retries; null when the deadline ran out. A
   * tool step (`auto`) is capped at the time before the final-answer
   * reserve: when it runs out, or a retry would start inside the reserve,
   * it returns SWITCH_TO_FINAL_ANSWER and the loop answers with tools
   * withheld instead.
   */
  const callModel = async (
    request: Anthropic.MessageStreamParams,
    iteration: number,
    toolChoice: "auto" | "none"
  ): Promise<ToolLoopMessage | null | typeof SWITCH_TO_FINAL_ANSWER> => {
    const maxCallMs = params.maxCallMs ?? DEFAULT_MAX_CALL_MS;
    // Without a reserve a tool step may use all the remaining time.
    const keepsReserve = toolChoice === "auto" && finalAnswerReserveMs > 0;
    for (let attempt = 0; ; attempt += 1) {
      params.signal?.throwIfAborted();
      let timeoutMs: number | null;
      if (keepsReserve) {
        const budgetMs = toolStepBudgetMs();
        if (budgetMs < MIN_CALL_MS) return SWITCH_TO_FINAL_ANSWER;
        timeoutMs = Math.min(maxCallMs, budgetMs);
      } else {
        timeoutMs = params.deadline.nextTimeoutMs(maxCallMs, MIN_CALL_MS);
      }
      if (timeoutMs === null) return null;
      const startedAt = Date.now();
      await emitLifecycle(params, {
        type: "attempt_start",
        provider: "anthropic",
        model,
        attempt,
        fallbackIndex: 0,
      });
      const reservation = await reserveWorkspaceTextAiSpend({
        provider: "anthropic",
        model,
        request,
        maxOutputTokens: request.max_tokens,
      });
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const callSignal = params.signal
        ? AbortSignal.any([params.signal, timeoutSignal])
        : timeoutSignal;
      let streamedText = "";
      let deliveries: Promise<void> = Promise.resolve();
      try {
        const stream = client.messages.stream(request, {
          signal: callSignal,
          timeout: timeoutMs,
        });
        stream.on("text", (delta: string) => {
          if (!delta) return;
          streamedText += delta;
          const snapshot = streamedText;
          deliveries = deliveries.then(async () => {
            try {
              await params.onTextDelta?.(snapshot);
            } catch {
              /* a streaming consumer must not break generation */
            }
          });
        });
        const message = (await stream.finalMessage()) as ToolLoopMessage;
        await deliveries;
        const callUsage = extractAnthropicUsage(message.usage);
        await settleWorkspaceTextAiSpend(reservation, model, callUsage);
        params.signal?.throwIfAborted();
        const toolUseCount = message.content.filter(
          block => block.type === "tool_use"
        ).length;
        await recordCall({
          iteration,
          attempt,
          status: "ok",
          latencyMs: Date.now() - startedAt,
          usage: callUsage,
          finishReason: message.stop_reason,
          outputText: joinText(message.content),
          toolUseCount,
          toolChoice,
        });
        await emitLifecycle(params, {
          type: "attempt_success",
          provider: "anthropic",
          model,
          attempt,
          fallbackIndex: 0,
          latencyMs: Date.now() - startedAt,
        });
        usage = addUsage(usage, callUsage);
        return message;
      } catch (error) {
        await deliveries;
        try {
          await settleWorkspaceTextAiSpend(reservation, model, undefined);
        } catch (settleError) {
          if (!params.signal?.aborted) throw settleError;
        }
        if (params.signal?.aborted) {
          await recordCall({
            iteration,
            attempt,
            status: "cancelled",
            latencyMs: Date.now() - startedAt,
            toolChoice,
          });
          params.signal.throwIfAborted();
        }
        if (isWorkspaceAiPolicyError(error)) throw error;
        markAnthropicUnavailableForRuntime(
          error,
          params.logContext || "anthropic-tool-loop",
          model
        );
        const timedOut =
          timeoutSignal.aborted || error instanceof APIConnectionTimeoutError;
        const retryable = timedOut || isRetryableAIProviderError(error);
        const errorMessage = safeErrorLabel(error);
        await recordCall({
          iteration,
          attempt,
          status: "error",
          latencyMs: Date.now() - startedAt,
          errorMessage,
          toolChoice,
        });
        await emitLifecycle(params, {
          type: "attempt_error",
          provider: "anthropic",
          model,
          attempt,
          fallbackIndex: 0,
          retryable,
          errorMessage,
        });
        // A tool step that reached the reserve hands over to the answer.
        if (keepsReserve && timedOut && toolStepBudgetMs() < MIN_CALL_MS) {
          return SWITCH_TO_FINAL_ANSWER;
        }
        // A timeout that used up the turn's budget ends collection, not Claude.
        if (timedOut && params.deadline.remainingMs() < MIN_CALL_MS) {
          return null;
        }
        // Retrying after streamed text would show the user a second answer.
        if (retryable && attempt < maxRetries && !streamedText) {
          const delayMs = RETRY_DELAY_MS * 2 ** attempt;
          const retryBudgetMs = keepsReserve
            ? toolStepBudgetMs()
            : params.deadline.remainingMs();
          // A tool step is not retried into the reserve: answer instead.
          if (keepsReserve && retryBudgetMs <= delayMs + MIN_CALL_MS) {
            return SWITCH_TO_FINAL_ANSWER;
          }
          if (retryBudgetMs > delayMs + MIN_CALL_MS) {
            await emitLifecycle(params, {
              type: "retry_wait",
              provider: "anthropic",
              model,
              attempt,
              fallbackIndex: 0,
              delayMs,
            });
            await sleepWithCancellation(delayMs, params.signal);
            continue;
          }
        }
        throw new AnthropicToolLoopUnavailableError("provider_failed", {
          ...(readHttpStatus(error)
            ? { httpStatus: readHttpStatus(error) }
            : {}),
          retryable,
        });
      }
    }
  };

  const finish = (
    text: string,
    stopReason: AnthropicToolLoopStopReason
  ): AnthropicToolLoopResult => ({
    text,
    stopReason,
    forcedFinalAnswer,
    iterations,
    toolCalls,
    model,
    ...(usage ? { usage } : {}),
    messages: transcript,
  });

  const buildRequest = (
    toolChoice: "auto" | "none"
  ): Anthropic.MessageStreamParams => ({
    model,
    max_tokens: base.max_tokens,
    system,
    tools,
    tool_choice: toolChoice === "none" ? { type: "none" } : { type: "auto" },
    // A copy per request: the SDK and test doubles may keep the reference.
    messages: [...transcript],
    ...(base.thinking
      ? { thinking: base.thinking as Anthropic.ThinkingConfigParam }
      : {}),
    ...(base.output_config
      ? {
          output_config: base.output_config as Anthropic.OutputConfig,
        }
      : {}),
  });
  const requestBytes = (request: Anthropic.MessageStreamParams) =>
    Buffer.byteLength(JSON.stringify(request), "utf8");

  /**
   * Shortens the newest tool results (largest first) until the request fits
   * the size bound. Only that last user turn changes: every assistant turn,
   * thinking blocks included, stays as it was. False when it cannot fit.
   */
  const trimNewestToolResults = (): boolean => {
    const last = transcript.at(-1);
    if (
      !last ||
      last.role !== "user" ||
      !Array.isArray(last.content) ||
      !last.content.some(block => block.type === "tool_result")
    ) {
      return false;
    }
    const blocks = last.content.map(block => ({ ...block }));
    transcript[transcript.length - 1] = { role: "user", content: blocks };
    for (let pass = 0; pass < blocks.length * 2; pass += 1) {
      const excess = requestBytes(buildRequest("none")) - maxRequestBytes;
      if (excess <= 0) return true;
      let largest: Anthropic.ToolResultBlockParam | null = null;
      for (const block of blocks) {
        if (
          block.type === "tool_result" &&
          typeof block.content === "string" &&
          block.content.length > MIN_TRIMMED_TOOL_RESULT_CHARS &&
          (!largest || block.content.length > String(largest.content).length)
        ) {
          largest = block;
        }
      }
      if (!largest) break;
      const content = String(largest.content).replace(
        TRIMMED_TOOL_RESULT_NOTE,
        ""
      );
      // UTF-8 can take up to 3 bytes (escaped JSON up to 6) per character:
      // cut at least the excess, then re-measure.
      const keep = Math.max(
        MIN_TRIMMED_TOOL_RESULT_CHARS,
        content.length - Math.max(excess, 1) - TRIMMED_TOOL_RESULT_NOTE.length
      );
      largest.content = `${content.slice(0, keep)}${TRIMMED_TOOL_RESULT_NOTE}`;
    }
    return requestBytes(buildRequest("none")) <= maxRequestBytes;
  };

  let switchedToFinalAnswer = false;
  for (;;) {
    params.signal?.throwIfAborted();
    const lastStep = iterations + 1 >= maxIterations;
    const remainingMs = params.deadline.remainingMs();
    const nearDeadline =
      switchedToFinalAnswer ||
      remainingMs <= finalAnswerReserveMs ||
      (finalAnswerReserveMs > 0 &&
        remainingMs - finalAnswerReserveMs < MIN_CALL_MS);
    let toolChoice: "auto" | "none" =
      lastStep || nearDeadline ? "none" : "auto";
    // Withholding tools cuts collection short, except a one-step loop by design.
    if (nearDeadline) forcedFinalAnswer = "deadline";
    else if (lastStep && maxIterations > 1)
      forcedFinalAnswer = "iteration_limit";
    let request = buildRequest(toolChoice);
    if (requestBytes(request) > maxRequestBytes) {
      // The newest results do not fit: shorten them and answer from what
      // was gathered, instead of ending without an answer.
      if (!trimNewestToolResults()) return finish("", "context_limit");
      toolChoice = "none";
      forcedFinalAnswer = "context_limit";
      request = buildRequest(toolChoice);
    }
    iterations += 1;
    const message = await callModel(request, iterations, toolChoice);
    if (message === SWITCH_TO_FINAL_ANSWER) {
      // Nothing was appended: the transcript is unchanged and valid.
      switchedToFinalAnswer = true;
      continue;
    }
    if (!message) return finish("", "deadline");
    // Append unchanged: thinking blocks and signatures must round-trip.
    transcript.push({
      role: "assistant",
      content: message.content as Anthropic.ContentBlockParam[],
    });
    if (message.stop_reason === "refusal") return finish("", "refusal");
    const toolUses = message.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );
    const text = joinText(message.content);
    if (message.stop_reason === "pause_turn" && iterations < maxIterations)
      continue;
    if (message.stop_reason === "max_tokens") {
      // A tool input cut off at max_tokens can still parse; never run it.
      return finish(toolUses.length ? "" : text, "max_tokens");
    }
    if (!toolUses.length || toolChoice === "none") {
      return finish(
        text,
        message.stop_reason === "stop_sequence" ? "stop_sequence" : "end_turn"
      );
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      params.signal?.throwIfAborted();
      toolCalls += 1;
      const outcome = await params.executeTool(
        { id: use.id, name: use.name, input: use.input },
        { iteration: iterations, signal: params.signal }
      );
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: outcome.content,
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }
    transcript.push({ role: "user", content: results });
  }
}
