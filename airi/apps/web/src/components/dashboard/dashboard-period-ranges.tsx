"use client";

import { createDashboardFormatters } from "@/components/dashboard/dashboard-formatters";
import { cn } from "@/lib/utils";
import type { DashboardComparisonPeriod } from "@/types/dashboard";
import { useLocale, useTranslations } from "next-intl";

interface DashboardPeriodRangesProps {
  period: DashboardComparisonPeriod | null;
  comparisonEnabled: boolean;
  className?: string;
}

export function DashboardPeriodRanges({
  period,
  comparisonEnabled,
  className,
}: DashboardPeriodRangesProps) {
  const locale = useLocale();
  const t = useTranslations("DashboardClientPage");

  if (!period) return null;

  const { dateRange } = createDashboardFormatters(locale);

  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground",
        className
      )}
    >
      <span className="break-words">
        {t("comparison.currentPeriod", {
          range: dateRange(period.current, period.timeZone),
        })}
      </span>
      {comparisonEnabled && period.previous ? (
        <span className="break-words">
          {t("comparison.previousPeriod", {
            range: dateRange(period.previous, period.timeZone),
          })}
        </span>
      ) : null}
    </div>
  );
}
