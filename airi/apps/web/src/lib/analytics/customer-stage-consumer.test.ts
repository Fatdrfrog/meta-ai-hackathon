jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
import {
  materializeCustomerStageEvent,
  processCustomerStageChange,
  rebuildCustomerStageSnapshots,
  watchCustomerStageTransitions,
} from "./customer-stage-consumer";
import CustomerEvent from "@/models/customer-event";
import Customer from "@/models/customer";
import {
  AnalyticsCustomerStageCheckpoint,
  AnalyticsServiceLifecycleCheckpoint,
} from "@/models/analytics-service-lifecycle";
import { advanceServiceLifecycleCheckpoint } from "./service-lifecycle-consumer";
import {
  buildCustomerStageTransition,
  decodeCustomerStageEnvelope,
} from "./customer-stage-transition";
const event = buildCustomerStageTransition({
  before: { currentFunnelStage: "proposal", crm_stage_revision: 2 },
  after: {
    _id: "66b8db4b52ca2cbd68b79312",
    workspaceId: "w",
    currentFunnelStage: "qualified",
  },
  now: new Date("2026-10-02T00:00:00Z"),
  eventId: "event-3",
})!.crm_stage_event;

test("rapid repeat visits get distinct transition identities and scalar timestamps revive", () => {
  const decoded = decodeCustomerStageEnvelope(JSON.stringify(event));
  expect(decoded).toEqual(event);
  expect(
    buildCustomerStageTransition({
      before: { currentFunnelStage: "qualified" },
      after: {
        _id: event.customerId,
        workspaceId: "w",
        currentFunnelStage: "qualified",
      },
      now: new Date(),
      eventId: "noop",
    })
  ).toBeNull();
});
test("uses exact change event and persists before resume checkpoint", async () => {
  const order: string[] = [];
  const persistEvent = jest.fn(async () => {
    order.push("event");
    return null;
  });
  await processCustomerStageChange({
    workspaceId: "w",
    change: {
      _id: { token: "one" },
      operationType: "update",
      updateDescription: {
        updatedFields: { crm_stage_event: JSON.stringify(event) },
      },
      fullDocument: { crm_stage_event: { ...event, eventId: "racing-newer" } },
    },
    persistEvent,
    checkpoint: async () => {
      order.push("checkpoint");
    },
  });
  expect(order).toEqual(["event", "checkpoint"]);
  expect(persistEvent).toHaveBeenCalledWith(event, "change_stream");
});
test("failed CustomerEvent persistence never advances the token", async () => {
  const checkpoint = jest.fn();
  await expect(
    processCustomerStageChange({
      workspaceId: "w",
      change: {
        _id: {},
        operationType: "insert",
        fullDocument: { crm_stage_event: event },
      },
      persistEvent: async () => {
        throw new Error("storage unavailable");
      },
      checkpoint,
    })
  ).rejects.toThrow("storage unavailable");
  expect(checkpoint).not.toHaveBeenCalled();
});
test("the shared stage stream keeps the original tenant on persisted CustomerEvent evidence", async () => {
  const persistEvent = jest.fn();
  const tenantEvent = {
    ...event,
    workspaceId: "f8d81838-7ce8-4d17-8c8c-350134e5b9aa",
  };
  await processCustomerStageChange({
    workspaceId: "__analytics_all_workspaces__",
    change: {
      _id: {},
      operationType: "insert",
      fullDocument: { crm_stage_event: tenantEvent },
    },
    persistEvent,
    checkpoint: jest.fn(),
  });
  expect(persistEvent).toHaveBeenCalledWith(tenantEvent, "change_stream");
});

test("unsupported source envelopes fail visibly before a resume checkpoint can skip them", async () => {
  const checkpoint = jest.fn();
  await expect(
    processCustomerStageChange({
      workspaceId: "w",
      change: {
        _id: {},
        operationType: "insert",
        fullDocument: { crm_stage_event: { ...event, contractVersion: 2 } },
      },
      checkpoint,
    })
  ).rejects.toThrow("Invalid customer stage envelope");
  expect(checkpoint).not.toHaveBeenCalled();
});
test("a malformed shared stage envelope degrades coverage before token advance and cannot invent a tenant", async () => {
  const order: string[] = [],
    persistEvent = jest.fn();
  let cause: unknown;
  await processCustomerStageChange({
    workspaceId: "__analytics_all_workspaces__",
    change: {
      _id: {},
      operationType: "insert",
      fullDocument: { crm_stage_event: { ...event, contractVersion: 2 } },
    },
    persistEvent,
    invalidEvent: async error => {
      cause = error;
      order.push("gap");
    },
    checkpoint: async () => {
      order.push("token");
    },
  });
  expect(order).toEqual(["gap", "token"]);
  expect(persistEvent).not.toHaveBeenCalled();
  expect(cause).toEqual(new Error("Invalid customer stage envelope"));
});

test.each([
  ["a default customer insert", "insert"],
  ["a full-document replace", "replace"],
] as const)(
  "%s without a stage is not a transition and never marks a shared history gap",
  async (_label, operationType) => {
    const order: string[] = [],
      persistEvent = jest.fn(),
      invalidEvent = jest.fn();
    await processCustomerStageChange({
      workspaceId: "__analytics_all_workspaces__",
      change: {
        _id: { token: "default-insert" },
        operationType,
        fullDocument: {
          workspaceId: "f8d81838-7ce8-4d17-8c8c-350134e5b9aa",
          crm_stage_event: null,
          crm_stage_event_key: null,
        },
      },
      persistEvent,
      invalidEvent,
      checkpoint: async token => {
        order.push(`token:${String(token.token)}`);
      },
    });
    expect(order).toEqual(["token:default-insert"]);
    expect(invalidEvent).not.toHaveBeenCalled();
    expect(persistEvent).not.toHaveBeenCalled();
  }
);

test("the shared stage stream admits only string event keys and advances past a stage-less insert", async () => {
  const state: Record<string, unknown> = {
    workspaceId: "__analytics_all_workspaces__",
    historyState: "since_activation",
    startAtOperationTime: { t: 1 },
  };
  const acquire = jest
    .spyOn(AnalyticsCustomerStageCheckpoint, "findOneAndUpdate")
    .mockReturnValue({
      lean: jest.fn().mockResolvedValue({ fence: 3 }),
    } as never);
  const upsert = jest
    .spyOn(AnalyticsCustomerStageCheckpoint, "updateOne")
    .mockImplementation(((_filter: unknown, update: { $set?: object }) => {
      Object.assign(state, update.$set);
      return Promise.resolve({ matchedCount: 1 });
    }) as never);
  const read = jest
    .spyOn(AnalyticsCustomerStageCheckpoint, "findOne")
    .mockReturnValue({ lean: jest.fn().mockResolvedValue(state) } as never);
  const stream = {
    tryNext: jest.fn().mockResolvedValueOnce({
      _id: { token: "after-default-insert" },
      operationType: "insert",
      documentKey: { _id: "66b8db4b52ca2cbd68b79399" },
      fullDocument: { crm_stage_event: null, crm_stage_event_key: null },
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const watch = jest
    .spyOn(Customer.collection, "watch")
    .mockReturnValue(stream as never);
  const logger = { error: jest.fn() };
  try {
    await expect(
      watchCustomerStageTransitions({
        workspaceId: "__analytics_all_workspaces__",
        maxEvents: 1,
        logger,
      })
    ).resolves.toEqual({ status: "stopped", processed: 1 });
    expect(watch.mock.calls[0][0]).toEqual([
      {
        $match: {
          $or: [
            {
              operationType: { $in: ["insert", "replace"] },
              "fullDocument.crm_stage_event_key": { $type: "string" },
            },
            {
              operationType: "update",
              "updateDescription.updatedFields.crm_stage_event_key": {
                $type: "string",
              },
            },
          ],
        },
      },
    ]);
    expect(state).toMatchObject({
      historyState: "since_activation",
      resumeToken: { token: "after-default-insert" },
    });
    expect(state.historyGapAt).toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
  } finally {
    acquire.mockRestore();
    upsert.mockRestore();
    read.mockRestore();
    watch.mockRestore();
  }
});

test("a malformed shared stage event logs its sanitized cause and source document", async () => {
  const state: Record<string, unknown> = {
    workspaceId: "__analytics_all_workspaces__",
    historyState: "since_activation",
    resumeToken: { token: "before" },
  };
  const acquire = jest
    .spyOn(AnalyticsCustomerStageCheckpoint, "findOneAndUpdate")
    .mockReturnValue({
      lean: jest.fn().mockResolvedValue({ fence: 4 }),
    } as never);
  const write = jest
    .spyOn(AnalyticsCustomerStageCheckpoint, "updateOne")
    .mockImplementation(((_filter: unknown, update: { $set?: object }) => {
      Object.assign(state, update.$set);
      return Promise.resolve({ matchedCount: 1 });
    }) as never);
  const read = jest
    .spyOn(AnalyticsCustomerStageCheckpoint, "findOne")
    .mockReturnValue({ lean: jest.fn().mockResolvedValue(state) } as never);
  const stream = {
    tryNext: jest.fn().mockResolvedValueOnce({
      _id: { token: "malformed" },
      operationType: "update",
      documentKey: { _id: "66b8db4b52ca2cbd68b79312" },
      updateDescription: {
        updatedFields: {
          crm_stage_event: JSON.stringify({ ...event, contractVersion: 2 }),
          crm_stage_event_key: "w:event-3",
        },
      },
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const watch = jest
    .spyOn(Customer.collection, "watch")
    .mockReturnValue(stream as never);
  const logger = { error: jest.fn() };
  try {
    await watchCustomerStageTransitions({
      workspaceId: "__analytics_all_workspaces__",
      maxEvents: 1,
      logger,
    });
    expect(logger.error).toHaveBeenCalledWith(
      "analytics.projection_degraded",
      { name: "Error", message: "Invalid customer stage envelope" },
      {
        phase: "customer_stage",
        reason: "invalid_source_event",
        operationType: "update",
        documentId: "66b8db4b52ca2cbd68b79312",
      }
    );
    expect(state).toMatchObject({
      historyState: "history_gap",
      gapReason: "invalid_source_event",
      resumeToken: { token: "malformed" },
    });
  } finally {
    acquire.mockRestore();
    write.mockRestore();
    read.mockRestore();
    watch.mockRestore();
  }
});

test("snapshot recovery cannot borrow another source's lease", async () => {
  await expect(
    rebuildCustomerStageSnapshots({
      workspaceId: "w",
      lease: { workspaceId: "w", owner: "service-worker", fence: 1 },
    })
  ).rejects.toThrow("matching source lease");
});
test("materializes the canonical CustomerEvent once by event identity", async () => {
  const write = jest
    .spyOn(CustomerEvent, "findOneAndUpdate")
    .mockResolvedValue(null as never);
  try {
    await materializeCustomerStageEvent(event, "change_stream");
    expect(write).toHaveBeenCalledWith(
      { workspaceId: "w", idempotencyKey: "customer-stage:event-3" },
      {
        $setOnInsert: expect.objectContaining({
          occurredAt: event.occurredAt,
          type: "stage_changed",
          payload: expect.objectContaining({
            stage: "qualified",
            previousStage: "proposal",
            stageEventId: "event-3",
          }),
        }),
      },
      { upsert: true, new: true }
    );
  } finally {
    write.mockRestore();
  }
});
test("stage source fencing uses isolated cursor state and cannot advance a stale holder", async () => {
  const stage = jest
    .spyOn(AnalyticsCustomerStageCheckpoint, "updateOne")
    .mockResolvedValue({ matchedCount: 0 } as never);
  const service = jest.spyOn(AnalyticsServiceLifecycleCheckpoint, "updateOne");
  try {
    await expect(
      advanceServiceLifecycleCheckpoint(
        { workspaceId: "w", source: "customer_stage", owner: "old", fence: 1 },
        { $set: { resumeToken: {} } }
      )
    ).rejects.toThrow("lease");
    expect(stage).toHaveBeenCalled();
    expect(service).not.toHaveBeenCalled();
  } finally {
    stage.mockRestore();
    service.mockRestore();
  }
});
