/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import { SWRConfig } from "swr";

import russianCatalog from "../../../../messages/analytics/ru/page.json";
import type { AgentPerformanceResponse } from "@/types/performance";
import PerformancePage from "./performance-route";

jest.mock("next-intl", () =>
  jest
    .requireActual("@/test-support/next-intl-test-utils")
    .createMessagesNextIntlMock()
);

jest.mock("next/navigation", () => ({
  useParams: () => ({ workspaceId: "workspace-1" }),
}));

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () =>
    function AgentPerformanceChartMock() {
      return <div data-testid="performance-chart" />;
    },
}));

jest.mock("@/components/analytics/analytics-layout", () => ({
  AnalyticsLayout: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
}));

jest.mock("@/components/dashboard/agent-leaderboard", () => ({
  AgentLeaderboard: () => <div data-testid="agent-leaderboard" />,
}));

jest.mock("@/components/dashboard/performance-insights", () => ({
  PerformanceInsights: () => <div data-testid="performance-insights" />,
}));

jest.mock("@/components/ui/page-header", () => ({
  PageHeader: ({
    title,
    description,
    secondaryAction,
  }: {
    title: string;
    description: string;
    secondaryAction?: ReactNode;
  }) => (
    <header>
      <h1>{title}</h1>
      <p>{description}</p>
      {secondaryAction}
    </header>
  ),
}));

jest.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => (
    <div role="listbox">{children}</div>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <div role="option" aria-selected="false" data-value={value}>
      {children}
    </div>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
  SelectValue: () => null,
}));

const successfulResponse: AgentPerformanceResponse = {
  agents: [
    {
      id: "agent-1",
      name: "Agent One",
      avatar_url: null,
      conversation_count: 4,
      total_conversation_count: 5,
      qa_coverage_rate: 80,
      low_qa_conversation_count: 0,
      overall_qa_score: 8,
      scores: { empathy: 8, clarity: 8, scriptAdherence: 8, resolution: 8 },
      trend: 1,
      trend_direction: "up",
      avg_response_time_sec: 20,
      avg_csat: 4.5,
    },
  ],
  summary: {
    days: 30,
    active_managers: 1,
    total_scored_conversations: 4,
    total_handled_conversations: 5,
    avg_qa_score: 8,
    qa_score_trend: 1,
    qa_coverage_rate: 80,
    avg_response_time_sec: 20,
    avg_csat: 4.5,
    managers_needing_attention: 0,
    improving_managers: 1,
    declining_managers: 0,
  },
  dimensions: [],
  coaching_priorities: [],
};

function response(payload: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 503,
    statusText: ok ? "OK" : "PROVIDER-STATUS-TEXT-KEEP",
    json: async () => payload,
  } as Response;
}

function renderLocalized(ui: ReactElement) {
  return render(
    <NextIntlClientProvider
      locale="ru"
      messages={{ PerformancePage: russianCatalog.PerformancePage }}
    >
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        {ui}
      </SWRConfig>
    </NextIntlClientProvider>
  );
}

describe("localized performance analytics route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders localized date ranges for a successful response", async () => {
    global.fetch = jest.fn(async () => response(successfulResponse));

    renderLocalized(<PerformancePage />);

    expect(await screen.findByTestId("performance-chart")).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "Последние 7 дней" })
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "Последние 30 дней" })
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "Последние 90 дней" })
    ).toBeTruthy();
  });

  it("renders a localized chart empty state", async () => {
    global.fetch = jest.fn(async () =>
      response({ ...successfulResponse, agents: [] })
    );

    renderLocalized(<PerformancePage />);

    expect(
      await screen.findByRole("heading", { name: "Недостаточно данных" })
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Соберите больше данных о диалогах, чтобы увидеть эффективность команды."
      )
    ).toBeTruthy();
  });

  it("owns the load failure summary and retries without promoting provider diagnostics", async () => {
    const fetchMock = jest.fn(async () =>
      response({ error: "PROVIDER-DIAGNOSTIC-KEEP" }, false)
    );
    global.fetch = fetchMock;

    renderLocalized(<PerformancePage />);

    expect(
      await screen.findByText("Не удалось загрузить данные об эффективности.")
    ).toBeTruthy();
    expect(screen.queryByText("PROVIDER-DIAGNOSTIC-KEEP")).toBeNull();
    expect(screen.queryByText("PROVIDER-STATUS-TEXT-KEEP")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
