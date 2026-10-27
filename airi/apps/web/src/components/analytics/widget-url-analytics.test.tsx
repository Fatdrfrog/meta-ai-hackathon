/**
 * @jest-environment jsdom
 */

import type { WidgetAnalytics } from "@/app/actions/widget-analytics";
import { getWidgetAnalytics } from "@/app/actions/widget-analytics";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import kazakhAnalytics from "../../../messages/analytics/kz/page.json";
import russianAnalytics from "../../../messages/analytics/ru/page.json";
import { WidgetUrlAnalytics } from "./widget-url-analytics";

jest.mock("@/app/actions/widget-analytics", () => ({
  getWidgetAnalytics: jest.fn(),
}));

jest.mock("next-intl", () => {
  const intl = jest.requireActual("@/test-support/next-intl-test-utils");
  return intl.createMessagesNextIntlMock({ format: intl.fillPassedValues });
});

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () =>
    function DynamicLineChartMock({
      data,
      emptyLabel,
      valueLabel,
      formatValue,
    }: {
      data: Array<{ value: number }>;
      emptyLabel: string;
      valueLabel: string;
      formatValue?: (value: number) => string;
    }) {
      const value = data[0]?.value ?? 0;
      return (
        <div data-empty-label={emptyLabel} data-testid="widget-line-chart">
          {valueLabel}: {formatValue?.(value) ?? value}
        </div>
      );
    },
}));

const analyticsFixture: WidgetAnalytics = {
  source: {
    id: "source-1",
    name: "RAW Widget name",
    installedAt: "2026-07-01T12:00:00.000Z",
    status: "unknown",
    allowedDomains: ["RAW.Example.COM"],
    airiEnabled: true,
    helpTabEnabled: true,
    autoOpen: true,
    position: "bottom-left",
  },
  conversations: {
    totalConversations: 25,
    totalMessages: 50,
    uniquePages: 1,
    activeToday: 2,
    topPages: [],
  },
  analytics: {
    pageviews: 1234,
    sessions: 100,
    avgSessionDuration: 90,
    bounceRate: 0,
    topPages: [],
    trafficSources: [{ source: "RAW Referral", visitors: 8, percentage: 12.5 }],
    devices: { desktop: 5, mobile: 3, tablet: 0 },
    timeSeriesData: [{ date: "2026-07-31", pageviews: 1234.5 }],
  },
  pages: [
    {
      url: "https://RAW.Example.COM/Offers?Plan=VIP",
      views: 40,
      conversations: 5,
      lastActive: "2026-07-31T12:00:00.000Z",
      startRate: 12.5,
    },
  ],
  summary: { chatStartRate: 12.5, returningVisitorRate: 12.5 },
  websiteAnalyticsStatus: { state: "ready" },
  engagement: {
    statusBreakdown: { open: 5, in_progress: 3, closed: 2 },
    sentimentBreakdown: { positive: 4, neutral: 3, negative: 1 },
    avgResponseTimeSec: 3660,
    avgMessagesPerConversation: 2.5,
    avgCsat: 4.5,
    csatCount: 2,
    returningVisitors: 2,
    uniqueVisitors: 8,
    conversationsByDay: [],
    topCategories: [{ name: "RAW Category / VIP", count: 5 }],
  },
};

const catalogs = {
  kz: { WidgetAnalytics: kazakhAnalytics.WidgetAnalytics },
  ru: { WidgetAnalytics: russianAnalytics.WidgetAnalytics },
};

function renderLocalized(
  analytics: WidgetAnalytics,
  locale: keyof typeof catalogs = "ru"
) {
  const { NextIntlClientProvider } = jest.requireMock("next-intl") as {
    NextIntlClientProvider: React.ComponentType<{
      children: ReactNode;
      locale: string;
      messages: Record<string, unknown>;
    }>;
  };

  jest.mocked(getWidgetAnalytics).mockResolvedValue({ data: analytics });

  return render(
    <NextIntlClientProvider locale={locale} messages={catalogs[locale]}>
      <WidgetUrlAnalytics workspaceId={`workspace-${locale}`} />
    </NextIntlClientProvider>
  );
}

describe("WidgetUrlAnalytics localization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("formats Russian durations, percentages, chart series, and localized source values", async () => {
    renderLocalized(analyticsFixture);

    expect(await screen.findByText("1 мин 30 с")).toBeTruthy();
    expect(screen.getByText("1 ч 1 мин")).toBeTruthy();
    expect(screen.getAllByText(/12,5\s%/).length).toBeGreaterThan(0);
    expect(screen.getByText("Слева внизу")).toBeTruthy();
    expect(screen.getByText("Неизвестно")).toBeTruthy();

    const chart = screen.getByTestId("widget-line-chart");
    expect(chart.getAttribute("data-empty-label")).toBe(
      "Нет данных для графика"
    );
    expect(chart.textContent).toMatch(/Просмотры: 1[\s\u00a0]234,5/);

    expect(screen.getByText("RAW Category / VIP")).toBeTruthy();

    const sourceCard = screen
      .getByText("Настройка виджета")
      .closest('[data-slot="card"]');
    expect(sourceCard).not.toBeNull();
    expect(
      within(sourceCard as HTMLElement).getByText("RAW.Example.COM")
    ).toBeTruthy();
  });

  it("localizes the server unknown page sentinel", async () => {
    renderLocalized({
      ...analyticsFixture,
      pages: [{ ...analyticsFixture.pages[0], url: "unknown" }],
    });

    const pagesCard = (await screen.findByText("Страницы")).closest(
      '[data-slot="card"]'
    );
    expect(pagesCard).not.toBeNull();
    expect(
      within(pagesCard as HTMLElement).getByText("Неизвестно")
    ).toBeTruthy();
    expect(within(pagesCard as HTMLElement).queryByText("unknown")).toBeNull();
  });

  it.each([
    ["bottom-left", "Слева внизу"],
    ["bottom-right", "Справа внизу"],
    ["unknown", "Неизвестно"],
  ] as const)(
    "localizes the %s source position",
    async (position, expected) => {
      renderLocalized({
        ...analyticsFixture,
        source: analyticsFixture.source
          ? { ...analyticsFixture.source, position }
          : null,
      });

      expect((await screen.findAllByText(expected)).length).toBeGreaterThan(0);
    }
  );

  it("maps kz to kk-KZ only for Intl presentation formatting", async () => {
    renderLocalized(analyticsFixture, "kz");

    expect(await screen.findByText("1 мин 30 с")).toBeTruthy();
    expect(screen.getAllByText("12,5%").length).toBeGreaterThan(0);
    expect(screen.getByTestId("widget-line-chart").textContent).toMatch(
      /Қаралымдар: 1[\s\u00a0]234,5/
    );
  });

  it("shows a localized provider outage without claiming there is no traffic", async () => {
    renderLocalized({
      ...analyticsFixture,
      conversations: {
        ...analyticsFixture.conversations,
        totalConversations: 0,
        totalMessages: 0,
      },
      websiteAnalyticsStatus: { state: "unavailable", reason: "query_failed" },
    });
    expect(await screen.findByText("Веб-аналитика недоступна")).toBeTruthy();
    expect(
      screen.getByText(
        "Не удалось загрузить метрики сайта. Обновите страницу, чтобы повторить попытку. Метрики диалогов доступны."
      )
    ).toBeTruthy();
    expect(
      screen.queryByText(russianAnalytics.WidgetAnalytics.noDataAvailable)
    ).toBeNull();
    expect(screen.queryByTestId("widget-line-chart")).toBeNull();
    expect(screen.queryByText("1 мин 30 с")).toBeNull();
    const pageRow = screen.getByText("/Offers?Plan=VIP").closest("tr");
    expect(pageRow).not.toBeNull();
    const cells = within(pageRow as HTMLElement).getAllByRole("cell");
    expect(cells[1].textContent).toBe("-");
    expect(cells[2].textContent).toBe("5");
    expect(cells[3].textContent).toBe("-");
  });

  it("renders an owned localized error instead of a provider diagnostic", async () => {
    const providerDiagnostic = "PROVIDER_DIAGNOSTIC_RAW_451";
    const { NextIntlClientProvider } = jest.requireMock("next-intl") as {
      NextIntlClientProvider: React.ComponentType<{
        children: ReactNode;
        locale: string;
        messages: Record<string, unknown>;
      }>;
    };
    jest.mocked(getWidgetAnalytics).mockResolvedValue({
      data: null,
      error: providerDiagnostic,
    });

    render(
      <NextIntlClientProvider locale="ru" messages={catalogs.ru}>
        <WidgetUrlAnalytics workspaceId="workspace-error" />
      </NextIntlClientProvider>
    );

    expect(
      await screen.findByText("Не удалось загрузить аналитику виджета.")
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByText(providerDiagnostic)).toBeNull()
    );
  });
});
