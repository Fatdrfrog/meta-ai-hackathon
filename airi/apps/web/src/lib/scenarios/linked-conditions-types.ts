import type { ScenarioPostActionConditionType } from "@icecore/scenario-contracts";
import { normalizeMissingTextPhrases } from "@icecore/scenario-contracts";
import { readArray, readTrimmedString } from "@icecore/shared/lib/value-utils";

export type ScenarioGraphNodeRecord = {
  id?: string;
  data?: Record<string, unknown>;
};
export type ScenarioGraphEdgeRecord = {
  id?: string;
  source?: string;
  target?: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

export type ScenarioRecord = {
  _id?: unknown;
  __v?: unknown;
  workspaceId?: unknown;
  nodes?: unknown;
  edges?: unknown;
  updatedAt?: unknown;
  deletedAt?: unknown;
};

export type LinkedConditionParentRef = {
  parentScenarioId: string;
  conditionNodeId: string;
  branchType: ScenarioPostActionConditionType;
  sourceActionNodeId: string;
  scenarioLinkNodeId: string;
};

export type LinkedConditionRecord = {
  _id?: unknown;
  __v?: unknown;
  workspaceId?: unknown;
  childScenarioId?: unknown;
  childTriggerNodeId?: unknown;
  conditionType?: unknown;
  conditionConfig?: Record<string, unknown> | null;
  updatedAt?: unknown;
  parentRefs?: Array<{
    parentScenarioId?: unknown;
    conditionNodeId?: unknown;
    branchType?: unknown;
    sourceActionNodeId?: unknown;
    scenarioLinkNodeId?: unknown;
  }>;
};

export const LINKED_CONDITION_ERROR_CODES = {
  conflictingChildReuse: "linked_condition_conflicting_child_reuse",
  missingChildTrigger: "linked_condition_missing_child_trigger",
  invalidChildTrigger: "linked_condition_invalid_child_trigger",
  conflictingParentBranchTarget:
    "linked_condition_conflicting_parent_branch_target",
  revisionConflict: "linked_condition_revision_conflict",
} as const;

export type LinkedConditionErrorCode =
  (typeof LINKED_CONDITION_ERROR_CODES)[keyof typeof LINKED_CONDITION_ERROR_CODES];

export type LinkedConditionRevisionConflictScope = "graph" | "parent";

export class LinkedConditionRevisionConflictError extends Error {
  readonly code = LINKED_CONDITION_ERROR_CODES.revisionConflict;

  constructor(readonly scope: LinkedConditionRevisionConflictScope) {
    super(LINKED_CONDITION_ERROR_CODES.revisionConflict);
    this.name = "LinkedConditionRevisionConflictError";
  }
}

export function isLinkedConditionRevisionConflict(error: unknown): boolean {
  return (
    error instanceof LinkedConditionRevisionConflictError ||
    (error instanceof Error &&
      error.message === LINKED_CONDITION_ERROR_CODES.revisionConflict)
  );
}

export const normalizeString = readTrimmedString;

export const asNodes = readArray<ScenarioGraphNodeRecord>;
export const asEdges = readArray<ScenarioGraphEdgeRecord>;

export function normalizeConditionType(
  value: unknown
): ScenarioPostActionConditionType | null {
  return value === "user_replied" ||
    value === "payment_detected" ||
    value === "no_reply_timeout"
    ? value
    : null;
}

export function normalizeConditionConfigValue(
  type: ScenarioPostActionConditionType,
  config: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (type === "no_reply_timeout") {
    const timeoutMinutes = Number(config?.timeoutMinutes);
    const missingTextPhrases = normalizeMissingTextPhrases(
      config?.missingTextPhrases
    );
    return {
      timeoutMinutes:
        Number.isFinite(timeoutMinutes) && timeoutMinutes >= 1
          ? Math.floor(timeoutMinutes)
          : 30,
      ...(missingTextPhrases.length > 0 ? { missingTextPhrases } : {}),
    };
  }

  return {};
}

export function serializeComparableCondition(params: {
  type: ScenarioPostActionConditionType;
  config: Record<string, unknown>;
}): string {
  return JSON.stringify({
    type: params.type,
    config: normalizeConditionConfigValue(params.type, params.config),
  });
}

export function areConditionDefinitionsEqual(params: {
  leftType: ScenarioPostActionConditionType;
  leftConfig: Record<string, unknown> | null | undefined;
  rightType: ScenarioPostActionConditionType;
  rightConfig: Record<string, unknown> | null | undefined;
}): boolean {
  return (
    serializeComparableCondition({
      type: params.leftType,
      config: params.leftConfig || {},
    }) ===
    serializeComparableCondition({
      type: params.rightType,
      config: params.rightConfig || {},
    })
  );
}

export function normalizeParentRefs(
  value: LinkedConditionRecord["parentRefs"]
): LinkedConditionParentRef[] {
  return Array.isArray(value)
    ? value.flatMap(parentRef => {
        const parentScenarioId = normalizeString(parentRef?.parentScenarioId);
        const conditionNodeId = normalizeString(parentRef?.conditionNodeId);
        const branchType = normalizeConditionType(parentRef?.branchType);
        const sourceActionNodeId = normalizeString(
          parentRef?.sourceActionNodeId
        );
        const scenarioLinkNodeId = normalizeString(
          parentRef?.scenarioLinkNodeId
        );
        if (
          !parentScenarioId ||
          !conditionNodeId ||
          !branchType ||
          !sourceActionNodeId ||
          !scenarioLinkNodeId
        ) {
          return [];
        }
        return [
          {
            parentScenarioId,
            conditionNodeId,
            branchType,
            sourceActionNodeId,
            scenarioLinkNodeId,
          } satisfies LinkedConditionParentRef,
        ];
      })
    : [];
}

export function dedupeParentRefs(
  refs: LinkedConditionParentRef[]
): LinkedConditionParentRef[] {
  const seen = new Set<string>();
  const nextRefs: LinkedConditionParentRef[] = [];

  for (const ref of refs) {
    const key = JSON.stringify([
      ref.parentScenarioId,
      ref.conditionNodeId,
      ref.branchType,
      ref.sourceActionNodeId,
      ref.scenarioLinkNodeId,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    nextRefs.push(ref);
  }

  return nextRefs;
}

export function normalizeTimestampMs(value: unknown): number {
  const timestamp =
    value instanceof Date
      ? value.getTime()
      : typeof value === "string" || typeof value === "number"
        ? new Date(value).getTime()
        : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}
