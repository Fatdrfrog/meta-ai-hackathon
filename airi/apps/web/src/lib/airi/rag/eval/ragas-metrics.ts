/**
 * Deterministic RAGAS-lite metrics (Phase 3.5 rag-production-hardening).
 *
 * Implements offline-computable proxies for the four classic RAGAS metrics so
 * CI can enforce quality gates without LLM-as-judge API calls:
 *
 *   - contextPrecisionAtK — fraction of retrieved chunks (in top-k) whose
 *     source id is in the gold set, rank-weighted (reward higher ranks more).
 *   - contextRecallAtK   — fraction of gold source ids recovered inside top-k.
 *   - answerRelevancy    — token-set F1 of (generated answer, gold answer).
 *   - faithfulness       — fraction of answer n-grams that appear in the
 *     concatenated retrieved context; penalizes hallucinated claims.
 *
 * These are proxies, not ground-truth RAGAS. They correlate strongly enough
 * with the LLM-judge scores to regression-test retrieval and generation
 * without external dependencies. Real LLM-judge scoring runs in the launch-gate
 * eval on real workspaces (see Phase 4).
 */

export interface RagasCaseInput {
  id: string;
  query: string;
  /** Retrieved source ids in rank order (best first). */
  retrievedSourceIds: readonly string[];
  /** Ground-truth source ids that answer the query (order-insensitive). */
  goldSourceIds: readonly string[];
  /** Text of the retrieved chunks concatenated, used for faithfulness. */
  retrievedContext: string;
  /** Generated answer produced by the RAG pipeline. */
  generatedAnswer: string;
  /** Ground-truth answer (reference). */
  goldAnswer: string;
}

export interface RagasCaseScores {
  id: string;
  contextPrecisionAtK: number;
  contextRecallAtK: number;
  answerRelevancy: number;
  faithfulness: number;
}

export interface RagasAggregate {
  contextPrecisionAtK: number;
  contextRecallAtK: number;
  answerRelevancy: number;
  faithfulness: number;
}

const STOPWORDS = new Set<string>([
  // English
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "of",
  "to",
  "in",
  "on",
  "for",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "with",
  "as",
  "by",
  "at",
  "from",
  "you",
  "your",
  "we",
  "our",
  "i",
  "do",
  "does",
  "did",
  "not",
  // Russian
  "и",
  "в",
  "не",
  "на",
  "что",
  "как",
  "же",
  "бы",
  "по",
  "это",
  "за",
  "от",
  "для",
  "о",
  "с",
  "к",
  "у",
  "из",
]);

function normalizeText(text: string): string {
  return (text || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(" ")
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

function ngrams(tokens: readonly string[], n: number): string[] {
  if (tokens.length < n) return [];
  const out: string[] = [];
  for (let i = 0; i <= tokens.length - n; i += 1) {
    out.push(tokens.slice(i, i + n).join(" "));
  }
  return out;
}

/**
 * Context precision@k with a linear rank-decay weight. A gold hit at rank 1
 * contributes more than the same hit at rank k. Bounded to [0, 1].
 */
export function contextPrecisionAtK(
  retrieved: readonly string[],
  gold: readonly string[],
  k?: number
): number {
  const cutoff = k ?? retrieved.length;
  if (cutoff <= 0 || gold.length === 0) return 0;
  const goldSet = new Set(gold);
  const topK = retrieved.slice(0, cutoff);
  if (topK.length === 0) return 0;

  let weightedHits = 0;
  let weightSum = 0;
  for (let i = 0; i < topK.length; i += 1) {
    const rankWeight = 1 / (i + 1);
    weightSum += rankWeight;
    if (goldSet.has(topK[i])) weightedHits += rankWeight;
  }
  return weightSum > 0 ? weightedHits / weightSum : 0;
}

export function contextRecallAtK(
  retrieved: readonly string[],
  gold: readonly string[],
  k?: number
): number {
  if (gold.length === 0) return 1;
  const cutoff = k ?? retrieved.length;
  const top = new Set(retrieved.slice(0, cutoff));
  let hits = 0;
  for (const id of gold) {
    if (top.has(id)) hits += 1;
  }
  return hits / gold.length;
}

/**
 * Token-set F1 between generated and gold answer. Token set keeps the metric
 * robust to paraphrasing / word order while still rewarding content overlap.
 */
export function answerRelevancy(generated: string, gold: string): number {
  const genTokens = new Set(tokenize(generated));
  const goldTokens = new Set(tokenize(gold));
  if (genTokens.size === 0 && goldTokens.size === 0) return 1;
  if (genTokens.size === 0 || goldTokens.size === 0) return 0;
  let overlap = 0;
  for (const t of genTokens) {
    if (goldTokens.has(t)) overlap += 1;
  }
  const precision = overlap / genTokens.size;
  const recall = overlap / goldTokens.size;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * Faithfulness proxy: what fraction of content n-grams from the answer also
 * appear in the retrieved context. n=2 balances sensitivity (catches novel
 * claims) with recall (tolerates paraphrase).
 *
 * Returns 1 for empty answers so we don't double-penalize abstention cases.
 */
export function faithfulness(
  generated: string,
  retrievedContext: string,
  n = 2
): number {
  const genTokens = tokenize(generated);
  if (genTokens.length === 0) return 1;
  const ctxTokens = tokenize(retrievedContext);
  if (ctxTokens.length === 0) return 0;
  const answerGrams = ngrams(genTokens, n);
  if (answerGrams.length === 0) {
    // Short answer (< n tokens): fall back to unigram containment.
    const ctxSet = new Set(ctxTokens);
    const hits = genTokens.filter(t => ctxSet.has(t)).length;
    return hits / genTokens.length;
  }
  const ctxSet = new Set(ngrams(ctxTokens, n));
  let hits = 0;
  for (const g of answerGrams) {
    if (ctxSet.has(g)) hits += 1;
  }
  return hits / answerGrams.length;
}

export function scoreCase(input: RagasCaseInput): RagasCaseScores {
  return {
    id: input.id,
    contextPrecisionAtK: contextPrecisionAtK(
      input.retrievedSourceIds,
      input.goldSourceIds
    ),
    contextRecallAtK: contextRecallAtK(
      input.retrievedSourceIds,
      input.goldSourceIds
    ),
    answerRelevancy: answerRelevancy(input.generatedAnswer, input.goldAnswer),
    faithfulness: faithfulness(input.generatedAnswer, input.retrievedContext),
  };
}

export function aggregate(scores: readonly RagasCaseScores[]): RagasAggregate {
  if (scores.length === 0) {
    return {
      contextPrecisionAtK: 0,
      contextRecallAtK: 0,
      answerRelevancy: 0,
      faithfulness: 0,
    };
  }
  const sum = scores.reduce(
    (acc, s) => ({
      contextPrecisionAtK: acc.contextPrecisionAtK + s.contextPrecisionAtK,
      contextRecallAtK: acc.contextRecallAtK + s.contextRecallAtK,
      answerRelevancy: acc.answerRelevancy + s.answerRelevancy,
      faithfulness: acc.faithfulness + s.faithfulness,
    }),
    {
      contextPrecisionAtK: 0,
      contextRecallAtK: 0,
      answerRelevancy: 0,
      faithfulness: 0,
    }
  );
  const n = scores.length;
  return {
    contextPrecisionAtK: sum.contextPrecisionAtK / n,
    contextRecallAtK: sum.contextRecallAtK / n,
    answerRelevancy: sum.answerRelevancy / n,
    faithfulness: sum.faithfulness / n,
  };
}
