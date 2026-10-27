import {
  normalizeComparableText,
  shouldPreferStandaloneAskStructural,
  stripAiriPrefix,
} from "@/lib/airi/reply/thread/reply-text-utils";
import type {
  TurnFollowUpMode,
  TurnUnderstanding,
} from "@/lib/airi/reply/turn/understand-customer-turn";

type GoalQueryPlanParams = {
  mode: "adaptive" | "last_message_only";
  latestMessage: string;
  currentGoal: string;
  unresolvedNeeds: string[];
  latestSubstantiveCustomerMessage: string;
  recentEntityReference?: string;
  lastGroundingAnchor?: string | null;
  turnUnderstanding?: Pick<
    TurnUnderstanding,
    | "asks"
    | "coverageHints"
    | "followUpMode"
    | "followUpAnchor"
    | "queryVariants"
    | "threadScaffold"
  > | null;
};

export type GoalQueryPlan = {
  activeGoals: string[];
  openAsks: string[];
  coverageHints: string[];
  followUpMode: TurnFollowUpMode;
  followUpAnchor?: string;
  queryVariants: string[];
  retrievalQuery: string;
  intentAnchor: string;
};

function dedupeComparable(values: string[], limit: number = 6): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const rawValue of values) {
    const value = stripAiriPrefix(String(rawValue || ""))
      .replace(/\s+/g, " ")
      .trim();
    const normalized = normalizeComparableText(value);
    if (!value || !normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value);
    if (result.length >= limit) break;
  }

  return result;
}

function joinDistinctIntentParts(parts: string[]): string {
  return dedupeComparable(parts, 6).join(". ").slice(0, 400);
}

function resolvePrimaryQuery(params: {
  mode: GoalQueryPlanParams["mode"];
  latestMessage: string;
  currentGoal: string;
  openAsks: string[];
  followUpAnchor?: string;
  queryVariants: string[];
  latestSubstantiveCustomerMessage: string;
  recentEntityReference?: string;
  lastGroundingAnchor?: string | null;
  turnUnderstanding?: GoalQueryPlanParams["turnUnderstanding"];
}): string {
  const preferStandaloneAsk =
    Boolean(params.openAsks[0]) &&
    Boolean(params.followUpAnchor) &&
    (shouldPreferStandaloneAskStructural(
      params.openAsks[0] || "",
      params.followUpAnchor || ""
    ) ||
      Boolean(
        params.turnUnderstanding?.threadScaffold
          ?.preferStandaloneAskOverFollowUpAnchor
      ));

  if (params.mode === "last_message_only") {
    return (
      (preferStandaloneAsk ? params.openAsks[0] : "") ||
      params.queryVariants[0] ||
      params.latestMessage ||
      params.followUpAnchor ||
      params.currentGoal
    );
  }

  if (preferStandaloneAsk && params.openAsks[0]) {
    return params.openAsks[0];
  }

  if (params.queryVariants[0]) {
    return params.queryVariants[0];
  }

  if (params.openAsks.length >= 2) {
    return joinDistinctIntentParts(params.openAsks);
  }

  return (
    params.followUpAnchor ||
    params.openAsks[0] ||
    params.latestSubstantiveCustomerMessage ||
    params.recentEntityReference ||
    params.lastGroundingAnchor ||
    params.currentGoal ||
    params.latestMessage
  );
}

export function planGoalQuery(params: GoalQueryPlanParams): GoalQueryPlan {
  const latestMessage = stripAiriPrefix(params.latestMessage).trim();
  const currentGoal = stripAiriPrefix(params.currentGoal).trim();
  const latestSubstantiveCustomerMessage = stripAiriPrefix(
    params.latestSubstantiveCustomerMessage
  ).trim();
  const recentEntityReference = stripAiriPrefix(
    params.recentEntityReference || ""
  ).trim();
  const lastGroundingAnchor = stripAiriPrefix(
    params.lastGroundingAnchor || ""
  ).trim();
  const followUpMode = params.turnUnderstanding?.followUpMode || "none";
  const followUpAnchor = stripAiriPrefix(
    params.turnUnderstanding?.followUpAnchor || ""
  ).trim();
  const queryVariants = dedupeComparable(
    params.turnUnderstanding?.queryVariants || [],
    4
  );

  const openAsks = dedupeComparable(params.turnUnderstanding?.asks || [], 4);
  const preferStandaloneAsk =
    Boolean(openAsks[0]) &&
    Boolean(followUpAnchor) &&
    (shouldPreferStandaloneAskStructural(
      openAsks[0] || "",
      followUpAnchor || ""
    ) ||
      Boolean(
        params.turnUnderstanding?.threadScaffold
          ?.preferStandaloneAskOverFollowUpAnchor
      ));

  const activeGoals = dedupeComparable(
    [
      ...openAsks,
      followUpAnchor,
      currentGoal,
      latestSubstantiveCustomerMessage,
      recentEntityReference,
      lastGroundingAnchor,
      ...params.unresolvedNeeds.slice(-3),
    ],
    5
  );

  const modelCoverageHints = dedupeComparable(
    params.turnUnderstanding?.coverageHints || [],
    4
  );
  const coverageHints =
    modelCoverageHints.length > 0
      ? modelCoverageHints
      : dedupeComparable(
          [...openAsks, followUpAnchor, activeGoals[0] || ""],
          4
        );

  const retrievalQuery = resolvePrimaryQuery({
    mode: params.mode,
    latestMessage,
    currentGoal,
    openAsks,
    followUpAnchor: followUpAnchor || undefined,
    queryVariants,
    latestSubstantiveCustomerMessage,
    recentEntityReference: recentEntityReference || undefined,
    lastGroundingAnchor: lastGroundingAnchor || undefined,
    turnUnderstanding: params.turnUnderstanding,
  }).slice(0, 400);

  const finalizedQueryVariants =
    queryVariants.length > 0
      ? dedupeComparable([retrievalQuery, ...queryVariants], 4)
      : dedupeComparable(
          [
            retrievalQuery,
            ...openAsks,
            followUpAnchor,
            currentGoal,
            latestSubstantiveCustomerMessage,
          ],
          4
        );

  const intentAnchor = (
    (preferStandaloneAsk ? openAsks[0] : "") ||
    (followUpMode !== "none" ? followUpAnchor : "") ||
    openAsks[0] ||
    finalizedQueryVariants[0] ||
    currentGoal ||
    lastGroundingAnchor
  )
    .slice(0, 400)
    .trim();

  return {
    activeGoals,
    openAsks,
    coverageHints,
    followUpMode,
    followUpAnchor: followUpAnchor || undefined,
    queryVariants: finalizedQueryVariants,
    retrievalQuery,
    intentAnchor,
  };
}
