import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workerSrcDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(workerSrcDir, "../../..");
const contractsPath = join(
  repoRoot,
  "packages",
  "temporal",
  "src",
  "whatsapp-calls.ts",
);
const workflowPath = join(
  workerSrcDir,
  "workflows",
  "whatsapp-call-transcription-drain.ts",
);
const workflowIndexPath = join(workerSrcDir, "workflows", "index.ts");
const workerPath = join(workerSrcDir, "worker.ts");
const recordingActivitiesPath = join(
  workerSrcDir,
  "activities",
  "whatsapp-calls",
  "recording-activities.ts",
);
const schedulePath = join(
  workerSrcDir,
  "whatsapp-call-transcription-drain-schedule.ts",
);
const callWorkflowPath = join(
  workerSrcDir,
  "workflows",
  "whatsapp-call-workflow.ts",
);

function readRequiredSource(path: string): string {
  assert.equal(existsSync(path), true, `${path} must exist`);
  return readFileSync(path, "utf8");
}

test("defines a batched WhatsApp call transcription drain workflow contract", () => {
  const contracts = readRequiredSource(contractsPath);

  assert.match(contracts, /WHATSAPP_CALL_TRANSCRIPTION_DRAIN_WORKFLOW/);
  assert.match(contracts, /WHATSAPP_CALL_TRANSCRIPTION_DRAIN_ACTIVITY/);
  assert.match(contracts, /WHATSAPP_CALL_TRANSCRIPTION_DRAIN_SCHEDULE_ID/);
  assert.match(contracts, /WhatsAppCallTranscriptionDrainWorkflowInput/);
  assert.match(contracts, /WhatsAppCallTranscriptionDrainActivityResult/);
});

test("registers a scheduled transcription drain workflow and activity", () => {
  const workflow = readRequiredSource(workflowPath);
  const workflowIndex = readRequiredSource(workflowIndexPath);
  const worker = readRequiredSource(workerPath);
  const schedule = readRequiredSource(schedulePath);

  assert.match(workflow, /WHATSAPP_CALL_TRANSCRIPTION_DRAIN_ACTIVITY/);
  assert.match(workflow, /whatsappCallTranscriptionDrainWorkflow/);
  assert.match(workflowIndex, /whatsappCallTranscriptionDrainWorkflow/);
  assert.match(worker, /WHATSAPP_CALL_TRANSCRIPTION_DRAIN_ACTIVITY/);
  assert.match(worker, /ensureWhatsAppCallTranscriptionDrainSchedule/);
  assert.match(schedule, /buildWhatsAppCallTranscriptionDrainScheduleOptions/);
  assert.match(schedule, /WHATSAPP_CALL_TRANSCRIPTION_DRAIN_SCHEDULE_ID/);
  assert.match(schedule, /overlap:\s*"SKIP"/);
});

test("drains transcription polling in batches instead of sleeping inside every call workflow", () => {
  const callWorkflow = readRequiredSource(callWorkflowPath);
  const recordingActivities = readRequiredSource(recordingActivitiesPath);

  assert.doesNotMatch(callWorkflow, /sleep\(TRANSCRIPTION_POLL_INTERVAL\)/);
  assert.doesNotMatch(callWorkflow, /while\s*\(\s*shouldPollTranscription/);
  assert.match(recordingActivities, /drainWhatsAppCallTranscriptionOperations/);
  assert.match(recordingActivities, /transcriptStatus:\s*"processing"/);
  assert.match(recordingActivities, /transcriptionRequestId:\s*\{\s*\$nin/);
  assert.match(recordingActivities, /pollWhatsAppCallTranscriptionActivity/);
});
