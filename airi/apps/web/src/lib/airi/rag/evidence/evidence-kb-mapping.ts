import type { EvidenceChunk } from "@/lib/airi/rag/evidence/evidence-types";
import type {
  KBArticleResult,
  LogicalMirroredSourceKind,
} from "@/lib/airi/rag/kb/kb-types";

export type { LogicalMirroredSourceKind } from "@/lib/airi/rag/kb/kb-types";

/** Logical kind for policy, citations, and URLs. */
function logicalSourceKindFromKbHit(
  article: KBArticleResult
): LogicalMirroredSourceKind {
  if (article.sourceType === "indexed_url") return "indexed_url";
  if (article.sourceType === "curated_snippet") return "curated_snippet";
  return "kb_article";
}

function authorityForLogicalKind(
  article: KBArticleResult,
  logical: LogicalMirroredSourceKind
): number {
  if (logical === "curated_snippet") return 0.95;
  if (logical === "indexed_url") return 0.45;
  return article.allowAutoLinkEmbedding ? 0.85 : 0.7;
}

/**
 * Supabase `knowledge_chunks` hit (`retrievalMethod === "knowledge_chunk"`).
 * Evidence text is the chunk body only — no article-level title+body merge.
 */
export function canonicalKbHitToEvidenceChunk(
  article: KBArticleResult
): EvidenceChunk {
  const logical = logicalSourceKindFromKbHit(article);
  const body = (article.fullContent || "").trim();
  const title = article.title?.trim();

  const mirroredAuthority =
    article.chunkAuthorityScore != null &&
    Number.isFinite(article.chunkAuthorityScore)
      ? article.chunkAuthorityScore
      : null;

  return {
    id: `knowledge_chunk:${article.id}`,
    sourceKind: "knowledge_chunk",
    locale: article.locale,
    title: title || undefined,
    text: body,
    url: article.url,
    authorityScore:
      mirroredAuthority ?? authorityForLogicalKind(article, logical),
    similarity: article.similarity,
    rerankerScore: article.rerankerScore,
    metadata: {
      retrievalMethod: article.retrievalMethod,
      contextFormat: article.contextFormat,
      documentId: article.documentId,
      sourceRecordId: article.sourceRecordId,
      chunkIndex: article.chunkIndex,
      logicalSourceKind: logical,
    },
  };
}

/**
 * Legacy article-level KB hit (RPC on articles / FTS / pinned full article).
 */
export function legacyKbHitToEvidenceChunk(
  article: KBArticleResult
): EvidenceChunk {
  const logical = logicalSourceKindFromKbHit(article);
  return {
    id: `${logical}:${article.id}`,
    sourceKind: logical,
    locale: article.locale,
    title: article.title,
    text: [article.title, article.fullContent].filter(Boolean).join("\n\n"),
    url: article.url,
    authorityScore: authorityForLogicalKind(article, logical),
    similarity: article.similarity,
    rerankerScore: article.rerankerScore,
    metadata: {
      retrievalMethod: article.retrievalMethod,
      contextFormat: article.contextFormat,
    },
  };
}

export function curatedSnippetIdsCoveredByCanonicalKb(
  kbArticles: KBArticleResult[]
): Set<string> {
  const ids = new Set<string>();
  for (const kb of kbArticles) {
    if (
      kb.retrievalMethod === "knowledge_chunk" &&
      kb.sourceType === "curated_snippet" &&
      kb.sourceRecordId
    ) {
      ids.add(String(kb.sourceRecordId));
    }
  }
  return ids;
}
