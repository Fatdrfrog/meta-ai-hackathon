import "server-only";

import type {
  CanonicalKnowledgeChunkRow,
  QueryKnowledgeChunksParams,
} from "@/lib/airi/rag/kb/kb-types";
import { resolveMatchAllowedVisibilities } from "@/lib/airi/rag/knowledge/knowledge-search-permissions";
import { ragLogger } from "@/lib/airi/shared/logger";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  KNOWLEDGE_CANONICAL_SYNC_SOURCE_KINDS,
  normalizeKnowledgeCanonicalSyncSourceKinds,
} from "@icecore/temporal";

export type { CanonicalKnowledgeChunkRow, QueryKnowledgeChunksParams };

/**
 * Drops `kb_article` chunks whose article is no longer published (unpublished
 * or deleted). Unpublishing retires canonical documents right away; this
 * covers a failed or racing retirement, since nothing in
 * `match_knowledge_chunks` checks publication status.
 */
async function dropUnpublishedKbArticleRows(
  workspaceId: string,
  rows: CanonicalKnowledgeChunkRow[]
): Promise<CanonicalKnowledgeChunkRow[]> {
  const articleIds = Array.from(
    new Set(
      rows
        .filter(row => row.source_kind === "kb_article")
        .map(row => row.source_record_id)
        .filter(Boolean)
    )
  );
  if (articleIds.length === 0) return rows;

  const { data, error } = await supabaseAdmin
    .from("kb_articles")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("status", "published")
    .in("id", articleIds);

  let publishedIds: Set<string>;
  if (error) {
    ragLogger.retrieval.warn(
      "Failed to validate canonical KB article visibility",
      {
        workspaceId,
        candidateCount: articleIds.length,
        error: error.message,
      }
    );
    // Fail closed for KB chunks; other sources don't depend on article status.
    publishedIds = new Set();
  } else {
    publishedIds = new Set((data || []).map(row => String(row.id)));
  }

  return rows.filter(
    row =>
      row.source_kind !== "kb_article" || publishedIds.has(row.source_record_id)
  );
}

/**
 * Hybrid search over mirrored `knowledge_chunks` (cosine + FTS + RRF via `match_knowledge_chunks`).
 */
export async function queryKnowledgeChunks(
  params: QueryKnowledgeChunksParams
): Promise<CanonicalKnowledgeChunkRow[]> {
  const {
    workspaceId,
    queryText,
    queryEmbedding,
    matchCount,
    matchThreshold,
    matchLocale,
    matchSourceKinds,
    knowledgeSearchPrincipal,
    matchAllowedVisibilities: explicitVisibilities,
    fullTextWeight = 1,
    semanticWeight = 1,
    rrfK = 50,
  } = params;

  if (!workspaceId || !queryEmbedding?.length) {
    return [];
  }

  const resolvedVisibilities = resolveMatchAllowedVisibilities({
    knowledgeSearchPrincipal,
    matchAllowedVisibilities: explicitVisibilities,
  });
  const normalizedRequestedSourceKinds =
    normalizeKnowledgeCanonicalSyncSourceKinds(matchSourceKinds);
  const requestedSourceKinds = normalizedRequestedSourceKinds?.length
    ? normalizedRequestedSourceKinds
    : [...KNOWLEDGE_CANONICAL_SYNC_SOURCE_KINDS];
  const requestedSourceKindSet = new Set<string>(requestedSourceKinds);
  const supportedSourceKindSet = new Set<string>(
    KNOWLEDGE_CANONICAL_SYNC_SOURCE_KINDS
  );

  try {
    const rpcArgs: Record<string, unknown> = {
      query_text: queryText,
      query_embedding: queryEmbedding,
      match_workspace: workspaceId,
      match_count: matchCount,
      match_threshold: matchThreshold,
      match_locale: matchLocale,
      match_source_kinds: requestedSourceKinds,
      full_text_weight: fullTextWeight,
      semantic_weight: semanticWeight,
      rrf_k: rrfK,
    };
    if (resolvedVisibilities !== null) {
      rpcArgs.match_allowed_visibilities = resolvedVisibilities;
    }

    const { data, error } = await supabaseAdmin.rpc(
      "match_knowledge_chunks",
      rpcArgs
    );

    if (error) {
      ragLogger.retrieval.warn("match_knowledge_chunks RPC failed", {
        workspaceId,
        error: error.message,
        rpcFunction: "match_knowledge_chunks",
      });
      return [];
    }

    const rows = Array.isArray(data)
      ? (data as CanonicalKnowledgeChunkRow[])
      : [];
    return await dropUnpublishedKbArticleRows(
      workspaceId,
      rows.filter(
        row =>
          supportedSourceKindSet.has(row.source_kind) &&
          requestedSourceKindSet.has(row.source_kind)
      )
    );
  } catch (error) {
    ragLogger.retrieval.warn("match_knowledge_chunks threw", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
