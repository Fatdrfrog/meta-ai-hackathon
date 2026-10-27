/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import type { DashboardStatCard } from "./dashboard-localization";
import { SectionCards } from "./section-cards";

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, values?: Record<string, string>) => {
    const messages: Record<string, string> = {
      openRequestQueue: "Open request queue",
      moreMetrics: "More metrics",
      noChange: "No change",
      previousValue: "Previous: {value}",
      "comparisonNotes.liveStatus": "Current status · not compared",
      "comparisonNotes.notCompared": "Not compared with the previous period",
      "duration.missing": "—",
      "duration.lessThanMinute": "less than a minute",
      "duration.seconds": "{value} sec",
      "duration.minutes": "{value} min",
      "duration.hours": "{value} hr",
      "duration.days": "{value} days",
      "duration.noChange": "No change",
      "help.ariaLabel": "What {metric} means",
      "help.firstResponse":
        "Median is the middle first reply. Avg can be skewed by outliers. P90 covers 90% of first replies.",
      "help.sla": "Open chats older than 3 days.",
      "help.repeat": "Customers who started another chat.",
      "help.csat": "Average customer satisfaction score.",
      "help.ttr": "Average time from chat start to close.",
    };
    return (messages[key] ?? key).replace(/\{(\w+)\}/g, (_, token: string) =>
      String(values?.[token] ?? `{${token}}`)
    );
  },
}));

jest.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div role="tooltip">{children}</div>
  ),
}));

const metricIds = [
  "repeat",
  "first_response",
  "sla",
  "resolved",
  "total",
  "ttr",
  "new",
  "csat",
  "in_progress",
] as const;

function buildStats(): DashboardStatCard[] {
  return metricIds.map((id, index) => ({
    id,
    label: `Metric ${id}`,
    value: String(index + 1),
    comparison: {
      current: 10,
      previous: 5,
      delta: 5,
      percentChange: 100,
      kind: "increase",
    },
    insight: id === "first_response" ? "Response sample details" : "",
    isHighlighted: id === "sla",
  }));
}

describe("SectionCards", () => {
  it("shows all metrics in canonical order without a disclosure control", () => {
    const { container } = render(
      <SectionCards
        workspaceId="workspace-1"
        stats={buildStats()}
        comparisonEnabled
      />
    );

    expect(screen.queryByRole("button", { name: "More metrics" })).toBeNull();
    expect(container.querySelectorAll("[data-metric-id]")).toHaveLength(9);
    expect(
      Array.from(container.querySelectorAll("[data-metric-id]")).map(node =>
        node.getAttribute("data-metric-id")
      )
    ).toEqual([
      "total",
      "new",
      "resolved",
      "first_response",
      "in_progress",
      "sla",
      "repeat",
      "csat",
      "ttr",
    ]);
  });

  it("sizes KPI columns from their container instead of the viewport", () => {
    const { container } = render(
      <SectionCards
        workspaceId="workspace-1"
        stats={buildStats()}
        comparisonEnabled
      />
    );

    const grid = container.querySelector(
      '[data-metric-id="total"]'
    )?.parentElement;
    expect(grid?.className).toContain("grid-cols-1");
    expect(grid?.className).toContain("sm:grid-cols-2");
    expect(grid?.className).toContain("lg:grid-cols-3");
    expect(grid?.className).toContain("items-start");
  });

  it("shows the change and previous value for compared metrics without decorative icons", () => {
    const { container } = render(
      <SectionCards
        workspaceId="workspace-1"
        stats={buildStats()}
        comparisonEnabled
      />
    );

    const cards = container.querySelectorAll('[data-slot="card"]');
    expect(cards).toHaveLength(9);
    for (const card of cards) {
      expect(card.querySelector('[data-slot="card-header"]')).toBeTruthy();
      expect(card.querySelector('[data-slot="card-content"]')).toBeTruthy();
    }

    for (const id of ["total", "resolved", "repeat"]) {
      expect(screen.getByTestId(`metric-comparison-${id}`)).toHaveTextContent(
        "+100%Previous: 5"
      );
    }
    expect(
      screen.getByTestId("metric-comparison-first_response")
    ).toHaveTextContent("+5 secPrevious: less than a minute");
    expect(screen.getByTestId("metric-comparison-csat")).toHaveTextContent(
      "+5Previous: 5"
    );
    expect(screen.getByTestId("metric-comparison-ttr")).toHaveTextContent(
      "+5 daysPrevious: 5 days"
    );
    expect(container.querySelector("svg")).toBeNull();
  });

  it("explains live queue metrics instead of comparing them", () => {
    render(
      <SectionCards
        workspaceId="workspace-1"
        stats={buildStats()}
        comparisonEnabled
      />
    );

    for (const id of ["new", "in_progress", "sla"]) {
      expect(screen.queryByTestId(`metric-comparison-${id}`)).toBeNull();
      expect(
        screen.getByTestId(`metric-comparison-note-${id}`)
      ).toHaveTextContent("Current status · not compared");
    }
  });

  it("says when a comparable metric has no previous value, and stays quiet without comparison", () => {
    const stats = buildStats().map(stat =>
      stat.id === "csat" ? { ...stat, comparison: null } : stat
    );
    const { rerender } = render(
      <SectionCards workspaceId="workspace-1" stats={stats} comparisonEnabled />
    );

    expect(screen.getByTestId("metric-comparison-note-csat")).toHaveTextContent(
      "Not compared with the previous period"
    );

    rerender(
      <SectionCards
        workspaceId="workspace-1"
        stats={stats}
        comparisonEnabled={false}
      />
    );
    expect(screen.queryByTestId("metric-comparison-total")).toBeNull();
    expect(screen.queryByText(/not compared/i)).toBeNull();
  });

  it("formats unchanged values and changes from a zero baseline", () => {
    const stats = buildStats().map(stat =>
      stat.id === "total"
        ? {
            ...stat,
            comparison: {
              current: 7,
              previous: 7,
              delta: 0,
              percentChange: 0,
              kind: "unchanged" as const,
            },
          }
        : stat.id === "resolved"
          ? {
              ...stat,
              comparison: {
                current: 4,
                previous: 0,
                delta: 4,
                percentChange: null,
                kind: "new" as const,
              },
            }
          : stat
    );
    render(
      <SectionCards workspaceId="workspace-1" stats={stats} comparisonEnabled />
    );

    expect(screen.getByTestId("metric-comparison-total")).toHaveTextContent(
      "No changePrevious: 7"
    );
    expect(screen.getByTestId("metric-comparison-resolved")).toHaveTextContent(
      "+4Previous: 0"
    );
  });

  it("adds static help tooltips for metrics that need explanation", () => {
    render(
      <SectionCards
        workspaceId="workspace-1"
        stats={buildStats()}
        comparisonEnabled
      />
    );

    expect(
      screen.getByRole("button", {
        name: /What Metric first_response means/,
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /What Metric sla means/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /What Metric repeat means/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /What Metric csat means/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /What Metric ttr means/ })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /What Metric total means/ })
    ).toBeNull();
  });

  it("links actionable metrics to filtered requests URLs", () => {
    render(
      <SectionCards
        workspaceId="workspace-1"
        stats={buildStats()}
        comparisonEnabled
      />
    );

    const hrefs = screen
      .getAllByRole("link", { name: "Open request queue" })
      .map(link => link.getAttribute("href"));
    expect(hrefs).toEqual(
      expect.arrayContaining([
        "/panel/w/workspace-1/requests?status=open",
        "/panel/w/workspace-1/requests?status=in_progress",
        "/panel/w/workspace-1/requests?status=closed",
        "/panel/w/workspace-1/requests?filter=slaBreached",
        "/panel/w/workspace-1/requests?filter=csatLow",
      ])
    );
    expect(hrefs).toHaveLength(5);
  });
});
