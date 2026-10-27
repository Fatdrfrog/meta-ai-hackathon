"use client";

import { ANALYTICS_STAT_CARD_CLASS } from "@/components/analytics/analytics-surface";
import type { DashboardStatCard } from "@/components/dashboard/dashboard-localization";
import { MetricHelpTooltip } from "@/components/dashboard/metric-help-tooltip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { DashboardMetricId } from "@/types/dashboard";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import {
  DASHBOARD_LIVE_STATUS_METRICS,
  formatDashboardStatComparison,
  type DashboardTranslator,
} from "./dashboard-localization";

const METRIC_ORDER: DashboardMetricId[] = [
  "total",
  "new",
  "resolved",
  "first_response",
  "in_progress",
  "sla",
  "repeat",
  "csat",
  "ttr",
];

const METRIC_HELP_KEYS: Partial<
  Record<DashboardMetricId, "firstResponse" | "sla" | "repeat" | "csat" | "ttr">
> = {
  first_response: "firstResponse",
  sla: "sla",
  repeat: "repeat",
  csat: "csat",
  ttr: "ttr",
};

interface SectionCardsProps {
  stats: DashboardStatCard[];
  workspaceId: string;
  comparisonEnabled: boolean;
}

function statHref(
  stat: DashboardStatCard,
  workspaceId: string
): string | undefined {
  const base = `/panel/w/${workspaceId}/requests`;
  switch (stat.id) {
    case "sla":
      return `${base}?filter=slaBreached`;
    case "csat":
      return `${base}?filter=csatLow`;
    case "new":
      return `${base}?status=open`;
    case "in_progress":
      return `${base}?status=in_progress`;
    case "resolved":
      return `${base}?status=closed`;
    default:
      return undefined;
  }
}

export function MetricCard({
  stat,
  workspaceId,
  comparisonEnabled,
}: {
  stat: DashboardStatCard;
  workspaceId: string;
  comparisonEnabled: boolean;
}) {
  const locale = useLocale();
  const t = useTranslations("SectionCards");
  const href = statHref(stat, workspaceId);
  const helpKey = METRIC_HELP_KEYS[stat.id];
  const liveStatus = DASHBOARD_LIVE_STATUS_METRICS.has(stat.id);
  const comparison =
    comparisonEnabled && stat.comparison && !liveStatus
      ? formatDashboardStatComparison(
          stat.id,
          stat.comparison,
          locale,
          t as unknown as DashboardTranslator
        )
      : null;
  const comparisonNote =
    comparisonEnabled && !comparison
      ? t(
          liveStatus
            ? "comparisonNotes.liveStatus"
            : "comparisonNotes.notCompared"
        )
      : null;

  return (
    <Card
      className={cn(
        ANALYTICS_STAT_CARD_CLASS,
        stat.isHighlighted && "ring-1 ring-destructive/50"
      )}
      data-metric-id={stat.id}
    >
      <CardHeader className="gap-1 px-4">
        <CardTitle className="flex min-w-0 flex-wrap items-center justify-between gap-1.5 text-sm font-medium text-muted-foreground">
          <span className="min-w-0 break-words">{stat.label}</span>
          {helpKey ? (
            <MetricHelpTooltip
              label={t("help.ariaLabel", { metric: stat.label })}
              text={t(`help.${helpKey}`)}
            />
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-2 px-4">
        <div className="min-w-0">
          <span className="min-w-0 break-words text-3xl font-semibold tracking-tight leading-tight tabular-nums">
            {stat.value}
          </span>
        </div>
        {comparison ? (
          <p
            data-testid={`metric-comparison-${stat.id}`}
            className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs leading-relaxed text-muted-foreground"
          >
            <span className="font-medium text-foreground tabular-nums">
              {comparison.change}
            </span>
            <span className="min-w-0 break-words tabular-nums">
              {t("previousValue", { value: comparison.previous })}
            </span>
          </p>
        ) : comparisonNote ? (
          <p
            data-testid={`metric-comparison-note-${stat.id}`}
            className="text-xs leading-relaxed text-muted-foreground"
          >
            {comparisonNote}
          </p>
        ) : null}
        {stat.insight ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {stat.insight}
          </p>
        ) : null}
        {href ? (
          <Button
            asChild
            variant="link"
            size="sm"
            className="h-auto justify-start self-start whitespace-normal px-0 py-0 text-xs leading-relaxed underline dark:text-foreground"
          >
            <Link href={href}>{t("openRequestQueue")}</Link>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function orderStats(
  stats: DashboardStatCard[],
  ids: DashboardMetricId[]
): DashboardStatCard[] {
  const byId = new Map(stats.map(stat => [stat.id, stat]));
  return ids.flatMap(id => {
    const stat = byId.get(id);
    return stat ? [stat] : [];
  });
}

export function SectionCards({
  stats,
  workspaceId,
  comparisonEnabled,
}: SectionCardsProps) {
  const ordered = orderStats(stats || [], METRIC_ORDER);

  if (ordered.length === 0) return null;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="grid min-w-0 grid-cols-1 items-start gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {ordered.map(stat => (
          <MetricCard
            key={stat.id}
            comparisonEnabled={comparisonEnabled}
            stat={stat}
            workspaceId={workspaceId}
          />
        ))}
      </div>
    </TooltipProvider>
  );
}
