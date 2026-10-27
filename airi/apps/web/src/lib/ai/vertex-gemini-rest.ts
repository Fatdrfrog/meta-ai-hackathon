/**
 * Vertex AI Gemini adapters (`generateContent`).
 * Runs on `@google/genai` with Google Cloud auth (or a workspace's own key).
 *
 * @see https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference
 * @see https://cloud.google.com/vertex-ai/generative-ai/docs/start/quickstarts/quickstart-multimodal
 */

import { createLogger } from "@icecore/shared/lib/logger";
import { GoogleGenAI } from "@google/genai";
import { runAfterResponse } from "@/lib/after-response-work";
import {
  resolveWorkspaceTextAiBilling,
  reserveWorkspaceTextAiSpend,
  settleWorkspaceTextAiSpend,
  type WorkspaceTextAiBilling,
} from "./workspace-ai-policy";
import { WorkspaceAiSpendError } from "@icecore/airi-runtime/workspace-ai-spend";
import {
  canUseVertexAI,
  markVertexUnavailableForRuntime,
} from "./vertex-config";
import { getVertexGeminiLocation } from "./vertex-env";
import { getVertexGenAI } from "./vertex-genai-client";
import {
  normalizeLlmTokenUsage,
  type LlmTokenUsage,
} from "@icecore/airi-runtime/llm-analytics";

const vertexGeminiLogger = createLogger("vertex-gemini");

/**
 * Default Flash model for capability routes (heavy/chat/summary/multimodal).
 * Override per surface with VERTEX_GEMINI_HEAVY_MODEL, VERTEX_MULTIMODAL_MODEL.
 */
const VERTEX_GEMINI_DEFAULT_CAPABILITY_MODEL = "gemini-3.5-flash";

const GEMINI_3_SAMPLING_CONFIG_KEYS = new Set([
  "temperature",
  "topP",
  "top_p",
  "topK",
  "top_k",
]);

export type GeminiPart =
  | { text: string }
  | { fileData: { fileUri: string; mimeType: string } }
  | { inlineData: { data: string; mimeType: string } };

export type GeminiContent = {
  role: "user" | "model" | string;
  parts: GeminiPart[];
};

export type VertexGeminiTextResponse = {
  text: string;
  finishReason?: string | null;
  finishMessage?: string | null;
  promptBlockReason?: string | null;
  promptBlockReasonMessage?: string | null;
  raw?: unknown;
};

const VERTEX_GEMINI_FAILURE_REASON_LIMIT = 64;
const VERTEX_GEMINI_EMPTY_CONTENT_MESSAGE_LIMIT = 240;

function boundedFailureReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized
    ? normalized.slice(0, VERTEX_GEMINI_FAILURE_REASON_LIMIT)
    : null;
}

export class VertexGeminiEmptyContentError extends Error {
  readonly code = "vertex_gemini_empty_content";
  readonly finishReason: string | null;
  readonly promptBlockReason: string | null;
  readonly usage?: LlmTokenUsage;

  constructor(
    response: Pick<
      VertexGeminiTextResponse,
      "finishReason" | "promptBlockReason" | "raw"
    >
  ) {
    const finishReason = boundedFailureReason(response.finishReason);
    const promptBlockReason = boundedFailureReason(response.promptBlockReason);
    const reason = [
      finishReason ? `finishReason=${finishReason}` : null,
      promptBlockReason ? `promptBlockReason=${promptBlockReason}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    super(
      `Vertex Gemini returned no text content${reason ? `: ${reason}` : ""}`.slice(
        0,
        VERTEX_GEMINI_EMPTY_CONTENT_MESSAGE_LIMIT
      )
    );
    this.name = "VertexGeminiEmptyContentError";
    this.finishReason = finishReason;
    this.promptBlockReason = promptBlockReason;
    this.usage = extractVertexGeminiUsage(response.raw);
  }
}

/** Carry completed spend across cancellation without retaining provider prose. */
class VertexGeminiCancelledUsageError extends Error {
  readonly usage: LlmTokenUsage;

  constructor(usage: LlmTokenUsage) {
    super("The operation was aborted.");
    this.name = "AbortError";
    this.usage = usage;
  }
}

/**
 * Fast/cheap Gemini for short JSON, cleanup, translation, HyDE, language tags, etc.
 * Env: VERTEX_GEMINI_LIGHT_MODEL (default gemini-3.5-flash).
 */
export function getVertexGeminiLightModel(): string {
  return process.env.VERTEX_GEMINI_LIGHT_MODEL?.trim() || "gemini-3.5-flash";
}

function isGemini3FamilyModel(model: string): boolean {
  return /^gemini-3(?:[.-]|$)/i.test(String(model || "").trim());
}

export function normalizeVertexGeminiGenerationConfig(
  model: string,
  generationConfig?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!generationConfig) {
    return undefined;
  }

  if (!isGemini3FamilyModel(model)) {
    // Gemini 2.0 has no thinkingConfig; Gemini 2.5 accepts thinkingBudget but
    // not a Gemini 3 thinkingLevel carried through fallback. Keep output caps.
    if (
      /^gemini-2(?:[.-]|$)/i.test(model.trim()) &&
      generationConfig.thinkingConfig &&
      typeof generationConfig.thinkingConfig === "object"
    ) {
      if (/^gemini-2\.0(?:[.-]|$)/i.test(model.trim())) {
        const normalized = { ...generationConfig };
        delete normalized.thinkingConfig;
        return normalized;
      }
      const thinkingConfig = {
        ...(generationConfig.thinkingConfig as Record<string, unknown>),
      };
      if (
        Object.prototype.hasOwnProperty.call(thinkingConfig, "thinkingLevel")
      ) {
        delete thinkingConfig.thinkingLevel;
        const normalized = { ...generationConfig };
        if (Object.keys(thinkingConfig).length)
          normalized.thinkingConfig = thinkingConfig;
        else delete normalized.thinkingConfig;
        return normalized;
      }
    }
    return generationConfig;
  }

  let changed = false;
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(generationConfig)) {
    if (GEMINI_3_SAMPLING_CONFIG_KEYS.has(key)) {
      changed = true;
      continue;
    }

    normalized[key] = value;
  }

  // Model fallback can carry the primary model's MINIMAL setting. Newer Flash
  // models support LOW as their minimum; preserve the requested output cap.
  const thinking = normalized.thinkingConfig as
    | { thinkingLevel?: unknown }
    | undefined;
  if (
    /gemini-3\.[78]-flash/i.test(model) &&
    thinking?.thinkingLevel === "MINIMAL"
  ) {
    normalized.thinkingConfig = { ...thinking, thinkingLevel: "LOW" };
    changed = true;
  }

  if (!changed) {
    return generationConfig;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * Merge into generation config for structured JSON calls.
 */
export function getVertexGeminiStructuredJsonGenerationConfig(
  model: string
): Record<string, unknown> {
  const id = String(model || "").toLowerCase();

  if (id.includes("gemini-3")) {
    if (id.includes("pro")) {
      return { thinkingConfig: { thinkingLevel: "LOW" } };
    }
    if (id.includes("flash")) {
      if (/gemini-3\.[78]-flash/.test(id)) {
        return { thinkingConfig: { thinkingLevel: "LOW" } };
      }
      return { thinkingConfig: { thinkingLevel: "MINIMAL" } };
    }
    return { thinkingConfig: { thinkingLevel: "LOW" } };
  }

  return {};
}

export function getVertexGeminiLightStructuredJsonGenerationConfig(): Record<
  string,
  unknown
> {
  return getVertexGeminiStructuredJsonGenerationConfig(
    getVertexGeminiLightModel()
  );
}

/**
 * “Heavy” Gemini (reply generation, rerank, verification, coach, etc.).
 * Env: VERTEX_GEMINI_HEAVY_MODEL, then VERTEX_FALLBACK_MODEL, then {@link VERTEX_GEMINI_DEFAULT_CAPABILITY_MODEL}.
 */
export function getVertexGeminiHeavyModel(): string {
  return (
    process.env.VERTEX_GEMINI_HEAVY_MODEL?.trim() ||
    process.env.VERTEX_FALLBACK_MODEL?.trim() ||
    VERTEX_GEMINI_DEFAULT_CAPABILITY_MODEL
  );
}

/** Default chat model when no per-call model is passed (same as heavy). */
export function getVertexChatModel(): string {
  return getVertexGeminiHeavyModel();
}

/** Multimodal (image/audio/video URLs) - env: VERTEX_MULTIMODAL_MODEL. */
export function getVertexMultimodalModel(): string {
  return (
    process.env.VERTEX_MULTIMODAL_MODEL ||
    VERTEX_GEMINI_DEFAULT_CAPABILITY_MODEL
  );
}

export function extractGeminiTextResponse(
  data: unknown,
  options?: {
    /**
     * When `true` (default), trims surrounding whitespace from the extracted
     * text. The non-streaming generate paths want this because Gemini tends
     * to emit a trailing newline.
     *
     * Streaming callers MUST pass `false`: Gemini splits chunks at arbitrary
     * positions, often in the middle of a space (e.g. chunk N = "могли",
     * chunk N+1 = " продолжить"). Trimming per chunk strips that leading
     * space, so the accumulated text would read "моглипродолжить" — words
     * glued together at every chunk boundary. The streaming callers trim
     * the *final* accumulated string instead.
     */
    trim?: boolean;
  }
): VertexGeminiTextResponse {
  if (!data || typeof data !== "object") {
    return {
      text: "",
      finishReason: null,
      finishMessage: null,
      promptBlockReason: null,
      promptBlockReasonMessage: null,
      raw: data,
    };
  }

  const root = data as {
    candidates?: Array<{
      finishReason?: string;
      finish_reason?: string;
      finishMessage?: string;
      content?: { parts?: Array<{ text?: string }> };
    }>;
    promptFeedback?: {
      blockReason?: string;
      blockReasonMessage?: string;
    };
  };

  const shouldTrim = options?.trim !== false;
  const parts = root.candidates?.[0]?.content?.parts;
  const joined = parts?.length
    ? parts.map(part => part.text || "").join("")
    : "";
  const text = shouldTrim ? joined.trim() : joined;

  return {
    text,
    finishReason:
      root.candidates?.[0]?.finishReason ||
      root.candidates?.[0]?.finish_reason ||
      null,
    finishMessage: root.candidates?.[0]?.finishMessage || null,
    promptBlockReason: root.promptFeedback?.blockReason || null,
    promptBlockReasonMessage: root.promptFeedback?.blockReasonMessage || null,
    raw: data,
  };
}

export function extractVertexGeminiUsage(
  raw: unknown
): LlmTokenUsage | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const usage = (
    raw as {
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
        thoughtsTokenCount?: number;
        cachedContentTokenCount?: number;
      };
    }
  ).usageMetadata;

  if (!usage) {
    return undefined;
  }

  return normalizeLlmTokenUsage({
    prompt_tokens: usage.promptTokenCount,
    completion_tokens: usage.candidatesTokenCount,
    total_tokens: usage.totalTokenCount,
    thinking_tokens: usage.thoughtsTokenCount,
    cached_prompt_tokens: usage.cachedContentTokenCount,
  });
}

/** Read only the sanitized counters retained by our provider error boundary. */
export function getVertexGeminiErrorUsage(
  error: unknown
): LlmTokenUsage | undefined {
  if (
    error instanceof VertexGeminiEmptyContentError ||
    error instanceof VertexGeminiCancelledUsageError
  )
    return error.usage;
  if (
    !error ||
    typeof error !== "object" ||
    !("code" in error) ||
    error.code !== "google_text_provider_failed" ||
    !("usage" in error)
  )
    return undefined;
  return normalizeLlmTokenUsage(error.usage as LlmTokenUsage | undefined);
}

function throwIfGeminiCancelled(
  signal: AbortSignal | undefined,
  error: unknown
): void {
  if (signal?.aborted) {
    const usage = getVertexGeminiErrorUsage(error);
    if (usage) throw new VertexGeminiCancelledUsageError(usage);
  }
  signal?.throwIfAborted();
}

function pickVertexGenerateDiagnostics(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") {
    return {};
  }

  const root = data as Record<string, unknown>;
  const usage = root.usageMetadata as Record<string, unknown> | undefined;
  const usageSummary =
    usage && typeof usage === "object"
      ? {
          promptTokenCount: usage.promptTokenCount,
          candidatesTokenCount: usage.candidatesTokenCount,
          totalTokenCount: usage.totalTokenCount,
          thoughtsTokenCount: usage.thoughtsTokenCount,
        }
      : undefined;
  const candidates = root.candidates;
  const c0 =
    Array.isArray(candidates) &&
    candidates[0] &&
    typeof candidates[0] === "object"
      ? (candidates[0] as Record<string, unknown>)
      : undefined;
  return {
    usage: usageSummary,
    safetyRatings: c0?.safetyRatings,
    candidateCount: Array.isArray(candidates) ? candidates.length : 0,
  };
}

export type VertexGeminiGenerateParams = {
  model: string;
  contents: GeminiContent[];
  generationConfig?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
};

function generationSignal(
  params: { signal?: AbortSignal; timeoutMs?: number },
  configuredSignal?: unknown
): AbortSignal | undefined {
  const signals = [
    params.signal,
    configuredSignal instanceof AbortSignal ? configuredSignal : undefined,
    params.timeoutMs ? AbortSignal.timeout(params.timeoutMs) : undefined,
  ].filter((value): value is AbortSignal => Boolean(value));
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
}

function buildSdkGenerationConfig(
  generationConfig: Record<string, unknown> | undefined,
  timeoutMs: number | undefined,
  signal?: AbortSignal
): Record<string, unknown> | undefined {
  const abortSignal = generationSignal(
    { signal, timeoutMs },
    generationConfig?.abortSignal
  );
  const existingHttpOptions = generationConfig?.httpOptions;
  const httpOptions =
    existingHttpOptions &&
    typeof existingHttpOptions === "object" &&
    !Array.isArray(existingHttpOptions)
      ? (existingHttpOptions as Record<string, unknown>)
      : {};

  return {
    ...(generationConfig || {}),
    httpOptions: {
      ...httpOptions,
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
      retryOptions: { attempts: 1 },
    },
    abortSignal,
  };
}

async function generateVertexGeminiContentResponseViaSdk(
  params: VertexGeminiGenerateParams,
  ai: GoogleGenAI,
  customerFunded = false
): Promise<VertexGeminiTextResponse> {
  const data = await ai.models.generateContent({
    model: params.model,
    contents: params.contents,
    config: buildSdkGenerationConfig(
      params.generationConfig,
      params.timeoutMs,
      params.signal
    ),
  });

  const extracted = extractGeminiTextResponse(data);
  if (!extracted.text) {
    if (!customerFunded)
      vertexGeminiLogger.warn("generateContent returned no visible text", {
        model: params.model,
        finishReason: extracted.finishReason ?? null,
        finishMessage: extracted.finishMessage ?? null,
        promptBlockReason: extracted.promptBlockReason ?? null,
        ...pickVertexGenerateDiagnostics(data),
      });
    throw new VertexGeminiEmptyContentError(extracted);
  }

  return extracted;
}

async function generateVertexGeminiContentResponseImpl(
  params: VertexGeminiGenerateParams,
  billing: WorkspaceTextAiBilling | null
): Promise<VertexGeminiTextResponse> {
  params.signal?.throwIfAborted();
  const normalizedParams = {
    ...params,
    generationConfig: normalizeVertexGeminiGenerationConfig(
      params.model,
      params.generationConfig
    ),
  };

  params.signal?.throwIfAborted();
  if (billing?.billingSource === "customer") {
    try {
      // Explicit false prevents GOOGLE_GENAI_USE_VERTEXAI from changing billing.
      // Keep customer clients local: neither keys nor clients enter shared caches.
      const ai = new GoogleGenAI({ apiKey: billing.apiKey, vertexai: false });
      return await generateVertexGeminiContentResponseViaSdk(
        normalizedParams,
        ai,
        true
      );
    } catch (error) {
      throwIfGeminiCancelled(params.signal, error);
      throw sanitizeGoogleTextProviderError(error);
    }
  }

  return generateVertexGeminiContentResponseViaSdk(
    normalizedParams,
    await getVertexGenAI(getVertexGeminiLocation())
  );
}

export type VertexGeminiStreamChunk = {
  delta: string;
  accumulated: string;
};

export type VertexGeminiStreamCallbacks = {
  onDelta?: (chunk: VertexGeminiStreamChunk) => void | Promise<void>;
};

async function streamVertexGeminiContentResponseViaSdk(
  params: VertexGeminiGenerateParams,
  callbacks: VertexGeminiStreamCallbacks,
  ai: GoogleGenAI,
  customerFunded = false
): Promise<VertexGeminiTextResponse> {
  const stream = await ai.models.generateContentStream({
    model: params.model,
    contents: params.contents,
    config: buildSdkGenerationConfig(
      params.generationConfig,
      params.timeoutMs,
      params.signal
    ),
  });

  let accumulated = "";
  let lastChunk: unknown = null;

  for await (const chunk of stream) {
    params.signal?.throwIfAborted();
    lastChunk = chunk;
    // IMPORTANT: `trim: false` — see note on extractGeminiTextResponse. The
    // model splits chunks mid-whitespace, so trimming here corrupts word
    // boundaries in the accumulated text.
    const delta = extractGeminiTextResponse(chunk, { trim: false }).text;
    if (delta) {
      accumulated += delta;
      if (callbacks.onDelta) {
        try {
          await callbacks.onDelta({ delta, accumulated });
        } catch {
          /* callback failures must not break generation */
        }
      }
    }
  }

  // Gemini streams carry finish metadata on the last chunk only.
  const extracted = extractGeminiTextResponse(lastChunk);
  const result: VertexGeminiTextResponse = {
    text: accumulated.trim() || extracted.text,
    finishReason: extracted.finishReason ?? null,
    finishMessage: extracted.finishMessage ?? null,
    promptBlockReason: extracted.promptBlockReason ?? null,
    promptBlockReasonMessage: extracted.promptBlockReasonMessage ?? null,
    raw: lastChunk,
  };

  if (!result.text) {
    if (!customerFunded)
      vertexGeminiLogger.warn(
        "generateContentStream returned no visible text",
        {
          model: params.model,
          finishReason: result.finishReason ?? null,
          finishMessage: result.finishMessage ?? null,
          promptBlockReason: result.promptBlockReason ?? null,
        }
      );
    throw new VertexGeminiEmptyContentError(result);
  }

  return result;
}

/**
 * Streaming variant of {@link generateVertexGeminiContentResponse}. Calls
 * `callbacks.onDelta` with each incremental chunk. Returns the final
 * aggregated response (same shape as the non-streaming call) so downstream
 * code can swap one for the other.
 */
async function streamVertexGeminiContentResponseImpl(
  params: VertexGeminiGenerateParams,
  callbacks: VertexGeminiStreamCallbacks,
  billing: WorkspaceTextAiBilling | null
): Promise<VertexGeminiTextResponse> {
  params.signal?.throwIfAborted();
  const normalizedParams = {
    ...params,
    generationConfig: normalizeVertexGeminiGenerationConfig(
      params.model,
      params.generationConfig
    ),
  };

  params.signal?.throwIfAborted();
  if (billing?.billingSource === "customer") {
    try {
      const ai = new GoogleGenAI({ apiKey: billing.apiKey, vertexai: false });
      return await streamVertexGeminiContentResponseViaSdk(
        normalizedParams,
        callbacks,
        ai,
        true
      );
    } catch (error) {
      throwIfGeminiCancelled(params.signal, error);
      throw sanitizeGoogleTextProviderError(error);
    }
  }

  return streamVertexGeminiContentResponseViaSdk(
    normalizedParams,
    callbacks,
    await getVertexGenAI(getVertexGeminiLocation())
  );
}

async function generateWithSpendReservation(
  params: VertexGeminiGenerateParams,
  callbacks?: VertexGeminiStreamCallbacks
): Promise<VertexGeminiTextResponse> {
  params.signal?.throwIfAborted();
  const bounded = {
    ...params,
    generationConfig: {
      ...params.generationConfig,
      maxOutputTokens: params.generationConfig?.maxOutputTokens ?? 8192,
    },
  };
  // Remote file URIs do not carry a verifiable input-unit bound. Customer keys
  // may process them; platform media callers must supply bounded inline data.
  const billing = await resolveWorkspaceTextAiBilling();
  const hasRemoteInput = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(hasRemoteInput);
    return Object.entries(value).some(
      ([key, child]) =>
        key === "fileData" || key === "cachedContent" || hasRemoteInput(child)
    );
  };
  if (
    billing?.billingSource !== "customer" &&
    ((params.generationConfig?.candidateCount ?? 1) !== 1 ||
      params.generationConfig?.tools !== undefined ||
      hasRemoteInput({
        contents: params.contents,
        generationConfig: bounded.generationConfig,
      }))
  ) {
    throw new WorkspaceAiSpendError("workspace_ai_spend_limit");
  }
  const reservation = await reserveWorkspaceTextAiSpend({
    provider: "vertex",
    model: params.model,
    request: {
      contents: params.contents,
      generationConfig: bounded.generationConfig,
    },
    maxOutputTokens: Number(bounded.generationConfig.maxOutputTokens),
  });
  // The reservation already holds the call's maximum cost, so the settle
  // (a database round trip) runs after the response instead of before it.
  let response: VertexGeminiTextResponse;
  try {
    response = callbacks
      ? await streamVertexGeminiContentResponseImpl(bounded, callbacks, billing)
      : await generateVertexGeminiContentResponseImpl(bounded, billing);
  } catch (error) {
    const usage =
      error && typeof error === "object" && "usage" in error
        ? (error.usage as LlmTokenUsage)
        : undefined;
    runAfterResponse("ai_spend_settle", () =>
      settleWorkspaceTextAiSpend(reservation, params.model, usage)
    );
    throw error;
  }
  const responseUsage = extractVertexGeminiUsage(response.raw);
  runAfterResponse("ai_spend_settle", () =>
    settleWorkspaceTextAiSpend(reservation, params.model, responseUsage)
  );
  return response;
}

export function generateVertexGeminiContentResponse(
  params: VertexGeminiGenerateParams
): Promise<VertexGeminiTextResponse> {
  return generateWithSpendReservation(params);
}

export function streamVertexGeminiContentResponse(
  params: VertexGeminiGenerateParams,
  callbacks: VertexGeminiStreamCallbacks
): Promise<VertexGeminiTextResponse> {
  return generateWithSpendReservation(params, callbacks);
}

/**
 * Non-streaming generateContent. Single entry for all Vertex Gemini calls.
 */
export async function generateVertexGeminiContent(
  params: VertexGeminiGenerateParams
): Promise<string> {
  const response = await generateVertexGeminiContentResponse(params);
  return response.text;
}

/**
 * Like generateVertexGeminiContent but respects canUseVertexAI and maps auth-style failures.
 */
export async function generateVertexGeminiContentOrThrow(
  params: VertexGeminiGenerateParams,
  runtimeContext: string
): Promise<string> {
  const billing = await resolveWorkspaceTextAiBilling();
  if (billing?.billingSource !== "customer" && !canUseVertexAI()) {
    throw new Error("Vertex AI is not configured or is disabled");
  }
  try {
    return await generateVertexGeminiContent(params);
  } catch (error) {
    if (billing?.billingSource !== "customer") {
      markVertexUnavailableForRuntime(error, runtimeContext);
    }
    throw error;
  }
}

/** Provider errors may contain request headers/URLs. Retain only safe retry data. */
function sanitizeGoogleTextProviderError(error: unknown): Error {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number(error.status)
      : undefined;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  const timedOut =
    name === "AbortError" ||
    name === "TimeoutError" ||
    /timeout|timed out|deadline exceeded/i.test(message);
  const safeStatus =
    Number.isInteger(status) && status! >= 400 && status! <= 599
      ? status
      : undefined;
  return Object.assign(
    new Error(
      timedOut
        ? "Google AI request timeout"
        : `Google AI request failed${safeStatus ? ` (HTTP ${safeStatus})` : ""}`
    ),
    {
      name: "GoogleTextProviderError",
      code: "google_text_provider_failed",
      ...(error instanceof VertexGeminiEmptyContentError && error.usage
        ? { usage: error.usage }
        : {}),
      ...(safeStatus ? { status: safeStatus } : {}),
    }
  );
}
