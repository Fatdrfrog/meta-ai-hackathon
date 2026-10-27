/**
 * @jest-environment node
 */

const mockConnectDB = jest.fn();
const mockOperationFindOne = jest.fn();
const mockOperationFindOneAndUpdate = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/whatsapp-qr-operation", () => {
  const actual = jest.requireActual("@/models/whatsapp-qr-operation");
  return {
    ...actual,
    WhatsAppQrOperation: {
      findOne: (...args: unknown[]) => mockOperationFindOne(...args),
      findOneAndUpdate: (...args: unknown[]) =>
        mockOperationFindOneAndUpdate(...args),
    },
  };
});

import { createHash } from "node:crypto";

import { serializeCanonicalJson } from "@icecore/shared/lib/canonical-json";

import type { WhatsAppQrOperationRecord } from "@/models/whatsapp-qr-operation";
import {
  WHATSAPP_QR_OPERATION_LEASE_MS,
  WHATSAPP_QR_OPERATION_TERMINAL_TTL_MS,
  WhatsAppQrStoreError,
} from "./contract";
import {
  acquireWhatsAppQrOperationLease,
  acquireWhatsAppQrReconciliationOperation,
  completeWhatsAppQrOperation,
  failWhatsAppQrOperation,
  hashWhatsAppQrIdempotencyKey,
  hashWhatsAppQrRequestDigest,
  lookupWhatsAppQrOperation,
  markWhatsAppQrProviderRequestSent,
  markWhatsAppQrReconcileRequired,
  releaseWhatsAppQrOperationLease,
  renewWhatsAppQrOperationLease,
  reserveWhatsAppQrOperation,
} from "./operation-store";

const REVISION = "2026-08-06T10:00:00.000Z";
const NOW = new Date(REVISION);
const DIGEST = "b".repeat(64);

function leanQuery<T>(value: T) {
  return { lean: jest.fn().mockResolvedValue(value) };
}

function metadataResult<T>(value: T, updatedExisting: boolean) {
  return Promise.resolve({
    value,
    lastErrorObject: { updatedExisting, n: 1 },
    ok: 1,
  });
}

function operation(
  overrides: Partial<WhatsAppQrOperationRecord> = {}
): WhatsAppQrOperationRecord {
  return {
    operationId: "operation-1",
    workspaceId: "workspace-1",
    entryPointId: "entry-1",
    sourceId: "source-1",
    operationKeyHash: "a".repeat(64),
    requestDigest: DIGEST,
    kind: "CREATE",
    status: "RUNNING",
    expectedEntryPointVersion: 0,
    providerStage: "NOT_STARTED",
    lease: { fence: 0 },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function liveLease(fence = 1) {
  return {
    operationId: "operation-1",
    workspaceId: "workspace-1",
    entryPointId: "entry-1",
    ownerToken: "worker-1",
    fence,
    expiresAt: new Date(NOW.getTime() + WHATSAPP_QR_OPERATION_LEASE_MS),
  };
}

function reserveParams(
  overrides: Partial<Parameters<typeof reserveWhatsAppQrOperation>[0]> = {}
) {
  return {
    workspaceId: "workspace-1",
    entryPointId: "entry-1",
    sourceId: "source-1",
    kind: "CREATE" as const,
    idempotencyKey: "idem-1",
    requestDigest: DIGEST,
    expectedEntryPointVersion: 0,
    ownerToken: "worker-1",
    now: NOW,
    ...overrides,
  };
}

describe("WhatsApp QR operation store", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockOperationFindOne.mockReturnValue(leanQuery(null));
  });

  it("hashes idempotency and request digests with canonical JSON sha256", () => {
    const keyHash = hashWhatsAppQrIdempotencyKey({
      workspaceId: "workspace-1",
      entryPointId: "entry-1",
      kind: "CREATE",
      idempotencyKey: "idem-1",
    });
    const requestHash = hashWhatsAppQrRequestDigest({
      desiredMessage: "Hello",
      expectedEntryPointVersion: 0,
    });

    expect(keyHash).toBe(
      createHash("sha256")
        .update(
          serializeCanonicalJson({
            workspaceId: "workspace-1",
            entryPointId: "entry-1",
            kind: "CREATE",
            idempotencyKey: "idem-1",
          })
        )
        .digest("hex")
    );
    expect(requestHash).toBe(
      createHash("sha256")
        .update(
          serializeCanonicalJson({
            desiredMessage: "Hello",
            expectedEntryPointVersion: 0,
          })
        )
        .digest("hex")
    );
    expect(keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(requestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("looks up terminal replays before mutable resource validation", async () => {
    const terminalResult = {
      outcome: "applied" as const,
      status: "COMPLETED" as const,
      entryPointVersion: 1,
      codeId: "code-1",
      codeVersion: 1,
    };
    const completed = operation({
      operationKeyHash: hashWhatsAppQrIdempotencyKey({
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        kind: "CREATE",
        idempotencyKey: "idem-1",
      }),
      status: "COMPLETED",
      cleanupAt: new Date(
        NOW.getTime() + WHATSAPP_QR_OPERATION_TERMINAL_TTL_MS
      ),
      cachedTerminalResult: terminalResult,
      lease: { fence: 2 },
    });
    mockOperationFindOne.mockReturnValueOnce(leanQuery(completed));

    await expect(
      lookupWhatsAppQrOperation({
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        kind: "CREATE",
        idempotencyKey: "idem-1",
        requestDigest: DIGEST,
        now: NOW,
      })
    ).resolves.toEqual({
      kind: "replay",
      operation: completed,
      result: terminalResult,
    });
    expect(mockOperationFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("reports a live active idempotency row as busy and an expired row as a miss", async () => {
    const keyHash = hashWhatsAppQrIdempotencyKey({
      workspaceId: "workspace-1",
      entryPointId: "entry-1",
      kind: "CREATE",
      idempotencyKey: "idem-1",
    });
    const busy = operation({
      operationKeyHash: keyHash,
      lease: {
        ownerToken: "other-worker",
        fence: 2,
        expiresAt: new Date(NOW.getTime() + 60_000),
      },
    });
    const expired = operation({
      operationKeyHash: keyHash,
      lease: {
        ownerToken: "old-worker",
        fence: 2,
        expiresAt: new Date(NOW.getTime() - 1),
      },
    });
    mockOperationFindOne
      .mockReturnValueOnce(leanQuery(busy))
      .mockReturnValueOnce(leanQuery(expired));

    const params = {
      workspaceId: "workspace-1",
      entryPointId: "entry-1",
      kind: "CREATE" as const,
      idempotencyKey: "idem-1",
      requestDigest: DIGEST,
      now: NOW,
    };
    await expect(lookupWhatsAppQrOperation(params)).resolves.toEqual({
      kind: "busy",
      operation: busy,
    });
    await expect(lookupWhatsAppQrOperation(params)).resolves.toEqual({
      kind: "miss",
    });
  });

  it("keeps an unlocked reconciliation row busy until the explicit reconcile command reacquires it", async () => {
    const reconcileRequired = operation({
      operationKeyHash: hashWhatsAppQrIdempotencyKey({
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        kind: "CREATE",
        idempotencyKey: "idem-1",
      }),
      status: "RECONCILE_REQUIRED",
      lease: { fence: 2 },
    });
    mockOperationFindOne.mockReturnValueOnce(leanQuery(reconcileRequired));

    await expect(
      lookupWhatsAppQrOperation({
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        kind: "CREATE",
        idempotencyKey: "idem-1",
        requestDigest: DIGEST,
        now: NOW,
      })
    ).resolves.toEqual({
      kind: "busy",
      operation: reconcileRequired,
    });
  });

  it("reserves a new operation and acquires a fenced lease", async () => {
    const inserted = operation({
      operationKeyHash: hashWhatsAppQrIdempotencyKey({
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        kind: "CREATE",
        idempotencyKey: "idem-1",
      }),
    });
    const acquired = operation({
      ...inserted,
      lease: {
        ownerToken: "worker-1",
        fence: 1,
        expiresAt: new Date(NOW.getTime() + WHATSAPP_QR_OPERATION_LEASE_MS),
      },
    });
    mockOperationFindOneAndUpdate
      .mockReturnValueOnce(metadataResult(inserted, false))
      .mockReturnValueOnce(leanQuery(acquired));

    const result = await reserveWhatsAppQrOperation(reserveParams());

    expect(result).toMatchObject({
      kind: "acquired",
      isNew: true,
      lease: {
        operationId: "operation-1",
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        ownerToken: "worker-1",
        fence: 1,
      },
    });
    expect(mockConnectDB).toHaveBeenCalled();
    expect(mockOperationFindOneAndUpdate.mock.calls[0]).toEqual([
      {
        workspaceId: "workspace-1",
        operationKeyHash: inserted.operationKeyHash,
      },
      {
        $setOnInsert: expect.objectContaining({
          workspaceId: "workspace-1",
          entryPointId: "entry-1",
          sourceId: "source-1",
          requestDigest: DIGEST,
          kind: "CREATE",
          status: "RUNNING",
          providerStage: "NOT_STARTED",
          expectedEntryPointVersion: 0,
          lease: { fence: 0 },
        }),
      },
      expect.objectContaining({
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: false,
        includeResultMetadata: true,
        lean: true,
      }),
    ]);
    expect(
      mockOperationFindOneAndUpdate.mock.calls[0][1].$setOnInsert
    ).not.toHaveProperty("cleanupAt");
    expect(
      mockOperationFindOneAndUpdate.mock.calls[0][1].$setOnInsert
    ).not.toHaveProperty("cachedTerminalResult");
    expect(mockOperationFindOneAndUpdate.mock.calls[1]).toEqual([
      expect.objectContaining({
        operationId: "operation-1",
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        status: "RUNNING",
        "lease.fence": 0,
        "lease.ownerToken": { $exists: false },
      }),
      {
        $set: {
          "lease.ownerToken": "worker-1",
          "lease.expiresAt": new Date(
            NOW.getTime() + WHATSAPP_QR_OPERATION_LEASE_MS
          ),
        },
        $inc: { "lease.fence": 1 },
      },
      { new: true, runValidators: true },
    ]);
  });

  it("replays a terminal operation with matching digest", async () => {
    const terminalResult = {
      outcome: "applied" as const,
      status: "COMPLETED" as const,
      entryPointVersion: 1,
      codeId: "code-1",
      codeVersion: 1,
    };
    const completed = operation({
      status: "COMPLETED",
      cleanupAt: new Date(
        NOW.getTime() + WHATSAPP_QR_OPERATION_TERMINAL_TTL_MS
      ),
      cachedTerminalResult: terminalResult,
      lease: { fence: 2 },
    });
    mockOperationFindOneAndUpdate.mockReturnValueOnce(
      metadataResult(completed, true)
    );

    await expect(
      reserveWhatsAppQrOperation(reserveParams())
    ).resolves.toEqual({
      kind: "replay",
      operation: completed,
      result: terminalResult,
    });
    expect(mockOperationFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("rejects digest conflicts on an existing idempotency row", async () => {
    const existing = operation({ requestDigest: "c".repeat(64) });
    mockOperationFindOneAndUpdate.mockReturnValueOnce(
      metadataResult(existing, true)
    );

    await expect(
      reserveWhatsAppQrOperation(reserveParams())
    ).rejects.toMatchObject<Partial<WhatsAppQrStoreError>>({
      code: "OPERATION_CONFLICT",
    });
  });

  it("returns busy when another live lease owns the active operation", async () => {
    const busy = operation({
      lease: {
        ownerToken: "other-worker",
        fence: 3,
        expiresAt: new Date(NOW.getTime() + 60_000),
      },
    });
    mockOperationFindOneAndUpdate.mockReturnValueOnce(
      metadataResult(busy, true)
    );

    await expect(
      reserveWhatsAppQrOperation(reserveParams())
    ).resolves.toEqual({
      kind: "busy",
      operation: busy,
    });
    expect(mockOperationFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("marks provider request sent under the live lease", async () => {
    const lease = liveLease();
    const current = operation({
      lease: {
        ownerToken: lease.ownerToken,
        fence: lease.fence,
        expiresAt: lease.expiresAt,
      },
    });
    const updated = {
      ...current,
      providerStage: "REQUEST_SENT" as const,
      attemptedAt: NOW,
      providerCodeEvidence: "provider-code-1",
    };
    mockOperationFindOne.mockReturnValueOnce(leanQuery(current));
    mockOperationFindOneAndUpdate.mockReturnValueOnce(leanQuery(updated));

    await expect(
      markWhatsAppQrProviderRequestSent({
        lease,
        providerCodeEvidence: "provider-code-1",
        now: NOW,
      })
    ).resolves.toEqual(updated);
    expect(mockOperationFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: lease.operationId,
        workspaceId: lease.workspaceId,
        entryPointId: lease.entryPointId,
        status: "RUNNING",
        "lease.ownerToken": lease.ownerToken,
        "lease.fence": lease.fence,
      }),
      {
        $set: {
          providerStage: "REQUEST_SENT",
          attemptedAt: NOW,
          providerCodeEvidence: "provider-code-1",
        },
      },
      { new: true, runValidators: true }
    );
  });

  it("marks reconcile required without blind recreate", async () => {
    const lease = liveLease();
    const current = operation({
      providerStage: "REQUEST_SENT",
      lease: {
        ownerToken: lease.ownerToken,
        fence: lease.fence,
        expiresAt: lease.expiresAt,
      },
    });
    const updated = {
      ...current,
      status: "RECONCILE_REQUIRED" as const,
      providerStage: "RECONCILING" as const,
      sanitizedError: { code: "PROVIDER_AMBIGUOUS", retryable: true },
      providerCodeEvidence: "provider-code-1",
      lease: { fence: lease.fence },
    };
    mockOperationFindOne.mockReturnValueOnce(leanQuery(current));
    mockOperationFindOneAndUpdate.mockReturnValueOnce(leanQuery(updated));

    await expect(
      markWhatsAppQrReconcileRequired({
        lease,
        sanitizedError: { code: "PROVIDER_AMBIGUOUS", retryable: true },
        providerCodeEvidence: "provider-code-1",
        now: NOW,
      })
    ).resolves.toEqual(updated);
    expect(mockOperationFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "RUNNING",
        "lease.fence": lease.fence,
      }),
      {
        $set: {
          status: "RECONCILE_REQUIRED",
          providerStage: "RECONCILING",
          sanitizedError: { code: "PROVIDER_AMBIGUOUS", retryable: true },
          providerCodeEvidence: "provider-code-1",
        },
        $unset: {
          "lease.ownerToken": 1,
          "lease.expiresAt": 1,
        },
      },
      { new: true, runValidators: true }
    );
  });

  it("completes with cleanup TTL and cached terminal result under active CAS", async () => {
    const lease = liveLease();
    const current = operation({
      lease: {
        ownerToken: lease.ownerToken,
        fence: lease.fence,
        expiresAt: lease.expiresAt,
      },
    });
    const terminalResult = {
      outcome: "applied" as const,
      status: "COMPLETED" as const,
      entryPointVersion: 1,
      codeId: "code-1",
      codeVersion: 1,
    };
    const completed = {
      ...current,
      status: "COMPLETED" as const,
      providerStage: "CONFIRMED" as const,
      cleanupAt: new Date(
        NOW.getTime() + WHATSAPP_QR_OPERATION_TERMINAL_TTL_MS
      ),
      cachedTerminalResult: terminalResult,
      lease: { fence: lease.fence },
    };
    mockOperationFindOne.mockReturnValueOnce(leanQuery(current));
    mockOperationFindOneAndUpdate.mockReturnValueOnce(leanQuery(completed));

    await expect(
      completeWhatsAppQrOperation({
        lease,
        result: terminalResult,
        now: NOW,
      })
    ).resolves.toEqual(completed);
    expect(mockOperationFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "RUNNING",
        "lease.fence": lease.fence,
      }),
      {
        $set: {
          status: "COMPLETED",
          cleanupAt: new Date(
            NOW.getTime() + WHATSAPP_QR_OPERATION_TERMINAL_TTL_MS
          ),
          cachedTerminalResult: terminalResult,
          providerStage: "CONFIRMED",
        },
        $unset: {
          sanitizedError: 1,
          "lease.ownerToken": 1,
          "lease.expiresAt": 1,
        },
      },
      { new: true, runValidators: true }
    );
  });

  it("fails with cleanup TTL and failed terminal cache", async () => {
    const lease = liveLease();
    const current = operation({
      lease: {
        ownerToken: lease.ownerToken,
        fence: lease.fence,
        expiresAt: lease.expiresAt,
      },
    });
    const terminalResult = {
      outcome: "failed" as const,
      status: "FAILED" as const,
      entryPointVersion: 0,
    };
    const failed = {
      ...current,
      status: "FAILED" as const,
      cleanupAt: new Date(
        NOW.getTime() + WHATSAPP_QR_OPERATION_TERMINAL_TTL_MS
      ),
      cachedTerminalResult: terminalResult,
      sanitizedError: { code: "PROVIDER_DEFINITE", retryable: false },
      lease: { fence: lease.fence },
    };
    mockOperationFindOne.mockReturnValueOnce(leanQuery(current));
    mockOperationFindOneAndUpdate.mockReturnValueOnce(leanQuery(failed));

    await expect(
      failWhatsAppQrOperation({
        lease,
        sanitizedError: { code: "PROVIDER_DEFINITE", retryable: false },
        result: terminalResult,
        now: NOW,
      })
    ).resolves.toEqual(failed);
    expect(mockOperationFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "RUNNING",
        "lease.fence": lease.fence,
      }),
      {
        $set: {
          status: "FAILED",
          cleanupAt: new Date(
            NOW.getTime() + WHATSAPP_QR_OPERATION_TERMINAL_TTL_MS
          ),
          cachedTerminalResult: terminalResult,
          sanitizedError: { code: "PROVIDER_DEFINITE", retryable: false },
        },
        $unset: {
          "lease.ownerToken": 1,
          "lease.expiresAt": 1,
        },
      },
      { new: true, runValidators: true }
    );
  });

  it("maps lease fence CAS mismatch to OPERATION_BUSY", async () => {
    const current = operation();
    mockOperationFindOne.mockReturnValueOnce(leanQuery(current));
    mockOperationFindOneAndUpdate.mockReturnValueOnce(leanQuery(null));

    await expect(
      acquireWhatsAppQrOperationLease({
        operationId: "operation-1",
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        ownerToken: "worker-1",
        now: NOW,
      })
    ).rejects.toMatchObject<Partial<WhatsAppQrStoreError>>({
      code: "OPERATION_BUSY",
    });
    expect(mockOperationFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "operation-1",
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        "lease.fence": 0,
      }),
      expect.objectContaining({
        $inc: { "lease.fence": 1 },
      }),
      { new: true, runValidators: true }
    );
  });

  it("reacquires the original RECONCILE_REQUIRED operation instead of creating a second active row", async () => {
    const current = operation({
      status: "RECONCILE_REQUIRED",
      providerStage: "RECONCILING",
      lease: { fence: 1 },
    });
    const acquired = operation({
      status: "RECONCILE_REQUIRED",
      providerStage: "RECONCILING",
      lease: {
        ownerToken: "reconciler-1",
        fence: 2,
        expiresAt: new Date(NOW.getTime() + WHATSAPP_QR_OPERATION_LEASE_MS),
      },
    });
    mockOperationFindOne.mockReturnValueOnce(leanQuery(current));
    mockOperationFindOneAndUpdate.mockReturnValueOnce(leanQuery(acquired));

    await expect(
      acquireWhatsAppQrReconciliationOperation({
        operationId: "operation-1",
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        ownerToken: "reconciler-1",
        now: NOW,
      })
    ).resolves.toMatchObject({
      kind: "acquired",
      operation: acquired,
      lease: { operationId: "operation-1", ownerToken: "reconciler-1", fence: 2 },
    });
    expect(mockOperationFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mockOperationFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "operation-1",
        status: "RECONCILE_REQUIRED",
        "lease.fence": 1,
      }),
      expect.objectContaining({
        $inc: { "lease.fence": 1 },
      }),
      { new: true, runValidators: true }
    );
  });

  it("acquires, renews, and releases only the current fenced lease", async () => {
    const initial = operation();
    const acquired = operation({
      lease: {
        ownerToken: "worker-1",
        fence: 1,
        expiresAt: new Date(NOW.getTime() + WHATSAPP_QR_OPERATION_LEASE_MS),
      },
    });
    const renewedExpiresAt = new Date(
      NOW.getTime() + 60_000 + WHATSAPP_QR_OPERATION_LEASE_MS
    );
    const renewed = operation({
      lease: {
        ownerToken: "worker-1",
        fence: 1,
        expiresAt: renewedExpiresAt,
      },
    });
    mockOperationFindOne
      .mockReturnValueOnce(leanQuery(initial))
      .mockReturnValueOnce(leanQuery(acquired))
      .mockReturnValueOnce(leanQuery(renewed));
    const released = operation({
      lease: { fence: 1 },
    });
    mockOperationFindOneAndUpdate
      .mockReturnValueOnce(leanQuery(acquired))
      .mockReturnValueOnce(leanQuery(renewed))
      .mockReturnValueOnce(leanQuery(released));

    const leased = await acquireWhatsAppQrOperationLease({
      operationId: "operation-1",
      workspaceId: "workspace-1",
      entryPointId: "entry-1",
      ownerToken: "worker-1",
      now: NOW,
    });
    const lease = await renewWhatsAppQrOperationLease({
      lease: leased.lease,
      now: new Date(NOW.getTime() + 60_000),
    });
    await releaseWhatsAppQrOperationLease({
      lease,
      now: new Date(NOW.getTime() + 60_000),
    });

    expect(leased.lease.fence).toBe(1);
    expect(lease.expiresAt).toEqual(renewedExpiresAt);
    expect(mockOperationFindOneAndUpdate.mock.calls[2]).toEqual([
      {
        operationId: "operation-1",
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        "lease.ownerToken": "worker-1",
        "lease.fence": 1,
        "lease.expiresAt": { $gt: new Date(NOW.getTime() + 60_000) },
        status: "RUNNING",
      },
      {
        $unset: {
          "lease.ownerToken": 1,
          "lease.expiresAt": 1,
        },
      },
      { new: true, runValidators: true },
    ]);
  });

  it("rejects a lease release when the fenced update loses its race", async () => {
    const current = operation({
      lease: {
        ownerToken: "worker-1",
        fence: 2,
        expiresAt: new Date(NOW.getTime() + WHATSAPP_QR_OPERATION_LEASE_MS),
      },
    });
    mockOperationFindOne.mockReturnValueOnce(leanQuery(current));
    mockOperationFindOneAndUpdate.mockReturnValueOnce(leanQuery(null));

    await expect(
      releaseWhatsAppQrOperationLease({
        lease: {
          operationId: "operation-1",
          workspaceId: "workspace-1",
          entryPointId: "entry-1",
          ownerToken: "worker-1",
          fence: 2,
          expiresAt: current.lease.expiresAt!,
        },
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  });
});
