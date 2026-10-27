import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workerSrcDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(workerSrcDir, "../../..");
const workflowPath = join(
  workerSrcDir,
  "workflows",
  "whatsapp-call-workflow.ts",
);
const activitiesPath = join(
  workerSrcDir,
  "activities",
  "whatsapp-calls",
  "call-activities.ts",
);
const recordingActivitiesPath = join(
  workerSrcDir,
  "activities",
  "whatsapp-calls",
  "recording-activities.ts",
);
const callActivitiesIndexPath = join(
  workerSrcDir,
  "activities",
  "whatsapp-calls",
  "index.ts",
);
const contractsPath = join(
  repoRoot,
  "packages",
  "temporal",
  "src",
  "whatsapp-calls.ts",
);
const workerPath = join(workerSrcDir, "worker.ts");
const workerEventConsumersPath = join(
  workerSrcDir,
  "pubsub",
  "worker-event-consumers.ts",
);
const workflowsIndexPath = join(workerSrcDir, "workflows", "index.ts");

function readRequiredSource(path: string): string {
  assert.equal(existsSync(path), true, `${path} must exist`);
  return readFileSync(path, "utf8");
}

test("defines WhatsApp call workflow contracts and activity names", () => {
  const contracts = readRequiredSource(contractsPath);

  assert.match(contracts, /WHATSAPP_CALL_WORKFLOW\s*=/);
  assert.match(contracts, /WHATSAPP_CALL_SESSION_EVENT_SIGNAL\s*=/);
  assert.match(contracts, /WHATSAPP_CALL_COMMAND_SIGNAL\s*=/);
  assert.match(contracts, /WHATSAPP_CALL_STATE_QUERY\s*=/);
  assert.match(contracts, /WHATSAPP_CALL_PREPARE_MEDIA_ACTIVITY\s*=/);
  assert.match(contracts, /WHATSAPP_CALL_CREATE_COMMAND_ACTIVITY\s*=/);
  assert.match(contracts, /WHATSAPP_CALL_SEND_COMMAND_ACTIVITY\s*=/);
  assert.match(contracts, /WHATSAPP_CALL_MARK_COMMAND_ACTIVITY\s*=/);
  assert.match(contracts, /WhatsAppCallWorkflowInput/);
  assert.match(contracts, /WhatsAppCallCommandSignal/);
});

test("serializes call session and command signals in one workflow", () => {
  const source = readRequiredSource(workflowPath);

  assert.match(source, /defineSignal<\[WhatsAppCallSessionSignal\]>/);
  assert.match(source, /defineSignal<\[WhatsAppCallCommandSignal\]>/);
  assert.match(source, /defineQuery<WhatsAppCallStateQueryResult>/);
  assert.match(
    source,
    /const commandQueue:\s*WhatsAppCallCommandSignal\[\]\s*=/,
  );
  assert.match(source, /while\s*\(\s*commandQueue\.length\s*>\s*0\s*\)/);
  assert.match(source, /shouldAutoPreAccept\(state\)/);
  assert.match(source, /await createCommandActivity\(/);
  assert.match(source, /action:\s*"pre_accept"/);
  assert.match(source, /await sendCommandActivity\(command\)/);
  assert.match(source, /await markCommandActivity\(/);
  assert.match(source, /reason:\s*"command"/);
  assert.match(source, /dedupeKeySuffix:\s*command\.commandId/);
});

test("bounds retries, closes ended calls, and continues as new before history grows", () => {
  const source = readRequiredSource(workflowPath);

  assert.match(source, /maximumAttempts:\s*5/);
  assert.match(source, /processedThisRun\s*>=\s*MAX_SIGNALS_PER_RUN/);
  assert.match(source, /continueAsNew<typeof whatsappCallWorkflow>/);
  assert.match(source, /isTerminalCallState\(state\.lastSessionState\)/);
  assert.match(source, /return\s+state/);
});

test("registers call workflow and activities with the Temporal worker", () => {
  const worker = readRequiredSource(workerPath);
  const workerEventConsumers = readRequiredSource(workerEventConsumersPath);
  const workflowsIndex = readRequiredSource(workflowsIndexPath);
  const activities = readRequiredSource(activitiesPath);
  const activityIndex = readRequiredSource(callActivitiesIndexPath);

  assert.match(workflowsIndex, /whatsappCallWorkflow/);
  assert.match(worker, /WHATSAPP_CALL_PREPARE_MEDIA_ACTIVITY/);
  assert.match(worker, /WHATSAPP_CALL_CREATE_COMMAND_ACTIVITY/);
  assert.match(worker, /WHATSAPP_CALL_SEND_COMMAND_ACTIVITY/);
  assert.match(worker, /WHATSAPP_CALL_MARK_COMMAND_ACTIVITY/);
  assert.match(worker, /whatsappCallActivityHandlers/);
  assert.match(worker, /startWorkerEventConsumers/);
  assert.match(workerEventConsumers, /startWhatsAppCallWebhookPubSubConsumer/);
  assert.match(activities, /whatsappCallActivityHandlers/);
  assert.match(activityIndex, /whatsappCallActivityHandlers/);
  assert.match(activityIndex, /whatsappCallRecordingActivityHandlers/);
});

test("gates media preparation by source-level WhatsApp call readiness", () => {
  const contracts = readRequiredSource(contractsPath);
  const workflow = readRequiredSource(workflowPath);
  const activities = readRequiredSource(activitiesPath);

  assert.match(
    contracts,
    /type WhatsAppCallPrepareMediaActivityInput = \{[\s\S]*sourceId\?: string \| null/,
  );
  assert.match(
    workflow,
    /prepareMediaActivity\(\{[\s\S]*sourceId:\s*state\.sourceId[\s\S]*sessionSdp:/,
  );
  assert.match(activities, /getWhatsAppCallMediaReadiness/);
  assert.match(activities, /source_media_disabled/);
  assert.match(activities, /source_calls_not_enabled/);
  assert.doesNotMatch(
    activities,
    new RegExp(["WHATSAPP", "CALLS", "MEDIA", "ENABLED"].join("_")),
  );
});

test("tracks connector-accepted media without forcing legacy SDP pre-accept", () => {
  const contracts = readRequiredSource(contractsPath);
  const workflow = readRequiredSource(workflowPath);
  const activities = readRequiredSource(activitiesPath);

  assert.match(contracts, /connectorAccepted: boolean/);
  assert.match(contracts, /providerAccepted\?: boolean \| null/);
  assert.match(workflow, /connectorAccepted:\s*Boolean/);
  assert.match(workflow, /!state\.connectorAccepted[\s\S]*state\.sdpAnswer/);
  assert.match(
    workflow,
    /state\.connectorAccepted\s*=\s*Boolean\([\s\S]*media\.providerAccepted/,
  );
  assert.match(activities, /whatsappPhoneNumberId/);
  assert.match(activities, /createLiveKitConnectorClient\(liveKit\)/);
  assert.match(activities, /connector_not_accepted/);
});

test("uses LiveKit Cloud Connector API without a custom connector URL", () => {
  const activities = readRequiredSource(activitiesPath);

  assert.match(activities, /createLiveKitConnectorClient/);
  assert.doesNotMatch(activities, /LIVEKIT_WHATSAPP_CONNECTOR_URL/);
  assert.doesNotMatch(activities, /connectorUrl/);
});

test("emits low-cardinality call workflow failure logs from activities", () => {
  const activities = readRequiredSource(activitiesPath);
  const recordingActivities = readRequiredSource(recordingActivitiesPath);

  assert.match(activities, /airiWorkerLogger/);
  assert.match(activities, /whatsapp\.call\.workflow\.failure/);
  assert.match(activities, /failureStage:\s*params\.stage/);
  assert.match(activities, /stage:\s*"prepare_media"/);
  assert.match(activities, /stage:\s*"command"/);
  assert.match(activities, /failedCommandResult\(input,\s*"provider_failed"/);
  assert.match(recordingActivities, /airiWorkerLogger/);
  assert.match(recordingActivities, /failureStage:\s*"terminal_session"/);
  assert.match(recordingActivities, /reason:\s*metadata\.state === "failed"/);
  assert.doesNotMatch(activities, /sessionSdp:[\s\S]*airiWorkerLogger/);
});

test("finalizes call recording and analytics through a patched workflow activity", () => {
  const contracts = readRequiredSource(contractsPath);
  const workflow = readRequiredSource(workflowPath);
  const worker = readRequiredSource(workerPath);
  const recordingActivities = readRequiredSource(recordingActivitiesPath);

  assert.match(contracts, /WHATSAPP_CALL_FINALIZE_RECORDING_ACTIVITY/);
  assert.match(contracts, /WhatsAppCallFinalizeRecordingActivityInput/);
  assert.match(workflow, /patched\("whatsapp-call-recording-analytics-v1"\)/);
  assert.match(workflow, /await finalizeRecordingActivity\(/);
  assert.match(worker, /WHATSAPP_CALL_FINALIZE_RECORDING_ACTIVITY/);
  assert.match(
    recordingActivities,
    /WHATSAPP_CALL_FINALIZE_RECORDING_ACTIVITY/,
  );
});

test("starts LiveKit call egress after media preparation through a patched workflow activity", () => {
  const contracts = readRequiredSource(contractsPath);
  const workflow = readRequiredSource(workflowPath);
  const worker = readRequiredSource(workerPath);
  const recordingActivities = readRequiredSource(recordingActivitiesPath);

  assert.match(contracts, /WHATSAPP_CALL_START_RECORDING_ACTIVITY/);
  assert.match(contracts, /WhatsAppCallStartRecordingActivityInput/);
  assert.match(contracts, /recordingStartAttempted: boolean/);
  assert.match(contracts, /recordingStarted: boolean/);
  assert.match(
    workflow,
    /patched\("whatsapp-call-recording-egress-start-v1"\)/,
  );
  assert.match(workflow, /await startRecordingActivity\(/);
  assert.match(worker, /WHATSAPP_CALL_START_RECORDING_ACTIVITY/);
  assert.match(recordingActivities, /startWhatsAppCallRecordingActivity/);
  assert.match(
    recordingActivities,
    /buildWhatsAppCallLiveKitEgressStartRequest/,
  );
});

test("leaves direct Google Speech transcription polling to the batched drain", () => {
  const contracts = readRequiredSource(contractsPath);
  const workflow = readRequiredSource(workflowPath);
  const worker = readRequiredSource(workerPath);
  const recordingActivities = readRequiredSource(recordingActivitiesPath);

  assert.match(contracts, /WHATSAPP_CALL_POLL_TRANSCRIPTION_ACTIVITY/);
  assert.match(contracts, /WHATSAPP_CALL_TRANSCRIPTION_DRAIN_ACTIVITY/);
  assert.match(contracts, /WhatsAppCallPollTranscriptionActivityInput/);
  assert.doesNotMatch(workflow, /await pollTranscriptionActivity\(/);
  assert.doesNotMatch(workflow, /sleep\(TRANSCRIPTION_POLL_INTERVAL\)/);
  assert.match(worker, /WHATSAPP_CALL_POLL_TRANSCRIPTION_ACTIVITY/);
  assert.match(worker, /WHATSAPP_CALL_TRANSCRIPTION_DRAIN_ACTIVITY/);
  assert.match(recordingActivities, /pollWhatsAppCallTranscriptionActivity/);
  assert.match(recordingActivities, /parseWhatsAppCallGoogleSpeechOperation/);
  assert.match(recordingActivities, /drainWhatsAppCallTranscriptionOperations/);
});
