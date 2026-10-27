import {
  VIDEO_GENERATION_RECONCILE_ACTIVITY,
  type VideoGenerationReconcileActivityResult,
  type VideoGenerationReconcileWorkflowInput,
} from "@icecore/temporal";
import { proxyActivities, setWorkflowOptions } from "@temporalio/workflow";

const activities = proxyActivities<{
  [VIDEO_GENERATION_RECONCILE_ACTIVITY]: (
    input: VideoGenerationReconcileWorkflowInput,
  ) => Promise<VideoGenerationReconcileActivityResult>;
}>({
  startToCloseTimeout: "10m",
  retry: { maximumAttempts: 3 },
});

export async function videoGenerationReconcileWorkflow(
  input: VideoGenerationReconcileWorkflowInput,
): Promise<VideoGenerationReconcileActivityResult> {
  return activities[VIDEO_GENERATION_RECONCILE_ACTIVITY](input);
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  videoGenerationReconcileWorkflow,
);
