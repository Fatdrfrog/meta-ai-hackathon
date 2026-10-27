"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useLocale, useTranslations } from "next-intl";
import { createDashboardFormatters } from "./dashboard-formatters";

type CategoryData = { name: string; value: number; previous?: number };

export function CategoryDistributionChart({
  data,
  uncategorized,
  uncategorizedPrevious,
  comparisonEnabled = false,
}: {
  data: CategoryData[];
  uncategorized: number;
  uncategorizedPrevious?: number;
  comparisonEnabled?: boolean;
}) {
  const locale = useLocale();
  const t = useTranslations("CategoryDistributionChart");
  const formatters = createDashboardFormatters(locale);
  const meaningfulData = (data || [])
    .filter(row => row.name && Number.isFinite(row.value) && row.value > 0)
    .sort((a, b) => b.value - a.value);
  const hasUncategorized = Number.isFinite(uncategorized) && uncategorized > 0;
  if (!meaningfulData.length && !hasUncategorized) return null;

  const rows = meaningfulData.length
    ? meaningfulData
    : [
        {
          name: t("uncategorized").replace(/:\s*$/, ""),
          value: uncategorized,
          previous: uncategorizedPrevious,
        },
      ];
  const previousOf = (row: CategoryData) =>
    comparisonEnabled && Number.isFinite(row.previous)
      ? (row.previous as number)
      : null;
  // Both periods share one scale so the bar lengths compare directly.
  const maximum = Math.max(
    ...rows.map(row => Math.max(row.value, previousOf(row) ?? 0))
  );
  const previousLabel = (value: number | null | undefined) =>
    comparisonEnabled && Number.isFinite(value)
      ? t("previousValue", { value: formatters.number(value) })
      : null;

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-5">
        <ol aria-label={t("title")} className="space-y-5">
          {rows.map((row, index) => {
            const previous = previousOf(row);
            return (
              <li key={`${row.name}-${index}`} className="space-y-2">
                <div className="flex min-w-0 items-start justify-between gap-3 text-sm">
                  <span className="min-w-0 break-words">{row.name}</span>
                  <span className="flex shrink-0 flex-col items-end">
                    <span className="font-medium tabular-nums">
                      {formatters.number(row.value)}
                    </span>
                    {previous !== null ? (
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {previousLabel(previous)}
                      </span>
                    ) : null}
                  </span>
                </div>
                <div aria-hidden="true" className="space-y-1">
                  <div className="h-2 overflow-hidden rounded-sm bg-muted">
                    <div
                      className="h-full rounded-sm bg-chart-3"
                      style={{ width: `${(row.value / maximum) * 100}%` }}
                    />
                  </div>
                  {previous !== null ? (
                    <div className="h-1 overflow-hidden rounded-sm bg-muted">
                      <div
                        data-previous-bar
                        className="h-full rounded-sm bg-muted-foreground/45"
                        style={{ width: `${(previous / maximum) * 100}%` }}
                      />
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
        {meaningfulData.length && hasUncategorized ? (
          <p className="flex flex-wrap gap-x-2 border-t pt-3 text-xs text-muted-foreground">
            <span>
              {t("uncategorized")} {formatters.number(uncategorized)}
            </span>
            {previousLabel(uncategorizedPrevious) ? (
              <span className="tabular-nums">
                {previousLabel(uncategorizedPrevious)}
              </span>
            ) : null}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
