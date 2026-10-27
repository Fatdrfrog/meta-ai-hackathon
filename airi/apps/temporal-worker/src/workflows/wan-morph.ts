import {
  assertContractVersion,
  WAN_MORPH_ACTIVITY_CONTRACT_VERSION,
  WAN_MORPH_FAIL_ACTIVITY,
  WAN_MORPH_PROCESS_ACTIVITY,
  WAN_MORPH_WORKFLOW_CONTRACT_VERSION,
  type WanMorphActivityResult,
  type WanMorphFailActivityInput,
  type WanMorphProcessActivityInput,
  type WanMorphWorkflowInput,
  type WanMorphWorkflowResult,
} from "@icecore/temporal";
import { proxyActivities, setWorkflowOptions } from "@temporalio/workflow";

const wanMorphActivities = proxyActivities<{
  [WAN_MORPH_PROCESS_ACTIVITY]: (
    input: WanMorphProcessActivityInput,
  ) => Promise<WanMorphActivityResult>;
  [WAN_MORPH_FAIL_ACTIVITY]: (
    input: WanMorphFailActivityInput,
  ) => Promise<WanMorphActivityResult>;
}>({
  startToCloseTimeout: "1800s",
  scheduleToCloseTimeout: "3600s",
  heartbeatTimeout: "2m",
  retry: {
    maximumAttempts: 3,
    initialInterval: "15s",
    backoffCoefficient: 2,
    maximumInterval: "2m",
  },
});

const wanMorphProcessActivity = wanMorphActivities[
  WAN_MORPH_PROCESS_ACTIVITY
] as (
  input: WanMorphProcessActivityInput,
) => Promise<WanMorphActivityResult>;

const wanMorphFailActivity = wanMorphActivities[WAN_MORPH_FAIL_ACTIVITY] as (
  input: WanMorphFailActivityInput,
) => Promise<WanMorphActivityResult>;

function validateContractVersion(input: WanMorphWorkflowInput): void {
  assertContractVersion(
    input.contractVersion,
    { max: WAN_MORPH_WORKFLOW_CONTRACT_VERSION },
    "Wan morph workflow",
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
  return "Failed to generate Wan morph video";
}

export async function wanMorphWorkflow(
  input: WanMorphWorkflowInput,
): Promise<WanMorphWorkflowResult> {
  validateContractVersion(input);

  try {
    return await wanMorphProcessActivity({
      ...input,
      contractVersion: WAN_MORPH_ACTIVITY_CONTRACT_VERSION,
    });
  } catch (error) {
    return wanMorphFailActivity({
      contractVersion: WAN_MORPH_ACTIVITY_CONTRACT_VERSION,
      workspaceId: input.workspaceId,
      outputAssetId: input.outputAssetId,
      error: failureMessage(error),
    });
  }
}

setWorkflowOptions({ versioningBehavior: "AUTO_UPGRADE" }, wanMorphWorkflow);
