/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { DashboardStatCard } from "./dashboard-localization";
import type {
  DashboardCategoryComparison,
  DashboardComparisonPeriod,
} from "@/types/dashboard";
import { DashboardOverview } from "./dashboard-overview";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    (
      ({
        "categoryComparison.table.current": "Current",
        "categoryComparison.table.previous": "Previous",
      }) as Record<string, string>
    )[key] ?? key,
}));

jest.mock("./section-cards", () => ({
  SectionCards: ({
    stats,
    comparisonEnabled,
  }: {
    stats: Array<{ id: string }>;
    comparisonEnabled: boolean;
  }) => (
    <div
      data-comparison-enabled={String(comparisonEnabled)}
      data-testid="section-cards"
    >
      {stats.map(stat => stat.id).join("|")}
    </div>
  ),
}));

jest.mock("./conversation-volume-chart", () => ({
  ConversationVolumeChart: ({
    current,
    previous,
    comparisonEnabled,
    comparisonPeriod,
  }: {
    current: unknown[];
    previous: unknown[];
    comparisonEnabled: boolean;
    comparisonPeriod?: DashboardComparisonPeriod;
  }) => (
    <div
      data-comparison-enabled={String(comparisonEnabled)}
      data-current={current.length}
      data-period-time-zone={comparisonPeriod?.timeZone}
      data-previous={previous.length}
      data-testid="volume-chart"
    />
  ),
}));

jest.mock("./dashboard-period-summary", () => ({
  DashboardPeriodSummary: ({
    comparisonEnabled,
  }: {
    comparisonEnabled: boolean;
  }) => (
    <div
      data-comparison-enabled={String(comparisonEnabled)}
      data-testid="period-summary"
    />
  ),
}));

jest.mock("./category-comparison-table", () => ({
  CategoryComparisonTable: ({
    rows,
    limit,
    comparisonEnabled,
    onViewAll,
  }: {
    rows: unknown[];
    limit?: number;
    comparisonEnabled: boolean;
    onViewAll?: () => void;
  }) => (
    <div
      data-comparison-enabled={String(comparisonEnabled)}
      data-limit={limit}
      data-rows={rows.length}
      data-testid="category-preview"
    >
      <button onClick={onViewAll}>View all categories</button>
    </div>
  ),
}));

const period: DashboardComparisonPeriod = {
  preset: "30d",
  strategy: "adjacent_equal_duration",
  timeZone: "Asia/Qyzylorda",
  current: {
    start: "2026-07-01T00:00:00.000Z",
    endExclusive: "2026-07-31T00:00:00.000Z",
  },
  previous: {
    start: "2026-06-01T00:00:00.000Z",
    endExclusive: "2026-07-01T00:00:00.000Z",
  },
};

const stats = [
  "total",
  "new",
  "resolved",
  "first_response",
  "in_progress",
  "sla",
  "repeat",
  "csat",
  "ttr",
].map(id => ({
  id,
  label: id,
  value: "1",
  comparison: null,
  insight: "",
  isHighlighted: false,
})) as DashboardStatCard[];

const categoryComparisons: DashboardCategoryComparison[] = [
  {
    category: "Accounting",
    current: 9,
    previous: 4,
    delta: 5,
    percentChange: 125,
    kind: "increase",
  },
];

describe("DashboardOverview", () => {
  it("composes KPIs, paired volume, exact periods, and a five-row category preview", () => {
    const onViewAll = jest.fn();

    render(
      <DashboardOverview
        workspaceId="workspace-1"
        stats={stats}
        dailySeries={{
          current: [{ date: "2026-07-01", total: 9 }],
          previous: [{ date: "2026-06-01", total: 4 }],
        }}
        comparisonPeriod={period}
        categoryComparisons={categoryComparisons}
        comparisonEnabled
        onViewAll={onViewAll}
      />
    );

    expect(screen.getByTestId("section-cards").textContent).toContain(
      "first_response"
    );
    expect(
      screen.getByTestId("volume-chart").getAttribute("data-previous")
    ).toBe("1");
    expect(
      screen.getByTestId("volume-chart").getAttribute("data-period-time-zone")
    ).toBe("Asia/Qyzylorda");
    expect(
      screen
        .getByTestId("period-summary")
        .getAttribute("data-comparison-enabled")
    ).toBe("true");
    expect(
      screen.getByTestId("category-preview").getAttribute("data-limit")
    ).toBe("5");

    fireEvent.click(
      screen.getByRole("button", { name: "View all categories" })
    );
    expect(onViewAll).toHaveBeenCalledTimes(1);
  });

  it("passes current-only presentation through every comparison owner", () => {
    render(
      <DashboardOverview
        workspaceId="workspace-1"
        stats={stats}
        dailySeries={{
          current: [{ date: "2026-07-01", total: 9 }],
          previous: [{ date: "2026-06-01", total: 4 }],
        }}
        comparisonPeriod={period}
        categoryComparisons={categoryComparisons}
        comparisonEnabled={false}
        onViewAll={jest.fn()}
      />
    );

    for (const testId of [
      "section-cards",
      "volume-chart",
      "period-summary",
      "category-preview",
    ]) {
      expect(
        screen.getByTestId(testId).getAttribute("data-comparison-enabled")
      ).toBe("false");
    }
  });
});
