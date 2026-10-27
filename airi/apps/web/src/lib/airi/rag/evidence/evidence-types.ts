import type { RagQueryPreparation } from "@/lib/airi/rag/query/query-cleaner";

export type FactualIntent =
  | "none"
  | "factual"
  | "procedural"
  | "navigational"
  | "ambiguous";

export type CitationStrength = "none" | "preferred" | "strict";

export type PlannerMode = "heuristic" | "llm";

/**
 * Typed output of request-time query planning (replaces unconditional LLM cleaning).
 */
export interface RetrievalPlan {
  normalizedQuery: string;
  standaloneQuery: string;
  subqueries: string[];
  factualIntent: FactualIntent;
  pinnedSourceIds: string[];
  requiredCitationStrength: CitationStrength;
  plannerMode: PlannerMode;
  /**
   * When false, skip HyDE for snippets and KB rescue (planner judged expansion low value:
   * e.g. greeting, pinned short follow-up, forced blend, or decomposed compound query).
   */
  hydeRecommended: boolean;
  /** Carried for downstream execution plan + snippet/KB prep compatibility */
  ragQueryPreparation: RagQueryPreparation;
}

export type EvidenceSourceKind =
  | "kb_article"
  | "indexed_url"
  | "curated_snippet"
  | "conversation_summary"
  | "knowledge_chunk";

/**
 * Normalized evidence unit for ranking, citations, and grounded generation.
 */
export interface EvidenceChunk {
  id: string;
  sourceKind: EvidenceSourceKind;
  workspaceId?: string;
  locale?: string;
  title?: string;
  text: string;
  url?: string;
  authorityScore: number;
  freshnessAt?: string | null;
  similarity?: number;
  rerankerScore?: number;
  visibility?: string;
  metadata?: Record<string, unknown>;
}

export interface Citation {
  chunkId: string;
  label: string;
  url?: string;
  sourceKind: EvidenceSourceKind;
  excerpt?: string;
}

export interface CitationPack {
  citations: Citation[];
  primaryChunkIds: string[];
}

export interface GroundedAnswer {
  answer: string;
  citations: Citation[];
  confidence: number;
  unsupportedClaims: string[];
  /** Chunk ids the reflection model linked to the reply (subset of {@link citations}). */
  llmCitedChunkIds?: string[];
}

export type ResponsePolicy =
  | "answer"
  | "clarify"
  | "handoff"
  | "snippet_direct";

export interface EvidencePools {
  productChunks: EvidenceChunk[];
  memoryChunks: EvidenceChunk[];
}
