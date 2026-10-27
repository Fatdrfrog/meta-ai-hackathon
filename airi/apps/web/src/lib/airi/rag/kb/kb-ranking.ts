import type { KBArticleResult } from "./kb-types";

const CHUNK_FUSED_RANK_WEIGHT = 2;
const CHUNK_AUTH_RANK_WEIGHT = 0.08;
const CHUNK_FRESH_HALF_LIFE_DAYS = 120;

function freshnessRankBoost(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  const ageDays = Math.max(0, (Date.now() - t) / 86400000);
  return 0.04 * Math.exp(-ageDays / CHUNK_FRESH_HALF_LIFE_DAYS);
}

/**
 * Scalar score for ordering non chunk-chunk pairs (e.g. canonical vs indexed URL).
 * Chunk-chunk ordering uses the same tuple as SQL: fused -> authority -> freshness -> similarity.
 */
function kbArticleMergeRankScore(article: KBArticleResult): number {
  let score = article.similarity;
  if (article.retrievalMethod === "knowledge_chunk") {
    const fused = article.chunkFusedScore;
    if (fused != null && Number.isFinite(fused)) {
      score += fused * CHUNK_FUSED_RANK_WEIGHT;
    }
    const auth = article.chunkAuthorityScore;
    if (auth != null && Number.isFinite(auth)) {
      score += (auth - 0.5) * CHUNK_AUTH_RANK_WEIGHT;
    }
    score += freshnessRankBoost(article.chunkFreshnessAt ?? null);
  }
  const rs = article.rerankerScore;
  if (rs != null && rs > 0) {
    score += rs * 0.12;
  }
  return score;
}

function isCanonicalChunkWithFused(article: KBArticleResult): boolean {
  return (
    article.retrievalMethod === "knowledge_chunk" &&
    article.chunkFusedScore != null &&
    Number.isFinite(article.chunkFusedScore)
  );
}

/** Negative if `a` should sort before `b` (a ranks higher). Matches hybrid RPC ordering. */
function compareKbMergeDescending(
  a: KBArticleResult,
  b: KBArticleResult
): number {
  const ca = isCanonicalChunkWithFused(a);
  const cb = isCanonicalChunkWithFused(b);
  if (ca && cb) {
    const fusedDiff = (b.chunkFusedScore ?? 0) - (a.chunkFusedScore ?? 0);
    if (fusedDiff !== 0) return fusedDiff;
    const authDiff =
      (b.chunkAuthorityScore ?? 0.5) - (a.chunkAuthorityScore ?? 0.5);
    if (authDiff !== 0) return authDiff;
    const ta = a.chunkFreshnessAt
      ? Date.parse(a.chunkFreshnessAt)
      : Number.NEGATIVE_INFINITY;
    const tb = b.chunkFreshnessAt
      ? Date.parse(b.chunkFreshnessAt)
      : Number.NEGATIVE_INFINITY;
    if (tb !== ta) return tb - ta;
    return b.similarity - a.similarity;
  }
  const sa = kbArticleMergeRankScore(a);
  const sb = kbArticleMergeRankScore(b);
  if (sb !== sa) return sb - sa;
  return (b.rerankerScore ?? -1) - (a.rerankerScore ?? -1);
}

export function mergeDedupeKBArticles(
  articles: KBArticleResult[],
  normalizedLimit: number
): KBArticleResult[] {
  const deduped = new Map<string, KBArticleResult>();
  for (const article of articles) {
    const key = `${article.sourceType || "kb_article"}:${article.id}`;
    const existing = deduped.get(key);
    if (!existing || compareKbMergeDescending(existing, article) > 0) {
      deduped.set(key, article);
    }
  }
  return Array.from(deduped.values())
    .sort(compareKbMergeDescending)
    .slice(0, normalizedLimit);
}

/**
 * Same merge, dedupe, and ranking as production KB retrieval. For golden eval / CI only (no I/O).
 */
export function rankKBArticlesForEval(
  articles: KBArticleResult[],
  limit: number
): KBArticleResult[] {
  const n = Math.max(1, Math.floor(limit));
  return mergeDedupeKBArticles(articles, n);
}
