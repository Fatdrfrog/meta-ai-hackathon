import {
  assertContractVersion,
  CAMPAIGN_DELIVERY_DRAIN_ACTIVITY,
  CAMPAIGN_EXECUTION_FINALIZE_ACTIVITY,
  CAMPAIGN_EXECUTION_WORKFLOW,
  CAMPAIGN_EXECUTION_WORKFLOW_CONTRACT_VERSION,
  CAMPAIGN_NODE_RUN_ACTIVITY,
  CAMPAIGN_NODE_RUN_WORKFLOW_CONTRACT_VERSION,
  type CampaignDeliveryDrainInput,
  type CampaignDeliveryDrainResult,
  type CampaignExecutionFinalizeInput,
  type CampaignExecutionWorkflowInput,
  type CampaignExecutionWorkflowResult,
  type CampaignNodeRunActivityInput,
  type CampaignNodeRunActivityResult,
  type CampaignNodeRunWorkflowInput,
  type CampaignNodeRunWorkflowResult,
} from "@icecore/temporal";
import {
  ParentClosePolicy,
  TemporalFailure,
  proxyActivities,
  setWorkflowOptions,
  sleep,
  startChild,
} from "@temporalio/workflow";

const runActivities = proxyActivities<{
  [CAMPAIGN_NODE_RUN_ACTIVITY]: (
    input: CampaignNodeRunActivityInput,
  ) => Promise<CampaignNodeRunActivityResult>;
}>({
  startToCloseTimeout: "900s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "2s",
    backoffCoefficient: 2,
    maximumInterval: "60s",
  },
});

const executionActivities = proxyActivities<{
  [CAMPAIGN_DELIVERY_DRAIN_ACTIVITY]: (
    input: CampaignDeliveryDrainInput,
  ) => Promise<CampaignDeliveryDrainResult>;
  [CAMPAIGN_EXECUTION_FINALIZE_ACTIVITY]: (
    input: CampaignExecutionFinalizeInput,
  ) => Promise<void>;
}>({
  startToCloseTimeout: "300s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "2s",
    backoffCoefficient: 2,
    maximumInterval: "60s",
  },
});

const campaignNodeRunActivity = runActivities[CAMPAIGN_NODE_RUN_ACTIVITY] as (
  input: CampaignNodeRunActivityInput,
) => Promise<CampaignNodeRunActivityResult>;

const campaignDeliveryDrainActivity = executionActivities[
  CAMPAIGN_DELIVERY_DRAIN_ACTIVITY
] as (
  input: CampaignDeliveryDrainInput,
) => Promise<CampaignDeliveryDrainResult>;

const campaignExecutionFinalizeActivity = executionActivities[
  CAMPAIGN_EXECUTION_FINALIZE_ACTIVITY
] as (input: CampaignExecutionFinalizeInput) => Promise<void>;

function buildCampaignExecutionWorkflowId(params: {
  workspaceId: string;
  campaignId: string;
}) {
  return `campaign-execution:${params.workspaceId}:${params.campaignId}`;
}

function computeExecutionSleepMs(params: {
  nextDispatchAt?: string | null;
  delayMs: number;
}) {
  const delayMs = Math.max(1_000, Math.floor(params.delayMs || 0));
  const nextDispatchAtMs = params.nextDispatchAt
    ? Date.parse(params.nextDispatchAt)
    : Number.NaN;

  if (Number.isFinite(nextDispatchAtMs)) {
    const waitMs = nextDispatchAtMs - Date.now();
    if (waitMs > 0) {
      return waitMs;
    }
  }

  return delayMs;
}

function computeInitialScheduleDelayMs(scheduledAt?: string | null) {
  if (!scheduledAt) return 0;
  const scheduledAtMs = Date.parse(scheduledAt);
  if (!Number.isFinite(scheduledAtMs)) return 0;
  return Math.max(0, scheduledAtMs - Date.now());
}

export async function campaignExecutionWorkflow(
  input: CampaignExecutionWorkflowInput,
): Promise<CampaignExecutionWorkflowResult> {
  assertContractVersion(
    input.contractVersion,
    { max: CAMPAIGN_EXECUTION_WORKFLOW_CONTRACT_VERSION },
    "campaign execution workflow",
  );

  let processed = 0;
  let completed = 0;
  let retried = 0;
  let failedTerminal = 0;
  let skipped = 0;
  let recoveredStale = 0;
  let pendingCount = 0;
  let batchCount = 0;

  while (true) {
    const drainResult = await campaignDeliveryDrainActivity({
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      batchLimit: input.batchPlan.batchSize,
    });

    processed += drainResult.processed;
    completed += drainResult.completed;
    retried += drainResult.retried;
    failedTerminal += drainResult.failedTerminal;
    skipped += drainResult.skipped;
    recoveredStale += drainResult.recoveredStale;
    pendingCount = drainResult.pendingCount;
    batchCount += 1;

    if (pendingCount <= 0) {
      break;
    }

    await sleep(
      computeExecutionSleepMs({
        nextDispatchAt: drainResult.nextDispatchAt,
        delayMs: input.batchPlan.delayMs,
      }),
    );
  }

  await campaignExecutionFinalizeActivity({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
  });

  return {
    scenarioId: input.scenarioId,
    nodeId: input.nodeId,
    campaignId: input.campaignId,
    audienceSource: input.audienceSource,
    runKey: input.runKey,
    processed,
    completed,
    retried,
    failedTerminal,
    skipped,
    recoveredStale,
    pendingCount,
    batchCount,
  };
}

export async function campaignNodeRunWorkflow(
  input: CampaignNodeRunWorkflowInput,
): Promise<CampaignNodeRunWorkflowResult> {
  assertContractVersion(
    input.contractVersion,
    { max: CAMPAIGN_NODE_RUN_WORKFLOW_CONTRACT_VERSION },
    "campaign node run workflow",
  );

  const initialDelayMs = computeInitialScheduleDelayMs(input.scheduledAt);
  if (initialDelayMs > 0) {
    await sleep(initialDelayMs);
  }

  const materialized = await campaignNodeRunActivity(input);

  let executionWorkflowId: string | null = null;
  if (
    materialized.status === "materialized" &&
    materialized.campaignId &&
    materialized.batchPlan &&
    materialized.pendingCount > 0
  ) {
    executionWorkflowId = buildCampaignExecutionWorkflowId({
      workspaceId: input.workspaceId,
      campaignId: materialized.campaignId,
    });

    try {
      await startChild(CAMPAIGN_EXECUTION_WORKFLOW, {
        workflowId: executionWorkflowId,
        parentClosePolicy: ParentClosePolicy.ABANDON,
        args: [
          {
            contractVersion: CAMPAIGN_EXECUTION_WORKFLOW_CONTRACT_VERSION,
            workspaceId: input.workspaceId,
            scenarioId: input.scenarioId,
            nodeId: input.nodeId,
            campaignId: materialized.campaignId,
            batchPlan: materialized.batchPlan,
            audienceSource: materialized.audienceSource,
            runKey: materialized.runKey,
            scheduledFor: input.scheduledFor || input.scheduledAt || null,
          },
        ],
      });
    } catch (error) {
      // A retried or rescheduled occurrence shares the original campaign.
      // Its existing child continues to own that campaign's durable tasks.
      if (
        !(error instanceof TemporalFailure) ||
        error.name !== "WorkflowExecutionAlreadyStartedError" ||
        (error as { workflowId?: unknown }).workflowId !== executionWorkflowId
      )
        throw error;
    }
  }

  return {
    scenarioId: input.scenarioId,
    nodeId: input.nodeId,
    campaignId: materialized.campaignId || null,
    status: materialized.status,
    shadowMode: materialized.shadowMode,
    audienceSource: materialized.audienceSource,
    runKey: materialized.runKey,
    candidates: materialized.candidates,
    created: materialized.created,
    wouldCreate: materialized.wouldCreate,
    processed: 0,
    completed: 0,
    retried: 0,
    failedTerminal: 0,
    skipped: 0,
    pendingCount: materialized.pendingCount,
    batchCount: 0,
    executionWorkflowId,
    reason: materialized.reason,
  };
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  campaignExecutionWorkflow,
);
setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  campaignNodeRunWorkflow,
);
