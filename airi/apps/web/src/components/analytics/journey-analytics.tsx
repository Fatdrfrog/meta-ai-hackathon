"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import {
  LoadingState,
  EmptyState,
  ErrorState,
} from "@/components/ui/async-states";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AcquisitionReport } from "@/lib/analytics/acquisition-contract";
import type { WhatsAppAnalyticsResult } from "@/lib/analytics/whatsapp-analytics-contract";
import type { ChatLeakageReport } from "@/lib/analytics/chat-leakage";
import type { ServiceLifecycleReport } from "@/lib/analytics/service-lifecycle-report";
import type { MetaAdsInsights } from "@/types/dashboard";
import { comparableEfficiency } from "@/lib/analytics/acquisition-efficiency";
import {
  normalizeDashboardCustomCalendarRange,
  resolveDashboardCalendarDays,
} from "@/lib/dashboard-comparison";
import { LineChart } from "@/components/analytics/charts/LineChart";
import { WhatsAppInsightsActivation } from "@/components/analytics/whatsapp-insights-activation";
import { DashboardBoardGrid } from "@/components/dashboard/dashboard-board-grid";
import {
  formatDashboardDuration,
  type DashboardTranslator,
} from "@/components/dashboard/dashboard-localization";
import { OutcomesBoardController } from "@/components/dashboard/dashboard-board-controller";
import type {
  OutcomesBoardCard,
  OutcomesBlockId,
} from "@/components/dashboard/dashboard-board-model";
import {
  createDashboardFormatters,
  normalizeDashboardIntlLocale,
} from "@/components/dashboard/dashboard-formatters";
import {
  getAcquisitionSummary,
  observedCount,
  observedAcquisitionCount,
  qualificationHistoryCoversWindow,
  getAcquisitionQualifiedToPaidRate,
  getAcquisitionRevenueByCurrency,
} from "@/lib/analytics/journey-presentation";

const subscribeToNothing = () => () => {};
const readBrowserTimeZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const fetcher = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error("analytics_unavailable");
  return response.json();
};
const config = {
  revalidateOnFocus: false,
  shouldRetryOnError: false,
  dedupingInterval: 60000,
};
type Policy = {
  qualifiedStageKeys: string[];
  revision: number;
  stages: Array<{ key: string; name: string }>;
  canEdit: boolean;
};

function ReportTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: React.ReactNode[][];
}) {
  return (
    <div
      className="min-w-0 overflow-x-auto rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&>[data-slot=table-container]]:overflow-visible"
      tabIndex={0}
      role="region"
      aria-label={headers.join(", ")}
    >
      <Table>
        <TableHeader>
          <TableRow>
            {headers.map((header, index) => (
              <TableHead
                key={index}
                scope="col"
                className="min-w-24 max-w-44 whitespace-normal align-bottom text-xs text-muted-foreground"
              >
                {header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={index}>
              {row.map((cell, column) => (
                <TableCell
                  key={column}
                  className="max-w-60 whitespace-normal break-words py-3 tabular-nums"
                >
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function JourneyAnalytics({
  workspaceId,
  memberId,
}: {
  workspaceId: string;
  memberId: string;
}) {
  const t = useTranslations("AnalyticsOutcomes");
  const [days, setDays] = useState<7 | 30 | 90>(30),
    [observationDays, setObservation] = useState<7 | 30>(30);
  const [matureCohorts, setMatureCohorts] = useState(false);
  const [sourceId, setSource] = useState("");
  return (
    <div className="flex min-w-0 flex-col gap-4" data-outcomes-report>
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      </header>
      <OutcomesBoardController
        workspaceId={workspaceId}
        memberId={memberId}
        inlineToolbar
      >
        {presentation =>
          presentation.cards.length ? (
            <JourneyReports
              {...presentation}
              workspaceId={workspaceId}
              days={days}
              observationDays={observationDays}
              matureCohorts={matureCohorts}
              sourceId={sourceId}
              setDays={setDays}
              setObservation={setObservation}
              setMatureCohorts={setMatureCohorts}
              setSource={setSource}
            />
          ) : null
        }
      </OutcomesBoardController>
    </div>
  );
}

function JourneyReports({
  workspaceId,
  days,
  observationDays,
  matureCohorts,
  sourceId,
  cards,
  editing,
  onCardsChange,
  toolbar,
  setDays,
  setObservation,
  setMatureCohorts,
  setSource,
}: {
  workspaceId: string;
  days: 7 | 30 | 90;
  observationDays: 7 | 30;
  matureCohorts: boolean;
  sourceId: string;
  cards: OutcomesBoardCard[];
  editing: boolean;
  onCardsChange: (cards: OutcomesBoardCard[]) => void;
  toolbar: React.ReactNode;
  setDays: (days: 7 | 30 | 90) => void;
  setObservation: (days: 7 | 30) => void;
  setMatureCohorts: (mature: boolean) => void;
  setSource: (source: string) => void;
}) {
  const t = useTranslations("AnalyticsOutcomes"),
    locale = useLocale();
  const durationT = useTranslations("SectionCards");
  const visible = (ids: OutcomesBlockId[]) =>
    cards.some(card => ids.includes(card.id));
  const [sourceLabel, setSourceLabel] = useState("");
  const [calendarAnchor, setCalendarAnchor] = useState(() => Date.now());
  const [selectedStages, setStages] = useState<string[] | null>(null),
    [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState(false);
  const [refreshing, setRefreshing] = useState(false),
    [refreshError, setRefreshError] = useState(false);
  const [segment, setSegment] = useState<{
    scope: string;
    sourceId: string | null;
    adId: string | null;
    ownerId: string | null;
  } | null>(null);
  const [lifecycleRefreshedAt, setLifecycleRefreshedAt] = useState(0);
  useEffect(() => setSegment(null), [sourceId]);
  const lifecycleWindow = useMemo(() => {
    const end = new Date(Math.max(Date.now(), lifecycleRefreshedAt));
    return {
      start: new Date(end.getTime() - days * 86400000).toISOString(),
      end: end.toISOString(),
    };
  }, [days, lifecycleRefreshedAt]);
  // The server has no browser zone: calendar dates render and load after hydration.
  const browserTimeZone = useSyncExternalStore(
    subscribeToNothing,
    readBrowserTimeZone,
    () => null
  );
  const timeZone = browserTimeZone ?? "UTC";
  const calendarWindow = useMemo(() => {
    const now = new Date(Math.max(calendarAnchor, Date.now()));
    let lagDays = matureCohorts ? observationDays + 1 : 0;
    let labels = resolveDashboardCalendarDays(days, timeZone, now, lagDays);
    let range = normalizeDashboardCustomCalendarRange(
      labels.from,
      labels.to,
      timeZone
    );
    // Calendar dates must finish the elapsed observation horizon, including DST.
    while (
      matureCohorts &&
      range.endExclusive.getTime() > now.getTime() - observationDays * 86400000
    ) {
      labels = resolveDashboardCalendarDays(days, timeZone, now, ++lagDays);
      range = normalizeDashboardCustomCalendarRange(
        labels.from,
        labels.to,
        timeZone
      );
    }
    return { ...labels, ...range };
  }, [days, timeZone, calendarAnchor, matureCohorts, observationDays]);
  const prefix = `/api/workspaces/${encodeURIComponent(workspaceId)}/analytics`;
  const query = new URLSearchParams({
    days: String(days),
    observationDays: String(observationDays),
    timeZone,
    from: calendarWindow.from,
    to: calendarWindow.to,
    ...(sourceId ? { sourceId } : {}),
  });
  const acquisition = useSWR<AcquisitionReport>(
    browserTimeZone && visible(["acquisition", "flows", "retention"])
      ? `${prefix}/acquisition?${query}`
      : null,
    fetcher,
    config
  );
  // Delivery days follow the viewer's calendar like the other Outcomes blocks,
  // so nothing is requested before the browser zone is known (never as UTC).
  const sourceOptionsUrl = browserTimeZone
    ? `${prefix}/whatsapp?days=${days}&timeZone=${encodeURIComponent(browserTimeZone)}`
    : null;
  const sourceOptions = useSWR<WhatsAppAnalyticsResult>(
    sourceOptionsUrl,
    fetcher,
    { ...config, keepPreviousData: true }
  );
  const messagingUrl =
    sourceOptionsUrl &&
    `${sourceOptionsUrl}${sourceId ? `&sourceId=${encodeURIComponent(sourceId)}` : ""}`;
  const messaging = useSWR<WhatsAppAnalyticsResult>(
    messagingUrl && visible(["delivery", "templates", "health"])
      ? messagingUrl
      : null,
    fetcher,
    config
  );
  const lifecycle = useSWR<ServiceLifecycleReport>(
    visible(["health"])
      ? `${prefix}/service-lifecycle?start=${encodeURIComponent(lifecycleWindow.start)}&end=${encodeURIComponent(lifecycleWindow.end)}${sourceId ? `&sourceId=${encodeURIComponent(sourceId)}` : ""}`
      : null,
    fetcher,
    config
  );
  const scopedSegment = segment?.scope === sourceId ? segment : null;
  const attentionSegments = scopedSegment
    ? `&sourceIds=${encodeURIComponent(scopedSegment.sourceId || "__none__")}&adIds=${encodeURIComponent(scopedSegment.adId || "__none__")}&ownerIds=${encodeURIComponent(scopedSegment.ownerId || "__none__")}`
    : sourceId
      ? `&sourceIds=${encodeURIComponent(sourceId)}`
      : "";
  const attention = useSWR<ChatLeakageReport>(
    visible(["attention"])
      ? `${prefix}/chat-leakage?qualifiedOnly=true${attentionSegments}`
      : null,
    fetcher,
    config
  );
  const policy = useSWR<Policy>(
    visible(["acquisition"]) ? `${prefix}/policy` : null,
    fetcher,
    config
  );
  const dashboard = useSWR<{
    advertisement: { metaInsights: MetaAdsInsights };
  }>(
    browserTimeZone && visible(["acquisition"]) && !sourceId
      ? `/api/dashboard?workspaceId=${encodeURIComponent(workspaceId)}&from=${calendarWindow.from}&to=${calendarWindow.to}&timezone=${encodeURIComponent(timeZone)}`
      : null,
    fetcher,
    config
  );
  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(false);
    try {
      setCalendarAnchor(Date.now());
      if (visible(["health"])) setLifecycleRefreshedAt(Date.now());
      const results = await Promise.allSettled([
        messagingUrl && visible(["delivery", "templates", "health"])
          ? (async () => {
              const updated = await fetcher<WhatsAppAnalyticsResult>(
                `${messagingUrl}&refresh=1`
              );
              await messaging.mutate(updated, { revalidate: false });
              if (!sourceId)
                await sourceOptions.mutate(updated, { revalidate: false });
            })()
          : undefined,
        visible(["acquisition", "flows", "retention"])
          ? acquisition.mutate()
          : undefined,
        visible(["attention"]) ? attention.mutate() : undefined,
        visible(["acquisition"]) && !sourceId ? dashboard.mutate() : undefined,
      ]);
      setRefreshError(results.some(result => result.status === "rejected"));
    } catch {
      setRefreshError(true);
    } finally {
      setRefreshing(false);
    }
  };
  const formatters = createDashboardFormatters(locale);
  const number = formatters.number;
  const compactNumber = new Intl.NumberFormat(
    normalizeDashboardIntlLocale(locale),
    { notation: "compact", maximumFractionDigits: 1 }
  );
  const percent = (value: number | null | undefined) =>
    value == null || !Number.isFinite(value)
      ? "—"
      : new Intl.NumberFormat(normalizeDashboardIntlLocale(locale), {
          style: "percent",
          maximumFractionDigits: 1,
        }).format(value);
  const money = (
    value: number | null | undefined,
    currency: string | null | undefined
  ) =>
    value == null || !Number.isFinite(value) || !currency
      ? "—"
      : /^[A-Z]{3}$/.test(currency)
        ? new Intl.NumberFormat(normalizeDashboardIntlLocale(locale), {
            style: "currency",
            currency,
          }).format(value)
        : "—";
  const date = (value: string | null | undefined) =>
    value && Number.isFinite(Date.parse(value))
      ? new Intl.DateTimeFormat(normalizeDashboardIntlLocale(locale), {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(value))
      : "—";
  const label = (key: string) => t(key);
  const accountHealth = (status: string) =>
    t(
      `accountHealth.${["healthy", "warning", "reconnecting", "disconnected", "restricted", "disabled", "payment_required", "inaccessible"].includes(status) ? status : "unknown"}`
    );
  const stat = (items: Array<[string, number | null | undefined]>) => (
    <dl
      className={`grid grid-cols-2 gap-x-4 gap-y-5 py-2 ${items.length === 6 ? "@[36rem]:grid-cols-3 @[64rem]:grid-cols-6" : "@[36rem]:grid-cols-4"}`}
    >
      {items.map(([key, value]) => (
        <div key={key} className="flex flex-col">
          <dt className="text-sm leading-snug text-muted-foreground">
            {t(key)}
          </dt>
          <dd
            className="mt-auto break-words pt-1 text-3xl font-semibold tracking-tight tabular-nums"
            title={number(value)}
            aria-label={number(value)}
          >
            {value != null &&
            Number.isFinite(value) &&
            Math.abs(value) >= 1_000_000
              ? compactNumber.format(value)
              : number(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
  const save = async () => {
    if (!policy.data || !selectedStages?.length) return;
    setSaving(true);
    setSaveError(false);
    try {
      const response = await fetch(`${prefix}/policy`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision: policy.data.revision,
          qualifiedStageKeys: selectedStages,
        }),
      });
      if (!response.ok) throw new Error("policy_save_failed");
      await policy.mutate();
      await acquisition.mutate();
      await attention.mutate();
      setStages(null);
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };
  const data = acquisition.data,
    wa = messaging.data,
    leaks = attention.data;
  const attentionComplete = Boolean(
    leaks && !leaks.truncated && leaks.status !== "partial"
  );
  const incomplete =
    data?.coverage.status !== "ready" || Boolean(data?.coverage.truncated);
  const entries = data?.cohorts.reduce((sum, row) => sum + row.entries, 0) || 0;
  const summary = getAcquisitionSummary(data);
  const revenue = getAcquisitionRevenueByCurrency(data);
  const serviceComplete =
    lifecycle.data?.coverage.state === "streaming" &&
    !lifecycle.data.coverage.historyGapAt &&
    Boolean(lifecycle.data.coverage.firstObservedAt) &&
    Date.parse(lifecycle.data.coverage.firstObservedAt!) <=
      Date.parse(lifecycleWindow.start);
  function renderReport(tab: OutcomesBlockId) {
    const report = ["acquisition", "flows", "retention"].includes(tab)
      ? acquisition
      : tab === "attention"
        ? attention
        : messaging;
    return (
      <section
        aria-busy={
          refreshing ||
          report.isLoading ||
          (!report.data && !report.error) ||
          (tab === "health" && lifecycle.isLoading)
        }
        id={`outcomes-${tab}-report`}
        aria-label={t(`tabs.${tab}`)}
        className="@container flex h-full min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 sm:p-5"
      >
        <h2 className="text-base font-semibold tracking-tight">
          {t(`tabs.${tab}`)}
        </h2>
        {report.error ? (
          <ErrorState
            message={t("unavailable")}
            onRetry={() => void refresh()}
            retryLabel={t("refresh")}
          />
        ) : report.isLoading || !report.data ? (
          <>
            <p role="status" className="sr-only">
              {t("loading")}
            </p>
            <LoadingState lines={6} />
          </>
        ) : (
          <>
            {["acquisition", "flows", "retention"].includes(tab) && data ? (
              <>
                {incomplete ? (
                  <p
                    role="status"
                    className="border-l-2 border-[var(--chart-1)] pl-3 text-sm"
                  >
                    {t(`coverage.${data.coverage.status}`)}{" "}
                    {data.coverage.truncated ? t("truncated") : ""}
                  </p>
                ) : null}
              </>
            ) : null}
            {["acquisition", "flows", "retention"].includes(tab) && data ? (
              <details className="text-xs text-muted-foreground">
                <summary className="w-fit cursor-pointer">
                  {t("workspace.freshness")}
                </summary>
                <p className="text-xs text-muted-foreground">
                  {t("projectedThrough", {
                    date: date(data.coverage.projectedThrough),
                  })}{" "}
                  ·{" "}
                  {t("ledgerThrough", {
                    date: date(data.coverage.conversionThrough),
                  })}{" "}
                  ·{" "}
                  {t("reconciliationThrough", {
                    date: date(data.coverage.reconciliationThrough),
                  })}
                </p>
              </details>
            ) : null}
            {tab === "acquisition" && data ? (
              <>
                {stat([
                  ["entries", summary.entries],
                  ["engaged", summary.engaged],
                  ["qualified", summary.qualified],
                  ["booked", summary.booked],
                  ["paid", summary.paid],
                  ["pending", summary.pendingObservation],
                ])}
                {summary.qualificationIncomplete ? (
                  <p className="text-xs text-muted-foreground">
                    {t("workspace.qualificationIncomplete")}
                  </p>
                ) : null}
                {revenue.length ? (
                  <dl className="flex flex-wrap gap-x-8 gap-y-3 border-t pt-3">
                    {revenue.map(row => (
                      <div key={row.currency}>
                        <dt className="text-xs text-muted-foreground">
                          {t("netRevenue")} ·{" "}
                          {row.currency || t("unknownCurrency")}
                        </dt>
                        <dd className="mt-1 text-xl font-semibold tabular-nums">
                          {money(
                            row.netRevenue === 0 && incomplete
                              ? null
                              : row.netRevenue,
                            row.currency
                          )}
                        </dd>
                        {row.unknownValues > 0 ? (
                          <p className="text-xs text-muted-foreground">
                            {t("workspace.unknownRevenue", {
                              count: row.unknownValues,
                            })}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </dl>
                ) : null}
                {entries > 0 ? (
                  <div className="space-y-3 border-t pt-4">
                    <h3 className="text-sm font-medium">
                      {t("workspace.entryBreakdown")}
                    </h3>
                    <ul className="space-y-3">
                      {[...data.cohorts]
                        .sort((a, b) => b.entries - a.entries)
                        .slice(0, 6)
                        .map((row, index) => {
                          const ad =
                            dashboard.data?.advertisement.metaInsights?.topAds.find(
                              ad => ad.adId === row.adId
                            );
                          const source =
                            sourceOptions.data?.health.find(
                              source => source.sourceId === row.sourceId
                            )?.sourceName ||
                            row.sourceId ||
                            t("unassigned");
                          return (
                            <li
                              key={`${row.kind}:${row.sourceId}:${row.adId}:${index}`}
                              className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1"
                            >
                              <span className="min-w-0 break-words text-sm">
                                {row.kind === "organic"
                                  ? t("organic")
                                  : ad?.adName || row.adId || t("adEntry")}
                                <span className="ml-2 text-xs text-muted-foreground">
                                  {source}
                                </span>
                              </span>
                              <span className="text-sm font-medium tabular-nums">
                                {number(row.entries)}
                              </span>
                              <div
                                aria-hidden="true"
                                className="col-span-2 h-1.5 overflow-hidden rounded-full bg-muted"
                              >
                                <div
                                  className="h-full rounded-full bg-[var(--chart-1)]"
                                  style={{
                                    width: `${(100 * row.entries) / Math.max(...data.cohorts.map(row => row.entries), 1)}%`,
                                  }}
                                />
                              </div>
                            </li>
                          );
                        })}
                    </ul>
                    {data.cohorts.length > 6 ? (
                      <p className="text-xs text-muted-foreground">
                        {t("workspace.topEntries", { count: 6 })}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <details className="border-t pt-3">
                  <summary className="min-h-8 w-fit cursor-pointer text-sm font-medium">
                    {t("workspace.entryDetails")}
                  </summary>
                  {!entries ? (
                    <EmptyState
                      title={t("empty")}
                      description={t("emptyCohort")}
                    />
                  ) : (
                    <ReportTable
                      headers={[
                        "entryType",
                        "ad",
                        "entries",
                        "engaged",
                        "qualified",
                        "booked",
                        "paid",
                        "qualifiedToPaid",
                        "pending",
                        "currency",
                        "netRevenue",
                        "costQualified",
                        "costPaid",
                        "roas",
                      ].map(label)}
                      rows={data.cohorts.flatMap(row => {
                        const meta = dashboard.data?.advertisement.metaInsights;
                        const adRows =
                          meta?.topAds.filter(ad => ad.adId === row.adId) || [];
                        const adCurrencies = [
                          ...new Set(adRows.map(ad => ad.currency)),
                        ];
                        const comparable = Boolean(
                          !sourceId &&
                            !incomplete &&
                            row.pendingObservation === 0 &&
                            row.kind === "ad" &&
                            Boolean(row.sourceId) &&
                            data.cohorts.filter(
                              cohort =>
                                cohort.kind === "ad" && cohort.adId === row.adId
                            ).length === 1 &&
                            !meta?.partial &&
                            meta?.dateStart === calendarWindow.from &&
                            meta?.dateStop === calendarWindow.to &&
                            data.window.start ===
                              calendarWindow.start.toISOString() &&
                            data.window.end ===
                              calendarWindow.endExclusive.toISOString() &&
                            meta?.reporting?.workspaceTimeZone === timeZone &&
                            meta?.accounts?.every(
                              account => account.timeZone === timeZone
                            ) &&
                            adRows.length > 0 &&
                            adRows.every(
                              ad =>
                                ad.destination === "whatsapp" &&
                                ad.destinationUpdatedAt &&
                                Date.parse(ad.destinationUpdatedAt) <=
                                  Date.parse(data.window.start)
                            ) &&
                            adCurrencies.length === 1
                        );
                        const spend = adRows.every(ad => ad.spend !== null)
                          ? adRows.reduce((sum, ad) => sum + (ad.spend ?? 0), 0)
                          : null;
                        return (
                          row.currencies.length
                            ? row.currencies
                            : [{ currency: "", netRevenue: 0 }]
                        ).map(currency => {
                          const efficiency = comparableEfficiency({
                            spend: adRows.length ? spend : null,
                            spendCurrency: adCurrencies[0] || null,
                            revenue: currency.netRevenue,
                            revenueCurrency: currency.currency,
                            qualified: row.qualified,
                            paid: row.paid,
                            comparable,
                          });
                          const qualificationComplete =
                            qualificationHistoryCoversWindow(data);
                          return [
                            t(row.kind),
                            adRows[0]?.adName || row.adId || "—",
                            number(observedAcquisitionCount(data, row.entries)),
                            number(observedAcquisitionCount(data, row.engaged)),
                            number(
                              observedAcquisitionCount(
                                data,
                                row.qualified,
                                true
                              )
                            ),
                            number(observedAcquisitionCount(data, row.booked)),
                            number(observedAcquisitionCount(data, row.paid)),
                            percent(
                              getAcquisitionQualifiedToPaidRate(data, row)
                            ),
                            number(
                              observedAcquisitionCount(
                                data,
                                row.pendingObservation
                              )
                            ),
                            currency.currency || t("unknownCurrency"),
                            currency.currency
                              ? money(
                                  currency.netRevenue === 0 && incomplete
                                    ? null
                                    : currency.netRevenue,
                                  currency.currency
                                )
                              : "—",
                            money(
                              qualificationComplete
                                ? efficiency.costPerQualified
                                : null,
                              adCurrencies[0]
                            ),
                            money(efficiency.costPerPaid, adCurrencies[0]),
                            efficiency.netRoas == null
                              ? "—"
                              : `${number(efficiency.netRoas)}×`,
                          ];
                        });
                      })}
                    />
                  )}
                </details>
                <details className="border-t pt-3">
                  <summary className="min-h-8 w-fit cursor-pointer text-sm text-muted-foreground">
                    {t("workspace.measurement")}
                  </summary>
                  <div className="space-y-3 pt-3">
                    <p className="text-sm text-muted-foreground">
                      {t("cohortDefinition", { days: observationDays })}
                    </p>
                    <details className="border-b pb-4">
                      <summary className="cursor-pointer text-sm font-medium">
                        {t("qualification")}
                      </summary>
                      <div className="flex flex-wrap items-end gap-4 pt-3">
                        {policy.error ? (
                          <p>{t("unavailable")}</p>
                        ) : (
                          policy.data?.stages.map(stage => (
                            <label
                              key={stage.key}
                              className="flex items-center gap-2 text-sm"
                            >
                              <input
                                type="checkbox"
                                className="size-4 accent-[var(--airi-rose)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                disabled={!policy.data?.canEdit || saving}
                                checked={(
                                  selectedStages ||
                                  policy.data?.qualifiedStageKeys ||
                                  []
                                ).includes(stage.key)}
                                onChange={event => {
                                  const keys =
                                    selectedStages ||
                                    policy.data!.qualifiedStageKeys;
                                  setStages(
                                    event.target.checked
                                      ? [...keys, stage.key]
                                      : keys.filter(key => key !== stage.key)
                                  );
                                }}
                              />
                              {stage.name}
                            </label>
                          ))
                        )}
                        {policy.data?.canEdit ? (
                          <Button
                            size="sm"
                            disabled={!selectedStages?.length || saving}
                            onClick={() => void save()}
                          >
                            {saving ? t("saving") : t("save")}
                          </Button>
                        ) : null}
                      </div>
                      {saveError ? (
                        <p
                          role="alert"
                          className="mt-2 text-sm text-destructive"
                        >
                          {t("saveFailed")}
                        </p>
                      ) : null}
                      <p className="mt-3 text-xs text-muted-foreground">
                        {t("qualificationHelp")}
                      </p>
                    </details>
                    <p className="text-xs text-muted-foreground">
                      {t("cohortPeriod", {
                        from: calendarWindow.from,
                        to: calendarWindow.to,
                      })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("qualificationCoverage")} {t("qualifiedToPaidHelp")}{" "}
                      {t("efficiencyHelp")}{" "}
                      {t("identityCoverage", {
                        count: data.coverage.identityMissing,
                      })}
                    </p>
                  </div>
                </details>
              </>
            ) : null}
            {tab === "attention" && leaks ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {t("attentionScope", { date: date(leaks.asOf) })}
                </p>
                {leaks.truncated || leaks.audienceTruncated ? (
                  <p role="status" className="text-sm">
                    {t("truncated")}
                  </p>
                ) : null}
                {stat([
                  [
                    "needsReply",
                    observedCount(leaks.counts.needsReply, attentionComplete),
                  ],
                  [
                    "agedUnanswered",
                    observedCount(
                      leaks.counts.agedUnanswered,
                      attentionComplete
                    ),
                  ],
                  [
                    "stalled",
                    observedCount(leaks.counts.stalled, attentionComplete),
                  ],
                  [
                    "handoff",
                    observedCount(leaks.counts.handoff, attentionComplete),
                  ],
                ])}
                {scopedSegment ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setSegment(null)}
                  >
                    {t("clearSegment")}
                  </Button>
                ) : null}
                {leaks.audience.length ? (
                  <ul className="divide-y border-t">
                    {leaks.audience.slice(0, 3).map(row => (
                      <li
                        key={row.conversationId}
                        className="flex min-w-0 items-center justify-between gap-3 py-3"
                      >
                        <div className="min-w-0">
                          <p className="break-words text-sm font-medium">
                            {row.customerName || t("unassigned")}
                          </p>
                          <p className="mt-0.5 break-words text-xs text-muted-foreground">
                            {row.stageName || row.stageKey} ·{" "}
                            {row.ownerName || t("unassigned")}
                          </p>
                        </div>
                        <Link
                          className="shrink-0 rounded-sm py-2 text-sm text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          href={`/panel/w/${workspaceId}/requests?conversation=${encodeURIComponent(row.conversationId)}`}
                        >
                          {row.followUp
                            ? t(`followUp.${row.followUp.kind}`)
                            : t("openChat")}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <details className="border-t pt-3">
                  <summary className="min-h-8 w-fit cursor-pointer text-sm font-medium">
                    {t("workspace.leadDetails")}
                  </summary>
                  <div className="space-y-4 pt-3">
                    {leaks.groups?.length ? (
                      <ReportTable
                        headers={[
                          "source",
                          "ad",
                          "owner",
                          "needsReply",
                          "stalled",
                          "segment",
                        ].map(label)}
                        rows={leaks.groups.map(group => [
                          group.sourceName || group.sourceId || t("unassigned"),
                          group.adId || "—",
                          group.ownerName || t("unassigned"),
                          number(
                            observedCount(
                              group.counts.needsReply,
                              attentionComplete
                            )
                          ),
                          number(
                            observedCount(
                              group.counts.stalled,
                              attentionComplete
                            )
                          ),
                          <Button
                            key={`${group.sourceId}:${group.adId}:${group.ownerId}`}
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setSegment({
                                scope: sourceId,
                                sourceId: group.sourceId,
                                adId: group.adId,
                                ownerId: group.ownerId,
                              })
                            }
                          >
                            {t("viewSegment")}
                          </Button>,
                        ])}
                      />
                    ) : null}
                    {!leaks.audience.length ? (
                      <EmptyState
                        title={
                          leaks.truncated ||
                          leaks.audienceTruncated ||
                          (leaks.audienceTotal ?? 0) > 0
                            ? t("workspace.audienceUnavailable")
                            : t("emptyAttention")
                        }
                      />
                    ) : (
                      <ReportTable
                        headers={[
                          "customer",
                          "stage",
                          "ad",
                          "owner",
                          "workspace.wait",
                          "nextAction",
                          "chat",
                        ].map(label)}
                        rows={leaks.audience.map(row => [
                          row.customerName || "—",
                          row.stageName || row.stageKey,
                          row.adId || "—",
                          row.ownerName || t("unassigned"),
                          formatDashboardDuration(
                            row.waitSeconds,
                            locale,
                            durationT as unknown as DashboardTranslator
                          ),
                          row.followUp
                            ? t(`followUp.${row.followUp.kind}`)
                            : "—",
                          <Link
                            key={row.conversationId}
                            className="underline underline-offset-4"
                            href={`/panel/w/${workspaceId}/requests?conversation=${encodeURIComponent(row.conversationId)}`}
                          >
                            {t("openChat")}
                          </Link>,
                        ])}
                      />
                    )}
                  </div>
                </details>
              </>
            ) : null}
            {wa &&
            ["delivery", "templates", "health"].includes(tab) &&
            (wa.limitations?.sourcesTruncated ||
              wa.limitations?.providerAccountsTruncated) ? (
              <p role="status">{t("truncated")}</p>
            ) : null}
            {wa &&
            ["templates", "health"].includes(tab) &&
            !wa.health.length ? (
              <EmptyState title={t("provider.not_connected")} />
            ) : null}
            {tab === "delivery" && wa ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {t("workspace.deliveryScope", { days })}
                </p>
                {stat([
                  ["accepted", wa.delivery.accepted],
                  ["delivered", wa.delivery.delivered],
                  ["failed", wa.delivery.failed],
                  ["pendingDelivery", wa.delivery.pending],
                ])}
                <details className="border-t pt-3">
                  <summary className="min-h-8 w-fit cursor-pointer text-sm font-medium">
                    {t("workspace.deliveryDetails")}
                  </summary>
                  <div className="space-y-4 pt-3">
                    {stat([
                      ["read", wa.delivery.read],
                      ["replied", wa.delivery.replied],
                      ["free", wa.pricing.free],
                      ["unknownPricing", wa.pricing.unknown],
                    ])}
                    <h3 className="text-sm font-medium">{t("pendingTrend")}</h3>
                    <p className="text-xs text-muted-foreground">
                      {t("dailyDeliveryScope")}
                    </p>
                    <LineChart
                      data={wa.delivery.dailyDelivery.map(row => ({
                        date: row.day,
                        label: row.day,
                        value: row.pending,
                      }))}
                      emptyLabel={t("empty")}
                      valueLabel={t("pendingDelivery")}
                      height={220}
                      formatValue={number}
                    />
                    <details>
                      <summary className="cursor-pointer text-sm font-medium">
                        {t("dailyDelivery")}
                      </summary>
                      <ReportTable
                        headers={[
                          "day",
                          "accepted",
                          "delivered",
                          "read",
                          "replied",
                          "failed",
                          "pendingDelivery",
                        ].map(label)}
                        rows={wa.delivery.dailyDelivery.map(row => [
                          row.day,
                          number(row.accepted),
                          number(row.delivered),
                          number(row.read),
                          number(row.replied),
                          number(row.failed),
                          number(row.pending),
                        ])}
                      />
                    </details>
                    <ReportTable
                      headers={[
                        "origin",
                        "accepted",
                        "delivered",
                        "read",
                        "replied",
                        "failed",
                      ].map(label)}
                      rows={wa.delivery.byOrigin.map(row => [
                        t(`origins.${row.origin}`),
                        number(row.accepted),
                        number(row.delivered),
                        number(row.read),
                        number(row.replied),
                        number(row.failed),
                      ])}
                    />
                    <details>
                      <summary className="cursor-pointer text-sm font-medium">
                        {t("sourceTemplateBreakdown")}
                      </summary>
                      {wa.delivery.breakdownTruncated ? (
                        <p role="status">{t("truncated")}</p>
                      ) : null}
                      <ReportTable
                        headers={[
                          "source",
                          "phone",
                          "template",
                          "accepted",
                          "delivered",
                          "read",
                          "replied",
                          "failed",
                          "pendingDelivery",
                        ].map(label)}
                        rows={wa.delivery.bySourcePhoneTemplate.map(row => [
                          sourceOptions.data?.health.find(
                            source => source.sourceId === row.sourceId
                          )?.sourceName ||
                            row.sourceId ||
                            "—",
                          row.phoneNumberId || "—",
                          row.template || "—",
                          number(row.accepted),
                          number(row.delivered),
                          number(row.read),
                          number(row.replied),
                          number(row.failed),
                          number(row.pending),
                        ])}
                      />
                    </details>
                    <ReportTable
                      headers={["latency", "medianSeconds", "p95Seconds"].map(
                        label
                      )}
                      rows={[
                        [
                          t("deliveryLatency"),
                          number(wa.delivery.medianDeliverySeconds),
                          number(wa.delivery.p95DeliverySeconds),
                        ],
                        [
                          t("readLatency"),
                          number(wa.delivery.medianReadSeconds),
                          number(wa.delivery.p95ReadSeconds),
                        ],
                      ]}
                    />
                    <h3 className="text-sm font-medium">{t("accountSpend")}</h3>
                    <p className="text-xs text-muted-foreground">
                      {t("pricingHelp")}
                    </p>
                    <ReportTable
                      headers={[
                        "account",
                        "status",
                        "currency",
                        "approximateSpend",
                        "fetchedAt",
                      ].map(label)}
                      rows={wa.pricing.providerAccounts.map(account => [
                        account.sourceName,
                        t(`provider.${account.pricingStatus}`),
                        account.currency || t("unknownCurrency"),
                        money(account.approximateSpend, account.currency),
                        date(account.fetchedAt),
                      ])}
                    />
                    {wa.pricing.providerAccounts.map(account => (
                      <details key={account.accountKey}>
                        <summary className="cursor-pointer text-sm font-medium">
                          {t("pricingDetails")} · {account.sourceName}
                        </summary>
                        <p className="py-2 text-xs text-muted-foreground">
                          {t("providerWindow", {
                            start: date(account.providerWindow.start),
                            end: date(account.providerWindow.end),
                          })}
                        </p>
                        <ReportTable
                          headers={[
                            "country",
                            "category",
                            "billingType",
                            "tier",
                            "volume",
                            "cost",
                            "currency",
                          ].map(label)}
                          rows={account.pricing.map(point => [
                            point.country || "—",
                            point.category || "—",
                            point.type || "—",
                            point.tier || "—",
                            number(point.volume),
                            money(point.cost, point.currency),
                            point.currency || t("unknownCurrency"),
                          ])}
                        />
                      </details>
                    ))}
                    {wa.delivery.topErrors.length ? (
                      <ReportTable
                        headers={["errorCode", "count"].map(label)}
                        rows={wa.delivery.topErrors.map(error => [
                          error.code,
                          number(error.count),
                        ])}
                      />
                    ) : null}
                  </div>
                </details>
              </>
            ) : null}
            {tab === "templates" && wa ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {t("templateScope")}
                </p>
                <details>
                  <summary className="cursor-pointer text-sm font-medium">
                    {t("templateHistory")}
                  </summary>
                  <p className="py-2 text-xs text-muted-foreground">
                    {t("templateHistoryScope")}
                  </p>
                  <ReportTable
                    headers={[
                      "fetchedAt",
                      "template",
                      "event",
                      "status",
                      "quality",
                      "category",
                    ].map(label)}
                    rows={(wa.templateLifecycle || []).map(event => [
                      date(event.at),
                      event.name,
                      event.kind,
                      event.status || "—",
                      event.quality || "—",
                      event.category || "—",
                    ])}
                  />
                </details>
                {wa.templates.map(account => (
                  <div
                    key={account.accountKey}
                    className="flex min-w-0 flex-col gap-3"
                  >
                    <h3 className="text-sm font-medium">
                      {account.sourceName}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {t(`provider.${account.templateStatus}`)} ·{" "}
                      {date(account.fetchedAt)}
                    </p>
                    {account.templateStatus === "activation_required" ? (
                      <WhatsAppInsightsActivation
                        workspaceId={workspaceId}
                        sourceId={account.sourceId}
                        accountName={account.sourceName}
                        onEnabled={refresh}
                      />
                    ) : null}
                    {account.providerWindow ? (
                      <p className="text-xs text-muted-foreground">
                        {t("providerWindow", {
                          start: date(account.providerWindow.start),
                          end: date(account.providerWindow.end),
                        })}
                      </p>
                    ) : null}
                    {account.templatesTruncated ? (
                      <p>{t("truncated")}</p>
                    ) : null}
                    <ReportTable
                      headers={[
                        "template",
                        "status",
                        "category",
                        "quality",
                        "sent",
                        "delivered",
                        "read",
                        "clicked",
                        "uniqueClicked",
                        "quickReply",
                        "readRate",
                        "clickRate",
                        "cost",
                        "costPerDelivered",
                        "currency",
                      ].map(label)}
                      rows={account.templates.map(template => [
                        `${template.name} · ${template.language}`,
                        template.status,
                        template.category,
                        template.quality || "—",
                        number(template.sent),
                        number(template.delivered),
                        number(template.read),
                        number(template.clicked),
                        number(template.uniqueClicked),
                        number(template.quickReplyClicked),
                        percent(template.readRate),
                        percent(template.clickRate),
                        money(template.cost, template.currency),
                        money(template.costPerDelivered, template.currency),
                        template.currency || "—",
                      ])}
                    />
                  </div>
                ))}
              </>
            ) : null}
            {tab === "health" && wa ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {t("healthScope")}
                </p>
                <ReportTable
                  headers={[
                    "source",
                    "phoneQuality",
                    "portfolioLimit",
                    "accountStatus",
                    "webhook",
                    "templateIssues",
                    "tracking",
                    "lastVerified",
                  ].map(label)}
                  rows={wa.health.map(source => [
                    source.sourceName,
                    source.phoneQuality || "—",
                    source.portfolioLimit || "—",
                    accountHealth(source.accountStatus),
                    t(`webhookStatus.${source.webhookStatus}`),
                    number(source.templateIssues),
                    t(`activation.${source.activationStatus}`),
                    date(source.lastVerifiedAt),
                  ])}
                />
                {wa.health.map(source => (
                  <details key={source.sourceId}>
                    <summary className="cursor-pointer text-sm font-medium">
                      {t("healthHistory")} · {source.sourceName} ·{" "}
                      {t(`freshness.${source.verificationFreshness}`)}
                    </summary>
                    <p className="py-2 text-xs text-muted-foreground">
                      {t("healthHistoryScope")}
                    </p>
                    <ReportTable
                      headers={[
                        "day",
                        "phoneQuality",
                        "portfolioLimit",
                        "accountStatus",
                        "webhook",
                        "templateIssues",
                        "pending7d",
                        "failed7d",
                        "healthObservedAt",
                        "deliveryObservedAt",
                      ].map(label)}
                      rows={source.history.map(row => [
                        row.day,
                        row.phoneQuality || "—",
                        row.portfolioLimit || "—",
                        accountHealth(row.accountStatus),
                        t(`webhookStatus.${row.webhookStatus}`),
                        number(row.templateIssues),
                        number(row.pending7d),
                        number(row.failed7d),
                        date(row.observedAt),
                        date(row.deliveryObservedAt),
                      ])}
                    />
                  </details>
                ))}
                <p className="text-xs text-muted-foreground">
                  {t("activationHelp")}
                </p>
                <h3 className="text-sm font-medium">{t("serviceHistory")}</h3>
                <p className="text-xs text-muted-foreground">
                  {t("serviceHistoryScope")}
                </p>
                {lifecycle.error ? (
                  <p role="status">{t("unavailable")}</p>
                ) : lifecycle.isLoading ? (
                  <p role="status">{t("loading")}</p>
                ) : lifecycle.data ? (
                  <>
                    <p className="text-sm">
                      {t(`lifecycleState.${lifecycle.data.coverage.state}`)} ·{" "}
                      {date(lifecycle.data.coverage.firstObservedAt)}
                    </p>
                    {lifecycle.data.coverage.historyGapAt ? (
                      <p role="status">
                        {t("historyGap", {
                          date: date(lifecycle.data.coverage.historyGapAt),
                        })}
                      </p>
                    ) : null}
                    {stat([
                      ["resolved", lifecycle.data.observed.resolvedEvents],
                      ["reopened", lifecycle.data.observed.reopened],
                      [
                        "handoffStarted",
                        observedCount(
                          lifecycle.data.observed.handoffStarted,
                          serviceComplete
                        ),
                      ],
                      ["handoffEnded", lifecycle.data.observed.handoffEnded],
                      [
                        "unknownClosures",
                        observedCount(
                          lifecycle.data.observed.unknownClosures,
                          serviceComplete
                        ),
                      ],
                      [
                        "timeoutClosures",
                        observedCount(
                          lifecycle.data.observed.timeoutClosures,
                          serviceComplete
                        ),
                      ],
                      [
                        "snapshotEvents",
                        observedCount(
                          lifecycle.data.observed.snapshotEvents,
                          serviceComplete
                        ),
                      ],
                      ["streamEvents", lifecycle.data.observed.streamEvents],
                    ])}
                    <ReportTable
                      headers={[
                        "source",
                        "resolved",
                        "resolutionSeconds",
                        "handoffSeconds",
                        "measuredResolutions",
                      ].map(label)}
                      rows={lifecycle.data.bySource.map(row => [
                        wa.health.find(
                          source => source.sourceId === row.sourceId
                        )?.sourceName ||
                          row.sourceId ||
                          "—",
                        number(row.resolvedEvents),
                        number(row.averageResolutionSeconds),
                        number(row.averageHandoffSeconds),
                        number(row.measuredResolutions),
                      ])}
                    />
                    {lifecycle.data.groupsTruncated ? (
                      <p role="status">{t("truncated")}</p>
                    ) : null}
                  </>
                ) : null}
              </>
            ) : null}
            {tab === "flows" && data ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {t("flowScope")}
                </p>
                {summary.qualificationIncomplete ? (
                  <p className="text-xs text-muted-foreground">
                    {t("workspace.qualificationIncomplete")}
                  </p>
                ) : null}
                <ReportTable
                  headers={[
                    "flow",
                    "sent",
                    "delivered",
                    "read",
                    "submitted",
                    "qualified",
                    "paid",
                  ].map(label)}
                  rows={data.flows.map(flow => [
                    flow.flowId || "—",
                    number(observedAcquisitionCount(data, flow.sent)),
                    number(observedAcquisitionCount(data, flow.delivered)),
                    number(observedAcquisitionCount(data, flow.read)),
                    number(observedAcquisitionCount(data, flow.submitted)),
                    number(
                      observedAcquisitionCount(data, flow.qualified, true)
                    ),
                    number(observedAcquisitionCount(data, flow.paid)),
                  ])}
                />
                {!data.flows.length ? <EmptyState title={t("empty")} /> : null}
              </>
            ) : null}
            {tab === "retention" && data ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {t("retentionScope", { days: observationDays })}
                </p>
                <ReportTable
                  headers={[
                    "cohortMonth",
                    "currency",
                    "customers",
                    "repeatCustomers",
                    "pendingCustomers",
                    "unknownValues",
                    "sales",
                    "grossRevenue",
                    "refundedRevenue",
                    "netRevenue",
                  ].map(label)}
                  rows={data.retention.map(row => [
                    row.cohortMonth,
                    row.currency || t("unknownCurrency"),
                    number(observedAcquisitionCount(data, row.customers)),
                    number(observedAcquisitionCount(data, row.repeatCustomers)),
                    number(
                      observedAcquisitionCount(data, row.pendingCustomers)
                    ),
                    number(observedAcquisitionCount(data, row.unknownValues)),
                    number(observedAcquisitionCount(data, row.sales)),
                    money(
                      row.grossRevenue === 0 && incomplete
                        ? null
                        : row.grossRevenue,
                      row.currency
                    ),
                    money(
                      row.refundedRevenue === 0 && incomplete
                        ? null
                        : row.refundedRevenue,
                      row.currency
                    ),
                    money(
                      row.netRevenue === 0 && incomplete
                        ? null
                        : row.netRevenue,
                      row.currency
                    ),
                  ])}
                />
                <p className="text-xs text-muted-foreground">
                  {t("retentionMaturity")}{" "}
                  {t("retentionIdentity", {
                    count: data.retentionMissingIdentity,
                  })}
                </p>
                {!data.retention.length ? (
                  <EmptyState title={t("empty")} />
                ) : null}
              </>
            ) : null}
          </>
        )}
      </section>
    );
  }
  return (
    <div className="min-w-0 space-y-4">
      <div className="grid min-w-0 grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-end">
        {visible([
          "acquisition",
          "flows",
          "retention",
          "delivery",
          "templates",
          "health",
        ]) ? (
          <label className="flex min-w-0 flex-col gap-1 text-sm sm:flex-row sm:items-center sm:gap-2">
            {t("workspace.period")}
            <select
              className="h-10 min-w-0 w-full rounded-md border bg-background px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={days}
              onChange={event =>
                setDays(Number(event.target.value) as 7 | 30 | 90)
              }
            >
              {[7, 30, 90].map(value => (
                <option key={value} value={value}>
                  {t("days", { days: value })}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex min-w-0 flex-col gap-1 text-sm sm:flex-row sm:items-center sm:gap-2">
          {t("source")}
          <select
            className="h-10 min-w-0 w-full sm:max-w-52 rounded-md border bg-background px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={sourceId}
            onChange={event => {
              setSource(event.target.value);
              setSourceLabel(
                event.target.selectedOptions[0]?.text || event.target.value
              );
            }}
          >
            <option value="">{t("allSources")}</option>
            {sourceId &&
            !sourceOptions.data?.health.some(
              source => source.sourceId === sourceId
            ) ? (
              <option value={sourceId}>{sourceLabel || sourceId}</option>
            ) : null}
            {sourceOptions.data?.health.map(source => (
              <option key={source.sourceId} value={source.sourceId}>
                {source.sourceName}
              </option>
            ))}
          </select>
        </label>
      </div>

      {visible(["acquisition", "flows", "retention"]) ? (
        <details className="text-sm">
          <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {t("workspace.observation", { days: observationDays })}
            {matureCohorts ? ` · ${t("workspace.mature")}` : ""}
          </summary>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2">
              {t("observation")}
              <select
                className="h-10 rounded-md border bg-background px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={observationDays}
                onChange={event =>
                  setObservation(Number(event.target.value) as 7 | 30)
                }
              >
                {[7, 30].map(value => (
                  <option key={value} value={value}>
                    {t("days", { days: value })}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-h-10 items-center gap-2">
              <input
                type="checkbox"
                className="size-4 accent-[var(--airi-rose)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                checked={matureCohorts}
                onChange={event => setMatureCohorts(event.target.checked)}
              />
              {t("matureCohorts")}
            </label>
          </div>
        </details>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        {browserTimeZone && visible(["acquisition", "flows", "retention"]) ? (
          <p className="text-xs text-muted-foreground">
            {t("workspace.dateScope", {
              from: createDashboardFormatters(locale).shortDate(
                calendarWindow.from
              ),
              to: createDashboardFormatters(locale).shortDate(
                calendarWindow.to
              ),
            })}
          </p>
        ) : (
          <span />
        )}
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            {refreshing ? t("workspace.refreshing") : t("refresh")}
          </Button>
          {toolbar}
        </div>
      </div>
      {refreshError ? (
        <p role="alert" className="text-sm text-destructive">
          {t("workspace.refreshFailed")}
        </p>
      ) : null}
      <DashboardBoardGrid
        cards={cards}
        editing={editing}
        onCardsChange={onCardsChange}
        getCardLabel={id => t(`tabs.${id}`)}
        gridLabel={t("workspace.title")}
        renderCard={renderReport}
      />
    </div>
  );
}
