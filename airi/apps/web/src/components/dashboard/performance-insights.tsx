"use client";

import { StatsCard } from "@/components/analytics/charts/StatsCard";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type {
  CoachingPriority,
  DimensionHealth,
  TeamPerformanceSummary,
} from "@/types/performance";
import { useLocale, useTranslations } from "next-intl";

import {
  createPerformanceFormatters,
  type PerformanceFormatters,
} from "./performance-localization";

function TrendPill({
  value,
  formatters,
  noTrendLabel,
}: {
  value: number | null;
  formatters: PerformanceFormatters;
  noTrendLabel: string;
}) {
  if (value === null || value === undefined) {
    return (
      <span className="text-xs text-muted-foreground">{noTrendLabel}</span>
    );
  }

  if (value > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-chart-2">
        {formatters.signedNumber(value)}
      </span>
    );
  }

  if (value < 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-destructive">
        {formatters.number(value)}
      </span>
    );
  }

  return (
    <span className="text-xs text-muted-foreground">
      {formatters.number(value)}
    </span>
  );
}

function getRiskBadgeVariant(riskScore: number) {
  if (riskScore >= 2.5) return "destructive" as const;
  if (riskScore >= 1.5) return "secondary" as const;
  return "outline" as const;
}

function getDimensionBarClass(score: number) {
  if (score >= 8) return "bg-chart-2";
  if (score >= 6) return "bg-chart-3";
  return "bg-chart-1";
}

export function PerformanceInsights({
  summary,
  dimensions,
  coachingPriorities,
}: {
  summary: TeamPerformanceSummary;
  dimensions: DimensionHealth[];
  coachingPriorities: CoachingPriority[];
}) {
  const locale = useLocale();
  const rootT = useTranslations("PerformancePage");
  const t = useTranslations("PerformancePage.insights");
  const dimensionT = useTranslations("PerformancePage.dimensions");
  const formatters = createPerformanceFormatters(
    locale,
    rootT as unknown as Parameters<typeof createPerformanceFormatters>[1]
  );
  const noTrendLabel = t("noTrendYet");

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatsCard
          title={t("summary.teamQaScore")}
          value={formatters.scoreOutOfTen(summary.avg_qa_score)}
          subtitle={
            summary.qa_score_trend === null
              ? t("summary.noPreviousPeriod")
              : t("summary.vsPreviousPeriod", {
                  value: formatters.signedNumber(summary.qa_score_trend),
                })
          }
          color="text-foreground"
        />
        <StatsCard
          title={t("summary.qaCoverage")}
          value={formatters.percent(summary.qa_coverage_rate)}
          subtitle={t("summary.scoredOfHandled", {
            count: summary.total_scored_conversations,
            scored: formatters.number(summary.total_scored_conversations),
            handled: formatters.number(summary.total_handled_conversations),
          })}
        />
        <StatsCard
          title={t("summary.managersNeedingSupport")}
          value={formatters.number(summary.managers_needing_attention)}
          subtitle={t("summary.managerTrends", {
            improving: summary.improving_managers,
            declining: summary.declining_managers,
          })}
          color={
            summary.managers_needing_attention > 0
              ? "text-destructive"
              : undefined
          }
        />
        <StatsCard
          title={t("summary.averageResponseTime")}
          value={formatters.duration(summary.avg_response_time_sec)}
          subtitle={t("summary.responseTimeDescription")}
        />
        <StatsCard
          title={t("summary.averageCsat")}
          value={
            summary.avg_csat === null
              ? rootT("duration.missing")
              : formatters.scoreOutOfFive(summary.avg_csat)
          }
          subtitle={t("summary.csatDescription")}
        />
        <StatsCard
          title={t("summary.activeManagers")}
          value={formatters.number(summary.active_managers)}
          subtitle={t("summary.lastDays", {
            count: summary.days,
            value: formatters.number(summary.days),
          })}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("dimensions.title")}</CardTitle>
            <CardDescription>{t("dimensions.description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {dimensions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("dimensions.empty")}
              </p>
            ) : (
              dimensions.map(dimension => {
                const width = Math.max(
                  5,
                  Math.min(100, dimension.average * 10)
                );
                return (
                  <div
                    key={dimension.key}
                    className="rounded-lg bg-muted/25 p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium">
                        {dimensionT(dimension.key)}
                      </p>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold">
                          {formatters.scoreOutOfTen(dimension.average)}
                        </span>
                        <TrendPill
                          value={dimension.trend}
                          formatters={formatters}
                          noTrendLabel={noTrendLabel}
                        />
                      </div>
                    </div>
                    <div className="mt-2 h-2 rounded-full bg-muted">
                      <div
                        className={cn(
                          "h-2 rounded-full transition-all",
                          getDimensionBarClass(dimension.average)
                        )}
                        style={{ width: `${width}%` }}
                      />
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t("dimensions.best")}:{" "}
                      {dimension.strongest_manager
                        ? `${dimension.strongest_manager.name} (${formatters.number(dimension.strongest_manager.score)})`
                        : rootT("duration.missing")}{" "}
                      | {t("dimensions.needsCoaching")}:{" "}
                      {dimension.weakest_manager
                        ? `${dimension.weakest_manager.name} (${formatters.number(dimension.weakest_manager.score)})`
                        : rootT("duration.missing")}
                    </p>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("coaching.title")}</CardTitle>
            <CardDescription>{t("coaching.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            {coachingPriorities.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("coaching.empty")}
              </p>
            ) : (
              <div className="space-y-3">
                {coachingPriorities.map(priority => (
                  <div
                    key={priority.id}
                    className="flex items-start justify-between gap-3 rounded-lg bg-muted/25 p-3"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <Avatar className="h-9 w-9">
                        <AvatarImage src={priority.avatar_url || undefined} />
                        <AvatarFallback>
                          {priority.name.charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {priority.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t("coaching.focus")}:{" "}
                          {dimensionT(priority.focus_area)} (
                          {formatters.scoreOutOfTen(priority.focus_score)})
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t("coaching.summary", {
                            score: formatters.number(priority.overall_qa_score),
                            count: priority.conversation_count,
                            countValue: formatters.number(
                              priority.conversation_count
                            ),
                          })}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Badge variant={getRiskBadgeVariant(priority.risk_score)}>
                        {t("coaching.risk")}{" "}
                        {formatters.number(priority.risk_score)}
                      </Badge>
                      <TrendPill
                        value={priority.trend}
                        formatters={formatters}
                        noTrendLabel={noTrendLabel}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
