"use client";

import type { DashboardStatCard } from "@/components/dashboard/dashboard-localization";
import type {
  DashboardCategoryComparison,
  DashboardComparisonPeriod,
  DashboardDailySeries,
} from "@/types/dashboard";
import { useTranslations } from "next-intl";
import { CategoryComparisonTable } from "./category-comparison-table";
import { ConversationVolumeChart } from "./conversation-volume-chart";
import { DashboardPeriodSummary } from "./dashboard-period-summary";
import { SectionCards } from "./section-cards";

export interface DashboardOverviewProps {
  workspaceId: string;
  stats: DashboardStatCard[];
  dailySeries: DashboardDailySeries;
  comparisonPeriod: DashboardComparisonPeriod;
  categoryComparisons: DashboardCategoryComparison[];
  comparisonEnabled: boolean;
  onViewAll: () => void;
}

export function DashboardOverview({
  workspaceId,
  stats,
  dailySeries,
  comparisonPeriod,
  categoryComparisons,
  comparisonEnabled,
  onViewAll,
}: DashboardOverviewProps) {
  const t = useTranslations("DashboardClientPage");

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <SectionCards
        comparisonEnabled={comparisonEnabled}
        stats={stats}
        workspaceId={workspaceId}
      />
      <ConversationVolumeChart
        comparisonPeriod={comparisonPeriod}
        comparisonEnabled={comparisonEnabled}
        current={dailySeries.current}
        currentLabel={t("categoryComparison.table.current")}
        previous={dailySeries.previous}
        previousLabel={t("categoryComparison.table.previous")}
      />
      <DashboardPeriodSummary
        comparisonEnabled={comparisonEnabled}
        comparisons={categoryComparisons}
        period={comparisonPeriod}
      />
      <CategoryComparisonTable
        comparisonEnabled={comparisonEnabled}
        limit={5}
        onViewAll={onViewAll}
        rows={categoryComparisons}
      />
    </div>
  );
}
