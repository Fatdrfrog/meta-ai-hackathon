"use client";

import { useLocale, useTranslations } from "next-intl";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  DashboardCategoryComparison,
  DashboardComparisonPeriod,
} from "@/types/dashboard";
import { DashboardPeriodRanges } from "./dashboard-period-ranges";
import { createDashboardFormatters } from "./dashboard-formatters";
import {
  formatDashboardCategory,
  type DashboardTranslator,
} from "./dashboard-localization";

export interface DashboardPeriodSummaryProps {
  period: DashboardComparisonPeriod;
  comparisons: DashboardCategoryComparison[];
  comparisonEnabled: boolean;
}

function findNotableCategory(
  comparisons: DashboardCategoryComparison[]
): DashboardCategoryComparison | undefined {
  return comparisons.reduce<DashboardCategoryComparison | undefined>(
    (selected, row) => {
      if (row.delta === 0) return selected;
      if (!selected) return row;

      const difference = Math.abs(row.delta) - Math.abs(selected.delta);
      if (difference > 0) return row;
      if (difference === 0 && row.category < selected.category) return row;
      return selected;
    },
    undefined
  );
}

export function DashboardPeriodSummary({
  period,
  comparisons,
  comparisonEnabled,
}: DashboardPeriodSummaryProps) {
  const locale = useLocale();
  const t = useTranslations("DashboardClientPage");

  if (!comparisonEnabled || !period.previous) return null;

  const translate: DashboardTranslator = (key, values) => t(key, values);
  const { integer } = createDashboardFormatters(locale);
  const notable = findNotableCategory(comparisons);
  let change = t("notableChanges.unchanged");

  if (notable) {
    const values = {
      category: formatDashboardCategory(notable.category, translate),
      delta: integer(Math.abs(notable.delta)),
    };
    const key =
      notable.kind === "no_longer_active"
        ? "notableChanges.noLongerActive"
        : `notableChanges.${notable.kind}`;
    change = t(key, values);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("notableChanges.title")}</CardTitle>
        <CardDescription>{t("notableChanges.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <DashboardPeriodRanges
          period={period}
          comparisonEnabled={comparisonEnabled}
          className="text-sm"
        />
        <p>{change}</p>
      </CardContent>
    </Card>
  );
}
