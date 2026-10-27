import assert from "node:assert/strict";
import test from "node:test";
import type { ScheduleClient } from "@temporalio/client";

import {
  buildCrossStoreOutboxDrainScheduleOptions,
  isCrossStoreOutboxDrainScheduleEnabled,
  reconcileCrossStoreOutboxDrainSchedule,
} from "./cross-store-outbox-drain-schedule";

test("builds a minutely non-overlapping worker-owned outbox drain", () => {
  const options = buildCrossStoreOutboxDrainScheduleOptions({
    taskQueue: "airi-worker",
  });

  assert.equal(options.scheduleId, "cross-store-outbox:drain");
  assert.deepEqual(options.spec, { intervals: [{ every: 60_000 }] });
  assert.equal(options.policies?.overlap, "SKIP");
  assert.equal(options.policies?.catchupWindow, 5 * 60_000);
  assert.equal(options.action.type, "startWorkflow");
  assert.equal(options.action.workflowType, "crossStoreOutboxDrainWorkflow");
  assert.equal(options.action.taskQueue, "airi-worker");
  assert.equal(options.action.workflowId, "cross-store-outbox:drain:run");
  assert.equal(options.action.workflowRunTimeout, 10 * 60_000);
  assert.equal(options.action.workflowExecutionTimeout, 10 * 60_000);
  assert.deepEqual(options.action.args, [
    {
      contractVersion: 1,
      batchLimit: 200,
      maxBatches: 20,
      maxDurationMs: 45_000,
    },
  ]);
});

test("pauses the existing outbox drain schedule when the feature is disabled", async () => {
  const pauseNotes: string[] = [];
  const result = await reconcileCrossStoreOutboxDrainSchedule({
    enabled: false,
    scheduleClient: {
      getHandle: (scheduleId: string) => {
        assert.equal(scheduleId, "cross-store-outbox:drain");
        return {
          pause: async (note: string) => {
            pauseNotes.push(note);
          },
        };
      },
    } as unknown as ScheduleClient,
    taskQueue: "airi-worker",
  });

  assert.equal(result, "paused");
  assert.deepEqual(pauseNotes, ["disabled by worker configuration"]);
});

test("treats an already-absent disabled outbox drain schedule as reconciled", async () => {
  const result = await reconcileCrossStoreOutboxDrainSchedule({
    enabled: false,
    scheduleClient: {
      getHandle: () => ({
        pause: async () => {
          throw new Error("schedule not found");
        },
      }),
    } as unknown as ScheduleClient,
    taskQueue: "airi-worker",
  });

  assert.equal(result, "not_found");
});

test("enables the outbox drain schedule by default", () => {
  assert.equal(isCrossStoreOutboxDrainScheduleEnabled(undefined), true);
  assert.equal(isCrossStoreOutboxDrainScheduleEnabled(""), true);
  assert.equal(isCrossStoreOutboxDrainScheduleEnabled("true"), true);
  assert.equal(isCrossStoreOutboxDrainScheduleEnabled("0"), false);
  assert.equal(isCrossStoreOutboxDrainScheduleEnabled("off"), false);
});
