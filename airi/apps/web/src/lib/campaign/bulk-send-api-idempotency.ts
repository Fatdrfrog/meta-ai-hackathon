import { createHash, randomBytes } from "node:crypto";
import {
  SCENARIO_GENERATOR_MAX_GENERATED_MESSAGES,
  normalizeBulkCampaignRecipientPolicy,
  type BulkCampaignRecipientPolicy,
} from "@icecore/scenario-contracts";

import connectDB from "@/lib/mongoose";
import BulkSendApiIdempotency, {
  BULK_SEND_API_IDEMPOTENCY_INDEXES,
  BULK_SEND_API_IDEMPOTENCY_LEGACY_INDEX_NAME,
  BULK_SEND_API_IDEMPOTENCY_OPERATION_KIND,
  BULK_SEND_API_IDEMPOTENCY_OPERATION_STATE,
} from "@/models/bulk-send-api-idempotency";
import { isRecord } from "@icecore/shared/lib/value-utils";
import { createStableJsonSha256 } from "./bulk-campaign-content-hash";

export const BULK_SEND_IDEMPOTENCY_RESERVATION_LEASE_MS = 2 * 60 * 1000;
export const BULK_SEND_LEGACY_IDEMPOTENCY_RESERVATION_LEASE_MS = 6 * 60 * 1000;
const BULK_SEND_IDEMPOTENCY_MAX_PROGRESS_BYTES = 256 * 1024;
const BULK_SEND_IDEMPOTENCY_MAX_RESPONSE_BYTES = 256 * 1024;
const BULK_SEND_IDEMPOTENCY_TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;

const LEGACY_OPERATION_KIND = BULK_SEND_API_IDEMPOTENCY_OPERATION_KIND.LEGACY;
const GENERATED_OPERATION_KIND =
  BULK_SEND_API_IDEMPOTENCY_OPERATION_KIND.GENERATED;
const GENERATED_OPERATION_STATE_ACTIVE =
  BULK_SEND_API_IDEMPOTENCY_OPERATION_STATE.ACTIVE;
const GENERATED_OPERATION_STATE_COMPLETED =
  BULK_SEND_API_IDEMPOTENCY_OPERATION_STATE.COMPLETED;
const GENERATED_OPERATION_STATE_FAILED =
  BULK_SEND_API_IDEMPOTENCY_OPERATION_STATE.FAILED;
const LEGACY_OPERATION_STATE_ACTIVE =
  BULK_SEND_API_IDEMPOTENCY_OPERATION_STATE.ACTIVE;
const LEGACY_OPERATION_STATE_COMPLETED =
  BULK_SEND_API_IDEMPOTENCY_OPERATION_STATE.COMPLETED;

type BulkSendApiIdempotencyIndexCache = {
  ready: boolean;
  promise: Promise<void> | null;
};

const globalForBulkSendApiIdempotencyIndexes =
  globalThis as typeof globalThis & {
    __bulkSendApiIdempotencyIndexCache?: BulkSendApiIdempotencyIndexCache;
  };

const bulkSendApiIdempotencyIndexCache =
  globalForBulkSendApiIdempotencyIndexes.__bulkSendApiIdempotencyIndexCache ?? {
    ready: false,
    promise: null,
  };

globalForBulkSendApiIdempotencyIndexes.__bulkSendApiIdempotencyIndexCache =
  bulkSendApiIdempotencyIndexCache;

export type IdempotencyScope = {
  workspaceId: string;
  userId: string;
  idempotencyKey: string;
};

type LegacyBulkSendOperationOwnerScope = IdempotencyScope & {
  requestDigestVersion: number;
  requestDigest: string;
  reservationToken: string;
};

export type LegacyBulkSendOperationReservation =
  | { status: "acquired"; reservationToken: string }
  | {
      status: "completed";
      responseBody: Record<string, unknown>;
      eventFacts?: Record<string, unknown>;
    }
  | { status: "in_progress"; retryAfterMs: number }
  | { status: "payload_mismatch" };

type BulkSendIdempotencyDocument = {
  _id?: unknown;
  activeScenarioKey?: string;
  audienceRevision?: string | null;
  campaignId?: string;
  expiresAt?: Date | string | null;
  intentDigest?: string;
  intentDigestVersion?: number;
  operationKind?: string;
  operationState?: string;
  progressBody?: string;
  progressVersion?: number;
  recipientPolicy?: unknown;
  requestDigest?: string;
  requestDigestVersion?: number;
  requestedAtIso?: string;
  responseBody?: string;
  responseStatus?: number;
  reservationExpiresAt?: Date | string | null;
  reservationToken?: string;
  scenarioId?: string;
  scheduledAtIso?: string | null;
  userId?: string;
  workspaceId?: string;
};

type GeneratedOperationOwnerScope = {
  workspaceId: string;
  scenarioId: string;
  operationId: string;
  reservationToken: string;
};

type GeneratedOperationIntent = {
  workspaceId: string;
  scenarioId: string;
  audienceRevision: string;
  intentDigestVersion: number;
  intentDigest: string;
  legacyIntentDigestVersion: 1;
  legacyIntentDigest: string;
  recipientPolicy: BulkCampaignRecipientPolicy;
  scheduledAtIso: string | null;
  scheduledAtWasProvided: boolean;
};

export type GeneratedBulkSendOperationReservation =
  | {
      status: "acquired";
      operationId: string;
      reservationToken: string;
      initiatingUserId: string;
      audienceRevision: string;
      requestedAt: string;
      scheduledAt: string | null;
      isNew: boolean;
      progressVersion: number;
      progressBody?: Record<string, unknown>;
      recipientPolicy: BulkCampaignRecipientPolicy;
      requestDigest?: string;
      requestDigestVersion?: number;
      compatibilityMode: "current_v2" | "legacy_v1_disabled";
    }
  | {
      status: "completed";
      operationId: string;
      responseBody: Record<string, unknown>;
    }
  | {
      status: "failed";
      operationId: string;
      responseStatus: number;
      responseBody: Record<string, unknown>;
    }
  | {
      status: "in_progress";
      operationId: string;
      retryAfterMs: number;
    }
  | {
      status: "payload_mismatch";
    }
  | {
      status: "legacy_operation";
      operationId: string;
      reason: "missing_audience_revision" | "missing_requested_at";
    };

export type GeneratedBulkSendOperationBeforeCreate = (
  candidate: Extract<
    GeneratedBulkSendOperationReservation,
    { status: "acquired" }
  >
) => Promise<void>;

function hashKey(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function resolveKeyHash(params: IdempotencyScope): string {
  return hashKey(
    `${params.workspaceId}:${params.userId}:${params.idempotencyKey.trim()}`
  );
}

function normalizeLegacyBulkSendSemanticRequest(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const request = { ...(value as Record<string, unknown>) };
  delete request.idempotencyKey;
  delete request.templateComponents;
  delete request.useColumnSplitRouting;
  delete request.overflowQueueConfirmed;

  if (typeof request.scheduledAt === "string") {
    const scheduledAtMs = Date.parse(request.scheduledAt);
    if (Number.isFinite(scheduledAtMs)) {
      request.scheduledAt = new Date(scheduledAtMs).toISOString();
    }
  }
  const audience = request.audience;
  if (
    audience &&
    typeof audience === "object" &&
    !Array.isArray(audience) &&
    (audience as Record<string, unknown>).kind === "inline"
  ) {
    delete request.audienceUploadEvidence;
  }
  return request;
}

export function createLegacyBulkSendRequestDigest(value: unknown): string {
  return createStableJsonSha256({
    version: 1,
    request: normalizeLegacyBulkSendSemanticRequest(value),
  });
}

function deterministicUuid(input: string): string {
  const bytes = Buffer.from(
    createHash("sha256").update(input).digest("hex").slice(0, 32),
    "hex"
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function deterministicCampaignId(keyHash: string): string {
  return deterministicUuid(`bulk-send-campaign:${keyHash}`);
}

export function deriveBulkSendCampaignId(params: IdempotencyScope): string {
  return deterministicCampaignId(resolveKeyHash(params));
}

export function deriveBulkSendChildCampaignId(
  parentOperationId: string,
  partitionKey: string
): string {
  return deterministicUuid(
    `bulk-send-child-campaign:${parentOperationId}:${partitionKey}`
  );
}

function parseResponseBody(
  responseBody: string | undefined
): Record<string, unknown> | null {
  if (!responseBody) {
    return null;
  }
  try {
    return JSON.parse(responseBody) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function serializeBoundedJson(
  value: Record<string, unknown>,
  maxBytes: number,
  errorMessage: string
): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error(errorMessage);
  }
  return serialized;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === 11000 || error.code === 11001)
  );
}

function isMissingIndexError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const indexError = error as { code?: unknown; codeName?: unknown };
  return indexError.code === 27 || indexError.codeName === "IndexNotFound";
}

async function createBulkSendApiIdempotencyIndexes(): Promise<void> {
  await BulkSendApiIdempotency.collection.updateMany(
    {
      operationKind: { $exists: false },
      scenarioId: { $exists: false },
      activeScenarioKey: { $exists: false },
    },
    { $set: { operationKind: LEGACY_OPERATION_KIND } }
  );

  try {
    await BulkSendApiIdempotency.collection.dropIndex(
      BULK_SEND_API_IDEMPOTENCY_LEGACY_INDEX_NAME
    );
  } catch (error) {
    if (!isMissingIndexError(error)) {
      throw error;
    }
  }

  for (const index of Object.values(BULK_SEND_API_IDEMPOTENCY_INDEXES)) {
    await BulkSendApiIdempotency.collection.createIndex(
      index.keys,
      index.options
    );
  }
}

export async function ensureBulkSendApiIdempotencyIndexes(): Promise<void> {
  if (bulkSendApiIdempotencyIndexCache.ready) {
    return;
  }
  if (bulkSendApiIdempotencyIndexCache.promise) {
    return bulkSendApiIdempotencyIndexCache.promise;
  }

  bulkSendApiIdempotencyIndexCache.promise = (async () => {
    await connectDB();
    await createBulkSendApiIdempotencyIndexes();
    bulkSendApiIdempotencyIndexCache.ready = true;
  })()
    .catch(error => {
      bulkSendApiIdempotencyIndexCache.promise = null;
      throw error;
    })
    .finally(() => {
      if (bulkSendApiIdempotencyIndexCache.ready) {
        bulkSendApiIdempotencyIndexCache.promise = null;
      }
    });

  return bulkSendApiIdempotencyIndexCache.promise;
}

function normalizeGeneratedOperationSchedule(
  scheduledAt: string | null | undefined
): string | null {
  if (scheduledAt == null || scheduledAt.trim() === "") {
    return null;
  }
  const parsed = new Date(scheduledAt);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Generated bulk-send operation schedule is invalid");
  }
  return parsed.toISOString();
}

function assertVersionedDigest(
  name: string,
  version: number,
  digest: string
): void {
  if (!Number.isSafeInteger(version) || version <= 0 || digest.trim() === "") {
    throw new Error(`${name} must include a positive version and digest`);
  }
}

function resolveGeneratedClientKeyHash(params: {
  workspaceId: string;
  idempotencyKey?: string | null;
}): string | null {
  const normalizedKey = params.idempotencyKey?.trim();
  if (!normalizedKey) {
    return null;
  }
  return hashKey(
    `generated-bulk-send-key:${params.workspaceId}:${normalizedKey}`
  );
}

function resolveActiveScenarioKey(params: {
  workspaceId: string;
  scenarioId: string;
}): string {
  return hashKey(
    `generated-bulk-send-active:${params.workspaceId}:${params.scenarioId}`
  );
}

const GENERATED_OPERATION_FIELDS = [
  "_id",
  "activeScenarioKey",
  "audienceRevision",
  "campaignId",
  "expiresAt",
  "intentDigest",
  "intentDigestVersion",
  "operationKind",
  "operationState",
  "progressBody",
  "progressVersion",
  "recipientPolicy",
  "requestDigest",
  "requestDigestVersion",
  "requestedAtIso",
  "reservationExpiresAt",
  "reservationToken",
  "responseBody",
  "responseStatus",
  "scenarioId",
  "scheduledAtIso",
  "userId",
  "workspaceId",
].join(" ");

async function readGeneratedOperation(
  filter: Record<string, unknown>
): Promise<BulkSendIdempotencyDocument | null> {
  return BulkSendApiIdempotency.findOne(filter)
    .select(GENERATED_OPERATION_FIELDS)
    .lean<BulkSendIdempotencyDocument | null>();
}

function hasAudienceRevision(
  value: string | null | undefined
): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function normalizeGeneratedOperationRequestedAt(
  value: string | null | undefined
): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function parseGeneratedOperationRecipientPolicy(
  value: unknown
): BulkCampaignRecipientPolicy {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).version !== 1 ||
    typeof (value as Record<string, unknown>).excludePriorFailedBulkSends !==
      "boolean"
  ) {
    throw new Error("Generated bulk-send operation policy snapshot is invalid");
  }
  try {
    return normalizeBulkCampaignRecipientPolicy(value);
  } catch (error) {
    throw new Error(
      "Generated bulk-send operation policy snapshot is invalid",
      { cause: error }
    );
  }
}

function classifyGeneratedOperationIntent(
  document: BulkSendIdempotencyDocument,
  params: GeneratedOperationIntent
):
  | "current_v2"
  | "legacy_v1"
  | "payload_mismatch"
  | "legacy_missing_audience_revision"
  | "legacy_missing_requested_at" {
  const baseIntentMatches =
    document.operationKind === GENERATED_OPERATION_KIND &&
    document.workspaceId === params.workspaceId &&
    document.scenarioId === params.scenarioId &&
    (!params.scheduledAtWasProvided ||
      (document.scheduledAtIso ?? null) === params.scheduledAtIso);
  if (!baseIntentMatches) {
    return "payload_mismatch";
  }
  if (
    document.operationState === GENERATED_OPERATION_STATE_ACTIVE &&
    !hasAudienceRevision(document.audienceRevision)
  ) {
    return "legacy_missing_audience_revision";
  }
  if (
    document.operationState === GENERATED_OPERATION_STATE_ACTIVE &&
    !normalizeGeneratedOperationRequestedAt(document.requestedAtIso)
  ) {
    return "legacy_missing_requested_at";
  }
  if (document.audienceRevision !== params.audienceRevision) {
    return "payload_mismatch";
  }
  if (document.intentDigestVersion === params.intentDigestVersion) {
    const storedPolicy = parseGeneratedOperationRecipientPolicy(
      document.recipientPolicy
    );
    if (document.operationState === GENERATED_OPERATION_STATE_ACTIVE) {
      return "current_v2";
    }
    if (
      document.intentDigest === params.intentDigest &&
      storedPolicy.version === params.recipientPolicy.version &&
      storedPolicy.excludePriorFailedBulkSends ===
        params.recipientPolicy.excludePriorFailedBulkSends
    ) {
      return "current_v2";
    }
    return "payload_mismatch";
  }
  if (
    document.intentDigestVersion === params.legacyIntentDigestVersion &&
    document.intentDigest === params.legacyIntentDigest
  ) {
    return "legacy_v1";
  }
  return "payload_mismatch";
}

function parseGeneratedOperationPayload(
  value: string | undefined,
  label: "progress" | "response"
): Record<string, unknown> | null {
  const parsed = parseResponseBody(value);
  if (value && !parsed) {
    throw new Error(`Generated bulk-send operation ${label} is invalid`);
  }
  return parsed;
}

function acquiredGeneratedOperationResult(
  document: BulkSendIdempotencyDocument,
  reservationToken: string,
  isNew: boolean,
  compatibilityMode: "current_v2" | "legacy_v1_disabled"
): GeneratedBulkSendOperationReservation {
  if (!document.campaignId || !document.userId) {
    throw new Error("Generated bulk-send operation identity is invalid");
  }
  if (!hasAudienceRevision(document.audienceRevision)) {
    throw new Error(
      "Generated bulk-send operation audience revision is invalid"
    );
  }
  const requestedAt = normalizeGeneratedOperationRequestedAt(
    document.requestedAtIso
  );
  if (!requestedAt) {
    throw new Error("Generated bulk-send operation request time is invalid");
  }
  const progressBody = parseGeneratedOperationPayload(
    document.progressBody,
    "progress"
  );
  const recipientPolicy =
    compatibilityMode === "current_v2"
      ? parseGeneratedOperationRecipientPolicy(document.recipientPolicy)
      : normalizeBulkCampaignRecipientPolicy({
          version: 1,
          excludePriorFailedBulkSends: false,
        });
  return {
    status: "acquired",
    operationId: document.campaignId,
    reservationToken,
    initiatingUserId: document.userId,
    audienceRevision: document.audienceRevision,
    requestedAt,
    scheduledAt: document.scheduledAtIso ?? null,
    isNew,
    compatibilityMode,
    recipientPolicy,
    progressVersion: document.progressVersion ?? 0,
    ...(progressBody ? { progressBody } : {}),
    ...(document.requestDigest
      ? {
          requestDigest: document.requestDigest,
          requestDigestVersion: document.requestDigestVersion,
        }
      : {}),
  };
}

function terminalGeneratedOperationResult(
  document: BulkSendIdempotencyDocument
): Extract<
  GeneratedBulkSendOperationReservation,
  { status: "completed" | "failed" }
> | null {
  if (
    document.operationState !== GENERATED_OPERATION_STATE_COMPLETED &&
    document.operationState !== GENERATED_OPERATION_STATE_FAILED
  ) {
    return null;
  }
  if (!document.campaignId) {
    throw new Error("Terminal generated bulk-send operation ID is missing");
  }
  const responseBody = parseGeneratedOperationPayload(
    document.responseBody,
    "response"
  );
  if (!responseBody) {
    throw new Error("Terminal generated bulk-send operation has no response");
  }
  if (document.operationState === GENERATED_OPERATION_STATE_COMPLETED) {
    return {
      status: "completed",
      operationId: document.campaignId,
      responseBody,
    };
  }
  if (
    !Number.isSafeInteger(document.responseStatus) ||
    Number(document.responseStatus) < 400 ||
    Number(document.responseStatus) > 599
  ) {
    throw new Error(
      "Failed generated bulk-send operation response status is invalid"
    );
  }
  return {
    status: "failed",
    operationId: document.campaignId,
    responseStatus: Number(document.responseStatus),
    responseBody,
  };
}

function terminalGeneratedRequestDigestMatchesCompatibility(
  document: BulkSendIdempotencyDocument,
  intentMatch: "current_v2" | "legacy_v1"
): boolean {
  const expectedRequestDigestVersion = intentMatch === "current_v2" ? 2 : 1;
  return (
    document.requestDigestVersion === expectedRequestDigestVersion &&
    typeof document.requestDigest === "string" &&
    /^[a-f0-9]{64}$/.test(document.requestDigest)
  );
}

function isGeneratedTerminalCount(value: unknown, minimum = 0): boolean {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function isGeneratedTerminalSha256(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function terminalGeneratedPolicyOutcomeIsValid(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const unique = value.uniqueRecipients;
  const warnings = value.warnings;
  const skipped = value.skippedByReason;
  if (
    !isGeneratedTerminalCount(value.requestedTotal) ||
    Number(value.requestedTotal) > SCENARIO_GENERATOR_MAX_GENERATED_MESSAGES ||
    !isGeneratedTerminalCount(value.acceptedTotal) ||
    Number(value.acceptedTotal) > Number(value.requestedTotal) ||
    !isRecord(unique) ||
    !isGeneratedTerminalCount(unique.requested) ||
    !isGeneratedTerminalCount(unique.accepted) ||
    Number(unique.accepted) > Number(unique.requested) ||
    Number(unique.requested) > Number(value.requestedTotal) ||
    Number(unique.accepted) > Number(value.acceptedTotal) ||
    !isRecord(skipped) ||
    Object.entries(skipped).some(
      ([reason, count]) =>
        ![
          "ineligible",
          "marketing_opt_out",
          "recipient_limit",
          "prior_failure",
          "service_window",
          "unsubscribed",
          "recent_contact",
        ].includes(reason) || !isGeneratedTerminalCount(count)
    ) ||
    !isRecord(warnings) ||
    !isGeneratedTerminalCount(warnings.missingMarketingConsent) ||
    typeof value.allExcluded !== "boolean"
  ) {
    return false;
  }
  const skippedTotal = Object.values(skipped).reduce<number>(
    (sum, count) => sum + Number(count),
    0
  );
  return (
    Number(value.acceptedTotal) + skippedTotal ===
      Number(value.requestedTotal) &&
    value.allExcluded ===
      (Number(value.requestedTotal) > 0 && Number(value.acceptedTotal) === 0)
  );
}

function terminalGeneratedRecoveryFactIsValid(
  value: unknown,
  policyMode: "required" | "forbidden"
): boolean {
  if (!isRecord(value)) return false;
  const audience = value.audience;
  const batchPlan = value.batchPlan;
  if (
    typeof value.partitionKey !== "string" ||
    !value.partitionKey.trim() ||
    typeof value.campaignId !== "string" ||
    !value.campaignId.trim() ||
    !["whatsapp", "telegram", "email"].includes(String(value.channel)) ||
    !(
      value.sourceId === null ||
      (typeof value.sourceId === "string" && value.sourceId.trim())
    ) ||
    !isRecord(batchPlan) ||
    !isGeneratedTerminalCount(batchPlan.batchSize, 1) ||
    !isGeneratedTerminalCount(batchPlan.delayMs) ||
    typeof batchPlan.ratePerSecond !== "number" ||
    !Number.isFinite(batchPlan.ratePerSecond) ||
    batchPlan.ratePerSecond <= 0 ||
    typeof batchPlan.rateSource !== "string" ||
    !batchPlan.rateSource.trim() ||
    !isGeneratedTerminalSha256(value.contentHash) ||
    !isRecord(audience) ||
    audience.version !== 1 ||
    !isGeneratedTerminalCount(audience.count, 1) ||
    !isGeneratedTerminalSha256(audience.digest) ||
    !isGeneratedTerminalCount(value.requestedTotal, 1) ||
    Number(value.requestedTotal) > SCENARIO_GENERATOR_MAX_GENERATED_MESSAGES ||
    Number(audience.count) > Number(value.requestedTotal) ||
    !isGeneratedTerminalCount(value.skippedOptIn) ||
    Number(value.skippedOptIn) > Number(value.requestedTotal)
  ) {
    return false;
  }
  if (policyMode === "forbidden") return value.policyFacts === undefined;
  const policyFacts = value.policyFacts;
  if (!isRecord(policyFacts)) return false;
  const limit = policyFacts.authoritativeRecipientLimit;
  return (
    isRecord(limit) &&
    ["live_meta", "cached_meta", "channel_default"].includes(
      String(limit.source)
    ) &&
    isGeneratedTerminalCount(limit.value, 1) &&
    typeof limit.rawLimit === "string" &&
    Boolean(limit.rawLimit.trim()) &&
    terminalGeneratedPolicyOutcomeIsValid(policyFacts.outcome)
  );
}

function terminalGeneratedProgressFactsAreValid(
  progress: Record<string, unknown>,
  policyMode: "required" | "forbidden"
): boolean {
  const recoveryFacts = progress.recoveryFacts;
  if (
    !Array.isArray(recoveryFacts) ||
    recoveryFacts.length > 300 ||
    Buffer.byteLength(JSON.stringify(recoveryFacts), "utf8") > 192 * 1024 ||
    !isGeneratedTerminalCount(progress.admittedChildrenCount) ||
    !isGeneratedTerminalCount(progress.queuedCount) ||
    Number(progress.queuedCount) > SCENARIO_GENERATOR_MAX_GENERATED_MESSAGES ||
    !isGeneratedTerminalCount(progress.skippedCount) ||
    Number(progress.skippedCount) > SCENARIO_GENERATOR_MAX_GENERATED_MESSAGES ||
    Number(progress.queuedCount) + Number(progress.skippedCount) >
      SCENARIO_GENERATOR_MAX_GENERATED_MESSAGES ||
    !(
      progress.lastPartitionKey === null ||
      (typeof progress.lastPartitionKey === "string" &&
        progress.lastPartitionKey.trim())
    ) ||
    recoveryFacts.some(
      fact => !terminalGeneratedRecoveryFactIsValid(fact, policyMode)
    )
  ) {
    return false;
  }
  const facts = recoveryFacts as Array<Record<string, unknown>>;
  const admittedAudienceTotal = facts.reduce(
    (total, fact) =>
      total + Number((fact.audience as Record<string, unknown>).count),
    0
  );
  return (
    new Set(facts.map(fact => fact.partitionKey)).size === facts.length &&
    new Set(facts.map(fact => fact.campaignId)).size === facts.length &&
    Number(progress.admittedChildrenCount) <= facts.length &&
    admittedAudienceTotal <= SCENARIO_GENERATOR_MAX_GENERATED_MESSAGES &&
    Number(progress.queuedCount) <= admittedAudienceTotal &&
    (progress.lastPartitionKey === null ||
      facts.some(fact => fact.partitionKey === progress.lastPartitionKey))
  );
}

export function generatedBulkSendPreparedProgressMatchesCompatibility(
  progressBody: unknown,
  compatibilityMode: "current_v2" | "legacy_v1_disabled",
  recipientPolicy: BulkCampaignRecipientPolicy
): boolean {
  const progress =
    typeof progressBody === "string"
      ? parseResponseBody(progressBody)
      : isRecord(progressBody)
        ? progressBody
        : null;
  if (
    !progress ||
    progress.version !== 1 ||
    progress.phase !== "prepared" ||
    !isGeneratedTerminalSha256(progress.preparationDigest) ||
    !Array.isArray(progress.recoveryFacts)
  ) {
    return false;
  }
  if (compatibilityMode === "legacy_v1_disabled") {
    return (
      progress.preparationDigestVersion === 2 &&
      progress.recipientPolicy === undefined &&
      progress.whatsappPolicyFacts === undefined &&
      terminalGeneratedProgressFactsAreValid(progress, "forbidden")
    );
  }
  const persistedPolicy = progress.recipientPolicy;
  const policyMatches =
    isRecord(persistedPolicy) &&
    persistedPolicy.version === recipientPolicy.version &&
    persistedPolicy.excludePriorFailedBulkSends ===
      recipientPolicy.excludePriorFailedBulkSends;
  if (!policyMatches) return false;
  const hasWhatsAppRecoveryFact = progress.recoveryFacts.some(
    fact => isRecord(fact) && fact.channel === "whatsapp"
  );
  const whatsappPolicyFacts = progress.whatsappPolicyFacts;
  if (whatsappPolicyFacts !== undefined) {
    if (!isRecord(whatsappPolicyFacts)) return false;
    const globalPolicy = whatsappPolicyFacts.policy;
    const globalLimit = whatsappPolicyFacts.authoritativeRecipientLimit;
    if (
      !isRecord(globalPolicy) ||
      globalPolicy.version !== recipientPolicy.version ||
      globalPolicy.excludePriorFailedBulkSends !==
        recipientPolicy.excludePriorFailedBulkSends ||
      !terminalGeneratedPolicyOutcomeIsValid(whatsappPolicyFacts.outcome)
    ) {
      return false;
    }
    const globalOutcome = whatsappPolicyFacts.outcome as Record<
      string,
      unknown
    >;
    if (globalLimit === undefined) {
      if (
        hasWhatsAppRecoveryFact ||
        Number(globalOutcome.acceptedTotal) !== 0
      ) {
        return false;
      }
    } else if (
      !isRecord(globalLimit) ||
      !["live_meta", "cached_meta", "channel_default"].includes(
        String(globalLimit.source)
      ) ||
      !isGeneratedTerminalCount(globalLimit.value, 1) ||
      typeof globalLimit.rawLimit !== "string" ||
      !globalLimit.rawLimit.trim()
    ) {
      return false;
    }
  } else if (
    progress.preparationDigestVersion === 3 &&
    hasWhatsAppRecoveryFact
  ) {
    return false;
  }
  if (progress.preparationDigestVersion === 1) {
    return (
      progress.recoveryFacts.length === 0 &&
      terminalGeneratedProgressFactsAreValid(progress, "required")
    );
  }
  return (
    progress.preparationDigestVersion === 3 &&
    terminalGeneratedProgressFactsAreValid(progress, "required")
  );
}

function terminalGeneratedProgressMatchesCompatibility(
  document: BulkSendIdempotencyDocument,
  intentMatch: "current_v2" | "legacy_v1",
  recipientPolicy: BulkCampaignRecipientPolicy
): boolean {
  if (intentMatch === "legacy_v1" && !document.progressBody) return true;
  return generatedBulkSendPreparedProgressMatchesCompatibility(
    document.progressBody,
    intentMatch === "legacy_v1" ? "legacy_v1_disabled" : "current_v2",
    recipientPolicy
  );
}

type GeneratedOperationCandidateResolution =
  | GeneratedBulkSendOperationReservation
  | { status: "legacy_terminalized" };

async function resolveGeneratedOperationCandidate(
  document: BulkSendIdempotencyDocument,
  params: GeneratedOperationIntent,
  now: Date,
  reservationToken: string,
  options: { foundByClientKey: boolean; raceReread?: boolean }
): Promise<GeneratedOperationCandidateResolution> {
  const intentMatch = classifyGeneratedOperationIntent(document, params);
  if (intentMatch === "payload_mismatch") {
    return { status: "payload_mismatch" };
  }
  if (!document.campaignId) {
    throw new Error("Generated bulk-send operation ID is missing");
  }
  if (
    intentMatch === "legacy_missing_audience_revision" ||
    intentMatch === "legacy_missing_requested_at"
  ) {
    return {
      status: "legacy_operation",
      operationId: document.campaignId,
      reason:
        intentMatch === "legacy_missing_audience_revision"
          ? "missing_audience_revision"
          : "missing_requested_at",
    };
  }

  const terminalResult = terminalGeneratedOperationResult(document);
  if (terminalResult) {
    if (
      !terminalGeneratedRequestDigestMatchesCompatibility(
        document,
        intentMatch
      ) ||
      !terminalGeneratedProgressMatchesCompatibility(
        document,
        intentMatch,
        params.recipientPolicy
      )
    ) {
      return { status: "payload_mismatch" };
    }
    return intentMatch === "legacy_v1" &&
      params.recipientPolicy.excludePriorFailedBulkSends
      ? { status: "payload_mismatch" }
      : terminalResult;
  }
  if (document.operationState !== GENERATED_OPERATION_STATE_ACTIVE) {
    return { status: "payload_mismatch" };
  }

  const existingLeaseExpiresAt = document.reservationExpiresAt
    ? new Date(document.reservationExpiresAt).getTime()
    : 0;
  if (
    document.reservationToken &&
    Number.isFinite(existingLeaseExpiresAt) &&
    existingLeaseExpiresAt > now.getTime()
  ) {
    return {
      status: "in_progress",
      operationId: document.campaignId,
      retryAfterMs: existingLeaseExpiresAt - now.getTime(),
    };
  }
  if (options.raceReread) {
    throw new Error("Generated bulk-send operation active lease is invalid");
  }

  if (
    intentMatch === "legacy_v1" &&
    params.recipientPolicy.excludePriorFailedBulkSends
  ) {
    const responseBody = serializeBoundedJson(
      {
        operationDisposition: "in_progress",
        code: "generated_bulk_send_legacy_policy_upgrade_required",
        error:
          "This generated send must be retried as a fresh policy-aware operation.",
        retryable: false,
      },
      BULK_SEND_IDEMPOTENCY_MAX_RESPONSE_BYTES,
      "Generated bulk-send operation response exceeds 256 KiB"
    );
    const terminalized = await BulkSendApiIdempotency.findOneAndUpdate(
      {
        campaignId: document.campaignId,
        workspaceId: params.workspaceId,
        scenarioId: params.scenarioId,
        audienceRevision: params.audienceRevision,
        operationKind: GENERATED_OPERATION_KIND,
        operationState: GENERATED_OPERATION_STATE_ACTIVE,
        intentDigestVersion: params.legacyIntentDigestVersion,
        intentDigest: params.legacyIntentDigest,
        $or: [
          { reservationExpiresAt: { $lte: now } },
          { reservationExpiresAt: { $exists: false } },
        ],
      },
      {
        $set: {
          operationState: GENERATED_OPERATION_STATE_FAILED,
          responseStatus: 409,
          responseBody,
          expiresAt: new Date(
            now.getTime() + BULK_SEND_IDEMPOTENCY_TERMINAL_TTL_MS
          ),
        },
        $unset: {
          activeScenarioKey: "",
          progressBody: "",
          reservationExpiresAt: "",
          reservationToken: "",
        },
      },
      { new: true }
    ).lean<BulkSendIdempotencyDocument | null>();
    if (terminalized) {
      return options.foundByClientKey
        ? { status: "payload_mismatch" }
        : { status: "legacy_terminalized" };
    }
    const latest = await readGeneratedOperation({
      campaignId: document.campaignId,
      workspaceId: params.workspaceId,
      scenarioId: params.scenarioId,
      operationKind: GENERATED_OPERATION_KIND,
    });
    if (!latest) {
      throw new Error("Generated bulk-send operation disappeared");
    }
    return resolveGeneratedOperationCandidate(
      latest,
      params,
      now,
      reservationToken,
      { ...options, raceReread: true }
    );
  }

  const reservationExpiresAt = new Date(
    now.getTime() + BULK_SEND_IDEMPOTENCY_RESERVATION_LEASE_MS
  );
  const acquired = await BulkSendApiIdempotency.findOneAndUpdate(
    {
      campaignId: document.campaignId,
      workspaceId: params.workspaceId,
      scenarioId: params.scenarioId,
      audienceRevision: params.audienceRevision,
      intentDigestVersion: document.intentDigestVersion,
      intentDigest: document.intentDigest,
      operationKind: GENERATED_OPERATION_KIND,
      operationState: GENERATED_OPERATION_STATE_ACTIVE,
      $or: [
        { reservationExpiresAt: { $lte: now } },
        { reservationExpiresAt: { $exists: false } },
      ],
    },
    {
      $set: {
        reservationToken,
        reservationExpiresAt,
      },
      $unset: { expiresAt: "" },
    },
    { new: true }
  ).lean<BulkSendIdempotencyDocument | null>();

  if (acquired) {
    return acquiredGeneratedOperationResult(
      acquired,
      reservationToken,
      false,
      intentMatch === "legacy_v1" ? "legacy_v1_disabled" : "current_v2"
    );
  }

  const latest = await readGeneratedOperation({
    campaignId: document.campaignId,
    workspaceId: params.workspaceId,
    scenarioId: params.scenarioId,
    operationKind: GENERATED_OPERATION_KIND,
  });
  if (!latest) {
    throw new Error("Generated bulk-send operation disappeared");
  }
  return resolveGeneratedOperationCandidate(
    latest,
    params,
    now,
    reservationToken,
    { ...options, raceReread: true }
  );
}

export async function reserveGeneratedBulkSendOperation(params: {
  workspaceId: string;
  scenarioId: string;
  initiatingUserId: string;
  idempotencyKey?: string | null;
  scheduledAt?: string | null;
  audienceRevision: string;
  intentDigestVersion: number;
  intentDigest: string;
  legacyIntentDigestVersion: 1;
  legacyIntentDigest: string;
  recipientPolicy: BulkCampaignRecipientPolicy;
  beforeCreate?: GeneratedBulkSendOperationBeforeCreate;
}): Promise<GeneratedBulkSendOperationReservation> {
  assertVersionedDigest(
    "Generated bulk-send intent",
    params.intentDigestVersion,
    params.intentDigest
  );
  assertVersionedDigest(
    "Generated bulk-send legacy intent",
    params.legacyIntentDigestVersion,
    params.legacyIntentDigest
  );
  if (params.legacyIntentDigestVersion !== 1) {
    throw new Error("Generated bulk-send legacy intent version must be 1");
  }
  const recipientPolicy = normalizeBulkCampaignRecipientPolicy(
    params.recipientPolicy
  );
  if (!hasAudienceRevision(params.audienceRevision)) {
    throw new Error(
      "Generated bulk-send operation audience revision is required"
    );
  }
  const scheduledAtIso = normalizeGeneratedOperationSchedule(
    params.scheduledAt
  );
  const scheduledAtWasProvided = Object.prototype.hasOwnProperty.call(
    params,
    "scheduledAt"
  );
  await ensureBulkSendApiIdempotencyIndexes();

  const now = new Date();
  const reservationToken = randomBytes(32).toString("base64url");
  const reservationExpiresAt = new Date(
    now.getTime() + BULK_SEND_IDEMPOTENCY_RESERVATION_LEASE_MS
  );
  const activeScenarioKey = resolveActiveScenarioKey(params);
  const clientKeyHash = resolveGeneratedClientKeyHash(params);
  const resolvedIntent = {
    workspaceId: params.workspaceId,
    scenarioId: params.scenarioId,
    audienceRevision: params.audienceRevision,
    intentDigestVersion: params.intentDigestVersion,
    intentDigest: params.intentDigest,
    recipientPolicy,
    legacyIntentDigestVersion: params.legacyIntentDigestVersion,
    legacyIntentDigest: params.legacyIntentDigest,
    scheduledAtIso,
    scheduledAtWasProvided,
  };

  if (clientKeyHash) {
    const keyedDocument = await readGeneratedOperation({
      keyHash: clientKeyHash,
    });
    if (keyedDocument) {
      const resolved = await resolveGeneratedOperationCandidate(
        keyedDocument,
        resolvedIntent,
        now,
        reservationToken,
        { foundByClientKey: true }
      );
      return resolved.status === "legacy_terminalized"
        ? { status: "payload_mismatch" }
        : resolved;
    }
  }

  const activeDocument = await readGeneratedOperation({
    activeScenarioKey,
    operationKind: GENERATED_OPERATION_KIND,
    operationState: GENERATED_OPERATION_STATE_ACTIVE,
  });
  if (activeDocument) {
    const resolved = await resolveGeneratedOperationCandidate(
      activeDocument,
      resolvedIntent,
      now,
      reservationToken,
      { foundByClientKey: false }
    );
    if (resolved.status !== "legacy_terminalized") return resolved;
  }

  const operationSeed = clientKeyHash ?? randomBytes(32).toString("base64url");
  const operationId = deterministicUuid(
    `generated-bulk-send-operation:${operationSeed}`
  );
  const keyHash =
    clientKeyHash ?? hashKey(`generated-bulk-send-internal-key:${operationId}`);
  const document = {
    keyHash,
    workspaceId: params.workspaceId,
    userId: params.initiatingUserId,
    operationKind: GENERATED_OPERATION_KIND,
    operationState: GENERATED_OPERATION_STATE_ACTIVE,
    scenarioId: params.scenarioId,
    activeScenarioKey,
    campaignId: operationId,
    audienceRevision: params.audienceRevision,
    requestedAtIso: now.toISOString(),
    scheduledAtIso,
    intentDigestVersion: params.intentDigestVersion,
    intentDigest: params.intentDigest,
    recipientPolicy,
    reservationToken,
    reservationExpiresAt,
    progressVersion: 0,
  };

  if (params.beforeCreate) {
    const candidate = acquiredGeneratedOperationResult(
      document,
      reservationToken,
      true,
      "current_v2"
    );
    if (candidate.status !== "acquired") {
      throw new Error("Generated bulk-send candidate is invalid");
    }
    await params.beforeCreate(candidate);
  }

  try {
    const created = (await BulkSendApiIdempotency.create(
      document
    )) as BulkSendIdempotencyDocument;
    return acquiredGeneratedOperationResult(
      {
        ...document,
        ...created,
      },
      reservationToken,
      true,
      "current_v2"
    );
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }
  }

  const winnerByKey = clientKeyHash
    ? await readGeneratedOperation({ keyHash: clientKeyHash })
    : null;
  const winner =
    winnerByKey ??
    (await readGeneratedOperation({
      activeScenarioKey,
      operationKind: GENERATED_OPERATION_KIND,
      operationState: GENERATED_OPERATION_STATE_ACTIVE,
    }));
  if (!winner) {
    throw new Error("Generated bulk-send operation race winner disappeared");
  }
  const resolved = await resolveGeneratedOperationCandidate(
    winner,
    resolvedIntent,
    now,
    reservationToken,
    { foundByClientKey: Boolean(winnerByKey) }
  );
  return resolved.status === "legacy_terminalized"
    ? { status: "payload_mismatch" }
    : resolved;
}

function generatedOperationOwnerFilter(
  params: GeneratedOperationOwnerScope
): Record<string, unknown> {
  return {
    campaignId: params.operationId,
    workspaceId: params.workspaceId,
    scenarioId: params.scenarioId,
    operationKind: GENERATED_OPERATION_KIND,
    operationState: GENERATED_OPERATION_STATE_ACTIVE,
    reservationToken: params.reservationToken,
  };
}

export async function bindGeneratedBulkSendOperationRequestDigest(
  params: GeneratedOperationOwnerScope & {
    requestDigestVersion: number;
    requestDigest: string;
  }
): Promise<
  | { status: "bound" }
  | { status: "matched" }
  | { status: "payload_mismatch" }
  | { status: "stale_owner" }
> {
  assertVersionedDigest(
    "Generated bulk-send request",
    params.requestDigestVersion,
    params.requestDigest
  );
  await connectDB();
  const ownerFilter = generatedOperationOwnerFilter(params);
  const current = await readGeneratedOperation(ownerFilter);
  if (!current) {
    return { status: "stale_owner" };
  }
  if (current.requestDigest) {
    return current.requestDigestVersion === params.requestDigestVersion &&
      current.requestDigest === params.requestDigest
      ? { status: "matched" }
      : { status: "payload_mismatch" };
  }

  const bound = await BulkSendApiIdempotency.findOneAndUpdate(
    {
      ...ownerFilter,
      requestDigest: { $exists: false },
    },
    {
      $set: {
        requestDigestVersion: params.requestDigestVersion,
        requestDigest: params.requestDigest,
      },
    },
    { new: true }
  ).lean<BulkSendIdempotencyDocument | null>();
  if (bound) {
    return { status: "bound" };
  }

  const latest = await readGeneratedOperation(ownerFilter);
  if (!latest) {
    return { status: "stale_owner" };
  }
  return latest.requestDigestVersion === params.requestDigestVersion &&
    latest.requestDigest === params.requestDigest
    ? { status: "matched" }
    : { status: "payload_mismatch" };
}

export async function renewGeneratedBulkSendOperationLease(
  params: GeneratedOperationOwnerScope
): Promise<boolean> {
  await connectDB();
  const renewed = await BulkSendApiIdempotency.findOneAndUpdate(
    generatedOperationOwnerFilter(params),
    {
      $set: {
        reservationExpiresAt: new Date(
          Date.now() + BULK_SEND_IDEMPOTENCY_RESERVATION_LEASE_MS
        ),
      },
      $unset: { expiresAt: "" },
    },
    { new: true }
  ).lean<{ _id?: unknown } | null>();
  return Boolean(renewed);
}

export async function compareAndSetGeneratedBulkSendOperationProgress(
  params: GeneratedOperationOwnerScope & {
    expectedProgressVersion: number;
    progressBody: Record<string, unknown>;
  }
): Promise<{ progressVersion: number } | null> {
  const progressBody = serializeBoundedJson(
    params.progressBody,
    BULK_SEND_IDEMPOTENCY_MAX_PROGRESS_BYTES,
    "Generated bulk-send operation progress exceeds 256 KiB"
  );
  if (
    !Number.isSafeInteger(params.expectedProgressVersion) ||
    params.expectedProgressVersion < 0
  ) {
    throw new Error("Generated bulk-send progress version is invalid");
  }

  await connectDB();
  const recorded = await BulkSendApiIdempotency.findOneAndUpdate(
    {
      ...generatedOperationOwnerFilter(params),
      progressVersion: params.expectedProgressVersion,
    },
    {
      $set: {
        progressBody,
      },
      $inc: { progressVersion: 1 },
    },
    { new: true }
  ).lean<{ progressVersion?: number } | null>();
  if (!recorded || typeof recorded.progressVersion !== "number") {
    return null;
  }
  return { progressVersion: recorded.progressVersion };
}

export async function releaseGeneratedBulkSendOperationLease(
  params: GeneratedOperationOwnerScope
): Promise<boolean> {
  await connectDB();
  const released = await BulkSendApiIdempotency.findOneAndUpdate(
    generatedOperationOwnerFilter(params),
    {
      $unset: {
        reservationExpiresAt: "",
        reservationToken: "",
      },
    },
    { new: true }
  ).lean<{ _id?: unknown } | null>();
  return Boolean(released);
}

export async function completeGeneratedBulkSendOperation(
  params: GeneratedOperationOwnerScope & {
    responseBody: Record<string, unknown>;
  }
): Promise<boolean> {
  const responseBody = serializeBoundedJson(
    params.responseBody,
    BULK_SEND_IDEMPOTENCY_MAX_RESPONSE_BYTES,
    "Generated bulk-send operation response exceeds 256 KiB"
  );

  await connectDB();
  const completed = await BulkSendApiIdempotency.findOneAndUpdate(
    {
      ...generatedOperationOwnerFilter(params),
      requestDigest: { $exists: true },
    },
    {
      $set: {
        operationState: GENERATED_OPERATION_STATE_COMPLETED,
        responseBody,
        expiresAt: new Date(Date.now() + BULK_SEND_IDEMPOTENCY_TERMINAL_TTL_MS),
      },
      $unset: {
        activeScenarioKey: "",
        reservationExpiresAt: "",
        reservationToken: "",
      },
    },
    { new: true }
  ).lean<{ _id?: unknown } | null>();
  return Boolean(completed);
}

export async function failGeneratedBulkSendOperation(
  params: GeneratedOperationOwnerScope & {
    responseStatus: number;
    responseBody: Record<string, unknown>;
  }
): Promise<boolean> {
  if (
    !Number.isSafeInteger(params.responseStatus) ||
    params.responseStatus < 400 ||
    params.responseStatus > 599
  ) {
    throw new Error(
      "Generated bulk-send terminal response status must be between 400 and 599"
    );
  }
  const responseBody = serializeBoundedJson(
    params.responseBody,
    BULK_SEND_IDEMPOTENCY_MAX_RESPONSE_BYTES,
    "Generated bulk-send operation response exceeds 256 KiB"
  );

  await connectDB();
  const failed = await BulkSendApiIdempotency.findOneAndUpdate(
    {
      ...generatedOperationOwnerFilter(params),
      requestDigest: { $exists: true },
    },
    {
      $set: {
        operationState: GENERATED_OPERATION_STATE_FAILED,
        responseStatus: params.responseStatus,
        responseBody,
        expiresAt: new Date(Date.now() + BULK_SEND_IDEMPOTENCY_TERMINAL_TTL_MS),
      },
      $unset: {
        activeScenarioKey: "",
        reservationExpiresAt: "",
        reservationToken: "",
      },
    },
    { new: true }
  ).lean<{ _id?: unknown } | null>();
  return Boolean(failed);
}

export async function deleteGeneratedBulkSendOperationBeforeClaim(
  params: GeneratedOperationOwnerScope
): Promise<boolean> {
  await connectDB();
  const result = await BulkSendApiIdempotency.deleteOne({
    ...generatedOperationOwnerFilter(params),
    progressBody: { $exists: false },
  });
  return result.deletedCount === 1;
}

const LEGACY_OPERATION_FIELDS = [
  "_id",
  "operationKind",
  "operationState",
  "progressBody",
  "requestDigest",
  "requestDigestVersion",
  "reservationExpiresAt",
  "reservationToken",
  "responseBody",
  "userId",
  "workspaceId",
].join(" ");

async function readLegacyOperation(
  keyHash: string
): Promise<BulkSendIdempotencyDocument | null> {
  return BulkSendApiIdempotency.findOne({ keyHash })
    .select(LEGACY_OPERATION_FIELDS)
    .lean<BulkSendIdempotencyDocument | null>();
}

function terminalLegacyOperationResult(
  document: BulkSendIdempotencyDocument
): Extract<LegacyBulkSendOperationReservation, { status: "completed" }> | null {
  const isLegacyResponseOnlyRecord =
    !document.operationState && Boolean(document.responseBody);
  if (
    document.operationState !== LEGACY_OPERATION_STATE_COMPLETED &&
    !isLegacyResponseOnlyRecord
  ) {
    return null;
  }
  if (
    document.operationState === LEGACY_OPERATION_STATE_COMPLETED &&
    (document.operationKind !== LEGACY_OPERATION_KIND ||
      !Number.isSafeInteger(document.requestDigestVersion) ||
      Number(document.requestDigestVersion) <= 0 ||
      typeof document.requestDigest !== "string" ||
      document.requestDigest.trim() === "")
  ) {
    throw new Error("completed legacy bulk-send operation is malformed");
  }
  const responseBody = parseResponseBody(document.responseBody);
  if (!responseBody) {
    throw new Error("Legacy bulk-send operation response is invalid");
  }
  const eventFacts = parseResponseBody(document.progressBody);
  if (document.progressBody && !eventFacts) {
    throw new Error("Legacy bulk-send operation event facts are invalid");
  }
  return {
    status: "completed",
    responseBody,
    ...(eventFacts ? { eventFacts } : {}),
  };
}

function legacyRequestDigestMatches(
  document: BulkSendIdempotencyDocument,
  params: { requestDigestVersion: number; requestDigest: string }
): boolean {
  return (
    document.requestDigestVersion === params.requestDigestVersion &&
    document.requestDigest === params.requestDigest
  );
}

async function resolveLegacyOperationCandidate(
  document: BulkSendIdempotencyDocument,
  params: IdempotencyScope & {
    requestDigestVersion: number;
    requestDigest: string;
  },
  now: Date,
  reservationToken: string
): Promise<LegacyBulkSendOperationReservation> {
  const terminal = terminalLegacyOperationResult(document);
  if (terminal) {
    if (
      document.requestDigest &&
      !legacyRequestDigestMatches(document, params)
    ) {
      return { status: "payload_mismatch" };
    }
    return terminal;
  }
  if (
    document.operationKind !== LEGACY_OPERATION_KIND ||
    document.operationState !== LEGACY_OPERATION_STATE_ACTIVE ||
    !legacyRequestDigestMatches(document, params)
  ) {
    return { status: "payload_mismatch" };
  }

  const leaseExpiresAt = document.reservationExpiresAt
    ? new Date(document.reservationExpiresAt).getTime()
    : Number.NaN;
  if (
    document.reservationToken &&
    Number.isFinite(leaseExpiresAt) &&
    leaseExpiresAt > now.getTime()
  ) {
    return {
      status: "in_progress",
      retryAfterMs: leaseExpiresAt - now.getTime(),
    };
  }

  const reservationExpiresAt = new Date(
    now.getTime() + BULK_SEND_LEGACY_IDEMPOTENCY_RESERVATION_LEASE_MS
  );
  const acquired = await BulkSendApiIdempotency.findOneAndUpdate(
    {
      keyHash: resolveKeyHash(params),
      workspaceId: params.workspaceId,
      userId: params.userId,
      operationKind: LEGACY_OPERATION_KIND,
      operationState: LEGACY_OPERATION_STATE_ACTIVE,
      requestDigestVersion: params.requestDigestVersion,
      requestDigest: params.requestDigest,
      $or: [
        { reservationExpiresAt: { $lte: now } },
        { reservationExpiresAt: { $exists: false } },
      ],
    },
    {
      $set: { reservationToken, reservationExpiresAt },
      $unset: { expiresAt: "" },
    },
    { new: true }
  ).lean<BulkSendIdempotencyDocument | null>();
  if (acquired) {
    return { status: "acquired", reservationToken };
  }

  const latest = await readLegacyOperation(resolveKeyHash(params));
  if (!latest) {
    throw new Error("Legacy bulk-send operation race winner disappeared");
  }
  const latestTerminal = terminalLegacyOperationResult(latest);
  if (latestTerminal) {
    return legacyRequestDigestMatches(latest, params) || !latest.requestDigest
      ? latestTerminal
      : { status: "payload_mismatch" };
  }
  if (!legacyRequestDigestMatches(latest, params)) {
    return { status: "payload_mismatch" };
  }
  const latestLeaseExpiresAt = latest.reservationExpiresAt
    ? new Date(latest.reservationExpiresAt).getTime()
    : Number.NaN;
  if (!latest.reservationToken || !Number.isFinite(latestLeaseExpiresAt)) {
    throw new Error("Legacy bulk-send operation active lease is invalid");
  }
  return {
    status: "in_progress",
    retryAfterMs: Math.max(0, latestLeaseExpiresAt - now.getTime()),
  };
}

export async function reserveLegacyBulkSendOperation(
  params: IdempotencyScope & {
    requestDigestVersion: number;
    requestDigest: string;
  }
): Promise<LegacyBulkSendOperationReservation> {
  assertVersionedDigest(
    "Legacy bulk-send request",
    params.requestDigestVersion,
    params.requestDigest
  );
  await ensureBulkSendApiIdempotencyIndexes();

  const keyHash = resolveKeyHash(params);
  const now = new Date();
  const reservationToken = randomBytes(32).toString("base64url");
  const existing = await readLegacyOperation(keyHash);
  if (existing) {
    return resolveLegacyOperationCandidate(
      existing,
      params,
      now,
      reservationToken
    );
  }

  const document = {
    keyHash,
    workspaceId: params.workspaceId,
    userId: params.userId,
    operationKind: LEGACY_OPERATION_KIND,
    operationState: LEGACY_OPERATION_STATE_ACTIVE,
    requestDigestVersion: params.requestDigestVersion,
    requestDigest: params.requestDigest,
    reservationToken,
    reservationExpiresAt: new Date(
      now.getTime() + BULK_SEND_LEGACY_IDEMPOTENCY_RESERVATION_LEASE_MS
    ),
    progressVersion: 0,
  };
  try {
    await BulkSendApiIdempotency.create(document);
    return { status: "acquired", reservationToken };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }

  const winner = await readLegacyOperation(keyHash);
  if (!winner) {
    throw new Error("Legacy bulk-send operation race winner disappeared");
  }
  return resolveLegacyOperationCandidate(winner, params, now, reservationToken);
}

function legacyOperationOwnerFilter(
  params: LegacyBulkSendOperationOwnerScope
): Record<string, unknown> {
  return {
    keyHash: resolveKeyHash(params),
    workspaceId: params.workspaceId,
    userId: params.userId,
    operationKind: LEGACY_OPERATION_KIND,
    operationState: LEGACY_OPERATION_STATE_ACTIVE,
    requestDigestVersion: params.requestDigestVersion,
    requestDigest: params.requestDigest,
    reservationToken: params.reservationToken,
  };
}

export async function completeLegacyBulkSendOperation(
  params: LegacyBulkSendOperationOwnerScope & {
    responseBody: Record<string, unknown>;
    eventFacts: Record<string, unknown>;
  }
): Promise<boolean> {
  const responseBody = serializeBoundedJson(
    params.responseBody,
    BULK_SEND_IDEMPOTENCY_MAX_RESPONSE_BYTES,
    "Legacy bulk-send operation response exceeds 256 KiB"
  );
  const progressBody = serializeBoundedJson(
    params.eventFacts,
    BULK_SEND_IDEMPOTENCY_MAX_PROGRESS_BYTES,
    "Legacy bulk-send operation event facts exceed 256 KiB"
  );
  await connectDB();
  const completed = await BulkSendApiIdempotency.findOneAndUpdate(
    legacyOperationOwnerFilter(params),
    {
      $set: {
        operationState: LEGACY_OPERATION_STATE_COMPLETED,
        responseBody,
        progressBody,
        expiresAt: new Date(Date.now() + BULK_SEND_IDEMPOTENCY_TERMINAL_TTL_MS),
      },
      $unset: {
        reservationExpiresAt: "",
        reservationToken: "",
      },
    },
    { new: true }
  ).lean<{ _id?: unknown } | null>();
  return Boolean(completed);
}

export async function releaseLegacyBulkSendOperation(
  params: LegacyBulkSendOperationOwnerScope
): Promise<boolean> {
  await connectDB();
  const released = await BulkSendApiIdempotency.deleteOne(
    legacyOperationOwnerFilter(params)
  );
  return released.deletedCount === 1;
}
