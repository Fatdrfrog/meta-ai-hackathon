"use client";

import type { WidgetAnalytics } from "@/app/actions/widget-analytics";
import { getWidgetAnalytics } from "@/app/actions/widget-analytics";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatsCard } from "@/components/analytics/charts/StatsCard";
import dynamic from "next/dynamic";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface WidgetUrlAnalyticsProps {
  workspaceId: string;
}

const PANEL_CARD_CLASS = "border-0 bg-muted/25 shadow-none";

const LineChart = dynamic(
  () => import("./charts/LineChart").then(module => module.LineChart),
  {
    ssr: false,
    loading: () => <Skeleton className="h-[220px] w-full" />,
  }
);

function normalizePageUrl(
  url: string,
  unknownLabel: string
): { label: string; host: string } {
  if (!url || url.trim().toLowerCase() === "unknown") {
    return { label: unknownLabel, host: "" };
  }

  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    return {
      label: path === "/" ? parsed.hostname : path,
      host: parsed.hostname,
    };
  } catch {
    return {
      label: url || unknownLabel,
      host: "",
    };
  }
}

function EmptyBlock({ label }: { label: string }) {
  return (
    <div className="flex h-36 items-center justify-center rounded-md bg-muted/30 px-4 text-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}

function DistributionList({
  items,
  emptyLabel,
  formatter,
}: {
  items: Array<{ label: string; value: number; detail?: string }>;
  emptyLabel: string;
  formatter: (value: number) => string;
}) {
  const visibleItems = items.filter(item => item.value > 0);
  const total = visibleItems.reduce((sum, item) => sum + item.value, 0);

  if (visibleItems.length === 0 || total === 0) {
    return <EmptyBlock label={emptyLabel} />;
  }

  return (
    <div className="flex flex-col gap-3">
      {visibleItems.map(item => {
        const percentage = (item.value / total) * 100;

        return (
          <div key={item.label} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate font-medium">{item.label}</span>
              <span className="shrink-0 text-muted-foreground">
                {formatter(item.value)}
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted">
              <div
                className="h-2 rounded-full bg-primary"
                style={{ width: `${Math.max(percentage, 2)}%` }}
              />
            </div>
            {item.detail ? (
              <p className="break-words text-xs text-muted-foreground">
                {item.detail}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function CompactStat({
  title,
  value,
  detail,
}: {
  title: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-muted/30 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{title}</p>
          {detail ? (
            <p className="break-words text-xs text-muted-foreground">
              {detail}
            </p>
          ) : null}
        </div>
      </div>
      <span className="max-w-[50%] break-words text-right text-sm font-semibold tabular-nums">
        {value}
      </span>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-28 rounded-lg" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
        <Skeleton className="h-80 rounded-lg" />
        <Skeleton className="h-80 rounded-lg" />
      </div>
      <Skeleton className="h-72 rounded-lg" />
    </div>
  );
}

export function WidgetUrlAnalytics({ workspaceId }: WidgetUrlAnalyticsProps) {
  const t = useTranslations("WidgetAnalytics");
  const locale = useLocale();
  const [analytics, setAnalytics] = useState<WidgetAnalytics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const requestIdRef = useRef(0);
  const intlLocale = locale === "kz" ? "kk-KZ" : locale;

  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(intlLocale),
    [intlLocale]
  );
  const oneDecimalFormatter = useMemo(
    () =>
      new Intl.NumberFormat(intlLocale, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    [intlLocale]
  );
  const percentFormatter = useMemo(
    () =>
      new Intl.NumberFormat(intlLocale, {
        style: "percent",
        maximumFractionDigits: 1,
      }),
    [intlLocale]
  );
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(intlLocale, {
        month: "short",
        day: "numeric",
      }),
    [intlLocale]
  );
  const fullDateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(intlLocale, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
    [intlLocale]
  );

  const formatNumber = useCallback(
    (value: number) => numberFormatter.format(value),
    [numberFormatter]
  );
  const formatOneDecimal = useCallback(
    (value: number) => oneDecimalFormatter.format(value),
    [oneDecimalFormatter]
  );
  const formatPercent = useCallback(
    (value: number | null | undefined) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return "-";
      return percentFormatter.format(value / 100);
    },
    [percentFormatter]
  );
  const formatDuration = useCallback(
    (seconds: number): string => {
      if (!Number.isFinite(seconds) || seconds <= 0) return "-";
      if (seconds < 60) {
        return t("units.seconds", {
          value: formatNumber(Math.round(seconds)),
        });
      }

      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = Math.round(seconds % 60);
      if (minutes < 60) {
        return `${t("units.minutes", {
          value: formatNumber(minutes),
        })} ${t("units.seconds", {
          value: formatNumber(remainingSeconds),
        })}`;
      }

      const hours = Math.floor(minutes / 60);
      const remainingMinutes = minutes % 60;
      return `${t("units.hours", {
        value: formatNumber(hours),
      })} ${t("units.minutes", {
        value: formatNumber(remainingMinutes),
      })}`;
    },
    [formatNumber, t]
  );
  const formatDate = useCallback(
    (value: string | null | undefined) => {
      if (!value) return "-";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "-";
      return fullDateFormatter.format(date);
    },
    [fullDateFormatter]
  );

  const loadAnalytics = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setIsLoading(true);
    setHasError(false);

    try {
      const result = await getWidgetAnalytics(workspaceId);
      if (requestIdRef.current !== requestId) return;

      if (result.error) {
        setAnalytics(null);
        setHasError(true);
      } else {
        setAnalytics(result.data);
      }
    } catch {
      if (requestIdRef.current !== requestId) return;
      setAnalytics(null);
      setHasError(true);
    } finally {
      if (requestIdRef.current === requestId) {
        setIsLoading(false);
      }
    }
  }, [workspaceId]);

  useEffect(() => {
    loadAnalytics();
    return () => {
      requestIdRef.current += 1;
    };
  }, [loadAnalytics]);

  if (isLoading) {
    return <LoadingSkeleton />;
  }

  if (hasError || !analytics) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <PageHeader title={t("title")} description={t("subtitle")} />
          <Button variant="outline" size="sm" onClick={loadAnalytics}>
            {t("refresh")}
          </Button>
        </div>
        <Alert variant={hasError ? "destructive" : "default"}>
          <AlertTitle>
            {hasError ? t("errorTitle") : t("noDataAvailable")}
          </AlertTitle>
          <AlertDescription>
            {hasError ? t("errors.loadFailed") : t("noDataDescription")}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const {
    source,
    conversations,
    analytics: webAnalytics,
    engagement,
  } = analytics;
  const websiteAnalyticsAvailable =
    analytics.websiteAnalyticsStatus.state === "ready";
  const hasAnyData =
    (websiteAnalyticsAvailable &&
      (webAnalytics.pageviews > 0 || webAnalytics.sessions > 0)) ||
    conversations.totalConversations > 0 ||
    conversations.totalMessages > 0;

  const lineChartData = webAnalytics.timeSeriesData.map(item => ({
    date: dateFormatter.format(new Date(item.date)),
    value: item.pageviews,
  }));
  const deviceItems = [
    {
      label: t("devices.desktop"),
      value: webAnalytics.devices.desktop,
    },
    {
      label: t("devices.mobile"),
      value: webAnalytics.devices.mobile,
    },
    {
      label: t("devices.tablet"),
      value: webAnalytics.devices.tablet,
    },
  ];
  const trafficItems = webAnalytics.trafficSources.map(sourceItem => ({
    label:
      sourceItem.source === "(direct)"
        ? t("traffic.direct")
        : sourceItem.source,
    value: sourceItem.visitors,
    detail: formatPercent(sourceItem.percentage),
  }));
  const statusItems = [
    { label: t("engagement.open"), value: engagement.statusBreakdown.open },
    {
      label: t("engagement.inProgress"),
      value: engagement.statusBreakdown.in_progress,
    },
    { label: t("engagement.closed"), value: engagement.statusBreakdown.closed },
  ];
  const sentimentItems = [
    {
      label: t("engagement.positive"),
      value: engagement.sentimentBreakdown.positive,
    },
    {
      label: t("engagement.neutral"),
      value: engagement.sentimentBreakdown.neutral,
    },
    {
      label: t("engagement.negative"),
      value: engagement.sentimentBreakdown.negative,
    },
  ];
  const categoryItems = engagement.topCategories.map(category => ({
    label: category.name,
    value: category.count,
  }));
  const visibleDomains = source?.allowedDomains.slice(0, 3) ?? [];
  const extraDomainCount =
    source && source.allowedDomains.length > visibleDomains.length
      ? source.allowedDomains.length - visibleDomains.length
      : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <PageHeader title={t("title")} description={t("subtitle")} />
        <div className="flex flex-wrap items-center gap-2">
          {source ? (
            <Badge
              variant={source.status === "active" ? "secondary" : "outline"}
            >
              {source.status === "active"
                ? t("source.statusActive")
                : source.status === "inactive"
                  ? t("source.statusInactive")
                  : t("unknown")}
            </Badge>
          ) : null}
          <Badge variant="outline">{t("privateAnalytics")}</Badge>
          <Button variant="outline" size="sm" onClick={loadAnalytics}>
            {t("refresh")}
          </Button>
        </div>
      </div>

      {websiteAnalyticsAvailable && !hasAnyData ? (
        <Alert>
          <AlertTitle>{t("noDataAvailable")}</AlertTitle>
          <AlertDescription>{t("noDataDescription")}</AlertDescription>
        </Alert>
      ) : null}

      {!websiteAnalyticsAvailable ? (
        <Alert>
          <AlertTitle>{t("websiteUnavailable.title")}</AlertTitle>
          <AlertDescription>
            {t(
              analytics.websiteAnalyticsStatus.state === "unavailable" &&
                analytics.websiteAnalyticsStatus.reason === "query_failed"
                ? "websiteUnavailable.queryFailed"
                : "websiteUnavailable.description"
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatsCard
          title={t("stats.pageviews")}
          value={
            websiteAnalyticsAvailable
              ? formatNumber(webAnalytics.pageviews)
              : "-"
          }
          subtitle={
            websiteAnalyticsAvailable
              ? t("websiteMetrics")
              : t("websiteUnavailable.metric")
          }
        />
        <StatsCard
          title={t("stats.sessions")}
          value={
            websiteAnalyticsAvailable
              ? formatNumber(webAnalytics.sessions)
              : "-"
          }
          subtitle={
            websiteAnalyticsAvailable
              ? formatDuration(webAnalytics.avgSessionDuration)
              : t("websiteUnavailable.metric")
          }
        />
        <StatsCard
          title={t("stats.conversations")}
          value={formatNumber(conversations.totalConversations)}
          subtitle={t("conversationMetrics")}
        />
        <StatsCard
          title={t("stats.chatStartRate")}
          value={
            websiteAnalyticsAvailable
              ? formatPercent(analytics.summary.chatStartRate)
              : "-"
          }
          subtitle={t("stats.chatStartRateSubtitle")}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
        <Card className={PANEL_CARD_CLASS}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              {t("charts.pageviewsTitle")}
            </CardTitle>
            <CardDescription>
              {t("charts.pageviewsDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!websiteAnalyticsAvailable ? (
              <EmptyBlock label={t("websiteUnavailable.metric")} />
            ) : lineChartData.length > 0 ? (
              <LineChart
                data={lineChartData}
                emptyLabel={t("charts.noData")}
                valueLabel={t("charts.valueLabel")}
                formatValue={formatNumber}
                height={220}
              />
            ) : (
              <EmptyBlock label={t("charts.noTimeSeriesData")} />
            )}
          </CardContent>
        </Card>

        <Card className={PANEL_CARD_CLASS}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t("source.title")}</CardTitle>
            <CardDescription>
              {source?.name ?? t("source.noSource")}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-md bg-background/70 p-2.5">
                <p className="break-words text-xs text-muted-foreground">
                  {t("source.installed")}
                </p>
                <p className="mt-1 truncate font-medium">
                  {formatDate(source?.installedAt)}
                </p>
              </div>
              <div className="rounded-md bg-background/70 p-2.5">
                <p className="break-words text-xs text-muted-foreground">
                  {t("source.position")}
                </p>
                <p className="mt-1 truncate font-medium">
                  {source?.position === "bottom-left"
                    ? t("source.positions.bottomLeft")
                    : source?.position === "bottom-right"
                      ? t("source.positions.bottomRight")
                      : t("unknown")}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Badge variant={source?.airiEnabled ? "secondary" : "outline"}>
                {t("source.airiEnabled")}
              </Badge>
              <Badge variant={source?.helpTabEnabled ? "secondary" : "outline"}>
                {t("source.helpEnabled")}
              </Badge>
              <Badge variant={source?.autoOpen ? "secondary" : "outline"}>
                {t("source.autoOpen")}
              </Badge>
            </div>

            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium uppercase text-muted-foreground">
                {t("source.domains")}
              </p>
              {visibleDomains.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {visibleDomains.map(domain => (
                    <Badge key={domain} variant="outline">
                      {domain}
                    </Badge>
                  ))}
                  {extraDomainCount > 0 ? (
                    <Badge variant="outline">+{extraDomainCount}</Badge>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("source.noDomains")}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className={PANEL_CARD_CLASS}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              {t("charts.trafficSourcesTitle")}
            </CardTitle>
            <CardDescription>
              {t("charts.trafficSourcesDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {websiteAnalyticsAvailable ? (
              <DistributionList
                items={trafficItems}
                emptyLabel={t("charts.noTrafficSourceData")}
                formatter={formatNumber}
              />
            ) : (
              <EmptyBlock label={t("websiteUnavailable.metric")} />
            )}
          </CardContent>
        </Card>

        <Card className={PANEL_CARD_CLASS}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              {t("charts.deviceBreakdownTitle")}
            </CardTitle>
            <CardDescription>
              {t("charts.deviceBreakdownDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {!websiteAnalyticsAvailable ? (
              <EmptyBlock label={t("websiteUnavailable.metric")} />
            ) : deviceItems.some(item => item.value > 0) ? (
              deviceItems.map(item => {
                return (
                  <div
                    key={item.label}
                    className="flex items-center justify-between gap-3 rounded-md bg-background/70 px-3 py-2"
                  >
                    <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                      <span className="truncate">{item.label}</span>
                    </span>
                    <Badge variant="secondary">
                      {formatNumber(item.value)}
                    </Badge>
                  </div>
                );
              })
            ) : (
              <EmptyBlock label={t("charts.noDeviceData")} />
            )}
          </CardContent>
        </Card>

        <Card className={PANEL_CARD_CLASS}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t("insights.title")}</CardTitle>
            <CardDescription>{t("engagement.title")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
            <CompactStat
              title={t("engagement.avgResponseTime")}
              value={formatDuration(engagement.avgResponseTimeSec)}
            />
            <CompactStat
              title={t("engagement.avgMessages")}
              value={formatOneDecimal(engagement.avgMessagesPerConversation)}
            />
            <CompactStat
              title={t("engagement.csatScore")}
              value={
                engagement.csatCount > 0
                  ? `${formatOneDecimal(engagement.avgCsat)}/5`
                  : "-"
              }
              detail={
                engagement.csatCount > 0
                  ? t("engagement.csatResponses", {
                      count: engagement.csatCount,
                    })
                  : undefined
              }
            />
            <CompactStat
              title={t("engagement.returningVisitors")}
              value={formatPercent(analytics.summary.returningVisitorRate)}
              detail={
                engagement.uniqueVisitors > 0
                  ? t("engagement.uniqueVisitorCount", {
                      count: engagement.uniqueVisitors,
                    })
                  : undefined
              }
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className={PANEL_CARD_CLASS}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              {t("engagement.statusTitle")}
            </CardTitle>
            <CardDescription>{t("engagement.statusDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <DistributionList
              items={statusItems}
              emptyLabel={t("breakdowns.empty")}
              formatter={formatNumber}
            />
          </CardContent>
        </Card>
        <Card className={PANEL_CARD_CLASS}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              {t("engagement.sentimentTitle")}
            </CardTitle>
            <CardDescription>{t("engagement.sentimentDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <DistributionList
              items={sentimentItems}
              emptyLabel={t("breakdowns.empty")}
              formatter={formatNumber}
            />
          </CardContent>
        </Card>
        <Card className={PANEL_CARD_CLASS}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              {t("engagement.categoriesTitle")}
            </CardTitle>
            <CardDescription>{t("engagement.categoriesDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <DistributionList
              items={categoryItems}
              emptyLabel={t("breakdowns.empty")}
              formatter={formatNumber}
            />
          </CardContent>
        </Card>
      </div>

      <Card className={PANEL_CARD_CLASS}>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("pages.title")}</CardTitle>
          <CardDescription>{t("pages.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {analytics.pages.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("pages.page")}</TableHead>
                  <TableHead className="text-right">
                    {t("pages.views")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("pages.conversations")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("pages.startRate")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("pages.lastActive")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {analytics.pages.map(page => {
                  const pageParts = normalizePageUrl(page.url, t("unknown"));

                  return (
                    <TableRow key={page.url}>
                      <TableCell className="max-w-[28rem] whitespace-normal">
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                            {pageParts.label}
                          </p>
                          {pageParts.host ? (
                            <p className="break-words text-xs text-muted-foreground">
                              {pageParts.host}
                            </p>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {websiteAnalyticsAvailable
                          ? formatNumber(page.views)
                          : "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatNumber(page.conversations)}
                      </TableCell>
                      <TableCell className="text-right">
                        {websiteAnalyticsAvailable
                          ? formatPercent(page.startRate)
                          : "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatDate(page.lastActive)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <EmptyBlock label={t("pages.empty")} />
          )}
        </CardContent>
      </Card>

      <Alert className="border-0 bg-muted/30">
        <AlertTitle>{t("privacyBanner.title")}</AlertTitle>
        <AlertDescription className="text-xs">
          {t("privacyBanner.description")}
        </AlertDescription>
      </Alert>
    </div>
  );
}
