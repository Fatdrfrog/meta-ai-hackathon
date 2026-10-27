import { RAG_CONFIG } from "@/lib/airi/rag/config";
import type { KBArticleResult } from "./kb-types";

export type { KBRetrievalMethod } from "./kb-types";

const KB_THRESHOLDS = {
  kb: RAG_CONFIG.thresholds.kb,
  kbCandidate: RAG_CONFIG.thresholds.kbCandidate,
  kbReranked: RAG_CONFIG.thresholds.kbReranked,
  verificationConfidence: RAG_CONFIG.thresholds.verificationConfidence,
};

export function getKBCandidateThreshold(
  threshold: number = KB_THRESHOLDS.kb
): number {
  return Math.min(threshold, KB_THRESHOLDS.kbCandidate);
}

export function isVerifiedKBArticle(
  article: KBArticleResult | undefined
): boolean {
  if (!article) return false;
  return (
    article.verificationStatus === "verified" &&
    (article.verificationConfidence ?? 0) >=
      KB_THRESHOLDS.verificationConfidence
  );
}

export function hasStrongKBRerankerSupport(
  article: KBArticleResult | undefined,
  threshold: number = KB_THRESHOLDS.kb
): boolean {
  if (!article) return false;
  return (
    (article.rerankerScore ?? 0) >= KB_THRESHOLDS.kbReranked &&
    article.similarity >= getKBCandidateThreshold(threshold)
  );
}

export function isLexicalKBArticle(
  article: KBArticleResult | undefined
): boolean {
  if (!article) return false;
  return (
    article.retrievalMethod === "fts" ||
    article.retrievalMethod === "search_vector"
  );
}

function isKnowledgeChunkHit(article: KBArticleResult | undefined): boolean {
  return article?.retrievalMethod === "knowledge_chunk";
}

export function isHighConfidenceKB(
  article: KBArticleResult | undefined,
  threshold: number = KB_THRESHOLDS.kb
): boolean {
  if (!article) return false;

  if (article.sourceType === "indexed_url") {
    return (
      article.similarity >=
      Math.min(threshold, RAG_CONFIG.thresholds.indexedUrlSimilarityCeiling)
    );
  }

  if (isKnowledgeChunkHit(article)) {
    if (article.sourceType === "curated_snippet") {
      return (
        article.similarity >= getKBCandidateThreshold(threshold) ||
        hasStrongKBRerankerSupport(article, threshold)
      );
    }
    const verified = isVerifiedKBArticle(article);
    const rerankerSupported = hasStrongKBRerankerSupport(article, threshold);
    return article.similarity >= threshold || verified || rerankerSupported;
  }

  const verified = isVerifiedKBArticle(article);
  const rerankerSupported = hasStrongKBRerankerSupport(article, threshold);

  if (isLexicalKBArticle(article)) {
    return verified || rerankerSupported;
  }

  return article.similarity >= threshold || verified || rerankerSupported;
}
