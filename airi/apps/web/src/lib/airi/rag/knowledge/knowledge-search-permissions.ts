/**
 * Maps request-time principals to hybrid `match_knowledge_chunks.match_allowed_visibilities`.
 * Source-kind filtering remains on `match_source_kinds` (see knowledge-chunks-retrieval).
 */

/** Stored in `knowledge_documents.visibility` / `knowledge_chunks.visibility`. */
export const KNOWLEDGE_CHUNK_VISIBILITY = {
  WORKSPACE: "workspace",
  PUBLIC: "public",
  INTERNAL: "internal",
} as const;

export type KnowledgeChunkVisibility =
  (typeof KNOWLEDGE_CHUNK_VISIBILITY)[keyof typeof KNOWLEDGE_CHUNK_VISIBILITY];

/**
 * Who is performing canonical chunk search; drives default visibility allowlist.
 *
 * - `rag_auto_reply` — outbound / customer-facing RAG (no internal-only chunks).
 * - `workspace_member_tool` — authenticated workspace tools (panel, coach, etc.).
 * - `system_unrestricted` — no visibility predicate in RPC (omit filter).
 */
export type KnowledgeSearchPrincipal =
  | "rag_auto_reply"
  | "workspace_member_tool"
  | "system_unrestricted";

const RAG_AUTO_REPLY_VISIBILITIES: KnowledgeChunkVisibility[] = [
  KNOWLEDGE_CHUNK_VISIBILITY.WORKSPACE,
  KNOWLEDGE_CHUNK_VISIBILITY.PUBLIC,
];

const WORKSPACE_TOOL_VISIBILITIES: KnowledgeChunkVisibility[] = [
  KNOWLEDGE_CHUNK_VISIBILITY.WORKSPACE,
  KNOWLEDGE_CHUNK_VISIBILITY.PUBLIC,
  KNOWLEDGE_CHUNK_VISIBILITY.INTERNAL,
];

/**
 * Resolves RPC `match_allowed_visibilities`.
 *
 * - `matchAllowedVisibilities: null` → unrestricted (omit filter in SQL).
 * - `matchAllowedVisibilities: string[]` → explicit allowlist (may be empty).
 * - undefined → derive from `knowledgeSearchPrincipal` (default `rag_auto_reply`).
 */
export function resolveMatchAllowedVisibilities(params: {
  knowledgeSearchPrincipal?: KnowledgeSearchPrincipal;
  matchAllowedVisibilities?: string[] | null;
}): string[] | null {
  if (params.matchAllowedVisibilities !== undefined) {
    return params.matchAllowedVisibilities;
  }

  const principal = params.knowledgeSearchPrincipal ?? "rag_auto_reply";
  if (principal === "system_unrestricted") {
    return null;
  }
  if (principal === "workspace_member_tool") {
    return [...WORKSPACE_TOOL_VISIBILITIES];
  }
  return [...RAG_AUTO_REPLY_VISIBILITIES];
}

/** Stable segment for KB retrieval cache keys. */
export function visibilityCacheKeySegment(allowed: string[] | null): string {
  if (allowed === null) {
    return "vis:all";
  }
  if (allowed.length === 0) {
    return "vis:none";
  }
  return `vis:${[...allowed].sort().join("|")}`;
}
