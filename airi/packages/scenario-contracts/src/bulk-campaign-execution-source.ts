/**
 * How a bulk send / campaign run was started (web API, dispatch CRON, Temporal).
 * Shared by Mongo enums, Zod, and @icecore/temporal campaign contracts.
 */
export const BULK_CAMPAIGN_DISPATCH_EXECUTION_SOURCES = [
  "scenario_schedule",
  "scenario_run_now",
  "ad_hoc",
] as const;

export type BulkCampaignDispatchExecutionSource =
  (typeof BULK_CAMPAIGN_DISPATCH_EXECUTION_SOURCES)[number];
