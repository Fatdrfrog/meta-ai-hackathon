import { evaluateFactualGroundingGuard } from "@/lib/airi/grounding/factual-grounding-guard";
import { resolvePinnedGroundingForRetrieval } from "@/lib/airi/grounding/rag-response-pinned-grounding";
import { selectBestContext } from "@/lib/airi/rag/decision/decision-engine";
import {
  rankProductEvidence,
  splitEvidencePools,
} from "@/lib/airi/rag/evidence/evidence-from-hybrid";
import {
  getRetrievalSummary,
  retrieveHybridContext,
} from "@/lib/airi/rag/pipeline/hybrid-retrieval";
import {
  resolveRetrievalHintVariants,
  resolveThreadBlendDecision,
} from "@/lib/airi/rag/pipeline/retrieval-policy";
import type {
  KBArticleResult,
  KbMirroredSourceKind,
} from "@/lib/airi/rag/kb/kb-types";
import { type ContextDecision, isRagRetrievalPath } from "@/lib/airi/rag/types";
import { ragLogger } from "@/lib/airi/shared/logger";
import { recordRagTurnAnalyticsEvents } from "@/lib/llm-analytics/events";
import { classifyRetrievalIntent } from "@/lib/airi/rag/query/retrieval-intent-classifier";
import {
  previewStringArray,
  previewText,
  traceableChain,
} from "@/lib/observability/tracing";
import {
  buildGenericFallbackResult,
  buildGuardClarificationInstruction,
  buildRecoveryTurnContext,
  hasBusinessContext,
  resolveGenericFallback,
  toFallbackResult,
} from "./rag-response-fallback";
import { buildAssistantHybridRetrievalOptions } from "./assistant-hybrid-retrieval-options";
import {
  generateGroundedAIResponse,
  generateVerifiedSnippetResponse,
} from "./rag-response-generation";
import {
  meetsSnippetCriteria,
  mergePreservedKBArticles,
  selectLockedSelectionKBArticles,
} from "./rag-response-kb-selection";
import {
  buildGroundedReplyOptionsFromKbArticles,
  logAssistantReplyGenerationBranch,
  mergeLockedWithFallbackRecovery,
  resolveEffectiveRoutingDecision,
  resolveMatchedKbArticlesBase,
  retrievalSummaryWithFactualGrounding,
  selectBroadOverviewRescueArticles,
} from "./rag-response-routing";
import { applyScenarioRuntimeFilters } from "./rag-response-scenario-runtime";
import type {
  RAGGenerateResponseParams,
  RAGResponseResult,
  RagProductMode,
  RetrievalSummary,
} from "./types";

export type {
  RAGGenerateResponseParams,
  RAGResponseResult,
  RagProductMode,
} from "./types";

/**
 * Minimum shape required to collect a KB article's "source ids" for the
 * retrieval summary. Deliberately narrower than {@link KBArticleResult} so
 * call sites that construct ad-hoc article-shaped objects (tests, selection
 * locking, broad-overview rescue) stay type-checked without pulling the full
 * interface. Typed as a tagged union on `sourceType` so the per-kind id
 * preference lives next to the cases it covers.
 */
type KbSourceIdCandidate = Pick<KBArticleResult, "id"> & {
  readonly sourceType?: KbMirroredSourceKind;
  readonly sourceRecordId?: string;
  readonly documentId?: string;
};

type KbSourceIdField = "sourceRecordId" | "documentId" | "id";

function kbSourceIdFieldOrder(
  sourceType: KbMirroredSourceKind | undefined
): readonly KbSourceIdField[] {
  switch (sourceType) {
    case "curated_snippet":
    case "indexed_url":
      return ["sourceRecordId", "id"];
    case "kb_article":
    case undefined:
      return ["sourceRecordId", "documentId", "id"];
    default: {
      const _exhaustive: never = sourceType;
      void _exhaustive;
      return ["sourceRecordId", "documentId", "id"];
    }
  }
}

function collectSelectedKbSourceIds(
  articles: readonly KbSourceIdCandidate[]
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const article of articles) {
    for (const field of kbSourceIdFieldOrder(article.sourceType)) {
      const raw = article[field];
      const value = typeof raw === "string" ? raw.trim() : "";
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function attachGroundedReplyOptions(params: {
  result: RAGResponseResult;
  activeSelection?: { sourceIds?: string[] } | null;
  kbArticles: KBArticleResult[];
}): RAGResponseResult {
  if (
    params.result.fallbackAction !== "generic_clarification" ||
    Boolean(params.activeSelection?.sourceIds?.length)
  ) {
    return params.result;
  }

  const groundedReplyOptions = buildGroundedReplyOptionsFromKbArticles(
    params.kbArticles
  );
  if (groundedReplyOptions.length < 2) {
    return params.result;
  }

  return {
    ...params.result,
    groundedReplyOptions,
  };
}

export class RagResponseService {
  static async generateResponse(
    params: RAGGenerateResponseParams
  ): Promise<RAGResponseResult> {
    const pipelineStartedAt = Date.now();
    const { workspaceId, conversationId, text, language } = params;
    // `text` is the retrieval query; fallbacks answer what the customer sent.
    const customerMessage = params.customerMessage?.trim() || text;
    const fastMode = params.fastMode ?? false;
    const scenarioRuntime = params.scenarioRuntime;
    const productMode: RagProductMode = params.productMode ?? "answer";

    const finish = async (
      result: RAGResponseResult,
      meta: Record<string, unknown> = {}
    ): Promise<RAGResponseResult> => {
      const retrievalSummary = result.retrievalSummary as
        | RetrievalSummary
        | undefined;
      const { path: pipelinePath, ...finishMeta } = meta;
      // Phase 3.6: canonical wide-event per RAG turn. We both emit it to the
      // structured logger and attach it to `retrievalSummary.wideEvent` so
      // downstream persistence (airireplytraces) can store the exact same
      // payload without having to reconstruct it.
      const wideEvent: Record<string, unknown> = {
        event: "rag.request.complete",
        workspaceId,
        conversationId,
        channel: params.channel ?? null,
        fastMode,
        scenarioId:
          (retrievalSummary?.scenarioId as string | undefined) ??
          scenarioRuntime?.scenarioId ??
          null,
        resultType: result.type,
        durationMs: Date.now() - pipelineStartedAt,
        productMode: result.productMode ?? productMode,
        pipelinePath: typeof pipelinePath === "string" ? pipelinePath : null,
        retrievalPath: isRagRetrievalPath(retrievalSummary?.retrievalPath)
          ? retrievalSummary.retrievalPath
          : null,
        outcome: "ok",
        hasGenerationInference: Boolean(result.generationInference),
        generationInferenceMs: result.generationInference?.latencyMs ?? null,
        generationModel: result.generationInference?.model ?? null,
        retrieval: retrievalSummary ?? null,
        ...finishMeta,
      };
      ragLogger.emitWideEvent("rag.request.complete", wideEvent);
      await recordRagTurnAnalyticsEvents({
        eventTs: new Date(),
        inputText: text,
        outputText: result.content || null,
        sourceService: "web.rag",
        wideEvent,
      });
      // Keep the event's retrieval snapshot separate from the persisted summary:
      // mutating it here would make summary -> event -> retrieval circular.
      result.retrievalSummary = {
        ...retrievalSummary,
        wideEvent,
      } as RetrievalSummary;
      return result;
    };

    try {
      // Reuse permission-scoped retrieval caches, but build every answer from
      // this turn's context so cached replies cannot bypass current grounding.
      const retrievalHints = resolveRetrievalHintVariants({
        queryVariants: params.queryVariants,
        coverageHints: params.coverageHints,
        activeGoals: params.activeGoals,
      });
      const retrievalIntent =
        params.retrievalIntent ??
        (await classifyRetrievalIntent({
          query: text,
          language,
          workspaceId,
          conversationId,
        }));
      const threadBlendDecision = resolveThreadBlendDecision({
        openAsks: params.openAsks,
        followUpAnchor: params.followUpAnchor,
        lastMessageQuery: params.lastMessageQuery,
      });

      const retrievalWallStarted = Date.now();
      const hybridContext = await retrieveHybridContext(
        workspaceId,
        text,
        language,
        buildAssistantHybridRetrievalOptions({
          base: params,
          fastMode,
          scenarioRuntime,
          conversationId,
          retrievalHints,
          retrievalIntent,
          threadBlendDecision,
          pinnedGrounding: resolvePinnedGroundingForRetrieval(params),
        })
      );
      const retrievalWallMs = Date.now() - retrievalWallStarted;
      applyScenarioRuntimeFilters(hybridContext, scenarioRuntime);

      const contextDecision = selectBestContext(hybridContext);
      const lockedSelectionKBArticles = selectLockedSelectionKBArticles(
        hybridContext,
        params.activeSelection
      );
      const broadOverviewKBArticles = selectBroadOverviewRescueArticles(
        hybridContext,
        contextDecision,
        lockedSelectionKBArticles
      );
      const effectiveDecision = resolveEffectiveRoutingDecision(
        contextDecision,
        lockedSelectionKBArticles,
        broadOverviewKBArticles
      );
      const matchedKBArticlesBase = resolveMatchedKbArticlesBase(
        hybridContext,
        broadOverviewKBArticles
      );
      const matchedKBArticles = mergePreservedKBArticles(
        lockedSelectionKBArticles,
        matchedKBArticlesBase
      );
      const selectedSnippetId =
        effectiveDecision.useSnippet && hybridContext.snippet?.id
          ? hybridContext.snippet.id
          : null;
      const selectedKbArticleIds = effectiveDecision.useKB
        ? matchedKBArticles.map(article => article.id)
        : [];
      const selectedKbSourceIds = effectiveDecision.useKB
        ? collectSelectedKbSourceIds(matchedKBArticles)
        : [];
      // HyDE provenance is aggregated once in RetrievalOrchestrator; see
      // hybrid-retrieval.getRetrievalSummary, which reads it from
      // hybridContext.retrievalStats.{hydeApplied,hydeSources}.
      const retrievalSummary = {
        ...getRetrievalSummary(hybridContext, effectiveDecision),
        scenarioId: scenarioRuntime?.scenarioId,
        scenarioName: scenarioRuntime?.scenarioName,
        selectedSnippetId,
        selectedKbArticleIds,
        selectedKbSourceIds,
        selectionPinned: Boolean(params.activeSelection?.sourceIds?.length),
        lockedSelectionPreserved: lockedSelectionKBArticles.length > 0,
        broadOverviewRescue: broadOverviewKBArticles.length >= 2,
        chosenSourceIds: [
          ...(selectedSnippetId ? [selectedSnippetId] : []),
          ...selectedKbSourceIds,
        ],
      };

      if (productMode === "retrieve") {
        return finish(
          {
            type: "evidence_retrieve",
            productMode: "retrieve",
            rankedEvidence: rankProductEvidence(
              splitEvidencePools(hybridContext).productChunks
            ),
            decision: effectiveDecision,
            retrievalSummary,
          },
          {
            path: "evidence_retrieve",
            retrievalWallMs,
          }
        );
      }

      if (productMode === "context") {
        return finish(
          {
            type: "evidence_context",
            productMode: "context",
            evidencePools: splitEvidencePools(hybridContext),
            decision: effectiveDecision,
            retrievalSummary,
          },
          {
            path: "evidence_context",
            retrievalWallMs,
          }
        );
      }

      const { snippet } = hybridContext;
      const kbArticlesSelectedForTurn = matchedKBArticles;
      const kbArticlesRawFromRetrieval = hybridContext.kbArticles;
      const factualGroundingGuard = evaluateFactualGroundingGuard({
        query: text,
        literalCustomerMessage: params.lastMessageQuery ?? null,
        decision: effectiveDecision,
        channel: params.channel,
        snippet,
        kbArticles: kbArticlesSelectedForTurn,
        retrievedKbCandidates: kbArticlesRawFromRetrieval,
      });

      let result: RAGResponseResult;

      if (meetsSnippetCriteria(effectiveDecision, snippet)) {
        result = await generateVerifiedSnippetResponse(
          snippet!,
          language,
          effectiveDecision,
          retrievalSummary
        );
        return finish(result, {
          path: "verified_snippet",
          retrievalWallMs,
        });
      }

      if (factualGroundingGuard.shouldBlock) {
        const guardedDecision: ContextDecision = {
          useSnippet: false,
          useKB: false,
          priority: "generic",
          reasoning: `Blocked by factual grounding guard: ${factualGroundingGuard.reason}`,
        };

        result = await buildGenericFallbackResult({
          latestCustomerMessage: customerMessage,
          turnContext: buildRecoveryTurnContext(params),
          language: params.language,
          decision: guardedDecision,
          summary: retrievalSummaryWithFactualGrounding(
            retrievalSummary,
            factualGroundingGuard
          ),
          workspacePersona: params.workspacePersona,
          channel: params.channel,
          alreadyGreeted: params.alreadyGreeted,
        });
        result = attachGroundedReplyOptions({
          result,
          activeSelection: params.activeSelection,
          kbArticles: matchedKBArticles,
        });
        return finish(result, {
          path: "factual_grounding_guard",
          retrievalWallMs,
        });
      }

      if (effectiveDecision.priority === "generic") {
        const fallbackKBArticles = mergeLockedWithFallbackRecovery(
          lockedSelectionKBArticles,
          hybridContext
        );

        if (scenarioRuntime) {
          result = await buildGenericFallbackResult({
            latestCustomerMessage: customerMessage,
            turnContext: buildRecoveryTurnContext(params),
            language: params.language,
            decision: effectiveDecision,
            summary: retrievalSummaryWithFactualGrounding(
              retrievalSummary,
              factualGroundingGuard,
              { scenarioGenericNeedsUnrestrictedRetry: true }
            ),
            intentAnchor: params.intentAnchor,
            kbContext:
              fallbackKBArticles.length > 0 ? fallbackKBArticles : undefined,
            workspacePersona: params.workspacePersona,
            channel: params.channel,
            alreadyGreeted: params.alreadyGreeted,
          });
          result = attachGroundedReplyOptions({
            result,
            activeSelection: params.activeSelection,
            kbArticles: fallbackKBArticles,
          });
          return finish(result, {
            path: "generic_scenario_fallback",
            retrievalWallMs,
          });
        }

        const genericFallback = await resolveGenericFallback({
          latestCustomerMessage: customerMessage,
          turnContext: buildRecoveryTurnContext(params),
          language: params.language,
          summary: retrievalSummaryWithFactualGrounding(
            retrievalSummary,
            factualGroundingGuard
          ),
          allowClarifyingGeneration: hasBusinessContext(params.companyContext),
          intentAnchor: params.intentAnchor,
          kbContext:
            fallbackKBArticles.length > 0 ? fallbackKBArticles : undefined,
          workspacePersona: params.workspacePersona,
          channel: params.channel,
          channelInstructions: params.channelInstructions,
          alreadyGreeted: params.alreadyGreeted,
        });

        if (genericFallback.fallbackAction === "clarifying_generation") {
          const guardParams: RAGGenerateResponseParams = {
            ...params,
            scenarioInstructionOverride:
              buildGuardClarificationInstruction(language),
          };

          logAssistantReplyGenerationBranch({
            workspaceId: params.workspaceId,
            conversationId: params.conversationId,
            pipelineBranch: "guard_clarification",
            decision: effectiveDecision,
            hybridContext,
          });
          const replyGenStarted = Date.now();
          result = await generateGroundedAIResponse(
            guardParams,
            hybridContext,
            effectiveDecision,
            retrievalSummaryWithFactualGrounding(
              retrievalSummary,
              factualGroundingGuard,
              { guardClarification: true }
            ),
            matchedKBArticles
          );
          result = attachGroundedReplyOptions({
            result,
            activeSelection: params.activeSelection,
            kbArticles: fallbackKBArticles,
          });
          return finish(result, {
            path: "guard_clarification_ai_reply",
            retrievalWallMs,
            replyGenerationWallMs: Date.now() - replyGenStarted,
          });
        }

        result = toFallbackResult(
          effectiveDecision,
          retrievalSummaryWithFactualGrounding(
            retrievalSummary,
            factualGroundingGuard
          ),
          genericFallback
        );
        result = attachGroundedReplyOptions({
          result,
          activeSelection: params.activeSelection,
          kbArticles: fallbackKBArticles,
        });
        return finish(result, {
          path: "generic_fallback",
          retrievalWallMs,
        });
      }

      logAssistantReplyGenerationBranch({
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        pipelineBranch: "kb_or_snippet_context",
        decision: effectiveDecision,
        hybridContext,
      });
      const replyGenStarted = Date.now();
      result = await generateGroundedAIResponse(
        params,
        hybridContext,
        effectiveDecision,
        retrievalSummaryWithFactualGrounding(
          retrievalSummary,
          factualGroundingGuard
        ),
        matchedKBArticles
      );
      result = attachGroundedReplyOptions({
        result,
        activeSelection: params.activeSelection,
        kbArticles: matchedKBArticles,
      });
      return finish(result, {
        path: "kb_snippet_ai_reply",
        retrievalWallMs,
        replyGenerationWallMs: Date.now() - replyGenStarted,
      });
    } catch (error) {
      const wideEvent = {
        event: "rag.request.complete",
        workspaceId,
        conversationId,
        channel: params.channel ?? null,
        fastMode,
        pipelinePath: null,
        retrievalPath: "none",
        outcome: "error",
        durationMs: Date.now() - pipelineStartedAt,
        retrieval: null,
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
      ragLogger.emitWideEvent("rag.request.complete", wideEvent);
      await recordRagTurnAnalyticsEvents({
        eventTs: new Date(),
        inputText: text,
        outputText: null,
        sourceService: "web.rag",
        wideEvent,
      });
      throw error;
    }
  }
}
const generateResponseImpl =
  RagResponseService.generateResponse.bind(RagResponseService);

RagResponseService.generateResponse = traceableChain(
  async (params: RAGGenerateResponseParams): Promise<RAGResponseResult> =>
    generateResponseImpl(params),
  {
    name: "airi.rag.generate_response",
    tags: ["airi", "rag", "response"],
    getMetadata: params => ({
      workspace_id: params.workspaceId,
      conversation_id: params.conversationId,
      channel: params.channel || null,
      scenario_id: params.scenarioRuntime?.scenarioId || null,
      preferred_language: params.language,
      product_mode: params.productMode || "answer",
    }),
    processInputs: inputs => {
      const payload = (
        "input" in inputs ? inputs.input : inputs
      ) as RAGGenerateResponseParams;
      return {
        workspace_id: payload.workspaceId,
        conversation_id: payload.conversationId,
        product_mode: payload.productMode || "answer",
        language: payload.language,
        text_preview: previewText(payload.text, 240),
        query_variants: previewStringArray(payload.queryVariants || [], 4, 120),
        follow_up_mode: payload.followUpMode || "none",
        last_grounding_kind: payload.lastGrounding?.sourceKind || "none",
        active_selection_label: payload.activeSelection?.label || null,
        active_selection_price:
          payload.activeSelection?.quotedPriceText || null,
        scenario_id: payload.scenarioRuntime?.scenarioId || null,
      };
    },
    processOutputs: outputs => {
      const result = (
        "outputs" in outputs ? outputs.outputs : outputs
      ) as RAGResponseResult;
      return {
        type: result.type,
        decision_priority: result.decision?.priority || null,
        fallback_action: result.fallbackAction || null,
        fallback_reason: result.fallbackReason || null,
        selection_pinned: Boolean(result.retrievalSummary?.selectionPinned),
        broad_overview_rescue: Boolean(
          result.retrievalSummary?.broadOverviewRescue
        ),
        selected_snippet_id: result.retrievalSummary?.selectedSnippetId || null,
        selected_kb_article_ids: previewStringArray(
          result.retrievalSummary?.selectedKbArticleIds || [],
          6,
          80
        ),
        selected_kb_source_ids: previewStringArray(
          result.retrievalSummary?.selectedKbSourceIds || [],
          6,
          80
        ),
        chosen_source_ids: previewStringArray(
          result.retrievalSummary?.chosenSourceIds || [],
          6,
          80
        ),
        content_preview: previewText(result.content, 280),
      };
    },
  }
) as typeof RagResponseService.generateResponse;
