/**
 * @jest-environment node
 */

const mockConnectDB = jest.fn();
const mockScenarioFind = jest.fn();
const mockScenarioFindOne = jest.fn();
const mockScenarioUpdateOne = jest.fn();
const mockScenarioStartSession = jest.fn();
const mockEntryPointFind = jest.fn();
const mockDetachRemovedNodes = jest.fn();
const mockLoggerError = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/scenario", () => ({
  Scenario: {
    find: (...args: unknown[]) => mockScenarioFind(...args),
    findOne: (...args: unknown[]) => mockScenarioFindOne(...args),
    updateOne: (...args: unknown[]) => mockScenarioUpdateOne(...args),
    startSession: (...args: unknown[]) => mockScenarioStartSession(...args),
  },
}));

jest.mock("@/models/whatsapp-qr-entry-point", () => ({
  WhatsAppQrEntryPoint: {
    find: (...args: unknown[]) => mockEntryPointFind(...args),
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

jest.mock("./lifecycle", () => {
  class WhatsAppQrUnassignError extends Error {
    readonly failedEntryPointIds: string[];
    readonly failedNodeIds: string[];

    constructor(
      failures: ReadonlyArray<{ entryPointId: string; nodeId: string }>
    ) {
      super("QR unassignment failed");
      this.failedEntryPointIds = failures.map(failure => failure.entryPointId);
      this.failedNodeIds = failures.map(failure => failure.nodeId);
    }
  }

  return {
    WhatsAppQrUnassignError,
    unassignWhatsAppQrEntryPointsForRemovedNodes: (...args: unknown[]) =>
      mockDetachRemovedNodes(...args),
  };
});

import {
  buildWhatsAppQrDetachPendingState,
  markWhatsAppQrDetachPendingNodes,
  processWhatsAppQrDetachPendingBatch,
  reconcileWhatsAppQrDetachPendingForScenario,
} from "./cleanup-retry";
import { WhatsAppQrUnassignError } from "./lifecycle";

function sessionLeanQuery<T>(value: T) {
  const query = {
    session: jest.fn(),
    lean: jest.fn().mockResolvedValue(value),
  };
  query.session.mockReturnValue(query);
  return query;
}

function sessionSelectLeanQuery<T>(value: T) {
  const query = {
    select: jest.fn(),
    session: jest.fn(),
    lean: jest.fn().mockResolvedValue(value),
  };
  query.select.mockReturnValue(query);
  query.session.mockReturnValue(query);
  return query;
}

function dueScenarioQuery<T>(value: T) {
  const query = {
    select: jest.fn(),
    sort: jest.fn(),
    limit: jest.fn(),
    lean: jest.fn().mockResolvedValue(value),
  };
  query.select.mockReturnValue(query);
  query.sort.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  return query;
}

function createSession() {
  return {
    withTransaction: jest.fn(async (callback: () => Promise<void>) =>
      callback()
    ),
    endSession: jest.fn().mockResolvedValue(undefined),
  };
}

function pendingScenario(overrides: Record<string, unknown> = {}) {
  return {
    _id: "scenario-1",
    workspaceId: "workspace-1",
    nodes: [],
    deletedAt: null,
    whatsappQrDetachPendingNodeIds: ["node-1", "node-2"],
    whatsappQrDetachNextRetryAt: new Date("2026-08-08T12:00:00.000Z"),
    ...overrides,
  };
}

describe("WhatsApp QR detach retry", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockScenarioStartSession.mockResolvedValue(createSession());
    mockScenarioUpdateOne.mockResolvedValue({ matchedCount: 1 });
    mockEntryPointFind.mockReturnValue(sessionSelectLeanQuery([]));
    mockDetachRemovedNodes.mockResolvedValue(undefined);
  });

  it("keeps re-added pending nodes until reconciliation verifies their projection", () => {
    const qrNode = (id: string) => ({
      id,
      data: {
        kind: "trigger",
        triggerConfig: { entryPointType: "whatsapp_qr" },
      },
    });

    expect(
      buildWhatsAppQrDetachPendingState({
        existingPendingNodeIds: ["node-readded", "node-still-pending"],
        previousNodes: [qrNode("node-removed"), qrNode("node-readded")],
        nextNodes: [qrNode("node-readded")],
      })
    ).toEqual({
      pendingNodeIds: ["node-readded", "node-still-pending", "node-removed"],
      removedNodeIds: ["node-removed"],
    });
  });

  it("durably schedules newly discovered orphan placements before reconciliation", async () => {
    const now = new Date("2026-08-08T12:00:00.000Z");

    await expect(
      markWhatsAppQrDetachPendingNodes({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        nodeIds: ["node-1", " node-1 ", "node-2"],
        now,
      })
    ).resolves.toBeUndefined();

    expect(mockScenarioUpdateOne).toHaveBeenCalledWith(
      { _id: "scenario-1", workspaceId: "workspace-1" },
      {
        $addToSet: {
          whatsappQrDetachPendingNodeIds: { $each: ["node-1", "node-2"] },
        },
        $min: { whatsappQrDetachNextRetryAt: now },
      },
      { timestamps: false }
    );
  });

  it("atomically clears the durable marker after every pending node detaches", async () => {
    const session = createSession();
    mockScenarioStartSession.mockResolvedValue(session);
    mockScenarioFindOne.mockReturnValue(sessionLeanQuery(pendingScenario()));

    const result = await reconcileWhatsAppQrDetachPendingForScenario({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      now: new Date("2026-08-08T12:00:00.000Z"),
    });

    expect(result).toEqual({
      attemptedNodeIds: ["node-1", "node-2"],
      failedNodeIds: [],
    });
    expect(mockDetachRemovedNodes).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      removedNodeIds: ["node-1", "node-2"],
      session,
    });
    expect(mockScenarioUpdateOne).toHaveBeenCalledWith(
      {
        _id: "scenario-1",
        workspaceId: "workspace-1",
        whatsappQrDetachPendingNodeIds: ["node-1", "node-2"],
      },
      {
        $unset: {
          whatsappQrDetachPendingNodeIds: 1,
          whatsappQrDetachNextRetryAt: 1,
        },
      },
      { session, timestamps: false }
    );
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });

  it("commits later detach successes and reschedules only the failed node IDs", async () => {
    const session = createSession();
    mockScenarioStartSession.mockResolvedValue(session);
    mockScenarioFindOne.mockReturnValue(sessionLeanQuery(pendingScenario()));
    mockDetachRemovedNodes.mockRejectedValueOnce(
      new WhatsAppQrUnassignError([
        { entryPointId: "entry-1", nodeId: "node-1" },
      ])
    );

    const result = await reconcileWhatsAppQrDetachPendingForScenario({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      now: new Date("2026-08-08T12:00:00.000Z"),
    });

    expect(result).toEqual({
      attemptedNodeIds: ["node-1", "node-2"],
      failedNodeIds: ["node-1"],
    });
    expect(mockScenarioUpdateOne).toHaveBeenCalledWith(
      {
        _id: "scenario-1",
        workspaceId: "workspace-1",
        whatsappQrDetachPendingNodeIds: ["node-1", "node-2"],
      },
      {
        $set: {
          whatsappQrDetachPendingNodeIds: ["node-1"],
          whatsappQrDetachNextRetryAt: new Date("2026-08-08T12:05:00.000Z"),
        },
      },
      { session, timestamps: false }
    );
  });

  it("does not detach a pending node that was re-added as a QR trigger", async () => {
    const session = createSession();
    mockScenarioStartSession.mockResolvedValue(session);
    mockScenarioFindOne.mockReturnValue(
      sessionLeanQuery(
        pendingScenario({
          whatsappQrDetachPendingNodeIds: ["node-1"],
          nodes: [
            {
              id: "node-1",
              data: {
                kind: "trigger",
                triggerConfig: {
                  entryPointType: "whatsapp_qr",
                  entryPointId: "entry-1",
                },
              },
            },
          ],
        })
      )
    );
    mockEntryPointFind.mockReturnValue(
      sessionSelectLeanQuery([{ entryPointId: "entry-1", nodeId: "node-1" }])
    );

    await expect(
      reconcileWhatsAppQrDetachPendingForScenario({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
      })
    ).resolves.toEqual({ attemptedNodeIds: [], failedNodeIds: [] });

    expect(mockDetachRemovedNodes).not.toHaveBeenCalled();
    expect(mockScenarioUpdateOne).toHaveBeenCalledWith(
      expect.any(Object),
      {
        $unset: {
          whatsappQrDetachPendingNodeIds: 1,
          whatsappQrDetachNextRetryAt: 1,
        },
      },
      { session, timestamps: false }
    );
  });

  it("bounds the due scan and continues after one scenario cannot start a transaction", async () => {
    const now = new Date("2026-08-08T12:00:00.000Z");
    const findQuery = dueScenarioQuery([
      { _id: "scenario-1", workspaceId: "workspace-1" },
      { _id: "scenario-2", workspaceId: "workspace-2" },
    ]);
    const secondSession = createSession();
    mockScenarioFind.mockReturnValue(findQuery);
    mockScenarioStartSession
      .mockRejectedValueOnce(new Error("transaction unavailable"))
      .mockResolvedValueOnce(secondSession);
    mockScenarioFindOne.mockReturnValueOnce(
      sessionLeanQuery(
        pendingScenario({
          _id: "scenario-2",
          workspaceId: "workspace-2",
          whatsappQrDetachPendingNodeIds: ["node-2"],
        })
      )
    );

    await expect(
      processWhatsAppQrDetachPendingBatch({ limit: 2, now })
    ).resolves.toEqual({
      scanned: 2,
      completed: 1,
      pending: 0,
      failed: 1,
    });

    expect(mockScenarioFind).toHaveBeenCalledWith({
      "whatsappQrDetachPendingNodeIds.0": { $exists: true },
      whatsappQrDetachNextRetryAt: { $lte: now },
    });
    expect(findQuery.select).toHaveBeenCalledWith({
      _id: 1,
      workspaceId: 1,
    });
    expect(findQuery.sort).toHaveBeenCalledWith({
      whatsappQrDetachNextRetryAt: 1,
      _id: 1,
    });
    expect(findQuery.limit).toHaveBeenCalledWith(2);
    expect(mockScenarioStartSession).toHaveBeenCalledTimes(2);
    expect(mockLoggerError).toHaveBeenCalledWith(
      "whatsapp_qr.unassign_retry_scenario_failed",
      expect.any(Error),
      { workspaceId: "workspace-1", scenarioId: "scenario-1" }
    );
  });
});
