export type CrmPipelineStage = {
  id: string;
  key: string;
  name: string;
  color: string | null;
  sortOrder: number;
  isActive: boolean;
  ghostedAfterDays: number;
  stalledAfterDays: number;
};

export type CrmPipelineStageInput = {
  id?: string | null;
  key?: string | null;
  name: string;
  color?: string | null;
  sortOrder?: number | null;
  isActive?: boolean | null;
  ghostedAfterDays?: number | null;
  stalledAfterDays?: number | null;
};

export type ValidatedCrmPipelineStageInput = {
  id: string | null;
  key: string;
  name: string;
  color: string | null;
  sortOrder: number;
  isActive: boolean;
  ghostedAfterDays: number;
  stalledAfterDays: number;
};

export const CRM_UNASSIGNED_STAGE_KEY = "unassigned";

export const CRM_DEFAULT_ATTENTION_DAYS = 3;
export const CRM_ATTENTION_DAYS_MIN = 1;
export const CRM_ATTENTION_DAYS_MAX = 90;

export function normalizeCrmAttentionDays(value: unknown): number {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return CRM_DEFAULT_ATTENTION_DAYS;
  return Math.min(
    CRM_ATTENTION_DAYS_MAX,
    Math.max(CRM_ATTENTION_DAYS_MIN, Math.round(parsed))
  );
}

export function crmAttentionDaysToMs(days: unknown): number {
  return normalizeCrmAttentionDays(days) * 24 * 60 * 60 * 1000;
}

export const DEFAULT_CRM_PIPELINE_STAGES: CrmPipelineStage[] = [
  {
    id: "default-new",
    key: "new",
    name: "New",
    color: "#2563eb",
    sortOrder: 0,
    isActive: true,
    ghostedAfterDays: CRM_DEFAULT_ATTENTION_DAYS,
    stalledAfterDays: CRM_DEFAULT_ATTENTION_DAYS,
  },
  {
    id: "default-qualified",
    key: "qualified",
    name: "Qualified",
    color: "#7c3aed",
    sortOrder: 1,
    isActive: true,
    ghostedAfterDays: CRM_DEFAULT_ATTENTION_DAYS,
    stalledAfterDays: CRM_DEFAULT_ATTENTION_DAYS,
  },
  {
    id: "default-proposal",
    key: "proposal",
    name: "Proposal",
    color: "#ca8a04",
    sortOrder: 2,
    isActive: true,
    ghostedAfterDays: CRM_DEFAULT_ATTENTION_DAYS,
    stalledAfterDays: CRM_DEFAULT_ATTENTION_DAYS,
  },
  {
    id: "default-won",
    key: "won",
    name: "Won",
    color: "#16a34a",
    sortOrder: 3,
    isActive: true,
    ghostedAfterDays: CRM_DEFAULT_ATTENTION_DAYS,
    stalledAfterDays: CRM_DEFAULT_ATTENTION_DAYS,
  },
  {
    id: "default-lost",
    key: "lost",
    name: "Lost",
    color: "#dc2626",
    sortOrder: 4,
    isActive: true,
    ghostedAfterDays: CRM_DEFAULT_ATTENTION_DAYS,
    stalledAfterDays: CRM_DEFAULT_ATTENTION_DAYS,
  },
];

export const CRM_UNASSIGNED_STAGE: CrmPipelineStage = {
  id: "system-unassigned",
  key: CRM_UNASSIGNED_STAGE_KEY,
  name: "Unassigned",
  color: null,
  sortOrder: -1,
  isActive: true,
  ghostedAfterDays: CRM_DEFAULT_ATTENTION_DAYS,
  stalledAfterDays: CRM_DEFAULT_ATTENTION_DAYS,
};

export function normalizeCrmStageKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^stage:/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return normalized || null;
}

export function resolveCrmBoardStageKey(
  value: unknown,
  assignedStageKeys: ReadonlySet<string>
): string {
  const key = normalizeCrmStageKey(value);
  if (
    key &&
    key !== CRM_UNASSIGNED_STAGE_KEY &&
    assignedStageKeys.has(key)
  ) {
    return key;
  }
  return CRM_UNASSIGNED_STAGE_KEY;
}

export function crmAssignedStageQueryValues(
  assignedStageKeys: readonly string[]
): string[] {
  const values = new Set<string>();
  for (const key of assignedStageKeys) {
    if (!key || key === CRM_UNASSIGNED_STAGE_KEY) continue;
    const normalized = normalizeCrmStageKey(key) ?? key;
    const parts = normalized.split("_").filter(Boolean);
    const spaced = parts.join(" ");
    const titled = parts
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
    const titledKey = parts
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join("_");
    for (const variant of [
      normalized,
      normalized.toUpperCase(),
      titledKey,
      spaced,
      titled,
      spaced.toUpperCase(),
    ]) {
      if (!variant) continue;
      values.add(variant);
      values.add(` ${variant} `);
      values.add(stageKeyToInternalLabel(variant));
      values.add(` ${stageKeyToInternalLabel(variant)} `);
    }
  }
  return [...values];
}

export function stageKeyToInternalLabel(stageKey: string): string {
  return `stage:${stageKey}`;
}

function isStageLabel(value: unknown): boolean {
  return (
    typeof value === "string" && value.trim().toLowerCase().startsWith("stage:")
  );
}

export function replaceStageLabel(
  labels: unknown,
  nextStageKey: string | null
): string[] {
  const preserved = Array.isArray(labels)
    ? labels
        .map(label => (typeof label === "string" ? label.trim() : ""))
        .filter(label => label && !isStageLabel(label))
    : [];
  const normalizedStage = normalizeCrmStageKey(nextStageKey);
  if (!normalizedStage) return Array.from(new Set(preserved));
  return Array.from(
    new Set([...preserved, stageKeyToInternalLabel(normalizedStage)])
  );
}

export function validatePipelineStages(
  stages: CrmPipelineStageInput[]
): ValidatedCrmPipelineStageInput[] {
  const seen = new Set<string>();
  return stages.map((stage, index) => {
    const name = stage.name.trim();
    if (!name) {
      throw new Error("Pipeline stage name is required");
    }
    if (name.length > 80) {
      throw new Error("Pipeline stage name must be 80 characters or less");
    }

    const key = normalizeCrmStageKey(stage.key || name);
    if (!key || key === CRM_UNASSIGNED_STAGE_KEY) {
      throw new Error("Invalid pipeline stage key");
    }
    if (seen.has(key)) {
      throw new Error(`Duplicate pipeline stage: ${key}`);
    }
    seen.add(key);

    return {
      id: stage.id ?? null,
      key,
      name,
      color: stage.color ?? null,
      sortOrder:
        typeof stage.sortOrder === "number" && Number.isFinite(stage.sortOrder)
          ? stage.sortOrder
          : index,
      isActive: stage.isActive !== false,
      ghostedAfterDays: normalizeCrmAttentionDays(stage.ghostedAfterDays),
      stalledAfterDays: normalizeCrmAttentionDays(stage.stalledAfterDays),
    };
  });
}

export function getEffectivePipelineStages(
  persistedStages: CrmPipelineStage[]
): CrmPipelineStage[] {
  if (persistedStages.length === 0) return DEFAULT_CRM_PIPELINE_STAGES;

  const active = persistedStages
    .filter(stage => stage.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  return active;
}

export function normalizeStageForPersistence(value: unknown): string | null {
  const key = normalizeCrmStageKey(value);
  if (!key || key === CRM_UNASSIGNED_STAGE_KEY) return null;
  return key;
}
