import { medianFromSortedValues } from "@/lib/statistics";
import { CRM_ATTENTION_WINDOW_MS } from "@/lib/crm/attention";

type Timestamp = Date | string | null;

export type ServiceConversationEvidence = {
  status?: string | null;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  first_inbound_at?: Timestamp;
  service_episode_started_at?: Timestamp;
  service_resolved_at?: Timestamp;
  service_resolution_kind?: string | null;
  csat_timeout_closed?: boolean | null;
};

export type FirstHumanResponseEvidence = {
  first_inbound_at?: Timestamp;
  first_response_seconds?: number | null;
};

export type ServiceTruthReport = {
  asOf: string;
  sourceCoverage?: DashboardSourceCoverage;
  firstHumanResponse: {
    eligibleConversations: number | null;
    answeredConversations: number;
    unansweredConversations: number | null;
    coverageRate: number | null;
    oldestUnansweredSeconds: number | null;
    medianSeconds: number | null;
    p90Seconds: number | null;
  };
  resolution: {
    measuredResolvedConversations: number;
    unknownClosedConversations: number;
    timeoutClosedConversations: number;
    averageSeconds: number | null;
    medianSeconds: number | null;
    p90Seconds: number | null;
  };
  agedOpenPolicy: { windowDays: 3; count: number };
};

export type DashboardSourceCoverage = {
  status: "complete" | "partial";
  rowLimit: number;
  conversationRowsLoaded: number;
  firstResponseRowsLoaded: number;
  conversationRowsTruncated: boolean;
  firstResponseRowsTruncated: boolean;
};

function timestamp(value: Timestamp | undefined): number | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function measuredResolutionSeconds(
  row: ServiceConversationEvidence
): number | null {
  if (
    row.status !== "closed" ||
    row.csat_timeout_closed ||
    !["manager", "customer_csat"].includes(row.service_resolution_kind ?? "")
  )
    return null;
  const start =
    timestamp(row.service_episode_started_at) ??
    timestamp(row.first_inbound_at);
  const resolved = timestamp(row.service_resolved_at);
  return start !== null && resolved !== null && resolved >= start
    ? (resolved - start) / 1000
    : null;
}

/** Public webhook contract: measured service time in whole seconds, absent when unmeasured. */
export function measuredResolutionWholeSeconds(
  row: ServiceConversationEvidence
): number | undefined {
  const seconds = measuredResolutionSeconds(row);
  return seconds === null ? undefined : Math.round(seconds);
}

function summary(values: number[]) {
  const ordered = values
    .filter(value => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  return {
    averageSeconds: ordered.length
      ? ordered.reduce((sum, value) => sum + value, 0) / ordered.length
      : null,
    medianSeconds: medianFromSortedValues(ordered),
    p90Seconds: ordered.length
      ? ordered[Math.max(0, Math.ceil(ordered.length * 0.9) - 1)]
      : null,
  };
}

/** Current evidence is measured as of now; unanswered cohorts remain observable. */
export function buildServiceTruthReport({
  now,
  conversationRows,
  firstResponseRows,
  firstResponderFiltered = false,
}: {
  now: Date;
  conversationRows: ServiceConversationEvidence[];
  firstResponseRows: FirstHumanResponseEvidence[];
  firstResponderFiltered?: boolean;
}): ServiceTruthReport {
  const answered = firstResponseRows.filter(
    row =>
      typeof row.first_response_seconds === "number" &&
      Number.isFinite(row.first_response_seconds) &&
      row.first_response_seconds >= 0
  );
  const answeredSet = new Set(answered);
  const unanswered = firstResponseRows.filter(row => !answeredSet.has(row));
  const ages = unanswered
    .map(row => timestamp(row.first_inbound_at))
    .filter(
      (value): value is number => value !== null && value <= now.getTime()
    )
    .map(value => (now.getTime() - value) / 1000);
  const responseSummary = summary(
    answered.map(row => row.first_response_seconds as number)
  );
  const resolutions = conversationRows
    .map(measuredResolutionSeconds)
    .filter((value): value is number => value !== null);
  const closed = conversationRows.filter(row => row.status === "closed");
  const timeoutCount = closed.filter(
    row => row.csat_timeout_closed || row.service_resolution_kind === "timeout"
  ).length;
  return {
    asOf: now.toISOString(),
    firstHumanResponse: {
      eligibleConversations: firstResponderFiltered
        ? null
        : firstResponseRows.length,
      answeredConversations: answered.length,
      unansweredConversations: firstResponderFiltered
        ? null
        : unanswered.length,
      coverageRate:
        firstResponderFiltered || !firstResponseRows.length
          ? null
          : (answered.length * 100) / firstResponseRows.length,
      oldestUnansweredSeconds:
        firstResponderFiltered || !ages.length
          ? null
          : ages.reduce((oldest, age) => Math.max(oldest, age), 0),
      medianSeconds: responseSummary.medianSeconds,
      p90Seconds: responseSummary.p90Seconds,
    },
    resolution: {
      measuredResolvedConversations: resolutions.length,
      unknownClosedConversations:
        closed.length - resolutions.length - timeoutCount,
      timeoutClosedConversations: timeoutCount,
      ...summary(resolutions),
    },
    agedOpenPolicy: {
      windowDays: 3,
      count: conversationRows.filter(
        row =>
          row.status !== "closed" &&
          timestamp(row.createdAt) !== null &&
          now.getTime() - (timestamp(row.createdAt) as number) >=
            CRM_ATTENTION_WINDOW_MS
      ).length,
    },
  };
}
