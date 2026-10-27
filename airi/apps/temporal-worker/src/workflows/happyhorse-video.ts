import {
  assertContractVersion,
  HAPPYHORSE_VIDEO_ACTIVITY_CONTRACT_VERSION,
  HAPPYHORSE_VIDEO_FAIL_ACTIVITY,
  HAPPYHORSE_VIDEO_PROCESS_ACTIVITY,
  HAPPYHORSE_VIDEO_WORKFLOW_CONTRACT_VERSION,
  type HappyHorseVideoActivityResult,
  type HappyHorseVideoFailActivityInput,
  type HappyHorseVideoProcessActivityInput,
  type HappyHorseVideoWorkflowInput,
  type HappyHorseVideoWorkflowResult,
} from "@icecore/temporal";
import { proxyActivities, setWorkflowOptions } from "@temporalio/workflow";

const happyHorseActivities = proxyActivities<{
  [HAPPYHORSE_VIDEO_PROCESS_ACTIVITY]: (
    input: HappyHorseVideoProcessActivityInput,
  ) => Promise<HappyHorseVideoActivityResult>;
  [HAPPYHORSE_VIDEO_FAIL_ACTIVITY]: (
    input: HappyHorseVideoFailActivityInput,
  ) => Promise<HappyHorseVideoActivityResult>;
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

const happyHorseVideoProcessActivity = happyHorseActivities[
  HAPPYHORSE_VIDEO_PROCESS_ACTIVITY
] as (
  input: HappyHorseVideoProcessActivityInput,
) => Promise<HappyHorseVideoActivityResult>;

const happyHorseVideoFailActivity = happyHorseActivities[
  HAPPYHORSE_VIDEO_FAIL_ACTIVITY
] as (
  input: HappyHorseVideoFailActivityInput,
) => Promise<HappyHorseVideoActivityResult>;

function validateContractVersion(input: HappyHorseVideoWorkflowInput): void {
  assertContractVersion(
    input.contractVersion,
    { max: HAPPYHORSE_VIDEO_WORKFLOW_CONTRACT_VERSION },
    "HappyHorse video workflow",
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
  return "Failed to generate HappyHorse video";
}

export async function happyHorseVideoWorkflow(
  input: HappyHorseVideoWorkflowInput,
): Promise<HappyHorseVideoWorkflowResult> {
  validateContractVersion(input);

  try {
    return await happyHorseVideoProcessActivity({
      ...input,
      contractVersion: HAPPYHORSE_VIDEO_ACTIVITY_CONTRACT_VERSION,
    });
  } catch (error) {
    return happyHorseVideoFailActivity({
      contractVersion: HAPPYHORSE_VIDEO_ACTIVITY_CONTRACT_VERSION,
      workspaceId: input.workspaceId,
      outputAssetId: input.outputAssetId,
      error: failureMessage(error),
    });
  }
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  happyHorseVideoWorkflow,
);
