import "server-only";

import { randomUUID } from "node:crypto";

import {
  CRAWL_WEBSITE_WORKFLOW,
  CRAWL_WEBSITE_WORKFLOW_CONTRACT_VERSION,
  sanitizeTemporalWorkflowIdPart,
  type CrawlWebsiteWorkflowInput,
} from "@icecore/temporal";

import {
  getTemporalClient,
  getTemporalWebClientConfig,
  isTemporalConfigured,
} from "./client";
import { buildCrawlWebsiteExecutionId } from "./crawl-website-execution";
import { isTemporalSdkError } from "./sdk";
import { requireTemporalConfigured } from "./workflow-start";

export function buildCrawlWebsiteWorkflowId(params: {
  workspaceId: string;
  executionId?: string | null;
}): string {
  const workspaceId = sanitizeTemporalWorkflowIdPart(
    params.workspaceId || "workspace"
  );
  const executionId = sanitizeTemporalWorkflowIdPart(
    params.executionId || `run-${Date.now()}-${randomUUID()}`
  );
  return `crawl-website:${workspaceId}:${executionId}`;
}

export type StartCrawlWebsiteWorkflowParams = {
  workspaceId: string;
  websites?: string[];
  includeInstagram?: boolean;
  maxPagesPerSite?: number;
  maxCrawlMsPerSite?: number;
  maxIndexChars?: number;
  /** When omitted, a deterministic effective-input execution id is derived. */
  executionId?: string | null;
};

/**
 * Enqueues a Temporal workflow that crawls the customer's websites + Instagram
 * profile and mirrors the extracted text into the canonical RAG store.
 */
export async function startCrawlWebsiteWorkflow(
  params: StartCrawlWebsiteWorkflowParams
) {
  requireTemporalConfigured(
    "Temporal is not configured; cannot start crawl website workflow"
  );

  const client = getTemporalClient();
  const config = getTemporalWebClientConfig();
  const executionId =
    params.executionId?.trim() || buildCrawlWebsiteExecutionId(params);
  const workflowId = buildCrawlWebsiteWorkflowId({
    workspaceId: params.workspaceId,
    executionId,
  });

  const input: CrawlWebsiteWorkflowInput = {
    contractVersion: CRAWL_WEBSITE_WORKFLOW_CONTRACT_VERSION,
    workspaceId: params.workspaceId,
    websites: params.websites,
    includeInstagram: params.includeInstagram,
    maxPagesPerSite: params.maxPagesPerSite,
    maxCrawlMsPerSite: params.maxCrawlMsPerSite,
    maxIndexChars: params.maxIndexChars,
  };

  return client.workflow.start(CRAWL_WEBSITE_WORKFLOW, {
    workflowId,
    taskQueue: config.taskQueue,
    workflowIdReusePolicy: "ALLOW_DUPLICATE",
    workflowIdConflictPolicy: "USE_EXISTING",
    args: [input],
  });
}

export type TryStartCrawlWebsiteResult =
  | { ok: true; workflowId: string }
  | {
      ok: false;
      reason: "temporal_not_configured" | "start_failed";
      message?: string;
    };

/**
 * Like {@link startCrawlWebsiteWorkflow} but never throws.
 */
export async function tryStartCrawlWebsiteWorkflow(
  params: StartCrawlWebsiteWorkflowParams
): Promise<TryStartCrawlWebsiteResult> {
  if (!isTemporalConfigured()) {
    return { ok: false, reason: "temporal_not_configured" };
  }

  const executionId =
    params.executionId?.trim() || buildCrawlWebsiteExecutionId(params);
  const workflowId = buildCrawlWebsiteWorkflowId({
    workspaceId: params.workspaceId,
    executionId,
  });

  try {
    const handle = await startCrawlWebsiteWorkflow(params);
    return { ok: true, workflowId: handle.workflowId };
  } catch (error) {
    if (isTemporalSdkError(error, "WorkflowExecutionAlreadyStartedError")) {
      return { ok: true, workflowId };
    }

    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "start_failed", message };
  }
}
