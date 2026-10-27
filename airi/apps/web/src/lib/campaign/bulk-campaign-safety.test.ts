/**
 * @jest-environment node
 */

import {
  BULK_CAMPAIGN_EXPIRY_GRACE_MS,
  BULK_CAMPAIGN_RECENT_OVERLAP_WINDOW_MS,
  calculateBulkCampaignAudienceOverlap,
  canonicalizeBulkCampaignRecipientIdentity,
  classifyBulkCampaignProviderCircuit,
  createBulkCampaignAudienceFingerprint,
  createBulkCampaignAudienceFingerprintFromRecipientHashes,
  getBulkCampaignDispatchExpiresAt,
  hasConfirmedBulkCampaignAudienceResend,
  isBulkCampaignDispatchExpired,
  requiresBulkCampaignAudienceConfirmation,
} from "./bulk-campaign-safety";

const secret = "test-encryption-secret";
const workspaceId = "workspace-1";

describe("bulk campaign audience safety", () => {
  it.each([
    "KZ.12345678901234",
    "=77010000001",
    "client77010000001",
    "7.701E+10",
    "++77010000001",
  ])(
    "does not turn a non-phone recipient %s into a sendable hashed identity",
    phone => {
      expect(
        canonicalizeBulkCampaignRecipientIdentity({
          channel: "whatsapp",
          recipient: { phone },
        })
      ).toBeNull();
    }
  );

  it("retains the v1 persisted identity for legacy national-format snapshots", () => {
    expect(
      canonicalizeBulkCampaignRecipientIdentity({
        channel: "whatsapp",
        recipient: { phone: "87010000001" },
      })
    ).toBe("87010000001");
  });

  it("canonicalizes recipient identities by channel", () => {
    expect(
      canonicalizeBulkCampaignRecipientIdentity({
        channel: "whatsapp",
        recipient: { phone: "+7 (701) 000-00-01" },
      })
    ).toBe("77010000001");
    expect(
      canonicalizeBulkCampaignRecipientIdentity({
        channel: "telegram",
        recipient: { chatId: "  -100123  ", sourceId: " SOURCE-1 " },
      })
    ).toBe("source-1:-100123");
    expect(
      canonicalizeBulkCampaignRecipientIdentity({
        channel: "email",
        recipient: { email: "  PERSON@EXAMPLE.COM " },
      })
    ).toBe("person@example.com");
  });

  it("creates an opaque stable audience fingerprint independent of recipient order and duplicates", () => {
    const first = createBulkCampaignAudienceFingerprint({
      secret,
      workspaceId,
      channel: "whatsapp",
      recipients: [
        { phone: "+7 701 000 00 01" },
        { phone: "+7 701 000 00 02" },
      ],
    });
    const second = createBulkCampaignAudienceFingerprint({
      secret,
      workspaceId,
      channel: "whatsapp",
      recipients: [
        { phone: "77010000002" },
        { phone: "77010000001" },
        { phone: "77010000001" },
      ],
    });

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.recipientHashes).toHaveLength(2);
    expect(
      createBulkCampaignAudienceFingerprintFromRecipientHashes({
        secret,
        workspaceId,
        channel: "whatsapp",
        recipientHashes: [
          first.recipientHashes[1]!,
          first.recipientHashes[0]!,
          first.recipientHashes[0]!,
        ],
      })
    ).toBe(first.fingerprint);
  });

  it("blocks an exact fingerprint regardless of audience size", () => {
    const overlap = calculateBulkCampaignAudienceOverlap({
      candidateFingerprint: "same",
      previousFingerprint: "same",
      candidateRecipientHashes: ["a"],
      previousRecipientHashes: ["a"],
    });

    expect(overlap.kind).toBe("exact");
    expect(overlap.blocksActiveDispatch).toBe(true);
  });

  it("classifies an 80 percent overlap with at least ten intersecting recipients as high", () => {
    const candidate = Array.from({ length: 12 }, (_, index) => `id-${index}`);
    const overlap = calculateBulkCampaignAudienceOverlap({
      candidateRecipientHashes: candidate,
      previousRecipientHashes: [
        ...candidate.slice(0, 10),
        "other-1",
        "other-2",
      ],
    });

    expect(overlap.intersectionCount).toBe(10);
    expect(overlap.ratio).toBe(10 / 12);
    expect(overlap.kind).toBe("high");
    expect(overlap.blocksActiveDispatch).toBe(true);
  });

  it("does not classify high overlap when fewer than ten recipients intersect", () => {
    const candidate = Array.from({ length: 9 }, (_, index) => `id-${index}`);
    const overlap = calculateBulkCampaignAudienceOverlap({
      candidateRecipientHashes: candidate,
      previousRecipientHashes: candidate,
    });

    expect(overlap.ratio).toBe(1);
    expect(overlap.kind).toBe("none");
  });

  it("requires a matching confirmation only for a high recent terminal overlap", () => {
    const now = new Date("2026-07-23T10:00:00.000Z");
    const overlap = {
      kind: "high" as const,
      blocksActiveDispatch: true,
      intersectionCount: 10,
      candidateCount: 10,
      previousCount: 10,
      ratio: 1,
    };
    const params = {
      candidateFingerprint: "candidate-fingerprint",
      overlap,
      previousFinishedAt: new Date(
        now.getTime() - BULK_CAMPAIGN_RECENT_OVERLAP_WINDOW_MS + 1
      ).toISOString(),
      now,
    };

    expect(requiresBulkCampaignAudienceConfirmation(params)).toBe(true);
    expect(
      hasConfirmedBulkCampaignAudienceResend({
        ...params,
        confirmationFingerprint: "candidate-fingerprint",
      })
    ).toBe(true);
    expect(
      hasConfirmedBulkCampaignAudienceResend({
        ...params,
        confirmationFingerprint: "a-different-fingerprint",
      })
    ).toBe(false);
    expect(
      requiresBulkCampaignAudienceConfirmation({
        ...params,
        previousFinishedAt: new Date(
          now.getTime() - BULK_CAMPAIGN_RECENT_OVERLAP_WINDOW_MS - 1
        ).toISOString(),
      })
    ).toBe(false);
  });

  it("expires immediate and scheduled dispatches fifteen minutes after their allowed start", () => {
    const requestedAt = "2026-07-23T10:00:00.000Z";
    const scheduledAt = "2026-07-23T12:00:00.000Z";

    expect(getBulkCampaignDispatchExpiresAt({ requestedAt })).toBe(
      "2026-07-23T10:15:00.000Z"
    );
    expect(getBulkCampaignDispatchExpiresAt({ requestedAt, scheduledAt })).toBe(
      "2026-07-23T12:15:00.000Z"
    );
    expect(BULK_CAMPAIGN_EXPIRY_GRACE_MS).toBe(15 * 60 * 1000);
    expect(
      isBulkCampaignDispatchExpired({
        dispatchExpiresAt: "2026-07-23T10:15:00.000Z",
        now: new Date("2026-07-23T10:15:00.000Z"),
      })
    ).toBe(true);
  });

  it("opens the provider circuit only for a completed all-failed batch with one repeated provider signature", () => {
    expect(
      classifyBulkCampaignProviderCircuit({
        batchStatus: "completed",
        results: [
          {
            success: false,
            failureScope: "provider",
            provider: "meta",
            code: "131000",
          },
          {
            success: false,
            failureScope: "provider",
            provider: "meta",
            code: "131000",
          },
        ],
      })
    ).toEqual({
      state: "open",
      provider: "meta",
      code: "131000",
      failureCount: 2,
    });

    expect(
      classifyBulkCampaignProviderCircuit({
        batchStatus: "completed",
        results: [
          {
            success: false,
            failureScope: "recipient",
            provider: "meta",
            code: "131000",
          },
          {
            success: false,
            failureScope: "recipient",
            provider: "meta",
            code: "131000",
          },
        ],
      }).state
    ).toBe("closed");

    expect(
      classifyBulkCampaignProviderCircuit({
        batchStatus: "completed",
        results: [
          {
            success: false,
            attempted: false,
            failureScope: "provider",
            provider: "meta",
            code: "131000",
          },
          {
            success: false,
            attempted: false,
            failureScope: "provider",
            provider: "meta",
            code: "131000",
          },
        ],
      }).state
    ).toBe("closed");
  });

  it("keeps the provider circuit closed for a batch that only hit Meta throughput", () => {
    const throttled = {
      success: false,
      failureScope: "provider" as const,
      provider: "meta",
      code: "130429",
    };
    expect(
      classifyBulkCampaignProviderCircuit({
        batchStatus: "completed",
        results: [throttled, throttled, throttled],
      })
    ).toEqual({ state: "closed" });
    expect(
      classifyBulkCampaignProviderCircuit({
        batchStatus: "completed",
        results: [
          { ...throttled, code: "131048" },
          { ...throttled, code: "131048" },
        ],
      }).state
    ).toBe("open");
  });
});
