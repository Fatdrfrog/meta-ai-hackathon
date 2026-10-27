"use client";

import {
  hasAdvertisementData,
  hasInternalLabelData,
} from "@/components/dashboard/dashboard-section-visibility";
import { CategoryComparisonTable } from "@/components/dashboard/category-comparison-table";
import { ChannelBreakdown } from "@/components/dashboard/channel-breakdown";
import { MetricCard } from "./section-cards";
import { ServiceCoverageNotice, ServiceTruthSummary } from "./service-truth-summary";
import { DashboardPeriodSummary } from "./dashboard-period-summary";
import { DashboardBoardGrid } from "./dashboard-board-grid";
import type { DashboardBoardPresentation } from "./dashboard-board-controller";
import type { DashboardCardId } from "./dashboard-board-model";
import { TooltipProvider } from "@/components/ui/tooltip";
import { dashboardSWRConfig } from "@/components/dashboard/dashboard-client-swr-config";
import {
  buildDashboardComplaintInsight,
  buildDashboardStatCards,
  formatDashboardCategory,
  type DashboardTranslator,
} from "@/components/dashboard/dashboard-localization";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  ErrorState,
  EmptyState,
  LoadingState,
} from "@/components/ui/async-states";
import { Button } from "@/components/ui/button";
import {
  DateRangeControl,
  type DateRange,
} from "@/components/ui/date-range-control";
import { Skeleton } from "@/components/ui/skeleton";
import { PreservedTabsContent } from "@/components/ui/preserved-tabs-content";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { filterDashboardData } from "@/lib/dashboard-filters";
import { buildDashboardQueryPath } from "@/lib/dashboard-query";
import {
  DASHBOARD_UNCATEGORIZED_CATEGORY,
  type DashboardData,
} from "@/types/dashboard";
import dynamic from "next/dynamic";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";

const DashboardOverview = dynamic(
  () =>
    import("@/components/dashboard/dashboard-overview").then(
      module => module.DashboardOverview
    ),
  { ssr: false, loading: () => <Skeleton className="h-96 w-full" /> }
);
// Charts load on demand so recharts stays out of the initial analytics bundle.
const ConversationVolumeChart = dynamic(
  () =>
    import("@/components/dashboard/conversation-volume-chart").then(
      module => module.ConversationVolumeChart
    ),
  { ssr: false, loading: () => <Skeleton className="h-72 w-full" /> }
);
const CategoryDistributionChart = dynamic(
  () =>
    import("@/components/dashboard/category-distribution-chart").then(
      module => module.CategoryDistributionChart
    ),
  { ssr: false, loading: () => <Skeleton className="h-80 w-full" /> }
);
const ManagerResponseOverview = dynamic(
  () =>
    import("@/components/dashboard/manager-response-overview").then(
      module => module.ManagerResponseOverview
    ),
  { ssr: false, loading: () => <Skeleton className="h-72 w-full" /> }
);
const ConversationActivityHeatmap = dynamic(
  () =>
    import("@/components/dashboard/conversation-activity-heatmap").then(
      module => module.ConversationActivityHeatmap
    ),
  { ssr: false, loading: () => <Skeleton className="h-80 w-full" /> }
);
const AdvertisementAnalyticsSection = dynamic(
  () =>
    import("@/components/dashboard/advertisement-analytics").then(
      module => module.AdvertisementAnalyticsSection
    ),
  { ssr: false, loading: () => <Skeleton className="h-96 w-full" /> }
);
const InternalLabelsAnalyticsSection = dynamic(
  () =>
    import("@/components/dashboard/internal-labels-analytics").then(
      module => module.InternalLabelsAnalyticsSection
    ),
  { ssr: false, loading: () => <Skeleton className="h-80 w-full" /> }
);

const DashboardDomainCard = dynamic(
  () =>
    import("@/components/analytics/dashboard-domain-cards").then(
      module => module.DashboardDomainCard
    ),
  { ssr: false, loading: () => <Skeleton className="h-72 w-full" /> }
);

const dashboardFetcher = async (url: string): Promise<DashboardData> => {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json();
};

type DashboardTab = "overview" | "categories" | "team" | "sources";

export function DashboardClientPage({
  workspaceId,
  dateRange: controlledDateRange,
  filters,
  comparisonEnabled = true,
  onDataLoaded,
  boardPresentation,
}: {
  workspaceId: string;
  dateRange?: DateRange;
  filters?: {
    channels: string[];
    categories: string[];
    internalLabels?: string[];
    managerIds?: string[];
  };
  comparisonEnabled?: boolean;
  onDataLoaded?: (data: DashboardData) => void;
  boardPresentation?: DashboardBoardPresentation;
}) {
  const [uncontrolledDateRange, setUncontrolledDateRange] = useState<DateRange>(
    { preset: "30d", from: null, to: null }
  );
  const [activeTab, setActiveTab] = useState<DashboardTab>("overview");
  const lastNotifiedDataRef = useRef<DashboardData | null>(null);
  const dateRange = controlledDateRange ?? uncontrolledDateRange;
  const locale = useLocale();
  const t = useTranslations("DashboardClientPage");
  const tSectionCards = useTranslations("SectionCards");
  const requestTimeZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    []
  );
  const swrKey = useMemo(() => {
    if (!workspaceId) return null;
    return buildDashboardQueryPath(
      workspaceId,
      dateRange,
      filters,
      requestTimeZone
    );
  }, [workspaceId, dateRange, filters, requestTimeZone]);
  const {
    data: rawData,
    error: swrError,
    isLoading,
    mutate,
  } = useSWR<DashboardData>(swrKey, dashboardFetcher, dashboardSWRConfig);
  const data = useMemo(() => {
    if (!rawData) return null;
    return filterDashboardData(
      rawData,
      filters?.channels || [],
      filters?.categories || []
    );
  }, [rawData, filters]);
  const localizedData = useMemo(() => {
    if (!data) return null;
    const dashboardT = t as unknown as DashboardTranslator;
    const sectionCardsT = tSectionCards as unknown as DashboardTranslator;
    const previousByCategory = new Map(
      data.categoryComparisons.map(row => [row.category, row.previous])
    );

    return {
      stats: buildDashboardStatCards(
        data.stats,
        data.firstResponse,
        locale,
        sectionCardsT
      ),
      topCategories: data.topCategories.map(category => ({
        ...category,
        name: formatDashboardCategory(category.name, dashboardT),
        previous: previousByCategory.get(category.name) ?? 0,
      })),
      // The ranked list can already hold the uncategorized bucket; then its
      // separate footnote would repeat the same count.
      uncategorized: data.topCategories.some(
        category => category.name === DASHBOARD_UNCATEGORIZED_CATEGORY
      )
        ? 0
        : data.uncategorizedCount,
      uncategorizedPrevious:
        previousByCategory.get(DASHBOARD_UNCATEGORIZED_CATEGORY) ?? 0,
      categoriesByChannel: data.categoriesByChannel.map(category => ({
        ...category,
        category: formatDashboardCategory(category.category, dashboardT),
      })),
      complaintInsight: buildDashboardComplaintInsight(
        data.topComplaintTag,
        dashboardT
      ),
    };
  }, [data, locale, t, tSectionCards]);
  const showSources = Boolean(
    data &&
      (hasAdvertisementData(data.advertisement) ||
        hasInternalLabelData(data.internalLabels))
  );
  if (data && activeTab === "sources" && !showSources) {
    setActiveTab("overview");
  }
  useEffect(() => {
    if (!rawData || !onDataLoaded) return;
    if (lastNotifiedDataRef.current === rawData) return;
    lastNotifiedDataRef.current = rawData;
    onDataLoaded(rawData);
  }, [rawData, onDataLoaded]);

  const effectiveComparisonEnabled =
    comparisonEnabled && Boolean(data?.comparisonPeriod.previous);

  if (boardPresentation) {
    const renderCard = (id: DashboardCardId) => {
      // Board cards have no frame title, so a placeholder must name its card.
      const emptyCard = () => (
        <EmptyState
          title={t(`board.cards.${id}`)}
          description={t("board.noCardData")}
        />
      );
      if (id === "ai_usage" || id === "campaigns") {
        return <DashboardDomainCard kind={id} workspaceId={workspaceId} />;
      }
      if (isLoading && !rawData) return <LoadingState lines={3} />;
      if (!data || !localizedData) {
        return (
          <ErrorState
            message={t("failedToLoadData")}
            onRetry={() => void mutate()}
            retryLabel={t("retry")}
          />
        );
      }
      const stat = localizedData.stats.find(item => item.id === id);
      if (stat)
        return (
          <MetricCard
            stat={stat}
            workspaceId={workspaceId}
            comparisonEnabled={effectiveComparisonEnabled}
          />
        );
      switch (id) {
        case "volume":
          return data.dailySeries.current.length ? (
            <ConversationVolumeChart
              current={data.dailySeries.current}
              previous={data.dailySeries.previous}
              comparisonPeriod={data.comparisonPeriod}
              comparisonEnabled={effectiveComparisonEnabled}
              currentLabel={t("categoryComparison.table.current")}
              previousLabel={t("categoryComparison.table.previous")}
            />
          ) : (
            emptyCard()
          );
        case "category_comparison":
          return (
            <CategoryComparisonTable
              rows={data.categoryComparisons}
              comparisonEnabled={effectiveComparisonEnabled}
            />
          );
        case "period_summary":
          return effectiveComparisonEnabled ? (
            <DashboardPeriodSummary
              comparisons={data.categoryComparisons}
              period={data.comparisonPeriod}
              comparisonEnabled
            />
          ) : (
            <EmptyState
              title={t("board.cards.period_summary")}
              description={t("board.comparisonUnavailable")}
            />
          );
        case "categories":
          return localizedData.topCategories.length ||
            data.uncategorizedCount ? (
            <CategoryDistributionChart
              data={localizedData.topCategories}
              uncategorized={localizedData.uncategorized}
              uncategorizedPrevious={localizedData.uncategorizedPrevious}
              comparisonEnabled={effectiveComparisonEnabled}
            />
          ) : (
            emptyCard()
          );
        case "channels":
          return localizedData.categoriesByChannel.some(
            row => row.count > 0
          ) ? (
            <ChannelBreakdown
              data={localizedData.categoriesByChannel}
              insight={localizedData.complaintInsight}
            />
          ) : (
            emptyCard()
          );
        case "team":
          return data.serviceTruth || data.managerPerformance?.length ? (
            <div className="min-w-0"><ServiceTruthSummary report={data.serviceTruth} /><ManagerResponseOverview managers={data.managerPerformance || []} /></div>
          ) : (
            emptyCard()
          );
        case "activity":
          return data.conversationActivityByTime.some(row => row.count > 0) ? (
            <ConversationActivityHeatmap
              data={data.conversationActivityByTime}
              timeZone={data.comparisonPeriod.timeZone}
            />
          ) : (
            emptyCard()
          );
        case "advertisements":
          return hasAdvertisementData(data.advertisement) ? (
            <AdvertisementAnalyticsSection data={data.advertisement} />
          ) : (
            emptyCard()
          );
        case "labels":
          return hasInternalLabelData(data.internalLabels) ? (
            <InternalLabelsAnalyticsSection
              data={data.internalLabels}
              workspaceId={workspaceId}
            />
          ) : (
            emptyCard()
          );
        default:
          return emptyCard();
      }
    };
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {!controlledDateRange ? (
          <DateRangeControl
            iconFree
            onChange={setUncontrolledDateRange}
            value={dateRange}
          />
        ) : null}
        {swrError && rawData ? (
          <RefreshErrorAlert
            message={t("failedToLoadData")}
            onRetry={() => void mutate()}
            retryLabel={t("retry")}
          />
        ) : null}
        <TooltipProvider delayDuration={150}>
          <ServiceCoverageNotice coverage={data?.sourceCoverage} />
          <DashboardBoardGrid {...boardPresentation} renderCard={renderCard} />
        </TooltipProvider>
      </div>
    );
  }

  if (isLoading && !rawData) {
    return (
      <div>
        <LoadingState lines={8} />
      </div>
    );
  }

  if (!rawData && swrError) {
    return (
      <div>
        <ErrorState
          message={t("failedToLoadData")}
          onRetry={() => void mutate()}
          retryLabel={t("retry")}
        />
      </div>
    );
  }

  if (!data || !localizedData) {
    return (
      <div>
        <ErrorState
          message={t("failedToLoadData")}
          onRetry={() => void mutate()}
          retryLabel={t("retry")}
        />
      </div>
    );
  }

  const totalMetric = data.stats.find(metric => metric.id === "total");
  const currentInquiryVolume =
    totalMetric?.comparison?.current ?? totalMetric?.value ?? 0;
  if (currentInquiryVolume <= 0) {
    return (
      <div className="flex flex-col gap-4">
        {swrError ? (
          <RefreshErrorAlert
            message={t("failedToLoadData")}
            onRetry={() => void mutate()}
            retryLabel={t("retry")}
          />
        ) : null}
        <EmptyState title={t("empty.dashboard")} />
      </div>
    );
  }

  const hasCategoryDistribution =
    localizedData.topCategories.length > 0 || data.uncategorizedCount > 0;
  const hasChannelBreakdown = localizedData.categoriesByChannel.some(
    row => Number.isFinite(row.count) && row.count > 0
  );
  const hasActivity = data.conversationActivityByTime.some(
    row => Number.isFinite(row.count) && row.count > 0
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {!controlledDateRange ? (
        <div className="flex justify-end">
          <DateRangeControl
            iconFree
            onChange={setUncontrolledDateRange}
            value={dateRange}
          />
        </div>
      ) : null}

      {swrError ? (
        <RefreshErrorAlert
          message={t("failedToLoadData")}
          onRetry={() => void mutate()}
          retryLabel={t("retry")}
        />
      ) : null}

      <ServiceCoverageNotice coverage={data.sourceCoverage} />
      <Tabs
        className="min-w-0 gap-4"
        onValueChange={value => setActiveTab(value as DashboardTab)}
        value={activeTab}
      >
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <TabsList
            aria-label={t("tabs.label")}
            className="h-auto min-w-max justify-start"
          >
            <TabsTrigger value="overview">{t("tabs.overview")}</TabsTrigger>
            <TabsTrigger value="categories">{t("tabs.categories")}</TabsTrigger>
            <TabsTrigger value="team">{t("tabs.team")}</TabsTrigger>
            {showSources ? (
              <TabsTrigger value="sources">{t("tabs.sources")}</TabsTrigger>
            ) : null}
          </TabsList>
        </div>

        <PreservedTabsContent
          activeValue={activeTab}
          className="m-0 min-w-0"
          value="overview"
        >
          <DashboardOverview
            categoryComparisons={data.categoryComparisons}
            comparisonEnabled={effectiveComparisonEnabled}
            comparisonPeriod={data.comparisonPeriod}
            dailySeries={data.dailySeries}
            onViewAll={() => setActiveTab("categories")}
            stats={localizedData.stats}
            workspaceId={workspaceId}
          />
        </PreservedTabsContent>

        <PreservedTabsContent
          activeValue={activeTab}
          className="m-0 flex min-w-0 flex-col gap-4"
          value="categories"
        >
          <CategoryComparisonTable
            comparisonEnabled={effectiveComparisonEnabled}
            rows={data.categoryComparisons}
          />
          {hasCategoryDistribution || hasChannelBreakdown ? (
            <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-3">
              {hasCategoryDistribution ? (
                <CategoryDistributionChart
                  data={localizedData.topCategories}
                  uncategorized={localizedData.uncategorized}
                  uncategorizedPrevious={localizedData.uncategorizedPrevious}
                  comparisonEnabled={effectiveComparisonEnabled}
                />
              ) : null}
              {hasChannelBreakdown ? (
                <div className="min-w-0 xl:col-span-2">
                  <ChannelBreakdown
                    data={localizedData.categoriesByChannel}
                    insight={localizedData.complaintInsight}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </PreservedTabsContent>

        <PreservedTabsContent
          activeValue={activeTab}
          className="m-0 flex min-w-0 flex-col gap-4"
          value="team"
        >
          <ServiceTruthSummary report={data.serviceTruth} />
          <ManagerResponseOverview managers={data.managerPerformance || []} />
          {hasActivity ? (
            <ConversationActivityHeatmap
              data={data.conversationActivityByTime}
              timeZone={data.comparisonPeriod.timeZone}
            />
          ) : null}
        </PreservedTabsContent>

        {showSources ? (
          <PreservedTabsContent
            activeValue={activeTab}
            className="m-0 flex min-w-0 flex-col gap-4"
            value="sources"
          >
            {hasAdvertisementData(data.advertisement) ? (
              <AdvertisementAnalyticsSection data={data.advertisement} />
            ) : null}
            {hasInternalLabelData(data.internalLabels) ? (
              <InternalLabelsAnalyticsSection
                data={data.internalLabels}
                workspaceId={workspaceId}
              />
            ) : null}
          </PreservedTabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}

function RefreshErrorAlert({
  message,
  retryLabel,
  onRetry,
}: {
  message: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <Alert>
      <AlertDescription className="flex w-full flex-wrap items-center justify-between gap-3">
        <span>{message}</span>
        <Button onClick={onRetry} size="sm" variant="outline">
          {retryLabel}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
