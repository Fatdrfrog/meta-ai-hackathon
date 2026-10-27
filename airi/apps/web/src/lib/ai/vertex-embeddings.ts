/**
 * Vertex text embeddings (`embedContent`).
 *
 * @see https://cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-text-embeddings
 * @see https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/text-embeddings-api
 */

import { runAfterResponse } from "@/lib/after-response-work";
import { recordLlmTraceAnalyticsEvent } from "@/lib/llm-analytics/events";
import type { LlmTokenUsage } from "@icecore/airi-runtime/llm-analytics";
import type { EmbeddingTaskType, GeneratedEmbedding } from "./embedding-types";
import { traceableEmbedding } from "@/lib/observability/tracing";
import {
  canUseVertexEmbeddings,
  getVertexEmbeddingLocation,
  markVertexEmbeddingsUnavailableForRuntime,
  resolveVertexEmbeddingProjectId,
} from "./vertex-auth";
import { GoogleGenAI } from "@google/genai";
import { getVertexGenAI } from "./vertex-genai-client";

import {
  resolveWorkspaceTextAiBilling,
  reserveWorkspaceTextAiSpend,
  settleWorkspaceTextAiSpend,
} from "./workspace-ai-policy";

const DEFAULT_VERTEX_EMBEDDING_MODEL = "gemini-embedding-001";
const VERTEX_EMBEDDING_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.VERTEX_EMBEDDING_TIMEOUT_MS || 30_000)
);

export function getVertexEmbeddingModel(): string {
  return (
    (process.env.VERTEX_EMBEDDING_MODEL || "").trim() ||
    DEFAULT_VERTEX_EMBEDDING_MODEL
  );
}

/** Shared input normalization for embedding RPCs (also used by `embeddings.ts` cache layer). */
export function normalizeEmbeddingText(text: string): string {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function mapEmbeddingValues(
  values: number[] | undefined,
  dimensions: number
): number[] {
  if (!Array.isArray(values) || values.length !== dimensions) {
    throw new Error(
      `Vertex embeddings returned invalid dimensions: expected ${dimensions}, received ${values?.length || 0}`
    );
  }

  return values.map(value =>
    typeof value === "number" && Number.isFinite(value) ? value : 0
  );
}

function buildGeneratedEmbedding(params: {
  values: number[];
  model: string;
  dimensions: number;
  taskType: EmbeddingTaskType;
}): GeneratedEmbedding {
  return {
    embedding: mapEmbeddingValues(params.values, params.dimensions),
    provider: "vertex",
    model: params.model,
    dimensions: params.dimensions,
    taskType: params.taskType,
  };
}

async function getVertexTextEmbeddingViaSdk(params: {
  normalizedText: string;
  taskType: EmbeddingTaskType;
  dimensions: number;
  title?: string;
  model: string;
  location: string;
  apiKey?: string;
}): Promise<{ result: GeneratedEmbedding; tokenCount?: number }> {
  const ai = params.apiKey
    ? new GoogleGenAI({ vertexai: false, apiKey: params.apiKey })
    : await getVertexGenAI(params.location);
  const response = await ai.models.embedContent({
    model: params.model,
    contents: [params.normalizedText],
    config: {
      httpOptions: {
        timeout: VERTEX_EMBEDDING_TIMEOUT_MS,
        retryOptions: { attempts: 1 },
      },
      taskType: params.taskType,
      ...(params.taskType === "RETRIEVAL_DOCUMENT" &&
      params.title &&
      params.title.trim()
        ? { title: params.title.trim() }
        : {}),
      ...(params.apiKey ? {} : { autoTruncate: true }),
      outputDimensionality: params.dimensions,
    },
  });

  return {
    tokenCount: response.embeddings?.[0]?.statistics?.tokenCount,
    result: buildGeneratedEmbedding({
      values: response.embeddings?.[0]?.values || [],
      model: params.model,
      dimensions: params.dimensions,
      taskType: params.taskType,
    }),
  };
}

type VertexEmbeddingAttemptInput = {
  normalizedText: string;
  taskType: EmbeddingTaskType;
  dimensions: number;
  title?: string;
  model: string;
  projectId: string;
  location: string;
};

async function executeVertexEmbeddingAttemptImpl(
  params: VertexEmbeddingAttemptInput
): Promise<GeneratedEmbedding> {
  const billing = await resolveWorkspaceTextAiBilling();
  const reservation = await reserveWorkspaceTextAiSpend({
    provider: "vertex",
    model: params.model,
    request: {
      text: params.normalizedText,
      title: params.title,
      taskType: params.taskType,
      dimensions: params.dimensions,
    },
    maxOutputTokens: 0,
  });
  const started = Date.now();
  let usage: LlmTokenUsage | undefined;
  let result: GeneratedEmbedding;
  let failed = false;
  let failure:
    | { code: string; message: string; httpStatus?: number }
    | undefined;
  const provider = billing?.billingSource === "customer" ? "google" : "vertex";
  try {
    const response = await getVertexTextEmbeddingViaSdk({
      ...params,
      apiKey:
        billing?.billingSource === "customer" ? billing.apiKey : undefined,
    });
    const tokens = response.tokenCount;
    usage =
      typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0
        ? { prompt_tokens: tokens, completion_tokens: 0, total_tokens: tokens }
        : undefined;
    result = response.result;
  } catch (error) {
    failed = true;
    // Provider errors can contain credentials and input text. Keep only safe
    // status/timeout diagnostics in both the customer error and analytics.
    const status =
      error && typeof error === "object" && "status" in error
        ? error.status
        : undefined;
    const httpStatus =
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 400 &&
      status <= 599
        ? status
        : undefined;
    const timedOut =
      error instanceof Error &&
      (error.name === "AbortError" ||
        error.name === "TimeoutError" ||
        /timeout|timed out|deadline exceeded/i.test(error.message));
    const providerLabel = provider === "google" ? "Customer Google" : "Vertex";
    failure = {
      code: `${provider}_embedding_${timedOut ? "timeout" : "provider_failed"}`,
      message: timedOut
        ? `${providerLabel} embedding request timeout.`
        : `${providerLabel} embedding request failed${httpStatus ? ` (HTTP ${httpStatus})` : ""}.`,
      ...(httpStatus ? { httpStatus } : {}),
    };
    if (billing?.billingSource === "customer") {
      throw Object.assign(new Error(failure.message), {
        name: "GoogleEmbeddingProviderError",
        code: failure.code,
        ...(httpStatus ? { status: httpStatus } : {}),
      });
    }
    throw error;
  } finally {
    // The reservation already holds the maximum cost; settle after the
    // response so the embedding never waits on that database round trip.
    const settledUsage = usage;
    runAfterResponse("ai_spend_settle", () =>
      settleWorkspaceTextAiSpend(reservation, params.model, settledUsage)
    );
    if (billing)
      await recordLlmTraceAnalyticsEvent({
        workspaceId: billing.workspaceId,
        companyId: billing.companyId,
        actionId: billing.actionId,
        billingSource: billing.billingSource,
        operation: "ai.embedding",
        provider,
        model: params.model,
        status: failed ? "error" : "ok",
        usage,
        errorMessage: failure?.message,
        latencyMs: Date.now() - started,
        metadata: {
          taskType: params.taskType,
          dimensions: params.dimensions,
          ...(failure ? { errorCode: failure.code } : {}),
          ...(failure?.httpStatus ? { httpStatus: failure.httpStatus } : {}),
        },
      });
  }
  return result;
}

export async function getVertexTextEmbedding(params: {
  text: string;
  taskType: EmbeddingTaskType;
  dimensions: number;
  title?: string;
}): Promise<GeneratedEmbedding | null> {
  const normalizedText = normalizeEmbeddingText(params.text);
  if (normalizedText.length < 2) {
    return null;
  }

  const billing = await resolveWorkspaceTextAiBilling();
  const customer = billing?.billingSource === "customer";
  if (!customer && !canUseVertexEmbeddings()) return null;
  const projectId = customer ? "" : await resolveVertexEmbeddingProjectId();
  if (!customer && !projectId) {
    return null;
  }

  const model = getVertexEmbeddingModel();
  const location = getVertexEmbeddingLocation();
  const provider = customer ? "google" : "vertex";

  try {
    return await traceableEmbedding(executeVertexEmbeddingAttemptImpl, {
      name: `${provider}.embed_content`,
      tags: ["ai", "embedding", provider],
      getMetadata: attempt => ({
        embedding_dimensions: attempt.dimensions,
        embedding_task_type: attempt.taskType,
        model: attempt.model,
        operation: "embed_content",
        provider,
        source_service: "web",
      }),
    })({
      normalizedText,
      taskType: params.taskType,
      dimensions: params.dimensions,
      title: params.title,
      model,
      projectId: projectId || "",
      location,
    });
  } catch (error) {
    if (!customer) {
      markVertexEmbeddingsUnavailableForRuntime(error, "Vertex Embeddings");
    }
    throw error;
  }
}
