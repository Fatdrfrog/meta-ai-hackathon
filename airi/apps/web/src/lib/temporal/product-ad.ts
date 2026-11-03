import "server-only";

import {
  PRODUCT_AD_TASK_QUEUE,
  PRODUCT_AD_WORKFLOW,
  PRODUCT_AD_WORKFLOW_CONTRACT_VERSION,
  buildProductAdWorkflowId,
  type ProductAdWorkflowInput,
} from "@icecore/temporal";

import {
  requireTemporalConfigured,
  resolveTemporalMediaTaskQueue,
  startOrAttachWorkflow,
  type WorkflowStartResult,
} from "./workflow-start";

/**
 * Starts one run of a video ad on the media queue: "make" for the first one
 * and a retry (it pays only for steps not saved yet), "render" after the
 * owner edits the words (no model calls). Each run has its own workflow id,
 * product-ad:<adId>:r<renderNo>; asking for one already running attaches.
 */
export async function startProductAdWorkflow(
  input: Omit<ProductAdWorkflowInput, "contractVersion">
): Promise<WorkflowStartResult> {
  requireTemporalConfigured("Temporal is not configured for product ads");
  const workflowInput: ProductAdWorkflowInput = {
    contractVersion: PRODUCT_AD_WORKFLOW_CONTRACT_VERSION,
    ...input,
  };
  return startOrAttachWorkflow({
    workflowType: PRODUCT_AD_WORKFLOW,
    workflowId: buildProductAdWorkflowId({
      adId: input.adId,
      renderNo: input.renderNo,
    }),
    taskQueue: resolveTemporalMediaTaskQueue(PRODUCT_AD_TASK_QUEUE),
    args: [workflowInput],
  });
}
