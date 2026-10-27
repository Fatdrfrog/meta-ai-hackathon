import {
  KNOWLEDGE_CANONICAL_SYNC_ACTIVITY,
  isSupportedKnowledgeCanonicalSyncContractVersion,
  normalizeKnowledgeCanonicalSyncSourceKinds,
  type KnowledgeCanonicalSyncActivityInput,
  type KnowledgeCanonicalSyncActivityResult,
  type KnowledgeCanonicalSyncWorkflowInput,
  type KnowledgeCanonicalSyncWorkflowResult,
} from "@icecore/temporal";
import { proxyActivities, setWorkflowOptions } from "@temporalio/workflow";

const activities = proxyActivities<{
  [KNOWLEDGE_CANONICAL_SYNC_ACTIVITY]: (
    input: KnowledgeCanonicalSyncActivityInput,
  ) => Promise<KnowledgeCanonicalSyncActivityResult>;
}>({
  startToCloseTimeout: "45m",
  retry: {
    maximumAttempts: 2,
    initialInterval: "10s",
    backoffCoefficient: 2,
    maximumInterval: "120s",
  },
});

const runKnowledgeCanonicalSyncActivity = activities[
  KNOWLEDGE_CANONICAL_SYNC_ACTIVITY
] as (
  input: KnowledgeCanonicalSyncActivityInput,
) => Promise<KnowledgeCanonicalSyncActivityResult>;

export async function knowledgeCanonicalSyncWorkflow(
  input: KnowledgeCanonicalSyncWorkflowInput,
): Promise<KnowledgeCanonicalSyncWorkflowResult> {
  return runKnowledgeCanonicalSyncActivity(
    normalizeKnowledgeCanonicalSyncWorkflowInput(input),
  );
}

export function normalizeKnowledgeCanonicalSyncWorkflowInput(
  input: KnowledgeCanonicalSyncWorkflowInput,
): KnowledgeCanonicalSyncWorkflowInput {
  if (
    !isSupportedKnowledgeCanonicalSyncContractVersion(input.contractVersion)
  ) {
    throw new Error(
      `Unsupported knowledge canonical sync workflow contract version: ${input.contractVersion}`,
    );
  }

  return {
    ...input,
    sourceKinds: normalizeKnowledgeCanonicalSyncSourceKinds(input.sourceKinds),
  };
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  knowledgeCanonicalSyncWorkflow,
);
