const mockAdmitBulkCampaign = jest.fn();
const mockStartBulkCampaignDispatchWorkflow = jest.fn();
const mockEmitCampaignHistoryCreatedUsageBestEffort = jest.fn();
const mockFailCampaignDispatchBeforeStart = jest.fn();
const mockStoreBulkCampaignDispatchItems = jest.fn();
const mockRecoverAdmittedCampaignDispatch = jest.fn();
const mockLookupAdmittedBulkCampaignReplay = jest.fn();

jest.mock("@icecore/shared/lib/bulk-dispatch-payload-store", () => ({
  isBulkDispatchPayloadStoreConfigured: () => false,
  storeBulkCampaignDispatchItems: (...args: unknown[]) =>
    mockStoreBulkCampaignDispatchItems(...args),
}));

jest.mock("./bulk-campaign-admission", () => {
  const actual = jest.requireActual("./bulk-campaign-admission");
  return {
    ...actual,
    admitBulkCampaign: (...args: unknown[]) => mockAdmitBulkCampaign(...args),
    lookupAdmittedBulkCampaignReplay: (...args: unknown[]) =>
      mockLookupAdmittedBulkCampaignReplay(...args),
  };
});

jest.mock("./admitted-campaign-ledger-recovery", () => {
  const actual = jest.requireActual("./admitted-campaign-ledger-recovery");
  return {
    ...actual,
    recoverAdmittedCampaignDispatch: (...args: unknown[]) =>
      mockRecoverAdmittedCampaignDispatch(...args),
  };
});

jest.mock("./campaign-history-store", () => ({
  emitCampaignHistoryCreatedUsageBestEffort: (...args: unknown[]) =>
    mockEmitCampaignHistoryCreatedUsageBestEffort(...args),
  failCampaignDispatchBeforeStart: (...args: unknown[]) =>
    mockFailCampaignDispatchBeforeStart(...args),
}));

jest.mock("./ensure-bulk-dispatch-gcs", () => ({
  ensureBulkDispatchGcsAuth: jest.fn(),
}));

jest.mock("@/lib/temporal/bulk-campaign-dispatch", () => ({
  startBulkCampaignDispatchWorkflow: (...args: unknown[]) =>
    mockStartBulkCampaignDispatchWorkflow(...args),
}));

import type { AdmittedBulkCampaignReplay } from "./bulk-campaign-admission";
import {
  ensureAdmittedBulkCampaignReplayStarted,
  ensureAdmittedPreparedBulkCampaignDispatchStarted,
  queuePreparedBulkCampaignDispatch,
  type QueuePreparedBulkCampaignDispatchInput,
} from "./queue-prepared-bulk-campaign-dispatch";
import { createBulkCampaignAudienceFingerprint } from "./bulk-campaign-safety";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const FIRST_CHILD_ID = "44444444-4444-4444-8444-444444444444";
const SECOND_CHILD_ID = "55555555-5555-4555-8555-555555555555";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const SECRET = "server-only-test-secret";

function input(campaignId: string) {
  return {
    storeClient: {
      from: jest.fn(),
      rpc: jest.fn(),
    },
    fingerprintSecret: SECRET,
    campaignId,
    workspaceId: WORKSPACE_ID,
    channel: "whatsapp" as const,
    campaignName: "July follow-up",
    templateName: "july_follow_up",
    templateLanguage: "en",
    messageText: null,
    sentBy: ACTOR_ID,
    scenarioId: null,
    scenarioNodeId: null,
    executionSource: "ad_hoc" as const,
    scheduledAt: null,
    batchPlan: {
      batchSize: 20,
      delayMs: 250,
      ratePerSecond: 80,
      rateSource: "meta_default_throughput",
      throughputLevel: "STANDARD",
    },
    items: [
      {
        workspaceId: WORKSPACE_ID,
        campaignId: SOURCE_CAMPAIGN_ID,
        generatedRecipientMessageId: "generated-message-1",
        channel: "whatsapp" as const,
        sourceId: "source-1",
        recipient: { phone: "+7 701 000 00 01" },
        phoneNumberId: "phone-number-1",
        templateName: "july_follow_up",
        languageCode: "en",
      },
      {
        workspaceId: WORKSPACE_ID,
        campaignId: SOURCE_CAMPAIGN_ID,
        generatedRecipientMessageId: "generated-message-2",
        channel: "whatsapp" as const,
        sourceId: "source-1",
        recipient: { phone: "+7 701 000 00 02" },
        phoneNumberId: "phone-number-1",
        templateName: "july_follow_up",
        languageCode: "en",
      },
    ],
    audienceSourceType: "failed_retry",
    requestedTotal: 2,
    skippedOptIn: 0,
    retryOfCampaignId: SOURCE_CAMPAIGN_ID,
    retryKind: "failed_only" as const,
    companyBulkCampaignLimit: 2,
    companySubscriptionType: "free" as const,
    confirmAudience: true,
    providerCircuitAcknowledgement: {
      acknowledgedBy: ACTOR_ID,
    },
  };
}

describe("prepared failed-only retry deduplication", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAdmitBulkCampaign.mockReset();
    mockStartBulkCampaignDispatchWorkflow.mockResolvedValue(undefined);
    mockFailCampaignDispatchBeforeStart.mockResolvedValue(true);
    mockRecoverAdmittedCampaignDispatch.mockReset();
    mockLookupAdmittedBulkCampaignReplay.mockReset();

    const audience = createBulkCampaignAudienceFingerprint({
      secret: SECRET,
      workspaceId: WORKSPACE_ID,
      channel: "whatsapp",
      recipients: [
        { phone: "+7 701 000 00 01" },
        { phone: "+7 701 000 00 02" },
      ],
    });
    mockAdmitBulkCampaign
      .mockResolvedValueOnce({
        status: "admitted",
        idempotentReplay: false,
        campaignId: FIRST_CHILD_ID,
        workflowId: `bulk-campaign:${FIRST_CHILD_ID}`,
        dispatchStatus: "queued",
        requestedAt: "2099-07-24T10:00:00.000Z",
        dispatchExpiresAt: "2099-07-24T10:15:00.000Z",
        audienceCount: 2,
        audienceFingerprint: audience.fingerprint,
        overlap: {
          kind: "none",
          intersectionCount: 0,
          candidateCount: 2,
          ratio: 0,
        },
      })
      .mockResolvedValueOnce({
        status: "admitted",
        idempotentReplay: true,
        campaignId: FIRST_CHILD_ID,
        workflowId: `bulk-campaign:${FIRST_CHILD_ID}`,
        dispatchStatus: "queued",
        requestedAt: "2099-07-24T10:00:00.000Z",
        dispatchExpiresAt: "2099-07-24T10:15:00.000Z",
        audienceCount: 2,
        audienceFingerprint: audience.fingerprint,
        overlap: {
          kind: "none",
          intersectionCount: 0,
          candidateCount: 2,
          ratio: 0,
        },
      });
  });

  it("restarts an admitted concurrent retry from immutable SQL snapshots instead of returning a false-positive queue", async () => {
    const alreadyStarted = new Error("Workflow execution already started");
    alreadyStarted.name = "WorkflowExecutionAlreadyStartedError";
    mockStartBulkCampaignDispatchWorkflow
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(alreadyStarted);
    const immutableSqlItems = input(FIRST_CHILD_ID).items.map(item => ({
      ...item,
      campaignId: FIRST_CHILD_ID,
      sentByUserId: ACTOR_ID,
      templateName: "immutable_sql_template",
    }));
    mockRecoverAdmittedCampaignDispatch.mockResolvedValue({
      status: "admitted",
      campaign: {
        campaignId: FIRST_CHILD_ID,
        workspaceId: WORKSPACE_ID,
        scenarioId: null,
        scenarioNodeId: null,
        executionSource: "ad_hoc",
        sentBy: ACTOR_ID,
        channel: "whatsapp",
        dispatchStatus: "queued",
        workflowId: `bulk-campaign:${FIRST_CHILD_ID}`,
        totalRecipients: 2,
        requestedAt: "2099-07-24T10:00:00.000Z",
        scheduledAt: null,
        dispatchExpiresAt: "2099-07-24T10:15:00.000Z",
        contentHash: "a".repeat(64),
        audience: {
          count: 2,
          fingerprint: "fingerprint",
          hashVersion: "v1",
          sourceType: "failed_retry",
        },
      },
      admittedItems: immutableSqlItems,
    });

    const [first, second] = await Promise.all([
      queuePreparedBulkCampaignDispatch(input(FIRST_CHILD_ID)),
      queuePreparedBulkCampaignDispatch(input(SECOND_CHILD_ID)),
    ]);

    expect(first.campaignId).toBe(FIRST_CHILD_ID);
    expect(second).toEqual(
      expect.objectContaining({
        campaignId: FIRST_CHILD_ID,
        dispatchId: FIRST_CHILD_ID,
        workflowId: `bulk-campaign:${FIRST_CHILD_ID}`,
        status: "queued",
        idempotentReplay: true,
        temporalDispatchStaging: "existing",
        total: 2,
        queuedGeneratedRecipientMessageIds: [
          "generated-message-1",
          "generated-message-2",
        ],
      })
    );
    expect(second).not.toHaveProperty("items");
    expect(mockRecoverAdmittedCampaignDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: FIRST_CHILD_ID,
        expectedRecipientCount: 2,
        maxRecipients: 2,
      })
    );
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledTimes(2);
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        campaignId: FIRST_CHILD_ID,
        items: immutableSqlItems,
      })
    );
    expect(mockEmitCampaignHistoryCreatedUsageBestEffort).toHaveBeenCalledTimes(
      1
    );
    expect(mockStoreBulkCampaignDispatchItems).not.toHaveBeenCalled();
  });

  it.each([
    { dispatchStatus: "queued" as const, scheduledAt: null },
    {
      dispatchStatus: "scheduled" as const,
      scheduledAt: "2099-07-25T10:00:00.000Z",
    },
  ])(
    "uses immutable SQL items for a same-campaign $dispatchStatus replay",
    async ({ dispatchStatus, scheduledAt }) => {
      const replayInput: QueuePreparedBulkCampaignDispatchInput =
        input(FIRST_CHILD_ID);
      replayInput.scheduledAt = scheduledAt;
      const audience = createBulkCampaignAudienceFingerprint({
        secret: SECRET,
        workspaceId: WORKSPACE_ID,
        channel: "whatsapp",
        recipients: [
          { phone: "+7 701 000 00 01" },
          { phone: "+7 701 000 00 02" },
        ],
      });
      const dispatchExpiresAt = scheduledAt
        ? "2099-07-25T10:15:00.000Z"
        : "2099-07-24T10:15:00.000Z";
      mockAdmitBulkCampaign.mockReset().mockResolvedValue({
        status: "admitted",
        idempotentReplay: true,
        campaignId: FIRST_CHILD_ID,
        workflowId: `bulk-campaign:${FIRST_CHILD_ID}`,
        dispatchStatus,
        requestedAt: "2099-07-24T10:00:00.000Z",
        dispatchExpiresAt,
        audienceCount: 2,
        audienceFingerprint: audience.fingerprint,
        overlap: {
          kind: "none",
          intersectionCount: 0,
          candidateCount: 2,
          ratio: 0,
        },
      });
      const immutableSqlItems = replayInput.items.map(item => ({
        ...item,
        campaignId: FIRST_CHILD_ID,
        sentByUserId: ACTOR_ID,
        templateName: "immutable_sql_template",
      }));
      mockRecoverAdmittedCampaignDispatch.mockResolvedValue({
        status: "admitted",
        campaign: {
          campaignId: FIRST_CHILD_ID,
          workspaceId: WORKSPACE_ID,
          scenarioId: null,
          scenarioNodeId: null,
          executionSource: "ad_hoc",
          sentBy: ACTOR_ID,
          channel: "whatsapp",
          dispatchStatus,
          workflowId: `bulk-campaign:${FIRST_CHILD_ID}`,
          totalRecipients: 2,
          requestedAt: "2099-07-24T10:00:00.000Z",
          scheduledAt,
          dispatchExpiresAt,
          contentHash: "a".repeat(64),
          audience: {
            count: 2,
            fingerprint: audience.fingerprint,
            hashVersion: "v1",
            sourceType: "failed_retry",
          },
        },
        admittedItems: immutableSqlItems,
      });

      await queuePreparedBulkCampaignDispatch(replayInput);

      expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: FIRST_CHILD_ID,
          scheduledAt,
          items: immutableSqlItems,
        })
      );
      expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalledWith(
        expect.objectContaining({ items: replayInput.items })
      );
    }
  );

  it("starts a canonical idempotent recovery with the persisted batch plan when live throughput drifts", async () => {
    const replayInput: QueuePreparedBulkCampaignDispatchInput =
      input(FIRST_CHILD_ID);
    const liveDriftedBatchPlan = {
      batchSize: 100,
      delayMs: 100,
      ratePerSecond: 1_000,
      rateSource: "live_meta_throughput",
      throughputLevel: "HIGH" as const,
    };
    const persistedBatchPlan = {
      batchSize: 5,
      delayMs: 1_000,
      ratePerSecond: 5,
      rateSource: "cached_meta_throughput",
      throughputLevel: "STANDARD" as const,
    };
    const requestDigest = { version: 1 as const, digest: "d".repeat(64) };
    replayInput.batchPlan = liveDriftedBatchPlan;
    replayInput.policyMetadata = {
      policy: { version: 1, excludePriorFailedBulkSends: true },
      authoritativeRecipientLimit: {
        source: "cached_meta",
        value: 2,
        rawLimit: "TIER_2",
      },
      outcome: {
        evaluatedAt: "2099-07-24T10:00:00.000Z",
        requestedTotal: 2,
        acceptedTotal: 2,
        uniqueRecipients: { requested: 2, accepted: 2 },
        skippedByReason: {},
        warnings: { missingMarketingConsent: 0 },
      },
      batchPlan: liveDriftedBatchPlan,
      requestDigest,
    };
    const audience = createBulkCampaignAudienceFingerprint({
      secret: SECRET,
      workspaceId: WORKSPACE_ID,
      channel: "whatsapp",
      recipients: [
        { phone: "+7 701 000 00 01" },
        { phone: "+7 701 000 00 02" },
      ],
    });
    mockAdmitBulkCampaign.mockReset().mockResolvedValue({
      status: "admitted",
      idempotentReplay: true,
      campaignId: FIRST_CHILD_ID,
      workflowId: `bulk-campaign:${FIRST_CHILD_ID}`,
      dispatchStatus: "queued",
      requestedAt: "2099-07-24T10:00:00.000Z",
      dispatchExpiresAt: "2099-07-24T10:15:00.000Z",
      audienceCount: 2,
      audienceFingerprint: audience.fingerprint,
      overlap: {
        kind: "none",
        intersectionCount: 0,
        candidateCount: 2,
        ratio: 0,
      },
    });
    mockLookupAdmittedBulkCampaignReplay.mockResolvedValue({
      campaignId: FIRST_CHILD_ID,
      workspaceId: WORKSPACE_ID,
      result: {},
      batchPlan: persistedBatchPlan,
      dispatchStatus: "queued",
      requestedAt: "2099-07-24T10:00:00.000Z",
      scheduledAt: null,
      dispatchExpiresAt: "2099-07-24T10:15:00.000Z",
      totalRecipients: 2,
      channel: "whatsapp",
      messageKind: "template",
      executionSource: "ad_hoc",
      scenarioId: null,
      rootNodeId: null,
      planLimit: { source: "cached_meta", value: 2 },
      policy: { version: 1, excludePriorFailedBulkSends: true },
    });
    const immutableSqlItems = replayInput.items.map(item => ({
      ...item,
      campaignId: FIRST_CHILD_ID,
      sentByUserId: ACTOR_ID,
    }));
    mockRecoverAdmittedCampaignDispatch.mockResolvedValue({
      status: "admitted",
      campaign: {
        campaignId: FIRST_CHILD_ID,
        workspaceId: WORKSPACE_ID,
        scenarioId: null,
        scenarioNodeId: null,
        executionSource: "ad_hoc",
        sentBy: ACTOR_ID,
        channel: "whatsapp",
        dispatchStatus: "queued",
        workflowId: `bulk-campaign:${FIRST_CHILD_ID}`,
        totalRecipients: 2,
        requestedAt: "2099-07-24T10:00:00.000Z",
        scheduledAt: null,
        dispatchExpiresAt: "2099-07-24T10:15:00.000Z",
        contentHash: "a".repeat(64),
        audience: {
          count: 2,
          fingerprint: audience.fingerprint,
          hashVersion: "v1",
          sourceType: "failed_retry",
        },
      },
      admittedItems: immutableSqlItems,
    });

    await queuePreparedBulkCampaignDispatch(replayInput);

    expect(mockLookupAdmittedBulkCampaignReplay).toHaveBeenCalledWith({
      client: replayInput.storeClient,
      campaignId: FIRST_CHILD_ID,
      workspaceId: WORKSPACE_ID,
      sentBy: ACTOR_ID,
      requestDigest,
    });
    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: FIRST_CHILD_ID,
        batchPlan: persistedBatchPlan,
        items: immutableSqlItems,
      })
    );
    expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalledWith(
      expect.objectContaining({ batchPlan: liveDriftedBatchPlan })
    );
  });

  it.each(["completed", "failed", "expired", "cancelled"] as const)(
    "fails closed when immutable ledger becomes %s after queued admission replay",
    async dispatchStatus => {
      const replayInput: QueuePreparedBulkCampaignDispatchInput =
        input(FIRST_CHILD_ID);
      const audience = createBulkCampaignAudienceFingerprint({
        secret: SECRET,
        workspaceId: WORKSPACE_ID,
        channel: "whatsapp",
        recipients: [
          { phone: "+7 701 000 00 01" },
          { phone: "+7 701 000 00 02" },
        ],
      });
      const requestDigest = { version: 1 as const, digest: "d".repeat(64) };
      replayInput.policyMetadata = {
        policy: { version: 1, excludePriorFailedBulkSends: false },
        authoritativeRecipientLimit: {
          source: "cached_meta",
          value: 2,
          rawLimit: "TIER_2",
        },
        outcome: {
          evaluatedAt: "2099-07-24T10:00:00.000Z",
          requestedTotal: 2,
          acceptedTotal: 2,
          uniqueRecipients: { requested: 2, accepted: 2 },
          skippedByReason: {},
          warnings: { missingMarketingConsent: 0 },
        },
        batchPlan: replayInput.batchPlan,
        requestDigest,
      };
      mockAdmitBulkCampaign.mockReset().mockResolvedValue({
        status: "admitted",
        idempotentReplay: true,
        campaignId: FIRST_CHILD_ID,
        workflowId: `bulk-campaign:${FIRST_CHILD_ID}`,
        dispatchStatus: "queued",
        requestedAt: "2099-07-24T10:00:00.000Z",
        dispatchExpiresAt: "2099-07-24T10:15:00.000Z",
        audienceCount: 2,
        audienceFingerprint: audience.fingerprint,
        overlap: {
          kind: "none",
          intersectionCount: 0,
          candidateCount: 2,
          ratio: 0,
        },
      });
      const replay: AdmittedBulkCampaignReplay = {
        campaignId: FIRST_CHILD_ID,
        workspaceId: WORKSPACE_ID,
        result: {},
        batchPlan: replayInput.batchPlan,
        dispatchStatus: "queued",
        requestedAt: "2099-07-24T10:00:00.000Z",
        scheduledAt: null,
        dispatchExpiresAt: "2099-07-24T10:15:00.000Z",
        totalRecipients: 2,
        channel: "whatsapp",
        messageKind: "template",
        executionSource: "ad_hoc",
        scenarioId: null,
        rootNodeId: null,
        planLimit: { source: "cached_meta", value: 2 },
        policy: { version: 1, excludePriorFailedBulkSends: false },
      };
      mockLookupAdmittedBulkCampaignReplay.mockResolvedValue(replay);
      mockRecoverAdmittedCampaignDispatch.mockResolvedValue({
        status: "admitted",
        campaign: {
          campaignId: FIRST_CHILD_ID,
          workspaceId: WORKSPACE_ID,
          scenarioId: null,
          scenarioNodeId: null,
          executionSource: "ad_hoc",
          sentBy: ACTOR_ID,
          channel: "whatsapp",
          dispatchStatus,
          workflowId: `bulk-campaign:${FIRST_CHILD_ID}`,
          totalRecipients: 2,
          requestedAt: replay.requestedAt,
          scheduledAt: null,
          dispatchExpiresAt: replay.dispatchExpiresAt,
          contentHash: "a".repeat(64),
          audience: {
            count: 2,
            fingerprint: audience.fingerprint,
            hashVersion: "v1",
            sourceType: "failed_retry",
          },
        },
        admittedItems: replayInput.items,
      });

      await expect(
        queuePreparedBulkCampaignDispatch(replayInput)
      ).rejects.toMatchObject({
        httpStatus: 409,
        body: {
          code: "bulk_campaign_terminal_replay",
          retryable: false,
          campaignId: FIRST_CHILD_ID,
          dispatchId: FIRST_CHILD_ID,
        },
      });
      expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
    }
  );

  it("binds recent confirmation and immutable acknowledgement inside admission", async () => {
    await queuePreparedBulkCampaignDispatch(input(FIRST_CHILD_ID));

    const admissionInput = mockAdmitBulkCampaign.mock.calls[0]?.[1];
    expect(admissionInput).toEqual(
      expect.objectContaining({
        confirmationFingerprint: admissionInput.audience.fingerprint,
        retryOfCampaignId: SOURCE_CAMPAIGN_ID,
        retryKind: "failed_only",
        providerCircuitAcknowledgedBy: ACTOR_ID,
      })
    );
    expect(admissionInput.snapshots).toEqual([
      expect.objectContaining({
        dispatchSnapshot: expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          campaignId: FIRST_CHILD_ID,
          channel: "whatsapp",
          sentByUserId: ACTOR_ID,
        }),
      }),
      expect.objectContaining({
        dispatchSnapshot: expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          campaignId: FIRST_CHILD_ID,
          channel: "whatsapp",
          sentByUserId: ACTOR_ID,
        }),
      }),
    ]);
  });

  it("retains repeated failed-only items and assigns fresh child ordinals", async () => {
    const duplicateInput = input(FIRST_CHILD_ID);
    duplicateInput.items = duplicateInput.items.map((item, index) => ({
      ...item,
      snapshotOrdinal: index + 9,
      ...(index === 1 ? { recipient: { phone: "+7 701 000 00 01" } } : {}),
    }));

    await expect(
      queuePreparedBulkCampaignDispatch(duplicateInput)
    ).resolves.toMatchObject({ total: 2 });
    const admissionInput = mockAdmitBulkCampaign.mock.calls[0]?.[1];
    expect(
      admissionInput.snapshots.map(
        (snapshot: { snapshotOrdinal: number }) => snapshot.snapshotOrdinal
      )
    ).toEqual([0, 1]);
    expect(
      admissionInput.snapshots.map(
        (snapshot: { dispatchSnapshot: { snapshotOrdinal?: number } }) =>
          snapshot.dispatchSnapshot.snapshotOrdinal
      )
    ).toEqual([0, 1]);
    expect(admissionInput.snapshots[0].recipientHash).toBe(
      admissionInput.snapshots[1].recipientHash
    );
  });

  it("returns a payment-required response when atomic admission finds the company quota full", async () => {
    const quotaInput = input(FIRST_CHILD_ID);
    const audience = createBulkCampaignAudienceFingerprint({
      secret: SECRET,
      workspaceId: WORKSPACE_ID,
      channel: "whatsapp",
      recipients: [
        { phone: "+7 701 000 00 01" },
        { phone: "+7 701 000 00 02" },
      ],
    });
    mockAdmitBulkCampaign.mockReset().mockResolvedValue({
      status: "blocked",
      code: "company_bulk_campaign_limit_exceeded",
      retryable: false,
      audienceFingerprint: audience.fingerprint,
      companyBulkCampaignLimit: 2,
      companyBulkCampaignCount: 2,
    });

    await expect(
      queuePreparedBulkCampaignDispatch(quotaInput)
    ).rejects.toMatchObject({
      httpStatus: 402,
      body: {
        code: "company_bulk_campaign_limit_exceeded",
        retryable: false,
      },
    });
    expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
    expect(
      mockEmitCampaignHistoryCreatedUsageBestEffort
    ).not.toHaveBeenCalled();
  });

  it("returns a retryable conflict when the company plan changes under lock", async () => {
    mockAdmitBulkCampaign.mockReset().mockResolvedValue({
      status: "conflict",
      code: "company_plan_changed",
      retryable: true,
      audienceFingerprint: "a".repeat(64),
      expectedSubscriptionType: "pro",
      currentSubscriptionType: "free",
    });

    await expect(
      queuePreparedBulkCampaignDispatch({
        ...input(FIRST_CHILD_ID),
        companySubscriptionType: "pro",
        companyBulkCampaignLimit: null,
      })
    ).rejects.toMatchObject({
      httpStatus: 409,
      body: {
        code: "company_plan_changed",
        retryable: true,
      },
    });
    expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
  });

  it("recovers the same admitted campaign without starting a second workflow", async () => {
    const recoveryInput = input(FIRST_CHILD_ID);
    const audience = createBulkCampaignAudienceFingerprint({
      secret: SECRET,
      workspaceId: WORKSPACE_ID,
      channel: "whatsapp",
      recipients: [
        { phone: "+7 701 000 00 01" },
        { phone: "+7 701 000 00 02" },
      ],
    });
    mockAdmitBulkCampaign.mockReset().mockResolvedValue({
      status: "admitted",
      idempotentReplay: true,
      campaignId: FIRST_CHILD_ID,
      workflowId: `bulk-campaign:${FIRST_CHILD_ID}`,
      dispatchStatus: "running",
      requestedAt: "2026-07-24T10:00:00.000Z",
      dispatchExpiresAt: "2026-07-24T10:15:00.000Z",
      audienceCount: 2,
      audienceFingerprint: audience.fingerprint,
      overlap: {
        kind: "none",
        intersectionCount: 0,
        candidateCount: 2,
        ratio: 0,
      },
    });

    await expect(
      queuePreparedBulkCampaignDispatch(recoveryInput)
    ).resolves.toEqual(
      expect.objectContaining({
        campaignId: FIRST_CHILD_ID,
        status: "running",
        idempotentReplay: true,
        temporalDispatchStaging: "existing",
        queuedGeneratedRecipientMessageIds: [
          "generated-message-1",
          "generated-message-2",
        ],
      })
    );
    expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
    expect(
      mockEmitCampaignHistoryCreatedUsageBestEffort
    ).not.toHaveBeenCalled();
    expect(mockFailCampaignDispatchBeforeStart).not.toHaveBeenCalled();
  });

  it.each(["completed", "failed", "expired", "cancelled"] as const)(
    "fails closed when an idempotent admission is already %s",
    async dispatchStatus => {
      const recoveryInput = input(FIRST_CHILD_ID);
      const audience = createBulkCampaignAudienceFingerprint({
        secret: SECRET,
        workspaceId: WORKSPACE_ID,
        channel: "whatsapp",
        recipients: [
          { phone: "+7 701 000 00 01" },
          { phone: "+7 701 000 00 02" },
        ],
      });
      mockAdmitBulkCampaign.mockReset().mockResolvedValue({
        status: "admitted",
        idempotentReplay: true,
        campaignId: FIRST_CHILD_ID,
        workflowId: `bulk-campaign:${FIRST_CHILD_ID}`,
        dispatchStatus,
        requestedAt: "2026-07-24T10:00:00.000Z",
        dispatchExpiresAt: "2026-07-24T10:15:00.000Z",
        audienceCount: 2,
        audienceFingerprint: audience.fingerprint,
        overlap: {
          kind: "none",
          intersectionCount: 0,
          candidateCount: 2,
          ratio: 0,
        },
      });

      await expect(
        queuePreparedBulkCampaignDispatch(recoveryInput)
      ).rejects.toMatchObject({
        httpStatus: 409,
        body: {
          code: "bulk_campaign_terminal_replay",
          retryable: false,
          campaignId: FIRST_CHILD_ID,
        },
      });
      expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
    }
  );

  it("fails closed when one admission contains multiple channels", async () => {
    const mixedInput: QueuePreparedBulkCampaignDispatchInput = {
      storeClient: {
        from: jest.fn(),
        rpc: jest.fn(),
      },
      fingerprintSecret: SECRET,
      campaignId: FIRST_CHILD_ID,
      workspaceId: WORKSPACE_ID,
      channel: "whatsapp",
      campaignName: "Generated multi-channel campaign",
      templateName: "july_follow_up",
      templateLanguage: "en",
      messageText: null,
      sentBy: ACTOR_ID,
      scenarioId: "scenario-1",
      scenarioNodeId: "root-1",
      executionSource: "scenario_run_now",
      scheduledAt: null,
      batchPlan: {
        batchSize: 20,
        delayMs: 250,
        ratePerSecond: 80,
        rateSource: "meta_default_throughput",
        throughputLevel: "STANDARD",
      },
      items: [
        {
          workspaceId: WORKSPACE_ID,
          campaignId: null,
          channel: "whatsapp",
          sourceId: "source-1",
          recipient: { phone: "+7 701 000 00 01" },
          phoneNumberId: "phone-number-1",
          templateName: "july_follow_up",
          languageCode: "en",
        },
        {
          workspaceId: WORKSPACE_ID,
          campaignId: null,
          channel: "telegram",
          sourceId: "source-2",
          recipient: { chatId: "998877" },
          messageText: "Telegram follow-up",
        },
      ],
      audienceSourceType: "scenario_generated",
      requestedTotal: 2,
      skippedOptIn: 0,
      companyBulkCampaignLimit: 2,
      companySubscriptionType: "free" as const,
    };

    await expect(
      queuePreparedBulkCampaignDispatch(mixedInput)
    ).rejects.toMatchObject({
      httpStatus: 409,
      body: {
        code: "bulk_campaign_mixed_channel_unsupported",
      },
    });
    expect(mockAdmitBulkCampaign).not.toHaveBeenCalled();
    expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
  });
});

describe("admitted prepared campaign workflow recovery", () => {
  const recoveryItems = input(FIRST_CHILD_ID).items.map(item => ({
    ...item,
    workspaceId: WORKSPACE_ID,
    campaignId: FIRST_CHILD_ID,
    sentByUserId: ACTOR_ID,
  }));
  const recoveryInput = {
    storeClient: {
      from: jest.fn(),
      rpc: jest.fn(),
    },
    workspaceId: WORKSPACE_ID,
    campaignId: FIRST_CHILD_ID,
    dispatchStatus: "queued" as const,
    requestedAt: "2099-07-24T10:00:00.000Z",
    scheduledAt: null,
    dispatchExpiresAt: "2099-07-24T10:15:00.000Z",
    batchPlan: input(FIRST_CHILD_ID).batchPlan,
    items: recoveryItems,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockStartBulkCampaignDispatchWorkflow
      .mockReset()
      .mockResolvedValue(undefined);
    mockFailCampaignDispatchBeforeStart.mockReset().mockResolvedValue(true);
    mockRecoverAdmittedCampaignDispatch.mockReset();
  });

  it("fails a canonical early replay closed when its persisted ledger is incomplete", async () => {
    const replay: AdmittedBulkCampaignReplay = {
      campaignId: FIRST_CHILD_ID,
      workspaceId: WORKSPACE_ID,
      result: {},
      batchPlan: {
        batchSize: 5,
        delayMs: 1_000,
        ratePerSecond: 5,
        rateSource: "cached_meta_throughput",
      },
      dispatchStatus: "queued",
      requestedAt: "2099-07-24T10:00:00.000Z",
      scheduledAt: null,
      dispatchExpiresAt: "2099-07-24T10:15:00.000Z",
      totalRecipients: 2,
      channel: "whatsapp",
      messageKind: "template",
      executionSource: "ad_hoc",
      scenarioId: null,
      rootNodeId: null,
      planLimit: { source: "cached_meta", value: 2 },
      policy: { version: 1, excludePriorFailedBulkSends: true },
    };
    const storeClient = input(FIRST_CHILD_ID).storeClient;
    mockRecoverAdmittedCampaignDispatch.mockResolvedValue({
      status: "not_admitted",
    });

    await expect(
      ensureAdmittedBulkCampaignReplayStarted({ storeClient, replay })
    ).rejects.toMatchObject({
      httpStatus: 503,
      body: {
        code: "bulk_campaign_admitted_payload_unavailable",
        retryable: true,
        campaignId: FIRST_CHILD_ID,
      },
    });
    expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
  });

  it("starts the exact immutable payload after a crash following SQL admission", async () => {
    await expect(
      ensureAdmittedPreparedBulkCampaignDispatchStarted(recoveryInput)
    ).resolves.toEqual({
      status: "started",
      temporalDispatchStaging: "inline",
    });

    expect(mockStartBulkCampaignDispatchWorkflow).toHaveBeenCalledWith({
      lifecycleManaged: true,
      workspaceId: WORKSPACE_ID,
      campaignId: FIRST_CHILD_ID,
      requestedAt: "2099-07-24T10:00:00.000Z",
      dispatchExpiresAt: "2099-07-24T10:15:00.000Z",
      batchPlan: recoveryInput.batchPlan,
      scheduledAt: null,
      items: recoveryItems,
    });
  });

  it("treats deterministic AlreadyStarted as success for first-admission ambiguity", async () => {
    const alreadyStarted = new Error("Workflow execution already started");
    alreadyStarted.name = "WorkflowExecutionAlreadyStartedError";
    mockStartBulkCampaignDispatchWorkflow.mockRejectedValueOnce(alreadyStarted);

    await expect(
      ensureAdmittedPreparedBulkCampaignDispatchStarted(recoveryInput)
    ).resolves.toEqual({
      status: "already_started",
      temporalDispatchStaging: "existing",
    });
    expect(mockFailCampaignDispatchBeforeStart).not.toHaveBeenCalled();
  });

  it.each(["completed", "failed", "expired", "cancelled"] as const)(
    "does not restart a terminal %s campaign",
    async dispatchStatus => {
      await expect(
        ensureAdmittedPreparedBulkCampaignDispatchStarted({
          ...recoveryInput,
          dispatchStatus,
        })
      ).resolves.toEqual({
        status: "terminal",
        dispatchStatus,
        temporalDispatchStaging: "existing",
      });
      expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
      expect(mockFailCampaignDispatchBeforeStart).not.toHaveBeenCalled();
    }
  );

  it("terminalizes an elapsed command before payload staging or workflow start", async () => {
    await expect(
      ensureAdmittedPreparedBulkCampaignDispatchStarted({
        ...recoveryInput,
        requestedAt: "2026-07-24T10:00:00.000Z",
        dispatchExpiresAt: "2026-07-24T10:15:00.000Z",
        now: new Date("2026-07-24T11:00:00.000Z"),
      })
    ).rejects.toMatchObject({
      httpStatus: 409,
      body: {
        code: "bulk_campaign_dispatch_expired",
        campaignId: FIRST_CHILD_ID,
        status: "failed",
      },
    });
    expect(mockFailCampaignDispatchBeforeStart).toHaveBeenCalledWith({
      supabase: recoveryInput.storeClient,
      campaignId: FIRST_CHILD_ID,
      stopReason: "dispatch_expired_before_start",
    });
    expect(mockStoreBulkCampaignDispatchItems).not.toHaveBeenCalled();
    expect(mockStartBulkCampaignDispatchWorkflow).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous start failure admitted for deterministic recovery", async () => {
    mockStartBulkCampaignDispatchWorkflow.mockRejectedValueOnce(
      new Error("Temporal connection reset after request write")
    );

    await expect(
      ensureAdmittedPreparedBulkCampaignDispatchStarted(recoveryInput)
    ).rejects.toMatchObject({
      httpStatus: 503,
      body: {
        code: "bulk_campaign_workflow_start_unconfirmed",
        retryable: true,
        campaignId: FIRST_CHILD_ID,
      },
    });
    expect(mockFailCampaignDispatchBeforeStart).not.toHaveBeenCalled();
  });
});
