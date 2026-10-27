import "server-only";

import {
  isRagPrepExplicitlyNonSearchable,
  normalizeRagQueryWhitespace,
  prepareQueryForRagWithLlm,
  type RagQueryPreparation,
} from "@/lib/airi/rag/query/query-cleaner";
import type {
  CitationStrength,
  FactualIntent,
  PlannerMode,
  RetrievalPlan,
} from "@/lib/airi/rag/evidence/evidence-types";
import { isLikelyGreetingOnly } from "@/lib/airi/shared/greeting-heuristics";
import type { RetrievalIntentClassification } from "@/lib/airi/rag/query/retrieval-intent-classifier";
import type { RetrievalBlendReason } from "@/lib/airi/rag/types";

function questionMarkCount(query: string): number {
  return (query.match(/\?/g) || []).length;
}

function looksCompound(query: string): boolean {
  const t = query.trim();
  if (t.length > 360) return true;
  if (questionMarkCount(t) >= 2) return true;
  if (/\n{2,}/.test(t)) return true;
  return /\b(and also|as well as|а также|также|және|ва\s+ham)\b/i.test(t);
}

function inferFactualIntent(query: string): FactualIntent {
  const t = query.trim().toLowerCase();
  if (/(how\s+do\s+i|как\s+(мне|я)|қалай)/i.test(query) && t.length < 400) {
    return "procedural";
  }
  if (/(where|где|қайда|qayerda)/i.test(query)) return "navigational";
  if (questionMarkCount(query) >= 1 && t.length < 500) return "factual";
  return "none";
}

function citationStrengthForIntent(
  intent: FactualIntent,
  serviceOverview: boolean
): CitationStrength {
  if (serviceOverview) return "preferred";
  if (intent === "factual" || intent === "procedural") return "strict";
  if (intent === "navigational") return "preferred";
  return "none";
}

export type PlanRetrievalQueryParams = {
  query: string;
  language?: string | null;
  workspaceId?: string | null;
  conversationId?: string | null;
  pinnedSourceIds?: string[];
  forceBlendedRetrieval?: boolean;
  forceBlendedReason?: RetrievalBlendReason;
  /** When true, never call LLM query prep (fast channel / latency-sensitive paths). */
  skipLlmRetrievalPlanner?: boolean;
  /**
   * Reuse when {@link PlanRetrievalQueryParams.query} matches `originalQuery` or
   * (for goal-planner retrieval) equals `cleanedQuery` from the same turn prep.
   */
  seedRagQueryPreparation?: RagQueryPreparation;
  retrievalIntent?: RetrievalIntentClassification;
};

/**
 * True when the retrieval `query` is already covered by turn-understanding prep,
 * so {@link prepareQueryForRagWithLlm} can be skipped.
 * Compares normalized whitespace; matches original, cleaned, or any sub-query.
 */
export function turnSeedCoversRetrievalQuery(
  seed: RagQueryPreparation | undefined,
  raw: string
): boolean {
  if (!seed) return false;
  const r = normalizeRagQueryWhitespace(raw);
  if (r.length < 2) return false;
  if (isRagPrepExplicitlyNonSearchable(seed)) return false;

  if (normalizeRagQueryWhitespace(seed.originalQuery) === r) return true;

  const cleaned = seed.cleanedQuery.trim();
  if (cleaned.length >= 4 && normalizeRagQueryWhitespace(cleaned) === r) {
    return true;
  }

  for (const sq of seed.subQueries) {
    const t = sq.trim();
    if (t.length >= 4 && normalizeRagQueryWhitespace(t) === r) {
      return true;
    }
  }

  return false;
}

/**
 * Turn understanding's own LLM prep, made for this turn with the conversation
 * in view. The thread retrieval query is built from that same turn's asks and
 * anchors, so a second prep call on it repeats the work (about 2 s).
 */
function isSearchableTurnModelSeed(
  seed: RagQueryPreparation | undefined
): seed is RagQueryPreparation {
  return Boolean(
    seed && seed.source === "llm" && !isRagPrepExplicitlyNonSearchable(seed)
  );
}

/** When hybrid context predates planner metadata (tests, partial mocks). */
export function createFallbackRetrievalPlan(query: string): RetrievalPlan {
  const q = String(query || "").trim();
  return {
    normalizedQuery: q,
    standaloneQuery: q,
    subqueries: [],
    factualIntent: "none",
    pinnedSourceIds: [],
    requiredCitationStrength: "none",
    plannerMode: "heuristic",
    hydeRecommended: true,
    ragQueryPreparation: {
      cleanedQuery: q,
      subQueries: [],
      originalQuery: q,
      wasCleaned: false,
      source: "fallback",
    },
  };
}

/**
 * Heuristic-first planner: skips LLM prep for simple turns; uses full LLM prep when
 * the turn is compound or thread-blended. Intent classification is supplied by
 * the orchestration layer so this planner never runs a second classifier.
 */
export async function planRetrievalQuery(
  params: PlanRetrievalQueryParams
): Promise<RetrievalPlan> {
  const raw = String(params.query || "").trim();
  const language = params.language || "en";
  const pinned = (params.pinnedSourceIds || []).slice(0, 8);
  const overviewQueryVariants = params.retrievalIntent
    ?.shouldUseOverviewVariants
    ? params.retrievalIntent.queryVariants
    : [];
  const shouldUseBroadRetrieval = Boolean(
    params.retrievalIntent?.shouldUseBroadRetrieval
  );

  const shortPinnedFollowUp =
    pinned.length > 0 &&
    raw.length > 0 &&
    raw.length < 96 &&
    !looksCompound(raw);

  const needsLlm =
    !params.skipLlmRetrievalPlanner &&
    (Boolean(params.forceBlendedRetrieval) ||
      looksCompound(raw) ||
      (!shortPinnedFollowUp && !isLikelyGreetingOnly(raw) && raw.length > 240));

  let plannerMode: PlannerMode;
  let prep: RagQueryPreparation;

  if (needsLlm) {
    plannerMode = "llm";
    const seed = params.seedRagQueryPreparation;
    prep = turnSeedCoversRetrievalQuery(seed, raw)
      ? seed!
      : isSearchableTurnModelSeed(seed)
        ? { ...seed, originalQuery: raw }
        : await prepareQueryForRagWithLlm(raw, {
            language,
            workspaceId: params.workspaceId,
            conversationId: params.conversationId,
          });
  } else if (isLikelyGreetingOnly(raw)) {
    plannerMode = "heuristic";
    prep = {
      cleanedQuery: "",
      subQueries: [],
      originalQuery: raw,
      wasCleaned: true,
      source: "llm",
    };
  } else if (
    turnSeedCoversRetrievalQuery(params.seedRagQueryPreparation, raw)
  ) {
    plannerMode =
      params.seedRagQueryPreparation!.source === "llm" ? "llm" : "heuristic";
    prep = params.seedRagQueryPreparation!;
  } else {
    plannerMode = "heuristic";
    const normalized = normalizeRagQueryWhitespace(raw);
    prep = {
      cleanedQuery: normalized,
      subQueries: [],
      originalQuery: raw,
      wasCleaned: false,
      source: "fallback",
    };
  }

  const standalone =
    prep.cleanedQuery.trim().length >= 4 ? prep.cleanedQuery.trim() : raw;
  const subqueries =
    prep.subQueries.length > 0 ? prep.subQueries : overviewQueryVariants;

  const factualIntent = inferFactualIntent(raw);
  const requiredCitationStrength = citationStrengthForIntent(
    factualIntent,
    shouldUseBroadRetrieval
  );

  const subqueriesForHyde =
    prep.subQueries.length > 0 ? prep.subQueries : overviewQueryVariants;

  const hydeRecommended =
    !isLikelyGreetingOnly(raw) &&
    !shortPinnedFollowUp &&
    !Boolean(params.forceBlendedRetrieval) &&
    subqueriesForHyde.length <= 1 &&
    !(looksCompound(raw) && needsLlm);

  return {
    normalizedQuery: raw,
    standaloneQuery: standalone,
    subqueries: subqueries.slice(0, 4),
    factualIntent,
    pinnedSourceIds: pinned,
    requiredCitationStrength,
    plannerMode,
    hydeRecommended,
    ragQueryPreparation: prep,
  };
}
