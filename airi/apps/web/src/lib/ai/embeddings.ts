import { isWorkspaceAiPolicyError } from "./workspace-ai-errors";
import {
  getWorkspaceTextAiAction,
  withWorkspaceTextAiAction,
  type WorkspaceAiAction,
} from "./workspace-ai-policy";
export type { WorkspaceAiAction } from "./workspace-ai-policy";
import pLimit from "p-limit";
import {
  BATCH_EMBEDDING_CONCURRENCY,
  EMBEDDING_CACHE_VERSION,
  EMBEDDING_DIMENSIONS,
  QUERY_EMBEDDING_CACHE_TTL_SECONDS,
} from "./embedding-config";
import type {
  EmbeddingMetadataFields,
  EmbeddingMetadataLike,
  EmbeddingTaskType,
  GeneratedEmbedding,
} from "./embedding-types";
import {
  getVertexEmbeddingModel,
  getVertexTextEmbedding,
  normalizeEmbeddingText,
} from "./vertex-embeddings";
import {
  canCallGcpAIGateway,
  getRemoteDocumentEmbeddingResult,
  getRemoteDocumentEmbeddingResultsBatch,
  getRemoteQueryEmbeddingResultWithCache,
} from "./gcp-ai-gateway";

const embeddingInFlight = new Map<string, Promise<GeneratedEmbedding | null>>();

function formatEmbeddingError(error: unknown): {
  message: string;
  type: string;
} {
  if (error instanceof Error) {
    return { message: error.message, type: error.name };
  }
  return { message: String(error), type: "Unknown" };
}

export function getPrimaryEmbeddingModel(): string {
  return getVertexEmbeddingModel();
}

export function buildEmbeddingMetadata(
  embedding: Pick<
    GeneratedEmbedding,
    "provider" | "model" | "taskType" | "dimensions"
  >
): EmbeddingMetadataFields {
  return {
    embeddingProvider: embedding.provider,
    embeddingModel: embedding.model,
    embeddingTaskType: embedding.taskType,
    embeddingDimensions: embedding.dimensions,
  };
}

export function getCurrentEmbeddingMetadata(
  taskType: EmbeddingTaskType
): EmbeddingMetadataFields {
  return {
    embeddingProvider: "vertex",
    embeddingModel: getPrimaryEmbeddingModel(),
    embeddingTaskType: taskType,
    embeddingDimensions: EMBEDDING_DIMENSIONS,
  };
}

export function isEmbeddingMetadataCurrent(
  metadata: EmbeddingMetadataLike,
  taskType: EmbeddingTaskType
): boolean {
  if (!metadata) return false;
  const current = getCurrentEmbeddingMetadata(taskType);
  return (
    metadata.embeddingProvider === current.embeddingProvider &&
    metadata.embeddingModel === current.embeddingModel &&
    metadata.embeddingTaskType === current.embeddingTaskType &&
    Number(metadata.embeddingDimensions || 0) === current.embeddingDimensions
  );
}

async function getEmbeddingResult(
  text: string,
  options: {
    taskType: EmbeddingTaskType;
    title?: string;
  }
): Promise<GeneratedEmbedding | null> {
  const normalizedText = normalizeEmbeddingText(text);
  if (normalizedText.length < 2) {
    return null;
  }

  if (canCallGcpAIGateway()) {
    if (options.taskType === "RETRIEVAL_QUERY") {
      return await getRemoteQueryEmbeddingResultWithCache(normalizedText);
    }

    return await getRemoteDocumentEmbeddingResult({
      text: normalizedText,
      title: options.title,
    });
  }

  try {
    const vertexEmbedding = await getVertexTextEmbedding({
      text: normalizedText,
      taskType: options.taskType,
      title: options.title,
      dimensions: EMBEDDING_DIMENSIONS,
    });
    if (vertexEmbedding) {
      return vertexEmbedding;
    }
  } catch (error) {
    if (isWorkspaceAiPolicyError(error)) throw error;
    console.error("[AI] Vertex embedding failed", {
      taskType: options.taskType,
      error: formatEmbeddingError(error),
    });
  }

  return null;
}

async function buildQueryEmbeddingCacheKey(
  taskType: EmbeddingTaskType,
  text: string
): Promise<string> {
  const { buildCacheKey } = await import("@/lib/cache");
  const crypto = await import("crypto");

  const normalizedText = normalizeEmbeddingText(text);
  const hash = crypto
    .createHash("md5")
    .update(normalizedText)
    .digest("hex")
    .substring(0, 16);

  return buildCacheKey(`ai:embedding:${EMBEDDING_CACHE_VERSION}`, [
    getWorkspaceTextAiAction()?.workspaceId || "unscoped",
    "vertex",
    taskType,
    String(EMBEDDING_DIMENSIONS),
    getPrimaryEmbeddingModel(),
    hash,
  ]);
}

export async function getDocumentEmbeddingResult(
  text: string,
  options?: { title?: string; action?: WorkspaceAiAction }
): Promise<GeneratedEmbedding | null> {
  if (options?.action)
    return withWorkspaceTextAiAction(options.action, () =>
      getDocumentEmbeddingResult(text, { title: options.title })
    );
  return getEmbeddingResult(text, {
    taskType: "RETRIEVAL_DOCUMENT",
    title: options?.title,
  });
}

export async function getQueryEmbeddingResultWithCache(
  text: string,
  action?: WorkspaceAiAction
): Promise<GeneratedEmbedding | null> {
  if (action)
    return withWorkspaceTextAiAction(action, () =>
      getQueryEmbeddingResultWithCache(text)
    );
  const normalizedText = normalizeEmbeddingText(text);
  if (normalizedText.length < 2) return null;

  if (canCallGcpAIGateway()) {
    const remoteResult =
      await getRemoteQueryEmbeddingResultWithCache(normalizedText);
    if (remoteResult) {
      return remoteResult;
    }
  }

  const { cache } = await import("@/lib/cache");

  const cacheKey = await buildQueryEmbeddingCacheKey(
    "RETRIEVAL_QUERY",
    normalizedText
  );

  const cached = await cache.get<GeneratedEmbedding>(cacheKey);
  if (
    cached &&
    Array.isArray(cached.embedding) &&
    cached.embedding.length === EMBEDDING_DIMENSIONS
  ) {
    return cached;
  }

  const existingInFlight = embeddingInFlight.get(cacheKey);
  if (existingInFlight) {
    return existingInFlight;
  }

  const embeddingPromise = (async () => {
    const cachedInside = await cache.get<GeneratedEmbedding>(cacheKey);
    if (
      cachedInside &&
      Array.isArray(cachedInside.embedding) &&
      cachedInside.embedding.length === EMBEDDING_DIMENSIONS
    ) {
      return cachedInside;
    }

    const result = await getVertexTextEmbedding({
      text: normalizedText,
      taskType: "RETRIEVAL_QUERY",
      dimensions: EMBEDDING_DIMENSIONS,
    }).catch(error => {
      if (isWorkspaceAiPolicyError(error)) throw error;
      console.warn("[AI] Vertex query embedding failed", {
        error: formatEmbeddingError(error),
      });
      return null;
    });

    if (result) {
      await cache.set(cacheKey, result, QUERY_EMBEDDING_CACHE_TTL_SECONDS);
    }
    return result;
  })();

  embeddingInFlight.set(cacheKey, embeddingPromise);
  try {
    return await embeddingPromise;
  } finally {
    embeddingInFlight.delete(cacheKey);
  }
}

export async function getQueryEmbeddingWithCache(
  text: string,
  action?: WorkspaceAiAction
): Promise<number[] | null> {
  return (
    (await getQueryEmbeddingResultWithCache(text, action))?.embedding || null
  );
}

export async function getDocumentEmbeddingResultsBatch(
  texts: Array<string | { text: string; title?: string }>,
  action?: WorkspaceAiAction
): Promise<(GeneratedEmbedding | null)[]> {
  if (action)
    return withWorkspaceTextAiAction(action, () =>
      getDocumentEmbeddingResultsBatch(texts)
    );
  if (!texts || texts.length === 0) {
    return [];
  }

  if (canCallGcpAIGateway()) {
    const remoteResults = await getRemoteDocumentEmbeddingResultsBatch(texts);
    if (remoteResults.length === texts.length) {
      return remoteResults;
    }
  }

  const limit = pLimit(BATCH_EMBEDDING_CONCURRENCY);
  return Promise.all(
    texts.map(item =>
      limit(async () => {
        const payload =
          typeof item === "string"
            ? { text: item, title: undefined }
            : { text: item.text, title: item.title };
        return getDocumentEmbeddingResult(payload.text, {
          title: payload.title,
        });
      })
    )
  );
}
