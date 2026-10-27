/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import type { BulkCampaignCommandResult } from "@icecore/scenario-contracts";
import { BulkCampaignOutcomeSummary } from "./bulk-campaign-outcome-summary";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { count?: number }) =>
    values?.count !== undefined ? `${key}:${values.count}` : key,
}));

const result: BulkCampaignCommandResult = {
  ok: true,
  outcome: {
    disposition: "queued",
    evaluatedAt: "2026-08-24T12:00:00.000Z",
    lifecycleStatus: "queued",
    requestedTotal: 13,
    acceptedTotal: 2,
    queuedTotal: 2,
    uniqueRecipients: { requested: 13, accepted: 2, queued: 2 },
    skippedByReason: {
      marketing_opt_out: 3,
      recipient_limit: 2,
      prior_failure: 1,
      ineligible: 4,
      service_window: 1,
      unsubscribed: 0,
    },
    warnings: { missingMarketingConsent: 5 },
    campaignId: "campaign-1",
    dispatchId: "dispatch-1",
  },
};

describe("BulkCampaignOutcomeSummary", () => {
  it("renders the same literal labels and counts from one canonical result", () => {
    render(<BulkCampaignOutcomeSummary result={result} />);

    const root = screen.getByTestId("bulk-campaign-outcome-summary");
    expect(root).toBeTruthy();
    const rowText = (label: string) =>
      screen.getByText(label).closest("li")?.textContent || "";
    expect(rowText("outcome.marketingOptOut")).toContain("3");
    expect(rowText("outcome.recipientLimit")).toContain("2");
    expect(rowText("outcome.priorFailure")).toContain("1");
    expect(rowText("outcome.ineligible")).toContain("4");
    expect(rowText("outcome.serviceWindow")).toContain("1");
    expect(screen.queryByText("outcome.unsubscribed")).toBeNull();
    expect(rowText("outcome.missingMarketingConsent")).toContain("5");
    // Skip reasons sit under a "not sent" heading; the consent warning is
    // set apart because those recipients were not skipped for it.
    const heading = screen.getByText("outcome.skippedTitle");
    expect(
      heading.compareDocumentPosition(
        screen.getByText("outcome.marketingOptOut")
      ) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      screen.getByText("outcome.missingMarketingConsent").closest("li")
        ?.className
    ).toContain("border-t");
  });

  it("shows a consent warning alone without the not-sent heading", () => {
    if (!result.ok) throw new Error("Expected a successful fixture");
    render(
      <BulkCampaignOutcomeSummary
        result={{
          ...result,
          outcome: { ...result.outcome, skippedByReason: {} },
        }}
      />
    );
    expect(screen.queryByText("outcome.skippedTitle")).toBeNull();
    const consentRow = screen
      .getByText("outcome.missingMarketingConsent")
      .closest("li");
    expect(consentRow?.textContent).toContain("5");
    expect(consentRow?.className).not.toContain("border-t");
  });

  it("omits the summary when there are no skipped recipients or consent warnings", () => {
    if (!result.ok) throw new Error("Expected a successful fixture");
    render(
      <BulkCampaignOutcomeSummary
        result={{
          ...result,
          outcome: {
            ...result.outcome,
            skippedByReason: {},
            warnings: { missingMarketingConsent: 0 },
          },
        }}
      />
    );
    expect(screen.queryByTestId("bulk-campaign-outcome-summary")).toBeNull();
  });
});
