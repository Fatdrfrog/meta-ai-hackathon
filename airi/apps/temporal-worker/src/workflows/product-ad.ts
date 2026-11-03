import {
  assertContractVersion,
  PRODUCT_AD_ACTIVITY,
  PRODUCT_AD_ACTIVITY_CONTRACT_VERSION,
  PRODUCT_AD_ACTIVITY_MAX_ATTEMPTS,
  PRODUCT_AD_FAIL_ACTIVITY,
  PRODUCT_AD_WORKFLOW_CONTRACT_VERSION,
  type ProductAdActivityInput,
  type ProductAdActivityResult,
  type ProductAdFailActivityInput,
  type ProductAdWorkflowInput,
  type ProductAdWorkflowResult,
} from "@icecore/temporal";
import {
  proxyActivities,
  setWorkflowOptions,
  workflowInfo,
} from "@temporalio/workflow";

// One run of a video ad: the activity makes (or renders) the whole ad,
// saving each step, so a retry resumes and pays for nothing twice; it
// heartbeats through every long step.
const adActivities = proxyActivities<{
  [PRODUCT_AD_ACTIVITY]: (
    input: ProductAdActivityInput,
  ) => Promise<ProductAdActivityResult>;
}>({
  startToCloseTimeout: "8m",
  heartbeatTimeout: "2m",
  retry: {
    maximumAttempts: PRODUCT_AD_ACTIVITY_MAX_ATTEMPTS,
    initialInterval: "15s",
    backoffCoefficient: 2,
    maximumInterval: "2m",
    nonRetryableErrorTypes: ["ProductAdRejected"],
  },
});

const failActivities = proxyActivities<{
  [PRODUCT_AD_FAIL_ACTIVITY]: (
    input: ProductAdFailActivityInput,
  ) => Promise<ProductAdActivityResult>;
}>({
  startToCloseTimeout: "2m",
  retry: {
    maximumAttempts: 5,
    initialInterval: "10s",
    backoffCoefficient: 2,
    maximumInterval: "2m",
  },
});

const productAdActivity = adActivities[PRODUCT_AD_ACTIVITY] as (
  input: ProductAdActivityInput,
) => Promise<ProductAdActivityResult>;

const productAdFailActivity = failActivities[PRODUCT_AD_FAIL_ACTIVITY] as (
  input: ProductAdFailActivityInput,
) => Promise<ProductAdActivityResult>;

function failureMessage(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (current instanceof Error) {
      const message = current.message.trim();
      if (message && !/^Activity task failed/i.test(message)) return message;
      current = current.cause;
      continue;
    }
    if (typeof current === "string" && current.trim()) return current.trim();
    break;
  }
  return "The video ad couldn't be made";
}

export async function productAdWorkflow(
  input: ProductAdWorkflowInput,
): Promise<ProductAdWorkflowResult> {
  assertContractVersion(
    input.contractVersion,
    { exact: PRODUCT_AD_WORKFLOW_CONTRACT_VERSION },
    "product ad workflow",
  );
  const activityInput: ProductAdActivityInput = {
    contractVersion: PRODUCT_AD_ACTIVITY_CONTRACT_VERSION,
    workspaceId: input.workspaceId,
    adId: input.adId,
    renderNo: input.renderNo,
    mode: input.mode,
    workflowId: workflowInfo().workflowId,
  };

  try {
    return await productAdActivity(activityInput);
  } catch (error) {
    return productAdFailActivity({
      ...activityInput,
      error: failureMessage(error),
    });
  }
}

setWorkflowOptions({ versioningBehavior: "AUTO_UPGRADE" }, productAdWorkflow);
