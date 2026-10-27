import {
  assertContractVersion,
  CREATIVE_IMAGE_GENERATION_ACTIVITY,
  CREATIVE_IMAGE_GENERATION_ACTIVITY_MAX_ATTEMPTS,
  CREATIVE_IMAGE_GENERATION_WORKFLOW_CONTRACT_VERSION,
  buildCreativeImageGenerationWorkflowId,
  type CreativeImageGenerationActivityInput,
  type CreativeImageGenerationActivityResult,
  type CreativeImageGenerationWorkflowInput,
  type CreativeImageGenerationWorkflowResult,
} from "@icecore/temporal";
import { proxyActivities, setWorkflowOptions } from "@temporalio/workflow";

const activities = proxyActivities<{
  [CREATIVE_IMAGE_GENERATION_ACTIVITY]: (
    input: CreativeImageGenerationActivityInput,
  ) => Promise<CreativeImageGenerationActivityResult>;
}>({
  startToCloseTimeout: "900s",
  retry: {
    maximumAttempts: CREATIVE_IMAGE_GENERATION_ACTIVITY_MAX_ATTEMPTS,
    initialInterval: "10s",
    backoffCoefficient: 2,
    maximumInterval: "2m",
  },
});

const generateImageActivity = activities[
  CREATIVE_IMAGE_GENERATION_ACTIVITY
] as (
  input: CreativeImageGenerationActivityInput,
) => Promise<CreativeImageGenerationActivityResult>;

function validateContractVersion(input: CreativeImageGenerationWorkflowInput) {
  assertContractVersion(
    input.contractVersion,
    { exact: CREATIVE_IMAGE_GENERATION_WORKFLOW_CONTRACT_VERSION },
    "creative image generation workflow",
  );
}

export async function creativeImageGenerationWorkflow(
  input: CreativeImageGenerationWorkflowInput,
): Promise<CreativeImageGenerationWorkflowResult> {
  validateContractVersion(input);

  return generateImageActivity({
    ...input,
    workflowId: buildCreativeImageGenerationWorkflowId({
      assetId: input.assetId,
    }),
  });
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  creativeImageGenerationWorkflow,
);
