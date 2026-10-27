/**
 * Classify Meta Ads MCP tools as read (auto-run) vs write (confirm first).
 * Only reviewed exact names may auto-run; every other tool fails closed.
 */

const READ_TOOL_EXACT = new Set([
  "ads_get_ad_entities",
  "ads_get_field_context",
  "ads_get_opportunity_score",
  "ads_insights_advertiser_context",
  "ads_insights_anomaly_signal",
  "ads_insights_auction_ranking_benchmarks",
  "ads_insights_industry_benchmark",
  "ads_insights_performance_trend",
  "ads_get_ad_accounts",
  "ads_search_help_articles",
  "ads_get_activity_history",
  "ads_get_signal_health",
  "ads_get_dataset_quality",
]);

export type MetaAdsMcpToolSideEffect = "read" | "write";

export function classifyMetaAdsMcpToolSideEffect(
  toolName: string
): MetaAdsMcpToolSideEffect {
  return READ_TOOL_EXACT.has(toolName) ? "read" : "write";
}

export function isMetaAdsMcpWriteTool(toolName: string): boolean {
  return classifyMetaAdsMcpToolSideEffect(toolName) === "write";
}
