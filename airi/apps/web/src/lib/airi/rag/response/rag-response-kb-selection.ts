import { RAG_CONFIG } from "@/lib/airi/rag/config";
import { resolveKbDecisionThreshold } from "@/lib/airi/rag/kb/kb-admission";
import type { KBArticleResult } from "@/lib/airi/rag/kb/kb-types";
import {
  getKBCandidateThreshold,
  hasStrongKBRerankerSupport,
  isHighConfidenceKB,
  isVerifiedKBArticle,
  type ContextDecision,
  type HybridContext,
  type RetrievedAnswer,
} from "@/lib/airi/rag/types";
import type { AiriActiveSelection } from "@/lib/airi/reply/selection";
import { normalizeComparableText } from "@/lib/airi/reply/thread/reply-text-utils";

function articleMatchesPinnedSourceId(
  article: KBArticleResult,
  pinnedSourceIds: Set<string>
): boolean {
  const candidates = [
    article.id,
    article.sourceRecordId || "",
    article.documentId || "",
  ]
    .map(value => String(value || "").trim())
    .filter(Boolean);

  return candidates.some(candidate => pinnedSourceIds.has(candidate));
}

export function selectLockedSelectionKBArticles(
  hybridContext: HybridContext,
  activeSelection?: AiriActiveSelection,
  limit: number = RAG_CONFIG.limits.kbArticles
): KBArticleResult[] {
  if (
    !activeSelection ||
    activeSelection.sourceKind === "snippet" ||
    !activeSelection.sourceIds.length
  ) {
    return [];
  }

  const pinnedSourceIds = new Set(
    activeSelection.sourceIds
      .map(value => String(value || "").trim())
      .filter(Boolean)
  );
  if (pinnedSourceIds.size === 0) {
    return [];
  }

  return (hybridContext.kbArticles || [])
    .filter(article => articleMatchesPinnedSourceId(article, pinnedSourceIds))
    .slice(0, limit);
}

export function mergePreservedKBArticles(
  preserved: KBArticleResult[],
  base: KBArticleResult[],
  limit: number = RAG_CONFIG.limits.kbArticles
): KBArticleResult[] {
  const merged: KBArticleResult[] = [];
  const seen = new Set<string>();
  const add = (article: KBArticleResult) => {
    const key = String(article.id || "").trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(article);
  };

  for (const article of preserved) add(article);
  for (const article of base) add(article);

  return merged.slice(0, limit);
}

export function selectMatchedKBArticles(
  hybridContext: HybridContext,
  limit: number = RAG_CONFIG.limits.kbArticles
): KBArticleResult[] {
  const kbArticles = hybridContext.kbArticles;
  if (!kbArticles || kbArticles.length === 0) {
    return [];
  }

  const kbThreshold = resolveKbDecisionThreshold(hybridContext);
  return kbArticles
    .filter(article => isHighConfidenceKB(article, kbThreshold))
    .slice(0, limit);
}

export function selectFallbackRecoveryKBArticles(
  hybridContext: HybridContext,
  limit: number = RAG_CONFIG.limits.kbArticles
): KBArticleResult[] {
  const kbArticles = hybridContext.kbArticles;
  if (!kbArticles || kbArticles.length === 0) {
    return [];
  }

  const kbThreshold = resolveKbDecisionThreshold(hybridContext);
  const candidateThreshold = getKBCandidateThreshold(kbThreshold);

  return kbArticles
    .filter(
      article =>
        isHighConfidenceKB(article, kbThreshold) ||
        article.similarity >= candidateThreshold ||
        isVerifiedKBArticle(article) ||
        hasStrongKBRerankerSupport(article, kbThreshold)
    )
    .slice(0, limit);
}

export function selectBroadOverviewKBArticles(
  hybridContext: HybridContext,
  limit: number = Math.min(
    RAG_CONFIG.limits.kbArticlesBroadOverviewMax,
    RAG_CONFIG.limits.kbArticles
  )
): KBArticleResult[] {
  const candidates = selectFallbackRecoveryKBArticles(hybridContext, limit * 3);
  if (candidates.length < 2) {
    return [];
  }

  const grouped = new Map<string, KBArticleResult[]>();
  for (const article of candidates) {
    const key =
      article.documentId ||
      article.sourceRecordId ||
      normalizeComparableText(article.title) ||
      article.id;
    const bucket = grouped.get(key) || [];
    bucket.push(article);
    grouped.set(key, bucket);
  }

  const rankedGroups = Array.from(grouped.values()).sort((left, right) => {
    const rightTop = right[0]?.similarity || 0;
    const leftTop = left[0]?.similarity || 0;
    if (rightTop !== leftTop) return rightTop - leftTop;
    return right.length - left.length;
  });

  const selected: KBArticleResult[] = [];
  const seenArticleIds = new Set<string>();

  for (let round = 0; selected.length < limit; round += 1) {
    let addedInRound = false;
    for (const group of rankedGroups) {
      const candidate = group[round];
      if (!candidate || seenArticleIds.has(candidate.id)) continue;
      seenArticleIds.add(candidate.id);
      selected.push(candidate);
      addedInRound = true;
      if (selected.length >= limit) break;
    }
    if (!addedInRound) break;
  }

  return selected.length >= 2 ? selected.slice(0, limit) : [];
}

export function meetsSnippetCriteria(
  decision: ContextDecision,
  snippet?: RetrievedAnswer
): boolean {
  return decision.useSnippet && decision.priority === "snippet" && !!snippet;
}
