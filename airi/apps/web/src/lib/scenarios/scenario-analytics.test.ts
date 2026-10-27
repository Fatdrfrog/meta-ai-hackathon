import {
  buildScenarioFunnelSteps,
  buildScenarioRecommendationCards,
  computeMedian,
  computeScenarioAnalyticsRate,
  formatScenarioAnalyticsReason,
} from "./scenario-analytics";

describe("scenario analytics helpers", () => {
  it("builds overall and previous-step funnel conversions", () => {
    const funnel = buildScenarioFunnelSteps([
      { key: "evaluated", label: "Evaluated", count: 100 },
      { key: "trigger_matched", label: "Trigger matched", count: 60 },
      { key: "winner", label: "Winner", count: 30 },
    ]);

    expect(funnel.overallConversion.map(step => step.conversionRate)).toEqual([
      1, 0.6, 0.3,
    ]);
    expect(funnel.relativeConversion.map(step => step.conversionRate)).toEqual([
      1, 0.6, 0.5,
    ]);
  });

  it("computes medians and safe rates", () => {
    expect(computeMedian([3, 1, 2])).toBe(2);
    expect(computeMedian([1, 2, 3, 4])).toBe(2.5);
    expect(computeMedian([])).toBe(0);
    expect(computeScenarioAnalyticsRate(4, 8)).toBe(0.5);
    expect(computeScenarioAnalyticsRate(4, 0)).toBe(0);
  });

  it("formats known reason labels for the UI", () => {
    expect(formatScenarioAnalyticsReason("trigger_mismatch")).toBe(
      "Trigger mismatch"
    );
    expect(formatScenarioAnalyticsReason("flow_no_matching_action")).toBe(
      "Trigger matched but no action fit"
    );
    expect(
      formatScenarioAnalyticsReason(
        "fallback_suppressed_recent_specific_session"
      )
    ).toBe("Fallback suppressed by a recent specific session");
    expect(formatScenarioAnalyticsReason("retired_historical_reason")).toBe(
      "Other scenario outcome"
    );
  });

  it("builds prescriptive recommendations only when sample size is sufficient", () => {
    const recommendations = buildScenarioRecommendationCards({
      scenarioMetrics: [
        {
          scenarioId: "scenario-high-mismatch",
          scenarioName: "High mismatch",
          evaluatedCount: 50,
          triggerMatchedCount: 15,
          winnerCount: 12,
          triggerMismatchCount: 35,
          noMatchingActionCount: 2,
          blockedCount: 8,
          blockedReasons: ["blocked_by_once_per_conversation"],
          filters: {
            channelFilter: ["whatsapp"],
          },
        },
        {
          scenarioId: "scenario-low-sample",
          scenarioName: "Low sample",
          evaluatedCount: 8,
          triggerMatchedCount: 4,
          winnerCount: 3,
          triggerMismatchCount: 2,
          noMatchingActionCount: 0,
          blockedCount: 0,
          blockedReasons: [],
          filters: null,
        },
      ],
      flowMetricsByScenarioId: new Map([
        [
          "scenario-high-mismatch",
          {
            scenarioId: "scenario-high-mismatch",
            scenarioName: "High mismatch",
            readCount: 40,
            submittedCount: 10,
          },
        ],
      ]),
    });

    const highMismatchKinds = recommendations
      .filter(item => item.scenarioId === "scenario-high-mismatch")
      .map(item => item.kind);

    expect(highMismatchKinds).toHaveLength(4);
    expect(highMismatchKinds).toEqual(
      expect.arrayContaining([
        "high_trigger_mismatch",
        "no_matching_action",
        "reentry_blocked",
        "flow_read_no_submit",
      ])
    );
    expect(
      recommendations
        .filter(item => item.scenarioId === "scenario-low-sample")
        .map(item => item.kind)
    ).toEqual(["low_sample"]);
  });
});
