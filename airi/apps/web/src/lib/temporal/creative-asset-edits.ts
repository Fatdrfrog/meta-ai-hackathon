import "server-only";

import {
  CREATIVE_ASSET_EDIT_TASK_QUEUE,
  CREATIVE_ASSET_EDIT_WORKFLOW,
  CREATIVE_ASSET_EDIT_WORKFLOW_CONTRACT_VERSION,
  buildCreativeAssetEditWorkflowId,
  type CreativeAssetEditWorkflowInput,
} from "@icecore/temporal";

import {
  requireTemporalConfigured,
  resolveTemporalMediaTaskQueue,
  startOrAttachWorkflow,
  type WorkflowStartResult,
} from "./workflow-start";

export { isTemporalConfigured } from "./client";

export type CreativeAssetEditWorkflowStartResult = WorkflowStartResult;

export async function startCreativeAssetEditWorkflow(
  input: Omit<CreativeAssetEditWorkflowInput, "contractVersion">
): Promise<CreativeAssetEditWorkflowStartResult> {
  requireTemporalConfigured(
    "Temporal is not configured for creative asset edits"
  );
  const workflowInput: CreativeAssetEditWorkflowInput = {
    contractVersion: CREATIVE_ASSET_EDIT_WORKFLOW_CONTRACT_VERSION,
    ...input,
  };
  return startOrAttachWorkflow({
    workflowType: CREATIVE_ASSET_EDIT_WORKFLOW,
    workflowId: buildCreativeAssetEditWorkflowId({
      outputAssetId: input.outputAssetId,
    }),
    taskQueue: resolveTemporalMediaTaskQueue(CREATIVE_ASSET_EDIT_TASK_QUEUE),
    args: [workflowInput],
  });
}
