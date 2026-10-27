import { supabaseAdmin } from "@/lib/supabase/admin";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import type { WhatsAppProviderSpendAccount } from "./whatsapp-analytics-contract";
import {
  readWhatsAppProviderSpend,
  type WhatsAppAnalyticsSource,
} from "./whatsapp-provider-analytics";

const DAY_MS = 86400000;
const MAX_PROVIDER_DAYS = 90;
const MAX_ACCOUNTS = 10;

/** What one WhatsApp Business Account's Meta spend answer means for a reader. */
export type WhatsAppSpendAccountState =
  | "reported"
  | "no_activity"
  | "cost_withheld"
  | "reconnect"
  | "unsupported"
  | "unavailable";

export type WhatsAppSpendAccount = {
  accountKey: string;
  sourceId: string;
  sourceName: string;
  state: WhatsAppSpendAccountState;
  currency: string | null;
  spend: number | null;
  volume: number;
  fetchedAt: string | null;
};

export type WhatsAppSpendReport = {
  /** The window Meta was asked about (UTC days, at most 90). */
  window: { start: string; end: string };
  generatedAt: string;
  state: "no_source" | "available" | "partial" | "reconnect" | "unavailable";
  /** Reported spend per currency; accounts never mix currencies. */
  totals: Array<{ currency: string; spend: number; accounts: number }>;
  accounts: WhatsAppSpendAccount[];
  accountsTruncated: boolean;
};

export function classifyWhatsAppSpendAccount(
  account: WhatsAppProviderSpendAccount
): WhatsAppSpendAccountState {
  if (account.pricingStatus === "available") {
    if (account.approximateSpend !== null && account.currency)
      return "reported";
    // No data points means Meta billed nothing in the window; a missing cost
    // on reported volume means Meta withholds it (e.g. partner credit lines).
    return account.pricing.length === 0 ? "no_activity" : "cost_withheld";
  }
  if (
    account.pricingStatus === "permission_required" ||
    account.pricingStatus === "not_connected"
  )
    return "reconnect";
  if (account.pricingStatus === "unsupported") return "unsupported";
  return "unavailable";
}

export function summarizeWhatsAppSpend(params: {
  accounts: WhatsAppProviderSpendAccount[];
  window: { start: Date; end: Date };
  accountsTruncated: boolean;
  now?: Date;
}): WhatsAppSpendReport {
  const accounts = params.accounts.map(account => {
    const state = classifyWhatsAppSpendAccount(account);
    return {
      accountKey: account.accountKey,
      sourceId: account.sourceId,
      sourceName: account.sourceName,
      state,
      currency: account.currency,
      spend: state === "reported" ? account.approximateSpend : null,
      volume: account.pricing.reduce((sum, point) => sum + point.volume, 0),
      fetchedAt: account.fetchedAt,
    };
  });
  const byCurrency = new Map<string, { spend: number; accounts: number }>();
  for (const account of accounts) {
    if (account.state !== "reported" || !account.currency) continue;
    const total = byCurrency.get(account.currency) || { spend: 0, accounts: 0 };
    total.spend += account.spend ?? 0;
    total.accounts += 1;
    byCurrency.set(account.currency, total);
  }
  const answered = accounts.filter(account =>
    ["reported", "no_activity"].includes(account.state)
  ).length;
  return {
    window: {
      start: params.window.start.toISOString(),
      end: params.window.end.toISOString(),
    },
    generatedAt: (params.now || new Date()).toISOString(),
    state: !accounts.length
      ? "no_source"
      : answered === accounts.length
        ? "available"
        : answered > 0
          ? "partial"
          : accounts.some(account => account.state === "reconnect")
            ? "reconnect"
            : "unavailable",
    totals: Array.from(byCurrency, ([currency, total]) => ({
      currency,
      ...total,
    })).sort((left, right) => left.currency.localeCompare(right.currency)),
    accounts,
    accountsTruncated: params.accountsTruncated,
  };
}

/** Meta's daily pricing buckets: whole UTC days, never more than 90 of them. */
export function resolveWhatsAppSpendWindow(
  start: Date,
  end: Date,
  now = new Date()
): { start: Date; end: Date } {
  const windowEnd = new Date(Math.min(end.getTime(), now.getTime()));
  const windowStart = new Date(
    Math.max(start.getTime(), windowEnd.getTime() - MAX_PROVIDER_DAYS * DAY_MS)
  );
  windowStart.setUTCHours(0, 0, 0, 0);
  if (windowEnd.getTime() - windowStart.getTime() > MAX_PROVIDER_DAYS * DAY_MS)
    windowStart.setUTCDate(windowStart.getUTCDate() + 1);
  return { start: windowStart, end: windowEnd };
}

/**
 * Account-level WhatsApp spend reported by Meta for a workspace's connected
 * numbers. Never allocated to campaigns; one read per WhatsApp Business Account.
 */
export async function queryWhatsAppSpend(params: {
  workspaceId: string;
  start: Date;
  end: Date;
}): Promise<WhatsAppSpendReport> {
  const window = resolveWhatsAppSpendWindow(params.start, params.end);
  const { data, error } = await supabaseAdmin
    .from("sources")
    .select("id,name,workspace_id,credentials")
    .eq("workspace_id", params.workspaceId)
    .eq("type", "whatsapp")
    .order("id")
    .limit(101);
  if (error) throw new Error("WhatsApp sources unavailable");
  const sources = (data || []).slice(0, 100) as WhatsAppAnalyticsSource[];
  // Duplicate phone connections must not double count WABA-level spend.
  const accountSources = new Map<string, WhatsAppAnalyticsSource>();
  for (const source of sources) {
    const accountKey =
      normalizeWhatsAppCredentials(source.credentials).wabaId || source.id;
    if (!accountSources.has(accountKey)) accountSources.set(accountKey, source);
  }
  const readSources = Array.from(accountSources.values()).slice(
    0,
    MAX_ACCOUNTS
  );
  const accounts: WhatsAppProviderSpendAccount[] = [];
  const deadline = AbortSignal.timeout(30000);
  for (let offset = 0; offset < readSources.length; offset += 2) {
    if (deadline.aborted) break;
    const batch = readSources.slice(offset, offset + 2);
    const results = await Promise.allSettled(
      batch.map(source =>
        readWhatsAppProviderSpend({
          source,
          start: window.start,
          end: window.end,
          signal: deadline,
        })
      )
    );
    results.forEach((result, index) =>
      accounts.push(
        result.status === "fulfilled"
          ? result.value
          : {
              sourceId: batch[index].id,
              sourceName: batch[index].name || "WhatsApp",
              accountKey:
                normalizeWhatsAppCredentials(batch[index].credentials).wabaId ||
                batch[index].id,
              scope: "waba",
              providerWindow: {
                start: window.start.toISOString(),
                end: window.end.toISOString(),
              },
              status: "unavailable",
              pricingStatus: "unavailable",
              currency: null,
              approximateSpend: null,
              pricing: [],
              fetchedAt: null,
            }
      )
    );
  }
  return summarizeWhatsAppSpend({
    accounts,
    window,
    accountsTruncated:
      (data || []).length > 100 || accounts.length < accountSources.size,
  });
}
