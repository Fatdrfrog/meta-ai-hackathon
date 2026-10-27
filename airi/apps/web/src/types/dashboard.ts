import type { ConversionAttributionReport } from "@icecore/shared/types/conversion-events";

export interface ChannelDataItem {
  category: string;
  channel: string;
  count: number;
}

export const DASHBOARD_UNCATEGORIZED_CATEGORY = "__uncategorized__" as const;

export type DashboardChangeKind =
  | "increase"
  | "decrease"
  | "unchanged"
  | "new"
  | "no_longer_active";

export interface DashboardTimeRange {
  start: string;
  endExclusive: string;
}

export interface DashboardComparisonPeriod {
  preset: "7d" | "30d" | "90d" | "this_week" | "custom" | "last_12_months";
  strategy: "adjacent_equal_duration" | "previous_week_same_elapsed" | "none";
  timeZone: string;
  current: DashboardTimeRange;
  previous: DashboardTimeRange | null;
}

export interface DashboardComparisonDateRange {
  start: Date;
  endExclusive: Date;
}

export type DashboardComparisonInput =
  | 7
  | 30
  | 90
  | "this_week"
  | "all"
  | DashboardComparisonDateRange;

export interface DashboardCountComparison {
  current: number;
  previous: number;
  delta: number;
  percentChange: number | null;
  kind: DashboardChangeKind;
}

export interface DashboardCategoryComparison extends DashboardCountComparison {
  category: string;
}

export type DashboardMetricId =
  | "total"
  | "new"
  | "in_progress"
  | "resolved"
  | "sla"
  | "repeat"
  | "csat"
  | "first_response"
  | "ttr";

export interface DashboardMetric {
  id: DashboardMetricId;
  value: number | null;
  secondaryValue: number | null;
  comparison: DashboardCountComparison | null;
}

export interface DashboardPeakTime {
  dayOfWeek: number;
  hour: number;
}

// Тип для данных графика
export interface DailyCount {
  date: string;
  total: number;
}

export interface ConversationActivityByTime {
  dayOfWeek: number;
  hour: number;
  count: number;
}

// Тип для трендов по категориям
export interface DashboardDailySeries {
  current: DailyCount[];
  previous: DailyCount[];
}

export interface DashboardMessageAnalytics {
  totals: { current: number; previous: number };
  categories: {
    current: Record<string, number>;
    previous: Record<string, number>;
  };
  dailySeries: DashboardDailySeries;
  categoriesByChannel: ChannelDataItem[];
}

export interface AdvertisementSourceStat {
  sourceKey: string;
  sourceId?: string | null;
  sourceType?: string | null;
  sourceUrl?: string | null;
  headline?: string | null;
  body?: string | null;
  mediaType?: string | null;
  conversations: number;
  responded: number;
  closed: number;
  latestAt?: string | Date | null;
}

export interface AdvertisementTypeStat {
  sourceType: string;
  conversations: number;
}

export interface AdvertisementDailyCount {
  date: string;
  conversations: number;
}

export interface MetaAdsInsightDailyCount {
  date: string;
  results: number | null;
  spend: number | null;
  costPerResult: number | null;
  currency?: string | null;
  accountId?: string;
  missingResultRows?: number;
  missingSpendRows?: number;
}

export interface MetaAdsInsightMetrics {
  impressions: number | null;
  linkClicks: number | null;
  /** Link-click rate, in percentage points, not all-click CTR. */
  ctr: number | null;
  /** Spend per inline link click; null without comparable currency/coverage. */
  cpc: number | null;
}

export interface MetaAdsCurrencyBucket extends MetaAdsInsightMetrics {
  currency: string | null;
  spend: number | null;
  results: number | null;
  costPerResult: number | null;
  accountIds: string[];
  missingResultRows: number;
  missingSpendRows?: number;
}

export interface MetaAdsInsightAccount extends MetaAdsInsightMetrics {
  accountId: string;
  accountName: string | null;
  currency: string | null;
  timeZone: string | null;
  dateStart: string;
  dateStop: string;
  /** Account-period values; reach/frequency must never be summed over days/ads. */
  reach: number | null;
  frequency: number | null;
}

export interface MetaAdsInsightAdStat {
  adId: string;
  /** Current explicit ad-set configuration; this is not a historical destination audit. */
  destination?: "whatsapp" | "other" | null;
  destinationType?: string | null;
  destinationUpdatedAt?: string | null;
  adName?: string | null;
  campaignId?: string | null;
  campaignName?: string | null;
  adSetId?: string | null;
  adSetName?: string | null;
  results: number | null;
  spend: number | null;
  costPerResult: number | null;
  currency?: string | null;
  accountId?: string;
  missingResultRows?: number;
  missingSpendRows?: number;
}

export interface MetaAdsInsights {
  dateStart: string;
  dateStop: string;
  resultActionType: string;
  resultLabel: string;
  totalResults: number | null;
  /** Null when account currencies differ or currency is unavailable. */
  totalSpend: number | null;
  costPerResult: number | null;
  currency?: string | null;
  accountId?: string | null;
  accountName?: string | null;
  accountTimezone?: string | null;
  sourceCount: number;
  accountCount: number;
  partial: boolean;
  error?: string | null;
  fetchedAt: string;
  dailyCounts: MetaAdsInsightDailyCount[];
  topAds: MetaAdsInsightAdStat[];
  currencyBuckets?: MetaAdsCurrencyBucket[];
  accounts?: MetaAdsInsightAccount[];
  resultCoverage?: { reportedRows: number; missingRows: number };
  spendCoverage?: { reportedRows: number; missingRows: number };
  actionCounts?: Array<{ actionType: string; destination: string | null; value: number }>;
  warnings?: string[];
  reporting?: {
    actionReportTime: "conversion";
    attribution: "ad_set";
    destination: "all_messaging";
    workspaceTimeZone: string;
  };
}

export interface AdvertisementAnalytics {
  conversionFeedback?: import('@/lib/conversions/conversion-feedback-report').ConversionFeedbackReport | null;
  conversionFeedbackError?: 'unavailable' | null;
  totalConversations: number;
  uniqueSources: number;
  respondedConversations: number;
  closedConversations: number;
  responseRate: number;
  closeRate: number;
  topSources: AdvertisementSourceStat[];
  bySourceType: AdvertisementTypeStat[];
  dailyCounts: AdvertisementDailyCount[];
  metaInsights?: MetaAdsInsights | null;
  conversionAttribution?: ConversionAttributionReport | null;
  conversionAttributionError?: "unavailable" | "date_range_too_large" | null;
}

export interface InternalLabelStat {
  label: string;
  conversations: number;
  open: number;
  inProgress: number;
  closed: number;
  responded: number;
  latestAt?: string | Date | null;
}

export interface InternalLabelAnalytics {
  taggedConversations: number;
  unlabeledConversations: number;
  uniqueLabels: number;
  totalAssignments: number;
  availableLabels: string[];
  topLabels: InternalLabelStat[];
}

export interface DashboardManagerOption {
  id: string;
  name: string;
  role?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
}

export interface DashboardManagerPerformance extends DashboardManagerOption {
  conversations: number;
  open: number;
  inProgress: number;
  resolved: number;
  firstResponseCount: number;
  medianFirstResponseSeconds: number | null;
  averageFirstResponseSeconds: number | null;
  p90FirstResponseSeconds: number | null;
}

export interface FirstResponseAnalytics {
  count: number;
  eligibleConversations?: number | null;
  unansweredConversations?: number | null;
  coverageRate?: number | null;
  oldestUnansweredSeconds?: number | null;
  medianSeconds: number | null;
  averageSeconds: number | null;
  p90Seconds: number | null;
}

// Тип для всего ответа от API
export interface DashboardData {
  stats: DashboardMetric[];
  comparisonPeriod: DashboardComparisonPeriod;
  dailySeries: DashboardDailySeries;
  conversationActivityByTime: ConversationActivityByTime[];
  categoryComparisons: DashboardCategoryComparison[];
  peakTime: DashboardPeakTime | null;
  topCategories: { name: string; value: number }[];
  uncategorizedCount: number;
  categoriesByChannel: ChannelDataItem[];
  topComplaintTag: string | null;
  advertisement: AdvertisementAnalytics;
  internalLabels: InternalLabelAnalytics;
  managerOptions: DashboardManagerOption[];
  managerPerformance: DashboardManagerPerformance[];
  firstResponse: FirstResponseAnalytics;
  serviceTruth?: import('@/lib/analytics/service-truth').ServiceTruthReport;
  sourceCoverage?: import('@/lib/analytics/service-truth').DashboardSourceCoverage;
}
