import { loadBulkCampaignDispatchItemsSlice } from "@icecore/shared/lib/bulk-dispatch-payload-store";
import {
  beginBulkCampaignDispatch,
  dispatchBulkCampaignBatch,
  finalizeBulkCampaignDispatch,
  finalizeBulkCampaignDispatchLifecycle,
  updateBulkCampaignDispatchProgress,
} from "@icecore/airi-runtime";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import { activityInfo, ApplicationFailure } from "@temporalio/activity";
import type {
  BulkCampaignDispatchBatchResult,
  BulkCampaignDispatchBeginInput,
  BulkCampaignDispatchBeginResult,
  BulkCampaignDispatchFinalizeInput,
  BulkCampaignDispatchItem,
  BulkCampaignDispatchLifecycleFinalizeInput,
  BulkCampaignDispatchProgressInput,
  BulkCampaignDispatchSendBatchInput,
} from "@icecore/temporal";

import { isLegacyBulkCampaignActivityExpired } from "../legacy-bulk-campaign-expiry";

function requireWorkflowExecution() {
  const info = activityInfo();
  const workflowExecution = info.workflowExecution;
  if (!workflowExecution) {
    throw ApplicationFailure.nonRetryable(
      "Bulk campaign activities require a workflow execution",
      "MISSING_WORKFLOW_EXECUTION",
    );
  }
  return { info, workflowExecution };
}

export async function dispatchBulkCampaignBatchActivity(
  input: BulkCampaignDispatchSendBatchInput,
): Promise<BulkCampaignDispatchBatchResult> {
  const { info, workflowExecution } = requireWorkflowExecution();
  if (
    isLegacyBulkCampaignActivityExpired({
      lifecycleManaged: input.lifecycleManaged,
      scheduledTimestampMs: info.scheduledTimestampMs,
    })
  ) {
    throw ApplicationFailure.nonRetryable(
      "Legacy bulk campaign activity expired before dispatch",
      "LEGACY_BULK_CAMPAIGN_DISPATCH_EXPIRED",
    );
  }

  const items =
    input.mode === "inline"
      ? input.items
      : await loadBulkCampaignDispatchItemsSlice<BulkCampaignDispatchItem>({
          workspaceId: input.workspaceId,
          payloadKey: input.payloadKey,
          offset: input.offset,
          limit: input.limit,
        });

  const activityDedupePrefix = input.lifecycleManaged && input.batchKey
    ? `${workflowExecution.workflowId}:batch:${input.batchKey}`
    : `${workflowExecution.workflowId}:${workflowExecution.runId}:${info.activityId}`;

  airiWorkerLogger.info("airi.worker.bulk_campaign", {
    note: "dispatch_batch_start",
    outcome: "started",
    itemCount: items.length,
    channel: items[0]?.channel || null,
    campaignId: items[0]?.campaignId || null,
    workspaceId: items[0]?.workspaceId || null,
    snapshotOrdinal: Number.isInteger(items[0]?.snapshotOrdinal)
      ? items[0].snapshotOrdinal
      : null,
    source: input.mode,
    temporalWorkflowId: workflowExecution.workflowId,
    temporalRunId: workflowExecution.runId,
    temporalActivityId: info.activityId,
    nodeEnv: process.env.NODE_ENV || "development",
  });

  return dispatchBulkCampaignBatch(items, {
    activityDedupePrefix,
    temporalWorkflowId: workflowExecution.workflowId,
    temporalRunId: workflowExecution.runId,
    temporalActivityId: info.activityId,
    lifecycleManaged: input.lifecycleManaged === true,
    campaignId: input.lifecycleManaged === true ? input.campaignId : undefined,
  });
}

export async function beginBulkCampaignDispatchActivity(
  input: BulkCampaignDispatchBeginInput,
): Promise<BulkCampaignDispatchBeginResult> {
  const { workflowExecution } = requireWorkflowExecution();
  return beginBulkCampaignDispatch(
    input.campaignId,
    workflowExecution.workflowId,
  );
}

export async function updateBulkCampaignDispatchProgressActivity(
  input: BulkCampaignDispatchProgressInput,
): Promise<boolean> {
  return updateBulkCampaignDispatchProgress(input);
}

export async function finalizeBulkCampaignDispatchLifecycleActivity(
  input: BulkCampaignDispatchLifecycleFinalizeInput,
): Promise<void> {
  await finalizeBulkCampaignDispatchLifecycle(input);
}

export async function finalizeBulkCampaignDispatchActivity(
  input: BulkCampaignDispatchFinalizeInput,
): Promise<void> {
  const { info, workflowExecution } = requireWorkflowExecution();
  airiWorkerLogger.info("airi.worker.bulk_campaign", {
    note: "finalize_dispatch",
    outcome: "started",
    campaignId: input.campaignId,
    successfulSends: input.successfulSends,
    failedSends: input.failedSends,
    temporalWorkflowId: workflowExecution.workflowId,
    temporalRunId: workflowExecution.runId,
    temporalActivityId: info.activityId,
    nodeEnv: process.env.NODE_ENV || "development",
  });

  await finalizeBulkCampaignDispatch(input);
}
