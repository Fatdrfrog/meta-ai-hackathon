import {
  DASHBOARD_UNCATEGORIZED_CATEGORY,
  type DashboardData,
} from "@/types/dashboard";
import { buildDashboardCsv } from "./dashboard-export";

const data: DashboardData = {
  stats: [
    {
      id: "total",
      value: 12,
      secondaryValue: null,
      comparison: {
        current: 12,
        previous: 9,
        delta: 3,
        percentChange: 33.33333333333333,
        kind: "increase",
      },
    },
  ],
  comparisonPeriod: {
    preset: "custom",
    strategy: "adjacent_equal_duration",
    timeZone: "Asia/Qyzylorda",
    current: {
      start: "2026-07-31T19:00:00.000Z",
      endExclusive: "2026-08-07T19:00:00.000Z",
    },
    previous: {
      start: "2026-07-24T19:00:00.000Z",
      endExclusive: "2026-07-31T19:00:00.000Z",
    },
  },
  dailySeries: {
    current: [{ date: "2026-08-01", total: 12 }],
    previous: [{ date: "2026-07-25", total: 9 }],
  },
  conversationActivityByTime: [{ dayOfWeek: 6, hour: 14, count: 7 }],
  categoryComparisons: [
    {
      category: "Refunds",
      current: 18,
      previous: 0,
      delta: 18,
      percentChange: null,
      kind: "new",
    },
  ],
  peakTime: null,
  topCategories: [{ name: "Оплата", value: 5 }],
  uncategorizedCount: 0,
  categoriesByChannel: [{ channel: "WhatsApp", category: "Оплата", count: 5 }],
  topComplaintTag: null,
  advertisement: {
    totalConversations: 0,
    uniqueSources: 0,
    respondedConversations: 0,
    closedConversations: 0,
    responseRate: 0,
    closeRate: 0,
    topSources: [],
    bySourceType: [],
    dailyCounts: [],
  },
  internalLabels: {
    taggedConversations: 0,
    unlabeledConversations: 0,
    uniqueLabels: 0,
    totalAssignments: 0,
    availableLabels: [],
    topLabels: [],
  },
  managerOptions: [],
  managerPerformance: [
    {
      id: "manager-1",
      name: "Анна",
      conversations: 4,
      open: 1,
      inProgress: 1,
      resolved: 2,
      firstResponseCount: 4,
      medianFirstResponseSeconds: 60,
      averageFirstResponseSeconds: 70,
      p90FirstResponseSeconds: 90,
    },
  ],
  firstResponse: {
    count: 0,
    medianSeconds: null,
    averageSeconds: null,
    p90Seconds: null,
  },
};

const messages: Record<string, string> = {
  "export.all": "ВСЕ",
  "export.filters": "Фильтры",
  "export.dailyCountsOverall": "Динамика по дням (все данные)",
  "export.messageActivityByHour": "Активность сообщений по часам",
  "export.topCategoriesVisible": "Популярные категории (видимые)",
  "export.categoriesByChannelVisible": "Категории по каналам (видимые)",
  "export.statsOverall": "Показатели (все данные)",
  "export.advertisement": "Реклама",
  "export.metaAdsManagerDaily": "Meta Ads Manager по дням",
  "export.metaAdsManagerTopAds": "Лучшие объявления Meta Ads Manager",
  "export.advertisementSources": "Источники рекламы",
  "export.internalLabels": "Внутренние метки",
  "export.managers": "Менеджеры",
  "export.internalLabelBreakdown": "Разбивка по внутренним меткам",
  "export.comparisonPeriods": "Периоды сравнения",
  "export.categoryComparisons": "Сравнение категорий",
};

describe("buildDashboardCsv", () => {
  const exportFixture = (fixture: DashboardData) =>
    buildDashboardCsv({
      data: fixture,
      filters: {
        channels: ["whatsapp"],
        categories: [],
        internalLabels: [],
        managerIds: [],
      },
      locale: "ru",
      translate: key => messages[key] ?? key,
    });

  it("preserves unknown Meta totals and currency-scoped rows without inventing a capture rate", () => {
    const csv = exportFixture({
      ...data,
      advertisement: {
        ...data.advertisement,
        totalConversations: 12,
        metaInsights: {
          dateStart: "2026-08-01",
          dateStop: "2026-08-07",
          resultActionType:
            "onsite_conversion.messaging_conversation_started_7d",
          resultLabel: "Messaging conversations started",
          totalResults: null,
          totalSpend: null,
          costPerResult: null,
          currency: null,
          sourceCount: 2,
          accountCount: 2,
          partial: false,
          fetchedAt: "2026-08-08T00:00:00.000Z",
          reporting: {
            actionReportTime: "conversion",
            attribution: "ad_set",
            destination: "all_messaging",
            workspaceTimeZone: "Asia/Qyzylorda",
          },
          resultCoverage: { reportedRows: 0, missingRows: 2 },
          warnings: ["multiple_currencies", "results_not_reported"],
          dailyCounts: [
            {
              date: "2026-08-01",
              results: null,
              spend: 10,
              costPerResult: null,
              currency: "USD",
              accountId: "act_1",
              missingResultRows: 1,
            },
          ],
          topAds: [
            {
              adId: "ad_1",
              adName: "=SUM(1,1)",
              destination: "whatsapp",
              destinationType: "WHATSAPP",
              destinationUpdatedAt: "2026-07-01T00:00:00.000Z",
              results: null,
              spend: 10,
              costPerResult: null,
              currency: "USD",
              accountId: "act_1",
              missingResultRows: 1,
            },
          ],
          currencyBuckets: [
            {
              currency: "USD",
              spend: 10,
              results: null,
              costPerResult: null,
              accountIds: ["act_1"],
              missingResultRows: 1,
              impressions: 100,
              linkClicks: 5,
              ctr: 5,
              cpc: 2,
            },
            {
              currency: "KZT",
              spend: 5000,
              results: null,
              costPerResult: null,
              accountIds: ["act_2"],
              missingResultRows: 1,
              impressions: 200,
              linkClicks: 10,
              ctr: 5,
              cpc: 500,
            },
          ],
          accounts: [
            {
              accountId: "act_1",
              accountName: "USD account",
              currency: "USD",
              timeZone: "UTC",
              dateStart: "2026-08-01",
              dateStop: "2026-08-07",
              impressions: 100,
              linkClicks: 5,
              ctr: 5,
              cpc: 2,
              reach: 80,
              frequency: 1.25,
            },
          ],
        },
      },
    });

    expect(csv).toContain(
      "meta_results,\nmeta_spend,\nmeta_cost_per_result,\n"
    );
    expect(csv).toContain("meta_destination,all_messaging");
    expect(csv).toContain("meta_local_filters_applied,false");
    expect(csv).toContain("meta_missing_result_rows,2");
    expect(csv).toContain("2026-08-01,,10,,act_1,USD,1");
    expect(csv).toContain('ad_1,"\'=SUM(1,1)",,,,,,10,,act_1,USD,1');
    expect(csv).toContain("whatsapp,WHATSAPP,2026-07-01T00:00:00.000Z");
    expect(csv).toContain("USD,10,,,100,5,5,2,act_1,1");
    expect(csv).toContain("KZT,5000,,,200,10,5,500,act_2,1");
    expect(csv).toContain(
      "act_1,USD account,USD,UTC,2026-08-01,2026-08-07,100,80,1.25,5,5,2"
    );
    expect(csv).not.toContain("airi_capture_rate");
  });

  it("never divides filtered local conversations by Meta reported messaging results", () => {
    const csv = exportFixture({
      ...data,
      advertisement: {
        ...data.advertisement,
        totalConversations: 12,
        metaInsights: {
          dateStart: "2026-08-01",
          dateStop: "2026-08-07",
          resultActionType:
            "onsite_conversion.messaging_conversation_started_7d",
          resultLabel: "Messaging conversations started",
          totalResults: 10,
          totalSpend: 50,
          costPerResult: 5,
          currency: "USD",
          sourceCount: 1,
          accountCount: 1,
          partial: false,
          fetchedAt: "2026-08-08T00:00:00.000Z",
          dailyCounts: [],
          topAds: [],
        },
      },
    });
    expect(csv).not.toContain("airi_capture_rate");
  });

  it("exports whole-period conversion feedback states and neutralizes provider reasons", () => {
    const csv = exportFixture({
      ...data,
      advertisement: {
        ...data.advertisement,
        conversionFeedback: {
          recorded: 8,
          eligible: 7,
          statuses: {
            not_eligible: 1,
            pending: 2,
            queued: 1,
            sent: 2,
            rejected: 1,
            delivery_unknown: 1,
          },
          oldestPendingAt: "2026-08-01T00:00:00.000Z",
          reasons: [{ status: "rejected", reason: "=CMD()", count: 1 }],
          truncated: false,
        },
      },
    });
    expect(csv).toContain("feedback_recorded,8");
    expect(csv).toContain("feedback_eligible,7");
    expect(csv).toContain("feedback_sent,2");
    expect(csv).toContain("feedback_delivery_unknown,1");
    expect(csv).toContain(
      "feedback_oldest_pending_at,2026-08-01T00:00:00.000Z"
    );
    expect(csv).toContain("status,reason,count\nrejected,'=CMD(),1");
  });

  it("localizes human headings and display values while preserving stable identifiers", () => {
    const csv = buildDashboardCsv({
      data,
      filters: {
        channels: [],
        categories: [],
        internalLabels: [],
        managerIds: [],
      },
      locale: "ru",
      translate: key =>
        key === "metrics.total" ? "Всего обращений" : (messages[key] ?? key),
    });

    expect(csv).toContain("Фильтры\nchannels,ВСЕ");
    expect(csv).toContain("Активность сообщений по часам");
    expect(csv).toContain("day_of_week,hour,message_count");
    expect(csv).toContain(
      "total,Всего обращений,count,12,12,9,3,33.33333333333333,increase"
    );
    expect(csv).toContain("Менеджеры");
    expect(csv).toContain(
      "manager_id,name,handled_conversations,open,in_progress,resolved,first_response_count,median_first_response,p90_first_response"
    );
    expect(csv).toContain("manager-1,Анна,4,1,1,2,4,60,90");
  });

  it("keeps user and provider filter values verbatim", () => {
    const csv = buildDashboardCsv({
      data,
      filters: {
        channels: ["WhatsApp Business"],
        categories: ["VIP, клиенты"],
        internalLabels: ["Не переводить"],
        managerIds: ["manager-1"],
      },
      locale: "ru",
      translate: key => messages[key] ?? key,
    });

    expect(csv).toContain("channels,WhatsApp Business");
    expect(csv).toContain('categories,"VIP, клиенты"');
    expect(csv).toContain("internal_labels,Не переводить");
    expect(csv).toContain("managers,manager-1");
  });

  it("localizes the uncategorized sentinel in human-readable CSV fields", () => {
    const csv = buildDashboardCsv({
      data: {
        ...data,
        topCategories: [{ name: DASHBOARD_UNCATEGORIZED_CATEGORY, value: 3 }],
        categoriesByChannel: [
          {
            channel: "WhatsApp",
            category: DASHBOARD_UNCATEGORIZED_CATEGORY,
            count: 3,
          },
        ],
      },
      filters: {
        channels: [],
        categories: [DASHBOARD_UNCATEGORIZED_CATEGORY],
        internalLabels: [],
        managerIds: [],
      },
      locale: "ru",
      translate: key =>
        key === "uncategorized" ? "Без категории" : (messages[key] ?? key),
    });

    expect(csv).toContain("categories,Без категории");
    expect(csv).toContain("Без категории,3");
    expect(csv).toContain("WhatsApp,Без категории,3");
    expect(csv).not.toContain(DASHBOARD_UNCATEGORIZED_CATEGORY);
  });

  it("neutralizes spreadsheet formulas in exported values", () => {
    const csv = buildDashboardCsv({
      data: {
        ...data,
        topCategories: [
          { name: "=SUM(1,1)", value: 1 },
          { name: "+SUM", value: 1 },
          { name: "-10+20", value: 1 },
          { name: "@SUM", value: 1 },
          { name: " \t=SUM(1,1)", value: 1 },
          { name: "\tSAFE", value: 1 },
        ],
      },
      filters: {
        channels: [],
        categories: [],
        internalLabels: [],
        managerIds: [],
      },
      locale: "ru",
      translate: key => messages[key] ?? key,
    });

    expect(csv).toContain('"\'=SUM(1,1)",1');
    expect(csv).toContain("'+SUM,1");
    expect(csv).toContain("'-10+20,1");
    expect(csv).toContain("'@SUM,1");
    expect(csv).toContain('"\' \t=SUM(1,1)",1');
    expect(csv).toContain("'\tSAFE,1");
    expect(csv).not.toMatch(/(?:^|\n)[=+\-@]/);
  });

  it("exports normalized period metadata and canonical category comparisons", () => {
    const csv = buildDashboardCsv({
      data,
      filters: {
        channels: [],
        categories: [],
        internalLabels: [],
        managerIds: [],
      },
      comparisonEnabled: true,
      locale: "ru",
      translate: key => messages[key] ?? key,
    });

    expect(csv).toContain(
      "preset,strategy,timezone,current_start,current_end_exclusive,previous_start,previous_end_exclusive\ncustom,adjacent_equal_duration,Asia/Qyzylorda,2026-07-31T19:00:00.000Z,2026-08-07T19:00:00.000Z,2026-07-24T19:00:00.000Z,2026-07-31T19:00:00.000Z"
    );
    expect(csv).toContain(
      "category,current,previous,difference,percent_change,change_kind\nRefunds,18,0,18,,new"
    );
  });

  it("exports strategy none and blank previous fields when comparison is off", () => {
    const csv = buildDashboardCsv({
      data,
      filters: {
        channels: [],
        categories: [],
        internalLabels: [],
        managerIds: [],
      },
      comparisonEnabled: false,
      locale: "ru",
      translate: key => messages[key] ?? key,
    });

    expect(csv).toContain(
      "custom,none,Asia/Qyzylorda,2026-07-31T19:00:00.000Z,2026-08-07T19:00:00.000Z,,"
    );
    expect(csv).toContain("Refunds,18,,,,");
  });

  it("neutralizes formulas in new comparison category fields", () => {
    const csv = buildDashboardCsv({
      data: {
        ...data,
        categoryComparisons: [
          {
            category: '=WEBSERVICE("https://example.com")',
            current: 1,
            previous: 0,
            delta: 1,
            percentChange: null,
            kind: "new",
          },
        ],
      },
      filters: {
        channels: [],
        categories: [],
        internalLabels: [],
        managerIds: [],
      },
      comparisonEnabled: true,
      locale: "ru",
      translate: key => messages[key] ?? key,
    });

    expect(csv).toContain(
      '"\'=WEBSERVICE(""https://example.com"")",1,0,1,,new'
    );
    expect(csv).not.toMatch(/(?:^|\n)=WEBSERVICE/);
  });

  it("exports stable metric units for machine-readable comparisons", () => {
    const csv = buildDashboardCsv({
      data: {
        ...data,
        stats: [
          ...data.stats,
          {
            id: "first_response",
            value: 120,
            secondaryValue: null,
            comparison: {
              current: 120,
              previous: 0,
              delta: 120,
              percentChange: null,
              kind: "increase",
            },
          },
          {
            id: "ttr",
            value: 2,
            secondaryValue: null,
            comparison: null,
          },
          {
            id: "csat",
            value: 4.5,
            secondaryValue: 5,
            comparison: null,
          },
        ],
      },
      filters: {
        channels: [],
        categories: [],
        internalLabels: [],
        managerIds: [],
      },
      comparisonEnabled: true,
      locale: "ru",
      translate: key => messages[key] ?? key,
    });

    expect(csv).toContain("id,label,unit,value,current,previous,difference");
    expect(csv).toContain("total,metrics.total,count,");
    expect(csv).toContain(
      "first_response,metrics.medianFirstManagerResponseTime,seconds,"
    );
    const firstResponseRow = csv
      .split("\n")
      .find(row => row.startsWith("first_response,"));
    expect(firstResponseRow?.split(",").slice(-5)).toEqual([
      "120",
      "0",
      "120",
      "",
      "increase",
    ]);
    expect(csv).toContain("ttr,metrics.avgResolutionTime,days,");
    expect(csv).toContain("csat,metrics.avgCsat,score,");
  });

  it("exports the server-filtered response without a second client filter pass", () => {
    const csv = buildDashboardCsv({
      data: {
        ...data,
        topCategories: [{ name: "Server result", value: 4 }],
        categoriesByChannel: [
          { channel: "telegram", category: "Server result", count: 4 },
        ],
      },
      filters: {
        channels: ["whatsapp"],
        categories: ["Different selected filter"],
        internalLabels: [],
        managerIds: [],
      },
      locale: "ru",
      translate: key => messages[key] ?? key,
    });

    expect(csv).toContain("Server result,4");
    expect(csv).toContain("telegram,Server result,4");
  });
});
