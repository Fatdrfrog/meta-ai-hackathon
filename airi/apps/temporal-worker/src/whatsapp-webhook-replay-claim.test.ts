import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWhatsAppNotPlanSkippedReceiptFilter,
  WHATSAPP_INTAKE_CONVERSATION_LIMIT_REASON,
} from "@icecore/airi-runtime/whatsapp-intake-plan-gate";

import {
  claimWhatsAppWebhookEventForReplay,
  runWhatsAppWebhookFastReplay,
} from "./whatsapp-webhook-replay-claim";

function createReceiptModel(
  receipt: Record<string, any>,
  { excludePlanSkipped = false } = {},
) {
  return {
    async updateOne(filter: Record<string, any>, update: Record<string, any>) {
      assert.deepEqual(filter, {
        _id: receipt._id,
        status: "completed",
        payloadCompactedAt: null,
        payload: { $exists: true, $ne: null },
        ...(excludePlanSkipped
          ? buildWhatsAppNotPlanSkippedReceiptFilter()
          : {}),
      });
      if (
        receipt.status !== filter.status ||
        receipt.payloadCompactedAt != null ||
        receipt.payload == null ||
        filter.planSkipReason?.$nin?.includes(receipt.planSkipReason)
      ) {
        return { matchedCount: 0 };
      }
      Object.assign(receipt, update.$set);
      return { matchedCount: 1 };
    },
  };
}

test("replay skips a compacted completed receipt without resurrecting processing", async () => {
  const receipt = {
    _id: "event-1",
    status: "completed",
    payloadCompactedAt: new Date("2026-10-01"),
    completedAt: new Date("2026-08-01"),
  };
  const original = structuredClone(receipt);
  const result = await claimWhatsAppWebhookEventForReplay({
    model: createReceiptModel(receipt),
    eventId: receipt._id,
    status: "completed",
  });
  assert.deepEqual(result, {
    status: "skipped",
    reason: "payload_unavailable_or_state_changed",
  });
  assert.deepEqual(receipt, original);
});

test("replay atomically resets a receipt while its recoverable payload remains present", async () => {
  const receipt: Record<string, any> = {
    _id: "event-1",
    status: "completed",
    completedAt: new Date("2026-08-01"),
    payload: { body: "original" },
    attempts: 3,
  };
  const now = new Date("2026-10-02");
  const result = await claimWhatsAppWebhookEventForReplay({
    model: createReceiptModel(receipt),
    eventId: receipt._id,
    status: "completed",
    now,
  });
  assert.deepEqual(result, { status: "ready" });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.completedAt, null);
  assert.equal(receipt.attempts, 0);
  assert.deepEqual(receipt.nextRetryAt, now);
  assert.deepEqual(receipt.payload, { body: "original" });
});

test("fast replay claims a processing lease before work can race the scheduled drain", async () => {
  const receipt: Record<string, any> = {
    _id: "event-1",
    status: "completed",
    completedAt: new Date("2026-08-01"),
    payload: { body: "original" },
    attempts: 3,
  };
  const now = new Date("2026-10-02");
  await claimWhatsAppWebhookEventForReplay({
    model: createReceiptModel(receipt),
    eventId: receipt._id,
    status: "completed",
    processingLeaseId: "fast-replay-owner",
    now,
  });
  assert.equal(receipt.status, "processing");
  assert.equal(receipt.processingLeaseId, "fast-replay-owner");
  assert.deepEqual(receipt.processingStartedAt, now);
});

test("replay skips missing payloads and rows whose status changed since selection", async () => {
  for (const receipt of [
    {
      _id: "event-1",
      status: "completed",
      completedAt: new Date("2026-08-01"),
    },
    { _id: "event-1", status: "processing", payload: { body: "original" } },
  ]) {
    const original = structuredClone(receipt);
    const result = await claimWhatsAppWebhookEventForReplay({
      model: createReceiptModel(receipt),
      eventId: receipt._id,
      status: "completed",
    });
    assert.equal(result.status, "skipped");
    assert.deepEqual(receipt, original);
  }
});

test("fast replay completion and failure preserve a concurrent processing owner", async () => {
  for (const fails of [false, true]) {
    const receipt: Record<string, any> = {
      _id: "event-1",
      status: "completed",
      payload: { body: "original" },
    };
    const model = {
      async updateOne(
        filter: Record<string, any>,
        update: Record<string, any>,
      ) {
        if (filter.status && receipt.status !== filter.status)
          return { matchedCount: 0 };
        if (
          filter.processingLeaseId &&
          receipt.processingLeaseId !== filter.processingLeaseId
        )
          return { matchedCount: 0 };
        Object.assign(receipt, update.$set);
        return { matchedCount: 1 };
      },
    };
    const failure = new Error("fast import interrupted");
    const run = runWhatsAppWebhookFastReplay({
      model,
      eventId: receipt._id,
      status: "completed",
      run: async () => {
        assert.equal(receipt.status, "processing");
        assert.ok(receipt.processingLeaseId);
        receipt.processingLeaseId = "concurrent-owner";
        if (fails) throw failure;
        return { status: "completed", runtimeCode: "fast_import" };
      },
    });
    if (fails) await assert.rejects(run, failure);
    else
      assert.deepEqual(await run, {
        status: "skipped",
        runtimeCode: "event_claim_lost",
      });
    assert.equal(receipt.status, "processing");
    assert.equal(receipt.processingLeaseId, "concurrent-owner");
  }
});

test("fast replay never imports a compacted receipt", async () => {
  const receipt = {
    _id: "event-1",
    status: "completed",
    payloadCompactedAt: new Date("2026-10-01"),
  };
  const result = await runWhatsAppWebhookFastReplay({
    model: createReceiptModel(receipt, { excludePlanSkipped: true }),
    eventId: receipt._id,
    status: "completed",
    run: async () => {
      assert.fail("compacted receipt cannot reach the importer");
    },
  });
  assert.deepEqual(result, {
    status: "skipped",
    runtimeCode: "payload_unavailable_or_state_changed",
  });
});

test("fast replay leaves a plan-skipped receipt to the processor replay", async () => {
  // Fast import completes edits, revokes, reactions and history children
  // without importing them, so it must not claim (and complete) a marked
  // receipt: --plan-skipped would never select it again.
  const receipt = {
    _id: "event-1",
    status: "completed",
    payload: { body: "original" },
    planSkipReason: WHATSAPP_INTAKE_CONVERSATION_LIMIT_REASON,
  };
  const original = structuredClone(receipt);
  const result = await runWhatsAppWebhookFastReplay({
    model: createReceiptModel(receipt, { excludePlanSkipped: true }),
    eventId: receipt._id,
    status: "completed",
    run: async () => {
      assert.fail("a plan-skipped receipt cannot reach the fast importer");
    },
  });
  assert.deepEqual(result, {
    status: "skipped",
    runtimeCode: "payload_unavailable_or_state_changed",
  });
  assert.deepEqual(receipt, original);
});

test("the processor replay still claims a plan-skipped receipt", async () => {
  const receipt: Record<string, any> = {
    _id: "event-1",
    status: "completed",
    payload: { body: "original" },
    planSkipReason: WHATSAPP_INTAKE_CONVERSATION_LIMIT_REASON,
  };
  const result = await claimWhatsAppWebhookEventForReplay({
    model: createReceiptModel(receipt),
    eventId: receipt._id,
    status: "completed",
  });
  assert.deepEqual(result, { status: "ready" });
  assert.equal(receipt.status, "failed");
});
