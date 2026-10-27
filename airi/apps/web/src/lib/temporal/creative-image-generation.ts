import "server-only";

import {
  CREATIVE_IMAGE_GENERATION_TASK_QUEUE,
  CREATIVE_IMAGE_GENERATION_WORKFLOW,
  CREATIVE_IMAGE_GENERATION_WORKFLOW_CONTRACT_VERSION,
  buildCreativeImageGenerationWorkflowId,
  type CreativeImageGenerationWorkflowInput,
} from "@icecore/temporal";

import {
  requireTemporalConfigured,
  resolveTemporalMediaTaskQueue,
  startOrAttachWorkflow,
  type WorkflowStartResult,
} from "./workflow-start";

export type CreativeImageGenerationWorkflowStartResult = WorkflowStartResult;

export { isTemporalConfigured } from "./client";

export async function startCreativeImageGenerationWorkflow(
  input: Omit<CreativeImageGenerationWorkflowInput, "contractVersion">
): Promise<CreativeImageGenerationWorkflowStartResult> {
  requireTemporalConfigured(
    "Temporal is not configured for creative image generation"
  );
  const workflowInput: CreativeImageGenerationWorkflowInput = {
    contractVersion: CREATIVE_IMAGE_GENERATION_WORKFLOW_CONTRACT_VERSION,
    ...input,
  };
  return startOrAttachWorkflow({
    workflowType: CREATIVE_IMAGE_GENERATION_WORKFLOW,
    workflowId: buildCreativeImageGenerationWorkflowId({
      assetId: input.assetId,
    }),
    taskQueue: resolveTemporalMediaTaskQueue(
      CREATIVE_IMAGE_GENERATION_TASK_QUEUE
    ),
    args: [workflowInput],
    conflictPolicy: "USE_EXISTING",
  });
}
