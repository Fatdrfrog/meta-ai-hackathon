import {
  BULK_CAMPAIGN_AUDIENCE_REPLACEMENT_HISTORY_LIMIT,
  BULK_CAMPAIGN_DISPATCH_EXECUTION_SOURCES,
  type BulkCampaignDispatchExecutionSource,
  type BulkCampaignRecipientPolicy,
  type BulkCampaignSkipReason,
} from "@icecore/scenario-contracts";
import { buildBulkCampaignDispatchWorkflowId } from "@icecore/temporal";
import {
  isCompanyBulkQuotaRefusal,
  isCompanySubscriptionType,
  type CompanySubscriptionType,
} from "@/lib/limits/company-limits";
import { isRecord } from "@icecore/shared/lib/value-utils";

import type {
  BulkCampaignChannel,
  BulkCampaignDispatchBatchPlan,
  BulkCampaignDispatchStatus,
} from "./bulk-campaign-contracts";
import { MAX_BULK_CAMPAIGN_RECIPIENTS } from "./bulk-campaign-contracts";
import {
  BULK_CAMPAIGN_AUDIENCE_HASH_VERSION,
  createBulkCampaignAudienceFingerprintFromRecipientHashes,
} from "./bulk-campaign-safety";
import {
  createBulkCampaignSuccessResult,
  serializeBulkCampaignCommandResult,
} from "./bulk-campaign-outcome";

const LOWERCASE_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_AUDIENCE_FILENAME_LENGTH = 512;

const SENSITIVE_SNAPSHOT_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "credential",
  "credentials",
  "password",
  "secret",
  "token",
]);
const SENSITIVE_SNAPSHOT_KEY_SUFFIXES = [
  "accesstoken",
  "apikey",
  "clientsecret",
  "credential",
  "credentials",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "token",
] as const;
// A WhatsApp Flow token is routing payload selected by the customer, not an
// API credential. It must remain in the immutable dispatch snapshot so a
// crash-recovered workflow sends the same approved button action.
const SAFE_SNAPSHOT_TOKEN_KEYS = new Set(["flowtoken"]);

type JsonPrimitive = boolean | number | string | null;
export type BulkCampaignSnapshotJson =
  | JsonPrimitive
  | BulkCampaignSnapshotJson[]
  | { [key: string]: BulkCampaignSnapshotJson };

export type BulkCampaignAdmissionRpcError = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
};

export type BulkCampaignAdmissionClient = {
  rpc: (
    functionName: "admit_bulk_campaign",
    args: Record<string, unknown>
  ) => PromiseLike<{
    data: unknown;
    error: BulkCampaignAdmissionRpcError | null;
  }>;
};

type BulkCampaignReplayStoreError = {
  code?: string | null;
  message?: string | null;
};

type BulkCampaignReplayStoreResult = {
  data?: Record<string, unknown> | null;
  error?: BulkCampaignReplayStoreError | null;
};

type BulkCampaignReplayQuery = {
  eq: (column: string, value: string) => BulkCampaignReplayQuery;
  maybeSingle: () => PromiseLike<BulkCampaignReplayStoreResult>;
};

export type BulkCampaignReplayLookupClient = {
  from: (table: string) => unknown;
};

type BulkCampaignReplayTable = {
  select: (columns: string) => BulkCampaignReplayQuery;
};

export type AdmittedBulkCampaignReplay = {
  campaignId: string;
  workspaceId: string;
  result: Record<string, unknown>;
  batchPlan: BulkCampaignDispatchBatchPlan;
  dispatchStatus: BulkCampaignDispatchStatus;
  requestedAt: string;
  scheduledAt: string | null;
  dispatchExpiresAt: string;
  totalRecipients: number;
  channel: BulkCampaignChannel;
  messageKind: "template" | "service_text" | "telegram" | "email";
  executionSource: BulkCampaignDispatchExecutionSource;
  scenarioId: string | null;
  rootNodeId: string | null;
  planLimit: Pick<BulkCampaignAuthoritativeRecipientLimit, "source" | "value">;
  policy: BulkCampaignRecipientPolicy;
};

export type BulkCampaignAudienceAdmissionMetadata = {
  originalFilename?: string | null;
  uploadedAt?: string | null;
  uploadedBy?: string | null;
  contentHash?: string | null;
  replacementHistory?: BulkCampaignAudienceReplacementEvent[] | null;
  policy?: BulkCampaignRecipientPolicy;
  authoritativeRecipientLimit?: BulkCampaignAuthoritativeRecipientLimit;
  outcome?: BulkCampaignAdmissionOutcomeMetadata;
  batchPlan?: BulkCampaignDispatchBatchPlan;
  requestDigest?: BulkCampaignRequestDigest;
};

export type BulkCampaignAuthoritativeRecipientLimit = {
  source: "live_meta" | "cached_meta" | "channel_default";
  value: number;
  rawLimit: string;
};

export type BulkCampaignRequestDigest = {
  version: 1;
  digest: string;
};

export type BulkCampaignAdmissionOutcomeMetadata = {
  evaluatedAt: string;
  requestedTotal: number;
  acceptedTotal: number;
  uniqueRecipients: { requested: number; accepted: number };
  skippedByReason: Partial<Record<BulkCampaignSkipReason, number>>;
  warnings: { missingMarketingConsent: number };
};

export type BulkCampaignPolicyAdmissionMetadata = Required<
  Pick<
    BulkCampaignAudienceAdmissionMetadata,
    | "authoritativeRecipientLimit"
    | "batchPlan"
    | "outcome"
    | "policy"
    | "requestDigest"
  >
>;

export type BulkCampaignAudienceReplacementEvent = {
  action: "replaced" | "cleared";
  replacedAt: string;
  replacedBy?: string | null;
  previousFilename?: string | null;
  nextFilename?: string | null;
  previousContentHash?: string | null;
  nextContentHash?: string | null;
};

export type BulkCampaignAdmissionSnapshot = {
  recipientHash: string;
  snapshotOrdinal: number;
  recipient: string;
  dispatchSnapshot: Record<string, unknown>;
};

export type BulkCampaignAdmissionInput = {
  /** Server-only HMAC secret. It is used locally and never sent to the RPC. */
  fingerprintSecret: string;
  campaignId: string;
  workspaceId: string;
  channel: BulkCampaignChannel;
  name: string;
  templateName: string | null;
  templateLanguage: string | null;
  messageText: string | null;
  sentBy: string | null;
  scenarioId: string | null;
  scenarioNodeId: string | null;
  executionSource: BulkCampaignDispatchExecutionSource | null;
  workflowId: string;
  dispatchStatus: Extract<BulkCampaignDispatchStatus, "queued" | "scheduled">;
  requestedAt: string;
  scheduledAt: string | null;
  dispatchExpiresAt: string;
  audience: {
    fingerprint: string;
    hashVersion: string;
    sourceType: string;
    count: number;
    metadata: BulkCampaignAudienceAdmissionMetadata;
  };
  confirmationFingerprint: string | null;
  retryOfCampaignId: string | null;
  retryKind: "failed_only" | "send_again" | null;
  companyBulkCampaignLimit: number | null;
  companySubscriptionType: CompanySubscriptionType;
  providerCircuitAcknowledgedBy?: string | null;
  snapshots: BulkCampaignAdmissionSnapshot[];
};

export type BulkCampaignAdmissionOverlap = {
  kind: "none" | "high" | "exact" | "unknown";
  intersectionCount: number;
  candidateCount: number;
  ratio: number;
};

export type BulkCampaignAdmissionResult =
  | {
      status: "admitted";
      campaignId: string;
      workflowId: string;
      dispatchStatus: BulkCampaignDispatchStatus;
      requestedAt: string;
      dispatchExpiresAt: string;
      audienceCount: number;
      idempotentReplay: boolean;
      audienceFingerprint: string;
      overlap?: BulkCampaignAdmissionOverlap;
    }
  | {
      status: "blocked";
      code: "active_audience_overlap" | "recent_audience_confirmation_required";
      retryable: false;
      audienceFingerprint: string;
      overlap: BulkCampaignAdmissionOverlap;
    }
  | {
      status: "blocked";
      code: "provider_circuit_acknowledgement_required";
      retryable: false;
      audienceFingerprint: string;
      providerCircuit: {
        state: "open";
        provider: string;
        code: string;
        failureCount: number;
      };
    }
  | {
      status: "blocked";
      code: "company_bulk_campaign_limit_exceeded";
      retryable: false;
      audienceFingerprint: string;
      companyBulkCampaignLimit: number;
      companyBulkCampaignCount: number;
    }
  | {
      status: "conflict";
      code: "admission_lock_busy";
      retryable: true;
      audienceFingerprint: string;
    }
  | {
      status: "conflict";
      code: "company_plan_changed";
      retryable: true;
      audienceFingerprint: string;
      expectedSubscriptionType: CompanySubscriptionType;
      currentSubscriptionType: CompanySubscriptionType;
    };

export class BulkCampaignAdmissionError extends Error {
  readonly code: string | null;

  constructor(message: string, code?: string | null) {
    super(message);
    this.name = "BulkCampaignAdmissionError";
    this.code = code || null;
  }
}

export class BulkCampaignAdmissionUnavailableError extends BulkCampaignAdmissionError {
  constructor(message: string, code?: string | null) {
    super(message, code);
    this.name = "BulkCampaignAdmissionUnavailableError";
  }
}

export class BulkCampaignAdmissionPayloadMismatchError extends BulkCampaignAdmissionError {
  constructor(message: string, code?: string | null) {
    super(message, code);
    this.name = "BulkCampaignAdmissionPayloadMismatchError";
  }
}

function normalizeSensitiveKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSensitiveSnapshotKey(key: string): boolean {
  const normalized = normalizeSensitiveKey(key);
  if (SAFE_SNAPSHOT_TOKEN_KEYS.has(normalized)) return false;
  return (
    SENSITIVE_SNAPSHOT_KEYS.has(normalized) ||
    SENSITIVE_SNAPSHOT_KEY_SUFFIXES.some(suffix =>
      normalized.endsWith(suffix)
    ) ||
    normalized.startsWith("authorization")
  );
}

function sanitizeSnapshotValue(
  value: unknown,
  ancestors: Set<object>
): BulkCampaignSnapshotJson | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== "object") {
    return undefined;
  }
  if (ancestors.has(value)) {
    throw new BulkCampaignAdmissionError(
      "Bulk campaign dispatch snapshot must be JSON serializable"
    );
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.flatMap(entry => {
        const sanitized = sanitizeSnapshotValue(entry, ancestors);
        return sanitized === undefined ? [] : [sanitized];
      });
    }

    const sanitized: Record<string, BulkCampaignSnapshotJson> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isSensitiveSnapshotKey(key)) {
        continue;
      }
      const sanitizedEntry = sanitizeSnapshotValue(entry, ancestors);
      if (sanitizedEntry !== undefined) {
        sanitized[key] = sanitizedEntry;
      }
    }
    return sanitized;
  } finally {
    ancestors.delete(value);
  }
}

export function sanitizeBulkCampaignDispatchSnapshot(
  snapshot: Record<string, unknown>
): Record<string, BulkCampaignSnapshotJson> {
  const sanitized = sanitizeSnapshotValue(snapshot, new Set());
  if (!sanitized || Array.isArray(sanitized) || typeof sanitized !== "object") {
    throw new BulkCampaignAdmissionError(
      "Bulk campaign dispatch snapshot must be an object"
    );
  }
  return sanitized;
}

function sanitizeOptionalText(
  value: unknown,
  label: string,
  maxLength = MAX_AUDIENCE_FILENAME_LENGTH
): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new BulkCampaignAdmissionError(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new BulkCampaignAdmissionError(
      `${label} must be between 1 and ${maxLength} characters`
    );
  }
  return normalized;
}

function sanitizeOptionalTimestamp(
  value: unknown,
  label: string
): string | null | undefined {
  const normalized = sanitizeOptionalText(value, label, 64);
  if (normalized === null || normalized === undefined) return normalized;
  const timestamp = new Date(normalized);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new BulkCampaignAdmissionError(`${label} must be a valid timestamp`);
  }
  return timestamp.toISOString();
}

function sanitizeOptionalSha256(
  value: unknown,
  label: string
): string | null | undefined {
  const normalized = sanitizeOptionalText(value, label, 64);
  if (normalized === null || normalized === undefined) return normalized;
  if (!LOWERCASE_SHA256_PATTERN.test(normalized)) {
    throw new BulkCampaignAdmissionError(
      `${label} must be a lowercase SHA-256 digest`
    );
  }
  return normalized;
}

function sanitizeReplacementEvent(
  value: unknown
): BulkCampaignAudienceReplacementEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BulkCampaignAdmissionError(
      "Bulk campaign audience replacement event must be an object"
    );
  }
  const event = value as Record<string, unknown>;
  if (event.action !== "replaced" && event.action !== "cleared") {
    throw new BulkCampaignAdmissionError(
      "Bulk campaign audience replacement action is invalid"
    );
  }
  const replacedAt = sanitizeOptionalTimestamp(
    event.replacedAt,
    "Bulk campaign audience replacement replacedAt"
  );
  if (!replacedAt) {
    throw new BulkCampaignAdmissionError(
      "Bulk campaign audience replacement replacedAt is required"
    );
  }

  return {
    action: event.action,
    replacedAt,
    ...copyDefined({
      replacedBy: sanitizeOptionalText(
        event.replacedBy,
        "Bulk campaign audience replacement replacedBy",
        128
      ),
      previousFilename: sanitizeOptionalText(
        event.previousFilename,
        "Bulk campaign audience replacement previousFilename"
      ),
      nextFilename: sanitizeOptionalText(
        event.nextFilename,
        "Bulk campaign audience replacement nextFilename"
      ),
      previousContentHash: sanitizeOptionalSha256(
        event.previousContentHash,
        "Bulk campaign audience replacement previousContentHash"
      ),
      nextContentHash: sanitizeOptionalSha256(
        event.nextContentHash,
        "Bulk campaign audience replacement nextContentHash"
      ),
    }),
  };
}

function copyDefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as T;
}

const BULK_CAMPAIGN_SKIP_REASONS = [
  "ineligible",
  "marketing_opt_out",
  "recipient_limit",
  "prior_failure",
  "service_window",
  "unsubscribed",
  "recent_contact",
] as const satisfies readonly BulkCampaignSkipReason[];

function sanitizeNonNegativeInteger(value: unknown, field: string): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_BULK_CAMPAIGN_RECIPIENTS
  ) {
    throw new BulkCampaignAdmissionError(
      `${field} must be an integer between 0 and ${MAX_BULK_CAMPAIGN_RECIPIENTS}`
    );
  }
  return value as number;
}

function sanitizeReplayTimestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(new Date(value).getTime()) ||
    new Date(value).toISOString() !== value
  ) {
    throw new BulkCampaignAdmissionError(`${field} evaluatedAt is invalid`);
  }
  return value;
}

function sanitizeReplayBatchPlan(
  value: unknown
): BulkCampaignDispatchBatchPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BulkCampaignAdmissionError(
      "Bulk campaign replay batch plan must be an object"
    );
  }
  const row = value as Record<string, unknown>;
  const batchSize = row.batchSize;
  const delayMs = row.delayMs;
  const ratePerSecond = row.ratePerSecond;
  const rateSource =
    typeof row.rateSource === "string" ? row.rateSource.trim() : "";
  const throughputLevel = row.throughputLevel;
  if (
    !Number.isInteger(batchSize) ||
    Number(batchSize) <= 0 ||
    Number(batchSize) > MAX_BULK_CAMPAIGN_RECIPIENTS ||
    !Number.isInteger(delayMs) ||
    Number(delayMs) < 0 ||
    Number(delayMs) > 2_147_483_647 ||
    typeof ratePerSecond !== "number" ||
    !Number.isFinite(ratePerSecond) ||
    ratePerSecond < 0.000001 ||
    ratePerSecond > MAX_BULK_CAMPAIGN_RECIPIENTS ||
    Number(ratePerSecond.toFixed(6)) !== ratePerSecond ||
    !rateSource ||
    rateSource.length > 128 ||
    (throughputLevel !== undefined &&
      throughputLevel !== null &&
      (typeof throughputLevel !== "string" ||
        !throughputLevel.trim() ||
        throughputLevel.trim().length > 128))
  ) {
    throw new BulkCampaignAdmissionError(
      "Bulk campaign replay batch plan exceeds safe bounds"
    );
  }
  return copyDefined({
    batchSize: Number(batchSize),
    delayMs: Number(delayMs),
    ratePerSecond,
    rateSource,
    ...(throughputLevel === undefined
      ? {}
      : {
          throughputLevel:
            typeof throughputLevel === "string" ? throughputLevel.trim() : null,
        }),
    ...(typeof row.dailyWaveLimit === "number" &&
    Number.isInteger(row.dailyWaveLimit) &&
    row.dailyWaveLimit > 0 &&
    row.dailyWaveLimit <= MAX_BULK_CAMPAIGN_RECIPIENTS
      ? { dailyWaveLimit: Number(row.dailyWaveLimit) }
      : {}),
  });
}

function sanitizePolicyMetadata(
  value: BulkCampaignAudienceAdmissionMetadata,
  counts: { itemCount: number; uniqueRecipientCount: number }
): Partial<BulkCampaignPolicyAdmissionMetadata> {
  const policyMembers = [
    value.policy,
    value.authoritativeRecipientLimit,
    value.outcome,
    value.batchPlan,
    value.requestDigest,
  ];
  const providedMembers = policyMembers.filter(member => member !== undefined);
  if (
    providedMembers.length > 0 &&
    providedMembers.length !== policyMembers.length
  ) {
    throw new BulkCampaignAdmissionError(
      "Bulk campaign replay policy metadata is all-or-none"
    );
  }
  if (providedMembers.length === 0) return {};

  const sanitized: Partial<BulkCampaignPolicyAdmissionMetadata> = {};
  if (value.policy !== undefined) {
    if (
      value.policy?.version !== 1 ||
      typeof value.policy.excludePriorFailedBulkSends !== "boolean"
    ) {
      throw new BulkCampaignAdmissionError(
        "Bulk campaign audience policy metadata is invalid"
      );
    }
    sanitized.policy = {
      version: 1,
      excludePriorFailedBulkSends: value.policy.excludePriorFailedBulkSends,
    };
  }

  if (value.authoritativeRecipientLimit !== undefined) {
    const source = value.authoritativeRecipientLimit?.source;
    if (
      source !== "live_meta" &&
      source !== "cached_meta" &&
      source !== "channel_default"
    ) {
      throw new BulkCampaignAdmissionError(
        "Bulk campaign authoritative recipient limit source is invalid"
      );
    }
    const limitValue = sanitizeNonNegativeInteger(
      value.authoritativeRecipientLimit.value,
      "Bulk campaign authoritative recipient limit"
    );
    if (limitValue <= 0) {
      throw new BulkCampaignAdmissionError(
        "Bulk campaign authoritative recipient limit is invalid"
      );
    }
    const rawLimit =
      typeof value.authoritativeRecipientLimit.rawLimit === "string"
        ? value.authoritativeRecipientLimit.rawLimit.trim()
        : "";
    if (!rawLimit || rawLimit.length > 128) {
      throw new BulkCampaignAdmissionError(
        "Bulk campaign authoritative recipient raw limit is invalid"
      );
    }
    sanitized.authoritativeRecipientLimit = {
      source,
      value: limitValue,
      rawLimit,
    };
  }

  if (value.outcome !== undefined) {
    const evaluatedAt = sanitizeReplayTimestamp(
      value.outcome?.evaluatedAt,
      "Bulk campaign outcome"
    );
    const requestedTotal = sanitizeNonNegativeInteger(
      value.outcome?.requestedTotal,
      "Bulk campaign outcome requestedTotal"
    );
    const acceptedTotal = sanitizeNonNegativeInteger(
      value.outcome.acceptedTotal,
      "Bulk campaign outcome acceptedTotal"
    );
    const uniqueRequested = sanitizeNonNegativeInteger(
      value.outcome.uniqueRecipients?.requested,
      "Bulk campaign outcome uniqueRecipients.requested"
    );
    const uniqueAccepted = sanitizeNonNegativeInteger(
      value.outcome.uniqueRecipients?.accepted,
      "Bulk campaign outcome uniqueRecipients.accepted"
    );
    const skippedByReason: Partial<Record<BulkCampaignSkipReason, number>> = {};
    for (const reason of BULK_CAMPAIGN_SKIP_REASONS) {
      const rawCount = value.outcome.skippedByReason?.[reason];
      if (rawCount !== undefined) {
        skippedByReason[reason] = sanitizeNonNegativeInteger(
          rawCount,
          `Bulk campaign outcome skippedByReason.${reason}`
        );
      }
    }
    const skippedTotal = Object.values(skippedByReason).reduce(
      (sum, count) => sum + (count || 0),
      0
    );
    const uniqueCap =
      isRecord(value.batchPlan) &&
      typeof value.batchPlan.dailyWaveLimit === "number" &&
      Number.isInteger(value.batchPlan.dailyWaveLimit) &&
      value.batchPlan.dailyWaveLimit > 0 &&
      value.batchPlan.dailyWaveLimit <= MAX_BULK_CAMPAIGN_RECIPIENTS
        ? MAX_BULK_CAMPAIGN_RECIPIENTS
        : sanitized.authoritativeRecipientLimit!.value;
    if (
      acceptedTotal > requestedTotal ||
      uniqueRequested > requestedTotal ||
      uniqueAccepted > acceptedTotal ||
      uniqueAccepted > uniqueRequested ||
      acceptedTotal + skippedTotal !== requestedTotal ||
      acceptedTotal !== counts.itemCount ||
      uniqueAccepted !== counts.uniqueRecipientCount ||
      uniqueAccepted > uniqueCap
    ) {
      throw new BulkCampaignAdmissionError(
        uniqueAccepted > uniqueCap
          ? "Bulk campaign accepted unique recipients exceed the authoritative recipient limit"
          : "Bulk campaign outcome aggregate metadata is inconsistent with immutable snapshots"
      );
    }
    const missingMarketingConsent = sanitizeNonNegativeInteger(
      value.outcome.warnings?.missingMarketingConsent,
      "Bulk campaign outcome warnings.missingMarketingConsent"
    );
    if (missingMarketingConsent > requestedTotal) {
      throw new BulkCampaignAdmissionError(
        "Bulk campaign outcome warning count exceeds requested total"
      );
    }
    sanitized.outcome = {
      evaluatedAt,
      requestedTotal,
      acceptedTotal,
      uniqueRecipients: {
        requested: uniqueRequested,
        accepted: uniqueAccepted,
      },
      skippedByReason,
      warnings: {
        missingMarketingConsent,
      },
    };
  }
  if (value.batchPlan !== undefined) {
    sanitized.batchPlan = sanitizeReplayBatchPlan(value.batchPlan);
  }
  if (value.requestDigest !== undefined) {
    if (!isRecord(value.requestDigest)) {
      throw new BulkCampaignAdmissionError(
        "Bulk campaign request digest is invalid"
      );
    }
    const digest =
      typeof value.requestDigest.digest === "string"
        ? value.requestDigest.digest
        : "";
    if (
      value.requestDigest.version !== 1 ||
      !LOWERCASE_SHA256_PATTERN.test(digest)
    ) {
      throw new BulkCampaignAdmissionError(
        "Bulk campaign request digest is invalid"
      );
    }
    sanitized.requestDigest = { version: 1, digest };
  }
  return sanitized;
}

function sanitizeAudienceMetadata(
  value: BulkCampaignAudienceAdmissionMetadata,
  counts: { itemCount: number; uniqueRecipientCount: number }
): Required<Pick<BulkCampaignAudienceAdmissionMetadata, "replacementHistory">> &
  Omit<BulkCampaignAudienceAdmissionMetadata, "replacementHistory"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BulkCampaignAdmissionError(
      "Bulk campaign audience metadata must be an object"
    );
  }
  const rawReplacementHistory = Array.isArray(value.replacementHistory)
    ? value.replacementHistory.slice(
        -BULK_CAMPAIGN_AUDIENCE_REPLACEMENT_HISTORY_LIMIT
      )
    : [];
  return copyDefined({
    originalFilename: sanitizeOptionalText(
      value.originalFilename,
      "Bulk campaign audience originalFilename"
    ),
    uploadedAt: sanitizeOptionalTimestamp(
      value.uploadedAt,
      "Bulk campaign audience uploadedAt"
    ),
    uploadedBy: sanitizeOptionalText(
      value.uploadedBy,
      "Bulk campaign audience uploadedBy",
      128
    ),
    contentHash: sanitizeOptionalSha256(
      value.contentHash,
      "Bulk campaign audience contentHash"
    ),
    replacementHistory: rawReplacementHistory.map(sanitizeReplacementEvent),
    ...sanitizePolicyMetadata(value, counts),
  }) as Required<
    Pick<BulkCampaignAudienceAdmissionMetadata, "replacementHistory">
  > &
    Omit<BulkCampaignAudienceAdmissionMetadata, "replacementHistory">;
}

const ADMITTED_BULK_CAMPAIGN_REPLAY_SELECT = [
  "id",
  "workspace_id",
  "sent_by",
  "channel",
  "template_name",
  "template_language",
  "message_text",
  "scenario_id",
  "scenario_node_id",
  "execution_source",
  "workflow_id",
  "dispatch_status",
  "requested_at",
  "scheduled_at",
  "dispatch_expires_at",
  "total_recipients",
  "audience_metadata",
].join(",");

function replayRequiredIdentifier(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new BulkCampaignAdmissionUnavailableError(
      `Persisted bulk campaign replay ${field} is invalid`
    );
  }
  return normalized;
}

function replayNullableIdentifier(
  value: unknown,
  field: string
): string | null {
  if (value === null || value === undefined) return null;
  return replayRequiredIdentifier(value, field);
}

function replayRequiredTimestamp(value: unknown, field: string): string {
  const normalized = replayRequiredIdentifier(value, field);
  const timestamp = new Date(normalized);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new BulkCampaignAdmissionUnavailableError(
      `Persisted bulk campaign replay ${field} is invalid`
    );
  }
  return timestamp.toISOString();
}

function replayNullableTimestamp(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return replayRequiredTimestamp(value, field);
}

function resolveReplayMessageKind(
  row: Record<string, unknown>,
  channel: BulkCampaignChannel
): AdmittedBulkCampaignReplay["messageKind"] {
  const templateName = replayNullableIdentifier(
    row.template_name,
    "template name"
  );
  const templateLanguage = replayRequiredIdentifier(
    row.template_language,
    "template language"
  );
  const messageText = replayNullableIdentifier(
    row.message_text,
    "message text"
  );

  if (channel === "whatsapp") {
    if (messageText) {
      if (templateName || templateLanguage === "multi") {
        throw new BulkCampaignAdmissionUnavailableError(
          "Persisted WhatsApp service-text replay intent is contradictory"
        );
      }
      return "service_text";
    }
    if (templateName) {
      if (templateLanguage === "multi") {
        throw new BulkCampaignAdmissionUnavailableError(
          "Persisted WhatsApp template replay intent is contradictory"
        );
      }
      return "template";
    }
    if (templateLanguage === "multi") return "template";
    throw new BulkCampaignAdmissionUnavailableError(
      "Persisted WhatsApp template replay identity is missing"
    );
  }

  if (channel === "telegram") {
    if (templateName || !messageText) {
      throw new BulkCampaignAdmissionUnavailableError(
        "Persisted Telegram replay intent is contradictory"
      );
    }
    return "telegram";
  }

  if (!templateName) {
    throw new BulkCampaignAdmissionUnavailableError(
      "Persisted email replay template identity is missing"
    );
  }
  return "email";
}

function replayStoreErrorMessage(
  error: BulkCampaignReplayStoreError | null | undefined
): string {
  return typeof error?.message === "string" && error.message.trim()
    ? error.message.trim()
    : "store read failed";
}

function parseAdmittedBulkCampaignReplay(params: {
  row: Record<string, unknown>;
  campaignId: string;
  workspaceId: string;
  sentBy: string;
  requestDigest: BulkCampaignRequestDigest;
}): AdmittedBulkCampaignReplay {
  const { row } = params;
  if (
    replayRequiredIdentifier(row.id, "campaign id") !== params.campaignId ||
    replayRequiredIdentifier(row.workspace_id, "workspace id") !==
      params.workspaceId ||
    replayRequiredIdentifier(row.sent_by, "sender") !== params.sentBy
  ) {
    throw new BulkCampaignAdmissionUnavailableError(
      "Persisted bulk campaign replay ownership is invalid"
    );
  }

  const channel = replayRequiredIdentifier(row.channel, "channel");
  if (channel !== "whatsapp" && channel !== "telegram" && channel !== "email") {
    throw new BulkCampaignAdmissionUnavailableError(
      "Persisted bulk campaign replay channel is invalid"
    );
  }
  const messageKind = resolveReplayMessageKind(
    row,
    channel as BulkCampaignChannel
  );
  const executionSource = replayRequiredIdentifier(
    row.execution_source,
    "execution source"
  );
  if (
    !BULK_CAMPAIGN_DISPATCH_EXECUTION_SOURCES.includes(
      executionSource as BulkCampaignDispatchExecutionSource
    )
  ) {
    throw new BulkCampaignAdmissionUnavailableError(
      "Persisted bulk campaign replay execution source is invalid"
    );
  }
  const workflowId = replayRequiredIdentifier(row.workflow_id, "workflow id");
  const expectedWorkflowId = buildBulkCampaignDispatchWorkflowId({
    workspaceId: params.workspaceId,
    executionId: params.campaignId,
  });
  if (workflowId !== expectedWorkflowId) {
    throw new BulkCampaignAdmissionUnavailableError(
      "Persisted bulk campaign replay workflow id is invalid"
    );
  }
  const dispatchStatus = replayRequiredIdentifier(
    row.dispatch_status,
    "dispatch status"
  );
  if (
    ![
      "queued",
      "scheduled",
      "running",
      "completed",
      "failed",
      "expired",
      "cancelled",
    ].includes(dispatchStatus)
  ) {
    throw new BulkCampaignAdmissionUnavailableError(
      "Persisted bulk campaign replay dispatch status is invalid"
    );
  }
  const requestedAt = replayRequiredTimestamp(row.requested_at, "requested at");
  const dispatchExpiresAt = replayRequiredTimestamp(
    row.dispatch_expires_at,
    "dispatch expiry"
  );
  const scheduledAt = replayNullableTimestamp(row.scheduled_at, "scheduled at");
  const scenarioId = replayNullableIdentifier(row.scenario_id, "scenario id");
  const rootNodeId = replayNullableIdentifier(
    row.scenario_node_id,
    "scenario node id"
  );

  if (!isRecord(row.audience_metadata)) {
    throw new BulkCampaignAdmissionUnavailableError(
      "Persisted bulk campaign replay audience metadata is invalid"
    );
  }
  const rawMetadata = row.audience_metadata;
  const rawOutcome = isRecord(rawMetadata.outcome) ? rawMetadata.outcome : null;
  const rawUniqueRecipients = isRecord(rawOutcome?.uniqueRecipients)
    ? rawOutcome.uniqueRecipients
    : null;
  const totalRecipients = sanitizeNonNegativeInteger(
    row.total_recipients,
    "Persisted bulk campaign total recipients"
  );
  const uniqueAccepted = sanitizeNonNegativeInteger(
    rawUniqueRecipients?.accepted,
    "Persisted bulk campaign unique accepted recipients"
  );
  const metadata = sanitizePolicyMetadata(
    rawMetadata as BulkCampaignAudienceAdmissionMetadata,
    { itemCount: totalRecipients, uniqueRecipientCount: uniqueAccepted }
  );
  if (
    !metadata.policy ||
    !metadata.authoritativeRecipientLimit ||
    !metadata.outcome ||
    !metadata.batchPlan ||
    !metadata.requestDigest
  ) {
    throw new BulkCampaignAdmissionUnavailableError(
      "Persisted bulk campaign replay policy metadata is incomplete"
    );
  }
  if (
    !params.requestDigest ||
    params.requestDigest.version !== 1 ||
    typeof params.requestDigest.digest !== "string" ||
    !LOWERCASE_SHA256_PATTERN.test(params.requestDigest.digest)
  ) {
    throw new BulkCampaignAdmissionUnavailableError(
      "Expected bulk campaign replay request digest is invalid"
    );
  }
  if (metadata.requestDigest.digest !== params.requestDigest.digest) {
    throw new BulkCampaignAdmissionPayloadMismatchError(
      "Persisted bulk campaign replay request digest does not match"
    );
  }

  const disposition = scheduledAt ? "scheduled" : "queued";
  const commandResult = createBulkCampaignSuccessResult({
    disposition,
    evaluatedAt: metadata.outcome.evaluatedAt,
    lifecycleStatus: disposition,
    requestedTotal: metadata.outcome.requestedTotal,
    acceptedTotal: metadata.outcome.acceptedTotal,
    queuedTotal: metadata.outcome.acceptedTotal,
    uniqueRecipients: {
      requested: metadata.outcome.uniqueRecipients.requested,
      accepted: metadata.outcome.uniqueRecipients.accepted,
      queued: metadata.outcome.uniqueRecipients.accepted,
    },
    skippedByReason: metadata.outcome.skippedByReason,
    warnings: metadata.outcome.warnings,
    campaignId: params.campaignId,
    dispatchId: params.campaignId,
    workflowId,
  });
  const skippedByLimit = metadata.outcome.skippedByReason.recipient_limit || 0;
  const skippedPriorFailure =
    metadata.outcome.skippedByReason.prior_failure || 0;
  return {
    campaignId: params.campaignId,
    workspaceId: params.workspaceId,
    result: {
      ...serializeBulkCampaignCommandResult(commandResult),
      ...(scheduledAt ? { scheduledAt } : {}),
      batchPlan: metadata.batchPlan,
      recipientLimit: {
        originalCount:
          metadata.outcome.acceptedTotal + skippedPriorFailure + skippedByLimit,
        acceptedCount: metadata.outcome.acceptedTotal,
        rawLimit: metadata.authoritativeRecipientLimit.rawLimit,
        source: metadata.authoritativeRecipientLimit.source,
        truncated: skippedByLimit > 0,
      },
    },
    batchPlan: metadata.batchPlan,
    dispatchStatus: dispatchStatus as BulkCampaignDispatchStatus,
    requestedAt,
    scheduledAt,
    dispatchExpiresAt,
    totalRecipients,
    channel,
    messageKind,
    executionSource: executionSource as BulkCampaignDispatchExecutionSource,
    scenarioId,
    rootNodeId,
    planLimit: {
      source: metadata.authoritativeRecipientLimit.source,
      value: metadata.authoritativeRecipientLimit.value,
    },
    policy: metadata.policy,
  };
}

export async function lookupAdmittedBulkCampaignReplay(params: {
  client: BulkCampaignReplayLookupClient;
  campaignId: string;
  workspaceId: string;
  sentBy: string;
  requestDigest: BulkCampaignRequestDigest;
}): Promise<AdmittedBulkCampaignReplay | null> {
  const result = await (
    params.client.from("campaign_history") as BulkCampaignReplayTable
  )
    .select(ADMITTED_BULK_CAMPAIGN_REPLAY_SELECT)
    .eq("id", params.campaignId)
    .eq("workspace_id", params.workspaceId)
    .eq("sent_by", params.sentBy)
    .maybeSingle();
  if (result.error) {
    throw new BulkCampaignAdmissionUnavailableError(
      `Persisted bulk campaign replay lookup failed: ${replayStoreErrorMessage(result.error)}`,
      result.error.code
    );
  }
  if (!result.data) return null;
  if (!isRecord(result.data)) {
    throw new BulkCampaignAdmissionUnavailableError(
      "Persisted bulk campaign replay row is invalid"
    );
  }
  try {
    return parseAdmittedBulkCampaignReplay({
      row: result.data,
      campaignId: params.campaignId,
      workspaceId: params.workspaceId,
      sentBy: params.sentBy,
      requestDigest: params.requestDigest,
    });
  } catch (error) {
    if (error instanceof BulkCampaignAdmissionPayloadMismatchError) throw error;
    if (error instanceof BulkCampaignAdmissionUnavailableError) throw error;
    if (error instanceof BulkCampaignAdmissionError) {
      throw new BulkCampaignAdmissionUnavailableError(
        `Persisted bulk campaign replay metadata is invalid: ${error.message}`,
        error.code
      );
    }
    throw error;
  }
}

function buildAdmissionMessages(input: BulkCampaignAdmissionInput) {
  if (
    !Number.isInteger(input.audience.count) ||
    input.audience.count <= 0 ||
    input.audience.count > MAX_BULK_CAMPAIGN_RECIPIENTS ||
    input.snapshots.length !== input.audience.count
  ) {
    throw new BulkCampaignAdmissionError(
      "Bulk campaign audience count must match the immutable snapshots"
    );
  }

  const recipientByHash = new Map<string, string>();
  const hashByRecipient = new Map<string, string>();
  const ordinals = new Set<number>();
  return input.snapshots.map(snapshot => {
    const recipientHash = snapshot.recipientHash.trim();
    const recipient = snapshot.recipient.trim();
    if (!recipientHash || !recipient) {
      throw new BulkCampaignAdmissionError(
        "Bulk campaign snapshots require recipient identity and hash"
      );
    }
    if (!LOWERCASE_SHA256_PATTERN.test(recipientHash)) {
      throw new BulkCampaignAdmissionError(
        "Bulk campaign recipient hash must be a lowercase SHA-256 digest"
      );
    }
    if (
      !Number.isInteger(snapshot.snapshotOrdinal) ||
      snapshot.snapshotOrdinal < 0 ||
      snapshot.snapshotOrdinal >= input.audience.count
    ) {
      throw new BulkCampaignAdmissionError(
        "Bulk campaign snapshot ordinal is outside the audience"
      );
    }
    if (ordinals.has(snapshot.snapshotOrdinal)) {
      throw new BulkCampaignAdmissionError(
        "Bulk campaign snapshots must be unique by ordinal"
      );
    }
    const mappedRecipient = recipientByHash.get(recipientHash);
    const mappedHash = hashByRecipient.get(recipient);
    if (
      (mappedRecipient !== undefined && mappedRecipient !== recipient) ||
      (mappedHash !== undefined && mappedHash !== recipientHash)
    ) {
      throw new BulkCampaignAdmissionError(
        "Bulk campaign recipient identity mapping is inconsistent"
      );
    }
    const embeddedOrdinal = snapshot.dispatchSnapshot.snapshotOrdinal;
    if (
      embeddedOrdinal !== undefined &&
      (!Number.isInteger(embeddedOrdinal) ||
        Number(embeddedOrdinal) !== snapshot.snapshotOrdinal)
    ) {
      throw new BulkCampaignAdmissionError(
        "Bulk campaign embedded snapshot ordinal does not match its item"
      );
    }
    recipientByHash.set(recipientHash, recipient);
    hashByRecipient.set(recipient, recipientHash);
    ordinals.add(snapshot.snapshotOrdinal);

    return {
      ledger_message_id: `${input.campaignId}:snapshot:${snapshot.snapshotOrdinal}`,
      recipient_hash: recipientHash,
      snapshot_ordinal: snapshot.snapshotOrdinal,
      recipient,
      dispatch_snapshot: sanitizeBulkCampaignDispatchSnapshot(
        snapshot.dispatchSnapshot
      ),
    };
  });
}

function isMissingAdmissionRpc(error: BulkCampaignAdmissionRpcError): boolean {
  const text = [error.message, error.details, error.hint]
    .filter(Boolean)
    .join(" ");
  return (
    error.code === "PGRST202" ||
    error.code === "42883" ||
    (/admit_bulk_campaign/i.test(text) &&
      /(schema cache|does not exist|could not find|undefined function)/i.test(
        text
      ))
  );
}

function isRequestDigestMismatchRpc(
  error: BulkCampaignAdmissionRpcError
): boolean {
  const text = [error.message, error.details, error.hint]
    .filter(Boolean)
    .join(" ");
  return (
    error.code === "22000" &&
    /request digest identity does not match the admitted dispatch/i.test(text)
  );
}

function parseOverlap(
  value: unknown,
  expectedCandidateCount: number
): BulkCampaignAdmissionOverlap | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const kind = row.kind;
  if (
    kind !== "none" &&
    kind !== "high" &&
    kind !== "exact" &&
    kind !== "unknown"
  ) {
    return undefined;
  }
  const intersectionCount = row.intersection_count;
  const candidateCount = row.candidate_count;
  const ratio = row.ratio;
  if (
    typeof intersectionCount !== "number" ||
    !Number.isInteger(intersectionCount) ||
    intersectionCount < 0 ||
    typeof candidateCount !== "number" ||
    !Number.isInteger(candidateCount) ||
    candidateCount !== expectedCandidateCount ||
    candidateCount <= 0 ||
    intersectionCount > candidateCount ||
    typeof ratio !== "number" ||
    !Number.isFinite(ratio) ||
    ratio < 0 ||
    ratio > 1
  ) {
    return undefined;
  }
  const expectedRatio = intersectionCount / candidateCount;
  if (Math.abs(ratio - expectedRatio) > Number.EPSILON * 10) {
    return undefined;
  }
  if (
    (kind === "unknown" && (intersectionCount !== 0 || ratio !== 0)) ||
    (kind === "exact" && intersectionCount !== candidateCount) ||
    (kind === "high" && (intersectionCount < 10 || ratio < 0.8))
  ) {
    return undefined;
  }
  return { kind, intersectionCount, candidateCount, ratio };
}

function parseAdmissionResult(
  value: unknown,
  expected: BulkCampaignAdmissionInput
): BulkCampaignAdmissionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BulkCampaignAdmissionUnavailableError(
      "Bulk campaign admission RPC returned an invalid result"
    );
  }
  const row = value as Record<string, unknown>;
  const expectedItemCount = expected.audience.count;
  const expectedUniqueRecipientCount = new Set(
    expected.snapshots.map(snapshot => snapshot.recipientHash.trim())
  ).size;
  const audienceFingerprint = String(row.audience_fingerprint || "");
  if (audienceFingerprint !== expected.audience.fingerprint) {
    throw new BulkCampaignAdmissionUnavailableError(
      "Bulk campaign admission RPC returned a mismatched audience"
    );
  }

  if (row.status === "admitted") {
    const campaignId = String(row.campaign_id || "");
    const dispatchStatus = row.dispatch_status;
    const idempotentReplay = row.idempotent_replay === true;
    const validDispatchStatus =
      dispatchStatus === "queued" ||
      dispatchStatus === "scheduled" ||
      dispatchStatus === "running" ||
      dispatchStatus === "completed" ||
      dispatchStatus === "failed" ||
      dispatchStatus === "expired" ||
      dispatchStatus === "cancelled";
    if (
      !campaignId ||
      !validDispatchStatus ||
      (!idempotentReplay &&
        (campaignId !== expected.campaignId ||
          dispatchStatus !== expected.dispatchStatus))
    ) {
      throw new BulkCampaignAdmissionUnavailableError(
        "Bulk campaign admission RPC returned an invalid admission"
      );
    }
    const overlap = parseOverlap(row.overlap, expectedUniqueRecipientCount);
    if (!overlap) {
      throw new BulkCampaignAdmissionUnavailableError(
        "Bulk campaign admission RPC returned invalid admitted overlap"
      );
    }
    const workflowId = idempotentReplay
      ? typeof row.workflow_id === "string" && row.workflow_id
        ? row.workflow_id
        : null
      : expected.workflowId;
    const requestedAt = idempotentReplay
      ? typeof row.requested_at === "string" && row.requested_at
        ? row.requested_at
        : null
      : expected.requestedAt;
    const dispatchExpiresAt = idempotentReplay
      ? typeof row.dispatch_expires_at === "string" && row.dispatch_expires_at
        ? row.dispatch_expires_at
        : null
      : expected.dispatchExpiresAt;
    const rpcItemCount = row.item_count ?? row.audience_count;
    const audienceCount = idempotentReplay
      ? Number.isInteger(rpcItemCount) && Number(rpcItemCount) > 0
        ? Number(rpcItemCount)
        : null
      : expectedItemCount;
    if (
      (row.item_count !== undefined &&
        (!Number.isInteger(row.item_count) ||
          Number(row.item_count) !== audienceCount)) ||
      (row.audience_count !== undefined &&
        (!Number.isInteger(row.audience_count) ||
          Number(row.audience_count) !== audienceCount)) ||
      (row.unique_recipient_count !== undefined &&
        (!Number.isInteger(row.unique_recipient_count) ||
          Number(row.unique_recipient_count) !== expectedUniqueRecipientCount))
    ) {
      throw new BulkCampaignAdmissionUnavailableError(
        "Bulk campaign admission RPC returned inconsistent item counts"
      );
    }
    if (!workflowId || !requestedAt || !dispatchExpiresAt || !audienceCount) {
      throw new BulkCampaignAdmissionUnavailableError(
        "Bulk campaign admission RPC returned incomplete persisted dispatch identity"
      );
    }
    return {
      status: "admitted",
      campaignId,
      workflowId,
      dispatchStatus,
      requestedAt,
      dispatchExpiresAt,
      audienceCount,
      idempotentReplay,
      audienceFingerprint,
      overlap,
    };
  }

  if (row.status === "blocked") {
    const code = row.code;
    if (code === "company_bulk_campaign_limit_exceeded") {
      const companyBulkCampaignLimit = row.company_bulk_campaign_limit;
      const companyBulkCampaignCount = row.company_bulk_campaign_count;
      if (
        expected.companyBulkCampaignLimit === null ||
        !Number.isSafeInteger(companyBulkCampaignLimit) ||
        Number(companyBulkCampaignLimit) !==
          expected.companyBulkCampaignLimit ||
        !isCompanyBulkQuotaRefusal(row)
      ) {
        throw new BulkCampaignAdmissionUnavailableError(
          "Bulk campaign admission RPC returned an invalid company quota decision"
        );
      }
      return {
        status: "blocked",
        code,
        retryable: false,
        audienceFingerprint,
        companyBulkCampaignLimit: Number(companyBulkCampaignLimit),
        companyBulkCampaignCount: Number(companyBulkCampaignCount),
      };
    }
    if (code === "provider_circuit_acknowledgement_required") {
      const circuit =
        row.provider_circuit &&
        typeof row.provider_circuit === "object" &&
        !Array.isArray(row.provider_circuit)
          ? (row.provider_circuit as Record<string, unknown>)
          : null;
      const provider =
        circuit && typeof circuit.provider === "string"
          ? circuit.provider.trim()
          : null;
      const providerCode =
        circuit && typeof circuit.code === "string" ? circuit.code.trim() : null;
      const failureCount =
        circuit &&
        Number.isInteger(circuit.failure_count) &&
        Number(circuit.failure_count) >= 0
          ? Number(circuit.failure_count)
          : null;
      if (
        circuit?.state !== "open" ||
        !provider ||
        !providerCode ||
        failureCount === null
      ) {
        throw new BulkCampaignAdmissionUnavailableError(
          "Bulk campaign admission RPC returned an invalid provider circuit"
        );
      }
      return {
        status: "blocked",
        code,
        retryable: false,
        audienceFingerprint,
        providerCircuit: {
          state: "open",
          provider,
          code: providerCode,
          failureCount,
        },
      };
    }
    const overlap = parseOverlap(row.overlap, expectedUniqueRecipientCount);
    if (
      (code !== "active_audience_overlap" &&
        code !== "recent_audience_confirmation_required") ||
      !overlap
    ) {
      throw new BulkCampaignAdmissionUnavailableError(
        "Bulk campaign admission RPC returned an invalid overlap decision"
      );
    }
    return {
      status: "blocked",
      code,
      retryable: false,
      audienceFingerprint,
      overlap,
    };
  }

  if (row.status === "conflict" && row.retryable === true) {
    if (row.code === "company_plan_changed") {
      const expectedSubscriptionType = row.expected_subscription_type;
      const currentSubscriptionType = row.current_subscription_type;
      if (
        !isCompanySubscriptionType(expectedSubscriptionType) ||
        !isCompanySubscriptionType(currentSubscriptionType) ||
        expectedSubscriptionType !== expected.companySubscriptionType
      ) {
        throw new BulkCampaignAdmissionUnavailableError(
          "Bulk campaign admission RPC returned an invalid company plan conflict"
        );
      }
      return {
        status: "conflict",
        code: "company_plan_changed",
        retryable: true,
        audienceFingerprint,
        expectedSubscriptionType,
        currentSubscriptionType,
      };
    }
    if (row.code !== "admission_lock_busy") {
      throw new BulkCampaignAdmissionUnavailableError(
        "Bulk campaign admission RPC returned an unknown conflict"
      );
    }
    return {
      status: "conflict",
      code: "admission_lock_busy",
      retryable: true,
      audienceFingerprint,
    };
  }

  throw new BulkCampaignAdmissionUnavailableError(
    "Bulk campaign admission RPC returned an unknown decision"
  );
}

export async function admitBulkCampaign(
  client: BulkCampaignAdmissionClient,
  input: BulkCampaignAdmissionInput
): Promise<BulkCampaignAdmissionResult> {
  const messages = buildAdmissionMessages(input);
  if (!input.fingerprintSecret.trim()) {
    throw new BulkCampaignAdmissionError(
      "Bulk campaign fingerprint secret is required"
    );
  }
  if (input.audience.hashVersion !== BULK_CAMPAIGN_AUDIENCE_HASH_VERSION) {
    throw new BulkCampaignAdmissionError(
      "Bulk campaign audience hash version is unsupported"
    );
  }
  if (
    input.companyBulkCampaignLimit !== null &&
    (!Number.isSafeInteger(input.companyBulkCampaignLimit) ||
      input.companyBulkCampaignLimit < 0)
  ) {
    throw new BulkCampaignAdmissionError(
      "Company bulk campaign limit must be a non-negative integer or null"
    );
  }
  if (!isCompanySubscriptionType(input.companySubscriptionType)) {
    throw new BulkCampaignAdmissionError(
      "Company subscription type is invalid"
    );
  }
  const hasAcknowledgedBy = Boolean(input.providerCircuitAcknowledgedBy);
  if (
    (hasAcknowledgedBy && input.retryKind !== "failed_only") ||
    (hasAcknowledgedBy &&
      (!input.sentBy || input.providerCircuitAcknowledgedBy !== input.sentBy))
  ) {
    throw new BulkCampaignAdmissionError(
      "Bulk campaign provider circuit acknowledgement is invalid"
    );
  }
  const computedFingerprint =
    createBulkCampaignAudienceFingerprintFromRecipientHashes({
      secret: input.fingerprintSecret,
      workspaceId: input.workspaceId,
      channel: input.channel,
      recipientHashes: messages.map(message => message.recipient_hash),
    });
  if (computedFingerprint !== input.audience.fingerprint) {
    throw new BulkCampaignAdmissionError(
      "Bulk campaign audience fingerprint does not match recipient hashes"
    );
  }
  const metadata = sanitizeAudienceMetadata(input.audience.metadata || {}, {
    itemCount: messages.length,
    uniqueRecipientCount: new Set(
      messages.map(message => message.recipient_hash)
    ).size,
  });
  const replacementHistory = metadata.replacementHistory;
  const { data, error } = await client.rpc("admit_bulk_campaign", {
    p_campaign_id: input.campaignId,
    p_workspace_id: input.workspaceId,
    p_channel: input.channel,
    p_name: input.name,
    p_template_name: input.templateName,
    p_template_language: input.templateLanguage,
    p_message_text: input.messageText,
    p_sent_by: input.sentBy,
    p_scenario_id: input.scenarioId,
    p_scenario_node_id: input.scenarioNodeId,
    p_execution_source: input.executionSource,
    p_workflow_id: input.workflowId,
    p_dispatch_status: input.dispatchStatus,
    p_requested_at: input.requestedAt,
    p_scheduled_at: input.scheduledAt,
    p_dispatch_expires_at: input.dispatchExpiresAt,
    p_audience_fingerprint: input.audience.fingerprint,
    p_audience_hash_version: input.audience.hashVersion,
    p_audience_source_type: input.audience.sourceType,
    p_audience_count: input.audience.count,
    p_audience_metadata: metadata,
    p_audience_original_filename: metadata.originalFilename || null,
    p_audience_uploaded_at: metadata.uploadedAt || null,
    p_audience_uploaded_by: metadata.uploadedBy || null,
    p_audience_content_hash: metadata.contentHash || null,
    p_audience_replacement_history: replacementHistory,
    p_retry_of_campaign_id: input.retryOfCampaignId,
    p_retry_kind: input.retryKind,
    p_company_bulk_campaign_limit: input.companyBulkCampaignLimit,
    p_expected_subscription_type: input.companySubscriptionType,
    p_provider_circuit_acknowledged_by:
      input.providerCircuitAcknowledgedBy ?? null,
    p_confirmation_fingerprint: input.confirmationFingerprint,
    p_messages: messages,
  });

  if (error) {
    const message =
      error.message || "Bulk campaign admission RPC failed without a message";
    if (isRequestDigestMismatchRpc(error)) {
      throw new BulkCampaignAdmissionPayloadMismatchError(message, error.code);
    }
    if (isMissingAdmissionRpc(error)) {
      throw new BulkCampaignAdmissionUnavailableError(message, error.code);
    }
    throw new BulkCampaignAdmissionError(message, error.code);
  }

  return parseAdmissionResult(data, input);
}
