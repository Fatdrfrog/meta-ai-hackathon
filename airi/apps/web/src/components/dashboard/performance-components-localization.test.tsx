/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import type {
  AgentPerformance,
  CoachingPriority,
  DimensionHealth,
  TeamPerformanceSummary,
} from "@/types/performance";
import { AgentLeaderboard } from "./agent-leaderboard";
import { AgentPerformanceChart } from "./agent-performance-chart";
import { PerformanceInsights } from "./performance-insights";

type TestLocale = "en" | "kz" | "ru";
type TranslationValues = Record<string, number | string>;

let mockLocale: TestLocale = "ru";
const STATIC_MESSAGES: Record<string, string> = {
  "PerformancePage.dimensions.empathy": "Эмпатия",
  "PerformancePage.dimensions.clarity": "Ясность",
  "PerformancePage.dimensions.scriptAdherence": "Соблюдение скрипта",
  "PerformancePage.dimensions.resolution": "Решение",
  "PerformancePage.insights.noTrendYet": "Тренда пока нет",
  "PerformancePage.insights.summary.teamQaScore": "Оценка QA команды",
  "PerformancePage.insights.summary.noPreviousPeriod":
    "Нет предыдущего периода для сравнения",
  "PerformancePage.insights.summary.qaCoverage": "Покрытие QA",
  "PerformancePage.insights.summary.managersNeedingSupport":
    "Менеджеры, которым нужна поддержка",
  "PerformancePage.insights.summary.averageResponseTime":
    "Среднее время ответа",
  "PerformancePage.insights.summary.responseTimeDescription":
    "По метрикам взаимодействий в оценённых диалогах",
  "PerformancePage.insights.summary.averageCsat": "Средний CSAT",
  "PerformancePage.insights.summary.csatDescription":
    "Только диалоги с оценкой CSAT",
  "PerformancePage.insights.summary.activeManagers": "Активные менеджеры",
  "PerformancePage.insights.dimensions.title": "Состояние показателей QA",
  "PerformancePage.insights.dimensions.description":
    "Сильные стороны команды и навыки для развития.",
  "PerformancePage.insights.dimensions.empty":
    "Данных по показателям пока недостаточно.",
  "PerformancePage.insights.dimensions.best": "Лучший результат",
  "PerformancePage.insights.dimensions.needsCoaching": "Нужен коучинг",
  "PerformancePage.insights.coaching.title": "Приоритеты коучинга",
  "PerformancePage.insights.coaching.description":
    "Возможности с наибольшим влиянием по оценке, тренду и объёму.",
  "PerformancePage.insights.coaching.empty":
    "За этот период приоритеты коучинга не выявлены.",
  "PerformancePage.insights.coaching.focus": "Фокус",
  "PerformancePage.insights.coaching.risk": "Риск",
  "PerformancePage.leaderboard.title": "Рейтинг менеджеров",
  "PerformancePage.leaderboard.agent": "Менеджер",
  "PerformancePage.leaderboard.dialogsProcessed": "Обработано диалогов",
  "PerformancePage.leaderboard.qaCoverage": "Покрытие QA",
  "PerformancePage.leaderboard.avgResponse": "Средний ответ",
  "PerformancePage.leaderboard.avgQaScore": "Средняя оценка QA",
  "PerformancePage.leaderboard.emptyTitle": "Данных об эффективности пока нет.",
  "PerformancePage.leaderboard.emptyDescription":
    "Менеджеры появятся здесь после оценённых диалогов.",
  "PerformancePage.leaderboard.scoreBreakdown": "Разбивка оценки",
  "PerformancePage.leaderboard.csat": "CSAT",
  "PerformancePage.leaderboard.lowQaConversations": "Диалоги с низким QA",
  "PerformancePage.performanceChart.title": "Сравнение оценок QA",
  "PerformancePage.performanceChart.singleAgentTitle": "Пока один менеджер",
  "PerformancePage.performanceChart.singleAgentDescription":
    "Добавьте ещё одного менеджера для сравнения.",
  "PerformancePage.performanceChart.description":
    "Сравнение команды со средним и целевым уровнем QA.",
  "PerformancePage.performanceChart.qaScore": "Оценка QA",
  "PerformancePage.performanceChart.scoredConversations": "Оценённые диалоги",
  "PerformancePage.performanceChart.teamAverage": "Команда",
  "PerformancePage.performanceChart.target": "Цель",
  "PerformancePage.duration.missing": "—",
};

function translate(
  namespace: string,
  key: string,
  values: TranslationValues = {}
): string {
  const path = `${namespace}.${key}`;
  if (path === "PerformancePage.duration.seconds") {
    return `${values.value} сек.`;
  }
  if (path === "PerformancePage.duration.minutes") {
    return `${values.value} мин.`;
  }
  if (path === "PerformancePage.duration.hours") {
    return `${values.value} ч.`;
  }
  if (path === "PerformancePage.insights.summary.vsPreviousPeriod") {
    return `${values.value} к предыдущему периоду`;
  }
  if (path === "PerformancePage.insights.summary.scoredOfHandled") {
    return `${values.scored} оценено из ${values.handled}`;
  }
  if (path === "PerformancePage.insights.summary.managerTrends") {
    if (
      typeof values.improving !== "number" ||
      typeof values.declining !== "number"
    ) {
      return "MANAGER-TREND-COUNTS-MUST-BE-NUMERIC";
    }
    return `${values.improving} менеджер улучшает результат, ${values.declining} менеджер снижает результат`;
  }
  if (path === "PerformancePage.insights.summary.lastDays") {
    return `Последние ${values.count} дней`;
  }
  if (path === "PerformancePage.insights.coaching.summary") {
    return `QA ${values.score} из 10 · ${values.count} оценённых диалогов`;
  }
  if (path === "PerformancePage.leaderboard.previousPeriodComparison") {
    return `${values.value} к предыдущему периоду`;
  }
  if (path === "PerformancePage.performanceChart.conversationsShort") {
    return `${values.count} диал.`;
  }
  if (path === "PerformancePage.performanceChart.teamAverage") {
    return `Команда ${values.value}`;
  }
  if (path === "PerformancePage.performanceChart.target") {
    return `Цель ${values.value}`;
  }
  if (path === "PerformancePage.units.scoreOutOfTen") {
    return `${values.value} из 10`;
  }
  if (path === "PerformancePage.units.scoreOutOfFive") {
    return `${values.value} из 5`;
  }
  if (path === "PerformancePage.units.percent") {
    return `${values.value} %`;
  }

  const message = STATIC_MESSAGES[path];
  if (!message) throw new Error(`Missing test translation: ${path}`);
  return message;
}

jest.mock("next-intl", () => ({
  useLocale: () => mockLocale,
  useTranslations:
    (namespace: string) => (key: string, values?: TranslationValues) =>
      translate(namespace, key, values),
}));

jest.mock("framer-motion", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    motion: {
      tr: ({
        initial: _initial,
        animate: _animate,
        transition: _transition,
        ...props
      }: Record<string, unknown>) => React.createElement("tr", props),
    },
  };
});

jest.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

jest.mock("@/components/ui/chart", () => ({
  ChartContainer: ({
    children,
    config,
  }: {
    children: ReactNode;
    config: Record<string, { label?: ReactNode }>;
  }) => (
    <div>
      {Object.entries(config).map(([key, value]) => (
        <span key={key}>{value.label}</span>
      ))}
      {children}
    </div>
  ),
  ChartTooltip: ({
    children,
    content,
  }: {
    children?: ReactNode;
    content?: ReactNode;
  }) => <div>{content ?? children}</div>,
  ChartTooltipContent: ({
    formatter,
  }: {
    formatter: (
      value: number,
      name: string,
      item: { payload: { conversation_count: number } }
    ) => ReactNode;
  }) => (
    <div>
      {formatter(8.4, "overall_qa_score", {
        payload: { conversation_count: 2 },
      })}
    </div>
  ),
}));

jest.mock("recharts", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const Container = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  return {
    Bar: Container,
    BarChart: Container,
    CartesianGrid: Container,
    ReferenceLine: ({
      y,
      stroke,
      strokeDasharray,
      label,
    }: {
      y?: number;
      stroke?: string;
      strokeDasharray?: string;
      label?: { value?: ReactNode; fill?: string };
    }) => (
      <svg data-testid="performance-benchmark" data-reference={y}>
        <line
          x1="0"
          x2="100"
          y1={y}
          y2={y}
          stroke={stroke}
          strokeDasharray={strokeDasharray}
        />
        <text fill={label?.fill}>{label?.value}</text>
      </svg>
    ),
    XAxis: Container,
    YAxis: Container,
  };
});

const agents: AgentPerformance[] = [
  {
    id: "agent-1",
    name: "Provider Name Keep",
    avatar_url: null,
    conversation_count: 2,
    total_conversation_count: 3,
    qa_coverage_rate: 66.7,
    low_qa_conversation_count: 1,
    overall_qa_score: 8.4,
    scores: {
      empathy: 8.2,
      clarity: 8.3,
      scriptAdherence: 8.4,
      resolution: 8.5,
    },
    trend: 1.5,
    trend_direction: "up",
    avg_response_time_sec: 90,
    avg_csat: 4.4,
  },
  {
    id: "agent-2",
    name: "Second Provider Keep",
    avatar_url: null,
    conversation_count: 1,
    total_conversation_count: 1,
    qa_coverage_rate: 100,
    low_qa_conversation_count: 0,
    overall_qa_score: 7.2,
    scores: null,
    trend: null,
    trend_direction: null,
    avg_response_time_sec: 30,
    avg_csat: null,
  },
];

const summary: TeamPerformanceSummary = {
  days: 30,
  active_managers: 2,
  total_scored_conversations: 3,
  total_handled_conversations: 4,
  avg_qa_score: 8.4,
  qa_score_trend: 1.5,
  qa_coverage_rate: 75,
  avg_response_time_sec: 90,
  avg_csat: 4.4,
  managers_needing_attention: 1,
  improving_managers: 1,
  declining_managers: 1,
};

const dimensions: DimensionHealth[] = [
  {
    key: "empathy",
    label: "SERVER-ENGLISH-LABEL-NOT-RENDERED",
    average: 8.4,
    trend: null,
    strongest_manager: {
      id: "agent-1",
      name: "Provider Name Keep",
      score: 8.7,
    },
    weakest_manager: {
      id: "agent-2",
      name: "Second Provider Keep",
      score: 7.2,
    },
  },
];

const coachingPriorities: CoachingPriority[] = [
  {
    id: "agent-2",
    name: "Second Provider Keep",
    avatar_url: null,
    overall_qa_score: 7.2,
    trend: -1.5,
    conversation_count: 1,
    focus_area: "clarity",
    focus_score: 6.7,
    risk_score: 2.1,
  },
];

describe("localized performance analytics components", () => {
  beforeEach(() => {
    mockLocale = "ru";
  });

  it("localizes insight copy, stable dimensions, durations, and numbers", () => {
    const { container } = render(
      <PerformanceInsights
        summary={summary}
        dimensions={dimensions}
        coachingPriorities={coachingPriorities}
      />
    );

    expect(screen.getByText("Оценка QA команды")).toBeTruthy();
    expect(screen.getByText("Эмпатия")).toBeTruthy();
    expect(screen.getByText("1,5 мин.")).toBeTruthy();
    expect(screen.getByText(/Provider Name Keep \(8,7\)/)).toBeTruthy();
    expect(screen.getByText("Second Provider Keep")).toBeTruthy();
    expect(container.textContent).not.toContain(
      "SERVER-ENGLISH-LABEL-NOT-RENDERED"
    );
    expect(container.textContent).not.toMatch(
      /Team QA score|QA Dimension Health|Coaching Priorities|No trend yet|Needs coaching|scored conversations/
    );
  });

  it("localizes leaderboard copy, tooltip values, and the empty state", () => {
    const { container, rerender } = render(<AgentLeaderboard data={agents} />);

    const rows = screen.getAllByRole("row");
    expect(rows[1].querySelector("td")?.textContent?.trim()).toBe("1");
    expect(rows[2].querySelector("td")?.textContent?.trim()).toBe("2");

    expect(screen.getByText("Рейтинг менеджеров")).toBeTruthy();
    expect(screen.getAllByText("Покрытие QA").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1,5 мин.").length).toBeGreaterThan(0);
    expect(screen.getByText("30 сек.")).toBeTruthy();
    expect(screen.getByText("Provider Name Keep")).toBeTruthy();
    expect(container.textContent).not.toMatch(
      /QA coverage|Avg response|Score Breakdown|Low-QA conversations|vs previous period/
    );

    rerender(<AgentLeaderboard data={[]} />);
    expect(screen.getByText("Данных об эффективности пока нет.")).toBeTruthy();
    expect(
      screen.getByText("Менеджеры появятся здесь после оценённых диалогов.")
    ).toBeTruthy();
  });

  it("localizes chart defaults, tooltip copy, and reference labels", () => {
    const { container, rerender } = render(
      <AgentPerformanceChart data={agents} teamAverage={8.4} />
    );

    expect(screen.getByText("Сравнение оценок QA")).toBeTruthy();
    expect(screen.getAllByText("Оценка QA").length).toBeGreaterThan(0);
    expect(screen.getByText("Команда 8,4")).toBeTruthy();
    expect(screen.getByText("Цель 8")).toBeTruthy();
    expect(container.textContent).not.toMatch(
      /Team comparison|QA score|Scored conversations|conv|Team 8\.4|Target 8\.0/
    );

    rerender(<AgentPerformanceChart data={[agents[0]]} teamAverage={8.4} />);
    expect(screen.getByText("Пока один менеджер")).toBeTruthy();
  });

  it("keeps benchmark SVG paint compatible with OKLCH theme tokens", () => {
    render(<AgentPerformanceChart data={agents} teamAverage={8.4} />);

    const benchmarks = screen.getAllByTestId("performance-benchmark");
    expect(benchmarks.map(marker => marker.dataset.reference)).toEqual([
      "8.4",
      "8",
    ]);
    for (const benchmark of benchmarks) {
      const line = benchmark.querySelector("line");
      const label = benchmark.querySelector("text");
      const stroke = line?.getAttribute("stroke");
      // Wrapping an OKLCH token in hsl() made the real browser paint no stroke.
      expect(stroke).toMatch(/^var\(--[a-z0-9-]+\)$/);
      expect(label?.getAttribute("fill")).toBe(stroke);
      expect(line?.getAttribute("stroke-dasharray")).toBe("4 4");
    }
  });

  it.each<TestLocale>(["ru", "kz"])(
    "formats a zero trend with %s locale number semantics",
    locale => {
      mockLocale = locale;

      render(
        <PerformanceInsights
          summary={summary}
          dimensions={[{ ...dimensions[0], trend: 0 }]}
          coachingPriorities={[]}
        />
      );

      expect(screen.getByText("0")).toBeTruthy();
      expect(screen.queryByText("0.0")).toBeNull();
    }
  );

  it("uses plural-safe Russian grammar for singular manager trends", () => {
    render(
      <PerformanceInsights
        summary={summary}
        dimensions={[]}
        coachingPriorities={[]}
      />
    );

    expect(
      screen.getByText(
        "1 менеджер улучшает результат, 1 менеджер снижает результат"
      )
    ).toBeTruthy();
  });
});
