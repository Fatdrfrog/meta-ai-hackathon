import {
  assertContractVersion,
  CRAWL_WEBSITE_ACTIVITY,
  KNOWLEDGE_CANONICAL_SYNC_WORKFLOW,
  KNOWLEDGE_CANONICAL_SYNC_WORKFLOW_CONTRACT_VERSION,
  sanitizeTemporalWorkflowIdPart,
  type CrawlWebsiteActivityInput,
  type CrawlWebsiteActivityResult,
  type CrawlWebsiteWorkflowInput,
  type CrawlWebsiteWorkflowResult,
  type KnowledgeCanonicalSyncWorkflowInput,
} from "@icecore/temporal";
import {
  ParentClosePolicy,
  proxyActivities,
  setWorkflowOptions,
  startChild,
  workflowInfo,
} from "@temporalio/workflow";

const activities = proxyActivities<{
  [CRAWL_WEBSITE_ACTIVITY]: (
    input: CrawlWebsiteActivityInput,
  ) => Promise<CrawlWebsiteActivityResult>;
}>({
  startToCloseTimeout: "30m",
  retry: {
    maximumAttempts: 2,
    initialInterval: "10s",
    backoffCoefficient: 2,
    maximumInterval: "120s",
  },
});

const runCrawlWebsiteActivity = activities[CRAWL_WEBSITE_ACTIVITY] as (
  input: CrawlWebsiteActivityInput,
) => Promise<CrawlWebsiteActivityResult>;

function buildCrawlCanonicalSyncWorkflowId(params: {
  workspaceId: string;
  crawlWorkflowId: string;
}): string {
  const workspaceId = sanitizeTemporalWorkflowIdPart(
    params.workspaceId || "workspace",
  );
  const crawlWorkflowId = sanitizeTemporalWorkflowIdPart(
    params.crawlWorkflowId || "crawl",
  ).slice(0, 120);
  return `knowledge-canonical-sync:${workspaceId}:from-${crawlWorkflowId}`;
}

export async function crawlWebsiteWorkflow(
  input: CrawlWebsiteWorkflowInput,
): Promise<CrawlWebsiteWorkflowResult> {
  assertContractVersion(
    input.contractVersion,
    { max: 1 },
    "crawl website workflow",
  );

  const crawlResult = await runCrawlWebsiteActivity(input);
  const anyIndexed = crawlResult.seeds.some(
    (seed) => seed.status === "completed",
  );

  if (!anyIndexed) {
    return crawlResult;
  }

  try {
    const childInput: KnowledgeCanonicalSyncWorkflowInput = {
      contractVersion: KNOWLEDGE_CANONICAL_SYNC_WORKFLOW_CONTRACT_VERSION,
      workspaceId: input.workspaceId,
      sourceKinds: ["indexed_url"],
    };

    await startChild(KNOWLEDGE_CANONICAL_SYNC_WORKFLOW, {
      workflowId: buildCrawlCanonicalSyncWorkflowId({
        workspaceId: input.workspaceId,
        crawlWorkflowId: workflowInfo().workflowId,
      }),
      parentClosePolicy: ParentClosePolicy.ABANDON,
      args: [childInput],
    });

    return {
      ...crawlResult,
      canonicalSyncEnqueued: true,
    };
  } catch {
    return crawlResult;
  }
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  crawlWebsiteWorkflow,
);
