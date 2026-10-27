/**
 * @jest-environment node
 */

const mockConnectDB = jest.fn();
const mockEntryPointFind = jest.fn();
const mockEntryPointFindOne = jest.fn();
const mockEntryPointFindOneAndUpdate = jest.fn();
const mockCodeFindOne = jest.fn();
const mockCodeFind = jest.fn();
const mockOperationFind = jest.fn();
const mockOperationFindOne = jest.fn();
const mockLoadAssignmentSummaries = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/whatsapp-qr-entry-point", () => ({
  WhatsAppQrEntryPoint: {
    find: (...args: unknown[]) => mockEntryPointFind(...args),
    findOne: (...args: unknown[]) => mockEntryPointFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) =>
      mockEntryPointFindOneAndUpdate(...args),
  },
}));

jest.mock("@/models/whatsapp-qr-code", () => ({
  WHATSAPP_QR_MANAGEABLE_HISTORY_LIMIT: 20,
  WhatsAppQrCode: {
    findOne: (...args: unknown[]) => mockCodeFindOne(...args),
    find: (...args: unknown[]) => mockCodeFind(...args),
  },
}));

jest.mock("@/models/whatsapp-qr-operation", () => ({
  WhatsAppQrOperation: {
    find: (...args: unknown[]) => mockOperationFind(...args),
    findOne: (...args: unknown[]) => mockOperationFindOne(...args),
  },
}));

jest.mock("./assignment-summary", () => ({
  loadWhatsAppQrAssignmentSummaries: (...args: unknown[]) =>
    mockLoadAssignmentSummaries(...args),
}));

import {
  findWhatsAppQrCodeByReference,
  getWhatsAppQrEntryPointDetail,
  listWhatsAppQrScenarioSummaries,
  loadWhatsAppQrEntryPointReadinessByBindings,
} from "./queries";

const NOW = new Date("2026-08-06T12:00:00.000Z");
const ENTRY_POINT_ID = "11111111-1111-4111-8111-111111111111";

function leanQuery<T>(value: T) {
  return { lean: jest.fn().mockResolvedValue(value) };
}

function selectedLeanQuery<T>(value: T) {
  const query = {
    select: jest.fn(),
    lean: jest.fn().mockResolvedValue(value),
  };
  query.select.mockReturnValue(query);
  return query;
}

function sortedLimitedLeanQuery<T>(value: T) {
  const lean = jest.fn().mockResolvedValue(value);
  const limit = jest.fn().mockReturnValue({ lean });
  const sort = jest.fn().mockReturnValue({ limit });
  return { query: { sort }, sort, limit, lean };
}

function readyEntryPoint(overrides: Record<string, unknown> = {}) {
  return {
    entryPointId: ENTRY_POINT_ID,
    workspaceId: "workspace-1",
    scenarioId: "scenario-1",
    nodeId: "node-1",
    assignmentState: "assigned",
    placementName: "Door",
    sourceId: "source-1",
    wabaId: "waba-1",
    phoneNumberId: "phone-1",
    currentCodeId: "code-1",
    status: "ACTIVE",
    version: 2,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function readyCode(overrides: Record<string, unknown> = {}) {
  return {
    codeId: "code-1",
    workspaceId: "workspace-1",
    entryPointId: ENTRY_POINT_ID,
    sourceId: "source-1",
    wabaId: "waba-1",
    phoneNumberId: "phone-1",
    referenceCode: "ABCDEFGHJK",
    providerCode: "QR1",
    deepLink: "https://wa.me/message/QR1",
    prefilledMessage: "Hi\n[Ref: ABCDE-FGHJK]",
    placementBindingState: "CURRENT",
    routingState: "ENABLED",
    providerState: "ACTIVE",
    version: 7,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("WhatsApp QR queries", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockCodeFind.mockReturnValue(sortedLimitedLeanQuery([]).query);
    mockOperationFind.mockReturnValue(selectedLeanQuery([]));
    mockOperationFindOne.mockReturnValue(leanQuery(null));
    mockLoadAssignmentSummaries.mockResolvedValue(new Map());
  });

  it("maps scenario entry points into a node summary map", async () => {
    mockEntryPointFind.mockReturnValue(
      leanQuery([
        {
          entryPointId: "entry-1",
          workspaceId: "workspace-1",
          scenarioId: "scenario-1",
          nodeId: "node-1",
          placementName: "Door",
          sourceId: "source-1",
          wabaId: "waba-1",
          phoneNumberId: "phone-1",
          currentCodeId: "code-1",
          status: "ACTIVE",
          version: 2,
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          entryPointId: "entry-2",
          workspaceId: "workspace-1",
          scenarioId: "scenario-1",
          nodeId: "node-2",
          placementName: "Window",
          status: "DRAFT",
          version: 0,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ])
    );
    mockCodeFind.mockReturnValue(
      selectedLeanQuery([
        {
          codeId: "code-1",
          workspaceId: "workspace-1",
          entryPointId: "entry-1",
          sourceId: "source-1",
          wabaId: "waba-1",
          phoneNumberId: "phone-1",
          providerCode: "QR1",
          deepLink: "https://wa.me/message/QR1",
          placementBindingState: "CURRENT",
          routingState: "ENABLED",
          providerState: "ACTIVE",
        },
      ])
    );

    await expect(
      listWhatsAppQrScenarioSummaries({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
      })
    ).resolves.toEqual({
      "node-1": {
        entryPointId: "entry-1",
        placementName: "Door",
        status: "ACTIVE",
        sourceId: "source-1",
        hasCurrentCode: true,
        readiness: "ready",
        reconcilePending: false,
        version: 2,
      },
      "node-2": {
        entryPointId: "entry-2",
        placementName: "Window",
        status: "DRAFT",
        hasCurrentCode: false,
        readiness: "draft",
        reconcilePending: false,
        version: 0,
      },
    });
  });

  it("returns entry-point detail with optional current code", async () => {
    mockEntryPointFindOne.mockReturnValue(
      leanQuery({
        entryPointId: "entry-1",
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        nodeId: "node-1",
        placementName: "Door",
        desiredMessage: "Hi",
        sourceId: "source-1",
        wabaId: "waba-1",
        phoneNumberId: "phone-1",
        currentCodeId: "code-1",
        status: "ACTIVE",
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      })
    );
    mockCodeFindOne.mockReturnValue(
      leanQuery({
        codeId: "code-1",
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        sourceId: "source-1",
        wabaId: "waba-1",
        phoneNumberId: "phone-1",
        referenceCode: "ABCDEFGHJK",
        providerCode: "QR1",
        deepLink: "https://wa.me/message/QR1",
        prefilledMessage: "Hi\n[Ref: ABCDE-FGHJK]",
        placementBindingState: "CURRENT",
        routingState: "ENABLED",
        providerState: "ACTIVE",
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      })
    );
    const historicalQuery = sortedLimitedLeanQuery([
      {
        codeId: "code-old",
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        sourceId: "source-1",
        wabaId: "waba-1",
        phoneNumberId: "phone-1",
        referenceCode: "OLDREFCODE1",
        providerCode: "QROLD",
        deepLink: "https://wa.me/message/QROLD",
        prefilledMessage: "Old\n[Ref: OLDRE-FCODE]",
        placementBindingState: "HISTORICAL",
        routingState: "ENABLED",
        providerState: "ACTIVE",
        version: 2,
        createdAt: NOW,
        updatedAt: NOW,
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        codeId: `code-overflow-${index}`,
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        sourceId: "source-1",
        wabaId: "waba-1",
        phoneNumberId: "phone-1",
        referenceCode: `OVERFLOW${String(index).padStart(2, "0")}`,
        placementBindingState: "HISTORICAL" as const,
        routingState: "DISABLED" as const,
        providerState: "ACTIVE" as const,
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    ]);
    mockCodeFind.mockReturnValue(historicalQuery.query);
    mockOperationFindOne.mockReturnValue(
      leanQuery({
        operationId: "operation-delete-old",
        sourceId: "source-1",
        kind: "DELETE",
        status: "RECONCILE_REQUIRED",
        codeId: "code-old",
      })
    );

    await expect(
      getWhatsAppQrEntryPointDetail({
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
      })
    ).resolves.toMatchObject({
      entryPoint: { entryPointId: "entry-1", status: "ACTIVE", version: 1 },
      currentCode: {
        codeId: "code-1",
        deepLink: "https://wa.me/message/QR1",
        routingState: "ENABLED",
      },
      historicalCodes: [
        {
          codeId: "code-old",
          referenceCode: "OLDREFCODE1",
          routingState: "ENABLED",
          providerState: "ACTIVE",
        },
        ...Array.from({ length: 19 }, (_, index) => ({
          codeId: `code-overflow-${index}`,
          referenceCode: `OVERFLOW${String(index).padStart(2, "0")}`,
          placementBindingState: "HISTORICAL",
          routingState: "DISABLED",
          providerState: "ACTIVE",
          version: 1,
        })),
      ],
      historicalCodesHasMore: true,
      canCreateReplacement: false,
      reconcileOperation: {
        operationId: "operation-delete-old",
        kind: "DELETE",
        codeId: "code-old",
      },
    });
    expect(mockCodeFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      entryPointId: "entry-1",
      placementBindingState: "HISTORICAL",
      providerState: { $in: ["ACTIVE", "RECONCILING"] },
    });
    expect(historicalQuery.sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(historicalQuery.limit).toHaveBeenCalledWith(21);
    expect(mockOperationFindOne).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      entryPointId: "entry-1",
      status: { $in: ["RUNNING", "RECONCILE_REQUIRED"] },
    });
  });

  it("exposes the operation source needed to reconcile an unbound draft", async () => {
    mockEntryPointFindOne.mockReturnValue(
      leanQuery({
        entryPointId: "entry-draft",
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        nodeId: "node-draft",
        placementName: "Draft placement",
        status: "DRAFT",
        version: 0,
        createdAt: NOW,
        updatedAt: NOW,
      })
    );
    mockOperationFindOne.mockReturnValue(
      leanQuery({
        operationId: "operation-create-draft",
        entryPointId: "entry-draft",
        sourceId: "source-operation",
        kind: "CREATE",
        status: "RECONCILE_REQUIRED",
      })
    );

    await expect(
      getWhatsAppQrEntryPointDetail({
        workspaceId: "workspace-1",
        entryPointId: "entry-draft",
      })
    ).resolves.toMatchObject({
      entryPoint: {
        entryPointId: "entry-draft",
        status: "DRAFT",
      },
      reconcileOperation: {
        operationId: "operation-create-draft",
        sourceId: "source-operation",
        kind: "CREATE",
      },
    });
  });

  it("omits absent assignment identifiers from unassigned detail", async () => {
    mockEntryPointFindOne.mockReturnValue(
      leanQuery({
        entryPointId: "entry-unassigned",
        workspaceId: "workspace-1",
        assignmentState: "unassigned",
        placementName: "Unassigned",
        placementNameSearch: "unassigned",
        status: "DRAFT",
        version: 0,
        createdAt: NOW,
        updatedAt: NOW,
      })
    );

    const detail = await getWhatsAppQrEntryPointDetail({
      workspaceId: "workspace-1",
      entryPointId: "entry-unassigned",
    });

    expect(detail?.entryPoint).toEqual({
      entryPointId: "entry-unassigned",
      workspaceId: "workspace-1",
      placementName: "Unassigned",
      status: "DRAFT",
      version: 0,
      updatedAt: NOW.toISOString(),
    });
    expect(detail?.entryPoint).not.toHaveProperty("scenarioId");
    expect(detail?.entryPoint).not.toHaveProperty("nodeId");
  });

  it("looks up a code by workspace+source+reference", async () => {
    mockCodeFindOne.mockReturnValue(
      leanQuery({
        codeId: "code-1",
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        sourceId: "source-1",
        referenceCode: "ABCDEFGHJK",
        placementBindingState: "CURRENT",
        routingState: "ENABLED",
        providerState: "ACTIVE",
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      })
    );

    await expect(
      findWhatsAppQrCodeByReference({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        referenceCode: "ABCDEFGHJK",
      })
    ).resolves.toMatchObject({
      codeId: "code-1",
      referenceCode: "ABCDEFGHJK",
    });
    expect(mockCodeFindOne).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      referenceCode: "ABCDEFGHJK",
    });
  });

  it("rejects blank reference lookup inputs", async () => {
    await expect(
      findWhatsAppQrCodeByReference({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        referenceCode: "  ",
      })
    ).rejects.toThrow("Reference code is required");
    expect(mockCodeFindOne).not.toHaveBeenCalled();
  });

  it("returns exact current-code evidence for a ready stable binding", async () => {
    mockEntryPointFind.mockReturnValue(leanQuery([readyEntryPoint()]));
    mockCodeFind.mockReturnValue(leanQuery([readyCode()]));

    await expect(
      loadWhatsAppQrEntryPointReadinessByBindings({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        bindings: [{ nodeId: "node-1", entryPointId: ENTRY_POINT_ID }],
      })
    ).resolves.toEqual({
      "node-1": {
        entryPointId: ENTRY_POINT_ID,
        ready: true,
        currentCodeId: "code-1",
        currentCodeVersion: 7,
      },
    });
  });

  it("keeps a historical code binding unready while returning its evidence", async () => {
    mockEntryPointFind.mockReturnValue(leanQuery([readyEntryPoint()]));
    mockCodeFind.mockReturnValue(
      leanQuery([readyCode({ placementBindingState: "HISTORICAL" })])
    );

    await expect(
      loadWhatsAppQrEntryPointReadinessByBindings({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        bindings: [{ nodeId: "node-1", entryPointId: ENTRY_POINT_ID }],
      })
    ).resolves.toEqual({
      "node-1": {
        entryPointId: ENTRY_POINT_ID,
        ready: false,
        currentCodeId: "code-1",
        currentCodeVersion: 7,
      },
    });
  });

  it("does not recover a supplied stable pointer from a mismatched tuple", async () => {
    mockEntryPointFind.mockReturnValue(
      leanQuery([readyEntryPoint({ nodeId: "different-node" })])
    );
    mockCodeFind.mockReturnValue(leanQuery([readyCode()]));

    await expect(
      loadWhatsAppQrEntryPointReadinessByBindings({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        bindings: [{ nodeId: "node-1", entryPointId: ENTRY_POINT_ID }],
      })
    ).resolves.toEqual({
      "node-1": {
        entryPointId: ENTRY_POINT_ID,
        ready: false,
        currentCodeId: "code-1",
        currentCodeVersion: 7,
      },
    });
  });

  it("has no evidence for a binding without a stable pointer", async () => {
    await expect(
      loadWhatsAppQrEntryPointReadinessByBindings({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        bindings: [{ nodeId: "node-1" }],
      })
    ).resolves.toEqual({});
    // No lookup by the (scenario, node) tuple.
    expect(mockEntryPointFind).not.toHaveBeenCalledWith(
      expect.objectContaining({ $or: expect.anything() })
    );
  });

  it("blocks activation evidence while a delete operation is active", async () => {
    mockEntryPointFind.mockReturnValue(leanQuery([readyEntryPoint()]));
    mockCodeFind.mockReturnValue(leanQuery([readyCode()]));
    mockOperationFind.mockReturnValue(
      selectedLeanQuery([{ entryPointId: ENTRY_POINT_ID }])
    );

    await expect(
      loadWhatsAppQrEntryPointReadinessByBindings({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        bindings: [{ nodeId: "node-1", entryPointId: ENTRY_POINT_ID }],
      })
    ).resolves.toEqual({
      "node-1": {
        entryPointId: ENTRY_POINT_ID,
        ready: false,
        currentCodeId: "code-1",
        currentCodeVersion: 7,
      },
    });
  });
});
