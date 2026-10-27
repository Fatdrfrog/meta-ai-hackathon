/** Must match the exported workflow function name in `apps/temporal-worker/src/workflows`. */
export const KNOWLEDGE_CANONICAL_SYNC_WORKFLOW =
  "knowledgeCanonicalSyncWorkflow";
export const KNOWLEDGE_CANONICAL_SYNC_WORKFLOW_CONTRACT_VERSION = 2;

export const KNOWLEDGE_CANONICAL_SYNC_SOURCE_KINDS = Object.freeze([
  "kb_article",
  "indexed_url",
  "curated_snippet",
] as const);

export const KNOWLEDGE_CANONICAL_SYNC_ACTIVITY =
  "knowledgeCanonicalSyncActivity";

export type KnowledgeCanonicalSyncSourceKind =
  (typeof KNOWLEDGE_CANONICAL_SYNC_SOURCE_KINDS)[number];

const KNOWLEDGE_CANONICAL_SYNC_SOURCE_KIND_SET = new Set<string>(
  KNOWLEDGE_CANONICAL_SYNC_SOURCE_KINDS,
);

export function isSupportedKnowledgeCanonicalSyncContractVersion(
  value: unknown,
): value is number {
  return (
    Number.isInteger(value) &&
    Number(value) >= 1 &&
    Number(value) <= KNOWLEDGE_CANONICAL_SYNC_WORKFLOW_CONTRACT_VERSION
  );
}

/**
 * Runtime normalization for rolling deploys and replayed v1 payloads.
 * Omission keeps the caller's default behavior; every explicit unsupported
 * value resolves to an explicit empty list rather than broadening the run.
 */
export function normalizeKnowledgeCanonicalSyncSourceKinds(
  value: unknown,
): KnowledgeCanonicalSyncSourceKind[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];

  const normalized: KnowledgeCanonicalSyncSourceKind[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      !KNOWLEDGE_CANONICAL_SYNC_SOURCE_KIND_SET.has(item) ||
      normalized.includes(item as KnowledgeCanonicalSyncSourceKind)
    ) {
      continue;
    }
    normalized.push(item as KnowledgeCanonicalSyncSourceKind);
  }
  return normalized;
}

export type KnowledgeCanonicalSyncPayload = {
  contractVersion: number;
  workspaceId: string;
  sourceKinds?: KnowledgeCanonicalSyncSourceKind[];
  /** Omission reconciles the workspace; an explicit empty list is a no-op. */
  sourceRecordIds?: string[];
  dryRun?: boolean;
};

export type KnowledgeCanonicalSyncActivityInput = KnowledgeCanonicalSyncPayload;

export type KnowledgeCanonicalSyncActivityResult = {
  workspaceId: string;
  bySource: Record<
    string,
    {
      documentsTouched: number;
      chunksUpserted: number;
      chunksDeleted: number;
      status: "pending" | "running" | "completed" | "failed";
      errorMessage?: string;
    }
  >;
  syncRunIds: string[];
};

export type KnowledgeCanonicalSyncWorkflowInput = KnowledgeCanonicalSyncPayload;

export type KnowledgeCanonicalSyncWorkflowResult =
  KnowledgeCanonicalSyncActivityResult;
