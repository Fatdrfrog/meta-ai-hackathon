import type { ConversationPreferredLanguage } from "@icecore/shared/types/conversation";
import type { HyDEArtifact } from "@/lib/airi/rag/pipeline/hyde-safety";
export {
  getKBCandidateThreshold,
  hasStrongKBRerankerSupport,
  isHighConfidenceKB,
  isVerifiedKBArticle,
} from "@/lib/airi/rag/kb/kb-confidence";

export type RetrievalBlendReason =
  | "thread_plan"
  | "pinned_grounding"
  | "compound_query"
  | "service_overview";

export type RetrievalQueryVariantPurpose =
  | "primary"
  | "decomposition"
  | "pinned_followup"
  | "service_overview";

export interface RetrievedAnswer {
  id?: string;
  answer: string;
  question: string;
  score: number;
  rerankerScore?: number;
  verifiedByReranker?: boolean;
  textScore?: number;
  category?: string;
  tags?: string[];
  wasHydeApplied?: boolean;
  hydeHypotheticalAnswer?: string;
  language?: string;
  retrievalMethod?: "knowledge_chunk";
}

export type { KBArticleResult } from "@/lib/airi/rag/kb/kb-types";

export type {
  EvidenceChunk,
  EvidencePools,
  GroundedAnswer,
  ResponsePolicy,
  RetrievalPlan,
} from "@/lib/airi/rag/evidence/evidence-types";

export type CompanyLanguage = ConversationPreferredLanguage;
export interface HybridContext {
  /** Answer snippet from MongoDB */
  snippet?: RetrievedAnswer;

  /** Whether the snippet passed LLM verification */
  snippetVerified?: boolean;

  /** Verification details for debugging */
  snippetVerification?: {
    isRelevant: boolean;
    confidence: number;
    reason: string;
  };

  /** KB articles from Supabase (comprehensive docs) */
  kbArticles: import("@/lib/airi/rag/kb/kb-types").KBArticleResult[];

  /** Whether KB articles were reranked by the LLM reranker */
  kbReranked?: boolean;

  /** KB article verification metadata (optional; e.g. future pipeline steps) */
  kbArticleVerification?: Array<{
    articleId: string;
    verified: boolean;
    confidence: number;
  }>;

  /** Conversation summaries from other conversations (cross-conversation RAG) */
  conversationSummaries?: import("@/lib/airi/rag/conversation-summary/conversation-summary-retrieval").ConversationSummaryResult[];

  /** Company business context */
  companyContext?: {
    businessContext?: string;
    dynamicTags?: string[];
    airiLanguage?: CompanyLanguage;
  };

  /** Retrieval performance metadata */
  retrievalStats: {
    snippetScore?: number;
    kbArticlesCount: number;
    topKBSimilarity?: number;
    totalRetrievalTimeMs: number;
    rerankTimeMs?: number;
    verificationTimeMs?: number;
    translationTimeMs?: number;
    /** Sub-phase wall times inside the retrieval orchestrator (for latency breakdown) */
    phaseTimingsMs?: {
      setupMs: number;
      parallelRetrievalMs: number;
      translationFallbackMs: number;
      rerankMs: number;
      verificationMs: number;
      rrfMs: number;
    };
    /** Per-retriever wall times for the retrieval stage; used to identify regressions before tuning */
    stageTimingsMs?: {
      originalRetrieval?: {
        totalMs?: number;
        queryEmbeddingMs?: number;
        snippetMs?: number;
        pinnedSnippetMs?: number;
        primaryKbMs?: number;
        pinnedKbMs?: number;
        summaryMs?: number;
        stageTwoKbMs?: number;
        stageTwoKbQueryCount?: number;
      };
      translationFallback?: {
        totalMs?: number;
        translationBuildMs?: number;
        translationRetrievalMs?: number;
      };
    };
    snippetShortCircuitedKB?: boolean;
    forcedBlendedRetrieval?: boolean;
    forcedBlendedReason?: RetrievalBlendReason;
    queryVariants?: string[];
    queryVariantPlans?: Array<{
      query: string;
      purpose: RetrievalQueryVariantPurpose;
      stage: 1 | 2;
    }>;
    retrievalBudget?: {
      maxKbVectorQueries: number;
      maxExtraQueryVariants: number;
      maxPinnedKbPasses: number;
    };
    pinnedSourceIds?: string[];
    /** Evidence layer telemetry (product vs memory pools) */
    evidenceProductChunkIds?: string[];
    evidenceMemoryChunkIds?: string[];
    plannerMode?: string;
    factualIntent?: string;
    requiredCitationStrength?: string;
    hydeApplied?: boolean;
    hydeSources?: Array<HyDEArtifact["source"]>;
    /** Internal generation safety metadata; not surfaced in standard retrieval summaries. */
    hydeArtifacts?: HyDEArtifact[];
    /** Query-type thresholds used for retrieval; drives KB admission in the decision layer */
    queryClassification?: {
      type: import("@/lib/airi/rag/query/query-type-classifier").QueryType;
      retrievalKbThreshold: number;
      kbAdmissionThreshold: number;
    };
  };

  /** Query translation info (for cross-language RAG) */
  queryTranslation?: {
    wasTranslated: boolean;
    originalQuery: string;
    translatedQuery: string;
    fromLang: string;
    toLang: string;
  };

  /** RRF Fusion result (if enabled) */
  rrfResult?: import("@/lib/airi/rrf-fusion").RRFFusionResult;

  /** Request-time retrieval planner output (evidence / grounded answering). */
  retrievalPlan?: import("@/lib/airi/rag/evidence/evidence-types").RetrievalPlan;
}

/** Canonical retrieval surface for dashboards (wide event `retrievalPath`). */
export type RagRetrievalPath = "snippet" | "kb" | "blended" | "none";

export function isRagRetrievalPath(value: unknown): value is RagRetrievalPath {
  return (
    value === "snippet" ||
    value === "kb" ||
    value === "blended" ||
    value === "none"
  );
}

/**
 * Context decision result
 */
export interface ContextDecision {
  /** Whether to use snippet in response */
  useSnippet: boolean;

  /** Whether to use KB articles in response */
  useKB: boolean;

  /** Priority level for context usage */
  priority: "snippet" | "kb" | "conversation_summary" | "generic";

  /** Human-readable reasoning */
  reasoning: string;
}

/**
 * Options for hybrid retrieval
 */
export interface HybridRetrievalOptions {
  /** Include answer snippets (default: true) */
  includeSnippets?: boolean;

  /** Include KB articles (default: true) */
  includeKB?: boolean;

  /** Include conversation summaries (default: true) */
  includeConversationSummaries?: boolean;

  /**
   * Exclude this conversation when retrieving cross-conversation summaries (active thread id).
   */
  excludeConversationSummaryId?: string;

  /** Include company context (default: true) */
  includeCompanyContext?: boolean;

  /** Number of KB articles to retrieve (default: 3) */
  kbLimit?: number;

  /** KB similarity threshold (default: 0.75) */
  kbThreshold?: number;

  /** Answer snippet threshold (default: 0.82) */
  snippetThreshold?: number;

  /** Phase 2.5: Conversation context (full conversation window with agent responses) for HyDE */
  conversationContext?: string;

  /** Enable LLM reranking for snippets and KB articles (default: true) */
  enableReranking?: boolean;

  /** Enable LLM verification for snippets (default: true) */
  enableVerification?: boolean;

  /** Prefer broader article context instead of aggressive narrowing. */
  preferBroadKbContext?: boolean;

  /** Enable HyDE (Hypothetical Document Embedding) for snippets (default: true) */
  enableHyDE?: boolean;

  /** Enable translation fallback for cross-language queries (default: true) */
  enableTranslation?: boolean;

  /**
   * Skip `prepareQueryForRagWithLlm` in the retrieval planner (heuristic prep only).
   * Used with channel fast mode to avoid a full LLM prep pass before embeddings.
   */
  skipLlmRetrievalPlanner?: boolean;

  /**
   * When `originalQuery` matches the retrieval query string, the planner reuses this
   * prep instead of a second {@link import("@/lib/airi/rag/query/query-cleaner").prepareQueryForRagWithLlm} call.
   */
  seedRagQueryPreparation?: import("@/lib/airi/rag/query/query-cleaner").RagQueryPreparation;

  /** Restrict snippet retrieval to these snippet document IDs */
  allowedSnippetIds?: string[];

  /** Force blended retrieval instead of winner-takes-all snippet routing */
  forceBlendedRetrieval?: boolean;

  /** Why blended retrieval was forced for this request */
  forceBlendedReason?: RetrievalBlendReason;

  /** Additional query variants for compound asks and follow-ups */
  queryVariants?: string[];

  /** Pinned grounding sources from the last trusted answer */
  pinnedGrounding?: {
    sourceKind: "snippet" | "kb" | "mixed" | "none";
    sourceIds: string[];
  };

  /** Canonical chunk search principal (default: `rag_auto_reply`). */
  knowledgeSearchPrincipal?: import("@/lib/airi/rag/knowledge/knowledge-search-permissions").KnowledgeSearchPrincipal;
  /** Overrides visibility allowlist for hybrid `match_knowledge_chunks`; `null` = unrestricted. */
  matchAllowedVisibilities?: string[] | null;
  /** Restrict canonical chunk sources used as customer-facing KB context. */
  matchSourceKinds?:
    | import("@/lib/airi/rag/kb/kb-types").KnowledgeCanonicalSourceKind[]
    | null;

  /** Precomputed LLM retrieval intent to avoid duplicate routing calls. */
  retrievalIntent?: import("@/lib/airi/rag/query/retrieval-intent-classifier").RetrievalIntentClassification;
}

// =============================================================================
// RETRIEVAL PHASE TYPES
// =============================================================================

/**
 * Type guard: Check if snippet meets standard threshold
 */
export function meetsSnippetThreshold(
  snippet: RetrievedAnswer | undefined,
  threshold: number = 0.79
): boolean {
  return Boolean(
    snippet && (snippet.verifiedByReranker || (snippet.score ?? 0) >= threshold)
  );
}
