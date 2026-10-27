import type {
  ReplyFallbackAction,
  ReplyFallbackReason,
} from "@/lib/airi/reply/generation/reply-fallback-policy";
import type { ReplyOperatorCounterName } from "@/lib/airi/reply/runtime/reply-operator-metrics";

export type AiriReplyOperatorEventRow = {
  timestamp: string;
  counterName: ReplyOperatorCounterName;
  channel?: string | null;
  turnKind?: string | null;
  confidence?: string | null;
  resultType?: string | null;
  fallbackAction?: ReplyFallbackAction | null;
  fallbackReason?: ReplyFallbackReason | null;
};

export type AiriReplyOperatorNamedMetric = {
  name: string;
  count: number;
};

export type AiriReplyOperatorAnalytics = {
  totals: {
    safeConversationalReplies: number;
    ragTurns: number;
    groundedRecoveryUsage: number;
    genericClarificationUsage: number;
    lowConfidenceUnderstandingResults: number;
  };
  rates: {
    groundedRecoveryRate: number;
    genericClarificationRate: number;
    lowConfidenceRate: number;
    safeReplyShare: number;
  };
  trends: Array<{
    date: string;
    safeConversationalReplies: number;
    ragTurns: number;
    groundedRecoveryUsage: number;
    genericClarificationUsage: number;
    lowConfidenceUnderstandingResults: number;
  }>;
  breakdowns: {
    fallbackActions: AiriReplyOperatorNamedMetric[];
    fallbackReasons: AiriReplyOperatorNamedMetric[];
    resultTypes: AiriReplyOperatorNamedMetric[];
    channels: AiriReplyOperatorNamedMetric[];
    safeReplyKinds: AiriReplyOperatorNamedMetric[];
    lowConfidenceKinds: AiriReplyOperatorNamedMetric[];
  };
  sampleInfo: {
    eventCount: number;
    limited: boolean;
  };
};

type TrendBucket = AiriReplyOperatorAnalytics["trends"][number];

function createTrendBucket(date: string): TrendBucket {
  return {
    date,
    safeConversationalReplies: 0,
    ragTurns: 0,
    groundedRecoveryUsage: 0,
    genericClarificationUsage: 0,
    lowConfidenceUnderstandingResults: 0,
  };
}

function increment(map: Map<string, number>, rawKey?: string | null): void {
  const key = String(rawKey || "").trim();
  if (!key) return;
  map.set(key, (map.get(key) || 0) + 1);
}

function toNamedMetrics(
  map: Map<string, number>,
  limit: number = 10
): AiriReplyOperatorNamedMetric[] {
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort(
      (left, right) =>
        right.count - left.count || left.name.localeCompare(right.name)
    )
    .slice(0, limit);
}

function toRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

export function buildAiriReplyOperatorAnalytics(params: {
  rows: AiriReplyOperatorEventRow[];
  limited?: boolean;
}): AiriReplyOperatorAnalytics {
  const totals = {
    safeConversationalReplies: 0,
    ragTurns: 0,
    groundedRecoveryUsage: 0,
    genericClarificationUsage: 0,
    lowConfidenceUnderstandingResults: 0,
  };
  const trends = new Map<string, TrendBucket>();
  const fallbackActions = new Map<string, number>();
  const fallbackReasons = new Map<string, number>();
  const resultTypes = new Map<string, number>();
  const channels = new Map<string, number>();
  const safeReplyKinds = new Map<string, number>();
  const lowConfidenceKinds = new Map<string, number>();

  for (const row of params.rows) {
    const date = new Date(row.timestamp).toISOString().split("T")[0];
    const trendBucket = trends.get(date) || createTrendBucket(date);
    trends.set(date, trendBucket);

    increment(channels, row.channel);

    if (row.counterName === "safe_conversational_replies") {
      totals.safeConversationalReplies += 1;
      trendBucket.safeConversationalReplies += 1;
      increment(safeReplyKinds, row.turnKind);
      continue;
    }

    if (row.counterName === "rag_turns") {
      totals.ragTurns += 1;
      trendBucket.ragTurns += 1;
      increment(fallbackActions, row.fallbackAction);
      increment(fallbackReasons, row.fallbackReason);
      increment(resultTypes, row.resultType);
      continue;
    }

    if (row.counterName === "grounded_recovery_usage") {
      totals.groundedRecoveryUsage += 1;
      trendBucket.groundedRecoveryUsage += 1;
      continue;
    }

    if (row.counterName === "generic_clarification_usage") {
      totals.genericClarificationUsage += 1;
      trendBucket.genericClarificationUsage += 1;
      continue;
    }

    if (row.counterName === "low_confidence_understanding_results") {
      totals.lowConfidenceUnderstandingResults += 1;
      trendBucket.lowConfidenceUnderstandingResults += 1;
      increment(lowConfidenceKinds, row.turnKind);
    }
  }

  const understandingEvents =
    totals.safeConversationalReplies + totals.lowConfidenceUnderstandingResults;

  return {
    totals,
    rates: {
      groundedRecoveryRate: toRate(
        totals.groundedRecoveryUsage,
        totals.ragTurns
      ),
      genericClarificationRate: toRate(
        totals.genericClarificationUsage,
        totals.ragTurns
      ),
      lowConfidenceRate: toRate(
        totals.lowConfidenceUnderstandingResults,
        understandingEvents
      ),
      safeReplyShare: toRate(
        totals.safeConversationalReplies,
        understandingEvents + totals.ragTurns
      ),
    },
    trends: Array.from(trends.values()).sort((left, right) =>
      left.date.localeCompare(right.date)
    ),
    breakdowns: {
      fallbackActions: toNamedMetrics(fallbackActions),
      fallbackReasons: toNamedMetrics(fallbackReasons),
      resultTypes: toNamedMetrics(resultTypes),
      channels: toNamedMetrics(channels),
      safeReplyKinds: toNamedMetrics(safeReplyKinds),
      lowConfidenceKinds: toNamedMetrics(lowConfidenceKinds),
    },
    sampleInfo: {
      eventCount: params.rows.length,
      limited: Boolean(params.limited),
    },
  };
}
