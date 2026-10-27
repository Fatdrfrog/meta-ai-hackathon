/**
 * Snippet retrieval service (canonical path).
 *
 * Answer-snippets are retrieved exclusively from `knowledge_chunks` via
 * `match_knowledge_chunks` — single RPC, single store. The previous Mongo
 * `$vectorSearch` + cosine-fallback + FTS + reranker-rescue leg has been
 * removed (Phase 4 rag-production-hardening cleanup). Canonical sync in
 * `knowledge-canonical-sync-runner.ts` mirrors every `AnswerSnippet` row into
 * `knowledge_chunks` with `source_kind='curated_snippet'`, so the canonical
 * RPC is the single source of truth.
 *
 * HyDE is now owned by `RetrievalOrchestrator`; the seed hypothetical answer
 * from unified query-prep (see `query-cleaner.ts`) is threaded through the
 * KB retrieval path and no longer re-applied here.
 */

import { randomUUID } from "node:crypto";
import { getQueryEmbeddingWithCache } from "@/lib/ai";
import { RAG_CONFIG } from "@/lib/airi/rag/config";
import { queryKnowledgeChunks } from "@/lib/airi/rag/knowledge/knowledge-chunks-retrieval";
import type { RetrievedAnswer } from "@/lib/airi/rag/types";

export type { RetrievedAnswer };

/**
 * Canonical-store snippet retrieval.
 *
 * Reads `curated_snippet` rows from `knowledge_chunks` via
 * `match_knowledge_chunks`. Parses the `Q: ...\nA: ...` chunk format written
 * by `chunkCuratedSnippet` to reconstruct question/answer. Category/tags are
 * intentionally dropped — the canonical retrieval path uses the chunk's
 * `locale` and `title` only, which is sufficient for the downstream reranker
 * + verifier owned by `RetrievalOrchestrator`.
 */
async function retrieveBestAnswerFromCanonical(params: {
  workspaceId: string;
  queryText: string;
  queryEmbedding: number[];
  limit: number;
  threshold: number;
  matchLocale: string | null;
  allowedSnippetIds: string[];
}): Promise<RetrievedAnswer | null> {
  const {
    workspaceId,
    queryText,
    queryEmbedding,
    limit,
    threshold,
    matchLocale,
    allowedSnippetIds,
  } = params;
  const allowedSet =
    allowedSnippetIds.length > 0 ? new Set(allowedSnippetIds) : null;

  const rows = await queryKnowledgeChunks({
    workspaceId,
    queryText,
    queryEmbedding,
    matchCount: Math.max(limit, 10),
    matchThreshold: Math.max(0, threshold - 0.05),
    matchLocale,
    matchSourceKinds: ["curated_snippet"],
  });

  const filtered = rows
    .filter(row =>
      allowedSet ? allowedSet.has(String(row.source_record_id)) : true
    )
    .sort((a, b) => (b.fused_score ?? 0) - (a.fused_score ?? 0));

  const top = filtered[0];
  if (!top) return null;

  const content = top.content || "";
  let question = top.title || "";
  let answer = content;
  const qaMatch = content.match(/^Q:\s*([\s\S]*?)\nA:\s*([\s\S]*)$/);
  if (qaMatch) {
    question = (qaMatch[1] || question).trim();
    answer = (qaMatch[2] || "").trim();
  }

  return {
    id: String(top.source_record_id),
    question,
    answer,
    score: Math.min(1, Math.max(0, top.fused_score ?? 1 - top.distance)),
    language: top.locale || undefined,
    retrievalMethod: "knowledge_chunk",
  };
}

/**
 * Retrieve the best matching snippet for a query from the canonical store.
 *
 * Reranking / verification live in `RetrievalOrchestrator`; HyDE is applied
 * upstream via unified query-prep. This fn only does the canonical RPC.
 */
export async function retrieveBestAnswer(
  workspaceId: string,
  text: string,
  opts?: {
    language?: string;
    threshold?: number;
    limit?: number;
    queryEmbedding?: number[];
    allowedSnippetIds?: string[];
  }
): Promise<RetrievedAnswer | null> {
  const trimmed = (text || "").trim();
  if (trimmed.length < 4) return null;

  const limit = opts?.limit ?? RAG_CONFIG.limits.snippets;
  const threshold = opts?.threshold ?? RAG_CONFIG.thresholds.snippet;
  const embedding =
    opts?.queryEmbedding ??
    (await getQueryEmbeddingWithCache(trimmed, {
      workspaceId,
      actionId: `snippet-retrieval:${randomUUID()}`,
    }).catch(() => null));
  if (!embedding) return null;

  const allowedSnippetIds = Array.isArray(opts?.allowedSnippetIds)
    ? opts.allowedSnippetIds.filter(Boolean).map(id => String(id))
    : [];

  return retrieveBestAnswerFromCanonical({
    workspaceId,
    queryText: trimmed,
    queryEmbedding: embedding,
    limit,
    threshold,
    matchLocale: opts?.language || null,
    allowedSnippetIds,
  });
}
