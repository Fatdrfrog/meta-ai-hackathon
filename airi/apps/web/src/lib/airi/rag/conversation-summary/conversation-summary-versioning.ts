import { createHash } from "crypto";

import {
  CONVERSATION_PREFERRED_LANGUAGES,
  type ConversationPreferredLanguage,
} from "@icecore/shared/types/conversation";
import { isRecord } from "@icecore/shared/lib/value-utils";

export const CONVERSATION_SUMMARY_SLOT_NAMESPACE =
  "93850bd8-947e-5b03-8df7-8cb385daf97f";

const SOURCE_REVISION_SORT_KEY_WIDTH = 16;
export const CONVERSATION_SUMMARY_MAX_CHUNKS = 64;
const VERSION_MARKER_FIELDS = [
  "analysis_revision_id",
  "source_revision",
  "source_revision_sort_key",
  "analysis_completed_at",
] as const;
const VERSION_METADATA_FIELDS = [
  ...VERSION_MARKER_FIELDS,
  "language",
  "word_count",
  "message_count",
  "chunk_count",
  "generation_time_ms",
  "embedding_provider",
  "embedding_model",
  "embedding_task_type",
  "embedding_dimensions",
] as const;

export type ConversationSummaryVersionMetadata = {
  analysisRevisionId: string;
  sourceRevision: number;
  sourceRevisionSortKey: string;
  analysisCompletedAt: string;
  language: ConversationPreferredLanguage;
  wordCount: number;
  messageCount: number;
  chunkCount: number;
  generationTimeMs: number;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingTaskType: "RETRIEVAL_DOCUMENT";
  embeddingDimensions: 1536;
  chunkIndex: number | null;
  generationMethod?: string;
};

export type ConversationSummaryStoredRow = {
  id: string;
  workspace_id: string;
  conversation_id: string;
  summary_text: string;
  chunk_index: number | null;
  metadata: unknown;
  embedding?: unknown;
  created_at?: string | null;
  updated_at?: string | null;
};

export type CommittedConversationSummaryVersion = {
  main: ConversationSummaryStoredRow;
  chunks: ConversationSummaryStoredRow[];
  metadata: ConversationSummaryVersionMetadata;
};

function versionMetadataError(): Error {
  return new Error("Conversation summary version metadata is invalid");
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isDenseFiniteNumberVector(
  value: unknown,
  dimensions: number
): value is number[] {
  if (
    !Array.isArray(value) ||
    !Number.isSafeInteger(dimensions) ||
    dimensions <= 0 ||
    value.length !== dimensions
  ) {
    return false;
  }
  for (let index = 0; index < dimensions; index += 1) {
    if (
      !Object.prototype.hasOwnProperty.call(value, index) ||
      typeof value[index] !== "number" ||
      !Number.isFinite(value[index])
    ) {
      return false;
    }
  }
  return true;
}

function assertCanonicalIdentity(value: string, name: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new Error(`${name} must be a non-empty canonical string`);
  }
}

function uuidBytes(value: string): Buffer {
  const compact = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/u.test(compact)) {
    throw new Error("Conversation summary UUID namespace is invalid");
  }
  return Buffer.from(compact, "hex");
}

function formatUuid(bytes: Buffer): string {
  const value = bytes.toString("hex");
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join("-");
}

function uuidV5(namespace: string, name: string): string {
  const digest = createHash("sha1")
    .update(Buffer.concat([uuidBytes(namespace), Buffer.from(name, "utf8")]))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

export function buildConversationSummarySlotId(input: {
  workspaceId: string;
  conversationId: string;
  chunkIndex: number | null;
}): string {
  assertCanonicalIdentity(input.workspaceId, "workspaceId");
  assertCanonicalIdentity(input.conversationId, "conversationId");
  if (
    input.chunkIndex !== null &&
    (!Number.isSafeInteger(input.chunkIndex) ||
      input.chunkIndex < 0 ||
      input.chunkIndex >= CONVERSATION_SUMMARY_MAX_CHUNKS)
  ) {
    throw new Error("chunkIndex is invalid");
  }
  const slot = input.chunkIndex === null ? "main" : `chunk:${input.chunkIndex}`;
  return uuidV5(
    CONVERSATION_SUMMARY_SLOT_NAMESPACE,
    `${input.workspaceId}:${input.conversationId}:${slot}`
  );
}

export function buildConversationSummarySourceRevisionSortKey(
  sourceRevision: number
): string {
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision <= 0) {
    throw new Error("sourceRevision must be a positive safe integer");
  }
  return String(sourceRevision).padStart(SOURCE_REVISION_SORT_KEY_WIDTH, "0");
}

function asSafeCount(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  ) {
    throw versionMetadataError();
  }
  return value as number;
}

function asCanonicalText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw versionMetadataError();
  }
  return value;
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function parseConversationSummaryVersionMetadata(
  value: unknown,
  input: { chunkIndex: number | null }
): ConversationSummaryVersionMetadata | null {
  if (!isRecord(value)) return null;
  const hasVersionMarker = VERSION_MARKER_FIELDS.some(field =>
    hasOwn(value, field)
  );
  if (!hasVersionMarker) return null;

  try {
    const allowedFields = new Set<string>([
      ...VERSION_METADATA_FIELDS,
      ...(input.chunkIndex === null ? [] : ["chunk_index"]),
      "generation_method",
    ]);
    const requiredFieldCount =
      VERSION_METADATA_FIELDS.length + (input.chunkIndex === null ? 0 : 1);
    const keys = Object.keys(value);
    if (
      keys.some(key => !allowedFields.has(key)) ||
      VERSION_METADATA_FIELDS.some(field => !hasOwn(value, field)) ||
      (input.chunkIndex !== null && !hasOwn(value, "chunk_index")) ||
      keys.length < requiredFieldCount ||
      keys.length > requiredFieldCount + 1
    ) {
      throw versionMetadataError();
    }

    const analysisRevisionId = asCanonicalText(value.analysis_revision_id);
    const sourceRevision = value.source_revision;
    if (
      !Number.isSafeInteger(sourceRevision) ||
      (sourceRevision as number) <= 0
    ) {
      throw versionMetadataError();
    }
    const sourceRevisionSortKey = asCanonicalText(
      value.source_revision_sort_key
    );
    if (
      sourceRevisionSortKey !==
      buildConversationSummarySourceRevisionSortKey(sourceRevision as number)
    ) {
      throw versionMetadataError();
    }
    if (!isCanonicalIsoDate(value.analysis_completed_at)) {
      throw versionMetadataError();
    }
    if (
      typeof value.language !== "string" ||
      !CONVERSATION_PREFERRED_LANGUAGES.includes(
        value.language as ConversationPreferredLanguage
      )
    ) {
      throw versionMetadataError();
    }
    const chunkCount = asSafeCount(
      value.chunk_count,
      CONVERSATION_SUMMARY_MAX_CHUNKS
    );
    let chunkIndex: number | null = null;
    if (input.chunkIndex !== null) {
      chunkIndex = asSafeCount(
        value.chunk_index,
        CONVERSATION_SUMMARY_MAX_CHUNKS - 1
      );
      if (chunkIndex !== input.chunkIndex || chunkIndex >= chunkCount) {
        throw versionMetadataError();
      }
    }
    if (
      asCanonicalText(value.embedding_task_type) !== "RETRIEVAL_DOCUMENT" ||
      value.embedding_dimensions !== 1536
    ) {
      throw versionMetadataError();
    }
    const generationMethod = hasOwn(value, "generation_method")
      ? asCanonicalText(value.generation_method)
      : undefined;

    return {
      analysisRevisionId,
      sourceRevision: sourceRevision as number,
      sourceRevisionSortKey,
      analysisCompletedAt: value.analysis_completed_at,
      language: value.language as ConversationPreferredLanguage,
      wordCount: asSafeCount(value.word_count),
      messageCount: asSafeCount(value.message_count),
      chunkCount,
      generationTimeMs: asSafeCount(value.generation_time_ms),
      embeddingProvider: asCanonicalText(value.embedding_provider),
      embeddingModel: asCanonicalText(value.embedding_model),
      embeddingTaskType: "RETRIEVAL_DOCUMENT",
      embeddingDimensions: 1536,
      chunkIndex,
      ...(generationMethod === undefined ? {} : { generationMethod }),
    };
  } catch {
    throw versionMetadataError();
  }
}

export function compareConversationSummaryVersionIdentities(
  stored: Pick<
    ConversationSummaryVersionMetadata,
    "analysisRevisionId" | "sourceRevision"
  >,
  requested: { analysisRevisionId: string; sourceRevision: number }
): "older" | "same" | "newer" | "conflict" {
  if (stored.sourceRevision < requested.sourceRevision) return "older";
  if (stored.sourceRevision > requested.sourceRevision) return "newer";
  return stored.analysisRevisionId === requested.analysisRevisionId
    ? "same"
    : "conflict";
}

export function areConversationSummaryVersionMetadataEqual(
  left: ConversationSummaryVersionMetadata,
  right: ConversationSummaryVersionMetadata,
  input: { includeChunkIndex: boolean }
): boolean {
  return (
    left.analysisRevisionId === right.analysisRevisionId &&
    left.sourceRevision === right.sourceRevision &&
    left.sourceRevisionSortKey === right.sourceRevisionSortKey &&
    left.analysisCompletedAt === right.analysisCompletedAt &&
    left.language === right.language &&
    left.wordCount === right.wordCount &&
    left.messageCount === right.messageCount &&
    left.chunkCount === right.chunkCount &&
    left.generationTimeMs === right.generationTimeMs &&
    left.embeddingProvider === right.embeddingProvider &&
    left.embeddingModel === right.embeddingModel &&
    left.embeddingTaskType === right.embeddingTaskType &&
    left.embeddingDimensions === right.embeddingDimensions &&
    left.generationMethod === right.generationMethod &&
    (!input.includeChunkIndex || left.chunkIndex === right.chunkIndex)
  );
}

export function assertConversationSummaryStoredRowIdentity(
  row: ConversationSummaryStoredRow,
  input: {
    workspaceId: string;
    conversationId: string;
    chunkIndex: number | null;
  }
): void {
  if (
    row.id !== buildConversationSummarySlotId(input) ||
    row.workspace_id !== input.workspaceId ||
    row.conversation_id !== input.conversationId ||
    row.chunk_index !== input.chunkIndex ||
    typeof row.summary_text !== "string" ||
    row.summary_text.trim().length === 0
  ) {
    throw new Error("Conversation summary deterministic slot is invalid");
  }
}

export function selectCommittedConversationSummaryVersion(input: {
  workspaceId: string;
  conversationId: string;
  rows: ConversationSummaryStoredRow[];
}): CommittedConversationSummaryVersion | null {
  const mainId = buildConversationSummarySlotId({
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    chunkIndex: null,
  });
  const mains = input.rows.filter(row => row.id === mainId);
  if (mains.length === 0) return null;
  if (mains.length !== 1) {
    throw new Error("Conversation summary committed main is invalid");
  }
  const main = mains[0];
  assertConversationSummaryStoredRowIdentity(main, {
    ...input,
    chunkIndex: null,
  });
  const metadata = parseConversationSummaryVersionMetadata(main.metadata, {
    chunkIndex: null,
  });
  if (!metadata) {
    throw new Error("Conversation summary committed main is invalid");
  }

  const chunks: ConversationSummaryStoredRow[] = [];
  for (let chunkIndex = 0; chunkIndex < metadata.chunkCount; chunkIndex += 1) {
    const id = buildConversationSummarySlotId({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      chunkIndex,
    });
    const matches = input.rows.filter(row => row.id === id);
    if (matches.length !== 1) {
      throw new Error("Conversation summary committed chunks are invalid");
    }
    const row = matches[0];
    try {
      assertConversationSummaryStoredRowIdentity(row, {
        ...input,
        chunkIndex,
      });
      const chunkMetadata = parseConversationSummaryVersionMetadata(
        row.metadata,
        { chunkIndex }
      );
      if (
        !chunkMetadata ||
        !areConversationSummaryVersionMetadataEqual(metadata, chunkMetadata, {
          includeChunkIndex: false,
        })
      ) {
        throw new Error("metadata mismatch");
      }
    } catch {
      throw new Error("Conversation summary committed chunks are invalid");
    }
    chunks.push(row);
  }

  return { main, chunks, metadata };
}
