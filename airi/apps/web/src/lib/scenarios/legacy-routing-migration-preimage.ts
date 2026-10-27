import { createHash, type Hash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import mongoose, { type ClientSession } from "mongoose";

import {
  Conversation,
  CONVERSATION_SCENARIO_PENDING_WAIT_INDEX_KEYS,
  CONVERSATION_SCENARIO_PENDING_WAIT_INDEX_NAME,
  CONVERSATION_SCENARIO_PENDING_WAIT_PARTIAL_FILTER,
} from "@/models/conversation";
import { Scenario } from "@/models/scenario";
import ScenarioLinkedCondition from "@/models/scenario-linked-condition";
import { asNullableRecord } from "@icecore/shared/lib/value-utils";

// The shared contract serializer intentionally stops at 1 MB. Migration
// evidence can contain several valid 16 MB Mongo documents, so this path
// streams canonical tokens into SHA-256 and applies a target-wide safety cap.
const MAX_MIGRATION_DIGEST_BYTES = 512 * 1024 * 1024;
const MAX_MIGRATION_DIGEST_MEMBERS = 10_000_000;
const MAX_MIGRATION_DIGEST_DEPTH = 256;
const MIGRATION_BSON_TAG = "$airiBson";

export type LegacyRoutingMigrationCandidatePair = {
  sourceActionNodeId: string;
  sourceNodeId: string;
};

type LegacyRoutingMigrationScenarioPreimage = {
  _id: string;
  workspaceId: string;
  graphSchemaVersion: number | null;
  nodes: unknown;
  edges: unknown;
  status: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  __v: number | null;
};

type LegacyRoutingMigrationConversationPreimage = {
  _id: string;
  workspaceId: string;
  airi_scenario_state: unknown;
  updatedAt: string | null;
  __v: number | null;
};

type LegacyRoutingMigrationLinkedConditionPreimage = {
  _id: string;
  workspaceId: string;
  parentRefs: unknown;
  updatedAt: string | null;
  __v: number | null;
};

type LegacyRoutingMigrationPreimagePayload = {
  version: 1;
  target: {
    workspaceId: string;
    scenarioId: string;
    candidatePairs: LegacyRoutingMigrationCandidatePair[];
  };
  scenario: LegacyRoutingMigrationScenarioPreimage;
  pendingConversations: LegacyRoutingMigrationConversationPreimage[];
  linkedConditions: LegacyRoutingMigrationLinkedConditionPreimage[];
};

export type LegacyRoutingMigrationPreimage =
  LegacyRoutingMigrationPreimagePayload & {
    preimageSha256: string;
  };

type RawMigrationRow = Record<string, unknown>;

type RawPreimageInput = {
  target: {
    workspaceId: string;
    scenarioId: string;
    candidatePairs: LegacyRoutingMigrationCandidatePair[];
  };
  scenario: RawMigrationRow;
  pendingConversations: RawMigrationRow[];
  linkedConditions: RawMigrationRow[];
};

export type LegacyRoutingMigrationLoadedState = {
  preimage: LegacyRoutingMigrationPreimage;
  raw: {
    scenario: RawMigrationRow;
    pendingConversations: RawMigrationRow[];
    linkedConditions: RawMigrationRow[];
  };
  semantic: {
    scenario: RawMigrationRow;
  };
};

type LegacyRoutingMigrationExternalStateIssue = {
  kind: "pending_conversation" | "linked_condition_parent_ref";
  recordId: string;
  conditionNodeId: string | null;
  sourceActionNodeId: string | null;
  expectedSourceActionNodeIds: string[];
  reason:
    | "malformed_state"
    | "missing_source_action"
    | "wrong_source_action"
    | "missing_target_parent_ref";
  parentRefIndex?: number;
};

class LegacyRoutingMigrationPreimageLoadError extends Error {
  readonly name = "LegacyRoutingMigrationPreimageLoadError";

  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause }
    );
  }
}

class LegacyRoutingMigrationDigestError extends Error {
  readonly name = "LegacyRoutingMigrationDigestError";
}

type DigestState = {
  hash: Hash;
  bytes: number;
  members: number;
  seen: Set<object>;
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function legacyRoutingMigrationCandidatePairKey(
  pair: LegacyRoutingMigrationCandidatePair
): string {
  return `${pair.sourceActionNodeId.trim()}\u0000${pair.sourceNodeId.trim()}`;
}

function canonicalCandidatePairs(
  pairs: LegacyRoutingMigrationCandidatePair[]
): LegacyRoutingMigrationCandidatePair[] {
  const byKey = new Map<string, LegacyRoutingMigrationCandidatePair>();
  for (const pair of pairs) {
    const canonical = {
      sourceActionNodeId: pair.sourceActionNodeId.trim(),
      sourceNodeId: pair.sourceNodeId.trim(),
    };
    byKey.set(legacyRoutingMigrationCandidatePairKey(canonical), canonical);
  }
  return Array.from(byKey.values()).sort((left, right) =>
    compareText(
      legacyRoutingMigrationCandidatePairKey(left),
      legacyRoutingMigrationCandidatePairKey(right)
    )
  );
}

function failDigest(message: string): never {
  throw new LegacyRoutingMigrationDigestError(message);
}

function emitDigest(state: DigestState, value: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  state.bytes += bytes;
  if (state.bytes > MAX_MIGRATION_DIGEST_BYTES) {
    failDigest("Legacy routing migration digest byte limit exceeded");
  }
  state.hash.update(value, "utf8");
}

function addDigestMember(state: DigestState): void {
  state.members += 1;
  if (state.members > MAX_MIGRATION_DIGEST_MEMBERS) {
    failDigest("Legacy routing migration digest member limit exceeded");
  }
}

function digestCanonicalValue(
  value: unknown,
  state: DigestState,
  depth: number
): void {
  if (depth > MAX_MIGRATION_DIGEST_DEPTH) {
    failDigest("Legacy routing migration digest depth limit exceeded");
  }
  if (value === null || typeof value === "boolean") {
    emitDigest(state, JSON.stringify(value));
    return;
  }
  if (typeof value === "string") {
    emitDigest(state, JSON.stringify(value));
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      failDigest("Legacy routing migration digest rejects non-finite numbers");
    }
    emitDigest(state, JSON.stringify(value));
    return;
  }
  if (typeof value !== "object") {
    failDigest(`Legacy routing migration digest rejects ${typeof value}`);
  }
  if (state.seen.has(value)) {
    failDigest("Legacy routing migration digest rejects cycles");
  }

  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      emitDigest(state, "[");
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          failDigest("Legacy routing migration digest rejects sparse arrays");
        }
        addDigestMember(state);
        if (index > 0) emitDigest(state, ",");
        digestCanonicalValue(value[index], state, depth + 1);
      }
      emitDigest(state, "]");
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) {
      failDigest("Legacy routing migration digest requires plain objects");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareText);
    emitDigest(state, "{");
    for (const [index, key] of keys.entries()) {
      const child = record[key];
      if (child === undefined) {
        failDigest("Legacy routing migration digest rejects undefined values");
      }
      addDigestMember(state);
      if (index > 0) emitDigest(state, ",");
      emitDigest(state, JSON.stringify(key));
      emitDigest(state, ":");
      digestCanonicalValue(child, state, depth + 1);
    }
    emitDigest(state, "}");
  } finally {
    state.seen.delete(value);
  }
}

export function hashLegacyRoutingMigrationValue(value: unknown): string {
  const hash = createHash("sha256");
  digestCanonicalValue(
    value,
    { hash, bytes: 0, members: 0, seen: new Set() },
    0
  );
  return hash.digest("hex");
}

function readId(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (
    typeof value === "object" &&
    "toHexString" in value &&
    typeof value.toHexString === "function"
  ) {
    return String(value.toHexString()).trim();
  }
  return String(value).trim();
}

function normalizeDate(value: unknown): string | null {
  const parsed =
    value instanceof Date
      ? value
      : typeof value === "string" || typeof value === "number"
        ? new Date(value)
        : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toISOString()
    : null;
}

function normalizeVersion(value: unknown): number | null {
  let numericValue = value;
  if (value !== null && typeof value === "object") {
    const bsonValue = value as {
      _bsontype?: unknown;
      value?: unknown;
      toNumber?: unknown;
    };
    if (
      (bsonValue._bsontype === "Int32" || bsonValue._bsontype === "Double") &&
      typeof bsonValue.value === "number"
    ) {
      numericValue = bsonValue.value;
    } else if (
      bsonValue._bsontype === "Long" &&
      typeof bsonValue.toNumber === "function"
    ) {
      numericValue = bsonValue.toNumber();
    }
  }
  return typeof numericValue === "number" &&
    Number.isSafeInteger(numericValue) &&
    numericValue >= 0
    ? numericValue
    : null;
}

function taggedBsonValue(
  type: string,
  value: unknown
): Record<string, unknown> {
  return { [MIGRATION_BSON_TAG]: { type, value } };
}

function canonicalBsonValue(value: object, type: string): unknown {
  try {
    return normalizeMongoValue(
      mongoose.mongo.BSON.EJSON.serialize(value, { relaxed: false })
    );
  } catch (error) {
    throw new LegacyRoutingMigrationDigestError(
      `Legacy routing migration evidence cannot encode BSON ${type}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function normalizeMongoValue(value: unknown): unknown {
  if (value === null) return null;
  if (value === undefined) {
    return taggedBsonValue("Undefined", null);
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value) && !Object.is(value, -0)) return value;
    return taggedBsonValue("Double", {
      $numberDouble: Number.isNaN(value)
        ? "NaN"
        : value === Number.POSITIVE_INFINITY
          ? "Infinity"
          : value === Number.NEGATIVE_INFINITY
            ? "-Infinity"
            : "-0.0",
    });
  }
  if (typeof value === "bigint") {
    return taggedBsonValue("Long", { $numberLong: value.toString() });
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new LegacyRoutingMigrationDigestError(
      `Legacy routing migration evidence rejects ${typeof value}`
    );
  }
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    if (!Number.isFinite(milliseconds)) {
      throw new LegacyRoutingMigrationDigestError(
        "Legacy routing migration evidence rejects invalid BSON dates"
      );
    }
    return taggedBsonValue("Date", {
      $date: { $numberLong: String(milliseconds) },
    });
  }
  if (Buffer.isBuffer(value)) {
    return taggedBsonValue("Binary", {
      $binary: { base64: value.toString("base64"), subType: "00" },
    });
  }
  if (value instanceof RegExp) {
    return taggedBsonValue("RegExp", {
      $regularExpression: { pattern: value.source, options: value.flags },
    });
  }
  if (Array.isArray(value)) {
    return value.map(item => normalizeMongoValue(item));
  }
  if (typeof value !== "object") {
    throw new LegacyRoutingMigrationDigestError(
      "Legacy routing migration evidence encountered an unsupported value"
    );
  }
  const prototype = Object.getPrototypeOf(value);
  const bsonType =
    prototype !== null &&
    prototype !== Object.prototype &&
    "_bsontype" in value &&
    typeof value._bsontype === "string"
      ? value._bsontype
      : null;
  if (
    bsonType === "ObjectId" &&
    "toHexString" in value &&
    typeof value.toHexString === "function"
  ) {
    return taggedBsonValue("ObjectId", {
      $oid: String(value.toHexString()),
    });
  }
  if (bsonType) {
    return taggedBsonValue(bsonType, canonicalBsonValue(value, bsonType));
  }

  if (prototype !== null && prototype !== Object.prototype) {
    throw new LegacyRoutingMigrationDigestError(
      "Legacy routing migration evidence requires plain BSON documents"
    );
  }
  const entries = Object.entries(value).map(([key, child]) => [
    key,
    normalizeMongoValue(child),
  ]);
  return Object.hasOwn(value, MIGRATION_BSON_TAG)
    ? taggedBsonValue("Document", entries)
    : Object.fromEntries(entries);
}

function normalizeScenario(
  row: RawMigrationRow
): LegacyRoutingMigrationScenarioPreimage {
  return {
    _id: readId(row._id),
    workspaceId: readId(row.workspaceId),
    graphSchemaVersion: normalizeVersion(row.graphSchemaVersion),
    nodes: normalizeMongoValue(row.nodes),
    edges: normalizeMongoValue(row.edges),
    status: typeof row.status === "string" ? row.status : null,
    updatedBy: typeof row.updatedBy === "string" ? row.updatedBy : null,
    updatedAt: normalizeDate(row.updatedAt),
    __v: normalizeVersion(row.__v),
  };
}

function normalizeConversation(
  row: RawMigrationRow
): LegacyRoutingMigrationConversationPreimage {
  return {
    _id: readId(row._id),
    workspaceId: readId(row.workspaceId),
    airi_scenario_state: normalizeMongoValue(row.airi_scenario_state),
    updatedAt: normalizeDate(row.updatedAt),
    __v: normalizeVersion(row.__v),
  };
}

function normalizeLinkedCondition(
  row: RawMigrationRow
): LegacyRoutingMigrationLinkedConditionPreimage {
  return {
    _id: readId(row._id),
    workspaceId: readId(row.workspaceId),
    parentRefs: normalizeMongoValue(row.parentRefs),
    updatedAt: normalizeDate(row.updatedAt),
    __v: normalizeVersion(row.__v),
  };
}

export function buildLegacyRoutingMigrationPreimage(
  input: RawPreimageInput
): LegacyRoutingMigrationPreimage {
  const payload: LegacyRoutingMigrationPreimagePayload = {
    version: 1,
    target: {
      workspaceId: input.target.workspaceId.trim(),
      scenarioId: input.target.scenarioId.trim(),
      candidatePairs: canonicalCandidatePairs(input.target.candidatePairs),
    },
    scenario: normalizeScenario(input.scenario),
    pendingConversations: input.pendingConversations
      .map(normalizeConversation)
      .sort((left, right) => compareText(left._id, right._id)),
    linkedConditions: input.linkedConditions
      .map(normalizeLinkedCondition)
      .sort((left, right) => compareText(left._id, right._id)),
  };
  return {
    ...payload,
    preimageSha256: hashLegacyRoutingMigrationValue(payload),
  };
}

function sourceActionsByCondition(
  pairs: LegacyRoutingMigrationCandidatePair[]
): Map<string, string[]> {
  const result = new Map<string, Set<string>>();
  for (const pair of canonicalCandidatePairs(pairs)) {
    const actions = result.get(pair.sourceNodeId) || new Set<string>();
    actions.add(pair.sourceActionNodeId);
    result.set(pair.sourceNodeId, actions);
  }
  return new Map(
    Array.from(result.entries()).map(([conditionNodeId, actions]) => [
      conditionNodeId,
      Array.from(actions).sort(compareText),
    ])
  );
}

function issueForSource(params: {
  kind: LegacyRoutingMigrationExternalStateIssue["kind"];
  recordId: string;
  conditionNodeId: string;
  sourceActionNodeId: string;
  expectedSourceActionNodeIds: string[];
  parentRefIndex?: number;
}): LegacyRoutingMigrationExternalStateIssue | null {
  if (
    params.sourceActionNodeId &&
    params.expectedSourceActionNodeIds.includes(params.sourceActionNodeId)
  ) {
    return null;
  }
  return {
    kind: params.kind,
    recordId: params.recordId,
    conditionNodeId: params.conditionNodeId || null,
    sourceActionNodeId: params.sourceActionNodeId || null,
    expectedSourceActionNodeIds: params.expectedSourceActionNodeIds,
    reason: params.sourceActionNodeId
      ? "wrong_source_action"
      : "missing_source_action",
    ...(params.parentRefIndex === undefined
      ? {}
      : { parentRefIndex: params.parentRefIndex }),
  };
}

export function classifyLegacyRoutingMigrationExternalState(
  preimage: LegacyRoutingMigrationPreimage
): LegacyRoutingMigrationExternalStateIssue[] {
  const expectedByCondition = sourceActionsByCondition(
    preimage.target.candidatePairs
  );
  const issues: LegacyRoutingMigrationExternalStateIssue[] = [];

  for (const row of preimage.pendingConversations) {
    const state = asNullableRecord(row.airi_scenario_state);
    if (!state) {
      issues.push({
        kind: "pending_conversation",
        recordId: row._id,
        conditionNodeId: null,
        sourceActionNodeId: null,
        expectedSourceActionNodeIds: [],
        reason: "malformed_state",
      });
      continue;
    }
    const conditionNodeId = readId(state.pendingConditionNodeId);
    const expectedSourceActionNodeIds =
      expectedByCondition.get(conditionNodeId) || [];
    const issue = issueForSource({
      kind: "pending_conversation",
      recordId: row._id,
      conditionNodeId,
      sourceActionNodeId: readId(state.pendingSourceActionNodeId),
      expectedSourceActionNodeIds,
    });
    if (issue) issues.push(issue);
  }

  for (const row of preimage.linkedConditions) {
    if (!Array.isArray(row.parentRefs)) {
      issues.push({
        kind: "linked_condition_parent_ref",
        recordId: row._id,
        conditionNodeId: null,
        sourceActionNodeId: null,
        expectedSourceActionNodeIds: [],
        reason: "missing_target_parent_ref",
      });
      continue;
    }
    let targetRefCount = 0;
    row.parentRefs.forEach((value, parentRefIndex) => {
      const parentRef = asNullableRecord(value);
      if (!parentRef) return;
      const conditionNodeId = readId(parentRef.conditionNodeId);
      const expectedSourceActionNodeIds =
        expectedByCondition.get(conditionNodeId);
      if (
        readId(parentRef.parentScenarioId) !== preimage.target.scenarioId ||
        !expectedSourceActionNodeIds
      ) {
        return;
      }
      targetRefCount += 1;
      const issue = issueForSource({
        kind: "linked_condition_parent_ref",
        recordId: row._id,
        conditionNodeId,
        sourceActionNodeId: readId(parentRef.sourceActionNodeId),
        expectedSourceActionNodeIds,
        parentRefIndex,
      });
      if (issue) issues.push(issue);
    });
    if (targetRefCount === 0) {
      issues.push({
        kind: "linked_condition_parent_ref",
        recordId: row._id,
        conditionNodeId: null,
        sourceActionNodeId: null,
        expectedSourceActionNodeIds: [],
        reason: "missing_target_parent_ref",
      });
    }
  }

  return issues;
}

function candidateConditionNodeIds(
  candidatePairs: LegacyRoutingMigrationCandidatePair[]
): string[] {
  return Array.from(
    new Set(
      candidatePairs
        .map(pair => pair.sourceNodeId.trim())
        .filter(conditionNodeId => conditionNodeId.length > 0)
    )
  ).sort(compareText);
}

function pendingConversationFilter(params: {
  workspaceId: string;
  scenarioId: string;
  conditionNodeIds: string[];
}) {
  return {
    workspaceId: params.workspaceId,
    "airi_scenario_state.lockedScenarioId": params.scenarioId,
    "airi_scenario_state.pendingConditionNodeId": {
      $in: params.conditionNodeIds,
    },
  };
}

function linkedConditionFilter(params: {
  workspaceId: string;
  scenarioId: string;
  conditionNodeIds: string[];
}) {
  return {
    workspaceId: params.workspaceId,
    parentRefs: {
      $elemMatch: {
        parentScenarioId: params.scenarioId,
        conditionNodeId: { $in: params.conditionNodeIds },
      },
    },
  };
}

const RAW_BSON_READ_OPTIONS = {
  promoteValues: false,
  promoteLongs: false,
  promoteBuffers: false,
  bsonRegExp: true,
} as const;

function promoteRawMigrationRow(row: RawMigrationRow): RawMigrationRow {
  return mongoose.mongo.BSON.deserialize(
    mongoose.mongo.BSON.serialize(row)
  ) as RawMigrationRow;
}

async function assertPendingWaitIndexAvailable(): Promise<void> {
  try {
    const indexes = await Conversation.collection.listIndexes().toArray();
    const index = indexes.find(
      candidate =>
        candidate.name === CONVERSATION_SCENARIO_PENDING_WAIT_INDEX_NAME
    );
    if (!index) {
      throw new LegacyRoutingMigrationPreimageLoadError(
        "legacy_routing_pending_wait_index_missing",
        `Required migration index ${CONVERSATION_SCENARIO_PENDING_WAIT_INDEX_NAME} is not deployed.`
      );
    }
    const actualKeys = Object.entries(index.key ?? {});
    const expectedKeys = Object.entries(
      CONVERSATION_SCENARIO_PENDING_WAIT_INDEX_KEYS
    );
    const hasExactOrderedKeys =
      actualKeys.length === expectedKeys.length &&
      actualKeys.every(
        ([key, direction], indexPosition) =>
          key === expectedKeys[indexPosition]?.[0] &&
          direction === expectedKeys[indexPosition]?.[1]
      );
    if (
      !hasExactOrderedKeys ||
      !isDeepStrictEqual(
        index.partialFilterExpression,
        CONVERSATION_SCENARIO_PENDING_WAIT_PARTIAL_FILTER
      )
    ) {
      throw new LegacyRoutingMigrationPreimageLoadError(
        "legacy_routing_pending_wait_index_mismatch",
        `Required migration index ${CONVERSATION_SCENARIO_PENDING_WAIT_INDEX_NAME} has an unexpected definition.`
      );
    }
  } catch (error) {
    if (error instanceof LegacyRoutingMigrationPreimageLoadError) throw error;
    throw new LegacyRoutingMigrationPreimageLoadError(
      "legacy_routing_pending_wait_index_check_failed",
      `Could not verify required migration index ${CONVERSATION_SCENARIO_PENDING_WAIT_INDEX_NAME}.`,
      { cause: error }
    );
  }
}

function isMissingHintError(error: unknown): boolean {
  const value =
    error !== null && typeof error === "object"
      ? (error as { code?: unknown; codeName?: unknown; message?: unknown })
      : {};
  const message =
    typeof value.message === "string" ? value.message.toLowerCase() : "";
  return (
    value.code === 2 ||
    value.code === 27 ||
    value.codeName === "BadValue" ||
    value.codeName === "IndexNotFound" ||
    (message.includes("hint") && message.includes("index"))
  );
}

export async function loadLegacyRoutingMigrationState(params: {
  workspaceId: string;
  scenarioId: string;
  candidatePairs: LegacyRoutingMigrationCandidatePair[];
  session?: ClientSession;
}): Promise<LegacyRoutingMigrationLoadedState | null> {
  const candidatePairs = canonicalCandidatePairs(params.candidatePairs);
  const scenario = (await Scenario.collection.findOne(
    {
      _id: new mongoose.Types.ObjectId(params.scenarioId),
      workspaceId: params.workspaceId,
      deletedAt: null,
    },
    {
      ...RAW_BSON_READ_OPTIONS,
      ...(params.session ? { session: params.session } : {}),
      projection: {
        _id: 1,
        workspaceId: 1,
        graphSchemaVersion: 1,
        nodes: 1,
        edges: 1,
        status: 1,
        updatedBy: 1,
        updatedAt: 1,
        __v: 1,
      },
    }
  )) as RawMigrationRow | null;
  if (!scenario) return null;

  const pendingConversations: RawMigrationRow[] = [];
  const linkedConditions: RawMigrationRow[] = [];
  const conditionNodeIds = candidateConditionNodeIds(candidatePairs);
  if (conditionNodeIds.length > 0) {
    await assertPendingWaitIndexAvailable();
    try {
      const cursor = Conversation.collection.find(
        pendingConversationFilter({
          workspaceId: params.workspaceId,
          scenarioId: params.scenarioId,
          conditionNodeIds,
        }),
        {
          ...RAW_BSON_READ_OPTIONS,
          ...(params.session ? { session: params.session } : {}),
          hint: CONVERSATION_SCENARIO_PENDING_WAIT_INDEX_NAME,
          projection: {
            _id: 1,
            workspaceId: 1,
            airi_scenario_state: 1,
            updatedAt: 1,
            __v: 1,
          },
        }
      );
      pendingConversations.push(
        ...((await cursor.toArray()) as RawMigrationRow[])
      );
    } catch (error) {
      if (!isMissingHintError(error)) throw error;
      throw new LegacyRoutingMigrationPreimageLoadError(
        "legacy_routing_pending_wait_index_hint_failed",
        `Required migration index ${CONVERSATION_SCENARIO_PENDING_WAIT_INDEX_NAME} could not serve the pending-wait scan.`,
        { cause: error }
      );
    }

    const linkedConditionCursor = ScenarioLinkedCondition.collection.find(
      linkedConditionFilter({
        workspaceId: params.workspaceId,
        scenarioId: params.scenarioId,
        conditionNodeIds,
      }),
      {
        ...RAW_BSON_READ_OPTIONS,
        ...(params.session ? { session: params.session } : {}),
        projection: {
          _id: 1,
          workspaceId: 1,
          parentRefs: 1,
          updatedAt: 1,
          __v: 1,
        },
      }
    );
    linkedConditions.push(
      ...((await linkedConditionCursor.toArray()) as RawMigrationRow[])
    );
  }

  const semantic = {
    scenario: promoteRawMigrationRow(scenario),
  };

  return {
    raw: { scenario, pendingConversations, linkedConditions },
    semantic,
    preimage: buildLegacyRoutingMigrationPreimage({
      target: {
        workspaceId: params.workspaceId,
        scenarioId: params.scenarioId,
        candidatePairs,
      },
      scenario,
      pendingConversations,
      linkedConditions,
    }),
  };
}
