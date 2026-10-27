/**
 * @jest-environment jsdom
 */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import { SWRConfig } from "swr";
import russianCatalog from "../../../messages/analytics/ru/page.json";
import {
  AiriChatDailyHealthChart,
  FallbackActionsChart,
  LlmDailyTrendChart,
  LlmSpendDailyChart,
} from "./llm-analytics-charts";
import { LlmAnalyticsPage } from "./llm-analytics-page";

const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();
const russianChartDate = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium",
  timeZone: "UTC",
}).format(new Date("2026-07-31T00:00:00.000Z"));

jest.mock("next-intl", () => {
  const intl = jest.requireActual("@/test-support/next-intl-test-utils");

  const russianPlural = (
    count: number,
    one: string,
    few: string,
    many: string
  ) => {
    const modulo10 = count % 10;
    const modulo100 = count % 100;
    const noun =
      modulo10 === 1 && modulo100 !== 11
        ? one
        : [2, 3, 4].includes(modulo10) && ![12, 13, 14].includes(modulo100)
          ? few
          : many;
    return `${new Intl.NumberFormat("ru-RU").format(count)} ${noun}`;
  };

  const countMessages: Record<string, (count: number) => string> = {
    "LlmAnalytics.units.calls": count =>
      russianPlural(count, "вызов", "вызова", "вызовов"),
    "LlmAnalytics.units.tokens": count =>
      russianPlural(count, "токен", "токена", "токенов"),
    "LlmAnalytics.units.sampledEvaluations": count =>
      russianPlural(
        count,
        "выборочная оценка",
        "выборочные оценки",
        "выборочных оценок"
      ),
    "LlmAnalytics.units.observedCalls": count =>
      russianPlural(
        count,
        "наблюдаемый вызов",
        "наблюдаемых вызова",
        "наблюдаемых вызовов"
      ),
    "LlmAnalytics.units.openFindings": count =>
      russianPlural(
        count,
        "открытое замечание",
        "открытых замечания",
        "открытых замечаний"
      ),
    "LlmAnalytics.units.turns": count =>
      russianPlural(count, "ход", "хода", "ходов"),
  };

  return intl.createMessagesNextIntlMock({
    format: (
      message: string | undefined,
      values: Record<string, string | number> | undefined,
      { key }: { key: string }
    ) => {
      const formatCount = countMessages[key];
      if (formatCount && typeof values?.count === "number") {
        return formatCount(values.count);
      }
      if (message === undefined) return key;
      return intl.replacePassedValues(message, values);
    },
  });
});

jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () =>
    function DynamicChartMock() {
      return null;
    },
}));

jest.mock("recharts", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  type Series = {
    dataKey: string;
    name?: string;
    stroke?: string;
    fill?: string;
  };
  const ChartContext = React.createContext<{
    data: Record<string, unknown>[];
    series: Series[];
  }>({ data: [], series: [] });
  const Container = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  const Line = () => null;
  const Bar = () => null;
  const Chart = ({
    children,
    data,
  }: {
    children?: ReactNode;
    data: Record<string, unknown>[];
  }) => {
    const series = React.Children.toArray(children).flatMap(child =>
      React.isValidElement<Series>(child) &&
      (child.type === Line || child.type === Bar)
        ? [child.props]
        : []
    );
    return React.createElement(
      ChartContext.Provider,
      { value: { data, series } },
      children
    );
  };
  const XAxis = ({
    dataKey,
    tickFormatter,
  }: {
    dataKey?: string;
    tickFormatter?: (value: string) => string;
  }) => {
    const { data } = React.useContext(ChartContext);
    return React.createElement(
      "div",
      { "data-testid": `x-axis-${dataKey ?? "unknown"}` },
      data.map((row, index) =>
        React.createElement(
          "span",
          { key: index },
          tickFormatter?.(String(row[dataKey ?? ""]))
        )
      )
    );
  };
  const YAxis = ({
    tickFormatter,
  }: {
    tickFormatter?: (value: number) => string;
  }) =>
    React.createElement(
      "div",
      { "data-testid": "y-axis-value" },
      tickFormatter?.(12_345)
    );
  const Tooltip = ({
    content,
  }: {
    content?: ReactElement<Record<string, unknown>>;
  }) => {
    const { data, series } = React.useContext(ChartContext);
    const row = data[0];
    if (!content || !row) return null;
    return React.createElement(
      "div",
      { "data-testid": "tooltip-content" },
      React.cloneElement(content, {
        active: true,
        label: row.date ?? row.name,
        payload: series.map(item => ({
          dataKey: item.dataKey,
          name: item.name ?? item.dataKey,
          value: row[item.dataKey],
          color: item.stroke ?? item.fill,
          payload: row,
        })),
      })
    );
  };
  const Legend = ({
    content,
  }: {
    content?: ReactElement<Record<string, unknown>>;
  }) => {
    const { series } = React.useContext(ChartContext);
    return React.createElement(
      "div",
      { "data-testid": "chart-legend" },
      content
        ? React.cloneElement(content, {
            payload: series.map(item => ({
              dataKey: item.dataKey,
              value: item.name ?? item.dataKey,
              color: item.stroke ?? item.fill,
            })),
          })
        : null
    );
  };

  return {
    Bar,
    BarChart: Chart,
    CartesianGrid: Container,
    Legend,
    Line,
    LineChart: Chart,
    ResponsiveContainer: Container,
    Tooltip,
    XAxis,
    YAxis,
  };
});

const analyticsResponse = {
  days: 30,
  analytics: {
    totals: {
      safeConversationalReplies: 4,
      ragTurns: 8,
      groundedRecoveryUsage: 2,
      genericClarificationUsage: 1,
      lowConfidenceUnderstandingResults: 1,
    },
    rates: {
      groundedRecoveryRate: 25,
      genericClarificationRate: 12.5,
      lowConfidenceRate: 20,
      safeReplyShare: 30.8,
    },
    trends: [
      {
        date: "2026-07-31",
        safeConversationalReplies: 4,
        ragTurns: 8,
        groundedRecoveryUsage: 2,
        genericClarificationUsage: 1,
        lowConfidenceUnderstandingResults: 1,
      },
    ],
    breakdowns: {
      fallbackActions: [
        { name: "grounded_recovery", count: 2 },
        { name: "future_action", count: 1 },
      ],
      fallbackReasons: [{ name: "missing_knowledge_signal", count: 12_345 }],
      resultTypes: [
        { name: "ai_reply", count: 2 },
        { name: "future_result", count: 1 },
      ],
      channels: [{ name: "whatsapp", count: 3 }],
      safeReplyKinds: [{ name: "greeting", count: 2 }],
      lowConfidenceKinds: [{ name: "question", count: 1 }],
    },
    sampleInfo: { eventCount: 20, limited: false },
  },
  warehouse: {
    overview: {
      trace_count: 2,
      rag_turn_count: 1,
      error_count: 0,
      p95_latency_ms: 1_500,
      total_tokens: 5,
      rag_issue_count: 1,
    },
    modelBreakdown: [
      {
        provider: "PROVIDER-ID-KEEP",
        model: "MODEL-ID-KEEP",
        operation: "airi_chat.reply",
        calls: 2,
        total_tokens: 5,
        total_cost_usd: 12.5,
      },
    ],
    generationQuality: {
      rag_turn_count: 2,
      generation_quality_score: 87.25,
      groundedness_pct: 75,
      answer_relevance_pct: 80,
      guardrail_pass_pct: 100,
      eval_pass_pct: 50,
      eval_sampled_count: 2,
      answer_completeness_pct: 90,
      citation_coverage_pct: 60,
      toxicity_score_pct: 0,
      toxicity_violation_count: 0,
    },
    systemPerformance: {
      trace_count: 2,
      p95_latency_ms: 1_500,
      p99_latency_ms: 1_900,
      tokens_per_second: 3.5,
      output_tokens_per_second: 2.5,
      p95_time_to_first_token_ms: 250,
      time_to_first_token_note: "DIAGNOSTIC-NOTE-KEEP",
    },
    operationalEfficiency: {
      trace_count: 2,
      total_tokens: 5,
      error_rate_pct: 0,
      prompt_token_share_pct: 60,
      completion_token_share_pct: 40,
      cost_per_1k_tokens_usd: 0.25,
      semantic_cache_hit_rate_pct: 25,
      semantic_cache_observed_count: 2,
    },
    spend: {
      workspace: {
        overview: {
          trace_count: 2,
          total_cost_usd: 12.5,
          avg_cost_per_call: 6.25,
          total_tokens: 5,
        },
        daily: [],
        byOperation: [
          {
            operation: "airi_chat.reply",
            calls: 2,
            total_tokens: 5,
            total_cost_usd: 12.5,
          },
        ],
      },
      company: null,
      pricingVersion: "PRICING-ID-KEEP",
    },
    airiChats: {
      overview: {
        trace_count: 2,
        rag_turn_count: 3,
        no_context_turn_count: 1,
        total_cost_usd: 0.5,
      },
      daily: [],
      issues: [],
      qualityScore: null,
    },
    source: "bigquery" as const,
    generatedAt: "2026-07-31T12:00:00.000Z",
    errors: ["BIGQUERY-DIAGNOSTIC-KEEP"],
  },
};

const reviewItems = [
  {
    id: "review-1",
    issueType: "knowledge_gap",
    severity: "high",
    title: "CUSTOMER-FINDING-TITLE-KEEP",
    summary: "rag turn took 1500ms, above the 1000ms target",
    inputExcerpt: "CUSTOMER-INPUT-KEEP",
    outputExcerpt: "CUSTOMER-REPLY-KEEP",
    suggestedFix: { type: "knowledge_base_update", title: "FIX-TITLE-KEEP" },
  },
  {
    id: "review-2",
    issueType: "future_issue",
    severity: "future_severity",
    title: "SECOND-FINDING-KEEP",
    summary: "RAW-DIAGNOSTIC-SUMMARY-KEEP",
    inputExcerpt: null,
    outputExcerpt: null,
    suggestedFix: null,
  },
];

function jsonResponse(payload: unknown, ok = true): Response {
  return {
    ok,
    json: async () => payload,
  } as Response;
}

function renderLocalized(ui: ReactElement) {
  return render(
    <NextIntlClientProvider
      locale="ru"
      messages={{ LlmAnalytics: russianCatalog.LlmAnalytics }}
      timeZone="UTC"
    >
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        {ui}
      </SWRConfig>
    </NextIntlClientProvider>
  );
}

function installFetchMock(fetchMock: jest.Mock) {
  global.fetch = fetchMock as typeof fetch;
  Object.defineProperty(window, "fetch", {
    configurable: true,
    writable: true,
    value: fetchMock,
  });
}

describe("localized LLM analytics page", () => {
  let reviewUpdateResponse: "diagnostic" | "malformed";

  beforeEach(() => {
    reviewUpdateResponse = "diagnostic";
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/analytics/llm")) {
          return jsonResponse(analyticsResponse);
        }
        if (url.includes("/api/ai-quality/review-items?") && !init?.method) {
          return jsonResponse({ items: reviewItems });
        }
        if (url.endsWith("/review-1") && init?.method === "PATCH") {
          return jsonResponse({ regressionCaseId: "regression-1" });
        }
        if (url.endsWith("/review-2") && init?.method === "PATCH") {
          if (reviewUpdateResponse === "malformed") {
            return {
              ok: false,
              json: async () => {
                throw new SyntaxError("Unexpected token");
              },
            } as unknown as Response;
          }
          return jsonResponse(
            { error: " \tPROVIDER-UPDATE-DIAGNOSTIC-KEEP \n" },
            false
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    global.fetch = fetchMock as typeof fetch;
    Object.defineProperty(window, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("localizes the complete warehouse, quality, health, and review experience", async () => {
    renderLocalized(<LlmAnalyticsPage workspaceId="workspace-1" />);

    expect(
      await screen.findByRole("heading", {
        name: russianCatalog.LlmAnalytics.quality.title,
      })
    ).toBeTruthy();
    expect(screen.getAllByText("Ответ в чате Airi").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2 вызова").length).toBeGreaterThan(0);
    expect(screen.getAllByText("5 токенов").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1,5 с").length).toBeGreaterThan(0);
    expect(screen.getByText("Качество генерации")).toBeTruthy();
    expect(screen.getByText("2 выборочные оценки")).toBeTruthy();
    expect(screen.getByText("2 наблюдаемых вызова")).toBeTruthy();
    expect(
      screen.getByText("Данных о состоянии чата Airi по дням пока нет.")
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Предупреждений о контексте чата Airi за этот период нет."
      )
    ).toBeTruthy();

    expect(
      screen.getByText("Некоторые метрики хранилища временно недоступны.")
    ).toBeTruthy();
    expect(screen.getByText("BIGQUERY-DIAGNOSTIC-KEEP")).toBeTruthy();
    expect(screen.getAllByText("Техническая деталь").length).toBeGreaterThan(0);
    expect(screen.getByText("DIAGNOSTIC-NOTE-KEEP")).toBeTruthy();
    expect(screen.getByText("PROVIDER-ID-KEEP")).toBeTruthy();
    expect(screen.getByText("MODEL-ID-KEEP")).toBeTruthy();

    expect(screen.getByText("Очередь проверки")).toBeTruthy();
    expect(screen.getByText("2 открытых замечания")).toBeTruthy();
    expect(screen.getByText("Пробел в знаниях")).toBeTruthy();
    expect(screen.getByText("Высокая")).toBeTruthy();
    expect(
      screen.getByText("Неизвестное значение (future_issue)")
    ).toBeTruthy();
    expect(
      screen.getByText("Неизвестное значение (future_severity)")
    ).toBeTruthy();
    expect(screen.getByText("CUSTOMER-FINDING-TITLE-KEEP")).toBeTruthy();
    expect(screen.getByText("CUSTOMER-REPLY-KEEP")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Решение" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Решить" })).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: "Игнорировать" })
    ).toHaveLength(2);

    expect(
      screen.getByText("Неизвестное значение (future_result)")
    ).toBeTruthy();
    expect(screen.queryByText("Future Result")).toBeNull();
    expect(
      screen.getByText(value => value.replace(/\s/g, " ") === "12 345")
    ).toBeTruthy();
  });

  it("localizes review prompts and success and error toasts", async () => {
    const promptMock = jest
      .spyOn(window, "prompt")
      .mockReturnValueOnce("EXPLANATION-KEEP")
      .mockReturnValue("0.8");
    renderLocalized(<LlmAnalyticsPage workspaceId="workspace-1" />);

    const resolveButtons = await screen.findAllByRole("button", {
      name: "Решить",
    });
    fireEvent.click(resolveButtons[0]);

    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith(
        "Замечание решено и добавлено в регрессионные сценарии"
      )
    );
    expect(promptMock).toHaveBeenCalledWith(
      "Объяснение судьи: почему ответ получил такую оценку?",
      "FIX-TITLE-KEEP"
    );
    expect(promptMock).toHaveBeenCalledWith(
      "Оценка «Релевантность» (0–1, оставьте пустым, чтобы пропустить)",
      ""
    );

    const ignoreButtons = await screen.findAllByRole("button", {
      name: "Игнорировать",
    });
    fireEvent.click(ignoreButtons[1]);

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "Не удалось обновить замечание",
        {
          description:
            "Техническая деталь:  \tPROVIDER-UPDATE-DIAGNOSTIC-KEEP \n",
        }
      )
    );
  });

  it("uses only the localized generic update error for malformed responses", async () => {
    reviewUpdateResponse = "malformed";
    renderLocalized(<LlmAnalyticsPage workspaceId="workspace-1" />);

    const ignoreButtons = await screen.findAllByRole("button", {
      name: "Игнорировать",
    });
    fireEvent.click(ignoreButtons[1]);

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "Не удалось обновить замечание"
      )
    );
  });

  it("does not expose an internal fallback code for a non-JSON analytics error", async () => {
    installFetchMock(
      jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/analytics/llm")) {
          return {
            ok: false,
            json: async () => {
              throw new SyntaxError("Unexpected token");
            },
          } as unknown as Response;
        }
        if (url.includes("/api/ai-quality/review-items?")) {
          return jsonResponse({ items: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );

    const { container } = renderLocalized(
      <LlmAnalyticsPage workspaceId="workspace-malformed" />
    );

    expect(
      await screen.findByText("Не удалось загрузить аналитику LLM")
    ).toBeTruthy();
    expect(container.textContent).not.toContain("llm_analytics_load_failed");
  });

  it("does not expose an internal fallback code for a non-JSON review error", async () => {
    installFetchMock(
      jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/analytics/llm")) {
          return jsonResponse(analyticsResponse);
        }
        if (url.includes("/api/ai-quality/review-items?")) {
          return {
            ok: false,
            json: async () => {
              throw new SyntaxError("Unexpected token");
            },
          } as unknown as Response;
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );

    const { container } = renderLocalized(
      <LlmAnalyticsPage workspaceId="workspace-malformed-review" />
    );

    expect(
      await screen.findByText("Не удалось загрузить замечания.")
    ).toBeTruthy();
    expect(container.textContent).not.toContain("review_items_load_failed");
  });
});

describe("localized LLM analytics charts", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const countCharts = [
    ["health", "Ответы"],
    ["trend", "RAG-ходы"],
    ["fallback", "События"],
  ] as const;

  const renderCountChart = (
    chart: (typeof countCharts)[number][0],
    value: number
  ) =>
    renderLocalized(
      chart === "health" ? (
        <AiriChatDailyHealthChart
          data={[
            {
              date: "2026-07-31",
              rag_turn_count: value,
              grounded_turn_count: 2,
              no_context_turn_count: 1,
            },
          ]}
        />
      ) : chart === "trend" ? (
        <LlmDailyTrendChart
          data={[
            {
              date: "2026-07-31",
              ragTurns: value,
              groundedRecoveryUsage: 2,
              genericClarificationUsage: 1,
              safeConversationalReplies: 3,
              lowConfidenceUnderstandingResults: 0,
            },
          ]}
        />
      ) : (
        <FallbackActionsChart
          data={[{ name: "grounded_recovery", count: value }]}
        />
      )
    );

  it("localizes health series and fallback action labels", () => {
    renderLocalized(
      <>
        <AiriChatDailyHealthChart
          data={[
            {
              date: "2026-07-31",
              rag_turn_count: 4,
              grounded_turn_count: 2,
              no_context_turn_count: 1,
            },
          ]}
        />
        <FallbackActionsChart
          data={[
            { name: "grounded_recovery", count: 2 },
            { name: "future_action", count: 1 },
          ]}
        />
      </>
    );

    const legend = within(screen.getByTestId("chart-legend"));
    expect(legend.getByText("Ответы")).toBeTruthy();
    expect(legend.getByText("Обоснованные")).toBeTruthy();
    expect(legend.getByText("Без контекста")).toBeTruthy();
    const fallbackAxis = within(screen.getByTestId("x-axis-name"));
    expect(fallbackAxis.getByText("Восстановление из контекста")).toBeTruthy();
    expect(
      fallbackAxis.getByText("Неизвестное значение (future_action)")
    ).toBeTruthy();
    expect(screen.queryByText("Answers")).toBeNull();
  });

  it("formats spend dates and values with the active locale", () => {
    renderLocalized(
      <LlmSpendDailyChart
        data={[{ date: "2026-07-31", total_cost_usd: 12_345 }]}
      />
    );

    expect(screen.getByTestId("x-axis-date").textContent).toBe(
      russianChartDate
    );
    expect(screen.getByTestId("y-axis-value").textContent).toContain("12");
    expect(screen.getByTestId("y-axis-value").textContent).toContain("$");
    const tooltip = within(screen.getByTestId("tooltip-content"));
    expect(tooltip.getByText(russianChartDate)).toBeTruthy();
    const formattedSpend = new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(12_345);
    expect(
      tooltip.getByText(
        value =>
          value.replace(/\s/g, " ") === formattedSpend.replace(/\s/g, " ")
      )
    ).toBeTruthy();
  });

  it("formats health and fallback axes and tooltips with the active locale", () => {
    const health = renderCountChart("health", 12_345);

    expect(screen.getByTestId("x-axis-date").textContent).toBe(
      russianChartDate
    );
    expect(
      screen.getByTestId("y-axis-value").textContent?.replace(/\s/g, " ")
    ).toBe("12 345");
    const healthTooltip = within(screen.getByTestId("tooltip-content"));
    expect(healthTooltip.getByText(russianChartDate)).toBeTruthy();
    expect(
      healthTooltip.getByText(value => value.replace(/\s/g, " ") === "12 345")
    ).toBeTruthy();

    health.unmount();
    renderCountChart("fallback", 12_345);
    expect(
      screen.getByTestId("y-axis-value").textContent?.replace(/\s/g, " ")
    ).toBe("12 345");
    const fallbackTooltip = within(screen.getByTestId("tooltip-content"));
    expect(
      fallbackTooltip.getByText("Восстановление из контекста")
    ).toBeTruthy();
    expect(
      fallbackTooltip.getByText(value => value.replace(/\s/g, " ") === "12 345")
    ).toBeTruthy();
  });

  it.each(countCharts)(
    "formats zero through the %s numeric tooltip row",
    (chart, label) => {
      renderCountChart(chart, 0);

      const tooltip = within(screen.getByTestId("tooltip-content"));
      expect(tooltip.getByText(label)).toBeTruthy();
      expect(
        tooltip.getByText("0", { selector: "span.tabular-nums" })
      ).toBeTruthy();
    }
  );

  it.each(countCharts)(
    "uses the selected Russian locale for %s counts when the browser default is English",
    (chart, label) => {
      const originalToLocaleString = Number.prototype.toLocaleString;
      jest
        .spyOn(Number.prototype, "toLocaleString")
        .mockImplementation(function (
          this: number,
          ...args: Parameters<number["toLocaleString"]>
        ) {
          return args.length
            ? originalToLocaleString.apply(this, args)
            : originalToLocaleString.call(this, "en-US");
        });
      renderCountChart(chart, 12_345);

      const tooltip = within(screen.getByTestId("tooltip-content"));
      expect(tooltip.getByText(label)).toBeTruthy();
      expect(
        tooltip.getByText(value => value.replace(/\s/g, " ") === "12 345")
      ).toBeTruthy();
      expect(tooltip.queryByText("12,345")).toBeNull();
    }
  );

  it("preserves a missing health count without inventing a zero", () => {
    renderLocalized(
      <AiriChatDailyHealthChart
        data={[{ date: "2026-07-31", rag_turn_count: null }]}
      />
    );

    const tooltip = within(screen.getByTestId("tooltip-content"));
    expect(tooltip.getByText("Ответы")).toBeTruthy();
    expect(tooltip.queryByText("0")).toBeNull();
  });
});
