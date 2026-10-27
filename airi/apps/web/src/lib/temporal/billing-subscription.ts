import "server-only";

import {
  BILLING_SUBSCRIPTION_WORKFLOW,
  BILLING_SUBSCRIPTION_WORKFLOW_CONTRACT_VERSION,
  buildBillingSubscriptionWorkflowId,
  type BillingSubscriptionWorkflowInput,
} from "@icecore/temporal";

import { getTemporalClient, getTemporalWebClientConfig } from "./client";
import { requireTemporalConfigured } from "./workflow-start";

export async function startBillingSubscriptionWorkflow(
  input: Omit<BillingSubscriptionWorkflowInput, "contractVersion">
) {
  requireTemporalConfigured("Temporal is not configured for billing renewals");

  const client = getTemporalClient();
  const config = getTemporalWebClientConfig();
  const workflowId = buildBillingSubscriptionWorkflowId({
    subscriptionId: input.subscriptionId,
  });

  return client.workflow.start(BILLING_SUBSCRIPTION_WORKFLOW, {
    workflowId,
    taskQueue: config.taskQueue,
    workflowIdReusePolicy: "ALLOW_DUPLICATE",
    workflowIdConflictPolicy: "USE_EXISTING",
    args: [
      {
        contractVersion: BILLING_SUBSCRIPTION_WORKFLOW_CONTRACT_VERSION,
        ...input,
      },
    ],
  });
}
