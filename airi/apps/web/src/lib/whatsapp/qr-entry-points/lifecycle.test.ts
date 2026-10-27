/**
 * @jest-environment node
 */

const mockConnectDB = jest.fn();
const mockAssertUnassignedWritesEnabled = jest.fn();
const mockEntryPointFind = jest.fn();
const mockEntryPointFindOne = jest.fn();
const mockEntryPointFindOneAndUpdate = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("./indexes", () => ({
  assertWhatsAppQrUnassignedWritesEnabled: (...args: unknown[]) =>
    mockAssertUnassignedWritesEnabled(...args),
}));

jest.mock("@/models/whatsapp-qr-entry-point", () => ({
  WhatsAppQrEntryPoint: {
    find: (...args: unknown[]) => mockEntryPointFind(...args),
    findOne: (...args: unknown[]) => mockEntryPointFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) =>
      mockEntryPointFindOneAndUpdate(...args),
  },
}));

import { unassignWhatsAppQrEntryPointsForRemovedNodes } from "./lifecycle";

const NOW = new Date("2026-08-06T12:00:00.000Z");

function leanQuery<T>(value: T) {
  const query = {
    select: jest.fn(),
    session: jest.fn(),
    lean: jest.fn().mockResolvedValue(value),
  };
  query.select.mockReturnValue(query);
  query.session.mockReturnValue(query);
  return query;
}

function assignedEntry(overrides: Record<string, unknown> = {}) {
  return {
    entryPointId: "entry-1",
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

describe("WhatsApp QR assignment lifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertUnassignedWritesEnabled.mockResolvedValue(undefined);
    mockConnectDB.mockResolvedValue(undefined);
  });

  it("unassigns matching entry points with identity and version CAS", async () => {
    mockEntryPointFind.mockReturnValue(leanQuery([assignedEntry()]));
    mockEntryPointFindOneAndUpdate.mockReturnValue(
      leanQuery(
        assignedEntry({
          scenarioId: undefined,
          nodeId: undefined,
          assignmentState: "unassigned",
          version: 3,
        })
      )
    );

    await unassignWhatsAppQrEntryPointsForRemovedNodes({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      removedNodeIds: ["node-1", "node-missing"],
    });

    expect(mockEntryPointFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      nodeId: { $in: ["node-1", "node-missing"] },
    });
    expect(mockEntryPointFindOneAndUpdate).toHaveBeenCalledWith(
      {
        entryPointId: "entry-1",
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        nodeId: "node-1",
        version: 2,
      },
      {
        $unset: { scenarioId: 1, nodeId: 1 },
        $set: { assignmentState: "unassigned" },
        $inc: { version: 1 },
      },
      { new: true, runValidators: true }
    );
  });

  it("runs the lookup and CAS mutation in the caller transaction", async () => {
    const session = { id: "session-1" };
    const findQuery = leanQuery([assignedEntry()]);
    const updateQuery = leanQuery(
      assignedEntry({
        scenarioId: undefined,
        nodeId: undefined,
        assignmentState: "unassigned",
        version: 3,
      })
    );
    mockEntryPointFind.mockReturnValue(findQuery);
    mockEntryPointFindOneAndUpdate.mockReturnValue(updateQuery);

    await unassignWhatsAppQrEntryPointsForRemovedNodes({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      removedNodeIds: ["node-1"],
      session: session as never,
    });

    expect(findQuery.session).toHaveBeenCalledWith(session);
    expect(updateQuery.session).toHaveBeenCalledWith(session);
  });

  it("retries CAS after a version conflict", async () => {
    mockEntryPointFind.mockReturnValue(leanQuery([assignedEntry()]));
    mockEntryPointFindOneAndUpdate
      .mockReturnValueOnce(leanQuery(null))
      .mockReturnValueOnce(
        leanQuery(
          assignedEntry({
            scenarioId: undefined,
            nodeId: undefined,
            assignmentState: "unassigned",
            version: 4,
          })
        )
      );
    mockEntryPointFindOne.mockReturnValue(
      leanQuery(assignedEntry({ version: 3 }))
    );

    await unassignWhatsAppQrEntryPointsForRemovedNodes({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      removedNodeIds: ["node-1"],
    });

    expect(mockEntryPointFindOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ version: 3 }),
      expect.objectContaining({
        $unset: { scenarioId: 1, nodeId: 1 },
        $set: { assignmentState: "unassigned" },
      }),
      { new: true, runValidators: true }
    );
  });

  it("stops when another writer already moved or unassigned the entry point", async () => {
    mockEntryPointFind.mockReturnValue(leanQuery([assignedEntry()]));
    mockEntryPointFindOneAndUpdate.mockReturnValue(leanQuery(null));
    mockEntryPointFindOne.mockReturnValue(leanQuery(null));

    await expect(
      unassignWhatsAppQrEntryPointsForRemovedNodes({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        removedNodeIds: ["node-1"],
      })
    ).resolves.toBeUndefined();

    expect(mockEntryPointFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("rejects after the bounded CAS retries are exhausted", async () => {
    mockEntryPointFind.mockReturnValue(leanQuery([assignedEntry()]));
    mockEntryPointFindOneAndUpdate.mockReturnValue(leanQuery(null));
    mockEntryPointFindOne
      .mockReturnValueOnce(leanQuery(assignedEntry({ version: 3 })))
      .mockReturnValueOnce(leanQuery(assignedEntry({ version: 4 })))
      .mockReturnValueOnce(leanQuery(assignedEntry({ version: 5 })));

    await expect(
      unassignWhatsAppQrEntryPointsForRemovedNodes({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        removedNodeIds: ["node-1"],
      })
    ).rejects.toThrow(
      "WhatsApp QR entry point entry-1 could not be unassigned after 3 attempts"
    );

    expect(mockEntryPointFindOneAndUpdate).toHaveBeenCalledTimes(3);
  });

  it("continues unassigning later entry points and aggregates exhausted failures", async () => {
    const laterEntry = assignedEntry({
      entryPointId: "entry-2",
      nodeId: "node-2",
      version: 7,
    });
    mockEntryPointFind.mockReturnValue(
      leanQuery([assignedEntry(), laterEntry])
    );
    mockEntryPointFindOneAndUpdate
      .mockReturnValueOnce(leanQuery(null))
      .mockReturnValueOnce(leanQuery(null))
      .mockReturnValueOnce(leanQuery(null))
      .mockReturnValueOnce(
        leanQuery(
          assignedEntry({
            ...laterEntry,
            scenarioId: undefined,
            nodeId: undefined,
            assignmentState: "unassigned",
            version: 8,
          })
        )
      );
    mockEntryPointFindOne
      .mockReturnValueOnce(leanQuery(assignedEntry({ version: 3 })))
      .mockReturnValueOnce(leanQuery(assignedEntry({ version: 4 })))
      .mockReturnValueOnce(leanQuery(assignedEntry({ version: 5 })));

    const result = unassignWhatsAppQrEntryPointsForRemovedNodes({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      removedNodeIds: ["node-1", "node-2"],
    });

    await expect(result).rejects.toMatchObject({
      failedEntryPointIds: ["entry-1"],
      failedNodeIds: ["node-1"],
    });
    expect(mockEntryPointFindOneAndUpdate).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        entryPointId: "entry-2",
        nodeId: "node-2",
        version: 7,
      }),
      expect.any(Object),
      expect.any(Object)
    );
  });

  it("no-ops before persistence when removedNodeIds is empty", async () => {
    await unassignWhatsAppQrEntryPointsForRemovedNodes({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      removedNodeIds: [],
    });

    expect(mockAssertUnassignedWritesEnabled).not.toHaveBeenCalled();
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockEntryPointFind).not.toHaveBeenCalled();
  });
});
