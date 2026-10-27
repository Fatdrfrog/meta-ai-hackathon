import { buildCacheKey } from "@icecore/shared/lib/cache";

export const CAMPAIGN_DELIVERY_MAX_ATTEMPTS = 5;
export const CAMPAIGN_DELIVERY_STALE_PROCESSING_MINUTES = 20;

export function buildCampaignDeliveryIdempotencyKey(
  parts: Array<string | number | null | undefined>
): string {
  return buildCacheKey("campaign-delivery", parts);
}

export function computeCampaignDeliveryRetryAt(params: {
  attempts: number;
  now?: Date;
}): Date {
  const now = params.now || new Date();
  const attempt = Math.max(1, Math.floor(params.attempts || 1));
  const backoffMinutes = Math.min(120, Math.max(1, 2 ** Math.min(attempt, 6)));
  return new Date(now.getTime() + backoffMinutes * 60_000);
}
