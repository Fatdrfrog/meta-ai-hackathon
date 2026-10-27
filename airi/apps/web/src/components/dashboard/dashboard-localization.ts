import {
  DASHBOARD_UNCATEGORIZED_CATEGORY,
  type DashboardMetric,
  type DashboardMetricId,
  type DashboardCountComparison,
  type DashboardChangeKind,
  type FirstResponseAnalytics,
} from "@/types/dashboard";
import { createDashboardFormatters } from "./dashboard-formatters";

export { normalizeDashboardIntlLocale } from "./dashboard-formatters";

export type DashboardTranslator = (
  key: string,
  values?: Record<string, number | string>
) => string;

export interface DashboardStatCard {
  id: DashboardMetricId;
  label: string;
  value: string;
  comparison: DashboardCountComparison | null;
  insight: string;
  isHighlighted?: boolean;
}

const METRIC_LABEL_KEYS: Record<DashboardMetricId, string> = {
  total: "metrics.total",
  new: "metrics.new",
  in_progress: "metrics.inProgress",
  resolved: "metrics.resolved",
  sla: "metrics.slaBreached",
  repeat: "metrics.repeatRequests",
  csat: "metrics.avgCsat",
  first_response: "metrics.medianFirstManagerResponseTime",
  ttr: "metrics.avgResolutionTime",
};

const CHANGE_KIND_LABEL_KEYS: Record<DashboardChangeKind, string> = {
  increase: "categoryComparison.changeKinds.increase",
  decrease: "categoryComparison.changeKinds.decrease",
  unchanged: "categoryComparison.changeKinds.unchanged",
  new: "categoryComparison.changeKinds.new",
  no_longer_active: "categoryComparison.changeKinds.noLongerActive",
};

function isDashboardMetricHighlighted(metric: DashboardMetric): boolean {
  if (metric.value === null) return false;
  if (metric.id === "sla") return metric.value > 0;
  if (metric.id === "csat") return metric.value <= 3.5;
  return false;
}

export function formatDashboardDuration(
  seconds: number | null,
  locale: string,
  t: DashboardTranslator
): string {
  if (seconds === null || !Number.isFinite(seconds)) {
    return t("duration.missing");
  }
  if (seconds < 60) return t("duration.lessThanMinute");

  const { number } = createDashboardFormatters(locale);
  if (seconds < 3_600) {
    const count = Math.round(seconds / 60);
    return t("duration.minutes", { count, value: number(count) });
  }
  if (seconds < 86_400) {
    const count = Number((seconds / 3_600).toFixed(1));
    return t("duration.hours", { count, value: number(count) });
  }

  const count = Number((seconds / 86_400).toFixed(1));
  return t("duration.days", { count, value: number(count) });
}

export function formatDashboardDurationDelta(
  seconds: number | null,
  locale: string,
  t: DashboardTranslator
): string {
  if (seconds === null || !Number.isFinite(seconds)) {
    return t("duration.missing");
  }
  const magnitude = Math.round(Math.abs(seconds));
  if (magnitude === 0) return t("duration.noChange");

  const sign = seconds > 0 ? "+" : "-";
  // "Less than a minute" reads as a value, not a change: deltas keep seconds.
  if (magnitude < 60) {
    const { number } = createDashboardFormatters(locale);
    return `${sign}${t("duration.seconds", {
      count: magnitude,
      value: number(magnitude),
    })}`;
  }
  return `${sign}${formatDashboardDuration(magnitude, locale, t)}`;
}

/** Card metrics that report the queue as it is now, so no past value exists. */
export const DASHBOARD_LIVE_STATUS_METRICS: ReadonlySet<DashboardMetricId> =
  new Set(["new", "in_progress", "sla"]);

/** Change and previous-period value, in the unit and format of the metric card. */
export function formatDashboardStatComparison(
  id: DashboardMetricId,
  comparison: DashboardCountComparison,
  locale: string,
  t: DashboardTranslator
): { change: string; previous: string } {
  const { number, integer, signedInteger, signedPercent } =
    createDashboardFormatters(locale);

  switch (id) {
    case "first_response":
      return {
        change: formatDashboardDurationDelta(comparison.delta, locale, t),
        previous: formatDashboardDuration(comparison.previous, locale, t),
      };
    case "ttr":
      // Resolution time is reported in days, like the metric value.
      return {
        change: formatDashboardDurationDelta(
          comparison.delta * 86_400,
          locale,
          t
        ),
        previous: formatDashboardDuration(
          comparison.previous * 86_400,
          locale,
          t
        ),
      };
    case "csat":
      return {
        change:
          comparison.delta === 0
            ? t("noChange")
            : `${comparison.delta > 0 ? "+" : ""}${number(comparison.delta)}`,
        previous: number(comparison.previous),
      };
    default:
      return {
        change:
          comparison.delta === 0
            ? t("noChange")
            : comparison.percentChange === null
              ? signedInteger(comparison.delta)
              : signedPercent(comparison.percentChange, 1),
        previous: integer(comparison.previous),
      };
  }
}

export function formatDashboardChangeKind(
  kind: DashboardChangeKind,
  t: DashboardTranslator
): string {
  return t(CHANGE_KIND_LABEL_KEYS[kind]);
}

export function formatDashboardCategory(
  category: string | null,
  t: DashboardTranslator
): string {
  if (category === DASHBOARD_UNCATEGORIZED_CATEGORY) {
    return t("uncategorized");
  }
  return category ?? t("missingValue");
}

export function buildDashboardComplaintInsight(
  topComplaintTag: string | null,
  t: DashboardTranslator
): string {
  return topComplaintTag
    ? t("complaintInsight", { tag: topComplaintTag })
    : t("noComplaintTrends");
}

export function buildDashboardStatCards(
  metrics: DashboardMetric[],
  firstResponse: FirstResponseAnalytics,
  locale: string,
  t: DashboardTranslator
): DashboardStatCard[] {
  const { number, integer, percent } = createDashboardFormatters(locale);

  return metrics.map(metric => {
    let value =
      metric.value === null ? t("duration.missing") : number(metric.value);
    let insight = "";

    if (metric.id === "repeat" && metric.value !== null) {
      const percentage = metric.secondaryValue ?? 0;
      value = `${integer(metric.value)} (${percent(percentage, 1)})`;
    } else if (metric.id === "csat" && metric.value !== null) {
      value = metric.secondaryValue
        ? `${number(metric.value)} / ${number(metric.secondaryValue)}`
        : number(metric.value);
    } else if (metric.id === "first_response") {
      value = formatDashboardDuration(
        firstResponse.count > 0 ? metric.value : null,
        locale,
        t
      );
      if (firstResponse.count > 0) {
        insight = t("firstManagerResponseInsight", {
          count: firstResponse.count,
          countValue: integer(firstResponse.count),
          average: formatDashboardDuration(
            firstResponse.averageSeconds,
            locale,
            t
          ),
          p90: formatDashboardDuration(firstResponse.p90Seconds, locale, t),
        });
      }
    } else if (metric.id === "ttr") {
      value = formatDashboardDuration(
        metric.value === null ? null : metric.value * 86_400,
        locale,
        t
      );
    }

    return {
      id: metric.id,
      label: t(METRIC_LABEL_KEYS[metric.id]),
      value,
      comparison: metric.comparison,
      insight,
      isHighlighted: isDashboardMetricHighlighted(metric),
    };
  });
}
