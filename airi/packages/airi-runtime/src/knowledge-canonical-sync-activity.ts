import type {
  KnowledgeCanonicalSyncActivityInput,
  KnowledgeCanonicalSyncActivityResult,
  KnowledgeCanonicalSyncSourceKind,
} from "@icecore/temporal";
import {
  isSupportedKnowledgeCanonicalSyncContractVersion,
  normalizeKnowledgeCanonicalSyncSourceKinds,
} from "@icecore/temporal";
import { airiWorkerLogger } from "./logging";
import { createWebRequire } from "./internal/module-interop";

const requireWeb = createWebRequire(import.meta.url);

type RunnerModule = {
  runKnowledgeCanonicalSync: (input: {
    workspaceId: string;
    sourceKinds?: KnowledgeCanonicalSyncSourceKind[];
    sourceRecordIds?: string[];
    dryRun?: boolean;
  }) => Promise<{
    workspaceId: string;
    bySource: Record<string, unknown>;
    syncRunIds: string[];
  }>;
};

function loadRunner(): RunnerModule {
  return requireWeb(
    "../../../apps/web/src/lib/airi/rag/knowledge/canonical-sync/knowledge-canonical-sync-runner",
  ) as RunnerModule;
}

export async function executeKnowledgeCanonicalSyncActivity(
  input: KnowledgeCanonicalSyncActivityInput,
): Promise<KnowledgeCanonicalSyncActivityResult> {
  if (
    !isSupportedKnowledgeCanonicalSyncContractVersion(input.contractVersion)
  ) {
    throw new Error(
      `Unsupported knowledge canonical sync contract version: ${input.contractVersion}`,
    );
  }

  const workspaceId = String(input.workspaceId || "").trim();
  if (!workspaceId) {
    throw new Error("workspaceId is required");
  }

  const sourceKinds = normalizeKnowledgeCanonicalSyncSourceKinds(
    input.sourceKinds,
  );

  airiWorkerLogger.info("knowledge_canonical_sync.activity_started", {
    workspaceId,
    sourceKinds: sourceKinds ?? null,
    dryRun: Boolean(input.dryRun),
  });

  if (sourceKinds?.length === 0 || input.sourceRecordIds?.length === 0) {
    const emptyResult: KnowledgeCanonicalSyncActivityResult = {
      workspaceId,
      bySource: {},
      syncRunIds: [],
    };
    airiWorkerLogger.info("knowledge_canonical_sync.activity_finished", {
      workspaceId,
      bySource: emptyResult.bySource,
      syncRunCount: 0,
    });
    return emptyResult;
  }

  const result = await loadRunner().runKnowledgeCanonicalSync({
    workspaceId,
    sourceKinds,
    ...(input.sourceRecordIds !== undefined
      ? { sourceRecordIds: input.sourceRecordIds }
      : {}),
    dryRun: input.dryRun,
  });

  const bySource: KnowledgeCanonicalSyncActivityResult["bySource"] = {};
  for (const [key, value] of Object.entries(result.bySource)) {
    const v = value as {
      documentsTouched: number;
      chunksUpserted: number;
      chunksDeleted: number;
      status: string;
      errorMessage?: string;
    };
    bySource[key] = {
      documentsTouched: v.documentsTouched,
      chunksUpserted: v.chunksUpserted,
      chunksDeleted: v.chunksDeleted,
      status:
        v.status === "failed"
          ? "failed"
          : v.status === "completed"
            ? "completed"
            : v.status === "running"
              ? "running"
              : "completed",
      errorMessage: v.errorMessage,
    };
  }

  airiWorkerLogger.info("knowledge_canonical_sync.activity_finished", {
    workspaceId,
    bySource,
    syncRunCount: result.syncRunIds.length,
  });

  return {
    workspaceId: result.workspaceId,
    bySource,
    syncRunIds: result.syncRunIds,
  };
}
