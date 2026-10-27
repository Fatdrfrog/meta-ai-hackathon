import mongoose from "mongoose";

import { randomUUID } from "node:crypto";
import {
  CONVERSATION_CLASSIFICATION_PROVENANCE_KINDS,
  CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION,
  hasCurrentConversationClassification,
} from "@icecore/shared/lib/conversation-classification-freshness";
import { cosineSimilarity, getQueryEmbeddingWithCache } from "@/lib/ai";
import { RAG_CONFIG } from "@/lib/airi/rag/config";
import {
  areConversationSummaryVersionMetadataEqual,
  assertConversationSummaryStoredRowIdentity,
  buildConversationSummarySlotId,
  CONVERSATION_SUMMARY_MAX_CHUNKS,
  isDenseFiniteNumberVector,
  parseConversationSummaryVersionMetadata,
  type ConversationSummaryStoredRow,
  type ConversationSummaryVersionMetadata,
} from "@/lib/airi/rag/conversation-summary/conversation-summary-versioning";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { Conversation } from "@/models/conversation";
import { isRecord } from "@icecore/shared/lib/value-utils";

const EMBEDDING_DIMENSIONS = 1536;
const SLOT_READ_BATCH_SIZE = 100;
const MAX_CANDIDATES = 512;
const EXACT_ROW_SELECT =
  "id, workspace_id, conversation_id, summary_text, chunk_index, metadata, created_at, updated_at";
const MANUAL_ROW_SELECT = `${EXACT_ROW_SELECT}, embedding`;

export interface ConversationSummaryResult {
  conversationId: string;
  summaryText: string;
  chunkIndex: number | null;
  similarity: number;
  metadata?: Record<string, unknown>;
}

type Candidate = ConversationSummaryResult & {
  id: string | null;
  version: ConversationSummaryVersionMetadata | null;
};

export interface ConversationSummaryRetrievalOptions {
  limit?: number;
  threshold?: number;
  excludeConversationId?: string;
  queryEmbedding?: number[];
}

function asError(error: unknown, fallback: string): Error {
  if (
    isRecord(error) &&
    typeof error.message === "string" &&
    error.message.length > 0
  ) {
    return new Error(error.message);
  }
  return new Error(fallback);
}

function assertEmbedding(value: unknown): number[] {
  if (!isDenseFiniteNumberVector(value, EMBEDDING_DIMENSIONS)) {
    throw new Error("Conversation summary query embedding is invalid");
  }
  return [...value];
}

function parsePgVector(value: unknown): number[] {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      throw new Error("Conversation summary stored embedding is invalid");
    }
  }
  if (!isDenseFiniteNumberVector(candidate, EMBEDDING_DIMENSIONS)) {
    throw new Error("Conversation summary stored embedding is invalid");
  }
  return candidate as number[];
}

function normalizeChunkIndex(value: unknown): number | null {
  if (value === null) return null;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) >= CONVERSATION_SUMMARY_MAX_CHUNKS
  ) {
    throw new Error("Conversation summary candidate chunk index is invalid");
  }
  return value as number;
}

function normalizeCandidate(
  value: unknown,
  input: { requireId: boolean }
): Candidate {
  if (!isRecord(value)) {
    throw new Error("Conversation summary candidate is invalid");
  }
  const conversationId = value.conversation_id;
  const summaryText = value.summary_text;
  const similarity = value.similarity;
  const id = value.id;
  if (
    typeof conversationId !== "string" ||
    conversationId.trim().length === 0 ||
    typeof summaryText !== "string" ||
    summaryText.trim().length === 0 ||
    typeof similarity !== "number" ||
    !Number.isFinite(similarity) ||
    (input.requireId && (typeof id !== "string" || id.trim().length === 0))
  ) {
    throw new Error("Conversation summary candidate is invalid");
  }
  const chunkIndex = normalizeChunkIndex(value.chunk_index);
  const version = parseConversationSummaryVersionMetadata(value.metadata, {
    chunkIndex,
  });
  return {
    id: typeof id === "string" ? id : null,
    conversationId,
    summaryText,
    chunkIndex,
    similarity,
    version,
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
  };
}

function normalizeExactRow(value: unknown): ConversationSummaryStoredRow {
  if (!isRecord(value)) {
    throw new Error("Conversation summary exact slot row is invalid");
  }
  const chunkIndex = normalizeChunkIndex(value.chunk_index);
  if (
    typeof value.id !== "string" ||
    typeof value.workspace_id !== "string" ||
    typeof value.conversation_id !== "string" ||
    typeof value.summary_text !== "string"
  ) {
    throw new Error("Conversation summary exact slot row is invalid");
  }
  return {
    id: value.id,
    workspace_id: value.workspace_id,
    conversation_id: value.conversation_id,
    summary_text: value.summary_text,
    chunk_index: chunkIndex,
    metadata: value.metadata,
    ...(Object.prototype.hasOwnProperty.call(value, "embedding")
      ? { embedding: value.embedding }
      : {}),
    ...(typeof value.created_at === "string" || value.created_at === null
      ? { created_at: value.created_at }
      : {}),
    ...(typeof value.updated_at === "string" || value.updated_at === null
      ? { updated_at: value.updated_at }
      : {}),
  };
}

function chunk<T>(values: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}

async function loadExactRows(input: {
  workspaceId: string;
  ids: string[];
}): Promise<Map<string, ConversationSummaryStoredRow>> {
  const rows = new Map<string, ConversationSummaryStoredRow>();
  const uniqueIds = [...new Set(input.ids)];
  for (const batch of chunk(uniqueIds, SLOT_READ_BATCH_SIZE)) {
    if (batch.length === 0) continue;
    const { data, error } = await supabaseAdmin
      .from("conversation_summaries")
      .select(EXACT_ROW_SELECT)
      .eq("workspace_id", input.workspaceId)
      .in("id", batch);
    if (error)
      throw asError(error, "Conversation summary exact slot read failed");
    if (!Array.isArray(data)) {
      throw new Error("Conversation summary exact slot rows are invalid");
    }
    for (const value of data) {
      const row = normalizeExactRow(value);
      if (row.workspace_id !== input.workspaceId || rows.has(row.id)) {
        throw new Error("Conversation summary exact slot rows are invalid");
      }
      rows.set(row.id, row);
    }
  }
  return rows;
}

function buildCandidateSlotId(
  workspaceId: string,
  candidate: Candidate
): string {
  return buildConversationSummarySlotId({
    workspaceId,
    conversationId: candidate.conversationId,
    chunkIndex: candidate.chunkIndex,
  });
}

function buildMainSlotId(workspaceId: string, conversationId: string): string {
  return buildConversationSummarySlotId({
    workspaceId,
    conversationId,
    chunkIndex: null,
  });
}

function verifyVersionedCandidate(input: {
  workspaceId: string;
  candidate: Candidate;
  exactRows: Map<string, ConversationSummaryStoredRow>;
}): { candidate: Candidate; main: ConversationSummaryVersionMetadata } | null {
  const candidateVersion = input.candidate.version;
  if (!candidateVersion) return null;
  const candidateId = buildCandidateSlotId(input.workspaceId, input.candidate);
  const exactCandidate = input.exactRows.get(candidateId);
  const exactMain = input.exactRows.get(
    buildMainSlotId(input.workspaceId, input.candidate.conversationId)
  );
  if (!exactCandidate || !exactMain) return null;
  if (input.candidate.id !== null && input.candidate.id !== candidateId)
    return null;
  try {
    assertConversationSummaryStoredRowIdentity(exactCandidate, {
      workspaceId: input.workspaceId,
      conversationId: input.candidate.conversationId,
      chunkIndex: input.candidate.chunkIndex,
    });
    assertConversationSummaryStoredRowIdentity(exactMain, {
      workspaceId: input.workspaceId,
      conversationId: input.candidate.conversationId,
      chunkIndex: null,
    });
  } catch {
    return null;
  }
  if (
    exactCandidate.workspace_id !== input.workspaceId ||
    exactCandidate.conversation_id !== input.candidate.conversationId ||
    exactCandidate.summary_text !== input.candidate.summaryText ||
    exactCandidate.chunk_index !== input.candidate.chunkIndex ||
    exactMain.workspace_id !== input.workspaceId ||
    exactMain.conversation_id !== input.candidate.conversationId ||
    exactMain.chunk_index !== null
  ) {
    return null;
  }
  const exactCandidateVersion = parseConversationSummaryVersionMetadata(
    exactCandidate.metadata,
    { chunkIndex: exactCandidate.chunk_index }
  );
  const mainVersion = parseConversationSummaryVersionMetadata(
    exactMain.metadata,
    {
      chunkIndex: null,
    }
  );
  if (!exactCandidateVersion || !mainVersion) return null;
  if (
    !areConversationSummaryVersionMetadataEqual(
      candidateVersion,
      exactCandidateVersion,
      {
        includeChunkIndex: true,
      }
    ) ||
    !areConversationSummaryVersionMetadataEqual(
      exactCandidateVersion,
      mainVersion,
      {
        includeChunkIndex: false,
      }
    ) ||
    (input.candidate.chunkIndex !== null &&
      input.candidate.chunkIndex >= mainVersion.chunkCount)
  ) {
    return null;
  }
  return { candidate: input.candidate, main: mainVersion };
}

function hasEnteredClassificationContractV2(value: unknown): boolean {
  if (!isRecord(value)) return true;
  const state = value.classification_state;
  const metadata = value.classification_meta;
  return (
    (isRecord(state) &&
      typeof state.contractVersion === "number" &&
      Number.isSafeInteger(state.contractVersion) &&
      state.contractVersion >=
        CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION) ||
    (isRecord(metadata) &&
      (metadata.provenance_kind ===
        CONVERSATION_CLASSIFICATION_PROVENANCE_KINDS[0] ||
        (typeof metadata.analysis_revision_id === "string" &&
          metadata.analysis_revision_id.trim().length > 0)))
  );
}

function objectIdString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof mongoose.Types.ObjectId) return value.toHexString();
  if (isRecord(value) && typeof value.toString === "function") {
    const result = value.toString();
    return typeof result === "string" ? result : null;
  }
  return null;
}

async function applyCurrentnessGate(input: {
  workspaceId: string;
  candidates: Candidate[];
  limit: number;
  excludeConversationId?: string;
}): Promise<ConversationSummaryResult[]> {
  const validCandidates = input.candidates.filter(candidate =>
    mongoose.isObjectIdOrHexString(candidate.conversationId)
  );
  if (validCandidates.length === 0) return [];

  const idsToLoad = validCandidates.flatMap(candidate => [
    buildMainSlotId(input.workspaceId, candidate.conversationId),
    ...(candidate.version
      ? [buildCandidateSlotId(input.workspaceId, candidate)]
      : []),
  ]);
  const exactRows = await loadExactRows({
    workspaceId: input.workspaceId,
    ids: idsToLoad,
  });

  const verified: Array<{
    candidate: Candidate;
    main: ConversationSummaryVersionMetadata | null;
  }> = [];
  for (const candidate of validCandidates) {
    if (candidate.version) {
      const versioned = verifyVersionedCandidate({
        workspaceId: input.workspaceId,
        candidate,
        exactRows,
      });
      if (versioned) verified.push({ candidate, main: versioned.main });
      continue;
    }
    if (
      exactRows.has(
        buildMainSlotId(input.workspaceId, candidate.conversationId)
      )
    ) {
      continue;
    }
    verified.push({ candidate, main: null });
  }
  if (verified.length === 0) return [];

  const conversationIds = [
    ...new Set(verified.map(item => item.candidate.conversationId)),
  ];
  const conversations = await Conversation.find({
    _id: {
      $in: conversationIds.map(id => new mongoose.Types.ObjectId(id)),
    },
    workspaceId: input.workspaceId,
  })
    .select(
      "_id workspaceId is_classified classification_revision classification_state classification_meta"
    )
    .lean()
    .exec();
  if (!Array.isArray(conversations)) {
    throw new Error("Conversation summary currentness rows are invalid");
  }
  const conversationsById = new Map<string, unknown>();
  for (const conversation of conversations) {
    if (!isRecord(conversation)) continue;
    const id = objectIdString(conversation._id);
    if (id) conversationsById.set(id, conversation);
  }

  const results: ConversationSummaryResult[] = [];
  const seenCandidates = new Set<string>();
  for (const item of verified) {
    const candidate = item.candidate;
    const conversation = conversationsById.get(candidate.conversationId);
    if (!conversation || !isRecord(conversation)) continue;
    if (conversation.workspaceId !== input.workspaceId) continue;
    if (item.main) {
      if (!hasCurrentConversationClassification(conversation)) continue;
      const revision = conversation.classification_revision;
      const metadata = conversation.classification_meta;
      if (
        revision !== item.main.sourceRevision ||
        !isRecord(metadata) ||
        metadata.analysis_revision_id !== item.main.analysisRevisionId
      ) {
        continue;
      }
    } else if (hasEnteredClassificationContractV2(conversation)) {
      continue;
    }
    if (
      input.excludeConversationId &&
      candidate.conversationId === input.excludeConversationId
    ) {
      continue;
    }
    const candidateIdentity = `${candidate.conversationId}:${candidate.chunkIndex ?? "main"}:${item.main?.analysisRevisionId ?? "legacy"}:${candidate.summaryText}`;
    if (seenCandidates.has(candidateIdentity)) continue;
    seenCandidates.add(candidateIdentity);
    results.push({
      conversationId: candidate.conversationId,
      summaryText: candidate.summaryText,
      chunkIndex: candidate.chunkIndex,
      similarity: candidate.similarity,
      ...(candidate.metadata ? { metadata: candidate.metadata } : {}),
    });
    if (results.length >= input.limit) break;
  }
  return results;
}

async function readManualCandidates(input: {
  workspaceId: string;
  queryEmbedding: number[];
  candidateCount: number;
  threshold: number;
}): Promise<Candidate[]> {
  const { data, error } = await supabaseAdmin
    .from("conversation_summaries")
    .select(MANUAL_ROW_SELECT)
    .eq("workspace_id", input.workspaceId)
    .not("embedding", "is", null)
    .limit(input.candidateCount);
  if (error) throw asError(error, "Conversation summary manual search failed");
  if (!Array.isArray(data)) {
    throw new Error("Conversation summary manual candidates are invalid");
  }
  if (data.length > input.candidateCount) {
    throw new Error("Conversation summary manual candidate limit exceeded");
  }
  return data
    .map(value => {
      if (!isRecord(value)) {
        throw new Error("Conversation summary manual candidate is invalid");
      }
      const embedding = parsePgVector(value.embedding);
      const similarity = cosineSimilarity(input.queryEmbedding, embedding);
      if (!Number.isFinite(similarity)) {
        throw new Error("Conversation summary similarity is invalid");
      }
      return normalizeCandidate({ ...value, similarity }, { requireId: true });
    })
    .filter(candidate => candidate.similarity >= input.threshold)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, input.candidateCount);
}

export async function retrieveConversationSummaries(
  workspaceId: string,
  query: string,
  options: ConversationSummaryRetrievalOptions = {}
): Promise<ConversationSummaryResult[]> {
  if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
    throw new Error("Conversation summary workspace is invalid");
  }
  const limit = options.limit ?? RAG_CONFIG.limits.conversationSummaries;
  const threshold =
    options.threshold ?? RAG_CONFIG.thresholds.conversationSummaryRetrieval;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_CANDIDATES) {
    throw new Error("Conversation summary result limit is invalid");
  }
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
    throw new Error("Conversation summary threshold is invalid");
  }
  const queryEmbedding = assertEmbedding(
    options.queryEmbedding ??
      (await getQueryEmbeddingWithCache(query, {
        workspaceId,
        actionId: `summary-retrieval:${randomUUID()}`,
      }))
  );
  const candidateCount = Math.min(Math.max(limit * 8, 32), MAX_CANDIDATES);

  const { data: rpcData, error: rpcError } = await supabaseAdmin.rpc(
    "match_conversation_summaries",
    {
      query_embedding: queryEmbedding,
      match_threshold: threshold,
      match_count: candidateCount,
      workspace_filter: workspaceId,
    }
  );

  const candidates = rpcError
    ? await readManualCandidates({
        workspaceId,
        queryEmbedding,
        candidateCount,
        threshold,
      })
    : (() => {
        if (rpcData === null || rpcData === undefined) return [];
        if (!Array.isArray(rpcData)) {
          throw new Error("Conversation summary RPC candidates are invalid");
        }
        if (rpcData.length > candidateCount) {
          throw new Error("Conversation summary RPC candidate limit exceeded");
        }
        return rpcData.map(value =>
          normalizeCandidate(value, { requireId: false })
        );
      })();

  return applyCurrentnessGate({
    workspaceId,
    candidates,
    limit,
    excludeConversationId: options.excludeConversationId,
  });
}
