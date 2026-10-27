/**
 * Optional HTTP proxy to GCP-hosted embedding/search routes (Vercel OIDC). Not Vertex SDK;
 * complements direct Vertex calls in `vertex-embeddings.ts`.
 */

import "server-only";
import { getWorkspaceTextAiAction } from "./workspace-ai-policy";
import { awaitWithCancellation, throwIfCancelled } from "./cancellation";

import {
  AI_GATEWAY_PATHS,
  type AskDataContextGatewayRequest,
  type AskDataContextGatewayResponse,
  type DocumentEmbeddingBatchGatewayItem,
  type DocumentEmbeddingBatchGatewayResponse,
  type DocumentEmbeddingGatewayRequest,
  type DocumentEmbeddingGatewayResponse,
  type LlmAnalyticsGatewayEventResponse,
  type LlmAnalyticsQueryGatewayRequest,
  type LlmAnalyticsQueryGatewayResponse,
  type QueryEmbeddingGatewayRequest,
  type QueryEmbeddingGatewayResponse,
} from "@icecore/airi-runtime/ai-gateway";
import type { LlmAnalyticsEvent } from "@icecore/airi-runtime/llm-analytics";
import { compactEnv, getVercelOidcTokenOrEnv } from "@/lib/google/gcp-auth";
import type { GeneratedEmbedding } from "./embedding-types";

const GCP_AI_GATEWAY_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.GCP_AI_GATEWAY_TIMEOUT_MS || 30_000)
);

export class GcpAiGatewayHttpError extends Error {
  readonly status: number;

  constructor(status: number, responseText: string, localAuthHint = "") {
    super(
      `GCP AI gateway HTTP ${status}: ${responseText.slice(0, 800)}${localAuthHint}`
    );
    this.name = "GcpAiGatewayHttpError";
    this.status = status;
  }

  get permanent(): boolean {
    return this.status === 400 || this.status === 413;
  }
}

function getGcpAiGatewayBaseUrl(): string | null {
  const value = String(process.env.GCP_AI_GATEWAY_URL || "").trim();
  if (!value) return null;
  return value.replace(/\/$/, "");
}

function isLocalGatewayUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function canCallGcpAIGateway(): boolean {
  const baseUrl = getGcpAiGatewayBaseUrl();
  if (!baseUrl) return false;
  if (isLocalGatewayUrl(baseUrl)) return true;
  return Boolean(compactEnv("VERCEL_OIDC_TOKEN") || compactEnv("VERCEL"));
}

async function callGcpAIGateway<TResponse>(
  path: string,
  payload: unknown,
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<TResponse> {
  throwIfCancelled(options?.signal);
  const baseUrl = getGcpAiGatewayBaseUrl();
  if (!baseUrl) {
    throw new Error("GCP_AI_GATEWAY_URL is not configured");
  }

  const token = await awaitWithCancellation(
    getVercelOidcTokenOrEnv(),
    options?.signal
  );
  if (!token && !isLocalGatewayUrl(baseUrl)) {
    throw new Error(
      "GCP_AI_GATEWAY_URL points to a secured gateway, but no Vercel OIDC token is available. Set VERCEL_OIDC_TOKEN for local testing or unset GCP_AI_GATEWAY_URL to use local search."
    );
  }
  const timeoutSignal = AbortSignal.timeout(
    options?.timeoutMs || GCP_AI_GATEWAY_TIMEOUT_MS
  );
  const signal = options?.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    redirect: "error",
    signal,
    body: JSON.stringify(payload),
  });

  const responseText = await awaitWithCancellation(response.text(), signal);
  throwIfCancelled(signal);
  if (!response.ok) {
    const localAuthHint =
      response.status === 401 &&
      isLocalGatewayUrl(baseUrl) &&
      /Missing bearer token/i.test(responseText)
        ? " Local AI gateway auth is still enabled. Restart the local gateway with AIRI_RUNTIME_MODE=ai-gateway and AI_GATEWAY_DISABLE_AUTH=true, or point GCP_AI_GATEWAY_URL at a secured gateway with a valid Vercel OIDC token."
        : "";
    throw new GcpAiGatewayHttpError(
      response.status,
      responseText,
      localAuthHint
    );
  }

  try {
    return JSON.parse(responseText) as TResponse;
  } catch {
    throw new Error("GCP AI gateway returned non-JSON response");
  }
}

export async function getRemoteQueryEmbeddingResultWithCache(
  text: string
): Promise<GeneratedEmbedding | null> {
  const payload: QueryEmbeddingGatewayRequest = {
    text,
    action: getWorkspaceTextAiAction(),
  };
  const response = await callGcpAIGateway<QueryEmbeddingGatewayResponse>(
    AI_GATEWAY_PATHS.queryEmbedding,
    payload
  );
  return response.result as GeneratedEmbedding | null;
}

export async function getRemoteDocumentEmbeddingResult(params: {
  text: string;
  title?: string;
}): Promise<GeneratedEmbedding | null> {
  const payload: DocumentEmbeddingGatewayRequest = {
    text: params.text,
    title: params.title,
    action: getWorkspaceTextAiAction(),
  };
  const response = await callGcpAIGateway<DocumentEmbeddingGatewayResponse>(
    AI_GATEWAY_PATHS.documentEmbedding,
    payload
  );
  return response.result as GeneratedEmbedding | null;
}

export async function getRemoteDocumentEmbeddingResultsBatch(
  items: DocumentEmbeddingBatchGatewayItem[]
): Promise<Array<GeneratedEmbedding | null>> {
  const response =
    await callGcpAIGateway<DocumentEmbeddingBatchGatewayResponse>(
      AI_GATEWAY_PATHS.documentEmbeddingBatch,
      { items, action: getWorkspaceTextAiAction() }
    );
  return response.results as Array<GeneratedEmbedding | null>;
}

export async function getRemoteAskDataContext(
  payload: AskDataContextGatewayRequest,
  options?: { signal?: AbortSignal }
): Promise<AskDataContextGatewayResponse> {
  return callGcpAIGateway<AskDataContextGatewayResponse>(
    AI_GATEWAY_PATHS.askDataContextSearch,
    { ...payload, action: getWorkspaceTextAiAction() ?? payload.action },
    options
  );
}

export async function publishRemoteLlmAnalyticsEvents(
  events: LlmAnalyticsEvent[]
): Promise<LlmAnalyticsGatewayEventResponse> {
  if (events.length === 0) {
    return { accepted: 0, published: 0, skipped: false, topics: [] };
  }

  return callGcpAIGateway<LlmAnalyticsGatewayEventResponse>(
    AI_GATEWAY_PATHS.llmEvents,
    { events }
  );
}

export async function queryRemoteLlmAnalytics(
  payload: LlmAnalyticsQueryGatewayRequest
): Promise<LlmAnalyticsQueryGatewayResponse> {
  return callGcpAIGateway<LlmAnalyticsQueryGatewayResponse>(
    AI_GATEWAY_PATHS.llmAnalyticsQuery,
    payload
  );
}
