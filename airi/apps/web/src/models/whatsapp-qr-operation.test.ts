/**
 * @jest-environment node
 */

import {
  WhatsAppQrOperation,
  WHATSAPP_QR_OPERATION_INDEXES,
} from "./whatsapp-qr-operation";

function operation(overrides: Record<string, unknown> = {}) {
  return new WhatsAppQrOperation({
    operationId: "operation-1",
    workspaceId: "workspace-1",
    entryPointId: "entry-1",
    operationKeyHash: "a".repeat(64),
    requestDigest: "b".repeat(64),
    sourceId: "source-1",
    kind: "CREATE",
    status: "RUNNING",
    providerStage: "NOT_STARTED",
    expectedEntryPointVersion: 0,
    expectedCodeVersion: 0,
    currentCodeId: "code-1",
    lease: { fence: 0 },
    ...overrides,
  });
}
function stubWrites() {
  return jest
    .spyOn(WhatsAppQrOperation.collection, "updateOne")
    .mockResolvedValue({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
      upsertedCount: 0,
    } as never);
}
const FILTER = {
  operationId: "operation-1",
  workspaceId: "workspace-1",
  entryPointId: "entry-1",
  "lease.fence": 0,
};
const LEASE_EXPIRES_AT = new Date("2026-08-06T12:10:00.000Z");
const LIVE_RUNNING_FILTER = {
  operationId: "operation-1",
  workspaceId: "workspace-1",
  entryPointId: "entry-1",
  status: "RUNNING",
  "lease.ownerToken": "worker-1",
  "lease.fence": 1,
  "lease.expiresAt": { $gt: new Date("2026-08-06T12:00:00.000Z") },
};
const RUNNING_FILTER = { ...FILTER, status: "RUNNING" };
const COMPLETED_FILTER = { ...FILTER, status: "COMPLETED" };
const RESULT = {
  outcome: "applied",
  status: "COMPLETED",
  codeId: "code-1",
  entryPointVersion: 1,
  codeVersion: 1,
};

describe("WhatsAppQrOperation", () => {
  afterEach(() => jest.restoreAllMocks());
  it("uses fenced, bounded operation state without provider credentials or payloads", () => {
    expect(WhatsAppQrOperation.collection.collectionName).toBe(
      "whatsapp_qr_operations"
    );
    expect(WhatsAppQrOperation.schema.get("strict")).toBe("throw");
    expect(WhatsAppQrOperation.schema.path("kind")?.options.enum).toEqual([
      "CREATE",
      "CONNECT",
      "APPLY_MESSAGE",
      "REPLACE",
      "MOVE",
      "SET_ROUTING",
      "DELETE",
      "SYNC_PROVIDER",
      "RECONCILE",
    ]);
    expect(WhatsAppQrOperation.schema.path("status")?.options.enum).toEqual([
      "RUNNING",
      "RECONCILE_REQUIRED",
      "FAILED",
      "COMPLETED",
    ]);
    expect(operation().validateSync()).toBeUndefined();
    expect(
      operation({ operationKeyHash: "bad" }).validateSync()?.errors
        .operationKeyHash
    ).toBeDefined();
    expect(
      operation({ lease: { fence: -1 } }).validateSync()?.errors["lease.fence"]
    ).toBeDefined();
    expect(operation({ status: "COMPLETED" }).validateSync()).toBeDefined();
    expect(operation({ cleanupAt: new Date() }).validateSync()).toBeDefined();
    expect(WhatsAppQrOperation.schema.path("accessToken")).toBeUndefined();
    expect(WhatsAppQrOperation.schema.path("prefilledMessage")).toBeUndefined();
    expect(WhatsAppQrOperation.schema.path("expectedVersion")).toBeUndefined();
    expect(
      WhatsAppQrOperation.schema.path("expectedEntryPointVersion")
    ).toBeDefined();
    expect(WhatsAppQrOperation.schema.path("sanitizedError")).toBeDefined();
  });

  it("enforces atomic terminal state, upsert, evidence, and fence shapes before Mongo", async () => {
    const write = stubWrites();
    await expect(
      WhatsAppQrOperation.updateOne(
        LIVE_RUNNING_FILTER,
        {
          $set: {
            status: "COMPLETED",
            cleanupAt: new Date(),
            cachedTerminalResult: RESULT,
          },
        },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    await expect(
      WhatsAppQrOperation.updateOne(
        FILTER,
        { $set: { status: "COMPLETED", cachedTerminalResult: RESULT } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow();
    await expect(
      WhatsAppQrOperation.updateOne(
        FILTER,
        {
          $set: {
            status: "RUNNING",
            cleanupAt: new Date(),
            cachedTerminalResult: RESULT,
          },
        },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow();
    const insert = {
      operationId: "operation-2",
      workspaceId: "workspace-1",
      entryPointId: "entry-2",
      sourceId: "source-1",
      codeId: "code-1",
      currentCodeId: "code-1",
      operationKeyHash: "a".repeat(64),
      requestDigest: "b".repeat(64),
      kind: "CREATE",
      expectedEntryPointVersion: 0,
      expectedCodeVersion: 0,
      status: "RUNNING",
      providerStage: "NOT_STARTED",
      lease: { fence: 0 },
    };
    await expect(
      WhatsAppQrOperation.updateOne(
        { operationId: "operation-2" },
        { $setOnInsert: insert },
        { upsert: true, runValidators: true, setDefaultsOnInsert: false }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    await expect(
      WhatsAppQrOperation.updateOne(
        { operationId: "operation-2" },
        {
          $setOnInsert: {
            ...insert,
            cleanupAt: new Date(),
            cachedTerminalResult: RESULT,
          },
        },
        { upsert: true, runValidators: true, setDefaultsOnInsert: false }
      ).exec()
    ).rejects.toThrow();
    await expect(
      WhatsAppQrOperation.updateOne(
        LIVE_RUNNING_FILTER,
        {
          $set: {
            providerStage: "RECONCILING",
            providerCodeEvidence: "provider-code",
            observedAt: new Date(),
          },
        },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    for (const update of [
      { $set: { requestDigest: "c".repeat(64) } },
      { $set: { "lease.fence": 1 } },
      { $inc: { "lease.fence": 2 } },
    ])
      await expect(
        WhatsAppQrOperation.updateOne(FILTER, update, {
          runValidators: true,
        }).exec()
      ).rejects.toThrow();
    await expect(
      WhatsAppQrOperation.updateOne(
        {
          operationId: "operation-1",
          workspaceId: "workspace-1",
          entryPointId: "entry-1",
        },
        { $inc: { "lease.fence": 1 } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow();
    expect(write).toHaveBeenCalledTimes(3);
  });

  it("permits CREATE upserts without optional code targets and rejects loose lease CAS", async () => {
    const write = stubWrites();
    const insert = {
      operationId: "operation-create",
      workspaceId: "workspace-1",
      entryPointId: "entry-create",
      sourceId: "source-1",
      operationKeyHash: "c".repeat(64),
      requestDigest: "d".repeat(64),
      kind: "CREATE",
      expectedEntryPointVersion: 0,
      status: "RUNNING",
      providerStage: "NOT_STARTED",
      lease: { fence: 0 },
    };
    await expect(
      WhatsAppQrOperation.updateOne(
        { operationId: "operation-create" },
        { $setOnInsert: insert },
        { upsert: true, runValidators: true, setDefaultsOnInsert: false }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    await expect(
      WhatsAppQrOperation.updateOne(
        {
          operationId: "operation-1",
          workspaceId: "workspace-1",
          entryPointId: "entry-1",
          "lease.fence": { $gte: 0 },
        },
        { $inc: { "lease.fence": 1 } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/CAS/);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("reserves immutable command identity only through $setOnInsert", async () => {
    const write = stubWrites();
    const insert = {
      operationId: "operation-reserve",
      workspaceId: "workspace-1",
      entryPointId: "entry-reserve",
      sourceId: "source-1",
      operationKeyHash: "e".repeat(64),
      requestDigest: "f".repeat(64),
      kind: "CREATE",
      expectedEntryPointVersion: 0,
      expectedCodeVersion: 0,
      status: "RUNNING",
      providerStage: "NOT_STARTED",
      lease: { fence: 0 },
    };
    await expect(
      WhatsAppQrOperation.updateOne(
        { operationId: "operation-reserve" },
        {
          $setOnInsert: insert,
          $set: { attemptedAt: new Date() },
        },
        { upsert: true, runValidators: true, setDefaultsOnInsert: false }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    await expect(
      WhatsAppQrOperation.updateOne(
        { operationId: "operation-reserve" },
        {
          $setOnInsert: insert,
          $set: { codeId: "code-2" },
        },
        { upsert: true, runValidators: true, setDefaultsOnInsert: false }
      ).exec()
    ).rejects.toThrow(/identity.*setOnInsert/i);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("accepts only clean RUNNING reservations and active-status CAS transitions", async () => {
    const write = stubWrites();
    const insert = {
      operationId: "operation-reservation-state",
      workspaceId: "workspace-1",
      entryPointId: "entry-reservation-state",
      sourceId: "source-1",
      operationKeyHash: "1".repeat(64),
      requestDigest: "2".repeat(64),
      kind: "CREATE",
      expectedEntryPointVersion: 0,
      status: "RUNNING",
      providerStage: "NOT_STARTED",
      lease: { fence: 0 },
    };
    await expect(
      WhatsAppQrOperation.updateOne(
        { operationId: "operation-reservation-state" },
        { $setOnInsert: insert },
        { upsert: true, runValidators: true, setDefaultsOnInsert: false }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    await expect(
      WhatsAppQrOperation.updateOne(
        { operationId: "operation-reservation-state" },
        {
          $setOnInsert: {
            ...insert,
            status: "COMPLETED",
          },
        },
        { upsert: true, runValidators: true, setDefaultsOnInsert: false }
      ).exec()
    ).rejects.toThrow(/RUNNING|cleanup|result/i);
    await expect(
      WhatsAppQrOperation.updateOne(
        { operationId: "operation-reservation-state" },
        { $setOnInsert: insert, $set: { cleanupAt: new Date() } },
        { upsert: true, runValidators: true, setDefaultsOnInsert: false }
      ).exec()
    ).rejects.toThrow(/cleanup|result/i);
    await expect(
      WhatsAppQrOperation.updateOne(
        { operationId: "operation-reservation-state" },
        { $setOnInsert: insert, $unset: { cachedTerminalResult: 1 } },
        { upsert: true, runValidators: true, setDefaultsOnInsert: false }
      ).exec()
    ).rejects.toThrow(/cleanup|result/i);
    await expect(
      WhatsAppQrOperation.updateOne(
        LIVE_RUNNING_FILTER,
        { $set: { status: "RECONCILE_REQUIRED" } },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    await expect(
      WhatsAppQrOperation.updateOne(
        FILTER,
        { $set: { status: "RECONCILE_REQUIRED" } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/live lease CAS|operation state/i);
    await expect(
      WhatsAppQrOperation.updateOne(
        COMPLETED_FILTER,
        { $set: { status: "RUNNING" } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/live lease CAS|operation state/i);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("requires active-status CAS for terminal transitions", async () => {
    const write = stubWrites();
    await expect(
      WhatsAppQrOperation.updateOne(
        LIVE_RUNNING_FILTER,
        {
          $set: {
            status: "COMPLETED",
            cleanupAt: new Date(),
            cachedTerminalResult: RESULT,
          },
        },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    await expect(
      WhatsAppQrOperation.updateOne(
        FILTER,
        {
          $set: {
            status: "COMPLETED",
            cleanupAt: new Date(),
            cachedTerminalResult: RESULT,
          },
        },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/live lease CAS|operation state/i);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("permits only fenced acquisition, renewal, and release lease shapes", async () => {
    const write = stubWrites();
    await expect(
      WhatsAppQrOperation.updateOne(
        {
          operationId: "operation-1",
          workspaceId: "workspace-1",
          entryPointId: "entry-1",
          status: "RUNNING",
          "lease.fence": 0,
          "lease.ownerToken": { $exists: false },
        },
        {
          $set: {
            "lease.ownerToken": "worker-1",
            "lease.expiresAt": LEASE_EXPIRES_AT,
          },
          $inc: { "lease.fence": 1 },
        },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });

    await expect(
      WhatsAppQrOperation.updateOne(
        LIVE_RUNNING_FILTER,
        { $set: { "lease.expiresAt": LEASE_EXPIRES_AT } },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });

    await expect(
      WhatsAppQrOperation.updateOne(
        LIVE_RUNNING_FILTER,
        {
          $unset: {
            "lease.ownerToken": 1,
            "lease.expiresAt": 1,
          },
        },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });

    for (const [filter, update] of [
      [
        { operationId: "operation-1", status: "RUNNING", "lease.fence": 0 },
        {
          $set: {
            "lease.ownerToken": "worker-2",
            "lease.expiresAt": LEASE_EXPIRES_AT,
          },
          $inc: { "lease.fence": 1 },
        },
      ],
      [RUNNING_FILTER, { $set: { "lease.expiresAt": LEASE_EXPIRES_AT } }],
      [
        RUNNING_FILTER,
        { $unset: { "lease.ownerToken": 1, "lease.expiresAt": 1 } },
      ],
      [LIVE_RUNNING_FILTER, { $set: { "lease.ownerToken": "attacker" } }],
    ] as const) {
      await expect(
        WhatsAppQrOperation.updateOne(filter as never, update as never, {
          runValidators: true,
        }).exec()
      ).rejects.toThrow(/lease|operation/i);
    }
    expect(write).toHaveBeenCalledTimes(3);
  });

  it("requires validation for bounded evidence and protects persisted identity", async () => {
    const write = stubWrites();
    const filter = {
      operationId: "operation-1",
      workspaceId: "workspace-1",
      entryPointId: "entry-1",
      "lease.fence": 0,
    };
    await expect(
      WhatsAppQrOperation.updateOne(filter, {
        $set: {
          providerStage: "RECONCILING",
          providerCodeEvidence: "provider-code",
          observedAt: new Date(),
        },
      }).exec()
    ).rejects.toThrow(/runValidators/);
    await expect(
      WhatsAppQrOperation.updateOne(
        LIVE_RUNNING_FILTER,
        {
          $set: {
            providerStage: "RECONCILING",
            providerCodeEvidence: "provider-code",
            observedAt: new Date(),
          },
        },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    expect(
      operation({ providerCodeEvidence: "x".repeat(257) }).validateSync()
        ?.errors.providerCodeEvidence
    ).toBeDefined();
    const persisted = WhatsAppQrOperation.hydrate({
      ...operation().toObject(),
      _id: new (require("mongoose").Types.ObjectId)(),
    });
    persisted.requestDigest = "c".repeat(64);
    await expect(persisted.save()).rejects.toThrow(/guarded atomic updates/);

    const stateMutation = WhatsAppQrOperation.hydrate({
      ...operation().toObject(),
      _id: new (require("mongoose").Types.ObjectId)(),
    });
    stateMutation.status = "RECONCILE_REQUIRED";
    await expect(stateMutation.save()).rejects.toThrow(
      /guarded atomic updates/
    );

    const leaseMutation = WhatsAppQrOperation.hydrate({
      ...operation().toObject(),
      _id: new (require("mongoose").Types.ObjectId)(),
    });
    leaseMutation.lease.ownerToken = "attacker";
    leaseMutation.markModified("lease.ownerToken");
    await expect(leaseMutation.save()).rejects.toThrow(
      /guarded atomic updates/
    );
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("requires terminal result/status agreement and rejects terminal recovery", async () => {
    const write = stubWrites();
    const filter = {
      operationId: "operation-1",
      workspaceId: "workspace-1",
      entryPointId: "entry-1",
      "lease.fence": 0,
    };
    const completed = {
      outcome: "applied",
      status: "COMPLETED",
      entryPointVersion: 1,
    };
    const failed = {
      outcome: "failed",
      status: "FAILED",
      entryPointVersion: 1,
    };
    expect(
      operation({
        status: "COMPLETED",
        cleanupAt: new Date(),
        cachedTerminalResult: completed,
      }).validateSync()
    ).toBeUndefined();
    expect(
      operation({
        status: "FAILED",
        cleanupAt: new Date(),
        cachedTerminalResult: failed,
      }).validateSync()
    ).toBeUndefined();
    expect(
      operation({
        status: "COMPLETED",
        cleanupAt: new Date(),
        cachedTerminalResult: failed,
      }).validateSync()
    ).toBeDefined();
    await expect(
      WhatsAppQrOperation.updateOne(
        filter,
        { $set: { status: "RUNNING" } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow();
    await expect(
      WhatsAppQrOperation.updateOne(
        COMPLETED_FILTER,
        { $set: { status: "RUNNING" } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/live lease CAS|operation state/i);
    expect(write).not.toHaveBeenCalled();
  });

  it("declares unique idempotency ownership, lease recovery, and terminal TTL indexes", () => {
    expect(WHATSAPP_QR_OPERATION_INDEXES).toEqual([
      {
        key: { operationId: 1 },
        options: {
          background: true,
          unique: true,
          name: "whatsapp_qr_operation_id_unique",
        },
      },
      {
        key: { workspaceId: 1, operationKeyHash: 1 },
        options: {
          background: true,
          unique: true,
          name: "whatsapp_qr_operation_workspace_idempotency_unique",
        },
      },
      {
        key: { workspaceId: 1, entryPointId: 1 },
        options: {
          background: true,
          unique: true,
          name: "whatsapp_qr_operation_active_resource_unique",
          partialFilterExpression: {
            status: { $in: ["RUNNING", "RECONCILE_REQUIRED"] },
          },
        },
      },
      {
        key: { status: 1, "lease.expiresAt": 1 },
        options: {
          background: true,
          name: "whatsapp_qr_operation_status_lease",
        },
      },
      {
        key: { cleanupAt: 1 },
        options: {
          background: true,
          name: "whatsapp_qr_operation_cleanup_ttl",
          expireAfterSeconds: 0,
        },
      },
    ]);
    expect(WhatsAppQrOperation.schema.indexes()).toEqual(
      WHATSAPP_QR_OPERATION_INDEXES.map(index => [index.key, index.options])
    );
  });
});
