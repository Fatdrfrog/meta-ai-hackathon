import {
  buildDashboardStatCards,
  formatDashboardCategory,
  type DashboardTranslator,
} from "@/components/dashboard/dashboard-localization";
import type { DashboardData, DashboardMetricId } from "@/types/dashboard";

export interface DashboardExportFilters {
  channels: string[];
  categories: string[];
  internalLabels: string[];
  managerIds: string[];
}

export interface BuildDashboardCsvInput {
  data: DashboardData;
  filters: DashboardExportFilters;
  comparisonEnabled?: boolean;
  locale: string;
  translate: DashboardTranslator;
}

const csvCell = (value: unknown) => {
  const text = String(value ?? "");
  const safeText =
    typeof value === "string" && /^ *(?:[=+\-@]|[\t\r\n])/.test(text)
      ? `'${text}`
      : text;
  return /[",\n\r]/.test(safeText)
    ? `"${safeText.replace(/"/g, '""')}"`
    : safeText;
};

const csvRow = (...values: unknown[]) => values.map(csvCell).join(",");

const DASHBOARD_METRIC_UNITS: Record<
  DashboardMetricId,
  "count" | "seconds" | "days" | "score" | "percent"
> = {
  total: "count",
  new: "count",
  in_progress: "count",
  resolved: "count",
  sla: "count",
  repeat: "count",
  csat: "score",
  first_response: "seconds",
  ttr: "days",
};

export function buildDashboardCsv({
  data,
  filters,
  comparisonEnabled = true,
  locale,
  translate,
}: BuildDashboardCsvInput): string {
  const metaInsights = data.advertisement?.metaInsights ?? null;
  const all = translate("export.all");
  const formatCategory = (category: string | null) =>
    formatDashboardCategory(category, translate);
  const includeComparison =
    comparisonEnabled && data.comparisonPeriod.previous !== null;
  const exportedStrategy = includeComparison
    ? data.comparisonPeriod.strategy
    : "none";
  const lines: string[] = [];

  lines.push(translate("export.filters"));
  lines.push(csvRow("channels", filters.channels.join("|") || all));
  lines.push(
    csvRow(
      "categories",
      filters.categories.map(formatCategory).join("|") || all
    )
  );
  lines.push(
    csvRow("internal_labels", filters.internalLabels.join("|") || all)
  );
  lines.push(csvRow("managers", filters.managerIds.join("|") || all));
  lines.push("");
  lines.push(translate("export.comparisonPeriods"));
  lines.push(
    "preset,strategy,timezone,current_start,current_end_exclusive,previous_start,previous_end_exclusive"
  );
  lines.push(
    csvRow(
      data.comparisonPeriod.preset,
      exportedStrategy,
      data.comparisonPeriod.timeZone,
      data.comparisonPeriod.current.start,
      data.comparisonPeriod.current.endExclusive,
      includeComparison ? data.comparisonPeriod.previous?.start : "",
      includeComparison ? data.comparisonPeriod.previous?.endExclusive : ""
    )
  );
  lines.push("");
  lines.push(translate("export.dailyCountsOverall"));
  lines.push("date,total");
  data.dailySeries.current.forEach(day =>
    lines.push(csvRow(day.date, day.total))
  );
  lines.push("");
  lines.push(translate("export.messageActivityByHour"));
  lines.push("day_of_week,hour,message_count");
  data.conversationActivityByTime.forEach(slot =>
    lines.push(csvRow(slot.dayOfWeek, slot.hour, slot.count))
  );
  lines.push("");
  lines.push(translate("export.topCategoriesVisible"));
  lines.push("name,value");
  data.topCategories.forEach(category =>
    lines.push(csvRow(formatCategory(category.name), category.value))
  );
  lines.push("");
  lines.push(translate("export.categoryComparisons"));
  lines.push("category,current,previous,difference,percent_change,change_kind");
  data.categoryComparisons.forEach(row =>
    lines.push(
      csvRow(
        row.category,
        row.current,
        includeComparison ? row.previous : "",
        includeComparison ? row.delta : "",
        includeComparison ? row.percentChange : "",
        includeComparison ? row.kind : ""
      )
    )
  );
  lines.push("");
  lines.push(translate("export.categoriesByChannelVisible"));
  lines.push("channel,category,count");
  data.categoriesByChannel.forEach(row =>
    lines.push(csvRow(row.channel, formatCategory(row.category), row.count))
  );
  lines.push("");
  lines.push(translate("export.statsOverall"));
  lines.push(
    "id,label,unit,value,current,previous,difference,percent_change,change_kind"
  );
  buildDashboardStatCards(
    data.stats,
    data.firstResponse,
    locale,
    translate
  ).forEach(stat => {
    const metric = data.stats.find(candidate => candidate.id === stat.id);
    const comparison = includeComparison ? metric?.comparison : null;
    lines.push(
      csvRow(
        stat.id,
        stat.label,
        DASHBOARD_METRIC_UNITS[stat.id],
        stat.value,
        comparison?.current ?? metric?.value ?? "",
        comparison?.previous ?? "",
        comparison?.delta ?? "",
        comparison?.percentChange ?? "",
        comparison?.kind ?? ""
      )
    );
  });
  lines.push("");
  lines.push(translate("export.advertisement"));
  lines.push("metric,value");
  if (metaInsights) {
    lines.push(csvRow("meta_results", metaInsights.totalResults));
    lines.push(csvRow("meta_spend", metaInsights.totalSpend));
    lines.push(csvRow("meta_cost_per_result", metaInsights.costPerResult));
    lines.push(csvRow("meta_currency", metaInsights.currency));
    lines.push(csvRow("meta_account_id", metaInsights.accountId));
    lines.push(csvRow("meta_account_name", metaInsights.accountName));
    lines.push(csvRow("meta_date_start", metaInsights.dateStart));
    lines.push(csvRow("meta_date_stop", metaInsights.dateStop));
    lines.push(csvRow("meta_partial", metaInsights.partial));
    lines.push(csvRow("meta_error", metaInsights.error));
    lines.push(
      csvRow("meta_result_action_type", metaInsights.resultActionType)
    );
    lines.push(csvRow("meta_fetched_at", metaInsights.fetchedAt));
    lines.push(
      csvRow(
        "meta_action_report_time",
        metaInsights.reporting?.actionReportTime
      )
    );
    lines.push(csvRow("meta_attribution", metaInsights.reporting?.attribution));
    lines.push(csvRow("meta_destination", metaInsights.reporting?.destination));
    lines.push(
      csvRow(
        "meta_workspace_timezone",
        metaInsights.reporting?.workspaceTimeZone
      )
    );
    lines.push(csvRow("meta_local_filters_applied", false));
    lines.push(
      csvRow(
        "meta_reported_result_rows",
        metaInsights.resultCoverage?.reportedRows
      )
    );
    lines.push(
      csvRow(
        "meta_missing_result_rows",
        metaInsights.resultCoverage?.missingRows
      )
    );
    lines.push(
      csvRow(
        "meta_reported_spend_rows",
        metaInsights.spendCoverage?.reportedRows
      )
    );
    lines.push(
      csvRow("meta_missing_spend_rows", metaInsights.spendCoverage?.missingRows)
    );
    lines.push(csvRow("meta_warnings", metaInsights.warnings?.join("|")));
  }
  lines.push(
    csvRow("airi_captured_starts", data.advertisement?.totalConversations ?? 0)
  );
  lines.push(csvRow("unique_sources", data.advertisement?.uniqueSources ?? 0));
  lines.push(
    csvRow("responded", data.advertisement?.respondedConversations ?? 0)
  );
  lines.push(csvRow("closed", data.advertisement?.closedConversations ?? 0));
  lines.push(csvRow("response_rate", data.advertisement?.responseRate ?? 0));
  lines.push(csvRow("close_rate", data.advertisement?.closeRate ?? 0));
  if (metaInsights) {
    lines.push("");
    lines.push(translate("export.metaAdsManagerDaily"));
    lines.push(
      "date,results,spend,cost_per_result,account_id,currency,missing_result_rows,missing_spend_rows"
    );
    metaInsights.dailyCounts.forEach(day =>
      lines.push(
        csvRow(
          day.date,
          day.results,
          day.spend,
          day.costPerResult,
          day.accountId,
          day.currency,
          day.missingResultRows,
          day.missingSpendRows
        )
      )
    );
    lines.push("");
    lines.push(translate("export.metaAdsManagerTopAds"));
    lines.push(
      "ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,results,spend,cost_per_result,account_id,currency,missing_result_rows,missing_spend_rows,current_destination,current_destination_type,destination_updated_at"
    );
    metaInsights.topAds.forEach(ad =>
      lines.push(
        csvRow(
          ad.adId,
          ad.adName,
          ad.campaignId,
          ad.campaignName,
          ad.adSetId,
          ad.adSetName,
          ad.results,
          ad.spend,
          ad.costPerResult,
          ad.accountId,
          ad.currency,
          ad.missingResultRows,
          ad.missingSpendRows,
          ad.destination,
          ad.destinationType,
          ad.destinationUpdatedAt
        )
      )
    );
    lines.push("");
    lines.push(translate("export.metaAdsCurrencies"));
    lines.push(
      "currency,spend,results,cost_per_result,impressions,link_clicks,link_ctr,link_cpc,account_ids,missing_result_rows,missing_spend_rows"
    );
    metaInsights.currencyBuckets?.forEach(bucket =>
      lines.push(
        csvRow(
          bucket.currency,
          bucket.spend,
          bucket.results,
          bucket.costPerResult,
          bucket.impressions,
          bucket.linkClicks,
          bucket.ctr,
          bucket.cpc,
          bucket.accountIds.join("|"),
          bucket.missingResultRows,
          bucket.missingSpendRows
        )
      )
    );
    lines.push("");
    lines.push(translate("export.metaAdsAccounts"));
    lines.push(
      "account_id,account_name,currency,timezone,date_start,date_stop,impressions,reach,frequency,link_clicks,link_ctr,link_cpc"
    );
    metaInsights.accounts?.forEach(account =>
      lines.push(
        csvRow(
          account.accountId,
          account.accountName,
          account.currency,
          account.timeZone,
          account.dateStart,
          account.dateStop,
          account.impressions,
          account.reach,
          account.frequency,
          account.linkClicks,
          account.ctr,
          account.cpc
        )
      )
    );
  }
  const feedback = data.advertisement?.conversionFeedback;
  if (feedback || data.advertisement?.conversionFeedbackError) {
    lines.push("");
    lines.push(translate("export.conversionFeedback"));
    lines.push("metric,value");
    lines.push(
      csvRow("feedback_error", data.advertisement.conversionFeedbackError)
    );
    if (feedback) {
      lines.push(csvRow("feedback_recorded", feedback.recorded));
      lines.push(csvRow("feedback_eligible", feedback.eligible));
      Object.entries(feedback.statuses).forEach(([status, count]) =>
        lines.push(csvRow(`feedback_${status}`, count))
      );
      lines.push(
        csvRow("feedback_oldest_pending_at", feedback.oldestPendingAt)
      );
      lines.push(csvRow("feedback_reasons_truncated", feedback.truncated));
      lines.push("");
      lines.push(translate("export.conversionFeedbackReasons"));
      lines.push("status,reason,count");
      feedback.reasons.forEach(reason =>
        lines.push(csvRow(reason.status, reason.reason, reason.count))
      );
    }
  }
  lines.push("");
  lines.push(translate("export.advertisementSources"));
  lines.push(
    "source_key,source_type,source_id,headline,starts,responded,closed"
  );
  data.advertisement?.topSources.forEach(source =>
    lines.push(
      csvRow(
        source.sourceKey,
        source.sourceType,
        source.sourceId,
        source.headline,
        source.conversations,
        source.responded,
        source.closed
      )
    )
  );
  lines.push("");
  lines.push(translate("export.internalLabels"));
  lines.push("metric,value");
  lines.push(
    csvRow(
      "tagged_conversations",
      data.internalLabels?.taggedConversations ?? 0
    )
  );
  lines.push(
    csvRow(
      "unlabeled_conversations",
      data.internalLabels?.unlabeledConversations ?? 0
    )
  );
  lines.push(csvRow("unique_labels", data.internalLabels?.uniqueLabels ?? 0));
  lines.push(
    csvRow("total_assignments", data.internalLabels?.totalAssignments ?? 0)
  );
  lines.push("");
  lines.push(translate("export.managers"));
  lines.push(
    "manager_id,name,handled_conversations,open,in_progress,resolved,first_response_count,median_first_response,p90_first_response"
  );
  data.managerPerformance.forEach(manager =>
    lines.push(
      csvRow(
        manager.id,
        manager.name,
        manager.conversations,
        manager.open,
        manager.inProgress,
        manager.resolved,
        manager.firstResponseCount,
        manager.medianFirstResponseSeconds,
        manager.p90FirstResponseSeconds
      )
    )
  );
  lines.push("");
  lines.push(translate("export.internalLabelBreakdown"));
  lines.push("label,conversations,open,in_progress,closed,responded,latest_at");
  data.internalLabels?.topLabels.forEach(label =>
    lines.push(
      csvRow(
        label.label,
        label.conversations,
        label.open,
        label.inProgress,
        label.closed,
        label.responded,
        label.latestAt
      )
    )
  );

  return lines.join("\n");
}
