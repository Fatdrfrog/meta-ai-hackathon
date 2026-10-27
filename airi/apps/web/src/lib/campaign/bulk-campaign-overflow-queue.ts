import { BULK_CAMPAIGN_OVERFLOW_QUEUE_INTERVAL_MS } from "@icecore/temporal";

export const BULK_CAMPAIGN_OVERFLOW_QUEUE_CONFIRMATION_REQUIRED =
  "bulk_campaign_overflow_queue_confirmation_required";

export type BulkCampaignOverflowQueuePlan = {
  recipientCount: number;
  dailyLimit: number;
  exceedsDailyLimit: boolean;
  waveCount: number;
  firstWaveCount: number;
  queuedCount: number;
  lastWaveAt: string | null;
};

export type BulkCampaignOverflowQueueConfirmation = BulkCampaignOverflowQueuePlan & {
  required: boolean;
  confirmed: boolean;
};

export function readBulkCampaignOverflowQueuePayload(
  payload: unknown
): BulkCampaignOverflowQueueConfirmation | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const overflowQueue = (payload as { overflowQueue?: unknown }).overflowQueue;
  if (
    !overflowQueue ||
    typeof overflowQueue !== "object" ||
    Array.isArray(overflowQueue)
  ) {
    return null;
  }
  const row = overflowQueue as Record<string, unknown>;
  const recipientCount = row.recipientCount;
  const dailyLimit = row.dailyLimit;
  const waveCount = row.waveCount;
  const firstWaveCount = row.firstWaveCount;
  const queuedCount = row.queuedCount;
  if (
    typeof recipientCount !== "number" ||
    typeof dailyLimit !== "number" ||
    typeof waveCount !== "number" ||
    typeof firstWaveCount !== "number" ||
    typeof queuedCount !== "number"
  ) {
    return null;
  }
  return {
    recipientCount,
    dailyLimit,
    exceedsDailyLimit: row.exceedsDailyLimit === true || queuedCount > 0,
    waveCount,
    firstWaveCount,
    queuedCount,
    lastWaveAt: typeof row.lastWaveAt === "string" ? row.lastWaveAt : null,
    required: row.required === true,
    confirmed: row.confirmed === true,
  };
}

export function buildBulkCampaignOverflowQueuePlan(params: {
  recipientCount: number;
  dailyLimit: number;
  startAt?: Date | string | null;
}): BulkCampaignOverflowQueuePlan {
  const recipientCount = Math.max(0, Math.floor(params.recipientCount || 0));
  const dailyLimit = Math.max(0, Math.floor(params.dailyLimit || 0));
  if (recipientCount === 0 || dailyLimit <= 0) {
    return {
      recipientCount,
      dailyLimit,
      exceedsDailyLimit: false,
      waveCount: 0,
      firstWaveCount: 0,
      queuedCount: 0,
      lastWaveAt: null,
    };
  }

  const waveCount = Math.ceil(recipientCount / dailyLimit);
  const firstWaveCount = Math.min(dailyLimit, recipientCount);
  const queuedCount = Math.max(0, recipientCount - firstWaveCount);
  const exceedsDailyLimit = queuedCount > 0;
  const startAtMs = Date.parse(
    params.startAt instanceof Date
      ? params.startAt.toISOString()
      : params.startAt || ""
  );
  const startMs = Number.isFinite(startAtMs) ? startAtMs : Date.now();
  const lastWaveAt =
    waveCount > 1
      ? new Date(
          // INTERVAL includes max jitter so GCS retain outlives the last wave.
          startMs + (waveCount - 1) * BULK_CAMPAIGN_OVERFLOW_QUEUE_INTERVAL_MS
        ).toISOString()
      : null;

  return {
    recipientCount,
    dailyLimit,
    exceedsDailyLimit,
    waveCount,
    firstWaveCount,
    queuedCount,
    lastWaveAt,
  };
}
