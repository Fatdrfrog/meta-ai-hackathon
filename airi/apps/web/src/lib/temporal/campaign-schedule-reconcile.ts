import { randomUUID } from "node:crypto";

import {
  CAMPAIGN_SCHEDULE_RECONCILE_WORKFLOW,
  CAMPAIGN_SCHEDULE_RECONCILE_WORKFLOW_CONTRACT_VERSION,
  sanitizeTemporalWorkflowIdPart,
} from "@icecore/temporal";
import type { CampaignScheduleReconcileWorkflowInput } from "@icecore/scenario-contracts";

import { getTemporalClient, getTemporalWebClientConfig } from "./client";

export function buildCampaignScheduleReconcileWorkflowId(params: {
  workspaceId: string;
  scenarioId: string;
}): string {
  const workspaceId = sanitizeTemporalWorkflowIdPart(
    params.workspaceId || "workspace"
  );
  const scenarioId = sanitizeTemporalWorkflowIdPart(
    params.scenarioId || "scenario"
  );
  const runId = sanitizeTemporalWorkflowIdPart(randomUUID());
  return `campaign-schedule-reconcile:${workspaceId}:${scenarioId}:${runId}`;
}

export async function startCampaignScheduleReconcileWorkflow(
  input: Omit<CampaignScheduleReconcileWorkflowInput, "contractVersion">
) {
  const client = getTemporalClient();
  const config = getTemporalWebClientConfig();
  const workflowId = buildCampaignScheduleReconcileWorkflowId({
    workspaceId: input.workspaceId,
    scenarioId: input.scenarioId,
  });

  return client.workflow.start(CAMPAIGN_SCHEDULE_RECONCILE_WORKFLOW, {
    workflowId,
    taskQueue: config.taskQueue,
    args: [
      {
        contractVersion: CAMPAIGN_SCHEDULE_RECONCILE_WORKFLOW_CONTRACT_VERSION,
        workspaceId: input.workspaceId,
        scenarioId: input.scenarioId,
      } satisfies CampaignScheduleReconcileWorkflowInput,
    ],
  });
}
