import {
  isBulkDispatchPayloadStoreConfigured,
  storeBulkCampaignDispatchItems,
} from "@icecore/shared/lib/bulk-dispatch-payload-store";
import { isWorkflowAlreadyStartedError } from "@icecore/shared/lib/temporal-errors";
import type {
  BulkCampaignDispatchBatchPlan,
  BulkCampaignDispatchItem,
  BulkCampaignDispatchLifecycleState,
} from "@icecore/temporal";
import {
  BULK_CAMPAIGN_DISPATCH_WORKFLOW_CONTRACT_VERSION,
  buildBulkCampaignDispatchLogicalRecipientKey,
  buildBulkCampaignDispatchWorkflowId as buildSharedBulkCampaignDispatchWorkflowId,
} from "@icecore/temporal";
import type { BulkCampaignDispatchExecutionSource } from "@icecore/scenario-contracts";

import {
  admitBulkCampaign,
  BulkCampaignAdmissionError,
  BulkCampaignAdmissionPayloadMismatchError,
  BulkCampaignAdmissionUnavailableError,
  lookupAdmittedBulkCampaignReplay,
  sanitizeBulkCampaignDispatchSnapshot,
  type AdmittedBulkCampaignReplay,
  type BulkCampaignAdmissionClient,
  type BulkCampaignAdmissionOverlap,
  type BulkCampaignAudienceAdmissionMetadata,
  type BulkCampaignPolicyAdmissionMetadata,
} from "./bulk-campaign-admission";
import { buildBulkCampaignOverflowQueuePlan } from "./bulk-campaign-overflow-queue";
import {
  AdmittedCampaignLedgerRecoveryAmbiguousError,
  recoverAdmittedCampaignDispatch,
} from "./admitted-campaign-ledger-recovery";
import { createPreparedBulkCampaignContentHash } from "./bulk-campaign-content-hash";
import type {
  BulkCampaignAudienceUploadEvidence,
  BulkCampaignChannel,
} from "./bulk-campaign-contracts";
import {
  BULK_CAMPAIGN_AUDIENCE_HASH_VERSION,
  createBulkCampaignAudienceFingerprintFromRecipientHashes,
  getBulkCampaignDispatchExpiresAt,
  hashBulkCampaignRecipientIdentity,
  isBulkCampaignDispatchExpired,
} from "./bulk-campaign-safety";
import {
  emitCampaignHistoryCreatedUsageBestEffort,
  failCampaignDispatchBeforeStart,
  type CampaignExecutionSource,
  type CampaignStoreClient,
} from "./campaign-history-store";
import { ensureBulkDispatchGcsAuth } from "./ensure-bulk-dispatch-gcs";
import {
  COMPANY_BULK_CAMPAIGN_LIMIT_EXCEEDED_CODE,
  COMPANY_BULK_RECIPIENT_LIMIT_EXCEEDED_ERROR,
  type CompanySubscriptionType,
} from "@/lib/limits/company-limits";
import { startBulkCampaignDispatchWorkflow } from "@/lib/temporal/bulk-campaign-dispatch";

const TEMPORAL_INLINE_WORKFLOW_PAYLOAD_BYTE_LIMIT = 900_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type BulkCampaignQueueStoreClient = CampaignStoreClient &
  BulkCampaignAdmissionClient;

export type PreparedBulkCampaignQueueErrorBody = {
  code: string;
  error: string;
  retryable?: boolean;
  campaignId?: string;
  dispatchId?: string;
  status?: "failed";
  audience?: {
    fingerprint: string;
    requestedTotal: number;
    queuedTotal: number;
    skippedOptIn: number;
    overlap?: BulkCampaignAdmissionOverlap;
  };
  audienceConfirmation?: {
    required: boolean;
    confirmed: boolean;
    fingerprint: string;
  };
  providerCircuit?: {
    state: "open";
    provider: string;
    code: string;
    failureCount: number;
    requiresAcknowledgement: true;
  };
};

export class PreparedBulkCampaignQueueError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly body: PreparedBulkCampaignQueueErrorBody
  ) {
    super(body.error);
    this.name = "PreparedBulkCampaignQueueError";
  }
}

export function createPreparedBulkCampaignTerminalReplayError(input: {
  campaignId: string;
  dispatchStatus: Extract<
    BulkCampaignDispatchLifecycleState,
    "completed" | "failed" | "expired" | "cancelled"
  >;
}): PreparedBulkCampaignQueueError {
  return new PreparedBulkCampaignQueueError(409, {
    code: "bulk_campaign_terminal_replay",
    error: `This campaign is already ${input.dispatchStatus} and cannot be queued again.`,
    retryable: false,
    campaignId: input.campaignId,
    dispatchId: input.campaignId,
  });
}

export type QueuePreparedBulkCampaignDispatchInput = {
  storeClient: BulkCampaignQueueStoreClient;
  fingerprintSecret: string;
  campaignId: string;
  workspaceId: string;
  channel: BulkCampaignChannel;
  campaignName: string;
  templateName: string | null;
  templateLanguage: string | null;
  messageText: string | null;
  sentBy: string;
  scenarioId: string | null;
  scenarioNodeId: string | null;
  executionSource: BulkCampaignDispatchExecutionSource;
  /** Immutable parent-command time. Omit only for a brand-new direct send. */
  requestedAt?: string | null;
  scheduledAt: string | null;
  batchPlan: BulkCampaignDispatchBatchPlan;
  items: BulkCampaignDispatchItem[];
  audienceSourceType: string;
  audienceUploadEvidence?: BulkCampaignAudienceUploadEvidence;
  policyMetadata?: BulkCampaignPolicyAdmissionMetadata;
  audienceConfirmationFingerprint?: string | null;
  requestedTotal: number;
  skippedOptIn: number;
  retryOfCampaignId?: string | null;
  retryKind?: "failed_only" | "send_again" | null;
  companyBulkCampaignLimit: number | null;
  companySubscriptionType: CompanySubscriptionType;
  /** Server-owned retry/resend intent; binds confirmation after fingerprinting. */
  confirmAudience?: boolean;
  providerCircuitAcknowledgement?: {
    acknowledgedBy: string;
  } | null;
};

export function buildBulkCampaignAudienceAdmissionMetadata(input: {
  audienceUploadEvidence?: BulkCampaignAudienceUploadEvidence;
  contentHash: string;
  sentBy: string;
  policyMetadata?: BulkCampaignPolicyAdmissionMetadata;
}): BulkCampaignAudienceAdmissionMetadata {
  const replacementHistory = (
    input.audienceUploadEvidence?.replacementHistory || []
  ).map(event => ({
    ...event,
    replacedBy: input.sentBy,
  }));
  return {
    originalFilename: input.audienceUploadEvidence?.originalFilename || null,
    uploadedAt: input.audienceUploadEvidence?.selectedAt || null,
    uploadedBy: input.audienceUploadEvidence ? input.sentBy : null,
    contentHash: input.contentHash,
    replacementHistory,
    ...input.policyMetadata,
  };
}

export type QueuedPreparedBulkCampaignDispatch = {
  campaignId: string;
  dispatchId: string;
  workflowId: string;
  status: BulkCampaignDispatchLifecycleState;
  requestedAt: string;
  dispatchExpiresAt: string;
  temporalDispatchStaging: "inline" | "gcs" | "existing";
  idempotentReplay: boolean;
  total: number;
  queuedGeneratedRecipientMessageIds: string[];
  audience: {
    fingerprint: string;
    requestedTotal: number;
    queuedTotal: number;
    skippedOptIn: number;
    overlap?: BulkCampaignAdmissionOverlap;
  };
  audienceConfirmation: {
    required: boolean;
    confirmed: boolean;
    fingerprint: string;
  };
};

export type PreparedBulkCampaignGeneratedProjectionExclusion = {
  generatedRecipientMessageId: string;
  reason: "invalid_recipient_identity";
};

export type NormalizedPreparedBulkCampaignQueueItems = {
  items: BulkCampaignDispatchItem[];
  snapshotSeeds: Array<{
    recipientHash: string;
    snapshotOrdinal: number;
    recipient: string;
    dispatchSnapshot: Record<string, unknown>;
  }>;
  queuedGeneratedRecipientMessageIds: string[];
  excludedGeneratedRecipientMessages: PreparedBulkCampaignGeneratedProjectionExclusion[];
};

export type PreparedBulkCampaignDispatchTiming = {
  requestedAt: string;
  dispatchExpiresAt: string;
  expired: boolean;
};

export type EnsureAdmittedPreparedBulkCampaignDispatchStartedInput = {
  storeClient: CampaignStoreClient;
  workspaceId: string;
  campaignId: string;
  dispatchStatus: BulkCampaignDispatchLifecycleState;
  requestedAt: string;
  scheduledAt: string | null;
  dispatchExpiresAt: string;
  batchPlan: BulkCampaignDispatchBatchPlan;
  /** Immutable, sanitized dispatch snapshots persisted by SQL admission. */
  items: BulkCampaignDispatchItem[];
  now?: Date;
};

export type EnsuredAdmittedPreparedBulkCampaignDispatchStart =
  | {
      status: "started" | "already_started";
      temporalDispatchStaging: "inline" | "gcs" | "existing";
    }
  | {
      status: "already_active";
      dispatchStatus: "running";
      temporalDispatchStaging: "existing";
    }
  | {
      status: "terminal";
      dispatchStatus: Extract<
        BulkCampaignDispatchLifecycleState,
        "completed" | "failed" | "expired" | "cancelled"
      >;
      temporalDispatchStaging: "existing";
    };

function buildAggregateAudience(params: {
  fingerprint: string;
  requestedTotal: number;
  queuedTotal: number;
  skippedOptIn: number;
  overlap?: BulkCampaignAdmissionOverlap;
}) {
  return {
    fingerprint: params.fingerprint,
    requestedTotal: params.requestedTotal,
    queuedTotal: params.queuedTotal,
    skippedOptIn: params.skippedOptIn,
    ...(params.overlap ? { overlap: params.overlap } : {}),
  };
}

async function failAdmittedDispatch(params: {
  storeClient: CampaignStoreClient;
  campaignId: string;
  stopReason:
    | "payload_staging_unavailable"
    | "payload_staging_failed"
    | "workflow_start_failed"
    | "dispatch_expired_before_start";
}): Promise<boolean> {
  try {
    return await failCampaignDispatchBeforeStart({
      supabase: params.storeClient,
      campaignId: params.campaignId,
      stopReason: params.stopReason,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Failed to terminalize bulk campaign before start", {
      campaignId: params.campaignId,
      stopReason: params.stopReason,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function preStartFailureBody(params: {
  campaignId: string;
  code: string;
  error: string;
  terminalized: boolean;
}): PreparedBulkCampaignQueueErrorBody {
  if (!params.terminalized) {
    return {
      code: "bulk_campaign_prestart_cleanup_failed",
      error:
        "Bulk campaign could not be queued and its safety reservation could not be released. Contact support before retrying.",
      campaignId: params.campaignId,
      dispatchId: params.campaignId,
    };
  }
  return {
    code: params.code,
    error: params.error,
    campaignId: params.campaignId,
    dispatchId: params.campaignId,
    status: "failed",
  };
}

export function resolvePreparedBulkCampaignDispatchTiming(params: {
  requestedAt?: string | null;
  scheduledAt?: string | null;
  now?: Date;
}): PreparedBulkCampaignDispatchTiming {
  const now = params.now ?? new Date();
  const requestedAtValue = params.requestedAt
    ? new Date(params.requestedAt)
    : now;
  if (!Number.isFinite(requestedAtValue.getTime())) {
    throw new PreparedBulkCampaignQueueError(500, {
      code: "bulk_campaign_request_time_invalid",
      error: "Bulk campaign request timing is invalid.",
    });
  }
  const requestedAt = requestedAtValue.toISOString();
  let dispatchExpiresAt: string;
  try {
    dispatchExpiresAt = getBulkCampaignDispatchExpiresAt({
      requestedAt,
      scheduledAt: params.scheduledAt,
    });
  } catch {
    throw new PreparedBulkCampaignQueueError(400, {
      code: "bulk_campaign_schedule_invalid",
      error: "Bulk campaign schedule is invalid.",
    });
  }
  return {
    requestedAt,
    dispatchExpiresAt,
    expired: isBulkCampaignDispatchExpired({ dispatchExpiresAt, now }),
  };
}

/**
 * Canonical queue identity boundary. Producers that persist an assignment
 * before admission must use this exact result, so Mongo ownership and the
 * immutable SQL snapshots cannot disagree about invalid or duplicate rows.
 */
export function normalizePreparedBulkCampaignQueueItems(
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
): NormalizedPreparedBulkCampaignQueueItems {
  if (!UUID_PATTERN.test(input.campaignId)) {
    throw new PreparedBulkCampaignQueueError(500, {
      code: "bulk_campaign_identity_invalid",
      error: "Bulk campaign identity could not be created.",
    });
  }
  if (!input.fingerprintSecret.trim()) {
    throw new PreparedBulkCampaignQueueError(503, {
      code: "bulk_campaign_safety_unavailable",
      error: "Bulk campaign safety is not configured.",
    });
  }

  const items: BulkCampaignDispatchItem[] = [];
  const snapshotSeeds: NormalizedPreparedBulkCampaignQueueItems["snapshotSeeds"] =
    [];
  const queuedGeneratedRecipientMessageIds: string[] = [];
  const excludedGeneratedRecipientMessages: PreparedBulkCampaignGeneratedProjectionExclusion[] =
    [];
  const strictFailedOnlyRetry = input.retryKind === "failed_only";

  for (const item of input.items) {
    if (item.channel !== input.channel) {
      throw new PreparedBulkCampaignQueueError(409, {
        code: strictFailedOnlyRetry
          ? "invalid_retry_snapshot"
          : "bulk_campaign_mixed_channel_unsupported",
        error: strictFailedOnlyRetry
          ? "Campaign failed-recipient snapshots cannot be retried safely."
          : "Queue each campaign channel separately so audience safety can be enforced.",
      });
    }
    const normalizedItem = {
      ...item,
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      sentByUserId: input.sentBy,
      snapshotOrdinal: items.length,
    } as BulkCampaignDispatchItem;
    const itemChannel = normalizedItem.channel as BulkCampaignChannel;
    const logicalRecipientKey =
      buildBulkCampaignDispatchLogicalRecipientKey(normalizedItem);
    const generatedRecipientMessageId =
      normalizedItem.generatedRecipientMessageId?.trim() || null;
    if (!logicalRecipientKey) {
      if (strictFailedOnlyRetry) {
        throw new PreparedBulkCampaignQueueError(409, {
          code: "invalid_retry_snapshot",
          error:
            "Campaign failed-recipient snapshots cannot be retried safely.",
        });
      }
      if (generatedRecipientMessageId) {
        excludedGeneratedRecipientMessages.push({
          generatedRecipientMessageId,
          reason: "invalid_recipient_identity",
        });
      }
      continue;
    }
    const recipientHash = hashBulkCampaignRecipientIdentity({
      secret: input.fingerprintSecret,
      workspaceId: input.workspaceId,
      channel: itemChannel,
      identity: logicalRecipientKey,
    });
    items.push(normalizedItem);
    snapshotSeeds.push({
      recipientHash,
      snapshotOrdinal: normalizedItem.snapshotOrdinal!,
      recipient: logicalRecipientKey,
      dispatchSnapshot: sanitizeBulkCampaignDispatchSnapshot(
        normalizedItem as unknown as Record<string, unknown>
      ),
    });
    if (generatedRecipientMessageId) {
      queuedGeneratedRecipientMessageIds.push(generatedRecipientMessageId);
    }
  }

  return {
    items,
    snapshotSeeds,
    queuedGeneratedRecipientMessageIds,
    excludedGeneratedRecipientMessages,
  };
}

/**
 * Queue-owned post-admission boundary. SQL admission is durable before this
 * runs, so every caller (including crash recovery) must use this operation to
 * stage the immutable payload and start the deterministic Temporal workflow.
 */
export async function ensureAdmittedPreparedBulkCampaignDispatchStarted(
  input: EnsureAdmittedPreparedBulkCampaignDispatchStartedInput
): Promise<EnsuredAdmittedPreparedBulkCampaignDispatchStart> {
  if (
    input.dispatchStatus === "completed" ||
    input.dispatchStatus === "failed" ||
    input.dispatchStatus === "expired" ||
    input.dispatchStatus === "cancelled"
  ) {
    return {
      status: "terminal",
      dispatchStatus: input.dispatchStatus,
      temporalDispatchStaging: "existing",
    };
  }
  if (input.dispatchStatus === "running") {
    return {
      status: "already_active",
      dispatchStatus: "running",
      temporalDispatchStaging: "existing",
    };
  }

  const requestedAt = new Date(input.requestedAt);
  const dispatchExpiresAt = new Date(input.dispatchExpiresAt);
  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
  if (
    !UUID_PATTERN.test(input.campaignId) ||
    !input.workspaceId.trim() ||
    !Number.isFinite(requestedAt.getTime()) ||
    !Number.isFinite(dispatchExpiresAt.getTime()) ||
    dispatchExpiresAt.getTime() <= requestedAt.getTime() ||
    (scheduledAt && !Number.isFinite(scheduledAt.getTime())) ||
    input.items.length === 0 ||
    input.items.some(
      item =>
        item.workspaceId !== input.workspaceId ||
        item.campaignId !== input.campaignId
    )
  ) {
    throw new PreparedBulkCampaignQueueError(500, {
      code: "bulk_campaign_admitted_payload_invalid",
      error: "The admitted bulk campaign payload is invalid.",
      campaignId: input.campaignId,
      dispatchId: input.campaignId,
    });
  }

  const now = input.now ?? new Date();
  if (
    isBulkCampaignDispatchExpired({
      dispatchExpiresAt: input.dispatchExpiresAt,
      now,
    })
  ) {
    const terminalized = await failAdmittedDispatch({
      storeClient: input.storeClient,
      campaignId: input.campaignId,
      stopReason: "dispatch_expired_before_start",
    });
    throw new PreparedBulkCampaignQueueError(
      terminalized ? 409 : 503,
      preStartFailureBody({
        campaignId: input.campaignId,
        code: "bulk_campaign_dispatch_expired",
        error:
          "This bulk campaign command expired before dispatch could start. Create a fresh campaign instead.",
        terminalized,
      })
    );
  }

  const inlineWorkflowEnvelope = {
    contractVersion: BULK_CAMPAIGN_DISPATCH_WORKFLOW_CONTRACT_VERSION,
    lifecycleManaged: true,
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    requestedAt: input.requestedAt,
    scheduledAt: input.scheduledAt,
    dispatchExpiresAt: input.dispatchExpiresAt,
    batchPlan: input.batchPlan,
    items: input.items,
  };
  const usePayloadStaging =
    Buffer.byteLength(JSON.stringify(inlineWorkflowEnvelope), "utf8") >
    TEMPORAL_INLINE_WORKFLOW_PAYLOAD_BYTE_LIMIT;
  let temporalDispatchStaging: "inline" | "gcs" = "inline";
  let workflowDispatchInput:
    | { items: BulkCampaignDispatchItem[] }
    | { itemsPayloadKey: string; itemCount: number } = { items: input.items };

  if (usePayloadStaging) {
    if (!isBulkDispatchPayloadStoreConfigured()) {
      const terminalized = await failAdmittedDispatch({
        storeClient: input.storeClient,
        campaignId: input.campaignId,
        stopReason: "payload_staging_unavailable",
      });
      throw new PreparedBulkCampaignQueueError(
        terminalized ? 413 : 503,
        preStartFailureBody({
          campaignId: input.campaignId,
          code: "bulk_campaign_payload_staging_unavailable",
          error:
            "This bulk campaign is too large to queue because payload staging is unavailable.",
          terminalized,
        })
      );
    }

    try {
      ensureBulkDispatchGcsAuth();
      const overflowPlan = buildBulkCampaignOverflowQueuePlan({
        recipientCount: input.items.length,
        dailyLimit: input.batchPlan.dailyWaveLimit || 0,
        startAt: input.scheduledAt || new Date().toISOString(),
      });
      const stored = await storeBulkCampaignDispatchItems({
        workspaceId: input.workspaceId,
        items: input.items,
        retainUntil: overflowPlan.lastWaveAt || input.scheduledAt,
      });
      temporalDispatchStaging = "gcs";
      workflowDispatchInput = {
        itemsPayloadKey: stored.payloadKey,
        itemCount: input.items.length,
      };
    } catch (error) {
      const terminalized = await failAdmittedDispatch({
        storeClient: input.storeClient,
        campaignId: input.campaignId,
        stopReason: "payload_staging_failed",
      });
      const message = error instanceof Error ? error.message : String(error);
      throw new PreparedBulkCampaignQueueError(
        terminalized && message.includes("too large") ? 413 : 503,
        preStartFailureBody({
          campaignId: input.campaignId,
          code: "bulk_campaign_payload_staging_failed",
          error: message.includes("too large")
            ? message
            : "Failed to stage bulk campaign payload. Try again.",
          terminalized,
        })
      );
    }
  }

  try {
    await startBulkCampaignDispatchWorkflow({
      lifecycleManaged: true,
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      requestedAt: input.requestedAt,
      dispatchExpiresAt: input.dispatchExpiresAt,
      batchPlan: input.batchPlan,
      scheduledAt: input.scheduledAt,
      ...(typeof input.batchPlan.dailyWaveLimit === "number"
        ? { dailyWaveLimit: input.batchPlan.dailyWaveLimit }
        : {}),
      ...workflowDispatchInput,
    });
  } catch (error) {
    if (isWorkflowAlreadyStartedError(error)) {
      return {
        status: "already_started",
        temporalDispatchStaging: "existing",
      };
    }
    // Temporal start is an ambiguous boundary: the request can succeed before
    // its response is lost. Keep SQL admission recoverable and retry the same
    // deterministic workflow ID instead of falsely terminalizing the campaign.
    throw new PreparedBulkCampaignQueueError(503, {
      code: "bulk_campaign_workflow_start_unconfirmed",
      error:
        "Bulk campaign workflow start is not confirmed yet. Recovery can safely retry.",
      retryable: true,
      campaignId: input.campaignId,
      dispatchId: input.campaignId,
    });
  }

  return {
    status: "started",
    temporalDispatchStaging,
  };
}

type RecoveredAdmittedPreparedBulkCampaignDispatch = {
  workflowStart: EnsuredAdmittedPreparedBulkCampaignDispatchStart;
  admittedItems: BulkCampaignDispatchItem[];
  requestedAt: string;
  scheduledAt: string | null;
  dispatchExpiresAt: string;
};

async function recoverAndStartAdmittedPreparedBulkCampaignDispatch(input: {
  storeClient: CampaignStoreClient;
  workspaceId: string;
  campaignId: string;
  dispatchStatus: BulkCampaignDispatchLifecycleState;
  requestedAt: string;
  scheduledAt: string | null;
  dispatchExpiresAt: string;
  batchPlan: BulkCampaignDispatchBatchPlan;
  expectedRecipientCount: number;
  maxRecipients: number;
  expectedChannel: BulkCampaignChannel;
  expectedScenarioId: string | null;
  expectedScenarioNodeId: string | null;
  expectedExecutionSource: BulkCampaignDispatchExecutionSource;
  expectedAudienceSourceType?: string;
}): Promise<RecoveredAdmittedPreparedBulkCampaignDispatch> {
  if (
    input.dispatchStatus !== "queued" &&
    input.dispatchStatus !== "scheduled"
  ) {
    const workflowStart =
      await ensureAdmittedPreparedBulkCampaignDispatchStarted({
        storeClient: input.storeClient,
        workspaceId: input.workspaceId,
        campaignId: input.campaignId,
        dispatchStatus: input.dispatchStatus,
        requestedAt: input.requestedAt,
        scheduledAt: input.scheduledAt,
        dispatchExpiresAt: input.dispatchExpiresAt,
        batchPlan: input.batchPlan,
        items: [],
      });
    return {
      workflowStart,
      admittedItems: [],
      requestedAt: input.requestedAt,
      scheduledAt: input.scheduledAt,
      dispatchExpiresAt: input.dispatchExpiresAt,
    };
  }

  let recovered;
  try {
    recovered = await recoverAdmittedCampaignDispatch({
      supabase: input.storeClient,
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      expectedRecipientCount: input.expectedRecipientCount,
      maxRecipients: input.maxRecipients,
      expectedChannel: input.expectedChannel,
      expectedScenarioId: input.expectedScenarioId,
      expectedScenarioNodeId: input.expectedScenarioNodeId,
      expectedExecutionSource: input.expectedExecutionSource,
      expectedAudienceSourceType: input.expectedAudienceSourceType,
    });
  } catch (error) {
    if (error instanceof AdmittedCampaignLedgerRecoveryAmbiguousError) {
      throw new PreparedBulkCampaignQueueError(503, {
        code: "bulk_campaign_admitted_payload_ambiguous",
        error:
          "The admitted bulk campaign payload could not be verified for recovery.",
        retryable: true,
        campaignId: input.campaignId,
        dispatchId: input.campaignId,
      });
    }
    throw error;
  }
  if (recovered.status !== "admitted") {
    throw new PreparedBulkCampaignQueueError(503, {
      code: "bulk_campaign_admitted_payload_unavailable",
      error:
        "The admitted bulk campaign payload is not available for recovery.",
      retryable: true,
      campaignId: input.campaignId,
      dispatchId: input.campaignId,
    });
  }

  const workflowStart = await ensureAdmittedPreparedBulkCampaignDispatchStarted(
    {
      storeClient: input.storeClient,
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      dispatchStatus: recovered.campaign.dispatchStatus,
      requestedAt: recovered.campaign.requestedAt,
      scheduledAt: recovered.campaign.scheduledAt,
      dispatchExpiresAt: recovered.campaign.dispatchExpiresAt,
      batchPlan: input.batchPlan,
      items: recovered.admittedItems,
    }
  );
  return {
    workflowStart,
    admittedItems: recovered.admittedItems,
    requestedAt: recovered.campaign.requestedAt,
    scheduledAt: recovered.campaign.scheduledAt,
    dispatchExpiresAt: recovered.campaign.dispatchExpiresAt,
  };
}

/**
 * Authenticated cache-miss replay boundary. The strict replay projection owns
 * the immutable plan while the ledger owns items and command timing.
 */
export async function ensureAdmittedBulkCampaignReplayStarted(input: {
  storeClient: CampaignStoreClient;
  replay: AdmittedBulkCampaignReplay;
}): Promise<RecoveredAdmittedPreparedBulkCampaignDispatch> {
  return recoverAndStartAdmittedPreparedBulkCampaignDispatch({
    storeClient: input.storeClient,
    workspaceId: input.replay.workspaceId,
    campaignId: input.replay.campaignId,
    dispatchStatus: input.replay.dispatchStatus,
    requestedAt: input.replay.requestedAt,
    scheduledAt: input.replay.scheduledAt,
    dispatchExpiresAt: input.replay.dispatchExpiresAt,
    batchPlan: input.replay.batchPlan,
    expectedRecipientCount: input.replay.totalRecipients,
    maxRecipients: input.replay.totalRecipients,
    expectedChannel: input.replay.channel,
    expectedScenarioId: input.replay.scenarioId,
    expectedScenarioNodeId: input.replay.rootNodeId,
    expectedExecutionSource: input.replay.executionSource,
  });
}

export async function queuePreparedBulkCampaignDispatch(
  input: QueuePreparedBulkCampaignDispatchInput
): Promise<QueuedPreparedBulkCampaignDispatch> {
  const normalizedItems = normalizePreparedBulkCampaignQueueItems(input);
  const dispatchItems = normalizedItems.items;
  const snapshotSeeds = normalizedItems.snapshotSeeds;

  if (dispatchItems.length === 0) {
    throw new PreparedBulkCampaignQueueError(400, {
      code: "bulk_campaign_no_valid_recipients",
      error: "No valid recipients remain for this campaign.",
    });
  }
  const queuedGeneratedRecipientMessageIds =
    normalizedItems.queuedGeneratedRecipientMessageIds;

  const timing = resolvePreparedBulkCampaignDispatchTiming({
    requestedAt: input.requestedAt,
    scheduledAt: input.scheduledAt,
  });
  if (timing.expired) {
    throw new PreparedBulkCampaignQueueError(409, {
      code: "bulk_campaign_dispatch_expired",
      error:
        "This bulk campaign command is too old to start. Create a fresh campaign instead.",
    });
  }
  const { requestedAt, dispatchExpiresAt } = timing;
  const dispatchStatus = input.scheduledAt ? "scheduled" : "queued";
  const workflowId = buildSharedBulkCampaignDispatchWorkflowId({
    workspaceId: input.workspaceId,
    executionId: input.campaignId,
  });
  const fingerprint = createBulkCampaignAudienceFingerprintFromRecipientHashes({
    secret: input.fingerprintSecret,
    workspaceId: input.workspaceId,
    channel: input.channel,
    recipientHashes: snapshotSeeds.map(snapshot => snapshot.recipientHash),
  });
  const snapshots = snapshotSeeds;
  const contentHash = createPreparedBulkCampaignContentHash(snapshots);

  let admission;
  let canonicalAdmittedReplay: AdmittedBulkCampaignReplay | null = null;
  const confirmationFingerprint = input.confirmAudience
    ? fingerprint
    : input.audienceConfirmationFingerprint || null;
  try {
    admission = await admitBulkCampaign(input.storeClient, {
      fingerprintSecret: input.fingerprintSecret,
      campaignId: input.campaignId,
      workspaceId: input.workspaceId,
      channel: input.channel,
      name: input.campaignName,
      templateName: input.templateName,
      templateLanguage: input.templateLanguage,
      messageText: input.messageText,
      sentBy: input.sentBy,
      scenarioId: input.scenarioId,
      scenarioNodeId: input.scenarioNodeId,
      executionSource: input.executionSource,
      workflowId,
      dispatchStatus,
      requestedAt,
      scheduledAt: input.scheduledAt,
      dispatchExpiresAt,
      audience: {
        fingerprint,
        hashVersion: BULK_CAMPAIGN_AUDIENCE_HASH_VERSION,
        sourceType: input.audienceSourceType,
        count: snapshots.length,
        metadata: buildBulkCampaignAudienceAdmissionMetadata({
          audienceUploadEvidence: input.audienceUploadEvidence,
          contentHash,
          sentBy: input.sentBy,
          policyMetadata: input.policyMetadata,
        }),
      },
      confirmationFingerprint,
      retryOfCampaignId: input.retryOfCampaignId || null,
      retryKind: input.retryKind || null,
      companyBulkCampaignLimit: input.companyBulkCampaignLimit,
      companySubscriptionType: input.companySubscriptionType,
      providerCircuitAcknowledgedBy:
        input.providerCircuitAcknowledgement?.acknowledgedBy ?? null,
      snapshots,
    });
    if (
      admission.status === "admitted" &&
      admission.idempotentReplay &&
      (admission.dispatchStatus === "queued" ||
        admission.dispatchStatus === "scheduled") &&
      input.policyMetadata?.requestDigest
    ) {
      canonicalAdmittedReplay = await lookupAdmittedBulkCampaignReplay({
        client: input.storeClient,
        campaignId: admission.campaignId,
        workspaceId: input.workspaceId,
        sentBy: input.sentBy,
        requestDigest: input.policyMetadata.requestDigest,
      });
      if (!canonicalAdmittedReplay) {
        throw new BulkCampaignAdmissionUnavailableError(
          "Persisted bulk campaign replay is unavailable after idempotent admission"
        );
      }
    }
  } catch (error) {
    if (error instanceof BulkCampaignAdmissionPayloadMismatchError) {
      throw new PreparedBulkCampaignQueueError(409, {
        code: "bulk_campaign_idempotency_payload_mismatch",
        error: "This idempotency key is already bound to a different request.",
        retryable: false,
      });
    }
    if (error instanceof BulkCampaignAdmissionUnavailableError) {
      throw new PreparedBulkCampaignQueueError(503, {
        code: "bulk_campaign_admission_unavailable",
        error: "Bulk campaign safety is temporarily unavailable.",
        retryable: true,
      });
    }
    if (error instanceof BulkCampaignAdmissionError) {
      throw new PreparedBulkCampaignQueueError(500, {
        code: "bulk_campaign_admission_failed",
        error: "Bulk campaign could not be admitted safely.",
      });
    }
    throw error;
  }

  const audience = buildAggregateAudience({
    fingerprint,
    requestedTotal: input.requestedTotal,
    queuedTotal: dispatchItems.length,
    skippedOptIn: input.skippedOptIn,
    overlap: "overlap" in admission ? admission.overlap : undefined,
  });

  if (admission.status === "blocked") {
    if (admission.code === COMPANY_BULK_CAMPAIGN_LIMIT_EXCEEDED_CODE) {
      throw new PreparedBulkCampaignQueueError(402, {
        code: COMPANY_BULK_CAMPAIGN_LIMIT_EXCEEDED_CODE,
        error: COMPANY_BULK_RECIPIENT_LIMIT_EXCEEDED_ERROR,
        retryable: false,
      });
    }
    if (admission.code === "provider_circuit_acknowledgement_required") {
      throw new PreparedBulkCampaignQueueError(409, {
        code: admission.code,
        error:
          "Confirm that the provider problem was repaired before retrying.",
        providerCircuit: {
          ...admission.providerCircuit,
          requiresAcknowledgement: true,
        },
      });
    }
    const confirmationRequired =
      admission.code === "recent_audience_confirmation_required";
    throw new PreparedBulkCampaignQueueError(409, {
      code: confirmationRequired
        ? "bulk_campaign_recent_audience_confirmation_required"
        : "bulk_campaign_active_audience_overlap",
      error: confirmationRequired
        ? "Confirm sending to this recent audience again."
        : "Another active campaign already targets this audience.",
      audience,
      ...(confirmationRequired
        ? {
            audienceConfirmation: {
              required: true,
              confirmed: false,
              fingerprint,
            },
          }
        : {}),
    });
  }
  if (admission.status === "conflict") {
    if (admission.code === "company_plan_changed") {
      throw new PreparedBulkCampaignQueueError(409, {
        code: "company_plan_changed",
        error:
          "Your company plan changed while the campaign was queued. Retry.",
        retryable: true,
        audience,
      });
    }
    throw new PreparedBulkCampaignQueueError(409, {
      code: "bulk_campaign_admission_lock_busy",
      error: "Another campaign is being queued. Try again.",
      retryable: true,
      audience,
    });
  }

  const sameCampaignReplay =
    admission.idempotentReplay && admission.campaignId === input.campaignId;
  const replayIsTerminal =
    admission.idempotentReplay &&
    !["queued", "scheduled", "running"].includes(admission.dispatchStatus);
  if (replayIsTerminal) {
    throw createPreparedBulkCampaignTerminalReplayError({
      campaignId: admission.campaignId,
      dispatchStatus: admission.dispatchStatus as Extract<
        BulkCampaignDispatchLifecycleState,
        "completed" | "failed" | "expired" | "cancelled"
      >,
    });
  }
  if (
    admission.idempotentReplay &&
    admission.dispatchStatus === "running" &&
    !sameCampaignReplay
  ) {
    const confirmationRequired =
      input.confirmAudience === true ||
      admission.overlap?.kind === "exact" ||
      admission.overlap?.kind === "high" ||
      admission.overlap?.kind === "unknown";
    return {
      campaignId: admission.campaignId,
      dispatchId: admission.campaignId,
      workflowId: admission.workflowId,
      status: admission.dispatchStatus,
      requestedAt: admission.requestedAt,
      dispatchExpiresAt: admission.dispatchExpiresAt,
      temporalDispatchStaging: "existing",
      idempotentReplay: true,
      total: admission.audienceCount,
      queuedGeneratedRecipientMessageIds: [],
      audience,
      audienceConfirmation: {
        required: confirmationRequired,
        confirmed:
          confirmationRequired && confirmationFingerprint === fingerprint,
        fingerprint,
      },
    };
  }

  if (!admission.idempotentReplay) {
    emitCampaignHistoryCreatedUsageBestEffort({
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      channel: input.channel,
      executionSource: input.executionSource as CampaignExecutionSource,
      logContext: "queuePreparedBulkCampaignDispatch",
    });
  }

  const immutableDispatchItems = snapshots.map(
    snapshot => snapshot.dispatchSnapshot as unknown as BulkCampaignDispatchItem
  );
  let admittedGeneratedRecipientMessageIds = queuedGeneratedRecipientMessageIds;
  let workflowStart: EnsuredAdmittedPreparedBulkCampaignDispatchStart;
  if (
    admission.idempotentReplay &&
    (admission.dispatchStatus === "queued" ||
      admission.dispatchStatus === "scheduled")
  ) {
    const recovered = canonicalAdmittedReplay
      ? await ensureAdmittedBulkCampaignReplayStarted({
          storeClient: input.storeClient,
          replay: canonicalAdmittedReplay,
        })
      : await recoverAndStartAdmittedPreparedBulkCampaignDispatch({
          storeClient: input.storeClient,
          workspaceId: input.workspaceId,
          campaignId: admission.campaignId,
          dispatchStatus: admission.dispatchStatus,
          requestedAt: admission.requestedAt,
          scheduledAt: input.scheduledAt,
          dispatchExpiresAt: admission.dispatchExpiresAt,
          batchPlan: input.batchPlan,
          expectedRecipientCount: admission.audienceCount,
          // Legacy/generated callers have already materialized this bounded
          // audience. Preserve that existing zero-policy-key recovery path.
          maxRecipients: dispatchItems.length,
          expectedChannel: input.channel,
          expectedScenarioId: input.scenarioId,
          expectedScenarioNodeId: input.scenarioNodeId,
          expectedExecutionSource: input.executionSource,
          expectedAudienceSourceType: input.audienceSourceType,
        });
    workflowStart = recovered.workflowStart;
    admittedGeneratedRecipientMessageIds = recovered.admittedItems.flatMap(
      item => {
        const messageId = item.generatedRecipientMessageId?.trim();
        return messageId ? [messageId] : [];
      }
    );
  } else {
    workflowStart = await ensureAdmittedPreparedBulkCampaignDispatchStarted({
      storeClient: input.storeClient,
      workspaceId: input.workspaceId,
      campaignId: admission.campaignId,
      dispatchStatus: admission.dispatchStatus,
      requestedAt: admission.requestedAt,
      scheduledAt: input.scheduledAt,
      dispatchExpiresAt: admission.dispatchExpiresAt,
      batchPlan: input.batchPlan,
      items: immutableDispatchItems,
    });
  }

  if (workflowStart.status === "terminal") {
    throw createPreparedBulkCampaignTerminalReplayError({
      campaignId: admission.campaignId,
      dispatchStatus: workflowStart.dispatchStatus,
    });
  }

  const confirmationRequired =
    admission.overlap?.kind === "exact" ||
    admission.overlap?.kind === "high" ||
    admission.overlap?.kind === "unknown";
  return {
    campaignId: admission.campaignId,
    dispatchId: admission.campaignId,
    workflowId: admission.workflowId,
    status: admission.dispatchStatus,
    requestedAt: admission.requestedAt,
    dispatchExpiresAt: admission.dispatchExpiresAt,
    temporalDispatchStaging: workflowStart.temporalDispatchStaging,
    idempotentReplay: admission.idempotentReplay,
    total: admission.audienceCount,
    queuedGeneratedRecipientMessageIds: admittedGeneratedRecipientMessageIds,
    audience,
    audienceConfirmation: {
      required: confirmationRequired,
      confirmed:
        confirmationRequired && confirmationFingerprint === fingerprint,
      fingerprint,
    },
  };
}
