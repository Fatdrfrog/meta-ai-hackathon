import {
  assertContractVersion,
  CREATIVE_ASSET_EDIT_ACTIVITY_CONTRACT_VERSION,
  CREATIVE_ASSET_EDIT_WORKFLOW_CONTRACT_VERSION,
  CREATIVE_ASSET_FAIL_EDIT_ACTIVITY,
  CREATIVE_ASSET_PROCESS_EDIT_ACTIVITY,
  type CreativeAssetFailEditActivityInput,
  type CreativeAssetEditActivityInput,
  type CreativeAssetEditActivityResult,
  type CreativeAssetEditWorkflowInput,
  type CreativeAssetEditWorkflowResult,
} from "@icecore/temporal";
import { proxyActivities, setWorkflowOptions } from "@temporalio/workflow";

const creativeAssetEditActivities = proxyActivities<{
  [CREATIVE_ASSET_PROCESS_EDIT_ACTIVITY]: (
    input: CreativeAssetEditActivityInput,
  ) => Promise<CreativeAssetEditActivityResult>;
  [CREATIVE_ASSET_FAIL_EDIT_ACTIVITY]: (
    input: CreativeAssetFailEditActivityInput,
  ) => Promise<CreativeAssetEditActivityResult>;
}>({
  startToCloseTimeout: "10800s",
  scheduleToCloseTimeout: "32400s",
  heartbeatTimeout: "5m",
  retry: {
    maximumAttempts: 3,
    initialInterval: "15s",
    backoffCoefficient: 2,
    maximumInterval: "2m",
  },
});

const creativeAssetProcessEditActivity = creativeAssetEditActivities[
  CREATIVE_ASSET_PROCESS_EDIT_ACTIVITY
] as (
  input: CreativeAssetEditActivityInput,
) => Promise<CreativeAssetEditActivityResult>;

const creativeAssetFailEditActivity = creativeAssetEditActivities[
  CREATIVE_ASSET_FAIL_EDIT_ACTIVITY
] as (
  input: CreativeAssetFailEditActivityInput,
) => Promise<CreativeAssetEditActivityResult>;

function validateContractVersion(input: CreativeAssetEditWorkflowInput): void {
  assertContractVersion(
    input.contractVersion,
    { max: CREATIVE_ASSET_EDIT_WORKFLOW_CONTRACT_VERSION },
    "creative asset edit workflow",
  );
}

function failureMessage(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (current instanceof Error) {
      const message = current.message.trim();
      if (message && !/^Activity task failed/i.test(message)) {
        return message;
      }
      current = current.cause;
      continue;
    }
    if (typeof current === "string" && current.trim()) {
      return current.trim();
    }
    break;
  }
  return "Failed to process creative asset edit";
}

export async function creativeAssetEditWorkflow(
  input: CreativeAssetEditWorkflowInput,
): Promise<CreativeAssetEditWorkflowResult> {
  validateContractVersion(input);

  try {
    return await creativeAssetProcessEditActivity({
      ...input,
      contractVersion: CREATIVE_ASSET_EDIT_ACTIVITY_CONTRACT_VERSION,
    });
  } catch (error) {
    return creativeAssetFailEditActivity({
      contractVersion: CREATIVE_ASSET_EDIT_ACTIVITY_CONTRACT_VERSION,
      workspaceId: input.workspaceId,
      outputAssetId: input.outputAssetId,
      operation: input.operation,
      error: failureMessage(error),
    });
  }
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  creativeAssetEditWorkflow,
);
