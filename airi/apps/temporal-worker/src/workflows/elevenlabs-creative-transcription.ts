import {
  assertContractVersion,
  ELEVENLABS_CREATIVE_TRANSCRIPTION_COMPLETED_SIGNAL,
  ELEVENLABS_CREATIVE_TRANSCRIPTION_COMPLETE_ACTIVITY,
  ELEVENLABS_CREATIVE_TRANSCRIPTION_FAIL_ACTIVITY,
  ELEVENLABS_CREATIVE_TRANSCRIPTION_SUBMIT_ACTIVITY,
  ELEVENLABS_CREATIVE_TRANSCRIPTION_TIMEOUT_MS,
  ELEVENLABS_CREATIVE_TRANSCRIPTION_WORKFLOW_CONTRACT_VERSION,
  buildElevenLabsCreativeTranscriptionWorkflowId,
  type ElevenLabsCreativeTranscriptionActivityResult,
  type ElevenLabsCreativeTranscriptionCompletedSignalInput,
  type ElevenLabsCreativeTranscriptionCompleteActivityInput,
  type ElevenLabsCreativeTranscriptionFailActivityInput,
  type ElevenLabsCreativeTranscriptionSubmitActivityInput,
  type ElevenLabsCreativeTranscriptionSubmitActivityResult,
  type ElevenLabsCreativeTranscriptionWorkflowInput,
  type ElevenLabsCreativeTranscriptionWorkflowResult,
} from "@icecore/temporal";
import {
  ActivityFailure,
  ApplicationFailure,
  TimeoutFailure,
  condition,
  patched,
  defineSignal,
  proxyActivities,
  setHandler,
  setWorkflowOptions,
} from "@temporalio/workflow";

const transcriptionCompletedSignal = defineSignal<
  [ElevenLabsCreativeTranscriptionCompletedSignalInput]
>(ELEVENLABS_CREATIVE_TRANSCRIPTION_COMPLETED_SIGNAL);

const submitActivities = proxyActivities<{
  [ELEVENLABS_CREATIVE_TRANSCRIPTION_SUBMIT_ACTIVITY]: (
    input: ElevenLabsCreativeTranscriptionSubmitActivityInput,
  ) => Promise<ElevenLabsCreativeTranscriptionSubmitActivityResult>;
}>({
  startToCloseTimeout: "120s",
  retry: {
    maximumAttempts: 1,
  },
});

const terminalActivities = proxyActivities<{
  [ELEVENLABS_CREATIVE_TRANSCRIPTION_COMPLETE_ACTIVITY]: (
    input: ElevenLabsCreativeTranscriptionCompleteActivityInput,
  ) => Promise<ElevenLabsCreativeTranscriptionActivityResult>;
  [ELEVENLABS_CREATIVE_TRANSCRIPTION_FAIL_ACTIVITY]: (
    input: ElevenLabsCreativeTranscriptionFailActivityInput,
  ) => Promise<ElevenLabsCreativeTranscriptionActivityResult>;
}>({
  startToCloseTimeout: "900s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "10s",
    backoffCoefficient: 2,
    maximumInterval: "2m",
  },
});

const submitActivity = submitActivities[
  ELEVENLABS_CREATIVE_TRANSCRIPTION_SUBMIT_ACTIVITY
] as (
  input: ElevenLabsCreativeTranscriptionSubmitActivityInput,
) => Promise<ElevenLabsCreativeTranscriptionSubmitActivityResult>;

const completeActivity = terminalActivities[
  ELEVENLABS_CREATIVE_TRANSCRIPTION_COMPLETE_ACTIVITY
] as (
  input: ElevenLabsCreativeTranscriptionCompleteActivityInput,
) => Promise<ElevenLabsCreativeTranscriptionActivityResult>;

const failActivity = terminalActivities[
  ELEVENLABS_CREATIVE_TRANSCRIPTION_FAIL_ACTIVITY
] as (
  input: ElevenLabsCreativeTranscriptionFailActivityInput,
) => Promise<ElevenLabsCreativeTranscriptionActivityResult>;

function validateContractVersion(
  input: ElevenLabsCreativeTranscriptionWorkflowInput,
) {
  assertContractVersion(
    input.contractVersion,
    { exact: ELEVENLABS_CREATIVE_TRANSCRIPTION_WORKFLOW_CONTRACT_VERSION },
    "ElevenLabs creative transcription workflow",
  );
}

function findMatchingSignal(
  signals: ElevenLabsCreativeTranscriptionCompletedSignalInput[],
  requestId: string | undefined,
  mode: ElevenLabsCreativeTranscriptionWorkflowInput["mode"],
) {
  return signals.find((signal) =>
    requestId
      ? signal.requestId === requestId
      : signal.mode === mode && Boolean(signal.requestId),
  );
}

export async function elevenLabsCreativeTranscriptionWorkflow(
  input: ElevenLabsCreativeTranscriptionWorkflowInput,
): Promise<ElevenLabsCreativeTranscriptionWorkflowResult> {
  validateContractVersion(input);

  const workflowId = buildElevenLabsCreativeTranscriptionWorkflowId({
    assetId: input.assetId,
  });
  const signals: ElevenLabsCreativeTranscriptionCompletedSignalInput[] = [];
  setHandler(transcriptionCompletedSignal, (payload) => {
    const last = signals[signals.length - 1];
    if (
      last &&
      last.requestId === payload.requestId &&
      last.status === payload.status
    ) {
      signals[signals.length - 1] = payload;
      return;
    }
    signals.push(payload);
    if (signals.length > 20) {
      signals.splice(0, signals.length - 20);
    }
  });

  let submitted:
    | ElevenLabsCreativeTranscriptionSubmitActivityResult
    | undefined;
  try {
    submitted = await submitActivity({ ...input, workflowId });
  } catch (error) {
    const cause = error instanceof ActivityFailure ? error.cause : error;
    const outcomeUnknown =
      (cause instanceof ApplicationFailure &&
        cause.type === "ElevenLabsCreativeTranscriptionOutcomeUnknown") ||
      cause instanceof TimeoutFailure;
    if (
      !outcomeUnknown ||
      !patched("creative-transcription-await-unknown-v1")
    ) {
      return failActivity({
        ...input,
        workflowId,
        error:
          error instanceof Error
            ? error.message
            : "Failed to submit ElevenLabs transcription",
      });
    }
    // Authenticated provider metadata routes the late result to this asset's workflow.
    // Retain the existing deadline without issuing another paid submission.
  }

  if (submitted?.alreadyComplete) {
    return {
      assetId: input.assetId,
      status: "complete",
      providerRequestId: submitted.requestId,
      terminal: true,
    };
  }

  await condition(
    () =>
      Boolean(findMatchingSignal(signals, submitted?.requestId, input.mode)),
    ELEVENLABS_CREATIVE_TRANSCRIPTION_TIMEOUT_MS,
  );

  const signal = findMatchingSignal(signals, submitted?.requestId, input.mode);
  if (!signal) {
    return failActivity({
      ...input,
      workflowId,
      requestId: submitted?.requestId,
      error: "Timed out waiting for ElevenLabs transcription webhook",
    });
  }

  return completeActivity({
    ...input,
    workflowId,
    transcription: signal,
  });
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  elevenLabsCreativeTranscriptionWorkflow,
);
