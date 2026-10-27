export const LEGACY_BULK_CAMPAIGN_DISPATCH_START_GRACE_MS = 15 * 60 * 1000;

export function isLegacyBulkCampaignActivityExpired(params: {
  lifecycleManaged?: boolean;
  scheduledTimestampMs: number;
  nowMs?: number;
}): boolean {
  if (params.lifecycleManaged === true) {
    return false;
  }
  const nowMs = params.nowMs ?? Date.now();
  return (
    nowMs - params.scheduledTimestampMs >
    LEGACY_BULK_CAMPAIGN_DISPATCH_START_GRACE_MS
  );
}
