import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MetaAdsAdAccount } from "@icecore/shared/types/sources";
import type { ConversionAttributionRow } from "@icecore/shared/types/conversion-events";
import { awaitWithCancellation } from "@/lib/ai/cancellation";
import { getAcquisitionReport } from "@/lib/analytics/acquisition-report";
import { comparableEfficiency } from "@/lib/analytics/acquisition-efficiency";
import {
  getAcquisitionQualifiedToPaidRate,
  getAcquisitionRevenueByCurrency,
  observedAcquisitionCount,
  qualificationHistoryCoversWindow,
} from "@/lib/analytics/journey-presentation";
import {
  normalizeDashboardCustomCalendarRange,
  resolveDashboardCalendarDays,
  resolveDashboardComparisonWindow,
} from "@/lib/dashboard-comparison";
import { getConversionAttributionReport } from "@/lib/conversions/conversion-attribution";
import { normalizeMetaAdAccountId } from "@/lib/meta-ads/meta-ad-account-id";
import { fetchMetaAdsDashboardInsights } from "@/lib/meta-ads/meta-ads-insights";
import { isNonNegativeSafeInteger } from "@icecore/shared/lib/value-utils";

const COLLECTION_TIMEOUT_MS = 12_000;
const QUERY_TIMEOUT_MS = 4_000;
const MAX_AD_GROUPS = 10;
const REPORTING_QUERY =
  /report|perform|analys|revenue|sales?|profit|roas|roi|funnel|qualif|convers|отч[её]т|анализ|эффектив|выруч|продаж|доход|прибыл|ворон|квалиф|конвер|оплат|есеп|талдау|сатылым|табыс|кіріс|төлем/iu;
const MUTATION_QUERY =
  /\b(?:pause|resume|activate|delete|create|update|edit|increase|decrease)\b|останов|приостанов|запуст|созда|удал|измени|тоқтат|өзгерт/iu;
const REPORTING_ACTION =
  /report|analys|analyz|compare|summar|evaluate|отч[её]т|анализ|сравн|итог|есеп|талдау/iu;

function requestsBusinessReporting(input: {
  userMessage: string;
  previousUserMessages?: string[];
}): boolean {
  const message = input.userMessage;
  if (MUTATION_QUERY.test(message) && !REPORTING_ACTION.test(message))
    return false;
  if (REPORTING_QUERY.test(message) || REPORTING_ACTION.test(message))
    return true;
  const previous = input.previousUserMessages?.at(-1) || "";
  const followUp = message.replace(/@meta\b/gi, "").trim();
  return (
    /^(?:what about|how about|and\b|а\s|а что|ал\s)/iu.test(followUp) &&
    (REPORTING_QUERY.test(previous) || REPORTING_ACTION.test(previous)) &&
    !(MUTATION_QUERY.test(previous) && !REPORTING_ACTION.test(previous))
  );
}

export type MetaAdsMcpBusinessPeriod = {
  from: string;
  to: string;
  start: string;
  end: string;
  resolution: "explicit" | "history" | "default";
};

/** Resolve calendar labels through the dashboard owner, including DST boundaries.
 * Ambiguous dates must not silently become the default reporting period. */
export function resolveMetaAdsMcpBusinessPeriod(input: {
  userMessage: string;
  previousUserMessages?: string[];
  timeZone: string;
  now: Date;
}): MetaAdsMcpBusinessPeriod | null {
  const periodFromText = (
    text: string
  ): { from: string; to: string } | null | undefined => {
    const dates = text.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [];
    if (dates.length)
      return dates.length === 2 ? { from: dates[0], to: dates[1] } : null;
    const relative =
      /(?:last|past|последни[ехй]|соңғы)\s+(\d+)\s*(?:days?|дн[яеий]+|күн)/iu.exec(
        text
      );
    if (relative) {
      const days = Number(relative[1]);
      return days === 7 || days === 30
        ? resolveDashboardCalendarDays(days, input.timeZone, input.now, 1)
        : null;
    }
    // These change the requested population but have no reviewed date mapping here.
    if (
      /\d{4}-\d{2}|\b(?:today|yesterday|week|month|year|quarter|january|february|march|april|may|june|july|august|september|october|november|december|all\s+time)\b|сегодня|вчера|недел|месяц|квартал|вс[её]\s+время|январ|феврал|март|апрел|ма[яй]|июн|июл|август|сентябр|октябр|ноябр|декабр|жыл|апта|бүгін|кеше|барлық\s+уақыт/iu.test(
        text
      )
    )
      return null;
    return undefined;
  };
  try {
    let labels = periodFromText(input.userMessage);
    let resolution: MetaAdsMcpBusinessPeriod["resolution"] = "explicit";
    if (labels === undefined) {
      for (const text of [...(input.previousUserMessages || [])]
        .slice(-12)
        .reverse()) {
        const previous = periodFromText(text);
        if (previous !== undefined) {
          labels = previous;
          resolution = "history";
          break;
        }
      }
    }
    if (labels === undefined) {
      labels = resolveDashboardCalendarDays(30, input.timeZone, input.now, 1);
      resolution = "default";
    }
    if (!labels) return null;
    const days =
      (Date.parse(labels.to) - Date.parse(labels.from)) / 86_400_000 + 1;
    if (!Number.isFinite(days) || days < 1 || days > 31) return null;
    const range = normalizeDashboardCustomCalendarRange(
      labels.from,
      labels.to,
      input.timeZone
    );
    if (range.endExclusive.getTime() > input.now.getTime()) return null;
    return {
      ...labels,
      start: range.start.toISOString(),
      end: range.endExclusive.toISOString(),
      resolution,
    };
  } catch {
    return null;
  }
}

type AcquisitionEvidence = {
  sourceId: string | null;
  entries: number | null;
  engaged: number | null;
  qualified: number | null;
  booked: number | null;
  paid: number | null;
  pendingObservation: number | null;
  qualifiedToPaidRate: number | null;
  costPerQualified: number | null;
  costPerPaid: number | null;
  currencies: Array<{
    currency: string;
    netRevenue: number | null;
    netRoas: number | null;
  }>;
};
type AdEvidence = {
  adId: string;
  campaignId: string | null;
  accountMembership: "verified";
  advertising: {
    accountId: string;
    period: { from: string; to: string };
    observedAt: string;
    currency: string | null;
    spend: number | null;
    providerResults: number | null;
  };
  recordedSales: Array<
    Omit<
      ConversionAttributionRow,
      "grossRevenue" | "refundedRevenue" | "netRevenue"
    > & {
      grossRevenue: number | null;
      refundedRevenue: number | null;
      netRevenue: number | null;
    }
  > | null;
  acquisition: AcquisitionEvidence[];
};
type Coverage = "complete" | "partial" | "unavailable";
export type MetaAdsMcpBusinessEvidence = {
  status: "available" | "partial" | "unavailable" | "not_requested";
  scope: {
    workspaceId: string;
    sourceId: string;
    adAccountId: string;
    timeZone: string;
    currency: string | null;
  } | null;
  period: MetaAdsMcpBusinessPeriod | null;
  observedAt: string;
  coverage: { advertising: Coverage; sales: Coverage; acquisition: Coverage };
  ads: AdEvidence[];
  unmatched: { salesGroups: number | null; acquisitionGroups: number | null };
  omittedAdGroups: number;
  reasons: string[];
};
type BusinessEvidenceInput = {
  supabase: SupabaseClient;
  workspaceId: string;
  sourceId: string;
  selectedAdAccount: MetaAdsAdAccount;
  userMessage: string;
  previousUserMessages?: string[];
  signal?: AbortSignal;
  now?: Date;
};
const amount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
function validSalesRow(row: ConversionAttributionRow): boolean {
  return (
    row &&
    (row.adId === null || typeof row.adId === "string") &&
    (row.campaignId === null || typeof row.campaignId === "string") &&
    typeof row.currency === "string" &&
    (row.currency === "" || /^[A-Z]{3}$/.test(row.currency)) &&
    [row.sales, row.refunds, row.payingCustomers, row.paidConversations].every(
      isNonNegativeSafeInteger
    ) &&
    [row.grossRevenue, row.refundedRevenue, row.netRevenue].every(amount)
  );
}

/** Compose existing reporting owners; never ingest, repair, attribute or send. */
export async function collectMetaAdsMcpBusinessEvidence(
  input: BusinessEvidenceInput
): Promise<MetaAdsMcpBusinessEvidence> {
  input.signal?.throwIfAborted();
  const now = input.now || new Date();
  const empty: MetaAdsMcpBusinessEvidence = {
    status: "unavailable",
    scope: null,
    period: null,
    observedAt: now.toISOString(),
    coverage: {
      advertising: "unavailable",
      sales: "unavailable",
      acquisition: "unavailable",
    },
    ads: [],
    unmatched: { salesGroups: null, acquisitionGroups: null },
    omittedAdGroups: 0,
    reasons: [],
  };
  if (!requestsBusinessReporting(input))
    return { ...empty, status: "not_requested" };
  const adAccountId = normalizeMetaAdAccountId(input.selectedAdAccount.id);
  const requestedAccounts = input.userMessage.match(/\bact_\d+\b/gi) || [];
  if (
    !adAccountId ||
    requestedAccounts.some(id => normalizeMetaAdAccountId(id) !== adAccountId)
  )
    return { ...empty, reasons: ["account_scope_unavailable"] };
  const timeZone = input.selectedAdAccount.timezone_name;
  if (!timeZone) return { ...empty, reasons: ["account_timezone_unavailable"] };
  const period = resolveMetaAdsMcpBusinessPeriod({ ...input, timeZone, now });
  if (!period) return { ...empty, reasons: ["period_unavailable"] };
  const currency = input.selectedAdAccount.currency?.toUpperCase();
  const scope = {
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    adAccountId,
    timeZone,
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
  };
  const signal = AbortSignal.any([
    AbortSignal.timeout(COLLECTION_TIMEOUT_MS),
    ...(input.signal ? [input.signal] : []),
  ]);
  const comparisonPeriod = resolveDashboardComparisonWindow(
    normalizeDashboardCustomCalendarRange(period.from, period.to, timeZone),
    timeZone,
    now
  );
  const settled = await Promise.allSettled([
    awaitWithCancellation(
      fetchMetaAdsDashboardInsights({
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
        adAccountId,
        comparisonPeriod,
        signal,
        deadlineAt: Date.now() + COLLECTION_TIMEOUT_MS,
      }),
      signal
    ),
    awaitWithCancellation(
      getConversionAttributionReport({
        supabase: input.supabase,
        workspaceId: input.workspaceId,
        start: period.start,
        end: period.end,
        timeZone,
        signal,
      }),
      signal
    ),
    awaitWithCancellation(
      getAcquisitionReport({
        workspaceId: input.workspaceId,
        start: new Date(period.start),
        end: new Date(period.end),
        observationDays: 7,
        now,
        signal,
        queryMaxTimeMS: QUERY_TIMEOUT_MS,
      }),
      signal
    ),
  ]);
  input.signal?.throwIfAborted();
  const provider = settled[0].status === "fulfilled" ? settled[0].value : null;
  const rawSales = settled[1].status === "fulfilled" ? settled[1].value : null;
  const sales =
    rawSales &&
    typeof rawSales.truncated === "boolean" &&
    rawSales.rows.every(validSalesRow)
      ? rawSales
      : null;
  const acquisition =
    settled[2].status === "fulfilled" ? settled[2].value : null;
  const providerAccountMatches = Boolean(
    provider &&
      normalizeMetaAdAccountId(provider.accountId) === adAccountId &&
      provider.accounts?.length === 1 &&
      normalizeMetaAdAccountId(provider.accounts[0].accountId) === adAccountId
  );
  const providerScopeMatches = Boolean(
    providerAccountMatches &&
      provider &&
      provider.dateStart === period.from &&
      provider.dateStop === period.to &&
      normalizeMetaAdAccountId(provider.accountId) === adAccountId &&
      provider.reporting?.workspaceTimeZone === timeZone &&
      provider.accounts?.length === 1 &&
      provider.accounts.every(
        account =>
          normalizeMetaAdAccountId(account.accountId) === adAccountId &&
          account.timeZone === timeZone &&
          account.currency === scope.currency
      )
  );
  const acquisitionScopeMatches = Boolean(
    acquisition &&
      acquisition.window.start === period.start &&
      acquisition.window.end === period.end
  );
  const qualificationHistoryComplete =
    qualificationHistoryCoversWindow(acquisition);
  const coverage: MetaAdsMcpBusinessEvidence["coverage"] = {
    advertising: !provider
      ? "unavailable"
      : provider.partial || provider.error || !providerScopeMatches
        ? "partial"
        : "complete",
    sales: !sales
      ? "unavailable"
      : sales.truncated || sales.rows.some(row => !row.currency)
        ? "partial"
        : "complete",
    acquisition: !acquisition
      ? "unavailable"
      : acquisition.coverage.status !== "ready" ||
          acquisition.coverage.truncated ||
          !acquisitionScopeMatches ||
          !qualificationHistoryComplete
        ? "partial"
        : "complete",
  };
  const verifiedAds = (provider?.topAds || []).filter(
    ad =>
      providerAccountMatches &&
      /^\d+$/.test(ad.adId) &&
      normalizeMetaAdAccountId(ad.accountId) === adAccountId &&
      (provider?.topAds || []).filter(
        other => other.adId === ad.adId && other.accountId === ad.accountId
      ).length === 1
  );
  const verifiedIds = new Set(verifiedAds.map(ad => ad.adId));
  const unmatched = {
    salesGroups: sales
      ? sales.rows.filter(row => !row.adId || !verifiedIds.has(row.adId)).length
      : null,
    acquisitionGroups: acquisition
      ? acquisition.cohorts.filter(
          row =>
            !acquisitionScopeMatches || !row.adId || !verifiedIds.has(row.adId)
        ).length
      : null,
  };
  const omittedAdGroups = Math.max(0, verifiedAds.length - MAX_AD_GROUPS);
  const ads: AdEvidence[] = verifiedAds.slice(0, MAX_AD_GROUPS).map(ad => {
    const cohorts = acquisitionScopeMatches
      ? acquisition?.cohorts.filter(
          row => row.kind === "ad" && row.adId === ad.adId
        ) || []
      : [];
    const comparable =
      coverage.advertising === "complete" &&
      coverage.acquisition === "complete" &&
      cohorts.length === 1 &&
      Boolean(cohorts[0].sourceId) &&
      cohorts[0].pendingObservation === 0 &&
      ad.destination === "whatsapp" &&
      Boolean(ad.destinationUpdatedAt) &&
      Date.parse(ad.destinationUpdatedAt!) <= Date.parse(period.start) &&
      ad.currency === scope.currency;
    return {
      adId: ad.adId,
      campaignId: ad.campaignId || null,
      accountMembership: "verified",
      advertising: {
        accountId: adAccountId,
        period: { from: provider!.dateStart, to: provider!.dateStop },
        observedAt: provider!.fetchedAt,
        currency: ad.currency || null,
        spend: ad.spend,
        providerResults: ad.results,
      },
      recordedSales:
        sales &&
        (!sales.truncated || sales.rows.some(row => row.adId === ad.adId))
          ? sales.rows
              .filter(row => row.adId === ad.adId)
              .map(row => ({
                ...row,
                campaignName: null,
                grossRevenue: row.currency ? row.grossRevenue : null,
                refundedRevenue: row.currency ? row.refundedRevenue : null,
                netRevenue: row.currency ? row.netRevenue : null,
              }))
          : null,
      acquisition: cohorts.map(row => {
        const efficiency = comparableEfficiency({
          spend: ad.spend,
          spendCurrency: ad.currency || null,
          revenue: null,
          revenueCurrency: "",
          qualified: row.qualified,
          paid: row.paid,
          comparable,
        });
        return {
          sourceId: row.sourceId,
          entries: observedAcquisitionCount(acquisition, row.entries),
          engaged: observedAcquisitionCount(acquisition, row.engaged),
          qualified: observedAcquisitionCount(acquisition, row.qualified, true),
          booked: observedAcquisitionCount(acquisition, row.booked),
          paid: observedAcquisitionCount(acquisition, row.paid),
          pendingObservation: observedAcquisitionCount(
            acquisition,
            row.pendingObservation
          ),
          qualifiedToPaidRate: getAcquisitionQualifiedToPaidRate(
            acquisition,
            row
          ),
          costPerQualified: qualificationHistoryCoversWindow(acquisition)
            ? efficiency.costPerQualified
            : null,
          costPerPaid: efficiency.costPerPaid,
          currencies: getAcquisitionRevenueByCurrency({
            ...acquisition!,
            cohorts: [row],
          }).map(money => ({
            currency: money.currency,
            netRevenue: money.currency ? money.netRevenue : null,
            netRoas: comparableEfficiency({
              spend: ad.spend,
              spendCurrency: ad.currency || null,
              revenue: money.netRevenue,
              revenueCurrency: money.currency,
              qualified: row.qualified,
              paid: row.paid,
              comparable,
            }).netRoas,
          })),
        };
      }),
    };
  });
  const partial =
    Object.values(coverage).some(value => value !== "complete") ||
    Boolean(
      unmatched.salesGroups || unmatched.acquisitionGroups || omittedAdGroups
    );
  return {
    ...empty,
    status: Object.values(coverage).every(value => value === "unavailable")
      ? "unavailable"
      : partial
        ? "partial"
        : "available",
    scope,
    period,
    coverage,
    ads,
    unmatched,
    omittedAdGroups,
    reasons: [
      ...(provider && !providerScopeMatches ? ["provider_scope_mismatch"] : []),
      ...(acquisition && !acquisitionScopeMatches
        ? ["acquisition_scope_mismatch"]
        : []),
      ...(acquisition && !qualificationHistoryComplete
        ? ["qualification_history_partial"]
        : []),
      ...(signal.aborted ? ["collection_timeout"] : []),
      ...(!scope.currency ? ["account_currency_unavailable"] : []),
    ],
  };
}

export async function loadMetaAdsMcpBusinessEvidence(
  input: BusinessEvidenceInput
): Promise<string> {
  const evidence = await collectMetaAdsMcpBusinessEvidence(input);
  if (evidence.status === "not_requested") return "";
  // Drop whole groups before serialization; never cut a JSON fact or imply complete coverage.
  while (JSON.stringify(evidence).length > 4_800 && evidence.ads.length) {
    evidence.ads.pop();
    evidence.omittedAdGroups += 1;
    evidence.status = "partial";
  }
  return `Canonical read-only business evidence. Exact-ad membership comes from the scoped Graph report. RecordedSales is SQL activity in the stated period; acquisition is entry cohorts with a seven-day observation horizon and can contain later outcomes. Never add these financial populations or infer real sales from absent records. Unmatched groups remain account-unverified. Distinct customers/conversations are non-additive. Use only supplied efficiency values; never invent ROAS or conversion ratios. Provider MCP results with another account/period cannot be joined to this evidence. If period.resolution is default, explicitly state the default period.\n${JSON.stringify(evidence)}`;
}
