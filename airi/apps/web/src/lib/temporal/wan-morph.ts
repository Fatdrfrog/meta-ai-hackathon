import "server-only";

import {
  WAN_MORPH_TASK_QUEUE,
  WAN_MORPH_WORKFLOW,
  WAN_MORPH_WORKFLOW_CONTRACT_VERSION,
  buildWanMorphWorkflowId,
  type WanMorphWorkflowInput,
} from "@icecore/temporal";

import { isTemporalConfigured } from "./client";
import {
  requireTemporalConfigured,
  resolveTemporalMediaTaskQueue,
  startOrAttachWorkflow,
  type WorkflowStartResult,
} from "./workflow-start";

export type WanMorphWorkflowStartResult = WorkflowStartResult;

export async function startWanMorphWorkflow(
  input: Omit<WanMorphWorkflowInput, "contractVersion">
): Promise<WanMorphWorkflowStartResult> {
  requireTemporalConfigured("Temporal is not configured for Wan morph video");
  const workflowInput: WanMorphWorkflowInput = {
    contractVersion: WAN_MORPH_WORKFLOW_CONTRACT_VERSION,
    ...input,
  };
  return startOrAttachWorkflow({
    workflowType: WAN_MORPH_WORKFLOW,
    workflowId: buildWanMorphWorkflowId({ outputAssetId: input.outputAssetId }),
    taskQueue: resolveTemporalMediaTaskQueue(WAN_MORPH_TASK_QUEUE),
    args: [workflowInput],
  });
}

export { isTemporalConfigured };
