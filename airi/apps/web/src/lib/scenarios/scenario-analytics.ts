import type { ScenarioTriggerLogFilterSummary } from "@/lib/scenarios/trigger-log-meta";
import { medianFromSortedValues } from "@/lib/statistics";
import { readTrimmedString } from "@icecore/shared/lib/value-utils";

type ScenarioFunnelStep = {
  key: string;
  label: string;
  count: number;
  conversionRate: number;
  baseline: "first_step" | "previous_step";
};

export type ScenarioFunnelTrendPoint = {
  date: string;
  label: string;
  evaluatedCount: number;
  triggerMatchedCount: number;
  winnerCount: number;
  overallConversion: number;
  relativeConversion: number;
};

type ScenarioRecommendationCard = {
  id: string;
  kind:
    | "high_trigger_mismatch"
    | "no_matching_action"
    | "reentry_blocked"
    | "flow_read_no_submit"
    | "low_sample";
  severity: "high" | "medium" | "info";
  scenarioId: string;
  scenarioName: string;
  title: string;
  evidence: string;
  suggestedChange: string;
  sampleSize: number;
  metricLabel: string;
  metricValue: number;
  filters?: ScenarioTriggerLogFilterSummary | null;
};

export type ScenarioAnalyticsScenarioMetrics = {
  scenarioId: string;
  scenarioName: string;
  evaluatedCount: number;
  triggerMatchedCount: number;
  winnerCount: number;
  triggerMismatchCount: number;
  noMatchingActionCount: number;
  blockedCount: number;
  blockedReasons: string[];
  filters?: ScenarioTriggerLogFilterSummary | null;
};

export type ScenarioAnalyticsFlowMetrics = {
  scenarioId: string;
  scenarioName: string;
  readCount: number;
  submittedCount: number;
};

export function buildScenarioAnalyticsMatchCounts() {
  const winner = { $eq: ["$matched", true] };
  const noMatchingAction = {
    $eq: ["$mismatchReason", "flow_no_matching_action"],
  };

  return {
    triggerMatchedCount: {
      $sum: {
        $cond: [
          {
            $or: [
              winner,
              { $eq: ["$result", "matched_but_shadowed"] },
              noMatchingAction,
            ],
          },
          1,
          0,
        ],
      },
    },
    // Log matched=true records the arbitration winner. Daily rollup matchedCount
    // also includes shadowed candidates, so it cannot supply this count.
    winnerCount: { $sum: { $cond: [winner, 1, 0] } },
    noMatchingActionCount: { $sum: { $cond: [noMatchingAction, 1, 0] } },
  };
}

export function formatScenarioAnalyticsReason(
  reason: string | null | undefined
) {
  const normalized = readTrimmedString(reason);
  if (!normalized) return "Unknown reason";

  switch (normalized) {
    case "trigger_mismatch":
      return "Trigger mismatch";
    case "flow_no_matching_action":
      return "Trigger matched but no action fit";
    case "already_started_in_conversation":
      return "Already started in conversation";
    case "blocked_by_once_per_conversation":
      return "Blocked by once-per-conversation";
    case "fallback_suppressed_recent_specific_session":
      return "Fallback suppressed by a recent specific session";
    default:
      return "Other scenario outcome";
  }
}

export function computeScenarioAnalyticsRate(
  numerator: number,
  denominator: number
) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return 0;
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

export function buildScenarioFunnelSteps(
  steps: Array<{ key: string; label: string; count: number }>
) {
  if (steps.length === 0) {
    return {
      overallConversion: [] as ScenarioFunnelStep[],
      relativeConversion: [] as ScenarioFunnelStep[],
    };
  }

  const firstStepCount = steps[0]?.count ?? 0;

  return {
    overallConversion: steps.map(step => ({
      key: step.key,
      label: step.label,
      count: step.count,
      conversionRate: computeScenarioAnalyticsRate(step.count, firstStepCount),
      baseline: "first_step",
    })),
    relativeConversion: steps.map((step, index) => ({
      key: step.key,
      label: step.label,
      count: step.count,
      conversionRate:
        index === 0
          ? 1
          : computeScenarioAnalyticsRate(
              step.count,
              steps[index - 1]?.count ?? 0
            ),
      baseline: "previous_step",
    })),
  };
}

export function computeMedian(values: number[]) {
  const normalized = values
    .filter(value => Number.isFinite(value))
    .sort((left, right) => left - right);

  return medianFromSortedValues(normalized) ?? 0;
}

export function buildScenarioRecommendationCards(params: {
  scenarioMetrics: ScenarioAnalyticsScenarioMetrics[];
  flowMetricsByScenarioId: Map<string, ScenarioAnalyticsFlowMetrics>;
}) {
  const recommendations: ScenarioRecommendationCard[] = [];

  for (const scenario of params.scenarioMetrics) {
    if (scenario.evaluatedCount < 20) {
      recommendations.push({
        id: `${scenario.scenarioId}:low_sample`,
        kind: "low_sample",
        severity: "info",
        scenarioId: scenario.scenarioId,
        scenarioName: scenario.scenarioName,
        title: "Low sample",
        evidence: `Only ${scenario.evaluatedCount} trigger evaluations landed in this window, so the pattern is still directional.`,
        suggestedChange:
          "Treat this as an observation-only signal for now and gather more traffic before making larger trigger changes.",
        sampleSize: scenario.evaluatedCount,
        metricLabel: "Evaluations",
        metricValue: scenario.evaluatedCount,
        filters: scenario.filters ?? null,
      });
      continue;
    }

    const mismatchRate = computeScenarioAnalyticsRate(
      scenario.triggerMismatchCount,
      scenario.evaluatedCount
    );
    if (mismatchRate >= 0.6) {
      recommendations.push({
        id: `${scenario.scenarioId}:high_trigger_mismatch`,
        kind: "high_trigger_mismatch",
        severity: "high",
        scenarioId: scenario.scenarioId,
        scenarioName: scenario.scenarioName,
        title: "High trigger mismatch",
        evidence: `${Math.round(mismatchRate * 100)}% of ${scenario.evaluatedCount} evaluations stop at the trigger layer before this scenario can win.`,
        suggestedChange:
          "Broaden or simplify the trigger by reviewing keyword, classification, channel, and new-customer filters against real customer language.",
        sampleSize: scenario.evaluatedCount,
        metricLabel: "Mismatch rate",
        metricValue: mismatchRate,
        filters: scenario.filters ?? null,
      });
    }

    if (scenario.noMatchingActionCount > 0) {
      recommendations.push({
        id: `${scenario.scenarioId}:no_matching_action`,
        kind: "no_matching_action",
        severity: "high",
        scenarioId: scenario.scenarioId,
        scenarioName: scenario.scenarioName,
        title: "No matching action",
        evidence: `${scenario.noMatchingActionCount} matched triggers reached this scenario but could not find a valid action path.`,
        suggestedChange:
          "Add or repair action branches so every successful trigger has a valid next step and destination node.",
        sampleSize: scenario.evaluatedCount,
        metricLabel: "No-action hits",
        metricValue: scenario.noMatchingActionCount,
        filters: scenario.filters ?? null,
      });
    }

    const blockRate = computeScenarioAnalyticsRate(
      scenario.blockedCount,
      scenario.evaluatedCount
    );
    if (blockRate >= 0.15) {
      recommendations.push({
        id: `${scenario.scenarioId}:reentry_blocked`,
        kind: "reentry_blocked",
        severity: "medium",
        scenarioId: scenario.scenarioId,
        scenarioName: scenario.scenarioName,
        title: "Re-entry blocked too often",
        evidence: `${Math.round(blockRate * 100)}% of ${scenario.evaluatedCount} evaluations are blocked by re-entry or conversation-state rules.`,
        suggestedChange:
          "Review the scenario entry policy so it can re-engage when customers return with a valid intent.",
        sampleSize: scenario.evaluatedCount,
        metricLabel: "Block rate",
        metricValue: blockRate,
        filters: scenario.filters ?? null,
      });
    }

    const flowMetrics = params.flowMetricsByScenarioId.get(scenario.scenarioId);
    const submitRateFromRead = flowMetrics
      ? computeScenarioAnalyticsRate(
          flowMetrics.submittedCount,
          flowMetrics.readCount
        )
      : 0;
    if (
      flowMetrics &&
      flowMetrics.readCount >= 20 &&
      submitRateFromRead < 0.4
    ) {
      recommendations.push({
        id: `${scenario.scenarioId}:flow_read_no_submit`,
        kind: "flow_read_no_submit",
        severity: "medium",
        scenarioId: scenario.scenarioId,
        scenarioName: scenario.scenarioName,
        title: "Flow read but not submitted",
        evidence: `${flowMetrics.readCount} people opened the flow, but only ${Math.round(
          submitRateFromRead * 100
        )}% completed it.`,
        suggestedChange:
          "Shorten the flow, simplify the first question, and tighten the CTA so the customer knows exactly what to do next.",
        sampleSize: flowMetrics.readCount,
        metricLabel: "Read-to-submit rate",
        metricValue: submitRateFromRead,
        filters: scenario.filters ?? null,
      });
    }
  }

  return recommendations.sort((left, right) => {
    const severityRank = {
      high: 0,
      medium: 1,
      info: 2,
    } as const;

    if (severityRank[left.severity] !== severityRank[right.severity]) {
      return severityRank[left.severity] - severityRank[right.severity];
    }

    if (right.metricValue !== left.metricValue) {
      return right.metricValue - left.metricValue;
    }

    return left.title.localeCompare(right.title);
  });
}
