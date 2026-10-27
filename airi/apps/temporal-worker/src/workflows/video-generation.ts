import {
  VIDEO_GENERATION_FAIL_ACTIVITY,
  VIDEO_GENERATION_FINALIZE_ACTIVITY,
  VIDEO_GENERATION_POLL_ACTIVITY,
  VIDEO_GENERATION_STATUS_SIGNAL,
  VIDEO_GENERATION_SUBMIT_ACTIVITY,
  VIDEO_GENERATION_WORKFLOW_CONTRACT_VERSION,
  MAX_VIDEO_GENERATION_COMPLETION_RESULT_ASSET_ID_LENGTH,
  MAX_VIDEO_GENERATION_COMPLETION_RESULT_ATTEMPT_TOKEN_LENGTH,
  isVideoGenerationCompletionCode,
  normalizeVideoGenerationCompletionResult,
  normalizeVideoGenerationCompletionTarget,
  resolveVideoGenerationPollPolicy,
  selectVideoGenerationSettledStatus,
  selectVideoGenerationTerminalStatus,
  type VideoGenerationActivityResult,
  type VideoGenerationCompletionResult,
  type VideoGenerationCompletionTarget,
  type VideoGenerationTerminalProviderStatus,
  type VideoGenerationStatusSignal,
  type VideoGenerationWorkflowInput,
} from "@icecore/temporal";
import {
  condition,
  continueAsNew,
  defineSignal,
  getExternalWorkflowHandle,
  patched,
  proxyActivities,
  setHandler,
  setWorkflowOptions,
} from "@temporalio/workflow";
import {
  readVideoGenerationFinalizationFailure,
  resolveVideoGenerationFinalizationTerminalStatus,
} from "../video-generation-finalization-failure";

const statusSignal = defineSignal<[VideoGenerationStatusSignal]>(
  VIDEO_GENERATION_STATUS_SIGNAL,
);

const submitActivities = proxyActivities<{
  [VIDEO_GENERATION_SUBMIT_ACTIVITY]: (
    input: VideoGenerationWorkflowInput,
  ) => Promise<VideoGenerationActivityResult>;
}>({
  startToCloseTimeout: "10m",
  retry: { maximumAttempts: 3 },
});

const pollActivities = proxyActivities<{
  [VIDEO_GENERATION_POLL_ACTIVITY]: (
    input: VideoGenerationWorkflowInput & {
      providerRequestId: string;
      providerRequestLocator: string;
      webhookOnly?: boolean;
    },
  ) => Promise<VideoGenerationActivityResult>;
}>({
  startToCloseTimeout: "2m",
  retry: { maximumAttempts: 3 },
});

const failActivities = proxyActivities<{
  [VIDEO_GENERATION_FAIL_ACTIVITY]: (
    input: VideoGenerationWorkflowInput & {
      providerRequestId: string | null;
      phase:
        | "validation"
        | "compile"
        | "submit"
        | "poll"
        | "download"
        | "probe"
        | "store";
      code: string;
      providerCode?: string | null;
      message: string;
      retryable: boolean;
      terminalStatus?: "failed" | "nsfw";
    },
  ) => Promise<VideoGenerationActivityResult>;
}>({
  startToCloseTimeout: "2m",
  retry: { maximumAttempts: 3 },
});

const videoGenerationSubmitActivity =
  submitActivities[VIDEO_GENERATION_SUBMIT_ACTIVITY];
const videoGenerationPollActivity =
  pollActivities[VIDEO_GENERATION_POLL_ACTIVITY];
const videoGenerationFailActivity =
  failActivities[VIDEO_GENERATION_FAIL_ACTIVITY];

const MAX_QUEUED_STATUS_SIGNALS = 20;

type FailureInput = Parameters<typeof videoGenerationFailActivity>[0];

function validateInput(
  input: VideoGenerationWorkflowInput,
): VideoGenerationCompletionTarget | null {
  if (input.contractVersion !== VIDEO_GENERATION_WORKFLOW_CONTRACT_VERSION) {
    throw new Error(
      `Unsupported video generation workflow contract: ${input.contractVersion}`,
    );
  }
  if (
    !input.workspaceId ||
    typeof input.assetId !== "string" ||
    !input.assetId ||
    input.assetId.trim() !== input.assetId ||
    input.assetId.length >
      MAX_VIDEO_GENERATION_COMPLETION_RESULT_ASSET_ID_LENGTH ||
    typeof input.attemptToken !== "string" ||
    !input.attemptToken ||
    input.attemptToken.trim() !== input.attemptToken ||
    input.attemptToken.length >
      MAX_VIDEO_GENERATION_COMPLETION_RESULT_ATTEMPT_TOKEN_LENGTH
  ) {
    throw new Error("Video generation workflow identity is incomplete");
  }
  if (
    typeof input.mediaTaskQueue !== "string" ||
    !input.mediaTaskQueue.trim() ||
    input.mediaTaskQueue.length > 256
  ) {
    throw new Error("Video generation media task queue is required");
  }
  if (input.resume) {
    const locator = input.resume.providerRequestLocator;
    if (
      typeof input.resume.providerRequestId !== "string" ||
      input.resume.providerRequestId.length < 1 ||
      input.resume.providerRequestId.length > 500 ||
      typeof locator !== "string" ||
      locator.length < 1 ||
      locator.length > 500 ||
      /:\/\/|[?#]/.test(locator) ||
      !Number.isSafeInteger(input.resume.pollCount) ||
      input.resume.pollCount < 0 ||
      !Number.isSafeInteger(input.resume.elapsedMs) ||
      input.resume.elapsedMs < 0
    ) {
      throw new Error("Video generation resume state is invalid");
    }
  }
  return normalizeVideoGenerationCompletionTarget(input.completionTarget);
}

function signalKey(signal: VideoGenerationStatusSignal): string {
  return `${signal.providerRequestId}:${signal.status}`;
}

function isBoundedSignal(
  input: VideoGenerationWorkflowInput,
  signal: VideoGenerationStatusSignal,
): boolean {
  return (
    Boolean(signal) &&
    signal.contractVersion === VIDEO_GENERATION_WORKFLOW_CONTRACT_VERSION &&
    signal.assetId === input.assetId &&
    typeof signal.providerRequestId === "string" &&
    signal.providerRequestId.length > 0 &&
    signal.providerRequestId.length <= 500 &&
    (signal.status === "queued" ||
      signal.status === "in_progress" ||
      signal.status === "completed" ||
      signal.status === "failed" ||
      signal.status === "nsfw" ||
      signal.status === "cancelled") &&
    typeof signal.receivedAt === "string" &&
    signal.receivedAt.length > 0 &&
    signal.receivedAt.length <= 64
  );
}

function providerFailure(status: VideoGenerationStatusSignal["status"]): {
  code: string;
  message: string;
  retryable: boolean;
  terminalStatus: "failed" | "nsfw";
} | null {
  if (status === "nsfw") {
    return {
      code: "provider_nsfw",
      message: "Provider rejected the video because of its safety policy",
      retryable: false,
      terminalStatus: "nsfw",
    };
  }
  if (status === "cancelled") {
    return {
      code: "provider_cancelled",
      message: "Provider cancelled the video generation",
      retryable: true,
      terminalStatus: "failed",
    };
  }
  if (status === "failed") {
    return {
      code: "provider_failed",
      message: "Provider failed the video generation",
      retryable: true,
      terminalStatus: "failed",
    };
  }
  return null;
}

type VideoGenerationWorkflowOutcome = {
  terminalResult: VideoGenerationActivityResult;
  codeHint: string | null;
};

function isDurableTerminalResult(
  input: VideoGenerationWorkflowInput,
  result: VideoGenerationActivityResult,
): boolean {
  return (
    result.contractVersion === VIDEO_GENERATION_WORKFLOW_CONTRACT_VERSION &&
    result.assetId === input.assetId &&
    result.attemptToken === input.attemptToken &&
    result.terminal === true &&
    (result.status === "complete" ||
      result.status === "failed" ||
      result.status === "nsfw")
  );
}

async function ensureDurableTerminalOutcome(
  input: VideoGenerationWorkflowInput,
  workflowOutcome: VideoGenerationWorkflowOutcome,
): Promise<VideoGenerationWorkflowOutcome> {
  if (isDurableTerminalResult(input, workflowOutcome.terminalResult)) {
    return workflowOutcome;
  }
  const terminalResult = await videoGenerationFailActivity({
    ...input,
    providerRequestId: workflowOutcome.terminalResult.providerRequestId,
    phase: "poll",
    code: "provider_protocol_error",
    message: "Provider returned an invalid terminal generation result",
    retryable: false,
    terminalStatus: "failed",
  });
  if (!isDurableTerminalResult(input, terminalResult)) {
    throw new Error(
      "Video generation terminal persistence returned an invalid result",
    );
  }
  return { terminalResult, codeHint: "provider_protocol_error" };
}

function safeCompletionCode(codeHint: string | null): string {
  return isVideoGenerationCompletionCode(codeHint)
    ? codeHint
    : "generation_failed";
}

function buildCompletionPayload(
  input: VideoGenerationWorkflowInput,
  target: VideoGenerationCompletionTarget,
  workflowOutcome: VideoGenerationWorkflowOutcome,
): VideoGenerationCompletionResult {
  const { terminalResult, codeHint } = workflowOutcome;
  if (terminalResult.status === "complete") {
    return normalizeVideoGenerationCompletionResult({
      contractVersion: 1,
      correlationId: target.correlationId,
      assetId: input.assetId,
      attemptToken: input.attemptToken,
      terminal: "complete",
      code: "generation_complete",
    });
  }
  if (terminalResult.status === "nsfw") {
    return normalizeVideoGenerationCompletionResult({
      contractVersion: 1,
      correlationId: target.correlationId,
      assetId: input.assetId,
      attemptToken: input.attemptToken,
      terminal: "unsafe",
      code: "provider_nsfw",
    });
  }
  if (terminalResult.status === "failed") {
    const timedOut = codeHint === "provider_timeout";
    return normalizeVideoGenerationCompletionResult({
      contractVersion: 1,
      correlationId: target.correlationId,
      assetId: input.assetId,
      attemptToken: input.attemptToken,
      terminal: timedOut ? "timeout" : "failed",
      code: timedOut ? "provider_timeout" : safeCompletionCode(codeHint),
    });
  }
  throw new Error("Video generation completion result is not terminal");
}

async function notifyVideoGenerationCompletion(
  input: VideoGenerationWorkflowInput,
  target: VideoGenerationCompletionTarget | null,
  workflowOutcome: VideoGenerationWorkflowOutcome,
): Promise<VideoGenerationActivityResult> {
  if (!target) return workflowOutcome.terminalResult;
  const settled = await ensureDurableTerminalOutcome(input, workflowOutcome);
  const terminalResult = settled.terminalResult;
  const payload = buildCompletionPayload(input, target, settled);
  await getExternalWorkflowHandle(target.workflowId).signal(
    target.signalName,
    payload,
  );
  return terminalResult;
}

async function runVideoGeneration(
  input: VideoGenerationWorkflowInput,
  recordFailureCode: (code: string) => void,
): Promise<VideoGenerationActivityResult> {
  const signals: VideoGenerationStatusSignal[] = [];
  const queuedSignalKeys = new Set<string>();
  const processedSignalKeys = new Set<string>();
  setHandler(statusSignal, (signal) => {
    if (!isBoundedSignal(input, signal)) return;
    const key = signalKey(signal);
    if (queuedSignalKeys.has(key) || processedSignalKeys.has(key)) return;
    if (signals.length >= MAX_QUEUED_STATUS_SIGNALS) {
      const removed = signals.shift();
      if (removed) queuedSignalKeys.delete(signalKey(removed));
    }
    signals.push(signal);
    queuedSignalKeys.add(key);
  });

  const finalizeActivities = proxyActivities<{
    [VIDEO_GENERATION_FINALIZE_ACTIVITY]: (input: {
      contractVersion: 1;
      workspaceId: string;
      assetId: string;
      attemptToken: string;
      providerRequestId: string;
      providerRequestLocator: string;
    }) => Promise<VideoGenerationActivityResult>;
  }>({
    taskQueue: input.mediaTaskQueue,
    startToCloseTimeout: "15m",
    scheduleToCloseTimeout: "30m",
    retry: {
      initialInterval: "5s",
      backoffCoefficient: 2,
      maximumInterval: "30s",
    },
  });
  const videoGenerationFinalizeActivity =
    finalizeActivities[VIDEO_GENERATION_FINALIZE_ACTIVITY];

  const fail = (
    failure: Omit<FailureInput, keyof VideoGenerationWorkflowInput>,
  ) => {
    recordFailureCode(failure.code);
    return videoGenerationFailActivity({ ...input, ...failure });
  };

  const policy = resolveVideoGenerationPollPolicy(input.spec?.provider);
  if (!policy) {
    return fail({
      providerRequestId: input.resume?.providerRequestId ?? null,
      phase: "validation",
      code: "unsupported_provider",
      message: "Video generation provider is unsupported",
      retryable: false,
      terminalStatus: "failed",
    });
  }

  const finalize = async (
    providerRequestId: string,
    providerRequestLocator: string,
  ): Promise<VideoGenerationActivityResult> => {
    try {
      return await videoGenerationFinalizeActivity({
        contractVersion: 1,
        workspaceId: input.workspaceId,
        assetId: input.assetId,
        attemptToken: input.attemptToken,
        providerRequestId,
        providerRequestLocator,
      });
    } catch (error) {
      const typedFailure = readVideoGenerationFinalizationFailure(error);
      return fail({
        providerRequestId,
        phase: typedFailure?.phase ?? "store",
        code: typedFailure?.code ?? "result_materialization_failed",
        providerCode: typedFailure?.providerCode ?? null,
        message:
          typedFailure?.message ??
          "Generated video could not be verified and stored",
        retryable:
          typedFailure?.code === "provider_result_not_ready"
            ? false
            : (typedFailure?.retryable ?? true),
        terminalStatus:
          resolveVideoGenerationFinalizationTerminalStatus(typedFailure),
      });
    }
  };

  let providerRequestId: string | null =
    input.resume?.providerRequestId ?? null;
  let providerRequestLocator: string | null =
    input.resume?.providerRequestLocator ?? null;
  let providerStatus: VideoGenerationActivityResult["providerStatus"] = null;

  if (!input.resume) {
    let submitted: VideoGenerationActivityResult;
    try {
      submitted = await videoGenerationSubmitActivity(input);
    } catch {
      return fail({
        providerRequestId: null,
        phase: "submit",
        code: "submit_activity_failed",
        message: "Video generation submission could not be completed",
        retryable: true,
        terminalStatus: "failed",
      });
    }
    if (submitted.status === "complete") return submitted;
    if (submitted.terminal) return submitted;
    providerRequestId = submitted.providerRequestId;
    providerRequestLocator = submitted.providerRequestLocator;
    providerStatus = submitted.providerStatus;
  }

  if (!providerRequestId || !providerRequestLocator) {
    return fail({
      providerRequestId,
      phase: "submit",
      code: "provider_protocol_error",
      message: "Provider did not return a usable request identity",
      retryable: false,
      terminalStatus: "failed",
    });
  }
  if (providerStatus === "completed") {
    return finalize(providerRequestId, providerRequestLocator);
  }

  let pollCount = input.resume?.pollCount ?? 0;
  const previousElapsedMs = input.resume?.elapsedMs ?? 0;
  const startedAt = Date.now() - previousElapsedMs;

  const drainMatchingSignals = (): VideoGenerationStatusSignal[] => {
    const matchingSignals = signals.filter(
      (signal) => signal.providerRequestId === providerRequestId,
    );
    if (matchingSignals.length === 0) return [];
    const retainedSignals = signals.filter(
      (signal) => signal.providerRequestId !== providerRequestId,
    );
    signals.splice(0, signals.length, ...retainedSignals);
    for (const signal of matchingSignals) {
      const key = signalKey(signal);
      queuedSignalKeys.delete(key);
      processedSignalKeys.add(key);
    }
    return matchingSignals;
  };

  const settleProviderStatus = (
    status: VideoGenerationTerminalProviderStatus,
  ): Promise<VideoGenerationActivityResult> => {
    if (status === "completed") {
      return finalize(providerRequestId, providerRequestLocator);
    }
    const failure = providerFailure(status);
    if (!failure) throw new Error("Unreachable nonterminal provider status");
    return fail({ providerRequestId, phase: "poll", ...failure });
  };

  for (;;) {
    const signaledStatus = selectVideoGenerationTerminalStatus(
      drainMatchingSignals().map((signal) => signal.status),
    );
    if (signaledStatus) {
      return settleProviderStatus(signaledStatus);
    }

    let elapsedMs = Date.now() - startedAt;
    if (pollCount >= policy.maxPolls || elapsedMs >= policy.deadlineMs) {
      let durableWebhookResult: VideoGenerationActivityResult | null = null;
      try {
        durableWebhookResult = await videoGenerationPollActivity({
          ...input,
          providerRequestId,
          providerRequestLocator,
          webhookOnly: true,
        });
      } catch {
        // Preserve the bounded timeout contract when the final recovery read fails.
      }
      const durableWebhookStatus = selectVideoGenerationSettledStatus({
        signalStatuses: drainMatchingSignals().map((signal) => signal.status),
        pollResult: durableWebhookResult,
      });
      if (durableWebhookStatus) {
        if (
          durableWebhookStatus === "completed" &&
          durableWebhookResult?.status === "complete"
        ) {
          return durableWebhookResult;
        }
        return settleProviderStatus(durableWebhookStatus);
      }
      return fail({
        providerRequestId,
        phase: "poll",
        code: "provider_timeout",
        message: "Video generation timed out before the provider completed it",
        retryable: true,
        terminalStatus: "failed",
      });
    }

    const waitMs = Math.max(
      1,
      Math.min(policy.intervalMs, policy.deadlineMs - elapsedMs),
    );
    const receivedSignal = await condition(
      () =>
        signals.some(
          (signal) => signal.providerRequestId === providerRequestId,
        ),
      waitMs,
    );
    if (receivedSignal) continue;

    elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= policy.deadlineMs) continue;

    let polled: VideoGenerationActivityResult | null = null;
    try {
      polled = await videoGenerationPollActivity({
        ...input,
        providerRequestId,
        providerRequestLocator,
      });
    } catch {
      // Retryable provider outages escape the poll activity after its bounded
      // retries. Keep the workflow open for webhook recovery and later polls.
    }

    const postPollSignalStatus = selectVideoGenerationSettledStatus({
      signalStatuses: drainMatchingSignals().map((signal) => signal.status),
      pollResult: polled,
    });
    if (postPollSignalStatus) {
      if (
        postPollSignalStatus === "completed" &&
        polled?.status === "complete"
      ) {
        return polled;
      }
      return settleProviderStatus(postPollSignalStatus);
    }

    if (!polled && !patched("video-poll-outage-recovery-v1")) {
      return fail({
        providerRequestId,
        phase: "poll",
        code: "provider_poll_failed",
        message: "Provider status could not be read after bounded retries",
        retryable: true,
        terminalStatus: "failed",
      });
    }
    pollCount += 1;

    if (polled?.terminal) {
      return fail({
        providerRequestId,
        phase: "poll",
        code:
          polled.status === "nsfw"
            ? "provider_nsfw"
            : "provider_protocol_error",
        message:
          polled.status === "nsfw"
            ? "Provider rejected the video because of its safety policy"
            : "Provider polling ended without a completed result",
        retryable: false,
        terminalStatus: polled.status === "nsfw" ? "nsfw" : "failed",
      });
    }

    elapsedMs = Date.now() - startedAt;
    if (
      policy.continueAsNewEvery &&
      pollCount < policy.maxPolls &&
      pollCount % policy.continueAsNewEvery === 0 &&
      elapsedMs < policy.deadlineMs &&
      !signals.some((signal) => signal.providerRequestId === providerRequestId)
    ) {
      await continueAsNew<typeof videoGenerationWorkflow>({
        ...input,
        resume: {
          providerRequestId,
          providerRequestLocator,
          pollCount,
          elapsedMs,
        },
      });
    }
  }
}

async function executeVideoGeneration(
  input: VideoGenerationWorkflowInput,
): Promise<VideoGenerationWorkflowOutcome> {
  let codeHint: string | null = null;
  const terminalResult = await runVideoGeneration(input, (code) => {
    codeHint = code;
  });
  return { terminalResult, codeHint };
}

export async function videoGenerationWorkflow(
  input: VideoGenerationWorkflowInput,
): Promise<VideoGenerationActivityResult> {
  const completionTarget = validateInput(input);
  const {
    completionTarget: _untrustedCompletionTarget,
    ...inputWithoutTarget
  } = input;
  const normalizedInput: VideoGenerationWorkflowInput = {
    ...inputWithoutTarget,
    ...(completionTarget ? { completionTarget } : {}),
  };
  const workflowOutcome = await executeVideoGeneration(normalizedInput);
  const terminalResult = await notifyVideoGenerationCompletion(
    normalizedInput,
    completionTarget,
    workflowOutcome,
  );
  return terminalResult;
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  videoGenerationWorkflow,
);
