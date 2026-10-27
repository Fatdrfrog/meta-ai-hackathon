import "server-only";

import {
  ELEVENLABS_CREATIVE_TRANSCRIPTION_TASK_QUEUE,
  ELEVENLABS_CREATIVE_TRANSCRIPTION_WORKFLOW,
  ELEVENLABS_CREATIVE_TRANSCRIPTION_WORKFLOW_CONTRACT_VERSION,
  buildElevenLabsCreativeTranscriptionWorkflowId,
  type ElevenLabsCreativeTranscriptionWorkflowInput,
} from "@icecore/temporal";

import {
  requireTemporalConfigured,
  resolveTemporalMediaTaskQueue,
  startOrAttachWorkflow,
  type WorkflowStartResult,
} from "./workflow-start";

export type ElevenLabsCreativeTranscriptionWorkflowStartResult =
  WorkflowStartResult;

export async function startElevenLabsCreativeTranscriptionWorkflow(
  input: Omit<ElevenLabsCreativeTranscriptionWorkflowInput, "contractVersion">
): Promise<ElevenLabsCreativeTranscriptionWorkflowStartResult> {
  requireTemporalConfigured(
    "Temporal is not configured for ElevenLabs creative transcription"
  );
  const workflowInput: ElevenLabsCreativeTranscriptionWorkflowInput = {
    contractVersion:
      ELEVENLABS_CREATIVE_TRANSCRIPTION_WORKFLOW_CONTRACT_VERSION,
    ...input,
  };
  return startOrAttachWorkflow({
    workflowType: ELEVENLABS_CREATIVE_TRANSCRIPTION_WORKFLOW,
    workflowId: buildElevenLabsCreativeTranscriptionWorkflowId({
      assetId: input.assetId,
    }),
    taskQueue: resolveTemporalMediaTaskQueue(
      ELEVENLABS_CREATIVE_TRANSCRIPTION_TASK_QUEUE
    ),
    args: [workflowInput],
    conflictPolicy: "USE_EXISTING",
  });
}
