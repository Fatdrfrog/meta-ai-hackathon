import type { ScenarioPostActionConditionType } from "@icecore/scenario-contracts";
import { resolveConditionalScenarioLinkRefs } from "@icecore/scenario-contracts";
import {
  mutateScenarioGraphWithCas,
  type ScenarioGraphMutationProjection,
  type ScenarioGraphMutationResult,
} from "@/lib/scenarios/scenario-graph-mutation";
import {
  areConditionDefinitionsEqual,
  asEdges,
  asNodes,
  dedupeParentRefs,
  LinkedConditionRevisionConflictError,
  LINKED_CONDITION_ERROR_CODES,
  normalizeConditionConfigValue,
  normalizeParentRefs,
  normalizeString,
  normalizeTimestampMs,
  type LinkedConditionParentRef,
  type LinkedConditionRecord,
  type ScenarioGraphEdgeRecord,
  type ScenarioGraphNodeRecord,
  type ScenarioRecord,
} from "@/lib/scenarios/linked-conditions-types";
import { Scenario } from "@/models/scenario";
import ScenarioLinkedCondition from "@/models/scenario-linked-condition";
import { Types, type ClientSession } from "mongoose";

export function createLinkedConditionRecordId(): string {
  return String(new Types.ObjectId());
}

export async function loadScenarioForLinkedConditionSync(params: {
  workspaceId: string;
  scenarioId: string;
}): Promise<ScenarioRecord | null> {
  return Scenario.findOne({
    _id: params.scenarioId,
    workspaceId: params.workspaceId,
    deletedAt: null,
  })
    .select("_id workspaceId nodes edges updatedAt")
    .lean<ScenarioRecord | null>();
}

export async function loadChildScenarioGraphsByIds(params: {
  workspaceId: string;
  scenarioIds: string[];
}): Promise<ScenarioRecord[]> {
  if (params.scenarioIds.length === 0) return [];

  return Scenario.find({
    workspaceId: params.workspaceId,
    _id: { $in: params.scenarioIds },
    deletedAt: null,
  })
    .select("_id nodes")
    .lean<ScenarioRecord[]>();
}

export async function mutateLinkedConditionScenarioGraph<T>(params: {
  workspaceId: string;
  scenarioId: string;
  project: (scenario: ScenarioRecord) => ScenarioGraphMutationProjection<T> & {
    nodes?: ScenarioGraphNodeRecord[];
    edges?: ScenarioGraphEdgeRecord[];
  };
}): Promise<ScenarioGraphMutationResult<T>> {
  return mutateScenarioGraphWithCas({
    workspaceId: params.workspaceId,
    scenarioId: params.scenarioId,
    project: snapshot =>
      params.project({
        _id: params.scenarioId,
        workspaceId: params.workspaceId,
        nodes: snapshot.nodes,
        edges: snapshot.edges,
      }),
  });
}

export async function loadLinkedConditionRecordsForChild(params: {
  workspaceId: string;
  childScenarioId: string;
}): Promise<LinkedConditionRecord[]> {
  return ScenarioLinkedCondition.find({
    workspaceId: params.workspaceId,
    childScenarioId: params.childScenarioId,
  }).lean<LinkedConditionRecord[]>();
}

export async function loadLinkedConditionRecordForChild(params: {
  workspaceId: string;
  childScenarioId: string;
}): Promise<LinkedConditionRecord | null> {
  return ScenarioLinkedCondition.findOne({
    workspaceId: params.workspaceId,
    childScenarioId: params.childScenarioId,
  }).lean<LinkedConditionRecord | null>();
}

export async function loadLinkedConditionRecordsForChildren(params: {
  workspaceId: string;
  childScenarioIds: string[];
}): Promise<LinkedConditionRecord[]> {
  if (params.childScenarioIds.length === 0) return [];

  return ScenarioLinkedCondition.find({
    workspaceId: params.workspaceId,
    childScenarioId: { $in: params.childScenarioIds },
  }).lean<LinkedConditionRecord[]>();
}

export async function loadLinkedConditionParentSummaryRecords(params: {
  workspaceId: string;
  childScenarioIds: string[];
}): Promise<LinkedConditionRecord[]> {
  if (params.childScenarioIds.length === 0) return [];

  return ScenarioLinkedCondition.find({
    workspaceId: params.workspaceId,
    childScenarioId: { $in: params.childScenarioIds },
  })
    .select("childScenarioId parentRefs.parentScenarioId")
    .lean<LinkedConditionRecord[]>();
}

export async function loadLinkedConditionRecordsForParent(params: {
  workspaceId: string;
  parentScenarioId: string;
}): Promise<LinkedConditionRecord[]> {
  return ScenarioLinkedCondition.find({
    workspaceId: params.workspaceId,
    "parentRefs.parentScenarioId": params.parentScenarioId,
  }).lean<LinkedConditionRecord[]>();
}

export async function loadLinkedConditionRecordsByIds(params: {
  recordIds: string[];
}): Promise<LinkedConditionRecord[]> {
  if (params.recordIds.length === 0) return [];

  return ScenarioLinkedCondition.find({
    _id: { $in: params.recordIds },
  }).lean<LinkedConditionRecord[]>();
}

export async function updateLinkedConditionDefinition(params: {
  workspaceId: string;
  recordId: string;
  childTriggerNodeId: string;
  conditionType: ScenarioPostActionConditionType;
  conditionConfig: Record<string, unknown>;
}): Promise<void> {
  await ScenarioLinkedCondition.updateOne(
    { _id: params.recordId, workspaceId: params.workspaceId },
    {
      $set: {
        childTriggerNodeId: params.childTriggerNodeId,
        conditionType: params.conditionType,
        conditionConfig: params.conditionConfig,
        updatedAt: new Date(),
      },
    }
  );
}

type ExpectedParentScenarioRevision = {
  parentScenarioId: string;
  updatedAt: unknown;
  deleted?: boolean;
};

type PreferredLinkedConditionRecord = {
  recordId: string;
  childTriggerNodeId: string;
};

type ParentRefProjection = {
  ref: LinkedConditionParentRef;
  conditionType: ScenarioPostActionConditionType;
  conditionConfig: Record<string, unknown>;
};

function readRecordId(value: unknown): string {
  return normalizeString(String(value || ""));
}

function readDocumentVersion(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function sortRecordsById<T extends { _id?: unknown }>(records: T[]): T[] {
  return [...records].sort((left, right) =>
    readRecordId(left._id).localeCompare(readRecordId(right._id))
  );
}

function versionFilter(value: unknown): number | { $exists: false } {
  return readDocumentVersion(value) ?? { $exists: false };
}

function parentRefProjectionsForScenario(params: {
  childScenarioId: string;
  parentScenario: ScenarioRecord;
}): ParentRefProjection[] {
  if (params.parentScenario.deletedAt) return [];

  const parentScenarioId = readRecordId(params.parentScenario._id);
  if (!parentScenarioId) return [];
  const resolved = resolveConditionalScenarioLinkRefs({
    nodes: asNodes(params.parentScenario.nodes),
    edges: asEdges(params.parentScenario.edges),
  });
  if (resolved.errors.length > 0) {
    throw new Error(resolved.errors[0]);
  }

  return resolved.refs.flatMap(ref => {
    if (normalizeString(ref.childScenarioId) !== params.childScenarioId) {
      return [];
    }
    return [
      {
        ref: {
          parentScenarioId,
          conditionNodeId: ref.conditionNodeId,
          branchType: ref.branchType,
          sourceActionNodeId: ref.sourceActionNodeId,
          scenarioLinkNodeId: ref.scenarioLinkNodeId,
        },
        conditionType: ref.branchType,
        conditionConfig: normalizeConditionConfigValue(ref.branchType, {
          timeoutMinutes: ref.branchConfig.timeoutMinutes,
          missingTextPhrases: ref.branchConfig.missingTextPhrases,
        }),
      } satisfies ParentRefProjection,
    ];
  });
}

function assertExpectedParentRevision(params: {
  expected: ExpectedParentScenarioRevision;
  parentScenario: ScenarioRecord | undefined;
}): void {
  const expectedMs = normalizeTimestampMs(params.expected.updatedAt);
  const currentMs = normalizeTimestampMs(params.parentScenario?.updatedAt);
  const currentDeleted = Boolean(params.parentScenario?.deletedAt);
  if (
    !params.parentScenario ||
    expectedMs === 0 ||
    currentMs !== expectedMs ||
    currentDeleted !== Boolean(params.expected.deleted)
  ) {
    throw new LinkedConditionRevisionConflictError("parent");
  }
}

function assertCompatibleParentDefinitions(
  projections: ParentRefProjection[]
): ParentRefProjection | null {
  const first = projections[0];
  if (!first) return null;
  if (
    projections.some(
      projection =>
        projection.conditionType !== first.conditionType ||
        !areConditionDefinitionsEqual({
          leftType: first.conditionType,
          leftConfig: first.conditionConfig,
          rightType: projection.conditionType,
          rightConfig: projection.conditionConfig,
        })
    )
  ) {
    throw new Error(LINKED_CONDITION_ERROR_CODES.conflictingChildReuse);
  }
  return first;
}

async function touchLinkedConditionScenarioFence(params: {
  workspaceId: string;
  scenarios: ScenarioRecord[];
  session: ClientSession;
}): Promise<void> {
  const sortedScenarios = sortRecordsById(params.scenarios);
  for (const scenario of sortedScenarios) {
    const scenarioId = readRecordId(scenario._id);
    if (!scenarioId) continue;
    const result = await Scenario.updateOne(
      {
        _id: scenarioId,
        workspaceId: params.workspaceId,
        deletedAt: scenario.deletedAt || null,
        updatedAt: scenario.updatedAt,
        __v: versionFilter(scenario.__v),
      },
      { $inc: { __v: 1 } },
      { session: params.session, timestamps: false }
    );
    if (result.matchedCount !== 1) {
      throw new LinkedConditionRevisionConflictError("parent");
    }
  }
}

async function deleteVersionedLinkedConditionRecords(params: {
  workspaceId: string;
  records: LinkedConditionRecord[];
  session: ClientSession;
}): Promise<void> {
  const sortedRecords = sortRecordsById(params.records);
  for (const record of sortedRecords) {
    const recordId = readRecordId(record._id);
    if (!recordId) continue;
    const result = await ScenarioLinkedCondition.deleteOne(
      {
        _id: recordId,
        workspaceId: params.workspaceId,
        __v: versionFilter(record.__v),
      },
      { session: params.session }
    );
    if (result.deletedCount !== 1) {
      throw new LinkedConditionRevisionConflictError("parent");
    }
  }
}

/**
 * Rebuilds one child's parent refs from the current parent Scenario graphs.
 * The Scenario writes are the serialization boundary shared with routing
 * migrations, so a paused reconciler cannot resurrect a stale condition ref.
 */
export async function reconcileLinkedConditionRecordWithParentFence(params: {
  workspaceId: string;
  childScenarioId: string;
  preferredRecord?: PreferredLinkedConditionRecord;
  expectedParent?: ExpectedParentScenarioRevision;
  forceDelete?: boolean;
}): Promise<LinkedConditionRecord | null> {
  const childScenarioId = normalizeString(params.childScenarioId);
  if (!childScenarioId) {
    throw new Error(LINKED_CONDITION_ERROR_CODES.invalidChildTrigger);
  }

  const session = (await Scenario.startSession()) as ClientSession;
  try {
    return await session.withTransaction(async () => {
      const records = await ScenarioLinkedCondition.find({
        workspaceId: params.workspaceId,
        childScenarioId,
      })
        .session(session)
        .lean<LinkedConditionRecord[]>({ defaults: false });
      const parentScenarioIds = new Set(
        records.flatMap(record =>
          normalizeParentRefs(record.parentRefs).map(
            parentRef => parentRef.parentScenarioId
          )
        )
      );
      if (params.expectedParent?.parentScenarioId) {
        parentScenarioIds.add(params.expectedParent.parentScenarioId);
      }

      const fencedScenarioIds = Array.from(
        new Set([childScenarioId, ...parentScenarioIds])
      ).sort();
      const fencedScenarios = await Scenario.find({
        workspaceId: params.workspaceId,
        _id: { $in: fencedScenarioIds },
      })
        .select("_id workspaceId nodes edges updatedAt deletedAt __v")
        .session(session)
        .lean<ScenarioRecord[]>({ defaults: false });
      const fencedScenarioById = new Map(
        fencedScenarios.map(scenario => [readRecordId(scenario._id), scenario])
      );
      if (!fencedScenarioById.has(childScenarioId)) {
        throw new Error(LINKED_CONDITION_ERROR_CODES.missingChildTrigger);
      }
      const parentScenarios = Array.from(parentScenarioIds).flatMap(
        parentScenarioId => {
          const scenario = fencedScenarioById.get(parentScenarioId);
          return scenario ? [scenario] : [];
        }
      );
      const parentScenarioById = new Map(
        parentScenarios.map(scenario => [readRecordId(scenario._id), scenario])
      );
      if (params.expectedParent) {
        assertExpectedParentRevision({
          expected: params.expectedParent,
          parentScenario: parentScenarioById.get(
            params.expectedParent.parentScenarioId
          ),
        });
      }

      const sortedParentScenarios = sortRecordsById(parentScenarios);
      const projections = params.forceDelete
        ? []
        : sortedParentScenarios.flatMap(parentScenario =>
            parentRefProjectionsForScenario({
              childScenarioId,
              parentScenario,
            })
          );
      const definition = assertCompatibleParentDefinitions(projections);
      const parentRefs = dedupeParentRefs(
        projections.map(projection => projection.ref)
      );
      if (records.length === 0 && parentRefs.length === 0) return null;

      await touchLinkedConditionScenarioFence({
        workspaceId: params.workspaceId,
        scenarios: fencedScenarios,
        session,
      });

      if (!definition || parentRefs.length === 0) {
        await deleteVersionedLinkedConditionRecords({
          workspaceId: params.workspaceId,
          records,
          session,
        });
        return null;
      }

      const preferredRecordId = normalizeString(
        params.preferredRecord?.recordId
      );
      const targetRecord =
        records.find(
          record => readRecordId(record._id) === preferredRecordId
        ) || records[0];
      const recordId =
        readRecordId(targetRecord?._id) ||
        preferredRecordId ||
        createLinkedConditionRecordId();
      const childTriggerNodeId =
        normalizeString(params.preferredRecord?.childTriggerNodeId) ||
        normalizeString(targetRecord?.childTriggerNodeId);
      if (!childTriggerNodeId) {
        throw new Error(LINKED_CONDITION_ERROR_CODES.missingChildTrigger);
      }

      const updatedAt = new Date();
      const result = await ScenarioLinkedCondition.updateOne(
        {
          _id: recordId,
          workspaceId: params.workspaceId,
          __v: versionFilter(targetRecord?.__v),
        },
        {
          $set: {
            workspaceId: params.workspaceId,
            childScenarioId,
            childTriggerNodeId,
            conditionType: definition.conditionType,
            conditionConfig: definition.conditionConfig,
            parentRefs,
            updatedAt,
          },
          $setOnInsert: { createdAt: updatedAt },
          $inc: { __v: 1 },
        },
        { upsert: !targetRecord, session, timestamps: false }
      );
      if (
        (targetRecord && result.matchedCount !== 1) ||
        (!targetRecord &&
          result.matchedCount !== 1 &&
          result.upsertedCount !== 1)
      ) {
        throw new LinkedConditionRevisionConflictError("parent");
      }

      await deleteVersionedLinkedConditionRecords({
        workspaceId: params.workspaceId,
        records: records.filter(
          record => readRecordId(record._id) !== recordId
        ),
        session,
      });
      return {
        _id: recordId,
        __v: (readDocumentVersion(targetRecord?.__v) ?? 0) + 1,
        workspaceId: params.workspaceId,
        childScenarioId,
        childTriggerNodeId,
        conditionType: definition.conditionType,
        conditionConfig: definition.conditionConfig,
        parentRefs,
        updatedAt,
      } satisfies LinkedConditionRecord;
    });
  } finally {
    await session.endSession();
  }
}
