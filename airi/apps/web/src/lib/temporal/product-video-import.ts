import "server-only";

import {
  PRODUCT_VIDEO_IMPORT_TASK_QUEUE,
  PRODUCT_VIDEO_IMPORT_WORKFLOW,
  PRODUCT_VIDEO_IMPORT_WORKFLOW_CONTRACT_VERSION,
  buildProductVideoImportWorkflowId,
  type ProductVideoImportWorkflowInput,
} from "@icecore/temporal";

import {
  requireTemporalConfigured,
  resolveTemporalMediaTaskQueue,
  startOrAttachWorkflow,
  type WorkflowStartResult,
} from "./workflow-start";

export async function startProductVideoImportWorkflow(
  input: Omit<ProductVideoImportWorkflowInput, "contractVersion">
): Promise<WorkflowStartResult> {
  requireTemporalConfigured(
    "Temporal is not configured for product video imports"
  );
  const workflowInput: ProductVideoImportWorkflowInput = {
    contractVersion: PRODUCT_VIDEO_IMPORT_WORKFLOW_CONTRACT_VERSION,
    ...input,
  };
  return startOrAttachWorkflow({
    workflowType: PRODUCT_VIDEO_IMPORT_WORKFLOW,
    workflowId: buildProductVideoImportWorkflowId({ importId: input.importId }),
    taskQueue: resolveTemporalMediaTaskQueue(PRODUCT_VIDEO_IMPORT_TASK_QUEUE),
    args: [workflowInput],
  });
}
