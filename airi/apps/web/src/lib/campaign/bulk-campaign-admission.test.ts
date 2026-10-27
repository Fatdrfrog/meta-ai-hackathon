/**
 * @jest-environment node
 */

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn(() => {
    throw new Error("Unexpected database access in admission unit test");
  }),
}));

import {
  BulkCampaignAdmissionError,
  BulkCampaignAdmissionPayloadMismatchError,
  BulkCampaignAdmissionUnavailableError,
  admitBulkCampaign,
  lookupAdmittedBulkCampaignReplay,
  sanitizeBulkCampaignDispatchSnapshot,
} from "./bulk-campaign-admission";
import type { BulkCampaignAdmissionClient } from "./bulk-campaign-admission";
import { createBulkCampaignAudienceFingerprint } from "./bulk-campaign-safety";

describe("bulk campaign admission RPC adapter", () => {
  const fingerprintSecret = "server-only-fingerprint-secret";
  const persistedBatchPlan = {
    batchSize: 20,
    delayMs: 250,
    ratePerSecond: 80,
    rateSource: "meta_default_throughput",
    throughputLevel: "STANDARD",
  };
  const persistedRequestDigest = {
    version: 1 as const,
    digest: "a".repeat(64),
  };
  const audienceIdentity = createBulkCampaignAudienceFingerprint({
    secret: fingerprintSecret,
    workspaceId: "22222222-2222-4222-8222-222222222222",
    channel: "whatsapp",
    recipients: [{ phone: "77010000001" }],
  });
  const input = {
    fingerprintSecret,
    campaignId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    channel: "whatsapp" as const,
    name: "July follow-up",
    templateName: "july_follow_up",
    templateLanguage: "en",
    messageText: null,
    sentBy: "33333333-3333-4333-8333-333333333333",
    scenarioId: "scenario-1",
    scenarioNodeId: "node-1",
    executionSource: "scenario_run_now" as const,
    workflowId: "bulk-campaign:11111111",
    dispatchStatus: "queued" as const,
    requestedAt: "2026-07-23T09:00:00.000Z",
    scheduledAt: null,
    dispatchExpiresAt: "2026-07-23T09:15:00.000Z",
    audience: {
      fingerprint: audienceIdentity.fingerprint,
      hashVersion: "v1",
      sourceType: "uploaded_file",
      count: 1,
      metadata: {
        originalFilename: "audience.csv",
        uploadedAt: "2026-07-23T08:59:00.000Z",
        uploadedBy: "33333333-3333-4333-8333-333333333333",
        contentHash: "b".repeat(64),
        replacementHistory: [],
      },
    },
    confirmationFingerprint: null,
    retryOfCampaignId: null,
    retryKind: null,
    companyBulkCampaignLimit: 2,
    companySubscriptionType: "free" as const,
    providerCircuitAcknowledgedBy: null,
    snapshots: [
      {
        recipientHash: audienceIdentity.recipientHashes[0]!,
        snapshotOrdinal: 0,
        recipient: "77010000001",
        dispatchSnapshot: {
          channel: "whatsapp",
          snapshotOrdinal: 0,
          recipient: { phone: "77010000001" },
          templateName: "july_follow_up",
          accessToken: "must-not-be-persisted",
        },
      },
    ],
  };

  it("calls the atomic RPC with sanitized snapshots and returns no recipient hashes", async () => {
    const rpc = jest.fn<
      ReturnType<BulkCampaignAdmissionClient["rpc"]>,
      Parameters<BulkCampaignAdmissionClient["rpc"]>
    >(async () => ({
      data: {
        status: "admitted",
        campaign_id: input.campaignId,
        dispatch_status: "queued",
        audience_fingerprint: input.audience.fingerprint,
        overlap: {
          kind: "none",
          intersection_count: 0,
          candidate_count: 1,
          ratio: 0,
        },
        recipient_hashes: ["must-never-cross-the-adapter"],
      },
      error: null,
    }));

    const result = await admitBulkCampaign({ rpc }, input);

    expect(rpc).toHaveBeenCalledWith(
      "admit_bulk_campaign",
      expect.objectContaining({
        p_campaign_id: input.campaignId,
        p_workspace_id: input.workspaceId,
        p_audience_fingerprint: input.audience.fingerprint,
        p_audience_count: 1,
        p_company_bulk_campaign_limit: 2,
        p_expected_subscription_type: "free",
        p_provider_circuit_acknowledged_by: null,
        p_messages: [
          expect.objectContaining({
            recipient_hash: audienceIdentity.recipientHashes[0],
            snapshot_ordinal: 0,
            recipient: "77010000001",
            dispatch_snapshot: {
              channel: "whatsapp",
              snapshotOrdinal: 0,
              recipient: { phone: "77010000001" },
              templateName: "july_follow_up",
            },
          }),
        ],
      })
    );
    expect(result).toEqual({
      status: "admitted",
      campaignId: input.campaignId,
      dispatchStatus: "queued",
      audienceFingerprint: input.audience.fingerprint,
      overlap: {
        kind: "none",
        intersectionCount: 0,
        candidateCount: 1,
        ratio: 0,
      },
      idempotentReplay: false,
      workflowId: input.workflowId,
      requestedAt: input.requestedAt,
      dispatchExpiresAt: input.dispatchExpiresAt,
      audienceCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain(
      audienceIdentity.recipientHashes[0]!
    );
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_fingerprint_secret");
  });

  it("admits repeated recipient hashes as distinct contiguous dispatch items", async () => {
    const rpc = jest.fn<
      ReturnType<BulkCampaignAdmissionClient["rpc"]>,
      Parameters<BulkCampaignAdmissionClient["rpc"]>
    >(async () => ({
      data: {
        status: "admitted",
        campaign_id: input.campaignId,
        dispatch_status: "queued",
        audience_fingerprint: input.audience.fingerprint,
        audience_count: 2,
        item_count: 2,
        unique_recipient_count: 1,
        overlap: {
          kind: "none",
          intersection_count: 0,
          candidate_count: 1,
          ratio: 0,
        },
      },
      error: null,
    }));
    const repeatedInput = {
      ...input,
      audience: {
        ...input.audience,
        count: 2,
        metadata: {
          ...input.audience.metadata,
          policy: {
            version: 1 as const,
            excludePriorFailedBulkSends: false,
          },
          authoritativeRecipientLimit: {
            source: "live_meta" as const,
            value: 1,
            rawLimit: "TIER_1",
          },
          batchPlan: persistedBatchPlan,
          requestDigest: persistedRequestDigest,
          outcome: {
            evaluatedAt: "2026-07-23T08:59:30.000Z",
            requestedTotal: 2,
            acceptedTotal: 2,
            uniqueRecipients: { requested: 1, accepted: 1 },
            skippedByReason: {},
            warnings: { missingMarketingConsent: 0 },
          },
        },
      },
      snapshots: [
        input.snapshots[0],
        {
          ...input.snapshots[0],
          snapshotOrdinal: 1,
          dispatchSnapshot: {
            ...input.snapshots[0].dispatchSnapshot,
            snapshotOrdinal: 1,
            generatedRecipientMessageId: "message-2",
          },
        },
      ],
    };

    await expect(admitBulkCampaign({ rpc }, repeatedInput)).resolves.toEqual(
      expect.objectContaining({
        status: "admitted",
        audienceCount: 2,
        overlap: {
          kind: "none",
          intersectionCount: 0,
          candidateCount: 1,
          ratio: 0,
        },
      })
    );
    expect(rpc.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        p_audience_count: 2,
        p_audience_metadata: expect.objectContaining({
          authoritativeRecipientLimit: {
            source: "live_meta",
            value: 1,
            rawLimit: "TIER_1",
          },
          requestDigest: persistedRequestDigest,
          outcome: expect.objectContaining({
            acceptedTotal: 2,
            uniqueRecipients: { requested: 1, accepted: 1 },
          }),
        }),
        p_messages: [
          expect.objectContaining({
            recipient_hash: audienceIdentity.recipientHashes[0],
            snapshot_ordinal: 0,
          }),
          expect.objectContaining({
            recipient_hash: audienceIdentity.recipientHashes[0],
            snapshot_ordinal: 1,
          }),
        ],
      })
    );
  });

  it("maps a bounded lock conflict to a retryable aggregate-only outcome", async () => {
    const rpc = jest.fn(async () => ({
      data: {
        status: "conflict",
        code: "admission_lock_busy",
        retryable: true,
        audience_fingerprint: input.audience.fingerprint,
      },
      error: null,
    }));

    await expect(admitBulkCampaign({ rpc }, input)).resolves.toEqual({
      status: "conflict",
      code: "admission_lock_busy",
      retryable: true,
      audienceFingerprint: input.audience.fingerprint,
    });
  });

  it("maps a plan change detected under the company lock", async () => {
    const rpc = jest.fn(async () => ({
      data: {
        status: "conflict",
        code: "company_plan_changed",
        retryable: true,
        audience_fingerprint: input.audience.fingerprint,
        expected_subscription_type: "pro",
        current_subscription_type: "free",
      },
      error: null,
    }));

    await expect(
      admitBulkCampaign({ rpc }, { ...input, companySubscriptionType: "pro" })
    ).resolves.toEqual({
      status: "conflict",
      code: "company_plan_changed",
      retryable: true,
      audienceFingerprint: input.audience.fingerprint,
      expectedSubscriptionType: "pro",
      currentSubscriptionType: "free",
    });
  });

  it("maps a locked provider-circuit acknowledgement decision without recipient data", async () => {
    const rpc = jest.fn(async () => ({
      data: {
        status: "blocked",
        code: "provider_circuit_acknowledgement_required",
        retryable: false,
        audience_fingerprint: input.audience.fingerprint,
        provider_circuit: {
          state: "open",
          provider: "meta",
          code: "131042",
          failure_count: 2,
        },
      },
      error: null,
    }));

    await expect(admitBulkCampaign({ rpc }, input)).resolves.toEqual({
      status: "blocked",
      code: "provider_circuit_acknowledgement_required",
      retryable: false,
      audienceFingerprint: input.audience.fingerprint,
      providerCircuit: {
        state: "open",
        provider: "meta",
        code: "131042",
        failureCount: 2,
      },
    });
  });

  it.each([0, 1])("accepts a stored-open provider-circuit failure count of %s", async failureCount => {
    const rpc = jest.fn(async () => ({
      data: {
        status: "blocked",
        code: "provider_circuit_acknowledgement_required",
        retryable: false,
        audience_fingerprint: input.audience.fingerprint,
        provider_circuit: {
          state: "open",
          provider: "meta",
          code: "131042",
          failure_count: failureCount,
        },
      },
      error: null,
    }));

    await expect(admitBulkCampaign({ rpc }, input)).resolves.toEqual(
      expect.objectContaining({
        status: "blocked",
        providerCircuit: expect.objectContaining({ failureCount }),
      })
    );
  });

  it.each([
    ["negative count", { failure_count: -1 }],
    ["fractional count", { failure_count: 0.5 }],
    ["numeric string count", { failure_count: "0" }],
    ["missing count", { failure_count: undefined }],
    ["closed state", { state: "closed" }],
    ["missing state", { state: undefined }],
    ["blank provider", { provider: " " }],
    ["blank code", { code: " " }],
  ])("rejects a stored provider circuit with %s", async (_label, fields) => {
    const rpc = jest.fn(async () => ({
      data: {
        status: "blocked",
        code: "provider_circuit_acknowledgement_required",
        retryable: false,
        audience_fingerprint: input.audience.fingerprint,
        provider_circuit: {
          state: "open",
          provider: "meta",
          code: "131042",
          failure_count: 0,
          ...fields,
        },
      },
      error: null,
    }));

    await expect(admitBulkCampaign({ rpc }, input)).rejects.toThrow(
      BulkCampaignAdmissionUnavailableError
    );
  });

  it("returns a persisted failed-only child as an explicit idempotent admission", async () => {
    const existingCampaignId = "44444444-4444-4444-8444-444444444444";
    const existingWorkflowId = "bulk-campaign:existing-child";
    const rpc = jest.fn(async () => ({
      data: {
        status: "admitted",
        idempotent_replay: true,
        campaign_id: existingCampaignId,
        workflow_id: existingWorkflowId,
        dispatch_status: "running",
        requested_at: "2026-07-23T09:01:00.000Z",
        dispatch_expires_at: "2026-07-23T09:16:00.000Z",
        audience_count: 1,
        audience_fingerprint: input.audience.fingerprint,
        overlap: {
          kind: "none",
          intersection_count: 0,
          candidate_count: 1,
          ratio: 0,
        },
      },
      error: null,
    }));

    await expect(
      admitBulkCampaign(
        { rpc },
        {
          ...input,
          campaignId: "55555555-5555-4555-8555-555555555555",
          retryOfCampaignId: "66666666-6666-4666-8666-666666666666",
          retryKind: "failed_only",
          confirmationFingerprint: input.audience.fingerprint,
          providerCircuitAcknowledgedBy: "33333333-3333-4333-8333-333333333333",
        }
      )
    ).resolves.toEqual({
      status: "admitted",
      idempotentReplay: true,
      campaignId: existingCampaignId,
      workflowId: existingWorkflowId,
      dispatchStatus: "running",
      requestedAt: "2026-07-23T09:01:00.000Z",
      dispatchExpiresAt: "2026-07-23T09:16:00.000Z",
      audienceCount: 1,
      audienceFingerprint: input.audience.fingerprint,
      overlap: {
        kind: "none",
        intersectionCount: 0,
        candidateCount: 1,
        ratio: 0,
      },
    });
    expect(rpc).toHaveBeenCalledWith(
      "admit_bulk_campaign",
      expect.objectContaining({
        p_retry_of_campaign_id: "66666666-6666-4666-8666-666666666666",
        p_retry_kind: "failed_only",
        p_provider_circuit_acknowledged_by:
          "33333333-3333-4333-8333-333333333333",
      })
    );
  });

  it("accepts a terminal idempotent replay but rejects a forged acknowledgement actor", async () => {
    const terminalRpc = jest.fn(async () => ({
      data: {
        status: "admitted",
        idempotent_replay: true,
        campaign_id: "44444444-4444-4444-8444-444444444444",
        workflow_id: "bulk-campaign:terminal",
        dispatch_status: "failed",
        requested_at: "2026-07-23T09:01:00.000Z",
        dispatch_expires_at: "2026-07-23T09:16:00.000Z",
        audience_count: 1,
        audience_fingerprint: input.audience.fingerprint,
        overlap: {
          kind: "none",
          intersection_count: 0,
          candidate_count: 1,
          ratio: 0,
        },
      },
      error: null,
    }));
    await expect(
      admitBulkCampaign(
        { rpc: terminalRpc },
        {
          ...input,
          retryOfCampaignId: "66666666-6666-4666-8666-666666666666",
          retryKind: "failed_only",
        }
      )
    ).resolves.toEqual(
      expect.objectContaining({
        status: "admitted",
        idempotentReplay: true,
        dispatchStatus: "failed",
      })
    );

    const forgedRpc = jest.fn();
    await expect(
      admitBulkCampaign(
        { rpc: forgedRpc },
        {
          ...input,
          retryOfCampaignId: "66666666-6666-4666-8666-666666666666",
          retryKind: "failed_only",
          providerCircuitAcknowledgedBy: "77777777-7777-4777-8777-777777777777",
        }
      )
    ).rejects.toThrow("acknowledgement");
    expect(forgedRpc).not.toHaveBeenCalled();
  });

  it("fails closed when the required RPC or safety schema is unavailable", async () => {
    const rpc = jest.fn(async () => ({
      data: null,
      error: {
        code: "PGRST202",
        message:
          "Could not find the function public.admit_bulk_campaign in the schema cache",
      },
    }));

    await expect(admitBulkCampaign({ rpc }, input)).rejects.toBeInstanceOf(
      BulkCampaignAdmissionUnavailableError
    );
  });

  it("maps the SQL request-digest identity guard to a payload mismatch", async () => {
    const rpc = jest.fn(async () => ({
      data: null,
      error: {
        code: "22000",
        message:
          "campaign request digest identity does not match the admitted dispatch",
      },
    }));

    await expect(admitBulkCampaign({ rpc }, input)).rejects.toBeInstanceOf(
      BulkCampaignAdmissionPayloadMismatchError
    );
  });

  it("returns the authoritative company quota decision", async () => {
    const rpc = jest.fn(async () => ({
      data: {
        status: "blocked",
        code: "company_bulk_campaign_limit_exceeded",
        retryable: false,
        audience_fingerprint: input.audience.fingerprint,
        company_bulk_campaign_limit: 2,
        company_bulk_campaign_count: 2,
      },
      error: null,
    }));

    await expect(admitBulkCampaign({ rpc }, input)).resolves.toEqual({
      status: "blocked",
      code: "company_bulk_campaign_limit_exceeded",
      retryable: false,
      audienceFingerprint: input.audience.fingerprint,
      companyBulkCampaignLimit: 2,
      companyBulkCampaignCount: 2,
    });
  });

  it("returns a recipient allowance refusal that leaves recipients unused", async () => {
    const refusal = (used: number) =>
      jest.fn(async () => ({
        data: {
          status: "blocked",
          code: "company_bulk_campaign_limit_exceeded",
          retryable: false,
          audience_fingerprint: input.audience.fingerprint,
          company_bulk_campaign_limit: 500,
          company_bulk_campaign_count: used,
          company_bulk_recipient_count: 2,
        },
        error: null,
      }));
    const allowanceInput = { ...input, companyBulkCampaignLimit: 500 };

    // 499 used and 2 asked for: one recipient is still left, but not two.
    await expect(
      admitBulkCampaign({ rpc: refusal(499) }, allowanceInput)
    ).resolves.toEqual({
      status: "blocked",
      code: "company_bulk_campaign_limit_exceeded",
      retryable: false,
      audienceFingerprint: input.audience.fingerprint,
      companyBulkCampaignLimit: 500,
      companyBulkCampaignCount: 499,
    });
    // A refusal for a send that would have fit is not trusted.
    await expect(
      admitBulkCampaign({ rpc: refusal(498) }, allowanceInput)
    ).rejects.toBeInstanceOf(BulkCampaignAdmissionUnavailableError);
  });

  it("rejects malformed recipient hashes and fingerprint mismatches before RPC", async () => {
    const rpc = jest.fn();

    await expect(
      admitBulkCampaign(
        { rpc },
        {
          ...input,
          snapshots: [
            {
              ...input.snapshots[0],
              recipientHash: "not-a-hmac",
            },
          ],
        }
      )
    ).rejects.toBeInstanceOf(BulkCampaignAdmissionError);
    await expect(
      admitBulkCampaign(
        { rpc },
        {
          ...input,
          audience: {
            ...input.audience,
            fingerprint: "f".repeat(64),
          },
        }
      )
    ).rejects.toThrow("fingerprint");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("persists only allowlisted upload metadata and sanitized replacement events", async () => {
    const rpc = jest.fn<
      ReturnType<BulkCampaignAdmissionClient["rpc"]>,
      Parameters<BulkCampaignAdmissionClient["rpc"]>
    >(async () => ({
      data: {
        status: "admitted",
        campaign_id: input.campaignId,
        dispatch_status: input.dispatchStatus,
        audience_fingerprint: input.audience.fingerprint,
        overlap: {
          kind: "none",
          intersection_count: 0,
          candidate_count: 1,
          ratio: 0,
        },
      },
      error: null,
    }));
    const replacement = {
      action: "replaced",
      replacedAt: "2026-07-22T12:00:00.000Z",
      replacedBy: "33333333-3333-4333-8333-333333333333",
      previousFilename: "old.csv",
      nextFilename: "audience.csv",
      previousContentHash: "c".repeat(64),
      nextContentHash: "b".repeat(64),
      clientSecret: "must-not-be-persisted",
    };

    await admitBulkCampaign(
      { rpc },
      {
        ...input,
        audience: {
          ...input.audience,
          metadata: {
            ...input.audience.metadata,
            replacementHistory: [replacement],
            refreshToken: "must-not-be-persisted",
          } as never,
        },
      }
    );

    expect(rpc.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        p_audience_metadata: {
          originalFilename: "audience.csv",
          uploadedAt: "2026-07-23T08:59:00.000Z",
          uploadedBy: "33333333-3333-4333-8333-333333333333",
          contentHash: "b".repeat(64),
          replacementHistory: [
            {
              action: "replaced",
              replacedAt: "2026-07-22T12:00:00.000Z",
              replacedBy: "33333333-3333-4333-8333-333333333333",
              previousFilename: "old.csv",
              nextFilename: "audience.csv",
              previousContentHash: "c".repeat(64),
              nextContentHash: "b".repeat(64),
            },
          ],
        },
        p_audience_replacement_history: [
          expect.not.objectContaining({
            clientSecret: expect.anything(),
          }),
        ],
      })
    );
    expect(JSON.stringify(rpc.mock.calls[0]?.[1])).not.toContain(
      "must-not-be-persisted"
    );
  });

  it("sanitizes campaign policy, exact plan, limit, and outcome aggregates into audience metadata", async () => {
    const rpc = jest.fn<
      ReturnType<BulkCampaignAdmissionClient["rpc"]>,
      Parameters<BulkCampaignAdmissionClient["rpc"]>
    >(async () => ({
      data: {
        status: "admitted",
        campaign_id: input.campaignId,
        dispatch_status: input.dispatchStatus,
        audience_fingerprint: input.audience.fingerprint,
        overlap: {
          kind: "none",
          intersection_count: 0,
          candidate_count: 1,
          ratio: 0,
        },
      },
      error: null,
    }));

    await admitBulkCampaign(
      { rpc },
      {
        ...input,
        audience: {
          ...input.audience,
          metadata: {
            ...input.audience.metadata,
            policy: {
              version: 1,
              excludePriorFailedBulkSends: true,
              secret: "drop-me",
            },
            authoritativeRecipientLimit: {
              source: "live_meta",
              value: 2,
              rawLimit: "TIER_2",
              phone: "+15550000001",
            },
            batchPlan: {
              ...persistedBatchPlan,
              recipient: "+15550000001",
            },
            outcome: {
              evaluatedAt: "2026-07-23T08:59:30.000Z",
              requestedTotal: 3,
              acceptedTotal: 1,
              uniqueRecipients: { requested: 3, accepted: 1 },
              skippedByReason: { recipient_limit: 1, prior_failure: 1 },
              warnings: { missingMarketingConsent: 0 },
              recipients: ["+15550000001"],
            },
            requestDigest: {
              ...persistedRequestDigest,
              recipient: "+15550000001",
            },
          } as never,
        },
      }
    );

    expect(rpc.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        p_audience_metadata: expect.objectContaining({
          policy: { version: 1, excludePriorFailedBulkSends: true },
          authoritativeRecipientLimit: {
            source: "live_meta",
            value: 2,
            rawLimit: "TIER_2",
          },
          batchPlan: persistedBatchPlan,
          outcome: {
            evaluatedAt: "2026-07-23T08:59:30.000Z",
            requestedTotal: 3,
            acceptedTotal: 1,
            uniqueRecipients: { requested: 3, accepted: 1 },
            skippedByReason: { recipient_limit: 1, prior_failure: 1 },
            warnings: { missingMarketingConsent: 0 },
          },
          requestDigest: persistedRequestDigest,
        }),
      })
    );
    expect(JSON.stringify(rpc.mock.calls[0]?.[1])).not.toContain("drop-me");
    expect(JSON.stringify(rpc.mock.calls[0]?.[1])).not.toContain(
      "+15550000001"
    );
  });

  it.each([
    [
      "policy only",
      { policy: { version: 1, excludePriorFailedBulkSends: false } },
    ],
    [
      "limit only",
      {
        authoritativeRecipientLimit: {
          source: "live_meta",
          value: 1,
          rawLimit: "TIER_1",
        },
      },
    ],
    [
      "outcome only",
      {
        outcome: {
          evaluatedAt: "2026-07-23T08:59:30.000Z",
          requestedTotal: 1,
          acceptedTotal: 1,
          uniqueRecipients: { requested: 1, accepted: 1 },
          skippedByReason: {},
          warnings: { missingMarketingConsent: 0 },
        },
      },
    ],
    [
      "batch plan only",
      {
        batchPlan: persistedBatchPlan,
      },
    ],
    ["request digest only", { requestDigest: persistedRequestDigest }],
  ])(
    "rejects partial campaign policy metadata: %s",
    async (_label, partial) => {
      const rpc = jest.fn();

      await expect(
        admitBulkCampaign(
          { rpc },
          {
            ...input,
            audience: {
              ...input.audience,
              metadata: { ...input.audience.metadata, ...partial } as never,
            },
          }
        )
      ).rejects.toThrow("all-or-none");
      expect(rpc).not.toHaveBeenCalled();
    }
  );

  it("keeps recently contacted skips in the admitted outcome", async () => {
    const rpc = jest.fn<
      ReturnType<BulkCampaignAdmissionClient["rpc"]>,
      Parameters<BulkCampaignAdmissionClient["rpc"]>
    >(async () => ({
      data: {
        status: "admitted",
        campaign_id: input.campaignId,
        dispatch_status: input.dispatchStatus,
        audience_fingerprint: input.audience.fingerprint,
        overlap: {
          kind: "none",
          intersection_count: 0,
          candidate_count: 1,
          ratio: 0,
        },
      },
      error: null,
    }));
    const outcome = {
      evaluatedAt: "2026-07-23T08:59:30.000Z",
      requestedTotal: 3,
      acceptedTotal: 1,
      uniqueRecipients: { requested: 3, accepted: 1 },
      skippedByReason: { recent_contact: 2 },
      warnings: { missingMarketingConsent: 0 },
    };

    await admitBulkCampaign(
      { rpc },
      {
        ...input,
        audience: {
          ...input.audience,
          metadata: {
            ...input.audience.metadata,
            policy: { version: 1, excludePriorFailedBulkSends: false },
            authoritativeRecipientLimit: {
              source: "live_meta",
              value: 2,
              rawLimit: "TIER_2",
            },
            batchPlan: persistedBatchPlan,
            requestDigest: persistedRequestDigest,
            outcome,
          } as never,
        },
      }
    );

    expect(rpc.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        p_audience_metadata: expect.objectContaining({ outcome }),
      })
    );
  });

  it("rejects a policy outcome without a durable evaluatedAt timestamp", async () => {
    const rpc = jest.fn();

    await expect(
      admitBulkCampaign(
        { rpc },
        {
          ...input,
          audience: {
            ...input.audience,
            metadata: {
              ...input.audience.metadata,
              policy: { version: 1, excludePriorFailedBulkSends: false },
              authoritativeRecipientLimit: {
                source: "live_meta",
                value: 1,
                rawLimit: "TIER_1",
              },
              batchPlan: persistedBatchPlan,
              requestDigest: persistedRequestDigest,
              outcome: {
                requestedTotal: 1,
                acceptedTotal: 1,
                uniqueRecipients: { requested: 1, accepted: 1 },
                skippedByReason: {},
                warnings: { missingMarketingConsent: 0 },
              },
            } as never,
          },
        }
      )
    ).rejects.toThrow("evaluatedAt");
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    [
      "stale accepted item count",
      {
        requestedTotal: 1,
        acceptedTotal: 0,
        uniqueRecipients: { requested: 1, accepted: 0 },
        skippedByReason: { ineligible: 1 },
      },
    ],
    [
      "stale accepted unique count",
      {
        requestedTotal: 1,
        acceptedTotal: 1,
        uniqueRecipients: { requested: 1, accepted: 0 },
        skippedByReason: {},
      },
    ],
  ])("rejects policy metadata with %s", async (_label, outcome) => {
    const rpc = jest.fn();

    await expect(
      admitBulkCampaign(
        { rpc },
        {
          ...input,
          audience: {
            ...input.audience,
            metadata: {
              ...input.audience.metadata,
              policy: { version: 1, excludePriorFailedBulkSends: false },
              authoritativeRecipientLimit: {
                source: "live_meta",
                value: 1,
                rawLimit: "TIER_1",
              },
              batchPlan: persistedBatchPlan,
              requestDigest: persistedRequestDigest,
              outcome: {
                evaluatedAt: "2026-07-23T08:59:30.000Z",
                ...outcome,
                warnings: { missingMarketingConsent: 0 },
              },
            },
          },
        }
      )
    ).rejects.toBeInstanceOf(BulkCampaignAdmissionError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects admitted policy counts above the authoritative limit", async () => {
    const twoRecipientAudience = createBulkCampaignAudienceFingerprint({
      secret: fingerprintSecret,
      workspaceId: input.workspaceId,
      channel: "whatsapp",
      recipients: [{ phone: "77010000001" }, { phone: "77010000002" }],
    });
    const rpc = jest.fn();

    await expect(
      admitBulkCampaign(
        { rpc },
        {
          ...input,
          audience: {
            ...input.audience,
            fingerprint: twoRecipientAudience.fingerprint,
            count: 2,
            metadata: {
              ...input.audience.metadata,
              policy: { version: 1, excludePriorFailedBulkSends: false },
              authoritativeRecipientLimit: {
                source: "live_meta",
                value: 1,
                rawLimit: "TIER_1",
              },
              batchPlan: persistedBatchPlan,
              requestDigest: persistedRequestDigest,
              outcome: {
                evaluatedAt: "2026-07-23T08:59:30.000Z",
                requestedTotal: 2,
                acceptedTotal: 2,
                uniqueRecipients: { requested: 2, accepted: 2 },
                skippedByReason: {},
                warnings: { missingMarketingConsent: 0 },
              },
            },
          },
          snapshots: [
            input.snapshots[0],
            {
              recipientHash: twoRecipientAudience.recipientHashes[1]!,
              snapshotOrdinal: 1,
              recipient: "77010000002",
              dispatchSnapshot: {
                ...input.snapshots[0].dispatchSnapshot,
                snapshotOrdinal: 1,
                recipient: { phone: "77010000002" },
              },
            },
          ],
        }
      )
    ).rejects.toThrow("authoritative recipient limit");
    expect(rpc).not.toHaveBeenCalled();
  });

  describe("authenticated admitted-command replay", () => {
    const replayCampaignId = "44444444-4444-4444-8444-444444444444";
    const replayWorkspaceId = "55555555-5555-4555-8555-555555555555";
    const replayUserId = "66666666-6666-4666-8666-666666666666";
    const persistedWorkflowId =
      "bulk-campaign-dispatch:55555555-5555-4555-8555-555555555555:44444444-4444-4444-8444-444444444444";
    const persistedMetadata = {
      policy: { version: 1, excludePriorFailedBulkSends: true },
      authoritativeRecipientLimit: {
        source: "live_meta",
        value: 2,
        rawLimit: "TIER_2",
      },
      batchPlan: {
        batchSize: 5,
        delayMs: 1_000,
        ratePerSecond: 5,
        rateSource: "live_meta_throughput",
      },
      outcome: {
        evaluatedAt: "2026-08-21T09:00:00.000Z",
        requestedTotal: 4,
        acceptedTotal: 2,
        uniqueRecipients: { requested: 4, accepted: 2 },
        skippedByReason: { prior_failure: 1, recipient_limit: 1 },
        warnings: { missingMarketingConsent: 1 },
      },
      requestDigest: persistedRequestDigest,
    };

    function createReplayStore(result: {
      data: Record<string, unknown> | null;
      error: { message: string; code?: string } | null;
    }) {
      const query: { eq: jest.Mock; maybeSingle: jest.Mock } = {
        eq: jest.fn(() => query),
        maybeSingle: jest.fn(async () => result),
      };
      const select = jest.fn(() => query);
      return {
        client: {
          from: jest.fn(() => ({ select })),
        },
        query,
        select,
      };
    }

    function validReplayRow(overrides?: Record<string, unknown>) {
      return {
        id: replayCampaignId,
        workspace_id: replayWorkspaceId,
        sent_by: replayUserId,
        channel: "whatsapp",
        template_name: "promo",
        template_language: "en",
        message_text: null,
        scenario_id: null,
        scenario_node_id: null,
        execution_source: "ad_hoc",
        workflow_id: persistedWorkflowId,
        dispatch_status: "queued",
        requested_at: "2026-08-21T09:00:00.000Z",
        scheduled_at: null,
        dispatch_expires_at: "2026-08-21T09:15:00.000Z",
        total_recipients: 2,
        audience_metadata: persistedMetadata,
        ...overrides,
      };
    }

    it("projects exact persisted policy, plan, evaluated-at, identifiers, and counts", async () => {
      const store = createReplayStore({
        data: validReplayRow(),
        error: null,
      });

      await expect(
        lookupAdmittedBulkCampaignReplay({
          client: store.client,
          campaignId: replayCampaignId,
          workspaceId: replayWorkspaceId,
          sentBy: replayUserId,
          requestDigest: persistedRequestDigest,
        })
      ).resolves.toEqual({
        campaignId: replayCampaignId,
        workspaceId: replayWorkspaceId,
        result: expect.objectContaining({
          ok: true,
          outcome: {
            disposition: "queued",
            evaluatedAt: "2026-08-21T09:00:00.000Z",
            lifecycleStatus: "queued",
            requestedTotal: 4,
            acceptedTotal: 2,
            queuedTotal: 2,
            uniqueRecipients: { requested: 4, accepted: 2, queued: 2 },
            skippedByReason: { prior_failure: 1, recipient_limit: 1 },
            warnings: { missingMarketingConsent: 1 },
            campaignId: replayCampaignId,
            dispatchId: replayCampaignId,
            workflowId: persistedWorkflowId,
          },
          batchPlan: persistedMetadata.batchPlan,
          recipientLimit: {
            originalCount: 4,
            acceptedCount: 2,
            rawLimit: "TIER_2",
            source: "live_meta",
            truncated: true,
          },
        }),
        batchPlan: persistedMetadata.batchPlan,
        dispatchStatus: "queued",
        requestedAt: "2026-08-21T09:00:00.000Z",
        scheduledAt: null,
        dispatchExpiresAt: "2026-08-21T09:15:00.000Z",
        totalRecipients: 2,
        channel: "whatsapp",
        messageKind: "template",
        executionSource: "ad_hoc",
        scenarioId: null,
        rootNodeId: null,
        planLimit: { source: "live_meta", value: 2 },
        policy: { version: 1, excludePriorFailedBulkSends: true },
      });
      expect(store.query.eq.mock.calls).toEqual([
        ["id", replayCampaignId],
        ["workspace_id", replayWorkspaceId],
        ["sent_by", replayUserId],
      ]);
    });

    it("returns null only when no admitted row exists", async () => {
      const store = createReplayStore({ data: null, error: null });

      await expect(
        lookupAdmittedBulkCampaignReplay({
          client: store.client,
          campaignId: replayCampaignId,
          workspaceId: replayWorkspaceId,
          sentBy: replayUserId,
          requestDigest: persistedRequestDigest,
        })
      ).resolves.toBeNull();
    });

    it("rejects an admitted replay whose persisted semantic request digest differs", async () => {
      const store = createReplayStore({
        data: validReplayRow({
          audience_metadata: {
            ...persistedMetadata,
            requestDigest: { version: 1, digest: "a".repeat(64) },
          },
        }),
        error: null,
      });

      await expect(
        lookupAdmittedBulkCampaignReplay({
          client: store.client,
          campaignId: replayCampaignId,
          workspaceId: replayWorkspaceId,
          sentBy: replayUserId,
          requestDigest: { version: 1, digest: "b".repeat(64) },
        })
      ).rejects.toThrow("request digest");
    });

    it("fails closed when an admitted row has zero canonical replay metadata keys", async () => {
      const store = createReplayStore({
        data: validReplayRow({ audience_metadata: {} }),
        error: null,
      });

      await expect(
        lookupAdmittedBulkCampaignReplay({
          client: store.client,
          campaignId: replayCampaignId,
          workspaceId: replayWorkspaceId,
          sentBy: replayUserId,
          requestDigest: persistedRequestDigest,
        })
      ).rejects.toBeInstanceOf(BulkCampaignAdmissionUnavailableError);
    });

    it.each([
      ["missing request digest", { requestDigest: undefined }],
      [
        "uppercase request digest",
        { requestDigest: { version: 1, digest: "A".repeat(64) } },
      ],
      [
        "blank raw limit",
        {
          authoritativeRecipientLimit: {
            ...persistedMetadata.authoritativeRecipientLimit,
            rawLimit: " ",
          },
        },
      ],
      [
        "oversized raw limit",
        {
          authoritativeRecipientLimit: {
            ...persistedMetadata.authoritativeRecipientLimit,
            rawLimit: "x".repeat(129),
          },
        },
      ],
    ])("fails closed for malformed persisted %s", async (_label, metadata) => {
      const store = createReplayStore({
        data: validReplayRow({
          audience_metadata: { ...persistedMetadata, ...metadata },
        }),
        error: null,
      });

      await expect(
        lookupAdmittedBulkCampaignReplay({
          client: store.client,
          campaignId: replayCampaignId,
          workspaceId: replayWorkspaceId,
          sentBy: replayUserId,
          requestDigest: persistedRequestDigest,
        })
      ).rejects.toBeInstanceOf(BulkCampaignAdmissionUnavailableError);
    });

    it("restores the exact persisted scheduledAt and rawLimit aliases", async () => {
      const scheduledAt = "2026-08-22T09:00:00.000Z";
      const store = createReplayStore({
        data: validReplayRow({
          dispatch_status: "scheduled",
          scheduled_at: scheduledAt,
        }),
        error: null,
      });

      await expect(
        lookupAdmittedBulkCampaignReplay({
          client: store.client,
          campaignId: replayCampaignId,
          workspaceId: replayWorkspaceId,
          sentBy: replayUserId,
          requestDigest: persistedRequestDigest,
        })
      ).resolves.toEqual(
        expect.objectContaining({
          result: expect.objectContaining({
            scheduledAt,
            recipientLimit: expect.objectContaining({ rawLimit: "TIER_2" }),
          }),
        })
      );
    });

    it("canonicalizes a Postgres offset scheduledAt for byte-exact replay", async () => {
      const persistedScheduledAt = "2026-08-22T09:00:00+00:00";
      const canonicalScheduledAt = "2026-08-22T09:00:00.000Z";
      const store = createReplayStore({
        data: validReplayRow({
          dispatch_status: "scheduled",
          scheduled_at: persistedScheduledAt,
        }),
        error: null,
      });

      await expect(
        lookupAdmittedBulkCampaignReplay({
          client: store.client,
          campaignId: replayCampaignId,
          workspaceId: replayWorkspaceId,
          sentBy: replayUserId,
          requestDigest: persistedRequestDigest,
        })
      ).resolves.toEqual(
        expect.objectContaining({
          scheduledAt: canonicalScheduledAt,
          result: expect.objectContaining({
            scheduledAt: canonicalScheduledAt,
          }),
        })
      );
    });

    it.each([
      ["WhatsApp unsplit template", {}, "template"],
      [
        "WhatsApp service text",
        { template_name: null, template_language: "en", message_text: "Hi" },
        "service_text",
      ],
      [
        "WhatsApp verified split template",
        {
          template_name: null,
          template_language: "multi",
          message_text: null,
        },
        "template",
      ],
      [
        "Telegram message",
        {
          channel: "telegram",
          template_name: null,
          template_language: "en",
          message_text: "Telegram text",
        },
        "telegram",
      ],
      [
        "email template",
        {
          channel: "email",
          template_name: "custom_email",
          template_language: "en",
          message_text: null,
        },
        "email",
      ],
    ])(
      "accepts canonical persisted %s intent",
      async (_label, overrides, messageKind) => {
        const store = createReplayStore({
          data: validReplayRow(overrides),
          error: null,
        });

        await expect(
          lookupAdmittedBulkCampaignReplay({
            client: store.client,
            campaignId: replayCampaignId,
            workspaceId: replayWorkspaceId,
            sentBy: replayUserId,
            requestDigest: persistedRequestDigest,
          })
        ).resolves.toEqual(expect.objectContaining({ messageKind }));
      }
    );

    it.each([
      [
        "service text that also names a template",
        {
          template_name: "promo",
          template_language: "en",
          message_text: "Hello",
        },
      ],
      [
        "template row with no template identity",
        {
          template_name: null,
          template_language: "en",
          message_text: null,
        },
      ],
    ])(
      "fails closed for contradictory WhatsApp %s",
      async (_label, overrides) => {
        const store = createReplayStore({
          data: validReplayRow(overrides),
          error: null,
        });

        await expect(
          lookupAdmittedBulkCampaignReplay({
            client: store.client,
            campaignId: replayCampaignId,
            workspaceId: replayWorkspaceId,
            sentBy: replayUserId,
            requestDigest: persistedRequestDigest,
          })
        ).rejects.toBeInstanceOf(BulkCampaignAdmissionUnavailableError);
      }
    );

    it.each([
      [
        "WhatsApp split marker with a campaign template",
        {
          template_name: "promo",
          template_language: "multi",
          message_text: null,
        },
      ],
      [
        "Telegram template identity",
        {
          channel: "telegram",
          template_name: "promo",
          template_language: "en",
          message_text: "Telegram text",
        },
      ],
      [
        "Telegram missing message",
        {
          channel: "telegram",
          template_name: null,
          template_language: "en",
          message_text: null,
        },
      ],
      [
        "email missing template identity",
        {
          channel: "email",
          template_name: null,
          template_language: "en",
          message_text: "Subject",
        },
      ],
    ])(
      "fails closed for contradictory persisted %s",
      async (_label, overrides) => {
        const store = createReplayStore({
          data: validReplayRow(overrides),
          error: null,
        });

        await expect(
          lookupAdmittedBulkCampaignReplay({
            client: store.client,
            campaignId: replayCampaignId,
            workspaceId: replayWorkspaceId,
            sentBy: replayUserId,
            requestDigest: persistedRequestDigest,
          })
        ).rejects.toBeInstanceOf(BulkCampaignAdmissionUnavailableError);
      }
    );

    it("fails closed when the authenticated admitted lookup errors", async () => {
      const store = createReplayStore({
        data: null,
        error: { code: "57014", message: "query timed out" },
      });

      await expect(
        lookupAdmittedBulkCampaignReplay({
          client: store.client,
          campaignId: replayCampaignId,
          workspaceId: replayWorkspaceId,
          sentBy: replayUserId,
          requestDigest: persistedRequestDigest,
        })
      ).rejects.toBeInstanceOf(BulkCampaignAdmissionUnavailableError);
    });

    it.each([
      [
        "evaluatedAt",
        {
          audience_metadata: {
            ...persistedMetadata,
            outcome: { ...persistedMetadata.outcome, evaluatedAt: "today" },
          },
        },
      ],
      [
        "batch plan",
        {
          audience_metadata: {
            ...persistedMetadata,
            batchPlan: { ...persistedMetadata.batchPlan, batchSize: 50_001 },
          },
        },
      ],
      ["sender", { sent_by: "77777777-7777-4777-8777-777777777777" }],
    ])("fails closed for malformed persisted %s", async (_label, overrides) => {
      const store = createReplayStore({
        data: validReplayRow(overrides),
        error: null,
      });

      await expect(
        lookupAdmittedBulkCampaignReplay({
          client: store.client,
          campaignId: replayCampaignId,
          workspaceId: replayWorkspaceId,
          sentBy: replayUserId,
          requestDigest: persistedRequestDigest,
        })
      ).rejects.toBeInstanceOf(BulkCampaignAdmissionUnavailableError);
    });
  });

  it("recursively removes compound credential keys from immutable dispatch snapshots", () => {
    expect(
      sanitizeBulkCampaignDispatchSnapshot({
        channel: "whatsapp",
        accessToken: "secret",
        refreshToken: "secret",
        clientSecret: "secret",
        whatsappAccessToken: "secret",
        privateKey: "secret",
        credentials: { token: "secret" },
        nested: {
          apiKey: "secret",
          safe: "retained",
        },
      })
    ).toEqual({
      channel: "whatsapp",
      nested: {
        safe: "retained",
      },
    });
  });

  it("preserves WhatsApp Flow routing tokens in immutable dispatch snapshots", () => {
    expect(
      sanitizeBulkCampaignDispatchSnapshot({
        components: [
          {
            type: "button",
            sub_type: "flow",
            parameters: [
              {
                type: "action",
                action: {
                  flow_token: "bulk:scenario-1:node-1",
                  access_token: "must-not-be-persisted",
                },
              },
            ],
          },
        ],
      })
    ).toEqual({
      components: [
        {
          type: "button",
          sub_type: "flow",
          parameters: [
            {
              type: "action",
              action: {
                flow_token: "bulk:scenario-1:node-1",
              },
            },
          ],
        },
      ],
    });
  });

  it.each([
    [
      "numeric strings",
      {
        kind: "none",
        intersection_count: "0",
        candidate_count: 1,
        ratio: 0,
      },
    ],
    [
      "negative intersections",
      {
        kind: "none",
        intersection_count: -1,
        candidate_count: 1,
        ratio: -1,
      },
    ],
    [
      "the wrong candidate count",
      {
        kind: "none",
        intersection_count: 0,
        candidate_count: 2,
        ratio: 0,
      },
    ],
    [
      "an intersection larger than the candidate",
      {
        kind: "high",
        intersection_count: 2,
        candidate_count: 1,
        ratio: 2,
      },
    ],
    [
      "an inconsistent ratio",
      {
        kind: "high",
        intersection_count: 1,
        candidate_count: 1,
        ratio: 0.8,
      },
    ],
  ])("fails closed on admitted overlap with %s", async (_label, overlap) => {
    const rpc = jest.fn(async () => ({
      data: {
        status: "admitted",
        campaign_id: input.campaignId,
        dispatch_status: input.dispatchStatus,
        audience_fingerprint: input.audience.fingerprint,
        overlap,
      },
      error: null,
    }));

    await expect(admitBulkCampaign({ rpc }, input)).rejects.toBeInstanceOf(
      BulkCampaignAdmissionUnavailableError
    );
  });

  it("fails closed when admitted overlap is missing or dispatch state differs", async () => {
    const missingOverlapRpc = jest.fn(async () => ({
      data: {
        status: "admitted",
        campaign_id: input.campaignId,
        dispatch_status: input.dispatchStatus,
        audience_fingerprint: input.audience.fingerprint,
      },
      error: null,
    }));
    const wrongStateRpc = jest.fn(async () => ({
      data: {
        status: "admitted",
        campaign_id: input.campaignId,
        dispatch_status: "scheduled",
        audience_fingerprint: input.audience.fingerprint,
        overlap: {
          kind: "none",
          intersection_count: 0,
          candidate_count: 1,
          ratio: 0,
        },
      },
      error: null,
    }));

    await expect(
      admitBulkCampaign({ rpc: missingOverlapRpc }, input)
    ).rejects.toBeInstanceOf(BulkCampaignAdmissionUnavailableError);
    await expect(
      admitBulkCampaign({ rpc: wrongStateRpc }, input)
    ).rejects.toBeInstanceOf(BulkCampaignAdmissionUnavailableError);
  });

  it("accepts aggregate-only unknown overlap for the legacy transition", async () => {
    const rpc = jest.fn(async () => ({
      data: {
        status: "blocked",
        code: "recent_audience_confirmation_required",
        retryable: false,
        audience_fingerprint: input.audience.fingerprint,
        overlap: {
          kind: "unknown",
          intersection_count: 0,
          candidate_count: 1,
          ratio: 0,
        },
      },
      error: null,
    }));

    await expect(admitBulkCampaign({ rpc }, input)).resolves.toEqual({
      status: "blocked",
      code: "recent_audience_confirmation_required",
      retryable: false,
      audienceFingerprint: input.audience.fingerprint,
      overlap: {
        kind: "unknown",
        intersectionCount: 0,
        candidateCount: 1,
        ratio: 0,
      },
    });
  });
});
