import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as temporalContracts from "@icecore/temporal";

import * as finalizationFailures from "./video-generation-finalization-failure.js";

const {
  readVideoGenerationFinalizationFailure,
  VIDEO_GENERATION_FINALIZATION_FAILURE_TYPE,
} = finalizationFailures;

const root = dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");

const workflow = read("workflows", "video-generation.ts");
const workflowIndex = read("workflows", "index.ts");
const worker = read("worker.ts");
const replayExport = read("export-replay-histories.ts");
const finalizer = read("activities", "video-generation", "finalize.ts");

type ResolvePollPolicy = (provider: unknown) => {
  intervalMs: number;
  maxPolls: number;
  deadlineMs: number;
  continueAsNewEvery: number | null;
} | null;

type SelectTerminalStatus = (
  statuses: ReadonlyArray<string | null | undefined>,
) => "completed" | "failed" | "nsfw" | "cancelled" | null;

test("funnels every durable terminal result through one awaited completion notifier", () => {
  const executeIndex = workflow.indexOf("await executeVideoGeneration");
  const notifyIndex = workflow.indexOf(
    "await notifyVideoGenerationCompletion",
    executeIndex,
  );
  const returnIndex = workflow.indexOf("return terminalResult", notifyIndex);

  assert.ok(executeIndex >= 0, "workflow executes the canonical provider path");
  assert.ok(
    notifyIndex > executeIndex,
    "durable terminal result is notified after provider execution",
  );
  assert.ok(
    returnIndex > notifyIndex,
    "external signaling settles before the workflow returns",
  );
  assert.match(workflow, /getExternalWorkflowHandle/);
  assert.match(
    workflow,
    /await\s+getExternalWorkflowHandle\(target\.workflowId\)\.signal\(\s*target\.signalName,\s*payload,\s*\)/,
  );
  assert.doesNotMatch(
    workflow.slice(notifyIndex, returnIndex),
    /catch\s*\(/,
    "the completion signal is not swallowed",
  );
});

test("maps actual settled activity states to bounded completion classifications", () => {
  assert.match(
    workflow,
    /status\s*===\s*"complete"[\s\S]*terminal:\s*"complete"[\s\S]*code:\s*"generation_complete"/,
  );
  assert.match(
    workflow,
    /status\s*===\s*"nsfw"[\s\S]*terminal:\s*"unsafe"[\s\S]*code:\s*"provider_nsfw"/,
  );
  assert.match(
    workflow,
    /codeHint\s*===\s*"provider_timeout"[\s\S]*terminal:\s*timedOut\s*\?\s*"timeout"\s*:\s*"failed"[\s\S]*code:\s*timedOut\s*\?\s*"provider_timeout"/,
  );
  assert.match(
    workflow,
    /status\s*===\s*"failed"[\s\S]*terminal:\s*timedOut\s*\?\s*"timeout"\s*:\s*"failed"/,
  );
  assert.match(workflow, /code:\s*"provider_protocol_error"/);
});

test("keeps targetless workflows silent and preserves the target across continue-as-new", () => {
  const notifierIndex = workflow.indexOf(
    "async function notifyVideoGenerationCompletion",
  );
  const targetlessReturnIndex = workflow.indexOf(
    "if (!target) return workflowOutcome.terminalResult",
    notifierIndex,
  );
  const terminalNormalizationIndex = workflow.indexOf(
    "await ensureDurableTerminalOutcome",
    notifierIndex,
  );
  assert.match(
    workflow,
    /normalizeVideoGenerationCompletionTarget\(input\.completionTarget\)/,
  );
  assert.ok(
    targetlessReturnIndex > notifierIndex,
    "targetless workflows return their exact legacy activity result",
  );
  assert.ok(
    targetlessReturnIndex < terminalNormalizationIndex,
    "targetless workflows do not enter completion-only normalization",
  );
  assert.match(workflow, /continueAsNew[\s\S]*\{\s*\.\.\.input,[\s\S]*resume:/);
  assert.equal(
    workflow.match(/videoGenerationSubmitActivity\(input\)/g)?.length,
    1,
    "completion retries cannot add another provider submission path",
  );
});

test("preserves durable failure semantics while bounding private signal codes", () => {
  assert.match(
    workflow,
    /code:\s*typedFailure\?\.code\s*\?\?\s*"result_materialization_failed"/,
  );
  assert.match(
    workflow,
    /function\s+safeCompletionCode[\s\S]*?isVideoGenerationCompletionCode\(codeHint\)[\s\S]*?"generation_failed"/,
  );
  assert.match(
    workflow,
    /code:\s*timedOut\s*\?\s*"provider_timeout"\s*:\s*safeCompletionCode\(codeHint\)/,
  );
});

test("rejects non-contract terminal activity results before signaling success", () => {
  assert.match(
    workflow,
    /result\.contractVersion\s*===\s*VIDEO_GENERATION_WORKFLOW_CONTRACT_VERSION/,
  );
});

test("orchestrates bounded provider polling with a bounded webhook queue", () => {
  assert.match(workflow, /VIDEO_GENERATION_STATUS_SIGNAL/);
  assert.match(workflow, /MAX_QUEUED_STATUS_SIGNALS\s*=\s*20/);
  assert.match(workflow, /providerRequestId[\s\S]*status/);
  assert.match(workflow, /processedSignalKeys/);
  assert.match(workflow, /condition\(/);
  assert.match(workflow, /resolveVideoGenerationPollPolicy/);
  assert.match(workflow, /pollCount\s*>=\s*policy\.maxPolls/);
  assert.match(workflow, /elapsedMs\s*>=\s*policy\.deadlineMs/);
});

test("resolves the exact provider policies and rejects unknown providers", () => {
  const resolvePollPolicy = (
    temporalContracts as typeof temporalContracts & {
      resolveVideoGenerationPollPolicy?: ResolvePollPolicy;
    }
  ).resolveVideoGenerationPollPolicy;

  assert.equal(typeof resolvePollPolicy, "function");
  assert.deepEqual(resolvePollPolicy?.("happyhorse"), {
    intervalMs: 15_000,
    maxPolls: 100,
    deadlineMs: 25 * 60_000,
    continueAsNewEvery: null,
  });
  assert.deepEqual(resolvePollPolicy?.("google"), {
    intervalMs: 10_000,
    maxPolls: 180,
    deadlineMs: 30 * 60_000,
    continueAsNewEvery: null,
  });
  assert.deepEqual(resolvePollPolicy?.("higgsfield"), {
    intervalMs: 5 * 60_000,
    maxPolls: 288,
    deadlineMs: 24 * 60 * 60_000,
    continueAsNewEvery: 100,
  });
  assert.equal(resolvePollPolicy?.("unknown-provider"), null);
});

test("completed webhook status wins after an in-flight poll settles", () => {
  const selectTerminalStatus = (
    temporalContracts as typeof temporalContracts & {
      selectVideoGenerationTerminalStatus?: SelectTerminalStatus;
    }
  ).selectVideoGenerationTerminalStatus;

  assert.equal(typeof selectTerminalStatus, "function");
  assert.equal(
    selectTerminalStatus?.(["in_progress", "failed", "completed"]),
    "completed",
  );
  assert.equal(selectTerminalStatus?.(["completed", "nsfw"]), "nsfw");
  assert.equal(
    selectTerminalStatus?.(["failed", "cancelled", "completed"]),
    "completed",
  );
  assert.equal(selectTerminalStatus?.(["in_progress", "nsfw"]), "nsfw");
  assert.equal(
    selectTerminalStatus?.(["in_progress", "cancelled"]),
    "cancelled",
  );
  assert.equal(selectTerminalStatus?.(["in_progress", "failed"]), "failed");
  assert.equal(selectTerminalStatus?.(["queued", "in_progress"]), null);
});

test("guards provider policy before the workflow submits exactly once", () => {
  const guardIndex = workflow.indexOf(
    "const policy = resolveVideoGenerationPollPolicy",
  );
  const submitIndex = workflow.indexOf(
    "await videoGenerationSubmitActivity(input)",
  );
  const submitCalls = workflow.match(
    /await videoGenerationSubmitActivity\(input\)/g,
  );

  assert.ok(guardIndex >= 0, "workflow resolves a runtime provider policy");
  assert.ok(guardIndex < submitIndex, "provider guard runs before submission");
  assert.equal(submitCalls?.length, 1);
  assert.match(workflow, /code:\s*"unsupported_provider"/);
  assert.match(workflow, /phase:\s*"validation"/);
});

test("drains matching signals after polling before advancing a failed poll cycle", () => {
  const pollIndex = workflow.indexOf(
    "polled = await videoGenerationPollActivity",
  );
  const postPollDrainIndex = workflow.indexOf(
    "postPollSignalStatus",
    pollIndex,
  );
  const pollCountIndex = workflow.indexOf("pollCount += 1", pollIndex);

  assert.ok(pollIndex >= 0, "workflow invokes the poll activity");
  assert.ok(
    postPollDrainIndex > pollIndex,
    "workflow drains signals after the poll settles",
  );
  assert.ok(
    postPollDrainIndex < pollCountIndex,
    "completed and failure signals win before the poll cycle advances",
  );
});

test("keeps transient poll outages inside the bounded polling lifecycle", () => {
  const pollIndex = workflow.indexOf(
    "polled = await videoGenerationPollActivity",
  );
  const pollCountIndex = workflow.indexOf("pollCount += 1", pollIndex);
  const terminalResultIndex = workflow.indexOf(
    "if (polled?.terminal)",
    pollCountIndex,
  );
  const continueAsNewIndex = workflow.indexOf(
    "await continueAsNew",
    pollCountIndex,
  );

  assert.ok(pollIndex >= 0, "workflow invokes the poll activity");
  assert.ok(
    pollCountIndex > pollIndex,
    "an exhausted poll activity still consumes one bounded poll cycle",
  );
  assert.ok(
    terminalResultIndex > pollCountIndex,
    "only a returned definitive terminal result can fail early",
  );
  assert.ok(
    continueAsNewIndex > terminalResultIndex,
    "failed poll cycles still reach bounded history rollover",
  );
});

test("versions poll outage recovery for replaying pre-fix histories", () => {
  assert.match(workflow, /patched/);
  assert.match(
    workflow,
    /if\s*\(\s*!polled\s*&&\s*!patched\(\s*"video-poll-outage-recovery-v1"\s*\)\s*\)\s*\{[\s\S]*?return fail\([\s\S]*?code:\s*"provider_poll_failed"/,
  );
});

test("waits before every provider poll cycle to avoid outage retry loops", () => {
  const waitIndex = workflow.indexOf("const receivedSignal = await condition");
  const pollIndex = workflow.indexOf(
    "polled = await videoGenerationPollActivity",
    waitIndex,
  );
  const loopEndIndex = workflow.indexOf("\n  }\n}", pollIndex);

  assert.ok(waitIndex >= 0, "workflow waits for its provider interval");
  assert.ok(
    pollIndex > waitIndex,
    "provider polling happens only after the bounded wait",
  );
  assert.equal(
    workflow
      .slice(pollIndex, loopEndIndex)
      .match(/videoGenerationPollActivity\(/g)?.length,
    1,
    "the cycle has no immediate second provider poll",
  );
});

test("checks durable webhook state once immediately before timing out", () => {
  const timeoutIndex = workflow.indexOf('code: "provider_timeout"');
  const webhookOnlyIndex = workflow.lastIndexOf(
    "webhookOnly: true",
    timeoutIndex,
  );
  const webhookOnlyCalls = workflow.match(/webhookOnly:\s*true/g);

  assert.ok(timeoutIndex >= 0, "workflow has an explicit timeout failure");
  assert.ok(
    webhookOnlyIndex >= 0 && webhookOnlyIndex < timeoutIndex,
    "durable webhook check happens immediately before timeout failure",
  );
  assert.equal(webhookOnlyCalls?.length, 1);
  assert.match(
    workflow.slice(webhookOnlyIndex, timeoutIndex),
    /selectVideoGenerationSettledStatus/,
  );
});

test("keeps control activities short and result materialization on the media queue", () => {
  assert.match(
    workflow,
    /const submitActivities[\s\S]*?startToCloseTimeout:\s*"10m"[\s\S]*?maximumAttempts:\s*3/,
  );
  assert.match(
    workflow,
    /const pollActivities[\s\S]*?startToCloseTimeout:\s*"2m"[\s\S]*?maximumAttempts:\s*3/,
  );
  assert.match(
    workflow,
    /const failActivities[\s\S]*?startToCloseTimeout:\s*"2m"[\s\S]*?maximumAttempts:\s*3/,
  );
  assert.match(
    workflow,
    /taskQueue:\s*input\.mediaTaskQueue[\s\S]*startToCloseTimeout:\s*"15m"[\s\S]*scheduleToCloseTimeout:\s*"30m"[\s\S]*initialInterval:\s*"5s"[\s\S]*backoffCoefficient:\s*2[\s\S]*maximumInterval:\s*"30s"/,
  );
  const finalizePolicy = workflow.slice(
    workflow.indexOf("const finalizeActivities"),
    workflow.indexOf("const videoGenerationFinalizeActivity"),
  );
  assert.doesNotMatch(finalizePolicy, /maximumAttempts/);
  assert.match(workflow, /providerStatus\s*===\s*"completed"/);
  assert.match(workflow, /videoGenerationFinalizeActivity/);
});

test("resume input bypasses the only provider submission call", () => {
  assert.match(
    workflow,
    /if\s*\(!input\.resume\)\s*\{[\s\S]*?await videoGenerationSubmitActivity\(input\)/,
  );
  assert.equal(
    workflow.match(/await videoGenerationSubmitActivity\(input\)/g)?.length,
    1,
  );
});

test("does not offer a paid rerun after result propagation retries are exhausted", () => {
  assert.match(
    workflow,
    /typedFailure\?\.code\s*===\s*"provider_result_not_ready"[\s\S]*?\?\s*false[\s\S]*?:\s*\(typedFailure\?\.retryable\s*\?\?\s*true\)/,
  );
});

test("continues long Higgsfield runs with bounded opaque state only", () => {
  assert.match(workflow, /continueAsNew/);
  assert.match(workflow, /continueAsNewEvery/);
  assert.match(workflow, /providerRequestId/);
  assert.match(workflow, /providerRequestLocator/);
  assert.match(workflow, /pollCount/);
  assert.match(workflow, /elapsedMs/);
  assert.match(
    workflow,
    /pollCount\s*%\s*policy\.continueAsNewEvery\s*===\s*0/,
  );
  assert.match(workflow, /pollCount\s*<\s*policy\.maxPolls/);
  assert.doesNotMatch(workflow, /videoBytes|signedUrl|providerPayload/);
});

test("registers the new workflow and activities without removing retained workflows", () => {
  assert.match(
    workflowIndex,
    /export\s*\{\s*videoGenerationWorkflow\s*\}\s*from\s*"\.\/video-generation"/,
  );
  assert.match(workflowIndex, /happyHorseVideoWorkflow/);
  assert.match(workflowIndex, /higgsfieldAssetGenerationWorkflow/);
  assert.match(worker, /VIDEO_GENERATION_SUBMIT_ACTIVITY/);
  assert.match(worker, /VIDEO_GENERATION_POLL_ACTIVITY/);
  assert.match(worker, /VIDEO_GENERATION_FAIL_ACTIVITY/);
  assert.match(worker, /VIDEO_GENERATION_FINALIZE_ACTIVITY/);
  assert.match(replayExport, /VIDEO_GENERATION_WORKFLOW/);
  assert.match(replayExport, /HAPPYHORSE_VIDEO_WORKFLOW/);
  assert.match(replayExport, /HIGGSFIELD_ASSET_GENERATION_WORKFLOW/);
});

test("finalization delegates probing, idempotent storage, and completion to the materializer", () => {
  assert.match(finalizer, /materializeVideoGenerationResult/);
  assert.match(finalizer, /loadFinalHappyHorseVideoResult/);
  assert.match(finalizer, /loadFinalHiggsfieldVideoResult/);
  assert.match(finalizer, /loadFinalGoogleVideoResult/);
  assert.doesNotMatch(finalizer, /arrayBuffer\(|Buffer\.from\(await/);
});

test("preserves bounded typed finalization failures across the activity boundary", () => {
  assert.match(workflow, /readVideoGenerationFinalizationFailure/);
  assert.match(
    workflow,
    /catch\s*\(error\)[\s\S]*?readVideoGenerationFinalizationFailure\(error\)[\s\S]*?providerCode:[\s\S]*?retryable:/,
  );
  assert.doesNotMatch(
    workflow,
    /message:\s*error\s+instanceof\s+Error\s*\?\s*error\.message/,
  );
});

test("maps an authoritative finalization NSFW failure to the NSFW terminal state", () => {
  const resolver = (finalizationFailures as Record<string, unknown>)
    .resolveVideoGenerationFinalizationTerminalStatus;

  assert.equal(typeof resolver, "function");
  assert.equal(
    (
      resolver as (
        failure: ReturnType<typeof readVideoGenerationFinalizationFailure>,
      ) => "failed" | "nsfw"
    )({
      contractVersion: 1,
      phase: "poll",
      code: "provider_nsfw",
      providerCode: "nsfw",
      message: "Provider result did not satisfy the completion contract",
      retryable: false,
    }),
    "nsfw",
  );
  assert.match(
    workflow,
    /terminalStatus:\s*resolveVideoGenerationFinalizationTerminalStatus\(typedFailure\)/,
  );
});

test("decodes only bounded typed finalization details from an activity cause", () => {
  assert.deepEqual(
    readVideoGenerationFinalizationFailure({
      cause: {
        type: VIDEO_GENERATION_FINALIZATION_FAILURE_TYPE,
        details: [
          {
            contractVersion: 1,
            phase: "download",
            code: "result_download_failed",
            providerCode: null,
            message: "Generated video could not be downloaded safely",
            retryable: true,
          },
        ],
      },
    }),
    {
      contractVersion: 1,
      phase: "download",
      code: "result_download_failed",
      providerCode: null,
      message: "Generated video could not be downloaded safely",
      retryable: true,
    },
  );
  assert.equal(
    readVideoGenerationFinalizationFailure({
      cause: {
        type: VIDEO_GENERATION_FINALIZATION_FAILURE_TYPE,
        details: [
          {
            contractVersion: 1,
            phase: "download",
            code: "bad code with spaces",
            providerCode: null,
            message: "https://signed.example/video?token=secret",
            retryable: true,
          },
        ],
      },
    }),
    null,
  );
});
