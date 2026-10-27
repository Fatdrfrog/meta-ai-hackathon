"use client";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { InternalLabelAnalytics } from "@/types/dashboard";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { StatsCard } from "@/components/analytics/charts/StatsCard";

import { createDashboardFormatters } from "./dashboard-formatters";
import { hasInternalLabelData } from "./dashboard-section-visibility";

export { hasInternalLabelData } from "./dashboard-section-visibility";

export function InternalLabelsAnalyticsSection({
  data,
  workspaceId,
}: {
  data?: InternalLabelAnalytics | null;
  workspaceId: string;
}) {
  const locale = useLocale();
  const t = useTranslations("DashboardPage.internalLabels");
  const formatters = createDashboardFormatters(locale);

  if (!data || !hasInternalLabelData(data)) {
    return null;
  }

  const coverage =
    data.taggedConversations + data.unlabeledConversations > 0
      ? (data.taggedConversations /
          (data.taggedConversations + data.unlabeledConversations)) *
        100
      : 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              {t("title")}
            </CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </div>
          <Badge variant="outline">
            {t("labeled", { percent: formatters.percent(coverage) })}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatsCard
            title={t("tiles.tagged")}
            value={formatters.number(data.taggedConversations)}
            subtitle={t("coverageDetail", {
              percent: formatters.percent(coverage),
            })}
          />
          <StatsCard
            title={t("tiles.unlabeled")}
            value={formatters.number(data.unlabeledConversations)}
            subtitle={t("noLabelAttached")}
          />
          <StatsCard
            title={t("tiles.uniqueLabels")}
            value={formatters.number(data.uniqueLabels)}
            subtitle={t("assignmentCount", {
              count: data.totalAssignments,
              countValue: formatters.number(data.totalAssignments),
            })}
          />
          <StatsCard
            title={t("tiles.topLabels")}
            value={formatters.number(data.topLabels.length)}
            subtitle={t("shownBelow")}
          />
        </div>

        <div className="rounded-lg bg-muted/25 shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("table.label")}</TableHead>
                <TableHead className="text-right">
                  {t("table.conversations")}
                </TableHead>
                <TableHead className="text-right">{t("table.open")}</TableHead>
                <TableHead className="text-right">
                  {t("table.inProgress")}
                </TableHead>
                <TableHead className="text-right">
                  {t("table.closed")}
                </TableHead>
                <TableHead className="text-right">
                  {t("table.responded")}
                </TableHead>
                <TableHead className="text-right">
                  {t("table.latest")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.topLabels.map(label => (
                <TableRow key={label.label}>
                  <TableCell className="min-w-[12rem] whitespace-normal">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="max-w-[18rem]">
                        <span className="truncate">{label.label}</span>
                      </Badge>
                      <Link
                        href={{
                          pathname: `/panel/w/${workspaceId}/requests`,
                          query: { internalLabel: label.label },
                        }}
                        className="text-xs text-primary hover:underline"
                      >
                        {t("view")}
                      </Link>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatters.number(label.conversations)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatters.number(label.open)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatters.number(label.inProgress)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatters.number(label.closed)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatters.number(label.responded)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {formatters.shortDate(label.latestAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
