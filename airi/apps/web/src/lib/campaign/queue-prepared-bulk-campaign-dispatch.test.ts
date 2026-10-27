import type { BulkCampaignDispatchItem } from "@icecore/temporal";

import { createPreparedBulkCampaignContentHash } from "./bulk-campaign-content-hash";
import {
  buildBulkCampaignAudienceAdmissionMetadata,
  normalizePreparedBulkCampaignQueueItems,
  resolvePreparedBulkCampaignDispatchTiming,
} from "./queue-prepared-bulk-campaign-dispatch";

const queueIdentityInput = (
  items: BulkCampaignDispatchItem[],
  retryKind: "failed_only" | null = null
) => ({
  items,
  channel: "whatsapp" as const,
  workspaceId: "workspace-1",
  campaignId: "11111111-1111-4111-8111-111111111111",
  sentBy: "user-1",
  fingerprintSecret: "test-fingerprint-secret",
  retryKind,
});

const whatsappItem = (params: {
  messageId?: string;
  phone: string;
}): BulkCampaignDispatchItem => ({
  workspaceId: "stale-workspace",
  campaignId: "22222222-2222-4222-8222-222222222222",
  sentByUserId: "stale-user",
  generatedRecipientMessageId: params.messageId,
  channel: "whatsapp",
  sourceId: "source-1",
  recipient: { phone: params.phone },
  phoneNumberId: "phone-number-1",
  templateName: "launch",
  languageCode: "en",
});

describe("prepared bulk campaign queue item normalization", () => {
  it("builds campaign policy metadata once without copying it into items", () => {
    const metadata = buildBulkCampaignAudienceAdmissionMetadata({
      contentHash: "b".repeat(64),
      sentBy: "user-1",
      policyMetadata: {
        policy: { version: 1, excludePriorFailedBulkSends: true },
        authoritativeRecipientLimit: {
          source: "live_meta",
          value: 2,
          rawLimit: "TIER_2",
        },
        batchPlan: {
          batchSize: 20,
          delayMs: 250,
          ratePerSecond: 80,
          rateSource: "meta_default_throughput",
        },
        outcome: {
          evaluatedAt: "2026-08-21T10:00:00.000Z",
          requestedTotal: 3,
          acceptedTotal: 1,
          uniqueRecipients: { requested: 3, accepted: 1 },
          skippedByReason: { recipient_limit: 1, prior_failure: 1 },
          warnings: { missingMarketingConsent: 0 },
        },
        requestDigest: { version: 1, digest: "a".repeat(64) },
      },
    });

    expect(metadata).toMatchObject({
      policy: { version: 1, excludePriorFailedBulkSends: true },
      authoritativeRecipientLimit: {
        source: "live_meta",
        value: 2,
        rawLimit: "TIER_2",
      },
      requestDigest: { version: 1, digest: "a".repeat(64) },
      batchPlan: {
        batchSize: 20,
        delayMs: 250,
        ratePerSecond: 80,
        rateSource: "meta_default_throughput",
      },
      outcome: {
        evaluatedAt: "2026-08-21T10:00:00.000Z",
        requestedTotal: 3,
        acceptedTotal: 1,
        uniqueRecipients: { requested: 3, accepted: 1 },
      },
    });
    expect(
      JSON.stringify(whatsappItem({ phone: "+77010000001" }))
    ).not.toContain("authoritativeRecipientLimit");
  });

  it("owns operational fields and returns the exact generated projection audience", () => {
    const result = normalizePreparedBulkCampaignQueueItems(
      queueIdentityInput([
        whatsappItem({ messageId: "message-1", phone: "+77010000001" }),
        whatsappItem({ messageId: "message-2", phone: "+77010000002" }),
      ])
    );

    expect(result.items).toHaveLength(2);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: "workspace-1",
          campaignId: "11111111-1111-4111-8111-111111111111",
          sentByUserId: "user-1",
        }),
      ])
    );
    expect(result.queuedGeneratedRecipientMessageIds).toEqual([
      "message-1",
      "message-2",
    ]);
    expect(result.excludedGeneratedRecipientMessages).toEqual([]);
    expect(result.snapshotSeeds).toHaveLength(2);
  });

  it("retains same-recipient items and excludes only invalid generated projections", () => {
    const result = normalizePreparedBulkCampaignQueueItems(
      queueIdentityInput([
        whatsappItem({ messageId: "message-1", phone: "+77010000001" }),
        whatsappItem({ messageId: "message-2", phone: "+77010000001" }),
        whatsappItem({ messageId: "message-3", phone: "" }),
      ])
    );

    expect(result.items.map(item => item.snapshotOrdinal)).toEqual([0, 1]);
    expect(
      result.snapshotSeeds.map(seed => seed.dispatchSnapshot.snapshotOrdinal)
    ).toEqual([0, 1]);
    expect(result.queuedGeneratedRecipientMessageIds).toEqual([
      "message-1",
      "message-2",
    ]);
    expect(result.excludedGeneratedRecipientMessages).toEqual([
      {
        generatedRecipientMessageId: "message-3",
        reason: "invalid_recipient_identity",
      },
    ]);
  });

  it("assigns fresh child ordinals to repeated-recipient failed-only retries", () => {
    const parentItems = [
      {
        ...whatsappItem({ messageId: "message-1", phone: "+77010000001" }),
        snapshotOrdinal: 9,
      },
      {
        ...whatsappItem({ messageId: "message-2", phone: "+77010000001" }),
        snapshotOrdinal: 12,
      },
    ];

    const result = normalizePreparedBulkCampaignQueueItems(
      queueIdentityInput(parentItems, "failed_only")
    );

    expect(result.items.map(item => item.snapshotOrdinal)).toEqual([0, 1]);
    expect(result.snapshotSeeds).toHaveLength(2);
    expect(result.snapshotSeeds[0]?.recipientHash).toBe(
      result.snapshotSeeds[1]?.recipientHash
    );
  });
});

describe("prepared bulk campaign command timing", () => {
  it("preserves the original immediate command deadline across a late retry", () => {
    expect(
      resolvePreparedBulkCampaignDispatchTiming({
        requestedAt: "2026-07-27T10:00:00.000Z",
        scheduledAt: null,
        now: new Date("2026-07-27T11:00:00.000Z"),
      })
    ).toEqual({
      requestedAt: "2026-07-27T10:00:00.000Z",
      dispatchExpiresAt: "2026-07-27T10:15:00.000Z",
      expired: true,
    });
  });

  it("uses the immutable scheduled start rather than the retry time", () => {
    expect(
      resolvePreparedBulkCampaignDispatchTiming({
        requestedAt: "2026-07-27T10:00:00.000Z",
        scheduledAt: "2026-07-28T08:00:00.000Z",
        now: new Date("2026-07-27T11:00:00.000Z"),
      })
    ).toEqual({
      requestedAt: "2026-07-27T10:00:00.000Z",
      dispatchExpiresAt: "2026-07-28T08:15:00.000Z",
      expired: false,
    });
  });
});

describe("prepared bulk campaign content hashing", () => {
  const recipientHash = "a".repeat(64);
  const campaignId = "11111111-1111-4111-8111-111111111111";

  it("normalizes only structural campaign fields and preserves literal message content", () => {
    const literalCampaignId = createPreparedBulkCampaignContentHash([
      {
        recipientHash,
        dispatchSnapshot: {
          campaignId,
          messageText: campaignId,
        },
      },
    ]);
    const literalPlaceholder = createPreparedBulkCampaignContentHash([
      {
        recipientHash,
        dispatchSnapshot: {
          campaignId,
          messageText: "{campaignId}",
        },
      },
    ]);

    expect(literalCampaignId).not.toBe(literalPlaceholder);
  });

  it("preserves user variables that happen to use an operational field name", () => {
    const first = createPreparedBulkCampaignContentHash([
      {
        recipientHash,
        dispatchSnapshot: {
          campaignId,
          recipient: {
            email: "person@example.com",
            variables: { campaignId: "customer-value-a" },
          },
        },
      },
    ]);
    const second = createPreparedBulkCampaignContentHash([
      {
        recipientHash,
        dispatchSnapshot: {
          campaignId: "22222222-2222-4222-8222-222222222222",
          recipient: {
            email: "person@example.com",
            variables: { campaignId: "customer-value-b" },
          },
        },
      },
    ]);

    expect(first).not.toBe(second);
  });

  it("stays stable when only generated operational fields change", () => {
    const first = createPreparedBulkCampaignContentHash([
      {
        recipientHash,
        dispatchSnapshot: {
          campaignId,
          sentByUserId: "user-1",
          recipient: {
            email: "person@example.com",
            variables: {
              unsubscribeUrl: `https://app.airi.chat/unsubscribe/${campaignId}`,
            },
          },
          templateModel: {
            unsubscribeUrl: `https://app.airi.chat/unsubscribe/${campaignId}`,
          },
          messageText: "A stable message",
        },
      },
    ]);
    const second = createPreparedBulkCampaignContentHash([
      {
        recipientHash,
        dispatchSnapshot: {
          campaignId: "22222222-2222-4222-8222-222222222222",
          sentByUserId: "user-2",
          recipient: {
            email: "person@example.com",
            variables: {
              unsubscribeUrl:
                "https://app.airi.chat/unsubscribe/22222222-2222-4222-8222-222222222222",
            },
          },
          templateModel: {
            unsubscribeUrl:
              "https://app.airi.chat/unsubscribe/22222222-2222-4222-8222-222222222222",
          },
          messageText: "A stable message",
        },
      },
    ]);

    expect(first).toBe(second);
  });

  it("binds the generated message projection id used by recovery", () => {
    const first = createPreparedBulkCampaignContentHash([
      {
        recipientHash,
        dispatchSnapshot: {
          campaignId,
          generatedRecipientMessageId: "message-1",
          messageText: "A stable message",
        },
      },
    ]);
    const second = createPreparedBulkCampaignContentHash([
      {
        recipientHash,
        dispatchSnapshot: {
          campaignId,
          generatedRecipientMessageId: "message-2",
          messageText: "A stable message",
        },
      },
    ]);

    expect(first).not.toBe(second);
  });
});
