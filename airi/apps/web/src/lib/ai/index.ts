import { isWorkspaceAiPolicyError } from "@/lib/ai/workspace-ai-errors";
/**
 * AI facade: embeddings (Vertex + optional GCP gateway), chat (`chatCompletionWithFallback`), utilities.
 *
 * @see https://cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-text-embeddings
 * @see https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference
 */

import "server-only";
import {
  mergeCurrentRunMetadata,
  messagePreview,
  setCurrentRunUsageMetadata,
  traceableChain,
  traceableLlm,
} from "@/lib/observability/tracing";

export {
  buildEmbeddingMetadata,
  getCurrentEmbeddingMetadata,
  getDocumentEmbeddingResult,
  getDocumentEmbeddingResultsBatch,
  getQueryEmbeddingWithCache,
  isEmbeddingMetadataCurrent,
} from "./embeddings";

const DEFAULT_TEXT_PREVIEW_LENGTH = 100;

// =============================================================================
// CHAT COMPLETION WITH PROVIDER FALLBACK
// =============================================================================

import {
  canUseVertexAI,
  markVertexUnavailableForRuntime,
} from "./vertex-config";
import {
  canUseAnthropicAI,
  markAnthropicUnavailableForRuntime,
} from "./anthropic-config";
import {
  anthropicModelAcceptsSampling,
  AnthropicEmptyContentError,
  generateAnthropicText,
  getAnthropicErrorUsage,
  type AnthropicTextRequest,
} from "./anthropic-messages";
import {
  getHeavyTextModel,
  getStructuredJsonGenerationConfig,
  isClaudeModel,
  resolveTextModelForProvider,
  type TextModelProvider,
} from "./text-models";
import { canUseTextAI } from "./text-provider-config";
import { sleepWithCancellation } from "./cancellation";
import {
  AIChatProviderAggregateError,
  isRetryableAIProviderError,
  type AIChatProviderErrorComponent,
} from "./provider-errors";
import { resolveWorkspaceTextAiBilling } from "./workspace-ai-policy";
import { recordLlmTraceAnalyticsEvent } from "@/lib/llm-analytics/events";
import type {
  BuildLlmTraceEventParams,
  LlmTokenUsage,
} from "@icecore/airi-runtime/llm-analytics";
import {
  extractVertexGeminiUsage,
  generateVertexGeminiContentResponse,
  getVertexChatModel,
  getVertexGeminiErrorUsage,
  normalizeVertexGeminiGenerationConfig,
  streamVertexGeminiContentResponse,
  VertexGeminiEmptyContentError,
} from "./vertex-gemini-rest";

export type AIChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/** "anthropic" and "vertex" are platform-funded; "google" is a customer BYO key. */
export type AIChatProvider = TextModelProvider;

export {
  AIChatProviderAggregateError,
  isRetryableAIProviderError,
  type AIChatProviderErrorComponent,
} from "./provider-errors";

export type AIChatResult = {
  content: string;
  provider: AIChatProvider;
  /** Model that served the answer (a server-side refusal fallback may differ from the attempted model). */
  model: string;
  latencyMs: number;
  finishReason?: string | null;
  usage?: LlmTokenUsage;
};

export type AIChatDeltaEvent = {
  /** Incremental text chunk emitted by the model. */
  delta: string;
  /**
   * Full accumulated text up to and including this delta. A Claude
   * server-side refusal fallback continues the same text (the fallback model
   * resumes from the declined partial), so this never restarts mid-stream.
   */
  accumulated: string;
};

export type AIChatLifecycleEvent =
  | {
      type: "attempt_start";
      provider: AIChatProvider;
      model: string;
      attempt: number;
      fallbackIndex: number;
    }
  | {
      type: "attempt_success";
      provider: AIChatProvider;
      model: string;
      attempt: number;
      fallbackIndex: number;
      latencyMs: number;
    }
  | {
      type: "attempt_error";
      provider: AIChatProvider;
      model: string;
      attempt: number;
      fallbackIndex: number;
      retryable: boolean;
      errorMessage: string;
    }
  | {
      type: "retry_wait";
      provider: AIChatProvider;
      model: string;
      attempt: number;
      fallbackIndex: number;
      delayMs: number;
    }
  | {
      type: "model_fallback";
      provider: AIChatProvider;
      fromModel: string;
      toModel: string;
      fallbackIndex: number;
    };

export type AIChatOptions = {
  messages: AIChatMessage[];
  /** Caller cancellation propagates through every attempt and retry wait. */
  signal?: AbortSignal;
  model?: string;
  temperature?: number;
  responseFormat?: { type: "json_object" };
  generationConfig?: Record<string, unknown>;
  providerOrder?: AIChatProvider[];
  resilience?: {
    /**
     * Retries transient provider failures per model. A streaming call retries
     * only until its first delta is delivered: after that the partial answer
     * may already be visible, so a failure moves on to the next fallback.
     */
    maxRetries?: number;
    initialRetryDelayMs?: number;
    maxRetryDelayMs?: number;
    fallbackModels?: string[];
    /**
     * Restrict this call to its primary model. Same-model retries remain
     * controlled separately by maxRetries.
     */
    disableInternalFallbacks?: boolean;
    /** Total deadline shared by all attempts and model fallbacks for this call. */
    timeoutMs?: number;
  };
  trace?: boolean;
  analytics?: {
    workspaceId?: string | null;
    conversationId?: string | null;
    messageId?: string | null;
    traceId?: string | null;
    operation?: string | null;
    inputText?: string | null;
    sourceService?: string | null;
    metadata?: Record<string, unknown> | null;
  };
  /**
   * When provided, the provider uses its streaming endpoint (where supported)
   * and invokes this callback for each incremental text chunk. The final
   * aggregated text is still returned from the function. Supported by every
   * provider (`anthropic`, `vertex`, `google`).
   */
  onDelta?: (event: AIChatDeltaEvent) => void | Promise<void>;
  onLifecycle?: (event: AIChatLifecycleEvent) => void | Promise<void>;
};

function readAIChatSessionIdentity(analytics: AIChatOptions["analytics"]) {
  const conversationId = analytics?.conversationId || undefined;
  const workspaceId = analytics?.workspaceId || undefined;
  return {
    ...(conversationId ? { conversationId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };
}

const DEFAULT_PLATFORM_PROVIDER_ORDER: AIChatProvider[] = [
  "anthropic",
  "vertex",
];

/**
 * Platform provider order from AI_CHAT_PROVIDER_ORDER (comma list of
 * "anthropic"/"vertex"), default Claude first with Vertex Gemini as the
 * outage fallback.
 */
export function getConfiguredAIChatProviderOrder(): AIChatProvider[] {
  const configured = Array.from(
    new Set(
      String(process.env.AI_CHAT_PROVIDER_ORDER || "")
        .split(",")
        .map(item => item.trim().toLowerCase())
        .filter(
          (item): item is "anthropic" | "vertex" =>
            item === "anthropic" || item === "vertex"
        )
    )
  );
  return configured.length > 0
    ? configured
    : [...DEFAULT_PLATFORM_PROVIDER_ORDER];
}

export function getDefaultAIChatProviderOrder(): AIChatProvider[] {
  if (!canUseTextAI()) return [];
  return getConfiguredAIChatProviderOrder().filter(
    provider => provider !== "anthropic" || canUseAnthropicAI()
  );
}

const DEFAULT_CHAT_MAX_RETRIES = Math.max(
  0,
  Number(process.env.AI_CHAT_MAX_RETRIES || 2)
);
const DEFAULT_CHAT_INITIAL_RETRY_DELAY_MS = Math.max(
  25,
  Number(process.env.AI_CHAT_INITIAL_RETRY_DELAY_MS || 250)
);
const DEFAULT_CHAT_MAX_RETRY_DELAY_MS = Math.max(
  DEFAULT_CHAT_INITIAL_RETRY_DELAY_MS,
  Number(process.env.AI_CHAT_MAX_RETRY_DELAY_MS || 2_000)
);
const DEFAULT_CHAT_TIMEOUT_MS = 30_000;
/**
 * A provider followed by another usable provider may spend at most this share
 * of the remaining call deadline, so the outage fallback keeps >= 35%.
 */
const NON_FINAL_PROVIDER_DEADLINE_SHARE = 0.65;

function normalizeModelList(
  models: Array<string | null | undefined>
): string[] {
  return Array.from(
    new Set(models.map(model => String(model || "").trim()).filter(Boolean))
  );
}

function getConfiguredFallbackModels(): string[] {
  return normalizeModelList(
    [
      process.env.AI_CHAT_FALLBACK_MODELS,
      process.env.VERTEX_FALLBACK_MODEL,
    ].flatMap(value =>
      String(value || "")
        .split(",")
        .map(item => item.trim())
    )
  );
}

/** Candidate models for one provider; ids from the other family are mapped. */
function buildProviderModelCandidates(
  options: AIChatOptions,
  provider: AIChatProvider
): string[] {
  const primaryModel =
    (options.model && String(options.model).trim()) || getVertexChatModel();
  const models =
    options.resilience?.disableInternalFallbacks === true
      ? [primaryModel]
      : [
          primaryModel,
          ...(options.resilience?.fallbackModels || []),
          ...getConfiguredFallbackModels(),
          getVertexChatModel(),
        ];

  return normalizeModelList(
    normalizeModelList(models).map(model =>
      resolveTextModelForProvider(model, provider)
    )
  );
}

function isSameJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord).filter(key => aRecord[key] !== undefined);
  const bKeys = Object.keys(bRecord).filter(key => bRecord[key] !== undefined);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(key => isSameJsonValue(aRecord[key], bRecord[key]))
  );
}

/**
 * Call sites merge `getStructuredJsonGenerationConfig(model)` for the model
 * they asked for. When this attempt runs another model family (Claude <->
 * Gemini fallback), a thinking config that came from that tier helper is
 * re-derived for the attempt's model so each family keeps its own structured
 * JSON thinking level. Explicitly chosen thinking configs are left alone.
 */
function adaptCallerGenerationConfigForModel(
  callerConfig: Record<string, unknown> | undefined,
  requestedModel: string | undefined,
  attemptModel: string
): Record<string, unknown> {
  if (!callerConfig) return {};
  const requested = String(requestedModel || "").trim();
  if (
    !requested ||
    callerConfig.thinkingConfig === undefined ||
    isClaudeModel(requested) === isClaudeModel(attemptModel) ||
    !isSameJsonValue(
      callerConfig.thinkingConfig,
      getStructuredJsonGenerationConfig(requested).thinkingConfig
    )
  ) {
    return callerConfig;
  }
  const adapted = { ...callerConfig };
  const attemptThinkingConfig =
    getStructuredJsonGenerationConfig(attemptModel).thinkingConfig;
  if (attemptThinkingConfig === undefined) delete adapted.thinkingConfig;
  else adapted.thinkingConfig = attemptThinkingConfig;
  return adapted;
}

function canUseChatProvider(provider: AIChatProvider): boolean {
  if (provider === "anthropic") return canUseAnthropicAI();
  if (provider === "vertex") return canUseVertexAI();
  // "google" runs only on customer billing, whose key resolves per request.
  return true;
}

function getEmptyContentError(
  error: unknown
): VertexGeminiEmptyContentError | AnthropicEmptyContentError | null {
  return error instanceof VertexGeminiEmptyContentError ||
    error instanceof AnthropicEmptyContentError
    ? error
    : null;
}

/** Sanitized usage carried by any text provider error (spend survives failures). */
export function getTextProviderErrorUsage(
  error: unknown
): LlmTokenUsage | undefined {
  return getVertexGeminiErrorUsage(error) ?? getAnthropicErrorUsage(error);
}

function boundedProviderModel(value: string): string {
  return value.trim().slice(0, 128) || "unknown";
}

function buildProviderErrorComponent(input: {
  provider: AIChatProvider;
  model: string;
  attempt: number;
  fallbackIndex: number;
  retryable: boolean;
  error: unknown;
}): AIChatProviderErrorComponent {
  const emptyContentError = getEmptyContentError(input.error);
  const status =
    input.error && typeof input.error === "object" && "status" in input.error
      ? input.error.status
      : null;
  return {
    provider: input.provider,
    model: boundedProviderModel(input.model),
    attempt: input.attempt,
    fallbackIndex: input.fallbackIndex,
    retryable: input.retryable,
    finishReason: emptyContentError?.finishReason ?? null,
    promptBlockReason: emptyContentError?.promptBlockReason ?? null,
    httpStatus:
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 400 &&
      status <= 599
        ? status
        : null,
  };
}

function getRetryDelayMs(params: {
  attempt: number;
  initialDelayMs: number;
  maxDelayMs: number;
}): number {
  const exponential = params.initialDelayMs * 2 ** params.attempt;
  const capped = Math.min(params.maxDelayMs, exponential);
  const jitter = Math.floor(Math.random() * Math.max(1, capped * 0.25));
  return capped + jitter;
}

async function emitLifecycle(
  options: AIChatOptions,
  event: AIChatLifecycleEvent
) {
  try {
    await options.onLifecycle?.(event);
  } catch {
    /* lifecycle callbacks must not break generation */
  }
}

function buildVertexPrompt(
  messages: AIChatMessage[],
  forceJson: boolean
): string {
  const system = messages
    .filter(m => m.role === "system")
    .map(m => m.content.trim())
    .filter(Boolean)
    .join("\n\n");

  const dialogue = messages
    .filter(m => m.role !== "system")
    .map(m => `${m.role.toUpperCase()}:\n${m.content.trim()}`)
    .join("\n\n");

  const jsonInstruction = forceJson
    ? "\n\nOutput MUST be a valid JSON object only. No markdown fences."
    : "";

  return `${system ? `SYSTEM INSTRUCTIONS:\n${system}\n\n` : ""}${dialogue}${jsonInstruction}`.trim();
}

type VertexChatAttemptInput = {
  request: Parameters<typeof generateVertexGeminiContentResponse>[0];
  onDelta?: AIChatOptions["onDelta"];
  observability: {
    provider: AIChatProvider;
    analytics?: AIChatOptions["analytics"];
    attempt: number;
    fallbackIndex: number;
    responseFormat?: AIChatOptions["responseFormat"];
    temperature?: number;
  };
};

async function executeVertexChatAttemptImpl(input: VertexChatAttemptInput) {
  const startedAt = Date.now();
  let response: Awaited<ReturnType<typeof generateVertexGeminiContentResponse>>;
  try {
    response = input.onDelta
      ? await streamVertexGeminiContentResponse(input.request, {
          onDelta: async chunk => {
            try {
              await input.onDelta?.({
                delta: chunk.delta,
                accumulated: chunk.accumulated,
              });
            } catch {
              /* callback errors must not break generation */
            }
          },
        })
      : await generateVertexGeminiContentResponse(input.request);
  } catch (error) {
    recordAttemptUsage(getVertexGeminiErrorUsage(error));
    throw error;
  }
  const usage = extractVertexGeminiUsage(response.raw);

  mergeCurrentRunMetadata({
    fallback_index: input.observability.fallbackIndex,
    finish_reason: response.finishReason ?? null,
    latency_ms: Date.now() - startedAt,
    model: input.request.model,
    outcome: "success",
    provider: input.observability.provider,
    retry_count: input.observability.attempt,
  });
  recordAttemptUsage(usage);

  return response;
}

function recordAttemptUsage(usage: LlmTokenUsage | undefined): void {
  setCurrentRunUsageMetadata(
    usage
      ? {
          input_tokens: usage.prompt_tokens,
          output_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
          ...(usage.cached_prompt_tokens !== undefined
            ? {
                input_token_details: {
                  cached_tokens: usage.cached_prompt_tokens,
                },
              }
            : {}),
          ...(usage.thinking_tokens !== undefined
            ? {
                output_token_details: {
                  reasoning_tokens: usage.thinking_tokens,
                },
              }
            : {}),
        }
      : undefined
  );
}

const executeVertexChatAttempt = traceableLlm(executeVertexChatAttemptImpl, {
  name: "gemini.generate_content",
  tags: ["ai", "llm", "gemini"],
  getMetadata: input => ({
    operation: `${input.observability.analytics?.operation || "chat_completion"}.provider_attempt`,
    source_service: input.observability.analytics?.sourceService || "web",
    model: input.request.model,
    provider: input.observability.provider,
    response_format: input.observability.responseFormat?.type || null,
    ...(typeof input.observability.temperature === "number"
      ? { temperature: input.observability.temperature }
      : {}),
    fallback_index: input.observability.fallbackIndex,
    retry_count: input.observability.attempt,
  }),
  getSessionIdentity: input =>
    readAIChatSessionIdentity(input.observability.analytics),
});

type AnthropicChatAttemptInput = {
  request: AnthropicTextRequest;
  onDelta?: AIChatOptions["onDelta"];
  observability: VertexChatAttemptInput["observability"];
};

async function executeAnthropicChatAttemptImpl(
  input: AnthropicChatAttemptInput
) {
  const startedAt = Date.now();
  let response: Awaited<ReturnType<typeof generateAnthropicText>>;
  try {
    response = await generateAnthropicText(
      input.request,
      input.onDelta ? { onDelta: input.onDelta } : undefined
    );
  } catch (error) {
    recordAttemptUsage(getAnthropicErrorUsage(error));
    throw error;
  }

  mergeCurrentRunMetadata({
    fallback_index: input.observability.fallbackIndex,
    finish_reason: response.finishReason ?? null,
    latency_ms: Date.now() - startedAt,
    model: response.servedModel || input.request.model,
    outcome: "success",
    provider: input.observability.provider,
    retry_count: input.observability.attempt,
  });
  recordAttemptUsage(response.usage);

  return response;
}

const executeAnthropicChatAttempt = traceableLlm(
  executeAnthropicChatAttemptImpl,
  {
    name: "anthropic.messages",
    tags: ["ai", "llm", "anthropic"],
    getMetadata: input => ({
      operation: `${input.observability.analytics?.operation || "chat_completion"}.provider_attempt`,
      source_service: input.observability.analytics?.sourceService || "web",
      model: input.request.model,
      provider: input.observability.provider,
      response_format: input.observability.responseFormat?.type || null,
      ...(typeof input.observability.temperature === "number"
        ? { temperature: input.observability.temperature }
        : {}),
      fallback_index: input.observability.fallbackIndex,
      retry_count: input.observability.attempt,
    }),
    getSessionIdentity: input =>
      readAIChatSessionIdentity(input.observability.analytics),
  }
);

type ProviderAttemptResult = {
  content: string;
  finishReason: string | null;
  usage?: LlmTokenUsage;
  /** Serving model when it differs from the attempted one (Claude fallback). */
  servedModel?: string;
};

/**
 * Chat completion across text providers: Claude (`anthropic`) first, Vertex
 * Gemini as the outage fallback; customer-billed calls stay on Gemini (`google`).
 */
async function chatCompletionWithFallbackImpl(
  options: AIChatOptions
): Promise<AIChatResult> {
  options.signal?.throwIfAborted();
  const {
    messages,
    temperature = 0.2,
    responseFormat,
    providerOrder,
  } = options;

  if (!messages || messages.length === 0) {
    throw new Error("messages are required for chatCompletionWithFallback");
  }

  const billing = await resolveWorkspaceTextAiBilling();
  options.signal?.throwIfAborted();
  const customerBilled = billing?.billingSource === "customer";
  const errors: AIChatProviderErrorComponent[] = [];

  const requestedAnalyticsWorkspace = options.analytics?.workspaceId?.trim();
  if (
    billing?.workspaceId &&
    requestedAnalyticsWorkspace &&
    billing.workspaceId !== requestedAnalyticsWorkspace
  ) {
    throw new Error(
      "Analytics workspace must match the admitted AI workspace."
    );
  }
  const analyticsWorkspaceId =
    billing?.workspaceId || requestedAnalyticsWorkspace;
  const forceJson = responseFormat?.type === "json_object";
  const promptForAnalytics = buildVertexPrompt(messages, forceJson);
  const maxRetries = Math.max(
    0,
    options.resilience?.maxRetries ?? DEFAULT_CHAT_MAX_RETRIES
  );
  // Same-model retries stop once any delta reached the caller.
  let deltaDelivered = false;
  const callerOnDelta = options.onDelta;
  const onDelta: AIChatOptions["onDelta"] = callerOnDelta
    ? event => {
        deltaDelivered = true;
        return callerOnDelta(event);
      }
    : undefined;
  const initialRetryDelayMs = Math.max(
    25,
    options.resilience?.initialRetryDelayMs ??
      DEFAULT_CHAT_INITIAL_RETRY_DELAY_MS
  );
  const maxRetryDelayMs = Math.max(
    initialRetryDelayMs,
    options.resilience?.maxRetryDelayMs ?? DEFAULT_CHAT_MAX_RETRY_DELAY_MS
  );
  const timeoutMs = Math.max(
    1,
    options.resilience?.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS
  );
  // One deadline for the whole call: retries, model and provider fallbacks.
  const deadlineAt = Date.now() + timeoutMs;
  // Fallback index runs across providers so analytics/lifecycle can tell a
  // provider outage fallback from the primary attempt.
  let candidateIndex = 0;
  let lastAttemptedModel: string | null = null;

  const runProviderAttempt = async (params: {
    provider: AIChatProvider;
    model: string;
    attempt: number;
    fallbackIndex: number;
    remainingTimeoutMs: number;
  }): Promise<ProviderAttemptResult> => {
    const { provider, model, attempt, fallbackIndex, remainingTimeoutMs } =
      params;
    const generationConfig = {
      temperature,
      ...(forceJson && provider !== "anthropic"
        ? { responseMimeType: "application/json" }
        : {}),
      ...(forceJson ? getStructuredJsonGenerationConfig(model) : {}),
      ...adaptCallerGenerationConfigForModel(
        options.generationConfig,
        options.model,
        model
      ),
    };

    if (provider === "anthropic") {
      const response = await executeAnthropicChatAttempt({
        request: {
          model,
          messages,
          forceJson,
          generationConfig,
          timeoutMs: remainingTimeoutMs,
          signal: options.signal,
        },
        onDelta,
        observability: {
          provider,
          analytics: options.analytics,
          attempt,
          fallbackIndex,
          responseFormat,
          temperature:
            anthropicModelAcceptsSampling(model) &&
            typeof generationConfig.temperature === "number"
              ? generationConfig.temperature
              : undefined,
        },
      });
      return {
        content: response.text,
        finishReason: response.finishReason ?? null,
        usage: response.usage,
        ...(response.servedModel && response.servedModel !== model
          ? { servedModel: response.servedModel }
          : {}),
      };
    }

    const normalizedGenerationConfig = normalizeVertexGeminiGenerationConfig(
      model,
      generationConfig
    );
    const vertexResponse = await executeVertexChatAttempt({
      request: {
        model,
        contents: [{ role: "user", parts: [{ text: promptForAnalytics }] }],
        generationConfig: normalizedGenerationConfig,
        timeoutMs: remainingTimeoutMs,
        signal: options.signal,
      },
      onDelta,
      observability: {
        provider,
        analytics: options.analytics,
        attempt,
        fallbackIndex,
        responseFormat,
        temperature:
          typeof normalizedGenerationConfig?.temperature === "number"
            ? normalizedGenerationConfig.temperature
            : undefined,
      },
    });
    return {
      content: vertexResponse.text,
      finishReason: vertexResponse.finishReason ?? null,
      usage: extractVertexGeminiUsage(vertexResponse.raw),
    };
  };

  const tryProvider = async (
    provider: AIChatProvider,
    isFinalProvider: boolean
  ): Promise<AIChatResult | null> => {
    if (!canUseChatProvider(provider)) {
      return null;
    }

    // A non-final provider leaves >= 35% of the remaining call deadline to
    // the provider after it; the final provider may use all that remains.
    const providerStartedAt = Date.now();
    const providerDeadlineAt = isFinalProvider
      ? deadlineAt
      : providerStartedAt +
        Math.floor(
          Math.max(0, deadlineAt - providerStartedAt) *
            NON_FINAL_PROVIDER_DEADLINE_SHARE
        );
    const modelCandidates = buildProviderModelCandidates(options, provider);

    for (const providerModel of modelCandidates) {
      options.signal?.throwIfAborted();
      if (Date.now() >= providerDeadlineAt) break;
      const modelIndex = candidateIndex;
      candidateIndex += 1;
      if (lastAttemptedModel !== null) {
        await emitLifecycle(options, {
          type: "model_fallback",
          provider,
          fromModel: lastAttemptedModel,
          toModel: providerModel,
          fallbackIndex: modelIndex,
        });
      }
      lastAttemptedModel = providerModel;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        options.signal?.throwIfAborted();
        const remainingTimeoutMs = providerDeadlineAt - Date.now();
        if (remainingTimeoutMs <= 0) break;

        const started = Date.now();
        let completedResult: AIChatResult | undefined;
        let analyticsWriteStarted = false;
        const recordAttemptAnalytics = async (
          details: Pick<
            BuildLlmTraceEventParams,
            | "status"
            | "latencyMs"
            | "usage"
            | "finishReason"
            | "outputText"
            | "errorMessage"
          > & { retryable?: boolean; servedModel?: string }
        ) => {
          if (!analyticsWorkspaceId || analyticsWriteStarted) return;
          // Cancellation during the write must not publish this attempt again.
          analyticsWriteStarted = true;
          const { retryable, servedModel, ...eventDetails } = details;
          const cancelled = details.status === "cancelled";
          await recordLlmTraceAnalyticsEvent({
            eventTs: new Date(),
            workspaceId: analyticsWorkspaceId,
            companyId: billing?.companyId,
            actionId: billing?.actionId,
            billingSource: billing?.billingSource,
            conversationId: options.analytics?.conversationId || null,
            messageId: options.analytics?.messageId || null,
            traceId: options.analytics?.traceId || null,
            operation: options.analytics?.operation || "ai.chat_completion",
            provider,
            model: servedModel || providerModel,
            ...eventDetails,
            inputText: cancelled
              ? undefined
              : options.analytics?.inputText ||
                promptForAnalytics ||
                messages.map(message => message.content).join("\n\n"),
            sourceService: options.analytics?.sourceService || "web",
            metadata: {
              responseFormat: responseFormat?.type || null,
              temperature,
              retryAttempt: attempt,
              modelFallbackIndex: modelIndex,
              ...(retryable !== undefined ? { retryable } : {}),
              ...(cancelled ? {} : options.analytics?.metadata || {}),
            },
          });
        };

        try {
          await emitLifecycle(options, {
            type: "attempt_start",
            provider,
            model: providerModel,
            attempt,
            fallbackIndex: modelIndex,
          });
          const attemptResult = await runProviderAttempt({
            provider,
            model: providerModel,
            attempt,
            fallbackIndex: modelIndex,
            remainingTimeoutMs,
          });

          const result: AIChatResult = {
            content: attemptResult.content,
            provider,
            model: attemptResult.servedModel || providerModel,
            latencyMs: Date.now() - started,
            finishReason: attemptResult.finishReason,
            usage: attemptResult.usage,
          };
          completedResult = result;
          options.signal?.throwIfAborted();
          await emitLifecycle(options, {
            type: "attempt_success",
            provider,
            model: providerModel,
            attempt,
            fallbackIndex: modelIndex,
            latencyMs: result.latencyMs,
          });
          options.signal?.throwIfAborted();
          await recordAttemptAnalytics({
            status: "ok",
            servedModel: result.model,
            latencyMs: result.latencyMs,
            usage: result.usage,
            finishReason: result.finishReason,
            outputText: result.content,
          });

          options.signal?.throwIfAborted();
          return result;
        } catch (error) {
          if (options.signal?.aborted) {
            const usage =
              completedResult?.usage || getTextProviderErrorUsage(error);
            try {
              // Completed provider spend survives cancellation; content does not.
              if (usage) {
                await recordAttemptAnalytics({
                  status: "cancelled",
                  servedModel: completedResult?.model,
                  latencyMs: completedResult?.latencyMs ?? Date.now() - started,
                  usage,
                  finishReason:
                    completedResult?.finishReason ??
                    getEmptyContentError(error)?.finishReason ??
                    undefined,
                });
              }
            } finally {
              options.signal.throwIfAborted();
            }
          }
          options.signal?.throwIfAborted();
          if (isWorkspaceAiPolicyError(error)) throw error;
          if (provider === "vertex") {
            markVertexUnavailableForRuntime(error, "AI");
          } else if (provider === "anthropic") {
            markAnthropicUnavailableForRuntime(error, "AI", providerModel);
          }
          const retryable = isRetryableAIProviderError(error);
          const providerError = buildProviderErrorComponent({
            provider,
            model: providerModel,
            attempt: attempt + 1,
            fallbackIndex: modelIndex,
            retryable,
            error,
          });
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          await emitLifecycle(options, {
            type: "attempt_error",
            provider,
            model: providerModel,
            attempt,
            fallbackIndex: modelIndex,
            retryable,
            errorMessage,
          });
          await recordAttemptAnalytics({
            status: "error",
            usage: getTextProviderErrorUsage(error),
            finishReason:
              getEmptyContentError(error)?.finishReason ?? undefined,
            errorMessage,
            retryable,
          });
          errors.push(providerError);

          if (!retryable) {
            // Non-retryable failures skip this provider's remaining models.
            return null;
          }

          const canRetrySameModel =
            retryable && attempt < maxRetries && !deltaDelivered;
          if (canRetrySameModel) {
            const delayMs = getRetryDelayMs({
              attempt,
              initialDelayMs: initialRetryDelayMs,
              maxDelayMs: maxRetryDelayMs,
            });
            if (Date.now() + delayMs >= providerDeadlineAt) break;
            await emitLifecycle(options, {
              type: "retry_wait",
              provider,
              model: providerModel,
              attempt,
              fallbackIndex: modelIndex,
              delayMs,
            });
            await sleepWithCancellation(delayMs, options.signal);
            continue;
          }

          break;
        }
      }
    }

    return null;
  };

  // Customer-billed calls never leave the customer's Google key.
  const normalizedOrder: AIChatProvider[] = customerBilled
    ? ["google"]
    : (providerOrder && providerOrder.length > 0
        ? Array.from(new Set(providerOrder))
        : getDefaultAIChatProviderOrder()
      ).filter(provider => provider !== "google");

  for (let index = 0; index < normalizedOrder.length; index += 1) {
    const isFinalProvider = !normalizedOrder
      .slice(index + 1)
      .some(canUseChatProvider);
    const providerResult = await tryProvider(
      normalizedOrder[index],
      isFinalProvider
    );
    if (providerResult) return providerResult;
  }

  if (errors.length === 0) {
    throw new Error(
      "AI text provider is unavailable in this runtime. Set ANTHROPIC_API_KEY (and ANTHROPIC_AI_ENABLED is not false), configure Vertex AI credentials for local development, or use a callable GCP AI gateway."
    );
  }

  throw new AIChatProviderAggregateError(errors);
}

const tracedChatCompletionWithFallback = traceableChain(
  chatCompletionWithFallbackImpl,
  {
    name: "ai.chat_completion",
    tags: ["ai", "llm", "gemini"],
    getMetadata: options => ({
      operation: options.analytics?.operation || "chat_completion",
      source_service: options.analytics?.sourceService || "web",
      model:
        (options.model && String(options.model).trim()) || getHeavyTextModel(),
      response_format: options.responseFormat?.type || null,
      temperature: options.temperature ?? 0.2,
    }),
    getSessionIdentity: options => readAIChatSessionIdentity(options.analytics),
    processInputs: inputs => {
      const payload = "input" in inputs ? inputs.input : inputs;
      const options = payload as AIChatOptions;

      return {
        model:
          (options.model && String(options.model).trim()) ||
          getHeavyTextModel(),
        temperature: options.temperature ?? 0.2,
        provider_order:
          options.providerOrder && options.providerOrder.length > 0
            ? options.providerOrder
            : getDefaultAIChatProviderOrder(),
        response_format: options.responseFormat?.type || null,
        messages: messagePreview(options.messages || []),
      };
    },
    processOutputs: outputs => {
      const result = "outputs" in outputs ? outputs.outputs : outputs;
      const response = result as AIChatResult;

      return {
        choices: [
          {
            message: {
              role: "assistant",
              content: response.content,
            },
            finish_reason: response.finishReason ?? null,
          },
        ],
        provider: response.provider,
        model: response.model,
        latency_ms: response.latencyMs,
        usage_metadata: {
          input_tokens: response.usage?.prompt_tokens,
          output_tokens: response.usage?.completion_tokens,
          total_tokens: response.usage?.total_tokens,
        },
      };
    },
  }
);

export async function chatCompletionWithFallback(
  options: AIChatOptions
): Promise<AIChatResult> {
  const result = await (options.trace === false
    ? chatCompletionWithFallbackImpl(options)
    : tracedChatCompletionWithFallback(options));
  options.signal?.throwIfAborted();
  return result;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Truncate text for logging/preview with ellipsis
 *
 * @param text - Text to truncate
 * @param maxLength - Maximum length for preview
 * @returns Truncated text with "..." if needed
 */
export function truncateText(
  text: string | undefined | null,
  maxLength: number = DEFAULT_TEXT_PREVIEW_LENGTH
): string {
  if (!text) return "";
  return text.length > maxLength ? text.substring(0, maxLength) + "..." : text;
}

/**
 * Format similarity/confidence score for display
 * Rounds to 2 decimal places (0.8234 -> 0.82)
 *
 * @param score - Raw score (0.0 - 1.0)
 * @returns Formatted score or null
 */
export function formatScore(score: number | undefined | null): number | null {
  if (score === undefined || score === null) return null;
  return Math.round(score * 100) / 100;
}

/**
 * Format error for logging
 *
 * @param error - Error to format
 * @returns Object with error details
 */
export function formatError(error: unknown): { message: string; type: string } {
  if (error instanceof Error) {
    return { message: error.message, type: error.name };
  }
  return { message: String(error), type: "Unknown" };
}

/**
 * Simple cosine similarity between two vectors
 * Used as fallback when vector DB is unavailable
 *
 * @param a - First vector
 * @param b - Second vector
 * @returns Cosine similarity (0.0 - 1.0)
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;

  const dot = a.reduce((sum, val, i) => sum + val * (b[i] || 0), 0);
  const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));

  return normA && normB ? dot / (normA * normB) : 0;
}

// =============================================================================
// SUMMARIZATION
// =============================================================================

export {
  generateConversationSummary,
  type SummarizationOptions,
  type SummarizationResult,
} from "./summarization";

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export { canUseVertexAI } from "./vertex-config";
export { canUseAnthropicAI } from "./anthropic-config";
export {
  getHeavyTextModel,
  getLightStructuredJsonGenerationConfig,
  getLightTextModel,
  getReasoningTextModel,
  getStructuredJsonGenerationConfig,
} from "./text-models";
export {
  getVertexChatModel,
  getVertexGeminiHeavyModel,
  getVertexGeminiLightModel,
  getVertexGeminiStructuredJsonGenerationConfig,
} from "./vertex-gemini-rest";
