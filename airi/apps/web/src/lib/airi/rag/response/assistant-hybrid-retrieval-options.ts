import { RAG_CONFIG } from "@/lib/airi/rag/config";
import type {
  HybridRetrievalOptions,
  RetrievalBlendReason,
} from "@/lib/airi/rag/types";
import type { RetrievalIntentClassification } from "@/lib/airi/rag/query/retrieval-intent-classifier";
import type { RAGGenerateResponseParams } from "./types";

type ThreadBlendDecision = {
  forceBlendedRetrieval: boolean;
  forceBlendedReason?: RetrievalBlendReason;
};

/**
 * Maps LLM retrieval intent + thread blend policy onto hybrid flags.
 */
export function buildRetrievalIntentTuning(
  retrievalIntent: RetrievalIntentClassification,
  threadBlendDecision: ThreadBlendDecision
): Pick<
  HybridRetrievalOptions,
  "preferBroadKbContext" | "forceBlendedRetrieval" | "forceBlendedReason"
> {
  const shouldUseBroadRetrieval = retrievalIntent.shouldUseBroadRetrieval;
  return {
    preferBroadKbContext: shouldUseBroadRetrieval,
    forceBlendedRetrieval:
      threadBlendDecision.forceBlendedRetrieval || shouldUseBroadRetrieval,
    forceBlendedReason:
      threadBlendDecision.forceBlendedReason ||
      (shouldUseBroadRetrieval ? "service_overview" : undefined),
  };
}

/**
 * Full hybrid options for one assistant RAG turn (fast mode, snippet verify,
 * rerank/HyDE toggles from {@link RAG_CONFIG.features}).
 */
export function buildAssistantHybridRetrievalOptions(params: {
  base: RAGGenerateResponseParams;
  fastMode: boolean;
  scenarioRuntime: RAGGenerateResponseParams["scenarioRuntime"];
  conversationId: string;
  retrievalHints: string[];
  retrievalIntent: RetrievalIntentClassification;
  threadBlendDecision: ThreadBlendDecision;
  pinnedGrounding: HybridRetrievalOptions["pinnedGrounding"];
}): HybridRetrievalOptions {
  const { base, fastMode, scenarioRuntime, conversationId, retrievalHints } =
    params;
  const retrievalIntentTuning = buildRetrievalIntentTuning(
    params.retrievalIntent,
    params.threadBlendDecision
  );

  const snippetVerify =
    !fastMode && RAG_CONFIG.features.assistantReplySnippetVerification;

  return {
    includeSnippets: scenarioRuntime ? scenarioRuntime.includeSnippets : true,
    includeKB: scenarioRuntime
      ? scenarioRuntime.includeKBArticles || scenarioRuntime.includeIndexedUrls
      : true,
    includeConversationSummaries: scenarioRuntime
      ? scenarioRuntime.includeConversationSummaries && !fastMode
      : !fastMode,
    excludeConversationSummaryId: conversationId,
    kbLimit: fastMode
      ? RAG_CONFIG.limits.kbArticlesFastPath
      : RAG_CONFIG.limits.kbArticles,
    snippetThreshold: RAG_CONFIG.thresholds.snippet,
    enableReranking: !fastMode && RAG_CONFIG.features.enableReranking,
    enableVerification: snippetVerify,
    enableHyDE: !fastMode && RAG_CONFIG.features.enableHyDE,
    enableTranslation: !fastMode,
    skipLlmRetrievalPlanner: fastMode,
    conversationContext: base.conversationContext,
    allowedSnippetIds: scenarioRuntime?.snippetIds,
    queryVariants: retrievalHints,
    pinnedGrounding: params.pinnedGrounding,
    seedRagQueryPreparation: base.seedRagQueryPreparation,
    knowledgeSearchPrincipal: base.knowledgeSearchPrincipal,
    matchAllowedVisibilities: base.matchAllowedVisibilities,
    matchSourceKinds: base.matchSourceKinds,
    retrievalIntent: params.retrievalIntent,
    ...retrievalIntentTuning,
  };
}
