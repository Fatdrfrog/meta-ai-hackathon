import assert from "node:assert/strict";
import test from "node:test";

import type { CrossStoreOutboxDrainBatchResult } from "@icecore/temporal";

import {
  buildCrossStoreOutboxDrainLogContext,
  drainCrossStoreOutboxBatches,
  resolveProcessCrossStoreOutboxBatch,
} from "./cross-store-outbox-drain";

function batchResult(
  values: Partial<CrossStoreOutboxDrainBatchResult>,
): CrossStoreOutboxDrainBatchResult {
  return {
    recoveredStale: 0,
    claimed: 0,
    completed: 0,
    retried: 0,
    failed: 0,
    skippedUnsupported: 0,
    analyticsBacklog: 0,
    analyticsFailed: 0,
    ...values,
  };
}

test("drains repeated 200-row batches until the first partial batch", async () => {
  const batches = [
    batchResult({
      recoveredStale: 3,
      claimed: 200,
      completed: 190,
      retried: 8,
      failed: 2,
      analyticsBacklog: 415,
      analyticsFailed: 4,
    }),
    batchResult({
      claimed: 37,
      completed: 36,
      retried: 1,
      analyticsBacklog: 12,
      analyticsFailed: 5,
    }),
  ];
  const observedLimits: number[] = [];
  const heartbeats: unknown[] = [];

  const result = await drainCrossStoreOutboxBatches({
    batchLimit: 200,
    maxBatches: 20,
    maxDurationMs: 45_000,
    now: () => 0,
    heartbeat: (details) => heartbeats.push(details),
    processBatch: async ({ limit }) => {
      observedLimits.push(limit);
      return batches.shift() || batchResult({});
    },
  });

  assert.deepEqual(observedLimits, [200, 200]);
  assert.deepEqual(result, {
    recoveredStale: 3,
    claimed: 237,
    completed: 226,
    retried: 9,
    failed: 2,
    skippedUnsupported: 0,
    analyticsBacklog: 12,
    analyticsFailed: 5,
    batches: 2,
    stopReason: "drained",
    durationMs: 0,
  });
  assert.deepEqual(heartbeats, [
    {
      batch: 1,
      claimed: 200,
      completed: 190,
      analyticsBacklog: 415,
      analyticsFailed: 4,
    },
    {
      batch: 2,
      claimed: 37,
      completed: 36,
      analyticsBacklog: 12,
      analyticsFailed: 5,
    },
  ]);
});

test("bounds catch-up by both batch count and elapsed time", async (t) => {
  await t.test("maximum batch count", async () => {
    let calls = 0;
    const result = await drainCrossStoreOutboxBatches({
      batchLimit: 200,
      maxBatches: 2,
      maxDurationMs: 45_000,
      now: () => 0,
      processBatch: async () => {
        calls += 1;
        return batchResult({ claimed: 200, completed: 200 });
      },
    });

    assert.equal(calls, 2);
    assert.equal(result.claimed, 400);
    assert.equal(result.stopReason, "max_batches");
  });

  await t.test("elapsed time budget", async () => {
    const clock = [1_000, 20_000, 47_000];
    let calls = 0;
    const result = await drainCrossStoreOutboxBatches({
      batchLimit: 200,
      maxBatches: 20,
      maxDurationMs: 45_000,
      now: () => clock.shift() ?? 47_000,
      processBatch: async () => {
        calls += 1;
        return batchResult({ claimed: 200, completed: 200 });
      },
    });

    assert.equal(calls, 2);
    assert.equal(result.claimed, 400);
    assert.equal(result.stopReason, "time_budget");
    assert.equal(result.durationMs, 46_000);
  });
});

test("continues a partial outbox batch while webhook admission makes progress", async () => {
  const batches = [
    batchResult({
      claimed: 12,
      completed: 12,
      customerWebhookIntentsAdmitted: 12,
      customerWebhookIntentsHasMore: true,
    }),
    batchResult({
      claimed: 9,
      completed: 9,
      customerWebhookIntentsAdmitted: 9,
      customerWebhookIntentsHasMore: false,
    }),
  ];
  let calls = 0;
  const result = await drainCrossStoreOutboxBatches({
    now: () => 0,
    processBatch: async () => {
      calls += 1;
      return batches.shift() || batchResult({});
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.completed, 21);
  assert.equal(result.customerWebhookIntentsAdmitted, 21);
  assert.equal(result.customerWebhookIntentsHasMore, false);
  assert.equal(result.stopReason, "drained");
});

test("keeps catching up while unsubscribed webhook intents are cleared", async () => {
  const batches = [
    batchResult({
      customerWebhookIntentsAdmitted: 0,
      customerWebhookIntentsSkipped: 1_000,
      customerWebhookIntentsHasMore: true,
    }),
    batchResult({
      customerWebhookIntentsAdmitted: 3,
      customerWebhookIntentsSkipped: 400,
      customerWebhookIntentsHasMore: false,
    }),
  ];
  const heartbeats: Record<string, unknown>[] = [];
  const result = await drainCrossStoreOutboxBatches({
    now: () => 0,
    heartbeat: (details) => heartbeats.push(details),
    processBatch: async () => batches.shift()!,
  });

  assert.equal(result.batches, 2);
  assert.equal(result.stopReason, "drained");
  assert.equal(result.customerWebhookIntentsAdmitted, 3);
  assert.equal(result.customerWebhookIntentsSkipped, 1_400);
  assert.equal(heartbeats[0]?.customerWebhookIntentsSkipped, 1_000);
  assert.equal(
    buildCrossStoreOutboxDrainLogContext(result).customerWebhookIntentsSkipped,
    1_400,
  );
});

test("does not spin on pending webhook intents that cannot be admitted", async () => {
  let calls = 0;
  const result = await drainCrossStoreOutboxBatches({
    now: () => 0,
    processBatch: async () => {
      calls += 1;
      return batchResult({
        claimed: 1,
        completed: 1,
        customerWebhookIntentsAdmitted: 0,
        customerWebhookIntentsHasMore: true,
      });
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.stopReason, "drained");
  assert.equal(result.customerWebhookIntentsAdmitted, 0);
  assert.equal(result.customerWebhookIntentsHasMore, true);
});

test("keeps webhook recovery catch-up within batch and time caps", async (t) => {
  await t.test("batch cap", async () => {
    let calls = 0;
    const result = await drainCrossStoreOutboxBatches({
      maxBatches: 2,
      now: () => 0,
      processBatch: async () => {
        calls += 1;
        return batchResult({
          customerWebhookIntentsAdmitted: 1,
          customerWebhookIntentsHasMore: true,
        });
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.stopReason, "max_batches");
  });

  await t.test("time cap", async () => {
    let clock = 0;
    const result = await drainCrossStoreOutboxBatches({
      maxDurationMs: 3_000,
      now: () => clock,
      processBatch: async () => {
        clock += 3_000;
        return batchResult({
          customerWebhookIntentsAdmitted: 1,
          customerWebhookIntentsHasMore: true,
        });
      },
    });
    assert.equal(result.batches, 1);
    assert.equal(result.stopReason, "time_budget");
  });
});

test("maps the final drain result into structured backlog metrics", () => {
  assert.deepEqual(
    buildCrossStoreOutboxDrainLogContext({
      recoveredStale: 3,
      claimed: 237,
      completed: 226,
      retried: 9,
      failed: 2,
      skippedUnsupported: 0,
      analyticsBacklog: 12,
      analyticsFailed: 5,
      batches: 2,
      stopReason: "drained",
      durationMs: 731,
    }),
    {
      note: "completed",
      outcome: "degraded",
      durationMs: 731,
      batches: 2,
      stopReason: "drained",
      recoveredStale: 3,
      claimed: 237,
      completed: 226,
      retried: 9,
      failed: 2,
      skippedUnsupported: 0,
      analyticsBacklog: 12,
      analyticsFailed: 5,
    },
  );
});

test("resolves the web outbox processor from the worker runtime module shape", () => {
  const processBatch = async () => batchResult({});

  assert.equal(
    resolveProcessCrossStoreOutboxBatch({
      default: { processCrossStoreOutboxBatch: processBatch },
    }),
    processBatch,
  );
  assert.equal(
    resolveProcessCrossStoreOutboxBatch({
      processCrossStoreOutboxBatch: processBatch,
    }),
    processBatch,
  );
});
