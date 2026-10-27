import "server-only";

import type {
  EvidenceChunk,
  GroundedAnswer,
} from "@/lib/airi/rag/evidence/evidence-types";
import {
  rankProductEvidence,
  splitEvidencePools,
} from "@/lib/airi/rag/evidence/evidence-from-hybrid";
import type { HybridContext } from "@/lib/airi/rag/types";
import { normalizeComparableText } from "@/lib/airi/reply/thread/reply-text-utils";
import {
  buildCitationPackFromTop,
  sliceTopEvidenceChunks,
} from "./citation-pack";
import { GROUNDING_REFLECTION_EXCERPT_CAP } from "./constants";
import { postCheckClaims } from "./grounded-claims";
import type { LlmGroundingReflection } from "./llm-grounding-reflection";

export type { LlmGroundingReflection } from "./llm-grounding-reflection";

export function rankProductEvidenceChunks(
  hybridContext: HybridContext
): EvidenceChunk[] {
  const pools = splitEvidencePools(hybridContext);
  return rankProductEvidence(pools.productChunks);
}

/** Source lines for {@link runLlmGroundingReflection} (aligned with citation pack depth). */
export function buildGroundingReflectionSources(
  hybridContext: HybridContext,
  rankedProduct?: EvidenceChunk[]
): Array<{ chunkId: string; excerpt: string }> {
  const ranked = rankedProduct ?? rankProductEvidenceChunks(hybridContext);
  return sliceTopEvidenceChunks(ranked).map(c => ({
    chunkId: c.id,
    excerpt: (c.text || "").slice(0, GROUNDING_REFLECTION_EXCERPT_CAP),
  }));
}

function mergeUniqueClaims(a: string[], b: string[]): string[] {
  const seen = new Set(a.map(s => normalizeComparableText(s)));
  const out = [...a];
  for (const raw of b) {
    const t = raw.trim();
    if (t.length < 12) continue;
    const key = normalizeComparableText(t);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function mergeLlmIntoGroundedAnswer(
  base: GroundedAnswer,
  reflection: LlmGroundingReflection | null | undefined
): GroundedAnswer {
  if (!reflection) return base;

  const allowed = new Set(base.citations.map(c => c.chunkId));
  const llmCitedChunkIds = reflection.citedChunkIds.filter(id =>
    allowed.has(id)
  );
  const unsupportedClaims = mergeUniqueClaims(
    base.unsupportedClaims,
    reflection.unsupportedClaims
  );
  const confidence = Math.min(base.confidence, reflection.confidence);

  return {
    ...base,
    unsupportedClaims,
    confidence,
    llmCitedChunkIds:
      llmCitedChunkIds.length > 0 ? llmCitedChunkIds : undefined,
  };
}

/**
 * Heuristic grounding only (no LLM). Shared with the merged pipeline.
 */
export function computeHeuristicGroundedAnswer(params: {
  answer: string;
  rankedProduct: EvidenceChunk[];
}): GroundedAnswer {
  const topChunks = sliceTopEvidenceChunks(params.rankedProduct);
  const citationPack = buildCitationPackFromTop(topChunks);
  const citationTexts = topChunks.map(c => c.text || "");

  const claimCheck = postCheckClaims({
    answer: params.answer || "",
    citationTexts,
  });

  return {
    answer: params.answer || "",
    citations: citationPack.citations,
    confidence: claimCheck.confidence,
    unsupportedClaims: claimCheck.unsupportedClaims,
  };
}

/**
 * Structured grounding: ranked product evidence → citations → heuristic overlap, optionally
 * merged with {@link runLlmGroundingReflection}. Does not replace the main reply generator text.
 *
 * Pass {@link rankedProductOverride} when the caller already computed
 * {@link rankProductEvidenceChunks} (avoids duplicate ranking on the hot path).
 */
export function generateGroundedAnswer(params: {
  answer: string;
  hybridContext: HybridContext;
  llmReflection?: LlmGroundingReflection | null;
  rankedProductOverride?: EvidenceChunk[];
}): GroundedAnswer {
  const ranked =
    params.rankedProductOverride ??
    rankProductEvidenceChunks(params.hybridContext);
  const base = computeHeuristicGroundedAnswer({
    answer: params.answer,
    rankedProduct: ranked,
  });
  return mergeLlmIntoGroundedAnswer(base, params.llmReflection);
}
