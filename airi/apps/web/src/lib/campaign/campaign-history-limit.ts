import { readNonNegativeCount } from "@icecore/shared/lib/value-utils";

export type CampaignHistoryLimitRow = {
  total_recipients?: number | null;
  successful_sends?: number | null;
  failed_sends?: number | null;
};

export function campaignHistoryCountsTowardBulkLimit(
  row: CampaignHistoryLimitRow
): boolean {
  const totalRecipients = readNonNegativeCount(row.total_recipients);
  const successfulSends = readNonNegativeCount(row.successful_sends);
  const failedSends = readNonNegativeCount(row.failed_sends);

  if (successfulSends > 0) return true;
  if (totalRecipients <= 0) return false;

  return failedSends < totalRecipients;
}
