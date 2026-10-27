const mockConnectDB = jest.fn();
const mockFindOne = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockDeleteOne = jest.fn();
const mockCreate = jest.fn();
const mockCollectionUpdateMany = jest.fn();
const mockCollectionDropIndex = jest.fn();
const mockCollectionCreateIndex = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/bulk-send-api-idempotency", () => {
  const actual = jest.requireActual("@/models/bulk-send-api-idempotency");
  return {
    ...actual,
    __esModule: true,
    default: {
      findOne: (...args: unknown[]) => mockFindOne(...args),
      findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
      deleteOne: (...args: unknown[]) => mockDeleteOne(...args),
      create: (...args: unknown[]) => mockCreate(...args),
      collection: {
        updateMany: (...args: unknown[]) => mockCollectionUpdateMany(...args),
        dropIndex: (...args: unknown[]) => mockCollectionDropIndex(...args),
        createIndex: (...args: unknown[]) => mockCollectionCreateIndex(...args),
      },
    },
  };
});

import {
  bindGeneratedBulkSendOperationRequestDigest,
  compareAndSetGeneratedBulkSendOperationProgress,
  completeLegacyBulkSendOperation,
  completeGeneratedBulkSendOperation,
  createLegacyBulkSendRequestDigest,
  deleteGeneratedBulkSendOperationBeforeClaim,
  deriveBulkSendCampaignId,
  deriveBulkSendChildCampaignId,
  failGeneratedBulkSendOperation,
  releaseLegacyBulkSendOperation,
  releaseGeneratedBulkSendOperationLease,
  renewGeneratedBulkSendOperationLease,
  reserveGeneratedBulkSendOperation,
  reserveLegacyBulkSendOperation,
} from "./bulk-send-api-idempotency";

function leanResult<T>(value: T) {
  return {
    lean: jest.fn().mockResolvedValue(value),
  };
}

function selectedLeanResult<T>(value: T) {
  return {
    select: jest.fn(() => leanResult(value)),
  };
}

describe("bulk-send API idempotency reservations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockCollectionUpdateMany.mockResolvedValue({ acknowledged: true });
    mockCollectionDropIndex.mockResolvedValue(undefined);
    mockCollectionCreateIndex.mockResolvedValue("created");
  });

  it("derives one normalized campaign identity for a client request key", () => {
    const campaignId = deriveBulkSendCampaignId({
      workspaceId: "workspace-1",
      userId: "user-1",
      idempotencyKey: "  client-request-123  ",
    });

    expect(
      deriveBulkSendCampaignId({
        workspaceId: "workspace-1",
        userId: "user-1",
        idempotencyKey: "client-request-123",
      })
    ).toBe(campaignId);
    expect(campaignId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it("creates one request-bound legacy command owner and returns an active loser", async () => {
    const requestDigest = createLegacyBulkSendRequestDigest({
      workspaceId: "workspace-1",
      channel: "email",
      recipients: [{ email: "reader@example.com" }],
    });
    const scope = {
      workspaceId: "workspace-1",
      userId: "user-1",
      idempotencyKey: "legacy-command-key",
      requestDigestVersion: 1,
      requestDigest,
    };
    mockFindOne.mockReturnValueOnce(selectedLeanResult(null));
    mockCreate.mockImplementationOnce(
      async (document: Record<string, unknown>) => document
    );

    const owner = await reserveLegacyBulkSendOperation(scope);

    expect(owner).toEqual({
      status: "acquired",
      reservationToken: expect.any(String),
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKind: "legacy_bulk_send",
        operationState: "active",
        requestDigestVersion: 1,
        requestDigest,
        reservationToken: expect.any(String),
        reservationExpiresAt: expect.any(Date),
      })
    );

    const reservation = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    mockFindOne.mockReturnValueOnce(
      selectedLeanResult({
        ...reservation,
        reservationExpiresAt: new Date(Date.now() + 30_000),
      })
    );
    await expect(reserveLegacyBulkSendOperation(scope)).resolves.toEqual({
      status: "in_progress",
      retryAfterMs: expect.any(Number),
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("binds a legacy command key to the stable semantic request digest", async () => {
    const left = createLegacyBulkSendRequestDigest({
      channel: "telegram",
      recipients: [{ chatId: "123" }],
      policy: { version: 1, excludePriorFailedBulkSends: false },
    });
    const reordered = createLegacyBulkSendRequestDigest({
      policy: { excludePriorFailedBulkSends: false, version: 1 },
      recipients: [{ chatId: "123" }],
      channel: "telegram",
    });
    expect(reordered).toBe(left);

    mockFindOne.mockReturnValueOnce(
      selectedLeanResult({
        operationKind: "legacy_bulk_send",
        operationState: "active",
        requestDigestVersion: 1,
        requestDigest: left,
        reservationToken: "current-owner",
        reservationExpiresAt: new Date(Date.now() + 30_000),
      })
    );
    await expect(
      reserveLegacyBulkSendOperation({
        workspaceId: "workspace-1",
        userId: "user-1",
        idempotencyKey: "legacy-command-key",
        requestDigestVersion: 1,
        requestDigest: createLegacyBulkSendRequestDigest({
          channel: "telegram",
          recipients: [{ chatId: "999" }],
        }),
      })
    ).resolves.toEqual({ status: "payload_mismatch" });
  });

  it("binds schedule, message, audience, provenance, and policy intent into the semantic digest", () => {
    const base = {
      channel: "whatsapp",
      scheduledAt: "2099-01-01T00:00:00.000Z",
      messageText: "Hello",
      audience: { kind: "inline", recipients: [{ phone: "+15550000001" }] },
      provenance: { kind: "ad_hoc" },
      recipientPolicy: {
        version: 1,
        excludePriorFailedBulkSends: false,
      },
    };
    const digests = [
      base,
      { ...base, scheduledAt: "2099-01-02T00:00:00.000Z" },
      { ...base, messageText: "Changed" },
      {
        ...base,
        audience: {
          kind: "inline",
          recipients: [{ phone: "+15550000002" }],
        },
      },
      {
        ...base,
        provenance: {
          kind: "scenario_run_now",
          scenarioId: "scenario-1",
          rootNodeId: "root-1",
        },
      },
      {
        ...base,
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
      },
    ].map(createLegacyBulkSendRequestDigest);

    expect(new Set(digests).size).toBe(digests.length);
  });

  it("canonicalizes equivalent schedule and ignored compatibility wire fields in the semantic digest", () => {
    const uploadEvidence = {
      originalFilename: "audience.csv",
      selectedAt: "2026-08-21T10:00:00.000Z",
    };
    const canonical = createLegacyBulkSendRequestDigest({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      audience: {
        kind: "inline",
        recipients: [{ phone: "+15550000001", variables: { name: "Ada" } }],
        uploadEvidence,
      },
      recipientPolicy: {
        version: 1,
        excludePriorFailedBulkSends: false,
      },
      provenance: { kind: "ad_hoc" },
      templateName: "promo",
      scheduledAt: "2099-01-01T00:00:00.000Z",
    });
    const compatibleWire = createLegacyBulkSendRequestDigest({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      audience: {
        kind: "inline",
        recipients: [{ phone: "+15550000001", variables: { name: "Ada" } }],
        uploadEvidence,
      },
      recipientPolicy: {
        version: 1,
        excludePriorFailedBulkSends: false,
      },
      provenance: { kind: "ad_hoc" },
      templateName: "promo",
      scheduledAt: "2099-01-01T05:00:00.000+05:00",
      idempotencyKey: "ignored-by-semantic-digest",
      templateComponents: [{ type: "BODY", text: "browser observation" }],
      useColumnSplitRouting: false,
      audienceUploadEvidence: uploadEvidence,
    });

    expect(compatibleWire).toBe(canonical);
    expect(
      createLegacyBulkSendRequestDigest({
        ...{
          workspaceId: "workspace-1",
          channel: "whatsapp",
          audience: {
            kind: "inline",
            recipients: [{ phone: "+15550000001", variables: { name: "Ada" } }],
            uploadEvidence,
          },
          recipientPolicy: {
            version: 1,
            excludePriorFailedBulkSends: false,
          },
          provenance: { kind: "ad_hoc" },
          templateName: "promo",
          scheduledAt: "2099-01-01T00:00:00.000Z",
        },
        overflowQueueConfirmed: true,
      })
    ).toBe(canonical);
    expect(
      createLegacyBulkSendRequestDigest({
        workspaceId: "workspace-1",
        channel: "whatsapp",
        audience: {
          kind: "inline",
          recipients: [{ phone: "+15550000002", variables: { name: "Ada" } }],
          uploadEvidence,
        },
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: false,
        },
        provenance: { kind: "ad_hoc" },
        templateName: "promo",
        scheduledAt: "2099-01-01T00:00:00.000Z",
      })
    ).not.toBe(canonical);
  });

  it("returns the exact completed legacy response with its original aggregate event facts", async () => {
    const responseBody = { ok: true, outcome: { disposition: "no_op" } };
    const eventFacts = {
      channel: "email",
      messageKind: "email",
      executionSource: "ad_hoc",
      itemCounts: { requested: 2, accepted: 0, queued: 0 },
      uniqueRecipientCounts: { requested: 2, accepted: 0, queued: 0 },
      skippedByReason: { unsubscribed: 2 },
      warnings: { missingMarketingConsent: 0 },
      disposition: "no_op",
      lifecycleStatus: "completed",
      planLimit: { source: "channel_default", value: 1000 },
      policy: { version: 1, excludePriorFailedBulkSends: false },
    };
    mockFindOne.mockReturnValueOnce(
      selectedLeanResult({
        operationKind: "legacy_bulk_send",
        operationState: "completed",
        requestDigestVersion: 1,
        requestDigest: "digest-1",
        responseBody: JSON.stringify(responseBody),
        progressBody: JSON.stringify(eventFacts),
      })
    );

    await expect(
      reserveLegacyBulkSendOperation({
        workspaceId: "workspace-1",
        userId: "user-1",
        idempotencyKey: "legacy-command-key",
        requestDigestVersion: 1,
        requestDigest: "digest-1",
      })
    ).resolves.toEqual({ status: "completed", responseBody, eventFacts });
  });

  it("keeps pre-reservation response-only legacy rows exactly replayable", async () => {
    const responseBody = { ok: true, outcome: { disposition: "no_op" } };
    mockFindOne.mockReturnValueOnce(
      selectedLeanResult({ responseBody: JSON.stringify(responseBody) })
    );

    await expect(
      reserveLegacyBulkSendOperation({
        workspaceId: "workspace-1",
        userId: "user-1",
        idempotencyKey: "pre-reservation-key",
        requestDigestVersion: 1,
        requestDigest: "new-request-digest",
      })
    ).resolves.toEqual({ status: "completed", responseBody });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["operation kind", { operationKind: undefined }],
    ["exact legacy operation kind", { operationKind: "generated_bulk_send" }],
    ["request digest version", { requestDigestVersion: undefined }],
    ["request digest", { requestDigest: undefined }],
  ])(
    "rejects an explicit completed row without a valid %s instead of treating it as response-only compatibility",
    async (_label, override) => {
      mockFindOne.mockReturnValueOnce(
        selectedLeanResult({
          operationKind: "legacy_bulk_send",
          operationState: "completed",
          requestDigestVersion: 1,
          requestDigest: "digest-1",
          responseBody: JSON.stringify({
            ok: true,
            outcome: { disposition: "no_op" },
          }),
          ...override,
        })
      );

      await expect(
        reserveLegacyBulkSendOperation({
          workspaceId: "workspace-1",
          userId: "user-1",
          idempotencyKey: "malformed-explicit-completed-key",
          requestDigestVersion: 1,
          requestDigest: "digest-1",
        })
      ).rejects.toThrow("completed legacy bulk-send operation is malformed");
      expect(mockCreate).not.toHaveBeenCalled();
    }
  );

  it("completes and releases only the exact legacy command owner", async () => {
    mockFindOneAndUpdate
      .mockReturnValueOnce(leanResult({ _id: "legacy-record" }))
      .mockReturnValueOnce(leanResult(null));
    mockDeleteOne
      .mockResolvedValueOnce({ deletedCount: 1 })
      .mockResolvedValueOnce({ deletedCount: 0 });
    const owner = {
      workspaceId: "workspace-1",
      userId: "user-1",
      idempotencyKey: "legacy-command-key",
      requestDigestVersion: 1,
      requestDigest: "digest-1",
      reservationToken: "owner-token",
    };
    const eventFacts = { disposition: "no_op" };

    await expect(
      completeLegacyBulkSendOperation({
        ...owner,
        responseBody: { ok: true },
        eventFacts,
      })
    ).resolves.toBe(true);
    await expect(
      completeLegacyBulkSendOperation({
        ...owner,
        reservationToken: "stale-token",
        responseBody: { ok: true },
        eventFacts,
      })
    ).resolves.toBe(false);
    expect(mockFindOneAndUpdate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        operationKind: "legacy_bulk_send",
        operationState: "active",
        requestDigestVersion: 1,
        requestDigest: "digest-1",
        reservationToken: "owner-token",
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          operationState: "completed",
          responseBody: JSON.stringify({ ok: true }),
          progressBody: JSON.stringify(eventFacts),
        }),
      }),
      { new: true }
    );

    await expect(releaseLegacyBulkSendOperation(owner)).resolves.toBe(true);
    await expect(
      releaseLegacyBulkSendOperation({
        ...owner,
        reservationToken: "stale-token",
      })
    ).resolves.toBe(false);
  });
});

const generatedOperationFixture = {
  _id: "generated-operation-record-1",
  keyHash: "bound-key-hash",
  workspaceId: "workspace-1",
  scenarioId: "scenario-1",
  operationKind: "generated_scenario_send",
  operationState: "active",
  activeScenarioKey: "active-scenario-hash",
  campaignId: "5aa519ce-3dcb-5307-8688-84a631ea25c5",
  userId: "original-user",
  audienceRevision: "generation-job-1",
  createdAt: "2026-07-27T10:00:00.000Z",
  requestedAtIso: "2026-07-27T10:00:00.000Z",
  scheduledAtIso: "2026-07-28T00:00:00.000Z",
  intentDigestVersion: 2,
  intentDigest: "intent-digest-2",
  recipientPolicy: {
    version: 1,
    excludePriorFailedBulkSends: false,
  },
  progressVersion: 2,
};

const generatedOperationRequest = {
  workspaceId: "workspace-1",
  scenarioId: "scenario-1",
  initiatingUserId: "retrying-user",
  idempotencyKey: "client-generated-key",
  scheduledAt: "2026-07-28T06:00:00+06:00",
  audienceRevision: "generation-job-1",
  intentDigestVersion: 2,
  intentDigest: "intent-digest-2",
  legacyIntentDigestVersion: 1 as const,
  legacyIntentDigest: "intent-digest-1",
  recipientPolicy: {
    version: 1 as const,
    excludePriorFailedBulkSends: false,
  },
};

const generatedOperationRequestWithoutSchedule = {
  workspaceId: "workspace-1",
  scenarioId: "scenario-1",
  initiatingUserId: "retrying-user",
  audienceRevision: "generation-job-1",
  intentDigestVersion: 2,
  intentDigest: "intent-digest-2",
  legacyIntentDigestVersion: 1 as const,
  legacyIntentDigest: "intent-digest-1",
  recipientPolicy: {
    version: 1 as const,
    excludePriorFailedBulkSends: false,
  },
};

const legacyGeneratedOperationFixture = {
  ...generatedOperationFixture,
  intentDigestVersion: 1,
  intentDigest: "intent-digest-1",
  recipientPolicy: undefined,
  progressVersion: 1,
};

const CURRENT_GENERATED_REQUEST_DIGEST = "d".repeat(64);
const LEGACY_GENERATED_REQUEST_DIGEST = "e".repeat(64);

const currentGeneratedTerminalProgress = JSON.stringify({
  version: 1,
  phase: "prepared",
  preparationDigestVersion: 3,
  preparationDigest: "a".repeat(64),
  recoveryFacts: [
    {
      partitionKey: "whatsapp:source-1:phone-1",
      campaignId: "88888888-8888-4888-8888-888888888888",
      channel: "whatsapp",
      sourceId: "source-1",
      batchPlan: {
        batchSize: 50,
        delayMs: 1_000,
        ratePerSecond: 20,
        rateSource: "meta",
      },
      contentHash: "b".repeat(64),
      audience: { version: 1, count: 1, digest: "c".repeat(64) },
      requestedTotal: 1,
      skippedOptIn: 0,
      policyFacts: {
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
    },
  ],
  admittedChildrenCount: 1,
  queuedCount: 1,
  skippedCount: 0,
  lastPartitionKey: "whatsapp:source-1:phone-1",
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
      requestedTotal: 1,
      acceptedTotal: 1,
      uniqueRecipients: { requested: 1, accepted: 1 },
      skippedByReason: {},
      warnings: { missingMarketingConsent: 0 },
      allExcluded: false,
    },
  },
});

describe("server-owned generated bulk-send operation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockCollectionUpdateMany.mockResolvedValue({ acknowledged: true });
    mockCollectionDropIndex.mockResolvedValue(undefined);
    mockCollectionCreateIndex.mockResolvedValue("created");
  });

  it("migrates the legacy TTL once and creates the generated-operation indexes", async () => {
    delete (
      globalThis as typeof globalThis & {
        __bulkSendApiIdempotencyIndexCache?: unknown;
      }
    ).__bulkSendApiIdempotencyIndexCache;

    await jest.isolateModulesAsync(async () => {
      const { ensureBulkSendApiIdempotencyIndexes: ensureIndexes } =
        await import("./bulk-send-api-idempotency");

      await Promise.all([ensureIndexes(), ensureIndexes(), ensureIndexes()]);
      await ensureIndexes();
    });

    expect(mockConnectDB).toHaveBeenCalledTimes(1);
    expect(mockCollectionUpdateMany).toHaveBeenCalledWith(
      {
        operationKind: { $exists: false },
        scenarioId: { $exists: false },
        activeScenarioKey: { $exists: false },
      },
      { $set: { operationKind: "legacy_bulk_send" } }
    );
    expect(mockCollectionDropIndex).toHaveBeenCalledWith("createdAt_1");
    expect(mockCollectionCreateIndex).toHaveBeenCalledWith(
      { createdAt: 1 },
      {
        background: true,
        expireAfterSeconds: 60 * 60 * 24,
        name: "bulk_send_legacy_created_at_ttl",
        partialFilterExpression: { operationKind: "legacy_bulk_send" },
      }
    );
    expect(mockCollectionCreateIndex).toHaveBeenCalledWith(
      { expiresAt: 1 },
      {
        background: true,
        expireAfterSeconds: 0,
        name: "bulk_send_terminal_expires_at_ttl",
      }
    );
    expect(mockCollectionCreateIndex).toHaveBeenCalledWith(
      { keyHash: 1 },
      {
        background: true,
        name: "keyHash_1",
        unique: true,
      }
    );
    expect(mockCollectionCreateIndex).toHaveBeenCalledWith(
      { activeScenarioKey: 1 },
      {
        background: true,
        name: "bulk_send_active_scenario_unique",
        sparse: true,
        unique: true,
      }
    );
    expect(mockCollectionCreateIndex).toHaveBeenCalledWith(
      {
        workspaceId: 1,
        scenarioId: 1,
        operationState: 1,
        reservationExpiresAt: 1,
      },
      {
        background: true,
        name: "bulk_send_generated_operation_lease",
      }
    );
  });

  it.each([
    {
      name: "the same client key",
      idempotencyKey: "client-generated-key",
      keyedDocument: generatedOperationFixture,
    },
    {
      name: "a fresh client key",
      idempotencyKey: "fresh-client-key",
      keyedDocument: null,
    },
    {
      name: "no client key",
      idempotencyKey: undefined,
      keyedDocument: null,
    },
  ])(
    "reacquires one active scenario operation with $name",
    async ({ idempotencyKey, keyedDocument }) => {
      let keyLookupHandled = false;
      mockFindOne.mockImplementation((filter: Record<string, unknown>) => {
        if ("keyHash" in filter && !keyLookupHandled) {
          keyLookupHandled = true;
          return selectedLeanResult(keyedDocument);
        }
        if ("activeScenarioKey" in filter) {
          return selectedLeanResult(generatedOperationFixture);
        }
        return selectedLeanResult(null);
      });
      mockFindOneAndUpdate.mockImplementation(
        (_filter: unknown, update: Record<string, Record<string, unknown>>) =>
          leanResult({
            ...generatedOperationFixture,
            reservationToken: update.$set.reservationToken,
            reservationExpiresAt: update.$set.reservationExpiresAt,
          })
      );

      await expect(
        reserveGeneratedBulkSendOperation({
          ...generatedOperationRequest,
          idempotencyKey,
        })
      ).resolves.toEqual(
        expect.objectContaining({
          status: "acquired",
          compatibilityMode: "current_v2",
          isNew: false,
          operationId: generatedOperationFixture.campaignId,
          initiatingUserId: "original-user",
          audienceRevision: "generation-job-1",
          scheduledAt: "2026-07-28T00:00:00.000Z",
          progressVersion: 2,
          reservationToken: expect.any(String),
        })
      );

      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: generatedOperationFixture.campaignId,
          workspaceId: "workspace-1",
          scenarioId: "scenario-1",
          operationState: "active",
        }),
        expect.objectContaining({
          $set: expect.objectContaining({
            reservationToken: expect.any(String),
          }),
          $unset: { expiresAt: "" },
        }),
        { new: true }
      );
    }
  );

  it.each([
    {
      name: "the same client key",
      idempotencyKey: "client-generated-key",
      keyedDocument: generatedOperationFixture,
    },
    {
      name: "a fresh client key",
      idempotencyKey: "fresh-client-key",
      keyedDocument: null,
    },
    {
      name: "no client key",
      idempotencyKey: undefined,
      keyedDocument: null,
    },
  ])(
    "preserves an active operation's original schedule when reacquired with $name and no schedule field",
    async ({ idempotencyKey, keyedDocument }) => {
      let keyLookupHandled = false;
      mockFindOne.mockImplementation((filter: Record<string, unknown>) => {
        if ("keyHash" in filter && !keyLookupHandled) {
          keyLookupHandled = true;
          return selectedLeanResult(keyedDocument);
        }
        if ("activeScenarioKey" in filter) {
          return selectedLeanResult(generatedOperationFixture);
        }
        return selectedLeanResult(null);
      });
      mockFindOneAndUpdate.mockImplementation(
        (_filter: unknown, update: Record<string, Record<string, unknown>>) =>
          leanResult({
            ...generatedOperationFixture,
            reservationToken: update.$set.reservationToken,
            reservationExpiresAt: update.$set.reservationExpiresAt,
          })
      );

      await expect(
        reserveGeneratedBulkSendOperation({
          ...generatedOperationRequestWithoutSchedule,
          idempotencyKey,
        })
      ).resolves.toEqual(
        expect.objectContaining({
          status: "acquired",
          isNew: false,
          operationId: generatedOperationFixture.campaignId,
          requestedAt: "2026-07-27T10:00:00.000Z",
          scheduledAt: "2026-07-28T00:00:00.000Z",
        })
      );
    }
  );

  it("creates one normalized active operation without a terminal expiry", async () => {
    mockFindOne.mockReturnValue(selectedLeanResult(null));
    mockCreate.mockImplementation(
      async (document: Record<string, unknown>) => document
    );

    const result = await reserveGeneratedBulkSendOperation(
      generatedOperationRequest
    );

    expect(result).toEqual(
      expect.objectContaining({
        status: "acquired",
        compatibilityMode: "current_v2",
        isNew: true,
        initiatingUserId: "retrying-user",
        audienceRevision: "generation-job-1",
        requestedAt: expect.any(String),
        scheduledAt: "2026-07-28T00:00:00.000Z",
        operationId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        ),
        progressVersion: 0,
      })
    );
    expect(result).not.toHaveProperty("audienceCutoffAt");
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKind: "generated_scenario_send",
        operationState: "active",
        userId: "retrying-user",
        scenarioId: "scenario-1",
        audienceRevision: "generation-job-1",
        requestedAtIso: expect.any(String),
        scheduledAtIso: "2026-07-28T00:00:00.000Z",
        intentDigestVersion: 2,
        intentDigest: "intent-digest-2",
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: false,
        },
        activeScenarioKey: expect.stringMatching(/^[0-9a-f]{64}$/),
        reservationToken: expect.any(String),
        reservationExpiresAt: expect.any(Date),
        progressVersion: 0,
      })
    );
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty("audienceCutoffAt");
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty("expiresAt");
  });

  it("runs the read-only fresh-operation gate before insert and leaves no row when it rejects", async () => {
    mockFindOne.mockReturnValue(selectedLeanResult(null));
    const beforeCreate = jest.fn(async () => {
      expect(mockCreate).not.toHaveBeenCalled();
      throw new Error("read-only preflight rejected");
    });

    await expect(
      reserveGeneratedBulkSendOperation({
        ...generatedOperationRequest,
        beforeCreate,
      })
    ).rejects.toThrow("read-only preflight rejected");

    expect(beforeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "acquired",
        isNew: true,
        compatibilityMode: "current_v2",
        operationId: expect.any(String),
        requestedAt: expect.any(String),
      })
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("creates an immediate operation when the schedule field is omitted", async () => {
    mockFindOne.mockReturnValue(selectedLeanResult(null));
    mockCreate.mockImplementation(
      async (document: Record<string, unknown>) => document
    );

    await expect(
      reserveGeneratedBulkSendOperation(
        generatedOperationRequestWithoutSchedule
      )
    ).resolves.toEqual(
      expect.objectContaining({
        status: "acquired",
        isNew: true,
        scheduledAt: null,
      })
    );
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledAtIso: null,
      })
    );
  });

  it("returns payload mismatch instead of another scenario or intent response", async () => {
    mockFindOne.mockReturnValue(
      selectedLeanResult({
        ...generatedOperationFixture,
        scenarioId: "scenario-other",
        intentDigest: "other-intent",
        operationState: "completed",
        responseBody: JSON.stringify({
          success: true,
          secretCampaignId: "must-not-leak",
        }),
      })
    );

    await expect(
      reserveGeneratedBulkSendOperation(generatedOperationRequest)
    ).resolves.toEqual({ status: "payload_mismatch" });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "explicit null",
      scheduledAt: null,
    },
    {
      name: "a changed normalized value",
      scheduledAt: "2026-07-29T06:00:00+06:00",
    },
  ])(
    "rejects $name for an active scheduled operation even when the intent digest repeats",
    async ({ scheduledAt }) => {
      mockFindOne.mockReturnValue(
        selectedLeanResult(generatedOperationFixture)
      );

      await expect(
        reserveGeneratedBulkSendOperation({
          ...generatedOperationRequest,
          scheduledAt,
        })
      ).resolves.toEqual({ status: "payload_mismatch" });
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    }
  );

  it("fails closed when a legacy active operation has no immutable request time", async () => {
    const legacyOperation = {
      ...generatedOperationFixture,
      requestedAtIso: undefined,
    };
    mockFindOne.mockReturnValue(selectedLeanResult(legacyOperation));

    await expect(
      reserveGeneratedBulkSendOperation(generatedOperationRequest)
    ).resolves.toEqual({
      status: "legacy_operation",
      operationId: generatedOperationFixture.campaignId,
      reason: "missing_requested_at",
    });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns a bounded completed response only after exact scope and intent match", async () => {
    mockFindOne.mockReturnValue(
      selectedLeanResult({
        ...generatedOperationFixture,
        operationState: "completed",
        activeScenarioKey: undefined,
        requestDigestVersion: 2,
        requestDigest: CURRENT_GENERATED_REQUEST_DIGEST,
        progressBody: currentGeneratedTerminalProgress,
        responseBody: JSON.stringify({
          success: true,
          campaignId: generatedOperationFixture.campaignId,
        }),
      })
    );

    await expect(
      reserveGeneratedBulkSendOperation(generatedOperationRequest)
    ).resolves.toEqual({
      status: "completed",
      operationId: generatedOperationFixture.campaignId,
      responseBody: {
        success: true,
        campaignId: generatedOperationFixture.campaignId,
      },
    });
  });

  it("replays an exact terminal failure for the same generated operation intent", async () => {
    const select = jest.fn(() =>
      leanResult({
        ...generatedOperationFixture,
        operationState: "failed",
        activeScenarioKey: undefined,
        requestDigestVersion: 2,
        requestDigest: CURRENT_GENERATED_REQUEST_DIGEST,
        progressBody: currentGeneratedTerminalProgress,
        responseStatus: 409,
        responseBody: JSON.stringify({
          operationDisposition: "in_progress",
          code: "generated_bulk_send_child_terminal",
          retryable: false,
        }),
      })
    );
    mockFindOne.mockReturnValue({ select });

    await expect(
      reserveGeneratedBulkSendOperation(generatedOperationRequest)
    ).resolves.toEqual({
      status: "failed",
      operationId: generatedOperationFixture.campaignId,
      responseStatus: 409,
      responseBody: {
        operationDisposition: "in_progress",
        code: "generated_bulk_send_child_terminal",
        retryable: false,
      },
    });
    expect(select).toHaveBeenCalledWith(
      expect.stringContaining("responseStatus")
    );
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "a current-v2 intent with no request digest",
      fixture: {
        ...generatedOperationFixture,
        requestDigestVersion: undefined,
        requestDigest: undefined,
      },
    },
    {
      name: "a current-v2 intent paired with request-v1",
      fixture: {
        ...generatedOperationFixture,
        requestDigestVersion: 1,
        requestDigest: "cross-version-request-digest",
      },
    },
    {
      name: "a legacy-v1 intent with no request digest",
      fixture: {
        ...legacyGeneratedOperationFixture,
        requestDigestVersion: undefined,
        requestDigest: undefined,
      },
    },
    {
      name: "a legacy-v1 intent paired with request-v2",
      fixture: {
        ...legacyGeneratedOperationFixture,
        requestDigestVersion: 2,
        requestDigest: "cross-version-request-digest",
      },
    },
  ])("fails closed for terminal $name", async ({ fixture }) => {
    mockFindOne.mockReturnValue(
      selectedLeanResult({
        ...fixture,
        operationState: "completed",
        activeScenarioKey: undefined,
        responseBody: JSON.stringify({ success: true }),
      })
    );

    await expect(
      reserveGeneratedBulkSendOperation(generatedOperationRequest)
    ).resolves.toEqual({ status: "payload_mismatch" });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "current-v2 intent/request with missing progress",
      fixture: {
        ...generatedOperationFixture,
        requestDigestVersion: 2,
        requestDigest: CURRENT_GENERATED_REQUEST_DIGEST,
        progressBody: undefined,
      },
    },
    {
      name: "current-v2 intent/request with legacy preparation-v2 progress",
      fixture: {
        ...generatedOperationFixture,
        requestDigestVersion: 2,
        requestDigest: CURRENT_GENERATED_REQUEST_DIGEST,
        progressBody: JSON.stringify({
          version: 1,
          phase: "prepared",
          preparationDigestVersion: 2,
          preparationDigest: "a".repeat(64),
          recoveryFacts: [],
        }),
      },
    },
    {
      name: "legacy-v1 intent/request with current preparation-v3 progress",
      fixture: {
        ...legacyGeneratedOperationFixture,
        requestDigestVersion: 1,
        requestDigest: LEGACY_GENERATED_REQUEST_DIGEST,
        progressBody: currentGeneratedTerminalProgress,
      },
    },
    {
      name: "current-v2 intent/request with a malformed recovery fact",
      fixture: {
        ...generatedOperationFixture,
        requestDigestVersion: 2,
        requestDigest: CURRENT_GENERATED_REQUEST_DIGEST,
        progressBody: JSON.stringify({
          version: 1,
          phase: "prepared",
          preparationDigestVersion: 3,
          preparationDigest: "a".repeat(64),
          recoveryFacts: [{ policyFacts: {} }],
          admittedChildrenCount: 0,
          queuedCount: 0,
          skippedCount: 0,
          lastPartitionKey: null,
          recipientPolicy: {
            version: 1,
            excludePriorFailedBulkSends: false,
          },
        }),
      },
    },
    {
      name: "current-v2 intent/request with malformed WhatsApp global facts",
      fixture: {
        ...generatedOperationFixture,
        requestDigestVersion: 2,
        requestDigest: CURRENT_GENERATED_REQUEST_DIGEST,
        progressBody: JSON.stringify({
          ...JSON.parse(currentGeneratedTerminalProgress),
          whatsappPolicyFacts: {},
        }),
      },
    },
    {
      name: "current-v2 intent/request with a null partition raw limit",
      fixture: {
        ...generatedOperationFixture,
        requestDigestVersion: 2,
        requestDigest: CURRENT_GENERATED_REQUEST_DIGEST,
        progressBody: (() => {
          const progress = JSON.parse(currentGeneratedTerminalProgress);
          progress.recoveryFacts[0].policyFacts.authoritativeRecipientLimit.rawLimit =
            null;
          return JSON.stringify(progress);
        })(),
      },
    },
    {
      name: "current-v2 intent/request with over-cap aggregate counts",
      fixture: {
        ...generatedOperationFixture,
        requestDigestVersion: 2,
        requestDigest: CURRENT_GENERATED_REQUEST_DIGEST,
        progressBody: JSON.stringify({
          ...JSON.parse(currentGeneratedTerminalProgress),
          queuedCount: 3_001,
        }),
      },
    },
  ])("fails closed for terminal $name", async ({ fixture }) => {
    mockFindOne.mockReturnValue(
      selectedLeanResult({
        ...fixture,
        operationState: "completed",
        activeScenarioKey: undefined,
        responseBody: JSON.stringify({ success: true }),
      })
    );

    await expect(
      reserveGeneratedBulkSendOperation(generatedOperationRequest)
    ).resolves.toEqual({ status: "payload_mismatch" });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("replays an explicitly marked current terminal-expiry progress mode", async () => {
    mockFindOne.mockReturnValue(
      selectedLeanResult({
        ...generatedOperationFixture,
        operationState: "completed",
        activeScenarioKey: undefined,
        requestDigestVersion: 2,
        requestDigest: CURRENT_GENERATED_REQUEST_DIGEST,
        progressBody: JSON.stringify({
          version: 1,
          phase: "prepared",
          preparationDigestVersion: 1,
          preparationDigest: "a".repeat(64),
          recoveryFacts: [],
          admittedChildrenCount: 0,
          queuedCount: 0,
          skippedCount: 1,
          lastPartitionKey: null,
          recipientPolicy: {
            version: 1,
            excludePriorFailedBulkSends: false,
          },
        }),
        responseBody: JSON.stringify({ success: true, expired: true }),
      })
    );

    await expect(
      reserveGeneratedBulkSendOperation(generatedOperationRequest)
    ).resolves.toMatchObject({
      status: "completed",
      responseBody: { success: true, expired: true },
    });
  });

  it("returns in-progress without replacing an unexpired owner", async () => {
    mockFindOne.mockReturnValue(
      selectedLeanResult({
        ...generatedOperationFixture,
        reservationToken: "current-owner",
        reservationExpiresAt: new Date(Date.now() + 30_000),
      })
    );

    await expect(
      reserveGeneratedBulkSendOperation(generatedOperationRequest)
    ).resolves.toEqual({
      status: "in_progress",
      operationId: generatedOperationFixture.campaignId,
      retryAfterMs: expect.any(Number),
    });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("keeps a live current-v2 lease bound to its stored policy when the root policy changes", async () => {
    mockFindOne.mockReturnValue(
      selectedLeanResult({
        ...generatedOperationFixture,
        reservationToken: "current-owner",
        reservationExpiresAt: new Date(Date.now() + 30_000),
      })
    );

    await expect(
      reserveGeneratedBulkSendOperation({
        ...generatedOperationRequest,
        intentDigest: "intent-digest-after-policy-toggle",
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
      })
    ).resolves.toEqual({
      status: "in_progress",
      operationId: generatedOperationFixture.campaignId,
      retryAfterMs: expect.any(Number),
    });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("reacquires an expired current-v2 operation with its stored policy without overwriting it", async () => {
    const expired = {
      ...generatedOperationFixture,
      reservationToken: "expired-owner",
      reservationExpiresAt: new Date(Date.now() - 30_000),
    };
    mockFindOne.mockReturnValue(selectedLeanResult(expired));
    mockFindOneAndUpdate.mockImplementation(
      (_filter: unknown, update: Record<string, Record<string, unknown>>) =>
        leanResult({
          ...expired,
          reservationToken: update.$set.reservationToken,
          reservationExpiresAt: update.$set.reservationExpiresAt,
        })
    );

    await expect(
      reserveGeneratedBulkSendOperation({
        ...generatedOperationRequest,
        intentDigest: "intent-digest-after-policy-toggle",
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
      })
    ).resolves.toEqual(
      expect.objectContaining({
        status: "acquired",
        compatibilityMode: "current_v2",
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: false,
        },
      })
    );
    const update = mockFindOneAndUpdate.mock.calls[0]?.[1];
    expect(update.$set).not.toHaveProperty("recipientPolicy");
  });

  it.each([
    ["missing", undefined],
    ["malformed", { version: 1, excludePriorFailedBulkSends: "yes" }],
  ])(
    "fails closed for a current-v2 operation with a %s policy snapshot",
    async (_name, recipientPolicy) => {
      mockFindOne.mockReturnValue(
        selectedLeanResult({
          ...generatedOperationFixture,
          recipientPolicy,
          reservationToken: "current-owner",
          reservationExpiresAt: new Date(Date.now() + 30_000),
        })
      );

      await expect(
        reserveGeneratedBulkSendOperation(generatedOperationRequest)
      ).rejects.toThrow("policy snapshot is invalid");
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    }
  );

  it.each([
    {
      name: "disabled",
      recipientPolicy: {
        version: 1 as const,
        excludePriorFailedBulkSends: false,
      },
    },
    {
      name: "enabled",
      recipientPolicy: {
        version: 1 as const,
        excludePriorFailedBulkSends: true,
      },
    },
  ])(
    "returns in-progress for a live legacy-v1 lease when policy is $name",
    async ({ recipientPolicy }) => {
      mockFindOne.mockReturnValue(
        selectedLeanResult({
          ...legacyGeneratedOperationFixture,
          reservationToken: "legacy-owner",
          reservationExpiresAt: new Date(Date.now() + 30_000),
        })
      );

      await expect(
        reserveGeneratedBulkSendOperation({
          ...generatedOperationRequest,
          recipientPolicy,
        })
      ).resolves.toEqual({
        status: "in_progress",
        operationId: generatedOperationFixture.campaignId,
        retryAfterMs: expect.any(Number),
      });
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    }
  );

  it("replays a terminal legacy-v1 operation only for disabled policy and an exact legacy intent", async () => {
    mockFindOne.mockReturnValue(
      selectedLeanResult({
        ...legacyGeneratedOperationFixture,
        operationState: "completed",
        activeScenarioKey: undefined,
        requestDigestVersion: 1,
        requestDigest: LEGACY_GENERATED_REQUEST_DIGEST,
        responseBody: JSON.stringify({ success: true, legacy: true }),
      })
    );

    await expect(
      reserveGeneratedBulkSendOperation(generatedOperationRequest)
    ).resolves.toEqual({
      status: "completed",
      operationId: generatedOperationFixture.campaignId,
      responseBody: { success: true, legacy: true },
    });
    await expect(
      reserveGeneratedBulkSendOperation({
        ...generatedOperationRequest,
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
      })
    ).resolves.toEqual({ status: "payload_mismatch" });
    await expect(
      reserveGeneratedBulkSendOperation({
        ...generatedOperationRequest,
        legacyIntentDigest: "different-legacy-intent",
      })
    ).resolves.toEqual({ status: "payload_mismatch" });
  });

  it("reacquires an expired legacy-v1 operation in explicit disabled compatibility mode", async () => {
    mockFindOne.mockReturnValue(
      selectedLeanResult({
        ...legacyGeneratedOperationFixture,
        reservationToken: "expired-owner",
        reservationExpiresAt: new Date(Date.now() - 30_000),
      })
    );
    mockFindOneAndUpdate.mockImplementation(
      (_filter: unknown, update: Record<string, Record<string, unknown>>) =>
        leanResult({
          ...legacyGeneratedOperationFixture,
          reservationToken: update.$set.reservationToken,
          reservationExpiresAt: update.$set.reservationExpiresAt,
        })
    );

    await expect(
      reserveGeneratedBulkSendOperation(generatedOperationRequest)
    ).resolves.toEqual(
      expect.objectContaining({
        status: "acquired",
        compatibilityMode: "legacy_v1_disabled",
        operationId: generatedOperationFixture.campaignId,
      })
    );
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: generatedOperationFixture.campaignId,
        intentDigestVersion: 1,
        intentDigest: "intent-digest-1",
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ reservationToken: expect.any(String) }),
      }),
      { new: true }
    );
  });

  it("terminalizes an expired legacy-v1 enabled-policy operation and keeps the old client key mismatched", async () => {
    const expiredLegacy = {
      ...legacyGeneratedOperationFixture,
      reservationToken: "expired-owner",
      reservationExpiresAt: new Date(Date.now() - 30_000),
    };
    mockFindOne.mockReturnValue(selectedLeanResult(expiredLegacy));
    mockFindOneAndUpdate.mockReturnValue(
      leanResult({
        ...expiredLegacy,
        operationState: "failed",
        activeScenarioKey: undefined,
      })
    );

    await expect(
      reserveGeneratedBulkSendOperation({
        ...generatedOperationRequest,
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
      })
    ).resolves.toEqual({ status: "payload_mismatch" });
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: generatedOperationFixture.campaignId,
        operationState: "active",
        intentDigestVersion: 1,
        intentDigest: "intent-digest-1",
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          operationState: "failed",
          responseStatus: 409,
        }),
        $unset: expect.objectContaining({ activeScenarioKey: "" }),
      }),
      { new: true }
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("creates fresh v2 after terminalizing an expired legacy-v1 enabled-policy active row", async () => {
    const expiredLegacy = {
      ...legacyGeneratedOperationFixture,
      reservationToken: "expired-owner",
      reservationExpiresAt: new Date(Date.now() - 30_000),
    };
    let activeRead = 0;
    mockFindOne.mockImplementation((filter: Record<string, unknown>) => {
      if ("keyHash" in filter) return selectedLeanResult(null);
      if ("activeScenarioKey" in filter && activeRead++ === 0) {
        return selectedLeanResult(expiredLegacy);
      }
      return selectedLeanResult(null);
    });
    mockFindOneAndUpdate.mockReturnValue(
      leanResult({
        ...expiredLegacy,
        operationState: "failed",
        activeScenarioKey: undefined,
      })
    );
    mockCreate.mockImplementation(
      async (document: Record<string, unknown>) => document
    );

    await expect(
      reserveGeneratedBulkSendOperation({
        ...generatedOperationRequest,
        idempotencyKey: "fresh-v2-key",
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
      })
    ).resolves.toEqual(
      expect.objectContaining({
        status: "acquired",
        compatibilityMode: "current_v2",
        isNew: true,
      })
    );
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        intentDigestVersion: 2,
        intentDigest: "intent-digest-2",
      })
    );
  });

  it("rereads and deterministically classifies a legacy terminalization race loss", async () => {
    const expiredLegacy = {
      ...legacyGeneratedOperationFixture,
      reservationToken: "expired-owner",
      reservationExpiresAt: new Date(Date.now() - 30_000),
    };
    mockFindOne
      .mockReturnValueOnce(selectedLeanResult(expiredLegacy))
      .mockReturnValueOnce(
        selectedLeanResult({
          ...expiredLegacy,
          operationState: "failed",
          activeScenarioKey: undefined,
          responseStatus: 409,
          responseBody: JSON.stringify({
            code: "generated_bulk_send_legacy_policy_upgrade_required",
          }),
        })
      );
    mockFindOneAndUpdate.mockReturnValue(leanResult(null));

    await expect(
      reserveGeneratedBulkSendOperation({
        ...generatedOperationRequest,
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
      })
    ).resolves.toEqual({ status: "payload_mismatch" });
  });

  it("returns cached completion when a takeover loses the race to completion", async () => {
    mockFindOne
      .mockReturnValueOnce(selectedLeanResult(generatedOperationFixture))
      .mockReturnValueOnce(
        selectedLeanResult({
          ...generatedOperationFixture,
          operationState: "completed",
          activeScenarioKey: undefined,
          requestDigestVersion: 2,
          requestDigest: CURRENT_GENERATED_REQUEST_DIGEST,
          progressBody: currentGeneratedTerminalProgress,
          responseBody: JSON.stringify({
            success: true,
            campaignId: generatedOperationFixture.campaignId,
          }),
        })
      );
    mockFindOneAndUpdate.mockReturnValue(leanResult(null));

    await expect(
      reserveGeneratedBulkSendOperation(generatedOperationRequest)
    ).resolves.toEqual({
      status: "completed",
      operationId: generatedOperationFixture.campaignId,
      responseBody: {
        success: true,
        campaignId: generatedOperationFixture.campaignId,
      },
    });
  });

  it("returns in-progress from the real lease when another owner wins takeover", async () => {
    const reservationExpiresAt = new Date(Date.now() + 30_000);
    mockFindOne
      .mockReturnValueOnce(selectedLeanResult(generatedOperationFixture))
      .mockReturnValueOnce(
        selectedLeanResult({
          ...generatedOperationFixture,
          reservationToken: "winning-owner",
          reservationExpiresAt,
        })
      );
    mockFindOneAndUpdate.mockReturnValue(leanResult(null));

    const result = await reserveGeneratedBulkSendOperation(
      generatedOperationRequest
    );

    expect(result).toEqual({
      status: "in_progress",
      operationId: generatedOperationFixture.campaignId,
      retryAfterMs: expect.any(Number),
    });
    expect(
      result.status === "in_progress" ? result.retryAfterMs : null
    ).toBeLessThanOrEqual(30_000);
  });

  it("fails closed instead of inventing a lease after an unexplained takeover loss", async () => {
    mockFindOne
      .mockReturnValueOnce(selectedLeanResult(generatedOperationFixture))
      .mockReturnValueOnce(selectedLeanResult(generatedOperationFixture));
    mockFindOneAndUpdate.mockReturnValue(leanResult(null));

    await expect(
      reserveGeneratedBulkSendOperation(generatedOperationRequest)
    ).rejects.toThrow("active lease is invalid");
  });

  it.each([
    {
      name: "the same client key",
      idempotencyKey: "client-generated-key",
      keyedDocument: generatedOperationFixture,
    },
    {
      name: "a fresh client key",
      idempotencyKey: "fresh-client-key",
      keyedDocument: null,
    },
    {
      name: "no client key",
      idempotencyKey: undefined,
      keyedDocument: null,
    },
  ])(
    "rejects a different audience revision for an active operation with $name",
    async ({ idempotencyKey, keyedDocument }) => {
      let keyLookupHandled = false;
      mockFindOne.mockImplementation((filter: Record<string, unknown>) => {
        if ("keyHash" in filter && !keyLookupHandled) {
          keyLookupHandled = true;
          return selectedLeanResult(keyedDocument);
        }
        if ("activeScenarioKey" in filter) {
          return selectedLeanResult(generatedOperationFixture);
        }
        return selectedLeanResult(null);
      });
      mockFindOneAndUpdate.mockReturnValue(
        leanResult({
          ...generatedOperationFixture,
          reservationToken: "new-owner",
          reservationExpiresAt: new Date(Date.now() + 30_000),
        })
      );

      await expect(
        reserveGeneratedBulkSendOperation({
          ...generatedOperationRequest,
          idempotencyKey,
          audienceRevision: "generation-job-2",
        })
      ).resolves.toEqual({ status: "payload_mismatch" });
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    }
  );

  it.each(["", "   "])(
    "rejects a new operation with an empty audience revision %#",
    async audienceRevision => {
      mockFindOne.mockReturnValue(selectedLeanResult(null));
      mockCreate.mockImplementation(
        async (document: Record<string, unknown>) => document
      );

      await expect(
        reserveGeneratedBulkSendOperation({
          ...generatedOperationRequest,
          audienceRevision,
        })
      ).rejects.toThrow("audience revision is required");
      expect(mockFindOne).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    }
  );

  it.each([
    {
      name: "the same client key",
      idempotencyKey: "client-generated-key",
      keyedDocument: true,
    },
    {
      name: "a fresh client key",
      idempotencyKey: "fresh-client-key",
      keyedDocument: false,
    },
    {
      name: "no client key",
      idempotencyKey: undefined,
      keyedDocument: false,
    },
  ])(
    "returns a fail-closed legacy state without acquiring an active operation found with $name",
    async ({ idempotencyKey, keyedDocument }) => {
      const legacyOperation = {
        ...generatedOperationFixture,
        audienceRevision: undefined,
      };
      let keyLookupHandled = false;
      mockFindOne.mockImplementation((filter: Record<string, unknown>) => {
        if ("keyHash" in filter && !keyLookupHandled) {
          keyLookupHandled = true;
          return selectedLeanResult(keyedDocument ? legacyOperation : null);
        }
        if ("activeScenarioKey" in filter) {
          return selectedLeanResult(legacyOperation);
        }
        return selectedLeanResult(null);
      });

      await expect(
        reserveGeneratedBulkSendOperation({
          ...generatedOperationRequest,
          idempotencyKey,
        })
      ).resolves.toEqual({
        status: "legacy_operation",
        operationId: generatedOperationFixture.campaignId,
        reason: "missing_audience_revision",
      });
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    }
  );

  it("binds an immutable full request digest once and rejects mismatch", async () => {
    const ownerScope = {
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      operationId: generatedOperationFixture.campaignId,
      reservationToken: "owner-token",
      requestDigestVersion: 1,
      requestDigest: "request-digest-1",
    };

    mockFindOne
      .mockReturnValueOnce(selectedLeanResult(generatedOperationFixture))
      .mockReturnValueOnce(
        selectedLeanResult({
          ...generatedOperationFixture,
          requestDigestVersion: 1,
          requestDigest: "request-digest-1",
          reservationToken: "owner-token",
        })
      )
      .mockReturnValueOnce(
        selectedLeanResult({
          ...generatedOperationFixture,
          requestDigestVersion: 1,
          requestDigest: "request-digest-1",
          reservationToken: "owner-token",
        })
      );
    mockFindOneAndUpdate.mockReturnValueOnce(
      leanResult({
        ...generatedOperationFixture,
        requestDigestVersion: 1,
        requestDigest: "request-digest-1",
      })
    );

    await expect(
      bindGeneratedBulkSendOperationRequestDigest(ownerScope)
    ).resolves.toEqual({ status: "bound" });
    await expect(
      bindGeneratedBulkSendOperationRequestDigest(ownerScope)
    ).resolves.toEqual({ status: "matched" });
    await expect(
      bindGeneratedBulkSendOperationRequestDigest({
        ...ownerScope,
        requestDigest: "request-digest-other",
      })
    ).resolves.toEqual({ status: "payload_mismatch" });

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: generatedOperationFixture.campaignId,
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        operationKind: "generated_scenario_send",
        operationState: "active",
        reservationToken: "owner-token",
        requestDigest: { $exists: false },
      }),
      {
        $set: {
          requestDigestVersion: 1,
          requestDigest: "request-digest-1",
        },
      },
      { new: true }
    );
  });

  it("renews only the exact active operation lease owned by the token", async () => {
    mockFindOneAndUpdate
      .mockReturnValueOnce(leanResult({ _id: "operation-record" }))
      .mockReturnValueOnce(leanResult(null));

    const params = {
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      operationId: generatedOperationFixture.campaignId,
      reservationToken: "owner-token",
    };
    await expect(renewGeneratedBulkSendOperationLease(params)).resolves.toBe(
      true
    );
    await expect(
      renewGeneratedBulkSendOperationLease({
        ...params,
        reservationToken: "stale-token",
      })
    ).resolves.toBe(false);

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: generatedOperationFixture.campaignId,
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        operationState: "active",
        reservationToken: "owner-token",
      }),
      expect.objectContaining({
        $set: { reservationExpiresAt: expect.any(Date) },
        $unset: { expiresAt: "" },
      }),
      { new: true }
    );
  });

  it("compare-and-sets UTF-8-bounded progress for the exact owner", async () => {
    mockFindOneAndUpdate
      .mockReturnValueOnce(leanResult({ progressVersion: 3 }))
      .mockReturnValueOnce(leanResult(null));

    const params = {
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      operationId: generatedOperationFixture.campaignId,
      reservationToken: "owner-token",
      expectedProgressVersion: 2,
      progressBody: {
        children: [{ campaignId: "child-1", stage: "admitted" }],
      },
    };

    await expect(
      compareAndSetGeneratedBulkSendOperationProgress(params)
    ).resolves.toEqual({ progressVersion: 3 });
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: generatedOperationFixture.campaignId,
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        operationState: "active",
        reservationToken: "owner-token",
        progressVersion: 2,
      }),
      {
        $set: {
          progressBody: JSON.stringify(params.progressBody),
        },
        $inc: { progressVersion: 1 },
      },
      { new: true }
    );

    await expect(
      compareAndSetGeneratedBulkSendOperationProgress({
        ...params,
        reservationToken: "stale-owner",
      })
    ).resolves.toBeNull();

    mockFindOneAndUpdate.mockClear();
    await expect(
      compareAndSetGeneratedBulkSendOperationProgress({
        ...params,
        progressBody: { payload: "é".repeat(128 * 1024) },
      })
    ).rejects.toThrow("256 KiB");
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("releases only the exact active operation lease", async () => {
    mockFindOneAndUpdate
      .mockReturnValueOnce(leanResult({ _id: "operation-record" }))
      .mockReturnValueOnce(leanResult(null));

    const params = {
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      operationId: generatedOperationFixture.campaignId,
      reservationToken: "owner-token",
    };
    await expect(releaseGeneratedBulkSendOperationLease(params)).resolves.toBe(
      true
    );
    await expect(
      releaseGeneratedBulkSendOperationLease({
        ...params,
        reservationToken: "stale-token",
      })
    ).resolves.toBe(false);

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: generatedOperationFixture.campaignId,
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        operationState: "active",
        reservationToken: "owner-token",
      }),
      {
        $unset: {
          reservationExpiresAt: "",
          reservationToken: "",
        },
      },
      { new: true }
    );
  });

  it("bounds completion, clears active ownership, and sets terminal expiry", async () => {
    mockFindOneAndUpdate.mockReturnValueOnce(
      leanResult({ _id: "operation-record" })
    );
    const params = {
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      operationId: generatedOperationFixture.campaignId,
      reservationToken: "owner-token",
      responseBody: {
        success: true,
        children: [{ campaignId: "child-1" }],
      },
    };

    await expect(completeGeneratedBulkSendOperation(params)).resolves.toBe(
      true
    );
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: generatedOperationFixture.campaignId,
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        operationKind: "generated_scenario_send",
        operationState: "active",
        reservationToken: "owner-token",
        requestDigest: { $exists: true },
      }),
      {
        $set: {
          operationState: "completed",
          responseBody: JSON.stringify(params.responseBody),
          expiresAt: expect.any(Date),
        },
        $unset: {
          activeScenarioKey: "",
          reservationExpiresAt: "",
          reservationToken: "",
        },
      },
      { new: true }
    );

    mockFindOneAndUpdate.mockClear();
    await expect(
      completeGeneratedBulkSendOperation({
        ...params,
        responseBody: { payload: "é".repeat(128 * 1024) },
      })
    ).rejects.toThrow("256 KiB");
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("terminalizes the exact owner and clears scenario ownership for a new revision", async () => {
    const storedDocument: Record<string, unknown> = {
      ...generatedOperationFixture,
      requestDigestVersion: 1,
      requestDigest: "request-digest-1",
      reservationToken: "owner-token",
    };
    mockFindOneAndUpdate.mockImplementationOnce(
      (
        _filter: Record<string, unknown>,
        update: {
          $set: Record<string, unknown>;
          $unset: Record<string, unknown>;
        }
      ) => {
        Object.assign(storedDocument, update.$set);
        for (const key of Object.keys(update.$unset)) {
          delete storedDocument[key];
        }
        return leanResult(storedDocument);
      }
    );
    const params = {
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      operationId: generatedOperationFixture.campaignId,
      reservationToken: "owner-token",
      responseStatus: 409,
      responseBody: {
        operationDisposition: "in_progress",
        code: "generated_bulk_send_child_terminal",
        retryable: false,
      },
    };

    await expect(failGeneratedBulkSendOperation(params)).resolves.toBe(true);
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: generatedOperationFixture.campaignId,
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        operationKind: "generated_scenario_send",
        operationState: "active",
        reservationToken: "owner-token",
        requestDigest: { $exists: true },
      }),
      {
        $set: {
          operationState: "failed",
          responseStatus: 409,
          responseBody: JSON.stringify(params.responseBody),
          expiresAt: expect.any(Date),
        },
        $unset: {
          activeScenarioKey: "",
          reservationExpiresAt: "",
          reservationToken: "",
        },
      },
      { new: true }
    );
    expect(storedDocument).toEqual(
      expect.objectContaining({
        operationState: "failed",
        responseStatus: 409,
      })
    );
    expect(storedDocument).not.toHaveProperty("activeScenarioKey");

    mockFindOne.mockImplementation((filter: Record<string, unknown>) => {
      if ("keyHash" in filter) return selectedLeanResult(null);
      if ("activeScenarioKey" in filter) {
        return selectedLeanResult(
          storedDocument.operationState === "active" &&
            typeof storedDocument.activeScenarioKey === "string"
            ? storedDocument
            : null
        );
      }
      return selectedLeanResult(null);
    });
    mockCreate.mockImplementation(
      async (document: Record<string, unknown>) => document
    );

    await expect(
      reserveGeneratedBulkSendOperation({
        ...generatedOperationRequest,
        idempotencyKey: "fresh-key-for-generation-job-2",
        audienceRevision: "generation-job-2",
        intentDigest: "intent-digest-2",
      })
    ).resolves.toEqual(
      expect.objectContaining({
        status: "acquired",
        isNew: true,
        audienceRevision: "generation-job-2",
      })
    );
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        operationState: "active",
        audienceRevision: "generation-job-2",
        activeScenarioKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
    );
  });

  it("deletes only an exact token-owned operation before progress or claim", async () => {
    mockDeleteOne.mockResolvedValueOnce({ deletedCount: 1 });
    const params = {
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      operationId: generatedOperationFixture.campaignId,
      reservationToken: "owner-token",
    };

    await expect(
      deleteGeneratedBulkSendOperationBeforeClaim(params)
    ).resolves.toBe(true);
    expect(mockDeleteOne).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: generatedOperationFixture.campaignId,
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        operationKind: "generated_scenario_send",
        operationState: "active",
        reservationToken: "owner-token",
        progressBody: { $exists: false },
      })
    );
  });

  it("declares exact generated-operation fields, TTL, uniqueness, and lease indexes", () => {
    const bulkSendModel = jest.requireActual<
      typeof import("@/models/bulk-send-api-idempotency")
    >("@/models/bulk-send-api-idempotency").default;

    expect(bulkSendModel.schema.path("audienceRevision")?.instance).toBe(
      "String"
    );
    expect(bulkSendModel.schema.path("requestedAtIso")?.instance).toBe(
      "String"
    );
    expect(bulkSendModel.schema.path("audienceCutoffAt")).toBeUndefined();
    expect(bulkSendModel.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { keyHash: 1 },
          expect.objectContaining({
            name: "keyHash_1",
            unique: true,
          }),
        ],
        [
          { activeScenarioKey: 1 },
          expect.objectContaining({ unique: true, sparse: true }),
        ],
        [
          { campaignId: 1 },
          expect.objectContaining({ unique: true, sparse: true }),
        ],
        [
          {
            workspaceId: 1,
            scenarioId: 1,
            operationState: 1,
            reservationExpiresAt: 1,
          },
          expect.any(Object),
        ],
        [
          { createdAt: 1 },
          expect.objectContaining({
            expireAfterSeconds: 60 * 60 * 24,
            partialFilterExpression: {
              operationKind: "legacy_bulk_send",
            },
          }),
        ],
        [{ expiresAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })],
      ])
    );
  });
});

describe("deriveBulkSendChildCampaignId", () => {
  it("derives stable UUIDs from the parent operation and partition key", () => {
    const parentOperationId = "5aa519ce-3dcb-5307-8688-84a631ea25c5";

    expect(
      deriveBulkSendChildCampaignId(parentOperationId, "email:source-1")
    ).toBe("9eb806d4-8599-54bb-a8c7-a14f46760013");
    expect(
      deriveBulkSendChildCampaignId(parentOperationId, "email:source-1")
    ).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(
      deriveBulkSendChildCampaignId(parentOperationId, "email:source-2")
    ).not.toBe("9eb806d4-8599-54bb-a8c7-a14f46760013");
  });
});
