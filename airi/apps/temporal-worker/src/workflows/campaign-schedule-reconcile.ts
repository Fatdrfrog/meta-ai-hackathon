import {
  assertContractVersion,
  CAMPAIGN_SCHEDULE_RECONCILE_ACTIVITY,
  CAMPAIGN_SCHEDULE_RECONCILE_WORKFLOW_CONTRACT_VERSION,
  type CampaignScheduleReconcileWorkflowInput,
  type CampaignScheduleReconcileWorkflowResult,
} from "@icecore/temporal";
import { proxyActivities, setWorkflowOptions } from "@temporalio/workflow";

const activities = proxyActivities<{
  [CAMPAIGN_SCHEDULE_RECONCILE_ACTIVITY]: (
    input: CampaignScheduleReconcileWorkflowInput,
  ) => Promise<CampaignScheduleReconcileWorkflowResult>;
}>({
  startToCloseTimeout: "300s",
  retry: {
    maximumAttempts: 5,
    initialInterval: "2s",
    backoffCoefficient: 2,
    maximumInterval: "120s",
  },
});

const reconcileActivity = activities[CAMPAIGN_SCHEDULE_RECONCILE_ACTIVITY];

export async function campaignScheduleReconcileWorkflow(
  input: CampaignScheduleReconcileWorkflowInput,
): Promise<CampaignScheduleReconcileWorkflowResult> {
  assertContractVersion(
    input.contractVersion,
    { max: CAMPAIGN_SCHEDULE_RECONCILE_WORKFLOW_CONTRACT_VERSION },
    "campaign schedule reconcile workflow",
  );

  return reconcileActivity({
    contractVersion: input.contractVersion,
    workspaceId: input.workspaceId,
    scenarioId: input.scenarioId,
  });
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  campaignScheduleReconcileWorkflow,
);
