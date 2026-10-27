import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWhatsAppWebhookDrainFilter,
  buildWhatsAppWebhookExhaustedRetryFilter,
  drainPendingWhatsAppWebhookEventsToTemporal,
  getWhatsAppWebhookDrainOrderingKey,
  isValidWhatsAppWebhookDrainLimit,
  type WhatsAppWebhookDrainEventRecord,
} from "./whatsapp-webhook-drain";
import type { TemporalWorkerConfig } from "../config";

const testConfig: TemporalWorkerConfig = {
  address: "localhost:7233",
  namespace: "default",
  apiKey: null,
  taskQueue: "airi-worker",
  activityQueueClass: "shared",
  tls: false,
  target: "local",
  deploymentName: "test-worker",
  buildId: "test-build",
  versioningBehavior: "AUTO_UPGRADE",
  identity: "test-worker",
  workflowBundlePath: null,
  reuseV8Context: true,
  maxConcurrentWorkflowTaskExecutions: 2,
  maxConcurrentWorkflowTaskPolls: 1,
  maxConcurrentActivityTaskExecutions: 2,
  maxConcurrentActivityTaskPolls: 1,
  maxCachedWorkflows: 10,
  shutdownGraceTime: "1s",
  shutdownForceTime: "5s",
  requestsProjectionWriterEnabled: false,
  requestsProjectionRealtimeEnabled: false,
};

function createFindChain(events: WhatsAppWebhookDrainEventRecord[]) {
  return {
    select() {
      return this;
    },
    sort() {
      return this;
    },
    limit() {
      return this;
    },
    maxTimeMS() {
      return this;
    },
    lean: async () => events,
  };
}

test("heartbeats continue through pending database IO and stop after completion", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let finishQuery!: (events: WhatsAppWebhookDrainEventRecord[]) => void;
  const query = new Promise<WhatsAppWebhookDrainEventRecord[]>((resolve) => {
    finishQuery = resolve;
  });
  const heartbeats: Array<Record<string, unknown>> = [];
  const run = drainPendingWhatsAppWebhookEventsToTemporal({
    model: {
      find: () => ({ ...createFindChain([]), lean: () => query }),
      updateOne: async () => undefined,
    },
    config: testConfig,
    heartbeat: (details) => {
      heartbeats.push(details);
    },
    signalWithStart: async () => ({ workflowId: "unused" }),
  });
  const beforeWait = heartbeats.length;
  t.mock.timers.tick(20_000);
  const duringWait = heartbeats.length;
  finishQuery([]);
  await run;
  const afterCompletion = heartbeats.length;
  t.mock.timers.tick(30_000);
  assert.equal(duringWait - beforeWait, 2);
  assert.equal(heartbeats[beforeWait]?.phase, "recovery_scan");
  assert.equal(heartbeats.length, afterCompletion);
});

test("a failed in-flight heartbeat is propagated and its timer is cleared", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const failure = new Error("activity no longer running");
  let finishQuery!: (events: WhatsAppWebhookDrainEventRecord[]) => void;
  const query = new Promise<WhatsAppWebhookDrainEventRecord[]>((resolve) => {
    finishQuery = resolve;
  });
  let heartbeatCalls = 0;
  const run = drainPendingWhatsAppWebhookEventsToTemporal({
    model: {
      find: () => ({ ...createFindChain([]), lean: () => query }),
      updateOne: async () => undefined,
    },
    config: testConfig,
    heartbeat: () => {
      heartbeatCalls += 1;
      if (heartbeatCalls > 1) throw failure;
    },
    signalWithStart: async () => ({ workflowId: "unused" }),
  });
  t.mock.timers.tick(10_000);
  finishQuery([]);
  await assert.rejects(run, failure);
  const afterFailure = heartbeatCalls;
  t.mock.timers.tick(30_000);
  assert.equal(heartbeatCalls, afterFailure);
});

test("signals pending webhook events directly into Temporal and marks them queued", async () => {
  const now = new Date("2026-05-19T10:00:00.000Z");
  const updates: Array<{ filter: unknown; update: unknown }> = [];
  const signaled: unknown[] = [];
  const model = {
    find: () =>
      createFindChain([
        {
          _id: "event-1",
          dedupeKey: "dedupe-1",
          field: "messages",
          orderingKey: "phone-1",
          lastReceivedAt: now,
        },
      ]),
    updateOne: async (filter: unknown, update: unknown) => {
      updates.push({ filter, update });
    },
  };

  const result = await drainPendingWhatsAppWebhookEventsToTemporal({
    model,
    config: testConfig,
    now,
    limit: 50,
    signalWithStart: async (params) => {
      signaled.push(params);
      return { workflowId: "whatsapp-webhook:phone-1" };
    },
  });

  assert.deepEqual(result, { scanned: 1, queued: 1, failed: 0 });
  assert.deepEqual(signaled, [
    {
      config: testConfig,
      timeoutMs: 10_000,
      event: {
        eventId: "event-1",
        dedupeKey: "dedupe-1",
        field: "messages",
        orderingKey: "phone-1",
        receivedAt: now.toISOString(),
      },
    },
  ]);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0]?.filter, {
    _id: "event-1",
    ...buildWhatsAppWebhookDrainFilter(now),
  });
  assert.deepEqual(updates[0]?.update, {
    $set: {
      status: "queued",
      queuedAt: now,
      temporalWorkflowId: "whatsapp-webhook:phone-1",
      lastError: null,
    },
  });
});

test("both signal outcomes recheck recovery eligibility before changing receipt state", async () => {
  const now = new Date("2026-10-10T10:00:00.000Z");
  for (const signalFails of [false, true]) {
    let updateFilter: unknown;
    await drainPendingWhatsAppWebhookEventsToTemporal({
      model: {
        find: () =>
          createFindChain([
            {
              _id: "racing-event",
              dedupeKey: "dedupe",
              field: "messages",
              orderingKey: "phone",
            },
          ]),
        updateOne: async (filter) => {
          updateFilter = filter;
        },
      },
      config: testConfig,
      now,
      signalWithStart: async () => {
        if (signalFails) throw new Error("response lost after signal accepted");
        return { workflowId: "already-processing" };
      },
    });
    // A processor can claim/complete the receipt while signalWithStart is in flight.
    // Recheck the frozen eligibility cutoff, including the processing lease age.
    assert.deepEqual(updateFilter, {
      _id: "racing-event",
      ...buildWhatsAppWebhookDrainFilter(now),
    });
  }
});

test("bounds exhausted recovery by IDs and reads only routing metadata", async () => {
  const now = new Date("2026-10-10T10:00:00.000Z");
  const queries: Array<{
    filter: unknown;
    projection?: unknown;
    limit?: number;
    maxTimeMS?: number;
  }> = [];
  const updates: Array<{ filter: unknown; options: unknown }> = [];
  await drainPendingWhatsAppWebhookEventsToTemporal({
    model: {
      find: (filter) => {
        const query = { filter } as (typeof queries)[number];
        queries.push(query);
        const records =
          queries.length === 1
            ? [{ _id: "exhausted", dedupeKey: "", field: "", orderingKey: "" }]
            : [];
        return {
          ...createFindChain(records),
          select(projection: unknown) {
            query.projection = projection;
            return this;
          },
          limit(limit: number) {
            query.limit = limit;
            return this;
          },
          maxTimeMS(value: number) {
            query.maxTimeMS = value;
            return this;
          },
        };
      },
      updateOne: async () => undefined,
      updateMany: async (filter, _update, options) => {
        updates.push({ filter, options });
      },
    },
    config: testConfig,
    now,
    limit: 7,
    signalWithStart: async () => ({ workflowId: "unused" }),
  });
  assert.equal(queries.length, 2);
  assert.equal(queries[0].projection, "_id");
  assert.equal(queries[0].limit, 7);
  assert.equal(queries[0].maxTimeMS, 10_000);
  assert.equal(
    queries[1].projection,
    "_id dedupeKey field itemKind orderingKey firstReceivedAt lastReceivedAt",
  );
  assert.equal(queries[1].limit, 7);
  assert.equal(queries[1].maxTimeMS, 10_000);
  assert.deepEqual(updates, [
    {
      filter: {
        _id: { $in: ["exhausted"] },
        ...buildWhatsAppWebhookExhaustedRetryFilter(now),
      },
      options: { maxTimeMS: 10_000 },
    },
  ]);
});

test("does not mark a fresh final processing attempt dead", () => {
  const now = new Date("2026-10-10T10:00:00.000Z");
  const filter = buildWhatsAppWebhookExhaustedRetryFilter(now);
  assert.deepEqual(filter.$or, [
    { status: { $in: ["received", "failed", "queued"] } },
    {
      status: "processing",
      processingStartedAt: { $lte: new Date("2026-10-10T09:45:00.000Z") },
    },
  ]);
  assert.equal(filter.completedAt, null);
});

test("time budget defers remaining signals and still reports compaction progress", async () => {
  let elapsed = 0;
  let signaled = 0;
  const heartbeats: Array<Record<string, unknown>> = [];
  const result = await drainPendingWhatsAppWebhookEventsToTemporal({
    model: {
      find: () =>
        createFindChain(
          [1, 2].map((id) => ({
            _id: id,
            dedupeKey: `dedupe-${id}`,
            field: "messages",
            orderingKey: "phone",
          })),
        ),
      updateOne: async () => undefined,
    },
    config: testConfig,
    monotonicNow: () => elapsed,
    heartbeat: (details) => {
      heartbeats.push(details);
    },
    signalWithStart: async ({ timeoutMs }) => {
      assert.equal(timeoutMs, 10_000);
      signaled += 1;
      elapsed = 180_000;
      return { workflowId: "workflow" };
    },
    compactPayloads: async () => {
      elapsed += 25;
      return {
        dryRun: false,
        retentionDays: 30,
        cutoff: "2026-09-10T00:00:00.000Z",
        scanned: 100,
        compacted: 97,
      };
    },
  });
  assert.equal(signaled, 1);
  assert.deepEqual(result, { scanned: 2, queued: 1, failed: 0 });
  assert.ok(
    heartbeats.some(
      (details) =>
        details.phase === "payload_compaction_complete" &&
        details.compacted === 97 &&
        details.scanned === 100 &&
        details.durationMs === 25,
    ),
  );
  assert.ok(
    heartbeats.some(
      (details) =>
        details.phase === "recovery_complete" &&
        details.deferred === 1 &&
        details.stopReason === "time_budget",
    ),
  );
});

test("a recovery query failure still attempts maintenance and preserves the original failure", async () => {
  const failure = new Error("recovery query timed out");
  let compacted = false;
  await assert.rejects(
    drainPendingWhatsAppWebhookEventsToTemporal({
      model: {
        find: () => ({
          ...createFindChain([]),
          lean: async () => {
            throw failure;
          },
        }),
        updateOne: async () => undefined,
      },
      config: testConfig,
      signalWithStart: async () => ({ workflowId: "unused" }),
      compactPayloads: async () => {
        compacted = true;
        return {
          dryRun: false,
          retentionDays: 30,
          cutoff: "2026-09-10T00:00:00.000Z",
          scanned: 0,
          compacted: 0,
        };
      },
    }),
    failure,
  );
  assert.equal(compacted, true);
});

test("reports maintenance failure without turning recovered receipts into retryable work", async () => {
  const heartbeats: Array<Record<string, unknown>> = [];
  const result = await drainPendingWhatsAppWebhookEventsToTemporal({
    model: {
      find: () => createFindChain([]),
      updateOne: async () => undefined,
    },
    config: testConfig,
    heartbeat: (details) => {
      heartbeats.push(details);
    },
    signalWithStart: async () => ({ workflowId: "unused" }),
    compactPayloads: async () => {
      throw new Error("compaction timed out");
    },
  });
  assert.deepEqual(result, { scanned: 0, queued: 0, failed: 0 });
  assert.ok(
    heartbeats.some(
      (details) =>
        details.phase === "payload_compaction_failed" &&
        details.status === "failed" &&
        typeof details.durationMs === "number",
    ),
  );
});

test("completed payload maintenance runs after recovery without changing drain counts", async () => {
  const phases: string[] = [];
  const result = await drainPendingWhatsAppWebhookEventsToTemporal({
    model: {
      find: () =>
        createFindChain([
          {
            _id: "event-1",
            dedupeKey: "dedupe-1",
            field: "messages",
            orderingKey: "phone-1",
          },
        ]),
      updateOne: async () => {
        phases.push("queued");
      },
    },
    config: testConfig,
    signalWithStart: async () => {
      phases.push("signal");
      return { workflowId: "workflow-1" };
    },
    compactPayloads: async () => {
      phases.push("compact");
      return {
        dryRun: false,
        retentionDays: 30,
        cutoff: "2026-09-01T00:00:00.000Z",
        scanned: 100,
        compacted: 97,
      };
    },
  });
  assert.deepEqual(phases, ["signal", "queued", "compact"]);
  assert.deepEqual(result, { scanned: 1, queued: 1, failed: 0 });
});

test("a payload maintenance failure preserves successfully queued recovery work", async () => {
  let attempted = false;
  const result = await drainPendingWhatsAppWebhookEventsToTemporal({
    model: {
      find: () =>
        createFindChain([
          {
            _id: "event-1",
            dedupeKey: "dedupe-1",
            field: "messages",
            orderingKey: "phone-1",
          },
        ]),
      updateOne: async () => undefined,
    },
    config: testConfig,
    signalWithStart: async () => ({ workflowId: "workflow-1" }),
    compactPayloads: async () => {
      attempted = true;
      throw new Error("maintenance unavailable");
    },
  });
  assert.equal(attempted, true);
  assert.deepEqual(result, { scanned: 1, queued: 1, failed: 0 });
});

test("engagement recovery follows webhook recovery and preserves the activity contract", async () => {
  const phases: string[] = [];
  const result = await drainPendingWhatsAppWebhookEventsToTemporal({
    model: {
      find: () => createFindChain([]),
      updateOne: async () => undefined,
    },
    config: testConfig,
    signalWithStart: async () => ({ workflowId: "unused" }),
    compactPayloads: async () => {
      phases.push("compact");
      return {
        dryRun: false,
        retentionDays: 30,
        cutoff: "2026-09-01T00:00:00.000Z",
        scanned: 0,
        compacted: 0,
      };
    },
    refreshEngagement: async () => {
      phases.push("engagement");
      return { processed: 10, bootstrapsAdvanced: 1 };
    },
  });
  assert.deepEqual(phases, ["compact", "engagement"]);
  assert.deepEqual(result, { scanned: 0, queued: 0, failed: 0 });
});

test("an engagement recovery failure preserves completed webhook drain work", async () => {
  let attempted = false;
  const result = await drainPendingWhatsAppWebhookEventsToTemporal({
    model: {
      find: () => createFindChain([]),
      updateOne: async () => undefined,
    },
    config: testConfig,
    signalWithStart: async () => ({ workflowId: "unused" }),
    refreshEngagement: async () => {
      attempted = true;
      throw new Error("engagement maintenance unavailable");
    },
  });
  assert.equal(attempted, true);
  assert.deepEqual(result, { scanned: 0, queued: 0, failed: 0 });
});

test("keeps draining after a signal failure and schedules the failed event for retry", async () => {
  const now = new Date("2026-05-19T10:00:00.000Z");
  const updates: Array<{ filter: unknown; update: unknown }> = [];
  const model = {
    find: () =>
      createFindChain([
        {
          _id: "event-1",
          dedupeKey: "dedupe-1",
          field: "messages",
          orderingKey: "phone-1",
          firstReceivedAt: now,
        },
        {
          _id: "event-2",
          dedupeKey: "dedupe-2",
          field: "account_update",
          orderingKey: "waba-1",
          firstReceivedAt: now,
        },
      ]),
    updateOne: async (filter: unknown, update: unknown) => {
      updates.push({ filter, update });
    },
  };

  const result = await drainPendingWhatsAppWebhookEventsToTemporal({
    model,
    config: testConfig,
    now,
    limit: 50,
    signalWithStart: async (params) => {
      if (params.event.eventId === "event-1") {
        throw new Error("Temporal unavailable");
      }
      return { workflowId: `workflow:${params.event.orderingKey}` };
    },
  });

  assert.deepEqual(result, { scanned: 2, queued: 1, failed: 1 });
  assert.deepEqual(updates[0]?.filter, {
    _id: "event-1",
    ...buildWhatsAppWebhookDrainFilter(now),
  });
  assert.match(
    String(
      (updates[0]?.update as { $set?: { lastError?: unknown } }).$set
        ?.lastError,
    ),
    /Temporal unavailable/,
  );
  assert.deepEqual(updates[1]?.filter, {
    _id: "event-2",
    ...buildWhatsAppWebhookDrainFilter(now),
  });
});

test("moves stale echo events into their isolated processor lane", async () => {
  const now = new Date("2026-06-08T05:20:00.000Z");
  const signaled: unknown[] = [];
  const model = {
    find: () =>
      createFindChain([
        {
          _id: "event-echo",
          dedupeKey: "dedupe-echo",
          field: "smb_message_echoes",
          orderingKey: "phone-1",
          lastReceivedAt: now,
        },
      ]),
    updateOne: async () => undefined,
  };

  await drainPendingWhatsAppWebhookEventsToTemporal({
    model,
    config: testConfig,
    now,
    limit: 50,
    signalWithStart: async (params) => {
      signaled.push(params);
      return { workflowId: `workflow:${params.event.orderingKey}` };
    },
  });

  assert.equal(
    (signaled[0] as { event: { orderingKey: string } }).event.orderingKey,
    "phone-1:smb_message_echoes",
  );
});

test("does not double-suffix drain ordering keys that are already isolated", () => {
  assert.equal(
    getWhatsAppWebhookDrainOrderingKey({
      field: "smb_message_echoes",
      itemKind: "smb_message_echoes",
      orderingKey: "phone-1:smb_message_echoes",
    }),
    "phone-1:smb_message_echoes",
  );
});

test("preserves partitioned processor routing keys during recovery", () => {
  assert.equal(
    getWhatsAppWebhookDrainOrderingKey({
      field: "messages",
      itemKind: "status",
      orderingKey: "phone-1:status:0123456789abcdef01234567",
    }),
    "phone-1:status:0123456789abcdef01234567",
  );
});

test("uses persisted itemKind to keep top-level webhook errors isolated", () => {
  assert.equal(
    getWhatsAppWebhookDrainOrderingKey({
      field: "messages",
      itemKind: "error",
      orderingKey: "phone-1:error",
    }),
    "phone-1:error",
  );
});

test("falls back to field when older webhook events do not have itemKind", () => {
  assert.equal(
    getWhatsAppWebhookDrainOrderingKey({
      field: "smb_message_echoes",
      orderingKey: "phone-1:smb_message_echoes",
    }),
    "phone-1:smb_message_echoes",
  );
});

test("includes stale queued webhook events in the drain filter", () => {
  const now = new Date("2026-06-01T10:00:00.000Z");

  assert.deepEqual(buildWhatsAppWebhookDrainFilter(now), {
    $and: [
      {
        $or: [
          {
            status: { $in: ["received", "failed"] },
            nextRetryAt: { $lte: now },
          },
          {
            status: "queued",
            queuedAt: { $lte: new Date("2026-06-01T09:45:00.000Z") },
            completedAt: null,
          },
          {
            status: "processing",
            processingStartedAt: {
              $lte: new Date("2026-06-01T09:45:00.000Z"),
            },
            completedAt: null,
          },
        ],
      },
      {
        $expr: {
          $lt: [
            { $ifNull: ["$attempts", 0] },
            {
              $cond: [
                { $gt: [{ $ifNull: ["$maxAttempts", 0] }, 0] },
                "$maxAttempts",
                12,
              ],
            },
          ],
        },
      },
    ],
  });
});

test("does not issue an exhausted update when the bounded scan is empty", async () => {
  const now = new Date("2026-06-01T10:00:00.000Z");
  const updateManyCalls: Array<{ filter: unknown; update: unknown }> = [];
  const model = {
    find: () => createFindChain([]),
    updateOne: async () => undefined,
    updateMany: async (filter: unknown, update: unknown) => {
      updateManyCalls.push({ filter, update });
    },
  };

  const result = await drainPendingWhatsAppWebhookEventsToTemporal({
    model,
    config: testConfig,
    now,
    limit: 50,
    signalWithStart: async () => ({ workflowId: "unused" }),
  });

  assert.deepEqual(result, { scanned: 0, queued: 0, failed: 0 });
  assert.deepEqual(updateManyCalls, []);
});

test("validates drain limits before querying", () => {
  assert.equal(isValidWhatsAppWebhookDrainLimit(1), true);
  assert.equal(isValidWhatsAppWebhookDrainLimit(500), true);
  assert.equal(isValidWhatsAppWebhookDrainLimit(0), false);
  assert.equal(isValidWhatsAppWebhookDrainLimit(501), false);
  assert.equal(isValidWhatsAppWebhookDrainLimit(Number.NaN), false);
});
