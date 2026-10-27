import {
  assertContractVersion,
  CROSS_STORE_OUTBOX_DRAIN_ACTIVITY,
  CROSS_STORE_OUTBOX_DRAIN_WORKFLOW_CONTRACT_VERSION,
  type CrossStoreOutboxDrainActivityInput,
  type CrossStoreOutboxDrainActivityResult,
  type CrossStoreOutboxDrainWorkflowInput,
  type CrossStoreOutboxDrainWorkflowResult,
} from "@icecore/temporal";
import { proxyActivities, setWorkflowOptions } from "@temporalio/workflow";

const activities = proxyActivities<{
  [CROSS_STORE_OUTBOX_DRAIN_ACTIVITY]: (
    input: CrossStoreOutboxDrainActivityInput,
  ) => Promise<CrossStoreOutboxDrainActivityResult>;
}>({
  startToCloseTimeout: "3 minutes",
  heartbeatTimeout: "2 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
  },
});

const drainActivity = activities[CROSS_STORE_OUTBOX_DRAIN_ACTIVITY] as (
  input: CrossStoreOutboxDrainActivityInput,
) => Promise<CrossStoreOutboxDrainActivityResult>;

export async function crossStoreOutboxDrainWorkflow(
  input: CrossStoreOutboxDrainWorkflowInput,
): Promise<CrossStoreOutboxDrainWorkflowResult> {
  assertContractVersion(
    input.contractVersion,
    { exact: CROSS_STORE_OUTBOX_DRAIN_WORKFLOW_CONTRACT_VERSION },
    "cross-store outbox drain workflow",
  );

  return drainActivity(input);
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  crossStoreOutboxDrainWorkflow,
);
