import { RAG_CONFIG } from "@/lib/airi/rag/config";
import type { HybridContext } from "@/lib/airi/rag/types";

/**
 * KB "admission" threshold for {@link isHighConfidenceKB} / context decisions.
 *
 * Vector retrieval uses `queryTypeThreshold * kbRetrievalStageRatio` (e.g. 0.75 × 0.9 = 0.675).
 * The decision layer must use a matching bar, otherwise we retrieve articles we immediately reject.
 */
export function computeKbAdmissionThreshold(
  queryTypeThreshold: number
): number {
  const ratio = RAG_CONFIG.thresholds.kbRetrievalStageRatio;
  const floor = RAG_CONFIG.thresholds.kbAdmissionFloor;
  const ceiling = RAG_CONFIG.thresholds.kbAdmissionCeiling;
  const raw = queryTypeThreshold * ratio - RAG_CONFIG.epsilon;
  return Math.min(ceiling, Math.max(floor, raw));
}

/**
 * Resolves the KB similarity threshold used for admission (decisions, matched article lists).
 * Prefers orchestrator-populated {@link HybridContext.retrievalStats.queryClassification}.
 */
export function resolveKbDecisionThreshold(ctx: HybridContext): number {
  const q = ctx.retrievalStats?.queryClassification;
  if (
    q &&
    typeof q.kbAdmissionThreshold === "number" &&
    Number.isFinite(q.kbAdmissionThreshold)
  ) {
    return q.kbAdmissionThreshold;
  }
  if (
    q &&
    typeof q.retrievalKbThreshold === "number" &&
    Number.isFinite(q.retrievalKbThreshold)
  ) {
    return computeKbAdmissionThreshold(q.retrievalKbThreshold);
  }
  return RAG_CONFIG.thresholds.kb;
}
