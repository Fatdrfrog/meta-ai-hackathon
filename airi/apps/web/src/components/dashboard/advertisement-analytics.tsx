"use client";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  AdvertisementAnalytics,
  AdvertisementDailyCount,
  MetaAdsInsightDailyCount,
  MetaAdsInsights,
} from "@/types/dashboard";
import { useLocale, useTranslations } from "next-intl";
import { StatsCard } from "@/components/analytics/charts/StatsCard";

import { createDashboardFormatters } from "./dashboard-formatters";
import { ConversionAttributionReportSection } from "./conversion-attribution-report";
import { ConversionFeedbackReportSection } from "./conversion-feedback-report";
import { hasAdvertisementData } from "./dashboard-section-visibility";

export { hasAdvertisementData } from "./dashboard-section-visibility";

type AdvertisementTranslator = (
  key: string,
  values?: Record<string, number | string>
) => string;

function sourceTypeLabel(
  sourceType: string | null | undefined,
  t: AdvertisementTranslator
) {
  const normalized = (sourceType || "unknown").toLowerCase();
  if (normalized === "ad") return t("sourceTypes.metaAds");
  if (normalized === "post") return t("sourceTypes.instagramPosts");
  return normalized === "unknown" ? t("sourceTypes.unknown") : sourceType!;
}

function truncate(value: string, max = 96) {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 3)}...`;
}

function getRecentDailyCounts(
  dailyCounts: AdvertisementDailyCount[],
  limit = 14
) {
  return dailyCounts.slice(Math.max(0, dailyCounts.length - limit));
}

function getRecentMetaDailyCounts(
  dailyCounts: MetaAdsInsightDailyCount[],
  limit = 14
) {
  return dailyCounts.slice(Math.max(0, dailyCounts.length - limit));
}

function hasMetaInsights(metaInsights?: MetaAdsInsights | null) {
  return Boolean(
    metaInsights &&
      ((metaInsights.totalResults ?? 0) > 0 ||
        (metaInsights.totalSpend ?? 0) > 0 ||
        metaInsights.accounts?.length ||
        metaInsights.warnings?.length ||
        metaInsights.error)
  );
}

export function AdvertisementAnalyticsSection({
  data,
}: {
  data?: AdvertisementAnalytics | null;
}) {
  const locale = useLocale();
  const t = useTranslations("DashboardPage.advertisement");
  const formatters = createDashboardFormatters(locale);
  const metaInsights = data?.metaInsights ?? null;
  const hasAiriCapturedReferrals = Boolean(data && data.totalConversations > 0);
  const hasMetaAdsManagerData = hasMetaInsights(metaInsights);

  if (!data || !hasAdvertisementData(data)) {
    return null;
  }

  const recentDailyCounts = getRecentDailyCounts(data.dailyCounts);
  const maxDailyConversations = Math.max(
    1,
    ...recentDailyCounts.map(item => item.conversations)
  );
  const recentMetaDailyCounts = getRecentMetaDailyCounts(
    metaInsights?.dailyCounts ?? []
  );
  const maxDailyMetaResults = Math.max(
    1,
    ...recentMetaDailyCounts.map(item => item.results ?? 0)
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              {t("title")}
            </CardTitle>
            <CardDescription>{t("description")}</CardDescription>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {t("filterScope")}
            </p>
          </div>
          {hasAiriCapturedReferrals ? (
            <div className="flex flex-wrap gap-2">
              {data.bySourceType.map(item => (
                <Badge key={item.sourceType} variant="outline">
                  {t("sourceTypeCount", {
                    type: sourceTypeLabel(item.sourceType, t),
                    count: formatters.number(item.conversations),
                  })}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <ConversionAttributionReportSection
          report={data.conversionAttribution}
          error={data.conversionAttributionError}
        />
        <ConversionFeedbackReportSection
          report={data.conversionFeedback}
          error={data.conversionFeedbackError}
        />
        {hasMetaAdsManagerData && metaInsights ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatsCard
                title={t("tiles.metaResults")}
                value={formatters.number(metaInsights.totalResults)}
                subtitle={metaInsights.resultLabel}
              />
              <StatsCard
                title={t("tiles.spend")}
                value={formatters.currency(
                  metaInsights.totalSpend,
                  metaInsights.currency
                )}
                subtitle={t("spendScope", {
                  account:
                    metaInsights.accountName ||
                    metaInsights.accountId ||
                    t("selectedAdAccount"),
                })}
              />
              <StatsCard
                title={t("tiles.costPerResult")}
                value={formatters.currency(
                  metaInsights.costPerResult,
                  metaInsights.currency
                )}
                subtitle={metaInsights.resultActionType}
              />
              <StatsCard
                title={t("tiles.airiCaptured")}
                value={formatters.number(data.totalConversations)}
                subtitle={t("uniqueSources", { count: data.uniqueSources })}
              />
            </div>
            <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
              <p>{t("diagnostics.allMessaging")}</p>
              {metaInsights.reporting ? (
                <p>{t("diagnostics.reportTime")}</p>
              ) : null}
              <p>
                {t("diagnostics.fetchedAt", {
                  date: formatters.shortDate(metaInsights.fetchedAt),
                })}
              </p>
              {metaInsights.resultCoverage ? (
                <p>
                  {t("diagnostics.coverage", {
                    reported: formatters.integer(
                      metaInsights.resultCoverage.reportedRows
                    ),
                    missing: formatters.integer(
                      metaInsights.resultCoverage.missingRows
                    ),
                  })}
                </p>
              ) : null}
              {metaInsights.spendCoverage ? (
                <p>
                  {t("diagnostics.spendCoverage", {
                    reported: formatters.integer(
                      metaInsights.spendCoverage.reportedRows
                    ),
                    missing: formatters.integer(
                      metaInsights.spendCoverage.missingRows
                    ),
                  })}
                </p>
              ) : null}
              {metaInsights.partial ? (
                <p className="font-medium text-foreground">
                  {t("diagnostics.partial")}
                </p>
              ) : null}
              {metaInsights.warnings?.length ? (
                <ul className="list-disc space-y-1 pl-4">
                  {metaInsights.warnings.map(warning => (
                    <li key={warning}>
                      {t(`diagnostics.warnings.${warning}`)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            {metaInsights.currencyBuckets?.length ? (
              <section
                aria-label={t("diagnostics.currencyBreakdown")}
                className="min-w-0 rounded-lg border"
              >
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("diagnostics.currency")}</TableHead>
                      <TableHead className="text-right">
                        {t("tiles.spend")}
                      </TableHead>
                      <TableHead className="text-right">
                        {t("tiles.metaResults")}
                      </TableHead>
                      <TableHead className="text-right">
                        {t("diagnostics.impressions")}
                      </TableHead>
                      <TableHead className="text-right">
                        {t("diagnostics.linkClicks")}
                      </TableHead>
                      <TableHead className="text-right">
                        {t("diagnostics.ctr")}
                      </TableHead>
                      <TableHead className="text-right">
                        {t("diagnostics.cpc")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {metaInsights.currencyBuckets.map(bucket => (
                      <TableRow key={bucket.currency || "unknown"}>
                        <TableCell>
                          {bucket.currency || t("diagnostics.unknownCurrency")}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {bucket.currency
                            ? formatters.currency(bucket.spend, bucket.currency)
                            : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatters.number(bucket.results)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatters.integer(bucket.impressions)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatters.integer(bucket.linkClicks)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatters.percent(bucket.ctr)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {bucket.currency
                            ? formatters.currency(bucket.cpc, bucket.currency)
                            : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </section>
            ) : null}
            {metaInsights.accounts?.length ? (
              <details className="min-w-0 rounded-lg border p-3">
                <summary className="cursor-pointer text-sm font-medium text-foreground focus-visible:outline focus-visible:outline-ring">
                  {t("diagnostics.account")}
                </summary>
                <p className="my-3 text-xs text-muted-foreground">
                  {t("diagnostics.accountSummary")}
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("diagnostics.account")}</TableHead>
                      <TableHead>{t("diagnostics.timeZone")}</TableHead>
                      <TableHead className="text-right">
                        {t("diagnostics.impressions")}
                      </TableHead>
                      <TableHead className="text-right">
                        {t("diagnostics.reach")}
                      </TableHead>
                      <TableHead className="text-right">
                        {t("diagnostics.frequency")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {metaInsights.accounts.map(account => (
                      <TableRow key={account.accountId}>
                        <TableCell className="max-w-48 whitespace-normal break-words">
                          {account.accountName || account.accountId} ·{" "}
                          {account.currency || t("diagnostics.unknownCurrency")}
                        </TableCell>
                        <TableCell>{account.timeZone || "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatters.integer(account.impressions)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatters.integer(account.reach)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatters.number(account.frequency)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </details>
            ) : null}
            {metaInsights.error ? (
              <p className="text-xs text-destructive">{metaInsights.error}</p>
            ) : null}
          </div>
        ) : null}

        {hasAiriCapturedReferrals ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatsCard
              title={t("tiles.capturedStarts")}
              value={formatters.number(data.totalConversations)}
              subtitle={t("uniqueSources", { count: data.uniqueSources })}
            />
            <StatsCard
              title={t("tiles.responded")}
              value={formatters.number(data.respondedConversations)}
              subtitle={t("responseRate", {
                percent: formatters.percent(data.responseRate),
              })}
            />
            <StatsCard
              title={t("tiles.closed")}
              value={formatters.number(data.closedConversations)}
              subtitle={t("closeRate", {
                percent: formatters.percent(data.closeRate),
              })}
            />
            <StatsCard
              title={t("tiles.trackedSources")}
              value={formatters.number(data.topSources.length)}
              subtitle={t("topSourcesShown")}
            />
          </div>
        ) : null}

        {recentMetaDailyCounts.length > 0 ? (
          <div className="rounded-lg bg-muted/25 p-3 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium">{t("metaByDay.title")}</h3>
                <p className="text-xs text-muted-foreground">
                  {t("metaByDay.description")}
                </p>
              </div>
              <Badge variant="outline">
                {metaInsights?.dateStart === metaInsights?.dateStop
                  ? formatters.shortDate(metaInsights?.dateStart)
                  : t("dateRange", {
                      start: formatters.shortDate(metaInsights?.dateStart),
                      end: formatters.shortDate(metaInsights?.dateStop),
                    })}
              </Badge>
            </div>
            <ScrollArea className="mt-3 w-full whitespace-nowrap">
              <div className="flex w-max gap-2 pb-2">
                {recentMetaDailyCounts.map(item => {
                  const pct = item.results
                    ? Math.max(
                        8,
                        Math.round(
                          ((item.results ?? 0) / maxDailyMetaResults) * 100
                        )
                      )
                    : 0;

                  return (
                    <div
                      key={`${item.accountId || ""}:${item.date}`}
                      className="flex w-14 shrink-0 flex-col items-center gap-1"
                      title={t("metaResultTooltip", {
                        date: formatters.shortDate(item.date),
                        count: formatters.number(item.results),
                        spend:
                          (item.currency ?? metaInsights?.currency)
                            ? formatters.currency(
                                item.spend,
                                item.currency ?? metaInsights?.currency
                              )
                            : "—",
                      })}
                    >
                      <div className="flex h-20 w-full items-end rounded-md bg-muted/40 px-1">
                        <div
                          className="w-full rounded-sm bg-chart-3"
                          style={{ height: `${pct}%` }}
                        />
                      </div>
                      <span className="max-w-full truncate text-[10px] text-muted-foreground">
                        {formatters.shortDate(item.date)}
                      </span>
                      <span className="text-[11px] font-medium tabular-nums">
                        {formatters.number(item.results)}
                      </span>
                      <span className="max-w-full truncate text-[10px] text-muted-foreground">
                        {(item.currency ?? metaInsights?.currency)
                          ? formatters.currency(
                              item.spend,
                              item.currency ?? metaInsights?.currency
                            )
                          : "—"}
                      </span>
                    </div>
                  );
                })}
              </div>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
          </div>
        ) : null}

        {hasAiriCapturedReferrals && recentDailyCounts.length > 0 ? (
          <div className="rounded-lg bg-muted/25 p-3 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium">
                  {t("capturedByDay.title")}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {t("capturedByDay.description")}
                </p>
              </div>
              <Badge variant="outline">
                {t("dayCount", { count: recentDailyCounts.length })}
              </Badge>
            </div>
            <ScrollArea className="mt-3 w-full whitespace-nowrap">
              <div className="flex w-max gap-2 pb-2">
                {recentDailyCounts.map(item => {
                  const pct = Math.max(
                    8,
                    Math.round(
                      (item.conversations / maxDailyConversations) * 100
                    )
                  );

                  return (
                    <div
                      key={item.date}
                      className="flex w-14 shrink-0 flex-col items-center gap-1"
                      title={t("capturedStartTooltip", {
                        date: formatters.shortDate(item.date),
                        count: formatters.number(item.conversations),
                      })}
                    >
                      <div className="flex h-20 w-full items-end rounded-md bg-muted/40 px-1">
                        <div
                          className="w-full rounded-sm bg-chart-1"
                          style={{ height: `${pct}%` }}
                        />
                      </div>
                      <span className="max-w-full truncate text-[10px] text-muted-foreground">
                        {formatters.shortDate(item.date)}
                      </span>
                      <span className="text-[11px] font-medium tabular-nums">
                        {formatters.number(item.conversations)}
                      </span>
                    </div>
                  );
                })}
              </div>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
          </div>
        ) : null}

        {metaInsights && metaInsights.topAds.length > 0 ? (
          <div className="rounded-lg bg-muted/25 shadow-sm">
            <p className="px-4 py-3 text-xs text-muted-foreground">
              {t("diagnostics.currentDestinationHelp")}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("topAds.ad")}</TableHead>
                  <TableHead className="text-right">
                    {t("topAds.results")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("topAds.spend")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("topAds.costPerResult")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {metaInsights.topAds.map(ad => (
                  <TableRow key={`${ad.accountId || ""}:${ad.adId}`}>
                    <TableCell className="min-w-0 max-w-[20rem] whitespace-normal sm:min-w-[14rem] sm:max-w-[28rem]">
                      <div className="min-w-0">
                        <div className="truncate font-medium">
                          {truncate(ad.adName || ad.adId)}
                        </div>
                        <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                          {truncate(
                            [
                              ad.campaignName || ad.campaignId,
                              ad.adSetName || ad.adSetId,
                            ]
                              .filter(Boolean)
                              .join(" / ") || ad.adId,
                            120
                          )}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t("diagnostics.currentDestination", {
                            destination: t(
                              ad.destination === "whatsapp"
                                ? "diagnostics.destinationWhatsApp"
                                : ad.destination === "other"
                                  ? "diagnostics.destinationOther"
                                  : "diagnostics.destinationUnknown"
                            ),
                          })}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t("diagnostics.destinationUpdatedAt", {
                            date:
                              ad.destinationUpdatedAt?.slice(0, 10) ||
                              t("diagnostics.destinationUnknown"),
                          })}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {formatters.number(ad.results)}
                    </TableCell>
                    <TableCell className="text-right">
                      {(ad.currency ?? metaInsights.currency)
                        ? formatters.currency(
                            ad.spend,
                            ad.currency ?? metaInsights.currency
                          )
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {(ad.currency ?? metaInsights.currency)
                        ? formatters.currency(
                            ad.costPerResult,
                            ad.currency ?? metaInsights.currency
                          )
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}

        {hasAiriCapturedReferrals ? (
          <div className="rounded-lg bg-muted/25 shadow-sm">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("sources.source")}</TableHead>
                  <TableHead className="text-right">
                    {t("sources.starts")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("sources.responded")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("sources.closed")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("sources.latest")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.topSources.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="h-20 text-center text-sm text-muted-foreground"
                    >
                      {t("sources.empty")}
                    </TableCell>
                  </TableRow>
                ) : null}
                {data.topSources.map(source => {
                  const title =
                    source.headline ||
                    source.sourceId ||
                    source.sourceUrl ||
                    source.sourceKey;
                  const subtitle =
                    source.body ||
                    source.mediaType ||
                    (source.sourceId
                      ? t("sourceId", { id: source.sourceId })
                      : "");

                  return (
                    <TableRow key={source.sourceKey}>
                      <TableCell className="min-w-0 max-w-[20rem] whitespace-normal sm:min-w-[14rem] sm:max-w-[28rem]">
                        <div className="flex min-w-0 items-start gap-2">
                          <Badge variant="secondary" className="shrink-0">
                            {sourceTypeLabel(source.sourceType, t)}
                          </Badge>
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate font-medium">
                                {truncate(title)}
                              </span>
                              {source.sourceUrl ? (
                                <a
                                  href={source.sourceUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="shrink-0 text-muted-foreground hover:text-foreground"
                                  aria-label={t("openSource")}
                                >
                                  {t("openSource")}
                                </a>
                              ) : null}
                            </div>
                            {subtitle ? (
                              <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                                {truncate(subtitle, 120)}
                              </p>
                            ) : null}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {formatters.number(source.conversations)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatters.number(source.responded)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatters.number(source.closed)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {formatters.shortDate(source.latestAt)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
