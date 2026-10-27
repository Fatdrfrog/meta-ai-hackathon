/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react";
import type { AdvertisementAnalytics } from "@/types/dashboard";

import {
  AdvertisementAnalyticsSection,
  hasAdvertisementData,
} from "./advertisement-analytics";

jest.mock("next-intl", () => ({
  useLocale: () => "ru",
  useTranslations:
    () => (key: string, values?: Record<string, number | string>) => {
      const count = Number(values?.count ?? 0);
      const plural = (one: string, few: string, many: string) =>
        count % 10 === 1 && count % 100 !== 11
          ? one
          : [2, 3, 4].includes(count % 10) &&
              ![12, 13, 14].includes(count % 100)
            ? few
            : many;
      const messages: Record<string, string> = {
        title: "Реклама Meta",
        description:
          "Результаты Ads Manager и обращения из рекомендаций WhatsApp.",
        filterScope:
          "Фильтры обращений не влияют на результаты и расходы Meta.",
        "sourceTypes.metaAds": "Реклама Meta",
        "sourceTypes.instagramPosts": "Публикации Instagram",
        "sourceTypes.unknown": "Неизвестный источник",
        sourceTypeCount: `${values?.type}: ${values?.count}`,
        "tiles.metaResults": "Результаты Meta",
        "tiles.spend": "Расходы",
        "tiles.costPerResult": "Цена за результат",
        "tiles.airiCaptured": "Зафиксировано Airi",
        "tiles.capturedStarts": "Зафиксированные обращения",
        "tiles.responded": "С ответом",
        "tiles.closed": "Закрыто",
        "tiles.trackedSources": "Отслеживаемые источники",
        selectedAdAccount: "Выбранный рекламный аккаунт",
        spendScope: `Все объявления аккаунта · ${values?.account}`,
        uniqueSources: `${count} ${plural("уникальный источник", "уникальных источника", "уникальных источников")}`,
        ofMetaResults: `${values?.percent} от результатов Meta`,
        responseRate: `${values?.percent} ответов`,
        closeRate: `${values?.percent} закрыто`,
        topSourcesShown: "Основные источники показаны ниже",
        captureGap: `${values?.countValue} ${plural("результат Meta не стал", "результата Meta не стали", "результатов Meta не стали")} обращением Airi за этот период.`,
        "metaByDay.title": "Результаты Meta по дням",
        "metaByDay.description": "Результаты переписок и расходы Ads Manager.",
        dateRange: `${values?.start} — ${values?.end}`,
        "capturedByDay.title": "Обращения, зафиксированные Airi",
        "capturedByDay.description": "Обращения из рекламы Meta по дням.",
        dayCount: `${count} ${plural("день", "дня", "дней")}`,
        metaResultTooltip: `${values?.date}: ${values?.count}, ${values?.spend}`,
        capturedStartTooltip: `${values?.date}: ${values?.count}`,
        "topAds.ad": "Реклама Meta",
        "topAds.results": "Результаты",
        "topAds.spend": "Расходы",
        "topAds.costPerResult": "Цена за результат",
        "diagnostics.currentDestination": `Текущий канал: ${values?.destination}`,
        "diagnostics.destinationWhatsApp": "WhatsApp",
        "diagnostics.destinationOther": "Другие каналы",
        "diagnostics.destinationUnknown": "Не проверен",
        "diagnostics.destinationUpdatedAt": `Обновлено ${values?.date}`,
        "sources.source": "Источник Airi",
        "sources.starts": "Обращения",
        "sources.responded": "С ответом",
        "sources.closed": "Закрыто",
        "sources.latest": "Последнее",
        "sources.empty": "Нет разбивки по источникам за этот период.",
        sourceId: `ID источника: ${values?.id}`,
        openSource: "Открыть источник рекламы",
      };

      return messages[key] ?? key;
    },
}));

function buildData({
  gap = 5,
  days = 2,
}: {
  gap?: number;
  days?: number;
} = {}): AdvertisementAnalytics {
  return {
    totalConversations: 1_234,
    uniqueSources: 2,
    respondedConversations: 1_000,
    closedConversations: 500,
    responseRate: 81.2,
    closeRate: 40.5,
    bySourceType: [
      { sourceType: "ad", conversations: 1_234 },
      { sourceType: "PartnerFeed", conversations: 1 },
    ],
    dailyCounts: Array.from({ length: days }, (_, index) => ({
      date: `2026-07-${String(index + 1).padStart(2, "0")}`,
      conversations: index + 1,
    })),
    topSources: [
      {
        sourceKey: "source-key",
        sourceId: "SOURCE-ID-KEEP",
        sourceType: "PartnerFeed",
        sourceUrl: "https://example.com/source",
        headline: "Provider headline KEEP",
        body: "Provider body KEEP",
        conversations: 1_234,
        responded: 1_000,
        closed: 500,
        latestAt: "2026-07-31",
      },
    ],
    metaInsights: {
      dateStart: "2026-07-01",
      dateStop: "2026-07-31",
      resultActionType: "onsite_conversion.messaging KEEP",
      resultLabel: "Messaging conversations started KEEP",
      totalResults: 1_234 + gap,
      totalSpend: 9.5,
      costPerResult: 0.5,
      currency: "KZT",
      accountId: "ACCOUNT-ID-KEEP",
      accountName: "Account name KEEP",
      sourceCount: 1,
      accountCount: 1,
      partial: true,
      error: "Provider error KEEP",
      fetchedAt: "2026-07-31T12:00:00.000Z",
      dailyCounts: Array.from({ length: days }, (_, index) => ({
        date: `2026-07-${String(index + 1).padStart(2, "0")}`,
        results: index + 1,
        spend: index + 0.5,
        costPerResult: index + 0.5,
      })),
      topAds: [
        {
          adId: "AD-ID-KEEP",
          adName: "Ad name KEEP",
          campaignId: "CAMPAIGN-ID-KEEP",
          campaignName: "Campaign name KEEP",
          adSetId: "ADSET-ID-KEEP",
          adSetName: "Ad set name KEEP",
          results: 1_234,
          spend: 9.5,
          costPerResult: 0.5,
        },
      ],
    },
  };
}

describe("AdvertisementAnalyticsSection", () => {
  it("uses one visibility predicate for captured referrals and provider errors", () => {
    const providerErrorOnly = {
      ...buildData(),
      totalConversations: 0,
      metaInsights: {
        ...buildData().metaInsights!,
        totalResults: 0,
        totalSpend: 0,
        error: "Provider error KEEP",
      },
    };
    const empty = {
      ...buildData(),
      totalConversations: 0,
      metaInsights: null,
    };

    expect(hasAdvertisementData(providerErrorOnly)).toBe(true);
    expect(hasAdvertisementData(empty)).toBe(false);

    const visible = render(
      <AdvertisementAnalyticsSection data={providerErrorOnly} />
    );
    expect(screen.getByText("Provider error KEEP")).toBeTruthy();
    visible.unmount();
    expect(
      render(<AdvertisementAnalyticsSection data={empty} />).container
        .firstChild
    ).toBeNull();
  });

  it("renders localized Russian analytics while preserving provider and source content", () => {
    const { container } = render(
      <AdvertisementAnalyticsSection data={buildData()} />
    );

    expect(
      screen.getByText(
        "Фильтры обращений не влияют на результаты и расходы Meta."
      )
    ).toBeTruthy();
    expect(container.querySelector("svg.lucide")).toBeNull();

    expect(screen.getAllByText("Реклама Meta").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        "Результаты Ads Manager и обращения из рекомендаций WhatsApp."
      )
    ).toBeTruthy();
    expect(screen.getByText("Результаты Meta")).toBeTruthy();
    expect(
      screen.getAllByText((_, element) => element?.textContent === "1 239")
        .length
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText((_, element) => element?.textContent === "9,50 KZT")
        .length
    ).toBeGreaterThan(0);
    expect(screen.getByText("Результаты Meta по дням")).toBeTruthy();
    expect(screen.getByText("Обращения, зафиксированные Airi")).toBeTruthy();
    expect(screen.getByText("Источник Airi")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Открыть источник рекламы" })
    ).toBeTruthy();

    // Spend sums every ad in the account, not only messaging ads.
    expect(
      screen.getByText("Все объявления аккаунта · Account name KEEP")
    ).toBeTruthy();

    for (const literal of [
      "Messaging conversations started KEEP",
      "onsite_conversion.messaging KEEP",
      "Provider error KEEP",
      "Ad name KEEP",
      "Campaign name KEEP / Ad set name KEEP",
      "Provider headline KEEP",
      "Provider body KEEP",
      "PartnerFeed",
    ]) {
      expect(screen.getAllByText(literal).length).toBeGreaterThan(0);
    }
  });

  it("does not equate active historical ad chats with missing Meta results", () => {
    render(<AdvertisementAnalyticsSection data={buildData({ gap: 5 })} />);
    expect(screen.queryByText(/не стали.*обращением Airi/)).toBeNull();
    expect(screen.queryByText(/от результатов Meta/)).toBeNull();
  });

  it("does not draw unknown or present-zero results as a positive result bar", () => {
    const data = buildData();
    data.metaInsights!.dailyCounts = [
      {
        date: "2026-09-01",
        results: null,
        spend: null,
        costPerResult: null,
        currency: "USD",
        missingResultRows: 1,
        missingSpendRows: 1,
      },
      {
        date: "2026-09-02",
        results: 0,
        spend: 0,
        costPerResult: null,
        currency: "USD",
        missingResultRows: 0,
        missingSpendRows: 0,
      },
    ];
    const { container } = render(<AdvertisementAnalyticsSection data={data} />);
    expect(
      Array.from(container.querySelectorAll(".bg-chart-3")).map(
        element => (element as HTMLElement).style.height
      )
    ).toEqual(["0%", "0%"]);
  });

  it("renders separate currencies and missing results without a fictional combined total", () => {
    const data = buildData();
    data.metaInsights = {
      ...data.metaInsights!,
      totalResults: null,
      totalSpend: null,
      costPerResult: null,
      currency: null,
      currencyBuckets: [
        {
          currency: "USD",
          spend: 10,
          results: 0,
          costPerResult: null,
          accountIds: ["a"],
          missingResultRows: 0,
          impressions: 100,
          linkClicks: 4,
          ctr: 4,
          cpc: 2.5,
        },
        {
          currency: "KZT",
          spend: 9000,
          results: null,
          costPerResult: null,
          accountIds: ["b"],
          missingResultRows: 1,
          impressions: null,
          linkClicks: null,
          ctr: null,
          cpc: null,
        },
      ],
      warnings: ["multiple_currencies", "results_not_reported"],
      reporting: {
        destination: "all_messaging",
        attribution: "ad_set",
        actionReportTime: "conversion",
        workspaceTimeZone: "UTC",
      },
    };
    render(<AdvertisementAnalyticsSection data={data} />);
    expect(screen.getByRole("cell", { name: /^10\s/ })).toBeTruthy();
    expect(screen.getByRole("cell", { name: /9.000/ })).toBeTruthy();
    expect(screen.getByText("diagnostics.allMessaging")).toBeTruthy();
    expect(
      screen.getByText("diagnostics.warnings.multiple_currencies")
    ).toBeTruthy();
  });

  it("shows explicit current destination and preserves unknown configuration", () => {
    const data = buildData();
    data.metaInsights!.topAds[0].destination = "whatsapp";
    data.metaInsights!.topAds[0].destinationUpdatedAt =
      "2026-05-25T07:00:00.000Z";
    data.metaInsights!.topAds.push({
      ...data.metaInsights!.topAds[0],
      adId: "unknown-ad",
      destination: null,
      destinationUpdatedAt: null,
    });
    render(<AdvertisementAnalyticsSection data={data} />);
    expect(screen.getByText("Текущий канал: WhatsApp")).toBeTruthy();
    expect(screen.getByText("Обновлено 2026-05-25")).toBeTruthy();
    expect(screen.getByText("diagnostics.currentDestinationHelp")).toBeTruthy();
    expect(screen.getAllByText("Обновлено Не проверен").length).toBeGreaterThan(
      0
    );
  });
  it.each([
    [1, "1 день"],
    [2, "2 дня"],
    [5, "5 дней"],
  ])("renders the Russian day count for %i", (days, expected) => {
    render(<AdvertisementAnalyticsSection data={buildData({ days })} />);
    expect(screen.getByText(expected)).toBeTruthy();
  });
});
