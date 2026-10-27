import "server-only";

import {
  AIRI_COACH_WORKFLOW,
  AIRI_COACH_WORKFLOW_CONTRACT_VERSION,
  buildAiriCoachWorkflowId,
  type AiriCoachJobInput,
} from "@icecore/temporal";

import { getTemporalWebClientConfig } from "./client";
import {
  requireTemporalConfigured,
  startOrAttachWorkflow,
  type WorkflowStartResult,
} from "./workflow-start";

export { isTemporalConfigured } from "./client";

export type BackgroundWorkflowStartResult = WorkflowStartResult;

const NOT_CONFIGURED_MESSAGE = "Temporal is not configured for background jobs";

export async function startAiriCoachWorkflow(
  input: Omit<AiriCoachJobInput, "contractVersion">
): Promise<BackgroundWorkflowStartResult> {
  requireTemporalConfigured(NOT_CONFIGURED_MESSAGE);
  const workflowInput: AiriCoachJobInput = {
    contractVersion: AIRI_COACH_WORKFLOW_CONTRACT_VERSION,
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    agentId: input.agentId || null,
  };
  return startOrAttachWorkflow({
    workflowType: AIRI_COACH_WORKFLOW,
    workflowId: buildAiriCoachWorkflowId(input),
    taskQueue: getTemporalWebClientConfig().taskQueue,
    args: [workflowInput],
    conflictPolicy: "USE_EXISTING",
  });
}
