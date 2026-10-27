import { BULK_CAMPAIGN_OVERFLOW_QUEUE_INTERVAL_MS } from "@icecore/temporal";
import { buildBulkCampaignOverflowQueuePlan } from "./bulk-campaign-overflow-queue";

describe("buildBulkCampaignOverflowQueuePlan", () => {
  it("keeps a list inside the daily cap on one immediate wave", () => {
    expect(
      buildBulkCampaignOverflowQueuePlan({
        recipientCount: 250,
        dailyLimit: 250,
        startAt: "2026-08-27T09:00:00.000Z",
      })
    ).toEqual({
      recipientCount: 250,
      dailyLimit: 250,
      exceedsDailyLimit: false,
      waveCount: 1,
      firstWaveCount: 250,
      queuedCount: 0,
      lastWaveAt: null,
    });
  });

  it("queues leftover recipients into 24h waves starting from now", () => {
    expect(
      buildBulkCampaignOverflowQueuePlan({
        recipientCount: 2145,
        dailyLimit: 250,
        startAt: "2026-08-27T09:00:00.000Z",
      })
    ).toEqual({
      recipientCount: 2145,
      dailyLimit: 250,
      exceedsDailyLimit: true,
      waveCount: 9,
      firstWaveCount: 250,
      queuedCount: 1895,
      lastWaveAt: new Date(
        Date.parse("2026-08-27T09:00:00.000Z") +
          8 * BULK_CAMPAIGN_OVERFLOW_QUEUE_INTERVAL_MS
      ).toISOString(),
    });
  });
});
