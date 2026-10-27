const mockScenarioFind = jest.fn();
const mockScenarioFindOne = jest.fn();
const mockScenarioUpdateOne = jest.fn();
const mockScenarioStartSession = jest.fn();
const mockLinkedConditionFind = jest.fn();
const mockLinkedConditionFindOne = jest.fn();
const mockLinkedConditionUpdateOne = jest.fn();
const mockLinkedConditionDeleteOne = jest.fn();

jest.mock("@/models/scenario", () => ({
  Scenario: {
    find: (...args: unknown[]) => mockScenarioFind(...args),
    findOne: (...args: unknown[]) => mockScenarioFindOne(...args),
    updateOne: (...args: unknown[]) => mockScenarioUpdateOne(...args),
    startSession: (...args: unknown[]) => mockScenarioStartSession(...args),
  },
}));

jest.mock("@/models/scenario-linked-condition", () => ({
  __esModule: true,
  default: {
    find: (...args: unknown[]) => mockLinkedConditionFind(...args),
    findOne: (...args: unknown[]) => mockLinkedConditionFindOne(...args),
    updateOne: (...args: unknown[]) => mockLinkedConditionUpdateOne(...args),
    deleteOne: (...args: unknown[]) => mockLinkedConditionDeleteOne(...args),
  },
}));

import {
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  getScenarioActionOutcomeVirtualNodeId,
} from "@icecore/scenario-contracts";
import {
  dedupeLinkedConditionRecords,
  syncScenarioLinkedConditions,
} from "../linked-condition-reconciler";
import { reconcileLinkedConditionRecordWithParentFence } from "../linked-condition-repository";
import { LINKED_CONDITION_ERROR_CODES } from "../linked-conditions-types";

const expectedRevision = new Date("2026-08-05T12:00:00.000Z");
const convertedRevision = new Date("2026-08-05T12:01:00.000Z");
const transactionSession = { id: "linked-condition-fence-session" };

function chainLeanQuery<T>(value: T) {
  const query = {
    select: jest.fn(),
    session: jest.fn(),
    lean: jest.fn().mockResolvedValue(value),
  };
  query.select.mockReturnValue(query);
  query.session.mockReturnValue(query);
  return query;
}

function linkedRecord(parentRefs: Array<Record<string, unknown>>) {
  return {
    _id: "record-1",
    __v: 3,
    workspaceId: "workspace-1",
    childScenarioId: "child-1",
    childTriggerNodeId: "trigger-1",
    conditionType: "no_reply_timeout",
    conditionConfig: { timeoutMinutes: 30 },
    parentRefs,
  };
}

const parentRef = {
  parentScenarioId: "parent-1",
  conditionNodeId: getScenarioActionOutcomeVirtualNodeId("action-1"),
  branchType: "no_reply_timeout",
  sourceActionNodeId: "action-1",
  scenarioLinkNodeId: "link-1",
};

const otherParentRef = {
  parentScenarioId: "parent-2",
  conditionNodeId: getScenarioActionOutcomeVirtualNodeId("action-2"),
  branchType: "no_reply_timeout",
  sourceActionNodeId: "action-2",
  scenarioLinkNodeId: "link-2",
};

const otherParentScenario = {
  _id: "parent-2",
  __v: 4,
  workspaceId: "workspace-1",
  updatedAt: expectedRevision,
  nodes: [
    {
      id: "action-2",
      data: {
        kind: "action",
        actionOutcomes: {
          version: 1,
          noReply: {
            enabled: true,
            timeoutMinutes: 30,
            linkedConditionId: "record-1",
          },
        },
      },
    },
    {
      id: "link-2",
      data: { kind: "scenario_link", linkedScenarioId: "child-1" },
    },
  ],
  edges: [
    {
      id: "edge-2",
      source: "action-2",
      sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
      target: "link-2",
    },
  ],
};

function parentScenarioWithLink(updatedAt = expectedRevision) {
  return {
    _id: "parent-1",
    __v: 7,
    workspaceId: "workspace-1",
    updatedAt,
    nodes: [
      {
        id: "action-1",
        data: {
          kind: "action",
          actionOutcomes: {
            version: 1,
            noReply: {
              enabled: true,
              timeoutMinutes: 30,
              linkedConditionId: "record-1",
            },
          },
        },
      },
      {
        id: "link-1",
        data: { kind: "scenario_link", linkedScenarioId: "child-1" },
      },
    ],
    edges: [
      {
        id: "edge-1",
        source: "action-1",
        sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
        target: "link-1",
      },
    ],
  };
}

const childScenario = {
  _id: "child-1",
  updatedAt: expectedRevision,
  nodes: [
    {
      id: "trigger-1",
      data: {
        kind: "trigger",
        linkedConditionId: "record-1",
        triggerConfig: {
          enabled: true,
          messageMatchMode: "any",
          keywordMatchMode: "contains",
        },
      },
    },
  ],
  edges: [],
};

function arrangeTransaction() {
  const withTransaction = jest.fn(async callback => callback());
  const endSession = jest.fn().mockResolvedValue(undefined);
  mockScenarioStartSession.mockResolvedValue({
    ...transactionSession,
    withTransaction,
    endSession,
  });
  return { withTransaction, endSession };
}

function arrangeLinkedReads(params: {
  existingParentRecords: Array<Record<string, unknown>>;
  existingChildRecords?: Array<Record<string, unknown>>;
}) {
  const childRecords =
    params.existingChildRecords ?? params.existingParentRecords;
  mockLinkedConditionFind.mockImplementation(
    (query: Record<string, unknown>) => {
      if (query.childScenarioId === "parent-1") {
        return chainLeanQuery([]);
      }
      if ("parentRefs.parentScenarioId" in query) {
        return chainLeanQuery(params.existingParentRecords);
      }
      return chainLeanQuery(childRecords);
    }
  );
}

function arrangeScenarioReads(parentScenarios: Array<Record<string, unknown>>) {
  mockScenarioFind.mockImplementation((query: Record<string, unknown>) => {
    const ids = (query._id as { $in?: string[] } | undefined)?.$in ?? [];
    const scenarios = [...parentScenarios, childScenario].filter(
      (scenario, index, all) =>
        ids.includes(String(scenario._id)) &&
        all.findIndex(candidate => candidate._id === scenario._id) === index
    );
    return chainLeanQuery(scenarios);
  });
  mockScenarioFindOne.mockImplementation(({ _id }: { _id: string }) =>
    chainLeanQuery(
      _id === "child-1"
        ? childScenario
        : (parentScenarios.find(scenario => scenario._id === _id) ?? null)
    )
  );
}

describe("linked-condition parent write fence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    arrangeTransaction();
    mockScenarioUpdateOne.mockResolvedValue({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
    });
    mockLinkedConditionUpdateOne.mockResolvedValue({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
    });
    mockLinkedConditionDeleteOne.mockResolvedValue({
      acknowledged: true,
      deletedCount: 1,
    });
  });

  it("rejects a paused stale parent upsert after routing conversion without writing the linked record", async () => {
    const savedParent = parentScenarioWithLink();
    const convertedParent = {
      ...parentScenarioWithLink(convertedRevision),
      __v: 8,
    };
    const record = linkedRecord([otherParentRef]);

    arrangeLinkedReads({
      existingParentRecords: [],
      existingChildRecords: [record],
    });
    arrangeScenarioReads([convertedParent, otherParentScenario]);
    mockLinkedConditionFindOne.mockReturnValue(chainLeanQuery(record));

    await expect(
      syncScenarioLinkedConditions({
        workspaceId: "workspace-1",
        scenarioId: "parent-1",
        scenario: savedParent,
      })
    ).rejects.toThrow(LINKED_CONDITION_ERROR_CODES.revisionConflict);

    expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
    expect(mockLinkedConditionUpdateOne).not.toHaveBeenCalled();
  });

  it("upserts parent refs only after touching the expected Scenario revision in the same transaction", async () => {
    const parent = parentScenarioWithLink();
    const record = linkedRecord([otherParentRef]);

    arrangeLinkedReads({
      existingParentRecords: [],
      existingChildRecords: [record],
    });
    arrangeScenarioReads([parent, otherParentScenario]);
    mockLinkedConditionFindOne.mockReturnValue(chainLeanQuery(record));

    await syncScenarioLinkedConditions({
      workspaceId: "workspace-1",
      scenarioId: "parent-1",
      scenario: parent,
    });

    expect(mockScenarioUpdateOne).toHaveBeenCalledWith(
      {
        _id: "parent-1",
        workspaceId: "workspace-1",
        deletedAt: null,
        updatedAt: expectedRevision,
        __v: 7,
      },
      { $inc: { __v: 1 } },
      {
        session: expect.objectContaining(transactionSession),
        timestamps: false,
      }
    );
    expect(mockLinkedConditionUpdateOne).toHaveBeenCalledWith(
      {
        _id: "record-1",
        workspaceId: "workspace-1",
        __v: 3,
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          parentRefs: [parentRef, otherParentRef],
          updatedAt: expect.any(Date),
        }),
        $inc: { __v: 1 },
      }),
      {
        upsert: false,
        session: expect.objectContaining(transactionSession),
        timestamps: false,
      }
    );
  });

  it("creates a missing linked record with explicit timestamps and versioning", async () => {
    const parent = parentScenarioWithLink();
    arrangeLinkedReads({
      existingParentRecords: [],
      existingChildRecords: [],
    });
    arrangeScenarioReads([parent]);
    mockLinkedConditionUpdateOne.mockResolvedValueOnce({
      acknowledged: true,
      matchedCount: 0,
      modifiedCount: 0,
      upsertedCount: 1,
    });

    await syncScenarioLinkedConditions({
      workspaceId: "workspace-1",
      scenarioId: "parent-1",
      scenario: parent,
    });

    expect(mockLinkedConditionUpdateOne).toHaveBeenCalledWith(
      {
        _id: expect.any(String),
        workspaceId: "workspace-1",
        __v: { $exists: false },
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          workspaceId: "workspace-1",
          childScenarioId: "child-1",
          updatedAt: expect.any(Date),
        }),
        $setOnInsert: { createdAt: expect.any(Date) },
        $inc: { __v: 1 },
      }),
      {
        upsert: true,
        session: expect.objectContaining(transactionSession),
        timestamps: false,
      }
    );
  });

  it("locks the shared child Scenario and preserves both first-time parents after a transaction retry", async () => {
    const firstParent = parentScenarioWithLink();
    const secondParent = otherParentScenario;
    const sharedChild = {
      ...childScenario,
      __v: 2,
      workspaceId: "workspace-1",
    };
    const recordFromConcurrentParent = linkedRecord([parentRef]);
    let attempt = 0;
    const withTransaction = jest.fn(async callback => {
      attempt += 1;
      try {
        return await callback();
      } catch (error) {
        if (attempt !== 1) throw error;
        return callback();
      }
    });
    mockScenarioStartSession.mockResolvedValue({
      ...transactionSession,
      withTransaction,
      endSession: jest.fn().mockResolvedValue(undefined),
    });
    mockLinkedConditionFind
      .mockReturnValueOnce(chainLeanQuery([]))
      .mockReturnValueOnce(chainLeanQuery([recordFromConcurrentParent]));
    mockScenarioFind
      .mockReturnValueOnce(chainLeanQuery([sharedChild, secondParent]))
      .mockReturnValueOnce(
        chainLeanQuery([sharedChild, firstParent, secondParent])
      );
    let childFenceWrites = 0;
    mockScenarioUpdateOne.mockImplementation(async filter => {
      if (filter._id === "child-1") {
        childFenceWrites += 1;
        if (childFenceWrites === 1) {
          return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
        }
      }
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    });

    const result = await reconcileLinkedConditionRecordWithParentFence({
      workspaceId: "workspace-1",
      childScenarioId: "child-1",
      preferredRecord: {
        recordId: "record-2",
        childTriggerNodeId: "trigger-1",
      },
      expectedParent: {
        parentScenarioId: "parent-2",
        updatedAt: expectedRevision,
      },
    });

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(mockScenarioFind).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-1",
      _id: { $in: ["child-1", "parent-2"] },
    });
    expect(mockScenarioFind).toHaveBeenNthCalledWith(2, {
      workspaceId: "workspace-1",
      _id: { $in: ["child-1", "parent-1", "parent-2"] },
    });
    expect(mockScenarioUpdateOne.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            _id: "child-1",
            workspaceId: "workspace-1",
            __v: 2,
          }),
          { $inc: { __v: 1 } },
          expect.objectContaining({ timestamps: false }),
        ],
      ])
    );
    expect(result?.parentRefs).toEqual([parentRef, otherParentRef]);
    expect(childFenceWrites).toBe(2);
    expect(mockLinkedConditionUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockLinkedConditionUpdateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ _id: "record-1", __v: 3 }),
      expect.objectContaining({
        $set: expect.objectContaining({
          parentRefs: [parentRef, otherParentRef],
        }),
      }),
      expect.objectContaining({ upsert: false, timestamps: false })
    );
  });

  it("updates a shared linked record transactionally when the parent removes its refs", async () => {
    const parent = {
      _id: "parent-1",
      __v: 7,
      workspaceId: "workspace-1",
      updatedAt: expectedRevision,
      nodes: [],
      edges: [],
    };
    const record = linkedRecord([parentRef, otherParentRef]);

    arrangeLinkedReads({ existingParentRecords: [record] });
    arrangeScenarioReads([parent, otherParentScenario]);
    mockLinkedConditionFindOne.mockReturnValue(chainLeanQuery(record));

    await syncScenarioLinkedConditions({
      workspaceId: "workspace-1",
      scenarioId: "parent-1",
      scenario: parent,
    });

    expect(mockLinkedConditionUpdateOne).toHaveBeenCalledWith(
      {
        _id: "record-1",
        workspaceId: "workspace-1",
        __v: 3,
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          parentRefs: [otherParentRef],
          updatedAt: expect.any(Date),
        }),
        $inc: { __v: 1 },
      }),
      expect.objectContaining({
        session: expect.objectContaining(transactionSession),
        timestamps: false,
        upsert: false,
      })
    );
    expect(mockLinkedConditionDeleteOne).not.toHaveBeenCalled();
  });

  it("deletes the linked record transactionally when the parent removes its final ref", async () => {
    const parent = {
      _id: "parent-1",
      __v: 7,
      workspaceId: "workspace-1",
      updatedAt: expectedRevision,
      nodes: [],
      edges: [],
    };
    const record = linkedRecord([parentRef]);

    arrangeLinkedReads({ existingParentRecords: [record] });
    arrangeScenarioReads([parent]);
    mockScenarioFindOne.mockImplementation(({ _id }: { _id: string }) =>
      chainLeanQuery(
        _id === "parent-1"
          ? parent
          : {
              ...childScenario,
              nodes: [{ id: "trigger-1", data: { kind: "trigger" } }],
            }
      )
    );
    mockLinkedConditionFindOne.mockReturnValue(chainLeanQuery(record));

    await syncScenarioLinkedConditions({
      workspaceId: "workspace-1",
      scenarioId: "parent-1",
      scenario: parent,
    });

    expect(mockLinkedConditionDeleteOne).toHaveBeenCalledWith(
      {
        _id: "record-1",
        workspaceId: "workspace-1",
        __v: 3,
      },
      { session: expect.objectContaining(transactionSession) }
    );
    expect(mockLinkedConditionUpdateOne).not.toHaveBeenCalled();
  });

  it("rebuilds a paused duplicate-record merge from the converted parent graph", async () => {
    const convertedParent = parentScenarioWithLink(convertedRevision);
    const staleRef = {
      ...parentRef,
      conditionNodeId: "legacy-condition-1",
    };
    const canonical = linkedRecord([staleRef]);
    const duplicate = {
      ...linkedRecord([staleRef]),
      _id: "record-2",
      __v: 5,
    };

    mockLinkedConditionFind.mockReturnValue(
      chainLeanQuery([canonical, duplicate])
    );
    arrangeScenarioReads([convertedParent]);

    await dedupeLinkedConditionRecords({
      workspaceId: "workspace-1",
      childScenario,
      records: [canonical, duplicate],
    });

    expect(mockLinkedConditionUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "record-1", __v: 3 }),
      expect.objectContaining({
        $set: expect.objectContaining({
          parentRefs: [parentRef],
        }),
        $inc: { __v: 1 },
      }),
      expect.objectContaining({
        session: expect.objectContaining(transactionSession),
        timestamps: false,
        upsert: false,
      })
    );
    expect(mockLinkedConditionDeleteOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "record-2", __v: 5 }),
      { session: expect.objectContaining(transactionSession) }
    );
  });
});
