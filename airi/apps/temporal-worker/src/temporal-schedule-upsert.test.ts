import assert from "node:assert/strict";
import test from "node:test";

import {
  runTemporalScheduleUpsertWithDeadline,
  TEMPORAL_SCHEDULE_UPSERT_DEADLINE_MS,
} from "./temporal-schedule-upsert.js";

test("bounds schedule upserts with the shared Temporal deadline", async () => {
  const before = Date.now();
  let observedDeadline: number | Date | undefined;

  const result = await runTemporalScheduleUpsertWithDeadline(
    {
      withDeadline: async (deadline, run) => {
        observedDeadline = deadline;
        return run();
      },
    },
    async () => "updated" as const,
  );

  assert.equal(result, "updated");
  assert.equal(typeof observedDeadline, "number");
  assert.ok(
    Number(observedDeadline) >= before + TEMPORAL_SCHEDULE_UPSERT_DEADLINE_MS,
  );
  assert.ok(
    Number(observedDeadline) <=
      Date.now() + TEMPORAL_SCHEDULE_UPSERT_DEADLINE_MS,
  );
});

test("binds schedule upsert RPCs to the lifecycle abort signal", async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const result = await runTemporalScheduleUpsertWithDeadline(
    {
      withDeadline: async (_deadline, run) => run(),
      withAbortSignal: async (signal, run) => {
        observedSignal = signal;
        return run();
      },
    },
    async () => "updated" as const,
    controller.signal,
  );

  assert.equal(result, "updated");
  assert.equal(observedSignal, controller.signal);
});

test("normalizes a shutdown-owned Temporal gRPC cancellation", async () => {
  const controller = new AbortController();
  controller.abort("worker_shutdown");
  const cancelled = Object.assign(new Error("1 CANCELLED: Call cancelled"), {
    code: 1,
    details: "Call cancelled",
  });

  await assert.rejects(
    runTemporalScheduleUpsertWithDeadline(
      {
        withDeadline: async (_deadline, run) => run(),
        withAbortSignal: async () => {
          throw cancelled;
        },
      },
      async () => "must-not-complete",
      controller.signal,
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "AbortError" &&
      error.message === "worker_shutdown",
  );
});
