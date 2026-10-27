/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { ConversionFeedbackReportSection } from "./conversion-feedback-report";
import type { ConversionFeedbackReport } from "@/lib/conversions/conversion-feedback-report";
const report: ConversionFeedbackReport = {
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
it("shows whole-period counts and the attribution issue rather than a recent-event sample", () => {
  render(<ConversionFeedbackReportSection report={report} />);
  expect(screen.getByText("1,000")).toBeTruthy();
  expect(screen.getByText("900")).toBeTruthy();
  expect(screen.getByText("reasons.missing_attributable_click")).toBeTruthy();
  expect(screen.getByText("unknownHelp")).toBeTruthy();
  expect(screen.getByText("oldestPending")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});
it("retains a visible provider-feedback error independently from recorded sales", () => {
  render(<ConversionFeedbackReportSection error="unavailable" />);
  expect(screen.getByText("unavailable")).toBeTruthy();
});
it("uses an action-oriented fallback for an unrecognized provider reason", () => {
  render(
    <ConversionFeedbackReportSection
      report={{
        ...report,
        reasons: [
          { status: "rejected", reason: "private-provider-code", count: 50 },
        ],
      }}
    />
  );
  expect(screen.getByText("reasons.other")).toBeTruthy();
  expect(screen.queryByText("private-provider-code")).toBeNull();
});
it("explains refund eligibility and transport uncertainty from canonical delivery reasons", () => {
  render(
    <ConversionFeedbackReportSection
      report={{
        ...report,
        reasons: [
          {
            status: "not_eligible",
            reason: "purchase_destination_changed",
            count: 10,
          },
          {
            status: "delivery_unknown",
            reason: "provider_response_timeout",
            count: 50,
          },
          { status: "rejected", reason: "meta_graph_190_463", count: 50 },
        ],
      }}
    />
  );
  expect(screen.getByText("reasons.purchase_destination_changed")).toBeTruthy();
  expect(screen.getByText("reasons.provider_response_timeout")).toBeTruthy();
  expect(screen.getByText("reasons.meta")).toBeTruthy();
});
