import "server-only";

import { decryptMaybeString } from "@/lib/crypto";
import { normalizeDashboardCalendarDateStart } from "@/lib/dashboard-comparison";
import {
  fetchMetaAdsAdAccountById,
  resolveMetaAdsReportingAccounts,
} from "@/lib/meta-ads/meta-ads-accounts";
import { normalizeMetaAdAccountId } from "@/lib/meta-ads/meta-ad-account-id";
import { awaitWithCancellation } from "@/lib/ai/cancellation";
import { META_ADS_SOURCE_TYPE } from "@/lib/meta-ads/meta-ads-source";
import { createServerLogger } from "@/lib/observability/server-logs";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type {
  DashboardComparisonPeriod,
  DashboardTimeRange,
  MetaAdsInsights,
  MetaAdsInsightAccount,
  MetaAdsInsightAdStat,
  MetaAdsCurrencyBucket,
  MetaAdsInsightDailyCount,
} from "@/types/dashboard";
import { normalizeMetaGraphPagingNextUrl } from "@icecore/shared/lib/meta/api";
import { META_GRAPH_BASE_URL } from "@icecore/shared/lib/meta/graph-version";
import {
  readNonEmptyStringOrUndefined as normalizeOptionalString,
  asRecord,
} from "@icecore/shared/lib/value-utils";
import type { MetaAdsAdAccount } from "@icecore/shared/types/sources";

const META_AD_INSIGHTS_FIELDS = [
  "ad_id",
  "ad_name",
  "campaign_id",
  "campaign_name",
  "adset_id",
  "adset_name",
  "date_start",
  "date_stop",
  "spend",
  "actions",
  "impressions",
  "inline_link_clicks",
].join(",");

const META_RESULT_ACTION_TYPE =
  "onsite_conversion.messaging_conversation_started_7d";
const META_RESULT_LABEL = "Messaging conversations started";
const MAX_META_AD_SOURCES = 5;
const MAX_INSIGHT_ROWS_PER_PAGE = 500;
const MAX_INSIGHT_PAGES_PER_ACCOUNT = 10;
const META_REPORT_TIMEOUT_MS = 20_000;
const metaAdsInsightsLogger = createServerLogger("meta-ads.insights");

type MetaAdsSourceRow = {
  id?: string | null;
  name?: string | null;
  credentials?: unknown;
};

type MetaInsightAction = {
  action_type?: unknown;
  action_destination?: unknown;
  value?: unknown;
};

type MetaInsightRow = {
  ad_id?: unknown;
  ad_name?: unknown;
  campaign_id?: unknown;
  campaign_name?: unknown;
  adset_id?: unknown;
  adset_name?: unknown;
  date_start?: unknown;
  date_stop?: unknown;
  spend?: unknown;
  actions?: unknown;
  impressions?: unknown;
  inline_link_clicks?: unknown;
  reach?: unknown;
  frequency?: unknown;
};

type MetaGraphRowsResult = {
  rows: unknown[];
  error?: string;
  warning?: "rows_truncated" | "invalid_paging" | "report_timeout";
};

type DashboardMetaInsightsDateRange = {
  since: string;
  until: string;
};

function formatDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = new Map(parts.map(part => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

function normalizeTimeZone(value: string | undefined): string {
  const candidate = (value || "UTC").trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(
      new Date(0)
    );
    return candidate;
  } catch {
    return "UTC";
  }
}

export function resolveMetaAdsInsightsDateRange(
  currentRange: DashboardTimeRange,
  timeZone: string | undefined
): DashboardMetaInsightsDateRange {
  const resolvedTimeZone = normalizeTimeZone(timeZone);
  const endExclusive = new Date(currentRange.endExclusive);
  const endCalendarDate = formatDateInTimeZone(endExclusive, resolvedTimeZone);
  const endsAtCalendarDateStart =
    normalizeDashboardCalendarDateStart(
      endCalendarDate,
      resolvedTimeZone
    ).getTime() === endExclusive.getTime();
  const until = endsAtCalendarDateStart
    ? (() => {
        const [year, month, day] = endCalendarDate.split("-").map(Number);
        const previousDay = new Date(Date.UTC(year, month - 1, day - 1));
        return `${previousDay.getUTCFullYear()}-${String(previousDay.getUTCMonth() + 1).padStart(2, "0")}-${String(previousDay.getUTCDate()).padStart(2, "0")}`;
      })()
    : endCalendarDate;

  return {
    since: formatDateInTimeZone(new Date(currentRange.start), resolvedTimeZone),
    until,
  };
}

function readMetaError(value: unknown): string | undefined {
  const error = asRecord(value).error;
  if (!error || typeof error !== "object") return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message.slice(0, 250) : undefined;
}

async function fetchMetaGraphRows(params: {
  path: string;
  query: Record<string, string>;
  maxPages: number;
  deadline: number;
  signal: AbortSignal;
}): Promise<MetaGraphRowsResult> {
  const url = new URL(
    `${META_GRAPH_BASE_URL}/${params.path.replace(/^\/+/, "")}`
  );
  for (const [key, value] of Object.entries(params.query)) {
    if (key !== "access_token") url.searchParams.set(key, value);
  }

  const rows: unknown[] = [];
  let nextUrl: string | null = url.toString();
  let page = 0;
  const seenUrls = new Set<string>();

  while (nextUrl && page < params.maxPages) {
    const remainingTime = params.deadline - Date.now();
    if (remainingTime <= 0 || params.signal.aborted)
      return { rows, warning: "report_timeout" };
    if (seenUrls.has(nextUrl)) return { rows, warning: "invalid_paging" };
    seenUrls.add(nextUrl);
    page += 1;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(8000, remainingTime)
    );
    try {
      const response = await fetch(nextUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${params.query.access_token}` },
        signal: AbortSignal.any([controller.signal, params.signal]),
      });
      const payload = (await response.json().catch(() => null)) as {
        data?: unknown[];
        paging?: { next?: string };
      } | null;
      if (!response.ok || !Array.isArray(payload?.data)) {
        return {
          rows,
          error:
            readMetaError(payload) ||
            `Meta Graph request failed with ${response.status}`,
        };
      }

      const remaining =
        MAX_INSIGHT_ROWS_PER_PAGE * params.maxPages - rows.length;
      rows.push(...payload.data.slice(0, remaining));
      if (payload.data.length > remaining)
        return { rows, warning: "rows_truncated" };
      const rawNext = normalizeOptionalString(payload.paging?.next);
      if (rawNext) {
        try {
          nextUrl = new URL(
            normalizeMetaGraphPagingNextUrl(rawNext),
            META_GRAPH_BASE_URL
          ).toString();
        } catch {
          return { rows, warning: "invalid_paging" };
        }
        if (
          page >= params.maxPages ||
          rows.length >= MAX_INSIGHT_ROWS_PER_PAGE * params.maxPages
        ) {
          return { rows, warning: "rows_truncated" };
        }
      } else nextUrl = null;
    } catch (error) {
      if (params.signal.aborted || Date.now() >= params.deadline)
        return { rows, warning: "report_timeout" };
      return {
        rows,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return { rows };
}

function optionalMetric(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readActionValue(row: MetaInsightRow): number | null {
  // Meta lists only actions that happened, so a row that reports delivery
  // without the selected action had zero of them.
  const reported =
    optionalMetric(row.spend) !== null ||
    optionalMetric(row.impressions) !== null;
  const actions = row.actions;
  if (actions === undefined || actions === null) return reported ? 0 : null;
  if (!Array.isArray(actions)) return null;
  const selected = (actions as MetaInsightAction[]).filter(
    action => action.action_type === META_RESULT_ACTION_TYPE
  );
  if (!selected.length) return reported ? 0 : null;
  const values = selected.map(action => optionalMetric(action.value));
  return values.some(value => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + value!, 0);
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

async function fetchInsightsForAccount(params: {
  account: MetaAdsAdAccount;
  accessToken: string;
  dateRange: DashboardMetaInsightsDateRange;
  summary?: boolean;
  deadline: number;
  signal: AbortSignal;
}): Promise<MetaGraphRowsResult> {
  return fetchMetaGraphRows({
    path: `${params.account.id}/insights`,
    maxPages: params.summary ? 1 : MAX_INSIGHT_PAGES_PER_ACCOUNT,
    deadline: params.deadline,
    signal: params.signal,
    query: {
      fields: params.summary
        ? "impressions,reach,frequency,inline_link_clicks"
        : META_AD_INSIGHTS_FIELDS,
      level: params.summary ? "account" : "ad",
      time_increment: params.summary ? "all_days" : "1",
      use_unified_attribution_setting: "true",
      action_report_time: "conversion",
      ...(!params.summary
        ? { action_breakdowns: "action_type,action_destination" }
        : {}),
      limit: String(MAX_INSIGHT_ROWS_PER_PAGE),
      time_range: JSON.stringify(params.dateRange),
      access_token: params.accessToken,
    },
  });
}

/** The existing rows reader cannot parse Graph batch envelopes. Read-only GET
 * batches bound this metadata lookup to the 100 displayed ads and existing deadline.
 * Fields/enums: Meta's official SDK objects/ad.js and objects/ad-set.js. */
async function addAdDestinations(params: {
  ads: MetaAdsInsightAdStat[];
  tokens: Map<string, string>;
  deadline: number;
  signal: AbortSignal;
}) {
  const grouped = new Map<string, MetaAdsInsightAdStat[]>();
  for (const ad of params.ads) {
    ad.destination = null;
    ad.destinationType = null;
    ad.destinationUpdatedAt = null;
    const token = ad.accountId ? params.tokens.get(ad.accountId) : null;
    if (!token || !/^\d+$/.test(ad.adId)) continue;
    const group = grouped.get(token) || [];
    group.push(ad);
    grouped.set(token, group);
  }
  const batches: Array<{ token: string; ads: MetaAdsInsightAdStat[] }> = [];
  for (const [token, ads] of grouped)
    for (let index = 0; index < ads.length; index += 50)
      batches.push({ token, ads: ads.slice(index, index + 50) });
  await Promise.all(
    batches.map(async batch => {
      const remaining = params.deadline - Date.now();
      if (remaining <= 0 || params.signal.aborted) return;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.min(8000, remaining)
      );
      try {
        const response = await fetch(`${META_GRAPH_BASE_URL}/`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${batch.token}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          signal: AbortSignal.any([controller.signal, params.signal]),
          body: new URLSearchParams({
            batch: JSON.stringify(
              batch.ads.map(ad => ({
                method: "GET",
                relative_url: `${ad.adId}?fields=${encodeURIComponent("id,adset{destination_type,updated_time}")}`,
              }))
            ),
            include_headers: "false",
          }).toString(),
        });
        const payload: unknown = await response.json().catch(() => null);
        if (
          !response.ok ||
          !Array.isArray(payload) ||
          payload.length !== batch.ads.length
        )
          return;
        payload.forEach((raw, index) => {
          const envelope = asRecord(raw);
          if (envelope.code !== 200 || typeof envelope.body !== "string")
            return;
          let body: Record<string, unknown>;
          try {
            body = asRecord(JSON.parse(envelope.body));
          } catch {
            return;
          }
          const ad = batch.ads[index];
          if (body.id !== ad.adId) return;
          const adset = asRecord(body.adset);
          const destination = normalizeOptionalString(adset.destination_type);
          if (!destination || !/^[A-Z_]{1,96}$/.test(destination)) return;
          ad.destinationType = destination;
          ad.destination = destination === "WHATSAPP" ? "whatsapp" : "other";
          const updated = normalizeOptionalString(adset.updated_time);
          const date = updated ? new Date(updated) : null;
          ad.destinationUpdatedAt =
            date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
        });
      } catch {
        /* Missing metadata remains unknown; reported Insights values remain usable. */
      } finally {
        clearTimeout(timer);
      }
    })
  );
}

type MetricAccumulator = {
  spend: number;
  reportedSpendRows: number;
  missingSpendRows: number;
  results: number;
  reportedRows: number;
  missingRows: number;
  impressions: number;
  linkClicks: number;
  missingImpressions: boolean;
  missingClicks: boolean;
};
function emptyMetrics(): MetricAccumulator {
  return {
    spend: 0,
    reportedSpendRows: 0,
    missingSpendRows: 0,
    results: 0,
    reportedRows: 0,
    missingRows: 0,
    impressions: 0,
    linkClicks: 0,
    missingImpressions: false,
    missingClicks: false,
  };
}
function accumulateMetrics(target: MetricAccumulator, row: MetaInsightRow) {
  const spend = optionalMetric(row.spend);
  if (spend === null) target.missingSpendRows += 1;
  else {
    target.spend += spend;
    target.reportedSpendRows += 1;
  }
  const result = readActionValue(row);
  if (result === null) target.missingRows += 1;
  else {
    target.reportedRows += 1;
    target.results += result;
  }
  const impressions = optionalMetric(row.impressions);
  const clicks = optionalMetric(row.inline_link_clicks);
  target.missingImpressions ||= impressions === null;
  target.missingClicks ||= clicks === null;
  target.impressions += impressions ?? 0;
  target.linkClicks += clicks ?? 0;
}
function metricsForDisplay(value: MetricAccumulator) {
  const results = value.reportedRows ? value.results : null;
  const spend = value.missingSpendRows ? null : roundMetric(value.spend);
  const impressions = value.missingImpressions ? null : value.impressions;
  const linkClicks = value.missingClicks ? null : value.linkClicks;
  return {
    spend,
    results,
    missingResultRows: value.missingRows,
    missingSpendRows: value.missingSpendRows,
    costPerResult:
      results && !value.missingRows && spend !== null
        ? roundMetric(spend / results)
        : null,
    impressions,
    linkClicks,
    ctr:
      impressions && linkClicks !== null
        ? roundMetric((100 * linkClicks) / impressions)
        : null,
    cpc: linkClicks && spend !== null ? roundMetric(spend / linkClicks) : null,
  };
}

export async function fetchMetaAdsDashboardInsights(params: {
  workspaceId: string;
  comparisonPeriod: DashboardComparisonPeriod;
  /** Optional internal scope for account-bound consumers such as Airi business evidence. */
  sourceId?: string;
  adAccountId?: string;
  signal?: AbortSignal;
  deadlineAt?: number;
}): Promise<MetaAdsInsights | null> {
  params.signal?.throwIfAborted();
  const workspaceId = params.workspaceId.trim();
  if (!workspaceId) return null;
  const scopedAccountId = params.adAccountId
    ? normalizeMetaAdAccountId(params.adAccountId)
    : null;
  if (params.adAccountId && !scopedAccountId) return null;
  const deadline = Math.min(
    Date.now() + META_REPORT_TIMEOUT_MS,
    params.deadlineAt ?? Infinity
  );
  const signal = AbortSignal.any([
    AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    ...(params.signal ? [params.signal] : []),
  ]);
  const workspaceTimeZone = normalizeTimeZone(params.comparisonPeriod.timeZone);
  const dateRange = resolveMetaAdsInsightsDateRange(
    params.comparisonPeriod.current,
    workspaceTimeZone
  );
  let sourceQuery = supabaseAdmin
    .from("sources")
    .select("id, name, credentials")
    .eq("workspace_id", workspaceId)
    .eq("type", META_ADS_SOURCE_TYPE);
  if (params.sourceId) sourceQuery = sourceQuery.eq("id", params.sourceId);
  if (params.signal) sourceQuery = sourceQuery.abortSignal(signal);
  const { data, error } = await awaitWithCancellation(
    sourceQuery
      .order("created_at", { ascending: false })
      .limit(MAX_META_AD_SOURCES + 1),
    signal
  );
  if (error) {
    metaAdsInsightsLogger.error(
      "meta_ads_dashboard_source_lookup_failed",
      undefined,
      { workspaceId, error: error.message }
    );
  }
  const candidateSources = (data ?? []) as MetaAdsSourceRow[];
  if (!candidateSources.length && !error) return null;
  const sources = candidateSources
    .filter(source => !params.sourceId || source.id === params.sourceId)
    .slice(0, MAX_META_AD_SOURCES);
  const warnings = new Set<string>();
  if (error) warnings.add("sources_unavailable");
  if (candidateSources.length > MAX_META_AD_SOURCES)
    warnings.add("sources_truncated");
  const accountIds = new Set<string>();
  const totals = emptyMetrics();
  const currencies = new Map<
    string,
    { value: MetricAccumulator; accountIds: string[] }
  >();
  const daily = new Map<
    string,
    {
      value: MetricAccumulator;
      date: string;
      currency: string | null;
      accountId: string;
    }
  >();
  const ads = new Map<
    string,
    {
      value: MetricAccumulator;
      identity: Omit<
        MetaAdsInsightAdStat,
        "results" | "spend" | "costPerResult"
      >;
    }
  >();
  const actionCounts = new Map<
    string,
    { actionType: string; destination: string | null; value: number }
  >();
  const accountSummaries: MetaAdsInsightAccount[] = [];
  const accountTokens = new Map<string, string>();
  const metricAccounts: MetaAdsAdAccount[] = [];
  let firstAccount: MetaAdsAdAccount | null = null;
  let failedAccounts = 0;
  let partial = warnings.size > 0;
  for (const source of sources) {
    if (Date.now() >= deadline || signal.aborted) {
      partial = true;
      warnings.add("report_timeout");
      break;
    }
    const credentials = asRecord(source.credentials);
    const accessToken = decryptMaybeString(credentials.access_token);
    if (!accessToken) {
      partial = true;
      warnings.add("credentials_unavailable");
      continue;
    }
    let accounts: MetaAdsAdAccount[];
    try {
      if (scopedAccountId) {
        const account = await fetchMetaAdsAdAccountById({
          accessToken,
          adAccountId: scopedAccountId,
          signal,
        });
        accounts =
          account && normalizeMetaAdAccountId(account.id) === scopedAccountId
            ? [account]
            : [];
      } else {
        accounts = await resolveMetaAdsReportingAccounts({
          rawCredentials: credentials,
          accessToken,
          maxAccounts: MAX_META_AD_SOURCES,
          signal,
          onTruncated: () => {
            partial = true;
            warnings.add("accounts_truncated");
          },
          onAccountFetchError: () => {
            partial = true;
            warnings.add("accounts_unavailable");
          },
        });
      }
    } catch {
      params.signal?.throwIfAborted();
      partial = true;
      warnings.add(
        signal.aborted || Date.now() >= deadline
          ? "report_timeout"
          : "accounts_unavailable"
      );
      continue;
    }
    if (!accounts.length) {
      partial = true;
      warnings.add("accounts_unavailable");
    }
    for (const account of accounts) {
      if (Date.now() >= deadline || signal.aborted) {
        partial = true;
        warnings.add("report_timeout");
        break;
      }
      const accountId = normalizeOptionalString(account.id);
      if (!accountId || accountIds.has(accountId.toLowerCase())) continue;
      accountIds.add(accountId.toLowerCase());
      accountTokens.set(accountId, accessToken);
      firstAccount ??= account;
      const currencyCandidate = normalizeOptionalString(
        account.currency
      )?.toUpperCase();
      const currency =
        currencyCandidate && /^[A-Z]{3}$/.test(currencyCandidate)
          ? currencyCandidate
          : null;
      if (!currency) warnings.add("currency_unavailable");
      const timeZone = normalizeOptionalString(account.timezone_name) || null;
      if (!timeZone || timeZone !== workspaceTimeZone)
        warnings.add("timezone_scope");
      const [result, summary] = await Promise.all([
        fetchInsightsForAccount({
          account,
          accessToken,
          dateRange,
          deadline,
          signal,
        }),
        fetchInsightsForAccount({
          account,
          accessToken,
          dateRange,
          summary: true,
          deadline,
          signal,
        }),
      ]);
      if (result.error || result.warning) {
        partial = true;
        if (result.error) failedAccounts += 1;
        warnings.add(result.warning || "insights_unavailable");
      }
      if (summary.error || summary.warning) {
        partial = true;
        warnings.add("account_summary_unavailable");
        if (summary.warning === "report_timeout")
          warnings.add("report_timeout");
      }
      const summaryRow = asRecord(summary.rows[0]);
      const impressions = optionalMetric(summaryRow.impressions);
      const linkClicks = optionalMetric(summaryRow.inline_link_clicks);
      const bucketKey = currency || "";
      const bucket = currencies.get(bucketKey) || {
        value: emptyMetrics(),
        accountIds: [],
      };
      if (!bucket.accountIds.includes(accountId))
        bucket.accountIds.push(accountId);
      currencies.set(bucketKey, bucket);
      if (result.rows.length) metricAccounts.push(account);
      accountSummaries.push({
        accountId,
        accountName: normalizeOptionalString(account.name) || null,
        currency,
        timeZone,
        dateStart: dateRange.since,
        dateStop: dateRange.until,
        impressions,
        linkClicks,
        reach: optionalMetric(summaryRow.reach),
        frequency: optionalMetric(summaryRow.frequency),
        ctr:
          impressions && linkClicks !== null
            ? roundMetric((100 * linkClicks) / impressions)
            : null,
        cpc: null,
      });
      let accountSpend = 0;
      let accountMissingSpend = false;
      for (const rawRow of result.rows) {
        const row = asRecord(rawRow) as MetaInsightRow;
        accumulateMetrics(totals, row);
        accumulateMetrics(bucket.value, row);
        const rowSpend = optionalMetric(row.spend);
        accountMissingSpend ||= rowSpend === null;
        accountSpend += rowSpend ?? 0;
        const date = normalizeOptionalString(row.date_start);
        if (date) {
          const key = `${accountId}:${date}`;
          const day = daily.get(key) || {
            value: emptyMetrics(),
            date,
            currency,
            accountId,
          };
          accumulateMetrics(day.value, row);
          daily.set(key, day);
        }
        const adId = normalizeOptionalString(row.ad_id) || "unknown";
        const key = `${accountId}:${adId}`;
        const ad = ads.get(key) || {
          value: emptyMetrics(),
          identity: {
            adId,
            accountId,
            currency,
            adName: normalizeOptionalString(row.ad_name) || null,
            campaignId: normalizeOptionalString(row.campaign_id) || null,
            campaignName: normalizeOptionalString(row.campaign_name) || null,
            adSetId: normalizeOptionalString(row.adset_id) || null,
            adSetName: normalizeOptionalString(row.adset_name) || null,
          },
        };
        accumulateMetrics(ad.value, row);
        ads.set(key, ad);
        if (Array.isArray(row.actions))
          for (const action of row.actions as MetaInsightAction[]) {
            const actionType = normalizeOptionalString(action.action_type);
            const value = optionalMetric(action.value);
            if (!actionType?.includes("messaging") || value === null) continue;
            const destination =
              normalizeOptionalString(action.action_destination) || null;
            const actionKey = `${actionType}:${destination || ""}`;
            const existing = actionCounts.get(actionKey) || {
              actionType,
              destination,
              value: 0,
            };
            existing.value += value;
            actionCounts.set(actionKey, existing);
          }
      }
      accountSummaries[accountSummaries.length - 1].cpc =
        linkClicks &&
        currency &&
        !accountMissingSpend &&
        !result.error &&
        !result.warning &&
        !summary.error &&
        !summary.warning
          ? roundMetric(accountSpend / linkClicks)
          : null;
    }
  }
  const display = metricsForDisplay(totals);
  params.signal?.throwIfAborted();
  if (ads.size > 100) {
    partial = true;
    warnings.add("ads_truncated");
  }
  if (totals.missingRows) warnings.add("results_not_reported");
  if (totals.missingSpendRows) {
    warnings.add("spend_not_reported");
    partial = true;
  }
  const currencyBuckets: MetaAdsCurrencyBucket[] = Array.from(
    currencies,
    ([currency, bucket]) => ({
      currency: currency || null,
      ...metricsForDisplay(bucket.value),
      ...(partial && !bucket.value.reportedSpendRows ? { spend: null } : {}),
      accountIds: bucket.accountIds,
      ...(partial
        ? { costPerResult: null, ctr: null, cpc: null }
        : !currency
          ? { costPerResult: null, cpc: null }
          : {}),
    })
  );
  const singleCurrency =
    currencyBuckets.length === 1 && currencyBuckets[0].currency !== null;
  if (currencyBuckets.length > 1) warnings.add("multiple_currencies");
  const displayAccount = metricAccounts[0] ?? firstAccount;
  const topAds: MetaAdsInsightAdStat[] = Array.from(ads.values())
    .sort(
      (left, right) =>
        right.value.results - left.value.results ||
        right.value.spend - left.value.spend
    )
    .slice(0, 100)
    .map(ad => ({
      ...ad.identity,
      ...metricsForDisplay(ad.value),
      ...(partial || !ad.identity.currency ? { costPerResult: null } : {}),
    }));
  await addAdDestinations({
    ads: topAds,
    tokens: accountTokens,
    deadline,
    signal,
  });
  params.signal?.throwIfAborted();
  const dailyCounts: MetaAdsInsightDailyCount[] = Array.from(daily.values())
    .sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        left.accountId.localeCompare(right.accountId)
    )
    .map(day => ({
      date: day.date,
      currency: day.currency,
      accountId: day.accountId,
      ...metricsForDisplay(day.value),
      ...(partial || !day.currency ? { costPerResult: null } : {}),
    }));
  return {
    dateStart: dateRange.since,
    dateStop: dateRange.until,
    resultActionType: META_RESULT_ACTION_TYPE,
    resultLabel: META_RESULT_LABEL,
    totalResults: display.results,
    totalSpend:
      singleCurrency && !(partial && !totals.reportedSpendRows)
        ? display.spend
        : null,
    costPerResult: singleCurrency && !partial ? display.costPerResult : null,
    currency: singleCurrency ? currencyBuckets[0].currency : null,
    accountId: metricAccounts.length === 1 ? displayAccount?.id || null : null,
    accountName:
      metricAccounts.length > 1
        ? `${metricAccounts.length} ad accounts`
        : displayAccount?.name || null,
    accountTimezone:
      metricAccounts.length === 1
        ? displayAccount?.timezone_name || null
        : null,
    sourceCount: sources.length,
    accountCount: accountIds.size,
    partial,
    error: error
      ? "Meta Ads Manager data could not be loaded."
      : failedAccounts
        ? failedAccounts === accountIds.size
          ? "Meta Ads Manager data could not be loaded."
          : "Some Meta Ads Manager data could not be loaded."
        : null,
    fetchedAt: new Date().toISOString(),
    dailyCounts,
    topAds,
    currencyBuckets,
    accounts: accountSummaries,
    resultCoverage: {
      reportedRows: totals.reportedRows,
      missingRows: totals.missingRows,
    },
    spendCoverage: {
      reportedRows: totals.reportedSpendRows,
      missingRows: totals.missingSpendRows,
    },
    actionCounts: Array.from(actionCounts.values()).sort((a, b) =>
      a.actionType.localeCompare(b.actionType)
    ),
    warnings: Array.from(warnings),
    reporting: {
      actionReportTime: "conversion",
      attribution: "ad_set",
      destination: "all_messaging",
      workspaceTimeZone,
    },
  };
}
