import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWhatsAppWebhookDrainScheduleOptions,
  isWhatsAppWebhookDrainScheduleEnabled,
} from "./whatsapp-webhook-drain-schedule";

test("builds a Temporal schedule for webhook draining on the worker task queue", () => {
  const options = buildWhatsAppWebhookDrainScheduleOptions({
    taskQueue: "airi-worker",
    limit: 75,
  });

  assert.equal(options.scheduleId, "whatsapp-webhook-events:drain");
  assert.deepEqual(options.spec, {
    intervals: [{ every: 5 * 60 * 1000 }],
  });
  assert.equal(options.policies?.overlap, "SKIP");
  assert.equal(options.policies?.catchupWindow, 15 * 60 * 1000);
  assert.equal(options.action.type, "startWorkflow");
  assert.equal(options.action.workflowType, "whatsappWebhookDrainWorkflow");
  assert.equal(options.action.taskQueue, "airi-worker");
  assert.equal(options.action.workflowId, "whatsapp-webhook-events:drain:run");
  assert.deepEqual(options.action.args, [{ contractVersion: 1, limit: 75 }]);
});

test("enables the Temporal webhook drainer schedule by default", () => {
  assert.equal(isWhatsAppWebhookDrainScheduleEnabled(undefined), true);
  assert.equal(isWhatsAppWebhookDrainScheduleEnabled(""), true);
  assert.equal(isWhatsAppWebhookDrainScheduleEnabled("true"), true);
  assert.equal(isWhatsAppWebhookDrainScheduleEnabled("0"), false);
  assert.equal(isWhatsAppWebhookDrainScheduleEnabled("off"), false);
});
