import {
  BULK_CAMPAIGN_DISPATCH_PAUSE_SIGNAL,
  BULK_CAMPAIGN_DISPATCH_PAUSE_WAIT_QUERY,
  BULK_CAMPAIGN_DISPATCH_PAUSED_QUERY,
  BULK_CAMPAIGN_DISPATCH_WORKFLOW,
  BULK_CAMPAIGN_DISPATCH_WORKFLOW_CONTRACT_VERSION,
  buildBulkCampaignDispatchWorkflowId,
  type BulkCampaignDispatchWorkflowInput,
} from "@icecore/temporal";

import { getTemporalClient, getTemporalWebClientConfig } from "./client";
import { isTemporalSdkError } from "./sdk";

type BulkCampaignDispatchStartInput = Omit<
  BulkCampaignDispatchWorkflowInput,
  | "contractVersion"
  | "lifecycleManaged"
  | "campaignId"
  | "requestedAt"
  | "dispatchExpiresAt"
> & {
  lifecycleManaged: true;
  campaignId: string;
  requestedAt: string;
  dispatchExpiresAt: string;
};

export async function startBulkCampaignDispatchWorkflow(
  input: BulkCampaignDispatchStartInput
) {
  const client = getTemporalClient();
  const config = getTemporalWebClientConfig();
  const workflowId = buildBulkCampaignDispatchWorkflowId({
    workspaceId: input.workspaceId,
    executionId: input.campaignId,
  });

  return client.workflow.start(BULK_CAMPAIGN_DISPATCH_WORKFLOW, {
    workflowId,
    workflowIdReusePolicy: "REJECT_DUPLICATE",
    taskQueue: config.taskQueue,
    args: [
      {
        contractVersion: BULK_CAMPAIGN_DISPATCH_WORKFLOW_CONTRACT_VERSION,
        ...input,
      },
    ],
  });
}

export type BulkCampaignWorkflowCancellationResult = {
  outcome: "cancelled" | "already_closed";
};

export async function cancelBulkCampaignDispatchWorkflow(
  workflowId: string
): Promise<BulkCampaignWorkflowCancellationResult> {
  const handle = getTemporalClient().workflow.getHandle(workflowId);

  try {
    await handle.cancel();
    return { outcome: "cancelled" };
  } catch (error) {
    if (isTemporalSdkError(error, "WorkflowNotFoundError")) {
      return { outcome: "already_closed" };
    }
    throw error;
  }
}

export type BulkCampaignWorkflowPauseResult = {
  paused: boolean;
};

export class BulkCampaignPauseUnsupportedError extends Error {
  constructor(message = "This campaign workflow does not support pause yet.") {
    super(message);
    this.name = "BulkCampaignPauseUnsupportedError";
  }
}

export async function signalBulkCampaignDispatchPause(params: {
  workflowId: string;
  paused: boolean;
}): Promise<BulkCampaignWorkflowPauseResult> {
  const handle = getTemporalClient().workflow.getHandle(params.workflowId);
  const pauseWaitSupported = await handle.query<boolean>(
    BULK_CAMPAIGN_DISPATCH_PAUSE_WAIT_QUERY
  );
  if (pauseWaitSupported !== true) {
    throw new BulkCampaignPauseUnsupportedError();
  }
  await handle.signal(BULK_CAMPAIGN_DISPATCH_PAUSE_SIGNAL, params.paused);
  const paused = await handle.query<boolean>(
    BULK_CAMPAIGN_DISPATCH_PAUSED_QUERY
  );
  if (typeof paused !== "boolean") {
    throw new Error("Bulk campaign pause query returned a non-boolean");
  }
  return { paused };
}

export function isBulkCampaignPauseUnsupportedError(error: unknown) {
  return (
    isTemporalSdkError(error, "QueryNotRegisteredError") ||
    error instanceof BulkCampaignPauseUnsupportedError
  );
}
