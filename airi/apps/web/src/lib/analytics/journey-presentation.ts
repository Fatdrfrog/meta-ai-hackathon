import { isNonNegativeSafeInteger as validCount } from "@icecore/shared/lib/value-utils";
import type {
  AcquisitionCohortRow,
  AcquisitionReport,
} from "./acquisition-contract";

type Report = AcquisitionReport | null | undefined;
type OutcomeCounts = Pick<
  AcquisitionCohortRow,
  "entries" | "engaged" | "qualified" | "booked" | "paid" | "pendingObservation"
>;
const countKeys = [
  "entries",
  "engaged",
  "qualified",
  "booked",
  "paid",
  "pendingObservation",
] as const;

function coverageIsComplete(report: Report): boolean {
  return report?.coverage.status === "ready" && !report.coverage.truncated;
}

/** Snapshot recovery does not establish stage transitions before activation. */
export function qualificationHistoryCoversWindow(report: Report): boolean {
  const history = report?.coverage.qualificationHistory;
  if (!report || !history) return false;
  const firstObserved = history.firstObservedAt
    ? Date.parse(history.firstObservedAt)
    : NaN;
  const start = Date.parse(report.window.start);
  return (
    history.state === "streaming" &&
    history.history === "since_activation" &&
    history.snapshotRecovery === "complete" &&
    !history.historyGapAt &&
    Number.isFinite(firstObserved) &&
    Number.isFinite(start) &&
    firstObserved <= start
  );
}

/** A partial source can establish observations, but cannot establish an absence. */
export function observedCount(
  count: number | null | undefined,
  complete: boolean
): number | null {
  if (count == null || !validCount(count)) return null;
  return count > 0 || complete ? count : null;
}

/** Positive values remain observed counts; missing history cannot prove a zero. */
export function observedAcquisitionCount(
  report: Report,
  count: number | null | undefined,
  qualification = false
): number | null {
  if (!report) return null;
  const complete =
    coverageIsComplete(report) &&
    (!qualification || qualificationHistoryCoversWindow(report));
  return observedCount(count, complete);
}

/** Qualified payment is its own intersection, not all payments in a cohort. */
export function getAcquisitionQualifiedToPaidRate(
  report: Report,
  row: Pick<
    AcquisitionCohortRow,
    "qualified" | "qualifiedPaid" | "pendingObservation"
  >
): number | null {
  if (
    !coverageIsComplete(report) ||
    !qualificationHistoryCoversWindow(report) ||
    !validCount(row.qualified) ||
    !validCount(row.qualifiedPaid) ||
    row.pendingObservation !== 0 ||
    row.qualified === 0 ||
    row.qualifiedPaid > row.qualified
  )
    return null;
  return row.qualifiedPaid / row.qualified;
}

function sumCounts(
  report: Report,
  key: keyof AcquisitionCohortRow
): number | null {
  if (!report) return null;
  let total = 0;
  for (const row of report.cohorts) {
    const value = row[key];
    if (typeof value !== "number" || !validCount(value)) return null;
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

/** Each cohort contributes once. Outcomes are independent entry-episode counts. */
export function getAcquisitionSummary(report: Report) {
  const coverageComplete = coverageIsComplete(report);
  const qualificationComplete = qualificationHistoryCoversWindow(report);
  const totals = Object.fromEntries(
    countKeys.map(key => [
      key,
      observedAcquisitionCount(
        report,
        sumCounts(report, key),
        key === "qualified"
      ),
    ])
  ) as Record<keyof OutcomeCounts, number | null>;
  const qualified = sumCounts(report, "qualified");
  const qualifiedPaid = sumCounts(report, "qualifiedPaid");
  const pendingObservation = sumCounts(report, "pendingObservation");
  const validIntersections = report?.cohorts.every(
    row =>
      validCount(row.qualified) &&
      validCount(row.qualifiedPaid) &&
      row.qualifiedPaid <= row.qualified
  );
  return {
    ...totals,
    coverageComplete,
    qualificationComplete,
    qualificationIncomplete: !qualificationComplete,
    partial: !coverageComplete || !qualificationComplete,
    qualifiedToPaidRate:
      validIntersections &&
      qualified !== null &&
      qualifiedPaid !== null &&
      pendingObservation !== null
        ? getAcquisitionQualifiedToPaidRate(report, {
            qualified,
            qualifiedPaid,
            pendingObservation,
          })
        : null,
  };
}

/** Preserve unknown values and currencies; no currency conversion is implied. */
export function getAcquisitionRevenueByCurrency(report: Report) {
  const partial = !coverageIsComplete(report);
  const currencies = new Map<
    string,
    {
      currency: string;
      netRevenue: number | null;
      unknownValues: number;
      partial: boolean;
    }
  >();
  for (const cohort of report?.cohorts || []) {
    for (const row of cohort.currencies) {
      const total = currencies.get(row.currency) || {
        currency: row.currency,
        netRevenue: 0,
        unknownValues: 0,
        partial,
      };
      total.unknownValues += row.unknownValues;
      total.netRevenue =
        total.netRevenue !== null &&
        row.netRevenue !== null &&
        Number.isFinite(row.netRevenue) &&
        row.unknownValues === 0 &&
        Number.isFinite(total.netRevenue + row.netRevenue)
          ? total.netRevenue + row.netRevenue
          : null;
      currencies.set(row.currency, total);
    }
  }
  return [...currencies.values()].map(row => ({
    ...row,
    netRevenue: partial && row.netRevenue === 0 ? null : row.netRevenue,
  }));
}
