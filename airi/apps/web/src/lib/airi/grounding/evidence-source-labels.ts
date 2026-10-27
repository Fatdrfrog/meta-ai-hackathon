import type { EvidenceSourceKind } from "@/lib/airi/rag/evidence/evidence-types";

/** Human-readable labels for citation UI and default titles when a chunk has no title. */
export const EVIDENCE_SOURCE_KIND_LABELS: Record<EvidenceSourceKind, string> = {
  kb_article: "Knowledge base article",
  indexed_url: "Indexed page",
  curated_snippet: "Verified snippet",
  conversation_summary: "Conversation memory",
  knowledge_chunk: "Documentation",
};

/** Same three product kinds as `normalizeCanonicalSourceKind` in KB retrieval. */
export type CanonicalMirroredSourceKind =
  | "kb_article"
  | "indexed_url"
  | "curated_snippet";

const MIRRORED_LOGICAL_KINDS = new Set<string>([
  "kb_article",
  "indexed_url",
  "curated_snippet",
]);

/** `metadata.logicalSourceKind` when it mirrors a canonical row kind (not e.g. raw `knowledge_chunk`). */
export function isMirroredLogicalSourceKind(
  v: unknown
): v is CanonicalMirroredSourceKind {
  return typeof v === "string" && MIRRORED_LOGICAL_KINDS.has(v);
}

export function fallbackTitleForCanonicalRow(
  sourceType: CanonicalMirroredSourceKind,
  rowTitle: string | null | undefined
): string {
  const t = rowTitle?.trim();
  if (t) return t;
  if (sourceType === "curated_snippet") {
    return EVIDENCE_SOURCE_KIND_LABELS.curated_snippet;
  }
  return "Untitled";
}
