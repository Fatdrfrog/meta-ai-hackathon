import "server-only";

import {
  CONVERSATION_MEDIA_ANALYSIS_TASK_QUEUE,
  CONVERSATION_MEDIA_ANALYSIS_TRIGGER_AIRI_SIGNAL,
  CONVERSATION_MEDIA_ANALYSIS_WORKFLOW,
  CONVERSATION_MEDIA_ANALYSIS_WORKFLOW_CONTRACT_VERSION,
  buildConversationMediaAnalysisWorkflowId,
  type ConversationMediaAnalysisWorkflowInput,
} from "@icecore/temporal";

import { getTemporalClient } from "./client";
import {
  requireTemporalConfigured,
  resolveTemporalMediaTaskQueue,
  startOrAttachWorkflow,
  type WorkflowStartResult,
} from "./workflow-start";

export { isTemporalConfigured } from "./client";

export type ConversationMediaAnalysisWorkflowStartResult = WorkflowStartResult;

const NOT_CONFIGURED_MESSAGE =
  "Temporal is not configured for conversation media analysis";

export async function startConversationMediaAnalysisWorkflow(
  input: Omit<ConversationMediaAnalysisWorkflowInput, "contractVersion">
): Promise<ConversationMediaAnalysisWorkflowStartResult> {
  requireTemporalConfigured(NOT_CONFIGURED_MESSAGE);
  const workflowInput: ConversationMediaAnalysisWorkflowInput = {
    contractVersion: CONVERSATION_MEDIA_ANALYSIS_WORKFLOW_CONTRACT_VERSION,
    ...input,
  };
  return startOrAttachWorkflow({
    workflowType: CONVERSATION_MEDIA_ANALYSIS_WORKFLOW,
    workflowId: buildConversationMediaAnalysisWorkflowId(input),
    taskQueue: resolveTemporalMediaTaskQueue(
      CONVERSATION_MEDIA_ANALYSIS_TASK_QUEUE
    ),
    args: [workflowInput],
    onDuplicate: async handle => {
      if (input.triggerAiriAfterAnalysis) {
        await handle.signal(CONVERSATION_MEDIA_ANALYSIS_TRIGGER_AIRI_SIGNAL);
      }
    },
  });
}

export async function signalConversationMediaAnalysisAiriTriggerWorkflow(input: {
  workflowId: string;
}): Promise<{ workflowId: string }> {
  requireTemporalConfigured(NOT_CONFIGURED_MESSAGE);

  const workflowId = input.workflowId.trim();
  if (!workflowId) {
    throw new Error("Conversation media workflow id is required");
  }

  const client = getTemporalClient();
  await client.workflow
    .getHandle(workflowId)
    .signal(CONVERSATION_MEDIA_ANALYSIS_TRIGGER_AIRI_SIGNAL);
  return { workflowId };
}
