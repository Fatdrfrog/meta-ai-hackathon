import type { KnowledgeSearchPrincipal } from "@/lib/airi/rag/knowledge/knowledge-search-permissions";
import type { HyDEArtifact } from "@/lib/airi/rag/pipeline/hyde-safety";
import type { RagQueryPreparation } from "@/lib/airi/rag/query/query-cleaner";
import type { StartKnowledgeCanonicalSyncWorkflowParams } from "@/lib/temporal/knowledge-canonical-sync-client";
import type { KnowledgeCanonicalSyncSourceKind } from "@icecore/temporal";

// ---------------------------------------------------------------------------
// Mirrored KB layer (canonical documents + hybrid RAG hits)
// ---------------------------------------------------------------------------

/** Product sources mirrored into canonical knowledge documents and chunks. */
export type KbMirroredSourceKind = KnowledgeCanonicalSyncSourceKind;

export type KnowledgeCanonicalSourceKind = KbMirroredSourceKind;
export type LogicalMirroredSourceKind = KbMirroredSourceKind;

// ---------------------------------------------------------------------------
// Retrieval (vector / HyDE / FTS / chunks)
// ---------------------------------------------------------------------------

export type KBRetrievalMethod =
  | "vector"
  | "hyde_vector"
  | "fts"
  | "search_vector"
  | "pinned"
  | "indexed_url"
  | "knowledge_chunk";

export interface KBArticleResult {
  id: string;
  title: string;
  fullContent: string;
  similarity: number;
  rerankerScore?: number;
  _originalSimilarity?: number;
  _reranked?: boolean;
  locale: string;
  tags?: string[];
  url?: string;
  sourceType?: KbMirroredSourceKind;
  sourceRecordId?: string;
  documentId?: string;
  chunkIndex?: number;
  citationLabel?: string | null;
  documentTitle?: string | null;
  retrievalMethod?: KBRetrievalMethod;
  contextFormat?: "preview" | "full";
  verificationStatus?: "verified" | "unverified" | "failed";
  verificationConfidence?: number;
  allowAutoLinkEmbedding?: boolean;
  embeddedSourceUrls?: string[];
  wasHydeApplied?: boolean;
  hydeHypotheticalAnswer?: string;
  chunkFusedScore?: number;
  chunkAuthorityScore?: number;
  chunkFreshnessAt?: string | null;
}

export interface KBRetrievalOptions {
  limit?: number;
  threshold?: number;
  includeFullContent?: boolean;
  queryEmbedding?: number[];
  enableHyDERescue?: boolean;
  ragQueryPreparation?: RagQueryPreparation;
  knowledgeSearchPrincipal?: KnowledgeSearchPrincipal;
  matchAllowedVisibilities?: string[] | null;
  matchSourceKinds?: KnowledgeCanonicalSourceKind[] | null;
  hydeRecommended?: boolean;
  onHyDEApplied?: (artifact: HyDEArtifact) => void;
}

export type CanonicalKnowledgeChunkRow = {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  locale: string | null;
  source_kind: string;
  source_record_id: string;
  title: string | null;
  citation_label?: string | null;
  document_title?: string | null;
  canonical_url: string | null;
  authority_score: number;
  freshness_at: string | null;
  distance: number;
  fused_score: number;
};

export type QueryKnowledgeChunksParams = {
  workspaceId: string;
  queryText: string;
  queryEmbedding: number[];
  matchCount: number;
  matchThreshold: number;
  matchLocale: string | null;
  matchSourceKinds?: string[] | null;
  knowledgeSearchPrincipal?: KnowledgeSearchPrincipal;
  matchAllowedVisibilities?: string[] | null;
  fullTextWeight?: number;
  semanticWeight?: number;
  rrfK?: number;
};

export type KnowledgeSyncRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export interface KnowledgeSyncResult {
  documentsTouched: number;
  chunksUpserted: number;
  chunksDeleted: number;
  status: KnowledgeSyncRunStatus;
  errorMessage?: string;
}

export type RunKnowledgeCanonicalSyncInput = {
  workspaceId: string;
  sourceKinds?: KnowledgeCanonicalSourceKind[];
  sourceRecordIds?: string[];
  dryRun?: boolean;
};

export type RunKnowledgeCanonicalSyncResult = {
  workspaceId: string;
  bySource: Record<string, KnowledgeSyncResult>;
  syncRunIds: string[];
};

export type KBVersionRow = {
  content_mdx: string | null;
  version: number | null;
};

export type UpsertKnowledgeDocumentParams = {
  workspaceId: string;
  sourceKind: string;
  sourceRecordId: string;
  title?: string | null;
  canonicalUrl?: string | null;
  locale?: string | null;
  authorityScore: number;
  metadata?: Record<string, unknown>;
};

export type DeleteKnowledgeDocumentBySourceParams = {
  workspaceId: string;
  sourceKind: string;
  sourceRecordId: string;
};

export type StartKnowledgeSyncRunParams = {
  workspaceId: string | null;
  sourceKind: string;
  metadata?: Record<string, unknown>;
};

export type FinishKnowledgeSyncRunParams = {
  runId: string;
  status: "completed" | "failed";
  documentsTouched: number;
  chunksUpserted: number;
  chunksDeleted: number;
  errorMessage?: string | null;
};

export type EnqueueKnowledgeCanonicalSyncParams =
  StartKnowledgeCanonicalSyncWorkflowParams & {
    context: string;
  };
