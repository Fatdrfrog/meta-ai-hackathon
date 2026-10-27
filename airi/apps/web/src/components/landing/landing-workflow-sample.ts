import type { ConversionAttributionRow } from "@icecore/shared/types/conversion-events";
import type {
  DashboardDailySeries,
  FirstResponseAnalytics,
  MetaAdsInsights,
} from "@/types/dashboard";

/** Fictional Forma Home figures, shared by the public examples. Never customer data. */
export const LANDING_CAMPAIGN_SAMPLE = {
  selected: 1320,
  purchased: 52,
  unsubscribed: 28,
} as const;

export const LANDING_CAMPAIGN_RECIPIENTS =
  LANDING_CAMPAIGN_SAMPLE.selected -
  LANDING_CAMPAIGN_SAMPLE.purchased -
  LANDING_CAMPAIGN_SAMPLE.unsubscribed;

type RevenueSample = Pick<
  ConversionAttributionRow,
  "currency" | "sales" | "payingCustomers" | "grossRevenue" | "refundedRevenue"
>;

export const LANDING_REVENUE_SAMPLES = {
  month: {
    currency: "KZT",
    sales: 66,
    payingCustomers: 60,
    grossRevenue: 1188000,
    refundedRevenue: 36000,
  },
  week: {
    currency: "KZT",
    sales: 22,
    payingCustomers: 21,
    grossRevenue: 396000,
    refundedRevenue: 18000,
  },
} as const satisfies Record<string, RevenueSample>;

/** Fictional daily conversation counts, matching Dashboard Overview's series contract. */
const CURRENT_CONVERSATIONS = [
  28, 34, 25, 43, 36, 17, 35, 42, 22, 39, 40, 24, 59, 35, 14, 49, 39, 22, 49,
  36, 18, 60, 34, 48, 36, 57, 25, 49, 52, 76,
];
const PREVIOUS_CONVERSATIONS = [
  22, 26, 31, 24, 16, 30, 20, 32, 21, 30, 22, 19, 34, 22, 31, 35, 14, 33, 36,
  22, 35, 24, 32, 25, 36, 44, 33, 37, 38, 52,
];
const MONTHLY_CONVERSATIONS = {
  current: CURRENT_CONVERSATIONS.map((total, index) => ({
    date: `2026-06-${String(index + 1).padStart(2, "0")}`,
    total,
  })),
  previous: PREVIOUS_CONVERSATIONS.map((total, index) => ({
    date: `2026-05-${String(index + 2).padStart(2, "0")}`,
    total,
  })),
} satisfies DashboardDailySeries;

export const LANDING_CONVERSATION_SAMPLES = {
  month: MONTHLY_CONVERSATIONS,
  week: {
    current: MONTHLY_CONVERSATIONS.current.slice(-7),
    previous: MONTHLY_CONVERSATIONS.current.slice(-14, -7),
  },
} satisfies Record<keyof typeof LANDING_REVENUE_SAMPLES, DashboardDailySeries>;

/** Fields mirror the real Meta Insights adapter. USD spend is never mixed with KZT sales. */
export const LANDING_META_ADS_SAMPLE = {
  totalResults: 180,
  totalSpend: 288,
  costPerResult: 1.6,
  currency: "USD",
  resultActionType: "onsite_conversion.messaging_conversation_started_7d",
  topAds: [
    { adId: "basket", results: 90, spend: 126, costPerResult: 1.4 },
    { adId: "vase", results: 60, spend: 108, costPerResult: 1.8 },
    { adId: "textile", results: 30, spend: 54, costPerResult: 1.8 },
  ],
} as const satisfies Pick<
  MetaAdsInsights,
  | "totalResults"
  | "totalSpend"
  | "costPerResult"
  | "currency"
  | "resultActionType"
  | "topAds"
>;

/** Separate webhook observation count; it is not a stage in Meta's results funnel. */
export const LANDING_AD_CONVERSATIONS = 168;

/** Fictional monthly Meta Ads cohorts. These sales are a subset of store sales,
 * linked to captured ad conversations, not inferred from Meta's result count. */
export const LANDING_MONTHLY_ATTRIBUTION = [
  {
    month: "jan",
    spend: 240,
    conversations: 126,
    sales: 14,
    grossRevenue: 252000,
    refundedRevenue: 18000,
  },
  {
    month: "feb",
    spend: 270,
    conversations: 140,
    sales: 17,
    grossRevenue: 306000,
    refundedRevenue: 18000,
  },
  {
    month: "mar",
    spend: 258,
    conversations: 136,
    sales: 15,
    grossRevenue: 270000,
    refundedRevenue: 36000,
  },
  {
    month: "apr",
    spend: 300,
    conversations: 160,
    sales: 20,
    grossRevenue: 360000,
    refundedRevenue: 18000,
  },
  {
    month: "may",
    spend: 312,
    conversations: 174,
    sales: 22,
    grossRevenue: 396000,
    refundedRevenue: 36000,
  },
  {
    month: "jun",
    spend: LANDING_META_ADS_SAMPLE.totalSpend,
    conversations: LANDING_AD_CONVERSATIONS,
    sales: 24,
    grossRevenue: 432000,
    refundedRevenue: 18000,
  },
].map(row => ({ ...row, netRevenue: row.grossRevenue - row.refundedRevenue }));

/** Same explicit audience as the campaign example; observed read events are not inferred. */
export const LANDING_CAMPAIGN_REPORT = {
  totalAccepted: LANDING_CAMPAIGN_RECIPIENTS,
  delivered: 1210,
  read: 930,
  replied: 248,
  estimatedCost: 37.2,
  costPerReply: 0.15,
} as const;

export const LANDING_RESPONSE_SAMPLE = {
  count: 840,
  medianSeconds: 42,
  p90Seconds: 180,
} as const satisfies Pick<
  FirstResponseAnalytics,
  "count" | "medianSeconds" | "p90Seconds"
>;
