import type { WhatsAppComponent } from "../../shared/src/types/whatsapp";
import type { CampaignScheduleConfig } from "./campaign-schedule-config";

import type {
  ScenarioGeneratedRecipientCohort,
  ScenarioGeneratorChannel,
  ScenarioGeneratorSendMode,
  ScenarioGeneratorWorkflowKind,
} from "./scenario-generator";
import type { ScenarioActionType } from "./scenario-triggers";
import { isRecord } from "./value-guards";

export type BulkCampaignReadinessReason = {
  code:
    | "meta_business_limit"
    | "meta_sender_restricted"
    | "meta_billing"
    | "meta_disconnected"
    | "meta_check_unavailable"
    | "contact_frequency_limit";
  providerCode?: string;
  affectedRecipientCount?: number;
  eligibleRecipientCount?: number;
  nextEligibleAt?: string | null;
};

/** A current admission check, not a delivery guarantee or a quota reservation. */
export type BulkCampaignReadiness = {
  state: "ready" | "blocked" | "unavailable";
  checkedAt: string;
  remainingCapacity: null;
  reasons: BulkCampaignReadinessReason[];
};

export function isBulkCampaignReadiness(
  value: unknown,
): value is BulkCampaignReadiness {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<BulkCampaignReadiness>;
  if (
    !["ready", "blocked", "unavailable"].includes(row.state || "") ||
    typeof row.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(row.checkedAt)) ||
    row.remainingCapacity !== null ||
    !Array.isArray(row.reasons)
  )
    return false;
  const codes = new Set([
    "meta_business_limit",
    "meta_sender_restricted",
    "meta_billing",
    "meta_disconnected",
    "meta_check_unavailable",
    "contact_frequency_limit",
  ]);
  return (
    (row.state === "ready"
      ? row.reasons.length === 0
      : row.reasons.length > 0) &&
    row.reasons.every(
      (reason) =>
        reason &&
        typeof reason === "object" &&
        codes.has(reason.code) &&
        (reason.providerCode === undefined ||
          typeof reason.providerCode === "string") &&
        [reason.affectedRecipientCount, reason.eligibleRecipientCount].every(
          (count) =>
            count === undefined || (Number.isInteger(count) && count >= 0),
        ) &&
        (reason.nextEligibleAt === undefined ||
          reason.nextEligibleAt === null ||
          (typeof reason.nextEligibleAt === "string" &&
            Number.isFinite(Date.parse(reason.nextEligibleAt)))),
    )
  );
}

export function mergeBulkCampaignReadiness(
  checks: readonly (BulkCampaignReadiness | undefined)[],
): BulkCampaignReadiness {
  const valid = checks.filter(isBulkCampaignReadiness);
  const unavailable =
    valid.length !== checks.length ||
    !checks.length ||
    valid.some((check) => check.state === "unavailable");
  const blocked = valid.some((check) => check.state === "blocked");
  const reasons = valid.flatMap((check) => check.reasons);
  if (
    unavailable &&
    !reasons.some((reason) => reason.code === "meta_check_unavailable")
  )
    reasons.push({ code: "meta_check_unavailable" });
  return {
    state: blocked ? "blocked" : unavailable ? "unavailable" : "ready",
    checkedAt: valid.length
      ? new Date(
          Math.min(...valid.map((check) => Date.parse(check.checkedAt))),
        ).toISOString()
      : new Date().toISOString(),
    remainingCapacity: null,
    reasons: Array.from(
      new Map(
        reasons.map((reason) => [JSON.stringify(reason), reason]),
      ).values(),
    ),
  };
}

export type ScenarioGenerationStatus =
  | "idle"
  | "planning"
  | "needs_input"
  | "queued"
  | "generating_media"
  | "complete"
  | "failed";

export type ScenarioGeneratedAssetKind =
  | "image"
  | "video"
  | "audio"
  | "document";

export type ScenarioGeneratedAssetSource =
  | "uploaded"
  | "vertex"
  | "elevenlabs"
  | "higgsfield";

export type ScenarioGeneratedAsset = {
  id: string;
  kind: ScenarioGeneratedAssetKind;
  source: ScenarioGeneratedAssetSource;
  url: string;
  mimeType?: string;
  fileName?: string;
  durationSeconds?: number;
  status?: "queued" | "complete" | "failed";
  providerOperationId?: string;
};

export type ScenarioGeneratedTemplateDraft = {
  id: string;
  name: string;
  language: string;
  category?: string;
  status:
    | "draft"
    | "submitting"
    | "submitted"
    | "pending"
    | "approved"
    | "rejected";
  headerMediaUrl?: string;
  headerMediaFormat?: "IMAGE" | "VIDEO" | "DOCUMENT";
  components?: WhatsAppComponent[];
  metaTemplateId?: string;
  error?: string;
};

export type ScenarioBulkBatchPlan = {
  batchSize: number;
  delayMs: number;
  ratePerSecond: number;
  rateSource: string;
  throughputLevel?: string | null;
};

export type ScenarioBulkRecipientLimit = {
  maxRecipients: number | null;
  rawLimit?: string | null;
  source: "live_meta" | "cached_meta" | "channel_default" | "unavailable";
  warning?: string | null;
  error?: string | null;
  unlimited?: boolean;
};

export type ScenarioGeneratedSendState = {
  /** Immutable recipient-generation job owned by this logical send. */
  revision: string;
  /** Server-owned parent operation; child campaign identities stay in SQL. */
  operationId: string;
  state: "completed";
  requestedAt: string;
  completedAt: string;
};

/** Same shape as CampaignRecipientLike from campaign-variable-values. */
export type ScenarioCampaignRecipient = {
  phone?: string;
  chatId?: string;
  email?: string;
  name?: string;
  birthday?: string;
  sourceId?: string | null;
  fields?: Record<string, string>;
  variables?: Record<string, string>;
};

export const BULK_CAMPAIGN_AUDIENCE_REPLACEMENT_HISTORY_LIMIT = 25;

export type BulkCampaignAudienceReplacementEvidence = {
  action: "replaced" | "cleared";
  replacedAt: string;
  previousFilename?: string;
  nextFilename?: string;
};

/**
 * Browser-safe evidence about the selected file. Actor identity and content
 * hashes are deliberately server-owned and must never be accepted here.
 */
export type BulkCampaignAudienceUploadEvidence = {
  originalFilename?: string;
  selectedAt?: string;
  replacementHistory?: BulkCampaignAudienceReplacementEvidence[];
};

export const BULK_CAMPAIGN_RECIPIENT_POLICY_VERSION = 1 as const;

export type BulkCampaignRecipientPolicy = {
  version: typeof BULK_CAMPAIGN_RECIPIENT_POLICY_VERSION;
  excludePriorFailedBulkSends: boolean;
};

export function normalizeBulkCampaignRecipientPolicy(
  value: unknown,
): BulkCampaignRecipientPolicy {
  if (value == null) {
    return {
      version: BULK_CAMPAIGN_RECIPIENT_POLICY_VERSION,
      excludePriorFailedBulkSends: false,
    };
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Bulk campaign recipient policy must be an object");
  }

  const policy = value as Record<string, unknown>;
  if (policy.version !== BULK_CAMPAIGN_RECIPIENT_POLICY_VERSION) {
    throw new TypeError(
      `Unsupported bulk campaign recipient policy version: ${String(policy.version)}`,
    );
  }
  if (typeof policy.excludePriorFailedBulkSends !== "boolean") {
    throw new TypeError(
      "Bulk campaign recipient policy excludePriorFailedBulkSends must be a boolean",
    );
  }

  return {
    version: BULK_CAMPAIGN_RECIPIENT_POLICY_VERSION,
    excludePriorFailedBulkSends: policy.excludePriorFailedBulkSends,
  };
}

export type BulkCampaignAnalyticsAudienceIntent = {
  filters: {
    days?: string | number;
    from?: string;
    to?: string;
    timezone?: string;
    templates?: string[];
    campaignIds?: string[];
    status?: "all" | "replied" | "not_replied";
    engagement?: "all" | "high" | "medium" | "low" | "unscored";
    conversationScope?:
      | "campaign_sends"
      | "all"
      | "fresh"
      | "campaign_or_fresh";
    messageContains?: string;
    messageContainsMode?: "contains" | "not_contains";
    replyWindowHours?: string | number;
    excludeRecentClientMessageWithin24h?: boolean;
    excludeTemplates?: boolean;
  };
  previewCount?: number | null;
  variableConfigs?: Record<
    string,
    {
      mode: "auto" | "contact_name" | "recipient_phone" | "custom";
      customValue?: string;
    }
  >;
};

export type BulkCampaignAudienceIntent =
  | {
      kind: "inline";
      recipients: ScenarioCampaignRecipient[];
      uploadEvidence?: BulkCampaignAudienceUploadEvidence;
    }
  | {
      kind: "analytics_with_fill_up";
      analytics: BulkCampaignAnalyticsAudienceIntent;
      fillUpRecipients: ScenarioCampaignRecipient[];
    }
  | { kind: "registered_users"; selectedUserIds?: string[] }
  | { kind: "registered_business_phones"; selectedPhones?: string[] }
  | {
      kind: "telegram_subscribers";
      sourceId: string;
      selectedChatIds?: string[];
    };

export type BulkCampaignEligibilityMessageIntent =
  | {
      kind: "whatsapp_template";
      sourceId: string;
      templateName: string;
      language: string;
    }
  | {
      kind: "unsupported";
      messageKind: "whatsapp_service_text" | "telegram" | "email";
    };

export type BulkCampaignProvenanceIntent =
  | { kind: "ad_hoc" }
  | {
      kind: "scenario_run_now";
      scenarioId: string;
      rootNodeId: string;
      actionNodeId?: string;
      columnSplitNodeId?: string;
    };

export type BulkCampaignSkipReason =
  | "ineligible"
  | "marketing_opt_out"
  | "recipient_limit"
  | "prior_failure"
  | "service_window"
  | "unsubscribed"
  /** Contacted within the workspace's contact policy window. */
  | "recent_contact";

export type BulkCampaignCommandDisposition =
  | "queued"
  | "scheduled"
  | "no_op"
  | "blocked"
  | "failed";

export type BulkCampaignSuccessOutcome = {
  disposition: "queued" | "scheduled" | "no_op";
  evaluatedAt: string;
  lifecycleStatus:
    | "queued"
    | "scheduled"
    | "running"
    | "completed"
    | "failed"
    | "expired"
    | "cancelled";
  requestedTotal: number;
  acceptedTotal: number;
  queuedTotal: number;
  uniqueRecipients: { requested: number; accepted: number; queued: number };
  skippedByReason: Partial<Record<BulkCampaignSkipReason, number>>;
  warnings: { missingMarketingConsent: number };
  campaignId?: string;
  dispatchId?: string;
  workflowId?: string;
};

export type BulkCampaignCommandResult =
  | { ok: true; outcome: BulkCampaignSuccessOutcome }
  | {
      ok: false;
      disposition: "blocked" | "failed";
      code: string;
      message: string;
      partialOutcome?: BulkCampaignSuccessOutcome;
    };

export const SCENARIO_BULK_UPLOADED_AUDIENCE_SOURCE = "uploaded" as const;
export const SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE =
  "registered_business_phones" as const;
export const SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE =
  "telegram_subscribers" as const;
export const SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE =
  "customer_birthdays" as const;

export const SCENARIO_BULK_RECIPIENT_AUDIENCE_SOURCES = [
  SCENARIO_BULK_UPLOADED_AUDIENCE_SOURCE,
  SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE,
  SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE,
  SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
] as const;

export type ScenarioBulkRecipientAudienceSource =
  (typeof SCENARIO_BULK_RECIPIENT_AUDIENCE_SOURCES)[number];

export type CampaignVariableSourceMode =
  | "auto"
  | "csv_variable"
  | "csv_column"
  | "contact_name"
  | "recipient_phone"
  | "custom";

export type CampaignVariableSourceConfig = {
  mode: CampaignVariableSourceMode;
  csvColumn?: string;
  customValue?: string;
};

export const CAMPAIGN_BIRTHDAY_CONFIG_VERSION = 1 as const;
export const CAMPAIGN_BIRTHDAY_LEAP_DAY_POLICIES = ["feb_28"] as const;

export type CampaignBirthdayLeapDayPolicy =
  (typeof CAMPAIGN_BIRTHDAY_LEAP_DAY_POLICIES)[number];

export type CampaignBirthdayConfig = {
  version: typeof CAMPAIGN_BIRTHDAY_CONFIG_VERSION;
  leapDayPolicy: CampaignBirthdayLeapDayPolicy;
};

export type CampaignBirthdayImportResult = {
  total: number;
  imported: number;
  updated: number;
  skippedMissingPhone: number;
  skippedMissingChatId: number;
  skippedIneligibleTelegramSubscriber: number;
  skippedMissingBirthday: number;
  skippedInvalidBirthday: number;
};

export type ScenarioBulkRootConfig = {
  workflowKind: ScenarioGeneratorWorkflowKind;
  sendMode: ScenarioGeneratorSendMode;
  channels: ScenarioGeneratorChannel[];
  sourceIds?: string[];
  campaignName: string;
  recipientSourceSummary: string;
  recipientAudienceSource?: ScenarioBulkRecipientAudienceSource;
  telegramSubscriberSourceId?: string;
  telegramSubscriberCount?: number;
  generationStatus: ScenarioGenerationStatus;
  uploadedRecipients?: ScenarioCampaignRecipient[];
  audienceUploadEvidence?: BulkCampaignAudienceUploadEvidence;
  audienceRevision?: number;
  batchPlan?: ScenarioBulkBatchPlan;
  recipientLimit?: ScenarioBulkRecipientLimit;
  recipientPolicy?: BulkCampaignRecipientPolicy;
  /** Final generated channel/source message rows, not logical recipients. */
  generatedRecipientCount?: number;
  generationJobId?: string;
  /**
   * Completion marker for the generated revision. This is deliberately
   * separate from the numeric manual-upload audience revision.
   */
  generatedSendState?: ScenarioGeneratedSendState;
  cohorts?: ScenarioGeneratedRecipientCohort[];
  sendStatus?: {
    total: number;
    queued: number;
    sent: number;
    skipped: number;
    failed: number;
    campaignId?: string;
    dispatchId?: string;
    workflowId?: string;
    lifecycleStatus?:
      | "queued"
      | "scheduled"
      | "running"
      | "completed"
      | "failed"
      | "expired"
      | "cancelled";
    audienceFingerprint?: string;
    audienceRevision?: number;
    overlap?: {
      kind?: "none" | "high" | "exact" | "unknown";
      intersectionCount: number;
      candidateCount: number;
      ratio: number;
    };
    lastSendAttemptAt?: string;
    scheduledAt?: string;
    lastOutcome?: BulkCampaignSuccessOutcome;
  };
  scheduleConfig?: CampaignScheduleConfig;
  birthdayConfig?: CampaignBirthdayConfig;
};

/**
 * Returns the immutable generated-audience revision when this bulk root is
 * owned by Scenario Generator. Recipient counts are derived state and must
 * never decide whether a generated root falls back to manual sending.
 */
export function getScenarioBulkGenerationRevision(
  config: ScenarioBulkRootConfig | null | undefined,
): string | null {
  const revision = config?.generationJobId?.trim();
  return revision || null;
}

/**
 * A builder bulk-campaign root, read from the graph itself rather than from
 * Scenario.mode. Follow-up workflow roots share kind "bulk" but never send.
 */
export function isBulkCampaignRootNode(node: unknown): boolean {
  if (!isRecord(node) || !isRecord(node.data)) return false;
  const config = node.data.bulkRootConfig;
  return (
    node.data.kind === "bulk" &&
    isRecord(config) &&
    config.workflowKind === "bulk_campaign"
  );
}

export type ScenarioBulkWhatsAppTemplateSendBlockReason =
  | "missing"
  | "stale"
  | "not_approved"
  | "draft"
  | "pending_review"
  | "rejected";

export type ScenarioBulkConnectedAction = {
  nodeId: string;
  actionType?: ScenarioActionType | null;
  channel?: ScenarioGeneratorChannel;
  replyMode?: "ai" | "fixed";
  replyText?: string;
  templateName?: string;
  templateLanguage?: string;
  templateCategory?: string;
  templateVariables?: string[];
  templateComponents?: WhatsAppComponent[];
  previewText?: string;
  /** Set when WhatsApp template cannot be sent (stale / not approved / draft). */
  templateSendBlockReason?: ScenarioBulkWhatsAppTemplateSendBlockReason | null;
};

export type ScenarioBulkColumnSplitRoutePreview = {
  pathId: string;
  pathLabel?: string;
  handleId: string;
  recipientCount: number;
  actionNodeId?: string;
  templateName?: string;
  templateSendBlockReason?: ScenarioBulkWhatsAppTemplateSendBlockReason | null;
  isElse?: boolean;
};

export type ScenarioBulkColumnSplitPreview = {
  splitNodeId: string;
  routes: ScenarioBulkColumnSplitRoutePreview[];
  elseCount: number;
  total: number;
  ready: boolean;
  disabledReason?: string | null;
};

export type ScenarioBulkSendOptions = {
  /** One browser-attempt key; server-owned operation recovery remains authoritative. */
  idempotencyKey?: string;
  /** Explicit operator acknowledgement for a terminal generated-media failure. */
  acknowledgeMediaFailures?: boolean;
  recipientPolicy?: BulkCampaignRecipientPolicy;
  provenance?: BulkCampaignProvenanceIntent;
  recipients?: ScenarioCampaignRecipient[];
  registeredBusinessPhonesAudience?: {
    type: typeof SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE;
    previewCount?: number | null;
    selectedPhones?: string[];
  };
  telegramSubscribersAudience?: {
    type: typeof SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE;
    sourceId: string;
    previewCount?: number | null;
    selectedChatIds?: string[];
  };
  variableConfigs?: Record<string, CampaignVariableSourceConfig>;
  audienceUploadEvidence?: BulkCampaignAudienceUploadEvidence;
  audienceConfirmationFingerprint?: string;
  overflowQueueConfirmed?: boolean;
  scheduledAt?: string | null;
  /** When true, send uses per-recipient templates from column-split routing. */
  useColumnSplitRouting?: boolean;
};
