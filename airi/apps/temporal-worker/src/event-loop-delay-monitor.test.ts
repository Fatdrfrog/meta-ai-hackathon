import assert from "node:assert/strict";
import test from "node:test";

import { startEventLoopDelayMonitor } from "./event-loop-delay-monitor";

function blockFor(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Busy-wait so the event loop cannot run timers.
  }
}

test("logs event-loop delay and utilization once per interval", async () => {
  const records: Array<{ name: string; context: Record<string, unknown> }> = [];
  const stop = startEventLoopDelayMonitor({
    runtimeMode: "worker",
    intervalMs: 150,
    logger: {
      info: (name: string, context: Record<string, unknown>) => {
        records.push({ name, context });
      },
    } as never,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  blockFor(120);
  await new Promise((resolve) => setTimeout(resolve, 200));
  stop();

  assert.ok(records.length >= 1);
  const [first] = records;
  assert.equal(first?.name, "airi.worker.event_loop");
  assert.equal(first?.context.runtimeMode, "worker");
  for (const key of ["delayP50Ms", "delayP99Ms", "delayMaxMs", "utilization"]) {
    assert.equal(typeof first?.context[key], "number", key);
  }
  assert.ok(Number(first?.context.delayMaxMs) >= 100);
  assert.ok(Number(first?.context.utilization) > 0);
});

test("stops logging after the returned stop function runs", async () => {
  const records: unknown[] = [];
  const stop = startEventLoopDelayMonitor({
    runtimeMode: "realtime-dispatcher",
    intervalMs: 30,
    logger: { info: () => records.push(1) } as never,
  });
  stop();

  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(records.length, 0);
});
