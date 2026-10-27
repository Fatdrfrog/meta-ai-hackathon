import { RAG_CONFIG } from "@/lib/airi/rag/config";
import type { KBArticleResult } from "@/lib/airi/rag/kb/kb-types";
import type { RetrievedAnswer } from "@/lib/airi/rag/types";

const RRF_K = RAG_CONFIG.rrf.k;

const SOURCE_WEIGHTS = RAG_CONFIG.rrf.sourceWeights;

export interface RRFCandidate {
  id: string;
  source: "snippet" | "kb";
  content: string;
  title: string;
  originalScore: number;
  rrfScore: number;
  sourceRank: number;
  metadata?: {
    category?: string;
    tags?: string[];
    url?: string;
    locale?: string;
  };
}

export interface RRFFusionResult {
  candidates: RRFCandidate[];
  stats: {
    snippetCandidates: number;
    kbCandidates: number;
    totalCandidates: number;
    topSource: "snippet" | "kb" | "none";
    topRRFScore: number;
  };
}

function calculateRRFScore(rank: number, weight: number = 1.0): number {
  return weight / (RRF_K + rank);
}

export function fuseWithRRF(
  snippets: RetrievedAnswer[],
  kbArticles: KBArticleResult[]
): RRFFusionResult {
  const candidates: RRFCandidate[] = [];

  snippets.forEach((snippet, index) => {
    const rank = index + 1;
    candidates.push({
      id: `snippet-${index}`,
      source: "snippet",
      content: snippet.answer,
      title: snippet.question,
      originalScore: snippet.score,
      rrfScore: calculateRRFScore(rank, SOURCE_WEIGHTS.snippet),
      sourceRank: rank,
      metadata: {
        category: snippet.category,
        tags: snippet.tags,
      },
    });
  });

  kbArticles.forEach((article, index) => {
    const rank = index + 1;
    candidates.push({
      id: article.id,
      source: "kb",
      content: article.fullContent || "",
      title: article.title,
      originalScore: article.similarity,
      rrfScore: calculateRRFScore(rank, SOURCE_WEIGHTS.kb),
      sourceRank: rank,
      metadata: {
        tags: article.tags,
        url: article.url,
        locale: article.locale,
      },
    });
  });

  candidates.sort((a, b) => b.rrfScore - a.rrfScore);

  const stats = {
    snippetCandidates: snippets.length,
    kbCandidates: kbArticles.length,
    totalCandidates: candidates.length,
    topSource: candidates[0]?.source || ("none" as const),
    topRRFScore: candidates[0]?.rrfScore || 0,
  };

  return { candidates, stats };
}

export function selectBestFromRRF(
  fusionResult: RRFFusionResult,
  options?: {
    minSnippetScore?: number;
    minKBScore?: number;
  }
): RRFCandidate | null {
  const {
    minSnippetScore = RAG_CONFIG.thresholds.snippet,
    minKBScore = RAG_CONFIG.thresholds.kbReranked,
  } = options || {};

  const eligible = fusionResult.candidates.filter(c => {
    if (c.source === "snippet") {
      return c.originalScore >= minSnippetScore;
    }
    return c.originalScore >= minKBScore;
  });

  if (eligible.length === 0) {
    return null;
  }

  return eligible[0];
}
