import {
  EMBEDDING_DIMENSIONS,
  PRIMARY_EMBEDDING_MODEL_FALLBACK,
} from "@/lib/ai/embedding-config";

export const RAG_CONFIG = {
  thresholds: {
    kb: 0.72,
    kbRetrievalStageRatio: 0.9,
    kbAdmissionFloor: 0.62,
    kbAdmissionCeiling: 0.82,
    kbCandidate: 0.55,
    kbReranked: 0.7,
    snippet: 0.82,
    snippetReranked: 0.85,
    snippetVerified: 0.85,
    verificationConfidence: 0.7,
    kbNearAdmissionEpsilon: 0.012,
    factualGuardRetrievedKbFloor: 0.71,
    /** `isHighConfidenceKB` for indexed URL chunks: `Math.min(mainKbThreshold, this)`. */
    indexedUrlSimilarityCeiling: 0.35,
    /** Vector retrieval for the dedicated direct conversation-memory path. */
    conversationSummaryRetrieval: 0.8,
    /**
     * Confidence-gated abstention floor (Phase 3.1 rag-production-hardening).
     * When the reranker ran and the top article's `rerankerScore` is below this
     * value, the decision engine refuses the KB branch and falls through to the
     * generic "no confident evidence" fallback. Prevents the LLM from guessing
     * on weakly-ranked KB matches. Override with `RAG_ABSTAIN_RERANK_FLOOR`.
     */
    abstainRerankerFloor: (() => {
      const raw = Number(process.env.RAG_ABSTAIN_RERANK_FLOOR);
      return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.55;
    })(),
    /**
     * Snippet verification skip-floor (Phase 3.4 rag-production-hardening).
     * When the reranker scored the top snippet above this value, we accept
     * it without the follow-up `verifySnippetRelevance` LLM call. The cross
     * encoder already read query + snippet together; a second LLM pass at
     * high confidence is redundant latency. Set low enough to preserve the
     * LLM pass for borderline matches. Override with `RAG_SNIPPET_SKIP_VERIFY_FLOOR`.
     */
    snippetSkipVerifyRerankerFloor: (() => {
      const raw = Number(process.env.RAG_SNIPPET_SKIP_VERIFY_FLOOR);
      return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.85;
    })(),
  },

  limits: {
    kbArticles: 5,
    /** Fast reply path (reduced retrieval work; was hardcoded alongside kbArticles). */
    kbArticlesFastPath: 3,
    /**
     * Cap for broad-overview KB selection (`Math.min` with {@link kbArticles}).
     * Keeps overview prompts from listing more than this many distinct articles.
     */
    kbArticlesBroadOverviewMax: 4,
    /** Coach context: KB articles injected into prompt (not full RAG reply limit). */
    kbArticlesCoach: 2,
    /** Diagnostics payload: KB rows shown in retrieval summary. */
    kbDiagnosticsPreview: 3,
    /** Cross-conversation summary rows retrieved for hybrid RAG memory pool. */
    conversationSummaries: 3,
    factualGuardRetrievedTopKbArticles: 5,
    snippets: 5,
    textPreview: 100,
    ragQueryPrepMaxOutputTokens: 1024,
    translationQueryPrepMaxOutputTokens: 512,
    /** Citation excerpt length in packs / UI (grounding). */
    citationPackExcerptMaxLen: 220,
    /** LLM grounding reflection excerpt cap per source. */
    groundingReflectionExcerptCap: 480,
  },

  /**
   * Text generation models come from the tier getters in `@/lib/ai`
   * (`getLightTextModel`, `getHeavyTextModel`), not from this config.
   */
  models: {
    embedding: PRIMARY_EMBEDDING_MODEL_FALLBACK,
    embeddingDimensions: EMBEDDING_DIMENSIONS,
  },

  features: {
    enableReranking: true,
    /** Default for generic `retrieveHybridContext` callers (orchestrator). */
    enableVerification: true,
    enableHyDE: true,
    groundedStrictCitation: process.env.AIRI_RAG_GROUNDED_STRICT === "1",
    enableLlmGroundingReflection: process.env.AIRI_RAG_LLM_GROUNDING !== "0",
    /**
     * LLM snippet relevance check in assistant auto-reply hybrid retrieval (+1 call).
     * Off by default; set `AIRI_RAG_ASSISTANT_SNIPPET_VERIFY=1` to enable.
     */
    assistantReplySnippetVerification:
      process.env.AIRI_RAG_ASSISTANT_SNIPPET_VERIFY === "1",
    /**
     * Canonical-snippets path (Phase 2 of rag-production-hardening).
     * Answer-snippets are retrieved exclusively from `knowledge_chunks` via
     * `match_knowledge_chunks` (single RPC, single store). The Mongo
     * `snippet-search.ts` leg is kept only for the `scenario-runtime` /
     * `evidence-kb-mapping` code paths that still read raw Mongo snippets by
     * ID and is on the list to delete once those callers migrate.
     */
    useCanonicalSnippets: true,
    /**
     * Unified query-prep LLM call (Phase 3.3 rag-production-hardening).
     * The `prepareQueryForRagWithLlm` prompt emits `hypotheticalAnswer`
     * inline, collapsing cleaner + HyDE into one structured LLM round-trip.
     * The hypothetical is threaded via `RagQueryPreparation.hypotheticalAnswer`
     * and short-circuits the HyDE step in `retrieveBestAnswer` /
     * `retrieveRelevantKBArticles`.
     *
     * Translator stays separate — it is already lazy, gated by `companyLang`,
     * and fires <5% of turns, so folding it into this prompt would only add
     * tokens on the critical path.
     */
    unifiedQueryPrep: true,
  },

  reranking: {
    minScore: 0.55,
    candidateCount: 10,
    /** A slower rerank is dropped and the embedding order stands. */
    timeoutMs: 3_000,
    /** Skip the rerank when the top candidate is this similar to the query… */
    clearLeaderSimilarity: 0.85,
    /** …and this far ahead of the next one. */
    clearLeaderMargin: 0.08,
    useVertexRankingApi: process.env.VERTEX_RANKING_API === "1",
    vertexRankingModel: (
      process.env.VERTEX_RANKING_MODEL || "semantic-ranker-default-004"
    ).trim(),
    vertexRankingLocation: (
      process.env.VERTEX_RANKING_LOCATION || "global"
    ).trim(),
  },

  queryTypes: {
    factual: 0.85,
    exploratory: 0.75,
    procedural: 0.82,
    unknown: 0.82,
  },

  /** RRF (Reciprocal Rank Fusion) configuration */
  rrf: {
    /** RRF constant (k) - higher values = more equal weighting across ranks */
    k: 60,
    /** Source weights for different retrieval sources */
    sourceWeights: {
      /** Verified FAQs get 50% boost */
      snippet: 1.5,
      /** Standard weight for KB articles */
      kb: 1.0,
    },
  },

  /** Floating-point comparison epsilon */
  epsilon: 0.001,

  /**
   * Default authority priors when mirroring or building evidence chunks without explicit scores.
   * Tune in one place to keep retrieval ranking and sync consistent.
   */
  authority: {
    /** Direct cross-conversation memory; lower trust than product KB. */
    conversationSummary: 0.35,
    /** Chunk splits from indexed URL pages (block parser). */
    indexedUrlChunk: 0.5,
    /** Chunked curated FAQ snippets. */
    curatedSnippetChunk: 0.95,
  },

  /**
   * Chunking configuration for `knowledge-chunkers`.
   * Changes to these values invalidate existing embeddings; re-run the canonical
   * sync via `runKnowledgeCanonicalSync` so vectors match the new chunking.
   */
  chunking: {
    /** Min chunk size in characters (post-HTML-strip). Smaller chunks are dropped. */
    minChunkChars: 30,
    /** Max chunk size in characters; longer sections are recursively split. */
    maxChunkChars: 1200,
    /** Target char length for sub-splits (tries to keep chunks near this size). */
    targetChunkChars: 900,
    /** Overlap appended as tail of previous chunk to preserve conversational flow. */
    overlap: {
      /** Number of trailing sentences from the previous chunk to prepend. */
      tailSentences: 1,
      /** Hard cap on overlap length in characters (keeps overlap ~10-20% of target). */
      maxChars: 160,
    },
    /** FAQ-aware sub-chunking inside a section whose heading matches a FAQ pattern. */
    faq: {
      /** When true, split FAQ sections into one chunk per Q/A pair. */
      enabled: true,
      /** Emit a separate lightweight "intro" chunk for the FAQ section header. */
      emitSectionIntro: true,
    },
  },

  /** Logging configuration */
  logging: {
    /** Log level: 'debug' | 'info' | 'warn' | 'error' */
    level:
      (process.env.RAG_LOG_LEVEL as "debug" | "info" | "warn" | "error") ||
      "info",
    /** Enable performance logs (timing, metrics) */
    enablePerformanceLogs: true,
  },
} as const;
