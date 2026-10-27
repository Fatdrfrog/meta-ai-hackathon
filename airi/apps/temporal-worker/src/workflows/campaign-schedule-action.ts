import {
  assertContractVersion,
  CAMPAIGN_NODE_RUN_WORKFLOW,
  CAMPAIGN_NODE_RUN_WORKFLOW_CONTRACT_VERSION,
  CAMPAIGN_SCHEDULE_ACTION_CLAIM_ACTIVITY,
  CAMPAIGN_SCHEDULE_ACTION_COMPLETE_ACTIVITY,
  CAMPAIGN_SCHEDULE_ACTION_WORKFLOW_CONTRACT_VERSION,
  TEMPORAL_SCHEDULED_START_TIME_SEARCH_ATTRIBUTE,
  buildCampaignNodeScheduledOccurrenceWorkflowId,
  type CampaignNodeRunWorkflowInput,
  type CampaignScheduleActionClaimActivityInput,
  type CampaignScheduleActionClaimActivityResult,
  type CampaignScheduleActionCompleteActivityInput,
  type CampaignScheduleActionWorkflowInput,
  type CampaignScheduleActionWorkflowResult,
} from "@icecore/temporal";
import {
  ParentClosePolicy,
  proxyActivities,
  setWorkflowOptions,
  startChild,
  workflowInfo,
} from "@temporalio/workflow";

const scheduleActionActivities = proxyActivities<{
  [CAMPAIGN_SCHEDULE_ACTION_CLAIM_ACTIVITY]: (
    input: CampaignScheduleActionClaimActivityInput,
  ) => Promise<CampaignScheduleActionClaimActivityResult>;
  [CAMPAIGN_SCHEDULE_ACTION_COMPLETE_ACTIVITY]: (
    input: CampaignScheduleActionCompleteActivityInput,
  ) => Promise<void>;
}>({
  startToCloseTimeout: "60s",
  retry: {
    maximumAttempts: 12,
    initialInterval: "5s",
    backoffCoefficient: 2,
    maximumInterval: "5m",
  },
});

const campaignScheduleActionClaimActivity = scheduleActionActivities[
  CAMPAIGN_SCHEDULE_ACTION_CLAIM_ACTIVITY
] as (
  input: CampaignScheduleActionClaimActivityInput,
) => Promise<CampaignScheduleActionClaimActivityResult>;

const campaignScheduleActionCompleteActivity = scheduleActionActivities[
  CAMPAIGN_SCHEDULE_ACTION_COMPLETE_ACTIVITY
] as (input: CampaignScheduleActionCompleteActivityInput) => Promise<void>;

function normalizeTemporalSearchAttributeDate(value: unknown): string | null {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string" || typeof value === "number"
        ? new Date(value)
        : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function resolveScheduledForFromSearchAttributes(
  info: ReturnType<typeof workflowInfo>,
): string | null {
  const value =
    info.searchAttributes[TEMPORAL_SCHEDULED_START_TIME_SEARCH_ATTRIBUTE];
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = normalizeTemporalSearchAttributeDate(item);
      if (normalized) return normalized;
    }
    return null;
  }
  return normalizeTemporalSearchAttributeDate(value);
}

export async function campaignScheduleActionWorkflow(
  input: CampaignScheduleActionWorkflowInput,
): Promise<CampaignScheduleActionWorkflowResult> {
  assertContractVersion(
    input.contractVersion,
    { max: CAMPAIGN_SCHEDULE_ACTION_WORKFLOW_CONTRACT_VERSION },
    "campaign schedule action workflow",
  );

  const info = workflowInfo();
  const claim = await campaignScheduleActionClaimActivity({
    ...input,
    actionWorkflowId: info.workflowId,
    actionWorkflowRunId: info.runId,
    actionFirstExecutionRunId: info.firstExecutionRunId,
    scheduledFor: resolveScheduledForFromSearchAttributes(info),
    actionRunStartedAt: info.runStartTime.toISOString(),
  });

  if (claim.status === "duplicate" && claim.existingChildWorkflowId) {
    return {
      status: "duplicate",
      scheduleId: input.scheduleId,
      scheduledFor: claim.scheduledFor,
      childWorkflowId: claim.existingChildWorkflowId,
    };
  }

  const childWorkflowId = buildCampaignNodeScheduledOccurrenceWorkflowId({
    workspaceId: input.workspaceId,
    scenarioId: input.scenarioId,
    nodeId: input.nodeId,
    scheduledFor: claim.scheduledFor,
  });

  await startChild(CAMPAIGN_NODE_RUN_WORKFLOW, {
    workflowId: childWorkflowId,
    parentClosePolicy: ParentClosePolicy.ABANDON,
    args: [
      {
        contractVersion: CAMPAIGN_NODE_RUN_WORKFLOW_CONTRACT_VERSION,
        workspaceId: input.workspaceId,
        scenarioId: input.scenarioId,
        nodeId: input.nodeId,
        scheduleId: input.scheduleId,
        scheduledFor: claim.scheduledFor,
        executionSource: "scenario_schedule",
      } satisfies CampaignNodeRunWorkflowInput,
    ],
  });

  await campaignScheduleActionCompleteActivity({
    ...input,
    scheduledFor: claim.scheduledFor,
    actionWorkflowId: info.workflowId,
    actionWorkflowRunId: info.runId,
    childWorkflowId,
  });

  return {
    status: "started",
    scheduleId: input.scheduleId,
    scheduledFor: claim.scheduledFor,
    childWorkflowId,
  };
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  campaignScheduleActionWorkflow,
);
