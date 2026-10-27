import assert from "node:assert/strict";
import test from "node:test";

import type { TemporalWorkerConfig } from "./config";
import { signalWithStartWhatsAppWebhookProcessor } from "./whatsapp-webhook-temporal-client";

test("webhook recovery signals use a Temporal RPC deadline without changing the signal contract", async () => {
  const startedAt = Date.now();
  const calls: unknown[][] = [];
  let deadline: number | Date | undefined;
  const result = await signalWithStartWhatsAppWebhookProcessor(
    {
      config: { taskQueue: "airi-worker" } as TemporalWorkerConfig,
      timeoutMs: 1234,
      event: {
        eventId: "event-1",
        dedupeKey: "dedupe-1",
        field: "messages",
        orderingKey: "phone-1",
        receivedAt: "2026-10-10T10:00:00.000Z",
      },
    },
    async () => ({
      connection: {
        withDeadline: async (value, run) => {
          deadline = value;
          return run();
        },
      },
      workflow: {
        signalWithStart: async (...args) => {
          calls.push(args);
        },
      },
    }),
  );
  assert.equal(typeof deadline, "number");
  assert.ok(Number(deadline) >= startedAt + 1234);
  assert.ok(Number(deadline) <= Date.now() + 1234);
  assert.equal(result.workflowId, "whatsapp-webhook:phone-1");
  assert.equal(calls.length, 1);
  const options = calls[0][1] as { taskQueue: string; signalArgs: unknown[] };
  assert.equal(options.taskQueue, "airi-worker");
  assert.deepEqual(options.signalArgs, [
    {
      contractVersion: 1,
      eventId: "event-1",
      dedupeKey: "dedupe-1",
      field: "messages",
      orderingKey: "phone-1",
      receivedAt: "2026-10-10T10:00:00.000Z",
    },
  ]);
});
