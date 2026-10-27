/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  ServiceTruthSummary,
  ServiceCoverageNotice,
} from "./service-truth-summary";
import type { ServiceTruthReport } from "@/lib/analytics/service-truth";
jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations:
    (namespace: string) => (key: string, values?: Record<string, unknown>) =>
      (
        ({
          "DashboardPage.serviceTruth.title": "Service coverage",
          "DashboardPage.serviceTruth.unanswered": "Unanswered",
          "DashboardPage.serviceTruth.coverage": "Answered share",
          "DashboardPage.serviceTruth.managerFilterNotice":
            "Unanswered denominator unavailable for a first responder filter",
          "DashboardPage.serviceTruth.partialCoverage": `Partial chat detail limited to ${values?.limit} rows`,
          "SectionCards.duration.missing": "—",
          "SectionCards.duration.lessThanMinute": "less than a minute",
        }) as Record<string, string>
      )[`${namespace}.${key}`] ?? key,
}));
const report: ServiceTruthReport = {
  asOf: "2026-10-02T12:00:00Z",
  firstHumanResponse: {
    eligibleConversations: 3,
    answeredConversations: 1,
    unansweredConversations: 2,
    coverageRate: 100 / 3,
    oldestUnansweredSeconds: 60,
    medianSeconds: 0,
    p90Seconds: 0,
  },
  resolution: {
    measuredResolvedConversations: 0,
    unknownClosedConversations: 2,
    timeoutClosedConversations: 1,
    averageSeconds: null,
    medianSeconds: null,
    p90Seconds: null,
  },
  agedOpenPolicy: { windowDays: 3, count: 2 },
};
test("shows unanswered coverage alongside answered samples", () => {
  render(<ServiceTruthSummary report={report} />);
  expect(screen.getByText("Unanswered").nextElementSibling).toHaveTextContent(
    "2"
  );
  expect(
    screen.getByText("Answered share").nextElementSibling
  ).toHaveTextContent("33.3%");
  expect(
    screen.getByRole("heading", { name: "Service coverage" })
  ).toBeInTheDocument();
});
test("a manager filter shows unknown rather than a false zero denominator", () => {
  render(
    <ServiceTruthSummary
      report={{
        ...report,
        firstHumanResponse: {
          ...report.firstHumanResponse,
          eligibleConversations: null,
          unansweredConversations: null,
          coverageRate: null,
        },
      }}
    />
  );
  expect(screen.getByText("Unanswered").nextElementSibling).toHaveTextContent(
    "—"
  );
  expect(
    screen.getByText(
      "Unanswered denominator unavailable for a first responder filter"
    )
  ).toBeInTheDocument();
});
test("source truncation is visible and is never an invisible sample cap", () => {
  render(
    <ServiceCoverageNotice
      coverage={{
        status: "partial",
        rowLimit: 10000,
        conversationRowsLoaded: 10000,
        firstResponseRowsLoaded: 0,
        conversationRowsTruncated: true,
        firstResponseRowsTruncated: false,
      }}
    />
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Partial chat detail limited to 10,000 rows"
  );
});
test("unavailable service evidence does not fabricate a panel", () => {
  expect(render(<ServiceTruthSummary />).container).toBeEmptyDOMElement();
});
