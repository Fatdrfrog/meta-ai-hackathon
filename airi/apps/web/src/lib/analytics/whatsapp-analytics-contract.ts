export type WhatsAppProviderStatus =
  | "available"
  | "not_connected"
  | "activation_required"
  | "permission_required"
  | "unsupported"
  | "unavailable";
export type WhatsAppDeliveryTotals = {
  accepted: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  pending: number;
  deliveredRate: number | null;
  readRate: number | null;
  replyRate: number | null;
  medianDeliverySeconds: number | null;
  p95DeliverySeconds: number | null;
  medianReadSeconds: number | null;
  p95ReadSeconds: number | null;
  byOrigin: Array<{
    origin: string;
    accepted: number;
    delivered: number;
    read: number;
    replied: number;
    failed: number;
  }>;
  topErrors: Array<{ code: string; count: number }>;
  dailyDelivery: Array<{
    day: string;
    accepted: number;
    delivered: number;
    read: number;
    replied: number;
    failed: number;
    pending: number;
    topErrors: Array<{ code: string; count: number }>;
  }>;
  bySourcePhoneTemplate: Array<{
    sourceId: string | null;
    phoneNumberId: string | null;
    template: string | null;
    accepted: number;
    delivered: number;
    read: number;
    replied: number;
    failed: number;
    pending: number;
  }>;
  breakdownTruncated: boolean;
};
export type WhatsAppPricingPoint = {
  start: number;
  end: number;
  country: string | null;
  category: string | null;
  type: string | null;
  tier: string | null;
  volume: number;
  cost: number | null;
  currency: string | null;
};
export type WhatsAppTemplateEffectiveness = {
  id: string;
  name: string;
  language: string;
  category: string;
  quality: string | null;
  status: string;
  sent: number;
  delivered: number;
  read: number | null;
  clicked: number | null;
  uniqueClicked: number | null;
  quickReplyClicked: number | null;
  cost: number | null;
  currency: string | null;
  readRate: number | null;
  clickRate: number | null;
  costPerDelivered: number | null;
};
export type WhatsAppProviderAccount = {
  sourceId: string;
  sourceName: string;
  accountKey: string;
  scope: "waba";
  providerWindow: { start: string; end: string };
  status: WhatsAppProviderStatus;
  pricingStatus: WhatsAppProviderStatus;
  templateStatus: WhatsAppProviderStatus;
  activationStatus: "enabled" | "required" | "unknown";
  currency: string | null;
  approximateSpend: number | null;
  pricing: WhatsAppPricingPoint[];
  templates: WhatsAppTemplateEffectiveness[];
  templatesTruncated: boolean;
  /** Paused, rejected, disabled or red templates; read without insights. */
  templateIssues?: number | null;
  fetchedAt: string | null;
};
/** Account-level spend reported by Meta, without template data. */
export type WhatsAppProviderSpendAccount = Pick<
  WhatsAppProviderAccount,
  | "sourceId"
  | "sourceName"
  | "accountKey"
  | "scope"
  | "providerWindow"
  | "status"
  | "pricingStatus"
  | "currency"
  | "approximateSpend"
  | "pricing"
  | "fetchedAt"
>;
export type WhatsAppAnalyticsHealth = {
  sourceId: string;
  sourceName: string;
  phoneQuality: string | null;
  portfolioLimit: string | null;
  accountStatus: string;
  webhookStatus: "healthy" | "action_required" | "unknown";
  lastVerifiedAt: string | null;
  verificationFreshness: "fresh" | "stale" | "unknown";
  templateIssues: number | null;
  activationStatus: "enabled" | "required" | "unknown";
  history: Array<{
    day: string;
    observedAt: string;
    deliveryObservedAt?: string | null;
    accountStatus: string;
    phoneQuality: string | null;
    portfolioLimit: string | null;
    webhookStatus: "healthy" | "action_required" | "unknown";
    templateIssues: number | null;
    pending7d: number | null;
    failed7d: number | null;
  }>;
};
export type WhatsAppAnalyticsResult = {
  window: { days: number; start: string; end: string; replyWindowHours: 168 };
  generatedAt: string;
  delivery: WhatsAppDeliveryTotals;
  pricing: {
    billable: number;
    free: number;
    unknown: number;
    categoryBreakdown: Array<{
      category: string;
      billable: number;
      free: number;
      unknown: number;
    }>;
    providerAccounts: WhatsAppProviderAccount[];
    estimate: {
      amount: null;
      currency: null;
      reason: "verified_tariff_required";
    };
    aiCostIncluded: false;
  };
  templates: WhatsAppProviderAccount[];
  health: WhatsAppAnalyticsHealth[];
  templateLifecycle: Array<{
    at: string;
    templateId: string | null;
    name: string;
    kind: string;
    status: string | null;
    quality: string | null;
    category: string | null;
  }>;
  limitations: {
    sourcesTruncated: boolean;
    providerAccountsTruncated: boolean;
    providerTemplateLookbackDays: 90;
    providerReadClickWindowDays: 7;
    flowOpenMeasured: false;
  };
};

/**
 * Periods the member spend route accepts. Each distinct period is a separate
 * Meta read and cache entry, so periods are whole UTC days within fixed bounds.
 */
export const WHATSAPP_SPEND_DAY_OPTIONS = [7, 30, 90] as const;
export type WhatsAppSpendDays = (typeof WHATSAPP_SPEND_DAY_OPTIONS)[number];
/** Longest from/to period: days between its first and last UTC date. */
export const WHATSAPP_SPEND_MAX_SPAN_DAYS = 90;
/** A from/to period may not start more than this many days before today. */
export const WHATSAPP_SPEND_LOOKBACK_DAYS = 365;

const SPEND_DAY_MS = 86_400_000;
const SPEND_DATE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const utcDayStart = (time: number) =>
  Math.floor(time / SPEND_DAY_MS) * SPEND_DAY_MS;
/** UTC midnight of an ISO date or zoned ISO timestamp; null otherwise. */
const parseSpendDay = (value: string | null): number | null => {
  if (value === null || !SPEND_DATE.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? utcDayStart(time) : null;
};
const spendDate = (time: number) => new Date(time).toISOString().slice(0, 10);

/**
 * The part of a report period the spend route can answer: whole UTC dates,
 * ending no later than today, keeping the last 90 days (Meta's spend window).
 * Null when the period is invalid or ends before the 365-day lookback.
 */
export function boundWhatsAppSpendPeriod(
  period: { from: string; to: string },
  now = new Date()
): { from: string; to: string } | null {
  const first = parseSpendDay(period.from),
    last = parseSpendDay(period.to);
  if (first === null || last === null || first > last) return null;
  const today = utcDayStart(now.getTime()),
    oldest = today - WHATSAPP_SPEND_LOOKBACK_DAYS * SPEND_DAY_MS;
  const to = Math.min(last, today);
  const from = Math.max(
    first,
    to - WHATSAPP_SPEND_MAX_SPAN_DAYS * SPEND_DAY_MS,
    oldest
  );
  return from > to ? null : { from: spendDate(from), to: spendDate(to) };
}

/**
 * The spend window a route query asks for, or null when it is outside the
 * accepted periods: `days` of 7, 30 or 90 (default 30), or `from`/`to` UTC
 * dates (or timestamps, snapped to their date) at most 90 days apart, starting
 * within the last 365 days. A future `to` reads through today.
 */
export function parseWhatsAppSpendQuery(
  search: URLSearchParams,
  now = new Date()
): { start: Date; end: Date } | null {
  const rawFrom = search.get("from"),
    rawTo = search.get("to");
  if (rawFrom !== null || rawTo !== null) {
    const first = parseSpendDay(rawFrom),
      last = parseSpendDay(rawTo);
    if (first === null || last === null) return null;
    const today = utcDayStart(now.getTime());
    const to = Math.min(last, today);
    if (
      first > to ||
      to - first > WHATSAPP_SPEND_MAX_SPAN_DAYS * SPEND_DAY_MS ||
      first < today - WHATSAPP_SPEND_LOOKBACK_DAYS * SPEND_DAY_MS
    )
      return null;
    return {
      start: new Date(first),
      // Through the end of the last date, but never past now.
      end: new Date(Math.min(to + SPEND_DAY_MS - 1, now.getTime())),
    };
  }
  const raw = search.get("days");
  const days = raw === null ? 30 : Number(raw);
  if (!(WHATSAPP_SPEND_DAY_OPTIONS as readonly number[]).includes(days))
    return null;
  return {
    start: new Date(now.getTime() - days * SPEND_DAY_MS),
    end: new Date(now.getTime()),
  };
}
