import type { RAGGenerateResponseParams } from "@/lib/airi/rag/response/types";
import type { HybridRetrievalOptions } from "@/lib/airi/rag/types";

export function resolvePinnedGroundingForRetrieval(
  params: Pick<
    RAGGenerateResponseParams,
    "lastGrounding" | "followUpMode" | "activeSelection"
  >
): HybridRetrievalOptions["pinnedGrounding"] {
  const activeSelection = params.activeSelection;
  if (activeSelection?.sourceIds?.length) {
    return {
      sourceKind: activeSelection.sourceKind,
      sourceIds: activeSelection.sourceIds,
    };
  }

  const lastGrounding = params.lastGrounding;
  if (!lastGrounding?.sourceIds?.length) return undefined;
  if (lastGrounding.sourceKind !== "none") {
    return {
      sourceKind: lastGrounding.sourceKind,
      sourceIds: lastGrounding.sourceIds,
    };
  }
  if (params.followUpMode === "expand_last_grounding") {
    return { sourceKind: "kb", sourceIds: lastGrounding.sourceIds };
  }
  return undefined;
}
