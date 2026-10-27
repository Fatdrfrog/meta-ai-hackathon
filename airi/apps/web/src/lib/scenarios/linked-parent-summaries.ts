import type { PipelineStage } from "mongoose";
import { loadLinkedConditionParentSummaryRecords } from "@/lib/scenarios/linked-condition-repository";
import {
  normalizeString,
  type LinkedConditionRecord,
} from "@/lib/scenarios/linked-conditions-types";
import ScenarioLinkedCondition from "@/models/scenario-linked-condition";

/** Row field a list aggregate's `$lookup` fills with linked conditions. */
const LINKED_PARENT_LOOKUP_FIELD = "linkedParentConditionRecords";

type ScenarioWithLinkedParents = {
  _id: string;
  linkedParentScenarioIds?: string[];
};

type LinkedConditionParentSummaryRecord = Pick<
  LinkedConditionRecord,
  "childScenarioId" | "parentRefs"
>;

export function extractLinkedParentScenarioIds(
  records: LinkedConditionParentSummaryRecord[]
): Map<string, string[]> {
  const parentIdsByChildId = new Map<string, Set<string>>();

  for (const record of records) {
    const childScenarioId = normalizeString(record.childScenarioId);
    if (!childScenarioId) continue;

    const parentIds =
      parentIdsByChildId.get(childScenarioId) ?? new Set<string>();
    for (const parentRef of Array.isArray(record.parentRefs)
      ? record.parentRefs
      : []) {
      const parentScenarioId = normalizeString(parentRef?.parentScenarioId);
      if (!parentScenarioId || parentScenarioId === childScenarioId) continue;
      parentIds.add(parentScenarioId);
    }
    parentIdsByChildId.set(childScenarioId, parentIds);
  }

  return new Map(
    Array.from(parentIdsByChildId.entries()).map(
      ([childScenarioId, parentIds]) => [childScenarioId, Array.from(parentIds)]
    )
  );
}

export async function attachLinkedParentScenarioIds<
  T extends ScenarioWithLinkedParents,
>(input: T, workspaceId: string): Promise<T>;
export async function attachLinkedParentScenarioIds<
  T extends ScenarioWithLinkedParents,
>(input: T[], workspaceId: string): Promise<T[]>;
export async function attachLinkedParentScenarioIds<
  T extends ScenarioWithLinkedParents,
>(input: T | T[], workspaceId: string): Promise<T | T[]> {
  const items = Array.isArray(input) ? input : [input];
  const normalizedWorkspaceId = normalizeString(workspaceId);
  const childScenarioIds = Array.from(
    new Set(items.map(item => normalizeString(item._id)).filter(Boolean))
  );
  const records =
    normalizedWorkspaceId && childScenarioIds.length > 0
      ? await loadLinkedConditionParentSummaryRecords({
          workspaceId: normalizedWorkspaceId,
          childScenarioIds,
        })
      : [];
  const parentIdsByChildId = extractLinkedParentScenarioIds(records);

  const decorate = (item: T): T => ({
    ...item,
    linkedParentScenarioIds: parentIdsByChildId.get(item._id) ?? [],
  });

  return Array.isArray(input) ? items.map(decorate) : decorate(input);
}

/**
 * A `$lookup` stage that reads the records and fields
 * `attachLinkedParentScenarioIds` reads, so a scenario aggregate gets its
 * rows' parent ids in the same round trip. The unique
 * workspaceId+childScenarioId index serves it.
 */
export function buildLinkedParentScenarioIdsLookupStage(
  workspaceId: string
): PipelineStage.Lookup {
  return {
    $lookup: {
      from: ScenarioLinkedCondition.collection.name,
      let: { childScenarioId: { $toString: "$_id" } },
      pipeline: [
        {
          $match: {
            workspaceId: normalizeString(workspaceId),
            $expr: { $eq: ["$childScenarioId", "$$childScenarioId"] },
          },
        },
        {
          $project: {
            _id: 0,
            childScenarioId: 1,
            "parentRefs.parentScenarioId": 1,
          },
        },
      ],
      as: LINKED_PARENT_LOOKUP_FIELD,
    },
  };
}

/**
 * Replaces a looked-up row's linked-condition records with the
 * `linkedParentScenarioIds` that `attachLinkedParentScenarioIds` would give
 * it: unique parent ids without self-links.
 */
export function applyLookedUpLinkedParentScenarioIds(
  row: Record<string, unknown>
): Record<string, unknown> {
  const { [LINKED_PARENT_LOOKUP_FIELD]: records, ...rest } = row;
  const parentIdsByChildId = extractLinkedParentScenarioIds(
    Array.isArray(records)
      ? (records as LinkedConditionParentSummaryRecord[])
      : []
  );
  return {
    ...rest,
    linkedParentScenarioIds:
      parentIdsByChildId.get(String(row._id ?? "")) ?? [],
  };
}
