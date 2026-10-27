import "server-only";

import type { EnqueueKnowledgeCanonicalSyncParams } from "@/lib/airi/rag/kb/kb-types";
import { ragLogger } from "@/lib/airi/shared/logger";
import { tryStartKnowledgeCanonicalSyncWorkflow } from "@/lib/temporal/knowledge-canonical-sync-client";

/**
 * Fire-and-forget Temporal enqueue helper for source mutations that must refresh
 * the canonical evidence layer without blocking the request.
 */
export function enqueueKnowledgeCanonicalSync(
  params: EnqueueKnowledgeCanonicalSyncParams
): void {
  if (!params.workspaceId) {
    return;
  }

  void tryStartKnowledgeCanonicalSyncWorkflow({
    workspaceId: params.workspaceId,
    sourceKinds: params.sourceKinds,
    ...(params.sourceRecordIds !== undefined
      ? { sourceRecordIds: params.sourceRecordIds }
      : {}),
    dryRun: params.dryRun,
    executionId: params.executionId,
  }).then(result => {
    if (!result.ok && result.reason === "start_failed") {
      ragLogger.general.warn("knowledge_canonical_sync.enqueue_failed", {
        context: params.context,
        workspaceId: params.workspaceId,
        sourceKinds: params.sourceKinds || [],
        message: result.message || null,
      });
    }
  });
}
