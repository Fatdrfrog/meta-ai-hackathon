jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
import {
  processServiceLifecycleChange,
  isServiceLifecycleHistoryLost,
  advanceServiceLifecycleCheckpoint,
  watchServiceLifecycle,
  readServiceLifecycleCoverage,
  rebuildAnalyticsTransitionSnapshots,
  analyticsTransitionMatch,
  ANALYTICS_GLOBAL_CHECKPOINT,
} from "./service-lifecycle-consumer";
import { AnalyticsServiceLifecycleCheckpoint } from "@/models/analytics-service-lifecycle";
import { Conversation } from "@/models/conversation";
import mongoose from "mongoose";
const envelope = {
  contractVersion: 1,
  eventId: "event-1",
  revision: 1,
  occurredAt: new Date("2026-10-01T10:00:00Z"),
  workspaceId: "w",
  conversationId: "chat",
  customerId: null,
  sourceId: "s",
  channel: "whatsapp",
  kinds: ["resolved"],
  previousStatus: "open",
  status: "closed",
  previousHandoffActive: false,
  handoffActive: false,
  handoffStartedAt: null,
  episodeStartedAt: new Date("2026-10-01T09:00:00Z"),
  closedAt: new Date("2026-10-01T10:00:00Z"),
  resolvedAt: new Date("2026-10-01T10:00:00Z"),
  resolutionKind: "manager",
};
test("persists immutable event evidence before checkpoint and uses the event update value", async () => {
  const calls: string[] = [];
  const persistFact = jest.fn(async () => {
    calls.push("fact");
  });
  const checkpoint = jest.fn(async () => {
    calls.push("checkpoint");
  });
  await processServiceLifecycleChange({
    workspaceId: "w",
    change: {
      _id: { token: "one" },
      operationType: "update",
      updateDescription: {
        updatedFields: { service_lifecycle_event: JSON.stringify(envelope) },
      },
      fullDocument: {
        service_lifecycle_event: { ...envelope, eventId: "newer-racing-value" },
      },
    },
    persistFact,
    checkpoint,
  });
  expect(calls).toEqual(["fact", "checkpoint"]);
  expect(persistFact).toHaveBeenCalledWith(envelope, "change_stream");
  expect(checkpoint).toHaveBeenCalledWith({ token: "one" });
});
test("failed fact writes never advance the resume token", async () => {
  const checkpoint = jest.fn();
  await expect(
    processServiceLifecycleChange({
      workspaceId: "w",
      change: {
        _id: { token: "one" },
        operationType: "insert",
        fullDocument: { service_lifecycle_event: envelope },
      },
      persistFact: async () => {
        throw new Error("storage unavailable");
      },
      checkpoint,
    })
  ).rejects.toThrow("storage unavailable");
  expect(checkpoint).not.toHaveBeenCalled();
});
test("unrelated updates cannot read a newer full document as a historic event", async () => {
  const persistFact = jest.fn(),
    checkpoint = jest.fn();
  await processServiceLifecycleChange({
    workspaceId: "w",
    change: {
      _id: { token: "one" },
      operationType: "update",
      updateDescription: { updatedFields: { updatedAt: new Date() } },
      fullDocument: { service_lifecycle_event: envelope },
    },
    persistFact,
    checkpoint,
  });
  expect(persistFact).not.toHaveBeenCalled();
  expect(checkpoint).toHaveBeenCalled();
});
test("cross-workspace lifecycle evidence is never persisted into this checkpoint", async () => {
  const persistFact = jest.fn();
  await processServiceLifecycleChange({
    workspaceId: "other",
    change: {
      _id: {},
      operationType: "insert",
      fullDocument: { service_lifecycle_event: envelope },
    },
    persistFact,
    checkpoint: jest.fn(),
  });
  expect(persistFact).not.toHaveBeenCalled();
});
test("the shared stream routes immutable workspace evidence without creating a sentinel fact", async () => {
  const persistFact = jest.fn();
  const tenantEvent = {
    ...envelope,
    workspaceId: "f8d81838-7ce8-4d17-8c8c-350134e5b9aa",
  };
  await processServiceLifecycleChange({
    workspaceId: "__analytics_all_workspaces__",
    change: {
      _id: {},
      operationType: "insert",
      fullDocument: { service_lifecycle_event: tenantEvent },
    },
    persistFact,
    checkpoint: jest.fn(),
  });
  expect(persistFact).toHaveBeenCalledWith(tenantEvent, "change_stream");
});
test("history loss is distinct from an ordinary transient connection error", () => {
  expect(isServiceLifecycleHistoryLost({ code: 286 })).toBe(true);
  expect(
    isServiceLifecycleHistoryLost(new Error("resume token was not found"))
  ).toBe(true);
  expect(isServiceLifecycleHistoryLost(new Error("connection refused"))).toBe(
    false
  );
});
test("invalid shared tenant evidence records an explicit gap before advancing, without a business write", async () => {
  const order: string[] = [],
    persistFact = jest.fn();
  await processServiceLifecycleChange({
    workspaceId: ANALYTICS_GLOBAL_CHECKPOINT,
    change: {
      _id: {},
      operationType: "insert",
      fullDocument: {
        service_lifecycle_event: { ...envelope, workspaceId: "malformed" },
      },
    },
    persistFact,
    invalidEvent: async () => {
      order.push("gap");
    },
    checkpoint: async () => {
      order.push("token");
    },
  });
  expect(order).toEqual(["gap", "token"]);
  expect(persistFact).not.toHaveBeenCalled();
});
test("a shared-stream write without a lifecycle envelope advances the token without a gap", async () => {
  const persistFact = jest.fn(),
    invalidEvent = jest.fn(),
    checkpoint = jest.fn();
  await expect(
    processServiceLifecycleChange({
      workspaceId: ANALYTICS_GLOBAL_CHECKPOINT,
      change: {
        _id: { token: "default-null" },
        operationType: "insert",
        fullDocument: {
          service_lifecycle_event: null,
          service_lifecycle_event_key: null,
        },
      },
      persistFact,
      invalidEvent,
      checkpoint,
    })
  ).resolves.toBe(false);
  expect(checkpoint).toHaveBeenCalledWith({ token: "default-null" });
  expect(invalidEvent).not.toHaveBeenCalled();
  expect(persistFact).not.toHaveBeenCalled();
});
test("shared stream filters match only string event keys; schema-default nulls never reach the consumer", () => {
  for (const eventKeyField of [
    "service_lifecycle_event_key",
    "crm_stage_event_key",
  ]) {
    expect(
      analyticsTransitionMatch(ANALYTICS_GLOBAL_CHECKPOINT, eventKeyField)
    ).toEqual({
      $or: [
        {
          operationType: { $in: ["insert", "replace"] },
          [`fullDocument.${eventKeyField}`]: { $type: "string" },
        },
        {
          operationType: "update",
          [`updateDescription.updatedFields.${eventKeyField}`]: {
            $type: "string",
          },
        },
      ],
    });
  }
  expect(
    analyticsTransitionMatch("tenant.a", "service_lifecycle_event_key")
  ).toEqual({
    $or: [
      {
        operationType: { $in: ["insert", "replace"] },
        "fullDocument.workspaceId": "tenant.a",
      },
      {
        operationType: "update",
        "updateDescription.updatedFields.service_lifecycle_event_key": {
          $regex: "^tenant\\.a:",
        },
      },
    ],
  });
});
test("shutdown stops snapshot recovery between rows and keeps only the persisted prefix", async () => {
  const rows = [1, 2, 3].map(() => ({ _id: new mongoose.Types.ObjectId() }));
  const local: Record<string, unknown> = { snapshotState: "pending" };
  const read = jest
    .spyOn(AnalyticsServiceLifecycleCheckpoint, "findOne")
    .mockImplementation(((filter: { workspaceId: string }) => ({
      lean: jest
        .fn()
        .mockResolvedValue(
          filter.workspaceId === ANALYTICS_GLOBAL_CHECKPOINT ? null : local
        ),
    })) as never);
  const write = jest
    .spyOn(AnalyticsServiceLifecycleCheckpoint, "updateOne")
    .mockImplementation(((
      _filter: unknown,
      update: { $set?: object; $inc?: { snapshotScanned?: number } }
    ) => {
      Object.assign(local, update.$set);
      if (update.$inc) local.snapshotScanned = update.$inc.snapshotScanned;
      return Promise.resolve({ matchedCount: 1 });
    }) as never);
  const abort = new AbortController();
  const persistRow = jest.fn(async () => abort.abort());
  try {
    await expect(
      rebuildAnalyticsTransitionSnapshots({
        workspaceId: "tenant",
        source: "service_lifecycle",
        lease: { workspaceId: "tenant", owner: "sweep", fence: 2 },
        signal: abort.signal,
        loadRows: async () => rows,
        persistRow,
      })
    ).resolves.toEqual({ scanned: 1, complete: false });
    expect(persistRow).toHaveBeenCalledTimes(1);
    expect(local).toMatchObject({
      snapshotState: "running",
      snapshotCursor: rows[0]._id,
      snapshotScanned: 1,
    });
  } finally {
    read.mockRestore();
    write.mockRestore();
  }
});
test("shared stream liveness and activation compose with tenant-local snapshot progress", async () => {
  const global = {
    streamState: "streaming",
    historyState: "since_activation",
    firstObservedAt: new Date("2026-10-02T00:00:00Z"),
    startAtOperationTime: {},
    leaseOwner: "worker",
    leaseExpiresAt: new Date(Date.now() + 30_000),
  };
  const read = jest
    .spyOn(AnalyticsServiceLifecycleCheckpoint, "findOne")
    .mockImplementation(((filter: { workspaceId: string }) => ({
      lean: jest
        .fn()
        .mockResolvedValue(
          filter.workspaceId === ANALYTICS_GLOBAL_CHECKPOINT
            ? global
            : { snapshotState: "complete", snapshotScanned: 23 }
        ),
    })) as never);
  try {
    expect(await readServiceLifecycleCoverage("tenant")).toMatchObject({
      state: "streaming",
      history: "since_activation",
      firstObservedAt: "2026-10-02T00:00:00.000Z",
      snapshotRecovery: "complete",
      snapshotScanned: 23,
    });
    global.leaseExpiresAt = new Date(0);
    expect(await readServiceLifecycleCoverage("tenant")).toMatchObject({
      state: "degraded",
      history: "since_activation",
    });
    global.historyState = "history_gap";
    expect(await readServiceLifecycleCoverage("tenant")).toMatchObject({
      state: "history_gap",
      history: "history_gap",
    });
  } finally {
    read.mockRestore();
  }
});
test("a completed tenant lazily recovers a new global gap once, then retains explicit incomplete history", async () => {
  const local: Record<string, unknown> = {
    snapshotState: "complete",
    snapshotScanned: 20,
    snapshotCursor: new mongoose.Types.ObjectId(),
  };
  const global = {
    historyState: "history_gap",
    historyGapAt: new Date("2026-10-02T00:00:00Z"),
  };
  const read = jest
    .spyOn(AnalyticsServiceLifecycleCheckpoint, "findOne")
    .mockImplementation(((filter: { workspaceId: string }) => ({
      lean: jest
        .fn()
        .mockResolvedValue(
          filter.workspaceId === ANALYTICS_GLOBAL_CHECKPOINT ? global : local
        ),
    })) as never);
  const acquire = jest
    .spyOn(AnalyticsServiceLifecycleCheckpoint, "findOneAndUpdate")
    .mockReturnValue({
      lean: jest.fn().mockResolvedValue({ fence: 1 }),
    } as never);
  const write = jest
    .spyOn(AnalyticsServiceLifecycleCheckpoint, "updateOne")
    .mockImplementation(((
      _filter: unknown,
      update: { $set?: object; $inc?: { snapshotScanned?: number } }
    ) => {
      Object.assign(local, update.$set);
      if (update.$inc?.snapshotScanned)
        local.snapshotScanned =
          Number(local.snapshotScanned) + update.$inc.snapshotScanned;
      return Promise.resolve({ matchedCount: 1 });
    }) as never);
  const page = {
    select: jest.fn(),
    sort: jest.fn(),
    limit: jest.fn(),
    lean: jest.fn().mockResolvedValue([]),
  };
  page.select.mockReturnValue(page);
  page.sort.mockReturnValue(page);
  page.limit.mockReturnValue(page);
  const rows = jest.spyOn(Conversation, "find").mockReturnValue(page as never);
  try {
    expect(await readServiceLifecycleCoverage("tenant")).toMatchObject({
      history: "history_gap",
      snapshotRecovery: "pending",
      snapshotScanned: 0,
    });
    const { rebuildServiceLifecycleSnapshots } = await import(
      "./service-lifecycle-consumer"
    );
    await rebuildServiceLifecycleSnapshots({
      workspaceId: "tenant",
      batchSize: 500,
    });
    await rebuildServiceLifecycleSnapshots({
      workspaceId: "tenant",
      batchSize: 500,
    });
    expect(rows).toHaveBeenCalledTimes(1);
    expect(rows).toHaveBeenCalledWith({ workspaceId: "tenant" });
    expect(page.limit).toHaveBeenCalledWith(501);
    expect(local.snapshotGapAt).toEqual(global.historyGapAt);
    expect(await readServiceLifecycleCoverage("tenant")).toMatchObject({
      history: "history_gap",
      snapshotRecovery: "complete",
    });
    global.historyGapAt = new Date("2026-10-02T01:00:00Z");
    await rebuildServiceLifecycleSnapshots({
      workspaceId: "tenant",
      batchSize: 500,
    });
    expect(rows).toHaveBeenCalledTimes(2);
  } finally {
    read.mockRestore();
    acquire.mockRestore();
    write.mockRestore();
    rows.mockRestore();
  }
});
test("a stale holder cannot advance the token or recovery cursor", async () => {
  const write = jest
    .spyOn(AnalyticsServiceLifecycleCheckpoint, "updateOne")
    .mockResolvedValue({ matchedCount: 0 } as never);
  try {
    await expect(
      advanceServiceLifecycleCheckpoint(
        { workspaceId: "w", owner: "old-worker", fence: 2 },
        { $set: { resumeToken: { token: "older" } } }
      )
    ).rejects.toThrow("lease");
    expect(write.mock.calls[0][0]).toMatchObject({
      workspaceId: "w",
      leaseOwner: "old-worker",
      fence: 2,
      leaseExpiresAt: { $gt: expect.any(Date) },
    });
  } finally {
    write.mockRestore();
  }
});

test("expired resume history records a durable gap and bounded snapshot recovery cannot claim complete history", async () => {
  const state = {
    resumeToken: { token: "expired" },
    snapshotState: "pending",
    snapshotScanned: 0,
    historyState: "since_activation",
  };
  const acquire = jest
    .spyOn(AnalyticsServiceLifecycleCheckpoint, "findOneAndUpdate")
    .mockReturnValue({
      lean: jest.fn().mockResolvedValue({ fence: 7 }),
    } as never);
  const read = jest
    .spyOn(AnalyticsServiceLifecycleCheckpoint, "findOne")
    .mockReturnValue({ lean: jest.fn().mockResolvedValue(state) } as never);
  const write = jest
    .spyOn(AnalyticsServiceLifecycleCheckpoint, "updateOne")
    .mockImplementation(((_filter: unknown, update: { $set?: object }) => {
      Object.assign(state, update.$set);
      return Promise.resolve({ matchedCount: 1 });
    }) as never);
  const stream = {
    tryNext: jest.fn().mockRejectedValue({ code: 286 }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const watch = jest
    .spyOn(Conversation.collection, "watch")
    .mockReturnValue(stream as never);
  const source = {
    select: jest.fn(),
    sort: jest.fn(),
    limit: jest.fn(),
    lean: jest.fn().mockResolvedValue([]),
  };
  source.select.mockReturnValue(source);
  source.sort.mockReturnValue(source);
  source.limit.mockReturnValue(source);
  const snapshot = jest
    .spyOn(Conversation, "find")
    .mockReturnValue(source as never);
  try {
    expect(
      await watchServiceLifecycle({ workspaceId: "w", maxEvents: 1 })
    ).toMatchObject({
      status: "history_gap",
      recovery: { scanned: 0, complete: true },
    });
    expect(state).toMatchObject({
      historyState: "history_gap",
      resumeToken: null,
      snapshotState: "complete",
    });
    expect(source.limit).toHaveBeenCalledWith(501);
    expect(stream.close).toHaveBeenCalled();
  } finally {
    acquire.mockRestore();
    read.mockRestore();
    write.mockRestore();
    watch.mockRestore();
    snapshot.mockRestore();
  }
});
