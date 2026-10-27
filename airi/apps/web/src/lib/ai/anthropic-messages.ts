/**
 * Claude Messages API adapter for platform-funded text generation.
 * Translates the Gemini-shaped `generationConfig` bag used across call sites
 * into Messages API parameters (effort, thinking, structured outputs, caps).
 *
 * @see https://platform.claude.com/docs/en/api/messages
 * @see https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 */

import Anthropic, { APIConnectionTimeoutError } from "@anthropic-ai/sdk";
import { createLogger } from "@icecore/shared/lib/logger";
import { runAfterResponse } from "@/lib/after-response-work";
import {
  reserveWorkspaceTextAiSpend,
  settleWorkspaceTextAiSpend,
} from "./workspace-ai-policy";
import {
  normalizeLlmTokenUsage,
  type LlmTokenUsage,
} from "@icecore/airi-runtime/llm-analytics";
import { isRecord } from "@icecore/shared/lib/value-utils";
import {
  getAnthropicApiKey,
  getAnthropicWorkspaceId,
} from "./anthropic-config";

const anthropicLogger = createLogger("anthropic-messages");

export type AnthropicChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type AnthropicTextRequest = {
  model: string;
  messages: AnthropicChatMessage[];
  /** Appends the JSON-only instruction (parity with the Gemini prompt). */
  forceJson?: boolean;
  /** Gemini-shaped generation config; translated per model. */
  generationConfig?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type AnthropicTextResponse = {
  text: string;
  finishReason: string | null;
  /**
   * Whole-turn spend. After a server-side fallback this sums every hop in
   * `usage.iterations` (top-level usage covers only the serving hop).
   */
  usage?: LlmTokenUsage;
  /**
   * Model that produced the message: the requested model, or the fallback
   * model when a server-side refusal fallback served the turn.
   */
  servedModel: string;
};

export type AnthropicStreamCallbacks = {
  /**
   * Text deltas in order. A server-side refusal fallback never invalidates
   * streamed text: the fallback model continues from the declined partial (it
   * receives the partial's text as continuation context), so `accumulated`
   * stays the running text of the whole turn and equals the returned text.
   */
  onDelta?: (chunk: {
    delta: string;
    accumulated: string;
  }) => void | Promise<void>;
};

type Effort = "low" | "medium" | "high";
type ThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
type ModelProfile = "legacy" | "sonnet-5-5" | "opus-5-5" | "modern";

export type AnthropicMessageParams =
  Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

const DEFAULT_MAX_TOKENS = 16_000;
const MAX_TOKENS_CEILING = 64_000;
const THINKING_HEADROOM: Record<Effort, number> = {
  low: 4_096,
  medium: 8_192,
  high: 16_384,
};
const JSON_INSTRUCTION =
  "\n\nOutput MUST be a valid JSON object only. No markdown fences.";
const FAILURE_REASON_LIMIT = 64;

// =============================================================================
// Errors
// =============================================================================

export class AnthropicEmptyContentError extends Error {
  readonly code = "anthropic_empty_content";
  readonly finishReason: string | null;
  readonly promptBlockReason: string | null = null;
  readonly usage?: LlmTokenUsage;

  constructor(params: { finishReason?: string | null; usage?: LlmTokenUsage }) {
    const finishReason =
      typeof params.finishReason === "string" && params.finishReason.trim()
        ? params.finishReason.trim().slice(0, FAILURE_REASON_LIMIT)
        : null;
    super(
      `Anthropic returned no text content${
        finishReason ? `: finishReason=${finishReason}` : ""
      }`
    );
    this.name = "AnthropicEmptyContentError";
    this.finishReason = finishReason;
    this.usage = params.usage;
  }
}

/** Carry completed spend across cancellation without retaining provider prose. */
class AnthropicCancelledUsageError extends Error {
  readonly usage: LlmTokenUsage;

  constructor(usage: LlmTokenUsage) {
    super("The operation was aborted.");
    this.name = "AbortError";
    this.usage = usage;
  }
}

/** Read only the sanitized counters retained by this adapter's errors. */
export function getAnthropicErrorUsage(
  error: unknown
): LlmTokenUsage | undefined {
  if (
    error instanceof AnthropicEmptyContentError ||
    error instanceof AnthropicCancelledUsageError
  ) {
    return error.usage;
  }
  return undefined;
}

// =============================================================================
// Model profiles
// =============================================================================

function getModelProfile(model: string): ModelProfile {
  const id = String(model || "")
    .trim()
    .toLowerCase();
  if (/^claude-sonnet-5-5(?:$|-)/.test(id)) return "sonnet-5-5";
  if (/^claude-opus-5-5(?:$|-)/.test(id)) return "opus-5-5";
  if (/^claude-(?:instant|2|3)(?:$|[-.])/.test(id)) return "legacy";
  const match = /^claude-(?:haiku|sonnet|opus)-(\d+)(?:-(\d+))?/.exec(id);
  if (match) {
    const major = Number(match[1]);
    // An 8-digit group is a snapshot date, not a minor version.
    const minor =
      match[2] && match[2].length <= 2 ? Number(match[2]) : Number.NaN;
    if (major < 4 || (major === 4 && (Number.isNaN(minor) || minor <= 5))) {
      return "legacy";
    }
  }
  return "modern";
}

/**
 * Sampling parameters (temperature/top_p/top_k) are accepted only by Claude
 * 4.5-and-earlier ids such as claude-haiku-4-5; newer models reject them.
 */
export function anthropicModelAcceptsSampling(model: string): boolean {
  return getModelProfile(model) === "legacy";
}

function readThinkingLevel(
  generationConfig: Record<string, unknown> | undefined
): ThinkingLevel | undefined {
  const thinking = generationConfig?.thinkingConfig;
  if (!thinking || typeof thinking !== "object") return undefined;
  const { thinkingLevel, thinkingBudget } = thinking as {
    thinkingLevel?: unknown;
    thinkingBudget?: unknown;
  };
  if (typeof thinkingLevel === "string") {
    const normalized = thinkingLevel.trim().toUpperCase();
    if (
      normalized === "MINIMAL" ||
      normalized === "LOW" ||
      normalized === "MEDIUM" ||
      normalized === "HIGH"
    ) {
      return normalized;
    }
  }
  if (thinkingBudget === 0) return "MINIMAL";
  return undefined;
}

function resolveThinking(
  profile: ModelProfile,
  level: ThinkingLevel | undefined
): {
  effort?: Effort;
  thinking?: { type: "between_tools" };
  thinkingOn: boolean;
} {
  if (profile === "legacy") return { thinkingOn: false };
  if (profile === "opus-5-5") {
    // Thinking is always on; effort is the only control (default medium).
    const effort: Effort =
      level === "MINIMAL" || level === "LOW"
        ? "low"
        : level === "HIGH"
          ? "high"
          : "medium";
    return { effort, thinkingOn: true };
  }
  if (profile === "sonnet-5-5" && level === "MINIMAL") {
    return {
      effort: "low",
      thinking: { type: "between_tools" },
      thinkingOn: false,
    };
  }
  const effort: Effort =
    level === "MEDIUM" ? "medium" : level === "HIGH" ? "high" : "low";
  return { effort, thinkingOn: true };
}

// =============================================================================
// Schema conversion (Gemini/OpenAPI subset -> JSON Schema for structured outputs)
// =============================================================================

const SUPPORTED_STRING_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

function normalizeSchemaType(value: unknown): string | string[] | undefined {
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (!lowered || lowered === "type_unspecified") return undefined;
    return lowered;
  }
  if (Array.isArray(value)) {
    const types = value
      .map(item => normalizeSchemaType(item))
      .filter((item): item is string => typeof item === "string");
    return types.length ? Array.from(new Set(types)) : undefined;
  }
  return undefined;
}

/**
 * Converts a Gemini `responseSchema` (OpenAPI subset with UPPERCASE types) to a
 * JSON Schema accepted by Claude structured outputs. Pure; never mutates input.
 */
export function convertGeminiSchemaToJsonSchema(
  schema: unknown
): Record<string, unknown> {
  if (!isRecord(schema)) return {};
  const out: Record<string, unknown> = {};

  let type = normalizeSchemaType(schema.type);
  if (type === undefined && (isRecord(schema.properties) || schema.required)) {
    type = "object";
  }
  const nullable = schema.nullable === true;

  if (typeof schema.title === "string") out.title = schema.title;
  if (typeof schema.description === "string") {
    out.description = schema.description;
  }

  if (Array.isArray(schema.anyOf)) {
    const variants = schema.anyOf.map(item =>
      convertGeminiSchemaToJsonSchema(item)
    );
    if (nullable && !variants.some(variant => variant.type === "null")) {
      variants.push({ type: "null" });
    }
    out.anyOf = variants;
  }
  if (Array.isArray(schema.allOf)) {
    out.allOf = schema.allOf.map(item => convertGeminiSchemaToJsonSchema(item));
  }

  if (type !== undefined) {
    if (nullable && !Array.isArray(schema.anyOf)) {
      const types = Array.isArray(type) ? type : [type];
      out.type = types.includes("null") ? types : [...types, "null"];
    } else {
      out.type = type;
    }
  }

  if (Array.isArray(schema.enum)) {
    const types = Array.isArray(out.type) ? out.type : [out.type];
    const valueTypes = types.filter(item => item !== "null");
    if (types.includes("null") && valueTypes.length > 0 && !out.anyOf) {
      // Claude rejects an enum under a type list ("Enum value 'x' does not
      // match declared type ['string', 'null']"), so null is its own branch.
      delete out.type;
      out.anyOf = [
        {
          type: valueTypes.length === 1 ? valueTypes[0] : valueTypes,
          enum: schema.enum.filter(value => value !== null),
        },
        { type: "null" },
      ];
    } else {
      const values = [...schema.enum];
      if (nullable && !values.includes(null)) values.push(null);
      out.enum = values;
    }
  }
  if ("const" in schema) out.const = schema.const;

  if (
    typeof schema.format === "string" &&
    SUPPORTED_STRING_FORMATS.has(schema.format)
  ) {
    out.format = schema.format;
  }

  if (typeof schema.$ref === "string") out.$ref = schema.$ref;
  const defs = isRecord(schema.$defs)
    ? schema.$defs
    : isRecord(schema.definitions)
      ? schema.definitions
      : undefined;
  if (defs) {
    out.$defs = Object.fromEntries(
      Object.entries(defs).map(([key, value]) => [
        key,
        convertGeminiSchemaToJsonSchema(value),
      ])
    );
  }

  if (schema.items !== undefined) {
    out.items = convertGeminiSchemaToJsonSchema(schema.items);
  }

  const types = Array.isArray(out.type) ? out.type : [out.type];
  if (types.includes("object") || isRecord(schema.properties)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    out.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [
        key,
        convertGeminiSchemaToJsonSchema(value),
      ])
    );
    if (Array.isArray(schema.required)) {
      out.required = schema.required.filter(
        (key): key is string =>
          typeof key === "string" &&
          Object.prototype.hasOwnProperty.call(properties, key)
      );
    }
    out.additionalProperties = false;
  }

  return out;
}

/**
 * Structured outputs require `additionalProperties: false` on every object, so
 * a free-form map (object without properties) cannot be expressed. Such
 * schemas fall back to the prompt-level JSON instruction.
 */
function schemaHasFreeFormObject(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(schemaHasFreeFormObject);
  if (!isRecord(schema)) return false;
  const type = normalizeSchemaType(schema.type);
  const types = Array.isArray(type) ? type : [type];
  if (
    types.includes("object") &&
    (!isRecord(schema.properties) ||
      Object.keys(schema.properties).length === 0)
  ) {
    return true;
  }
  return Object.entries(schema).some(
    ([key, value]) =>
      key !== "enum" && key !== "const" && schemaHasFreeFormObject(value)
  );
}

// =============================================================================
// Request building
// =============================================================================

function buildPrompt(
  messages: AnthropicChatMessage[],
  forceJson: boolean
): { system: string; user: string } {
  const system = messages
    .filter(m => m.role === "system")
    .map(m => m.content.trim())
    .filter(Boolean)
    .join("\n\n");
  // Same flattened dialogue as the Gemini prompt; one user turn, never a
  // trailing assistant turn (prefill is rejected on current models).
  const dialogue = messages
    .filter(m => m.role !== "system")
    .map(m => `${m.role.toUpperCase()}:\n${m.content.trim()}`)
    .join("\n\n");
  const jsonInstruction = forceJson ? JSON_INSTRUCTION : "";

  if (!dialogue) {
    return { system: "", user: `${system}${jsonInstruction}`.trim() };
  }
  return { system, user: `${dialogue}${jsonInstruction}`.trim() };
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : undefined;
}

function readStopSequences(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sequences = value.filter(
    (item): item is string => typeof item === "string" && item.length > 0
  );
  return sequences.length ? sequences : undefined;
}

function readNumber(
  config: Record<string, unknown>,
  keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = config[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** Builds Messages API params from the provider-neutral request (exported for tests). */
export function buildAnthropicMessageParams(
  request: Pick<
    AnthropicTextRequest,
    "model" | "messages" | "forceJson" | "generationConfig"
  >
): AnthropicMessageParams {
  const config = request.generationConfig ?? {};
  const profile = getModelProfile(request.model);
  const forceJson =
    request.forceJson === true ||
    config.responseMimeType === "application/json";
  const prompt = buildPrompt(request.messages, forceJson);
  const { effort, thinking, thinkingOn } = resolveThinking(
    profile,
    readThinkingLevel(config)
  );

  const visibleCap = positiveInt(config.maxOutputTokens);
  const base = visibleCap ?? DEFAULT_MAX_TOKENS;
  const maxTokens =
    thinkingOn && effort
      ? Math.min(MAX_TOKENS_CEILING, base + THINKING_HEADROOM[effort])
      : Math.min(MAX_TOKENS_CEILING, base);

  const params: AnthropicMessageParams = {
    model: request.model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt.user }],
  };

  if (prompt.system) {
    params.system = [
      {
        type: "text",
        text: prompt.system,
        cache_control: { type: "ephemeral" },
      },
    ];
  }

  const stopSequences = readStopSequences(config.stopSequences);
  if (stopSequences) params.stop_sequences = stopSequences;

  if (profile === "legacy") {
    const temperature = readNumber(config, ["temperature"]);
    const topP = readNumber(config, ["topP", "top_p"]);
    const topK = readNumber(config, ["topK", "top_k"]);
    // Claude 4.x accepts at most one of temperature/top_p.
    if (temperature !== undefined) {
      params.temperature = Math.min(1, Math.max(0, temperature));
    } else if (topP !== undefined) {
      params.top_p = Math.min(1, Math.max(0, topP));
    }
    if (topK !== undefined && topK >= 1) params.top_k = Math.floor(topK);
  }

  if (thinking) params.thinking = thinking;

  const sourceSchema = config.responseSchema ?? config.responseJsonSchema;
  const outputConfig: NonNullable<AnthropicMessageParams["output_config"]> = {};
  if (effort) outputConfig.effort = effort;
  if (isRecord(sourceSchema) && !schemaHasFreeFormObject(sourceSchema)) {
    outputConfig.format = {
      type: "json_schema",
      schema: convertGeminiSchemaToJsonSchema(sourceSchema),
    };
  }
  if (Object.keys(outputConfig).length > 0) {
    params.output_config = outputConfig;
  }

  return params;
}

// =============================================================================
// Execution
// =============================================================================

let cachedClient: {
  apiKey: string;
  workspaceId: string;
  client: Anthropic;
} | null = null;

/** The shared SDK client (workspace header, no SDK retries); reused by the tool loop. */
export function getAnthropicClient(): Anthropic {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  const workspaceId = getAnthropicWorkspaceId();
  if (
    !cachedClient ||
    cachedClient.apiKey !== apiKey ||
    cachedClient.workspaceId !== workspaceId
  ) {
    // Our provider loop owns retries, deadlines and model fallback.
    cachedClient = {
      apiKey,
      workspaceId,
      client: new Anthropic({
        apiKey,
        maxRetries: 0,
        ...(workspaceId
          ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } }
          : {}),
      }),
    };
  }
  return cachedClient.client;
}

type UsageCounters = {
  input?: number;
  cacheRead?: number;
  cacheCreation?: number;
  output?: number;
};

function countTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function readUsageCounters(usage: Record<string, unknown>): UsageCounters {
  return {
    input: countTokens(usage.input_tokens),
    cacheRead: countTokens(usage.cache_read_input_tokens),
    cacheCreation: countTokens(usage.cache_creation_input_tokens),
    output: countTokens(usage.output_tokens),
  };
}

function addCount(
  a: number | undefined,
  b: number | undefined
): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

/**
 * After a server-side fallback, top-level usage covers only the serving hop
 * and `usage.iterations` is the per-hop source of truth: declined hops are
 * `message` entries and the serving hop is `fallback_message`, so the turn's
 * spend is their sum. Without a `fallback_message` entry, top-level usage is
 * already complete and is used as is.
 */
function readFallbackTurnCounters(
  iterations: unknown
): UsageCounters | undefined {
  if (!Array.isArray(iterations)) return undefined;
  const entries = iterations.filter(isRecord);
  if (!entries.some(entry => entry.type === "fallback_message")) {
    return undefined;
  }
  return entries
    .filter(
      entry => entry.type === "message" || entry.type === "fallback_message"
    )
    .map(readUsageCounters)
    .reduce<UsageCounters>(
      (total, item) => ({
        input: addCount(total.input, item.input),
        cacheRead: addCount(total.cacheRead, item.cacheRead),
        cacheCreation: addCount(total.cacheCreation, item.cacheCreation),
        output: addCount(total.output, item.output),
      }),
      {}
    );
}

export function extractAnthropicUsage(
  usage: unknown
): LlmTokenUsage | undefined {
  if (!isRecord(usage)) return undefined;
  const { input, cacheRead, cacheCreation, output } =
    readFallbackTurnCounters(usage.iterations) ?? readUsageCounters(usage);
  const hasPrompt =
    input !== undefined ||
    cacheRead !== undefined ||
    cacheCreation !== undefined;
  const prompt = hasPrompt
    ? (input ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0)
    : undefined;
  return normalizeLlmTokenUsage({
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens:
      prompt !== undefined || output !== undefined
        ? (prompt ?? 0) + (output ?? 0)
        : undefined,
    cached_prompt_tokens: cacheRead,
    cache_write_prompt_tokens: cacheCreation,
  });
}

/**
 * Joins every text block. Across a server-side `fallback` block this is the
 * turn's answer: a non-streaming mid-output decline omits the declined partial
 * entirely, and a streamed one keeps it as the prefix the fallback model
 * continues from (the API passes the partial's text as continuation context).
 */
function joinTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string"
    )
    .map(block => block.text)
    .join("");
}

function buildAbortScope(request: AnthropicTextRequest) {
  const timeoutSignal = request.timeoutMs
    ? AbortSignal.timeout(request.timeoutMs)
    : undefined;
  const signals = [request.signal, timeoutSignal].filter(
    (signal): signal is AbortSignal => Boolean(signal)
  );
  const signal =
    signals.length > 1 ? AbortSignal.any(signals) : (signals[0] ?? undefined);
  return { signal, timeoutSignal };
}

function timeoutError(): Error {
  return Object.assign(new Error("Anthropic request timeout"), {
    name: "AnthropicTimeoutError",
  });
}

type MessageLike = {
  content: unknown;
  stop_reason?: string | null;
  usage?: unknown;
  model?: string | null;
};

/** The subset of MessageStream / BetaMessageStream this adapter uses. */
type TextMessageStream = {
  on(
    event: "text",
    listener: (delta: string, snapshot: string) => void
  ): unknown;
  on(
    event: "streamEvent",
    listener: (event: unknown, snapshot: { usage?: unknown }) => void
  ): unknown;
  finalMessage(): Promise<MessageLike>;
};

function finalizeMessage(
  request: AnthropicTextRequest,
  message: MessageLike
): AnthropicTextResponse {
  const usage = extractAnthropicUsage(message.usage);
  if (request.signal?.aborted) {
    if (usage) throw new AnthropicCancelledUsageError(usage);
    request.signal.throwIfAborted();
  }
  const finishReason = message.stop_reason ?? null;
  const text = joinTextBlocks(message.content).trim();
  if (finishReason === "refusal" || !text) {
    anthropicLogger.warn("messages returned no usable text", {
      model: request.model,
      finishReason,
      usage,
    });
    throw new AnthropicEmptyContentError({ finishReason, usage });
  }
  const reportedModel =
    typeof message.model === "string" ? message.model.trim() : "";
  return {
    text,
    finishReason,
    usage,
    // Top-level `model` names the serving model; trust it only when a
    // fallback served, so a normal turn keeps the requested id.
    servedModel:
      reportedModel && hasServedFallback(message)
        ? reportedModel
        : request.model,
  };
}

/** `fallback_message` in usage.iterations also covers sticky-served turns. */
function hasServedFallback(message: MessageLike): boolean {
  const iterations = isRecord(message.usage)
    ? message.usage.iterations
    : undefined;
  if (
    Array.isArray(iterations) &&
    iterations.some(
      entry => isRecord(entry) && entry.type === "fallback_message"
    )
  ) {
    return true;
  }
  return (
    Array.isArray(message.content) &&
    message.content.some(block => isRecord(block) && block.type === "fallback")
  );
}

/**
 * Generates text with Claude. With `callbacks.onDelta` the streaming endpoint
 * is used and text deltas are delivered untrimmed and in order.
 *
 * The facade owns retries and model fallback so each paid attempt has a
 * separate reservation. Provider-side fallbacks would bypass that boundary.
 */
export async function generateAnthropicText(
  request: AnthropicTextRequest,
  callbacks?: AnthropicStreamCallbacks
): Promise<AnthropicTextResponse> {
  request.signal?.throwIfAborted();
  const client = getAnthropicClient();
  const params = buildAnthropicMessageParams(request);
  const { signal, timeoutSignal } = buildAbortScope(request);
  const requestOptions = {
    ...(signal ? { signal } : {}),
    ...(request.timeoutMs ? { timeout: request.timeoutMs } : {}),
  };

  const runRequest = async (): Promise<AnthropicTextResponse> => {
    if (callbacks?.onDelta) {
      const onDelta = callbacks.onDelta;
      const stream: TextMessageStream = client.messages.stream(
        params as Anthropic.MessageStreamParams,
        requestOptions
      );
      let accumulated = "";
      let deliveries: Promise<void> = Promise.resolve();
      stream.on("text", (delta: string) => {
        if (!delta) return;
        // Never trim per chunk: deltas split mid-whitespace.
        accumulated += delta;
        const chunk = { delta, accumulated };
        deliveries = deliveries.then(async () => {
          try {
            await onDelta(chunk);
          } catch {
            /* callback failures must not break generation */
          }
        });
      });
      const message = await stream.finalMessage();
      await deliveries;
      return finalizeMessage(request, message);
    }

    const message = await client.messages.create(
      params as Anthropic.MessageCreateParamsNonStreaming,
      requestOptions
    );
    return finalizeMessage(request, message as MessageLike);
  };

  const runOnce = async (): Promise<AnthropicTextResponse> => {
    const reservation = await reserveWorkspaceTextAiSpend({
      provider: "anthropic",
      model: request.model,
      request: params,
      maxOutputTokens: params.max_tokens,
    });
    // The reservation already holds the call's maximum cost, so the settle
    // (a database round trip) runs after the response instead of before it.
    let response: AnthropicTextResponse;
    try {
      response = await runRequest();
    } catch (error) {
      const usage = getAnthropicErrorUsage(error);
      runAfterResponse("ai_spend_settle", () =>
        settleWorkspaceTextAiSpend(reservation, request.model, usage)
      );
      throw error;
    }
    runAfterResponse("ai_spend_settle", () =>
      settleWorkspaceTextAiSpend(
        reservation,
        response.servedModel || request.model,
        response.usage
      )
    );
    return response;
  };

  try {
    return await runOnce();
  } catch (error) {
    if (request.signal?.aborted) {
      const usage = getAnthropicErrorUsage(error);
      if (usage) throw new AnthropicCancelledUsageError(usage);
      request.signal.throwIfAborted();
    }
    if (timeoutSignal?.aborted || error instanceof APIConnectionTimeoutError) {
      throw timeoutError();
    }
    throw error;
  }
}

/**
 * Test-only: drop the cached client so a mocked SDK is re-instantiated.
 */
export function resetAnthropicClientForTesting(): void {
  cachedClient = null;
}
