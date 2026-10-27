/**
 * @jest-environment node
 */

import {
  WHATSAPP_FLOW_PROVISIONING_PROVIDER_STATUSES,
  WHATSAPP_FLOW_PROVISIONING_RELEASE_MODES,
} from "@/lib/whatsapp/flows/provisioning-contract";

import {
  WhatsAppFlowProvisioningOperation,
  WHATSAPP_FLOW_PROVISIONING_OPERATION_INDEXES,
} from "./whatsapp-flow-provisioning-operation";

const VALID_PROVISIONING_INSERT = {
  operationId: "operation-1",
  operationKeyHash: "a".repeat(64),
  workspaceId: "workspace-1",
  scenarioId: "scenario-1",
  nodeId: "node-1",
  targetOwner: "template",
  sourceId: "source-1",
  wabaId: "waba-1",
  releaseMode: "data_endpoint",
  endpointId: "endpoint-1",
  applicationId: "application-1",
  contentRevision: 1,
  contentDigest: "b".repeat(64),
  providerMarker: "airi-operation-1",
  providerStatus: "DRAFT",
  stage: "CREATING_FLOW",
  status: "RUNNING",
  lease: { fence: 0 },
};

function stubProvisioningCollectionWrites() {
  return jest
    .spyOn(WhatsAppFlowProvisioningOperation.collection, "updateOne")
    .mockResolvedValue({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
      upsertedCount: 0,
      upsertedId: null,
    } as never);
}

function buildOperation(
  overrides: Record<string, unknown> = {}
): InstanceType<typeof WhatsAppFlowProvisioningOperation> {
  const providerAcknowledgement =
    typeof overrides.providerFlowId === "string" &&
    !Object.prototype.hasOwnProperty.call(overrides, "providerAcknowledgedAt")
      ? {
          providerAcknowledgedAt: new Date("2026-07-30T10:00:00.000Z"),
        }
      : {};
  return new WhatsAppFlowProvisioningOperation({
    operationId: "operation-1",
    operationKeyHash: "a".repeat(64),
    workspaceId: "workspace-1",
    scenarioId: "scenario-1",
    nodeId: "node-1",
    targetOwner: "template",
    sourceId: "source-1",
    wabaId: "waba-1",
    releaseMode: "data_endpoint",
    endpointId: "endpoint-1",
    applicationId: "application-1",
    contentRevision: 1,
    contentDigest: "b".repeat(64),
    providerMarker: "airi-operation-1",
    providerStatus: "DRAFT",
    stage: "CREATING_FLOW",
    status: "RUNNING",
    lease: {
      ownerToken: "worker-1",
      fence: 1,
      expiresAt: new Date("2026-07-30T10:05:00.000Z"),
    },
    ...providerAcknowledgement,
    ...overrides,
  });
}

describe("WhatsAppFlowProvisioningOperation", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("uses an explicit strict collection contract and ordered state enums", () => {
    expect(WhatsAppFlowProvisioningOperation.collection.collectionName).toBe(
      "whatsapp_flow_provisioning_operations"
    );
    expect(WhatsAppFlowProvisioningOperation.schema.get("versionKey")).toBe(
      false
    );
    expect(WhatsAppFlowProvisioningOperation.schema.get("strict")).toBe(
      "throw"
    );
    expect(
      WhatsAppFlowProvisioningOperation.schema.path("stage")?.options.enum
    ).toEqual([
      "CREATING_FLOW",
      "ATTACHING_APPLICATION",
      "ENSURING_PHONE_KEYS",
      "UPLOADING_JSON",
      "PUBLISHING",
      "READING_BACK",
      "COMPLETED",
    ]);
    expect(
      WhatsAppFlowProvisioningOperation.schema.path("status")?.options.enum
    ).toEqual([
      "RUNNING",
      "FAILED",
      "COMPLETED",
      "SUPERSEDED",
      "MANUALLY_RESOLVED",
    ]);
    expect(WHATSAPP_FLOW_PROVISIONING_RELEASE_MODES).toEqual([
      "linear",
      "data_endpoint",
    ]);
    expect(
      WhatsAppFlowProvisioningOperation.schema.path("releaseMode")?.options.enum
    ).toEqual(WHATSAPP_FLOW_PROVISIONING_RELEASE_MODES);
    expect(
      WhatsAppFlowProvisioningOperation.schema.path("providerStatus")?.options
        .enum
    ).toEqual(WHATSAPP_FLOW_PROVISIONING_PROVIDER_STATUSES);

    expect(
      WhatsAppFlowProvisioningOperation.schema.path("privateKey")
    ).toBeUndefined();
    expect(
      WhatsAppFlowProvisioningOperation.schema.path("accessToken")
    ).toBeUndefined();
  });

  it("requires endpoint bindings only for data-endpoint releases", () => {
    expect(
      buildOperation({
        releaseMode: "linear",
        endpointId: undefined,
        applicationId: undefined,
      }).validateSync()
    ).toBeUndefined();
    expect(
      buildOperation({ endpointId: undefined }).validateSync()?.errors
        .endpointId
    ).toBeDefined();
    expect(
      buildOperation({ applicationId: undefined }).validateSync()?.errors
        .applicationId
    ).toBeDefined();
    expect(
      buildOperation({
        releaseMode: "linear",
        endpointId: "endpoint-1",
        applicationId: undefined,
      }).validateSync()
    ).toBeDefined();
    expect(
      buildOperation({ releaseMode: "unsupported" }).validateSync()?.errors
        .releaseMode
    ).toBeDefined();
  });

  it("requires provider Flow ID and acknowledgement time as one durable pair", async () => {
    const acknowledgedAt = new Date("2026-07-30T10:00:00.000Z");

    expect(
      buildOperation({
        providerFlowId: "flow-1",
        providerAcknowledgedAt: acknowledgedAt,
      }).validateSync()
    ).toBeUndefined();
    expect(
      buildOperation({
        providerFlowId: "flow-1",
        providerAcknowledgedAt: undefined,
      }).validateSync()
    ).toBeDefined();
    expect(
      buildOperation({
        providerFlowId: undefined,
        providerAcknowledgedAt: acknowledgedAt,
      }).validateSync()
    ).toBeDefined();

    const updateOne = stubProvisioningCollectionWrites();
    const pairQuery = WhatsAppFlowProvisioningOperation.updateOne(
      { operationId: "operation-1", providerFlowId: { $exists: false } },
      {
        $set: {
          providerFlowId: "flow-1",
          providerAcknowledgedAt: acknowledgedAt,
        },
      },
      { runValidators: true }
    );
    await expect(pairQuery.exec()).resolves.toMatchObject({
      acknowledged: true,
    });
    expect(updateOne).toHaveBeenCalledTimes(1);
    updateOne.mockClear();

    for (const update of [
      { $set: { providerFlowId: "flow-1" } },
      { $set: { providerAcknowledgedAt: acknowledgedAt } },
      { $unset: { providerFlowId: 1, providerAcknowledgedAt: 1 } },
    ]) {
      const query = WhatsAppFlowProvisioningOperation.updateOne(
        { operationId: "operation-1" },
        update,
        { runValidators: true }
      );
      await expect(query.exec()).rejects.toThrow();
      expect(updateOne).not.toHaveBeenCalled();
    }
  });

  it("keeps active and authoritative completed operations out of TTL cleanup", () => {
    expect(buildOperation().validateSync()).toBeUndefined();
    expect(
      buildOperation({
        status: "FAILED",
        lastError: {
          code: "META_REQUEST_FAILED",
          message: "Provider rejected the draft",
          stage: "CREATING_FLOW",
          retryable: true,
          at: new Date("2026-07-30T10:03:00.000Z"),
        },
      }).validateSync()
    ).toBeUndefined();

    expect(
      buildOperation({
        status: "FAILED",
        cleanupAt: new Date("2026-08-30T10:00:00.000Z"),
      }).validateSync()?.errors.cleanupAt
    ).toBeDefined();
    expect(
      buildOperation({
        stage: "COMPLETED",
        status: "COMPLETED",
      }).validateSync()
    ).toBeUndefined();
    expect(
      buildOperation({
        stage: "COMPLETED",
        status: "COMPLETED",
        cleanupAt: new Date("2026-08-30T10:00:00.000Z"),
      }).validateSync()?.errors.cleanupAt
    ).toBeDefined();
    expect(
      buildOperation({
        stage: "COMPLETED",
        status: "SUPERSEDED",
        providerFlowId: "flow-1",
      }).validateSync()
    ).toBeUndefined();
    expect(
      buildOperation({
        stage: "COMPLETED",
        status: "SUPERSEDED",
        cleanupAt: new Date("2026-08-30T10:00:00.000Z"),
      }).validateSync()
    ).toBeUndefined();
    expect(
      buildOperation({
        stage: "READING_BACK",
        status: "COMPLETED",
        cleanupAt: new Date("2026-08-30T10:00:00.000Z"),
      }).validateSync()
    ).toBeDefined();
    expect(
      buildOperation({
        stage: "COMPLETED",
        status: "FAILED",
      }).validateSync()
    ).toBeDefined();
  });

  it("requires complete provider-confirmed evidence before published Flow resolution", () => {
    const cleanupAt = new Date("2026-08-30T10:00:00.000Z");
    const requestedAt = new Date("2026-07-30T10:00:00.000Z");
    const confirmedAt = new Date("2026-07-30T10:01:00.000Z");

    expect(
      buildOperation({
        stage: "COMPLETED",
        status: "SUPERSEDED",
        providerFlowId: "flow-1",
        providerStatus: "PUBLISHED",
        providerResolution: {
          kind: "published_deprecated",
          requestedAt,
          requestedBy: "operator-1",
        },
      }).validateSync()
    ).toBeUndefined();
    expect(
      buildOperation({
        stage: "CREATING_FLOW",
        status: "SUPERSEDED",
        providerFlowId: "flow-1",
        providerStatus: undefined,
        providerResolution: {
          kind: "draft_deleted",
          requestedAt,
          requestedBy: "operator-1",
        },
      }).validateSync()
    ).toBeUndefined();
    expect(
      buildOperation({
        stage: "READING_BACK",
        status: "SUPERSEDED",
        providerFlowId: "flow-1",
        providerStatus: "THROTTLED",
        providerResolution: {
          kind: "published_deprecated",
          requestedAt,
          requestedBy: "operator-1",
        },
      }).validateSync()
    ).toBeUndefined();
    expect(
      buildOperation({
        stage: "COMPLETED",
        status: "SUPERSEDED",
        providerFlowId: "flow-1",
        providerStatus: "PUBLISHED",
        providerResolution: {
          kind: "published_deprecated",
          requestedAt,
          requestedBy: "operator-1",
          outcome: "deprecated",
          confirmedAt,
          confirmedBy: "operator-1",
        },
      }).validateSync()
    ).toBeDefined();
    expect(
      buildOperation({
        stage: "COMPLETED",
        status: "MANUALLY_RESOLVED",
        providerFlowId: "flow-1",
        providerStatus: "DEPRECATED",
        cleanupAt,
        providerResolution: {
          kind: "published_deprecated",
          requestedAt,
          requestedBy: "operator-1",
          outcome: "deprecated",
          confirmedAt,
          confirmedBy: "operator-2",
        },
      }).validateSync()
    ).toBeUndefined();

    for (const overrides of [
      {
        providerStatus: "PUBLISHED",
        providerResolution: {
          kind: "published_deprecated",
          requestedAt,
          requestedBy: "operator-1",
          outcome: "deprecated",
          confirmedAt,
          confirmedBy: "operator-2",
        },
      },
      {
        providerStatus: "DEPRECATED",
        providerResolution: {
          kind: "published_deprecated",
          requestedAt,
          requestedBy: "operator-1",
        },
      },
      {
        providerStatus: "DEPRECATED",
        providerResolution: undefined,
      },
    ]) {
      expect(
        buildOperation({
          stage: "COMPLETED",
          status: "MANUALLY_RESOLVED",
          providerFlowId: "flow-1",
          cleanupAt,
          ...overrides,
        }).validateSync()
      ).toBeDefined();
    }
  });

  it("keeps missing-provider-draft resolution distinct from Flow retirement", () => {
    const cleanupAt = new Date("2026-08-30T10:00:00.000Z");
    const lastError = {
      code: "WHATSAPP_FLOW_PROVISIONING_CREATE_FAILED",
      message: "Meta no longer has the acknowledged Flow draft",
      stage: "CREATING_FLOW" as const,
      providerCode: 100,
      providerSubcode: 33,
      retryable: true,
      at: new Date("2026-07-30T10:00:00.000Z"),
    };

    expect(
      buildOperation({
        stage: "CREATING_FLOW",
        status: "MANUALLY_RESOLVED",
        providerFlowId: "flow-missing",
        providerStatus: undefined,
        cleanupAt,
        lastError,
      }).validateSync()
    ).toBeUndefined();

    for (const overrides of [
      { providerFlowId: undefined },
      {
        stage: "UPLOADING_JSON",
        lastError: { ...lastError, stage: "UPLOADING_JSON" },
      },
      { providerStatus: "DRAFT" },
      { providerStatus: "DEPRECATED" },
      {
        providerResolution: {
          kind: "draft_deleted",
          requestedAt: lastError.at,
          requestedBy: "operator-1",
        },
      },
      { lastError: undefined },
    ]) {
      expect(
        buildOperation({
          stage: "CREATING_FLOW",
          status: "MANUALLY_RESOLVED",
          providerFlowId: "flow-missing",
          providerStatus: undefined,
          cleanupAt,
          lastError,
          ...overrides,
        }).validateSync()
      ).toBeDefined();
    }
  });

  it("requires provider-confirmed evidence before deleted draft resolution", () => {
    const requestedAt = new Date("2026-07-30T10:00:00.000Z");
    const confirmedAt = new Date("2026-07-30T10:01:00.000Z");
    const cleanupAt = new Date("2026-08-29T10:01:00.000Z");

    expect(
      buildOperation({
        stage: "UPLOADING_JSON",
        status: "SUPERSEDED",
        providerFlowId: "flow-draft",
        providerStatus: "DRAFT",
        providerResolution: {
          kind: "draft_deleted",
          requestedAt,
          requestedBy: "operator-1",
        },
      }).validateSync()
    ).toBeUndefined();
    expect(
      buildOperation({
        stage: "UPLOADING_JSON",
        status: "MANUALLY_RESOLVED",
        providerFlowId: "flow-draft",
        providerStatus: undefined,
        cleanupAt,
        providerResolution: {
          kind: "draft_deleted",
          requestedAt,
          requestedBy: "operator-1",
          outcome: "missing",
          confirmedAt,
          confirmedBy: "operator-2",
        },
      }).validateSync()
    ).toBeUndefined();
    expect(
      buildOperation({
        stage: "UPLOADING_JSON",
        status: "MANUALLY_RESOLVED",
        providerFlowId: "flow-draft",
        providerStatus: "DRAFT",
        cleanupAt,
        providerResolution: {
          kind: "draft_deleted",
          requestedAt,
          requestedBy: "operator-1",
          outcome: "missing",
          confirmedAt,
          confirmedBy: "operator-2",
        },
      }).validateSync()
    ).toBeDefined();
  });

  it("allows only an atomic request or confirmed provider resolution transition", async () => {
    const updateOne = stubProvisioningCollectionWrites();
    const requestedAt = new Date("2026-07-30T10:00:00.000Z");
    const confirmedAt = new Date("2026-07-30T10:01:00.000Z");
    const cleanupAt = new Date("2026-08-29T10:01:00.000Z");

    await expect(
      WhatsAppFlowProvisioningOperation.updateOne(
        { operationId: "operation-1", status: "SUPERSEDED" },
        {
          $set: {
            status: "SUPERSEDED",
            stage: "COMPLETED",
            providerResolution: {
              kind: "published_deprecated",
              requestedAt,
              requestedBy: "operator-1",
            },
          },
          $unset: { cleanupAt: 1 },
        },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    updateOne.mockClear();

    await expect(
      WhatsAppFlowProvisioningOperation.updateOne(
        { operationId: "operation-1", status: "SUPERSEDED" },
        {
          $set: {
            status: "MANUALLY_RESOLVED",
            stage: "COMPLETED",
            providerStatus: "DEPRECATED",
            cleanupAt,
            providerResolution: {
              kind: "published_deprecated",
              requestedAt,
              requestedBy: "operator-1",
              outcome: "deprecated",
              confirmedAt,
              confirmedBy: "operator-2",
            },
          },
        },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    updateOne.mockClear();

    for (const update of [
      {
        $set: {
          providerResolution: {
            kind: "published_deprecated",
            requestedAt,
            requestedBy: "operator-1",
            outcome: "deprecated",
            confirmedAt,
            confirmedBy: "operator-1",
          },
        },
      },
      {
        $set: {
          status: "MANUALLY_RESOLVED",
          stage: "COMPLETED",
          providerStatus: "DEPRECATED",
          cleanupAt,
        },
      },
      {
        $set: {
          status: "MANUALLY_RESOLVED",
          stage: "COMPLETED",
          providerStatus: "PUBLISHED",
          cleanupAt,
          providerResolution: {
            kind: "published_deprecated",
            requestedAt,
            requestedBy: "operator-1",
            outcome: "deprecated",
            confirmedAt,
            confirmedBy: "operator-1",
          },
        },
      },
    ]) {
      await expect(
        WhatsAppFlowProvisioningOperation.updateOne(
          { operationId: "operation-1", status: "SUPERSEDED" },
          update,
          { runValidators: true }
        ).exec()
      ).rejects.toThrow();
      expect(updateOne).not.toHaveBeenCalled();
    }
  });

  it("allows only the exact atomic missing-provider-draft terminal transition", async () => {
    const updateOne = stubProvisioningCollectionWrites();
    const cleanupAt = new Date("2026-08-29T10:00:00.000Z");
    const lastError = {
      code: "WHATSAPP_FLOW_PROVISIONING_CREATE_FAILED",
      message: "Meta no longer has the acknowledged Flow draft",
      stage: "CREATING_FLOW" as const,
      providerCode: 100,
      providerSubcode: 33,
      retryable: true,
      at: new Date("2026-07-30T10:00:00.000Z"),
    };

    await expect(
      WhatsAppFlowProvisioningOperation.updateOne(
        {
          operationId: "operation-1",
          status: "RUNNING",
          stage: "CREATING_FLOW",
          providerFlowId: "flow-missing",
        },
        {
          $set: {
            status: "MANUALLY_RESOLVED",
            stage: "CREATING_FLOW",
            cleanupAt,
            lastError,
          },
          $unset: {
            providerStatus: 1,
            "lease.ownerToken": 1,
            "lease.expiresAt": 1,
          },
        },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    updateOne.mockClear();

    for (const update of [
      {
        $set: {
          status: "MANUALLY_RESOLVED",
          stage: "CREATING_FLOW",
          cleanupAt,
        },
      },
      {
        $set: {
          status: "MANUALLY_RESOLVED",
          stage: "UPLOADING_JSON",
          cleanupAt,
          lastError: { ...lastError, stage: "UPLOADING_JSON" },
        },
      },
    ]) {
      await expect(
        WhatsAppFlowProvisioningOperation.updateOne(
          {
            operationId: "operation-1",
            status: "RUNNING",
            stage: "CREATING_FLOW",
            providerFlowId: "flow-missing",
          },
          update,
          { runValidators: true }
        ).exec()
      ).rejects.toThrow();
      expect(updateOne).not.toHaveBeenCalled();
    }
  });

  it("atomically confirms provider draft deletion with absent-provider truth", async () => {
    const updateOne = stubProvisioningCollectionWrites();
    const requestedAt = new Date("2026-07-30T10:00:00.000Z");
    const confirmedAt = new Date("2026-07-30T10:01:00.000Z");
    const cleanupAt = new Date("2026-08-29T10:01:00.000Z");

    await expect(
      WhatsAppFlowProvisioningOperation.updateOne(
        { operationId: "operation-1", status: "FAILED" },
        {
          $set: {
            status: "SUPERSEDED",
            stage: "UPLOADING_JSON",
            providerResolution: {
              kind: "draft_deleted",
              requestedAt,
              requestedBy: "operator-1",
            },
          },
          $unset: { cleanupAt: 1 },
        },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    updateOne.mockClear();

    await expect(
      WhatsAppFlowProvisioningOperation.updateOne(
        { operationId: "operation-1", status: "SUPERSEDED" },
        {
          $set: {
            status: "MANUALLY_RESOLVED",
            stage: "UPLOADING_JSON",
            cleanupAt,
            providerResolution: {
              kind: "draft_deleted",
              requestedAt,
              requestedBy: "operator-1",
              outcome: "missing",
              confirmedAt,
              confirmedBy: "operator-2",
            },
          },
          $unset: { providerStatus: 1 },
        },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    expect(updateOne).toHaveBeenCalledTimes(1);
  });

  it("validates retryable and terminal cleanup transitions in query context", async () => {
    const updateOne = stubProvisioningCollectionWrites();
    const retryableQuery = WhatsAppFlowProvisioningOperation.updateOne(
      { operationId: "operation-1", status: "RUNNING" },
      {
        $set: {
          status: "FAILED",
          stage: "CREATING_FLOW",
          lastError: {
            code: "META_REQUEST_FAILED",
            message: "Provider rejected the draft",
            stage: "CREATING_FLOW",
            retryable: true,
            at: new Date("2026-07-30T10:03:00.000Z"),
          },
        },
        $unset: { cleanupAt: 1 },
      },
      { runValidators: true }
    );
    await expect(retryableQuery.exec()).resolves.toMatchObject({
      acknowledged: true,
    });
    expect(updateOne).toHaveBeenCalledTimes(1);
    updateOne.mockClear();

    const terminalQuery = WhatsAppFlowProvisioningOperation.updateOne(
      { operationId: "operation-1", status: "RUNNING" },
      {
        $set: {
          status: "COMPLETED",
          stage: "COMPLETED",
        },
        $unset: { cleanupAt: 1 },
      },
      { runValidators: true }
    );
    await expect(terminalQuery.exec()).resolves.toMatchObject({
      acknowledged: true,
    });
    expect(updateOne).toHaveBeenCalledTimes(1);
    updateOne.mockClear();

    const leaseOnlyQuery = WhatsAppFlowProvisioningOperation.updateOne(
      { operationId: "operation-1", status: "RUNNING" },
      {
        $set: {
          "lease.ownerToken": "worker-1",
          "lease.expiresAt": new Date("2026-07-30T10:05:00.000Z"),
        },
        $inc: { "lease.fence": 1 },
      },
      { runValidators: true }
    );
    await expect(leaseOnlyQuery.exec()).resolves.toMatchObject({
      acknowledged: true,
    });
    expect(updateOne).toHaveBeenCalledTimes(1);
    updateOne.mockClear();

    const mutableStateQuery = WhatsAppFlowProvisioningOperation.updateOne(
      { operationId: "operation-1", status: "RUNNING" },
      {
        $set: {
          providerFlowId: "flow-1",
          providerAcknowledgedAt: new Date("2026-07-30T10:03:00.000Z"),
          providerFlowName: "airi-flow-1",
          providerStatus: "DRAFT",
          lastError: {
            code: "META_REQUEST_FAILED",
            message: "Provider rejected the draft",
            stage: "CREATING_FLOW",
            retryable: true,
            at: new Date("2026-07-30T10:03:00.000Z"),
          },
          "lease.ownerToken": "worker-2",
          "lease.expiresAt": new Date("2026-07-30T10:10:00.000Z"),
        },
      },
      { runValidators: true }
    );
    await expect(mutableStateQuery.exec()).resolves.toMatchObject({
      acknowledged: true,
    });
    expect(updateOne).toHaveBeenCalledTimes(1);
    updateOne.mockClear();

    const clearMutableStateQuery = WhatsAppFlowProvisioningOperation.updateOne(
      { operationId: "operation-1", status: "RUNNING" },
      {
        $unset: {
          providerFlowName: 1,
          lastError: 1,
          "lease.ownerToken": 1,
          "lease.expiresAt": 1,
        },
      },
      { runValidators: true }
    );
    await expect(clearMutableStateQuery.exec()).resolves.toMatchObject({
      acknowledged: true,
    });
    expect(updateOne).toHaveBeenCalledTimes(1);
    updateOne.mockClear();

    const insertQuery = WhatsAppFlowProvisioningOperation.updateOne(
      { operationKeyHash: "a".repeat(64) },
      {
        $setOnInsert: VALID_PROVISIONING_INSERT,
      },
      {
        runValidators: true,
        setDefaultsOnInsert: false,
        upsert: true,
      }
    );
    await expect(insertQuery.exec()).resolves.toMatchObject({
      acknowledged: true,
    });
    expect(updateOne).toHaveBeenCalledTimes(1);
  });

  it("rejects incomplete provisioning upserts even without status or stage", async () => {
    const updateOne = stubProvisioningCollectionWrites();
    const withoutLease: Record<string, unknown> = {
      ...VALID_PROVISIONING_INSERT,
    };
    delete withoutLease.lease;
    const invalidQueries = [
      WhatsAppFlowProvisioningOperation.updateOne(
        { operationKeyHash: "a".repeat(64) },
        {
          $setOnInsert: {
            operationId: "operation-1",
            operationKeyHash: "a".repeat(64),
          },
        },
        {
          setDefaultsOnInsert: false,
          upsert: true,
        }
      ),
      WhatsAppFlowProvisioningOperation.updateOne(
        { operationKeyHash: "a".repeat(64) },
        {
          $setOnInsert: {
            status: "RUNNING",
            stage: "CREATING_FLOW",
          },
        },
        {
          runValidators: true,
          setDefaultsOnInsert: false,
          upsert: true,
        }
      ),
      WhatsAppFlowProvisioningOperation.updateOne(
        { operationKeyHash: "a".repeat(64) },
        {
          $setOnInsert: withoutLease,
        },
        {
          runValidators: true,
          upsert: true,
        }
      ),
    ];

    for (const query of invalidQueries) {
      await expect(query.exec()).rejects.toThrow();
      expect(updateOne).not.toHaveBeenCalled();
    }
  });

  it("enforces release-mode bindings on provisioning upserts", async () => {
    const updateOne = stubProvisioningCollectionWrites();
    const linearInsert: Record<string, unknown> = {
      ...VALID_PROVISIONING_INSERT,
      releaseMode: "linear",
    };
    delete linearInsert.endpointId;
    delete linearInsert.applicationId;

    await expect(
      WhatsAppFlowProvisioningOperation.updateOne(
        { operationKeyHash: "a".repeat(64) },
        { $setOnInsert: linearInsert },
        {
          runValidators: true,
          setDefaultsOnInsert: false,
          upsert: true,
        }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    expect(updateOne).toHaveBeenCalledTimes(1);
    updateOne.mockClear();

    const missingEndpoint: Record<string, unknown> = {
      ...VALID_PROVISIONING_INSERT,
    };
    delete missingEndpoint.endpointId;
    const linearWithEndpoint = {
      ...linearInsert,
      endpointId: "endpoint-1",
    };
    for (const invalidInsert of [missingEndpoint, linearWithEndpoint]) {
      const query = WhatsAppFlowProvisioningOperation.updateOne(
        { operationKeyHash: "a".repeat(64) },
        { $setOnInsert: invalidInsert },
        {
          runValidators: true,
          setDefaultsOnInsert: false,
          upsert: true,
        }
      );
      await expect(query.exec()).rejects.toThrow();
      expect(updateOne).not.toHaveBeenCalled();
    }
  });

  it("rejects existing-row provisioning identity mutations", async () => {
    const updateOne = stubProvisioningCollectionWrites();
    const mutations = [
      { operationId: "operation-2" },
      { operationKeyHash: "c".repeat(64) },
      { workspaceId: "workspace-2" },
      { scenarioId: "scenario-2" },
      { nodeId: "node-2" },
      { targetOwner: "service_message" },
      { sourceId: "source-2" },
      { wabaId: "waba-2" },
      { releaseMode: "linear" },
      { endpointId: "endpoint-2" },
      { applicationId: "application-2" },
      { replacesOperationId: "operation-2" },
      { cloneFlowId: "flow-2" },
      { contentRevision: 2 },
      { contentDigest: "c".repeat(64) },
      { providerMarker: "airi-operation-2" },
    ];

    for (const mutation of mutations) {
      const query = WhatsAppFlowProvisioningOperation.updateOne(
        { operationId: "operation-1" },
        { $set: mutation },
        { runValidators: true }
      );
      await expect(query.exec()).rejects.toThrow();
      expect(updateOne).not.toHaveBeenCalled();
    }
  });

  it.each([
    {
      label: "negative content revision",
      update: { $set: { contentRevision: -1 } },
    },
    {
      label: "malformed content digest",
      update: { $set: { contentDigest: "bad" } },
    },
    {
      label: "negative lease fence assignment",
      update: { $set: { "lease.fence": -1 } },
      options: { runValidators: true },
    },
    {
      label: "non-monotonic lease fence assignment",
      update: { $set: { "lease.fence": 2 } },
      options: { runValidators: true },
    },
    {
      label: "whole lease replacement that can overwrite its fence",
      update: {
        $set: {
          lease: {
            ownerToken: "worker-1",
            fence: 1,
          },
        },
      },
      options: { runValidators: true },
    },
    {
      label: "negative lease fence increment",
      update: { $inc: { "lease.fence": -1 } },
    },
    {
      label: "zero lease fence increment",
      update: { $inc: { "lease.fence": 0 } },
    },
    {
      label: "multi-step lease fence increment",
      update: { $inc: { "lease.fence": 2 } },
    },
    {
      label: "nonnumeric lease fence increment",
      update: { $inc: { "lease.fence": "1" } },
    },
    {
      label: "increment on another mutable path",
      update: { $inc: { contentRevision: 1 } },
    },
    {
      label: "unsupported lease operator",
      update: { $mul: { "lease.fence": 2 } },
    },
    {
      label: "invalid error stage",
      update: {
        $set: {
          lastError: {
            code: "META_REQUEST_FAILED",
            message: "Provider rejected the draft",
            stage: "BOGUS",
            retryable: true,
            at: new Date("2026-07-30T10:03:00.000Z"),
          },
        },
      },
    },
    {
      label: "oversized provider flow name",
      update: { $set: { providerFlowName: "x".repeat(300) } },
    },
    {
      label: "oversized provider flow ID",
      update: { $set: { providerFlowId: "x".repeat(300) } },
    },
    {
      label: "invalid provider status",
      update: { $set: { providerStatus: "UNKNOWN" } },
      options: { runValidators: true },
    },
    {
      label: "valid mutable state without validators",
      update: { $set: { contentRevision: 2 } },
    },
  ])("rejects $label before Mongo", async ({ update, options }) => {
    const updateOne = stubProvisioningCollectionWrites();
    const query = WhatsAppFlowProvisioningOperation.updateOne(
      { operationId: "operation-1" },
      update as never,
      options
    );

    await expect(query.exec()).rejects.toThrow();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("rejects invalid or comparison-less atomic cleanup transitions", async () => {
    const updateOne = stubProvisioningCollectionWrites();
    const invalidQueries = [
      WhatsAppFlowProvisioningOperation.updateOne(
        { operationId: "operation-1", status: "RUNNING" },
        {
          $set: {
            status: "COMPLETED",
            stage: "COMPLETED",
          },
        },
        { runValidators: true }
      ),
      WhatsAppFlowProvisioningOperation.updateOne(
        { operationId: "operation-1", status: "RUNNING" },
        {
          $set: {
            stage: "NOT_A_STAGE",
          },
        },
        { runValidators: true }
      ),
      WhatsAppFlowProvisioningOperation.updateOne(
        { operationId: "operation-1", status: "RUNNING" },
        {
          $set: {
            status: "FAILED",
            cleanupAt: new Date("2026-08-30T10:00:00.000Z"),
          },
        },
        { runValidators: true }
      ),
      WhatsAppFlowProvisioningOperation.updateOne(
        { operationId: "operation-1" },
        {
          $set: {
            cleanupAt: new Date("2026-08-30T10:00:00.000Z"),
          },
        },
        { runValidators: true }
      ),
    ];

    for (const query of invalidQueries) {
      await expect(query.exec()).rejects.toThrow();
      expect(updateOne).not.toHaveBeenCalled();
    }
  });

  it("rejects status-stage contradictions and invariant bypasses before Mongo", async () => {
    const updateOne = stubProvisioningCollectionWrites();
    const invalidQueries = [
      WhatsAppFlowProvisioningOperation.updateOne(
        { operationId: "operation-1", status: "RUNNING" },
        {
          $set: {
            status: "COMPLETED",
            stage: "READING_BACK",
            cleanupAt: new Date("2026-08-30T10:00:00.000Z"),
          },
        },
        { runValidators: true }
      ),
      WhatsAppFlowProvisioningOperation.updateOne(
        { operationId: "operation-1", status: "RUNNING" },
        {
          $set: {
            status: "FAILED",
            stage: "COMPLETED",
          },
          $unset: { cleanupAt: 1 },
        },
        { runValidators: true }
      ),
      WhatsAppFlowProvisioningOperation.updateOne(
        { operationId: "operation-1" },
        { $rename: { stage: "legacyStage" } },
        { runValidators: true }
      ),
      WhatsAppFlowProvisioningOperation.updateOne(
        { operationId: "operation-1" },
        { $rename: { legacyStage: "stage" } },
        { runValidators: true }
      ),
      WhatsAppFlowProvisioningOperation.updateOne(
        { operationId: "operation-1" },
        [
          {
            $set: {
              status: "COMPLETED",
              stage: "COMPLETED",
            },
          },
        ] as never,
        { runValidators: true }
      ),
      WhatsAppFlowProvisioningOperation.updateOne(
        { operationId: "operation-1" },
        {
          status: "COMPLETED",
          stage: "COMPLETED",
          cleanupAt: new Date("2026-08-30T10:00:00.000Z"),
        },
        { runValidators: true }
      ),
    ];

    for (const query of invalidQueries) {
      await expect(query.exec()).rejects.toThrow();
      expect(updateOne).not.toHaveBeenCalled();
    }
  });

  it("declares reconciliation, lease, lookup, and terminal-cleanup indexes", () => {
    expect(WHATSAPP_FLOW_PROVISIONING_OPERATION_INDEXES).toEqual([
      {
        key: { operationId: 1 },
        options: {
          background: true,
          unique: true,
          name: "whatsapp_flow_provisioning_operation_id_unique",
        },
      },
      {
        key: { operationKeyHash: 1 },
        options: {
          background: true,
          unique: true,
          name: "whatsapp_flow_provisioning_operation_key_hash_unique",
        },
      },
      {
        key: { wabaId: 1, providerMarker: 1 },
        options: {
          background: true,
          unique: true,
          name: "whatsapp_flow_provisioning_provider_marker_unique",
        },
      },
      {
        key: { wabaId: 1, providerFlowId: 1 },
        options: {
          background: true,
          unique: true,
          name: "whatsapp_flow_provisioning_provider_flow_unique",
          partialFilterExpression: {
            providerFlowId: { $type: "string" },
          },
        },
      },
      {
        key: {
          workspaceId: 1,
          scenarioId: 1,
          nodeId: 1,
          targetOwner: 1,
          sourceId: 1,
          wabaId: 1,
          releaseMode: 1,
          endpointId: 1,
          applicationId: 1,
          contentRevision: -1,
          createdAt: -1,
          operationId: -1,
        },
        options: {
          background: true,
          name: "whatsapp_flow_provisioning_binding_revision",
        },
      },
      {
        key: {
          workspaceId: 1,
          sourceId: 1,
          status: 1,
          providerFlowId: 1,
          wabaId: 1,
        },
        options: {
          background: true,
          name: "whatsapp_flow_provisioning_source_rebind",
        },
      },
      {
        key: { status: 1, "lease.expiresAt": 1 },
        options: {
          background: true,
          name: "whatsapp_flow_provisioning_status_lease",
        },
      },
      {
        key: { cleanupAt: 1 },
        options: {
          background: true,
          name: "whatsapp_flow_provisioning_cleanup_ttl",
          expireAfterSeconds: 0,
        },
      },
    ]);

    expect(WhatsAppFlowProvisioningOperation.schema.indexes()).toEqual(
      WHATSAPP_FLOW_PROVISIONING_OPERATION_INDEXES.map(index => [
        index.key,
        index.options,
      ])
    );
  });
});
