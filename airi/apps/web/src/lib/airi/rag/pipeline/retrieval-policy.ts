import type { RagQueryPreparation } from "@/lib/airi/rag/query/query-cleaner";
import type { RetrievalIntentClassification } from "@/lib/airi/rag/query/retrieval-intent-classifier";
import type {
  HybridRetrievalOptions,
  RetrievalBlendReason,
  RetrievalQueryVariantPurpose,
} from "@/lib/airi/rag/types";

type PinnedGrounding = NonNullable<HybridRetrievalOptions["pinnedGrounding"]>;
export type { RetrievalQueryVariantPurpose } from "@/lib/airi/rag/types";

export type RetrievalQueryVariantPlan = {
  query: string;
  purpose: RetrievalQueryVariantPurpose;
  stage: 1 | 2;
};

export type RetrievalQueryBudget = {
  maxKbVectorQueries: number;
  maxExtraQueryVariants: number;
  maxPinnedKbPasses: number;
};

export type RetrievalExecutionPlan = {
  queryVariants: string[];
  variantPlans: RetrievalQueryVariantPlan[];
  forceBlendedRetrieval: boolean;
  forceBlendedReason?: RetrievalBlendReason;
  retrievalBudget: RetrievalQueryBudget;
};

function dedupeComparable(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const rawValue of values) {
    const value = String(rawValue || "").trim();
    if (!value) continue;
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value);
  }

  return result;
}

function dedupeVariantPlans(
  variantPlans: RetrievalQueryVariantPlan[],
  limit: number = 4
): RetrievalQueryVariantPlan[] {
  const seen = new Set<string>();
  const result: RetrievalQueryVariantPlan[] = [];

  for (const plan of variantPlans) {
    const query = String(plan.query || "").trim();
    if (!query) continue;
    const normalized = query.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({
      query,
      purpose: plan.purpose,
      stage: plan.stage,
    });
    if (result.length >= limit) break;
  }

  return result;
}

export function resolveRetrievalHintVariants(params: {
  queryVariants?: string[];
  coverageHints?: string[];
  activeGoals?: string[];
}): string[] {
  const candidates =
    params.queryVariants && params.queryVariants.length > 0
      ? params.queryVariants
      : params.coverageHints && params.coverageHints.length > 0
        ? params.coverageHints
        : params.activeGoals || [];

  return dedupeComparable(candidates).slice(0, 4);
}

export function resolveThreadBlendDecision(params: {
  openAsks?: string[];
  followUpAnchor?: string | null;
  lastMessageQuery?: string | null;
}): {
  forceBlendedRetrieval: boolean;
  forceBlendedReason?: RetrievalBlendReason;
} {
  const hasMultipleOpenAsks = (params.openAsks?.length || 0) > 1;
  const hasFollowUpAnchorShift = Boolean(
    params.followUpAnchor &&
      params.lastMessageQuery &&
      params.followUpAnchor !== params.lastMessageQuery
  );

  if (hasMultipleOpenAsks || hasFollowUpAnchorShift) {
    return {
      forceBlendedRetrieval: true,
      forceBlendedReason: "thread_plan",
    };
  }

  return {
    forceBlendedRetrieval: false,
  };
}

/**
 * Build the retrieval execution plan (variant list + budget) from an already
 * prepared query. `ragQueryPreparation` is REQUIRED: the upstream caller
 * (retrieval-planner's `planRetrievalQuery`) is the single source of truth for
 * LLM-based query cleaning, so this function must never fall back to its own
 * LLM call. That guarantees no duplicate cleaner call per turn.
 */
export async function buildRetrievalExecutionPlan(params: {
  query: string;
  language?: string | null;
  ragQueryPreparation: RagQueryPreparation;
  plannedQueryVariants?: string[];
  forceBlendedRetrieval?: boolean;
  forceBlendedReason?: RetrievalBlendReason;
  pinnedGrounding?: PinnedGrounding;
  retrievalIntent?: RetrievalIntentClassification;
}): Promise<RetrievalExecutionPlan> {
  const primaryQuery = String(params.query || "").trim();
  const prep = params.ragQueryPreparation;
  const cleanedQuery = prep.cleanedQuery.trim();
  const decompositionVariants =
    prep.subQueries.length > 0 ? prep.subQueries : [];
  const overviewQueryVariants = params.retrievalIntent
    ?.shouldUseOverviewVariants
    ? params.retrievalIntent.queryVariants
    : [];
  const shouldUseBroadRetrieval = Boolean(
    params.retrievalIntent?.shouldUseBroadRetrieval
  );
  const hasPinnedGrounding = Boolean(params.pinnedGrounding?.sourceIds.length);

  // NOTE: We intentionally do NOT emit a stand-alone "cleanup" stage-2 variant
  // equal to `cleanedQuery`. Stage-1 retrieval already runs on the cleaned form
  // internally (see `retrieveRelevantKBArticles` — it re-derives cleanedQuery
  // from the provided `ragQueryPreparation`), so a second RPC on that string
  // is a guaranteed duplicate. Recall improvements come from decomposition,
  // pinned-followup, and service-overview variants, which differ from the
  // cleaned primary by design.
  const variantPlans = dedupeVariantPlans(
    [
      {
        query: primaryQuery || cleanedQuery,
        purpose: "primary",
        stage: 1,
      },
      ...decompositionVariants.map(variant => ({
        query: variant,
        purpose: "decomposition" as const,
        stage: 2 as const,
      })),
      ...(params.plannedQueryVariants || []).map(variant => ({
        query: variant,
        purpose:
          hasPinnedGrounding && params.forceBlendedReason === "thread_plan"
            ? ("pinned_followup" as const)
            : ("decomposition" as const),
        stage: 2 as const,
      })),
      ...overviewQueryVariants.map(variant => ({
        query: variant,
        purpose: "service_overview" as const,
        stage: 2 as const,
      })),
    ],
    4
  );

  const forceBlendedRetrieval =
    Boolean(params.forceBlendedRetrieval) ||
    hasPinnedGrounding ||
    decompositionVariants.length > 1 ||
    shouldUseBroadRetrieval;
  const forceBlendedReason = params.forceBlendedRetrieval
    ? params.forceBlendedReason || "thread_plan"
    : hasPinnedGrounding
      ? "pinned_grounding"
      : decompositionVariants.length > 1
        ? "compound_query"
        : shouldUseBroadRetrieval
          ? "service_overview"
          : undefined;

  const extraVariantPlans = variantPlans.filter(plan => plan.stage === 2);
  const maxExtraQueryVariants =
    extraVariantPlans.length === 0
      ? 0
      : forceBlendedReason === "thread_plan" ||
          forceBlendedReason === "compound_query" ||
          forceBlendedReason === "service_overview"
        ? Math.min(2, extraVariantPlans.length)
        : Math.min(1, extraVariantPlans.length);
  const maxPinnedKbPasses = hasPinnedGrounding ? 1 : 0;

  return {
    queryVariants: variantPlans.map(plan => plan.query),
    variantPlans,
    forceBlendedRetrieval,
    forceBlendedReason,
    retrievalBudget: {
      maxKbVectorQueries: 1 + maxExtraQueryVariants,
      maxExtraQueryVariants,
      maxPinnedKbPasses,
    },
  };
}
