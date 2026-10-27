/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { DashboardPeriodSummary } from "./dashboard-period-summary";

const messages: Record<string, string> = {
  "notableChanges.title": "Notable changes",
  "notableChanges.description": "Largest category change in inquiry volume.",
  "notableChanges.increase": "{category} increased by {delta} inquiries.",
  "notableChanges.decrease": "{category} decreased by {delta} inquiries.",
  "notableChanges.new": "{category} is new with {delta} inquiries.",
  "notableChanges.noLongerActive":
    "{category} is no longer active, a change of {delta} inquiries.",
  "notableChanges.unchanged": "Category inquiry volume was unchanged.",
  "comparison.currentPeriod": "Current: {range}",
  "comparison.previousPeriod": "Previous: {range}",
  uncategorized: "Uncategorized",
};

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations:
    () => (key: string, values?: Record<string, number | string>) => {
      const template = messages[key] ?? key;
      return template.replace(/\{(\w+)\}/g, (_, token: string) =>
        String(values?.[token] ?? `{${token}}`)
      );
    },
}));

const period = {
  preset: "7d" as const,
  strategy: "adjacent_equal_duration" as const,
  timeZone: "UTC",
  current: {
    start: "2026-08-01T00:00:00.000Z",
    endExclusive: "2026-08-08T00:00:00.000Z",
  },
  previous: {
    start: "2026-07-25T00:00:00.000Z",
    endExclusive: "2026-08-01T00:00:00.000Z",
  },
};

describe("DashboardPeriodSummary", () => {
  it("shows exact normalized ranges and a factual largest change", () => {
    render(
      <DashboardPeriodSummary
        period={period}
        comparisonEnabled
        comparisons={[
          {
            category: "Billing / Enterprise",
            current: 15,
            previous: 10,
            delta: 5,
            percentChange: 50,
            kind: "increase",
          },
        ]}
      />
    );

    expect(
      screen.getByText("Current: Aug 1, 2026 – Aug 7, 2026")
    ).toBeVisible();
    expect(
      screen.getByText("Previous: Jul 25, 2026 – Jul 31, 2026")
    ).toBeVisible();
    expect(
      screen.getByText("Billing / Enterprise increased by 5 inquiries.")
    ).toBeVisible();
    expect(
      screen.getByText("Billing / Enterprise increased by 5 inquiries.")
    ).not.toHaveTextContent(/because|caused|due to/i);
  });

  it("uses a factual status for a zero-baseline new category without a percentage", () => {
    render(
      <DashboardPeriodSummary
        period={period}
        comparisonEnabled
        comparisons={[
          {
            category: "VIP",
            current: 3,
            previous: 0,
            delta: 3,
            percentChange: null,
            kind: "new",
          },
        ]}
      />
    );

    expect(screen.getByText("VIP is new with 3 inquiries.")).toBeVisible();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("selects the largest absolute delta with a stable raw-category tie-break", () => {
    render(
      <DashboardPeriodSummary
        period={period}
        comparisonEnabled
        comparisons={[
          {
            category: "Smaller first",
            current: 11,
            previous: 10,
            delta: 1,
            percentChange: 10,
            kind: "increase",
          },
          {
            category: "Zulu",
            current: 20,
            previous: 10,
            delta: 10,
            percentChange: 100,
            kind: "increase",
          },
          {
            category: "Alpha",
            current: 0,
            previous: 10,
            delta: -10,
            percentChange: -100,
            kind: "no_longer_active",
          },
        ]}
      />
    );

    expect(
      screen.getByText("Alpha is no longer active, a change of 10 inquiries.")
    ).toBeVisible();
    expect(
      screen.queryByText(/Smaller first increased/)
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Zulu increased/)).not.toBeInTheDocument();
  });

  it("is absent when comparison presentation is off", () => {
    const { container } = render(
      <DashboardPeriodSummary
        period={period}
        comparisonEnabled={false}
        comparisons={[]}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });
});
