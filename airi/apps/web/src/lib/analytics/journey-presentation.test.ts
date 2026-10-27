import type {
  AcquisitionCohortRow,
  AcquisitionReport,
} from "./acquisition-contract";
import {
  getAcquisitionQualifiedToPaidRate,
  getAcquisitionRevenueByCurrency,
  getAcquisitionSummary,
  observedCount,
  observedAcquisitionCount,
  qualificationHistoryCoversWindow,
} from "./journey-presentation";

test("partial counters preserve observations without asserting an absence", () => {
  expect(observedCount(0, false)).toBeNull();
  expect(observedCount(0, true)).toBe(0);
  expect(observedCount(8, false)).toBe(8);
  expect(observedCount(1_000_000_000, true)).toBe(1_000_000_000);
  expect(observedCount(undefined, true)).toBeNull();
  expect(observedCount(-1, true)).toBeNull();
  expect(observedCount(Infinity, true)).toBeNull();
});

const cohort = (
  fields: Partial<AcquisitionCohortRow> = {}
): AcquisitionCohortRow => ({
  kind: "organic",
  sourceId: "source",
  adId: null,
  entries: 10,
  engaged: 7,
  qualified: 4,
  qualifiedPaid: 2,
  booked: 3,
  paid: 3,
  pendingObservation: 0,
  currencies: [],
  ...fields,
});
const report = (cohorts = [cohort()]): AcquisitionReport => ({
  window: {
    start: "2026-09-01T00:00:00Z",
    end: "2026-09-08T00:00:00Z",
    observationDays: 7,
    asOf: "2026-10-01T00:00:00Z",
  },
  policy: { qualifiedStageKeys: ["qualified"], revision: 1 },
  coverage: {
    status: "ready",
    projectedThrough: "2026-10-01T00:00:00Z",
    conversionThrough: "2026-10-01T00:00:00Z",
    reconciliationThrough: "2026-10-01T00:00:00Z",
    identityMissing: 0,
    truncated: false,
    qualification: "recorded_events",
    qualificationHistory: {
      state: "streaming",
      history: "since_activation",
      firstObservedAt: "2026-08-01T00:00:00Z",
      historyGapAt: null,
      snapshotRecovery: "complete",
      snapshotScanned: 0,
      resumePersistedAt: "2026-10-01T00:00:00Z",
    },
  },
  cohorts,
  flows: [],
  retention: [],
  retentionMissingIdentity: 0,
});

function acquisitionCounts(summary: ReturnType<typeof getAcquisitionSummary>) {
  const { entries, engaged, qualified, booked, paid, pendingObservation } =
    summary;
  return { entries, engaged, qualified, booked, paid, pendingObservation };
}

describe("acquisition presentation truth", () => {
  it("uses the same availability rules for detailed rows and summary values", () => {
    const data = report();
    data.coverage.qualificationHistory.history = "unknown";
    expect(observedAcquisitionCount(data, 0)).toBe(0);
    expect(observedAcquisitionCount(data, 0, true)).toBeNull();
    expect(observedAcquisitionCount(data, 2, true)).toBe(2);
    data.coverage.status = "backfilling";
    expect(observedAcquisitionCount(data, 0)).toBeNull();
    expect(observedAcquisitionCount(data, 2)).toBe(2);
    expect(observedAcquisitionCount(data, null)).toBeNull();
  });

  it("requires a safe integer total and accepts history activated at window start", () => {
    const data = report([
      cohort({ entries: Number.MAX_SAFE_INTEGER }),
      cohort({ entries: 1 }),
    ]);
    data.coverage.qualificationHistory.firstObservedAt = data.window.start;
    expect(qualificationHistoryCoversWindow(data)).toBe(true);
    expect(getAcquisitionSummary(data).entries).toBeNull();
  });

  it("sums independent entry-episode outcomes once, regardless of currency rows", () => {
    const result = getAcquisitionSummary(
      report([
        cohort(),
        cohort({
          kind: "ad",
          entries: 2,
          engaged: 0,
          qualified: 2,
          qualifiedPaid: 1,
          booked: 0,
          paid: 1,
        }),
      ])
    );
    expect(result).toMatchObject({
      entries: 12,
      engaged: 7,
      qualified: 6,
      booked: 3,
      paid: 4,
      pendingObservation: 0,
    });
    expect(result.qualifiedToPaidRate).toBe(0.5);
    expect(result.partial).toBe(false);
  });

  it("weights the qualified conversion rate by its actual denominator", () => {
    const result = getAcquisitionSummary(
      report([
        cohort({ qualified: 1, qualifiedPaid: 1 }),
        cohort({ entries: 100, qualified: 9, qualifiedPaid: 1 }),
      ])
    );
    expect(result.qualifiedToPaidRate).toBe(0.2);
  });

  it.each(["backfilling", "stale", "unavailable"] as const)(
    "preserves positive observations and suppresses unknown zeros when %s",
    status => {
      const data = report([
        cohort({ engaged: 0, booked: 0, pendingObservation: 0 }),
      ]);
      data.coverage.status = status;
      expect(getAcquisitionSummary(data)).toMatchObject({
        partial: true,
        coverageComplete: false,
        entries: 10,
        engaged: null,
        qualified: 4,
        booked: null,
        paid: 3,
        pendingObservation: null,
        qualifiedToPaidRate: null,
      });
    }
  );

  it("does not treat an empty truncated report as a measured zero", () => {
    const data = report([]);
    data.coverage.truncated = true;
    expect(
      Object.values(acquisitionCounts(getAcquisitionSummary(data)))
    ).toEqual([null, null, null, null, null, null]);
    expect(getAcquisitionSummary(data).partial).toBe(true);
  });

  it("allows verified empty zeros without inventing a zero denominator rate", () => {
    expect(
      Object.values(acquisitionCounts(getAcquisitionSummary(report([]))))
    ).toEqual([0, 0, 0, 0, 0, 0]);
    expect(getAcquisitionSummary(report([])).qualifiedToPaidRate).toBeNull();
  });

  it("withholds qualification zeros when history starts after the requested window", () => {
    const data = report([cohort({ qualified: 0, qualifiedPaid: 0 })]);
    data.coverage.qualificationHistory.firstObservedAt = "2026-09-02T00:00:00Z";
    expect(getAcquisitionSummary(data)).toMatchObject({
      partial: true,
      qualificationComplete: false,
      entries: 10,
      qualified: null,
      paid: 3,
      qualifiedToPaidRate: null,
    });
    data.cohorts[0].qualified = 2;
    expect(acquisitionCounts(getAcquisitionSummary(data)).qualified).toBe(2);
  });

  it.each(["not_started", "degraded", "history_gap"] as const)(
    "does not infer complete qualification history from %s state",
    state => {
      const data = report();
      data.coverage.qualificationHistory.state = state;
      expect(qualificationHistoryCoversWindow(data)).toBe(false);
      expect(
        getAcquisitionQualifiedToPaidRate(data, data.cohorts[0])
      ).toBeNull();
    }
  );

  it("rejects history gaps, incomplete recovery and malformed activation dates", () => {
    const data = report();
    data.coverage.qualificationHistory.historyGapAt = "2026-09-02T00:00:00Z";
    expect(qualificationHistoryCoversWindow(data)).toBe(false);
    data.coverage.qualificationHistory.historyGapAt = null;
    data.coverage.qualificationHistory.snapshotRecovery = "running";
    expect(qualificationHistoryCoversWindow(data)).toBe(false);
    data.coverage.qualificationHistory.snapshotRecovery = "complete";
    data.coverage.qualificationHistory.firstObservedAt = "invalid";
    expect(qualificationHistoryCoversWindow(data)).toBe(false);
  });

  it("withholds a rate while any included entry is still under observation", () => {
    const data = report([cohort(), cohort({ pendingObservation: 1 })]);
    expect(getAcquisitionQualifiedToPaidRate(data, data.cohorts[0])).toBe(0.5);
    expect(getAcquisitionQualifiedToPaidRate(data, data.cohorts[1])).toBeNull();
    expect(getAcquisitionSummary(data).qualifiedToPaidRate).toBeNull();
  });

  it.each([NaN, Infinity, -1, 0.5])(
    "never formats an invalid count as a valid summary: %s",
    entries => {
      expect(
        getAcquisitionSummary(report([cohort({ entries })])).entries
      ).toBeNull();
    }
  );

  it("withholds invalid ratios instead of showing conversion above 100 percent", () => {
    const data = report([cohort({ qualifiedPaid: 5 })]);
    expect(getAcquisitionQualifiedToPaidRate(data, data.cohorts[0])).toBeNull();
    expect(getAcquisitionSummary(data).qualifiedToPaidRate).toBeNull();
  });

  it("keeps revenue currencies separate and propagates unknown amounts", () => {
    const currency = (currency: string, netRevenue: number | null) => ({
      currency,
      sales: 1,
      refunds: 0,
      grossRevenue: netRevenue,
      refundedRevenue: 0,
      netRevenue,
      unknownValues: netRevenue === null ? 1 : 0,
    });
    const data = report([
      cohort({ currencies: [currency("USD", 100), currency("KZT", 200)] }),
      cohort({ currencies: [currency("USD", null), currency("KZT", -50)] }),
    ]);
    expect(getAcquisitionRevenueByCurrency(data)).toEqual([
      { currency: "USD", netRevenue: null, unknownValues: 1, partial: false },
      { currency: "KZT", netRevenue: 150, unknownValues: 0, partial: false },
    ]);
    expect(getAcquisitionRevenueByCurrency(report())).toEqual([]);
  });

  it("preserves unknown currency and suppresses incomplete revenue zeros", () => {
    const data = report([
      cohort({
        currencies: [
          {
            currency: "",
            sales: 1,
            refunds: 0,
            grossRevenue: 0,
            refundedRevenue: 0,
            netRevenue: 0,
            unknownValues: 0,
          },
        ],
      }),
    ]);
    data.coverage.status = "backfilling";
    expect(getAcquisitionRevenueByCurrency(data)).toEqual([
      { currency: "", netRevenue: null, unknownValues: 0, partial: true },
    ]);
  });

  it("returns unavailable values before a report is loaded", () => {
    expect(
      Object.values(acquisitionCounts(getAcquisitionSummary(undefined)))
    ).toEqual([null, null, null, null, null, null]);
    expect(getAcquisitionQualifiedToPaidRate(undefined, cohort())).toBeNull();
    expect(getAcquisitionRevenueByCurrency(undefined)).toEqual([]);
  });
});
