import { RAG_CONFIG } from "@/lib/airi/rag/config";
import { deriveRetrievalPath } from "@/lib/airi/rag/decision/decision-engine";
import { RetrievalOrchestrator } from "@/lib/airi/rag/pipeline/retrieval-orchestrator";
import type {
  ContextDecision,
  HybridContext,
  HybridRetrievalOptions,
} from "@/lib/airi/rag/types";
import type { RetrievalSummary } from "@/lib/airi/rag/response/types";
import { traceableRetriever } from "@/lib/observability/tracing";

// Re-export types for backward compatibility
export type { ContextDecision, HybridContext, HybridRetrievalOptions };

async function retrieveHybridContextImpl(
  workspaceId: string,
  query: string,
  locale: string = "en",
  options: HybridRetrievalOptions = {}
): Promise<HybridContext> {
  // Use RetrievalOrchestrator to coordinate all retrieval phases
  const orchestrator = new RetrievalOrchestrator(
    workspaceId,
    query,
    locale,
    options
  );

  return orchestrator.orchestrate();
}

export const retrieveHybridContext = traceableRetriever(
  retrieveHybridContextImpl,
  {
    name: "airi.rag.hybrid_retrieval",
    tags: ["airi", "rag", "retrieval"],
    getMetadata: (workspaceId, _query, locale) => ({
      workspace_id: workspaceId,
      preferred_language: locale,
      operation: "hybrid_retrieval",
      source_service: "web",
    }),
  }
);

export function getRetrievalSummary(
  context: HybridContext,
  decision: ContextDecision
): RetrievalSummary {
  return {
    hasSnippet: !!context.snippet,
    snippetScore: context.retrievalStats.snippetScore,
    snippetVerified: context.snippetVerified,
    snippetShortCircuitedKB:
      context.retrievalStats.snippetShortCircuitedKB || false,
    kbArticlesFound: context.retrievalStats.kbArticlesCount,
    topKBSimilarity: context.retrievalStats.topKBSimilarity,
    forceBlendedRetrieval:
      context.retrievalStats.forcedBlendedRetrieval || false,
    forceBlendedReason: context.retrievalStats.forcedBlendedReason || null,
    queryVariants: context.retrievalStats.queryVariants || [],
    pinnedSourceIds: context.retrievalStats.pinnedSourceIds || [],
    plannerMode: context.retrievalStats.plannerMode || null,
    factualIntent: context.retrievalStats.factualIntent || null,
    requiredCitationStrength:
      context.retrievalStats.requiredCitationStrength || null,
    queryClassification: context.retrievalStats.queryClassification || null,
    evidenceProductChunkIds:
      context.retrievalStats.evidenceProductChunkIds || [],
    evidenceMemoryChunkIds: context.retrievalStats.evidenceMemoryChunkIds || [],
    hydeApplied: context.retrievalStats.hydeApplied || false,
    hydeSources: context.retrievalStats.hydeSources || [],
    kbDiagnostics: (context.kbArticles || [])
      .slice(0, RAG_CONFIG.limits.kbDiagnosticsPreview)
      .map(article => ({
        id: article.id,
        similarity: article.similarity,
        rerankerScore: article.rerankerScore,
        retrievalMethod: article.retrievalMethod || null,
        contextFormat: article.contextFormat || null,
        verificationStatus: article.verificationStatus || null,
        verificationConfidence: article.verificationConfidence,
      })),
    phaseTimingsMs: context.retrievalStats.phaseTimingsMs,
    stageTimingsMs: context.retrievalStats.stageTimingsMs,
    retrievalTimeMs: context.retrievalStats.totalRetrievalTimeMs,
    retrievalPath: deriveRetrievalPath(decision),
    decision: decision.priority,
    reasoning: decision.reasoning,
    useSnippet: decision.useSnippet,
    useKB: decision.useKB,
  };
}
