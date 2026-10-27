import {
  assertContractVersion,
  PRODUCT_VIDEO_IMPORT_ACTIVITY,
  PRODUCT_VIDEO_IMPORT_ACTIVITY_CONTRACT_VERSION,
  PRODUCT_VIDEO_IMPORT_ACTIVITY_MAX_ATTEMPTS,
  PRODUCT_VIDEO_IMPORT_FAIL_ACTIVITY,
  PRODUCT_VIDEO_IMPORT_WORKFLOW_CONTRACT_VERSION,
  type ProductVideoImportActivityInput,
  type ProductVideoImportActivityResult,
  type ProductVideoImportFailActivityInput,
  type ProductVideoImportWorkflowInput,
  type ProductVideoImportWorkflowResult,
} from "@icecore/temporal";
import {
  proxyActivities,
  setWorkflowOptions,
  workflowInfo,
} from "@temporalio/workflow";

// The activity runs the whole import, saving each step, so a retry resumes;
// it heartbeats through every long step.
const importActivities = proxyActivities<{
  [PRODUCT_VIDEO_IMPORT_ACTIVITY]: (
    input: ProductVideoImportActivityInput,
  ) => Promise<ProductVideoImportActivityResult>;
}>({
  startToCloseTimeout: "45m",
  heartbeatTimeout: "2m",
  retry: {
    maximumAttempts: PRODUCT_VIDEO_IMPORT_ACTIVITY_MAX_ATTEMPTS,
    initialInterval: "30s",
    backoffCoefficient: 2,
    maximumInterval: "5m",
    nonRetryableErrorTypes: ["ProductVideoImportRejected"],
  },
});

const failActivities = proxyActivities<{
  [PRODUCT_VIDEO_IMPORT_FAIL_ACTIVITY]: (
    input: ProductVideoImportFailActivityInput,
  ) => Promise<ProductVideoImportActivityResult>;
}>({
  startToCloseTimeout: "2m",
  retry: {
    maximumAttempts: 5,
    initialInterval: "10s",
    backoffCoefficient: 2,
    maximumInterval: "2m",
  },
});

const productVideoImportActivity = importActivities[
  PRODUCT_VIDEO_IMPORT_ACTIVITY
] as (
  input: ProductVideoImportActivityInput,
) => Promise<ProductVideoImportActivityResult>;

const productVideoImportFailActivity = failActivities[
  PRODUCT_VIDEO_IMPORT_FAIL_ACTIVITY
] as (
  input: ProductVideoImportFailActivityInput,
) => Promise<ProductVideoImportActivityResult>;

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
  return "The product video import failed";
}

export async function productVideoImportWorkflow(
  input: ProductVideoImportWorkflowInput,
): Promise<ProductVideoImportWorkflowResult> {
  assertContractVersion(
    input.contractVersion,
    { exact: PRODUCT_VIDEO_IMPORT_WORKFLOW_CONTRACT_VERSION },
    "product video import workflow",
  );
  const activityInput: ProductVideoImportActivityInput = {
    contractVersion: PRODUCT_VIDEO_IMPORT_ACTIVITY_CONTRACT_VERSION,
    workspaceId: input.workspaceId,
    importId: input.importId,
    workflowId: workflowInfo().workflowId,
  };

  try {
    return await productVideoImportActivity(activityInput);
  } catch (error) {
    return productVideoImportFailActivity({
      ...activityInput,
      error: failureMessage(error),
    });
  }
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  productVideoImportWorkflow,
);
