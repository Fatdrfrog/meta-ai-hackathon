/**
 * Retrieval Orchestrator for Hybrid RAG
 *
 * Extracted from hybrid-retrieval.ts to isolate orchestration logic.
 * Coordinates all retrieval phases: translation, retrieval, reranking, verification, and RRF.
 *
 * Phases:
 * 1. Query classification (adaptive thresholds)
 * 2. Translation preparation
 * 3. Retrieval with original query
 * 4. Translation fallback (if needed)
 * 5. Reranking
 * 6. Verification
 * 7. RRF Fusion
 */

import { randomUUID } from "node:crypto";
import { getQueryEmbeddingWithCache } from "@/lib/ai";
import { withWorkspaceTextAiAction } from "@/lib/ai/workspace-ai-policy";
import { RAG_CONFIG } from "@/lib/airi/rag/config";
import { computeKbAdmissionThreshold } from "@/lib/airi/rag/kb/kb-admission";
import { fetchCompanyContextByWorkspace } from "@/lib/company-context";
import {
  retrieveConversationSummaries,
  type ConversationSummaryResult,
} from "@/lib/airi/rag/conversation-summary/conversation-summary-retrieval";
import { RetrievalError, VerificationError } from "@/lib/airi/shared/errors";
import type { KBArticleResult } from "@/lib/airi/rag/kb/kb-types";
import {
  retrievePinnedKBArticles,
  retrieveRelevantKBArticles,
} from "@/lib/airi/rag/kb/kb-retrieval";
import { ragLogger } from "@/lib/airi/shared/logger";
import {
  classifyRetrievalIntent,
  type RetrievalIntentClassification,
} from "@/lib/airi/rag/query/retrieval-intent-classifier";
import type { CompanyLanguage } from "@/lib/airi/rag/query/query-translator";
import { classifyQueryType } from "@/lib/airi/rag/query/query-type-classifier";
import {
  buildHeuristicRagQueryPreparation,
  type RagQueryPreparation,
} from "@/lib/airi/rag/query/query-cleaner";
import { splitEvidencePools } from "@/lib/airi/rag/evidence/evidence-from-hybrid";
import type { RetrievalPlan } from "@/lib/airi/rag/evidence/evidence-types";
import { planRetrievalQuery } from "@/lib/airi/rag/pipeline/retrieval-planner";
import {
  buildRetrievalExecutionPlan,
  type RetrievalExecutionPlan,
  type RetrievalQueryVariantPlan,
} from "@/lib/airi/rag/pipeline/retrieval-policy";
import type { HyDEArtifact } from "@/lib/airi/rag/pipeline/hyde-safety";
import {
  hasClearKbLeader,
  rerankKBArticles,
} from "@/lib/airi/rag/pipeline/reranker";
import { retrieveBestAnswer } from "@/lib/airi/rag/pipeline/retrieval";
import { fuseWithRRF } from "@/lib/airi/rrf-fusion";
import {
  TranslationCoordinator,
  type TranslationInfo,
} from "@/lib/airi/rag/pipeline/translation-coordinator";
import type {
  HybridContext,
  HybridRetrievalOptions,
  RetrievalBlendReason,
  RetrievedAnswer,
} from "@/lib/airi/rag/types";
import {
  isHighConfidenceKB,
  meetsSnippetThreshold,
} from "@/lib/airi/rag/types";
import { verifySnippetRelevance } from "@/lib/airi/rag/pipeline/verifier";

type RetrievalStageTimings = {
  totalMs?: number;
  queryEmbeddingMs?: number;
  snippetMs?: number;
  pinnedSnippetMs?: number;
  primaryKbMs?: number;
  pinnedKbMs?: number;
  summaryMs?: number;
  stageTwoKbMs?: number;
  stageTwoKbQueryCount?: number;
  translationBuildMs?: number;
  translationRetrievalMs?: number;
};

async function timePromise<T>(
  promise: Promise<T>
): Promise<{ value: T; durationMs: number }> {
  const started = Date.now();
  const value = await promise;
  return { value, durationMs: Date.now() - started };
}

/**
 * Retrieval Orchestrator
 * Coordinates all phases of hybrid retrieval
 */
export class RetrievalOrchestrator {
  private workspaceId: string;
  private query: string;
  private locale: string;
  private options: HybridRetrievalOptions;
  private startTime: number;

  // Phase results
  private queryTypeResult!: ReturnType<typeof classifyQueryType>;
  private companyContext: Record<string, unknown> = {};
  private translationInfo?: TranslationInfo;
  private translationTimeMs = 0;
  private rawSnippet: RetrievedAnswer | null = null;
  private rawKBArticles: KBArticleResult[] = [];
  private kbArticles: KBArticleResult[] = [];
  private kbReranked = false;
  private conversationSummaries: ConversationSummaryResult[] = [];
  private rerankTime = 0;
  private snippetVerifiedByLLM = false;
  private snippetVerification:
    | { isRelevant: boolean; confidence: number; reason: string }
    | undefined;
  private verificationTime = 0;
  private setupPhaseMs = 0;
  private parallelRetrievePhaseMs = 0;
  private translationFallbackPhaseMs = 0;
  private rrfPhaseMs = 0;
  private originalRetrievalStageTimingsMs: RetrievalStageTimings = {};
  private translationFallbackStageTimingsMs: RetrievalStageTimings = {};
  private rrfResult: ReturnType<typeof fuseWithRRF> | undefined;
  private retrievalPlan!: RetrievalExecutionPlan;
  private ragQueryPreparation!: RagQueryPreparation;
  private queryVariants: string[] = [];
  private queryVariantPlans: RetrievalQueryVariantPlan[] = [];
  private forceBlendedRetrieval = false;
  private forceBlendedReason: RetrievalBlendReason | undefined;
  private snippetShortCircuitedKB = false;
  private queryEmbeddingRequests = new Map<string, Promise<number[] | null>>();
  private retrievalPlannerPlan!: RetrievalPlan;
  private hydeArtifacts: HyDEArtifact[] = [];

  constructor(
    workspaceId: string,
    query: string,
    locale: string,
    options: HybridRetrievalOptions
  ) {
    this.workspaceId = workspaceId;
    this.query = query;
    this.locale = locale;
    this.options = options;
    this.startTime = Date.now();
  }

  private resolvePinnedSourceIds(sourceKind: "snippet" | "kb"): string[] {
    const pinned = this.options.pinnedGrounding;
    if (!pinned || pinned.sourceIds.length === 0) return [];
    if (pinned.sourceKind === "mixed" || pinned.sourceKind === sourceKind) {
      return pinned.sourceIds.slice(0, 8);
    }
    return [];
  }

  private recordHyDEArtifact(artifact: HyDEArtifact): void {
    const source = artifact.source;
    const query = artifact.query.trim();
    const hypotheticalAnswer = artifact.hypotheticalAnswer.trim();

    if (!query || !hypotheticalAnswer) return;

    const dedupeKey = `${source}:${query.toLowerCase()}:${hypotheticalAnswer.toLowerCase()}`;
    const hasExisting = this.hydeArtifacts.some(existing => {
      const existingKey = `${existing.source}:${existing.query.trim().toLowerCase()}:${existing.hypotheticalAnswer.trim().toLowerCase()}`;
      return existingKey === dedupeKey;
    });
    if (hasExisting) return;

    this.hydeArtifacts = [
      ...this.hydeArtifacts,
      { source, query, hypotheticalAnswer },
    ].slice(-8);
  }

  private mergeKBArticleSets(
    candidateSets: KBArticleResult[][],
    limit: number
  ): KBArticleResult[] {
    const deduped = new Map<string, KBArticleResult>();

    const dedupeKey = (article: KBArticleResult): string => {
      if (article.retrievalMethod === "knowledge_chunk") {
        return `knowledge_chunk:${article.id}`;
      }
      const st = article.sourceType || "kb_article";
      return `${st}:${article.sourceRecordId || article.id}`;
    };

    for (const articles of candidateSets) {
      for (const article of articles) {
        const key = dedupeKey(article);
        const existing = deduped.get(key);
        if (!existing || article.similarity > existing.similarity) {
          deduped.set(key, article);
        }
      }
    }

    const merged = Array.from(deduped.values());
    const coveredByChunk = new Set(
      merged
        .filter(a => a.retrievalMethod === "knowledge_chunk")
        .map(a => a.sourceRecordId?.trim())
        .filter((id): id is string => Boolean(id))
    );

    const withoutRedundantPinned = merged.filter(article => {
      if (article.retrievalMethod !== "pinned") return true;
      const rid = article.sourceRecordId || article.id;
      return !coveredByChunk.has(String(rid));
    });

    return withoutRedundantPinned
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, limit);
  }

  private getPrimaryVariantQuery(): string {
    return (
      this.queryVariantPlans.find(plan => plan.stage === 1)?.query || this.query
    );
  }

  private getSecondaryVariantPlans(): RetrievalQueryVariantPlan[] {
    return this.queryVariantPlans
      .filter(plan => plan.stage === 2)
      .slice(0, this.retrievalPlan.retrievalBudget.maxExtraQueryVariants);
  }

  /** One embedding request per distinct query text in this retrieval. */
  private getQueryEmbedding(text: string): Promise<number[] | null> {
    let request = this.queryEmbeddingRequests.get(text);
    if (!request) {
      request = getQueryEmbeddingWithCache(text);
      // Prefetched requests may never be awaited (stage two can be skipped);
      // whoever awaits one still sees its error.
      request.catch(() => undefined);
      this.queryEmbeddingRequests.set(text, request);
    }
    return request;
  }

  private hasStrongKBWindow(
    kbArticles: KBArticleResult[],
    queryTypeKbThreshold: number
  ): boolean {
    if (kbArticles.length === 0) {
      return false;
    }
    const admission = computeKbAdmissionThreshold(queryTypeKbThreshold);
    return isHighConfidenceKB(kbArticles[0], admission);
  }

  /** Stage two runs whatever stage one finds, so it can start with stage one. */
  private stageTwoRunsRegardlessOfStageOne(): boolean {
    const subQueryCount = this.ragQueryPreparation.subQueries?.length ?? 0;
    /** Multi-ask decomposition: stage-1 may only cover one sub-query; always run variants. */
    const needsCompoundSubqueryCoverage = subQueryCount > 1;
    /** Blended / thread / overview plans attach extra retrieval strings; do not drop them
     *  just because one facet already hits admission (would miss other asks/topics). */
    const blendNeedsMultiPassRecall =
      this.forceBlendedReason === "thread_plan" ||
      this.forceBlendedReason === "compound_query" ||
      this.forceBlendedReason === "service_overview";
    return needsCompoundSubqueryCoverage || blendNeedsMultiPassRecall;
  }

  private shouldExpandKBVariants(
    stageOneKbArticles: KBArticleResult[],
    kbThreshold: number
  ): boolean {
    if (this.getSecondaryVariantPlans().length === 0) {
      return false;
    }

    if (
      !this.stageTwoRunsRegardlessOfStageOne() &&
      this.hasStrongKBWindow(stageOneKbArticles, kbThreshold)
    ) {
      return false;
    }

    return true;
  }

  /**
   * Defense-in-depth dedupe: stage-1 runs vector search on `cleanedQuery`
   * (resolved internally by `retrieveRelevantKBArticles`). If any stage-2
   * variant happens to equal the same cleaned string (e.g. a caller passed
   * the cleaned form as a hint), drop it — the reranker already widens
   * candidate pool from stage-1.
   */
  private dropStageTwoVariantsRedundantWithPrimary(
    plans: RetrievalQueryVariantPlan[]
  ): RetrievalQueryVariantPlan[] {
    const cleaned = this.ragQueryPreparation.cleanedQuery?.trim();
    if (!cleaned) return plans;

    const filtered = plans.filter(plan => plan.query.trim() !== cleaned);
    if (filtered.length < plans.length) {
      ragLogger.retrieval.debug(
        "Skipping stage-2 KB variant(s) identical to primary cleaned query",
        {
          workspaceId: this.workspaceId,
          skipped: plans
            .filter(p => p.query.trim() === cleaned)
            .map(p => ({
              purpose: p.purpose,
              queryPreview:
                p.query.length > 80 ? `${p.query.slice(0, 80)}…` : p.query,
            })),
        }
      );
    }
    return filtered;
  }

  private async retrieveKBForVariant(params: {
    variant: string;
    locale: string;
    limit: number;
    threshold: number;
    enableHyDERescue: boolean;
    hydeRecommended?: boolean;
    preferBroadKbContext: boolean;
  }): Promise<KBArticleResult[]> {
    try {
      const queryEmbedding =
        (await this.getQueryEmbedding(params.variant)) || undefined;
      const cleanedTrimmed =
        this.ragQueryPreparation.cleanedQuery?.trim() ?? "";
      const variantSharesPrimaryPrep =
        params.variant === this.query ||
        (cleanedTrimmed.length > 0 && params.variant.trim() === cleanedTrimmed);

      const prepForVariant = variantSharesPrimaryPrep
        ? this.ragQueryPreparation
        : buildHeuristicRagQueryPreparation(params.variant);

      return await retrieveRelevantKBArticles(
        this.workspaceId,
        params.variant,
        params.locale,
        {
          limit: params.limit,
          threshold: params.threshold,
          queryEmbedding,
          enableHyDERescue: params.enableHyDERescue,
          hydeRecommended: params.hydeRecommended,
          includeFullContent: params.preferBroadKbContext,
          ragQueryPreparation: prepForVariant,
          onHyDEApplied: artifact => this.recordHyDEArtifact(artifact),
          knowledgeSearchPrincipal: this.options.knowledgeSearchPrincipal,
          matchAllowedVisibilities: this.options.matchAllowedVisibilities,
          matchSourceKinds: this.options.matchSourceKinds,
        }
      );
    } catch (err) {
      if (err instanceof RetrievalError) {
        ragLogger.retrieval.error(
          "KB retrieval with original query error",
          err,
          {
            workspaceId: this.workspaceId,
            ...err.context,
          }
        );
      } else {
        ragLogger.retrieval.error(
          "KB retrieval with original query error",
          err,
          {
            workspaceId: this.workspaceId,
          }
        );
      }
      return [];
    }
  }

  /**
   * Execute all retrieval phases and return HybridContext
   */
  async orchestrate(): Promise<HybridContext> {
    return withWorkspaceTextAiAction(
      {
        workspaceId: this.workspaceId,
        actionId: `rag-retrieval:${randomUUID()}`,
      },
      () => this.orchestrateInAction()
    );
  }

  private async orchestrateInAction(): Promise<HybridContext> {
    const setupStarted = Date.now();
    const retrievalIntent =
      this.options.retrievalIntent ??
      (await classifyRetrievalIntent({
        query: this.query,
        language: this.locale,
        workspaceId: this.workspaceId,
      }));
    // Phase 0: Classify query type
    this.queryTypeResult = this.classifyQuery(retrievalIntent);
    this.retrievalPlannerPlan = await planRetrievalQuery({
      query: this.query,
      language: this.locale,
      workspaceId: this.workspaceId,
      pinnedSourceIds: this.options.pinnedGrounding?.sourceIds,
      forceBlendedRetrieval: this.options.forceBlendedRetrieval,
      forceBlendedReason: this.options.forceBlendedReason,
      skipLlmRetrievalPlanner: this.options.skipLlmRetrievalPlanner,
      seedRagQueryPreparation: this.options.seedRagQueryPreparation,
      retrievalIntent,
    });
    this.ragQueryPreparation = this.retrievalPlannerPlan.ragQueryPreparation;
    this.retrievalPlan = await buildRetrievalExecutionPlan({
      query: this.query,
      language: this.locale,
      ragQueryPreparation: this.ragQueryPreparation,
      plannedQueryVariants: this.options.queryVariants,
      forceBlendedRetrieval: this.options.forceBlendedRetrieval,
      forceBlendedReason: this.options.forceBlendedReason,
      pinnedGrounding: this.options.pinnedGrounding,
      retrievalIntent,
    });
    this.queryVariants = this.retrievalPlan.queryVariants;
    this.queryVariantPlans = this.retrievalPlan.variantPlans;
    this.forceBlendedRetrieval = this.retrievalPlan.forceBlendedRetrieval;
    this.forceBlendedReason = this.retrievalPlan.forceBlendedReason;
    this.setupPhaseMs = Date.now() - setupStarted;

    // Fetch translation eligibility/company language in parallel with retrieval.
    // Actual translation is lazy and only runs if original-language retrieval misses.
    const parallelStarted = Date.now();
    await Promise.all([
      this.prepareTranslation(),
      this.retrieveWithOriginalQuery(),
    ]);
    this.parallelRetrievePhaseMs = Date.now() - parallelStarted;

    // Early-return gate: when the snippet short-circuited KB retrieval, the
    // remaining phases (translation fallback, KB reranking, RRF fusion) are
    // no-ops by construction — there are no KB articles and the snippet is
    // already in hand. Skip straight to snippet verification + context build
    // so the hot path stays tight. See plan Phase 1.10.
    if (this.snippetShortCircuitedKB) {
      await this.applyVerification();
      return this.buildHybridContext();
    }

    const translationFallbackStarted = Date.now();
    // Phase 2: Translation fallback (if needed)
    await this.retrieveWithTranslationFallback();
    this.translationFallbackPhaseMs = Date.now() - translationFallbackStarted;

    // Reranking (KB) and snippet verification are independent — run in parallel.
    await Promise.all([this.applyReranking(), this.applyVerification()]);

    const rrfStarted = Date.now();
    // Phase 5: Apply RRF fusion
    await this.applyRRFFusion();
    this.rrfPhaseMs = Date.now() - rrfStarted;

    return this.buildHybridContext();
  }

  /**
   * Phase 0: Classify query type for adaptive thresholds
   */
  private classifyQuery(
    retrievalIntent: RetrievalIntentClassification
  ): ReturnType<typeof classifyQueryType> {
    const result = classifyQueryType(this.query, {
      retrievalIntent,
    });

    ragLogger.query.debug("Query type classification", {
      workspaceId: this.workspaceId,
      query: this.query.substring(0, 100),
      queryType: result.type,
      adaptiveThreshold: result.threshold,
      confidence: result.confidence,
      reason: result.reason,
    });

    return result;
  }

  /**
   * Phase 0.5: Prepare translation for potential fallback
   */
  private async prepareTranslation(): Promise<void> {
    // Fetch company context to determine if translation is needed
    this.companyContext = await fetchCompanyContextByWorkspace(
      this.workspaceId
    ).catch(err => {
      ragLogger.general.error("Company context error", err, {
        workspaceId: this.workspaceId,
      });
      return {};
    });

    if (this.options.enableTranslation === false) {
      return;
    }

    // Check translation eligibility without paying a fallback LLM call yet.
    const translationResult = await TranslationCoordinator.prepareTranslation(
      this.locale,
      this.workspaceId,
      (this.companyContext as { airiLanguage?: CompanyLanguage })?.airiLanguage
    );

    this.translationTimeMs = translationResult.translationTimeMs;
  }

  /**
   * Phase 1: Retrieve with original query.
   * Snippets run first so a confident Q/A match can skip KB retrieval.
   */
  private async retrieveWithOriginalQuery(): Promise<void> {
    const {
      includeSnippets = true,
      includeKB = true,
      includeConversationSummaries = true,
      excludeConversationSummaryId,
      kbLimit = RAG_CONFIG.limits.kbArticles,
      kbThreshold = this.queryTypeResult.threshold,
      snippetThreshold = this.queryTypeResult.threshold,
      enableReranking = RAG_CONFIG.features.enableReranking,
      enableHyDE = RAG_CONFIG.features.enableHyDE,
    } = this.options;

    const searchLocale = this.locale;
    const effectiveKbLimit = enableReranking ? kbLimit * 2 : kbLimit;
    const totalKbQueryBudget =
      this.retrievalPlan.retrievalBudget.maxKbVectorQueries +
      this.retrievalPlan.retrievalBudget.maxPinnedKbPasses;
    const perQueryKbLimit = Math.max(
      2,
      Math.ceil(effectiveKbLimit / Math.max(1, totalKbQueryBudget))
    );
    const pinnedKbIds = this.resolvePinnedSourceIds("kb");
    const primaryVariantQuery = this.getPrimaryVariantQuery();

    ragLogger.retrieval.debug("Starting retrieval", {
      workspaceId: this.workspaceId,
      queryPreview:
        this.query.length > 50
          ? this.query.substring(0, 50) + "..."
          : this.query,
      locale: searchLocale,
      includeSnippets,
      includeKB,
      includeConversationSummaries,
      forceBlendedRetrieval: this.forceBlendedRetrieval,
      queryVariants: this.queryVariants,
      queryVariantPlans: this.queryVariantPlans,
      retrievalBudget: this.retrievalPlan.retrievalBudget,
    });

    const originalRetrievalStarted = Date.now();

    // Embed every query this retrieval may search at once. gemini-embedding-001
    // takes one text per request, so the batch is concurrent requests; KB
    // variants and stage two then never wait on an embedding of their own.
    const queryEmbeddingTimedPromise = timePromise(
      this.getQueryEmbedding(this.query)
    );
    const stageTwoCandidatePlans = includeKB
      ? this.dropStageTwoVariantsRedundantWithPrimary(
          this.getSecondaryVariantPlans()
        )
      : [];
    if (includeKB) {
      for (const text of [
        primaryVariantQuery,
        ...stageTwoCandidatePlans.map(plan => plan.query),
      ]) {
        void this.getQueryEmbedding(text);
      }
    }
    const queryEmbeddingTimed = await queryEmbeddingTimedPromise;
    const queryEmbedding = queryEmbeddingTimed.value;
    this.originalRetrievalStageTimingsMs.queryEmbeddingMs =
      queryEmbeddingTimed.durationMs;

    const snippetOriginalPromise = includeSnippets
      ? retrieveBestAnswer(this.workspaceId, this.query, {
          threshold: snippetThreshold,
          language: searchLocale,
          allowedSnippetIds: this.options.allowedSnippetIds,
          queryEmbedding: queryEmbedding || undefined,
        }).catch(err => {
          if (err instanceof RetrievalError) {
            ragLogger.retrieval.error(
              "Snippet retrieval with original query error",
              err,
              { workspaceId: this.workspaceId, ...err.context }
            );
          } else {
            ragLogger.retrieval.error(
              "Snippet retrieval with original query error",
              err,
              { workspaceId: this.workspaceId }
            );
          }
          return null;
        })
      : Promise.resolve(null);

    // Pinned snippets: on the canonical path, `retrieveBestAnswer` already
    // honors `allowedSnippetIds` against `match_knowledge_chunks`, so there
    // is no separate pinned-by-ID fetch. The Mongo-direct `fetchSnippetsByIds`
    // leg was removed with the Phase 4 canonical-only cutover.
    const snippetOriginalTimedPromise = timePromise(snippetOriginalPromise);

    // KB, pinned KB and summaries search alongside the snippet instead of
    // after it. A confident snippet still short-circuits KB: their results
    // are then dropped. (The canonical snippet path never applies HyDE, so
    // KB's HyDE rescue does not depend on the snippet's outcome.)
    const summaryPromise = includeConversationSummaries
      ? retrieveConversationSummaries(this.workspaceId, this.query, {
          limit: RAG_CONFIG.limits.conversationSummaries,
          threshold: RAG_CONFIG.thresholds.conversationSummaryRetrieval,
          excludeConversationId: excludeConversationSummaryId,
          queryEmbedding: queryEmbedding || undefined,
        }).catch(err => {
          ragLogger.retrieval.error(
            "Conversation summary retrieval error",
            err,
            {
              workspaceId: this.workspaceId,
            }
          );
          return [];
        })
      : Promise.resolve([]);

    const primaryKbPromise = includeKB
      ? this.retrieveKBForVariant({
          variant: primaryVariantQuery,
          locale: searchLocale,
          limit: perQueryKbLimit,
          threshold: kbThreshold * RAG_CONFIG.thresholds.kbRetrievalStageRatio,
          enableHyDERescue: enableHyDE,
          hydeRecommended: this.retrievalPlannerPlan.hydeRecommended,
          preferBroadKbContext: Boolean(this.options.preferBroadKbContext),
        })
      : Promise.resolve([]);

    const pinnedKbPromise =
      includeKB && pinnedKbIds.length > 0
        ? retrievePinnedKBArticles(
            this.workspaceId,
            pinnedKbIds,
            searchLocale,
            {
              limit: perQueryKbLimit,
              includeFullContent: Boolean(this.options.preferBroadKbContext),
            }
          ).catch(() => [])
        : Promise.resolve([]);

    const stageOneTimedPromise = Promise.all([
      timePromise(primaryKbPromise),
      timePromise(pinnedKbPromise),
      timePromise(summaryPromise),
    ]);

    const retrieveStageTwo = (plans: RetrievalQueryVariantPlan[]) =>
      timePromise(
        Promise.all(
          plans.map(plan =>
            this.retrieveKBForVariant({
              variant: plan.query,
              locale: searchLocale,
              limit: perQueryKbLimit,
              threshold:
                kbThreshold * RAG_CONFIG.thresholds.kbRetrievalStageRatio,
              enableHyDERescue: false,
              preferBroadKbContext: Boolean(this.options.preferBroadKbContext),
            })
          )
        )
      );
    // Blended and compound turns run stage two whatever stage one finds, so
    // it searches at the same time as stage one.
    const eagerStageTwoPromise =
      includeKB &&
      stageTwoCandidatePlans.length > 0 &&
      this.stageTwoRunsRegardlessOfStageOne()
        ? retrieveStageTwo(stageTwoCandidatePlans)
        : null;

    const snippetOriginalTimed = await snippetOriginalTimedPromise;
    const snippetOriginal = snippetOriginalTimed.value;
    this.originalRetrievalStageTimingsMs.snippetMs =
      snippetOriginalTimed.durationMs;
    this.originalRetrievalStageTimingsMs.pinnedSnippetMs = 0;

    this.rawSnippet = snippetOriginal;

    const shouldShortCircuitKB =
      meetsSnippetThreshold(this.rawSnippet || undefined, snippetThreshold) &&
      !this.forceBlendedRetrieval;
    this.snippetShortCircuitedKB = shouldShortCircuitKB;

    let convSummaries: ConversationSummaryResult[] | null = null;

    let kbOriginal: KBArticleResult[] = [];

    if (!shouldShortCircuitKB) {
      const [primaryKbTimed, pinnedKbTimed, summaryTimed] =
        await stageOneTimedPromise;
      const primaryKbResults = primaryKbTimed.value;
      const pinnedKbResults = pinnedKbTimed.value;
      const summaryResults = summaryTimed.value;
      this.originalRetrievalStageTimingsMs.primaryKbMs =
        primaryKbTimed.durationMs;
      this.originalRetrievalStageTimingsMs.pinnedKbMs =
        pinnedKbTimed.durationMs;
      this.originalRetrievalStageTimingsMs.summaryMs = summaryTimed.durationMs;

      // `shouldExpandKBVariants`/`hasStrongKBWindow` only inspect the TOP
      // candidate, so we don't need to build a full merged+sorted stage-1
      // list just to decide on stage-2. Pick the single strongest candidate
      // across primary+pinned as a lightweight proxy; the authoritative
      // merged list is computed exactly once after all stages run.
      const stageOneTopCandidate: KBArticleResult | undefined =
        (primaryKbResults[0]?.similarity ?? -Infinity) >=
        (pinnedKbResults[0]?.similarity ?? -Infinity)
          ? primaryKbResults[0]
          : pinnedKbResults[0];
      const stageOneKbPreview = stageOneTopCandidate
        ? [stageOneTopCandidate]
        : [];
      const stageTwoVariantPlans =
        eagerStageTwoPromise ||
        this.shouldExpandKBVariants(stageOneKbPreview, kbThreshold)
          ? stageTwoCandidatePlans
          : [];

      let stageTwoKbResults: KBArticleResult[][] = [];
      if (includeKB && stageTwoVariantPlans.length > 0) {
        const stageTwoTimed = await (eagerStageTwoPromise ??
          retrieveStageTwo(stageTwoVariantPlans));
        stageTwoKbResults = stageTwoTimed.value;
        this.originalRetrievalStageTimingsMs.stageTwoKbMs =
          stageTwoTimed.durationMs;
        this.originalRetrievalStageTimingsMs.stageTwoKbQueryCount =
          stageTwoVariantPlans.length;
      } else {
        this.originalRetrievalStageTimingsMs.stageTwoKbMs = 0;
        this.originalRetrievalStageTimingsMs.stageTwoKbQueryCount = 0;
      }

      // Single authoritative merge across ALL candidate sets (primary +
      // pinned + stage-2). Previously we merged twice (once for the stage-1
      // expansion check, once for the final list); that's now collapsed.
      kbOriginal = this.mergeKBArticleSets(
        [primaryKbResults, pinnedKbResults, ...stageTwoKbResults],
        effectiveKbLimit
      );
      convSummaries = summaryResults;

      ragLogger.retrieval.debug("KB staged retrieval executed", {
        workspaceId: this.workspaceId,
        primaryVariantQuery,
        stageTwoQueries: stageTwoVariantPlans.map(plan => ({
          query: plan.query,
          purpose: plan.purpose,
        })),
        stageOneTopSimilarity: stageOneTopCandidate?.similarity,
        finalKbCount: kbOriginal.length,
        stageTimingsMs: this.originalRetrievalStageTimingsMs,
      });
    } else if (includeKB && shouldShortCircuitKB) {
      ragLogger.retrieval.info(
        "Skipping KB retrieval after confident snippet match",
        {
          workspaceId: this.workspaceId,
          queryPreview:
            this.query.length > 50
              ? this.query.substring(0, 50) + "..."
              : this.query,
          snippetScore: snippetOriginal?.score,
          forceBlendedRetrieval: this.forceBlendedRetrieval,
          snippetVerifiedByReranker:
            this.rawSnippet?.verifiedByReranker || false,
        }
      );
    }

    this.originalRetrievalStageTimingsMs.totalMs =
      Date.now() - originalRetrievalStarted;

    if (kbOriginal.length > 0) this.rawKBArticles = kbOriginal;
    if (convSummaries && convSummaries.length > 0) {
      this.conversationSummaries = convSummaries;
    }

    // Log workspace verification for retrieved data
    ragLogger.retrieval.debug("Retrieval stage completed", {
      workspaceId: this.workspaceId,
      snippetFound: !!snippetOriginal,
      snippetShortCircuitedKB: shouldShortCircuitKB,
      kbArticlesFound: kbOriginal?.length || 0,
      kbArticleIds: kbOriginal?.map(a => a.id) ?? [],
      kbTopSimilarity: kbOriginal?.[0]?.similarity,
      conversationSummariesFound: convSummaries?.length || 0,
      stageTimingsMs: this.originalRetrievalStageTimingsMs,
      workspaceIsolation:
        "verified in snippet retrieval, KB RPC filters, and conversation summary retrieval",
    });

    if (includeKB) {
      ragLogger.retrieval.debug("Initial KB search results", {
        workspaceId: this.workspaceId,
        searchLocale,
        resultsFound: this.rawKBArticles.length,
        queryVariants: this.queryVariants,
        queryVariantPlans: this.queryVariantPlans,
        articles: this.rawKBArticles.map(r => ({
          id: r.id,
          title: r.title,
          locale: r.locale,
          similarity: r.similarity,
        })),
      });
    }
  }

  /**
   * Phase 2: Translation fallback (only if no results found)
   */
  private async retrieveWithTranslationFallback(): Promise<void> {
    const fallbackStarted = Date.now();
    const finishFallbackTiming = () => {
      this.translationFallbackStageTimingsMs.totalMs =
        Date.now() - fallbackStarted;
    };

    if (this.options.enableTranslation === false) {
      finishFallbackTiming();
      return;
    }

    const {
      includeSnippets = true,
      includeKB = true,
      kbLimit = RAG_CONFIG.limits.kbArticles,
      kbThreshold = this.queryTypeResult.threshold,
      snippetThreshold = this.queryTypeResult.threshold,
      enableReranking = RAG_CONFIG.features.enableReranking,
    } = this.options;

    // Only try translated search if NO relevant context found in original language
    const hasRelevantContext =
      !!this.rawSnippet || this.rawKBArticles.length > 0;

    if (!hasRelevantContext) {
      const companyLang = (
        this.companyContext as {
          airiLanguage?: CompanyLanguage;
        }
      )?.airiLanguage;

      if (!companyLang) {
        finishFallbackTiming();
        return;
      }
      if (!TranslationCoordinator.shouldTranslate(this.locale, companyLang)) {
        finishFallbackTiming();
        return;
      }

      const fallbackTranslationTimed = await timePromise(
        TranslationCoordinator.buildFallbackTranslation(
          this.query,
          this.locale,
          companyLang,
          this.workspaceId
        )
      );
      const fallbackTranslation = fallbackTranslationTimed.value;
      this.translationFallbackStageTimingsMs.translationBuildMs =
        fallbackTranslationTimed.durationMs;
      this.translationTimeMs = fallbackTranslation.translationTimeMs;
      this.translationInfo = fallbackTranslation.translationInfo;
      if (!this.translationInfo?.wasTranslated) {
        finishFallbackTiming();
        return;
      }

      ragLogger.translation.info(
        "No snippets or KB articles in original language, trying translation",
        {
          workspaceId: this.workspaceId,
          originalLang: this.locale,
          translatedLang: companyLang,
        }
      );

      const fallbackResultTimed = await timePromise(
        TranslationCoordinator.executeTranslationFallback(
          this.translationInfo,
          this.workspaceId,
          {
            includeSnippets,
            includeKB,
            snippetThreshold,
            kbThreshold,
            kbLimit,
            enableReranking,
            // HyDE has already been attempted on the original-language query.
            // Skip it on translation fallback to avoid duplicate expansion latency.
            enableHyDE: false,
            allowedSnippetIds: this.options.allowedSnippetIds,
            companyLang,
            knowledgeSearchPrincipal: this.options.knowledgeSearchPrincipal,
            matchAllowedVisibilities: this.options.matchAllowedVisibilities,
            matchSourceKinds: this.options.matchSourceKinds,
          }
        )
      );
      const fallbackResult = fallbackResultTimed.value;
      this.translationFallbackStageTimingsMs.translationRetrievalMs =
        fallbackResultTimed.durationMs;

      if (fallbackResult.snippet) this.rawSnippet = fallbackResult.snippet;
      if (fallbackResult.kbArticles && fallbackResult.kbArticles.length > 0) {
        this.rawKBArticles = fallbackResult.kbArticles;
      }
    }

    finishFallbackTiming();
  }

  /**
   * Phase 2: Apply reranking to KB articles
   */
  private async applyReranking(): Promise<void> {
    const {
      enableReranking = RAG_CONFIG.features.enableReranking,
      kbLimit = RAG_CONFIG.limits.kbArticles,
    } = this.options;

    this.kbArticles = this.rawKBArticles || [];

    if (hasClearKbLeader(this.kbArticles)) {
      ragLogger.reranker.debug("Skipping rerank: clear KB leader", {
        workspaceId: this.workspaceId,
        topSimilarity: this.kbArticles[0]?.similarity,
      });
      return;
    }

    if (enableReranking && this.kbArticles.length > 0) {
      const rerankStart = Date.now();
      try {
        const rerankedArticles = await rerankKBArticles(
          this.query,
          this.kbArticles,
          kbLimit,
          { workspaceId: this.workspaceId }
        );
        if (rerankedArticles.length > 0) {
          this.kbArticles = rerankedArticles;
          // rerankKBArticles falls back to original embedding order when the
          // reranker is unavailable, so mark reranked=true only when
          // reranker scores exist.
          this.kbReranked = rerankedArticles.some(
            article => typeof article.rerankerScore === "number"
          );

          // Log reranking results with both scores for debugging
          ragLogger.reranker.info("KB articles reranked", {
            workspaceId: this.workspaceId,
            articlesCount: rerankedArticles.length,
            rerankerApplied: this.kbReranked,
            topArticle: {
              id: rerankedArticles[0]?.id,
              title: rerankedArticles[0]?.title,
              originalSimilarity: rerankedArticles[0]?._originalSimilarity,
              rerankerScore: rerankedArticles[0]?.rerankerScore,
              similarityUsedForThreshold: rerankedArticles[0]?.similarity,
              note: "Using original similarity for threshold checks, reranker score for ranking only",
            },
          });
        }
      } catch (err) {
        ragLogger.reranker.error(
          "Reranking failed, using original order",
          err,
          { workspaceId: this.workspaceId }
        );
      }
      this.rerankTime = Date.now() - rerankStart;
    }
  }

  /**
   * Phase 3: Apply verification to snippet
   */
  private async applyVerification(): Promise<void> {
    const { enableVerification = RAG_CONFIG.features.enableVerification } =
      this.options;

    if (!enableVerification) {
      if (this.rawSnippet) {
        this.snippetVerifiedByLLM = true;
        this.snippetVerification = {
          isRelevant: true,
          confidence: 1,
          reason: "LLM verification disabled; snippet accepted",
        };
      }
      return;
    }

    if (this.rawSnippet?.verifiedByReranker) {
      this.snippetVerifiedByLLM = true;
      this.snippetVerification = {
        isRelevant: true,
        confidence: 1,
        reason: "Accepted via reranker rescue verification",
      };
      return;
    }

    // Phase 3.4: skip the LLM verification call when the reranker already
    // scored the snippet above `snippetSkipVerifyRerankerFloor`. The cross
    // encoder read (query, question, answer) together; a second LLM pass at
    // high confidence is pure redundant latency. Borderline matches still
    // fall through to `verifySnippetRelevance` below.
    if (
      this.rawSnippet &&
      typeof this.rawSnippet.rerankerScore === "number" &&
      this.rawSnippet.rerankerScore >=
        RAG_CONFIG.thresholds.snippetSkipVerifyRerankerFloor
    ) {
      this.snippetVerifiedByLLM = true;
      this.snippetVerification = {
        isRelevant: true,
        confidence: this.rawSnippet.rerankerScore,
        reason: "Accepted via high-confidence reranker score",
      };
      return;
    }

    if (
      enableVerification &&
      this.rawSnippet &&
      this.rawSnippet.score >= RAG_CONFIG.thresholds.snippet
    ) {
      const verifyStart = Date.now();
      try {
        const verification = await verifySnippetRelevance(
          this.query,
          {
            question: this.rawSnippet.question,
            answer: this.rawSnippet.answer,
            score: this.rawSnippet.score,
          },
          { workspaceId: this.workspaceId }
        );

        this.snippetVerification = verification;
        this.snippetVerifiedByLLM =
          verification.isRelevant && verification.confidence >= 0.7;

        // Verification result stored in this.snippetVerification
      } catch (err) {
        if (err instanceof VerificationError) {
          ragLogger.verification.error("Snippet verification failed", err, {
            workspaceId: this.workspaceId,
            ...err.context,
          });
        } else {
          ragLogger.verification.error("Snippet verification failed", err, {
            workspaceId: this.workspaceId,
          });
        }
        this.snippetVerifiedByLLM = false;
      }
      this.verificationTime = Date.now() - verifyStart;
    }
  }

  /**
   * Phase 4: Apply RRF fusion
   */
  private async applyRRFFusion(): Promise<void> {
    const snippet = this.rawSnippet;
    if (snippet || this.kbArticles.length > 0) {
      const snippets = snippet ? [snippet] : [];
      this.rrfResult = fuseWithRRF(snippets, this.kbArticles);
    }
  }

  /**
   * Build final HybridContext from all phase results
   */
  private buildHybridContext(): HybridContext {
    const totalTime = Date.now() - this.startTime;
    const phaseTimingsMs = {
      setupMs: this.setupPhaseMs,
      parallelRetrievalMs: this.parallelRetrievePhaseMs,
      translationFallbackMs: this.translationFallbackPhaseMs,
      rerankMs: this.rerankTime,
      verificationMs: this.verificationTime,
      rrfMs: this.rrfPhaseMs,
    };
    const stageTimingsMs = {
      originalRetrieval: this.originalRetrievalStageTimingsMs,
      translationFallback: this.translationFallbackStageTimingsMs,
    };

    const { includeCompanyContext = true } = this.options;

    const snippet = this.rawSnippet;

    // Aggregate HyDE provenance in one place: orchestrator-tracked artifacts
    // plus any HyDE applied downstream in retrieveBestAnswer /
    // retrieveRelevantKBArticles (surfaced via snippet/kbArticle flags).
    // Consumers (e.g. rag-response-service) should read these fields directly
    // and never re-derive the combined flag. See plan Phase 1.7.
    const hydeSourceSet = new Set<"snippet" | "kb">();
    for (const artifact of this.hydeArtifacts) {
      if (artifact.source) hydeSourceSet.add(artifact.source);
    }
    if (snippet?.wasHydeApplied) hydeSourceSet.add("snippet");
    if (this.kbArticles?.some(article => article.wasHydeApplied)) {
      hydeSourceSet.add("kb");
    }
    const hydeApplied = hydeSourceSet.size > 0;
    const hydeSources: Array<"snippet" | "kb"> = hydeApplied
      ? Array.from(hydeSourceSet)
      : [];

    // Build KB article verification metadata
    const kbArticleVerification =
      this.kbArticles && this.kbArticles.length > 0
        ? this.kbArticles
            .filter(a => a.verificationStatus !== undefined)
            .map(a => ({
              articleId: a.id,
              verified: a.verificationStatus === "verified",
              confidence: a.verificationConfidence || 0,
            }))
        : undefined;

    const hybrid: HybridContext = {
      snippet: snippet || undefined,
      snippetVerified: this.snippetVerifiedByLLM,
      snippetVerification: this.snippetVerification,
      kbArticles: this.kbArticles || [],
      kbReranked: this.kbReranked,
      kbArticleVerification,
      conversationSummaries: this.conversationSummaries || [],
      // Only include company context in result if requested
      companyContext: includeCompanyContext
        ? (this.companyContext as HybridContext["companyContext"])
        : undefined,
      retrievalStats: {
        snippetScore: snippet?.score,
        kbArticlesCount: this.kbArticles?.length || 0,
        topKBSimilarity: this.kbArticles?.[0]?.similarity,
        totalRetrievalTimeMs: totalTime,
        rerankTimeMs: this.rerankTime,
        verificationTimeMs: this.verificationTime,
        translationTimeMs: this.translationTimeMs || undefined,
        phaseTimingsMs,
        stageTimingsMs,
        snippetShortCircuitedKB: this.snippetShortCircuitedKB,
        forcedBlendedRetrieval: this.forceBlendedRetrieval,
        forcedBlendedReason: this.forceBlendedReason,
        queryVariants: this.queryVariants,
        queryVariantPlans: this.queryVariantPlans,
        retrievalBudget: this.retrievalPlan.retrievalBudget,
        pinnedSourceIds: this.options.pinnedGrounding?.sourceIds || [],
        hydeApplied,
        hydeSources,
        hydeArtifacts:
          this.hydeArtifacts.length > 0
            ? this.hydeArtifacts.slice()
            : undefined,
        queryClassification: {
          type: this.queryTypeResult.type,
          retrievalKbThreshold: this.queryTypeResult.threshold,
          kbAdmissionThreshold: computeKbAdmissionThreshold(
            this.queryTypeResult.threshold
          ),
        },
      },
      queryTranslation: this.translationInfo
        ? {
            wasTranslated: this.translationInfo.wasTranslated,
            originalQuery: this.translationInfo.originalQuery,
            translatedQuery: this.translationInfo.translatedQuery,
            fromLang: this.translationInfo.fromLang,
            toLang: this.translationInfo.toLang,
          }
        : undefined,
      rrfResult: this.rrfResult,
      retrievalPlan: this.retrievalPlannerPlan,
    };

    const pools = splitEvidencePools(hybrid);
    hybrid.retrievalStats = {
      ...hybrid.retrievalStats,
      evidenceProductChunkIds: pools.productChunks.map(c => c.id),
      evidenceMemoryChunkIds: pools.memoryChunks.map(c => c.id),
      plannerMode: this.retrievalPlannerPlan.plannerMode,
      factualIntent: this.retrievalPlannerPlan.factualIntent,
      requiredCitationStrength:
        this.retrievalPlannerPlan.requiredCitationStrength,
    };

    return hybrid;
  }
}
