import {
  assertContractVersion,
  CONVERSATION_MEDIA_ANALYSIS_ACTIVITY,
  CONVERSATION_MEDIA_ANALYSIS_ACTIVITY_CONTRACT_VERSION,
  CONVERSATION_MEDIA_ANALYSIS_COMPLETE_ACTIVITY,
  CONVERSATION_MEDIA_ANALYSIS_FAIL_ACTIVITY,
  CONVERSATION_MEDIA_ANALYSIS_TRIGGER_AIRI_ACTIVITY,
  CONVERSATION_MEDIA_ANALYSIS_TRIGGER_AIRI_SIGNAL,
  CONVERSATION_MEDIA_TRANSCRIPTION_COMPLETED_SIGNAL,
  CONVERSATION_MEDIA_TRANSCRIPTION_TIMEOUT_MS,
  CONVERSATION_MEDIA_ANALYSIS_WORKFLOW_CONTRACT_VERSION,
  buildConversationMediaAnalysisWorkflowId,
  type ConversationMediaAnalysisCompleteActivityInput,
  type ConversationMediaAnalysisActivityInput,
  type ConversationMediaAnalysisActivityResult,
  type ConversationMediaAnalysisFailActivityInput,
  type ConversationMediaAnalysisTriggerAiriActivityInput,
  type ConversationMediaAnalysisTriggerAiriActivityResult,
  type ConversationMediaTranscriptionCompletedSignalInput,
  type ConversationMediaAnalysisWorkflowInput,
  type ConversationMediaAnalysisWorkflowResult,
} from "@icecore/temporal";
import {
  condition,
  defineSignal,
  patched,
  proxyActivities,
  setHandler,
  setWorkflowOptions,
} from "@temporalio/workflow";

const transcriptionCompletedSignal = defineSignal<
  [ConversationMediaTranscriptionCompletedSignalInput]
>(CONVERSATION_MEDIA_TRANSCRIPTION_COMPLETED_SIGNAL);
const triggerAiriSignal = defineSignal<[]>(
  CONVERSATION_MEDIA_ANALYSIS_TRIGGER_AIRI_SIGNAL,
);

const TRIGGER_AIRI_AFTER_MEDIA_ANALYSIS_PATCH =
  "conversation-media-trigger-airi-v1";

const activities = proxyActivities<{
  [CONVERSATION_MEDIA_ANALYSIS_ACTIVITY]: (
    input: ConversationMediaAnalysisActivityInput,
  ) => Promise<ConversationMediaAnalysisActivityResult>;
}>({
  startToCloseTimeout: "900s",
  scheduleToCloseTimeout: "900s",
  heartbeatTimeout: "60s",
  retry: {
    maximumAttempts: 1,
  },
});
const completeActivities = proxyActivities<{
  [CONVERSATION_MEDIA_ANALYSIS_COMPLETE_ACTIVITY]: (
    input: ConversationMediaAnalysisCompleteActivityInput,
  ) => Promise<ConversationMediaAnalysisActivityResult>;
}>({
  startToCloseTimeout: "900s",
  scheduleToCloseTimeout: "900s",
  heartbeatTimeout: "60s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "10s",
    backoffCoefficient: 2,
    maximumInterval: "60s",
  },
});
const failActivities = proxyActivities<{
  [CONVERSATION_MEDIA_ANALYSIS_FAIL_ACTIVITY]: (
    input: ConversationMediaAnalysisFailActivityInput,
  ) => Promise<ConversationMediaAnalysisActivityResult>;
}>({
  startToCloseTimeout: "60s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "5s",
    backoffCoefficient: 2,
    maximumInterval: "30s",
  },
});
const airiTriggerActivities = proxyActivities<{
  [CONVERSATION_MEDIA_ANALYSIS_TRIGGER_AIRI_ACTIVITY]: (
    input: ConversationMediaAnalysisTriggerAiriActivityInput,
  ) => Promise<ConversationMediaAnalysisTriggerAiriActivityResult>;
}>({
  startToCloseTimeout: "120s",
  retry: {
    maximumAttempts: 5,
    initialInterval: "2s",
    backoffCoefficient: 2,
    maximumInterval: "30s",
  },
});

const processConversationMediaAnalysis = activities[
  CONVERSATION_MEDIA_ANALYSIS_ACTIVITY
] as (
  input: ConversationMediaAnalysisActivityInput,
) => Promise<ConversationMediaAnalysisActivityResult>;
const completeConversationMediaAnalysis = completeActivities[
  CONVERSATION_MEDIA_ANALYSIS_COMPLETE_ACTIVITY
] as (
  input: ConversationMediaAnalysisCompleteActivityInput,
) => Promise<ConversationMediaAnalysisActivityResult>;
const failConversationMediaAnalysis = failActivities[
  CONVERSATION_MEDIA_ANALYSIS_FAIL_ACTIVITY
] as (
  input: ConversationMediaAnalysisFailActivityInput,
) => Promise<ConversationMediaAnalysisActivityResult>;
const triggerAiriAfterConversationMediaAnalysis = airiTriggerActivities[
  CONVERSATION_MEDIA_ANALYSIS_TRIGGER_AIRI_ACTIVITY
] as (
  input: ConversationMediaAnalysisTriggerAiriActivityInput,
) => Promise<ConversationMediaAnalysisTriggerAiriActivityResult>;

function failureMessage(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (current instanceof Error) {
      const message = current.message.trim();
      if (message && !/^Activity task failed/i.test(message)) {
        return message;
      }
      current = current.cause;
      continue;
    }
    if (typeof current === "string" && current.trim()) {
      return current.trim();
    }
    break;
  }
  return "Conversation media analysis failed";
}

function findMatchingTranscriptionEvent(
  events: ConversationMediaTranscriptionCompletedSignalInput[],
  providerRequestId?: string | null,
): ConversationMediaTranscriptionCompletedSignalInput | null {
  if (!events.length) return null;
  if (!providerRequestId) return events[0] || null;
  return events.find((event) => event.requestId === providerRequestId) || null;
}

export async function conversationMediaAnalysisWorkflow(
  input: ConversationMediaAnalysisWorkflowInput,
): Promise<ConversationMediaAnalysisWorkflowResult> {
  assertContractVersion(
    input.contractVersion,
    { exact: CONVERSATION_MEDIA_ANALYSIS_WORKFLOW_CONTRACT_VERSION },
    "conversation media analysis workflow",
  );

  let analysisCompleted = false;
  let triggerAiriAfterAnalysis = Boolean(input.triggerAiriAfterAnalysis);
  try {
    const transcriptionEvents: ConversationMediaTranscriptionCompletedSignalInput[] =
      [];
    setHandler(transcriptionCompletedSignal, (payload) => {
      const last = transcriptionEvents[transcriptionEvents.length - 1];
      if (
        last &&
        last.requestId === payload.requestId &&
        last.status === payload.status
      ) {
        transcriptionEvents[transcriptionEvents.length - 1] = payload;
        return;
      }
      transcriptionEvents.push(payload);
      if (transcriptionEvents.length > 20) {
        transcriptionEvents.splice(0, transcriptionEvents.length - 20);
      }
    });
    setHandler(triggerAiriSignal, () => {
      triggerAiriAfterAnalysis = true;
    });

    const start = await processConversationMediaAnalysis({
      ...input,
      contractVersion: CONVERSATION_MEDIA_ANALYSIS_ACTIVITY_CONTRACT_VERSION,
    });
    if (start.status !== "submitted") {
      analysisCompleted = start.status === "completed";
      if (
        triggerAiriAfterAnalysis &&
        analysisCompleted &&
        (start.transcriptStored || start.analysisStored) &&
        patched(TRIGGER_AIRI_AFTER_MEDIA_ANALYSIS_PATCH)
      ) {
        await triggerAiriAfterConversationMediaAnalysis({
          ...input,
          workflowId: buildConversationMediaAnalysisWorkflowId(input),
        });
      }
      return start;
    }

    const providerRequestId = start.providerRequestId || null;
    const signaled = await condition(
      () =>
        Boolean(
          findMatchingTranscriptionEvent(
            transcriptionEvents,
            providerRequestId,
          ),
        ),
      CONVERSATION_MEDIA_TRANSCRIPTION_TIMEOUT_MS,
    );

    if (!signaled) {
      return failConversationMediaAnalysis({
        ...input,
        workflowId: buildConversationMediaAnalysisWorkflowId(input),
        contractVersion: CONVERSATION_MEDIA_ANALYSIS_ACTIVITY_CONTRACT_VERSION,
        error: "Timed out waiting for ElevenLabs transcription webhook",
      });
    }

    const transcription = findMatchingTranscriptionEvent(
      transcriptionEvents,
      providerRequestId,
    );
    if (!transcription) {
      return failConversationMediaAnalysis({
        ...input,
        workflowId: buildConversationMediaAnalysisWorkflowId(input),
        contractVersion: CONVERSATION_MEDIA_ANALYSIS_ACTIVITY_CONTRACT_VERSION,
        error: "ElevenLabs transcription webhook was not found",
      });
    }

    const completed = await completeConversationMediaAnalysis({
      ...input,
      workflowId: buildConversationMediaAnalysisWorkflowId(input),
      contractVersion: CONVERSATION_MEDIA_ANALYSIS_ACTIVITY_CONTRACT_VERSION,
      transcription,
    });
    analysisCompleted = completed.status === "completed";
    if (
      triggerAiriAfterAnalysis &&
      analysisCompleted &&
      (completed.transcriptStored || completed.analysisStored) &&
      patched(TRIGGER_AIRI_AFTER_MEDIA_ANALYSIS_PATCH)
    ) {
      await triggerAiriAfterConversationMediaAnalysis({
        ...input,
        workflowId: buildConversationMediaAnalysisWorkflowId(input),
      });
    }
    return completed;
  } catch (error) {
    if (analysisCompleted) throw error;
    return failConversationMediaAnalysis({
      ...input,
      workflowId: buildConversationMediaAnalysisWorkflowId(input),
      contractVersion: CONVERSATION_MEDIA_ANALYSIS_ACTIVITY_CONTRACT_VERSION,
      error: failureMessage(error),
    });
  }
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  conversationMediaAnalysisWorkflow,
);
