import { createHash } from "node:crypto";
import {
  buildEmbeddingMetadata,
  getCurrentEmbeddingMetadata,
  getDocumentEmbeddingResult,
  isEmbeddingMetadataCurrent,
} from "@/lib/ai";
import { RAG_CONFIG } from "@/lib/airi/rag/config";
import { parseStoredEmbedding } from "@/lib/ai/embedding-storage";
import type {
  EmbeddingMetadataFields,
  EmbeddingMetadataLike,
} from "@/lib/ai/embedding-types";

export type SnippetEmbeddingSource =
  | EmbeddingMetadataFields["embeddingProvider"]
  | "existing"
  | "placeholder";

type ResolveSnippetEmbeddingParams = {
  workspaceId: string;
  text?: string;
  question?: unknown;
  answer?: unknown;
  existingEmbedding?: unknown;
  existingEmbeddingFallback?: boolean;
  existingContent?: { question?: unknown; answer?: unknown };
  existingMetadata?: EmbeddingMetadataLike;
  context?: string;
};

type ResolveSnippetEmbeddingResult = {
  embedding: number[];
  source: SnippetEmbeddingSource;
  usedFallback: boolean;
  metadata: EmbeddingMetadataFields;
};

let placeholderEmbedding: number[] | null = null;

export function getExpectedEmbeddingDimensions(): number {
  return Number(RAG_CONFIG.models.embeddingDimensions || 1536);
}

export function buildSnippetEmbeddingText(params: {
  text?: string;
  question?: unknown;
  answer?: unknown;
}): string {
  const explicitText =
    typeof params.text === "string" ? params.text.trim() : "";
  if (explicitText) {
    return explicitText;
  }

  const question =
    typeof params.question === "string" ? params.question.trim() : "";
  const answer = typeof params.answer === "string" ? params.answer.trim() : "";

  if (question && answer) return `${question}\n\n${answer}`;
  if (question) return question;
  return answer;
}

export function getCurrentSnippetEmbeddingMetadata(): EmbeddingMetadataFields {
  return getCurrentEmbeddingMetadata("RETRIEVAL_DOCUMENT");
}

export function isCurrentSnippetEmbeddingMetadata(
  metadata: EmbeddingMetadataLike
): boolean {
  return isEmbeddingMetadataCurrent(metadata, "RETRIEVAL_DOCUMENT");
}

function getPlaceholderEmbedding(): number[] {
  const dimensions = getExpectedEmbeddingDimensions();
  if (!placeholderEmbedding || placeholderEmbedding.length !== dimensions) {
    const vector = new Array<number>(dimensions).fill(0);
    vector[0] = 1;
    placeholderEmbedding = vector;
  }
  return [...placeholderEmbedding];
}

function normalizeEmbeddingCandidate(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const expectedDimensions = getExpectedEmbeddingDimensions();
  if (value.length !== expectedDimensions) return null;

  const normalized = value.map(item =>
    typeof item === "number" && Number.isFinite(item) ? item : 0
  );
  const hasMagnitude = normalized.some(item => item !== 0);
  if (!hasMagnitude) return null;

  return normalized;
}

export async function resolveSnippetEmbedding(
  params: ResolveSnippetEmbeddingParams
): Promise<ResolveSnippetEmbeddingResult> {
  if (!params.workspaceId?.trim()) throw new Error("workspaceId is required");
  const embeddingText = buildSnippetEmbeddingText(params);
  const normalizedExisting = normalizeEmbeddingCandidate(
    params.existingEmbedding
  );
  if (
    normalizedExisting &&
    params.existingEmbeddingFallback === false &&
    parseStoredEmbedding(params.existingEmbedding) &&
    normalizedExisting.some(
      (value, index) => value !== (index === 0 ? 1 : 0)
    ) &&
    params.existingContent &&
    buildSnippetEmbeddingText(params.existingContent) === embeddingText &&
    isCurrentSnippetEmbeddingMetadata(params.existingMetadata)
  ) {
    return {
      embedding: normalizedExisting,
      source: "existing",
      usedFallback: false,
      metadata: params.existingMetadata as EmbeddingMetadataFields,
    };
  }
  const generated = await getDocumentEmbeddingResult(embeddingText, {
    action: {
      workspaceId: params.workspaceId,
      actionId: `snippet-embedding:${createHash("sha256").update(embeddingText).digest("hex")}`,
    },
  });
  const normalizedGenerated = normalizeEmbeddingCandidate(generated?.embedding);

  if (normalizedGenerated && generated) {
    return {
      embedding: normalizedGenerated,
      source: generated.provider,
      usedFallback: false,
      metadata: buildEmbeddingMetadata(generated),
    };
  }

  if (normalizedExisting) {
    console.warn("[Snippet Embedding] Using existing embedding fallback", {
      context: params.context || "unknown",
    });
    return {
      embedding: normalizedExisting,
      source: "existing",
      usedFallback: true,
      metadata: isCurrentSnippetEmbeddingMetadata(params.existingMetadata)
        ? (params.existingMetadata as EmbeddingMetadataFields)
        : getCurrentSnippetEmbeddingMetadata(),
    };
  }

  console.warn("[Snippet Embedding] Using placeholder embedding fallback", {
    context: params.context || "unknown",
    dimensions: getExpectedEmbeddingDimensions(),
  });
  return {
    embedding: getPlaceholderEmbedding(),
    source: "placeholder",
    usedFallback: true,
    metadata: getCurrentSnippetEmbeddingMetadata(),
  };
}
