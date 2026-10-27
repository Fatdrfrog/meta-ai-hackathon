import { RAG_CONFIG } from "@/lib/airi/rag/config";
import type { ConversationSummaryResult } from "@/lib/airi/rag/conversation-summary/conversation-summary-retrieval";
import type { KBArticleResult } from "@/lib/airi/rag/kb/kb-types";
import {
  canonicalKbHitToEvidenceChunk,
  curatedSnippetIdsCoveredByCanonicalKb,
  legacyKbHitToEvidenceChunk,
} from "@/lib/airi/rag/evidence/evidence-kb-mapping";
import type {
  EvidenceChunk,
  EvidencePools,
} from "@/lib/airi/rag/evidence/evidence-types";
import type { HybridContext, RetrievedAnswer } from "@/lib/airi/rag/types";

function hybridRelevanceScore(chunk: EvidenceChunk): number {
  return (
    (chunk.rerankerScore ?? 0) * 0.55 +
    (chunk.similarity ?? 0) * 0.35 +
    chunk.authorityScore * 0.1
  );
}

function kbHitToEvidenceChunk(article: KBArticleResult): EvidenceChunk {
  return article.retrievalMethod === "knowledge_chunk"
    ? canonicalKbHitToEvidenceChunk(article)
    : legacyKbHitToEvidenceChunk(article);
}

function snippetToChunk(snippet: RetrievedAnswer): EvidenceChunk {
  return {
    id: `curated_snippet:${snippet.id || "unknown"}`,
    sourceKind: "curated_snippet",
    locale: snippet.language,
    title: snippet.question?.slice(0, 120),
    text: `Q: ${snippet.question}\nA: ${snippet.answer}`,
    authorityScore: 0.95,
    similarity: snippet.score,
    rerankerScore: snippet.rerankerScore,
    metadata: { category: snippet.category },
  };
}

function summaryToChunk(
  row: ConversationSummaryResult,
  index: number
): EvidenceChunk {
  return {
    id: `conversation_summary:${row.conversationId}:${index}`,
    sourceKind: "conversation_summary",
    text: row.summaryText || "",
    title: `Conversation ${row.conversationId}`,
    authorityScore: RAG_CONFIG.authority.conversationSummary,
    similarity: row.similarity,
    metadata: { conversationId: row.conversationId },
  };
}

/**
 * Maps hybrid retrieval output into separate product vs memory pools (do not merge for ranking).
 */
export function splitEvidencePools(context: HybridContext): EvidencePools {
  const productChunks: EvidenceChunk[] = [];
  const kbArticles = context.kbArticles || [];
  const mongoSnippetCoveredByCanonical =
    curatedSnippetIdsCoveredByCanonicalKb(kbArticles);

  if (context.snippet) {
    const sid = context.snippet.id ? String(context.snippet.id) : null;
    if (!sid || !mongoSnippetCoveredByCanonical.has(sid)) {
      productChunks.push(snippetToChunk(context.snippet));
    }
  }
  const memoryChunks: EvidenceChunk[] = (
    context.conversationSummaries || []
  ).map((s, i) => summaryToChunk(s, i));
  for (const kb of kbArticles) {
    productChunks.push(kbHitToEvidenceChunk(kb));
  }

  return { productChunks, memoryChunks };
}

/**
 * Merged product-side evidence sorted by hybrid relevance signals (for legacy callers).
 */
export function rankProductEvidence(chunks: EvidenceChunk[]): EvidenceChunk[] {
  return [...chunks].sort(
    (a, b) => hybridRelevanceScore(b) - hybridRelevanceScore(a)
  );
}
