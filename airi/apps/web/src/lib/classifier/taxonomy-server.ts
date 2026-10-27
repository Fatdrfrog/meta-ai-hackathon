import "server-only";

import { createHash } from "node:crypto";

import type { ResolvedConversationClassificationTaxonomy } from "@/lib/classifier/conversation-analysis-types";
import { createConversationClassificationError } from "@/lib/classifier/conversation-classification-errors";
import {
  DEFAULT_TAXONOMY,
  backfillFewShotCoverage,
  normalizeFewShotExamples,
  normalizeTaxonomyLabels,
  type FewShotExample,
  type WorkspaceTaxonomy,
} from "@/lib/classifier/taxonomy";
import { supabaseAdmin } from "@/lib/supabase/admin";

const TAXONOMY_SELECT =
  "id, workspace_id, vertical, labels, guidelines, few_shots, confidence_threshold, version";

type TaxonomyRow = {
  id: unknown;
  workspace_id?: unknown;
  vertical?: unknown;
  labels?: unknown;
  guidelines?: unknown;
  few_shots?: unknown;
  confidence_threshold?: unknown;
  version?: unknown;
};

function defaultTaxonomy(workspaceId: string): WorkspaceTaxonomy {
  const labels = normalizeTaxonomyLabels(DEFAULT_TAXONOMY.labels);
  return {
    ...DEFAULT_TAXONOMY,
    workspaceId,
    labels,
    fewShots: backfillFewShotCoverage(
      labels,
      normalizeFewShotExamples(DEFAULT_TAXONOMY.fewShots, labels)
    ),
  };
}

function normalizeTaxonomyRow(
  workspaceId: string,
  data: TaxonomyRow
): WorkspaceTaxonomy {
  const id = typeof data.id === "string" ? data.id.trim() : "";
  if (!id) throw new Error("Taxonomy row is missing its identity");
  const labels = normalizeTaxonomyLabels(
    Array.isArray(data.labels) && data.labels.length > 0
      ? data.labels.map(String)
      : DEFAULT_TAXONOMY.labels
  );
  const rawFewShots = Array.isArray(data.few_shots)
    ? (data.few_shots as FewShotExample[])
    : DEFAULT_TAXONOMY.fewShots;
  const fewShots = backfillFewShotCoverage(
    labels,
    normalizeFewShotExamples(rawFewShots, labels)
  );
  const threshold = data.confidence_threshold;
  return {
    id,
    workspaceId,
    vertical:
      typeof data.vertical === "string" && data.vertical.trim()
        ? data.vertical.trim()
        : undefined,
    labels,
    guidelines:
      typeof data.guidelines === "string" && data.guidelines.trim()
        ? data.guidelines.trim()
        : DEFAULT_TAXONOMY.guidelines,
    fewShots,
    confidenceThreshold:
      typeof threshold === "number" &&
      Number.isFinite(threshold) &&
      threshold >= 0 &&
      threshold <= 1
        ? threshold
        : DEFAULT_TAXONOMY.confidenceThreshold,
    version:
      typeof data.version === "string" && data.version.trim()
        ? data.version.trim()
        : DEFAULT_TAXONOMY.version,
  };
}

/** The workspace's current taxonomy row (newest of several), or null. */
export async function readLatestTaxonomy(workspaceId: string) {
  return supabaseAdmin
    .from("taxonomies")
    .select(TAXONOMY_SELECT)
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
}

function taxonomyDigest(taxonomy: WorkspaceTaxonomy): string {
  const semanticTaxonomy = {
    id: taxonomy.id,
    version: taxonomy.version ?? null,
    labels: taxonomy.labels,
    guidelines: taxonomy.guidelines ?? null,
    fewShots: (taxonomy.fewShots ?? []).map(({ text, label }) => ({
      text,
      label,
    })),
    confidenceThreshold:
      taxonomy.confidenceThreshold ?? DEFAULT_TAXONOMY.confidenceThreshold,
  };
  return createHash("sha256")
    .update(JSON.stringify(semanticTaxonomy))
    .digest("hex");
}

export async function getWorkspaceTaxonomy(
  workspaceId: string
): Promise<WorkspaceTaxonomy> {
  try {
    const { data, error } = await readLatestTaxonomy(workspaceId);
    if (error || !data) return defaultTaxonomy(workspaceId);
    return normalizeTaxonomyRow(workspaceId, data as TaxonomyRow);
  } catch {
    return defaultTaxonomy(workspaceId);
  }
}

export async function getWorkspaceTaxonomyStrict(
  workspaceId: string
): Promise<ResolvedConversationClassificationTaxonomy> {
  let result: Awaited<ReturnType<typeof readLatestTaxonomy>>;
  try {
    result = await readLatestTaxonomy(workspaceId);
  } catch (error) {
    throw createConversationClassificationError("taxonomy_read_failed", error);
  }
  if (result.error) {
    throw createConversationClassificationError(
      "taxonomy_read_failed",
      result.error
    );
  }

  let taxonomy: WorkspaceTaxonomy;
  try {
    taxonomy = result.data
      ? normalizeTaxonomyRow(workspaceId, result.data as TaxonomyRow)
      : defaultTaxonomy(workspaceId);
  } catch (error) {
    throw createConversationClassificationError("taxonomy_read_failed", error);
  }
  return { taxonomy, digest: taxonomyDigest(taxonomy) };
}
