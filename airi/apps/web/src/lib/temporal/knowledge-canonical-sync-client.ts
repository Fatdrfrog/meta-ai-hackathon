import "server-only";

import { randomUUID } from "node:crypto";

import { isWorkflowAlreadyStartedError } from "@icecore/shared/lib/temporal-errors";
import {
  KNOWLEDGE_CANONICAL_SYNC_WORKFLOW,
  KNOWLEDGE_CANONICAL_SYNC_WORKFLOW_CONTRACT_VERSION,
  sanitizeTemporalWorkflowIdPart,
  type KnowledgeCanonicalSyncSourceKind,
  type KnowledgeCanonicalSyncWorkflowInput,
} from "@icecore/temporal";

import {
  getTemporalClient,
  getTemporalWebClientConfig,
  isTemporalConfigured,
} from "./client";
import { requireTemporalConfigured } from "./workflow-start";

export function buildKnowledgeCanonicalSyncWorkflowId(params: {
  workspaceId: string;
  executionId?: string | null;
}): string {
  const workspaceId = sanitizeTemporalWorkflowIdPart(
    params.workspaceId || "workspace"
  );
  const executionId = sanitizeTemporalWorkflowIdPart(
    params.executionId || `run-${Date.now()}-${randomUUID()}`
  );
  return `knowledge-canonical-sync:${workspaceId}:${executionId}`;
}

export function buildDailyKnowledgeCanonicalSyncExecutionId(
  date: Date = new Date()
): string {
  const validDate =
    date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return `daily-${validDate.toISOString().slice(0, 10)}`;
}

export type StartKnowledgeCanonicalSyncWorkflowParams = {
  workspaceId: string;
  sourceKinds?: KnowledgeCanonicalSyncSourceKind[];
  sourceRecordIds?: string[];
  dryRun?: boolean;
  /** When omitted, a unique execution id is generated (recommended). */
  executionId?: string | null;
};

/**
 * Enqueues a Temporal workflow that mirrors KB articles, indexed URLs, and Mongo snippets
 * into `knowledge_documents` / `knowledge_chunks` (offline from the RAG hot path).
 */
export async function startKnowledgeCanonicalSyncWorkflow(
  params: StartKnowledgeCanonicalSyncWorkflowParams
) {
  requireTemporalConfigured(
    "Temporal is not configured; cannot start knowledge canonical sync workflow"
  );

  const client = getTemporalClient();
  const config = getTemporalWebClientConfig();
  const workflowId = buildKnowledgeCanonicalSyncWorkflowId({
    workspaceId: params.workspaceId,
    executionId: params.executionId,
  });

  const input: KnowledgeCanonicalSyncWorkflowInput = {
    contractVersion: KNOWLEDGE_CANONICAL_SYNC_WORKFLOW_CONTRACT_VERSION,
    workspaceId: params.workspaceId,
    sourceKinds: params.sourceKinds,
    ...(params.sourceRecordIds !== undefined
      ? { sourceRecordIds: params.sourceRecordIds }
      : {}),
    dryRun: params.dryRun,
  };

  return client.workflow.start(KNOWLEDGE_CANONICAL_SYNC_WORKFLOW, {
    workflowId,
    taskQueue: config.taskQueue,
    workflowIdReusePolicy: "REJECT_DUPLICATE",
    workflowIdConflictPolicy: "USE_EXISTING",
    args: [input],
  });
}

export type TryStartKnowledgeCanonicalSyncResult =
  | { ok: true; workflowId: string }
  | {
      ok: false;
      reason: "temporal_not_configured" | "start_failed";
      message?: string;
    };

/**
 * Like {@link startKnowledgeCanonicalSyncWorkflow} but never throws: returns a result
 * for cron hooks and fire-and-forget publish paths.
 */
export async function tryStartKnowledgeCanonicalSyncWorkflow(
  params: StartKnowledgeCanonicalSyncWorkflowParams
): Promise<TryStartKnowledgeCanonicalSyncResult> {
  if (!isTemporalConfigured()) {
    return { ok: false, reason: "temporal_not_configured" };
  }

  const deterministicWorkflowId = params.executionId
    ? buildKnowledgeCanonicalSyncWorkflowId({
        workspaceId: params.workspaceId,
        executionId: params.executionId,
      })
    : null;

  try {
    const handle = await startKnowledgeCanonicalSyncWorkflow(params);
    return { ok: true, workflowId: handle.workflowId };
  } catch (error) {
    if (deterministicWorkflowId && isWorkflowAlreadyStartedError(error)) {
      return { ok: true, workflowId: deterministicWorkflowId };
    }

    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "start_failed", message };
  }
}
