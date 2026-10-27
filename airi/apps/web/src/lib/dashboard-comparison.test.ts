import {
  buildDashboardCategoryComparisons,
  buildDashboardCountComparison,
  buildDashboardDurationComparison,
  normalizeDashboardCalendarDateStart,
  normalizeDashboardCustomCalendarRange,
  resolveDashboardComparisonWindow,
  resolveDashboardCalendarDays,
} from "./dashboard-comparison";

describe("buildDashboardCountComparison", () => {
  it("classifies positive, zero-baseline, and fully-lost counts", () => {
    expect(buildDashboardCountComparison(35, 20)).toEqual({
      current: 35,
      previous: 20,
      delta: 15,
      percentChange: 75,
      kind: "increase",
    });
    expect(buildDashboardCountComparison(4, 0)).toEqual({
      current: 4,
      previous: 0,
      delta: 4,
      percentChange: null,
      kind: "new",
    });
    expect(buildDashboardCountComparison(0, 10)).toMatchObject({
      delta: -10,
      percentChange: -100,
      kind: "no_longer_active",
    });
  });
});

describe("buildDashboardCategoryComparisons", () => {
  it("orders the category union by absolute delta, current count, then raw category", () => {
    expect(
      buildDashboardCategoryComparisons(
        { Small: 1, Alpha: 8, Beta: 8, CurrentHigh: 10 },
        { Alpha: 3, Beta: 3, CurrentHigh: 5, Gone: 20 }
      )
    ).toEqual([
      {
        category: "Gone",
        current: 0,
        previous: 20,
        delta: -20,
        percentChange: -100,
        kind: "no_longer_active",
      },
      {
        category: "CurrentHigh",
        current: 10,
        previous: 5,
        delta: 5,
        percentChange: 100,
        kind: "increase",
      },
      {
        category: "Alpha",
        current: 8,
        previous: 3,
        delta: 5,
        percentChange: 166.66666666666669,
        kind: "increase",
      },
      {
        category: "Beta",
        current: 8,
        previous: 3,
        delta: 5,
        percentChange: 166.66666666666669,
        kind: "increase",
      },
      {
        category: "Small",
        current: 1,
        previous: 0,
        delta: 1,
        percentChange: null,
        kind: "new",
      },
    ]);
  });
});

describe("resolveDashboardComparisonWindow", () => {
  const timeZone = "Asia/Qyzylorda";
  const now = new Date("2026-08-05T09:30:00.000Z");

  it("compares this week through the same elapsed interval in the prior week", () => {
    expect(
      resolveDashboardComparisonWindow("this_week", timeZone, now)
    ).toEqual({
      preset: "this_week",
      strategy: "previous_week_same_elapsed",
      timeZone,
      current: {
        start: "2026-08-02T19:00:00.000Z",
        endExclusive: "2026-08-05T09:30:00.000Z",
      },
      previous: {
        start: "2026-07-26T19:00:00.000Z",
        endExclusive: "2026-07-29T09:30:00.000Z",
      },
    });
  });

  it.each([
    [7, "7d"],
    [30, "30d"],
    [90, "90d"],
  ] as const)(
    "uses adjacent equal-duration half-open intervals for %s days",
    (period, preset) => {
      const result = resolveDashboardComparisonWindow(period, "UTC", now);

      expect(result).toMatchObject({
        preset,
        strategy: "adjacent_equal_duration",
        current: { endExclusive: "2026-08-05T09:30:00.000Z" },
        previous: { endExclusive: result.current.start },
      });
      expect(
        new Date(result.current.endExclusive).getTime() -
          new Date(result.current.start).getTime()
      ).toBe(period * 24 * 60 * 60 * 1000);
      expect(
        new Date(result.previous!.endExclusive).getTime() -
          new Date(result.previous!.start).getTime()
      ).toBe(period * 24 * 60 * 60 * 1000);
    }
  );

  it("preserves normalized custom end-exclusive instants without including an extra millisecond", () => {
    expect(
      resolveDashboardComparisonWindow(
        {
          start: new Date("2026-08-01T00:00:00.000Z"),
          endExclusive: new Date("2026-08-04T00:00:00.000Z"),
        },
        "UTC",
        now
      )
    ).toEqual({
      preset: "custom",
      strategy: "adjacent_equal_duration",
      timeZone: "UTC",
      current: {
        start: "2026-08-01T00:00:00.000Z",
        endExclusive: "2026-08-04T00:00:00.000Z",
      },
      previous: {
        start: "2026-07-29T00:00:00.000Z",
        endExclusive: "2026-08-01T00:00:00.000Z",
      },
    });
  });

  it("keeps prior-week boundaries at the same local calendar positions across DST", () => {
    expect(
      resolveDashboardComparisonWindow(
        "this_week",
        "America/New_York",
        new Date("2026-11-04T19:30:00.000Z")
      )
    ).toEqual({
      preset: "this_week",
      strategy: "previous_week_same_elapsed",
      timeZone: "America/New_York",
      current: {
        start: "2026-11-02T05:00:00.000Z",
        endExclusive: "2026-11-04T19:30:00.000Z",
      },
      previous: {
        start: "2026-10-26T04:00:00.000Z",
        endExclusive: "2026-10-28T18:30:00.000Z",
      },
    });
  });

  it("rejects unsupported numeric presets", () => {
    expect(() =>
      resolveDashboardComparisonWindow(31 as never, "UTC", now)
    ).toThrow("Invalid dashboard comparison period");
  });

  it("bounds all-time comparisons to the current 365 days without a previous period", () => {
    expect(resolveDashboardComparisonWindow("all", "UTC", now)).toEqual({
      preset: "last_12_months",
      strategy: "none",
      timeZone: "UTC",
      current: {
        start: "2025-08-05T09:30:00.000Z",
        endExclusive: "2026-08-05T09:30:00.000Z",
      },
      previous: null,
    });
  });
});

describe("normalizeDashboardCustomCalendarRange", () => {
  it("converts inclusive local calendar dates to one exact half-open range", () => {
    expect(
      normalizeDashboardCustomCalendarRange(
        "2026-05-01",
        "2026-05-07",
        "Asia/Qyzylorda"
      )
    ).toEqual({
      start: new Date("2026-04-30T19:00:00.000Z"),
      endExclusive: new Date("2026-05-07T19:00:00.000Z"),
    });
  });

  it("returns the first valid instant when local midnight is skipped", () => {
    expect(
      normalizeDashboardCalendarDateStart("2026-03-08", "America/Havana")
    ).toEqual(new Date("2026-03-08T05:00:00.000Z"));
  });
});

describe("buildDashboardDurationComparison", () => {
  it("keeps valid zero-second medians directional instead of using category lifecycle kinds", () => {
    expect(buildDashboardDurationComparison(0, 10)).toEqual({
      current: 0,
      previous: 10,
      delta: -10,
      percentChange: -100,
      kind: "decrease",
    });
    expect(buildDashboardDurationComparison(10, 0)).toEqual({
      current: 10,
      previous: 0,
      delta: 10,
      percentChange: null,
      kind: "increase",
    });
    expect(buildDashboardDurationComparison(0, 0)).toEqual({
      current: 0,
      previous: 0,
      delta: 0,
      percentChange: null,
      kind: "unchanged",
    });
  });
});

describe("resolveDashboardCalendarDays", () => {
  it("shares complete local calendar labels across a DST transition", () => {
    const range = resolveDashboardCalendarDays(
      7,
      "America/New_York",
      new Date("2026-03-09T16:00:00Z")
    );
    expect(range).toEqual({ from: "2026-03-03", to: "2026-03-09" });
    const exact = normalizeDashboardCustomCalendarRange(
      range.from,
      range.to,
      "America/New_York"
    );
    expect(exact.start.toISOString()).toBe("2026-03-03T05:00:00.000Z");
    expect(exact.endExclusive.toISOString()).toBe("2026-03-10T04:00:00.000Z");
  });
  it("lags mature cohort dates by calendar days at month and year boundaries", () => {
    expect(
      resolveDashboardCalendarDays(
        7,
        "Asia/Almaty",
        new Date("2026-01-02T02:00:00Z"),
        30
      )
    ).toEqual({ from: "2025-11-27", to: "2025-12-03" });
  });
});
