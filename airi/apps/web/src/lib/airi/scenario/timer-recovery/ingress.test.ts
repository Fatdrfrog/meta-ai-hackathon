const mockConnectDb = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockFindOneLean = jest.fn();
const mockFindOneSession = jest.fn();
const mockUpdateOne = jest.fn();
const mockUpdateMany = jest.fn();
const mockFindLean = jest.fn();
const mockFindSort = jest.fn();
const mockReplanRemappedPostActionTimer = jest.fn();
const mockListIndexesToArray = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDb(...args),
}));

jest.mock("@/models/airi-turn-context", () => ({
  ...jest.requireActual("@/models/airi-turn-context"),
  __esModule: true,
  default: {
    collection: {
      listIndexes: () => ({ toArray: () => mockListIndexesToArray() }),
    },
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
    findOne: (...args: unknown[]) => {
      const query = {
        lean: () => mockFindOneLean(...args),
        session: (session: unknown) => {
          mockFindOneSession(session);
          return query;
        },
      };
      return query;
    },
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
    updateMany: (...args: unknown[]) => mockUpdateMany(...args),
    find: (...args: unknown[]) => {
      const query = {
        hint: () => query,
        select: () => query,
        sort: (...sortArgs: unknown[]) => {
          mockFindSort(...sortArgs);
          return query;
        },
        limit: () => query,
        lean: () => mockFindLean(...args),
      };
      return query;
    },
  },
}));

jest.mock("@/lib/airi/scenario/timer-recovery/recover", () => ({
  replanRemappedPostActionTimer: (...args: unknown[]) =>
    mockReplanRemappedPostActionTimer(...args),
}));

import {
  enqueueTimerReplanIngress,
  assertTimerReplanIngressIndexes,
  listOutstandingTimerReplanIngressForScenario,
  processTimerReplanIngressKeys,
  processTimerReplanIngressQueue,
  retryTimerReplanIngressForScenario,
} from "./ingress";

const now = new Date("2026-08-06T08:00:00.000Z");
const session = { id: "session-1" } as never;

function createClaimedIngress(overrides: Record<string, unknown> = {}) {
  return {
    _id: "ingress-1",
    ingressKey: "timer-replan-ingress:stable",
    ingressStatus: "pending",
    ingressAttempts: 1,
    ingressLeaseToken: "lease-from-update",
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    messageId: "timer-replan:scenario-1:action-1:message-out-1",
    triggerEventKind: "timer_replan",
    timerReplanIngress: {
      expectedScenarioId: "scenario-1",
      expectedConditionNodeId: "condition-virtual-1",
      expectedSourceActionNodeId: "action-1",
      anchorId: "message-out-1",
      messageDate: new Date("2026-08-06T07:59:00.000Z"),
      enqueuedAt: new Date("2026-08-06T07:59:01.000Z"),
    },
    ...overrides,
  };
}

describe("timer replan ingress", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDb.mockResolvedValue(undefined);
    mockUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    mockFindOneLean.mockResolvedValue(null);
    mockUpdateMany.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    mockFindLean.mockResolvedValue([]);
    mockListIndexesToArray.mockResolvedValue([
      {
        name: "airi_timer_replan_ingress_unique",
        key: { ingressKey: 1 },
        unique: true,
        partialFilterExpression: {
          ingressKey: { $type: "string" },
        },
      },
      {
        name: "airi_timer_replan_ingress_queue",
        key: {
          ingressStatus: 1,
          ingressNextRetryAt: 1,
          ingressLeaseExpiresAt: 1,
          _id: 1,
        },
        partialFilterExpression: {
          triggerEventKind: "timer_replan",
          ingressStatus: "pending",
        },
      },
      {
        name: "airi_timer_replan_ingress_scenario_status",
        key: {
          workspaceId: 1,
          "timerReplanIngress.expectedScenarioId": 1,
          ingressStatus: 1,
          updatedAt: -1,
          _id: 1,
        },
        partialFilterExpression: {
          triggerEventKind: "timer_replan",
          "timerReplanIngress.expectedScenarioId": { $type: "string" },
        },
      },
    ]);
  });

  it("fails closed unless all exact idempotency and queue indexes are deployed", async () => {
    await expect(assertTimerReplanIngressIndexes()).resolves.toBeUndefined();

    mockListIndexesToArray.mockResolvedValueOnce([
      {
        name: "airi_timer_replan_ingress_queue",
        key: {
          ingressStatus: 1,
          ingressNextRetryAt: 1,
          ingressLeaseExpiresAt: 1,
          _id: 1,
        },
        partialFilterExpression: {
          triggerEventKind: "timer_replan",
          ingressStatus: "pending",
        },
      },
      {
        name: "airi_timer_replan_ingress_scenario_status",
        key: {
          workspaceId: 1,
          "timerReplanIngress.expectedScenarioId": 1,
          ingressStatus: 1,
          updatedAt: -1,
          _id: 1,
        },
        partialFilterExpression: {
          triggerEventKind: "timer_replan",
          "timerReplanIngress.expectedScenarioId": { $type: "string" },
        },
      },
    ]);

    await expect(assertTimerReplanIngressIndexes()).rejects.toMatchObject({
      code: "timer_replan_ingress_indexes_missing",
    });
  });

  it("resolves a concurrent unique-key upsert to the exact ingress in the caller session", async () => {
    mockFindOneAndUpdate.mockRejectedValue({ code: 11000 });
    mockFindOneLean.mockImplementation(() => ({
      ...createClaimedIngress(),
      ...mockFindOneAndUpdate.mock.calls[0][1].$setOnInsert,
      messageId: "timer-replan:scenario-1:action-1:message-out-1",
    }));

    await expect(
      enqueueTimerReplanIngress({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        expectedScenarioId: "scenario-1",
        expectedConditionNodeId: "condition-virtual-1",
        expectedSourceActionNodeId: "action-1",
        anchorId: "message-out-1",
        messageDate: new Date("2026-08-06T07:59:00.000Z"),
        enqueuedAt: now,
        session,
      })
    ).resolves.toMatchObject({
      ingressKey: expect.stringMatching(/^timer-replan-ingress:/),
      messageId: "timer-replan:scenario-1:action-1:message-out-1",
    });
    expect(mockFindOneLean).toHaveBeenCalledWith({
      ingressKey: {
        $eq: expect.stringMatching(/^timer-replan-ingress:/),
        $type: "string",
      },
    });
    expect(mockFindOneSession).toHaveBeenCalledWith(session);
  });

  it("atomically enqueues one deterministic exact timer-replan ingress in the caller transaction", async () => {
    mockFindOneAndUpdate.mockImplementation(
      (_filter: unknown, update: Record<string, Record<string, unknown>>) => ({
        toObject: () => update.$setOnInsert,
      })
    );

    const first = await enqueueTimerReplanIngress({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      expectedScenarioId: "scenario-1",
      expectedConditionNodeId: "condition-virtual-1",
      expectedSourceActionNodeId: "action-1",
      anchorId: "message-out-1",
      messageDate: new Date("2026-08-06T07:59:00.000Z"),
      enqueuedAt: now,
      session,
    });
    const second = await enqueueTimerReplanIngress({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      expectedScenarioId: "scenario-1",
      expectedConditionNodeId: "condition-virtual-1",
      expectedSourceActionNodeId: "action-1",
      anchorId: "message-out-1",
      messageDate: new Date("2026-08-06T07:59:00.000Z"),
      enqueuedAt: new Date("2026-08-06T08:05:00.000Z"),
      session,
    });

    expect(first.ingressKey).toBe(second.ingressKey);
    expect(first.messageId).toBe(
      "timer-replan:scenario-1:action-1:message-out-1"
    );
    expect(first.messageId).toBe(second.messageId);
    expect(first.turnContextId).toBe(second.turnContextId);
    expect(first.ingressKey).toMatch(/^timer-replan-ingress:[a-f0-9]{64}$/);
    expect(mockConnectDb).not.toHaveBeenCalled();
    expect(mockFindOneAndUpdate).toHaveBeenNthCalledWith(
      1,
      { ingressKey: { $eq: first.ingressKey, $type: "string" } },
      {
        $setOnInsert: expect.objectContaining({
          turnContextId: first.turnContextId,
          ingressKey: first.ingressKey,
          ingressStatus: "pending",
          ingressAttempts: 0,
          ingressNextRetryAt: now,
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          messageId: first.messageId,
          triggerEventKind: "timer_replan",
          expiresAt: null,
          timerReplanIngress: {
            expectedScenarioId: "scenario-1",
            expectedConditionNodeId: "condition-virtual-1",
            expectedSourceActionNodeId: "action-1",
            messageDate: new Date("2026-08-06T07:59:00.000Z"),
            enqueuedAt: now,
          },
        }),
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
        session,
      }
    );
  });

  it("signals Temporal with the persisted event identity and closes the claimed lease token-safely", async () => {
    mockFindOneAndUpdate.mockImplementation(
      (_filter: unknown, update: Record<string, Record<string, unknown>>) =>
        createClaimedIngress({
          ingressLeaseToken: update.$set.ingressLeaseToken,
        })
    );
    mockReplanRemappedPostActionTimer.mockResolvedValue({
      conversationId: "conversation-1",
      status: "replanned",
    });

    const result = await processTimerReplanIngressQueue({ limit: 1, now });

    expect(result).toMatchObject({
      claimed: 1,
      signaled: 1,
      retryScheduled: 0,
      failed: 0,
      leaseLost: 0,
    });
    expect(mockReplanRemappedPostActionTimer).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      expectedScenarioId: "scenario-1",
      expectedConditionNodeId: "condition-virtual-1",
      expectedSourceActionNodeId: "action-1",
      apply: true,
      event: {
        messageId: "timer-replan:scenario-1:action-1:message-out-1",
        messageDate: "2026-08-06T07:59:00.000Z",
        enqueuedAt: "2026-08-06T07:59:01.000Z",
      },
    });
    const leaseToken =
      mockFindOneAndUpdate.mock.calls[0][1].$set.ingressLeaseToken;
    expect(mockUpdateOne).toHaveBeenCalledWith(
      {
        _id: "ingress-1",
        ingressStatus: "pending",
        ingressLeaseToken: leaseToken,
      },
      {
        $set: expect.objectContaining({
          ingressStatus: "signaled",
          ingressSignaledAt: now,
          ingressLastError: null,
          "timerReplanIngress.completion": "signaled",
          "timerReplanIngress.completedAt": now,
          expiresAt: new Date("2026-08-13T08:00:00.000Z"),
        }),
        $unset: {
          ingressLeaseToken: "",
          ingressLeaseExpiresAt: "",
          ingressNextRetryAt: "",
        },
      }
    );
  });

  it("processes only the requested ingress keys and returns their outcomes", async () => {
    mockFindOneAndUpdate.mockImplementation(
      (_filter: unknown, update: Record<string, Record<string, unknown>>) =>
        createClaimedIngress({
          ingressLeaseToken: update.$set.ingressLeaseToken,
        })
    );
    mockReplanRemappedPostActionTimer.mockResolvedValue({
      conversationId: "conversation-1",
      status: "replanned",
    });

    const result = await processTimerReplanIngressKeys({
      ingressKeys: ["timer-replan-ingress:stable"],
      now,
    });

    expect(result).toEqual({
      summary: {
        claimed: 1,
        signaled: 1,
        retryScheduled: 0,
        failed: 0,
        superseded: 0,
        leaseLost: 0,
      },
      results: [
        {
          ingressKey: "timer-replan-ingress:stable",
          conversationId: "conversation-1",
          status: "signaled",
        },
      ],
    });
    expect(mockFindOneAndUpdate.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        ingressKey: { $in: ["timer-replan-ingress:stable"], $type: "string" },
      })
    );
    expect(mockFindOneAndUpdate.mock.calls[0][2]).not.toHaveProperty("hint");
  });

  it("returns an exact terminal outcome completed by a concurrent worker", async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockFindLean.mockResolvedValue([
      {
        ingressKey: "timer-replan-ingress:stable",
        conversationId: "conversation-1",
        ingressStatus: "signaled",
        timerReplanIngress: { completion: "superseded" },
      },
    ]);

    const result = await processTimerReplanIngressKeys({
      ingressKeys: ["timer-replan-ingress:stable"],
      now,
    });

    expect(result).toEqual({
      summary: {
        claimed: 0,
        signaled: 0,
        retryScheduled: 0,
        failed: 0,
        superseded: 0,
        leaseLost: 0,
      },
      results: [
        {
          ingressKey: "timer-replan-ingress:stable",
          conversationId: "conversation-1",
          status: "superseded",
        },
      ],
    });
    expect(mockFindLean.mock.calls[0]?.[0]).toEqual({
      triggerEventKind: "timer_replan",
      ingressKey: { $in: ["timer-replan-ingress:stable"], $type: "string" },
      ingressStatus: { $in: ["signaled", "failed"] },
    });
  });

  it("keeps a transient Temporal failure durable with bounded backoff", async () => {
    mockFindOneAndUpdate.mockImplementation(
      (_filter: unknown, update: Record<string, Record<string, unknown>>) =>
        createClaimedIngress({
          ingressLeaseToken: update.$set.ingressLeaseToken,
          ingressAttempts: 1,
        })
    );
    mockReplanRemappedPostActionTimer.mockRejectedValue(
      new Error("Temporal unavailable")
    );

    const result = await processTimerReplanIngressQueue({ limit: 1, now });

    expect(result).toMatchObject({
      claimed: 1,
      signaled: 0,
      retryScheduled: 1,
      failed: 0,
    });
    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ ingressLeaseToken: expect.any(String) }),
      {
        $set: {
          ingressStatus: "pending",
          ingressLastError: "Temporal unavailable",
          ingressNextRetryAt: new Date("2026-08-06T08:00:30.000Z"),
        },
        $unset: {
          ingressLeaseToken: "",
          ingressLeaseExpiresAt: "",
        },
      }
    );
  });

  it("stops retrying after the bounded attempt budget", async () => {
    mockFindOneAndUpdate.mockImplementation(
      (_filter: unknown, update: Record<string, Record<string, unknown>>) =>
        createClaimedIngress({
          ingressLeaseToken: update.$set.ingressLeaseToken,
          ingressAttempts: 5,
        })
    );
    mockReplanRemappedPostActionTimer.mockRejectedValue(
      new Error("Temporal unavailable")
    );

    const result = await processTimerReplanIngressQueue({ limit: 1, now });

    expect(result).toMatchObject({
      claimed: 1,
      retryScheduled: 0,
      failed: 1,
    });
    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ ingressLeaseToken: expect.any(String) }),
      {
        $set: {
          ingressStatus: "failed",
          ingressLastError: "Temporal unavailable",
        },
        $unset: {
          ingressLeaseToken: "",
          ingressLeaseExpiresAt: "",
          ingressNextRetryAt: "",
          expiresAt: "",
        },
      }
    );
  });

  it("lists persistent pending and failed recovery state for scenario detail responses", async () => {
    mockFindLean.mockResolvedValue([
      {
        conversationId: "conversation-pending",
        ingressStatus: "pending",
      },
      {
        conversationId: "conversation-failed",
        ingressStatus: "failed",
      },
      {
        conversationId: "conversation-pending",
        ingressStatus: "failed",
      },
    ]);

    const result = await listOutstandingTimerReplanIngressForScenario({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      limit: 25,
    });

    expect(result).toEqual({
      status: "failed",
      affectedConversationIds: ["conversation-failed", "conversation-pending"],
      hasMore: false,
    });
    expect(mockFindSort).toHaveBeenCalledWith({
      ingressStatus: 1,
      updatedAt: -1,
      _id: 1,
    });
  });

  it("completes a recovery as superseded when the exact pending state already changed", async () => {
    mockFindOneAndUpdate.mockImplementation(
      (_filter: unknown, update: Record<string, Record<string, unknown>>) =>
        createClaimedIngress({
          ingressLeaseToken: update.$set.ingressLeaseToken,
        })
    );
    mockReplanRemappedPostActionTimer.mockResolvedValue({
      conversationId: "conversation-1",
      status: "conflict",
      reason: "conversation_state_changed",
    });

    const result = await processTimerReplanIngressQueue({ limit: 1, now });

    expect(result).toMatchObject({ claimed: 1, signaled: 0, superseded: 1 });
    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ ingressLeaseToken: expect.any(String) }),
      {
        $set: expect.objectContaining({
          ingressStatus: "signaled",
          "timerReplanIngress.completion": "superseded",
          "timerReplanIngress.completedAt": now,
          expiresAt: new Date("2026-08-13T08:00:00.000Z"),
        }),
        $unset: {
          ingressLeaseToken: "",
          ingressLeaseExpiresAt: "",
          ingressNextRetryAt: "",
        },
      }
    );
  });

  it("reopens terminal records for an explicit bounded retry before running the shared processor", async () => {
    mockUpdateMany.mockResolvedValue({ matchedCount: 2, modifiedCount: 2 });
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockFindLean
      .mockResolvedValueOnce([{ _id: "failed-1" }, { _id: "failed-2" }])
      .mockResolvedValueOnce([]);

    const result = await retryTimerReplanIngressForScenario({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      limit: 10,
      now,
    });

    expect(mockUpdateMany).toHaveBeenCalledWith(
      { _id: { $in: ["failed-1", "failed-2"] }, ingressStatus: "failed" },
      {
        $set: {
          ingressStatus: "pending",
          ingressAttempts: 0,
          ingressLastError: null,
          ingressNextRetryAt: now,
          expiresAt: null,
        },
        $unset: {
          ingressLeaseToken: "",
          ingressLeaseExpiresAt: "",
        },
      }
    );
    expect(result).toMatchObject({
      reopened: 2,
      processed: {
        claimed: 0,
        signaled: 0,
        retryScheduled: 0,
        failed: 0,
      },
      outstanding: {
        status: null,
        affectedConversationIds: [],
      },
    });
  });
});
