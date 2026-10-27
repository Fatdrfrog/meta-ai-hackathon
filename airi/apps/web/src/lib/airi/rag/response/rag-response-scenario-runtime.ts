import type { HybridContext } from "@/lib/airi/rag/types";
import type { AiriScenarioRuntimeConfig } from "@icecore/airi-runtime/scenario-runtime-types";

export function applyScenarioRuntimeFilters(
  hybridContext: HybridContext,
  scenarioRuntime?: AiriScenarioRuntimeConfig
): void {
  if (!scenarioRuntime) return;

  if (!scenarioRuntime.includeSnippets) {
    hybridContext.snippet = undefined;
    hybridContext.snippetVerified = false;
    hybridContext.snippetVerification = undefined;
    hybridContext.retrievalStats.snippetScore = undefined;
  }

  const hasKBArticleSource = scenarioRuntime.includeKBArticles;
  const hasIndexedUrlSource = scenarioRuntime.includeIndexedUrls;
  const kbArticleIdSet =
    scenarioRuntime.kbArticleIds && scenarioRuntime.kbArticleIds.length > 0
      ? new Set(scenarioRuntime.kbArticleIds.map(id => String(id)))
      : null;
  const indexedUrlIdSet =
    scenarioRuntime.indexedUrlIds && scenarioRuntime.indexedUrlIds.length > 0
      ? new Set(scenarioRuntime.indexedUrlIds.map(id => String(id)))
      : null;

  hybridContext.kbArticles = (hybridContext.kbArticles || []).filter(
    article => {
      const sourceType = article.sourceType || "kb_article";
      const recordId =
        article.sourceRecordId != null && article.sourceRecordId !== ""
          ? String(article.sourceRecordId)
          : String(article.id);

      if (sourceType === "indexed_url") {
        if (!hasIndexedUrlSource) return false;
        if (indexedUrlIdSet && !indexedUrlIdSet.has(recordId)) return false;
        return true;
      }

      if (sourceType === "curated_snippet") {
        if (!hasKBArticleSource) return false;
        if (kbArticleIdSet && !kbArticleIdSet.has(recordId)) return false;
        return true;
      }

      if (!hasKBArticleSource) return false;
      if (kbArticleIdSet && !kbArticleIdSet.has(recordId)) return false;
      return true;
    }
  );

  if (scenarioRuntime.includeConversationSummaries) {
    const conversationIdSet =
      scenarioRuntime.conversationIds &&
      scenarioRuntime.conversationIds.length > 0
        ? new Set(scenarioRuntime.conversationIds.map(id => String(id)))
        : null;

    if (conversationIdSet) {
      hybridContext.conversationSummaries = (
        hybridContext.conversationSummaries || []
      ).filter(summary =>
        conversationIdSet.has(String(summary.conversationId))
      );
    }
  } else {
    hybridContext.conversationSummaries = [];
  }

  hybridContext.retrievalStats.kbArticlesCount =
    hybridContext.kbArticles.length;
  hybridContext.retrievalStats.topKBSimilarity =
    hybridContext.kbArticles[0]?.similarity;
}
