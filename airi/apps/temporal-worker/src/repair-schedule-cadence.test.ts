import assert from "node:assert/strict";
import test from "node:test";
import { buildVideoGenerationReconcileScheduleOptions } from "./video-generation-reconcile-schedule.js";
import { buildWhatsAppCallTranscriptionDrainScheduleOptions } from "./whatsapp-call-transcription-drain-schedule.js";

test("slows video repair while retaining normal transcript completion cadence and workflow inputs", () => {
  const video = buildVideoGenerationReconcileScheduleOptions({
    taskQueue: "airi-worker",
  });
  const call = buildWhatsAppCallTranscriptionDrainScheduleOptions({
    taskQueue: "airi-worker",
  });
  for (const options of [video, call]) {
    assert.equal(options.policies?.overlap, "SKIP");
    assert.equal(options.action.type, "startWorkflow");
    assert.equal(options.action.taskQueue, "airi-worker");
    assert.equal(options.action.workflowRunTimeout, 600_000);
  }
  assert.deepEqual(video.spec.intervals, [{ every: 300_000 }]);
  assert.deepEqual(call.spec.intervals, [{ every: 60_000 }]);
  assert.equal(video.policies?.catchupWindow, 60_000);
  assert.equal(call.policies?.catchupWindow, 300_000);
  assert.deepEqual(video.action.args, [{ contractVersion: 1 }]);
  assert.deepEqual(call.action.args, [{ contractVersion: 1, limit: 50 }]);
});
