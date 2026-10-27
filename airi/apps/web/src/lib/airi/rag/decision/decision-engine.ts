import { formatScore } from "@/lib/ai";
import {
  detectFactualIntent,
  detectIntegrationTopic,
} from "@/lib/airi/grounding/factual-grounding-guard";
import { RAG_CONFIG } from "@/lib/airi/rag/config";
import { resolveKbDecisionThreshold } from "@/lib/airi/rag/kb/kb-admission";
import type {
  ContextDecision,
  HybridContext,
  RagRetrievalPath,
} from "@/lib/airi/rag/types";
import {
  isHighConfidenceKB,
  meetsSnippetThreshold,
} from "@/lib/airi/rag/types";
import { selectBestFromRRF } from "@/lib/airi/rrf-fusion";
import { ragLogger } from "@/lib/airi/shared/logger";

function checkVerifiedSnippet(
  hybridContext: HybridContext
): ContextDecision | null {
  const { snippet, kbArticles } = hybridContext;
  const snippetThreshold = RAG_CONFIG.thresholds.snippet;
  const kbAdmission = resolveKbDecisionThreshold(hybridContext);
  const matchedKBArticles = kbArticles.filter(article =>
    isHighConfidenceKB(article, kbAdmission)
  );
  const shouldBlend =
    Boolean(hybridContext.retrievalStats.forcedBlendedRetrieval) &&
    matchedKBArticles.length > 0;

  if (snippet && meetsSnippetThreshold(snippet, snippetThreshold)) {
    const decision: ContextDecision = {
      useSnippet: true,
      useKB: shouldBlend,
      priority: shouldBlend ? "kb" : "snippet",
      reasoning: shouldBlend
        ? "Blended snippet and KB context selected to preserve multi-ask coverage"
        : "Relevant FAQ snippet found",
    };

    logDecision("Priority 1 (Snippet)", decision, {
      snippetScore: formatScore(snippet.score),
      snippetThreshold,
      kbArticlesFound: kbArticles.length,
      topKBSimilarity: formatScore(kbArticles[0]?.similarity),
    });

    return decision;
  }

  return null;
}

function resolveQueryForFactSensitiveKb(ctx: HybridContext): string {
  const plan = ctx.retrievalPlan;
  return (
    (plan?.normalizedQuery && plan.normalizedQuery.trim()) ||
    (plan?.standaloneQuery && plan.standaloneQuery.trim()) ||
    (ctx.queryTranslation?.originalQuery &&
      ctx.queryTranslation.originalQuery.trim()) ||
    (ctx.queryTranslation?.translatedQuery &&
      ctx.queryTranslation.translatedQuery.trim()) ||
    ""
  );
}

function allowKbNearAdmission(hybridContext: HybridContext): boolean {
  const q = resolveQueryForFactSensitiveKb(hybridContext);
  if (!q) return false;
  const intent = detectFactualIntent(q);
  if (intent === "pricing" || intent === "policy") return true;
  if (intent === "integration_request") {
    return Boolean(detectIntegrationTopic(q));
  }
  return false;
}

function shouldAbstainOnReranker(
  hybridContext: HybridContext,
  candidates: readonly { rerankerScore?: number }[]
): boolean {
  if (!hybridContext.kbReranked) return false;
  const topReranker = candidates[0]?.rerankerScore;
  if (typeof topReranker !== "number") return false;
  return topReranker < RAG_CONFIG.thresholds.abstainRerankerFloor;
}

function checkKBArticles(hybridContext: HybridContext): ContextDecision | null {
  const { kbArticles, kbReranked } = hybridContext;

  const effectiveKBThreshold = resolveKbDecisionThreshold(hybridContext);

  const matchedKBArticles = kbArticles.filter(article =>
    isHighConfidenceKB(article, effectiveKBThreshold)
  );
  const topMatchedKBArticle = matchedKBArticles[0];

  if (topMatchedKBArticle) {
    // Confidence-gated abstention: even when similarity cleared the admission
    // threshold, the reranker has the final say. If it ranked the best article
    // below the abstain floor, fall through to generic fallback rather than
    // letting the LLM ground on a weakly-ranked match. See plan Phase 3.1.
    if (shouldAbstainOnReranker(hybridContext, matchedKBArticles)) {
      logDecision(
        "Priority 2 (KB Articles — abstain on reranker)",
        {
          useSnippet: false,
          useKB: false,
          priority: "generic",
          reasoning:
            "Top reranker score below abstain floor — refusing low-confidence KB",
        },
        {
          topKBSimilarity: formatScore(topMatchedKBArticle.similarity),
          topRerankerScore: formatScore(topMatchedKBArticle.rerankerScore),
          abstainFloor: RAG_CONFIG.thresholds.abstainRerankerFloor,
          kbArticlesAboveThreshold: matchedKBArticles.length,
        }
      );
      return null;
    }

    const decision: ContextDecision = {
      useSnippet:
        Boolean(hybridContext.retrievalStats.forcedBlendedRetrieval) &&
        !!hybridContext.snippet,
      useKB: true,
      priority: "kb",
      reasoning: kbReranked
        ? "Relevant KB documentation found (reranked)"
        : "Relevant KB documentation found",
    };

    logDecision("Priority 2 (KB Articles)", decision, {
      topKBSimilarity: formatScore(topMatchedKBArticle.similarity),
      kbReranked,
      kbThresholdUsed: effectiveKBThreshold,
      kbArticlesCount: kbArticles.length,
      kbArticlesAboveThreshold: matchedKBArticles.length,
    });

    return decision;
  }

  const top = kbArticles[0];
  const epsilon = RAG_CONFIG.thresholds.kbNearAdmissionEpsilon;
  const floor = RAG_CONFIG.thresholds.factualGuardRetrievedKbFloor;
  if (
    top &&
    kbArticles.length > 0 &&
    top.similarity < effectiveKBThreshold &&
    top.similarity >= effectiveKBThreshold - epsilon &&
    top.similarity >= floor &&
    allowKbNearAdmission(hybridContext)
  ) {
    const decision: ContextDecision = {
      useSnippet:
        Boolean(hybridContext.retrievalStats.forcedBlendedRetrieval) &&
        !!hybridContext.snippet,
      useKB: true,
      priority: "kb",
      reasoning: kbReranked
        ? "KB near admission threshold (reranked, fact-sensitive soft path)"
        : "KB near admission threshold (fact-sensitive soft path)",
    };

    logDecision("Priority 2 (KB Articles — near-threshold)", decision, {
      topKBSimilarity: formatScore(top.similarity),
      kbAdmissionThreshold: formatScore(effectiveKBThreshold),
      kbNearAdmissionEpsilon: epsilon,
      kbReranked,
      kbArticlesCount: kbArticles.length,
    });

    return decision;
  }

  return null;
}

function checkConversationSummaries(
  hybridContext: HybridContext
): ContextDecision | null {
  const { conversationSummaries } = hybridContext;

  const conversationSummaryThreshold =
    RAG_CONFIG.thresholds.conversationSummaryRetrieval;

  if (
    conversationSummaries &&
    conversationSummaries.length > 0 &&
    conversationSummaries[0].similarity >= conversationSummaryThreshold
  ) {
    const decision: ContextDecision = {
      useSnippet: false,
      useKB: false,
      priority: "conversation_summary",
      reasoning:
        "Relevant conversation summary found from similar past conversations",
    };

    logDecision("Priority 3 (Conversation Summaries)", decision, {
      conversationSummaryThreshold,
      topSummarySimilarity: formatScore(conversationSummaries[0].similarity),
      summariesCount: conversationSummaries.length,
      conversationId: conversationSummaries[0].conversationId,
      chunkIndex: conversationSummaries[0].chunkIndex,
    });

    return decision;
  }

  return null;
}

function checkRRFFallback(
  hybridContext: HybridContext
): ContextDecision | null {
  const { rrfResult } = hybridContext;

  if (!rrfResult) {
    return null;
  }

  const snippetThreshold = RAG_CONFIG.thresholds.snippet;
  const kbThreshold = resolveKbDecisionThreshold(hybridContext);

  const bestRRF = selectBestFromRRF(rrfResult, {
    minSnippetScore: snippetThreshold,
    minKBScore: kbThreshold,
  });

  if (bestRRF) {
    const isSnippet = bestRRF.source === "snippet";
    const decision: ContextDecision = {
      useSnippet: isSnippet,
      useKB: !isSnippet,
      priority: isSnippet ? "snippet" : "kb",
      reasoning: `RRF selected best candidate: ${bestRRF.title} (RRF: ${formatScore(bestRRF.rrfScore)})`,
    };

    logDecision("Priority 4 (RRF Selection)", decision, {
      source: bestRRF.source,
      originalScore: formatScore(bestRRF.originalScore),
      rrfScore: formatScore(bestRRF.rrfScore),
    });

    return decision;
  }

  return null;
}

function createGenericDecision(hybridContext: HybridContext): ContextDecision {
  const { snippet, kbArticles, kbReranked } = hybridContext;

  const snippetThreshold = RAG_CONFIG.thresholds.snippet;
  const kbThreshold = resolveKbDecisionThreshold(hybridContext);

  const matchedKBArticles = kbArticles.filter(article =>
    isHighConfidenceKB(article, kbThreshold)
  );

  const decision: ContextDecision = {
    useSnippet: false,
    useKB: false,
    priority: "generic",
    reasoning: "No high-confidence matches found",
  };

  const whyNoSnippet = !snippet
    ? "No snippet found"
    : `Snippet score ${formatScore(snippet.score)} below ${snippetThreshold} threshold`;

  logDecision("Priority 5 (Generic - No Context)", decision, {
    snippet: {
      found: !!snippet,
      score: formatScore(snippet?.score),
      whyNotUsed: whyNoSnippet,
    },
    kb: {
      articlesFound: kbArticles.length,
      articlesAboveThreshold: matchedKBArticles.length,
      reranked: kbReranked,
      topSimilarity: formatScore(kbArticles[0]?.similarity),
      whyNotUsed:
        kbArticles.length === 0
          ? "No KB articles found"
          : matchedKBArticles.length > 0
            ? "KB articles met threshold but another higher-priority source won"
            : `No KB article similarity met ${kbThreshold} threshold`,
    },
    action: "Airi will respond with 'I don't know' to prevent hallucination",
  });

  return decision;
}

export function deriveRetrievalPath(
  decision: ContextDecision
): RagRetrievalPath {
  if (decision.priority === "generic") {
    return "none";
  }
  if (decision.useSnippet && decision.useKB) {
    return "blended";
  }
  if (decision.useSnippet) {
    return "snippet";
  }
  if (decision.useKB) {
    return "kb";
  }
  if (decision.priority === "conversation_summary") {
    return "kb";
  }
  return "none";
}

export function selectBestContext(
  hybridContext: HybridContext
): ContextDecision {
  const priority1 = checkVerifiedSnippet(hybridContext);
  if (priority1) return priority1;

  const priority2 = checkKBArticles(hybridContext);
  if (priority2) return priority2;

  const priority3 = checkConversationSummaries(hybridContext);
  if (priority3) return priority3;

  const priority4 = checkRRFFallback(hybridContext);
  if (priority4) return priority4;

  return createGenericDecision(hybridContext);
}

function logDecision(
  priorityLabel: string,
  decision: ContextDecision,
  details: Record<string, unknown>
): void {
  ragLogger.decision.info("Context decision", {
    decisionLabel: priorityLabel,
    priority: decision.priority,
    reasoning: decision.reasoning,
    ...details,
  });
}
