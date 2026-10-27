import {
  assertContractVersion,
  WAN_AVATAR_ACTIVITY_CONTRACT_VERSION,
  WAN_AVATAR_FAIL_ACTIVITY,
  WAN_AVATAR_PROCESS_ACTIVITY,
  WAN_AVATAR_WORKFLOW_CONTRACT_VERSION,
  type WanAvatarActivityResult,
  type WanAvatarFailActivityInput,
  type WanAvatarProcessActivityInput,
  type WanAvatarWorkflowInput,
  type WanAvatarWorkflowResult,
} from "@icecore/temporal";
import { proxyActivities, setWorkflowOptions } from "@temporalio/workflow";

const wanAvatarActivities = proxyActivities<{
  [WAN_AVATAR_PROCESS_ACTIVITY]: (
    input: WanAvatarProcessActivityInput,
  ) => Promise<WanAvatarActivityResult>;
  [WAN_AVATAR_FAIL_ACTIVITY]: (
    input: WanAvatarFailActivityInput,
  ) => Promise<WanAvatarActivityResult>;
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

const wanAvatarProcessActivity = wanAvatarActivities[
  WAN_AVATAR_PROCESS_ACTIVITY
] as (
  input: WanAvatarProcessActivityInput,
) => Promise<WanAvatarActivityResult>;

const wanAvatarFailActivity = wanAvatarActivities[WAN_AVATAR_FAIL_ACTIVITY] as (
  input: WanAvatarFailActivityInput,
) => Promise<WanAvatarActivityResult>;

function validateContractVersion(input: WanAvatarWorkflowInput): void {
  assertContractVersion(
    input.contractVersion,
    { max: WAN_AVATAR_WORKFLOW_CONTRACT_VERSION },
    "Wan avatar workflow",
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
  return "Failed to generate Wan talking avatar";
}

export async function wanAvatarWorkflow(
  input: WanAvatarWorkflowInput,
): Promise<WanAvatarWorkflowResult> {
  validateContractVersion(input);

  try {
    return await wanAvatarProcessActivity({
      ...input,
      contractVersion: WAN_AVATAR_ACTIVITY_CONTRACT_VERSION,
    });
  } catch (error) {
    return wanAvatarFailActivity({
      contractVersion: WAN_AVATAR_ACTIVITY_CONTRACT_VERSION,
      workspaceId: input.workspaceId,
      outputAssetId: input.outputAssetId,
      error: failureMessage(error),
    });
  }
}

setWorkflowOptions({ versioningBehavior: "AUTO_UPGRADE" }, wanAvatarWorkflow);
