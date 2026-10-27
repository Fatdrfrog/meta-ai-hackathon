import { RAG_CONFIG } from "@/lib/airi/rag/config";
import type {
  Citation,
  CitationPack,
  EvidenceChunk,
} from "@/lib/airi/rag/evidence/evidence-types";
import { CITATION_PACK_EXCERPT_MAX_LEN } from "./constants";
import {
  EVIDENCE_SOURCE_KIND_LABELS,
  isMirroredLogicalSourceKind,
} from "./evidence-source-labels";

export function sliceTopEvidenceChunks(
  chunks: EvidenceChunk[]
): EvidenceChunk[] {
  const limit = RAG_CONFIG.limits.kbArticles;
  return chunks.slice(0, limit);
}

function excerptForChunk(
  chunk: EvidenceChunk,
  maxLen = CITATION_PACK_EXCERPT_MAX_LEN
): string {
  const t = chunk.text.replace(/\s+/g, " ").trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen - 1)}…`;
}

function labelForChunk(chunk: EvidenceChunk): string {
  if (chunk.title?.trim()) return chunk.title.trim();
  const logical = chunk.metadata?.logicalSourceKind;
  if (isMirroredLogicalSourceKind(logical)) {
    return EVIDENCE_SOURCE_KIND_LABELS[logical] ?? "Source";
  }
  return EVIDENCE_SOURCE_KIND_LABELS[chunk.sourceKind] ?? "Source";
}

export function buildCitationPackFromTop(top: EvidenceChunk[]): CitationPack {
  const citations: Citation[] = top.map(chunk => ({
    chunkId: chunk.id,
    label: labelForChunk(chunk),
    url: chunk.url,
    sourceKind: chunk.sourceKind,
    excerpt: excerptForChunk(chunk),
  }));

  return {
    citations,
    primaryChunkIds: citations.map(c => c.chunkId),
  };
}
