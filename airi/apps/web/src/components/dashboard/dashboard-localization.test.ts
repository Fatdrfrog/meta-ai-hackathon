import {
  buildDashboardComplaintInsight,
  buildDashboardStatCards,
  formatDashboardChangeKind,
  formatDashboardCategory,
  formatDashboardDurationDelta,
  formatDashboardStatComparison,
  normalizeDashboardIntlLocale,
  type DashboardTranslator,
} from "./dashboard-localization";
import { DASHBOARD_UNCATEGORIZED_CATEGORY } from "@/types/dashboard";

const messages: Record<string, string> = {
  "metrics.total": "Всего чатов",
  "metrics.new": "Открытые",
  "metrics.inProgress": "В работе",
  "metrics.resolved": "Решено",
  "metrics.slaBreached": "Нарушение SLA",
  "metrics.repeatRequests": "Повторные чаты",
  "metrics.avgCsat": "Средняя оценка (CSAT)",
  "metrics.medianFirstManagerResponseTime": "Первый ответ менеджера",
  "metrics.avgResolutionTime": "Среднее время решения",
  "duration.missing": "—",
  "duration.lessThanMinute": "Меньше минуты",
  "duration.seconds": "{value} сек.",
  "duration.minutes": "{value} мин.",
  "duration.hours": "{value} ч.",
  "duration.days": "{value} дн.",
  "duration.noChange": "Без изменений",
  noChange: "Без изменений",
  "categoryComparison.changeKinds.increase": "Увеличение",
  "categoryComparison.changeKinds.decrease": "Уменьшение",
  "categoryComparison.changeKinds.unchanged": "Без изменений",
  "categoryComparison.changeKinds.new": "Новая",
  "categoryComparison.changeKinds.noLongerActive": "Больше не активна",
  firstManagerResponseInsight:
    "Ответов: {countValue}. Среднее: {average}, P90: {p90}",
  complaintInsight: "Чаще всего жалуются на тему «{tag}».",
  noComplaintTrends: "Заметных тенденций в жалобах нет.",
  uncategorized: "Без категории",
  unknown: "Неизвестно",
  peakTimeInsight:
    "Пик сообщений приходится на {dayOfWeek}, с {startHour}:00 до {endHour}:00.",
};

const t: DashboardTranslator = (key, values) => {
  const template = messages[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, token: string) =>
    String(values?.[token] ?? `{${token}}`)
  );
};

describe("dashboard localization", () => {
  it("localizes dashboard cards and formats their values with the active locale", () => {
    const cards = buildDashboardStatCards(
      [
        {
          id: "repeat",
          value: 12_345,
          secondaryValue: 37.5,
          comparison: {
            current: 2,
            previous: 1,
            delta: 1,
            percentChange: 100,
            kind: "increase",
          },
        },
        {
          id: "first_response",
          value: 3_600,
          secondaryValue: null,
          comparison: {
            current: 3_600,
            previous: 1_800,
            delta: 1_800,
            percentChange: 100,
            kind: "increase",
          },
        },
      ],
      {
        count: 12_345,
        medianSeconds: 3_600,
        averageSeconds: 90,
        p90Seconds: 7_200,
      },
      "ru",
      t
    );

    expect(cards).toEqual([
      {
        id: "repeat",
        label: "Повторные чаты",
        value: "12 345 (37,5 %)",
        comparison: {
          current: 2,
          previous: 1,
          delta: 1,
          percentChange: 100,
          kind: "increase",
        },
        insight: "",
        isHighlighted: false,
      },
      {
        id: "first_response",
        label: "Первый ответ менеджера",
        value: "1 ч.",
        comparison: {
          current: 3_600,
          previous: 1_800,
          delta: 1_800,
          percentChange: 100,
          kind: "increase",
        },
        insight: "Ответов: 12 345. Среднее: 2 мин., P90: 2 ч.",
        isHighlighted: false,
      },
    ]);
  });

  it("formats repeat-request percentages for kz", () => {
    const [card] = buildDashboardStatCards(
      [{ id: "repeat", value: 2, secondaryValue: 37.5, comparison: null }],
      {
        count: 0,
        medianSeconds: null,
        averageSeconds: null,
        p90Seconds: null,
      },
      "kz",
      t
    );

    expect(card.value).toBe("2 (37,5%)");
  });

  it("derives card highlight semantics from raw metric values", () => {
    const cards = buildDashboardStatCards(
      [
        { id: "sla", value: 1_000, secondaryValue: null, comparison: null },
        { id: "csat", value: 3.9, secondaryValue: 5, comparison: null },
        { id: "total", value: 1_000, secondaryValue: null, comparison: null },
      ],
      {
        count: 0,
        medianSeconds: null,
        averageSeconds: null,
        p90Seconds: null,
      },
      "ru",
      t
    );

    expect(
      cards.map(card => ({ id: card.id, isHighlighted: card.isHighlighted }))
    ).toEqual([
      { id: "sla", isHighlighted: true },
      { id: "csat", isHighlighted: false },
      { id: "total", isHighlighted: false },
    ]);
  });

  it("keeps first response missing when there are no sampled conversations", () => {
    const [card] = buildDashboardStatCards(
      [
        {
          id: "first_response",
          value: 0,
          secondaryValue: null,
          comparison: null,
        },
      ],
      {
        count: 0,
        medianSeconds: null,
        averageSeconds: null,
        p90Seconds: null,
      },
      "ru",
      t
    );

    expect(card.value).toBe("—");
    expect(card.insight).toBe("");
  });

  it("localizes only the dashboard uncategorized sentinel", () => {
    expect(formatDashboardCategory(DASHBOARD_UNCATEGORIZED_CATEGORY, t)).toBe(
      "Без категории"
    );
    expect(formatDashboardCategory("Доставка", t)).toBe("Доставка");
  });

  it("preserves a provider complaint tag while localizing its surrounding copy", () => {
    expect(buildDashboardComplaintInsight("Late shipment / VIP", t)).toBe(
      "Чаще всего жалуются на тему «Late shipment / VIP»."
    );
    expect(buildDashboardComplaintInsight(null, t)).toBe(
      "Заметных тенденций в жалобах нет."
    );
  });

  it("normalizes the product Kazakh locale at Intl formatting boundaries", () => {
    const [card] = buildDashboardStatCards(
      [{ id: "csat", value: 4.5, secondaryValue: 5, comparison: null }],
      {
        count: 0,
        medianSeconds: null,
        averageSeconds: null,
        p90Seconds: null,
      },
      "kz",
      t
    );

    expect(normalizeDashboardIntlLocale("kz")).toBe("kk-KZ");
    expect(card.value).toBe("4,5 / 5");
  });

  it("formats positive, negative, and unchanged duration deltas", () => {
    expect(formatDashboardDurationDelta(7_200, "ru", t)).toBe("+2 ч.");
    expect(formatDashboardDurationDelta(-1_800, "ru", t)).toBe("-30 мин.");
    expect(formatDashboardDurationDelta(0, "ru", t)).toBe("Без изменений");
  });

  it("keeps sub-minute duration deltas in seconds instead of 'less than a minute'", () => {
    // Regression: a 44 s faster reply rendered as "-Меньше минуты".
    expect(formatDashboardDurationDelta(-44, "ru", t)).toBe("-44 сек.");
    expect(formatDashboardDurationDelta(12.4, "ru", t)).toBe("+12 сек.");
    expect(formatDashboardDurationDelta(0.4, "ru", t)).toBe("Без изменений");
    expect(formatDashboardDurationDelta(59.6, "ru", t)).toBe("+1 мин.");
  });

  it("formats card comparisons in each metric's own unit", () => {
    const comparison = (current: number, previous: number) => ({
      current,
      previous,
      delta: current - previous,
      percentChange:
        previous === 0 ? null : ((current - previous) / previous) * 100,
      kind: "increase" as const,
    });
    // ru Intl output separates groups and percent signs with no-break spaces.
    const { change, previous } = formatDashboardStatComparison(
      "total",
      comparison(1_150, 1_000),
      "ru",
      t
    );
    expect([change, previous].map(text => text.replace(/\s/g, " "))).toEqual([
      "+15 %",
      "1 000",
    ]);
    expect(
      formatDashboardStatComparison("resolved", comparison(4, 0), "ru", t)
    ).toEqual({ change: "+4", previous: "0" });
    expect(
      formatDashboardStatComparison("total", comparison(9, 9), "ru", t)
    ).toEqual({ change: "Без изменений", previous: "9" });
    expect(
      formatDashboardStatComparison(
        "first_response",
        comparison(96, 140),
        "ru",
        t
      )
    ).toEqual({ change: "-44 сек.", previous: "2 мин." });
    expect(
      formatDashboardStatComparison("ttr", comparison(5.4, 6.1), "ru", t)
    ).toEqual({ change: "-16,8 ч.", previous: "6,1 дн." });
    expect(
      formatDashboardStatComparison("csat", comparison(4.6, 4.4), "ru", t)
    ).toEqual({ change: "+0,2", previous: "4,4" });
  });

  it.each([
    ["increase", "Увеличение"],
    ["decrease", "Уменьшение"],
    ["unchanged", "Без изменений"],
    ["new", "Новая"],
    ["no_longer_active", "Больше не активна"],
  ] as const)("localizes the %s comparison kind", (kind, expected) => {
    expect(formatDashboardChangeKind(kind, t)).toBe(expected);
  });
});
