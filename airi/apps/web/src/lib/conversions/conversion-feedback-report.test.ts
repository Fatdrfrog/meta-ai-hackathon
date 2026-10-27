import { getConversionFeedbackReport } from "./conversion-feedback-report";

const report = {
  recorded: 1000,
  eligible: 900,
  statuses: {
    not_eligible: 100,
    pending: 300,
    queued: 100,
    sent: 400,
    rejected: 50,
    delivery_unknown: 50,
  },
  oldestPendingAt: "2026-09-01T00:00:00Z",
  reasons: [
    {
      status: "not_eligible",
      reason: "missing_attributable_click",
      count: 100,
    },
  ],
  truncated: false,
};
const interval = {
  workspaceId: "workspace",
  start: "2026-09-01T00:00:00Z",
  end: "2026-09-03T00:00:00Z",
  timeZone: "UTC",
};
it("returns whole-period delivery totals rather than only the latest twenty conversions", async () => {
  const rpc = jest.fn().mockResolvedValue({ data: report, error: null });
  expect(
    await getConversionFeedbackReport({
      ...interval,
      supabase: { rpc } as never,
      sourceId: "source",
    })
  ).toEqual(report);
  expect(rpc).toHaveBeenCalledWith("get_conversion_feedback_report", {
    p_workspace_id: "workspace",
    p_start: interval.start,
    p_end: interval.end,
    p_source_id: "source",
    p_timezone: "UTC",
  });
});

it.each([
  { data: report, error: { message: "offline" } },
  {
    data: { ...report, statuses: { ...report.statuses, sent: -1 } },
    error: null,
  },
  { data: { ...report, recorded: 5 }, error: null },
  {
    data: {
      ...report,
      reasons: Array.from({ length: 101 }, () => report.reasons[0]),
    },
    error: null,
  },
])("fails visibly on unavailable or inconsistent aggregates", async result => {
  await expect(
    getConversionFeedbackReport({
      ...interval,
      supabase: { rpc: jest.fn().mockResolvedValue(result) } as never,
    })
  ).rejects.toThrow("Failed to load conversion feedback");
});
