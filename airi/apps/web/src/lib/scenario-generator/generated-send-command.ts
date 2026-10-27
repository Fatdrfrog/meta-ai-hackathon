import "server-only";

import {
  advanceGeneratedRecipientAudience,
  createGeneratedRecipientAudience,
  generatedRecipientAudiencesEqual,
  GENERATED_RECIPIENT_AUDIENCE_MAX_PAGE_SIZE,
  normalizeGeneratedRecipientAudience,
  type GeneratedRecipientAudience,
} from "@/lib/campaign/generated-recipient-audience";
import { deriveBulkSendChildCampaignId } from "@/lib/campaign/bulk-send-api-idempotency";
import connectDB from "@/lib/mongoose";
import {
  SCENARIO_GENERATED_RECIPIENT_IDENTITY_INDEX_KEYS,
  SCENARIO_GENERATED_RECIPIENT_IDENTITY_INDEX_OPTIONS,
  SCENARIO_GENERATED_RECIPIENT_LEGACY_DRAFT_PAGE_INDEX_NAME,
  SCENARIO_GENERATED_RECIPIENT_LEGACY_IDENTITY_INDEX_NAME,
  SCENARIO_GENERATED_RECIPIENT_LEGACY_OPERATION_INDEX_NAME,
  SCENARIO_GENERATED_RECIPIENT_OPERATION_PAGE_INDEX_KEYS,
  SCENARIO_GENERATED_RECIPIENT_OPERATION_PAGE_INDEX_OPTIONS,
  SCENARIO_GENERATED_RECIPIENT_REVISION_DRAFT_INDEX_KEYS,
  SCENARIO_GENERATED_RECIPIENT_REVISION_DRAFT_INDEX_OPTIONS,
  SCENARIO_GENERATED_RECIPIENT_SOURCE_IDENTITY_INDEX_NAME,
  ScenarioGeneratedRecipientMessage,
} from "@/models/scenario-generated-recipient-message";
import {
  readNonEmptyString,
  readStringArray,
} from "@icecore/shared/lib/value-utils";

const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = GENERATED_RECIPIENT_AUDIENCE_MAX_PAGE_SIZE;
const MAX_BULK_WRITE_OPERATIONS = 500;

type MongoUpdateResult = {
  matchedCount?: number;
  modifiedCount?: number;
};

type GeneratedMessageBulkOperation = {
  updateMany: {
    filter: Record<string, unknown>;
    update: { $set: Record<string, unknown> };
  };
};

type GeneratedRecipientIndexCache = {
  ready: boolean;
  promise: Promise<void> | null;
};

const globalForGeneratedRecipientIndexes = globalThis as typeof globalThis & {
  __scenarioGeneratedRecipientIndexCacheV2?: GeneratedRecipientIndexCache;
};

const generatedRecipientIndexCache =
  globalForGeneratedRecipientIndexes.__scenarioGeneratedRecipientIndexCacheV2 ?? {
    ready: false,
    promise: null,
  };

globalForGeneratedRecipientIndexes.__scenarioGeneratedRecipientIndexCacheV2 =
  generatedRecipientIndexCache;

type GeneratedSendAudienceScope = {
  workspaceId: string;
  scenarioId: string;
  audienceRevision: string;
};

type GeneratedSendOperationScope = GeneratedSendAudienceScope & {
  operationId: string;
};

export type GeneratedSendPageCursor = {
  createdAt: string;
  messageId: string;
};

export type GeneratedSendQueuedOutcome = {
  campaignId: string;
  partitionKey: string;
};

export type GeneratedSendSkippedOutcome = {
  reason: string;
  detail?: string | null;
};

export type GeneratedSendRevisionClaimResult = GeneratedSendOperationScope & {
  revisionCount: number;
  claimedCount: number;
  matchedCount: number;
  modifiedCount: number;
  claimed: boolean;
};

export type GeneratedSendPartitionAssignmentResult = {
  campaignId: string;
  partitionKey: string;
  requestedCount: number;
  matchedCount: number;
  modifiedCount: number;
  assigned: boolean;
};

type GeneratedSendOutcomeCommitResult = {
  subsetCount: number;
  queuedCount: number;
  skippedCount: number;
  queuedMatchedCount: number;
  skippedMatchedCount: number;
  queuedModifiedCount: number;
  skippedModifiedCount: number;
  committed: boolean;
};

export type GeneratedSendAssignedPartitionSkipResult = {
  requestedCount: number;
  matchedCount: number;
  modifiedCount: number;
  committed: boolean;
};

export type GeneratedSendOperationCoverage = {
  expectedCount: number;
  ownedCount: number;
  allRevisionOwnedCount: number;
  queuedCount: number;
  skippedCount: number;
  incompleteCount: number;
  unexpectedRevisionCount: number;
  audience: GeneratedRecipientAudience;
  audienceMatches: boolean;
  complete: boolean;
};

export type GeneratedSendPreparationRow = {
  _id: string;
  workspaceId: string;
  scenarioId: string;
  generationJobId: string;
  nodeId: string;
  branchId?: string | null;
  conversationId?: string | null;
  channel: "whatsapp" | "telegram" | "email";
  recipient: string;
  recipientName?: string | null;
  recipientEmail?: string | null;
  sourceId?: string | null;
  taxonomyCategory?: string | null;
  internalLabels: string[];
  text: string;
  templateDraftId?: string | null;
  mediaAssetIds: string[];
  createdAt: Date;
  updatedAt?: Date;
};

export type GeneratedSendOperationRow = GeneratedSendPreparationRow & {
  sendStatus: "preparing" | "queued" | "skipped";
  sendOperationId: string;
  campaignId: string | null;
  sendPartitionKey: string | null;
  skipReason: string | null;
  skipDetail: string | null;
  error: string | null;
};

export type GeneratedSendPage<T> = {
  rows: T[];
  nextCursor: GeneratedSendPageCursor | null;
};

function isMissingIndexError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const indexError = error as { code?: unknown; codeName?: unknown };
  return indexError.code === 27 || indexError.codeName === "IndexNotFound";
}

async function dropIndexIfPresent(indexName: string): Promise<void> {
  try {
    await ScenarioGeneratedRecipientMessage.collection.dropIndex(indexName);
  } catch (error) {
    if (!isMissingIndexError(error)) throw error;
  }
}

async function materializeGeneratedRecipientIndexes(): Promise<void> {
  // Create the new revision-aware identity before removing either older
  // uniqueness guard so the collection never has an unguarded insert window.
  await ScenarioGeneratedRecipientMessage.collection.createIndex(
    SCENARIO_GENERATED_RECIPIENT_IDENTITY_INDEX_KEYS,
    SCENARIO_GENERATED_RECIPIENT_IDENTITY_INDEX_OPTIONS
  );
  await dropIndexIfPresent(
    SCENARIO_GENERATED_RECIPIENT_LEGACY_IDENTITY_INDEX_NAME
  );
  await dropIndexIfPresent(
    SCENARIO_GENERATED_RECIPIENT_SOURCE_IDENTITY_INDEX_NAME
  );
  await dropIndexIfPresent(
    SCENARIO_GENERATED_RECIPIENT_LEGACY_OPERATION_INDEX_NAME
  );
  await dropIndexIfPresent(
    SCENARIO_GENERATED_RECIPIENT_LEGACY_DRAFT_PAGE_INDEX_NAME
  );
  await ScenarioGeneratedRecipientMessage.collection.createIndex(
    SCENARIO_GENERATED_RECIPIENT_OPERATION_PAGE_INDEX_KEYS,
    SCENARIO_GENERATED_RECIPIENT_OPERATION_PAGE_INDEX_OPTIONS
  );
  await ScenarioGeneratedRecipientMessage.collection.createIndex(
    SCENARIO_GENERATED_RECIPIENT_REVISION_DRAFT_INDEX_KEYS,
    SCENARIO_GENERATED_RECIPIENT_REVISION_DRAFT_INDEX_OPTIONS
  );
}

export async function ensureScenarioGeneratedRecipientMessageIndexes(): Promise<void> {
  if (generatedRecipientIndexCache.ready) return;
  if (generatedRecipientIndexCache.promise) {
    return generatedRecipientIndexCache.promise;
  }
  generatedRecipientIndexCache.promise = (async () => {
    await connectDB();
    await materializeGeneratedRecipientIndexes();
    generatedRecipientIndexCache.ready = true;
  })()
    .catch(error => {
      generatedRecipientIndexCache.promise = null;
      throw error;
    })
    .finally(() => {
      if (generatedRecipientIndexCache.ready) {
        generatedRecipientIndexCache.promise = null;
      }
    });
  return generatedRecipientIndexCache.promise;
}

function requiredIdentifier(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`Generated send ${label} is required`);
  return normalized;
}

function normalizeAudienceScope(
  input: GeneratedSendAudienceScope
): GeneratedSendAudienceScope {
  return {
    workspaceId: requiredIdentifier(input.workspaceId, "workspaceId"),
    scenarioId: requiredIdentifier(input.scenarioId, "scenarioId"),
    audienceRevision: requiredIdentifier(
      input.audienceRevision,
      "audienceRevision"
    ),
  };
}

function normalizeOperationScope(
  input: GeneratedSendOperationScope
): GeneratedSendOperationScope {
  return {
    ...normalizeAudienceScope(input),
    operationId: requiredIdentifier(input.operationId, "operationId"),
  };
}

function normalizePageSize(value: number | undefined): number {
  const pageSize = value ?? DEFAULT_PAGE_SIZE;
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize <= 0 ||
    pageSize > MAX_PAGE_SIZE
  ) {
    throw new Error(
      `Generated send page size must be between 1 and ${MAX_PAGE_SIZE}`
    );
  }
  return pageSize;
}

function normalizeMessagePage(
  values: readonly string[],
  label: string
): string[] {
  if (values.length === 0) {
    throw new Error(`Generated send ${label} must not be empty`);
  }
  if (values.length > MAX_PAGE_SIZE) {
    throw new Error(
      `Generated send ${label} accepts at most ${MAX_PAGE_SIZE} IDs`
    );
  }
  const messageIds = values.map(value =>
    requiredIdentifier(value, `${label} messageId`)
  );
  if (new Set(messageIds).size !== messageIds.length) {
    throw new Error(`Generated send ${label} message IDs must be unique`);
  }
  return messageIds;
}

function normalizedCount(value: unknown): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Generated send database count is invalid");
  }
  return count;
}

function updateCounts(result: MongoUpdateResult) {
  return {
    matchedCount: normalizedCount(result.matchedCount ?? 0),
    modifiedCount: normalizedCount(result.modifiedCount ?? 0),
  };
}

function revisionFilter(scope: GeneratedSendAudienceScope) {
  return {
    workspaceId: scope.workspaceId,
    scenarioId: scope.scenarioId,
    generationJobId: scope.audienceRevision,
  };
}

function operationFilter(scope: GeneratedSendOperationScope) {
  return {
    ...revisionFilter(scope),
    sendOperationId: scope.operationId,
  };
}

function exactChildAssignment(
  scope: GeneratedSendOperationScope,
  value: GeneratedSendQueuedOutcome,
  label: string
): GeneratedSendQueuedOutcome {
  const partitionKey = requiredIdentifier(
    value.partitionKey,
    `${label} partitionKey`
  );
  const campaignId = requiredIdentifier(
    value.campaignId,
    `${label} campaignId`
  );
  if (
    deriveBulkSendChildCampaignId(scope.operationId, partitionKey) !==
    campaignId
  ) {
    throw new Error(
      "Generated send campaign and partition identity is invalid"
    );
  }
  return { campaignId, partitionKey };
}

const GENERATED_PREPARATION_ROW_SELECT = [
  "_id",
  "workspaceId",
  "scenarioId",
  "generationJobId",
  "nodeId",
  "branchId",
  "conversationId",
  "channel",
  "recipient",
  "recipientName",
  "recipientEmail",
  "sourceId",
  "taxonomyCategory",
  "internalLabels",
  "text",
  "templateDraftId",
  "mediaAssetIds",
  "sendStatus",
  "sendOperationId",
  "campaignId",
  "sendPartitionKey",
  "skipReason",
  "skipDetail",
  "error",
  "createdAt",
  "updatedAt",
].join(" ");

function normalizePreparationRow(
  value: Record<string, unknown>,
  scope: GeneratedSendAudienceScope,
  label: "draft" | "operation"
): GeneratedSendPreparationRow {
  const workspaceId = requiredIdentifier(
    value.workspaceId,
    `${label} row workspaceId`
  );
  const scenarioId = requiredIdentifier(
    value.scenarioId,
    `${label} row scenarioId`
  );
  const generationJobId = requiredIdentifier(
    value.generationJobId,
    `${label} row generationJobId`
  );
  const channel = requiredIdentifier(value.channel, `${label} row channel`);
  const createdAt = new Date(value.createdAt as Date | string);
  const updatedAt =
    value.updatedAt === undefined
      ? undefined
      : new Date(value.updatedAt as Date | string);
  if (
    workspaceId !== scope.workspaceId ||
    scenarioId !== scope.scenarioId ||
    generationJobId !== scope.audienceRevision ||
    (channel !== "whatsapp" && channel !== "telegram" && channel !== "email") ||
    !Number.isFinite(createdAt.getTime()) ||
    (updatedAt && !Number.isFinite(updatedAt.getTime()))
  ) {
    throw new Error(`Generated send ${label} row is malformed or foreign`);
  }
  return {
    _id: requiredIdentifier(String(value._id ?? ""), `${label} row ID`),
    workspaceId,
    scenarioId,
    generationJobId,
    nodeId: requiredIdentifier(value.nodeId, `${label} row nodeId`),
    branchId: readNonEmptyString(value.branchId),
    conversationId: readNonEmptyString(value.conversationId),
    channel,
    recipient: requiredIdentifier(value.recipient, `${label} row recipient`),
    recipientName: readNonEmptyString(value.recipientName),
    recipientEmail: readNonEmptyString(value.recipientEmail),
    sourceId: readNonEmptyString(value.sourceId),
    taxonomyCategory: readNonEmptyString(value.taxonomyCategory),
    internalLabels: readStringArray(value.internalLabels),
    text: typeof value.text === "string" ? value.text : "",
    templateDraftId: readNonEmptyString(value.templateDraftId),
    mediaAssetIds: readStringArray(value.mediaAssetIds),
    createdAt,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function normalizeOperationRow(
  value: Record<string, unknown>,
  scope: GeneratedSendOperationScope
): GeneratedSendOperationRow {
  const row = normalizePreparationRow(value, scope, "operation");
  const sendOperationId = requiredIdentifier(
    value.sendOperationId,
    "operation row sendOperationId"
  );
  const sendStatus = requiredIdentifier(
    value.sendStatus,
    "operation row sendStatus"
  );
  if (
    sendOperationId !== scope.operationId ||
    (sendStatus !== "preparing" &&
      sendStatus !== "queued" &&
      sendStatus !== "skipped")
  ) {
    throw new Error("Generated send operation row is malformed or foreign");
  }
  const campaignId = readNonEmptyString(value.campaignId);
  const sendPartitionKey = readNonEmptyString(value.sendPartitionKey);
  const skipReason = readNonEmptyString(value.skipReason);
  const skipDetail = readNonEmptyString(value.skipDetail);
  const error = readNonEmptyString(value.error);
  const hasAssignment = campaignId !== null && sendPartitionKey !== null;
  if (
    (campaignId === null) !== (sendPartitionKey === null) ||
    (sendStatus === "queued" && !hasAssignment)
  ) {
    throw new Error(
      "Generated send operation row partition assignment is malformed"
    );
  }
  if (
    hasAssignment &&
    deriveBulkSendChildCampaignId(scope.operationId, sendPartitionKey) !==
      campaignId
  ) {
    throw new Error(
      "Generated send operation row partition assignment is malformed"
    );
  }
  if (
    (sendStatus !== "skipped" &&
      (skipReason !== null || skipDetail !== null || error !== null)) ||
    (sendStatus === "skipped" &&
      (skipReason === null ||
        error !== stableSkipError(skipReason, skipDetail)))
  ) {
    throw new Error("Generated send operation row terminal state is malformed");
  }
  return {
    ...row,
    sendStatus,
    sendOperationId,
    campaignId,
    sendPartitionKey,
    skipReason,
    skipDetail,
    error,
  };
}

function normalizeCursor(
  value: GeneratedSendPageCursor | undefined
): { createdAt: Date; messageId: string } | null {
  if (!value) return null;
  const createdAt = new Date(value.createdAt);
  if (!Number.isFinite(createdAt.getTime())) {
    throw new Error("Generated send page cursor time is invalid");
  }
  return {
    createdAt,
    messageId: requiredIdentifier(value.messageId, "page cursor messageId"),
  };
}

function cursorFilter(cursor: { createdAt: Date; messageId: string } | null) {
  if (!cursor) return {};
  return {
    $or: [
      { createdAt: { $gt: cursor.createdAt } },
      {
        createdAt: cursor.createdAt,
        _id: { $gt: cursor.messageId },
      },
    ],
  };
}

function nextPageCursor<T extends GeneratedSendPreparationRow>(
  rows: T[],
  pageSize: number
): GeneratedSendPageCursor | null {
  if (rows.length < pageSize) return null;
  const last = rows[rows.length - 1]!;
  return {
    createdAt: last.createdAt.toISOString(),
    messageId: last._id,
  };
}

function assertUniquePageIds(
  rows: Array<{ _id: string }>,
  label: string
): void {
  if (new Set(rows.map(row => row._id)).size !== rows.length) {
    throw new Error(`Generated send ${label} page contains duplicate rows`);
  }
}

export async function loadGeneratedSendOperationPage(
  input: GeneratedSendOperationScope & {
    after?: GeneratedSendPageCursor;
    pageSize?: number;
  }
): Promise<GeneratedSendPage<GeneratedSendOperationRow>> {
  const scope = normalizeOperationScope(input);
  const pageSize = normalizePageSize(input.pageSize);
  const after = normalizeCursor(input.after);
  await ensureScenarioGeneratedRecipientMessageIndexes();
  const query = ScenarioGeneratedRecipientMessage.find({
    ...operationFilter(scope),
    ...cursorFilter(after),
  })
    .sort({ createdAt: 1, _id: 1 })
    .limit(pageSize)
    .select(GENERATED_PREPARATION_ROW_SELECT)
    .hint(SCENARIO_GENERATED_RECIPIENT_OPERATION_PAGE_INDEX_OPTIONS.name);
  const page = (await query.lean()) as Array<Record<string, unknown>>;
  if (!Array.isArray(page)) {
    throw new Error("Generated send operation page is malformed");
  }
  const rows = page.map(value => normalizeOperationRow(value, scope));
  assertUniquePageIds(rows, "operation");
  return { rows, nextCursor: nextPageCursor(rows, pageSize) };
}

export async function loadGeneratedSendRevisionPage(
  input: GeneratedSendAudienceScope & {
    after?: GeneratedSendPageCursor;
    pageSize?: number;
  }
): Promise<GeneratedSendPage<GeneratedSendPreparationRow>> {
  const scope = normalizeAudienceScope(input);
  const pageSize = normalizePageSize(input.pageSize);
  const after = normalizeCursor(input.after);
  const query = ScenarioGeneratedRecipientMessage.find({
    ...revisionFilter(scope),
    sendStatus: "draft",
    ...cursorFilter(after),
  })
    .sort({ createdAt: 1, _id: 1 })
    .limit(pageSize)
    .select(GENERATED_PREPARATION_ROW_SELECT)
    .hint(SCENARIO_GENERATED_RECIPIENT_REVISION_DRAFT_INDEX_OPTIONS.name);
  const page = (await query.lean()) as Array<Record<string, unknown>>;
  if (!Array.isArray(page)) {
    throw new Error("Generated send revision page is malformed");
  }
  const rows = page.map(value =>
    normalizePreparationRow(value, scope, "draft")
  );
  assertUniquePageIds(rows, "revision");
  return { rows, nextCursor: nextPageCursor(rows, pageSize) };
}

export async function claimGeneratedSendRevision(
  input: GeneratedSendOperationScope
): Promise<GeneratedSendRevisionClaimResult> {
  const scope = normalizeOperationScope(input);
  await ensureScenarioGeneratedRecipientMessageIndexes();
  const result = (await ScenarioGeneratedRecipientMessage.updateMany(
    {
      ...revisionFilter(scope),
      $or: [
        { sendStatus: "draft" },
        {
          sendStatus: "preparing",
          sendOperationId: scope.operationId,
        },
      ],
    },
    [
      {
        $set: {
          sendStatus: "preparing",
          sendOperationId: scope.operationId,
          campaignId: {
            $cond: [{ $eq: ["$sendStatus", "draft"] }, null, "$campaignId"],
          },
          sendPartitionKey: {
            $cond: [
              { $eq: ["$sendStatus", "draft"] },
              null,
              "$sendPartitionKey",
            ],
          },
          skipReason: null,
          skipDetail: null,
          error: null,
        },
      },
    ]
  )) as MongoUpdateResult;
  const [revisionCount, claimedCount] = await Promise.all([
    ScenarioGeneratedRecipientMessage.countDocuments(revisionFilter(scope)),
    ScenarioGeneratedRecipientMessage.countDocuments(operationFilter(scope)),
  ]);
  const counts = updateCounts(result);
  const normalizedRevisionCount = normalizedCount(revisionCount);
  const normalizedClaimedCount = normalizedCount(claimedCount);
  return {
    ...scope,
    revisionCount: normalizedRevisionCount,
    claimedCount: normalizedClaimedCount,
    ...counts,
    claimed:
      normalizedRevisionCount > 0 &&
      normalizedClaimedCount === normalizedRevisionCount,
  };
}

function operationPreparingPageFilter(
  scope: GeneratedSendOperationScope,
  messageIds: string[]
) {
  return {
    ...operationFilter(scope),
    _id: { $in: messageIds },
    sendStatus: "preparing",
  };
}

export async function assignGeneratedSendPartition(
  input: GeneratedSendOperationScope & {
    messageIds: readonly string[];
    partitionKey: string;
  }
): Promise<GeneratedSendPartitionAssignmentResult> {
  const scope = normalizeOperationScope(input);
  const messageIds = normalizeMessagePage(
    input.messageIds,
    "partition assignment page"
  );
  const partitionKey = requiredIdentifier(input.partitionKey, "partitionKey");
  const campaignId = deriveBulkSendChildCampaignId(
    scope.operationId,
    partitionKey
  );
  await ensureScenarioGeneratedRecipientMessageIndexes();
  const result = (await ScenarioGeneratedRecipientMessage.updateMany(
    {
      ...operationPreparingPageFilter(scope, messageIds),
      $or: [
        { campaignId: null, sendPartitionKey: null },
        { campaignId, sendPartitionKey: partitionKey },
      ],
    },
    {
      $set: { campaignId, sendPartitionKey: partitionKey },
    }
  )) as MongoUpdateResult;
  const counts = updateCounts(result);
  return {
    campaignId,
    partitionKey,
    requestedCount: messageIds.length,
    ...counts,
    assigned: counts.matchedCount === messageIds.length,
  };
}

function stableSkipError(reason: string, detail: string | null): string {
  return detail
    ? `Generated send skipped: ${reason} (${detail})`
    : `Generated send skipped: ${reason}`;
}

type StoredGeneratedOutcomeRow = {
  _id: string;
  workspaceId: string;
  scenarioId: string;
  generationJobId: string;
  sendOperationId: string;
  sendStatus: string;
  campaignId: string | null;
  sendPartitionKey: string | null;
  skipReason: string | null;
  skipDetail: string | null;
  error: string | null;
};

async function readExactGeneratedOutcomeRows(params: {
  scope: GeneratedSendOperationScope;
  messageIds: string[];
}): Promise<StoredGeneratedOutcomeRow[]> {
  const page = (await ScenarioGeneratedRecipientMessage.find({
    ...revisionFilter(params.scope),
    _id: { $in: params.messageIds },
    sendOperationId: params.scope.operationId,
  })
    .select(
      "_id workspaceId scenarioId generationJobId sendOperationId sendStatus campaignId sendPartitionKey skipReason skipDetail error"
    )
    .lean()) as Array<Record<string, unknown>>;
  if (!Array.isArray(page)) {
    throw new Error("Generated send outcome rows are malformed");
  }
  const rows = page.map(row => {
    const campaignId = readNonEmptyString(row.campaignId);
    const sendPartitionKey = readNonEmptyString(row.sendPartitionKey);
    if ((campaignId === null) !== (sendPartitionKey === null)) {
      throw new Error("Generated send outcome assignment is malformed");
    }
    if (
      campaignId &&
      sendPartitionKey &&
      deriveBulkSendChildCampaignId(
        params.scope.operationId,
        sendPartitionKey
      ) !== campaignId
    ) {
      throw new Error("Generated send outcome assignment is malformed");
    }
    return {
      _id: requiredIdentifier(String(row._id ?? ""), "outcome row ID"),
      workspaceId: requiredIdentifier(
        row.workspaceId,
        "outcome row workspaceId"
      ),
      scenarioId: requiredIdentifier(row.scenarioId, "outcome row scenarioId"),
      generationJobId: requiredIdentifier(
        row.generationJobId,
        "outcome row generationJobId"
      ),
      sendOperationId: readNonEmptyString(row.sendOperationId) || "",
      sendStatus: requiredIdentifier(row.sendStatus, "outcome row sendStatus"),
      campaignId,
      sendPartitionKey,
      skipReason: readNonEmptyString(row.skipReason),
      skipDetail: readNonEmptyString(row.skipDetail),
      error: readNonEmptyString(row.error),
    };
  });
  const expectedIds = new Set(params.messageIds);
  const seenIds = new Set<string>();
  for (const row of rows) {
    if (
      row.workspaceId !== params.scope.workspaceId ||
      row.scenarioId !== params.scope.scenarioId ||
      row.generationJobId !== params.scope.audienceRevision ||
      !expectedIds.has(row._id) ||
      seenIds.has(row._id)
    ) {
      throw new Error("Generated send outcome rows are malformed or foreign");
    }
    seenIds.add(row._id);
  }
  if (seenIds.size !== params.messageIds.length) {
    throw new Error("Generated send outcome rows do not match the exact page");
  }
  return rows;
}

function normalizeOutcomeIds<T>(
  outcomes: Record<string, T>,
  label: string
): Map<string, T> {
  const normalized = new Map<string, T>();
  for (const messageIdValue in outcomes) {
    if (!Object.prototype.hasOwnProperty.call(outcomes, messageIdValue)) {
      continue;
    }
    if (normalized.size >= MAX_PAGE_SIZE) {
      throw new Error(
        `Generated send ${label} accepts at most ${MAX_PAGE_SIZE} outcomes`
      );
    }
    const messageId = requiredIdentifier(messageIdValue, `${label} messageId`);
    if (normalized.has(messageId)) {
      throw new Error(`Generated send ${label} message IDs must be unique`);
    }
    normalized.set(messageId, outcomes[messageIdValue]!);
  }
  return normalized;
}

function classifyOutcomeRows(params: {
  rows: StoredGeneratedOutcomeRow[];
  scope: GeneratedSendOperationScope;
  queued: Map<string, GeneratedSendQueuedOutcome>;
  skipped: Map<string, { reason: string; detail: string | null }>;
}) {
  const pendingQueuedIds: string[] = [];
  const pendingSkippedIds: string[] = [];
  let terminalQueuedCount = 0;
  let terminalSkippedCount = 0;
  for (const row of params.rows) {
    if (row.sendOperationId !== params.scope.operationId) {
      throw new Error("Generated send outcome ownership changed");
    }
    const queued = params.queued.get(row._id);
    const skipped = params.skipped.get(row._id);
    if (row.sendStatus === "preparing") {
      if (
        queued &&
        row.campaignId === queued.campaignId &&
        row.sendPartitionKey === queued.partitionKey
      ) {
        pendingQueuedIds.push(row._id);
        continue;
      }
      if (skipped && row.campaignId === null && row.sendPartitionKey === null) {
        pendingSkippedIds.push(row._id);
        continue;
      }
    }
    if (
      row.sendStatus === "queued" &&
      queued &&
      row.campaignId === queued.campaignId &&
      row.sendPartitionKey === queued.partitionKey &&
      row.skipReason === null &&
      row.skipDetail === null &&
      row.error === null
    ) {
      terminalQueuedCount += 1;
      continue;
    }
    if (
      row.sendStatus === "skipped" &&
      skipped &&
      row.campaignId === null &&
      row.sendPartitionKey === null &&
      row.skipReason === skipped.reason &&
      row.skipDetail === skipped.detail &&
      row.error === stableSkipError(skipped.reason, skipped.detail)
    ) {
      terminalSkippedCount += 1;
      continue;
    }
    throw new Error(
      "Generated send existing terminal outcome does not match recovery"
    );
  }
  return {
    pendingQueuedIds,
    pendingSkippedIds,
    terminalQueuedCount,
    terminalSkippedCount,
  };
}

function bulkWriteBatches(
  operations: GeneratedMessageBulkOperation[]
): GeneratedMessageBulkOperation[][] {
  const batches: GeneratedMessageBulkOperation[][] = [];
  for (
    let index = 0;
    index < operations.length;
    index += MAX_BULK_WRITE_OPERATIONS
  ) {
    batches.push(operations.slice(index, index + MAX_BULK_WRITE_OPERATIONS));
  }
  return batches;
}

async function commitBulkOperations(
  operations: GeneratedMessageBulkOperation[]
): Promise<{ matchedCount: number; modifiedCount: number }> {
  let matchedCount = 0;
  let modifiedCount = 0;
  for (const batch of bulkWriteBatches(operations)) {
    const counts = updateCounts(
      (await ScenarioGeneratedRecipientMessage.bulkWrite(
        batch as never
      )) as MongoUpdateResult
    );
    matchedCount += counts.matchedCount;
    modifiedCount += counts.modifiedCount;
  }
  return { matchedCount, modifiedCount };
}

async function commitGeneratedSendOutcomePage(
  input: GeneratedSendOperationScope & {
    messageIds: readonly string[];
    queuedByMessageId: Record<string, GeneratedSendQueuedOutcome>;
    skippedByMessageId: Record<string, GeneratedSendSkippedOutcome>;
  }
): Promise<GeneratedSendOutcomeCommitResult> {
  const scope = normalizeOperationScope(input);
  const messageIds = normalizeMessagePage(input.messageIds, "outcome page");
  const queuedInput = normalizeOutcomeIds(input.queuedByMessageId, "queued");
  const skippedInput = normalizeOutcomeIds(input.skippedByMessageId, "skipped");
  if (queuedInput.size + skippedInput.size > MAX_PAGE_SIZE) {
    throw new Error(
      `Generated send outcome page accepts at most ${MAX_PAGE_SIZE} outcomes`
    );
  }
  for (const messageId of queuedInput.keys()) {
    if (skippedInput.has(messageId)) {
      throw new Error(
        "Generated send queued and skipped outcomes must be disjoint"
      );
    }
  }
  const classifiedIds = new Set(queuedInput.keys());
  for (const messageId of skippedInput.keys()) {
    classifiedIds.add(messageId);
  }
  if (
    classifiedIds.size !== messageIds.length ||
    messageIds.some(messageId => !classifiedIds.has(messageId))
  ) {
    throw new Error(
      "Generated send outcomes must classify the supplied page exactly once"
    );
  }
  const queued = new Map<string, GeneratedSendQueuedOutcome>();
  for (const [messageId, outcome] of queuedInput) {
    queued.set(
      messageId,
      exactChildAssignment(scope, outcome, "queued outcome")
    );
  }
  const skipped = new Map<string, { reason: string; detail: string | null }>();
  for (const [messageId, outcome] of skippedInput) {
    skipped.set(messageId, {
      reason: requiredIdentifier(outcome.reason, "skipped reason"),
      detail: readNonEmptyString(outcome.detail),
    });
  }

  await ensureScenarioGeneratedRecipientMessageIndexes();
  const initial = classifyOutcomeRows({
    rows: await readExactGeneratedOutcomeRows({ scope, messageIds }),
    scope,
    queued,
    skipped,
  });
  if (
    initial.pendingQueuedIds.length === 0 &&
    initial.pendingSkippedIds.length === 0
  ) {
    return {
      subsetCount: messageIds.length,
      queuedCount: queued.size,
      skippedCount: skipped.size,
      queuedMatchedCount: initial.terminalQueuedCount,
      skippedMatchedCount: initial.terminalSkippedCount,
      queuedModifiedCount: 0,
      skippedModifiedCount: 0,
      committed:
        initial.terminalQueuedCount === queued.size &&
        initial.terminalSkippedCount === skipped.size,
    };
  }
  const queuedGroups = new Map<string, string[]>();
  for (const messageId of initial.pendingQueuedIds) {
    const outcome = queued.get(messageId)!;
    const key = JSON.stringify([outcome.campaignId, outcome.partitionKey]);
    const ids = queuedGroups.get(key) || [];
    ids.push(messageId);
    queuedGroups.set(key, ids);
  }
  const skippedGroups = new Map<string, string[]>();
  for (const messageId of initial.pendingSkippedIds) {
    const outcome = skipped.get(messageId)!;
    const key = JSON.stringify([outcome.reason, outcome.detail]);
    const ids = skippedGroups.get(key) || [];
    ids.push(messageId);
    skippedGroups.set(key, ids);
  }
  const queuedOperations = Array.from(queuedGroups, ([key, ids]) => {
    const [campaignId, partitionKey] = JSON.parse(key) as [string, string];
    return {
      updateMany: {
        filter: {
          ...operationPreparingPageFilter(scope, ids),
          campaignId,
          sendPartitionKey: partitionKey,
        },
        update: {
          $set: {
            sendStatus: "queued",
            campaignId,
            sendPartitionKey: partitionKey,
            skipReason: null,
            skipDetail: null,
            error: null,
          },
        },
      },
    };
  });
  const skippedOperations = Array.from(skippedGroups, ([key, ids]) => {
    const [reason, detail] = JSON.parse(key) as [string, string | null];
    return {
      updateMany: {
        filter: {
          ...operationPreparingPageFilter(scope, ids),
          campaignId: null,
          sendPartitionKey: null,
        },
        update: {
          $set: {
            sendStatus: "skipped",
            campaignId: null,
            sendPartitionKey: null,
            skipReason: reason,
            skipDetail: detail,
            error: stableSkipError(reason, detail),
          },
        },
      },
    };
  });
  const [queuedWrites, skippedWrites] = await Promise.all([
    commitBulkOperations(queuedOperations),
    commitBulkOperations(skippedOperations),
  ]);
  // Always re-read final state. This is both the success proof and recovery
  // from a crash/race after Mongo persisted a terminal page.
  const final = classifyOutcomeRows({
    rows: await readExactGeneratedOutcomeRows({ scope, messageIds }),
    scope,
    queued,
    skipped,
  });
  const committed =
    final.pendingQueuedIds.length === 0 &&
    final.pendingSkippedIds.length === 0 &&
    final.terminalQueuedCount === queued.size &&
    final.terminalSkippedCount === skipped.size;
  return {
    subsetCount: messageIds.length,
    queuedCount: queued.size,
    skippedCount: skipped.size,
    queuedMatchedCount: final.terminalQueuedCount,
    skippedMatchedCount: final.terminalSkippedCount,
    queuedModifiedCount: queuedWrites.modifiedCount,
    skippedModifiedCount: skippedWrites.modifiedCount,
    committed,
  };
}

export async function commitGeneratedSendPartialOutcomes(
  input: GeneratedSendOperationScope & {
    messageIds: readonly string[];
    queuedByMessageId: Record<string, GeneratedSendQueuedOutcome>;
    skippedByMessageId: Record<string, GeneratedSendSkippedOutcome>;
  }
): Promise<GeneratedSendOutcomeCommitResult> {
  return commitGeneratedSendOutcomePage(input);
}

function classifyAssignedPartitionSkipRows(params: {
  rows: StoredGeneratedOutcomeRow[];
  scope: GeneratedSendOperationScope;
  assignment: GeneratedSendQueuedOutcome;
  reason: string;
  detail: string | null;
}): { pendingIds: string[]; terminalCount: number } {
  const pendingIds: string[] = [];
  let terminalCount = 0;
  const expectedError = stableSkipError(params.reason, params.detail);
  for (const row of params.rows) {
    if (
      row.sendOperationId !== params.scope.operationId ||
      row.campaignId !== params.assignment.campaignId ||
      row.sendPartitionKey !== params.assignment.partitionKey
    ) {
      throw new Error(
        "Generated send assigned partition skip state is divergent"
      );
    }
    if (
      row.sendStatus === "preparing" &&
      row.skipReason === null &&
      row.skipDetail === null &&
      row.error === null
    ) {
      pendingIds.push(row._id);
      continue;
    }
    if (
      row.sendStatus === "skipped" &&
      row.skipReason === params.reason &&
      row.skipDetail === params.detail &&
      row.error === expectedError
    ) {
      terminalCount += 1;
      continue;
    }
    throw new Error(
      "Generated send assigned partition skip state is divergent"
    );
  }
  return { pendingIds, terminalCount };
}

/**
 * Terminalizes a SQL-proven unadmitted assignment without erasing the
 * deterministic child evidence. A claimed revision is irreversible, so this
 * is the only safe outcome when the original command deadline has elapsed.
 */
export async function commitGeneratedSendAssignedPartitionSkip(
  input: GeneratedSendOperationScope & {
    messageIds: readonly string[];
    assignment: GeneratedSendQueuedOutcome;
    outcome: GeneratedSendSkippedOutcome;
  }
): Promise<GeneratedSendAssignedPartitionSkipResult> {
  const scope = normalizeOperationScope(input);
  const messageIds = normalizeMessagePage(
    input.messageIds,
    "assigned partition skip page"
  );
  const assignment = exactChildAssignment(
    scope,
    input.assignment,
    "assigned partition skip"
  );
  const reason = requiredIdentifier(
    input.outcome.reason,
    "assigned partition skip reason"
  );
  const detail = readNonEmptyString(input.outcome.detail);
  await ensureScenarioGeneratedRecipientMessageIndexes();

  const classifyCurrent = async () =>
    classifyAssignedPartitionSkipRows({
      rows: await readExactGeneratedOutcomeRows({ scope, messageIds }),
      scope,
      assignment,
      reason,
      detail,
    });
  const initial = await classifyCurrent();
  if (initial.pendingIds.length === 0) {
    return {
      requestedCount: messageIds.length,
      matchedCount: initial.terminalCount,
      modifiedCount: 0,
      committed: initial.terminalCount === messageIds.length,
    };
  }

  const writes = updateCounts(
    (await ScenarioGeneratedRecipientMessage.updateMany(
      {
        ...operationPreparingPageFilter(scope, initial.pendingIds),
        campaignId: assignment.campaignId,
        sendPartitionKey: assignment.partitionKey,
        skipReason: null,
        skipDetail: null,
        error: null,
      },
      {
        $set: {
          sendStatus: "skipped",
          skipReason: reason,
          skipDetail: detail,
          error: stableSkipError(reason, detail),
        },
      }
    )) as MongoUpdateResult
  );
  const final = await classifyCurrent();
  return {
    requestedCount: messageIds.length,
    matchedCount: final.terminalCount,
    modifiedCount: writes.modifiedCount,
    committed:
      final.pendingIds.length === 0 &&
      final.terminalCount === messageIds.length,
  };
}

export async function verifyGeneratedSendOperationCoverage(
  input: GeneratedSendOperationScope & {
    expectedAudience: GeneratedRecipientAudience;
    pageSize?: number;
  }
): Promise<GeneratedSendOperationCoverage> {
  const scope = normalizeOperationScope(input);
  const expectedAudience = normalizeGeneratedRecipientAudience(
    input.expectedAudience
  );
  const pageSize = normalizePageSize(input.pageSize);
  let audience = createGeneratedRecipientAudience();
  let cursor: GeneratedSendPageCursor | undefined;
  let queuedCount = 0;
  let skippedCount = 0;
  let incompleteCount = 0;
  for (;;) {
    const page = await loadGeneratedSendOperationPage({
      ...scope,
      ...(cursor ? { after: cursor } : {}),
      pageSize,
    });
    audience = advanceGeneratedRecipientAudience(
      audience,
      page.rows.map(row => row._id)
    );
    for (const row of page.rows) {
      if (row.sendStatus === "queued") queuedCount += 1;
      else if (row.sendStatus === "skipped") skippedCount += 1;
      else incompleteCount += 1;
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const allRevisionOwnedCount = normalizedCount(
    await ScenarioGeneratedRecipientMessage.countDocuments({
      workspaceId: scope.workspaceId,
      scenarioId: scope.scenarioId,
      sendOperationId: scope.operationId,
    })
  );
  const ownedCount = audience.count;
  const unexpectedRevisionCount = Math.max(
    0,
    allRevisionOwnedCount - ownedCount
  );
  const audienceMatches = generatedRecipientAudiencesEqual(
    audience,
    expectedAudience
  );
  return {
    expectedCount: expectedAudience.count,
    ownedCount,
    allRevisionOwnedCount,
    queuedCount,
    skippedCount,
    incompleteCount,
    unexpectedRevisionCount,
    audience,
    audienceMatches,
    complete:
      audienceMatches &&
      allRevisionOwnedCount === ownedCount &&
      incompleteCount === 0 &&
      queuedCount + skippedCount === expectedAudience.count,
  };
}
