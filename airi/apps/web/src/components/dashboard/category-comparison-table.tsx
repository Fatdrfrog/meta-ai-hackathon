"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { buildDashboardCountComparison } from "@/lib/dashboard-comparison";
import type {
  DashboardCategoryComparison,
  DashboardChangeKind,
  DashboardCountComparison,
} from "@/types/dashboard";
import { createDashboardFormatters } from "./dashboard-formatters";
import {
  formatDashboardCategory,
  formatDashboardChangeKind,
  type DashboardTranslator,
} from "./dashboard-localization";

type CategoryComparisonView =
  | "all"
  | Extract<DashboardChangeKind, "increase" | "decrease" | "new">;

export interface CategoryComparisonTableProps {
  rows: DashboardCategoryComparison[];
  limit?: number;
  comparisonEnabled: boolean;
  onViewAll?: () => void;
}

const VIEWS: Array<{ value: CategoryComparisonView; labelKey: string }> = [
  { value: "all", labelKey: "categoryComparison.views.all" },
  { value: "increase", labelKey: "categoryComparison.views.increased" },
  { value: "decrease", labelKey: "categoryComparison.views.decreased" },
  { value: "new", labelKey: "categoryComparison.views.new" },
];

function ChangeValue({
  row,
  signedPercent,
  translate,
  compact = false,
}: {
  row: DashboardCountComparison;
  signedPercent: (
    value: number | null,
    maximumFractionDigits?: number
  ) => string;
  translate: DashboardTranslator;
  /** Narrow layouts: the sign already says increased or decreased. */
  compact?: boolean;
}) {
  const label = formatDashboardChangeKind(row.kind, translate);
  if (row.kind === "new") {
    return <Badge variant="secondary">{label}</Badge>;
  }
  if (row.kind === "no_longer_active") {
    return (
      <span className="inline-flex flex-wrap items-center justify-end gap-1 tabular-nums">
        <span>{signedPercent(row.percentChange, 1)}</span>
        <Badge variant="outline">{label}</Badge>
      </span>
    );
  }
  if (compact && (row.kind === "increase" || row.kind === "decrease")) {
    return (
      <span className="tabular-nums">
        {signedPercent(row.percentChange, 1)}
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1 tabular-nums">
      <span>{signedPercent(row.percentChange, 1)}</span>
      <span className="text-muted-foreground">{` · ${label}`}</span>
    </span>
  );
}

/** One category, or the total, with the mobile layout stacking paired values. */
function ComparisonRow({
  label,
  row,
  comparisonEnabled,
}: {
  label: string;
  row: DashboardCountComparison;
  comparisonEnabled: boolean;
}) {
  const locale = useLocale();
  const t = useTranslations("DashboardClientPage");
  const translate: DashboardTranslator = (key, values) => t(key, values);
  const { integer, signedInteger, signedPercent } =
    createDashboardFormatters(locale);

  return (
    <TableRow>
      <TableCell className="max-w-48 whitespace-normal break-words font-medium sm:max-w-80">
        {label}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {comparisonEnabled ? (
          <>
            <span className="hidden sm:inline">{integer(row.current)}</span>
            <span className="flex flex-col items-end gap-1 whitespace-normal text-right sm:hidden">
              <span>
                <span className="text-muted-foreground sm:hidden">
                  {t("categoryComparison.mobile.current")}:{" "}
                </span>
                {integer(row.current)}
              </span>
              <span>
                <span className="text-muted-foreground sm:hidden">
                  {t("categoryComparison.mobile.previous")}:{" "}
                </span>
                {integer(row.previous)}
              </span>
            </span>
          </>
        ) : (
          integer(row.current)
        )}
      </TableCell>
      {comparisonEnabled ? (
        <>
          <TableCell className="hidden text-right tabular-nums sm:table-cell">
            {integer(row.previous)}
          </TableCell>
          <TableCell className="text-right tabular-nums">
            <span className="hidden sm:inline">{signedInteger(row.delta)}</span>
            <span className="flex flex-col items-end gap-1 whitespace-normal text-right sm:hidden">
              <span>
                <span className="text-muted-foreground sm:hidden">
                  {t("categoryComparison.mobile.difference")}:{" "}
                </span>
                {signedInteger(row.delta)}
              </span>
              <span>
                <span className="text-muted-foreground sm:hidden">
                  {t("categoryComparison.mobile.rate")}:{" "}
                </span>
                <ChangeValue
                  row={row}
                  signedPercent={signedPercent}
                  translate={translate}
                  compact
                />
              </span>
            </span>
          </TableCell>
          <TableCell className="hidden text-right sm:table-cell">
            <ChangeValue
              row={row}
              signedPercent={signedPercent}
              translate={translate}
            />
          </TableCell>
        </>
      ) : null}
    </TableRow>
  );
}

export function CategoryComparisonTable({
  rows,
  limit,
  comparisonEnabled,
  onViewAll,
}: CategoryComparisonTableProps) {
  const t = useTranslations("DashboardClientPage");
  const translate: DashboardTranslator = (key, values) => t(key, values);
  const [view, setView] = useState<CategoryComparisonView>("all");

  const eligibleRows = useMemo(
    () => (comparisonEnabled ? rows : rows.filter(row => row.current > 0)),
    [comparisonEnabled, rows]
  );
  const filteredRows = useMemo(
    () =>
      comparisonEnabled && view !== "all"
        ? eligibleRows.filter(row => row.kind === view)
        : eligibleRows,
    [comparisonEnabled, eligibleRows, view]
  );
  // Every inquiry has exactly one category, so the sum is the period total.
  const total = useMemo(
    () =>
      buildDashboardCountComparison(
        rows.reduce((sum, row) => sum + row.current, 0),
        rows.reduce((sum, row) => sum + row.previous, 0)
      ),
    [rows]
  );
  const visibleRows =
    limit === undefined
      ? filteredRows
      : filteredRows.slice(0, Math.max(0, limit));
  const totalCoversVisibleRows = visibleRows.length === eligibleRows.length;
  const showViewAll =
    onViewAll !== undefined &&
    limit !== undefined &&
    (comparisonEnabled ? rows.length : filteredRows.length) > limit;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {t(
            comparisonEnabled ? "categoryComparison.title" : "tabs.categories"
          )}
        </CardTitle>
        <CardDescription>
          {t(
            comparisonEnabled
              ? "categoryComparison.description"
              : "categoryComparison.currentOnlyDescription"
          )}
        </CardDescription>
        {showViewAll ? (
          <CardAction>
            <Button variant="ghost" size="sm" onClick={onViewAll}>
              {t("categoryComparison.viewAll")}
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {comparisonEnabled ? (
          <ScrollArea className="w-full whitespace-nowrap">
            <ToggleGroup
              type="single"
              value={view}
              onValueChange={nextView => {
                if (nextView) setView(nextView as CategoryComparisonView);
              }}
              aria-label={t("accessibility.categoryViews")}
              variant="outline"
              size="sm"
              className="inline-flex w-max flex-nowrap"
            >
              {VIEWS.map(option => (
                <ToggleGroupItem
                  key={option.value}
                  value={option.value}
                  className="flex-none whitespace-nowrap px-3"
                >
                  {t(option.labelKey)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        ) : null}

        {visibleRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("categoryComparison.empty")}
          </p>
        ) : (
          <Table>
            <TableCaption className="sr-only">
              {t(
                comparisonEnabled
                  ? "categoryComparison.caption"
                  : "categoryComparison.currentOnlyCaption"
              )}
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>{t("categoryComparison.table.category")}</TableHead>
                <TableHead className="text-right">
                  {t("categoryComparison.table.current")}
                </TableHead>
                {comparisonEnabled ? (
                  <>
                    <TableHead className="hidden text-right sm:table-cell">
                      {t("categoryComparison.table.previous")}
                    </TableHead>
                    <TableHead className="text-right">
                      {t("categoryComparison.table.difference")}
                    </TableHead>
                    <TableHead className="hidden text-right sm:table-cell">
                      {t("categoryComparison.table.change")}
                    </TableHead>
                  </>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.map(row => (
                <ComparisonRow
                  key={row.category}
                  label={formatDashboardCategory(row.category, translate)}
                  row={row}
                  comparisonEnabled={comparisonEnabled}
                />
              ))}
            </TableBody>
            <TableFooter>
              <ComparisonRow
                label={t(
                  totalCoversVisibleRows
                    ? "categoryComparison.table.total"
                    : "categoryComparison.table.totalAllCategories"
                )}
                row={total}
                comparisonEnabled={comparisonEnabled}
              />
            </TableFooter>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
