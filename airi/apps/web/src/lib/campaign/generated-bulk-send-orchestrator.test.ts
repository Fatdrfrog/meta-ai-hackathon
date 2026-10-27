import { BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID } from "@icecore/scenario-contracts";
import type { BulkCampaignDispatchItem } from "@icecore/temporal";

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {},
}));

jest.mock("./bulk-send-api-idempotency", () => ({
  ...jest.requireActual("./bulk-send-api-idempotency"),
  reserveGeneratedBulkSendOperation: jest.fn(),
}));

import { Scenario } from "@/models/scenario";
import { reserveGeneratedBulkSendOperation } from "./bulk-send-api-idempotency";
import {
  buildGeneratedScenarioRevisionGraphForPersistence,
  createGeneratedBulkSendOrchestrator,
  executeGeneratedBulkSend,
  previewGeneratedBulkCampaignEligibility,
  reconcileGeneratedBulkSendScenarioRevision,
  type GeneratedBulkSendOrchestratorDependencies,
} from "./generated-bulk-send-orchestrator";
import { BulkCampaignProvenanceError } from "./bulk-campaign-provenance";
import { BulkCampaignEligibilityError } from "./bulk-campaign-recipient-eligibility";
import { BulkRecipientPolicyError } from "./bulk-recipient-policy";
import {
  advanceGeneratedRecipientAudience,
  createGeneratedRecipientAudience,
} from "./generated-recipient-audience";

const WORKSPACE_ID = "workspace-1";
const SCENARIO_ID = "65f000000000000000000002";
const ROOT_ID = "bulk-root";
const REVISION = "generation-job-1";
const OPERATION_ID = "77777777-7777-4777-8777-777777777777";
const CAMPAIGN_ID = "88888888-8888-4888-8888-888888888888";
const MESSAGE_ID = "65f000000000000000000101";
const REQUESTED_AT = "2026-07-27T10:00:00.000Z";

function scenario(overrides: Record<string, unknown> = {}) {
  return {
    _id: SCENARIO_ID,
    workspaceId: WORKSPACE_ID,
    name: "Generated campaign",
    status: "draft",
    updatedAt: new Date("2026-07-27T09:00:00.000Z"),
    nodes: [
      {
        id: ROOT_ID,
        data: {
          kind: "bulk",
          bulkRootConfig: {
            workflowKind: "bulk_campaign",
            sendMode: "immediate",
            channels: ["whatsapp"],
            campaignName: "Generated campaign",
            generationStatus: "complete",
            generatedRecipientCount: 1,
            generationJobId: REVISION,
            recipientPolicy: {
              version: 1,
              excludePriorFailedBulkSends: false,
            },
          },
        },
      },
      {
        id: "action-1",
        data: {
          kind: "action",
          actionType: "whatsapp_template",
        },
      },
    ],
    ...overrides,
  };
}

// A complete generated WhatsApp bulk root without a recipient policy.
function bulkRootNode(configPatch: Record<string, unknown> = {}) {
  return {
    id: ROOT_ID,
    data: {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "Generated campaign",
        generationStatus: "complete",
        generatedRecipientCount: 1,
        generationJobId: REVISION,
        ...configPatch,
      },
    },
  };
}

function withScenario(overrides: Record<string, unknown>) {
  return { findScenario: jest.fn().mockResolvedValue(scenario(overrides)) };
}

function operationRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: MESSAGE_ID,
    workspaceId: WORKSPACE_ID,
    scenarioId: SCENARIO_ID,
    generationJobId: REVISION,
    nodeId: "action-1",
    channel: "whatsapp",
    recipient: "15550000001",
    recipientName: "Aibek",
    recipientEmail: null,
    sourceId: "source-1",
    text: "Generated offer",
    mediaAssetIds: [],
    internalLabels: [],
    createdAt: new Date("2026-07-27T09:30:00.000Z"),
    sendStatus: "preparing",
    sendOperationId: OPERATION_ID,
    campaignId: null,
    sendPartitionKey: null,
    skipReason: null,
    skipDetail: null,
    error: null,
    ...overrides,
  };
}

function dispatchItem(messageId = MESSAGE_ID): BulkCampaignDispatchItem {
  return {
    channel: "whatsapp",
    workspaceId: WORKSPACE_ID,
    campaignId: CAMPAIGN_ID,
    generatedRecipientMessageId: messageId,
    scenarioId: SCENARIO_ID,
    scenarioNodeId: "action-1",
    executionSource: "scenario_run_now",
    sentByUserId: "user-1",
    sourceId: "source-1",
    recipient: { phone: "15550000001" },
    phoneNumberId: "phone-1",
    templateName: "generated_offer",
    languageCode: "en",
    components: [],
  };
}

function currentPartitionPolicyFields(
  requestedTotal = 1,
  acceptedTotal = requestedTotal,
  skippedByReason: Record<string, number> = {}
) {
  return {
    authoritativeRecipientLimit: {
      source: "live_meta" as const,
      value: 100,
      rawLimit: "100",
    },
    policyOutcome: {
      requestedTotal,
      acceptedTotal,
      uniqueRecipients: {
        requested: requestedTotal,
        accepted: acceptedTotal,
      },
      skippedByReason,
      warnings: { missingMarketingConsent: 0 },
      allExcluded: requestedTotal > 0 && acceptedTotal === 0,
    },
  };
}

function currentWhatsAppPolicyFacts(
  requestedTotal = 1,
  acceptedTotal = requestedTotal,
  skippedByReason: Record<string, number> = {}
) {
  const partition = currentPartitionPolicyFields(
    requestedTotal,
    acceptedTotal,
    skippedByReason
  );
  return {
    policy: { version: 1 as const, excludePriorFailedBulkSends: false },
    authoritativeRecipientLimit: partition.authoritativeRecipientLimit,
    outcome: partition.policyOutcome,
  };
}

function completedReplayResponseWithPolicyFacts() {
  return {
    queued: true,
    total: 1,
    requestedTotal: 1,
    policyEventFacts: {
      channel: "whatsapp" as const,
      messageKind: "template" as const,
      executionSource: "scenario_run_now" as const,
      scenarioId: SCENARIO_ID,
      rootNodeId: ROOT_ID,
      itemCounts: { requested: 1, accepted: 1, queued: 1 },
      uniqueRecipientCounts: { requested: 1, accepted: 1, queued: 1 },
      skippedByReason: {},
      warnings: { missingMarketingConsent: 0 },
      disposition: "queued" as const,
      lifecycleStatus: "queued" as const,
      planLimit: { source: "live_meta" as const, value: 100 },
      policy: { version: 1 as const, excludePriorFailedBulkSends: false },
    },
    scenarioUpdate: {
      nodeId: ROOT_ID,
      bulkRootConfigPatch: {
        sendStatus: {
          total: 1,
          queued: 1,
          sent: 0,
          skipped: 0,
          failed: 0,
        },
        generatedSendState: {
          revision: REVISION,
          operationId: OPERATION_ID,
          state: "completed" as const,
          requestedAt: REQUESTED_AT,
          completedAt: "2026-07-27T10:02:00.000Z",
        },
      },
      scenarioUpdatedAt: "2026-07-27T10:02:00.000Z",
    },
  };
}

function queuedChild(overrides: Record<string, unknown> = {}) {
  return {
    campaignId: CAMPAIGN_ID,
    dispatchId: CAMPAIGN_ID,
    workflowId: `bulk-campaign-dispatch:${WORKSPACE_ID}:${CAMPAIGN_ID}`,
    status: "queued" as const,
    requestedAt: REQUESTED_AT,
    dispatchExpiresAt: "2026-07-27T10:15:00.000Z",
    temporalDispatchStaging: "inline" as const,
    idempotentReplay: false,
    total: 1,
    queuedGeneratedRecipientMessageIds: [MESSAGE_ID],
    audience: {
      fingerprint: "a".repeat(64),
      requestedTotal: 1,
      queuedTotal: 1,
      skippedOptIn: 0,
    },
    audienceConfirmation: {
      required: false,
      confirmed: false,
      fingerprint: "a".repeat(64),
    },
    ...overrides,
  };
}

function admittedChildRecovery(
  dispatchStatus:
    | "queued"
    | "scheduled"
    | "running"
    | "completed"
    | "failed"
    | "expired"
    | "cancelled" = "queued"
) {
  return {
    status: "admitted" as const,
    campaign: {
      campaignId: CAMPAIGN_ID,
      workspaceId: WORKSPACE_ID,
      scenarioId: SCENARIO_ID,
      scenarioNodeId: ROOT_ID,
      sentBy: "user-1",
      channel: "whatsapp" as const,
      dispatchStatus,
      workflowId: `bulk-campaign-dispatch:${WORKSPACE_ID}:${CAMPAIGN_ID}`,
      totalRecipients: 1,
      requestedAt: REQUESTED_AT,
      scheduledAt: null,
      dispatchExpiresAt: "2026-07-27T10:15:00.000Z",
      contentHash: "d".repeat(64),
      audience: {
        count: 1,
        fingerprint: "a".repeat(64),
        hashVersion: "v1",
        sourceType: "scenario_generated" as const,
      },
    },
    admittedAudience: {
      version: 1 as const,
      count: 1,
      digest: "e".repeat(64),
    },
    admittedItems: [dispatchItem()],
  };
}

function generatedRecoveryFact() {
  return {
    partitionKey: "whatsapp:source-1:phone-1",
    campaignId: CAMPAIGN_ID,
    channel: "whatsapp" as const,
    sourceId: "source-1",
    batchPlan: {
      batchSize: 50,
      delayMs: 1_000,
      ratePerSecond: 20,
      rateSource: "meta" as const,
    },
    contentHash: "d".repeat(64),
    audience: {
      version: 1 as const,
      count: 1,
      digest: "e".repeat(64),
    },
    requestedTotal: 1,
    skippedOptIn: 0,
  };
}

function resumedPreparedReservation(overrides: Record<string, unknown> = {}) {
  return {
    status: "acquired" as const,
    operationId: OPERATION_ID,
    reservationToken: "lease-token",
    initiatingUserId: "user-1",
    audienceRevision: REVISION,
    requestedAt: REQUESTED_AT,
    scheduledAt: null,
    isNew: false,
    compatibilityMode: "legacy_v1_disabled" as const,
    recipientPolicy: {
      version: 1 as const,
      excludePriorFailedBulkSends: false,
    },
    progressVersion: 1,
    requestDigest: "f".repeat(64),
    requestDigestVersion: 1,
    progressBody: {
      version: 1,
      phase: "prepared" as const,
      preparationDigestVersion: 2,
      preparationDigest: "b".repeat(64),
      recoveryFacts: [generatedRecoveryFact()],
      admittedChildrenCount: 0,
      queuedCount: 0,
      skippedCount: 0,
      lastPartitionKey: null,
    },
    ...overrides,
  };
}

function newReservation(overrides: Record<string, unknown> = {}) {
  return {
    status: "acquired" as const,
    operationId: OPERATION_ID,
    reservationToken: "lease-token",
    initiatingUserId: "user-1",
    audienceRevision: REVISION,
    requestedAt: REQUESTED_AT,
    scheduledAt: null,
    isNew: true,
    compatibilityMode: "current_v2" as const,
    recipientPolicy: {
      version: 1 as const,
      excludePriorFailedBulkSends: false,
    },
    progressVersion: 0,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<GeneratedBulkSendOrchestratorDependencies> = {}
): GeneratedBulkSendOrchestratorDependencies {
  const item = dispatchItem();
  return {
    now: () => new Date("2026-07-27T10:01:00.000Z"),
    connectDB: jest.fn().mockResolvedValue(undefined),
    fingerprintSecret: () => "fingerprint-secret",
    isTemporalConfigured: () => true,
    ensureConversationCapacity: jest.fn().mockResolvedValue({
      allowed: true,
      companyBulkCampaignLimit: 2,
      companySubscriptionType: "free",
    }),
    findScenario: jest.fn().mockResolvedValue(scenario()),
    reserveOperation: jest.fn(async (params: Record<string, unknown>) => {
      const reservation = newReservation({
        scheduledAt:
          Object.prototype.hasOwnProperty.call(params, "scheduledAt") &&
          typeof params.scheduledAt === "string"
            ? params.scheduledAt
            : null,
      });
      const beforeCreate = params.beforeCreate as
        | ((candidate: ReturnType<typeof newReservation>) => Promise<void>)
        | undefined;
      await beforeCreate?.(reservation);
      return reservation;
    }),
    deleteOperationBeforeClaim: jest.fn().mockResolvedValue(true),
    renewOperationLease: jest.fn().mockResolvedValue(true),
    bindRequestDigest: jest.fn().mockResolvedValue({ status: "bound" }),
    compareAndSetProgress: jest.fn().mockImplementation(async input => ({
      progressVersion: input.expectedProgressVersion + 1,
    })),
    completeOperation: jest.fn().mockResolvedValue(true),
    failOperation: jest.fn().mockResolvedValue(true),
    claimRevision: jest.fn().mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      scenarioId: SCENARIO_ID,
      audienceRevision: REVISION,
      operationId: OPERATION_ID,
      revisionCount: 1,
      claimedCount: 1,
      matchedCount: 1,
      modifiedCount: 1,
      claimed: true,
    }),
    loadOperationPage: jest.fn().mockResolvedValue({
      rows: [operationRow()],
      nextCursor: null,
    }),
    loadRevisionPage: jest.fn().mockResolvedValue({
      rows: [operationRow()],
      nextCursor: null,
    }),
    verifyGeneratedProvenanceCapability: jest.fn().mockResolvedValue({}),
    routeGeneratedProvenance: jest.fn().mockResolvedValue({
      routes: [],
      supportsWhatsAppTemplate: true,
      recipientPolicy: {
        version: 1,
        excludePriorFailedBulkSends: false,
      },
    }),
    prepare: jest.fn().mockResolvedValue({
      requestedMessageIds: [MESSAGE_ID],
      partitions: [
        {
          partitionKey: "whatsapp:source-1:phone-1",
          channel: "whatsapp",
          sourceId: "source-1",
          campaignId: CAMPAIGN_ID,
          items: [item],
          candidateMessageIds: [MESSAGE_ID],
          templateName: "generated_offer",
          templateLanguage: "en",
          messageText: null,
          batchPlan: {
            batchSize: 50,
            delayMs: 1_000,
            ratePerSecond: 20,
            rateSource: "meta",
          },
          requestedTotal: 1,
          skippedOptIn: 0,
          authoritativeRecipientLimit: {
            source: "live_meta",
            value: 100,
            rawLimit: "100",
          },
          policyOutcome: {
            requestedTotal: 1,
            acceptedTotal: 1,
            uniqueRecipients: { requested: 1, accepted: 1 },
            skippedByReason: {},
            warnings: { missingMarketingConsent: 0 },
            allExcluded: false,
          },
        },
      ],
      skippedByMessageId: {},
      whatsappPolicyFacts: {
        policy: { version: 1, excludePriorFailedBulkSends: false },
        authoritativeRecipientLimit: {
          source: "live_meta",
          value: 100,
          rawLimit: "100",
        },
        outcome: {
          requestedTotal: 1,
          acceptedTotal: 1,
          uniqueRecipients: { requested: 1, accepted: 1 },
          skippedByReason: {},
          warnings: { missingMarketingConsent: 0 },
          allExcluded: false,
        },
      },
      preparationDigestVersion: 3,
      preparationDigest: "b".repeat(64),
    }),
    normalizeQueueItems: jest.fn().mockReturnValue({
      items: [item],
      snapshotSeeds: [
        {
          recipientHash: "c".repeat(64),
          recipient: "whatsapp:15550000001",
          dispatchSnapshot: item,
        },
      ],
      queuedGeneratedRecipientMessageIds: [MESSAGE_ID],
      excludedGeneratedRecipientMessages: [],
    }),
    createContentHash: jest.fn().mockReturnValue("d".repeat(64)),
    assignPartition: jest.fn().mockResolvedValue({
      campaignId: CAMPAIGN_ID,
      partitionKey: "whatsapp:source-1:phone-1",
      requestedCount: 1,
      matchedCount: 1,
      modifiedCount: 1,
      assigned: true,
    }),
    commitOutcomes: jest.fn().mockResolvedValue({
      subsetCount: 1,
      queuedCount: 1,
      skippedCount: 0,
      queuedMatchedCount: 1,
      skippedMatchedCount: 0,
      queuedModifiedCount: 1,
      skippedModifiedCount: 0,
      committed: true,
    }),
    commitAssignedSkips: jest.fn().mockResolvedValue({
      subsetCount: 1,
      skippedCount: 1,
      matchedCount: 1,
      modifiedCount: 1,
      committed: true,
    }),
    recoverChild: jest.fn().mockResolvedValue({ status: "not_admitted" }),
    ensureRecoveredChildStarted: jest.fn().mockResolvedValue({
      status: "started",
      temporalDispatchStaging: "inline",
    }),
    queueChild: jest.fn().mockResolvedValue(queuedChild()),
    verifyCoverage: jest.fn().mockResolvedValue({
      expectedCount: 1,
      ownedCount: 1,
      allRevisionOwnedCount: 1,
      queuedCount: 1,
      skippedCount: 0,
      incompleteCount: 0,
      unexpectedRevisionCount: 0,
      audience: { version: 1, count: 1, digest: "e".repeat(64) },
      audienceMatches: true,
      complete: true,
    }),
    updateScenarioRevision: jest.fn().mockResolvedValue({
      updated: true,
      scenarioUpdatedAt: "2026-07-27T10:02:00.000Z",
    }),
    emitPolicyEvent: jest.fn(),
    ...overrides,
  } as GeneratedBulkSendOrchestratorDependencies;
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    scenarioId: SCENARIO_ID,
    userId: "user-1",
    requestUrl: "https://airi.chat/api/send",
    ...overrides,
  };
}

describe("generated bulk-send orchestrator", () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns the revision written by the real Scenario query when repairing a completed send", async () => {
    jest.useFakeTimers({ now: new Date("2026-09-07T10:00:00.000Z") });
    try {
      jest
        .spyOn(Scenario.base, "now")
        .mockReturnValue(new Date("2026-09-07T10:00:00.015Z"));
      jest.mocked(reserveGeneratedBulkSendOperation).mockResolvedValue({
        status: "completed",
        operationId: OPERATION_ID,
        responseBody: completedReplayResponseWithPolicyFacts(),
      });
      const read = jest
        .spyOn(Scenario.collection, "findOne")
        .mockResolvedValue(scenario());
      const write = jest
        .spyOn(Scenario.collection, "updateOne")
        .mockResolvedValue({
          acknowledged: true,
          matchedCount: 1,
          modifiedCount: 1,
          upsertedCount: 0,
          upsertedId: null,
        });

      const result = await executeGeneratedBulkSend(
        request({ idempotencyKey: "completed-revision" })
      );

      expect(result.status).toBe(200);
      expect(write).toHaveBeenCalledTimes(1);
      const [filter, update] = write.mock.calls[0]!;
      if (Array.isArray(update) || !update.$set) {
        throw new Error("Expected a Scenario revision update document");
      }
      expect(result.body.scenarioUpdate?.scenarioUpdatedAt).toBe(
        update.$set.updatedAt.toISOString()
      );
      expect(filter).toMatchObject({
        workspaceId: WORKSPACE_ID,
        deletedAt: null,
        updatedAt: scenario().updatedAt,
      });
      expect(read).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    [
      "activates a draft generated Scenario",
      "conversation",
      null,
      null,
      "active",
      "active",
    ],
    [
      "keeps a draft with a daily WhatsApp birthday root inactive",
      "conversation",
      "whatsapp",
      null,
      undefined,
      "draft",
    ],
    [
      "keeps a draft with a daily Telegram birthday root inactive",
      "conversation",
      "telegram",
      "telegram-source-1",
      undefined,
      "draft",
    ],
    [
      "activates a draft whose Telegram birthday root has no bot",
      "conversation",
      "telegram",
      null,
      "active",
      "active",
    ],
    [
      "activates a legacy bulk_campaign draft as before",
      "bulk_campaign",
      "whatsapp",
      null,
      "active",
      "active",
    ],
  ] as const)(
    "%s when a completed send repairs its marker",
    async (
      _label,
      mode,
      birthdayChannel,
      telegramSourceId,
      expectedStatus,
      reportedStatus
    ) => {
      jest.mocked(reserveGeneratedBulkSendOperation).mockResolvedValue({
        status: "completed",
        operationId: OPERATION_ID,
        responseBody: completedReplayResponseWithPolicyFacts(),
      });
      // Only the Scenario save runs the birthday guard, so a generated send
      // must not activate a builder birthday root's daily schedule (WhatsApp,
      // or Telegram with a bot). A root the save would not schedule (Telegram
      // without a bot) is activated as before.
      const birthdayRoot = {
        id: "birthday-root",
        data: {
          kind: "bulk",
          bulkRootConfig: {
            workflowKind: "bulk_campaign",
            channels: [birthdayChannel],
            recipientAudienceSource: "customer_birthdays",
            ...(telegramSourceId
              ? { telegramSubscriberSourceId: telegramSourceId }
              : {}),
            scheduleConfig: {
              version: 2,
              mode: "recurring",
              timezone: "UTC",
              recurrence: { kind: "daily", time: "09:00" },
            },
          },
        },
      };
      const birthdayMessage = {
        id: "birthday-message",
        data:
          birthdayChannel === "telegram"
            ? {
                kind: "action",
                actionType: "reply",
                actionReplyChannel: "telegram",
                actionReplyMode: "fixed",
                actionReplyText: "Happy birthday",
              }
            : {
                kind: "action",
                actionType: "whatsapp_template",
                actionWhatsAppTemplateName: "birthday_offer",
                actionWhatsAppTemplateLanguage: "en",
              },
      };
      const stored = scenario({ mode });
      jest.spyOn(Scenario.collection, "findOne").mockResolvedValue(
        birthdayChannel
          ? {
              ...stored,
              nodes: [...stored.nodes, birthdayRoot, birthdayMessage],
              edges: [
                {
                  id: "birthday-edge",
                  source: birthdayRoot.id,
                  sourceHandle: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
                  target: birthdayMessage.id,
                },
              ],
            }
          : stored
      );
      const write = jest
        .spyOn(Scenario.collection, "updateOne")
        .mockResolvedValue({
          acknowledged: true,
          matchedCount: 1,
          modifiedCount: 1,
          upsertedCount: 0,
          upsertedId: null,
        });

      const result = await executeGeneratedBulkSend(
        request({
          idempotencyKey: `repair-${mode}-${birthdayChannel}-${telegramSourceId}`,
        })
      );

      expect(result.status).toBe(200);
      expect(write).toHaveBeenCalledTimes(1);
      const update = write.mock.calls[0]![1];
      if (Array.isArray(update) || !update.$set) {
        throw new Error("Expected a Scenario revision update document");
      }
      expect(update.$set.status).toBe(expectedStatus);
      // The builder adopts a reported "active" and saves it back.
      expect(result.body.scenarioStatus).toBe(reportedStatus);
    }
  );

  it.each([
    [undefined, "active"],
    ["draft", "draft"],
  ] as const)(
    "reports the stored status %s as %s after a fresh send",
    async (storedStatus, reportedStatus) => {
      const deps = dependencies({
        updateScenarioRevision: jest.fn().mockResolvedValue({
          updated: true,
          scenarioUpdatedAt: "2026-07-27T10:02:00.000Z",
          scenarioStatus: storedStatus,
        }),
      });

      const result = await createGeneratedBulkSendOrchestrator(deps)(request());

      expect(result.status).toBe(200);
      expect(result.body.scenarioStatus).toBe(reportedStatus);
    }
  );

  it("previews an identifier-only persisted revision and marks recurring evaluation deferred", async () => {
    const immediateDeps = dependencies();
    const ready = await previewGeneratedBulkCampaignEligibility(
      {
        workspaceId: WORKSPACE_ID,
        scenarioId: SCENARIO_ID,
        observedPlanRevision: "old-plan",
      },
      immediateDeps
    );

    expect(ready).toEqual({
      status: 200,
      body: expect.objectContaining({
        state: "ready",
        audienceRevision: REVISION,
        planChanged: true,
        policy: { version: 1, excludePriorFailedBulkSends: false },
        requestedTotal: 1,
        acceptedTotal: 1,
      }),
    });
    expect(immediateDeps.loadRevisionPage).toHaveBeenCalledTimes(1);
    expect(
      immediateDeps.verifyGeneratedProvenanceCapability
    ).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      scenarioId: SCENARIO_ID,
      rootNodeId: ROOT_ID,
      audienceRevision: REVISION,
    });
    expect(immediateDeps.routeGeneratedProvenance).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({ _id: MESSAGE_ID })]
    );
    expect(immediateDeps.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: false,
        },
        digestMode: "current_v3",
      })
    );
    expect(immediateDeps.claimRevision).not.toHaveBeenCalled();
    expect(immediateDeps.reserveOperation).not.toHaveBeenCalled();

    const recurring = scenario();
    const recurringRoot = recurring.nodes[0]!.data.bulkRootConfig!;
    recurringRoot.sendMode = "each_run";
    recurringRoot.recipientPolicy = {
      version: 1,
      excludePriorFailedBulkSends: true,
    };
    const deferredDeps = dependencies({
      findScenario: jest.fn().mockResolvedValue(recurring),
    });
    await expect(
      previewGeneratedBulkCampaignEligibility(
        { workspaceId: WORKSPACE_ID, scenarioId: SCENARIO_ID },
        deferredDeps
      )
    ).resolves.toEqual({
      status: 200,
      body: {
        state: "deferred",
        appliesAt: "each_run",
        policy: { version: 1, excludePriorFailedBulkSends: true },
      },
    });
    expect(deferredDeps.loadRevisionPage).not.toHaveBeenCalled();
    expect(deferredDeps.prepare).not.toHaveBeenCalled();
  });

  it("normalizes the full graph while applying a missing generated-send marker without mutation", () => {
    const rawGraph = {
      graphSchemaVersion: 0,
      nodes: [
        {
          id: ROOT_ID,
          data: {
            kind: "bulk",
            bulkRootConfig: {
              generationJobId: REVISION,
              generatedSendState: null,
            },
          },
        },
        {
          id: "legacy-trigger",
          data: {
            kind: "trigger",
            triggerType: "future_unknown_trigger",
            triggerConfig: { enabled: true },
          },
        },
      ],
      edges: [{ id: "edge-1", source: ROOT_ID, target: "legacy-trigger" }],
    };
    const original = structuredClone(rawGraph);

    const graph = buildGeneratedScenarioRevisionGraphForPersistence(rawGraph, {
      nodeId: ROOT_ID,
      audienceRevision: REVISION,
      patch: {
        generatedRecipientCount: 1,
        sendStatus: {
          total: 1,
          queued: 1,
          sent: 0,
          skipped: 0,
          failed: 0,
        },
        generatedSendState: {
          revision: REVISION,
          operationId: OPERATION_ID,
          state: "completed",
          requestedAt: REQUESTED_AT,
          completedAt: "2026-07-27T10:02:00.000Z",
        },
      },
    });

    expect(rawGraph).toEqual(original);
    expect(graph).toEqual({
      graphSchemaVersion: 1,
      nodes: [
        {
          id: ROOT_ID,
          data: {
            kind: "bulk",
            bulkRootConfig: {
              generationJobId: REVISION,
              generatedRecipientCount: 1,
              sendStatus: {
                total: 1,
                queued: 1,
                sent: 0,
                skipped: 0,
                failed: 0,
              },
              generatedSendState: {
                revision: REVISION,
                operationId: OPERATION_ID,
                state: "completed",
                requestedAt: REQUESTED_AT,
                completedAt: "2026-07-27T10:02:00.000Z",
              },
            },
          },
        },
        {
          id: "legacy-trigger",
          data: {
            kind: "trigger",
            triggerConfig: {
              enabled: false,
              messageMatchMode: "any",
              keywordMatchMode: "contains",
            },
          },
        },
      ],
      edges: [{ id: "edge-1", source: ROOT_ID, target: "legacy-trigger" }],
    });
    expect(graph?.nodes[0]).not.toBe(rawGraph.nodes[0]);
    expect((graph?.nodes[0] as { data: unknown }).data).not.toBe(
      rawGraph.nodes[0].data
    );
  });

  it("does not mutate a Scenario whose exact generated operation marker is already repaired", async () => {
    const writeMissingMarker = jest.fn();
    const result = await reconcileGeneratedBulkSendScenarioRevision(
      {
        workspaceId: WORKSPACE_ID,
        scenarioId: SCENARIO_ID,
        nodeId: ROOT_ID,
        audienceRevision: REVISION,
        operationId: OPERATION_ID,
        updatedBy: "user-1",
        patch: {
          generatedRecipientCount: 1,
          sendStatus: {
            total: 1,
            queued: 1,
            sent: 0,
            skipped: 0,
            failed: 0,
          },
          generatedSendState: {
            revision: REVISION,
            operationId: OPERATION_ID,
            state: "completed",
            requestedAt: REQUESTED_AT,
            completedAt: "2026-07-27T10:02:00.000Z",
          },
        },
        scenarioStatus: "active",
      },
      {
        read: jest.fn().mockResolvedValue({
          generatedSendState: {
            revision: REVISION,
            operationId: OPERATION_ID,
            state: "completed",
            requestedAt: REQUESTED_AT,
            completedAt: "2026-07-27T10:02:00.000Z",
          },
          scenarioUpdatedAt: "2026-07-27T11:30:00.000Z",
        }),
        writeMissingMarker,
      }
    );

    expect(result).toEqual({
      updated: true,
      scenarioUpdatedAt: "2026-07-27T11:30:00.000Z",
    });
    expect(writeMissingMarker).not.toHaveBeenCalled();
  });

  it("normalizes before assignment and returns one canonical child", async () => {
    const deps = dependencies();
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request());

    expect(result.status).toBe(200);
    expect(deps.reserveOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        intentDigestVersion: 2,
        intentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        legacyIntentDigestVersion: 1,
        legacyIntentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: false,
        },
      })
    );
    expect(deps.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: false,
        },
        digestMode: "current_v3",
      })
    );
    expect(deps.normalizeQueueItems).toHaveBeenCalledTimes(1);
    expect(deps.assignPartition).toHaveBeenCalledWith(
      expect.objectContaining({ messageIds: [MESSAGE_ID] })
    );
    expect(
      (deps.normalizeQueueItems as jest.Mock).mock.invocationCallOrder[0]
    ).toBeLessThan(
      (deps.assignPartition as jest.Mock).mock.invocationCallOrder[0]
    );
    expect(deps.queueChild).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedAt: REQUESTED_AT,
        companyBulkCampaignLimit: 2,
        companySubscriptionType: "free",
        items: [expect.objectContaining({ campaignId: CAMPAIGN_ID })],
        policyMetadata: {
          policy: {
            version: 1,
            excludePriorFailedBulkSends: false,
          },
          authoritativeRecipientLimit: {
            source: "live_meta",
            value: 100,
            rawLimit: "100",
          },
          outcome: {
            evaluatedAt: REQUESTED_AT,
            requestedTotal: 1,
            acceptedTotal: 1,
            uniqueRecipients: { requested: 1, accepted: 1 },
            skippedByReason: {},
            warnings: { missingMarketingConsent: 0 },
          },
          batchPlan: {
            batchSize: 50,
            delayMs: 1_000,
            ratePerSecond: 20,
            rateSource: "meta",
          },
          requestDigest: {
            version: 1,
            digest: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      })
    );
    expect(deps.bindRequestDigest).toHaveBeenCalledWith(
      expect.objectContaining({ requestDigestVersion: 2 })
    );
    expect(result.body).toEqual(
      expect.objectContaining({
        operationDisposition: "completed",
        queued: true,
        total: 1,
        requestedTotal: 1,
        childrenTotal: 1,
        childrenTruncated: false,
        campaignId: CAMPAIGN_ID,
        scenarioUpdate: expect.objectContaining({
          nodeId: ROOT_ID,
          scenarioUpdatedAt: "2026-07-27T10:02:00.000Z",
          bulkRootConfigPatch: expect.objectContaining({
            generatedSendState: expect.objectContaining({
              revision: REVISION,
              state: "completed",
            }),
          }),
        }),
      })
    );
    expect(deps.completeOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        responseBody: expect.objectContaining({
          operationDisposition: "completed",
        }),
      })
    );
  });

  it("uses the persisted root policy as the only generated-send policy authority", async () => {
    const base = dependencies();
    const persistedPolicy = {
      version: 1 as const,
      excludePriorFailedBulkSends: true,
    };
    const deps = dependencies({
      findScenario: jest.fn().mockResolvedValue(
        scenario({
          nodes: [
            {
              ...scenario().nodes[0],
              data: {
                ...scenario().nodes[0].data,
                bulkRootConfig: {
                  ...scenario().nodes[0].data.bulkRootConfig,
                  recipientPolicy: persistedPolicy,
                },
              },
            },
            scenario().nodes[1],
          ],
        })
      ),
      routeGeneratedProvenance: jest.fn().mockResolvedValue({
        routes: [],
        recipientPolicy: persistedPolicy,
        supportsWhatsAppTemplate: true,
      }),
      prepare: jest.fn().mockImplementation(async params => {
        const prepared = await (base.prepare as jest.Mock)(params);
        return {
          ...prepared,
          whatsappPolicyFacts: {
            ...prepared.whatsappPolicyFacts,
            policy: persistedPolicy,
          },
        };
      }),
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    await execute(request());

    expect(deps.reserveOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
      })
    );
    expect(deps.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
      })
    );
  });

  it("fails fresh send and preview before writes when the provenance policy snapshot changes", async () => {
    const changedPolicy = {
      version: 1 as const,
      excludePriorFailedBulkSends: true,
    };
    let operationWritten = false;
    const reserveOperation = jest.fn(
      async (params: Record<string, unknown>) => {
        const candidate = newReservation();
        const beforeCreate = params.beforeCreate as
          | ((value: ReturnType<typeof newReservation>) => Promise<void>)
          | undefined;
        await beforeCreate?.(candidate);
        operationWritten = true;
        return candidate;
      }
    );
    const routeGeneratedProvenance = jest.fn().mockResolvedValue({
      routes: [],
      supportsWhatsAppTemplate: true,
      recipientPolicy: changedPolicy,
    });
    const sendDeps = dependencies({
      reserveOperation:
        reserveOperation as unknown as GeneratedBulkSendOrchestratorDependencies["reserveOperation"],
      routeGeneratedProvenance,
    });

    const send = await createGeneratedBulkSendOrchestrator(sendDeps)(request());
    const previewDeps = dependencies({ routeGeneratedProvenance });
    const preview = await previewGeneratedBulkCampaignEligibility(
      { workspaceId: WORKSPACE_ID, scenarioId: SCENARIO_ID },
      previewDeps
    );

    expect(send).toEqual({
      status: 503,
      body: expect.objectContaining({
        operationDisposition: "not_started",
        code: "generated_bulk_send_policy_changed",
        retryable: true,
      }),
    });
    expect(preview).toEqual({
      status: 503,
      body: expect.objectContaining({
        state: "unavailable",
        code: "generated_bulk_send_policy_changed",
        retryable: true,
      }),
    });
    expect(operationWritten).toBe(false);
    expect(sendDeps.prepare).not.toHaveBeenCalled();
    expect(previewDeps.prepare).not.toHaveBeenCalled();
  });

  it("prepares the complete draft revision read-only before irreversible claim writes", async () => {
    const deps = dependencies();
    const execute = createGeneratedBulkSendOrchestrator(deps);

    await execute(request());

    expect(deps.loadRevisionPage).toHaveBeenCalledTimes(1);
    expect(
      (deps.prepare as jest.Mock).mock.invocationCallOrder[0]
    ).toBeLessThan(
      (deps.compareAndSetProgress as jest.Mock).mock.invocationCallOrder[0]
    );
    expect(
      (deps.prepare as jest.Mock).mock.invocationCallOrder[0]
    ).toBeLessThan(
      (deps.claimRevision as jest.Mock).mock.invocationCallOrder[0]
    );
    expect(deps.prepare).toHaveBeenCalledTimes(1);
  });

  it("verifies generated provenance before audience preparation or claim writes", async () => {
    let operationWritten = false;
    const verifyGeneratedProvenanceCapability = jest
      .fn()
      .mockRejectedValue(new Error("generated provenance rejected"));
    const routeGeneratedProvenance = jest.fn();
    const reserveOperation = jest.fn(
      async (params: Record<string, unknown>) => {
        const candidate = newReservation();
        const beforeCreate = params.beforeCreate as
          | ((value: ReturnType<typeof newReservation>) => Promise<void>)
          | undefined;
        await beforeCreate?.(candidate);
        operationWritten = true;
        return candidate;
      }
    );
    const deps = dependencies({
      ...({
        reserveOperation,
        verifyGeneratedProvenanceCapability,
        routeGeneratedProvenance,
      } as unknown as Partial<GeneratedBulkSendOrchestratorDependencies>),
    });

    const result = await createGeneratedBulkSendOrchestrator(deps)(request());

    expect(result).toEqual({
      status: 503,
      body: expect.objectContaining({
        operationDisposition: "not_started",
        code: "generated_bulk_send_retryable_failure",
        error: "generated provenance rejected",
      }),
    });
    expect(verifyGeneratedProvenanceCapability).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      scenarioId: SCENARIO_ID,
      rootNodeId: ROOT_ID,
      audienceRevision: REVISION,
    });
    expect(routeGeneratedProvenance).not.toHaveBeenCalled();
    expect(deps.loadRevisionPage).not.toHaveBeenCalled();
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.compareAndSetProgress).not.toHaveBeenCalled();
    expect(deps.claimRevision).not.toHaveBeenCalled();
    expect(operationWritten).toBe(false);
    expect(deps.deleteOperationBeforeClaim).not.toHaveBeenCalled();
  });

  it("emits aggregate failure observability when policy preparation fails before operation creation", async () => {
    const deps = dependencies({
      prepare: jest
        .fn()
        .mockRejectedValue(new Error("Prior-failure lookup unavailable")),
    });

    const result = await createGeneratedBulkSendOrchestrator(deps)(request());

    expect(result).toEqual({
      status: 503,
      body: expect.objectContaining({
        operationDisposition: "not_started",
        code: "generated_bulk_send_retryable_failure",
      }),
    });
    expect(deps.emitPolicyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        channel: "whatsapp",
        itemCounts: { requested: 1, accepted: 0, queued: 0 },
        uniqueRecipientCounts: { requested: 1, accepted: 0, queued: 0 },
        disposition: "failed",
        errorCode: "generated_bulk_send_retryable_failure",
        idempotentReplay: false,
      })
    );
    expect(
      JSON.stringify((deps.emitPolicyEvent as jest.Mock).mock.calls)
    ).not.toContain(MESSAGE_ID);
  });

  it.each([false, true])(
    "blocks invalid recipient identities without retrying or claiming the audience (acquired operation: %s)",
    async acquired => {
      const deps = dependencies({
        prepare: jest
          .fn()
          .mockRejectedValue(
            new BulkRecipientPolicyError("invalid_recipient_identity")
          ),
        ...(acquired
          ? {
              reserveOperation: jest
                .fn()
                .mockResolvedValue(
                  newReservation({ isNew: false, progressVersion: 0 })
                ),
            }
          : {}),
      });

      const result = await createGeneratedBulkSendOrchestrator(deps)(request());

      expect(result).toEqual({
        status: 400,
        body: expect.objectContaining({
          operationDisposition: "not_started",
          code: "invalid_recipient_identity",
          retryable: false,
        }),
      });
      expect(deps.claimRevision).not.toHaveBeenCalled();
      expect(deps.queueChild).not.toHaveBeenCalled();
      expect(deps.deleteOperationBeforeClaim).not.toHaveBeenCalled();
      expect(deps.emitPolicyEvent).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: "invalid_recipient_identity" })
      );
    }
  );

  it("marks invalid generated recipient previews as blocked with their actionable error code", async () => {
    const deps = dependencies({
      prepare: jest
        .fn()
        .mockRejectedValue(
          new BulkRecipientPolicyError("invalid_recipient_identity")
        ),
    });

    const result = await previewGeneratedBulkCampaignEligibility(
      { workspaceId: WORKSPACE_ID, scenarioId: SCENARIO_ID },
      deps
    );

    expect(result).toEqual({
      status: 400,
      body: expect.objectContaining({
        state: "blocked",
        code: "invalid_recipient_identity",
        retryable: false,
      }),
    });
    expect(deps.reserveOperation).not.toHaveBeenCalled();
  });

  it("keeps recipient-policy store failures retryable", async () => {
    const deps = dependencies({
      prepare: jest
        .fn()
        .mockRejectedValue(
          new BulkRecipientPolicyError("prior_failure_lookup_failed")
        ),
    });

    const result = await createGeneratedBulkSendOrchestrator(deps)(request());

    expect(result).toEqual({
      status: 503,
      body: expect.objectContaining({
        code: "generated_bulk_send_retryable_failure",
        retryable: true,
      }),
    });
  });

  it.each([
    {
      name: "a preparation dependency rejects",
      overrides: {
        prepare: jest
          .fn()
          .mockRejectedValue(new Error("Prior-failure lookup unavailable")),
      },
      code: "generated_bulk_send_retryable_failure",
    },
    {
      name: "the runtime safety secret is unavailable",
      overrides: { fingerprintSecret: () => null },
      code: "bulk_campaign_safety_unavailable",
    },
  ])(
    "emits aggregate failure observability when an acquired no-progress retry finds $name",
    async ({ overrides, code }) => {
      const deps = dependencies({
        ...overrides,
        reserveOperation: jest.fn().mockResolvedValue(
          newReservation({
            isNew: false,
            progressVersion: 0,
          })
        ),
      });

      const result = await createGeneratedBulkSendOrchestrator(deps)(request());

      expect(result).toEqual({
        status: 503,
        body: expect.objectContaining({
          operationDisposition: "not_started",
          code,
          retryable: true,
        }),
      });
      expect(deps.emitPolicyEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          channel: "whatsapp",
          itemCounts: { requested: 1, accepted: 0, queued: 0 },
          uniqueRecipientCounts: { requested: 1, accepted: 0, queued: 0 },
          disposition: "failed",
          errorCode: code,
          idempotentReplay: false,
        })
      );
      expect(
        JSON.stringify((deps.emitPolicyEvent as jest.Mock).mock.calls)
      ).not.toContain(MESSAGE_ID);
      expect(deps.compareAndSetProgress).not.toHaveBeenCalled();
      expect(deps.claimRevision).not.toHaveBeenCalled();
      expect(deps.queueChild).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])(
    "answers a Meta rate limit on the template lookup with its code and retry time (acquired operation: %s)",
    async acquired => {
      const deps = dependencies({
        prepare: jest.fn().mockRejectedValue(
          new BulkCampaignEligibilityError("meta_rate_limited", {
            retryAfterSeconds: 120,
          })
        ),
        ...(acquired
          ? {
              reserveOperation: jest
                .fn()
                .mockResolvedValue(
                  newReservation({ isNew: false, progressVersion: 0 })
                ),
            }
          : {}),
      });

      const result = await createGeneratedBulkSendOrchestrator(deps)(request());

      expect(result).toEqual({
        status: 503,
        body: expect.objectContaining({
          operationDisposition: "not_started",
          code: "meta_rate_limited",
          retryable: true,
          retryAfterSeconds: 120,
        }),
        headers: { "Retry-After": "120" },
      });
      expect(deps.emitPolicyEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          disposition: "failed",
          errorCode: "meta_rate_limited",
        })
      );
      expect(deps.claimRevision).not.toHaveBeenCalled();
      expect(deps.queueChild).not.toHaveBeenCalled();
    }
  );

  it("answers an unavailable template lookup with its code and no retry time", async () => {
    const deps = dependencies({
      prepare: jest
        .fn()
        .mockRejectedValue(
          new BulkCampaignEligibilityError("template_lookup_unavailable")
        ),
    });

    const result = await createGeneratedBulkSendOrchestrator(deps)(request());

    expect(result).toEqual({
      status: 503,
      body: expect.objectContaining({
        operationDisposition: "not_started",
        code: "template_lookup_unavailable",
        retryable: true,
      }),
    });
    expect(result.body).not.toHaveProperty("retryAfterSeconds");
    expect(deps.emitPolicyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "template_lookup_unavailable" })
    );
  });

  it("leaves a failed template lookup in the preview to the eligibility route", async () => {
    const lookupError = new BulkCampaignEligibilityError("meta_rate_limited", {
      retryAfterSeconds: 120,
    });
    const deps = dependencies({
      prepare: jest.fn().mockRejectedValue(lookupError),
    });

    await expect(
      previewGeneratedBulkCampaignEligibility(
        { workspaceId: WORKSPACE_ID, scenarioId: SCENARIO_ID },
        deps
      )
    ).rejects.toBe(lookupError);
  });

  it("discards losing before-create preparation when a different operation wins the insert race", async () => {
    const losingOperationId = "99999999-9999-4999-8999-999999999999";
    const reserveOperation = jest.fn(
      async (params: Record<string, unknown>) => {
        const beforeCreate = params.beforeCreate as
          | ((value: ReturnType<typeof newReservation>) => Promise<void>)
          | undefined;
        await beforeCreate?.(
          newReservation({ operationId: losingOperationId })
        );
        return newReservation({ operationId: OPERATION_ID, isNew: false });
      }
    );
    const deps = dependencies({
      reserveOperation:
        reserveOperation as unknown as GeneratedBulkSendOrchestratorDependencies["reserveOperation"],
    });

    const result = await createGeneratedBulkSendOrchestrator(deps)(request());

    expect(result.status).toBe(200);
    expect(deps.prepare).toHaveBeenCalledTimes(2);
    expect(deps.prepare).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ operationId: losingOperationId })
    );
    expect(deps.prepare).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ operationId: OPERATION_ID })
    );
  });

  it("awaits generated row routing and fails closed before preparation or claim", async () => {
    const routeGeneratedProvenance = jest
      .fn()
      .mockRejectedValue(new Error("generated row route rejected"));
    const deps = dependencies({
      routeGeneratedProvenance:
        routeGeneratedProvenance as unknown as GeneratedBulkSendOrchestratorDependencies["routeGeneratedProvenance"],
    });

    const result = await createGeneratedBulkSendOrchestrator(deps)(request());

    expect(result).toEqual({
      status: 503,
      body: expect.objectContaining({
        operationDisposition: "not_started",
        code: "generated_bulk_send_retryable_failure",
        error: "generated row route rejected",
      }),
    });
    expect(routeGeneratedProvenance).toHaveBeenCalledTimes(1);
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.compareAndSetProgress).not.toHaveBeenCalled();
    expect(deps.claimRevision).not.toHaveBeenCalled();
    expect(deps.queueChild).not.toHaveBeenCalled();
  });

  it("fails closed when draft semantics change between read-only preparation and claim", async () => {
    const deps = dependencies({
      loadRevisionPage: jest.fn().mockResolvedValue({
        rows: [operationRow({ sendStatus: "draft", sendOperationId: null })],
        nextCursor: null,
      }),
      loadOperationPage: jest.fn().mockResolvedValue({
        rows: [operationRow({ text: "Changed after preflight" })],
        nextCursor: null,
      }),
    });

    const result = await createGeneratedBulkSendOrchestrator(deps)(request());

    expect(result).toEqual({
      status: 503,
      body: expect.objectContaining({
        operationDisposition: "in_progress",
        code: "generated_bulk_send_retryable_failure",
        error: "Generated send revision changed after read-only preflight",
      }),
    });
    expect(deps.assignPartition).not.toHaveBeenCalled();
    expect(deps.queueChild).not.toHaveBeenCalled();
    expect(deps.commitOutcomes).not.toHaveBeenCalled();
  });

  it("returns the canonical unsupported-policy code from send and preview", async () => {
    const enabledScenario = scenario();
    enabledScenario.nodes[0]!.data.bulkRootConfig!.recipientPolicy = {
      version: 1,
      excludePriorFailedBulkSends: true,
    };
    const error = new BulkCampaignProvenanceError("approved_template_missing");
    const sendDeps = dependencies({
      findScenario: jest.fn().mockResolvedValue(enabledScenario),
      routeGeneratedProvenance: jest.fn().mockRejectedValue(error),
    });

    const send = await createGeneratedBulkSendOrchestrator(sendDeps)(request());
    const preview = await previewGeneratedBulkCampaignEligibility(
      { workspaceId: WORKSPACE_ID, scenarioId: SCENARIO_ID },
      dependencies({
        findScenario: jest.fn().mockResolvedValue(enabledScenario),
        routeGeneratedProvenance: jest.fn().mockRejectedValue(error),
      })
    );

    expect(send).toEqual({
      status: 409,
      body: expect.objectContaining({
        operationDisposition: "not_started",
        code: "bulk_recipient_policy_unsupported",
      }),
    });
    expect(preview).toEqual({
      status: 409,
      body: expect.objectContaining({
        state: "unavailable",
        code: "bulk_recipient_policy_unsupported",
      }),
    });
  });

  it("maps a missing WhatsApp source to unsupported only for an enabled persisted policy", async () => {
    const enabledScenario = scenario();
    enabledScenario.nodes[0]!.data.bulkRootConfig!.recipientPolicy = {
      version: 1,
      excludePriorFailedBulkSends: true,
    };
    const missingSource = new BulkCampaignProvenanceError(
      "whatsapp_source_missing"
    );
    const enabledDeps = dependencies({
      findScenario: jest.fn().mockResolvedValue(enabledScenario),
      verifyGeneratedProvenanceCapability: jest
        .fn()
        .mockRejectedValue(missingSource),
    });
    const disabledDeps = dependencies({
      verifyGeneratedProvenanceCapability: jest
        .fn()
        .mockRejectedValue(missingSource),
    });

    const enabled =
      await createGeneratedBulkSendOrchestrator(enabledDeps)(request());
    const disabled =
      await createGeneratedBulkSendOrchestrator(disabledDeps)(request());

    expect(enabled).toEqual({
      status: 409,
      body: expect.objectContaining({
        operationDisposition: "not_started",
        code: "bulk_recipient_policy_unsupported",
      }),
    });
    expect(disabled).toEqual({
      status: 503,
      body: expect.objectContaining({
        operationDisposition: "not_started",
        code: "generated_bulk_send_retryable_failure",
      }),
    });
  });

  it.each([
    {
      name: "fingerprint safety",
      overrides: { fingerprintSecret: () => null },
      code: "bulk_campaign_safety_unavailable",
    },
    {
      name: "Temporal dispatch",
      overrides: { isTemporalConfigured: () => false },
      code: "generated_bulk_send_temporal_unavailable",
    },
  ])(
    "fails unavailable $name before irreversible progress, claim, or child writes",
    async ({ overrides, code }) => {
      const deps = dependencies(overrides);

      const result = await createGeneratedBulkSendOrchestrator(deps)(request());

      expect(result).toEqual({
        status: 503,
        body: expect.objectContaining({
          operationDisposition: "not_started",
          code,
          retryable: true,
        }),
      });
      expect(deps.prepare).toHaveBeenCalledTimes(1);
      expect(deps.compareAndSetProgress).not.toHaveBeenCalled();
      expect(deps.claimRevision).not.toHaveBeenCalled();
      expect(deps.assignPartition).not.toHaveBeenCalled();
      expect(deps.queueChild).not.toHaveBeenCalled();
      expect(deps.deleteOperationBeforeClaim).not.toHaveBeenCalled();
      expect(deps.emitPolicyEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          channel: "whatsapp",
          itemCounts: { requested: 1, accepted: 0, queued: 0 },
          uniqueRecipientCounts: { requested: 1, accepted: 0, queued: 0 },
          disposition: "failed",
          errorCode: code,
          idempotentReplay: false,
        })
      );
      expect(
        JSON.stringify((deps.emitPolicyEvent as jest.Mock).mock.calls)
      ).not.toContain(MESSAGE_ID);
    }
  );

  it("emits only aggregate policy observability and persists replay-safe facts", async () => {
    const deps = dependencies();
    const execute = createGeneratedBulkSendOrchestrator(deps);

    await execute(request());

    expect(deps.emitPolicyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        channel: "whatsapp",
        itemCounts: { requested: 1, accepted: 1, queued: 1 },
        uniqueRecipientCounts: { requested: 1, accepted: 1, queued: 1 },
        skippedByReason: {},
        idempotentReplay: false,
      })
    );
    expect(
      JSON.stringify((deps.emitPolicyEvent as jest.Mock).mock.calls)
    ).not.toContain(MESSAGE_ID);
    expect(deps.completeOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        responseBody: expect.objectContaining({
          policyEventFacts: expect.objectContaining({
            channel: "whatsapp",
            itemCounts: { requested: 1, accepted: 1, queued: 1 },
          }),
        }),
      })
    );
  });

  it("emits an aggregate generated email completion without recipient identities", async () => {
    const emailItem = {
      channel: "email",
      workspaceId: WORKSPACE_ID,
      campaignId: CAMPAIGN_ID,
      generatedRecipientMessageId: MESSAGE_ID,
      scenarioId: SCENARIO_ID,
      scenarioNodeId: "action-email",
      executionSource: "scenario_run_now",
      sentByUserId: "user-1",
      recipient: { email: "client@example.com" },
      templateKey: "announcement",
      templateModel: { body: "Hello" },
    } as BulkCampaignDispatchItem;
    const emailRow = operationRow({
      nodeId: "action-email",
      channel: "email",
      recipient: "client@example.com",
      recipientEmail: "client@example.com",
      sourceId: "email-source-1",
    });
    const deps = dependencies({
      ...withScenario({ nodes: [bulkRootNode({ channels: ["email"] })] }),
      loadRevisionPage: jest.fn().mockResolvedValue({
        rows: [emailRow],
        nextCursor: null,
      }),
      loadOperationPage: jest.fn().mockResolvedValue({
        rows: [emailRow],
        nextCursor: null,
      }),
      routeGeneratedProvenance: jest.fn().mockResolvedValue({
        routes: [],
        supportsWhatsAppTemplate: false,
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: false,
        },
      }),
      prepare: jest.fn().mockResolvedValue({
        requestedMessageIds: [MESSAGE_ID],
        partitions: [
          {
            partitionKey: "email:email-source-1:provider-1",
            channel: "email",
            sourceId: "email-source-1",
            campaignId: CAMPAIGN_ID,
            items: [emailItem],
            candidateMessageIds: [MESSAGE_ID],
            templateName: "announcement",
            templateLanguage: "en",
            messageText: "Hello",
            batchPlan: {
              batchSize: 100,
              delayMs: 1_000,
              ratePerSecond: 50,
              rateSource: "email",
            },
            requestedTotal: 1,
            skippedOptIn: 0,
            authoritativeRecipientLimit: {
              source: "channel_default",
              value: 100,
              rawLimit: "100",
            },
            policyOutcome: {
              requestedTotal: 1,
              acceptedTotal: 1,
              uniqueRecipients: { requested: 1, accepted: 1 },
              skippedByReason: {},
              warnings: { missingMarketingConsent: 0 },
              allExcluded: false,
            },
          },
        ],
        skippedByMessageId: {},
        preparationDigestVersion: 3,
        preparationDigest: "b".repeat(64),
      }),
      normalizeQueueItems: jest.fn().mockReturnValue({
        items: [emailItem],
        snapshotSeeds: [
          {
            recipientHash: "c".repeat(64),
            recipient: "email:client@example.com",
            dispatchSnapshot: emailItem,
          },
        ],
        queuedGeneratedRecipientMessageIds: [MESSAGE_ID],
        excludedGeneratedRecipientMessages: [],
      }),
      assignPartition: jest.fn().mockResolvedValue({
        campaignId: CAMPAIGN_ID,
        partitionKey: "email:email-source-1:provider-1",
        requestedCount: 1,
        matchedCount: 1,
        modifiedCount: 1,
        assigned: true,
      }),
    });

    const result = await createGeneratedBulkSendOrchestrator(deps)(request());

    expect(result.status).toBe(200);
    expect(deps.emitPolicyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        channel: "email",
        messageKind: "email",
        itemCounts: { requested: 1, accepted: 1, queued: 1 },
        uniqueRecipientCounts: { requested: 1, accepted: 1, queued: 1 },
        idempotentReplay: false,
      })
    );
    expect(
      JSON.stringify((deps.emitPolicyEvent as jest.Mock).mock.calls)
    ).not.toContain("client@example.com");
  });

  it("derives and backfills a missing generated recipient count from the exact claim", async () => {
    const deps = dependencies({
      findScenario: jest.fn().mockResolvedValue(
        scenario({
          nodes: [
            {
              id: ROOT_ID,
              data: {
                kind: "bulk",
                bulkRootConfig: {
                  workflowKind: "bulk_campaign",
                  sendMode: "immediate",
                  channels: ["whatsapp"],
                  campaignName: "Generated campaign",
                  generationStatus: "complete",
                  generationJobId: REVISION,
                },
              },
            },
            {
              id: "action-1",
              data: {
                kind: "action",
                actionType: "whatsapp_template",
              },
            },
          ],
        })
      ),
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request());

    expect(result.status).toBe(200);
    expect(deps.claimRevision).toHaveBeenCalledTimes(1);
    expect(deps.updateScenarioRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({
          generatedRecipientCount: 1,
        }),
      })
    );
    expect(result.body.scenarioUpdate).toEqual(
      expect.objectContaining({
        bulkRootConfigPatch: expect.objectContaining({
          generatedRecipientCount: 1,
        }),
      })
    );
  });

  it("rejects an explicitly corrupt generated recipient count before reservation", async () => {
    const deps = dependencies({
      ...withScenario({
        nodes: [bulkRootNode({ generatedRecipientCount: 0 })],
      }),
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request());

    expect(result.status).toBe(409);
    expect(result.body.code).toBe("generated_bulk_send_revision_corrupt");
    expect(result.body.operationDisposition).toBe("not_started");
    expect(deps.reserveOperation).not.toHaveBeenCalled();
  });

  it("rejects a past schedule only when reserving a new operation", async () => {
    const deps = dependencies({
      reserveOperation: jest.fn(async (params: Record<string, unknown>) => {
        const candidate = newReservation({ scheduledAt: REQUESTED_AT });
        const beforeCreate = params.beforeCreate as
          | ((value: ReturnType<typeof newReservation>) => Promise<void>)
          | undefined;
        await beforeCreate?.(candidate);
        return candidate;
      }),
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request({ scheduledAt: REQUESTED_AT }));

    expect(result.status).toBe(400);
    expect(result.body).toEqual(
      expect.objectContaining({
        operationDisposition: "not_started",
        error: "scheduledAt must be in the future",
      })
    );
    expect(deps.claimRevision).not.toHaveBeenCalled();
    expect(deps.deleteOperationBeforeClaim).not.toHaveBeenCalled();
  });

  it("recovers an existing operation with its immutable past schedule", async () => {
    const deps = dependencies({
      reserveOperation: jest.fn().mockResolvedValue({
        status: "acquired",
        operationId: OPERATION_ID,
        reservationToken: "lease-token",
        initiatingUserId: "user-1",
        audienceRevision: REVISION,
        requestedAt: REQUESTED_AT,
        scheduledAt: REQUESTED_AT,
        isNew: false,
        compatibilityMode: "current_v2",
        progressVersion: 0,
      }),
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request({ scheduledAt: REQUESTED_AT }));

    expect(result.status).toBe(200);
    expect(deps.claimRevision).toHaveBeenCalledTimes(1);
    expect(deps.deleteOperationBeforeClaim).not.toHaveBeenCalled();
  });

  it("replays a cached terminal operation response without resuming child work", async () => {
    const responseBody = {
      operationDisposition: "in_progress" as const,
      queued: false,
      partial: true,
      retryable: false,
      code: "generated_bulk_send_child_terminal",
      error:
        "The admitted child campaign is failed and cannot be restarted automatically.",
      failedPartitionKey: "whatsapp:source-1:phone-1",
      childDispatchStatus: "failed",
    };
    const deps = dependencies({
      reserveOperation: jest.fn().mockResolvedValue({
        status: "failed",
        operationId: OPERATION_ID,
        responseStatus: 409,
        responseBody,
      }),
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request({ idempotencyKey: "same-key" }));

    expect(result).toEqual({ status: 409, body: responseBody });
    expect(deps.claimRevision).not.toHaveBeenCalled();
    expect(deps.recoverChild).not.toHaveBeenCalled();
    expect(deps.queueChild).not.toHaveBeenCalled();
    expect(deps.emitPolicyEvent).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      factsUnavailable: "terminal_replay",
      errorCode: "bulk_campaign_terminal_replay",
      idempotentReplay: true,
    });
  });

  it("rejects an unbounded derived recipient count before loading operation rows", async () => {
    const deps = dependencies({
      findScenario: jest.fn().mockResolvedValue(
        scenario({
          nodes: [
            {
              id: ROOT_ID,
              data: {
                kind: "bulk",
                bulkRootConfig: {
                  workflowKind: "bulk_campaign",
                  sendMode: "immediate",
                  channels: ["whatsapp"],
                  campaignName: "Generated campaign",
                  generationStatus: "complete",
                  generationJobId: REVISION,
                },
              },
            },
          ],
        })
      ),
      claimRevision: jest.fn().mockResolvedValue({
        revisionCount: 3_001,
        claimedCount: 3_001,
        claimed: true,
      }),
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request());

    expect(result.status).toBe(409);
    expect(result.body.code).toBe("generated_bulk_send_revision_mismatch");
    expect(deps.loadOperationPage).not.toHaveBeenCalled();
    expect(deps.emitPolicyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        channel: "whatsapp",
        disposition: "failed",
        errorCode: "generated_bulk_send_revision_mismatch",
        idempotentReplay: false,
      })
    );
    expect(
      JSON.stringify((deps.emitPolicyEvent as jest.Mock).mock.calls)
    ).not.toContain(MESSAGE_ID);
  });

  it("assigns every same-recipient generated item through canonical normalization", async () => {
    const duplicateId = "65f000000000000000000102";
    const deps = dependencies({
      ...withScenario({
        nodes: [bulkRootNode({ generatedRecipientCount: 2 })],
      }),
      claimRevision: jest.fn().mockResolvedValue({
        revisionCount: 2,
        claimedCount: 2,
        claimed: true,
      }),
      loadOperationPage: jest.fn().mockResolvedValue({
        rows: [operationRow(), operationRow({ _id: duplicateId })],
        nextCursor: null,
      }),
      loadRevisionPage: jest.fn().mockResolvedValue({
        rows: [operationRow(), operationRow({ _id: duplicateId })],
        nextCursor: null,
      }),
      prepare: jest.fn().mockImplementation(async () => {
        const item = dispatchItem();
        return {
          requestedMessageIds: [MESSAGE_ID, duplicateId],
          partitions: [
            {
              partitionKey: "whatsapp:source-1:phone-1",
              channel: "whatsapp",
              sourceId: "source-1",
              campaignId: CAMPAIGN_ID,
              items: [item, dispatchItem(duplicateId)],
              candidateMessageIds: [MESSAGE_ID, duplicateId],
              templateName: "generated_offer",
              templateLanguage: "en",
              messageText: null,
              batchPlan: {
                batchSize: 50,
                delayMs: 1_000,
                ratePerSecond: 20,
                rateSource: "meta",
              },
              requestedTotal: 2,
              skippedOptIn: 0,
              ...currentPartitionPolicyFields(2, 2),
            },
          ],
          skippedByMessageId: {},
          whatsappPolicyFacts: currentWhatsAppPolicyFacts(2, 2),
          preparationDigestVersion: 3,
          preparationDigest: "b".repeat(64),
        };
      }),
      normalizeQueueItems: jest.fn().mockReturnValue({
        items: [dispatchItem(), dispatchItem(duplicateId)],
        snapshotSeeds: [
          {
            recipientHash: "c".repeat(64),
            recipient: "whatsapp:15550000001",
            dispatchSnapshot: dispatchItem(),
          },
          {
            recipientHash: "c".repeat(64),
            recipient: "whatsapp:15550000001",
            dispatchSnapshot: dispatchItem(duplicateId),
          },
        ],
        queuedGeneratedRecipientMessageIds: [MESSAGE_ID, duplicateId],
        excludedGeneratedRecipientMessages: [],
      }),
      queueChild: jest.fn().mockResolvedValue(
        queuedChild({
          total: 2,
          queuedGeneratedRecipientMessageIds: [MESSAGE_ID, duplicateId],
          audience: {
            fingerprint: "a".repeat(64),
            requestedTotal: 2,
            queuedTotal: 2,
            skippedOptIn: 0,
          },
        })
      ),
      verifyCoverage: jest.fn().mockResolvedValue({
        expectedCount: 2,
        ownedCount: 2,
        allRevisionOwnedCount: 2,
        queuedCount: 2,
        skippedCount: 0,
        incompleteCount: 0,
        unexpectedRevisionCount: 0,
        audience: { version: 1, count: 2, digest: "e".repeat(64) },
        audienceMatches: true,
        complete: true,
      }),
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request());

    expect(result.status).toBe(200);
    expect(deps.commitOutcomes).toHaveBeenCalledWith(
      expect.objectContaining({
        messageIds: [MESSAGE_ID, duplicateId],
        queuedByMessageId: {
          [MESSAGE_ID]: {
            campaignId: CAMPAIGN_ID,
            partitionKey: "whatsapp:source-1:phone-1",
          },
          [duplicateId]: {
            campaignId: CAMPAIGN_ID,
            partitionKey: "whatsapp:source-1:phone-1",
          },
        },
        skippedByMessageId: {},
      })
    );
    expect(deps.assignPartition).toHaveBeenCalledWith(
      expect.objectContaining({ messageIds: [MESSAGE_ID, duplicateId] })
    );
    expect(result.body.skippedRecipientCount).toBe(0);
  });

  it("returns admitted children on a later ambiguous failure and preserves confirmation fields", async () => {
    const emailMessageId = "65f000000000000000000103";
    const emailCampaignId = "99999999-9999-4999-8999-999999999999";
    const confirmFingerprint = "f".repeat(64);
    const whatsappItem = dispatchItem();
    const emailItem = {
      channel: "email",
      workspaceId: WORKSPACE_ID,
      campaignId: emailCampaignId,
      generatedRecipientMessageId: emailMessageId,
      scenarioId: SCENARIO_ID,
      scenarioNodeId: "action-email",
      executionSource: "scenario_run_now",
      sentByUserId: "user-1",
      recipient: { email: "client@example.com" },
      templateKey: "announcement",
      templateModel: { body: "Hello" },
    } as BulkCampaignDispatchItem;
    const deps = dependencies({
      ...withScenario({
        nodes: [
          bulkRootNode({
            channels: ["whatsapp", "email"],
            generatedRecipientCount: 2,
          }),
        ],
      }),
      claimRevision: jest.fn().mockResolvedValue({
        revisionCount: 2,
        claimedCount: 2,
        claimed: true,
      }),
      loadOperationPage: jest.fn().mockResolvedValue({
        rows: [
          operationRow(),
          operationRow({
            _id: emailMessageId,
            channel: "email",
            recipient: "client@example.com",
            sourceId: "email-source-1",
          }),
        ],
        nextCursor: null,
      }),
      loadRevisionPage: jest.fn().mockResolvedValue({
        rows: [
          operationRow(),
          operationRow({
            _id: emailMessageId,
            channel: "email",
            recipient: "client@example.com",
            sourceId: "email-source-1",
          }),
        ],
        nextCursor: null,
      }),
      prepare: jest.fn().mockResolvedValue({
        requestedMessageIds: [MESSAGE_ID, emailMessageId],
        partitions: [
          {
            partitionKey: "whatsapp:source-1:phone-1",
            channel: "whatsapp",
            sourceId: "source-1",
            campaignId: CAMPAIGN_ID,
            items: [whatsappItem],
            candidateMessageIds: [MESSAGE_ID],
            templateName: "generated_offer",
            templateLanguage: "en",
            messageText: null,
            batchPlan: {
              batchSize: 50,
              delayMs: 1_000,
              ratePerSecond: 20,
              rateSource: "meta",
            },
            requestedTotal: 1,
            skippedOptIn: 0,
            ...currentPartitionPolicyFields(),
          },
          {
            partitionKey: "email:email-source-1:provider-1",
            channel: "email",
            sourceId: "email-source-1",
            campaignId: emailCampaignId,
            items: [emailItem],
            candidateMessageIds: [emailMessageId],
            templateName: "announcement",
            templateLanguage: "en",
            messageText: "Generated campaign",
            batchPlan: {
              batchSize: 100,
              delayMs: 1_000,
              ratePerSecond: 50,
              rateSource: "email",
            },
            requestedTotal: 1,
            skippedOptIn: 0,
            ...currentPartitionPolicyFields(),
          },
        ],
        skippedByMessageId: {},
        whatsappPolicyFacts: currentWhatsAppPolicyFacts(),
        preparationDigestVersion: 3,
        preparationDigest: "b".repeat(64),
      }),
      normalizeQueueItems: jest
        .fn()
        .mockReturnValueOnce({
          items: [whatsappItem],
          snapshotSeeds: [
            {
              recipientHash: "1".repeat(64),
              recipient: "whatsapp:15550000001",
              dispatchSnapshot: whatsappItem,
            },
          ],
          queuedGeneratedRecipientMessageIds: [MESSAGE_ID],
          excludedGeneratedRecipientMessages: [],
        })
        .mockReturnValueOnce({
          items: [emailItem],
          snapshotSeeds: [
            {
              recipientHash: "2".repeat(64),
              recipient: "email:client@example.com",
              dispatchSnapshot: emailItem,
            },
          ],
          queuedGeneratedRecipientMessageIds: [emailMessageId],
          excludedGeneratedRecipientMessages: [],
        }),
      assignPartition: jest.fn().mockImplementation(async input => ({
        campaignId:
          input.partitionKey === "email:email-source-1:provider-1"
            ? emailCampaignId
            : CAMPAIGN_ID,
        partitionKey: input.partitionKey,
        requestedCount: input.messageIds.length,
        matchedCount: input.messageIds.length,
        modifiedCount: input.messageIds.length,
        assigned: true,
      })),
      queueChild: jest
        .fn()
        .mockResolvedValueOnce(queuedChild())
        .mockRejectedValueOnce(
          Object.assign(new Error("Confirm this audience"), {
            httpStatus: 409,
            body: {
              code: "bulk_campaign_recent_audience_confirmation_required",
              error: "Confirm sending to this recent audience again.",
              audienceConfirmation: {
                required: true,
                confirmed: false,
                fingerprint: confirmFingerprint,
              },
              audience: {
                fingerprint: confirmFingerprint,
                requestedTotal: 1,
                queuedTotal: 1,
                skippedOptIn: 0,
              },
            },
          })
        ),
      recoverChild: jest
        .fn()
        .mockResolvedValueOnce({ status: "not_admitted" })
        .mockResolvedValueOnce({ status: "not_admitted" })
        .mockResolvedValueOnce({ status: "not_admitted" }),
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request());

    expect(result.status).toBe(409);
    expect(result.body).toEqual(
      expect.objectContaining({
        operationDisposition: "in_progress",
        partial: true,
        retryable: true,
        failedPartitionKey: "email:email-source-1:provider-1",
        childrenTotal: 1,
        audienceConfirmation: {
          required: true,
          confirmed: false,
          fingerprint: confirmFingerprint,
        },
      })
    );
    expect(deps.completeOperation).not.toHaveBeenCalled();
    expect(deps.deleteOperationBeforeClaim).not.toHaveBeenCalled();
    expect(deps.emitPolicyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        channel: "whatsapp",
        itemCounts: { requested: 1, accepted: 1, queued: 1 },
        disposition: "failed",
        idempotentReplay: false,
      })
    );
    expect(deps.emitPolicyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        channel: "email",
        itemCounts: { requested: 1, accepted: 1, queued: 0 },
        disposition: "failed",
        idempotentReplay: false,
      })
    );
  });

  it("returns an admitted child when Temporal recovery remains unconfirmed", async () => {
    const admitted = admittedChildRecovery();
    const deps = dependencies({
      queueChild: jest.fn().mockRejectedValue(new Error("connection lost")),
      recoverChild: jest
        .fn()
        .mockResolvedValueOnce({ status: "not_admitted" })
        .mockResolvedValueOnce(admitted),
      ensureRecoveredChildStarted: jest
        .fn()
        .mockRejectedValue(new Error("Temporal start is unconfirmed")),
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request());

    expect(result.status).toBe(503);
    expect(result.body).toEqual(
      expect.objectContaining({
        partial: true,
        retryable: true,
        code: "generated_bulk_send_workflow_start_unconfirmed",
        total: 1,
        childrenTotal: 1,
        failedPartitionKey: "whatsapp:source-1:phone-1",
      })
    );
    expect(deps.commitOutcomes).toHaveBeenCalledWith(
      expect.objectContaining({
        queuedByMessageId: {
          [MESSAGE_ID]: {
            campaignId: CAMPAIGN_ID,
            partitionKey: "whatsapp:source-1:phone-1",
          },
        },
      })
    );
    expect(deps.completeOperation).not.toHaveBeenCalled();
    expect(deps.emitPolicyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        channel: "whatsapp",
        itemCounts: { requested: 1, accepted: 1, queued: 1 },
        disposition: "failed",
        errorCode: "generated_bulk_send_workflow_start_unconfirmed",
        idempotentReplay: false,
      })
    );
    expect(
      JSON.stringify((deps.emitPolicyEvent as jest.Mock).mock.calls)
    ).not.toContain(MESSAGE_ID);
  });

  it("fails closed when recovery reveals a terminal child", async () => {
    const expired = admittedChildRecovery("expired");
    const ensureStarted = jest.fn().mockRejectedValue(
      Object.assign(new Error("Campaign expired before start"), {
        httpStatus: 409,
        body: {
          code: "bulk_campaign_dispatch_expired",
          error:
            "This bulk campaign command expired before dispatch could start.",
          retryable: false,
          campaignId: CAMPAIGN_ID,
          dispatchId: CAMPAIGN_ID,
        },
      })
    );
    const recoverChild = jest
      .fn()
      .mockResolvedValueOnce(admittedChildRecovery())
      .mockResolvedValueOnce(expired);
    const row = operationRow({
      campaignId: CAMPAIGN_ID,
      sendPartitionKey: "whatsapp:source-1:phone-1",
    });
    const deps = dependencies({
      reserveOperation: jest
        .fn()
        .mockResolvedValue(resumedPreparedReservation()),
      loadOperationPage: jest.fn().mockResolvedValue({
        rows: [row],
        nextCursor: null,
      }),
      recoverChild,
      ensureRecoveredChildStarted: ensureStarted,
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request());

    expect(result.status).toBe(409);
    expect(result.body).toEqual(
      expect.objectContaining({
        operationDisposition: "in_progress",
        code: "generated_bulk_send_child_terminal",
        retryable: false,
        partial: true,
        queued: false,
        failedPartitionKey: "whatsapp:source-1:phone-1",
        childDispatchStatus: "expired",
        children: [
          expect.objectContaining({
            campaignId: CAMPAIGN_ID,
            status: "expired",
          }),
        ],
      })
    );
    expect(recoverChild).toHaveBeenCalledTimes(2);
    expect(deps.commitOutcomes).not.toHaveBeenCalled();
    expect(deps.completeOperation).not.toHaveBeenCalled();
    expect(
      (deps.renewOperationLease as jest.Mock).mock.invocationCallOrder[0]
    ).toBeLessThan(ensureStarted.mock.invocationCallOrder[0]);
  });

  it("persists and emits current-v2 aggregate facts when a recovered child is terminal", async () => {
    const policyFields = currentPartitionPolicyFields();
    const fact = {
      ...generatedRecoveryFact(),
      policyFacts: {
        authoritativeRecipientLimit: policyFields.authoritativeRecipientLimit,
        outcome: policyFields.policyOutcome,
      },
    };
    const row = operationRow({
      campaignId: CAMPAIGN_ID,
      sendPartitionKey: fact.partitionKey,
    });
    const deps = dependencies({
      reserveOperation: jest.fn().mockResolvedValue(
        resumedPreparedReservation({
          compatibilityMode: "current_v2",
          recipientPolicy: {
            version: 1,
            excludePriorFailedBulkSends: false,
          },
          requestDigestVersion: 2,
          progressBody: {
            version: 1,
            phase: "prepared",
            preparationDigestVersion: 3,
            preparationDigest: "b".repeat(64),
            recoveryFacts: [fact],
            admittedChildrenCount: 1,
            queuedCount: 1,
            skippedCount: 0,
            lastPartitionKey: fact.partitionKey,
            recipientPolicy: {
              version: 1,
              excludePriorFailedBulkSends: false,
            },
            whatsappPolicyFacts: currentWhatsAppPolicyFacts(),
          },
        })
      ),
      loadOperationPage: jest.fn().mockResolvedValue({
        rows: [row],
        nextCursor: null,
      }),
      recoverChild: jest.fn().mockResolvedValue(admittedChildRecovery()),
      ensureRecoveredChildStarted: jest.fn().mockResolvedValue({
        status: "terminal",
        dispatchStatus: "failed",
        temporalDispatchStaging: "existing",
      }),
    });

    const result = await createGeneratedBulkSendOrchestrator(deps)(request());

    expect(result.status).toBe(409);
    expect(deps.failOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        responseBody: expect.objectContaining({
          policyEventFacts: expect.objectContaining({
            channel: "whatsapp",
            itemCounts: { requested: 1, accepted: 1, queued: 1 },
            disposition: "failed",
            lifecycleStatus: "failed",
            errorCode: "generated_bulk_send_child_terminal",
          }),
        }),
      })
    );
    expect(deps.emitPolicyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        channel: "whatsapp",
        itemCounts: { requested: 1, accepted: 1, queued: 1 },
        disposition: "failed",
        lifecycleStatus: "failed",
        errorCode: "generated_bulk_send_child_terminal",
        idempotentReplay: false,
      })
    );
  });

  it("uses the immutable request time and terminal-skips an expired unassigned command", async () => {
    const deps = dependencies({
      now: () => new Date("2026-07-27T10:16:00.000Z"),
      loadOperationPage: jest
        .fn()
        .mockResolvedValueOnce({
          rows: [operationRow()],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          rows: [
            operationRow({
              sendStatus: "skipped",
              skipReason: "dispatch_expired",
              skipDetail: "2026-07-27T10:15:00.000Z",
              error:
                "Generated send skipped: dispatch_expired (2026-07-27T10:15:00.000Z)",
            }),
          ],
          nextCursor: null,
        }),
      verifyCoverage: jest.fn().mockResolvedValue({
        expectedCount: 1,
        ownedCount: 1,
        allRevisionOwnedCount: 1,
        queuedCount: 0,
        skippedCount: 1,
        incompleteCount: 0,
        unexpectedRevisionCount: 0,
        audience: { version: 1, count: 1, digest: "e".repeat(64) },
        audienceMatches: true,
        complete: true,
      }),
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request());

    expect(result.status).toBe(200);
    expect(deps.queueChild).not.toHaveBeenCalled();
    expect(deps.commitOutcomes).toHaveBeenCalledWith(
      expect.objectContaining({
        skippedByMessageId: {
          [MESSAGE_ID]: {
            reason: "dispatch_expired",
            detail: "2026-07-27T10:15:00.000Z",
          },
        },
      })
    );
    expect(result.body).toEqual(
      expect.objectContaining({
        operationDisposition: "completed",
        queued: false,
        noOp: true,
        total: 0,
        skippedRecipientCount: 1,
        message:
          "No campaign was queued because every generated recipient was skipped.",
      })
    );
    expect(deps.emitPolicyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        channel: "whatsapp",
        itemCounts: { requested: 1, accepted: 1, queued: 0 },
        uniqueRecipientCounts: { requested: 1, accepted: 1, queued: 0 },
        disposition: "blocked",
        lifecycleStatus: "expired",
        errorCode: "bulk_campaign_dispatch_expired",
        idempotentReplay: false,
      })
    );
  });

  it("completes exact coverage as a no-op when preparation skips every recipient", async () => {
    const scheduledAt = "2026-07-27T10:05:00.000Z";
    const deps = dependencies({
      reserveOperation: jest.fn().mockResolvedValue({
        status: "acquired",
        operationId: OPERATION_ID,
        reservationToken: "lease-token",
        initiatingUserId: "user-1",
        audienceRevision: REVISION,
        requestedAt: REQUESTED_AT,
        scheduledAt,
        isNew: true,
        compatibilityMode: "current_v2",
        progressVersion: 0,
      }),
      prepare: jest.fn().mockResolvedValue({
        requestedMessageIds: [MESSAGE_ID],
        partitions: [],
        skippedByMessageId: {
          [MESSAGE_ID]: {
            reason: "marketing_opt_out",
            detail: null,
          },
        },
        whatsappPolicyFacts: currentWhatsAppPolicyFacts(1, 0, {
          marketing_opt_out: 1,
        }),
        preparationDigestVersion: 3,
        preparationDigest: "8".repeat(64),
      }),
      loadOperationPage: jest
        .fn()
        .mockResolvedValueOnce({
          rows: [operationRow()],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          rows: [
            operationRow({
              sendStatus: "skipped",
              skipReason: "marketing_opt_out",
              skipDetail: null,
              error: "Generated send skipped: marketing_opt_out",
            }),
          ],
          nextCursor: null,
        }),
      verifyCoverage: jest.fn().mockResolvedValue({
        expectedCount: 1,
        ownedCount: 1,
        allRevisionOwnedCount: 1,
        queuedCount: 0,
        skippedCount: 1,
        incompleteCount: 0,
        unexpectedRevisionCount: 0,
        audience: { version: 1, count: 1, digest: "e".repeat(64) },
        audienceMatches: true,
        complete: true,
      }),
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request());

    expect(result.status).toBe(200);
    expect(deps.commitOutcomes).toHaveBeenCalledWith(
      expect.objectContaining({
        messageIds: [MESSAGE_ID],
        queuedByMessageId: {},
        skippedByMessageId: {
          [MESSAGE_ID]: {
            reason: "marketing_opt_out",
          },
        },
      })
    );
    expect(deps.verifyCoverage).toHaveBeenCalledTimes(1);
    expect(deps.queueChild).not.toHaveBeenCalled();
    expect(result.body).toEqual(
      expect.objectContaining({
        queued: false,
        noOp: true,
        scheduled: false,
        scheduledAt,
        total: 0,
        requestedTotal: 1,
        skippedRecipientCount: 1,
        childrenTotal: 0,
      })
    );
  });

  it.each([
    ["whatsapp_marketing_opt_out", "marketing_opt_out"],
    ["whatsapp_conversation_history_required", "ineligible"],
  ])(
    "canonicalizes legacy-v1-disabled %s only in no-op observability",
    async (legacySkipReason, canonicalSkipReason) => {
      const deps = dependencies({
        reserveOperation: jest.fn().mockResolvedValue(
          newReservation({
            isNew: false,
            compatibilityMode: "legacy_v1_disabled",
            recipientPolicy: {
              version: 1,
              excludePriorFailedBulkSends: false,
            },
            progressVersion: 0,
          })
        ),
        prepare: jest.fn().mockResolvedValue({
          requestedMessageIds: [MESSAGE_ID],
          partitions: [],
          skippedByMessageId: {
            [MESSAGE_ID]: { reason: legacySkipReason, detail: null },
          },
          preparationDigestVersion: 2,
          preparationDigest: "8".repeat(64),
        }),
        loadOperationPage: jest
          .fn()
          .mockResolvedValueOnce({
            rows: [operationRow()],
            nextCursor: null,
          })
          .mockResolvedValueOnce({
            rows: [
              operationRow({
                sendStatus: "skipped",
                skipReason: legacySkipReason,
                skipDetail: null,
                error: `Generated send skipped: ${legacySkipReason}`,
              }),
            ],
            nextCursor: null,
          }),
        verifyCoverage: jest.fn().mockResolvedValue({
          expectedCount: 1,
          ownedCount: 1,
          allRevisionOwnedCount: 1,
          queuedCount: 0,
          skippedCount: 1,
          incompleteCount: 0,
          unexpectedRevisionCount: 0,
          audience: { version: 1, count: 1, digest: "e".repeat(64) },
          audienceMatches: true,
          complete: true,
        }),
      });

      const result = await createGeneratedBulkSendOrchestrator(deps)(request());

      expect(result).toEqual({
        status: 200,
        body: expect.objectContaining({
          noOp: true,
          skippedRecipientCount: 1,
          policyEventFacts: expect.objectContaining({
            itemCounts: { requested: 1, accepted: 0, queued: 0 },
            skippedByReason: { [canonicalSkipReason]: 1 },
            disposition: "no_op",
          }),
        }),
      });
      expect(deps.emitPolicyEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          itemCounts: { requested: 1, accepted: 0, queued: 0 },
          skippedByReason: { [canonicalSkipReason]: 1 },
          disposition: "no_op",
          idempotentReplay: false,
        })
      );
      expect(
        JSON.stringify((deps.emitPolicyEvent as jest.Mock).mock.calls)
      ).not.toContain(MESSAGE_ID);
      expect(deps.queueChild).not.toHaveBeenCalled();
    }
  );

  it("reconciles an assigned admitted child before calling mutable preparation", async () => {
    const row = operationRow({
      campaignId: CAMPAIGN_ID,
      sendPartitionKey: "whatsapp:source-1:phone-1",
    });
    const deps = dependencies({
      reserveOperation: jest
        .fn()
        .mockResolvedValue(resumedPreparedReservation()),
      loadOperationPage: jest.fn().mockResolvedValue({
        rows: [row],
        nextCursor: null,
      }),
      recoverChild: jest.fn().mockResolvedValue(admittedChildRecovery()),
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request());

    expect(result.status).toBe(200);
    expect(deps.recoverChild).toHaveBeenCalledTimes(1);
    expect(deps.recoverChild).toHaveBeenCalledWith(
      expect.objectContaining({ expectedPolicyMetadata: null })
    );
    expect(deps.ensureRecoveredChildStarted).toHaveBeenCalledTimes(1);
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.queueChild).not.toHaveBeenCalled();
    expect(result.body.childrenTotal).toBe(1);
    expect(deps.completeOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        responseBody: expect.objectContaining({
          policyEventFacts: expect.objectContaining({
            channel: "whatsapp",
            itemCounts: { requested: 1, accepted: 1, queued: 1 },
            planLimit: { source: "unavailable", value: null },
            policy: {
              version: 1,
              excludePriorFailedBulkSends: false,
            },
          }),
        }),
      })
    );
    expect(deps.emitPolicyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        channel: "whatsapp",
        itemCounts: { requested: 1, accepted: 1, queued: 1 },
        planLimit: { source: "unavailable", value: null },
        policy: {
          version: 1,
          excludePriorFailedBulkSends: false,
        },
        idempotentReplay: false,
      })
    );
    expect(
      JSON.stringify((deps.emitPolicyEvent as jest.Mock).mock.calls)
    ).not.toContain(MESSAGE_ID);
  });

  it.each([
    {
      name: "global policy facts",
      progressOverride: { whatsappPolicyFacts: {} },
    },
    {
      name: "over-cap aggregate counts",
      progressOverride: { queuedCount: 3_001 },
    },
  ])(
    "rejects malformed active current-v2 $name before claim or child work",
    async ({ progressOverride }) => {
      const policyFields = currentPartitionPolicyFields();
      const fact = {
        ...generatedRecoveryFact(),
        policyFacts: {
          authoritativeRecipientLimit: policyFields.authoritativeRecipientLimit,
          outcome: policyFields.policyOutcome,
        },
      };
      const deps = dependencies({
        reserveOperation: jest.fn().mockResolvedValue(
          resumedPreparedReservation({
            compatibilityMode: "current_v2",
            recipientPolicy: {
              version: 1,
              excludePriorFailedBulkSends: false,
            },
            requestDigestVersion: 2,
            progressBody: {
              version: 1,
              phase: "prepared",
              preparationDigestVersion: 3,
              preparationDigest: "b".repeat(64),
              recoveryFacts: [fact],
              admittedChildrenCount: 0,
              queuedCount: 0,
              skippedCount: 0,
              lastPartitionKey: null,
              recipientPolicy: {
                version: 1,
                excludePriorFailedBulkSends: false,
              },
              whatsappPolicyFacts: currentWhatsAppPolicyFacts(),
              ...progressOverride,
            },
          })
        ),
      });

      const result = await createGeneratedBulkSendOrchestrator(deps)(request());

      expect(result).toEqual({
        status: 503,
        body: expect.objectContaining({
          operationDisposition: "in_progress",
          code: "generated_bulk_send_progress_invalid",
          retryable: true,
        }),
      });
      expect(deps.claimRevision).not.toHaveBeenCalled();
      expect(deps.loadOperationPage).not.toHaveBeenCalled();
      expect(deps.recoverChild).not.toHaveBeenCalled();
      expect(deps.queueChild).not.toHaveBeenCalled();
    }
  );

  it("binds current-v2 recovered children to the exact canonical five-key metadata group", async () => {
    const row = operationRow({
      campaignId: CAMPAIGN_ID,
      sendPartitionKey: "whatsapp:source-1:phone-1",
    });
    const policyFields = currentPartitionPolicyFields();
    const fact = {
      ...generatedRecoveryFact(),
      policyFacts: {
        authoritativeRecipientLimit: policyFields.authoritativeRecipientLimit,
        outcome: policyFields.policyOutcome,
      },
    };
    const deps = dependencies({
      reserveOperation: jest.fn().mockResolvedValue(
        resumedPreparedReservation({
          compatibilityMode: "current_v2",
          requestDigestVersion: 2,
          progressBody: {
            version: 1,
            phase: "prepared",
            preparationDigestVersion: 3,
            preparationDigest: "b".repeat(64),
            recoveryFacts: [fact],
            admittedChildrenCount: 0,
            queuedCount: 0,
            skippedCount: 0,
            lastPartitionKey: null,
            recipientPolicy: {
              version: 1,
              excludePriorFailedBulkSends: false,
            },
            whatsappPolicyFacts: currentWhatsAppPolicyFacts(),
          },
        })
      ),
      loadOperationPage: jest.fn().mockResolvedValue({
        rows: [row],
        nextCursor: null,
      }),
      recoverChild: jest.fn().mockResolvedValue(admittedChildRecovery()),
    });

    const result = await createGeneratedBulkSendOrchestrator(deps)(request());

    expect(result.status).toBe(200);
    expect(deps.recoverChild).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPolicyMetadata: {
          policy: { version: 1, excludePriorFailedBulkSends: false },
          authoritativeRecipientLimit: policyFields.authoritativeRecipientLimit,
          outcome: {
            evaluatedAt: REQUESTED_AT,
            requestedTotal: 1,
            acceptedTotal: 1,
            uniqueRecipients: { requested: 1, accepted: 1 },
            skippedByReason: {},
            warnings: { missingMarketingConsent: 0 },
          },
          batchPlan: fact.batchPlan,
          requestDigest: { version: 1, digest: "f".repeat(64) },
        },
      })
    );
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.queueChild).not.toHaveBeenCalled();
  });

  it("resumes a partial current-v2 operation with its immutable policy after the root policy changes", async () => {
    const changedScenario = scenario();
    changedScenario.nodes[0]!.data.bulkRootConfig!.recipientPolicy = {
      version: 1,
      excludePriorFailedBulkSends: true,
    };
    const policyFields = currentPartitionPolicyFields();
    const fact = {
      ...generatedRecoveryFact(),
      policyFacts: {
        authoritativeRecipientLimit: policyFields.authoritativeRecipientLimit,
        outcome: policyFields.policyOutcome,
      },
    };
    const deps = dependencies({
      findScenario: jest.fn().mockResolvedValue(changedScenario),
      reserveOperation: jest.fn().mockResolvedValue(
        resumedPreparedReservation({
          compatibilityMode: "current_v2",
          recipientPolicy: {
            version: 1,
            excludePriorFailedBulkSends: false,
          },
          requestDigestVersion: 2,
          progressBody: {
            version: 1,
            phase: "prepared",
            preparationDigestVersion: 3,
            preparationDigest: "b".repeat(64),
            recoveryFacts: [fact],
            admittedChildrenCount: 1,
            queuedCount: 1,
            skippedCount: 0,
            lastPartitionKey: fact.partitionKey,
            recipientPolicy: {
              version: 1,
              excludePriorFailedBulkSends: false,
            },
            whatsappPolicyFacts: currentWhatsAppPolicyFacts(),
          },
        })
      ),
      loadOperationPage: jest.fn().mockResolvedValue({
        rows: [
          operationRow({
            campaignId: CAMPAIGN_ID,
            sendPartitionKey: fact.partitionKey,
          }),
        ],
        nextCursor: null,
      }),
      recoverChild: jest.fn().mockResolvedValue(admittedChildRecovery()),
    });

    const result = await createGeneratedBulkSendOrchestrator(deps)(request());

    expect(result.status).toBe(200);
    expect(deps.recoverChild).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPolicyMetadata: expect.objectContaining({
          policy: {
            version: 1,
            excludePriorFailedBulkSends: false,
          },
        }),
      })
    );
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.queueChild).not.toHaveBeenCalled();
  });

  it("reprepares the full persisted operation universe when current work resumes", async () => {
    const skippedMessageId = "65f000000000000000000102";
    const resumedScenario = scenario();
    resumedScenario.nodes[0]!.data.bulkRootConfig!.generatedRecipientCount = 2;
    const prepare = jest
      .fn()
      .mockRejectedValue(new Error("stop after full-row reconciliation"));
    const deps = dependencies({
      findScenario: jest.fn().mockResolvedValue(resumedScenario),
      reserveOperation: jest.fn().mockResolvedValue(
        resumedPreparedReservation({
          compatibilityMode: "current_v2",
          requestDigestVersion: 2,
          progressBody: {
            version: 1,
            phase: "prepared",
            preparationDigestVersion: 3,
            preparationDigest: "b".repeat(64),
            recoveryFacts: [],
            admittedChildrenCount: 0,
            queuedCount: 0,
            skippedCount: 1,
            lastPartitionKey: null,
            recipientPolicy: {
              version: 1,
              excludePriorFailedBulkSends: false,
            },
            whatsappPolicyFacts: {
              policy: {
                version: 1,
                excludePriorFailedBulkSends: false,
              },
              authoritativeRecipientLimit: {
                source: "live_meta",
                value: 100,
                rawLimit: "100",
              },
              outcome: {
                requestedTotal: 2,
                acceptedTotal: 1,
                uniqueRecipients: { requested: 2, accepted: 1 },
                skippedByReason: { ineligible: 1 },
                warnings: { missingMarketingConsent: 0 },
                allExcluded: false,
              },
            },
          },
        })
      ),
      claimRevision: jest.fn().mockResolvedValue({
        workspaceId: WORKSPACE_ID,
        scenarioId: SCENARIO_ID,
        audienceRevision: REVISION,
        operationId: OPERATION_ID,
        revisionCount: 2,
        claimedCount: 2,
        matchedCount: 2,
        modifiedCount: 0,
        claimed: true,
      }),
      loadOperationPage: jest.fn().mockResolvedValue({
        rows: [
          operationRow({
            _id: skippedMessageId,
            sendStatus: "skipped",
            skipReason: "ineligible",
          }),
          operationRow(),
        ],
        nextCursor: null,
      }),
      prepare,
    });

    const result = await createGeneratedBulkSendOrchestrator(deps)(request());

    expect(result).toEqual({
      status: 503,
      body: expect.objectContaining({
        operationDisposition: "in_progress",
        error: "stop after full-row reconciliation",
      }),
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        digestMode: "current_v3",
        messages: [
          expect.objectContaining({
            _id: skippedMessageId,
            sendStatus: "skipped",
          }),
          expect.objectContaining({ _id: MESSAGE_ID, sendStatus: "preparing" }),
        ],
      })
    );
  });

  it("counts a reproduced persisted skip once in a resumed partial response", async () => {
    const skippedMessageId = "65f000000000000000000102";
    const resumedScenario = scenario();
    resumedScenario.nodes[0]!.data.bulkRootConfig!.generatedRecipientCount = 2;
    const policyFields = currentPartitionPolicyFields();
    const fact = {
      ...generatedRecoveryFact(),
      audience: advanceGeneratedRecipientAudience(
        createGeneratedRecipientAudience(),
        [MESSAGE_ID]
      ),
      policyFacts: {
        authoritativeRecipientLimit: policyFields.authoritativeRecipientLimit,
        outcome: policyFields.policyOutcome,
      },
    };
    const deps = dependencies({
      findScenario: jest.fn().mockResolvedValue(resumedScenario),
      reserveOperation: jest.fn().mockResolvedValue(
        resumedPreparedReservation({
          compatibilityMode: "current_v2",
          recipientPolicy: {
            version: 1,
            excludePriorFailedBulkSends: false,
          },
          requestDigestVersion: 2,
          progressBody: {
            version: 1,
            phase: "prepared",
            preparationDigestVersion: 3,
            preparationDigest: "b".repeat(64),
            recoveryFacts: [fact],
            admittedChildrenCount: 0,
            queuedCount: 0,
            skippedCount: 1,
            lastPartitionKey: null,
            recipientPolicy: {
              version: 1,
              excludePriorFailedBulkSends: false,
            },
            whatsappPolicyFacts: currentWhatsAppPolicyFacts(2, 1, {
              marketing_opt_out: 1,
            }),
          },
        })
      ),
      claimRevision: jest.fn().mockResolvedValue({
        revisionCount: 2,
        claimedCount: 2,
        claimed: true,
      }),
      loadOperationPage: jest.fn().mockResolvedValue({
        rows: [
          operationRow(),
          operationRow({
            _id: skippedMessageId,
            recipient: "15550000002",
            sendStatus: "skipped",
            skipReason: "marketing_opt_out",
            skipDetail: null,
            error: "Generated send skipped: marketing_opt_out",
          }),
        ],
        nextCursor: null,
      }),
      prepare: jest.fn().mockResolvedValue({
        requestedMessageIds: [MESSAGE_ID, skippedMessageId],
        partitions: [
          {
            partitionKey: fact.partitionKey,
            channel: "whatsapp",
            sourceId: "source-1",
            campaignId: CAMPAIGN_ID,
            items: [dispatchItem()],
            candidateMessageIds: [MESSAGE_ID],
            templateName: "generated_offer",
            templateLanguage: "en",
            messageText: null,
            batchPlan: fact.batchPlan,
            requestedTotal: 1,
            skippedOptIn: 0,
            ...policyFields,
          },
        ],
        skippedByMessageId: {
          [skippedMessageId]: { reason: "marketing_opt_out", detail: null },
        },
        whatsappPolicyFacts: currentWhatsAppPolicyFacts(2, 1, {
          marketing_opt_out: 1,
        }),
        preparationDigestVersion: 3,
        preparationDigest: "b".repeat(64),
      }),
      queueChild: jest.fn().mockRejectedValue(
        Object.assign(new Error("temporary admission failure"), {
          httpStatus: 503,
          body: {
            code: "bulk_campaign_dispatch_unavailable",
            error: "Bulk campaign dispatch is unavailable.",
            retryable: true,
          },
        })
      ),
    });

    const result = await createGeneratedBulkSendOrchestrator(deps)(request());

    expect(result.status).toBe(503);
    expect(result.body).toEqual(
      expect.objectContaining({
        operationDisposition: "in_progress",
        requestedTotal: 2,
        skippedRecipientCount: 1,
      })
    );
  });

  it.each(["failed", "expired", "cancelled"] as const)(
    "does not queue or complete a recovered %s child",
    async dispatchStatus => {
      const row = operationRow({
        campaignId: CAMPAIGN_ID,
        sendPartitionKey: "whatsapp:source-1:phone-1",
      });
      const ensureStarted = jest.fn().mockResolvedValue({
        status: "terminal",
        dispatchStatus,
        temporalDispatchStaging: "existing",
      });
      const failOperation = jest.fn().mockResolvedValue(true);
      const releaseOperationLease = jest.fn().mockResolvedValue(true);
      const deps = dependencies({
        reserveOperation: jest
          .fn()
          .mockResolvedValue(resumedPreparedReservation()),
        loadOperationPage: jest.fn().mockResolvedValue({
          rows: [row],
          nextCursor: null,
        }),
        recoverChild: jest
          .fn()
          .mockResolvedValue(admittedChildRecovery(dispatchStatus)),
        ensureRecoveredChildStarted: ensureStarted,
        failOperation,
        releaseOperationLease,
      });
      const execute = createGeneratedBulkSendOrchestrator(deps);

      const result = await execute(request());

      expect(result.status).toBe(409);
      expect(result.body).toEqual(
        expect.objectContaining({
          operationDisposition: "in_progress",
          queued: false,
          partial: true,
          retryable: false,
          code: "generated_bulk_send_child_terminal",
          failedPartitionKey: "whatsapp:source-1:phone-1",
          childDispatchStatus: dispatchStatus,
          children: [
            expect.objectContaining({
              campaignId: CAMPAIGN_ID,
              status: dispatchStatus,
            }),
          ],
        })
      );
      expect(ensureStarted).toHaveBeenCalledTimes(1);
      expect(deps.commitOutcomes).not.toHaveBeenCalled();
      expect(deps.updateScenarioRevision).not.toHaveBeenCalled();
      expect(deps.completeOperation).not.toHaveBeenCalled();
      expect(failOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          scenarioId: SCENARIO_ID,
          operationId: OPERATION_ID,
          reservationToken: "lease-token",
          responseStatus: 409,
          responseBody: expect.objectContaining({
            operationDisposition: "in_progress",
            code: "generated_bulk_send_child_terminal",
            childDispatchStatus: dispatchStatus,
          }),
        })
      );
      expect(releaseOperationLease).not.toHaveBeenCalled();
    }
  );

  it("accepts an already completed recovered child without restarting it", async () => {
    const row = operationRow({
      campaignId: CAMPAIGN_ID,
      sendPartitionKey: "whatsapp:source-1:phone-1",
    });
    const ensureStarted = jest.fn().mockResolvedValue({
      status: "terminal",
      dispatchStatus: "completed",
      temporalDispatchStaging: "existing",
    });
    const deps = dependencies({
      reserveOperation: jest
        .fn()
        .mockResolvedValue(resumedPreparedReservation()),
      loadOperationPage: jest.fn().mockResolvedValue({
        rows: [row],
        nextCursor: null,
      }),
      recoverChild: jest
        .fn()
        .mockResolvedValue(admittedChildRecovery("completed")),
      ensureRecoveredChildStarted: ensureStarted,
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request());

    expect(result.status).toBe(200);
    expect(result.body).toEqual(
      expect.objectContaining({
        operationDisposition: "completed",
        queued: true,
        children: [
          expect.objectContaining({
            campaignId: CAMPAIGN_ID,
            status: "completed",
          }),
        ],
      })
    );
    expect(ensureStarted).toHaveBeenCalledTimes(1);
    expect(deps.queueChild).not.toHaveBeenCalled();
    expect(deps.commitOutcomes).toHaveBeenCalledTimes(1);
    expect(deps.completeOperation).toHaveBeenCalledTimes(1);
  });

  it("fails closed when an unassigned persisted partition disappears during resume", async () => {
    const deps = dependencies({
      reserveOperation: jest
        .fn()
        .mockResolvedValue(resumedPreparedReservation()),
      prepare: jest.fn().mockResolvedValue({
        requestedMessageIds: [MESSAGE_ID],
        partitions: [],
        skippedByMessageId: {
          [MESSAGE_ID]: {
            reason: "source_unavailable",
            detail: "Source disappeared",
          },
        },
        preparationDigestVersion: 2,
        preparationDigest: "9".repeat(64),
      }),
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request());

    expect(result.status).toBe(503);
    expect(result.body).toEqual(
      expect.objectContaining({
        code: "generated_bulk_send_retryable_failure",
        error: "Generated send preparation changed after operation binding",
        retryable: true,
      })
    );
    expect(deps.commitOutcomes).not.toHaveBeenCalled();
    expect(deps.completeOperation).not.toHaveBeenCalled();
  });

  it("fails closed when reproduced preparation digest changes despite matching partition facts", async () => {
    const persistedOutcome = {
      requestedTotal: 1,
      acceptedTotal: 0,
      uniqueRecipients: { requested: 1, accepted: 0 },
      skippedByReason: { ineligible: 1 },
      warnings: { missingMarketingConsent: 0 },
      allExcluded: true,
    };
    const deps = dependencies({
      reserveOperation: jest.fn().mockResolvedValue(
        resumedPreparedReservation({
          compatibilityMode: "current_v2",
          requestDigestVersion: 2,
          progressBody: {
            version: 1,
            phase: "prepared",
            preparationDigestVersion: 3,
            preparationDigest: "b".repeat(64),
            recoveryFacts: [],
            admittedChildrenCount: 0,
            queuedCount: 0,
            skippedCount: 1,
            lastPartitionKey: null,
            recipientPolicy: {
              version: 1,
              excludePriorFailedBulkSends: false,
            },
            whatsappPolicyFacts: {
              policy: {
                version: 1,
                excludePriorFailedBulkSends: false,
              },
              outcome: persistedOutcome,
            },
          },
        })
      ),
      prepare: jest.fn().mockResolvedValue({
        requestedMessageIds: [MESSAGE_ID],
        partitions: [],
        skippedByMessageId: {
          [MESSAGE_ID]: { reason: "ineligible", detail: null },
        },
        whatsappPolicyFacts: {
          policy: { version: 1, excludePriorFailedBulkSends: false },
          outcome: persistedOutcome,
        },
        preparationDigestVersion: 3,
        preparationDigest: "9".repeat(64),
      }),
    });

    const result = await createGeneratedBulkSendOrchestrator(deps)(request());

    expect(result).toEqual({
      status: 503,
      body: expect.objectContaining({
        operationDisposition: "in_progress",
        code: "generated_bulk_send_retryable_failure",
        error: "Generated send preparation changed after operation binding",
      }),
    });
    expect(deps.assignPartition).not.toHaveBeenCalled();
    expect(deps.queueChild).not.toHaveBeenCalled();
    expect(deps.commitOutcomes).not.toHaveBeenCalled();
  });

  it("repairs the narrow Scenario marker on completed replay", async () => {
    const cached = completedReplayResponseWithPolicyFacts();
    const deps = dependencies({
      reserveOperation: jest.fn().mockResolvedValue({
        status: "completed",
        operationId: OPERATION_ID,
        responseBody: cached,
      }),
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(
      request({ idempotencyKey: "same-browser-attempt" })
    );

    expect(result.status).toBe(200);
    expect(result.body.idempotentReplay).toBe(true);
    expect(deps.emitPolicyEvent).toHaveBeenCalledWith({
      ...cached.policyEventFacts,
      workspaceId: WORKSPACE_ID,
      idempotentReplay: true,
    });
    expect(
      JSON.stringify((deps.emitPolicyEvent as jest.Mock).mock.calls)
    ).not.toContain(MESSAGE_ID);
    expect(deps.updateScenarioRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: {
          ...cached.scenarioUpdate.bulkRootConfigPatch,
          generatedRecipientCount: 1,
        },
      })
    );
    expect(deps.claimRevision).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "returns a conflict",
      updateScenarioRevision: jest.fn().mockResolvedValue({
        updated: false,
        scenarioUpdatedAt: "2026-07-27T10:02:00.000Z",
      }),
    },
    {
      name: "throws",
      updateScenarioRevision: jest
        .fn()
        .mockRejectedValue(new Error("Scenario repair unavailable")),
    },
  ])(
    "emits persisted replay facts when completed Scenario repair $name",
    async ({ updateScenarioRevision }) => {
      const cached = completedReplayResponseWithPolicyFacts();
      const deps = dependencies({
        reserveOperation: jest.fn().mockResolvedValue({
          status: "completed",
          operationId: OPERATION_ID,
          responseBody: cached,
        }),
        updateScenarioRevision,
      });

      const result = await createGeneratedBulkSendOrchestrator(deps)(request());

      expect(result).toEqual({
        status: 503,
        body: expect.objectContaining({
          operationDisposition: "completed",
          code: "generated_bulk_send_scenario_repair_failed",
          retryable: true,
        }),
      });
      expect(deps.emitPolicyEvent).toHaveBeenCalledWith({
        ...cached.policyEventFacts,
        workspaceId: WORKSPACE_ID,
        idempotentReplay: true,
      });
      expect(
        JSON.stringify((deps.emitPolicyEvent as jest.Mock).mock.calls)
      ).not.toContain(MESSAGE_ID);
      expect(deps.claimRevision).not.toHaveBeenCalled();
    }
  );

  it("refuses a generated send larger than the free bulk recipients left", async () => {
    const capacity = (bulkRecipientsRemaining: number) =>
      jest.fn().mockResolvedValue({
        allowed: true,
        companyBulkCampaignLimit: 500,
        companySubscriptionType: "free",
        bulkRecipientsRemaining,
      });
    const refused = dependencies({ ensureConversationCapacity: capacity(0) });

    const result =
      await createGeneratedBulkSendOrchestrator(refused)(request());

    expect(result).toEqual({
      status: 402,
      body: expect.objectContaining({
        operationDisposition: "not_started",
        code: "company_bulk_campaign_limit_exceeded",
        bulkRecipientsRemaining: 0,
        requestedRecipients: 1,
        retryable: false,
      }),
    });
    expect(refused.queueChild).not.toHaveBeenCalled();

    // Exactly enough left: the send goes ahead and admission checks again.
    const fits = dependencies({ ensureConversationCapacity: capacity(1) });
    const queued = await createGeneratedBulkSendOrchestrator(fits)(request());
    expect(queued.status).toBe(200);
    expect(fits.queueChild).toHaveBeenCalledWith(
      expect.objectContaining({ companyBulkCampaignLimit: 500 })
    );
  });

  it("repairs a completed replay even when current capacity is exhausted", async () => {
    const cached = {
      queued: true,
      total: 1,
      requestedTotal: 1,
      scenarioUpdate: {
        nodeId: ROOT_ID,
        bulkRootConfigPatch: {
          sendStatus: {
            total: 1,
            queued: 1,
            sent: 0,
            skipped: 0,
            failed: 0,
          },
          generatedSendState: {
            revision: REVISION,
            operationId: OPERATION_ID,
            state: "completed",
            requestedAt: REQUESTED_AT,
            completedAt: "2026-07-27T10:02:00.000Z",
          },
        },
        scenarioUpdatedAt: "2026-07-27T10:02:00.000Z",
      },
    };
    const capacity = jest.fn().mockResolvedValue({
      allowed: false,
      failure: {
        status: 402,
        body: { code: "company_conversation_limit_exceeded" },
      },
    });
    const deps = dependencies({
      ensureConversationCapacity: capacity,
      reserveOperation: jest.fn().mockResolvedValue({
        status: "completed",
        operationId: OPERATION_ID,
        responseBody: cached,
      }),
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request());

    expect(result.status).toBe(200);
    expect(capacity).not.toHaveBeenCalled();
  });

  it("repairs a completed replay without re-running mutable media, Temporal, or safety gates", async () => {
    const cached = {
      queued: true,
      total: 1,
      requestedTotal: 1,
      scenarioUpdate: {
        nodeId: ROOT_ID,
        bulkRootConfigPatch: {
          sendStatus: {
            total: 1,
            queued: 1,
            sent: 0,
            skipped: 0,
            failed: 0,
          },
          generatedSendState: {
            revision: REVISION,
            operationId: OPERATION_ID,
            state: "completed",
            requestedAt: REQUESTED_AT,
            completedAt: "2026-07-27T10:02:00.000Z",
          },
        },
        scenarioUpdatedAt: "2026-07-27T10:02:00.000Z",
      },
    };
    const deps = dependencies({
      ...withScenario({
        nodes: [bulkRootNode({ generationStatus: "generating_media" })],
      }),
      fingerprintSecret: () => null,
      isTemporalConfigured: () => false,
      reserveOperation: jest.fn().mockResolvedValue({
        status: "completed",
        operationId: OPERATION_ID,
        responseBody: cached,
      }),
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request());

    expect(result.status).toBe(200);
    expect(deps.reserveOperation).toHaveBeenCalledTimes(1);
  });

  it("classifies a rejected new media-incomplete command as not started", async () => {
    const deps = dependencies({
      ...withScenario({
        nodes: [bulkRootNode({ generationStatus: "generating_media" })],
      }),
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request());

    expect(result.status).toBe(400);
    expect(result.body.operationDisposition).toBe("not_started");
    expect(deps.deleteOperationBeforeClaim).not.toHaveBeenCalled();
    expect(deps.claimRevision).not.toHaveBeenCalled();
  });

  it("returns the current Scenario state without rewriting an already repaired replay", async () => {
    const completedAt = "2026-07-27T10:02:00.000Z";
    const currentSendStatus = {
      total: 1,
      queued: 1,
      sent: 1,
      skipped: 0,
      failed: 0,
    };
    const currentMarker = {
      revision: REVISION,
      operationId: OPERATION_ID,
      state: "completed" as const,
      requestedAt: REQUESTED_AT,
      completedAt,
    };
    const cached = {
      queued: true,
      total: 1,
      requestedTotal: 1,
      scenarioStatus: "active",
      scenarioUpdate: {
        nodeId: ROOT_ID,
        bulkRootConfigPatch: {
          sendStatus: {
            total: 1,
            queued: 1,
            sent: 0,
            skipped: 0,
            failed: 0,
          },
          generatedSendState: currentMarker,
        },
        scenarioUpdatedAt: completedAt,
      },
    };
    const deps = dependencies({
      ...withScenario({
        status: "paused",
        updatedAt: new Date("2026-07-27T11:30:00.000Z"),
        nodes: [
          bulkRootNode({
            sendStatus: currentSendStatus,
            generatedSendState: currentMarker,
          }),
        ],
      }),
      reserveOperation: jest.fn().mockResolvedValue({
        status: "completed",
        operationId: OPERATION_ID,
        responseBody: cached,
      }),
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request());

    expect(result.status).toBe(200);
    expect(deps.updateScenarioRevision).not.toHaveBeenCalled();
    expect(result.body).toEqual(
      expect.objectContaining({
        scenarioStatus: "paused",
        scenarioUpdate: {
          nodeId: ROOT_ID,
          bulkRootConfigPatch: {
            generatedRecipientCount: 1,
            sendStatus: currentSendStatus,
            generatedSendState: currentMarker,
          },
          scenarioUpdatedAt: "2026-07-27T11:30:00.000Z",
        },
        idempotentReplay: true,
      })
    );
  });

  it("fails a completed replay when the Scenario belongs to another operation", async () => {
    const cachedMarker = {
      revision: REVISION,
      operationId: OPERATION_ID,
      state: "completed" as const,
      requestedAt: REQUESTED_AT,
      completedAt: "2026-07-27T10:02:00.000Z",
    };
    const deps = dependencies({
      ...withScenario({
        nodes: [
          bulkRootNode({
            generatedSendState: {
              ...cachedMarker,
              operationId: "99999999-9999-4999-8999-999999999999",
            },
          }),
        ],
      }),
      reserveOperation: jest.fn().mockResolvedValue({
        status: "completed",
        operationId: OPERATION_ID,
        responseBody: {
          queued: true,
          total: 1,
          requestedTotal: 1,
          scenarioUpdate: {
            nodeId: ROOT_ID,
            bulkRootConfigPatch: {
              sendStatus: {
                total: 1,
                queued: 1,
                sent: 0,
                skipped: 0,
                failed: 0,
              },
              generatedSendState: cachedMarker,
            },
            scenarioUpdatedAt: "2026-07-27T10:02:00.000Z",
          },
        },
      }),
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request());

    expect(result.status).toBe(409);
    expect(result.body.code).toBe(
      "generated_bulk_send_scenario_operation_conflict"
    );
    expect(deps.updateScenarioRevision).not.toHaveBeenCalled();
  });

  it("rejects a cached replay that lacks its persisted send status", async () => {
    const deps = dependencies({
      reserveOperation: jest.fn().mockResolvedValue({
        status: "completed",
        operationId: OPERATION_ID,
        responseBody: {
          queued: true,
          total: 1,
          scenarioUpdate: {
            nodeId: ROOT_ID,
            bulkRootConfigPatch: {
              generatedSendState: {
                revision: REVISION,
                operationId: OPERATION_ID,
                state: "completed",
                requestedAt: REQUESTED_AT,
                completedAt: "2026-07-27T10:02:00.000Z",
              },
            },
            scenarioUpdatedAt: "2026-07-27T10:02:00.000Z",
          },
        },
      }),
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request());

    expect(result.status).toBe(503);
    expect(result.body.code).toBe(
      "generated_bulk_send_cached_state_incomplete"
    );
    expect(deps.updateScenarioRevision).not.toHaveBeenCalled();
  });

  it("stops before the next side effect when lease renewal fails", async () => {
    const renew = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const deps = dependencies({ renewOperationLease: renew });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request());

    expect(result.status).toBe(409);
    expect(result.body.code).toBe("generated_bulk_send_stale_owner");
    expect(deps.assignPartition).not.toHaveBeenCalled();
    expect(deps.queueChild).not.toHaveBeenCalled();
    expect(deps.deleteOperationBeforeClaim).not.toHaveBeenCalled();
  });

  it("does not complete the operation when exact terminal coverage fails", async () => {
    const deps = dependencies({
      verifyCoverage: jest.fn().mockResolvedValue({
        expectedCount: 1,
        ownedCount: 1,
        allRevisionOwnedCount: 1,
        queuedCount: 0,
        skippedCount: 0,
        incompleteCount: 1,
        unexpectedRevisionCount: 0,
        audience: { version: 1, count: 1, digest: "e".repeat(64) },
        audienceMatches: true,
        complete: false,
      }),
    });
    const execute = createGeneratedBulkSendOrchestrator(deps);

    const result = await execute(request());

    expect(result.status).toBe(503);
    expect(result.body.code).toBe("generated_bulk_send_outcomes_incomplete");
    expect(deps.updateScenarioRevision).not.toHaveBeenCalled();
    expect(deps.completeOperation).not.toHaveBeenCalled();
    expect(deps.emitPolicyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        channel: "whatsapp",
        disposition: "failed",
        errorCode: "generated_bulk_send_outcomes_incomplete",
        idempotentReplay: false,
      })
    );
    expect(
      JSON.stringify((deps.emitPolicyEvent as jest.Mock).mock.calls)
    ).not.toContain(MESSAGE_ID);
  });
});
