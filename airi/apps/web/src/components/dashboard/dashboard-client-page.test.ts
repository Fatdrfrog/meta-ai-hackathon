/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import type { ReactElement } from "react";
import {
  DASHBOARD_UNCATEGORIZED_CATEGORY,
  type AdvertisementAnalytics,
  type DashboardData,
  type InternalLabelAnalytics,
} from "@/types/dashboard";
import { dashboardSWRConfig } from "./dashboard-client-swr-config";

let mockDashboardData: DashboardData | undefined;
let mockDashboardError: unknown = null;
const mockMutate = jest.fn(async () => undefined);

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: (
    loader: () => Promise<unknown>,
    options: { loading?: () => ReactElement } = {}
  ) => {
    const source = String(loader);
    const scope = globalThis as typeof globalThis & {
      __dashboardDynamicOptions?: Map<string, { loading?: () => ReactElement }>;
    };
    scope.__dashboardDynamicOptions ??= new Map();
    scope.__dashboardDynamicOptions.set(source, options);
    if (source.includes("dashboard-domain-cards")) {
      return function MockDomainCard({ kind }: { kind: string }) {
        return createElement("div", { "data-testid": `domain-${kind}` });
      };
    }
    if (source.includes("dashboard-overview")) {
      return function MockDashboardOverview({
        comparisonEnabled,
        onViewAll,
        comparisonPeriod,
      }: {
        comparisonEnabled: boolean;
        onViewAll: () => void;
        comparisonPeriod: { timeZone: string };
      }) {
        return createElement(
          "div",
          {
            "data-comparison-enabled": String(comparisonEnabled),
            "data-testid": "overview-content",
            "data-time-zone": comparisonPeriod.timeZone,
          },
          createElement("button", { onClick: onViewAll }, "Open categories")
        );
      };
    }
    if (source.includes("category-distribution-chart")) {
      return function MockCategoryDistributionChart(props: {
        data: Array<{ name: string; value: number; previous?: number }>;
        uncategorized: number;
        uncategorizedPrevious?: number;
        comparisonEnabled?: boolean;
      }) {
        return createElement("div", {
          "data-testid": "category-distribution",
          "data-props": JSON.stringify(props),
        });
      };
    }
    if (source.includes("manager-response-overview")) {
      return function MockManagerResponseOverview() {
        return createElement("div", { "data-testid": "manager-overview" });
      };
    }
    if (source.includes("conversation-activity-heatmap")) {
      return function MockConversationActivityHeatmap({
        timeZone,
      }: {
        timeZone: string;
      }) {
        return createElement(
          "div",
          { "data-testid": "activity-heatmap" },
          timeZone
        );
      };
    }
    if (source.includes("advertisement-analytics")) {
      return function MockAdvertisementAnalytics() {
        return createElement("div", { "data-testid": "advertisement" });
      };
    }
    if (source.includes("internal-labels-analytics")) {
      return function MockInternalLabelsAnalytics() {
        return createElement("div", { "data-testid": "internal-labels" });
      };
    }
    if (source.includes("conversation-volume-chart")) {
      return function MockConversationVolumeChart() {
        return createElement("div", { "data-testid": "volume-chart" });
      };
    }
    return function MockUnavailableDynamicModule() {
      return null;
    };
  },
}));

function getMockDynamicOptions() {
  return (
    globalThis as typeof globalThis & {
      __dashboardDynamicOptions?: Map<string, { loading?: () => ReactElement }>;
    }
  ).__dashboardDynamicOptions;
}

jest.mock("swr", () => ({
  __esModule: true,
  default: () => ({
    data: mockDashboardData,
    error: mockDashboardError,
    isLoading: false,
    mutate: mockMutate,
  }),
}));

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations:
    () => (key: string, values?: Record<string, number | string>) => {
      const messages: Record<string, string> = {
        "tabs.label": "Dashboard sections",
        "tabs.overview": "Overview",
        "tabs.categories": "Categories",
        "tabs.team": "Team and workload",
        "tabs.sources": "Sources and labels",
        failedToLoadData: "Dashboard unavailable",
        retry: "Retry dashboard",
        "empty.dashboard": "No activity in this period.",
        uncategorized: "Uncategorized",
        missingValue: "—",
      };
      const template = messages[key] ?? key;
      return template.replace(/\{(\w+)\}/g, (_, token: string) =>
        String(values?.[token] ?? `{${token}}`)
      );
    },
}));

jest.mock("@/components/dashboard/dashboard-section-visibility", () => ({
  hasAdvertisementData: (data?: AdvertisementAnalytics | null) =>
    Boolean(
      data &&
        (data.totalConversations > 0 ||
          (data.metaInsights &&
            ((data.metaInsights.totalResults ?? 0) > 0 ||
              (data.metaInsights.totalSpend ?? 0) > 0 ||
              data.metaInsights.error)))
    ),
  hasInternalLabelData: (data?: InternalLabelAnalytics | null) =>
    Boolean(data && data.taggedConversations > 0),
}));

jest.mock("@/components/dashboard/advertisement-analytics", () => {
  throw new Error(
    "Advertisement owner was loaded outside its dynamic tab seam"
  );
});

jest.mock("@/components/dashboard/internal-labels-analytics", () => {
  throw new Error(
    "Internal-label owner was loaded outside its dynamic tab seam"
  );
});

jest.mock("@/components/dashboard/category-comparison-table", () => ({
  CategoryComparisonTable: () =>
    createElement("div", { "data-testid": "full-category-table" }),
}));

jest.mock("@/components/dashboard/channel-breakdown", () => ({
  ChannelBreakdown: () =>
    createElement("div", { "data-testid": "channel-breakdown" }),
}));

import { DashboardClientPage } from "./dashboard-client-page";

jest.mock(
  "./dashboard-board-grid",
  () => ({
    DashboardBoardGrid: ({
      cards,
      renderCard,
    }: {
      cards: Array<{ id: string }>;
      renderCard: (id: string) => ReactElement;
    }) =>
      createElement(
        "div",
        { "data-testid": "board-grid" },
        ...cards.map(card =>
          createElement(
            "section",
            { key: card.id, "data-testid": `board-${card.id}` },
            renderCard(card.id)
          )
        )
      ),
  }),
  { virtual: true }
);

jest.mock("./section-cards", () => ({
  MetricCard: ({
    stat,
    comparisonEnabled,
  }: {
    stat: { id: string };
    comparisonEnabled: boolean;
  }) =>
    createElement("div", {
      "data-testid": `board-metric-${stat.id}`,
      "data-comparison": String(comparisonEnabled),
    }),
}));
jest.mock("@/components/dashboard/conversation-volume-chart", () => {
  throw new Error(
    "Volume chart (recharts) was loaded outside its dynamic seam"
  );
});
jest.mock("./dashboard-period-summary", () => ({
  DashboardPeriodSummary: () =>
    createElement("div", { "data-testid": "board-summary" }),
}));

function selectTab(name: string) {
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  fireEvent.click(tab);
}

function expectKeptHidden(testId: string) {
  expect(screen.getByTestId(testId).closest("[hidden]")).toBeTruthy();
}

const emptyAdvertisement = (): AdvertisementAnalytics => ({
  totalConversations: 0,
  uniqueSources: 0,
  respondedConversations: 0,
  closedConversations: 0,
  responseRate: 0,
  closeRate: 0,
  topSources: [],
  bySourceType: [],
  dailyCounts: [],
});

const emptyInternalLabels = (): InternalLabelAnalytics => ({
  taggedConversations: 0,
  unlabeledConversations: 0,
  uniqueLabels: 0,
  totalAssignments: 0,
  availableLabels: [],
  topLabels: [],
});

function buildDashboardData({
  currentTotal = 10,
  sourceData = false,
}: {
  currentTotal?: number;
  sourceData?: boolean;
} = {}): DashboardData {
  const comparison = {
    current: currentTotal,
    previous: 5,
    delta: currentTotal - 5,
    percentChange: currentTotal === 0 ? -100 : 100,
    kind:
      currentTotal === 0
        ? ("no_longer_active" as const)
        : ("increase" as const),
  };

  return {
    stats: [
      { id: "total", value: currentTotal, secondaryValue: null, comparison },
      { id: "new", value: 3, secondaryValue: null, comparison: null },
      { id: "in_progress", value: 2, secondaryValue: null, comparison: null },
      { id: "resolved", value: 5, secondaryValue: null, comparison: null },
      { id: "sla", value: 0, secondaryValue: null, comparison: null },
      { id: "repeat", value: 1, secondaryValue: 10, comparison: null },
      { id: "csat", value: 4.5, secondaryValue: 5, comparison: null },
      {
        id: "first_response",
        value: 120,
        secondaryValue: null,
        comparison: {
          current: 120,
          previous: 60,
          delta: 60,
          percentChange: 100,
          kind: "increase",
        },
      },
      { id: "ttr", value: 1, secondaryValue: null, comparison: null },
    ],
    comparisonPeriod: {
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
    },
    dailySeries: {
      current:
        currentTotal > 0 ? [{ date: "2026-07-01", total: currentTotal }] : [],
      previous: [{ date: "2026-06-01", total: 5 }],
    },
    conversationActivityByTime: [{ dayOfWeek: 4, hour: 10, count: 2 }],
    categoryComparisons: [
      {
        category: "Accounting",
        ...comparison,
      },
    ],
    peakTime: { dayOfWeek: 4, hour: 10 },
    topCategories:
      currentTotal > 0 ? [{ name: "Accounting", value: currentTotal }] : [],
    uncategorizedCount: 0,
    categoriesByChannel:
      currentTotal > 0
        ? [{ category: "Accounting", channel: "whatsapp", count: currentTotal }]
        : [],
    topComplaintTag: null,
    advertisement: sourceData
      ? { ...emptyAdvertisement(), totalConversations: 1 }
      : emptyAdvertisement(),
    internalLabels: emptyInternalLabels(),
    managerOptions: [],
    managerPerformance: [],
    firstResponse: {
      count: 1,
      medianSeconds: 120,
      averageSeconds: 120,
      p90Seconds: 120,
    },
  };
}

describe("dashboardSWRConfig", () => {
  it("keeps dashboard data visible while refetching new filters", () => {
    expect(dashboardSWRConfig).toMatchObject({
      dedupingInterval: 10_000,
      keepPreviousData: true,
      revalidateOnFocus: false,
    });
  });
});

describe("DashboardClientPage composition", () => {
  it.each([
    ["manager-response-overview", "h-72"],
    ["advertisement-analytics", "h-96"],
    ["internal-labels-analytics", "h-80"],
    ["conversation-volume-chart", "h-72"],
  ])(
    "provides a layout-sized loading fallback for %s",
    (moduleName, expectedHeight) => {
      const options = Array.from(getMockDynamicOptions()?.entries() ?? []).find(
        ([source]) => source.includes(moduleName)
      )?.[1];

      expect(options?.loading).toBeDefined();
      const { container } = render(options?.loading?.() ?? null);
      const className =
        container.firstElementChild?.getAttribute("class") ?? "";
      expect(className).toContain(expectedHeight);
      expect(className).toContain("w-full");
    }
  );

  beforeEach(() => {
    mockDashboardData = buildDashboardData();
    mockDashboardError = null;
    mockMutate.mockClear();
  });

  it("composes selected board cards through the existing filtered data owner", () => {
    mockDashboardData!.managerPerformance = [
      {
        id: "manager-1",
        name: "Manager",
        conversations: 3,
        open: 1,
        inProgress: 1,
        resolved: 1,
        firstResponseCount: 2,
        medianFirstResponseSeconds: 60,
        averageFirstResponseSeconds: 80,
        p90FirstResponseSeconds: 100,
      },
    ];
    render(
      createElement(DashboardClientPage, {
        workspaceId: "workspace-1",
        comparisonEnabled: false,
        boardPresentation: {
          cards: [
            { id: "total", width: 1, height: 1 },
            { id: "team", width: 2, height: 2 },
          ],
          editing: false,
          onCardsChange: jest.fn(),
        },
      })
    );
    expect(
      screen.getByTestId("board-metric-total").getAttribute("data-comparison")
    ).toBe("false");
    expect(screen.getByTestId("manager-overview")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("shows a no-data state for a selected team card with no managers", () => {
    mockDashboardData!.managerPerformance = [];
    render(
      createElement(DashboardClientPage, {
        workspaceId: "workspace-1",
        boardPresentation: {
          cards: [{ id: "team", width: 2, height: 2 }],
          editing: false,
          onCardsChange: jest.fn(),
        },
      })
    );
    expect(screen.getByText("board.noCardData")).toBeTruthy();
    // Board cards have no frame title, so the placeholder names its card.
    expect(
      screen.getByRole("heading", { name: "board.cards.team" })
    ).toBeTruthy();
  });

  it("gives top categories their previous counts without repeating a ranked uncategorized bucket", () => {
    mockDashboardData!.topCategories = [
      { name: "Accounting", value: 10 },
      { name: DASHBOARD_UNCATEGORIZED_CATEGORY, value: 4 },
    ];
    mockDashboardData!.uncategorizedCount = 4;
    mockDashboardData!.categoryComparisons = [
      {
        category: "Accounting",
        current: 10,
        previous: 6,
        delta: 4,
        percentChange: 66.7,
        kind: "increase",
      },
      {
        category: DASHBOARD_UNCATEGORIZED_CATEGORY,
        current: 4,
        previous: 1,
        delta: 3,
        percentChange: 300,
        kind: "increase",
      },
    ];
    render(
      createElement(DashboardClientPage, {
        workspaceId: "workspace-1",
        boardPresentation: {
          cards: [{ id: "categories", width: 1, height: 2 }],
          editing: false,
          onCardsChange: jest.fn(),
        },
      })
    );

    const props = JSON.parse(
      screen.getByTestId("category-distribution").getAttribute("data-props")!
    );
    expect(props).toEqual({
      data: [
        { name: "Accounting", value: 10, previous: 6 },
        { name: "Uncategorized", value: 4, previous: 1 },
      ],
      uncategorized: 0,
      uncategorizedPrevious: 1,
      comparisonEnabled: true,
    });
  });

  it("shows a no-data state for a selected volume card in an empty period", () => {
    mockDashboardData = buildDashboardData({ currentTotal: 0 });
    render(
      createElement(DashboardClientPage, {
        workspaceId: "workspace-1",
        boardPresentation: {
          cards: [{ id: "volume", width: 3, height: 2 }],
          editing: false,
          onCardsChange: jest.fn(),
        },
      })
    );
    expect(screen.getByText("board.noCardData")).toBeTruthy();
    expect(screen.queryAllByTestId("board-volume")).toHaveLength(1);
    expect(screen.queryByTestId("volume-chart")).toBeNull();
  });

  it("loads the volume chart on demand for a volume card with data", () => {
    render(
      createElement(DashboardClientPage, {
        workspaceId: "workspace-1",
        boardPresentation: {
          cards: [{ id: "volume", width: 2, height: 2 }],
          editing: false,
          onCardsChange: jest.fn(),
        },
      })
    );
    expect(screen.getByTestId("volume-chart")).toBeTruthy();
  });

  it("keeps independent AI summaries available when conversation analytics fail", () => {
    mockDashboardData = undefined;
    mockDashboardError = new Error("offline");
    render(
      createElement(DashboardClientPage, {
        workspaceId: "workspace-1",
        boardPresentation: {
          cards: [
            { id: "total", width: 1, height: 1 },
            { id: "ai_usage", width: 2, height: 2 },
          ],
          editing: false,
          onCardsChange: jest.fn(),
        },
      })
    );
    expect(screen.getByTestId("domain-ai_usage")).toBeTruthy();
    expect(screen.getByText("Dashboard unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry dashboard" }));
    expect(mockMutate).toHaveBeenCalledTimes(1);
  });

  it("defaults to Overview and mounts only the active heavy subtree", () => {
    render(
      createElement(DashboardClientPage, {
        workspaceId: "workspace-1",
        dateRange: { preset: "30d", from: null, to: null },
        comparisonEnabled: true,
      })
    );

    expect(
      screen.getByRole("tablist", { name: "Dashboard sections" })
    ).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: "Overview" })
        .getAttribute("aria-selected")
    ).toBe("true");
    expect(
      screen.getByTestId("overview-content").getAttribute("data-time-zone")
    ).toBe("Asia/Qyzylorda");
    expect(screen.queryByTestId("full-category-table")).toBeNull();
    expect(screen.queryByTestId("manager-overview")).toBeNull();
    expect(screen.queryByTestId("advertisement")).toBeNull();
  });

  it("keeps visited tab panels mounted and hides the inactive ones", () => {
    render(
      createElement(DashboardClientPage, {
        workspaceId: "workspace-1",
        dateRange: { preset: "30d", from: null, to: null },
        comparisonEnabled: true,
      })
    );

    selectTab("Categories");
    expect(screen.getByTestId("full-category-table")).toBeTruthy();
    expect(screen.getByTestId("category-distribution")).toBeTruthy();
    expect(screen.getByTestId("channel-breakdown")).toBeTruthy();
    expectKeptHidden("overview-content");

    selectTab("Team and workload");
    expect(screen.getByTestId("manager-overview")).toBeTruthy();
    expect(screen.getByTestId("activity-heatmap").textContent).toBe(
      "Asia/Qyzylorda"
    );
    expectKeptHidden("full-category-table");
    expectKeptHidden("overview-content");
  });

  it("preserves the active tab across data refetches", () => {
    const view = render(
      createElement(DashboardClientPage, {
        workspaceId: "workspace-1",
        dateRange: { preset: "30d", from: null, to: null },
      })
    );
    selectTab("Categories");

    mockDashboardData = {
      ...buildDashboardData(),
      uncategorizedCount: 2,
    };
    view.rerender(
      createElement(DashboardClientPage, {
        workspaceId: "workspace-1",
        dateRange: { preset: "30d", from: null, to: null },
      })
    );

    expect(
      screen
        .getByRole("tab", { name: "Categories" })
        .getAttribute("aria-selected")
    ).toBe("true");
    expect(screen.getByTestId("full-category-table")).toBeTruthy();
  });

  it("preserves a valid tab across a transient empty-data response", () => {
    const renderPage = () =>
      createElement(DashboardClientPage, {
        workspaceId: "workspace-1",
        dateRange: { preset: "30d", from: null, to: null },
      });
    const view = render(renderPage());
    selectTab("Categories");

    mockDashboardData = buildDashboardData({ currentTotal: 0 });
    view.rerender(renderPage());
    expect(screen.getByText("No activity in this period.")).toBeTruthy();

    mockDashboardData = buildDashboardData();
    view.rerender(renderPage());

    expect(
      screen
        .getByRole("tab", { name: "Categories" })
        .getAttribute("aria-selected")
    ).toBe("true");
    expect(screen.getByTestId("full-category-table")).toBeTruthy();
  });

  it("shows Sources only for meaningful owner data and falls back when it disappears", async () => {
    mockDashboardData = buildDashboardData({ sourceData: true });
    const renderPage = () =>
      createElement(DashboardClientPage, {
        workspaceId: "workspace-1",
        dateRange: { preset: "30d", from: null, to: null },
      });
    const view = render(renderPage());

    selectTab("Sources and labels");
    expect(screen.getByTestId("advertisement")).toBeTruthy();
    expect(screen.queryByTestId("internal-labels")).toBeNull();

    mockDashboardData = buildDashboardData({ sourceData: false });
    view.rerender(renderPage());

    await waitFor(() =>
      expect(
        screen.queryByRole("tab", { name: "Sources and labels" })
      ).toBeNull()
    );
    expect(
      screen
        .getByRole("tab", { name: "Overview" })
        .getAttribute("aria-selected")
    ).toBe("true");
    expect(screen.getByTestId("overview-content")).toBeTruthy();

    mockDashboardData = buildDashboardData({ sourceData: true });
    view.rerender(renderPage());

    expect(
      screen
        .getByRole("tab", { name: "Overview" })
        .getAttribute("aria-selected")
    ).toBe("true");
  });

  it("preserves a valid non-source tab when source availability changes", () => {
    mockDashboardData = buildDashboardData({ sourceData: true });
    const renderPage = () =>
      createElement(DashboardClientPage, {
        workspaceId: "workspace-1",
        dateRange: { preset: "30d", from: null, to: null },
      });
    const view = render(renderPage());

    selectTab("Categories");
    expect(
      screen
        .getByRole("tab", { name: "Categories" })
        .getAttribute("aria-selected")
    ).toBe("true");

    mockDashboardData = buildDashboardData({ sourceData: false });
    view.rerender(renderPage());
    expect(
      screen
        .getByRole("tab", { name: "Categories" })
        .getAttribute("aria-selected")
    ).toBe("true");

    mockDashboardData = buildDashboardData({ sourceData: true });
    view.rerender(renderPage());
    expect(
      screen
        .getByRole("tab", { name: "Categories" })
        .getAttribute("aria-selected")
    ).toBe("true");
  });

  it("retains stale data with a localized retry action that calls SWR mutate", () => {
    mockDashboardError = new Error("HTTP 503 provider details");
    render(
      createElement(DashboardClientPage, {
        workspaceId: "workspace-1",
        dateRange: { preset: "30d", from: null, to: null },
      })
    );

    expect(screen.getByTestId("overview-content")).toBeTruthy();
    expect(screen.getByText("Dashboard unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry dashboard" }));
    expect(mockMutate).toHaveBeenCalledTimes(1);
  });

  it("uses the full error state only when there is no stale data", () => {
    mockDashboardData = undefined;
    mockDashboardError = new Error("HTTP 503 provider details");
    render(
      createElement(DashboardClientPage, {
        workspaceId: "workspace-1",
        dateRange: { preset: "30d", from: null, to: null },
      })
    );

    expect(screen.getByText("Dashboard unavailable")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("detects a fully empty current period even when the prior period had volume", () => {
    mockDashboardData = buildDashboardData({ currentTotal: 0 });
    render(
      createElement(DashboardClientPage, {
        workspaceId: "workspace-1",
        dateRange: { preset: "30d", from: null, to: null },
      })
    );

    expect(screen.getByText("No activity in this period.")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("suppresses comparison presentation without discarding the fetched prior data", () => {
    render(
      createElement(DashboardClientPage, {
        workspaceId: "workspace-1",
        dateRange: { preset: "30d", from: null, to: null },
        comparisonEnabled: false,
      })
    );

    expect(
      screen
        .getByTestId("overview-content")
        .getAttribute("data-comparison-enabled")
    ).toBe("false");
    expect(mockDashboardData?.dailySeries.previous).toHaveLength(1);
  });
});
