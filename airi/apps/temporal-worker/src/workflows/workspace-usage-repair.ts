import {
  WORKSPACE_USAGE_REPAIR_ACTIVITY,
  type WorkspaceUsageRepairActivityInput,
  type WorkspaceUsageRepairWorkflowInput,
  type WorkspaceUsageRepairWorkflowResult,
} from "@icecore/temporal";
import { proxyActivities } from "@temporalio/workflow";

const activities = proxyActivities<{
  [WORKSPACE_USAGE_REPAIR_ACTIVITY]: (
    input: WorkspaceUsageRepairActivityInput,
  ) => Promise<WorkspaceUsageRepairWorkflowResult>;
}>({
  startToCloseTimeout: "30 minutes",
  retry: {
    maximumAttempts: 3,
  },
});

export async function workspaceUsageRepairWorkflow(
  input: WorkspaceUsageRepairWorkflowInput,
): Promise<WorkspaceUsageRepairWorkflowResult> {
  return activities[WORKSPACE_USAGE_REPAIR_ACTIVITY](input);
}
