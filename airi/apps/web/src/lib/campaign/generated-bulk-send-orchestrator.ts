import "server-only";

import { Types } from "mongoose";
import {
  SCENARIO_GENERATOR_MAX_GENERATED_MESSAGES,
  normalizeBulkCampaignRecipientPolicy,
  type BulkCampaignRecipientPolicy,
  type ScenarioBulkBatchPlan,
  type ScenarioBulkRootConfig,
  type ScenarioGeneratorChannel,
  type ScenarioNodeData,
} from "@icecore/scenario-contracts";
import {
  buildBulkCampaignDispatchLogicalRecipientKey,
  type BulkCampaignDispatchItem,
  type BulkCampaignDispatchLifecycleState,
} from "@icecore/temporal";

import type {
  GeneratedBulkSendChild,
  GeneratedBulkSendScenarioUpdate,
  BulkCampaignSendResponse,
} from "./bulk-campaign-contracts";
import type { BulkCampaignPolicyAdmissionMetadata } from "./bulk-campaign-admission";
import { BulkRecipientPolicyError } from "./bulk-recipient-policy";
import type {
  GeneratedBulkSendOperationBeforeCreate,
  GeneratedBulkSendOperationReservation,
} from "./bulk-send-api-idempotency";
import {
  bindGeneratedBulkSendOperationRequestDigest,
  compareAndSetGeneratedBulkSendOperationProgress,
  completeGeneratedBulkSendOperation,
  deleteGeneratedBulkSendOperationBeforeClaim,
  failGeneratedBulkSendOperation,
  generatedBulkSendPreparedProgressMatchesCompatibility,
  releaseGeneratedBulkSendOperationLease,
  renewGeneratedBulkSendOperationLease,
  reserveGeneratedBulkSendOperation,
} from "./bulk-send-api-idempotency";
import type { GeneratedChildCampaignRecoveryResult } from "./generated-campaign-ledger-recovery";
import { recoverGeneratedChildCampaignAdmission } from "./generated-campaign-ledger-recovery";
import {
  advanceGeneratedRecipientAudience,
  createGeneratedRecipientAudience,
  type GeneratedRecipientAudience,
} from "./generated-recipient-audience";
import type {
  EnsuredAdmittedPreparedBulkCampaignDispatchStart,
  NormalizedPreparedBulkCampaignQueueItems,
  PreparedBulkCampaignGeneratedProjectionExclusion,
  QueuePreparedBulkCampaignDispatchInput,
  QueuedPreparedBulkCampaignDispatch,
} from "./queue-prepared-bulk-campaign-dispatch";
import {
  createPreparedBulkCampaignContentHash,
  createStableJsonSha256 as sha256,
  serializeStableJson as stableJson,
} from "./bulk-campaign-content-hash";
import {
  ensureAdmittedPreparedBulkCampaignDispatchStarted,
  normalizePreparedBulkCampaignQueueItems,
  queuePreparedBulkCampaignDispatch,
  resolvePreparedBulkCampaignDispatchTiming,
} from "./queue-prepared-bulk-campaign-dispatch";
import type {
  PreparedGeneratedBulkCampaignResult,
  PreparedGeneratedBulkPartition,
  PreparedGeneratedWhatsAppPolicyFacts,
} from "./generated-bulk-preparation";
import {
  GeneratedBulkRecipientPolicyUnsupportedError,
  prepareGeneratedBulkCampaignPartitions,
} from "./generated-bulk-preparation";
import {
  BulkCampaignEligibilityError,
  bulkCampaignEligibilityErrorStatus,
  bulkCampaignEligibilityRetryAfterSeconds,
} from "./bulk-campaign-recipient-eligibility";
import type {
  GeneratedSendAssignedPartitionSkipResult,
  GeneratedSendOperationCoverage,
  GeneratedSendOperationRow,
  GeneratedSendPreparationRow,
  GeneratedSendPage,
  GeneratedSendPageCursor,
  GeneratedSendPartitionAssignmentResult,
  GeneratedSendQueuedOutcome,
  GeneratedSendRevisionClaimResult,
  GeneratedSendSkippedOutcome,
} from "@/lib/scenario-generator/generated-send-command";
import {
  assignGeneratedSendPartition,
  claimGeneratedSendRevision,
  commitGeneratedSendAssignedPartitionSkip,
  commitGeneratedSendPartialOutcomes,
  loadGeneratedSendOperationPage,
  loadGeneratedSendRevisionPage,
  verifyGeneratedSendOperationCoverage,
} from "@/lib/scenario-generator/generated-send-command";
import connectDB from "@/lib/mongoose";
import {
  buildCompanyLimitExceededResponse,
  COMPANY_BULK_CAMPAIGN_LIMIT_EXCEEDED_CODE,
  COMPANY_BULK_RECIPIENT_LIMIT_EXCEEDED_ERROR,
  ensureCompanyConversationCapacity,
  getBulkRecipientsRemaining,
  type CompanySubscriptionType,
} from "@/lib/limits/company-limits";
import { Scenario } from "@/models/scenario";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isTemporalConfigured } from "@/lib/temporal/client";
import { normalizeScenarioGraphForPersistence } from "@/lib/scenarios/scenario-graph-persistence";
import { hasWhatsAppQrGraphBinding } from "@/lib/whatsapp/qr-entry-points/scenario-binding";
import { logger } from "@/lib/logger";
import { scenarioHasBirthdayBulkSchedule } from "./campaign-birthday-scenario-guards";
import {
  normalizeCampaignEmail,
  normalizeCampaignPhone,
} from "./campaign-recipient-utils";
import { normalizeTelegramChatId } from "@/lib/telegram/chat-id";
import { readTrimmedString as asString } from "@icecore/shared/lib/value-utils";
import {
  createBulkCampaignTerminalReplayFactsUnavailableEvent,
  emitBulkCampaignPolicyEvent,
  parseBulkCampaignPersistedPolicyEventFacts,
  type BulkCampaignPersistedPolicyEventFacts,
  type BulkCampaignPolicyEvent,
  type BulkCampaignTerminalReplayFactsUnavailableEvent,
} from "./bulk-campaign-observability";
import {
  BulkCampaignProvenanceError,
  routeVerifiedGeneratedBulkCampaignProvenance,
  verifyGeneratedBulkCampaignProvenanceCapability,
  type VerifiedGeneratedBulkCampaignRoute,
  type VerifiedGeneratedBulkCampaignProvenanceCapability,
} from "./bulk-campaign-provenance";

const GENERATED_SEND_INTENT_DIGEST_VERSION = 2;
const GENERATED_SEND_LEGACY_INTENT_DIGEST_VERSION = 1;
const GENERATED_SEND_REQUEST_DIGEST_VERSION = 2;
const GENERATED_SEND_LEGACY_REQUEST_DIGEST_VERSION = 1;
const GENERATED_SEND_PROGRESS_VERSION = 1;
const GENERATED_SEND_PAGE_SIZE = 500;
const GENERATED_SEND_OUTCOME_PAGE_SIZE = 1_000;
const GENERATED_SEND_MAX_PARTITIONS = 300;
const GENERATED_SEND_RESPONSE_CHILD_LIMIT = 100;
const GENERATED_SEND_RESPONSE_SKIP_LIMIT = 100;

function isUnsupportedGeneratedPolicyCapability(
  error: unknown,
  policy: BulkCampaignRecipientPolicy
): boolean {
  return (
    policy.excludePriorFailedBulkSends &&
    error instanceof BulkCampaignProvenanceError &&
    [
      "approved_template_missing",
      "action_message_kind_mismatch",
      "template_identity_missing",
      "template_category_conflict",
      "whatsapp_source_missing",
    ].includes(error.reason)
  );
}

type JsonObject = Record<string, unknown>;

type LeanScenarioNode = {
  id: string;
  data?: {
    kind?: string;
    bulkRootConfig?: ScenarioBulkRootConfig | null;
    [key: string]: unknown;
  };
};

type GeneratedBulkSendScenario = {
  _id?: unknown;
  workspaceId?: string;
  name?: unknown;
  nodes?: LeanScenarioNode[];
  status?: unknown;
  updatedAt?: Date | string;
};

type GeneratedBulkSendOrchestratorInput = {
  workspaceId: string;
  scenarioId: string;
  userId: string;
  requestUrl: string;
  idempotencyKey?: string | null;
  acknowledgeMediaFailures?: boolean;
  audienceConfirmationFingerprint?: string | null;
  scheduledAt?: string | null;
};

type GeneratedBulkSendOrchestratorResult = {
  status: number;
  body: BulkCampaignSendResponse & JsonObject;
  /** Response headers, such as Retry-After for a Meta rate limit. */
  headers?: Record<string, string>;
};

type CapacityResult =
  | {
      allowed: true;
      companyBulkCampaignLimit: number | null;
      companySubscriptionType: CompanySubscriptionType;
      /** Free bulk recipients left; null or absent when unlimited. */
      bulkRecipientsRemaining?: number | null;
    }
  | {
      allowed: false;
      failure?: GeneratedBulkSendOrchestratorResult;
    };

type GeneratedSendRecoveryFact = {
  partitionKey: string;
  campaignId: string;
  channel: ScenarioGeneratorChannel;
  sourceId: string | null;
  batchPlan: ScenarioBulkBatchPlan;
  contentHash: string;
  audience: GeneratedRecipientAudience;
  requestedTotal: number;
  skippedOptIn: number;
  policyFacts?: {
    authoritativeRecipientLimit: NonNullable<
      PreparedGeneratedBulkPartition["authoritativeRecipientLimit"]
    >;
    outcome: NonNullable<PreparedGeneratedBulkPartition["policyOutcome"]>;
  };
};

type GeneratedSendProgress = {
  version: typeof GENERATED_SEND_PROGRESS_VERSION;
  phase: "prepared";
  preparationDigestVersion: number;
  preparationDigest: string;
  recoveryFacts: GeneratedSendRecoveryFact[];
  admittedChildrenCount: number;
  queuedCount: number;
  skippedCount: number;
  lastPartitionKey: string | null;
  recipientPolicy?: BulkCampaignRecipientPolicy;
  whatsappPolicyFacts?: PreparedGeneratedWhatsAppPolicyFacts;
};

type GeneratedSendClaimingProgress = {
  version: typeof GENERATED_SEND_PROGRESS_VERSION;
  phase: "claiming";
  audienceRevision: string;
};

type ScenarioRevisionUpdateResult = {
  updated: boolean;
  scenarioUpdatedAt: string;
  // The stored status after the update; a builder birthday draft keeps its own.
  scenarioStatus?: string;
};

export type GeneratedBulkSendOrchestratorDependencies = {
  now(): Date;
  connectDB(): Promise<unknown>;
  fingerprintSecret(): string | null | undefined;
  isTemporalConfigured(): boolean;
  ensureConversationCapacity(workspaceId: string): Promise<CapacityResult>;
  findScenario(params: {
    workspaceId: string;
    scenarioId: string;
  }): Promise<GeneratedBulkSendScenario | null>;
  reserveOperation(params: {
    workspaceId: string;
    scenarioId: string;
    initiatingUserId: string;
    idempotencyKey?: string | null;
    audienceRevision: string;
    intentDigestVersion: number;
    intentDigest: string;
    legacyIntentDigestVersion: 1;
    legacyIntentDigest: string;
    recipientPolicy: BulkCampaignRecipientPolicy;
    scheduledAt?: string | null;
    beforeCreate?: GeneratedBulkSendOperationBeforeCreate;
  }): Promise<GeneratedBulkSendOperationReservation>;
  deleteOperationBeforeClaim(params: {
    workspaceId: string;
    scenarioId: string;
    operationId: string;
    reservationToken: string;
  }): Promise<boolean>;
  renewOperationLease(params: {
    workspaceId: string;
    scenarioId: string;
    operationId: string;
    reservationToken: string;
  }): Promise<boolean>;
  releaseOperationLease?(params: {
    workspaceId: string;
    scenarioId: string;
    operationId: string;
    reservationToken: string;
  }): Promise<boolean>;
  bindRequestDigest(params: {
    workspaceId: string;
    scenarioId: string;
    operationId: string;
    reservationToken: string;
    requestDigestVersion: number;
    requestDigest: string;
  }): Promise<
    | { status: "bound" }
    | { status: "matched" }
    | { status: "payload_mismatch" }
    | { status: "stale_owner" }
  >;
  compareAndSetProgress(params: {
    workspaceId: string;
    scenarioId: string;
    operationId: string;
    reservationToken: string;
    expectedProgressVersion: number;
    progressBody: JsonObject;
  }): Promise<{ progressVersion: number } | null>;
  completeOperation(params: {
    workspaceId: string;
    scenarioId: string;
    operationId: string;
    reservationToken: string;
    responseBody: JsonObject;
  }): Promise<boolean>;
  failOperation(params: {
    workspaceId: string;
    scenarioId: string;
    operationId: string;
    reservationToken: string;
    responseStatus: number;
    responseBody: JsonObject;
  }): Promise<boolean>;
  claimRevision(params: {
    workspaceId: string;
    scenarioId: string;
    audienceRevision: string;
    operationId: string;
  }): Promise<GeneratedSendRevisionClaimResult>;
  loadOperationPage(params: {
    workspaceId: string;
    scenarioId: string;
    audienceRevision: string;
    operationId: string;
    after?: GeneratedSendPageCursor;
    pageSize: number;
  }): Promise<GeneratedSendPage<GeneratedSendOperationRow>>;
  loadRevisionPage(params: {
    workspaceId: string;
    scenarioId: string;
    audienceRevision: string;
    after?: GeneratedSendPageCursor;
    pageSize: number;
  }): Promise<GeneratedSendPage<GeneratedSendPreparationRow>>;
  verifyGeneratedProvenanceCapability(params: {
    workspaceId: string;
    scenarioId: string;
    rootNodeId: string;
    audienceRevision: string;
  }): Promise<VerifiedGeneratedBulkCampaignProvenanceCapability>;
  routeGeneratedProvenance(
    capability: VerifiedGeneratedBulkCampaignProvenanceCapability,
    messages: readonly GeneratedSendPreparationRow[]
  ): Promise<{
    routes: readonly VerifiedGeneratedBulkCampaignRoute[];
    supportsWhatsAppTemplate: boolean;
    recipientPolicy: BulkCampaignRecipientPolicy;
  }>;
  prepare(params: {
    workspaceId: string;
    scenarioId: string;
    sentByUserId: string;
    operationId: string;
    campaignName: string;
    requestUrl: string;
    messages: Array<GeneratedSendOperationRow | GeneratedSendPreparationRow>;
    nodes: LeanScenarioNode[];
    fallbackSourceIds: string[];
    recipientPolicy: BulkCampaignRecipientPolicy;
    verifiedRoutes?: readonly VerifiedGeneratedBulkCampaignRoute[];
    verifiedWhatsAppTemplateCapability?: boolean;
    digestMode: "current_v3" | "legacy_v2_disabled";
  }): Promise<PreparedGeneratedBulkCampaignResult>;
  normalizeQueueItems(
    input: Pick<
      QueuePreparedBulkCampaignDispatchInput,
      | "campaignId"
      | "channel"
      | "fingerprintSecret"
      | "items"
      | "retryKind"
      | "sentBy"
      | "workspaceId"
    >
  ): NormalizedPreparedBulkCampaignQueueItems;
  createContentHash(
    snapshots: Array<{
      recipientHash: string;
      dispatchSnapshot: Record<string, unknown>;
    }>
  ): string;
  assignPartition(params: {
    workspaceId: string;
    scenarioId: string;
    audienceRevision: string;
    operationId: string;
    messageIds: readonly string[];
    partitionKey: string;
  }): Promise<GeneratedSendPartitionAssignmentResult>;
  commitOutcomes(params: {
    workspaceId: string;
    scenarioId: string;
    audienceRevision: string;
    operationId: string;
    messageIds: readonly string[];
    queuedByMessageId: Record<string, GeneratedSendQueuedOutcome>;
    skippedByMessageId: Record<string, GeneratedSendSkippedOutcome>;
  }): Promise<{ committed: boolean } & JsonObject>;
  commitAssignedSkips(params: {
    workspaceId: string;
    scenarioId: string;
    audienceRevision: string;
    operationId: string;
    campaignId: string;
    partitionKey: string;
    messageIds: readonly string[];
    reason: string;
    detail?: string | null;
  }): Promise<GeneratedSendAssignedPartitionSkipResult>;
  recoverChild(params: {
    workspaceId: string;
    scenarioId: string;
    scenarioNodeId: string;
    parentOperationId: string;
    partitionKey: string;
    campaignId: string;
    channel: ScenarioGeneratorChannel;
    assignedAudience: GeneratedRecipientAudience;
    expectedContentHash?: string;
    expectedPolicyMetadata: BulkCampaignPolicyAdmissionMetadata | null;
  }): Promise<GeneratedChildCampaignRecoveryResult>;
  ensureRecoveredChildStarted(params: {
    workspaceId: string;
    campaignId: string;
    dispatchStatus: BulkCampaignDispatchLifecycleState;
    requestedAt: string;
    scheduledAt: string | null;
    dispatchExpiresAt: string;
    batchPlan: ScenarioBulkBatchPlan;
    items: BulkCampaignDispatchItem[];
  }): Promise<EnsuredAdmittedPreparedBulkCampaignDispatchStart>;
  queueChild(
    input: Omit<QueuePreparedBulkCampaignDispatchInput, "storeClient">
  ): Promise<QueuedPreparedBulkCampaignDispatch>;
  verifyCoverage(params: {
    workspaceId: string;
    scenarioId: string;
    audienceRevision: string;
    operationId: string;
    expectedAudience: GeneratedRecipientAudience;
    pageSize: number;
  }): Promise<GeneratedSendOperationCoverage>;
  updateScenarioRevision(params: {
    workspaceId: string;
    scenarioId: string;
    nodeId: string;
    audienceRevision: string;
    operationId: string;
    updatedBy: string;
    patch: GeneratedBulkSendScenarioUpdate["bulkRootConfigPatch"];
    scenarioStatus: string;
    scenarioUpdatedAt?: string;
  }): Promise<ScenarioRevisionUpdateResult>;
  emitPolicyEvent(
    event:
      | BulkCampaignPolicyEvent
      | BulkCampaignTerminalReplayFactsUnavailableEvent
  ): void;
};

type OperationOwner = {
  workspaceId: string;
  scenarioId: string;
  operationId: string;
  reservationToken: string;
};

type NormalizedPartition = {
  partition: PreparedGeneratedBulkPartition;
  items: BulkCampaignDispatchItem[];
  messageIds: string[];
  excluded: PreparedBulkCampaignGeneratedProjectionExclusion[];
  fact: GeneratedSendRecoveryFact;
};

function normalizeSourceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(asString).filter(Boolean))).slice(0, 100);
}

function boundedGeneratedRecipientCount(value: unknown): number | null {
  return Number.isSafeInteger(value) &&
    Number(value) >= 1 &&
    Number(value) <= SCENARIO_GENERATOR_MAX_GENERATED_MESSAGES
    ? Number(value)
    : null;
}

function response(
  operationDisposition: NonNullable<
    BulkCampaignSendResponse["operationDisposition"]
  >,
  status: number,
  body: BulkCampaignSendResponse & JsonObject
): GeneratedBulkSendOrchestratorResult {
  return {
    status,
    body: {
      ...body,
      operationDisposition,
    },
  };
}

function capacityFailure(
  result: Exclude<CapacityResult, { allowed: true }>,
  fallback: { code: string; error: string }
): GeneratedBulkSendOrchestratorResult {
  return result.failure
    ? {
        ...result.failure,
        body: {
          ...result.failure.body,
          operationDisposition: "in_progress",
        },
      }
    : response("in_progress", 402, fallback);
}

/** Unique recipients the partitions would admit, counted as admission does. */
function countPartitionRecipients(
  partitions: readonly { items: readonly BulkCampaignDispatchItem[] }[]
): number {
  return partitions.reduce(
    (total, partition) =>
      total +
      new Set(
        partition.items.flatMap(item => {
          const key = buildBulkCampaignDispatchLogicalRecipientKey(item);
          return key ? [key] : [];
        })
      ).size,
    0
  );
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function audienceForIds(
  messageIds: readonly string[]
): GeneratedRecipientAudience {
  let audience = createGeneratedRecipientAudience();
  for (const page of chunks(messageIds, GENERATED_SEND_OUTCOME_PAGE_SIZE)) {
    audience = advanceGeneratedRecipientAudience(audience, page);
  }
  return audience;
}

function operationRowAudience(
  rows: readonly GeneratedSendOperationRow[]
): GeneratedRecipientAudience {
  return audienceForIds(rows.map(row => row._id));
}

function preparationRowSemantics(
  rows: readonly (GeneratedSendOperationRow | GeneratedSendPreparationRow)[]
): string {
  return stableJson(
    rows.map(row => ({
      id: asString(row._id),
      nodeId: asString(row.nodeId),
      branchId: asString(row.branchId) || null,
      channel: row.channel,
      recipient: row.recipient,
      recipientEmail: row.recipientEmail ?? null,
      recipientName: row.recipientName ?? null,
      sourceId: row.sourceId ?? null,
      text: row.text,
      mediaAssetIds: Array.isArray(row.mediaAssetIds)
        ? [...row.mediaAssetIds]
        : [],
    }))
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function normalizeBatchPlan(value: unknown): ScenarioBulkBatchPlan {
  const plan = value as Partial<ScenarioBulkBatchPlan> | null;
  if (
    !plan ||
    !Number.isFinite(plan.batchSize) ||
    !Number.isFinite(plan.delayMs) ||
    !Number.isFinite(plan.ratePerSecond) ||
    typeof plan.rateSource !== "string"
  ) {
    throw new Error("Generated send recovery batch plan is malformed");
  }
  return {
    batchSize: Math.max(1, Math.trunc(plan.batchSize!)),
    delayMs: Math.max(0, Math.trunc(plan.delayMs!)),
    ratePerSecond: Math.max(0.001, plan.ratePerSecond!),
    rateSource: plan.rateSource.trim(),
    ...(typeof plan.throughputLevel === "string" ||
    plan.throughputLevel === null
      ? { throughputLevel: plan.throughputLevel }
      : {}),
  };
}

function parseProgress(
  value: unknown
): GeneratedSendProgress | GeneratedSendClaimingProgress | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object") {
    throw new Error("Generated send operation progress is malformed");
  }
  const record = value as JsonObject;
  if (
    record.version === GENERATED_SEND_PROGRESS_VERSION &&
    record.phase === "claiming" &&
    asString(record.audienceRevision)
  ) {
    return {
      version: GENERATED_SEND_PROGRESS_VERSION,
      phase: "claiming",
      audienceRevision: asString(record.audienceRevision),
    };
  }
  if (
    record.version !== GENERATED_SEND_PROGRESS_VERSION ||
    record.phase !== "prepared" ||
    !Number.isSafeInteger(record.preparationDigestVersion) ||
    !isSha256(record.preparationDigest) ||
    !Array.isArray(record.recoveryFacts) ||
    record.recoveryFacts.length > GENERATED_SEND_MAX_PARTITIONS ||
    !Number.isSafeInteger(record.admittedChildrenCount) ||
    !Number.isSafeInteger(record.queuedCount) ||
    !Number.isSafeInteger(record.skippedCount)
  ) {
    throw new Error("Generated send operation progress is malformed");
  }
  const recoveryFacts = record.recoveryFacts.map(value => {
    if (!value || typeof value !== "object") {
      throw new Error("Generated send recovery fact is malformed");
    }
    const fact = value as JsonObject;
    const partitionKey = asString(fact.partitionKey);
    const campaignId = asString(fact.campaignId);
    const channel = asString(fact.channel) as ScenarioGeneratorChannel;
    const sourceId = fact.sourceId === null ? null : asString(fact.sourceId);
    const audience = fact.audience as GeneratedRecipientAudience;
    if (
      !partitionKey ||
      !campaignId ||
      !["whatsapp", "telegram", "email"].includes(channel) ||
      !isSha256(fact.contentHash) ||
      !audience ||
      audience.version !== 1 ||
      !Number.isSafeInteger(audience.count) ||
      audience.count < 1 ||
      !isSha256(audience.digest) ||
      !Number.isSafeInteger(fact.requestedTotal) ||
      !Number.isSafeInteger(fact.skippedOptIn)
    ) {
      throw new Error("Generated send recovery fact is malformed");
    }
    return {
      partitionKey,
      campaignId,
      channel,
      sourceId,
      batchPlan: normalizeBatchPlan(fact.batchPlan),
      contentHash: fact.contentHash,
      audience,
      requestedTotal: fact.requestedTotal,
      skippedOptIn: fact.skippedOptIn,
      ...(fact.policyFacts && typeof fact.policyFacts === "object"
        ? {
            policyFacts:
              fact.policyFacts as GeneratedSendRecoveryFact["policyFacts"],
          }
        : {}),
    } as GeneratedSendRecoveryFact;
  });
  if (
    new Set(recoveryFacts.map(fact => fact.partitionKey)).size !==
      recoveryFacts.length ||
    new Set(recoveryFacts.map(fact => fact.campaignId)).size !==
      recoveryFacts.length
  ) {
    throw new Error("Generated send recovery facts are ambiguous");
  }
  return {
    version: GENERATED_SEND_PROGRESS_VERSION,
    phase: "prepared",
    preparationDigestVersion: record.preparationDigestVersion as number,
    preparationDigest: record.preparationDigest as string,
    recoveryFacts,
    admittedChildrenCount: record.admittedChildrenCount as number,
    queuedCount: record.queuedCount as number,
    skippedCount: record.skippedCount as number,
    lastPartitionKey:
      record.lastPartitionKey === null
        ? null
        : asString(record.lastPartitionKey),
    ...(record.recipientPolicy
      ? {
          recipientPolicy: normalizeBulkCampaignRecipientPolicy(
            record.recipientPolicy
          ),
        }
      : {}),
    ...(record.whatsappPolicyFacts &&
    typeof record.whatsappPolicyFacts === "object"
      ? {
          whatsappPolicyFacts:
            record.whatsappPolicyFacts as PreparedGeneratedWhatsAppPolicyFacts,
        }
      : {}),
  };
}

function progressBody(progress: GeneratedSendProgress): JsonObject {
  return progress as unknown as JsonObject;
}

function findRoot(
  scenario: GeneratedBulkSendScenario
): LeanScenarioNode | null {
  return (
    (Array.isArray(scenario.nodes) ? scenario.nodes : []).find(
      node => node?.data?.kind === "bulk"
    ) ?? null
  );
}

function hasPersistedWhatsAppQrGraphBinding(
  nodes: GeneratedBulkSendScenario["nodes"]
): boolean {
  return hasWhatsAppQrGraphBinding(
    (Array.isArray(nodes) ? nodes : []).flatMap(node =>
      node?.data
        ? [
            {
              id: node.id,
              data: node.data as ScenarioNodeData,
            },
          ]
        : []
    )
  );
}

function generatedRevisionAlreadyCompleted(
  config: ScenarioBulkRootConfig,
  audienceRevision: string
): boolean {
  const state = config.generatedSendState;
  return state?.revision === audienceRevision && state.state === "completed";
}

function queueError(value: unknown): {
  httpStatus: number;
  body: JsonObject & {
    code?: string;
    error?: string;
    retryable?: boolean;
  };
} | null {
  if (
    value instanceof BulkRecipientPolicyError &&
    value.code === "invalid_recipient_identity"
  ) {
    return {
      httpStatus: 400,
      body: {
        code: value.code,
        error: value.message,
        retryable: false,
      },
    };
  }
  if (!value || typeof value !== "object") return null;
  const error = value as {
    httpStatus?: unknown;
    body?: unknown;
  };
  if (
    typeof error.httpStatus !== "number" ||
    !error.body ||
    typeof error.body !== "object"
  ) {
    return null;
  }
  return {
    httpStatus: error.httpStatus,
    body: error.body as JsonObject,
  };
}

/**
 * A coded failure from preparing the send, such as a template lookup Meta
 * rate limited (with when to try again) or one that is unavailable. The
 * generic retryable failure would hide both the code and the retry time.
 */
function eligibilityFailure(
  operationDisposition: NonNullable<
    BulkCampaignSendResponse["operationDisposition"]
  >,
  error: unknown
): GeneratedBulkSendOrchestratorResult | null {
  if (!(error instanceof BulkCampaignEligibilityError)) return null;
  const status = bulkCampaignEligibilityErrorStatus(error.code);
  const retryAfterSeconds = bulkCampaignEligibilityRetryAfterSeconds(error);
  return {
    ...response(operationDisposition, status, {
      code: error.code,
      error: error.message,
      retryable: status >= 500,
      ...(retryAfterSeconds === null ? {} : { retryAfterSeconds }),
    }),
    ...(retryAfterSeconds === null
      ? {}
      : { headers: { "Retry-After": String(retryAfterSeconds) } }),
  };
}

function topLevelQueueErrorFields(body: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const key of [
    "code",
    "error",
    "retryable",
    "audience",
    "audienceConfirmation",
    "providerCircuit",
  ]) {
    if (body[key] !== undefined) result[key] = body[key];
  }
  return result;
}

function childFromQueued(
  partition: PreparedGeneratedBulkPartition,
  queued: QueuedPreparedBulkCampaignDispatch
): GeneratedBulkSendChild {
  return {
    partitionKey: partition.partitionKey,
    channel: partition.channel,
    sourceId: partition.sourceId,
    campaignId: queued.campaignId,
    dispatchId: queued.dispatchId,
    workflowId: queued.workflowId,
    status: queued.status,
    total: queued.total,
    skippedRecipientCount: Math.max(0, partition.requestedTotal - queued.total),
    batchPlan: partition.batchPlan,
    temporalDispatchStaging: queued.temporalDispatchStaging,
    audience: queued.audience,
    audienceConfirmation: queued.audienceConfirmation,
  };
}

function childFromRecovery(params: {
  partitionKey: string;
  fact: GeneratedSendRecoveryFact;
  recovery: Extract<
    GeneratedChildCampaignRecoveryResult,
    { status: "admitted" }
  >;
}): GeneratedBulkSendChild {
  const campaign = params.recovery.campaign;
  return {
    partitionKey: params.partitionKey,
    channel: campaign.channel,
    sourceId: params.fact.sourceId,
    campaignId: campaign.campaignId,
    dispatchId: campaign.campaignId,
    workflowId: campaign.workflowId,
    status: campaign.dispatchStatus,
    total: params.recovery.admittedAudience.count,
    skippedRecipientCount: Math.max(
      0,
      params.fact.requestedTotal - params.recovery.admittedAudience.count
    ),
    batchPlan: params.fact.batchPlan,
    temporalDispatchStaging: "existing",
    audience: {
      fingerprint: campaign.audience.fingerprint,
      requestedTotal: params.fact.requestedTotal,
      queuedTotal: params.recovery.admittedAudience.count,
      skippedOptIn: params.fact.skippedOptIn,
    },
    audienceConfirmation: {
      required: false,
      confirmed: false,
      fingerprint: campaign.audience.fingerprint,
    },
  };
}

function recoveryFactMatches(
  left: GeneratedSendRecoveryFact,
  right: GeneratedSendRecoveryFact
): boolean {
  return stableJson(left) === stableJson(right);
}

function assertBoundedRecoveryFacts(facts: GeneratedSendRecoveryFact[]): void {
  if (
    facts.length > GENERATED_SEND_MAX_PARTITIONS ||
    Buffer.byteLength(JSON.stringify(facts), "utf8") > 192 * 1024
  ) {
    throw new Error("Generated send partition recovery facts exceed bounds");
  }
}

function createRequestDigest(params: {
  version: 1 | 2;
  scenarioId: string;
  audienceRevision: string;
  audience: GeneratedRecipientAudience;
  scheduledAt: string | null;
  preparationDigestVersion: number;
  preparationDigest: string;
  recoveryFacts: GeneratedSendRecoveryFact[];
  recipientPolicy: BulkCampaignRecipientPolicy;
  whatsappPolicyFacts?: PreparedGeneratedWhatsAppPolicyFacts;
}): string {
  return sha256({
    version: params.version,
    scenarioId: params.scenarioId,
    audienceRevision: params.audienceRevision,
    audience: params.audience,
    scheduledAt: params.scheduledAt,
    preparationDigestVersion: params.preparationDigestVersion,
    preparationDigest: params.preparationDigest,
    recoveryFacts: params.recoveryFacts,
    ...(params.version === GENERATED_SEND_REQUEST_DIGEST_VERSION
      ? {
          recipientPolicy: params.recipientPolicy,
          whatsappPolicyFacts: params.whatsappPolicyFacts ?? null,
        }
      : {}),
  });
}

function createIntentDigest(params: {
  version: 1 | 2;
  scenarioId: string;
  audienceRevision: string;
  recipientPolicy: BulkCampaignRecipientPolicy;
}): string {
  return sha256({
    version: params.version,
    scenarioId: params.scenarioId,
    audienceRevision: params.audienceRevision,
    sendMode: "immediate",
    ...(params.version === GENERATED_SEND_INTENT_DIGEST_VERSION
      ? { recipientPolicy: params.recipientPolicy }
      : {}),
  });
}

async function loadOperationRows(params: {
  deps: GeneratedBulkSendOrchestratorDependencies;
  scope: {
    workspaceId: string;
    scenarioId: string;
    audienceRevision: string;
    operationId: string;
  };
  expectedCount: number;
}): Promise<GeneratedSendOperationRow[]> {
  const rows: GeneratedSendOperationRow[] = [];
  let cursor: GeneratedSendPageCursor | undefined;
  for (;;) {
    const page = await params.deps.loadOperationPage({
      ...params.scope,
      ...(cursor ? { after: cursor } : {}),
      pageSize: GENERATED_SEND_PAGE_SIZE,
    });
    rows.push(...page.rows);
    if (
      rows.length > params.expectedCount ||
      rows.length > SCENARIO_GENERATOR_MAX_GENERATED_MESSAGES
    ) {
      throw new Error("Generated send operation audience exceeds its revision");
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  if (rows.length !== params.expectedCount) {
    throw new Error("Generated send operation audience is incomplete");
  }
  return rows;
}

async function loadRevisionRows(params: {
  deps: Pick<GeneratedBulkSendOrchestratorDependencies, "loadRevisionPage">;
  scope: {
    workspaceId: string;
    scenarioId: string;
    audienceRevision: string;
  };
}): Promise<GeneratedSendPreparationRow[]> {
  const rows: GeneratedSendPreparationRow[] = [];
  let cursor: GeneratedSendPageCursor | undefined;
  for (;;) {
    const page = await params.deps.loadRevisionPage({
      ...params.scope,
      ...(cursor ? { after: cursor } : {}),
      pageSize: GENERATED_SEND_PAGE_SIZE,
    });
    rows.push(...page.rows);
    if (rows.length > SCENARIO_GENERATOR_MAX_GENERATED_MESSAGES) {
      throw new Error("Generated send revision audience exceeds its cap");
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return rows;
}

async function commitSkippedPages(params: {
  deps: GeneratedBulkSendOrchestratorDependencies;
  scope: {
    workspaceId: string;
    scenarioId: string;
    audienceRevision: string;
    operationId: string;
  };
  skippedByMessageId: Record<string, GeneratedSendSkippedOutcome>;
}): Promise<void> {
  const entries = Object.entries(params.skippedByMessageId);
  for (const page of chunks(entries, GENERATED_SEND_OUTCOME_PAGE_SIZE)) {
    const skippedByMessageId = Object.fromEntries(page);
    const committed = await params.deps.commitOutcomes({
      ...params.scope,
      messageIds: page.map(([messageId]) => messageId),
      queuedByMessageId: {},
      skippedByMessageId,
    });
    if (!committed.committed) {
      throw new Error("Generated send skipped outcomes were not committed");
    }
  }
}

async function commitQueuedPages(params: {
  deps: GeneratedBulkSendOrchestratorDependencies;
  scope: {
    workspaceId: string;
    scenarioId: string;
    audienceRevision: string;
    operationId: string;
  };
  messageIds: string[];
  campaignId: string;
  partitionKey: string;
}): Promise<void> {
  for (const page of chunks(
    params.messageIds,
    GENERATED_SEND_OUTCOME_PAGE_SIZE
  )) {
    const queuedByMessageId = Object.fromEntries(
      page.map(messageId => [
        messageId,
        {
          campaignId: params.campaignId,
          partitionKey: params.partitionKey,
        },
      ])
    );
    const committed = await params.deps.commitOutcomes({
      ...params.scope,
      messageIds: page,
      queuedByMessageId,
      skippedByMessageId: {},
    });
    if (!committed.committed) {
      throw new Error("Generated send queued outcomes were not committed");
    }
  }
}

function assignedGroups(rows: GeneratedSendOperationRow[]) {
  const groups = new Map<
    string,
    {
      campaignId: string;
      partitionKey: string;
      rows: GeneratedSendOperationRow[];
    }
  >();
  for (const row of rows) {
    if (!row.campaignId && !row.sendPartitionKey) continue;
    if (!row.campaignId || !row.sendPartitionKey) {
      throw new Error("Generated send persisted assignment is malformed");
    }
    const key = `${row.campaignId}\0${row.sendPartitionKey}`;
    const group = groups.get(key) ?? {
      campaignId: row.campaignId,
      partitionKey: row.sendPartitionKey,
      rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  return Array.from(groups.values()).sort((left, right) =>
    left.partitionKey.localeCompare(right.partitionKey)
  );
}

function normalizedPartitionFacts(params: {
  deps: GeneratedBulkSendOrchestratorDependencies;
  fingerprintSecret: string;
  workspaceId: string;
  userId: string;
  preparation: PreparedGeneratedBulkCampaignResult;
}): NormalizedPartition[] {
  if (params.preparation.partitions.length > GENERATED_SEND_MAX_PARTITIONS) {
    throw new Error("Generated send has too many source partitions");
  }
  return params.preparation.partitions.map(partition => {
    const normalized = params.deps.normalizeQueueItems({
      campaignId: partition.campaignId,
      channel: partition.channel,
      fingerprintSecret: params.fingerprintSecret,
      items: partition.items,
      retryKind: null,
      sentBy: params.userId,
      workspaceId: params.workspaceId,
    });
    const messageIds = normalized.queuedGeneratedRecipientMessageIds;
    if (
      normalized.items.length !== messageIds.length ||
      messageIds.length === 0 ||
      new Set(messageIds).size !== messageIds.length
    ) {
      throw new Error(
        "Generated send canonical queue normalization is incomplete"
      );
    }
    if (
      params.preparation.preparationDigestVersion === 3 &&
      normalized.excludedGeneratedRecipientMessages.length > 0
    ) {
      throw new Error(
        "Generated send policy outcome changed during queue normalization"
      );
    }
    if (
      params.preparation.preparationDigestVersion === 3 &&
      (!partition.authoritativeRecipientLimit || !partition.policyOutcome)
    ) {
      throw new Error("Generated send partition policy facts are missing");
    }
    const fact: GeneratedSendRecoveryFact = {
      partitionKey: partition.partitionKey,
      campaignId: partition.campaignId,
      channel: partition.channel,
      sourceId: partition.sourceId,
      batchPlan: normalizeBatchPlan(partition.batchPlan),
      contentHash: params.deps.createContentHash(normalized.snapshotSeeds),
      audience: audienceForIds(messageIds),
      requestedTotal: partition.requestedTotal,
      skippedOptIn: partition.skippedOptIn,
      ...(params.preparation.preparationDigestVersion === 3
        ? {
            policyFacts: {
              authoritativeRecipientLimit:
                partition.authoritativeRecipientLimit!,
              outcome: partition.policyOutcome!,
            },
          }
        : {}),
    };
    return {
      partition,
      items: normalized.items,
      messageIds,
      excluded: normalized.excludedGeneratedRecipientMessages,
      fact,
    };
  });
}

function scenarioUpdateFromCached(
  value: unknown
): GeneratedBulkSendScenarioUpdate | null {
  if (!value || typeof value !== "object") return null;
  const update = value as JsonObject;
  if (
    !asString(update.nodeId) ||
    !asString(update.scenarioUpdatedAt) ||
    !update.bulkRootConfigPatch ||
    typeof update.bulkRootConfigPatch !== "object"
  ) {
    return null;
  }
  const patch = update.bulkRootConfigPatch as JsonObject;
  if (
    !patch.sendStatus ||
    typeof patch.sendStatus !== "object" ||
    !patch.generatedSendState ||
    typeof patch.generatedSendState !== "object"
  ) {
    return null;
  }
  return update as unknown as GeneratedBulkSendScenarioUpdate;
}

function boundedSkipDetails(
  rows: readonly GeneratedSendOperationRow[],
  additional?: ReadonlyMap<string, GeneratedSendSkippedOutcome>
) {
  const byMessageId = new Map<string, GeneratedSendSkippedOutcome>();
  for (const row of rows) {
    if (row.sendStatus === "skipped" && row.skipReason) {
      byMessageId.set(row._id, {
        reason: row.skipReason,
        ...(row.skipDetail ? { detail: row.skipDetail } : {}),
      });
    }
  }
  for (const [messageId, outcome] of additional ?? []) {
    if (!byMessageId.has(messageId)) byMessageId.set(messageId, outcome);
  }
  const details = Array.from(byMessageId, ([messageId, outcome]) => ({
    messageId,
    reason: outcome.reason,
    ...(outcome.detail ? { detail: outcome.detail } : {}),
  }));
  return {
    details: details.slice(0, GENERATED_SEND_RESPONSE_SKIP_LIMIT),
    total: details.length,
    truncated: details.length > GENERATED_SEND_RESPONSE_SKIP_LIMIT,
  };
}

function groupedResponse(params: {
  scenarioId: string;
  requestedAt: string;
  scheduledAt: string | null;
  children: GeneratedBulkSendChild[];
  requestedTotal: number;
  skippedCount: number;
  skipDetails: ReturnType<typeof boundedSkipDetails>;
  scenarioUpdate?: GeneratedBulkSendScenarioUpdate;
  scenarioStatus?: string;
}): BulkCampaignSendResponse & JsonObject {
  const orderedChildren = [...params.children].sort((left, right) =>
    left.partitionKey.localeCompare(right.partitionKey)
  );
  const responseChildren = orderedChildren.slice(
    0,
    GENERATED_SEND_RESPONSE_CHILD_LIMIT
  );
  const total = orderedChildren.reduce((sum, child) => sum + child.total, 0);
  const noOp = orderedChildren.length === 0;
  const body: BulkCampaignSendResponse & JsonObject = {
    queued: !noOp,
    ...(noOp
      ? {
          noOp: true,
          message:
            "No campaign was queued because every generated recipient was skipped.",
        }
      : {}),
    scheduled: !noOp && Boolean(params.scheduledAt),
    ...(params.scheduledAt ? { scheduledAt: params.scheduledAt } : {}),
    requestedAt: params.requestedAt,
    total,
    requestedTotal: params.requestedTotal,
    skippedRecipientCount: params.skippedCount,
    children: responseChildren,
    childrenTotal: orderedChildren.length,
    childrenTruncated:
      orderedChildren.length > GENERATED_SEND_RESPONSE_CHILD_LIMIT,
    skippedRecipientDetails: params.skipDetails.details,
    skippedRecipientDetailsTotal: params.skipDetails.total,
    skippedRecipientDetailsTruncated: params.skipDetails.truncated,
    scenarioId: params.scenarioId,
    scenarioStatus: params.scenarioStatus || "active",
    ...(params.scenarioUpdate ? { scenarioUpdate: params.scenarioUpdate } : {}),
  };
  if (orderedChildren.length === 1) {
    const child = orderedChildren[0]!;
    Object.assign(body, {
      campaignId: child.campaignId,
      dispatchId: child.dispatchId,
      workflowId: child.workflowId,
      status: child.status,
      batchPlan: child.batchPlan,
      temporalDispatchStaging: child.temporalDispatchStaging,
      audience: child.audience,
      audienceConfirmation: child.audienceConfirmation,
    });
  }
  return body;
}

const GENERATED_POLICY_SKIP_REASONS = new Set([
  "ineligible",
  "marketing_opt_out",
  "recipient_limit",
  "prior_failure",
  "service_window",
  "unsubscribed",
  "recent_contact",
]);

const GENERATED_LEGACY_POLICY_SKIP_REASONS: Readonly<Record<string, string>> = {
  whatsapp_marketing_opt_out: "marketing_opt_out",
  whatsapp_recipient_limit: "recipient_limit",
  email_unsubscribed: "unsubscribed",
};

function canonicalGeneratedPolicySkipReason(reason: string): string | null {
  const normalizedReason = reason.trim();
  if (!normalizedReason || normalizedReason === "dispatch_expired") return null;
  if (GENERATED_POLICY_SKIP_REASONS.has(normalizedReason)) {
    return normalizedReason;
  }
  return GENERATED_LEGACY_POLICY_SKIP_REASONS[normalizedReason] ?? "ineligible";
}

function generatedRowRecipientIdentity(
  row: Pick<
    GeneratedSendPreparationRow,
    "channel" | "recipient" | "recipientEmail" | "sourceId"
  >
): string | null {
  if (row.channel === "whatsapp") {
    const phone = normalizeCampaignPhone(row.recipient);
    return phone ? `whatsapp:${phone}` : null;
  }
  if (row.channel === "telegram") {
    const chatId = normalizeTelegramChatId(row.recipient);
    return chatId ? `telegram:${row.sourceId ?? ""}:${chatId}` : null;
  }
  const email = normalizeCampaignEmail(row.recipientEmail || row.recipient);
  return email ? `email:${email}` : null;
}

function generatedPolicyEventFacts(params: {
  progress: GeneratedSendProgress | null;
  policy: BulkCampaignRecipientPolicy;
  rows: readonly GeneratedSendOperationRow[];
  queuedMessageIds: ReadonlySet<string>;
  policySkipReasons: ReadonlyMap<string, string>;
  scenarioId: string;
  rootNodeId: string;
  scheduledAt: string | null;
  terminalStatus?: "failed" | "expired" | "cancelled";
  errorCode?: string;
}): BulkCampaignPersistedPolicyEventFacts[] {
  if (!params.progress) return [];
  const policy = params.progress.recipientPolicy ?? params.policy;
  const channels = Array.from(new Set(params.rows.map(row => row.channel)));
  const facts: BulkCampaignPersistedPolicyEventFacts[] = [];

  for (const channel of channels) {
    const rows = params.rows.filter(row => row.channel === channel);
    const rowById = new Map(rows.map(row => [row._id, row]));
    const queuedRows = Array.from(params.queuedMessageIds).flatMap(
      messageId => {
        const row = rowById.get(messageId);
        return row ? [row] : [];
      }
    );
    const acceptedRows = rows.filter(row => {
      const reason =
        params.policySkipReasons.get(row._id) || row.skipReason || "";
      return canonicalGeneratedPolicySkipReason(reason) === null;
    });
    const requestedIdentities = new Set(
      rows.flatMap(row => {
        const identity = generatedRowRecipientIdentity(row);
        return identity ? [identity] : [];
      })
    );
    const acceptedIdentities = new Set(
      acceptedRows.flatMap(row => {
        const identity = generatedRowRecipientIdentity(row);
        return identity ? [identity] : [];
      })
    );
    const queuedIdentities = new Set(
      queuedRows.flatMap(row => {
        const identity = generatedRowRecipientIdentity(row);
        return identity ? [identity] : [];
      })
    );
    const partitionFacts = params.progress.recoveryFacts.filter(
      fact => fact.channel === channel && fact.policyFacts
    );
    const skippedByReason: Record<string, number> = {};
    for (const row of rows) {
      const reason =
        params.policySkipReasons.get(row._id) || row.skipReason || "";
      const canonicalReason = canonicalGeneratedPolicySkipReason(reason);
      if (canonicalReason) {
        skippedByReason[canonicalReason] =
          (skippedByReason[canonicalReason] || 0) + 1;
      }
    }
    let requestedTotal = rows.length;
    let acceptedTotal = acceptedRows.length;
    let uniqueRequested = requestedIdentities.size;
    let uniqueAccepted = acceptedIdentities.size;
    let warnings = partitionFacts.reduce(
      (total, fact) =>
        total +
        (fact.policyFacts?.outcome.warnings.missingMarketingConsent || 0),
      0
    );
    let plan:
      | NonNullable<
          PreparedGeneratedBulkPartition["authoritativeRecipientLimit"]
        >
      | undefined = partitionFacts
      .map(fact => fact.policyFacts!.authoritativeRecipientLimit)
      .sort((left, right) => left.value - right.value)[0];

    if (channel === "whatsapp" && params.progress.whatsappPolicyFacts) {
      const global = params.progress.whatsappPolicyFacts;
      requestedTotal = global.outcome.requestedTotal;
      acceptedTotal = global.outcome.acceptedTotal;
      uniqueRequested = global.outcome.uniqueRecipients.requested;
      uniqueAccepted = global.outcome.uniqueRecipients.accepted;
      warnings = global.outcome.warnings.missingMarketingConsent;
      plan = global.authoritativeRecipientLimit;
      for (const key of Object.keys(skippedByReason))
        delete skippedByReason[key];
      Object.assign(skippedByReason, global.outcome.skippedByReason);
    }

    const queuedTotal = queuedRows.length;
    const terminal = params.terminalStatus;
    const noOp = acceptedTotal === 0;
    facts.push({
      channel,
      messageKind:
        channel === "whatsapp"
          ? "template"
          : channel === "telegram"
            ? "telegram"
            : "email",
      executionSource: "scenario_run_now",
      scenarioId: params.scenarioId,
      rootNodeId: params.rootNodeId,
      itemCounts: {
        requested: requestedTotal,
        accepted: acceptedTotal,
        queued: queuedTotal,
      },
      uniqueRecipientCounts: {
        requested: uniqueRequested,
        accepted: uniqueAccepted,
        queued: queuedIdentities.size,
      },
      skippedByReason,
      warnings: { missingMarketingConsent: warnings },
      disposition: terminal
        ? terminal === "failed"
          ? "failed"
          : "blocked"
        : params.errorCode
          ? "failed"
          : noOp
            ? "no_op"
            : params.scheduledAt
              ? "scheduled"
              : "queued",
      lifecycleStatus: terminal
        ? terminal
        : params.errorCode
          ? "failed"
          : noOp
            ? "completed"
            : params.scheduledAt
              ? "scheduled"
              : "queued",
      planLimit: plan
        ? { source: plan.source, value: plan.value }
        : { source: "unavailable", value: null },
      policy,
      ...(params.errorCode ? { errorCode: params.errorCode } : {}),
    });
  }
  return facts;
}

function generatedPreflightFailurePolicyEventFacts(params: {
  rows: readonly GeneratedSendPreparationRow[];
  configuredChannels: readonly ScenarioGeneratorChannel[];
  policy: BulkCampaignRecipientPolicy;
  scenarioId: string;
  rootNodeId: string;
  errorCode: string;
}): BulkCampaignPersistedPolicyEventFacts[] {
  const channels = Array.from(
    new Set(
      params.rows.length > 0
        ? params.rows.map(row => row.channel)
        : params.configuredChannels
    )
  );
  return channels.map(channel => {
    const rows = params.rows.filter(row => row.channel === channel);
    const requestedIdentities = new Set(
      rows.flatMap(row => {
        const identity = generatedRowRecipientIdentity(row);
        return identity ? [identity] : [];
      })
    );
    return {
      channel,
      messageKind:
        channel === "whatsapp"
          ? "template"
          : channel === "telegram"
            ? "telegram"
            : "email",
      executionSource: "scenario_run_now",
      scenarioId: params.scenarioId,
      rootNodeId: params.rootNodeId,
      itemCounts: { requested: rows.length, accepted: 0, queued: 0 },
      uniqueRecipientCounts: {
        requested: requestedIdentities.size,
        accepted: 0,
        queued: 0,
      },
      skippedByReason: {},
      warnings: { missingMarketingConsent: 0 },
      disposition: "failed",
      lifecycleStatus: "failed",
      planLimit: { source: "unavailable", value: null },
      policy: params.policy,
      errorCode: params.errorCode,
    };
  });
}

function parseGeneratedPolicyEventFacts(
  body: JsonObject
): BulkCampaignPersistedPolicyEventFacts[] {
  const values = Array.isArray(body.policyEventFactsByChannel)
    ? body.policyEventFactsByChannel.slice(0, 3)
    : body.policyEventFacts
      ? [body.policyEventFacts]
      : [];
  if (values.length === 0) return [];
  const parsed = values.map(parseBulkCampaignPersistedPolicyEventFacts);
  return parsed.every(Boolean)
    ? (parsed as BulkCampaignPersistedPolicyEventFacts[])
    : [];
}

function persistedGeneratedPolicyEventFacts(
  facts: readonly BulkCampaignPersistedPolicyEventFacts[]
): JsonObject {
  if (facts.length === 0) return {};
  return facts.length === 1
    ? { policyEventFacts: facts[0] as unknown as JsonObject }
    : { policyEventFactsByChannel: facts as unknown as JsonObject[] };
}

function partialResponse(params: {
  base: ReturnType<typeof groupedResponse>;
  failedPartitionKey: string;
  queueError: {
    httpStatus: number;
    body: JsonObject;
  };
}): GeneratedBulkSendOrchestratorResult {
  const hasAdmittedChildren = (params.base.childrenTotal ?? 0) > 0;
  return response("in_progress", params.queueError.httpStatus, {
    ...params.base,
    queued: false,
    partial: hasAdmittedChildren,
    retryable: params.queueError.body.retryable !== false,
    failedPartitionKey: params.failedPartitionKey,
    ...topLevelQueueErrorFields(params.queueError.body),
  });
}

async function releaseHandledLease(
  deps: GeneratedBulkSendOrchestratorDependencies,
  owner: OperationOwner
): Promise<void> {
  if (!deps.releaseOperationLease) return;
  try {
    await deps.releaseOperationLease(owner);
  } catch {
    // Retaining the active operation is safer than hiding the original error.
  }
}

export function createGeneratedBulkSendOrchestrator(
  deps: GeneratedBulkSendOrchestratorDependencies
) {
  return async function executeGeneratedBulkSend(
    input: GeneratedBulkSendOrchestratorInput
  ): Promise<GeneratedBulkSendOrchestratorResult> {
    const workspaceId = asString(input.workspaceId);
    const scenarioId = asString(input.scenarioId);
    const userId = asString(input.userId);
    const requestUrl = asString(input.requestUrl);
    if (!workspaceId || !scenarioId || !userId || !requestUrl) {
      return response("not_started", 400, {
        error: "Generated bulk-send request is invalid",
      });
    }

    await deps.connectDB();
    const scenario = await deps.findScenario({ workspaceId, scenarioId });
    if (!scenario) {
      return response("not_started", 404, { error: "Scenario not found" });
    }
    const root = findRoot(scenario);
    if (!root?.data?.bulkRootConfig) {
      return response("not_started", 400, {
        error: "Only generated bulk scenarios can be sent here",
      });
    }
    if (
      asString(scenario.status) !== "active" &&
      hasPersistedWhatsAppQrGraphBinding(scenario.nodes)
    ) {
      return response("not_started", 409, {
        code: "whatsapp_qr_activation_requires_scenario_route",
        error:
          "Activate this Scenario before sending so its WhatsApp QR bindings can be verified.",
      });
    }
    const rootConfig = root.data.bulkRootConfig;
    let recipientPolicy: BulkCampaignRecipientPolicy;
    try {
      recipientPolicy = normalizeBulkCampaignRecipientPolicy(
        rootConfig.recipientPolicy
      );
    } catch (error) {
      return response("not_started", 409, {
        code: "generated_bulk_send_policy_invalid",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (rootConfig.sendMode !== "immediate") {
      return response("not_started", 400, {
        error: "Triggered generated scenarios must be activated, not sent",
      });
    }
    const audienceRevision = asString(rootConfig.generationJobId);
    if (!audienceRevision) {
      return response("not_started", 409, {
        code: "generated_bulk_send_revision_open",
        error:
          "The generated recipient revision is incomplete and cannot be sent safely.",
      });
    }
    const storedGeneratedRecipientCount = rootConfig.generatedRecipientCount;
    const generatedRecipientCount = boundedGeneratedRecipientCount(
      storedGeneratedRecipientCount
    );
    if (
      storedGeneratedRecipientCount !== undefined &&
      generatedRecipientCount === null
    ) {
      return response("not_started", 409, {
        code: "generated_bulk_send_revision_corrupt",
        error: "The generated recipient count is invalid.",
      });
    }
    const campaignName =
      asString(rootConfig.campaignName) ||
      asString(scenario.name) ||
      "Generated campaign";
    const loadCompleteRevisionRows = async () => {
      const revisionRows = await loadRevisionRows({
        deps,
        scope: { workspaceId, scenarioId, audienceRevision },
      });
      if (
        revisionRows.length === 0 ||
        (generatedRecipientCount !== null &&
          revisionRows.length !== generatedRecipientCount)
      ) {
        throw new Error(
          "Generated send draft revision is incomplete before claim"
        );
      }
      return revisionRows;
    };

    const intentDigest = createIntentDigest({
      version: GENERATED_SEND_INTENT_DIGEST_VERSION,
      scenarioId,
      audienceRevision,
      recipientPolicy,
    });
    const legacyIntentDigest = createIntentDigest({
      version: GENERATED_SEND_LEGACY_INTENT_DIGEST_VERSION,
      scenarioId,
      audienceRevision,
      recipientPolicy,
    });
    const scheduledAtWasProvided = Object.prototype.hasOwnProperty.call(
      input,
      "scheduledAt"
    );
    let preflightPreparation: PreparedGeneratedBulkCampaignResult | null = null;
    let preflightRows: GeneratedSendPreparationRow[] | null = null;
    let preflightVerifiedRoutes:
      | readonly VerifiedGeneratedBulkCampaignRoute[]
      | null = null;
    let preflightSupportsWhatsAppTemplate: boolean | null = null;
    let preflightOperationId: string | null = null;
    let fingerprintSecret: string | null = null;
    let temporalConfigured: boolean | null = null;
    let generatedProvenanceCapability: VerifiedGeneratedBulkCampaignProvenanceCapability | null =
      null;
    let preflightConversationCapacity: Extract<
      CapacityResult,
      { allowed: true }
    > | null = null;
    let beforeCreateFailure: GeneratedBulkSendOrchestratorResult | null = null;
    const getBeforeCreateFailure = () => beforeCreateFailure;
    const abortBeforeCreate = (
      result: GeneratedBulkSendOrchestratorResult
    ): never => {
      beforeCreateFailure = result;
      throw new Error("Generated send was rejected by read-only preflight");
    };
    const beforeCreate: GeneratedBulkSendOperationBeforeCreate =
      async candidate => {
        const generationStatus = asString(rootConfig.generationStatus);
        const mediaReady =
          generationStatus === "complete" ||
          (generationStatus === "failed" &&
            input.acknowledgeMediaFailures === true);
        if (!mediaReady) {
          abortBeforeCreate(
            response("not_started", 400, {
              error:
                generationStatus === "failed"
                  ? "Generated media failed. Explicitly acknowledge the terminal media failure before sending."
                  : "Generated media is not complete. Wait for media generation before sending.",
            })
          );
        }
        if (
          candidate.scheduledAt &&
          new Date(candidate.scheduledAt).getTime() <= deps.now().getTime()
        ) {
          abortBeforeCreate(
            response("not_started", 400, {
              error: "scheduledAt must be in the future",
            })
          );
        }
        if (generatedRevisionAlreadyCompleted(rootConfig, audienceRevision)) {
          abortBeforeCreate(
            response("not_started", 409, {
              code: "generated_revision_already_sent",
              error:
                "This generated recipient revision was already sent. Generate a new revision before sending again.",
            })
          );
        }
        generatedProvenanceCapability =
          await deps.verifyGeneratedProvenanceCapability({
            workspaceId,
            scenarioId,
            rootNodeId: root.id,
            audienceRevision,
          });
        const revisionRows = await loadCompleteRevisionRows();
        const verifiedRouting = await deps.routeGeneratedProvenance(
          generatedProvenanceCapability,
          revisionRows
        );
        if (
          stableJson(verifiedRouting.recipientPolicy) !==
          stableJson(recipientPolicy)
        ) {
          abortBeforeCreate(
            response("not_started", 503, {
              code: "generated_bulk_send_policy_changed",
              error:
                "The generated campaign recipient policy changed during read-only preflight.",
              retryable: true,
            })
          );
        }
        preflightVerifiedRoutes = verifiedRouting.routes;
        preflightSupportsWhatsAppTemplate =
          verifiedRouting.supportsWhatsAppTemplate;
        preflightRows = revisionRows;
        preflightPreparation = await deps.prepare({
          workspaceId,
          scenarioId,
          sentByUserId: candidate.initiatingUserId,
          operationId: candidate.operationId,
          campaignName,
          requestUrl,
          messages: revisionRows,
          nodes: Array.isArray(scenario.nodes) ? scenario.nodes : [],
          fallbackSourceIds: normalizeSourceIds(rootConfig.sourceIds),
          recipientPolicy,
          verifiedRoutes: preflightVerifiedRoutes,
          verifiedWhatsAppTemplateCapability: preflightSupportsWhatsAppTemplate,
          digestMode: "current_v3",
        });
        if (preflightPreparation.preparationDigestVersion !== 3) {
          throw new Error(
            "Generated send preparation digest mode does not match its operation"
          );
        }
        if (preflightPreparation.partitions.length > 0) {
          fingerprintSecret = deps.fingerprintSecret()?.trim() || null;
          if (!fingerprintSecret) {
            abortBeforeCreate(
              response("not_started", 503, {
                code: "bulk_campaign_safety_unavailable",
                error: "Bulk campaign safety is not configured.",
                retryable: true,
              })
            );
          }
          temporalConfigured = deps.isTemporalConfigured();
          if (!temporalConfigured) {
            abortBeforeCreate(
              response("not_started", 503, {
                code: "generated_bulk_send_temporal_unavailable",
                error:
                  "Generated bulk send requires Temporal, but Temporal is not configured.",
                retryable: true,
              })
            );
          }
          const capacity = await deps.ensureConversationCapacity(workspaceId);
          if (!capacity.allowed) {
            const failure = capacityFailure(capacity, {
              code: "company_conversation_limit_exceeded",
              error: "Company conversation limit exceeded.",
            });
            abortBeforeCreate({
              ...failure,
              body: { ...failure.body, operationDisposition: "not_started" },
            });
          } else {
            // Generated messages are prepared and fingerprinted per partition
            // before any is admitted, so a send larger than the free bulk
            // recipient allowance is refused rather than trimmed.
            const remaining = capacity.bulkRecipientsRemaining ?? null;
            const requested = countPartitionRecipients(
              preflightPreparation.partitions
            );
            if (remaining !== null && requested > remaining) {
              abortBeforeCreate(
                response("not_started", 402, {
                  code: COMPANY_BULK_CAMPAIGN_LIMIT_EXCEEDED_CODE,
                  error: COMPANY_BULK_RECIPIENT_LIMIT_EXCEEDED_ERROR,
                  bulkRecipientsRemaining: remaining,
                  requestedRecipients: requested,
                  retryable: false,
                })
              );
            }
            preflightConversationCapacity = capacity;
          }
        }
        preflightOperationId = candidate.operationId;
      };
    const emitPreflightFailurePolicyEvents = (errorCode: string) => {
      const configuredChannels = (
        Array.isArray(rootConfig.channels) ? rootConfig.channels : []
      ).filter(
        (channel): channel is ScenarioGeneratorChannel =>
          channel === "whatsapp" ||
          channel === "telegram" ||
          channel === "email"
      );
      for (const fact of generatedPreflightFailurePolicyEventFacts({
        rows: preflightRows ?? [],
        configuredChannels,
        policy: recipientPolicy,
        scenarioId,
        rootNodeId: root.id,
        errorCode,
      })) {
        deps.emitPolicyEvent({
          ...fact,
          workspaceId,
          idempotentReplay: false,
        });
      }
    };

    let reservation: GeneratedBulkSendOperationReservation;
    try {
      reservation = await deps.reserveOperation({
        workspaceId,
        scenarioId,
        initiatingUserId: userId,
        idempotencyKey: input.idempotencyKey,
        audienceRevision,
        intentDigestVersion: GENERATED_SEND_INTENT_DIGEST_VERSION,
        intentDigest,
        legacyIntentDigestVersion: GENERATED_SEND_LEGACY_INTENT_DIGEST_VERSION,
        legacyIntentDigest,
        recipientPolicy,
        beforeCreate,
        ...(scheduledAtWasProvided
          ? { scheduledAt: input.scheduledAt ?? null }
          : {}),
      });
    } catch (error) {
      const preflightFailure = getBeforeCreateFailure();
      if (preflightFailure) {
        emitPreflightFailurePolicyEvents(
          asString(preflightFailure.body.code) ||
            "generated_bulk_send_preflight_blocked"
        );
        return preflightFailure;
      }
      if (
        error instanceof GeneratedBulkRecipientPolicyUnsupportedError ||
        isUnsupportedGeneratedPolicyCapability(error, recipientPolicy)
      ) {
        const unsupported =
          error instanceof GeneratedBulkRecipientPolicyUnsupportedError
            ? error
            : new GeneratedBulkRecipientPolicyUnsupportedError();
        emitPreflightFailurePolicyEvents(unsupported.code);
        return response("not_started", 409, {
          code: unsupported.code,
          error: unsupported.message,
        });
      }
      const eligibilityFailed = eligibilityFailure("not_started", error);
      if (eligibilityFailed) {
        emitPreflightFailurePolicyEvents(asString(eligibilityFailed.body.code));
        return eligibilityFailed;
      }
      const caught = queueError(error);
      if (caught) {
        emitPreflightFailurePolicyEvents(
          asString(caught.body.code) || "generated_bulk_send_preflight_blocked"
        );
        return response("not_started", caught.httpStatus, caught.body);
      }
      emitPreflightFailurePolicyEvents("generated_bulk_send_retryable_failure");
      return response("not_started", 503, {
        code: "generated_bulk_send_retryable_failure",
        error:
          error instanceof Error
            ? error.message
            : "Generated bulk send failed safely.",
        retryable: true,
      });
    }

    const emitTerminalReplayPolicyFacts = (body: JsonObject) => {
      const facts = parseGeneratedPolicyEventFacts(body);
      if (facts.length === 0) {
        deps.emitPolicyEvent(
          createBulkCampaignTerminalReplayFactsUnavailableEvent({ workspaceId })
        );
        return;
      }
      for (const fact of facts) {
        deps.emitPolicyEvent({
          ...fact,
          workspaceId,
          idempotentReplay: true,
        });
      }
    };

    if (reservation.status === "failed") {
      emitTerminalReplayPolicyFacts(reservation.responseBody);
      return {
        status: reservation.responseStatus,
        body: reservation.responseBody as BulkCampaignSendResponse & JsonObject,
      };
    }
    if (reservation.status === "completed") {
      const emitCachedPolicyFacts = () =>
        emitTerminalReplayPolicyFacts(reservation.responseBody);
      const cachedReplayFailure = (
        status: number,
        body: BulkCampaignSendResponse & JsonObject
      ) => {
        emitCachedPolicyFacts();
        return response("completed", status, body);
      };
      const cachedUpdate = scenarioUpdateFromCached(
        reservation.responseBody.scenarioUpdate
      );
      if (!cachedUpdate) {
        return cachedReplayFailure(503, {
          code: "generated_bulk_send_cached_state_incomplete",
          error:
            "The completed generated send is missing its Scenario revision evidence.",
          retryable: true,
        });
      }
      const cachedRecipientCount =
        boundedGeneratedRecipientCount(
          cachedUpdate.bulkRootConfigPatch.generatedRecipientCount
        ) ??
        boundedGeneratedRecipientCount(
          reservation.responseBody.requestedTotal
        ) ??
        generatedRecipientCount;
      if (cachedRecipientCount === null) {
        return cachedReplayFailure(503, {
          code: "generated_bulk_send_cached_state_incomplete",
          error:
            "The completed generated send is missing its exact recipient count.",
          retryable: true,
        });
      }
      const cachedPatch = {
        ...cachedUpdate.bulkRootConfigPatch,
        generatedRecipientCount: cachedRecipientCount,
      };
      const marker = cachedPatch.generatedSendState;
      if (
        !marker ||
        marker.revision !== audienceRevision ||
        marker.operationId !== reservation.operationId
      ) {
        return cachedReplayFailure(503, {
          code: "generated_bulk_send_cached_state_incomplete",
          error:
            "The completed generated send is missing its exact revision marker.",
          retryable: true,
        });
      }
      const currentMarker = rootConfig.generatedSendState;
      if (currentMarker) {
        const sameOperation =
          currentMarker.revision === audienceRevision &&
          currentMarker.operationId === reservation.operationId;
        if (!sameOperation) {
          return cachedReplayFailure(409, {
            code: "generated_bulk_send_scenario_operation_conflict",
            error:
              "The Scenario revision is already owned by another generated send operation.",
          });
        }
        if (!rootConfig.sendStatus) {
          return cachedReplayFailure(503, {
            code: "generated_bulk_send_scenario_state_incomplete",
            error:
              "The Scenario revision marker exists without its current send status.",
            retryable: true,
          });
        }
        const currentUpdatedAt = new Date(scenario.updatedAt ?? 0);
        if (!Number.isFinite(currentUpdatedAt.getTime())) {
          return cachedReplayFailure(503, {
            code: "generated_bulk_send_scenario_state_incomplete",
            error:
              "The Scenario revision marker has no authoritative update time.",
            retryable: true,
          });
        }
        emitCachedPolicyFacts();
        return response("completed", 200, {
          ...reservation.responseBody,
          scenarioStatus:
            asString(scenario.status) ||
            asString(reservation.responseBody.scenarioStatus) ||
            "active",
          scenarioUpdate: {
            nodeId: root.id,
            bulkRootConfigPatch: {
              sendStatus: rootConfig.sendStatus,
              generatedSendState: currentMarker,
              generatedRecipientCount:
                generatedRecipientCount ?? cachedRecipientCount,
            },
            scenarioUpdatedAt: currentUpdatedAt.toISOString(),
          },
          idempotentReplay: true,
        });
      }
      let repaired: ScenarioRevisionUpdateResult;
      try {
        repaired = await deps.updateScenarioRevision({
          workspaceId,
          scenarioId,
          nodeId: cachedUpdate.nodeId,
          audienceRevision: marker.revision,
          operationId: marker.operationId,
          updatedBy: userId,
          patch: cachedPatch,
          scenarioStatus: "active",
          scenarioUpdatedAt: cachedUpdate.scenarioUpdatedAt,
        });
      } catch {
        return cachedReplayFailure(503, {
          code: "generated_bulk_send_scenario_repair_failed",
          error:
            "The completed generated send could not repair its Scenario revision.",
          retryable: true,
        });
      }
      if (!repaired.updated) {
        return cachedReplayFailure(503, {
          code: "generated_bulk_send_scenario_repair_failed",
          error:
            "The completed generated send could not repair its Scenario revision.",
          retryable: true,
        });
      }
      emitCachedPolicyFacts();
      return response("completed", 200, {
        ...reservation.responseBody,
        scenarioStatus: repaired.scenarioStatus || "active",
        scenarioUpdate: {
          ...cachedUpdate,
          bulkRootConfigPatch: cachedPatch,
          scenarioUpdatedAt: repaired.scenarioUpdatedAt,
        },
        idempotentReplay: true,
      });
    }
    if (reservation.status === "in_progress") {
      return response("in_progress", 409, {
        code: "generated_bulk_send_in_progress",
        error: "This generated bulk send is already being processed.",
        retryable: true,
        retryAfterMs: reservation.retryAfterMs,
        operationId: reservation.operationId,
      });
    }
    if (reservation.status === "payload_mismatch") {
      return response("not_started", 409, {
        code: "idempotency_key_payload_mismatch",
        error:
          "This idempotency key or active generated send belongs to another request.",
      });
    }
    if (reservation.status === "legacy_operation") {
      return response("in_progress", 409, {
        code: "generated_bulk_send_legacy_operation",
        error:
          "This generated send predates exact audience revisions and requires support review.",
        operationId: reservation.operationId,
      });
    }

    if (
      preflightOperationId &&
      preflightOperationId !== reservation.operationId
    ) {
      if (reservation.isNew) {
        return response("not_started", 503, {
          code: "generated_bulk_send_preflight_operation_mismatch",
          error:
            "The generated send operation changed after read-only preflight.",
          retryable: true,
        });
      }
      preflightPreparation = null;
      preflightRows = null;
      preflightVerifiedRoutes = null;
      preflightSupportsWhatsAppTemplate = null;
      preflightOperationId = null;
      preflightConversationCapacity = null;
      fingerprintSecret = null;
      temporalConfigured = null;
      generatedProvenanceCapability = null;
    }

    // The operation owns the policy snapshot once it exists. This keeps active
    // resume and expired takeover deterministic even if the Scenario root is
    // edited after an earlier child was admitted.
    recipientPolicy = reservation.recipientPolicy;

    const owner: OperationOwner = {
      workspaceId,
      scenarioId,
      operationId: reservation.operationId,
      reservationToken: reservation.reservationToken,
    };
    const scope = {
      workspaceId,
      scenarioId,
      audienceRevision,
      operationId: reservation.operationId,
    };
    let claimed = false;
    let progressVersion = reservation.progressVersion;
    let parsedProgress:
      | GeneratedSendProgress
      | GeneratedSendClaimingProgress
      | null;
    try {
      parsedProgress = parseProgress(reservation.progressBody);
    } catch (error) {
      await releaseHandledLease(deps, owner);
      return response("in_progress", 503, {
        code: "generated_bulk_send_progress_invalid",
        error: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    }
    if (parsedProgress?.phase === "prepared") {
      if (
        !generatedBulkSendPreparedProgressMatchesCompatibility(
          reservation.progressBody,
          reservation.compatibilityMode,
          recipientPolicy
        )
      ) {
        await releaseHandledLease(deps, owner);
        return response("in_progress", 503, {
          code: "generated_bulk_send_progress_invalid",
          error:
            "Generated send progress is incompatible with its explicit digest mode.",
          retryable: true,
        });
      }
    }
    if (
      parsedProgress?.phase === "claiming" &&
      parsedProgress.audienceRevision !== audienceRevision
    ) {
      await releaseHandledLease(deps, owner);
      return response("in_progress", 503, {
        code: "generated_bulk_send_progress_invalid",
        error: "Generated send claiming progress belongs to another revision.",
        retryable: true,
      });
    }
    let progress = parsedProgress?.phase === "prepared" ? parsedProgress : null;
    let ownershipIrreversible = parsedProgress !== null;
    let requestDigestBound = Boolean(reservation.requestDigest);
    let boundRequestDigest = reservation.requestDigest;
    const expectedRequestDigestVersion =
      reservation.compatibilityMode === "legacy_v1_disabled"
        ? GENERATED_SEND_LEGACY_REQUEST_DIGEST_VERSION
        : GENERATED_SEND_REQUEST_DIGEST_VERSION;
    if (
      reservation.requestDigest &&
      reservation.requestDigestVersion !== expectedRequestDigestVersion
    ) {
      await releaseHandledLease(deps, owner);
      return response("in_progress", 409, {
        code: "idempotency_key_payload_mismatch",
        error:
          "The active generated send request digest uses another explicit compatibility mode.",
      });
    }
    const expectedChildPolicyMetadata = (
      fact: GeneratedSendRecoveryFact
    ): BulkCampaignPolicyAdmissionMetadata | null => {
      if (reservation.compatibilityMode === "legacy_v1_disabled") return null;
      if (!fact.policyFacts || !boundRequestDigest) {
        throw new Error(
          "Generated child policy admission metadata is incomplete"
        );
      }
      return {
        policy: recipientPolicy,
        authoritativeRecipientLimit:
          fact.policyFacts.authoritativeRecipientLimit,
        outcome: {
          evaluatedAt: reservation.requestedAt,
          requestedTotal: fact.policyFacts.outcome.requestedTotal,
          acceptedTotal: fact.policyFacts.outcome.acceptedTotal,
          uniqueRecipients: fact.policyFacts.outcome.uniqueRecipients,
          skippedByReason: fact.policyFacts.outcome.skippedByReason,
          warnings: fact.policyFacts.outcome.warnings,
        },
        batchPlan: fact.batchPlan,
        requestDigest: { version: 1, digest: boundRequestDigest },
      };
    };

    const deletePreClaim = async () => {
      if (claimed || ownershipIrreversible || !reservation.isNew) return;
      await deps.deleteOperationBeforeClaim(owner);
    };
    const staleOwner = () =>
      response("in_progress", 409, {
        code: "generated_bulk_send_stale_owner",
        error:
          "Another worker owns this generated send. Retry after its lease expires.",
        retryable: true,
      });
    const renew = async () => deps.renewOperationLease(owner);
    const ensurePreparedRuntimeDependencies = async (
      preparation: PreparedGeneratedBulkCampaignResult,
      onUnavailable: (errorCode: string) => void
    ): Promise<GeneratedBulkSendOrchestratorResult | null> => {
      if (preparation.partitions.length === 0) return null;
      fingerprintSecret =
        fingerprintSecret ?? deps.fingerprintSecret()?.trim() ?? null;
      if (!fingerprintSecret) {
        if (ownershipIrreversible) await releaseHandledLease(deps, owner);
        else await deletePreClaim();
        onUnavailable("bulk_campaign_safety_unavailable");
        return response(
          ownershipIrreversible ? "in_progress" : "not_started",
          503,
          {
            code: "bulk_campaign_safety_unavailable",
            error: "Bulk campaign safety is not configured.",
            retryable: true,
          }
        );
      }
      temporalConfigured = temporalConfigured ?? deps.isTemporalConfigured();
      if (!temporalConfigured) {
        if (ownershipIrreversible) await releaseHandledLease(deps, owner);
        else await deletePreClaim();
        onUnavailable("generated_bulk_send_temporal_unavailable");
        return response(
          ownershipIrreversible ? "in_progress" : "not_started",
          503,
          {
            code: "generated_bulk_send_temporal_unavailable",
            error:
              "Generated bulk send requires Temporal, but Temporal is not configured.",
            retryable: true,
          }
        );
      }
      return null;
    };
    const persistProgress = async (next: GeneratedSendProgress) => {
      assertBoundedRecoveryFacts(next.recoveryFacts);
      const recorded = await deps.compareAndSetProgress({
        ...owner,
        expectedProgressVersion: progressVersion,
        progressBody: progressBody(next),
      });
      if (!recorded) return false;
      progressVersion = recorded.progressVersion;
      progress = next;
      return true;
    };
    let emitFailurePolicyEvents: ((errorCode: string) => void) | null = null;
    const emitAvailableFailurePolicyEvents = (errorCode: string) => {
      if (emitFailurePolicyEvents) emitFailurePolicyEvents(errorCode);
      else emitPreflightFailurePolicyEvents(errorCode);
    };

    try {
      if (reservation.isNew) {
        const generationStatus = asString(rootConfig.generationStatus);
        const mediaReady =
          generationStatus === "complete" ||
          (generationStatus === "failed" &&
            input.acknowledgeMediaFailures === true);
        if (!mediaReady) {
          await deletePreClaim();
          return response("not_started", 400, {
            error:
              generationStatus === "failed"
                ? "Generated media failed. Explicitly acknowledge the terminal media failure before sending."
                : "Generated media is not complete. Wait for media generation before sending.",
          });
        }
      }
      if (
        reservation.isNew &&
        reservation.scheduledAt &&
        new Date(reservation.scheduledAt).getTime() <= deps.now().getTime()
      ) {
        await deletePreClaim();
        return response("not_started", 400, {
          error: "scheduledAt must be in the future",
        });
      }
      if (
        reservation.isNew &&
        generatedRevisionAlreadyCompleted(rootConfig, audienceRevision)
      ) {
        await deletePreClaim();
        return response("not_started", 409, {
          code: "generated_revision_already_sent",
          error:
            "This generated recipient revision was already sent. Generate a new revision before sending again.",
        });
      }

      const preClaimTiming = resolvePreparedBulkCampaignDispatchTiming({
        requestedAt: reservation.requestedAt,
        scheduledAt: reservation.scheduledAt,
        now: deps.now(),
      });
      if (
        !ownershipIrreversible &&
        !preClaimTiming.expired &&
        !preflightPreparation
      ) {
        if (!(await renew())) return staleOwner();
        if (reservation.compatibilityMode === "current_v2") {
          generatedProvenanceCapability =
            await deps.verifyGeneratedProvenanceCapability({
              workspaceId,
              scenarioId,
              rootNodeId: root.id,
              audienceRevision,
            });
        }
        const revisionRows = await loadCompleteRevisionRows();
        if (generatedProvenanceCapability) {
          const verifiedRouting = await deps.routeGeneratedProvenance(
            generatedProvenanceCapability,
            revisionRows
          );
          preflightVerifiedRoutes = verifiedRouting.routes;
          preflightSupportsWhatsAppTemplate =
            verifiedRouting.supportsWhatsAppTemplate;
        }
        preflightRows = revisionRows;
        preflightPreparation = await deps.prepare({
          workspaceId,
          scenarioId,
          sentByUserId: reservation.initiatingUserId,
          operationId: reservation.operationId,
          campaignName,
          requestUrl,
          messages: revisionRows,
          nodes: Array.isArray(scenario.nodes) ? scenario.nodes : [],
          fallbackSourceIds: normalizeSourceIds(rootConfig.sourceIds),
          recipientPolicy,
          ...(preflightVerifiedRoutes
            ? {
                verifiedRoutes: preflightVerifiedRoutes,
                verifiedWhatsAppTemplateCapability:
                  preflightSupportsWhatsAppTemplate === true,
              }
            : {}),
          digestMode:
            reservation.compatibilityMode === "legacy_v1_disabled"
              ? "legacy_v2_disabled"
              : "current_v3",
        });
        const expectedPreparationVersion =
          reservation.compatibilityMode === "legacy_v1_disabled" ? 2 : 3;
        if (
          preflightPreparation.preparationDigestVersion !==
          expectedPreparationVersion
        ) {
          throw new Error(
            "Generated send preparation digest mode does not match its operation"
          );
        }
        const unavailable = await ensurePreparedRuntimeDependencies(
          preflightPreparation,
          emitAvailableFailurePolicyEvents
        );
        if (unavailable) return unavailable;
        if (!(await renew())) return staleOwner();
      }

      if (!ownershipIrreversible) {
        const marked = await deps.compareAndSetProgress({
          ...owner,
          expectedProgressVersion: progressVersion,
          progressBody: {
            version: GENERATED_SEND_PROGRESS_VERSION,
            phase: "claiming",
            audienceRevision,
          },
        });
        if (!marked) return staleOwner();
        progressVersion = marked.progressVersion;
        ownershipIrreversible = true;
      }
      const claim = await deps.claimRevision(scope);
      claimed = claim.claimedCount > 0;
      const claimedRecipientCount = boundedGeneratedRecipientCount(
        claim.revisionCount
      );
      if (
        !claim.claimed ||
        claimedRecipientCount === null ||
        claim.claimedCount !== claimedRecipientCount ||
        (generatedRecipientCount !== null &&
          claimedRecipientCount !== generatedRecipientCount)
      ) {
        await releaseHandledLease(deps, owner);
        emitAvailableFailurePolicyEvents(
          "generated_bulk_send_revision_mismatch"
        );
        return response("in_progress", 409, {
          code: "generated_bulk_send_revision_mismatch",
          error:
            "The exact generated recipient revision could not be claimed safely.",
          retryable: true,
          expectedCount: generatedRecipientCount,
          revisionCount: claim.revisionCount,
          claimedCount: claim.claimedCount,
        });
      }
      const operationRecipientCount = claimedRecipientCount;
      claimed = true;
      const rows = await loadOperationRows({
        deps,
        scope,
        expectedCount: operationRecipientCount,
      });
      let observabilityRows: readonly GeneratedSendOperationRow[] = rows;
      const queuedMessageIdsForObservability = new Set(
        rows.flatMap(row => (row.sendStatus === "queued" ? [row._id] : []))
      );
      const policySkipReasonsForObservability = new Map<string, string>();
      const effectiveSkippedOutcomes = new Map<
        string,
        GeneratedSendSkippedOutcome
      >();
      for (const row of rows) {
        if (row.sendStatus === "skipped" && row.skipReason) {
          effectiveSkippedOutcomes.set(row._id, {
            reason: row.skipReason,
            ...(row.skipDetail ? { detail: row.skipDetail } : {}),
          });
          const canonicalReason = canonicalGeneratedPolicySkipReason(
            row.skipReason
          );
          if (canonicalReason) {
            policySkipReasonsForObservability.set(row._id, canonicalReason);
          }
        }
      }
      const currentPolicyEventFacts = (options?: {
        terminalStatus?: "failed" | "expired" | "cancelled";
        errorCode?: string;
      }) =>
        generatedPolicyEventFacts({
          progress,
          policy: recipientPolicy,
          rows: observabilityRows,
          queuedMessageIds: queuedMessageIdsForObservability,
          policySkipReasons: policySkipReasonsForObservability,
          scenarioId,
          rootNodeId: root.id,
          scheduledAt: reservation.scheduledAt,
          ...options,
        });
      const emitCurrentPolicyEvents = (options?: {
        terminalStatus?: "failed" | "expired" | "cancelled";
        errorCode?: string;
      }) => {
        const facts = currentPolicyEventFacts(options);
        for (const fact of facts) {
          deps.emitPolicyEvent({
            ...fact,
            workspaceId,
            idempotentReplay: false,
          });
        }
        return facts;
      };
      emitFailurePolicyEvents = errorCode => {
        emitCurrentPolicyEvents({ errorCode });
      };
      if (
        preflightRows &&
        preparationRowSemantics(preflightRows) !== preparationRowSemantics(rows)
      ) {
        throw new Error(
          "Generated send revision changed after read-only preflight"
        );
      }
      const expectedAudience = operationRowAudience(rows);
      const childrenByPartition = new Map<string, GeneratedBulkSendChild>();
      const factsByPartition = new Map(
        (progress?.recoveryFacts ?? []).map(fact => [fact.partitionKey, fact])
      );
      const currentGroupedBase = () =>
        groupedResponse({
          scenarioId,
          requestedAt: reservation.requestedAt,
          scheduledAt: reservation.scheduledAt,
          children: Array.from(childrenByPartition.values()),
          requestedTotal: operationRecipientCount,
          skippedCount: effectiveSkippedOutcomes.size,
          skipDetails: boundedSkipDetails(rows, effectiveSkippedOutcomes),
        });
      // Binds the immutable request digest for the prepared progress; returns
      // the failure response, or null once the digest is bound.
      const bindPreparedRequestDigest = async (
        preparedProgress: GeneratedSendProgress
      ): Promise<GeneratedBulkSendOrchestratorResult | null> => {
        const requestDigest = createRequestDigest({
          version: expectedRequestDigestVersion,
          scenarioId,
          audienceRevision,
          audience: expectedAudience,
          scheduledAt: reservation.scheduledAt,
          preparationDigestVersion: preparedProgress.preparationDigestVersion,
          preparationDigest: preparedProgress.preparationDigest,
          recoveryFacts: preparedProgress.recoveryFacts,
          recipientPolicy,
          ...(preparedProgress.whatsappPolicyFacts
            ? { whatsappPolicyFacts: preparedProgress.whatsappPolicyFacts }
            : {}),
        });
        const bound = await deps.bindRequestDigest({
          ...owner,
          requestDigestVersion: expectedRequestDigestVersion,
          requestDigest,
        });
        if (bound.status === "payload_mismatch") {
          await releaseHandledLease(deps, owner);
          emitCurrentPolicyEvents({
            errorCode: "idempotency_key_payload_mismatch",
          });
          return response("in_progress", 409, {
            code: "idempotency_key_payload_mismatch",
            error:
              "The active generated send no longer matches its immutable prepared request.",
          });
        }
        if (bound.status === "stale_owner") return staleOwner();
        requestDigestBound = true;
        boundRequestDigest = requestDigest;
        return null;
      };
      const assigned = assignedGroups(rows);
      const provenAbsentAssignments = new Map<
        string,
        (typeof assigned)[number]
      >();
      const terminalChildFailure = async (params: {
        partitionKey: string;
        child: GeneratedBulkSendChild;
        dispatchStatus: "failed" | "expired" | "cancelled";
      }): Promise<GeneratedBulkSendOrchestratorResult> => {
        childrenByPartition.set(params.partitionKey, params.child);
        for (const row of rows) {
          if (row.sendPartitionKey === params.partitionKey) {
            queuedMessageIdsForObservability.add(row._id);
          }
        }
        const base = currentGroupedBase();
        const policyEventFacts = currentPolicyEventFacts({
          terminalStatus: params.dispatchStatus,
          errorCode: "generated_bulk_send_child_terminal",
        });
        const failure = response("in_progress", 409, {
          ...base,
          ...persistedGeneratedPolicyEventFacts(policyEventFacts),
          queued: false,
          partial: true,
          retryable: false,
          code: "generated_bulk_send_child_terminal",
          error: `The admitted child campaign is ${params.dispatchStatus} and cannot be restarted automatically. Review its campaign history before generating a new revision.`,
          failedPartitionKey: params.partitionKey,
          childDispatchStatus: params.dispatchStatus,
        });
        const persisted = await deps.failOperation({
          ...owner,
          responseStatus: failure.status,
          responseBody: failure.body,
        });
        if (persisted) {
          for (const fact of policyEventFacts) {
            deps.emitPolicyEvent({
              ...fact,
              workspaceId,
              idempotentReplay: false,
            });
          }
        }
        return persisted ? failure : staleOwner();
      };
      const ensureRecoveredStart = async (params: {
        partitionKey: string;
        fact: GeneratedSendRecoveryFact;
        recovery: Extract<
          GeneratedChildCampaignRecoveryResult,
          { status: "admitted" }
        >;
        messageIds: string[];
      }): Promise<
        | { child: GeneratedBulkSendChild }
        | { failure: GeneratedBulkSendOrchestratorResult }
      > => {
        let child = childFromRecovery({
          partitionKey: params.partitionKey,
          fact: params.fact,
          recovery: params.recovery,
        });
        try {
          if (!(await renew())) return { failure: staleOwner() };
          const start = await deps.ensureRecoveredChildStarted({
            workspaceId,
            campaignId: params.recovery.campaign.campaignId,
            dispatchStatus: params.recovery.campaign.dispatchStatus,
            requestedAt:
              params.recovery.campaign.requestedAt || reservation.requestedAt,
            scheduledAt: params.recovery.campaign.scheduledAt,
            dispatchExpiresAt:
              params.recovery.campaign.dispatchExpiresAt ||
              resolvePreparedBulkCampaignDispatchTiming({
                requestedAt: reservation.requestedAt,
                scheduledAt: reservation.scheduledAt,
                now: deps.now(),
              }).dispatchExpiresAt,
            batchPlan: params.fact.batchPlan,
            items: params.recovery.admittedItems,
          });
          child = {
            ...child,
            temporalDispatchStaging:
              start.temporalDispatchStaging ?? "existing",
          };
          if (
            start.status === "terminal" &&
            start.dispatchStatus !== "completed"
          ) {
            return {
              failure: await terminalChildFailure({
                partitionKey: params.partitionKey,
                child,
                dispatchStatus: start.dispatchStatus,
              }),
            };
          }
          return { child };
        } catch (error) {
          let refreshedTerminalStatus:
            | "completed"
            | "failed"
            | "expired"
            | "cancelled"
            | null = null;
          try {
            if (!(await renew())) return { failure: staleOwner() };
            const refreshed = await deps.recoverChild({
              workspaceId,
              scenarioId,
              scenarioNodeId: root.id,
              parentOperationId: reservation.operationId,
              partitionKey: params.partitionKey,
              campaignId: params.recovery.campaign.campaignId,
              channel: params.fact.channel,
              assignedAudience: params.fact.audience,
              expectedContentHash: params.fact.contentHash,
              expectedPolicyMetadata: expectedChildPolicyMetadata(params.fact),
            });
            if (refreshed.status === "admitted") {
              child = childFromRecovery({
                partitionKey: params.partitionKey,
                fact: params.fact,
                recovery: refreshed,
              });
              if (
                refreshed.campaign.dispatchStatus === "completed" ||
                refreshed.campaign.dispatchStatus === "failed" ||
                refreshed.campaign.dispatchStatus === "expired" ||
                refreshed.campaign.dispatchStatus === "cancelled"
              ) {
                refreshedTerminalStatus = refreshed.campaign.dispatchStatus;
              }
            }
          } catch {
            // The original admission remains proven. Preserve its child
            // evidence and the queue-owned start error that caused this path.
          }
          if (
            refreshedTerminalStatus &&
            refreshedTerminalStatus !== "completed"
          ) {
            return {
              failure: await terminalChildFailure({
                partitionKey: params.partitionKey,
                child,
                dispatchStatus: refreshedTerminalStatus,
              }),
            };
          }
          if (refreshedTerminalStatus === "completed") return { child };
          if (!(await renew())) return { failure: staleOwner() };
          await commitQueuedPages({
            deps,
            scope,
            messageIds: params.messageIds,
            campaignId: params.recovery.campaign.campaignId,
            partitionKey: params.partitionKey,
          });
          for (const messageId of params.messageIds) {
            queuedMessageIdsForObservability.add(messageId);
          }
          childrenByPartition.set(params.partitionKey, child);
          await releaseHandledLease(deps, owner);
          const base = currentGroupedBase();
          const classified = queueError(error);
          if (classified) {
            emitCurrentPolicyEvents({
              errorCode:
                asString(classified.body.code) ||
                "generated_bulk_send_workflow_start_unconfirmed",
            });
            return {
              failure: response("in_progress", classified.httpStatus, {
                ...base,
                queued: false,
                partial: true,
                retryable: classified.body.retryable === true,
                failedPartitionKey: params.partitionKey,
                ...topLevelQueueErrorFields(classified.body),
              }),
            };
          }
          emitCurrentPolicyEvents({
            errorCode: "generated_bulk_send_workflow_start_unconfirmed",
          });
          return {
            failure: response("in_progress", 503, {
              ...base,
              queued: false,
              partial: true,
              retryable: true,
              code: "generated_bulk_send_workflow_start_unconfirmed",
              error:
                error instanceof Error
                  ? error.message
                  : "The admitted child workflow start is unconfirmed.",
              failedPartitionKey: params.partitionKey,
            }),
          };
        }
      };

      for (const group of assigned) {
        if (group.rows.every(row => row.sendStatus === "skipped")) continue;
        const fact = factsByPartition.get(group.partitionKey);
        if (!fact || fact.campaignId !== group.campaignId) {
          await releaseHandledLease(deps, owner);
          emitCurrentPolicyEvents({
            errorCode: "generated_bulk_send_recovery_fact_missing",
          });
          return response("in_progress", 503, {
            code: "generated_bulk_send_recovery_fact_missing",
            error:
              "An assigned generated child is missing its immutable recovery fact.",
            retryable: true,
            failedPartitionKey: group.partitionKey,
          });
        }
        const groupAudience = audienceForIds(group.rows.map(row => row._id));
        const recovered = await deps.recoverChild({
          workspaceId,
          scenarioId,
          scenarioNodeId: root.id,
          parentOperationId: reservation.operationId,
          partitionKey: group.partitionKey,
          campaignId: group.campaignId,
          channel: fact.channel,
          assignedAudience: groupAudience,
          expectedContentHash: fact.contentHash,
          expectedPolicyMetadata: expectedChildPolicyMetadata(fact),
        });
        if (recovered.status === "not_admitted") {
          if (group.rows.some(row => row.sendStatus === "queued")) {
            throw new Error(
              "Generated send queued rows are missing canonical SQL admission"
            );
          }
          provenAbsentAssignments.set(group.partitionKey, group);
          continue;
        }
        const preparingIds = group.rows
          .filter(row => row.sendStatus === "preparing")
          .map(row => row._id);
        const started = await ensureRecoveredStart({
          partitionKey: group.partitionKey,
          fact,
          recovery: recovered,
          messageIds: preparingIds,
        });
        if ("failure" in started) return started.failure;
        if (preparingIds.length > 0) {
          if (!(await renew())) return staleOwner();
          await commitQueuedPages({
            deps,
            scope,
            messageIds: preparingIds,
            campaignId: group.campaignId,
            partitionKey: group.partitionKey,
          });
          for (const row of group.rows) {
            if (row.sendStatus === "preparing") row.sendStatus = "queued";
          }
        }
        childrenByPartition.set(group.partitionKey, started.child);
        for (const row of group.rows) {
          queuedMessageIdsForObservability.add(row._id);
        }
      }

      const remainingRows = rows.filter(row => row.sendStatus === "preparing");
      const timing = resolvePreparedBulkCampaignDispatchTiming({
        requestedAt: reservation.requestedAt,
        scheduledAt: reservation.scheduledAt,
        now: deps.now(),
      });
      if (timing.expired && remainingRows.length > 0) {
        const unassignedSkips: Record<string, GeneratedSendSkippedOutcome> = {};
        for (const row of remainingRows) {
          if (!row.campaignId && !row.sendPartitionKey) {
            unassignedSkips[row._id] = {
              reason: "dispatch_expired",
              detail: timing.dispatchExpiresAt,
            };
          }
        }
        for (const [messageId, outcome] of Object.entries(unassignedSkips)) {
          effectiveSkippedOutcomes.set(messageId, outcome);
        }
        if (Object.keys(unassignedSkips).length > 0) {
          if (!(await renew())) return staleOwner();
          await commitSkippedPages({
            deps,
            scope,
            skippedByMessageId: unassignedSkips,
          });
        }
        for (const group of provenAbsentAssignments.values()) {
          for (const row of group.rows) {
            effectiveSkippedOutcomes.set(row._id, {
              reason: "dispatch_expired",
              detail: timing.dispatchExpiresAt,
            });
          }
          for (const page of chunks(
            group.rows.map(row => row._id),
            GENERATED_SEND_OUTCOME_PAGE_SIZE
          )) {
            if (!(await renew())) return staleOwner();
            const committed = await deps.commitAssignedSkips({
              ...scope,
              campaignId: group.campaignId,
              partitionKey: group.partitionKey,
              messageIds: page,
              reason: "dispatch_expired",
              detail: timing.dispatchExpiresAt,
            });
            if (!committed.committed) {
              throw new Error(
                "Generated send assigned expiry outcomes were not committed"
              );
            }
          }
        }
      } else if (remainingRows.length > 0) {
        if (!(await renew())) return staleOwner();
        let verifiedRoutes = preflightVerifiedRoutes;
        let supportsWhatsAppTemplate = preflightSupportsWhatsAppTemplate;
        if (
          reservation.compatibilityMode === "current_v2" &&
          !preflightPreparation
        ) {
          generatedProvenanceCapability =
            generatedProvenanceCapability ??
            (await deps.verifyGeneratedProvenanceCapability({
              workspaceId,
              scenarioId,
              rootNodeId: root.id,
              audienceRevision,
            }));
          const verifiedRouting = await deps.routeGeneratedProvenance(
            generatedProvenanceCapability,
            rows
          );
          verifiedRoutes = verifiedRouting.routes;
          supportsWhatsAppTemplate = verifiedRouting.supportsWhatsAppTemplate;
        }
        const preparation =
          preflightPreparation ??
          (await deps.prepare({
            workspaceId,
            scenarioId,
            sentByUserId: reservation.initiatingUserId,
            operationId: reservation.operationId,
            campaignName,
            requestUrl,
            messages: rows,
            nodes: Array.isArray(scenario.nodes) ? scenario.nodes : [],
            fallbackSourceIds: normalizeSourceIds(rootConfig.sourceIds),
            recipientPolicy,
            ...(verifiedRoutes
              ? {
                  verifiedRoutes,
                  verifiedWhatsAppTemplateCapability:
                    supportsWhatsAppTemplate === true,
                }
              : {}),
            digestMode:
              reservation.compatibilityMode === "legacy_v1_disabled"
                ? "legacy_v2_disabled"
                : "current_v3",
          }));
        const expectedPreparationVersion =
          reservation.compatibilityMode === "legacy_v1_disabled" ? 2 : 3;
        if (
          preparation.preparationDigestVersion !== expectedPreparationVersion
        ) {
          throw new Error(
            "Generated send preparation digest mode does not match its operation"
          );
        }
        const unavailable = await ensurePreparedRuntimeDependencies(
          preparation,
          emitAvailableFailurePolicyEvents
        );
        if (unavailable) return unavailable;
        if (!(await renew())) return staleOwner();
        if (preparation.partitions.length > 0 && !fingerprintSecret) {
          throw new Error(
            "Generated preparation lost its verified safety secret"
          );
        }
        const preparedFingerprintSecret = fingerprintSecret ?? "";
        const normalizedPartitions = normalizedPartitionFacts({
          deps,
          fingerprintSecret: preparedFingerprintSecret,
          workspaceId,
          userId: reservation.initiatingUserId,
          preparation,
        });
        const currentFacts = normalizedPartitions.map(value => value.fact);
        assertBoundedRecoveryFacts(currentFacts);

        const assignedPreparingIds = new Set(
          Array.from(provenAbsentAssignments.values()).flatMap(group =>
            group.rows.map(row => row._id)
          )
        );
        const permanentSkips: Record<string, GeneratedSendSkippedOutcome> = {};
        for (const [messageId, outcome] of Object.entries(
          preparation.skippedByMessageId
        )) {
          if (assignedPreparingIds.has(messageId)) {
            throw new Error(
              "Assigned generated child no longer reproduces its persisted partition"
            );
          }
          permanentSkips[messageId] = {
            reason: outcome.reason,
            ...(outcome.detail ? { detail: outcome.detail } : {}),
          };
        }
        for (const normalized of normalizedPartitions) {
          for (const excluded of normalized.excluded) {
            if (
              assignedPreparingIds.has(excluded.generatedRecipientMessageId)
            ) {
              throw new Error(
                "Assigned generated child no longer reproduces its canonical audience"
              );
            }
            permanentSkips[excluded.generatedRecipientMessageId] = {
              reason: excluded.reason,
            };
          }
        }
        for (const [messageId, outcome] of Object.entries(permanentSkips)) {
          effectiveSkippedOutcomes.set(messageId, outcome);
          const canonicalReason = canonicalGeneratedPolicySkipReason(
            outcome.reason
          );
          if (canonicalReason) {
            policySkipReasonsForObservability.set(messageId, canonicalReason);
          }
        }

        if (!progress) {
          const next: GeneratedSendProgress = {
            version: GENERATED_SEND_PROGRESS_VERSION,
            phase: "prepared",
            preparationDigestVersion: preparation.preparationDigestVersion,
            preparationDigest: preparation.preparationDigest,
            recoveryFacts: currentFacts,
            admittedChildrenCount: 0,
            queuedCount: 0,
            skippedCount: Object.keys(permanentSkips).length,
            lastPartitionKey: null,
            ...(reservation.compatibilityMode === "current_v2"
              ? {
                  recipientPolicy,
                  ...(preparation.whatsappPolicyFacts
                    ? {
                        whatsappPolicyFacts: preparation.whatsappPolicyFacts,
                      }
                    : {}),
                }
              : {}),
          };
          if (!(await persistProgress(next))) return staleOwner();
          for (const fact of next.recoveryFacts) {
            factsByPartition.set(fact.partitionKey, fact);
          }
        } else {
          if (
            progress.preparationDigestVersion !==
              preparation.preparationDigestVersion ||
            progress.preparationDigest !== preparation.preparationDigest
          ) {
            throw new Error(
              "Generated send preparation changed after operation binding"
            );
          }
          const currentFactsByPartition = new Map(
            currentFacts.map(fact => [fact.partitionKey, fact])
          );
          const assignedPartitionKeys = new Set(
            assigned.map(group => group.partitionKey)
          );
          for (const persisted of progress.recoveryFacts) {
            if (
              !assignedPartitionKeys.has(persisted.partitionKey) &&
              !currentFactsByPartition.has(persisted.partitionKey)
            ) {
              throw new Error(
                "Generated send preparation changed after operation binding"
              );
            }
          }
          for (const currentFact of currentFacts) {
            const persisted = factsByPartition.get(currentFact.partitionKey);
            if (!persisted || !recoveryFactMatches(persisted, currentFact)) {
              throw new Error(
                "Generated send preparation changed after operation binding"
              );
            }
          }
        }

        if (!reservation.requestDigest) {
          const bindFailure = await bindPreparedRequestDigest(progress!);
          if (bindFailure) return bindFailure;
        }

        if (Object.keys(permanentSkips).length > 0) {
          if (!(await renew())) return staleOwner();
          await commitSkippedPages({
            deps,
            scope,
            skippedByMessageId: permanentSkips,
          });
        }

        const newPartitionCount = normalizedPartitions.filter(
          normalized =>
            !childrenByPartition.has(normalized.partition.partitionKey)
        ).length;
        let companyBulkCampaignLimit: number | null | undefined;
        let companySubscriptionType: CompanySubscriptionType | undefined;
        if (newPartitionCount > 0) {
          const conversationCapacity =
            preflightConversationCapacity ??
            (await deps.ensureConversationCapacity(workspaceId));
          if (!conversationCapacity.allowed) {
            await releaseHandledLease(deps, owner);
            emitCurrentPolicyEvents({
              errorCode: "company_conversation_limit_exceeded",
            });
            return capacityFailure(conversationCapacity, {
              code: "company_conversation_limit_exceeded",
              error: "Company conversation limit exceeded.",
            });
          }
          companyBulkCampaignLimit =
            conversationCapacity.companyBulkCampaignLimit;
          companySubscriptionType =
            conversationCapacity.companySubscriptionType;
        }

        for (const normalized of normalizedPartitions) {
          const { partition, fact } = normalized;
          if (childrenByPartition.has(partition.partitionKey)) continue;
          const persistedFact = factsByPartition.get(partition.partitionKey);
          if (!persistedFact || !recoveryFactMatches(persistedFact, fact)) {
            throw new Error(
              "Generated send partition recovery fact does not match preparation"
            );
          }
          const assignedGroup = provenAbsentAssignments.get(
            partition.partitionKey
          );
          if (assignedGroup) {
            const assignedIds = assignedGroup.rows.map(row => row._id);
            if (
              stableJson(assignedIds) !== stableJson(normalized.messageIds) ||
              assignedGroup.campaignId !== partition.campaignId
            ) {
              throw new Error(
                "Generated send assigned child audience changed before admission"
              );
            }
          } else {
            if (!(await renew())) return staleOwner();
            for (const page of chunks(
              normalized.messageIds,
              GENERATED_SEND_OUTCOME_PAGE_SIZE
            )) {
              const assignment = await deps.assignPartition({
                ...scope,
                messageIds: page,
                partitionKey: partition.partitionKey,
              });
              if (
                !assignment.assigned ||
                assignment.campaignId !== partition.campaignId
              ) {
                throw new Error(
                  "Generated send partition assignment was incomplete"
                );
              }
            }
          }

          if (!(await renew())) return staleOwner();
          const expectedPolicyMetadata = expectedChildPolicyMetadata(fact);
          const recoverPartition = () =>
            deps.recoverChild({
              workspaceId,
              scenarioId,
              scenarioNodeId: root.id,
              parentOperationId: reservation.operationId,
              partitionKey: partition.partitionKey,
              campaignId: partition.campaignId,
              channel: partition.channel,
              assignedAudience: fact.audience,
              expectedContentHash: fact.contentHash,
              expectedPolicyMetadata,
            });
          let recovered = await recoverPartition();
          let child: GeneratedBulkSendChild | null = null;
          if (recovered.status === "admitted") {
            const started = await ensureRecoveredStart({
              partitionKey: partition.partitionKey,
              fact,
              recovery: recovered,
              messageIds: normalized.messageIds,
            });
            if ("failure" in started) return started.failure;
            child = started.child;
          } else {
            if (!(await renew())) return staleOwner();
            if (
              companyBulkCampaignLimit === undefined ||
              companySubscriptionType === undefined
            ) {
              throw new Error(
                "Generated child admission is missing the company plan snapshot"
              );
            }
            try {
              const queued = await deps.queueChild({
                fingerprintSecret: preparedFingerprintSecret,
                campaignId: partition.campaignId,
                workspaceId,
                channel: partition.channel,
                campaignName,
                templateName: partition.templateName,
                templateLanguage: partition.templateLanguage,
                messageText: partition.messageText,
                sentBy: reservation.initiatingUserId,
                scenarioId,
                scenarioNodeId: root.id,
                executionSource: "scenario_run_now",
                requestedAt: reservation.requestedAt,
                scheduledAt: reservation.scheduledAt,
                batchPlan: fact.batchPlan,
                items: normalized.items,
                audienceSourceType: "scenario_generated",
                audienceConfirmationFingerprint:
                  input.audienceConfirmationFingerprint || null,
                requestedTotal: partition.requestedTotal,
                skippedOptIn: partition.skippedOptIn,
                companyBulkCampaignLimit,
                companySubscriptionType,
                ...(expectedPolicyMetadata
                  ? { policyMetadata: expectedPolicyMetadata }
                  : {}),
              });
              if (
                stableJson(queued.queuedGeneratedRecipientMessageIds) !==
                  stableJson(normalized.messageIds) ||
                queued.campaignId !== partition.campaignId
              ) {
                throw new Error(
                  "Generated send queue returned a different immutable audience"
                );
              }
              child = childFromQueued(partition, queued);
            } catch (error) {
              const caught = queueError(error);
              recovered = await recoverPartition();
              if (recovered.status === "admitted") {
                const started = await ensureRecoveredStart({
                  partitionKey: partition.partitionKey,
                  fact,
                  recovery: recovered,
                  messageIds: normalized.messageIds,
                });
                if ("failure" in started) return started.failure;
                child = started.child;
              } else {
                await releaseHandledLease(deps, owner);
                const base = currentGroupedBase();
                const normalizedError =
                  caught ??
                  ({
                    httpStatus: 503,
                    body: {
                      code: "generated_bulk_send_admission_ambiguous",
                      error:
                        error instanceof Error
                          ? error.message
                          : "Generated child admission is ambiguous.",
                      retryable: true,
                    },
                  } as const);
                emitCurrentPolicyEvents({
                  errorCode:
                    asString(normalizedError.body.code) ||
                    "generated_bulk_send_partial_failure",
                });
                return partialResponse({
                  base,
                  failedPartitionKey: partition.partitionKey,
                  queueError: normalizedError,
                });
              }
            }
          }

          if (!child) {
            throw new Error("Generated send admitted child is missing");
          }
          if (!(await renew())) return staleOwner();
          await commitQueuedPages({
            deps,
            scope,
            messageIds: normalized.messageIds,
            campaignId: partition.campaignId,
            partitionKey: partition.partitionKey,
          });
          for (const messageId of normalized.messageIds) {
            queuedMessageIdsForObservability.add(messageId);
          }
          childrenByPartition.set(partition.partitionKey, child);
          const nextProgress: GeneratedSendProgress = {
            ...progress!,
            admittedChildrenCount: childrenByPartition.size,
            queuedCount: progress!.queuedCount + normalized.messageIds.length,
            lastPartitionKey: partition.partitionKey,
          };
          if (!(await persistProgress(nextProgress))) return staleOwner();
        }
      }

      if (!requestDigestBound && !progress) {
        const terminalProgress: GeneratedSendProgress = {
          version: GENERATED_SEND_PROGRESS_VERSION,
          phase: "prepared",
          preparationDigestVersion: 1,
          preparationDigest: sha256({
            version: 1,
            terminal: "dispatch_expired",
            audience: expectedAudience,
            dispatchExpiresAt: timing.dispatchExpiresAt,
          }),
          recoveryFacts: [],
          admittedChildrenCount: childrenByPartition.size,
          queuedCount: 0,
          skippedCount: remainingRows.length,
          lastPartitionKey: null,
          ...(reservation.compatibilityMode === "current_v2"
            ? {
                recipientPolicy,
                ...(preflightPreparation?.whatsappPolicyFacts
                  ? {
                      whatsappPolicyFacts:
                        preflightPreparation.whatsappPolicyFacts,
                    }
                  : {}),
              }
            : {}),
        };
        if (!(await persistProgress(terminalProgress))) return staleOwner();
      }
      if (!requestDigestBound && progress) {
        const bindFailure = await bindPreparedRequestDigest(progress);
        if (bindFailure) return bindFailure;
      }
      if (!requestDigestBound) {
        await releaseHandledLease(deps, owner);
        emitCurrentPolicyEvents({
          errorCode: "generated_bulk_send_request_digest_missing",
        });
        return response("in_progress", 503, {
          code: "generated_bulk_send_request_digest_missing",
          error:
            "The generated send has assigned outcomes without a bound request digest.",
          retryable: true,
        });
      }
      const coverage = await deps.verifyCoverage({
        ...scope,
        expectedAudience,
        pageSize: GENERATED_SEND_PAGE_SIZE,
      });
      if (!coverage.complete) {
        await releaseHandledLease(deps, owner);
        emitCurrentPolicyEvents({
          errorCode: "generated_bulk_send_outcomes_incomplete",
        });
        return response("in_progress", 503, {
          code: "generated_bulk_send_outcomes_incomplete",
          error:
            "Generated recipient outcomes are incomplete. Retry the active operation.",
          retryable: true,
          incompleteCount: coverage.incompleteCount,
        });
      }

      const finalRows = await loadOperationRows({
        deps,
        scope,
        expectedCount: operationRecipientCount,
      });
      observabilityRows = finalRows;
      for (const row of finalRows) {
        if (row.sendStatus === "queued") {
          queuedMessageIdsForObservability.add(row._id);
        }
        if (row.sendStatus === "skipped" && row.skipReason) {
          effectiveSkippedOutcomes.set(row._id, {
            reason: row.skipReason,
            ...(row.skipDetail ? { detail: row.skipDetail } : {}),
          });
          const canonicalReason = canonicalGeneratedPolicySkipReason(
            row.skipReason
          );
          if (canonicalReason) {
            policySkipReasonsForObservability.set(row._id, canonicalReason);
          }
        }
      }
      const skipDetails = boundedSkipDetails(
        finalRows,
        effectiveSkippedOutcomes
      );
      const completedAt = deps.now().toISOString();
      const patch: GeneratedBulkSendScenarioUpdate["bulkRootConfigPatch"] = {
        generatedRecipientCount: operationRecipientCount,
        sendStatus: {
          total: operationRecipientCount,
          queued: coverage.queuedCount,
          sent: 0,
          skipped: coverage.skippedCount,
          failed: 0,
          lastSendAttemptAt: reservation.requestedAt,
          ...(reservation.scheduledAt
            ? { scheduledAt: reservation.scheduledAt }
            : {}),
        },
        generatedSendState: {
          revision: audienceRevision,
          operationId: reservation.operationId,
          state: "completed",
          requestedAt: reservation.requestedAt,
          completedAt,
        },
      };
      if (!(await renew())) return staleOwner();
      const scenarioUpdated = await deps.updateScenarioRevision({
        workspaceId,
        scenarioId,
        nodeId: root.id,
        audienceRevision,
        operationId: reservation.operationId,
        updatedBy: userId,
        patch,
        scenarioStatus: "active",
      });
      if (!scenarioUpdated.updated) {
        await releaseHandledLease(deps, owner);
        emitCurrentPolicyEvents({
          errorCode: "generated_bulk_send_scenario_update_conflict",
        });
        return response("in_progress", 503, {
          code: "generated_bulk_send_scenario_update_conflict",
          error:
            "The Scenario revision changed before generated send completion.",
          retryable: true,
        });
      }
      const scenarioUpdate: GeneratedBulkSendScenarioUpdate = {
        nodeId: root.id,
        bulkRootConfigPatch: patch,
        scenarioUpdatedAt: scenarioUpdated.scenarioUpdatedAt,
      };
      const policyEventFacts = currentPolicyEventFacts(
        timing.expired
          ? {
              terminalStatus: "expired",
              errorCode: "bulk_campaign_dispatch_expired",
            }
          : undefined
      );
      const responseBody = {
        ...groupedResponse({
          scenarioId,
          requestedAt: reservation.requestedAt,
          scheduledAt: reservation.scheduledAt,
          children: Array.from(childrenByPartition.values()),
          requestedTotal: operationRecipientCount,
          skippedCount: coverage.skippedCount,
          skipDetails,
          scenarioUpdate,
          scenarioStatus: scenarioUpdated.scenarioStatus,
        }),
        ...persistedGeneratedPolicyEventFacts(policyEventFacts),
        operationDisposition: "completed" as const,
      };
      const completed = await deps.completeOperation({
        ...owner,
        responseBody,
      });
      if (!completed) {
        return response("in_progress", 409, {
          code: "generated_bulk_send_stale_owner",
          error:
            "The generated send completed but another worker owns finalization.",
          retryable: true,
        });
      }
      for (const policyEventFact of policyEventFacts) {
        deps.emitPolicyEvent({
          ...policyEventFact,
          workspaceId,
          idempotentReplay: false,
        });
      }
      return response("completed", 200, responseBody);
    } catch (error) {
      if (!claimed && !ownershipIrreversible) {
        await deletePreClaim();
      } else {
        await releaseHandledLease(deps, owner);
      }
      if (
        error instanceof GeneratedBulkRecipientPolicyUnsupportedError ||
        isUnsupportedGeneratedPolicyCapability(error, recipientPolicy)
      ) {
        const unsupported =
          error instanceof GeneratedBulkRecipientPolicyUnsupportedError
            ? error
            : new GeneratedBulkRecipientPolicyUnsupportedError();
        emitAvailableFailurePolicyEvents(unsupported.code);
        return response(
          claimed || ownershipIrreversible ? "in_progress" : "not_started",
          409,
          {
            code: unsupported.code,
            error: unsupported.message,
          }
        );
      }
      const eligibilityFailed = eligibilityFailure(
        claimed || ownershipIrreversible ? "in_progress" : "not_started",
        error
      );
      if (eligibilityFailed) {
        emitAvailableFailurePolicyEvents(asString(eligibilityFailed.body.code));
        return eligibilityFailed;
      }
      const caught = queueError(error);
      if (caught) {
        emitAvailableFailurePolicyEvents(
          asString(caught.body.code) || "generated_bulk_send_failure"
        );
        return response(
          claimed || ownershipIrreversible ? "in_progress" : "not_started",
          caught.httpStatus,
          caught.body
        );
      }
      emitAvailableFailurePolicyEvents("generated_bulk_send_retryable_failure");
      return response(
        claimed || ownershipIrreversible ? "in_progress" : "not_started",
        503,
        {
          code: "generated_bulk_send_retryable_failure",
          error:
            error instanceof Error
              ? error.message
              : "Generated bulk send failed safely.",
          retryable: true,
        }
      );
    }
  };
}

type GeneratedScenarioRevisionPersistence = {
  read(params: {
    workspaceId: string;
    scenarioId: string;
    nodeId: string;
    audienceRevision: string;
  }): Promise<{
    generatedSendState: ScenarioBulkRootConfig["generatedSendState"] | null;
    scenarioUpdatedAt: string;
    scenarioStatus?: string;
  } | null>;
  /** The status the Scenario holds after the write, or null on no match. */
  writeMissingMarker(
    params: Parameters<
      GeneratedBulkSendOrchestratorDependencies["updateScenarioRevision"]
    >[0] & { scenarioUpdatedAt: string }
  ): Promise<{ scenarioStatus: string } | null>;
};

export async function reconcileGeneratedBulkSendScenarioRevision(
  params: Parameters<
    GeneratedBulkSendOrchestratorDependencies["updateScenarioRevision"]
  >[0],
  persistence: GeneratedScenarioRevisionPersistence
): Promise<ScenarioRevisionUpdateResult> {
  const marker = params.patch.generatedSendState;
  if (
    !params.patch.sendStatus ||
    boundedGeneratedRecipientCount(params.patch.generatedRecipientCount) ===
      null ||
    !marker ||
    marker.revision !== params.audienceRevision ||
    marker.operationId !== params.operationId
  ) {
    throw new Error("Generated Scenario revision patch is malformed");
  }
  const current = await persistence.read(params);
  if (!current) {
    return {
      updated: false,
      scenarioUpdatedAt: new Date().toISOString(),
    };
  }
  if (current.generatedSendState) {
    const sameOperation =
      current.generatedSendState.revision === params.audienceRevision &&
      current.generatedSendState.operationId === params.operationId;
    return {
      updated: sameOperation,
      scenarioUpdatedAt: current.scenarioUpdatedAt,
      scenarioStatus: current.scenarioStatus,
    };
  }

  const scenarioUpdatedAt = new Date().toISOString();
  const written = await persistence.writeMissingMarker({
    ...params,
    scenarioUpdatedAt,
  });
  if (written) {
    return {
      updated: true,
      scenarioUpdatedAt,
      scenarioStatus: written.scenarioStatus,
    };
  }
  const raced = await persistence.read(params);
  const sameOperation =
    raced?.generatedSendState?.revision === params.audienceRevision &&
    raced.generatedSendState.operationId === params.operationId;
  return {
    updated: sameOperation,
    scenarioUpdatedAt: raced?.scenarioUpdatedAt ?? scenarioUpdatedAt,
    scenarioStatus: raced?.scenarioStatus,
  };
}

export function buildGeneratedScenarioRevisionGraphForPersistence(
  raw: unknown,
  params: {
    nodeId: string;
    audienceRevision: string;
    patch: GeneratedBulkSendScenarioUpdate["bulkRootConfigPatch"];
  }
) {
  const scenario =
    raw !== null && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : {};
  const nodes = Array.isArray(scenario.nodes) ? scenario.nodes : [];
  let foundRoot = false;
  const nextNodes = nodes.map(node => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return node;
    const nodeRecord = node as Record<string, unknown>;
    const data =
      nodeRecord.data &&
      typeof nodeRecord.data === "object" &&
      !Array.isArray(nodeRecord.data)
        ? (nodeRecord.data as Record<string, unknown>)
        : null;
    const bulkRootConfig =
      data?.bulkRootConfig &&
      typeof data.bulkRootConfig === "object" &&
      !Array.isArray(data.bulkRootConfig)
        ? (data.bulkRootConfig as Record<string, unknown>)
        : null;
    if (
      nodeRecord.id !== params.nodeId ||
      data?.kind !== "bulk" ||
      bulkRootConfig?.generationJobId !== params.audienceRevision ||
      bulkRootConfig.generatedSendState != null
    ) {
      return node;
    }

    foundRoot = true;
    return {
      ...nodeRecord,
      data: {
        ...data,
        bulkRootConfig: {
          ...bulkRootConfig,
          sendStatus: params.patch.sendStatus,
          generatedRecipientCount: params.patch.generatedRecipientCount,
          generatedSendState: params.patch.generatedSendState,
        },
      },
    };
  });
  if (!foundRoot) return null;

  return normalizeScenarioGraphForPersistence({
    graphSchemaVersion: scenario.graphSchemaVersion,
    nodes: nextNodes,
    edges: scenario.edges,
  });
}

const scenarioRevisionPersistence: GeneratedScenarioRevisionPersistence = {
  read: async params => {
    const scenario = await Scenario.findOne({
      _id: new Types.ObjectId(params.scenarioId),
      workspaceId: params.workspaceId,
      deletedAt: null,
      nodes: {
        $elemMatch: {
          id: params.nodeId,
          "data.kind": "bulk",
          "data.bulkRootConfig.generationJobId": params.audienceRevision,
        },
      },
    })
      .select("nodes status updatedAt")
      .lean<{
        nodes?: LeanScenarioNode[];
        status?: unknown;
        updatedAt?: Date | string;
      } | null>();
    if (!scenario) return null;
    const root = (scenario.nodes ?? []).find(node => node.id === params.nodeId);
    const updatedAt = new Date(scenario.updatedAt ?? 0);
    if (!root || !Number.isFinite(updatedAt.getTime())) return null;
    return {
      generatedSendState: root.data?.bulkRootConfig?.generatedSendState ?? null,
      scenarioUpdatedAt: updatedAt.toISOString(),
      scenarioStatus: asString(scenario.status),
    };
  },
  writeMissingMarker: async params => {
    const scenario = await Scenario.findOne({
      _id: new Types.ObjectId(params.scenarioId),
      workspaceId: params.workspaceId,
      deletedAt: null,
      nodes: {
        $elemMatch: {
          id: params.nodeId,
          "data.kind": "bulk",
          "data.bulkRootConfig.generationJobId": params.audienceRevision,
          "data.bulkRootConfig.generatedSendState": null,
        },
      },
    })
      .select("graphSchemaVersion mode nodes edges status updatedAt")
      .lean<{
        graphSchemaVersion?: unknown;
        mode?: unknown;
        nodes?: LeanScenarioNode[];
        edges?: unknown[];
        status?: unknown;
        updatedAt?: Date | string;
      } | null>();
    if (!scenario) return null;
    if (
      params.scenarioStatus === "active" &&
      asString(scenario.status) !== "active" &&
      hasPersistedWhatsAppQrGraphBinding(scenario.nodes)
    ) {
      return null;
    }
    // A builder birthday root the save would schedule (daily WhatsApp, or
    // Telegram with a bot) arms only through the Scenario save, which runs
    // the birthday guard, so the send records its marker without activating
    // the Scenario.
    const keepsStoredStatus =
      params.scenarioStatus === "active" &&
      asString(scenario.status) !== "active" &&
      asString(scenario.mode) !== "bulk_campaign" &&
      scenarioHasBirthdayBulkSchedule({
        mode: scenario.mode,
        nodes: scenario.nodes,
        edges: scenario.edges,
      });
    const persistedUpdatedAt = new Date(scenario.updatedAt ?? 0);
    if (!Number.isFinite(persistedUpdatedAt.getTime())) return null;
    const graph = buildGeneratedScenarioRevisionGraphForPersistence(
      scenario,
      params
    );
    if (!graph) return null;

    const result = await Scenario.updateOne(
      {
        _id: new Types.ObjectId(params.scenarioId),
        workspaceId: params.workspaceId,
        deletedAt: null,
        updatedAt: persistedUpdatedAt,
        nodes: {
          $elemMatch: {
            id: params.nodeId,
            "data.kind": "bulk",
            "data.bulkRootConfig.generationJobId": params.audienceRevision,
            "data.bulkRootConfig.generatedSendState": null,
          },
        },
      },
      {
        $set: {
          graphSchemaVersion: graph.graphSchemaVersion,
          nodes: graph.nodes,
          edges: graph.edges,
          ...(keepsStoredStatus ? {} : { status: params.scenarioStatus }),
          updatedBy: params.updatedBy,
          updatedAt: new Date(params.scenarioUpdatedAt),
        },
      },
      // Preserve the revision returned by the completed-send reconciliation.
      { timestamps: false }
    );
    if (result.matchedCount !== 1) return null;
    return {
      scenarioStatus: keepsStoredStatus
        ? asString(scenario.status)
        : params.scenarioStatus,
    };
  },
};

async function capacityResultFromResponse(
  allowed: boolean,
  companyBulkCampaignLimit: number | null,
  companySubscriptionType: CompanySubscriptionType,
  buildFailure: () => Response,
  bulkRecipientsRemaining: number | null = null
): Promise<CapacityResult> {
  if (allowed) {
    return {
      allowed: true,
      companyBulkCampaignLimit,
      companySubscriptionType,
      bulkRecipientsRemaining,
    };
  }
  const failure = buildFailure();
  return {
    allowed: false,
    failure: {
      status: failure.status,
      body: (await failure.json()) as BulkCampaignSendResponse & JsonObject,
    },
  };
}

const productionDependencies: GeneratedBulkSendOrchestratorDependencies = {
  now: () => new Date(),
  connectDB,
  fingerprintSecret: () => process.env.ENCRYPTION_SECRET,
  isTemporalConfigured,
  ensureConversationCapacity: async workspaceId => {
    const capacity = await ensureCompanyConversationCapacity(
      supabaseAdmin,
      workspaceId,
      { includeBulkRecipientUsage: true }
    );
    return capacityResultFromResponse(
      capacity.allowed,
      capacity.limit.bulkRecipientLimit,
      capacity.limit.subscriptionType,
      () => buildCompanyLimitExceededResponse(capacity.limit),
      getBulkRecipientsRemaining(capacity.limit)
    );
  },
  findScenario: async ({ workspaceId, scenarioId }) =>
    Scenario.findOne({
      _id: new Types.ObjectId(scenarioId),
      workspaceId,
      deletedAt: null,
    }).lean<GeneratedBulkSendScenario | null>(),
  reserveOperation: reserveGeneratedBulkSendOperation,
  deleteOperationBeforeClaim: deleteGeneratedBulkSendOperationBeforeClaim,
  renewOperationLease: renewGeneratedBulkSendOperationLease,
  releaseOperationLease: releaseGeneratedBulkSendOperationLease,
  bindRequestDigest: bindGeneratedBulkSendOperationRequestDigest,
  compareAndSetProgress: compareAndSetGeneratedBulkSendOperationProgress,
  completeOperation: completeGeneratedBulkSendOperation,
  failOperation: failGeneratedBulkSendOperation,
  claimRevision: claimGeneratedSendRevision,
  loadOperationPage: loadGeneratedSendOperationPage,
  loadRevisionPage: loadGeneratedSendRevisionPage,
  verifyGeneratedProvenanceCapability:
    verifyGeneratedBulkCampaignProvenanceCapability,
  routeGeneratedProvenance: async (capability, messages) => {
    const verified = await routeVerifiedGeneratedBulkCampaignProvenance(
      capability,
      messages.map(message => ({
        stableId: message._id,
        nodeId: message.nodeId,
        branchId: message.branchId,
        channel: message.channel,
        sourceId: message.sourceId,
        recipient: {
          sourceId: message.sourceId,
          name: message.recipientName ?? undefined,
          ...(message.channel === "whatsapp"
            ? { phone: message.recipient }
            : message.channel === "telegram"
              ? { chatId: message.recipient }
              : { email: message.recipient }),
        },
      }))
    );
    return {
      routes: verified.routes,
      supportsWhatsAppTemplate: verified.supportsWhatsAppTemplate,
      recipientPolicy: verified.recipientPolicy,
    };
  },
  prepare: prepareGeneratedBulkCampaignPartitions,
  normalizeQueueItems: normalizePreparedBulkCampaignQueueItems,
  createContentHash: createPreparedBulkCampaignContentHash,
  assignPartition: assignGeneratedSendPartition,
  commitOutcomes: commitGeneratedSendPartialOutcomes,
  commitAssignedSkips: params =>
    commitGeneratedSendAssignedPartitionSkip({
      workspaceId: params.workspaceId,
      scenarioId: params.scenarioId,
      audienceRevision: params.audienceRevision,
      operationId: params.operationId,
      messageIds: params.messageIds,
      assignment: {
        campaignId: params.campaignId,
        partitionKey: params.partitionKey,
      },
      outcome: {
        reason: params.reason,
        ...(params.detail !== undefined ? { detail: params.detail } : {}),
      },
    }),
  recoverChild: params =>
    recoverGeneratedChildCampaignAdmission({
      supabase: supabaseAdmin,
      ...params,
    }),
  ensureRecoveredChildStarted: params =>
    ensureAdmittedPreparedBulkCampaignDispatchStarted({
      storeClient: supabaseAdmin,
      ...params,
    }),
  queueChild: input =>
    queuePreparedBulkCampaignDispatch({
      storeClient: supabaseAdmin,
      ...input,
    }),
  verifyCoverage: verifyGeneratedSendOperationCoverage,
  updateScenarioRevision: params =>
    reconcileGeneratedBulkSendScenarioRevision(
      params,
      scenarioRevisionPersistence
    ),
  emitPolicyEvent: event => emitBulkCampaignPolicyEvent(logger, event),
};

export const executeGeneratedBulkSend = createGeneratedBulkSendOrchestrator(
  productionDependencies
);

export async function previewGeneratedBulkCampaignEligibility(
  input: {
    workspaceId: string;
    scenarioId: string;
    observedPlanRevision?: string;
  },
  dependencies: Pick<
    GeneratedBulkSendOrchestratorDependencies,
    | "connectDB"
    | "findScenario"
    | "loadRevisionPage"
    | "verifyGeneratedProvenanceCapability"
    | "routeGeneratedProvenance"
    | "prepare"
  > = productionDependencies
): Promise<{ status: number; body: JsonObject }> {
  const workspaceId = asString(input.workspaceId);
  const scenarioId = asString(input.scenarioId);
  if (!workspaceId || !scenarioId) {
    return { status: 400, body: { error: "Invalid preview identifiers" } };
  }
  await dependencies.connectDB();
  const scenario = await dependencies.findScenario({ workspaceId, scenarioId });
  const root = scenario ? findRoot(scenario) : null;
  if (!scenario || !root?.data?.bulkRootConfig) {
    return { status: 404, body: { error: "Scenario not found" } };
  }
  const rootConfig = root.data.bulkRootConfig;
  let recipientPolicy: BulkCampaignRecipientPolicy;
  try {
    recipientPolicy = normalizeBulkCampaignRecipientPolicy(
      rootConfig.recipientPolicy
    );
  } catch (error) {
    return {
      status: 409,
      body: {
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
  if (rootConfig.sendMode !== "immediate") {
    return {
      status: 200,
      body: {
        state: "deferred",
        appliesAt: "each_run",
        policy: recipientPolicy,
      },
    };
  }
  const audienceRevision = asString(rootConfig.generationJobId);
  if (!audienceRevision) {
    return {
      status: 409,
      body: { state: "open", error: "Generated revision is incomplete" },
    };
  }
  try {
    const capability = await dependencies.verifyGeneratedProvenanceCapability({
      workspaceId,
      scenarioId,
      rootNodeId: root.id,
      audienceRevision,
    });
    const rows = await loadRevisionRows({
      deps: dependencies,
      scope: { workspaceId, scenarioId, audienceRevision },
    });
    const expectedCount = boundedGeneratedRecipientCount(
      rootConfig.generatedRecipientCount
    );
    if (expectedCount === null || rows.length !== expectedCount) {
      return {
        status: 409,
        body: {
          state: "revision_mismatch",
          expectedCount,
          revisionCount: rows.length,
        },
      };
    }
    const verifiedRouting = await dependencies.routeGeneratedProvenance(
      capability,
      rows
    );
    if (
      stableJson(verifiedRouting.recipientPolicy) !==
      stableJson(recipientPolicy)
    ) {
      return {
        status: 503,
        body: {
          state: "unavailable",
          code: "generated_bulk_send_policy_changed",
          error:
            "The generated campaign recipient policy changed during preview.",
          retryable: true,
        },
      };
    }
    const preparation = await dependencies.prepare({
      workspaceId,
      scenarioId,
      sentByUserId: "preview",
      operationId: sha256({
        version: 1,
        purpose: "generated_bulk_preview",
        workspaceId,
        scenarioId,
        audienceRevision,
      }),
      campaignName:
        asString(rootConfig.campaignName) ||
        asString(scenario.name) ||
        "Generated campaign",
      requestUrl: "https://airi.chat",
      messages: rows,
      nodes: Array.isArray(scenario.nodes) ? scenario.nodes : [],
      fallbackSourceIds: normalizeSourceIds(rootConfig.sourceIds),
      recipientPolicy,
      verifiedRoutes: verifiedRouting.routes,
      verifiedWhatsAppTemplateCapability:
        verifiedRouting.supportsWhatsAppTemplate,
      digestMode: "current_v3",
    });
    const acceptedTotal = preparation.partitions.reduce(
      (total, partition) => total + partition.candidateMessageIds.length,
      0
    );
    const skippedByReason: Record<string, number> = {};
    for (const outcome of Object.values(preparation.skippedByMessageId)) {
      skippedByReason[outcome.reason] =
        (skippedByReason[outcome.reason] || 0) + 1;
    }
    return {
      status: 200,
      body: {
        state: "ready",
        audienceRevision,
        planRevision: preparation.preparationDigest,
        ...(input.observedPlanRevision
          ? {
              planChanged:
                input.observedPlanRevision !== preparation.preparationDigest,
            }
          : {}),
        policy: recipientPolicy,
        requestedTotal: rows.length,
        acceptedTotal,
        skippedByReason,
        warnings: preparation.whatsappPolicyFacts?.outcome.warnings ?? {
          missingMarketingConsent: 0,
        },
        allExcluded: rows.length > 0 && acceptedTotal === 0,
        ...(preparation.whatsappPolicyFacts
          ? {
              whatsapp: {
                requestedTotal:
                  preparation.whatsappPolicyFacts.outcome.requestedTotal,
                acceptedTotal:
                  preparation.whatsappPolicyFacts.outcome.acceptedTotal,
                uniqueRecipients:
                  preparation.whatsappPolicyFacts.outcome.uniqueRecipients,
                skippedByReason:
                  preparation.whatsappPolicyFacts.outcome.skippedByReason,
              },
            }
          : {}),
      },
    };
  } catch (error) {
    // The eligibility route answers these like the recipient check: a coded
    // blocked body, Retry-After for a Meta rate limit, and the cause logged.
    if (error instanceof BulkCampaignEligibilityError) throw error;
    const caught = queueError(error);
    if (caught) {
      return {
        status: caught.httpStatus,
        body: {
          state: caught.body.retryable === false ? "blocked" : "unavailable",
          ...caught.body,
        },
      };
    }
    if (
      error instanceof GeneratedBulkRecipientPolicyUnsupportedError ||
      isUnsupportedGeneratedPolicyCapability(error, recipientPolicy)
    ) {
      const unsupported =
        error instanceof GeneratedBulkRecipientPolicyUnsupportedError
          ? error
          : new GeneratedBulkRecipientPolicyUnsupportedError();
      return {
        status: 409,
        body: {
          state: "unavailable",
          code: unsupported.code,
          error: unsupported.message,
        },
      };
    }
    return {
      status: 409,
      body: {
        state: "unavailable",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
