import "server-only";

import {
  HIGGSFIELD_ASSET_GENERATION_WORKFLOW,
  HIGGSFIELD_ASSET_GENERATION_WORKFLOW_CONTRACT_VERSION,
  HIGGSFIELD_GENERATION_WEBHOOK_SIGNAL,
  buildHiggsfieldAssetGenerationWorkflowId,
  type HiggsfieldAssetGenerationWebhookSignalInput,
  type HiggsfieldAssetGenerationWorkflowInput,
} from "@icecore/temporal";

import { getTemporalClient, getTemporalWebClientConfig } from "./client";
import {
  requireTemporalConfigured,
  startOrAttachWorkflow,
  type WorkflowStartResult,
} from "./workflow-start";

export { isTemporalConfigured } from "./client";

export type HiggsfieldAssetWorkflowStartResult = WorkflowStartResult;

const NOT_CONFIGURED_MESSAGE =
  "Temporal is not configured for Higgsfield generation";

export async function startHiggsfieldAssetGenerationWorkflow(
  input: Omit<HiggsfieldAssetGenerationWorkflowInput, "contractVersion">
): Promise<HiggsfieldAssetWorkflowStartResult> {
  requireTemporalConfigured(NOT_CONFIGURED_MESSAGE);
  const workflowInput: HiggsfieldAssetGenerationWorkflowInput = {
    contractVersion: HIGGSFIELD_ASSET_GENERATION_WORKFLOW_CONTRACT_VERSION,
    ...input,
  };
  return startOrAttachWorkflow({
    workflowType: HIGGSFIELD_ASSET_GENERATION_WORKFLOW,
    workflowId: buildHiggsfieldAssetGenerationWorkflowId({
      assetId: input.assetId,
    }),
    taskQueue: getTemporalWebClientConfig().taskQueue,
    args: [workflowInput],
    conflictPolicy: "USE_EXISTING",
  });
}

export async function signalHiggsfieldAssetGenerationWorkflow(input: {
  assetId: string;
  webhook: HiggsfieldAssetGenerationWebhookSignalInput;
}): Promise<{ workflowId: string }> {
  requireTemporalConfigured(NOT_CONFIGURED_MESSAGE);

  const client = getTemporalClient();
  const workflowId = buildHiggsfieldAssetGenerationWorkflowId({
    assetId: input.assetId,
  });
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal(HIGGSFIELD_GENERATION_WEBHOOK_SIGNAL, input.webhook);
  return { workflowId };
}
