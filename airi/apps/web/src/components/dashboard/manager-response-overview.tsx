"use client";

import { MetricHelpTooltip } from "@/components/dashboard/metric-help-tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DashboardManagerPerformance } from "@/types/dashboard";

import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { createDashboardFormatters } from "./dashboard-formatters";
import {
  formatDashboardDuration,
  type DashboardTranslator,
} from "./dashboard-localization";

function isInactiveManager(manager: DashboardManagerPerformance): boolean {
  return manager.conversations === 0 && manager.firstResponseCount === 0;
}

function TableHeadWithHelp({
  label,
  help,
  className,
}: {
  label: string;
  help: string;
  className?: string;
}) {
  const t = useTranslations("DashboardPage.managerResponse");

  return (
    <TableHead className={className}>
      <span className="inline-flex items-center justify-end gap-1.5">
        <span>{label}</span>
        <MetricHelpTooltip
          label={t("help.ariaLabel", { metric: label })}
          text={help}
        />
      </span>
    </TableHead>
  );
}

export function ManagerResponseOverview({
  managers,
}: {
  managers: DashboardManagerPerformance[];
}) {
  const [showInactive, setShowInactive] = useState(false);
  const locale = useLocale();
  const t = useTranslations("DashboardPage.managerResponse");
  const dashboardT = useTranslations("DashboardClientPage");
  const durationT = useTranslations("SectionCards");
  const formatters = createDashboardFormatters(locale);
  const { activeManagers, inactiveManagers } = useMemo(() => {
    const activeManagers: DashboardManagerPerformance[] = [];
    const inactiveManagers: DashboardManagerPerformance[] = [];
    for (const manager of managers || []) {
      (isInactiveManager(manager) ? inactiveManagers : activeManagers).push(
        manager
      );
    }
    return { activeManagers, inactiveManagers };
  }, [managers]);
  const visibleManagers = showInactive
    ? [...activeManagers, ...inactiveManagers]
    : activeManagers;
  const formatDuration = (seconds: number | null) =>
    formatDashboardDuration(
      seconds,
      locale,
      durationT as unknown as DashboardTranslator
    );

  if (!managers || managers.length === 0) return null;

  return (
    <TooltipProvider delayDuration={150}>
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {t("title")}
          </CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          {inactiveManagers.length > 0 && !showInactive ? (
            <Button
              className="w-fit"
              onClick={() => setShowInactive(true)}
              size="sm"
              variant="outline"
            >
              {dashboardT("showInactiveManagers")}
            </Button>
          ) : null}

          {visibleManagers.length > 0 ? (
            <Table>
              <TableCaption className="sr-only">
                {t("description")}
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("table.manager")}</TableHead>
                  <TableHead className="text-right">
                    {t("table.handled")}
                  </TableHead>
                  <TableHeadWithHelp
                    className="text-right"
                    label={t("table.medianFirstResponse")}
                    help={t("help.medianFirstResponse")}
                  />
                  <TableHeadWithHelp
                    className="hidden text-right md:table-cell"
                    label={t("table.p90")}
                    help={t("help.p90")}
                  />
                  <TableHead className="hidden text-right lg:table-cell">
                    {t("table.replies")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleManagers.map(manager => (
                  <TableRow key={manager.id}>
                    <TableCell className="max-w-64 whitespace-normal">
                      <div className="min-w-0">
                        <p
                          className="truncate text-sm font-medium"
                          title={manager.name}
                        >
                          {manager.name}
                        </p>
                        <p
                          className="truncate text-xs text-muted-foreground"
                          title={
                            manager.email || manager.role || t("genericManager")
                          }
                        >
                          {manager.email || manager.role || t("genericManager")}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant="outline">
                        <span className="font-mono tabular-nums">
                          {formatters.number(manager.conversations)}
                        </span>
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="inline-flex items-center justify-end gap-1 text-sm font-medium tabular-nums">
                        {formatDuration(manager.medianFirstResponseSeconds)}
                      </span>
                    </TableCell>
                    <TableCell className="hidden text-right text-sm tabular-nums text-muted-foreground md:table-cell">
                      {formatDuration(manager.p90FirstResponseSeconds)}
                    </TableCell>
                    <TableCell className="hidden text-right text-sm tabular-nums text-muted-foreground lg:table-cell">
                      {formatters.number(manager.firstResponseCount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
