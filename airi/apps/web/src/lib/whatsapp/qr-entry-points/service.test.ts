/**
 * @jest-environment node
 */

jest.mock("server-only", () => ({}));

const mockConnectDB = jest.fn();
const mockEntryPointFindOne = jest.fn();
const mockEntryPointFindOneAndUpdate = jest.fn();
const mockEntryPointSave = jest.fn();
const mockCodeExists = jest.fn();
const mockCodeSave = jest.fn();
const mockCodeFindOne = jest.fn();
const mockCodeFindOneAndUpdate = jest.fn();
const mockCodeCountDocuments = jest.fn();
const mockScenarioFindOne = jest.fn();
const mockScenarioStartSession = jest.fn();
const mockMarkDetachPendingNodes = jest.fn();
const mockReconcileDetachPending = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/whatsapp-qr-entry-point", () => {
  class MockEntryPoint {
    constructor(public doc: Record<string, unknown>) {}
    save = (...args: unknown[]) => mockEntryPointSave(...args);
    toObject() {
      return this.doc;
    }
  }
  return {
    WhatsAppQrEntryPoint: Object.assign(MockEntryPoint, {
      findOne: (...args: unknown[]) => mockEntryPointFindOne(...args),
      findOneAndUpdate: (...args: unknown[]) =>
        mockEntryPointFindOneAndUpdate(...args),
    }),
  };
});

jest.mock("@/models/whatsapp-qr-code", () => {
  class MockCode {
    constructor(public doc: Record<string, unknown>) {
      if (!doc.codeId) doc.codeId = "code-1";
      if (doc.version === undefined) doc.version = 0;
    }
    save = (...args: unknown[]) => mockCodeSave(...args);
    toObject() {
      return this.doc;
    }
  }
  return {
    WHATSAPP_QR_MANAGEABLE_HISTORY_LIMIT: 20,
    WhatsAppQrCode: Object.assign(MockCode, {
      countDocuments: (...args: unknown[]) => mockCodeCountDocuments(...args),
      exists: (...args: unknown[]) => mockCodeExists(...args),
      findOne: (...args: unknown[]) => mockCodeFindOne(...args),
      findOneAndUpdate: (...args: unknown[]) =>
        mockCodeFindOneAndUpdate(...args),
    }),
  };
});

jest.mock("@/models/scenario", () => ({
  Scenario: {
    findOne: (...args: unknown[]) => mockScenarioFindOne(...args),
    startSession: (...args: unknown[]) => mockScenarioStartSession(...args),
  },
}));

jest.mock("./cleanup-retry", () => ({
  markWhatsAppQrDetachPendingNodes: (...args: unknown[]) =>
    mockMarkDetachPendingNodes(...args),
  reconcileWhatsAppQrDetachPendingForScenario: (...args: unknown[]) =>
    mockReconcileDetachPending(...args),
}));

import type { WhatsAppQrCodeRecord } from "@/models/whatsapp-qr-code";
import type { WhatsAppQrEntryPointRecord } from "@/models/whatsapp-qr-entry-point";
import type { WhatsAppQrOperationRecord } from "@/models/whatsapp-qr-operation";
import { WhatsAppChatQrProviderError } from "./provider";
import {
  applyWhatsAppQrMessage,
  checkWhatsAppQrProviderState,
  connectWhatsAppQrEntryPointCode,
  createWhatsAppQrEntryPointCode,
  deleteWhatsAppQrCodeFromProvider,
  reconcileWhatsAppQrOperation,
  replaceWhatsAppQrCode,
  setWhatsAppQrCodeRouting,
  WhatsAppQrServiceError,
} from "./service";

const NOW = new Date("2026-08-06T12:00:00.000Z");
const SCENARIO_ID = "507f1f77bcf86cd799439011";

function leanQuery<T>(value: T) {
  const query = {
    lean: jest.fn().mockResolvedValue(value),
    session: jest.fn(),
  };
  query.session.mockReturnValue(query);
  return query;
}

function sessionResult<T>(value: T) {
  const promise = Promise.resolve(value);
  return Object.assign(promise, {
    session: jest.fn().mockReturnThis(),
  });
}

function transactionSession() {
  return {
    withTransaction: jest.fn(async (operation: () => Promise<void>) =>
      operation()
    ),
    endSession: jest.fn().mockResolvedValue(undefined),
  };
}

function qrScenario(nodeId = "node-1") {
  return {
    _id: SCENARIO_ID,
    workspaceId: "workspace-1",
    status: "draft",
    nodes: [
      {
        id: nodeId,
        data: {
          kind: "trigger",
          triggerConfig: { entryPointType: "whatsapp_qr" },
        },
      },
    ],
  };
}

function entryPoint(
  overrides: Partial<WhatsAppQrEntryPointRecord> = {}
): WhatsAppQrEntryPointRecord {
  return {
    entryPointId: "entry-1",
    workspaceId: "workspace-1",
    scenarioId: "scenario-1",
    nodeId: "node-1",
    assignmentState: "assigned",
    placementName: "Counter",
    placementNameSearch: "counter",
    desiredMessage: "Hi",
    status: "DRAFT",
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function activeEntryPoint(
  overrides: Partial<WhatsAppQrEntryPointRecord> = {}
): WhatsAppQrEntryPointRecord {
  return entryPoint({
    status: "ACTIVE",
    sourceId: "source-1",
    wabaId: "waba-1",
    phoneNumberId: "phone-1",
    currentCodeId: "code-1",
    version: 1,
    ...overrides,
  });
}

function activeCode(
  overrides: Partial<WhatsAppQrCodeRecord> = {}
): WhatsAppQrCodeRecord {
  return {
    codeId: "code-1",
    workspaceId: "workspace-1",
    entryPointId: "entry-1",
    sourceId: "source-1",
    wabaId: "waba-1",
    phoneNumberId: "phone-1",
    referenceCode: "ABCDEFGHJK",
    providerCode: "QRCODE1",
    deepLink: "https://wa.me/message/QRCODE1",
    prefilledMessage: "Hi\n[Ref: ABCDE-FGHJK]",
    placementBindingState: "CURRENT",
    routingState: "ENABLED",
    providerState: "ACTIVE",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function pendingCode(
  overrides: Partial<WhatsAppQrCodeRecord> = {}
): WhatsAppQrCodeRecord {
  return activeCode({
    providerCode: undefined,
    deepLink: undefined,
    providerState: "PENDING",
    version: 0,
    ...overrides,
  });
}

function lease() {
  return {
    operationId: "operation-1",
    workspaceId: "workspace-1",
    entryPointId: "entry-1",
    ownerToken: "worker-1",
    fence: 1,
    expiresAt: new Date(NOW.getTime() + 60_000),
  };
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
    requestDigest: "b".repeat(64),
    kind: "CREATE",
    status: "RUNNING",
    expectedEntryPointVersion: 0,
    providerStage: "NOT_STARTED",
    lease: { fence: 1, ownerToken: "worker-1", expiresAt: lease().expiresAt },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function storeMocks() {
  return {
    lookupWhatsAppQrOperation: jest.fn().mockResolvedValue({ kind: "miss" }),
    recoverWhatsAppQrDeleteOperation: jest
      .fn()
      .mockResolvedValue({ kind: "miss" }),
    reserveWhatsAppQrOperation: jest.fn(),
    acquireWhatsAppQrReconciliationOperation: jest.fn(),
    markWhatsAppQrProviderRequestSent: jest.fn().mockResolvedValue(operation()),
    markWhatsAppQrReconcileRequired: jest
      .fn()
      .mockResolvedValue(operation({ status: "RECONCILE_REQUIRED" })),
    completeWhatsAppQrOperation: jest
      .fn()
      .mockResolvedValue(operation({ status: "COMPLETED" })),
    failWhatsAppQrOperation: jest
      .fn()
      .mockResolvedValue(operation({ status: "FAILED" })),
    releaseWhatsAppQrOperationLease: jest.fn().mockResolvedValue(undefined),
  };
}

// Command inputs for entry-1 on phone-1 of source-1; each test adds the
// store, provider and anything else it varies.
const qrTarget = {
  workspaceId: "workspace-1",
  entryPointId: "entry-1",
  sourceId: "source-1",
};

function createInput<T extends object>(patch: T) {
  return {
    ...qrTarget,
    wabaId: "waba-1",
    phoneNumberId: "phone-1",
    accessToken: "token",
    desiredMessage: "Hi",
    expectedEntryPointVersion: 0,
    ...patch,
  };
}

function checkInput<T extends object>(patch: T) {
  return {
    ...qrTarget,
    accessToken: "token",
    phoneNumberId: "phone-1",
    expectedEntryPointVersion: 1,
    expectedCodeVersion: 1,
    ...patch,
  };
}

// A confirmed provider delete of code-1 at version 1 of both records.
function deleteInput<T extends object>(patch: T) {
  return {
    ...qrTarget,
    phoneNumberId: "phone-1",
    codeId: "code-1",
    accessToken: "token",
    expectedEntryPointVersion: 1,
    expectedCodeVersion: 1,
    confirmed: true,
    ...patch,
  };
}

function reconcileInput<T extends object>(patch: T) {
  return {
    ...qrTarget,
    operationId: "operation-1",
    accessToken: "token",
    phoneNumberId: "phone-1",
    ...patch,
  };
}

describe("WhatsApp QR CREATE/CONNECT service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockCodeExists.mockResolvedValue(null);
    mockCodeCountDocuments.mockResolvedValue(0);
    mockCodeSave.mockResolvedValue(undefined);
    mockEntryPointSave.mockResolvedValue(undefined);
    mockScenarioStartSession.mockResolvedValue(transactionSession());
  });

  it("creates a Meta QR, observes identity, and activates the draft entry point", async () => {
    const draft = entryPoint();
    mockEntryPointFindOne.mockReturnValue(leanQuery(draft));
    mockCodeFindOneAndUpdate.mockReturnValue(
      leanQuery({
        codeId: "code-1",
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        sourceId: "source-1",
        wabaId: "waba-1",
        phoneNumberId: "phone-1",
        referenceCode: "ABCDEFGHJK",
        providerCode: "QRCODE1",
        deepLink: "https://wa.me/message/QRCODE1",
        prefilledMessage: "Hi\n[Ref: ABCDE-FGHJK]",
        placementBindingState: "CURRENT",
        routingState: "ENABLED",
        providerState: "ACTIVE",
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      } satisfies WhatsAppQrCodeRecord)
    );
    mockEntryPointFindOneAndUpdate.mockReturnValue(
      leanQuery({
        ...draft,
        status: "ACTIVE",
        sourceId: "source-1",
        wabaId: "waba-1",
        phoneNumberId: "phone-1",
        currentCodeId: "code-1",
        version: 1,
      })
    );
    const store = storeMocks();
    store.reserveWhatsAppQrOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation(),
      lease: lease(),
      isNew: true,
    });
    const createWhatsAppChatQr = jest
      .fn()
      .mockImplementation(
        async ({ prefilledMessage }: { prefilledMessage: string }) => ({
          code: "QRCODE1",
          deepLink: "https://wa.me/message/QRCODE1",
          prefilledMessage,
        })
      );

    await expect(
      createWhatsAppQrEntryPointCode(
        createInput({
          idempotencyKey: "idem-1",
          store,
          provider: { createWhatsAppChatQr },
        })
      )
    ).resolves.toEqual({
      status: "applied",
      entryPointId: "entry-1",
      codeId: "code-1",
      entryPointVersion: 1,
      codeVersion: 1,
    });

    expect(store.markWhatsAppQrProviderRequestSent).toHaveBeenCalled();
    expect(createWhatsAppChatQr).toHaveBeenCalledTimes(1);
    expect(store.completeWhatsAppQrOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          outcome: "applied",
          status: "COMPLETED",
          codeId: "code-1",
        }),
      })
    );
  });

  it("returns reconcile_required on ambiguous CREATE without completing", async () => {
    mockEntryPointFindOne.mockReturnValue(leanQuery(entryPoint()));
    const store = storeMocks();
    store.reserveWhatsAppQrOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation(),
      lease: lease(),
      isNew: true,
    });
    const createWhatsAppChatQr = jest.fn().mockRejectedValue(
      new WhatsAppChatQrProviderError("ambiguous", {
        category: "no_response",
      })
    );

    await expect(
      createWhatsAppQrEntryPointCode(
        createInput({
          idempotencyKey: "idem-2",
          store,
          provider: { createWhatsAppChatQr },
        })
      )
    ).resolves.toEqual({
      status: "reconcile_required",
      entryPointId: "entry-1",
      operationId: "operation-1",
    });
    expect(store.markWhatsAppQrReconcileRequired).toHaveBeenCalled();
    expect(store.completeWhatsAppQrOperation).not.toHaveBeenCalled();
    expect(store.failWhatsAppQrOperation).not.toHaveBeenCalled();
  });

  it("fails definite CREATE provider errors and releases the pending CURRENT slot", async () => {
    mockEntryPointFindOne.mockReturnValue(leanQuery(entryPoint()));
    mockCodeFindOneAndUpdate.mockReturnValue(
      leanQuery(
        activeCode({
          providerCode: undefined,
          deepLink: undefined,
          providerState: "PENDING",
          placementBindingState: "DETACHED",
          routingState: "DISABLED",
          version: 1,
        })
      )
    );
    const store = storeMocks();
    store.reserveWhatsAppQrOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation(),
      lease: lease(),
      isNew: true,
    });
    const createWhatsAppChatQr = jest.fn().mockRejectedValue(
      new WhatsAppChatQrProviderError("definite", {
        category: "graph_response",
        httpStatus: 400,
      })
    );

    await expect(
      createWhatsAppQrEntryPointCode(
        createInput({
          idempotencyKey: "idem-3",
          store,
          provider: { createWhatsAppChatQr },
        })
      )
    ).rejects.toMatchObject({
      name: "WhatsAppQrServiceError",
      code: "PROVIDER_FAILED",
    } satisfies Partial<WhatsAppQrServiceError>);
    expect(store.failWhatsAppQrOperation).toHaveBeenCalled();
    expect(mockCodeFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        codeId: expect.any(String),
        providerState: "PENDING",
        placementBindingState: "CURRENT",
      }),
      expect.objectContaining({
        $set: {
          placementBindingState: "DETACHED",
          routingState: "DISABLED",
        },
      }),
      expect.any(Object)
    );
  });

  it("retries pending-code cleanup after a concurrent version change", async () => {
    mockEntryPointFindOne.mockReturnValue(leanQuery(entryPoint()));
    mockCodeFindOneAndUpdate
      .mockReturnValueOnce(leanQuery(null))
      .mockReturnValueOnce(
        leanQuery(
          pendingCode({
            placementBindingState: "DETACHED",
            routingState: "DISABLED",
            version: 2,
          })
        )
      );
    mockCodeFindOne.mockReturnValue(leanQuery(pendingCode({ version: 1 })));
    const store = storeMocks();
    store.reserveWhatsAppQrOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation(),
      lease: lease(),
      isNew: true,
    });
    const createWhatsAppChatQr = jest.fn().mockRejectedValue(
      new WhatsAppChatQrProviderError("definite", {
        category: "graph_response",
        httpStatus: 400,
      })
    );

    await expect(
      createWhatsAppQrEntryPointCode(
        createInput({
          idempotencyKey: "idem-cleanup-retry",
          store,
          provider: { createWhatsAppChatQr },
        })
      )
    ).rejects.toMatchObject({ code: "PROVIDER_FAILED" });

    expect(mockCodeFindOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(store.failWhatsAppQrOperation).toHaveBeenCalled();
  });

  it("keeps a definite provider failure recoverable when local cleanup conflicts", async () => {
    mockEntryPointFindOne.mockReturnValue(leanQuery(entryPoint()));
    mockCodeFindOneAndUpdate.mockReturnValue(leanQuery(null));
    mockCodeFindOne.mockReturnValue(leanQuery(activeCode()));
    const store = storeMocks();
    store.reserveWhatsAppQrOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation(),
      lease: lease(),
      isNew: true,
    });
    const createWhatsAppChatQr = jest.fn().mockRejectedValue(
      new WhatsAppChatQrProviderError("definite", {
        category: "graph_response",
        httpStatus: 400,
      })
    );

    await expect(
      createWhatsAppQrEntryPointCode(
        createInput({
          idempotencyKey: "idem-cleanup-conflict",
          store,
          provider: { createWhatsAppChatQr },
        })
      )
    ).resolves.toEqual({
      status: "reconcile_required",
      entryPointId: "entry-1",
      operationId: "operation-1",
    });

    expect(store.markWhatsAppQrReconcileRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        sanitizedError: { code: "LOCAL_CLEANUP_FAILED", retryable: true },
      })
    );
    expect(store.failWhatsAppQrOperation).not.toHaveBeenCalled();
  });

  it("replays terminal CREATE results before reading mutable entry-point state", async () => {
    const store = storeMocks();
    store.lookupWhatsAppQrOperation.mockResolvedValue({
      kind: "replay",
      operation: operation({ status: "COMPLETED" }),
      result: {
        outcome: "applied",
        status: "COMPLETED",
        codeId: "code-1",
        entryPointVersion: 1,
        codeVersion: 1,
      },
    });
    const createWhatsAppChatQr = jest.fn();

    await expect(
      createWhatsAppQrEntryPointCode(
        createInput({
          idempotencyKey: "idem-1",
          store,
          provider: { createWhatsAppChatQr },
        })
      )
    ).resolves.toEqual({
      status: "replay",
      entryPointId: "entry-1",
      result: {
        outcome: "applied",
        status: "COMPLETED",
        codeId: "code-1",
        entryPointVersion: 1,
        codeVersion: 1,
      },
    });
    expect(createWhatsAppChatQr).not.toHaveBeenCalled();
    expect(mockEntryPointFindOne).not.toHaveBeenCalled();
    expect(store.reserveWhatsAppQrOperation).not.toHaveBeenCalled();
  });

  it("rejects stale entry-point versions before reserving", async () => {
    mockEntryPointFindOne.mockReturnValue(
      leanQuery(entryPoint({ version: 2 }))
    );
    const store = storeMocks();
    const createWhatsAppChatQr = jest.fn();

    await expect(
      createWhatsAppQrEntryPointCode(
        createInput({
          idempotencyKey: "idem-4",
          store,
          provider: { createWhatsAppChatQr },
        })
      )
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(store.reserveWhatsAppQrOperation).not.toHaveBeenCalled();
  });

  it("connects an existing Meta QR by updating its message while retaining identity", async () => {
    const draft = entryPoint();
    mockEntryPointFindOne.mockReturnValue(leanQuery(draft));
    mockCodeFindOneAndUpdate.mockReturnValue(
      leanQuery({
        codeId: "code-2",
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        sourceId: "source-1",
        wabaId: "waba-1",
        phoneNumberId: "phone-1",
        referenceCode: "ABCDEFGHJK",
        providerCode: "EXISTING1",
        deepLink: "https://wa.me/message/EXISTING1",
        prefilledMessage: "Hi\n[Ref: ABCDE-FGHJK]",
        placementBindingState: "CURRENT",
        routingState: "ENABLED",
        providerState: "ACTIVE",
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      } satisfies WhatsAppQrCodeRecord)
    );
    mockEntryPointFindOneAndUpdate.mockReturnValue(
      leanQuery({
        ...draft,
        status: "ACTIVE",
        sourceId: "source-1",
        wabaId: "waba-1",
        phoneNumberId: "phone-1",
        currentCodeId: "code-2",
        version: 1,
      })
    );
    const store = storeMocks();
    store.reserveWhatsAppQrOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({ kind: "CONNECT" }),
      lease: lease(),
      isNew: true,
    });
    const getWhatsAppChatQr = jest.fn().mockResolvedValue({
      code: "EXISTING1",
      deepLink: "https://wa.me/message/EXISTING1",
      prefilledMessage: "old",
    });
    const updateWhatsAppChatQrMessage = jest
      .fn()
      .mockImplementation(
        async ({
          current,
          prefilledMessage,
        }: {
          current: { code: string; deepLink: string };
          prefilledMessage: string;
        }) => ({
          code: current.code,
          deepLink: current.deepLink,
          prefilledMessage,
        })
      );

    await expect(
      connectWhatsAppQrEntryPointCode({
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        sourceId: "source-1",
        wabaId: "waba-1",
        phoneNumberId: "phone-1",
        accessToken: "token",
        providerCode: "EXISTING1",
        desiredMessage: "Hi",
        expectedEntryPointVersion: 0,
        idempotencyKey: "idem-connect",
        store,
        provider: { getWhatsAppChatQr, updateWhatsAppChatQrMessage },
      })
    ).resolves.toEqual({
      status: "applied",
      entryPointId: "entry-1",
      codeId: "code-2",
      entryPointVersion: 1,
      codeVersion: 1,
    });
    expect(getWhatsAppChatQr).toHaveBeenCalled();
    expect(updateWhatsAppChatQrMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        current: expect.objectContaining({ code: "EXISTING1" }),
      })
    );
    expect(store.completeWhatsAppQrOperation).toHaveBeenCalled();
  });

  it("fails CONNECT when the provider read fails without leaving an active operation", async () => {
    mockEntryPointFindOne.mockReturnValue(leanQuery(entryPoint()));
    const store = storeMocks();
    store.reserveWhatsAppQrOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({ kind: "CONNECT" }),
      lease: lease(),
      isNew: true,
    });
    const getWhatsAppChatQr = jest.fn().mockRejectedValue(
      new WhatsAppChatQrProviderError("ambiguous", {
        category: "no_response",
      })
    );

    await expect(
      connectWhatsAppQrEntryPointCode({
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        sourceId: "source-1",
        wabaId: "waba-1",
        phoneNumberId: "phone-1",
        accessToken: "token",
        providerCode: "EXISTING1",
        desiredMessage: "Hi",
        expectedEntryPointVersion: 0,
        idempotencyKey: "idem-connect-read-failure",
        store,
        provider: { getWhatsAppChatQr },
      })
    ).rejects.toMatchObject({ code: "PROVIDER_FAILED" });

    expect(store.failWhatsAppQrOperation).toHaveBeenCalled();
    expect(store.markWhatsAppQrReconcileRequired).not.toHaveBeenCalled();
    expect(mockCodeSave).not.toHaveBeenCalled();
  });
});

describe("WhatsApp QR remaining commands", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEntryPointFindOne.mockReset();
    mockEntryPointFindOneAndUpdate.mockReset();
    mockCodeFindOne.mockReset();
    mockCodeFindOneAndUpdate.mockReset();
    mockScenarioFindOne.mockReset();
    mockScenarioStartSession.mockReset();
    mockConnectDB.mockResolvedValue(undefined);
    mockCodeExists.mockReturnValue(sessionResult(null));
    mockCodeSave.mockResolvedValue(undefined);
    mockEntryPointSave.mockResolvedValue(undefined);
    mockEntryPointFindOneAndUpdate.mockReturnValue(
      leanQuery(
        activeEntryPoint({
          version: 2,
          lastDeletionFenceToken: "operation-1",
        })
      )
    );
    mockScenarioFindOne.mockReturnValue(leanQuery(qrScenario("node-2")));
    mockScenarioStartSession.mockResolvedValue(transactionSession());
    mockMarkDetachPendingNodes.mockResolvedValue(undefined);
    mockReconcileDetachPending.mockResolvedValue({
      attemptedNodeIds: ["node-2"],
      failedNodeIds: [],
    });
  });

  it("applies a message update on the current ACTIVE code without allocating a new reference", async () => {
    const ep = activeEntryPoint();
    const code = activeCode();
    mockEntryPointFindOne.mockReturnValue(leanQuery(ep));
    mockCodeFindOne.mockReturnValue(leanQuery(code));
    mockCodeFindOneAndUpdate
      .mockReturnValueOnce(
        leanQuery(
          activeCode({
            providerState: "RECONCILING",
            prefilledMessage: "Hello\n[Ref: ABCDE-FGHJK]",
            version: 2,
          })
        )
      )
      .mockReturnValueOnce(
        leanQuery(
          activeCode({
            providerState: "ACTIVE",
            prefilledMessage: "Hello\n[Ref: ABCDE-FGHJK]",
            version: 3,
          })
        )
      );
    mockEntryPointFindOneAndUpdate.mockReturnValue(
      leanQuery(activeEntryPoint({ desiredMessage: "Hello", version: 2 }))
    );
    const store = storeMocks();
    store.reserveWhatsAppQrOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({ kind: "APPLY_MESSAGE" }),
      lease: lease(),
      isNew: true,
    });
    const updateWhatsAppChatQrMessage = jest.fn().mockResolvedValue({
      code: "QRCODE1",
      deepLink: "https://wa.me/message/QRCODE1",
      prefilledMessage: "Hello\n[Ref: ABCDE-FGHJK]",
    });

    await expect(
      applyWhatsAppQrMessage({
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        sourceId: "source-1",
        accessToken: "token",
        desiredMessage: "Hello",
        expectedEntryPointVersion: 1,
        expectedCodeVersion: 1,
        idempotencyKey: "idem-apply",
        store,
        provider: { updateWhatsAppChatQrMessage },
      })
    ).resolves.toEqual({
      status: "applied",
      entryPointId: "entry-1",
      codeId: "code-1",
      entryPointVersion: 2,
      codeVersion: 3,
    });

    expect(updateWhatsAppChatQrMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        current: expect.objectContaining({ code: "QRCODE1" }),
        prefilledMessage: "Hello\n[Ref: ABCDE-FGHJK]",
      })
    );
    expect(mockCodeExists).not.toHaveBeenCalled();
    expect(store.completeWhatsAppQrOperation).toHaveBeenCalled();
  });

  it("checks an exact Meta QR observation without changing local versions", async () => {
    const ep = activeEntryPoint();
    const code = activeCode();
    mockEntryPointFindOne.mockReturnValue(leanQuery(ep));
    mockCodeFindOne.mockReturnValue(leanQuery(code));
    const store = storeMocks();
    store.reserveWhatsAppQrOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({
        kind: "SYNC_PROVIDER",
        codeId: "code-1",
        expectedEntryPointVersion: 1,
        expectedCodeVersion: 1,
      }),
      lease: lease(),
      isNew: true,
    });
    const getWhatsAppChatQr = jest.fn().mockResolvedValue({
      code: "QRCODE1",
      deepLink: "https://wa.me/message/QRCODE1",
      prefilledMessage: code.prefilledMessage,
    });

    await expect(
      checkWhatsAppQrProviderState(
        checkInput({
          idempotencyKey: "idem-check",
          store,
          provider: { getWhatsAppChatQr },
        })
      )
    ).resolves.toEqual({
      status: "applied",
      entryPointId: "entry-1",
      codeId: "code-1",
      entryPointVersion: 1,
      codeVersion: 1,
    });

    expect(store.completeWhatsAppQrOperation).toHaveBeenCalled();
    expect(store.markWhatsAppQrReconcileRequired).not.toHaveBeenCalled();
    expect(mockCodeFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("replays a lost drift response as reconcile-required", async () => {
    const store = storeMocks();
    store.lookupWhatsAppQrOperation.mockResolvedValue({
      kind: "busy",
      operation: operation({
        kind: "SYNC_PROVIDER",
        status: "RECONCILE_REQUIRED",
        operationId: "operation-drift",
      }),
    });
    const getWhatsAppChatQr = jest.fn();

    await expect(
      checkWhatsAppQrProviderState(
        checkInput({
          idempotencyKey: "idem-check-lost-response",
          store,
          provider: { getWhatsAppChatQr },
        })
      )
    ).resolves.toEqual({
      status: "reconcile_required",
      entryPointId: "entry-1",
      operationId: "operation-drift",
    });

    expect(getWhatsAppChatQr).not.toHaveBeenCalled();
    expect(mockEntryPointFindOne).not.toHaveBeenCalled();
  });

  it("fails closed and opens reconciliation when Meta's message drifted", async () => {
    const ep = activeEntryPoint();
    const code = activeCode();
    mockEntryPointFindOne.mockReturnValue(leanQuery(ep));
    mockCodeFindOne.mockReturnValue(leanQuery(code));
    mockCodeFindOneAndUpdate.mockReturnValue(
      leanQuery(activeCode({ providerState: "RECONCILING", version: 2 }))
    );
    const store = storeMocks();
    store.reserveWhatsAppQrOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({ kind: "SYNC_PROVIDER", codeId: "code-1" }),
      lease: lease(),
      isNew: true,
    });
    const getWhatsAppChatQr = jest.fn().mockResolvedValue({
      code: "QRCODE1",
      deepLink: "https://wa.me/message/QRCODE1",
      prefilledMessage: "Changed outside airi.chat",
    });

    await expect(
      checkWhatsAppQrProviderState(
        checkInput({
          idempotencyKey: "idem-check-drift",
          store,
          provider: { getWhatsAppChatQr },
        })
      )
    ).resolves.toEqual({
      status: "reconcile_required",
      entryPointId: "entry-1",
      operationId: "operation-1",
    });

    expect(mockCodeFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        codeId: "code-1",
        version: 1,
        providerState: "ACTIVE",
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ providerState: "RECONCILING" }),
      }),
      expect.objectContaining({ session: expect.any(Object) })
    );
    expect(store.markWhatsAppQrReconcileRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        sanitizedError: {
          code: "PROVIDER_MESSAGE_DRIFT",
          retryable: true,
        },
        providerCodeEvidence: "QRCODE1",
        session: expect.any(Object),
      })
    );
  });

  it("fails closed and opens reconciliation when Meta confirms the code is missing", async () => {
    const ep = activeEntryPoint();
    const code = activeCode();
    mockEntryPointFindOne.mockReturnValue(leanQuery(ep));
    mockCodeFindOne.mockReturnValue(leanQuery(code));
    mockCodeFindOneAndUpdate.mockReturnValue(
      leanQuery(activeCode({ providerState: "RECONCILING", version: 2 }))
    );
    const store = storeMocks();
    store.reserveWhatsAppQrOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({ kind: "SYNC_PROVIDER", codeId: "code-1" }),
      lease: lease(),
      isNew: true,
    });
    const getWhatsAppChatQr = jest.fn().mockRejectedValue(
      new WhatsAppChatQrProviderError("definite", {
        category: "not_found",
      })
    );

    await expect(
      checkWhatsAppQrProviderState(
        checkInput({
          idempotencyKey: "idem-check-missing",
          store,
          provider: { getWhatsAppChatQr },
        })
      )
    ).resolves.toMatchObject({
      status: "reconcile_required",
      operationId: "operation-1",
    });
    expect(store.markWhatsAppQrReconcileRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        sanitizedError: { code: "PROVIDER_MISSING", retryable: true },
      })
    );
  });

  it("keeps local readiness unchanged when the provider check is unavailable", async () => {
    mockEntryPointFindOne.mockReturnValue(leanQuery(activeEntryPoint()));
    mockCodeFindOne.mockReturnValue(leanQuery(activeCode()));
    const store = storeMocks();
    const getWhatsAppChatQr = jest.fn().mockRejectedValue(
      new WhatsAppChatQrProviderError("definite", {
        category: "graph_response",
        httpStatus: 503,
      })
    );

    await expect(
      checkWhatsAppQrProviderState(
        checkInput({
          idempotencyKey: "idem-check-unavailable",
          store,
          provider: { getWhatsAppChatQr },
        })
      )
    ).rejects.toMatchObject({ code: "PROVIDER_FAILED" });

    expect(store.reserveWhatsAppQrOperation).not.toHaveBeenCalled();
    expect(store.markWhatsAppQrReconcileRequired).not.toHaveBeenCalled();
    expect(mockCodeFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("stages APPLY_MESSAGE as RECONCILING and leaves it recoverable after an ambiguous provider result", async () => {
    const ep = activeEntryPoint();
    const current = activeCode();
    mockEntryPointFindOne.mockReturnValue(leanQuery(ep));
    mockCodeFindOne.mockReturnValue(leanQuery(current));
    mockCodeFindOneAndUpdate.mockReturnValue(
      leanQuery(
        activeCode({
          providerState: "RECONCILING",
          prefilledMessage: "Hello\n[Ref: ABCDE-FGHJK]",
          version: 2,
        })
      )
    );
    const store = storeMocks();
    store.reserveWhatsAppQrOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({ kind: "APPLY_MESSAGE", codeId: "code-1" }),
      lease: lease(),
      isNew: true,
    });
    const updateWhatsAppChatQrMessage = jest.fn().mockRejectedValue(
      new WhatsAppChatQrProviderError("ambiguous", {
        category: "no_response",
      })
    );

    await expect(
      applyWhatsAppQrMessage({
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        sourceId: "source-1",
        accessToken: "token",
        desiredMessage: "Hello",
        expectedEntryPointVersion: 1,
        expectedCodeVersion: 1,
        idempotencyKey: "idem-apply-ambiguous",
        store,
        provider: { updateWhatsAppChatQrMessage },
      })
    ).resolves.toEqual({
      status: "reconcile_required",
      entryPointId: "entry-1",
      operationId: "operation-1",
    });

    expect(mockCodeFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        codeId: "code-1",
        providerState: "ACTIVE",
        providerCode: "QRCODE1",
        deepLink: "https://wa.me/message/QRCODE1",
      }),
      expect.objectContaining({
        $set: {
          providerState: "RECONCILING",
          prefilledMessage: "Hello\n[Ref: ABCDE-FGHJK]",
        },
      }),
      expect.any(Object)
    );
    expect(store.markWhatsAppQrReconcileRequired).toHaveBeenCalled();
    expect(store.failWhatsAppQrOperation).not.toHaveBeenCalled();
  });

  it("rejects APPLY_MESSAGE on stale code version", async () => {
    mockEntryPointFindOne.mockReturnValue(leanQuery(activeEntryPoint()));
    mockCodeFindOne.mockReturnValue(leanQuery(activeCode({ version: 3 })));
    const store = storeMocks();

    await expect(
      applyWhatsAppQrMessage({
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        sourceId: "source-1",
        accessToken: "token",
        desiredMessage: "Hello",
        expectedEntryPointVersion: 1,
        expectedCodeVersion: 1,
        idempotencyKey: "idem-apply-stale",
        store,
      })
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(store.reserveWhatsAppQrOperation).not.toHaveBeenCalled();
  });

  it("replaces the current code, demotes prior CURRENT to HISTORICAL, and never deletes Meta", async () => {
    const ep = activeEntryPoint();
    const old = activeCode();
    mockEntryPointFindOne.mockReturnValue(leanQuery(ep));
    mockCodeFindOne.mockReturnValue(leanQuery(old));
    mockCodeFindOneAndUpdate
      .mockReturnValueOnce(
        leanQuery(
          activeCode({
            codeId: "code-2",
            referenceCode: "NEWREFCODE1",
            providerCode: "QRNEW",
            deepLink: "https://wa.me/message/QRNEW",
            placementBindingState: "HISTORICAL",
            version: 1,
          })
        )
      )
      .mockReturnValueOnce(
        leanQuery(
          activeCode({ placementBindingState: "HISTORICAL", version: 2 })
        )
      )
      .mockReturnValueOnce(
        leanQuery(
          activeCode({
            codeId: "code-2",
            placementBindingState: "CURRENT",
            providerCode: "QRNEW",
            deepLink: "https://wa.me/message/QRNEW",
            version: 2,
          })
        )
      );
    mockEntryPointFindOneAndUpdate.mockReturnValue(
      leanQuery(activeEntryPoint({ currentCodeId: "code-2", version: 2 }))
    );
    const store = storeMocks();
    store.reserveWhatsAppQrOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({ kind: "REPLACE" }),
      lease: lease(),
      isNew: true,
    });
    const createWhatsAppChatQr = jest.fn().mockResolvedValue({
      code: "QRNEW",
      deepLink: "https://wa.me/message/QRNEW",
      prefilledMessage: "Hi\n[Ref: NEWRE-FCODE]",
    });
    const deleteWhatsAppChatQr = jest.fn();

    await expect(
      replaceWhatsAppQrCode({
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        sourceId: "source-1",
        accessToken: "token",
        desiredMessage: "Hi",
        expectedEntryPointVersion: 1,
        expectedCodeVersion: 1,
        idempotencyKey: "idem-replace",
        store,
        provider: { createWhatsAppChatQr, deleteWhatsAppChatQr },
      })
    ).resolves.toEqual({
      status: "applied",
      entryPointId: "entry-1",
      codeId: "code-2",
      entryPointVersion: 2,
      codeVersion: 2,
    });

    expect(createWhatsAppChatQr).toHaveBeenCalled();
    expect(deleteWhatsAppChatQr).not.toHaveBeenCalled();
    expect(mockCodeFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        codeId: "code-1",
        placementBindingState: "CURRENT",
      }),
      expect.objectContaining({
        $set: { placementBindingState: "HISTORICAL" },
      }),
      expect.any(Object)
    );
  });

  it("stops routing for an active historical replacement code", async () => {
    mockEntryPointFindOne.mockReturnValue(
      leanQuery(activeEntryPoint({ currentCodeId: "code-current" }))
    );
    mockCodeFindOne.mockReturnValue(
      leanQuery(activeCode({ placementBindingState: "HISTORICAL" }))
    );
    mockCodeFindOneAndUpdate.mockReturnValue(
      leanQuery(
        activeCode({
          placementBindingState: "HISTORICAL",
          routingState: "DISABLED",
          version: 2,
        })
      )
    );
    const store = storeMocks();
    store.reserveWhatsAppQrOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({ kind: "SET_ROUTING", codeId: "code-1" }),
      lease: lease(),
      isNew: true,
    });

    await expect(
      setWhatsAppQrCodeRouting({
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        sourceId: "source-1",
        codeId: "code-1",
        routingState: "DISABLED",
        expectedEntryPointVersion: 1,
        expectedCodeVersion: 1,
        idempotencyKey: "idem-routing-historical",
        store,
      })
    ).resolves.toEqual({
      status: "applied",
      entryPointId: "entry-1",
      codeId: "code-1",
      entryPointVersion: 1,
      codeVersion: 2,
    });

    expect(mockCodeFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ placementBindingState: "HISTORICAL" }),
      expect.objectContaining({ $set: { routingState: "DISABLED" } }),
      expect.any(Object)
    );
  });

  it("rejects a replacement before Meta when manageable history is at capacity", async () => {
    mockEntryPointFindOne.mockReturnValue(leanQuery(activeEntryPoint()));
    mockCodeFindOne.mockReturnValue(leanQuery(activeCode()));
    mockCodeCountDocuments.mockResolvedValue(20);
    const store = storeMocks();
    const createWhatsAppChatQr = jest.fn();

    await expect(
      replaceWhatsAppQrCode({
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        sourceId: "source-1",
        accessToken: "token",
        desiredMessage: "Hi",
        expectedEntryPointVersion: 1,
        expectedCodeVersion: 1,
        idempotencyKey: "idem-replace-capacity",
        store,
        provider: { createWhatsAppChatQr },
      })
    ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });

    expect(mockCodeCountDocuments).toHaveBeenCalledWith(
      {
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        placementBindingState: "HISTORICAL",
        providerState: { $in: ["ACTIVE", "RECONCILING"] },
      },
      { limit: 20 }
    );
    expect(store.reserveWhatsAppQrOperation).not.toHaveBeenCalled();
    expect(createWhatsAppChatQr).not.toHaveBeenCalled();
  });

  it("toggles routing state without calling Meta", async () => {
    mockEntryPointFindOne.mockReturnValue(leanQuery(activeEntryPoint()));
    mockCodeFindOne.mockReturnValue(leanQuery(activeCode()));
    mockCodeFindOneAndUpdate.mockReturnValue(
      leanQuery(activeCode({ routingState: "DISABLED", version: 2 }))
    );
    const store = storeMocks();
    store.reserveWhatsAppQrOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({ kind: "SET_ROUTING" }),
      lease: lease(),
      isNew: true,
    });

    await expect(
      setWhatsAppQrCodeRouting({
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        sourceId: "source-1",
        codeId: "code-1",
        routingState: "DISABLED",
        expectedEntryPointVersion: 1,
        expectedCodeVersion: 1,
        idempotencyKey: "idem-routing",
        store,
      })
    ).resolves.toEqual({
      status: "applied",
      entryPointId: "entry-1",
      codeId: "code-1",
      entryPointVersion: 1,
      codeVersion: 2,
    });
    expect(store.markWhatsAppQrProviderRequestSent).not.toHaveBeenCalled();
    expect(store.completeWhatsAppQrOperation).toHaveBeenCalled();
  });

  it("deletes a historical replacement code without detaching the current code", async () => {
    mockEntryPointFindOne.mockReturnValue(
      leanQuery(activeEntryPoint({ currentCodeId: "code-current" }))
    );
    mockCodeFindOne.mockReturnValue(
      leanQuery(activeCode({ placementBindingState: "HISTORICAL" }))
    );
    mockCodeFindOneAndUpdate
      .mockReturnValueOnce(
        leanQuery(
          activeCode({
            placementBindingState: "HISTORICAL",
            providerState: "RECONCILING",
            version: 2,
          })
        )
      )
      .mockReturnValueOnce(
        leanQuery(
          activeCode({
            providerState: "DELETED",
            placementBindingState: "DETACHED",
            routingState: "DISABLED",
            version: 3,
          })
        )
      );
    const store = storeMocks();
    store.reserveWhatsAppQrOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({ kind: "DELETE", codeId: "code-1" }),
      lease: lease(),
      isNew: true,
    });
    const deleteWhatsAppChatQr = jest.fn().mockResolvedValue(undefined);

    await expect(
      deleteWhatsAppQrCodeFromProvider(
        deleteInput({
          idempotencyKey: "idem-delete-historical",
          store,
          provider: { deleteWhatsAppChatQr },
        })
      )
    ).resolves.toEqual({
      status: "applied",
      entryPointId: "entry-1",
      codeId: "code-1",
      entryPointVersion: 2,
      codeVersion: 3,
    });

    expect(deleteWhatsAppChatQr).toHaveBeenCalledWith(
      expect.objectContaining({ code: "QRCODE1" })
    );
    expect(mockEntryPointFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mockEntryPointFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        currentCodeId: "code-current",
        version: 1,
      }),
      {
        $set: { lastDeletionFenceToken: "operation-1" },
        $inc: { version: 1 },
      },
      expect.objectContaining({ session: expect.any(Object) })
    );
  });

  it("requires confirmed:true before deleting a provider code", async () => {
    const store = storeMocks();
    await expect(
      deleteWhatsAppQrCodeFromProvider({
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        sourceId: "source-1",
        phoneNumberId: "phone-1",
        codeId: "code-1",
        accessToken: "token",
        expectedEntryPointVersion: 1,
        expectedCodeVersion: 1,
        confirmed: false,
        idempotencyKey: "idem-delete",
        store,
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(store.reserveWhatsAppQrOperation).not.toHaveBeenCalled();
  });

  it("blocks Meta deletion for an active projected Scenario before reservation or provider work", async () => {
    mockEntryPointFindOne.mockReturnValue(leanQuery(activeEntryPoint()));
    mockScenarioFindOne.mockReturnValue(
      leanQuery({ ...qrScenario("node-1"), status: "active" })
    );
    const store = storeMocks();
    const deleteWhatsAppChatQr = jest.fn();

    await expect(
      deleteWhatsAppQrCodeFromProvider(
        deleteInput({
          idempotencyKey: "idem-active-scenario-delete",
          store,
          provider: { deleteWhatsAppChatQr },
        })
      )
    ).rejects.toMatchObject({ code: "ACTIVE_SCENARIO_ASSIGNMENT" });

    expect(store.reserveWhatsAppQrOperation).not.toHaveBeenCalled();
    expect(mockCodeFindOneAndUpdate).not.toHaveBeenCalled();
    expect(deleteWhatsAppChatQr).not.toHaveBeenCalled();
  });

  it("fails closed when the projected Scenario cannot be loaded", async () => {
    mockEntryPointFindOne.mockReturnValue(leanQuery(activeEntryPoint()));
    mockScenarioFindOne.mockReturnValue({
      lean: jest.fn().mockRejectedValue(new Error("mongo unavailable")),
    });
    const store = storeMocks();
    const deleteWhatsAppChatQr = jest.fn();

    await expect(
      deleteWhatsAppQrCodeFromProvider(
        deleteInput({
          idempotencyKey: "idem-scenario-read-failure",
          store,
          provider: { deleteWhatsAppChatQr },
        })
      )
    ).rejects.toThrow("mongo unavailable");

    expect(store.reserveWhatsAppQrOperation).not.toHaveBeenCalled();
    expect(mockCodeFindOneAndUpdate).not.toHaveBeenCalled();
    expect(deleteWhatsAppChatQr).not.toHaveBeenCalled();
  });

  it("terminally fails the reserved delete lease when staging loses its exact code-version CAS", async () => {
    mockEntryPointFindOne.mockReturnValue(leanQuery(activeEntryPoint()));
    mockScenarioFindOne.mockReturnValue(
      leanQuery({ ...qrScenario("node-1"), status: "draft" })
    );
    mockCodeFindOne.mockReturnValue(leanQuery(activeCode()));
    mockCodeFindOneAndUpdate.mockReturnValueOnce(leanQuery(null));
    const store = storeMocks();
    store.reserveWhatsAppQrOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({ kind: "DELETE", codeId: "code-1" }),
      lease: lease(),
      isNew: true,
    });
    const deleteWhatsAppChatQr = jest.fn();

    await expect(
      deleteWhatsAppQrCodeFromProvider(
        deleteInput({
          idempotencyKey: "idem-delete-stage-cas",
          store,
          provider: { deleteWhatsAppChatQr },
        })
      )
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });

    expect(mockCodeFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        codeId: "code-1",
        workspaceId: "workspace-1",
        version: 1,
        providerState: "ACTIVE",
      }),
      expect.any(Object),
      expect.any(Object)
    );
    expect(store.failWhatsAppQrOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: lease(),
        sanitizedError: {
          code: "DELETE_STAGING_VERSION_CONFLICT",
          retryable: false,
        },
        result: {
          outcome: "failed",
          status: "FAILED",
          codeId: "code-1",
          entryPointVersion: 2,
          codeVersion: 1,
        },
        session: expect.any(Object),
      })
    );
    expect(deleteWhatsAppChatQr).not.toHaveBeenCalled();
  });

  it("deletes a Meta QR, tombstones the code, and returns the entry point to DRAFT", async () => {
    const ep = activeEntryPoint();
    const current = activeCode();
    mockEntryPointFindOne.mockReturnValue(leanQuery(ep));
    mockCodeFindOne.mockReturnValue(leanQuery(current));
    mockCodeFindOneAndUpdate
      .mockReturnValueOnce(
        leanQuery(activeCode({ providerState: "RECONCILING", version: 2 }))
      )
      .mockReturnValueOnce(
        leanQuery(
          activeCode({
            providerState: "DELETED",
            placementBindingState: "DETACHED",
            routingState: "DISABLED",
            version: 3,
          })
        )
      );
    mockEntryPointFindOneAndUpdate
      .mockReturnValueOnce(
        leanQuery(
          activeEntryPoint({
            version: 2,
            lastDeletionFenceToken: "operation-1",
          })
        )
      )
      .mockReturnValueOnce(
        leanQuery(
          entryPoint({
            desiredMessage: "Hi",
            status: "DRAFT",
            version: 3,
            lastDeletionFenceToken: "operation-1",
          })
        )
      );
    const store = storeMocks();
    store.reserveWhatsAppQrOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({ kind: "DELETE", codeId: "code-1" }),
      lease: lease(),
      isNew: true,
    });
    const deleteWhatsAppChatQr = jest.fn().mockResolvedValue(undefined);

    await expect(
      deleteWhatsAppQrCodeFromProvider(
        deleteInput({
          idempotencyKey: "idem-delete",
          store,
          provider: { deleteWhatsAppChatQr },
        })
      )
    ).resolves.toEqual({
      status: "applied",
      entryPointId: "entry-1",
      codeId: "code-1",
      entryPointVersion: 3,
      codeVersion: 3,
    });
    expect(deleteWhatsAppChatQr).toHaveBeenCalledWith(
      expect.objectContaining({ code: "QRCODE1" })
    );
    expect(mockCodeFindOneAndUpdate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        providerCode: "QRCODE1",
        deepLink: "https://wa.me/message/QRCODE1",
        providerState: "ACTIVE",
      }),
      expect.objectContaining({
        $set: { providerState: "RECONCILING" },
      }),
      expect.any(Object)
    );
    expect(mockCodeFindOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ providerState: "RECONCILING" }),
      expect.objectContaining({
        $set: {
          providerState: "DELETED",
          placementBindingState: "DETACHED",
          routingState: "DISABLED",
        },
      }),
      expect.any(Object)
    );
    expect(mockEntryPointFindOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        status: "ACTIVE",
        currentCodeId: "code-1",
      }),
      expect.objectContaining({
        $set: { status: "DRAFT" },
        $unset: {
          sourceId: 1,
          wabaId: 1,
          phoneNumberId: 1,
          currentCodeId: 1,
        },
      }),
      expect.any(Object)
    );
  });

  it("rejects current-code deletion while a manageable historical code remains", async () => {
    mockEntryPointFindOne.mockReturnValue(leanQuery(activeEntryPoint()));
    mockCodeFindOne.mockReturnValue(leanQuery(activeCode()));
    mockCodeExists.mockResolvedValue({ _id: "historical-code" });
    const store = storeMocks();
    const deleteWhatsAppChatQr = jest.fn();

    await expect(
      deleteWhatsAppQrCodeFromProvider(
        deleteInput({
          idempotencyKey: "idem-delete-current-with-history",
          store,
          provider: { deleteWhatsAppChatQr },
        })
      )
    ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });

    expect(mockCodeExists).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      entryPointId: "entry-1",
      placementBindingState: "HISTORICAL",
      providerState: { $in: ["ACTIVE", "RECONCILING"] },
    });
    expect(store.reserveWhatsAppQrOperation).not.toHaveBeenCalled();
    expect(deleteWhatsAppChatQr).not.toHaveBeenCalled();
  });
});

describe("WhatsApp QR reconciliation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEntryPointFindOne.mockReset();
    mockEntryPointFindOneAndUpdate.mockReset();
    mockCodeFindOne.mockReset();
    mockCodeFindOneAndUpdate.mockReset();
    mockScenarioFindOne.mockReset();
    mockScenarioStartSession.mockReset();
    mockConnectDB.mockResolvedValue(undefined);
    mockScenarioFindOne.mockReturnValue(leanQuery(qrScenario()));
    mockScenarioStartSession.mockResolvedValue(transactionSession());
  });

  it("reuses the original CREATE operation and finalizes the uniquely observed provider code", async () => {
    const draft = entryPoint();
    const pending = pendingCode();
    mockEntryPointFindOne.mockReturnValue(leanQuery(draft));
    mockCodeFindOne.mockReturnValue(leanQuery(pending));
    mockCodeFindOneAndUpdate.mockReturnValue(
      leanQuery(activeCode({ version: 1 }))
    );
    mockEntryPointFindOneAndUpdate.mockReturnValue(
      leanQuery(activeEntryPoint({ version: 1 }))
    );
    const store = storeMocks();
    store.acquireWhatsAppQrReconciliationOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({
        kind: "CREATE",
        status: "RECONCILE_REQUIRED",
        providerCodeEvidence: "code-1",
      }),
      lease: lease(),
    });
    const listWhatsAppChatQrs = jest.fn().mockResolvedValue([
      {
        code: "QRCODE1",
        deepLink: "https://wa.me/message/QRCODE1",
        prefilledMessage: pending.prefilledMessage,
      },
    ]);

    await expect(
      reconcileWhatsAppQrOperation(
        reconcileInput({ store, provider: { listWhatsAppChatQrs } })
      )
    ).resolves.toEqual({
      status: "applied",
      entryPointId: "entry-1",
      codeId: "code-1",
      entryPointVersion: 1,
      codeVersion: 1,
    });

    expect(store.reserveWhatsAppQrOperation).not.toHaveBeenCalled();
    expect(store.completeWhatsAppQrOperation).toHaveBeenCalled();
  });

  it("finishes a definite CREATE failure after recovering a conflicted local cleanup", async () => {
    const draft = entryPoint();
    const pending = pendingCode();
    mockEntryPointFindOne.mockReturnValue(leanQuery(draft));
    mockCodeFindOne.mockReturnValue(leanQuery(pending));
    mockCodeFindOneAndUpdate.mockReturnValue(
      leanQuery(
        pendingCode({
          placementBindingState: "DETACHED",
          routingState: "DISABLED",
          version: 1,
        })
      )
    );
    const store = storeMocks();
    store.acquireWhatsAppQrReconciliationOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({
        status: "RECONCILE_REQUIRED",
        providerCodeEvidence: "code-1",
        sanitizedError: {
          code: "LOCAL_CLEANUP_FAILED",
          retryable: true,
        },
      }),
      lease: lease(),
    });
    const listWhatsAppChatQrs = jest.fn().mockResolvedValue([]);

    await expect(
      reconcileWhatsAppQrOperation(
        reconcileInput({ store, provider: { listWhatsAppChatQrs } })
      )
    ).rejects.toMatchObject({ code: "PROVIDER_FAILED" });

    expect(store.failWhatsAppQrOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          outcome: "failed",
          status: "FAILED",
          codeId: "code-1",
          codeVersion: 1,
        }),
      })
    );
  });

  it("reconciles CONNECT by inspecting the original provider code and reapplying the staged message", async () => {
    const draft = entryPoint();
    const pending = pendingCode();
    mockEntryPointFindOne.mockReturnValue(leanQuery(draft));
    mockCodeFindOne.mockReturnValue(leanQuery(pending));
    mockCodeFindOneAndUpdate.mockReturnValue(
      leanQuery(
        activeCode({
          providerCode: "EXISTING1",
          deepLink: "https://wa.me/message/EXISTING1",
          version: 1,
        })
      )
    );
    mockEntryPointFindOneAndUpdate.mockReturnValue(
      leanQuery(activeEntryPoint({ currentCodeId: "code-1", version: 1 }))
    );
    const store = storeMocks();
    store.acquireWhatsAppQrReconciliationOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({
        kind: "CONNECT",
        status: "RECONCILE_REQUIRED",
        providerCodeEvidence: "EXISTING1",
      }),
      lease: lease(),
    });
    const getWhatsAppChatQr = jest.fn().mockResolvedValue({
      code: "EXISTING1",
      deepLink: "https://wa.me/message/EXISTING1",
      prefilledMessage: "Old",
    });
    const updateWhatsAppChatQrMessage = jest.fn().mockResolvedValue({
      code: "EXISTING1",
      deepLink: "https://wa.me/message/EXISTING1",
      prefilledMessage: pending.prefilledMessage,
    });

    await expect(
      reconcileWhatsAppQrOperation(
        reconcileInput({
          store,
          provider: { getWhatsAppChatQr, updateWhatsAppChatQrMessage },
        })
      )
    ).resolves.toMatchObject({ status: "applied", codeId: "code-1" });
    expect(updateWhatsAppChatQrMessage).toHaveBeenCalled();
  });

  it("reconciles REPLACE using the exact staged code recorded on the original operation", async () => {
    const ep = activeEntryPoint();
    const pending = pendingCode({
      codeId: "code-2",
      placementBindingState: "HISTORICAL",
      referenceCode: "NEWREFCODE1",
      prefilledMessage: "Hello\n[Ref: NEWRE-FCODE]",
    });
    const old = activeCode();
    mockEntryPointFindOne.mockReturnValue(leanQuery(ep));
    mockCodeFindOne
      .mockReturnValueOnce(leanQuery(pending))
      .mockReturnValueOnce(leanQuery(old));
    mockCodeFindOneAndUpdate
      .mockReturnValueOnce(
        leanQuery(
          activeCode({
            ...pending,
            providerCode: "QRNEW",
            deepLink: "https://wa.me/message/QRNEW",
            providerState: "ACTIVE",
            version: 1,
          })
        )
      )
      .mockReturnValueOnce(
        leanQuery(
          activeCode({ placementBindingState: "HISTORICAL", version: 2 })
        )
      )
      .mockReturnValueOnce(
        leanQuery(
          activeCode({
            ...pending,
            providerCode: "QRNEW",
            deepLink: "https://wa.me/message/QRNEW",
            providerState: "ACTIVE",
            placementBindingState: "CURRENT",
            version: 2,
          })
        )
      );
    mockEntryPointFindOneAndUpdate.mockReturnValue(
      leanQuery(activeEntryPoint({ currentCodeId: "code-2", version: 2 }))
    );
    const store = storeMocks();
    store.acquireWhatsAppQrReconciliationOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({
        kind: "REPLACE",
        status: "RECONCILE_REQUIRED",
        codeId: "code-1",
        currentCodeId: "code-1",
        providerCodeEvidence: "code-2",
      }),
      lease: lease(),
    });
    const listWhatsAppChatQrs = jest.fn().mockResolvedValue([
      {
        code: "QRNEW",
        deepLink: "https://wa.me/message/QRNEW",
        prefilledMessage: pending.prefilledMessage,
      },
    ]);

    await expect(
      reconcileWhatsAppQrOperation(
        reconcileInput({ store, provider: { listWhatsAppChatQrs } })
      )
    ).resolves.toMatchObject({ status: "applied", codeId: "code-2" });
  });

  it("reconciles APPLY_MESSAGE from the staged local message", async () => {
    const ep = activeEntryPoint();
    const staged = activeCode({
      providerState: "RECONCILING",
      prefilledMessage: "Hello\n[Ref: ABCDE-FGHJK]",
      version: 2,
    });
    mockEntryPointFindOne.mockReturnValue(leanQuery(ep));
    mockCodeFindOne.mockReturnValue(leanQuery(staged));
    mockCodeFindOneAndUpdate.mockReturnValue(
      leanQuery(
        activeCode({ prefilledMessage: staged.prefilledMessage, version: 3 })
      )
    );
    mockEntryPointFindOneAndUpdate.mockReturnValue(
      leanQuery(activeEntryPoint({ desiredMessage: "Hello", version: 2 }))
    );
    const store = storeMocks();
    store.acquireWhatsAppQrReconciliationOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({
        kind: "APPLY_MESSAGE",
        status: "RECONCILE_REQUIRED",
        codeId: "code-1",
      }),
      lease: lease(),
    });
    const getWhatsAppChatQr = jest.fn().mockResolvedValue({
      code: "QRCODE1",
      deepLink: "https://wa.me/message/QRCODE1",
      prefilledMessage: staged.prefilledMessage,
    });

    await expect(
      reconcileWhatsAppQrOperation(
        reconcileInput({ store, provider: { getWhatsAppChatQr } })
      )
    ).resolves.toEqual({
      status: "applied",
      entryPointId: "entry-1",
      codeId: "code-1",
      entryPointVersion: 2,
      codeVersion: 3,
    });
  });

  it("reconciles provider message drift back to the canonical local message", async () => {
    const ep = activeEntryPoint();
    const staged = activeCode({ providerState: "RECONCILING", version: 2 });
    mockEntryPointFindOne.mockReturnValue(leanQuery(ep));
    mockCodeFindOne.mockReturnValue(leanQuery(staged));
    mockCodeFindOneAndUpdate.mockReturnValue(
      leanQuery(activeCode({ providerState: "ACTIVE", version: 3 }))
    );
    const store = storeMocks();
    store.acquireWhatsAppQrReconciliationOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({
        kind: "SYNC_PROVIDER",
        status: "RECONCILE_REQUIRED",
        codeId: "code-1",
        currentCodeId: "code-1",
        expectedEntryPointVersion: 1,
        expectedCodeVersion: 1,
        providerCodeEvidence: "QRCODE1",
        sanitizedError: {
          code: "PROVIDER_MESSAGE_DRIFT",
          retryable: true,
        },
      }),
      lease: lease(),
    });
    const getWhatsAppChatQr = jest.fn().mockResolvedValue({
      code: "QRCODE1",
      deepLink: "https://wa.me/message/QRCODE1",
      prefilledMessage: "Changed outside airi.chat",
    });
    const updateWhatsAppChatQrMessage = jest.fn().mockResolvedValue({
      code: "QRCODE1",
      deepLink: "https://wa.me/message/QRCODE1",
      prefilledMessage: staged.prefilledMessage,
    });

    await expect(
      reconcileWhatsAppQrOperation(
        reconcileInput({
          store,
          provider: { getWhatsAppChatQr, updateWhatsAppChatQrMessage },
        })
      )
    ).resolves.toEqual({
      status: "applied",
      entryPointId: "entry-1",
      codeId: "code-1",
      entryPointVersion: 1,
      codeVersion: 3,
    });
    expect(store.markWhatsAppQrProviderRequestSent).toHaveBeenCalled();
    expect(updateWhatsAppChatQrMessage).toHaveBeenCalledWith(
      expect.objectContaining({ prefilledMessage: staged.prefilledMessage })
    );
  });

  it("completes provider sync after a crash following local code restoration", async () => {
    const ep = activeEntryPoint();
    const restored = activeCode({ providerState: "ACTIVE", version: 3 });
    mockEntryPointFindOne.mockReturnValue(leanQuery(ep));
    mockCodeFindOne.mockReturnValue(leanQuery(restored));
    const store = storeMocks();
    store.acquireWhatsAppQrReconciliationOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({
        kind: "SYNC_PROVIDER",
        status: "RECONCILE_REQUIRED",
        codeId: "code-1",
        currentCodeId: "code-1",
        expectedEntryPointVersion: 1,
        expectedCodeVersion: 1,
        providerCodeEvidence: "QRCODE1",
      }),
      lease: lease(),
    });
    const getWhatsAppChatQr = jest.fn();

    await expect(
      reconcileWhatsAppQrOperation(
        reconcileInput({ store, provider: { getWhatsAppChatQr } })
      )
    ).resolves.toMatchObject({ status: "applied", codeVersion: 3 });
    expect(getWhatsAppChatQr).not.toHaveBeenCalled();
    expect(store.completeWhatsAppQrOperation).toHaveBeenCalled();
  });

  it("reconciles a provider-confirmed missing current code into a reusable draft", async () => {
    const ep = activeEntryPoint();
    const staged = activeCode({ providerState: "RECONCILING", version: 2 });
    mockEntryPointFindOne.mockReturnValue(leanQuery(ep));
    mockCodeFindOne.mockReturnValue(leanQuery(staged));
    mockCodeFindOneAndUpdate.mockReturnValue(
      leanQuery(
        activeCode({
          providerState: "DELETED",
          placementBindingState: "DETACHED",
          routingState: "DISABLED",
          version: 3,
        })
      )
    );
    mockEntryPointFindOneAndUpdate.mockReturnValue(
      leanQuery(entryPoint({ status: "DRAFT", version: 2 }))
    );
    const store = storeMocks();
    store.acquireWhatsAppQrReconciliationOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({
        kind: "SYNC_PROVIDER",
        status: "RECONCILE_REQUIRED",
        codeId: "code-1",
        currentCodeId: "code-1",
        expectedEntryPointVersion: 1,
        expectedCodeVersion: 1,
        providerCodeEvidence: "QRCODE1",
        sanitizedError: { code: "PROVIDER_MISSING", retryable: true },
      }),
      lease: lease(),
    });
    const getWhatsAppChatQr = jest.fn().mockRejectedValue(
      new WhatsAppChatQrProviderError("definite", {
        category: "not_found",
      })
    );

    await expect(
      reconcileWhatsAppQrOperation(
        reconcileInput({ store, provider: { getWhatsAppChatQr } })
      )
    ).resolves.toMatchObject({
      status: "applied",
      entryPointVersion: 2,
      codeVersion: 3,
    });
    expect(mockEntryPointFindOneAndUpdate).toHaveBeenCalled();
  });

  it("completes provider-missing sync after a crash following local draft reset", async () => {
    const draft = entryPoint({
      status: "DRAFT",
      sourceId: undefined,
      wabaId: undefined,
      phoneNumberId: undefined,
      currentCodeId: undefined,
      version: 2,
    });
    const tombstoned = activeCode({
      providerState: "DELETED",
      placementBindingState: "DETACHED",
      routingState: "DISABLED",
      version: 3,
    });
    mockEntryPointFindOne.mockReturnValue(leanQuery(draft));
    mockCodeFindOne.mockReturnValue(leanQuery(tombstoned));
    const store = storeMocks();
    store.acquireWhatsAppQrReconciliationOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({
        kind: "SYNC_PROVIDER",
        status: "RECONCILE_REQUIRED",
        codeId: "code-1",
        currentCodeId: "code-1",
        expectedEntryPointVersion: 1,
        expectedCodeVersion: 1,
        providerCodeEvidence: "QRCODE1",
        sanitizedError: { code: "PROVIDER_MISSING", retryable: true },
      }),
      lease: lease(),
    });
    const getWhatsAppChatQr = jest.fn();

    await expect(
      reconcileWhatsAppQrOperation(
        reconcileInput({ store, provider: { getWhatsAppChatQr } })
      )
    ).resolves.toMatchObject({
      status: "applied",
      entryPointVersion: 2,
      codeVersion: 3,
    });
    expect(getWhatsAppChatQr).not.toHaveBeenCalled();
    expect(mockEntryPointFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("reconciles DELETE when Meta no longer lists the staged code", async () => {
    const ep = activeEntryPoint();
    const staged = activeCode({ providerState: "RECONCILING", version: 2 });
    mockEntryPointFindOne.mockReturnValue(leanQuery(ep));
    mockCodeFindOne.mockReturnValue(leanQuery(staged));
    mockCodeFindOneAndUpdate.mockReturnValue(
      leanQuery(
        activeCode({
          providerState: "DELETED",
          placementBindingState: "DETACHED",
          routingState: "DISABLED",
          version: 3,
        })
      )
    );
    mockEntryPointFindOneAndUpdate.mockReturnValue(
      leanQuery(entryPoint({ status: "DRAFT", version: 2 }))
    );
    const store = storeMocks();
    store.acquireWhatsAppQrReconciliationOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({
        kind: "DELETE",
        status: "RECONCILE_REQUIRED",
        codeId: "code-1",
      }),
      lease: lease(),
    });
    const listWhatsAppChatQrs = jest.fn().mockResolvedValue([]);
    const deleteWhatsAppChatQr = jest.fn();

    await expect(
      reconcileWhatsAppQrOperation(
        reconcileInput({
          store,
          provider: { listWhatsAppChatQrs, deleteWhatsAppChatQr },
        })
      )
    ).resolves.toMatchObject({
      status: "applied",
      entryPointVersion: 2,
      codeVersion: 3,
    });
    expect(deleteWhatsAppChatQr).not.toHaveBeenCalled();
  });

  it("finishes current-code DELETE reconciliation after the provider tombstone committed locally", async () => {
    const ep = activeEntryPoint();
    const tombstoned = activeCode({
      providerState: "DELETED",
      placementBindingState: "DETACHED",
      routingState: "DISABLED",
      version: 3,
    });
    mockEntryPointFindOne.mockReturnValue(leanQuery(ep));
    mockCodeFindOne.mockReturnValue(leanQuery(tombstoned));
    mockEntryPointFindOneAndUpdate.mockReturnValue(
      leanQuery(entryPoint({ status: "DRAFT", version: 2 }))
    );
    const store = storeMocks();
    store.acquireWhatsAppQrReconciliationOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({
        kind: "DELETE",
        status: "RECONCILE_REQUIRED",
        codeId: "code-1",
      }),
      lease: lease(),
    });

    await expect(
      reconcileWhatsAppQrOperation(reconcileInput({ store }))
    ).resolves.toEqual({
      status: "applied",
      entryPointId: "entry-1",
      codeId: "code-1",
      entryPointVersion: 2,
      codeVersion: 3,
    });
    expect(mockCodeFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("reconciles a historical DELETE without detaching the current binding", async () => {
    const ep = activeEntryPoint({ currentCodeId: "code-current" });
    const staged = activeCode({
      placementBindingState: "HISTORICAL",
      providerState: "RECONCILING",
      version: 2,
    });
    mockEntryPointFindOne.mockReturnValue(leanQuery(ep));
    mockCodeFindOne.mockReturnValue(leanQuery(staged));
    mockCodeFindOneAndUpdate.mockReturnValue(
      leanQuery(
        activeCode({
          providerState: "DELETED",
          placementBindingState: "DETACHED",
          routingState: "DISABLED",
          version: 3,
        })
      )
    );
    const store = storeMocks();
    store.acquireWhatsAppQrReconciliationOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({
        kind: "DELETE",
        status: "RECONCILE_REQUIRED",
        codeId: "code-1",
      }),
      lease: lease(),
    });
    const listWhatsAppChatQrs = jest.fn().mockResolvedValue([]);

    await expect(
      reconcileWhatsAppQrOperation(
        reconcileInput({ store, provider: { listWhatsAppChatQrs } })
      )
    ).resolves.toMatchObject({
      status: "applied",
      entryPointVersion: 1,
      codeVersion: 3,
    });
    expect(mockEntryPointFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("rejects CREATE reconciliation after the placement was rebound to another code", async () => {
    const rebound = activeEntryPoint({ currentCodeId: "code-other" });
    const pending = pendingCode();
    mockEntryPointFindOne.mockReturnValue(leanQuery(rebound));
    mockCodeFindOne.mockReturnValue(leanQuery(pending));
    const store = storeMocks();
    store.acquireWhatsAppQrReconciliationOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({
        status: "RECONCILE_REQUIRED",
        providerCodeEvidence: "code-1",
      }),
      lease: lease(),
    });
    const listWhatsAppChatQrs = jest.fn();

    await expect(
      reconcileWhatsAppQrOperation(
        reconcileInput({ store, provider: { listWhatsAppChatQrs } })
      )
    ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });

    expect(listWhatsAppChatQrs).not.toHaveBeenCalled();
    expect(store.releaseWhatsAppQrOperationLease).toHaveBeenCalledWith({
      lease: lease(),
    });
  });

  it("rejects CONNECT reconciliation after the placement was rebound to another code", async () => {
    const rebound = activeEntryPoint({ currentCodeId: "code-other" });
    const pending = pendingCode();
    mockEntryPointFindOne.mockReturnValue(leanQuery(rebound));
    mockCodeFindOne.mockReturnValue(leanQuery(pending));
    const store = storeMocks();
    store.acquireWhatsAppQrReconciliationOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({
        kind: "CONNECT",
        status: "RECONCILE_REQUIRED",
        providerCodeEvidence: "EXISTING1",
      }),
      lease: lease(),
    });
    const getWhatsAppChatQr = jest.fn();

    await expect(
      reconcileWhatsAppQrOperation(
        reconcileInput({ store, provider: { getWhatsAppChatQr } })
      )
    ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });

    expect(getWhatsAppChatQr).not.toHaveBeenCalled();
    expect(store.releaseWhatsAppQrOperationLease).toHaveBeenCalledWith({
      lease: lease(),
    });
  });

  it("rejects REPLACE reconciliation when a third code became current", async () => {
    const rebound = activeEntryPoint({ currentCodeId: "code-other" });
    const pending = pendingCode({
      codeId: "code-2",
      placementBindingState: "HISTORICAL",
    });
    const old = activeCode();
    mockEntryPointFindOne.mockReturnValue(leanQuery(rebound));
    mockCodeFindOne
      .mockReturnValueOnce(leanQuery(pending))
      .mockReturnValueOnce(leanQuery(old));
    const store = storeMocks();
    store.acquireWhatsAppQrReconciliationOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({
        kind: "REPLACE",
        status: "RECONCILE_REQUIRED",
        codeId: "code-1",
        currentCodeId: "code-1",
        providerCodeEvidence: "code-2",
      }),
      lease: lease(),
    });
    const listWhatsAppChatQrs = jest.fn();

    await expect(
      reconcileWhatsAppQrOperation(
        reconcileInput({ store, provider: { listWhatsAppChatQrs } })
      )
    ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });

    expect(listWhatsAppChatQrs).not.toHaveBeenCalled();
    expect(store.releaseWhatsAppQrOperationLease).toHaveBeenCalledWith({
      lease: lease(),
    });
  });

  it("rejects APPLY_MESSAGE reconciliation for a code that is no longer current", async () => {
    const rebound = activeEntryPoint({ currentCodeId: "code-other" });
    const staged = activeCode({ providerState: "RECONCILING" });
    mockEntryPointFindOne.mockReturnValue(leanQuery(rebound));
    mockCodeFindOne.mockReturnValue(leanQuery(staged));
    const store = storeMocks();
    store.acquireWhatsAppQrReconciliationOperation.mockResolvedValue({
      kind: "acquired",
      operation: operation({
        kind: "APPLY_MESSAGE",
        status: "RECONCILE_REQUIRED",
        codeId: "code-1",
      }),
      lease: lease(),
    });
    const getWhatsAppChatQr = jest.fn();

    await expect(
      reconcileWhatsAppQrOperation(
        reconcileInput({ store, provider: { getWhatsAppChatQr } })
      )
    ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });

    expect(getWhatsAppChatQr).not.toHaveBeenCalled();
    expect(store.releaseWhatsAppQrOperationLease).toHaveBeenCalledWith({
      lease: lease(),
    });
  });
});
