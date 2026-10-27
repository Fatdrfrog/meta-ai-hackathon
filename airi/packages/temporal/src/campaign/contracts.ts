import type { BulkCampaignDispatchExecutionSource } from "@icecore/scenario-contracts";

export type {
  CampaignScheduleReconcileActivityInput,
  CampaignScheduleReconcileWorkflowInput,
  CampaignScheduleReconcileWorkflowResult,
} from "@icecore/scenario-contracts";

export const BULK_CAMPAIGN_DISPATCH_WORKFLOW = "bulkCampaignDispatchWorkflow";
export const BULK_CAMPAIGN_DISPATCH_WORKFLOW_CONTRACT_VERSION = 3;
/**
 * Meta unique-user messaging cap is a moving 24h window on delivered users,
 * shared across the business portfolio. Sleep starts after the previous
 * wave's last batch returns; extra settle/skew/jitter keep the next wave
 * off the window edge and off a synchronized Graph spike.
 */
export const BULK_CAMPAIGN_OVERFLOW_QUEUE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Cloud API accept is not Meta "delivered". */
export const BULK_CAMPAIGN_OVERFLOW_QUEUE_DELIVERY_SETTLE_MS = 5 * 60 * 1000;
/** Worker clock vs Meta. */
export const BULK_CAMPAIGN_OVERFLOW_QUEUE_CLOCK_SKEW_MS = 30 * 1000;
/** Deterministic extra wait. Hash(campaignId, waveIndex); no Math.random. */
export const BULK_CAMPAIGN_OVERFLOW_QUEUE_JITTER_MAX_MS = 60 * 1000;
export const BULK_CAMPAIGN_OVERFLOW_QUEUE_BOUNDARY_PADDING_MS =
  BULK_CAMPAIGN_OVERFLOW_QUEUE_DELIVERY_SETTLE_MS +
  BULK_CAMPAIGN_OVERFLOW_QUEUE_CLOCK_SKEW_MS;
export const BULK_CAMPAIGN_OVERFLOW_QUEUE_BASE_INTERVAL_MS =
  BULK_CAMPAIGN_OVERFLOW_QUEUE_WINDOW_MS +
  BULK_CAMPAIGN_OVERFLOW_QUEUE_BOUNDARY_PADDING_MS;
/** Worst-case gap (base + max jitter). Use for lastWaveAt / GCS retain. */
export const BULK_CAMPAIGN_OVERFLOW_QUEUE_INTERVAL_MS =
  BULK_CAMPAIGN_OVERFLOW_QUEUE_BASE_INTERVAL_MS +
  BULK_CAMPAIGN_OVERFLOW_QUEUE_JITTER_MAX_MS;

export const CAMPAIGN_NODE_RUN_WORKFLOW = "campaignNodeRunWorkflow";
export const CAMPAIGN_NODE_RUN_WORKFLOW_CONTRACT_VERSION = 2;
export const CAMPAIGN_EXECUTION_WORKFLOW = "campaignExecutionWorkflow";
export const CAMPAIGN_EXECUTION_WORKFLOW_CONTRACT_VERSION = 2;

export const CAMPAIGN_NODE_RUN_ACTIVITY = "campaignNodeRunActivity";
export const CAMPAIGN_DELIVERY_DRAIN_ACTIVITY = "campaignDeliveryDrainActivity";
export const CAMPAIGN_EXECUTION_FINALIZE_ACTIVITY =
  "campaignExecutionFinalizeActivity";

export const BULK_CAMPAIGN_DISPATCH_SEND_BATCH_ACTIVITY =
  "bulkCampaignDispatchSendBatch";
export const BULK_CAMPAIGN_DISPATCH_FINALIZE_ACTIVITY =
  "bulkCampaignDispatchFinalize";
export const BULK_CAMPAIGN_DISPATCH_BEGIN_ACTIVITY =
  "bulkCampaignDispatchBegin";
export const BULK_CAMPAIGN_DISPATCH_PROGRESS_ACTIVITY =
  "bulkCampaignDispatchProgress";
export const BULK_CAMPAIGN_DISPATCH_LIFECYCLE_FINALIZE_ACTIVITY =
  "bulkCampaignDispatchLifecycleFinalize";
export const BULK_CAMPAIGN_DISPATCH_PAUSE_SIGNAL =
  "bulkCampaignDispatchPause";
export const BULK_CAMPAIGN_DISPATCH_PAUSED_QUERY =
  "bulkCampaignDispatchPaused";
export const BULK_CAMPAIGN_DISPATCH_PAUSE_WAIT_QUERY =
  "bulkCampaignDispatchPauseWaitSupported";
/** Ledger marker while dispatch stays queued/scheduled/running. */
export const BULK_CAMPAIGN_DISPATCH_PAUSED_STOP_REASON = "paused_by_operator";

/** Persists Temporal Schedules for bulk-campaign scenario nodes (Mongo + Temporal Schedule API). */
export const CAMPAIGN_SCHEDULE_RECONCILE_WORKFLOW =
  "campaignScheduleReconcileWorkflow";
export const CAMPAIGN_SCHEDULE_RECONCILE_WORKFLOW_CONTRACT_VERSION = 1;
export const CAMPAIGN_SCHEDULE_RECONCILE_ACTIVITY =
  "campaignScheduleReconcileActivity";

/** Temporal Schedule action workflow for one exact scheduled occurrence. */
export const CAMPAIGN_SCHEDULE_ACTION_WORKFLOW =
  "campaignScheduleActionWorkflow";
export const CAMPAIGN_SCHEDULE_ACTION_WORKFLOW_CONTRACT_VERSION = 1;
export const CAMPAIGN_SCHEDULE_ACTION_CLAIM_ACTIVITY =
  "campaignScheduleActionClaimActivity";
export const CAMPAIGN_SCHEDULE_ACTION_COMPLETE_ACTIVITY =
  "campaignScheduleActionCompleteActivity";
export const TEMPORAL_SCHEDULED_START_TIME_SEARCH_ATTRIBUTE =
  "TemporalScheduledStartTime";

export function sanitizeTemporalWorkflowIdPart(value: string): string {
  return String(value || "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-");
}

export function buildBulkCampaignDispatchWorkflowId(params: {
  workspaceId: string;
  executionId: string;
}): string {
  const workspaceId = sanitizeTemporalWorkflowIdPart(
    params.workspaceId || "workspace",
  );
  const executionId = sanitizeTemporalWorkflowIdPart(
    params.executionId || "run",
  );
  return `bulk-campaign-dispatch:${workspaceId}:${executionId}`;
}

export function buildCampaignNodeRunWorkflowId(params: {
  workspaceId: string;
  scenarioId: string;
  nodeId: string;
  executionId: string;
}): string {
  const workspaceId = sanitizeTemporalWorkflowIdPart(
    params.workspaceId || "workspace",
  );
  const scenarioId = sanitizeTemporalWorkflowIdPart(
    params.scenarioId || "scenario",
  );
  const nodeId = sanitizeTemporalWorkflowIdPart(params.nodeId || "node");
  const executionId = sanitizeTemporalWorkflowIdPart(
    params.executionId || "run",
  );
  return `campaign-node-run:${workspaceId}:${scenarioId}:${nodeId}:${executionId}`;
}

export function buildCampaignNodeScheduledWorkflowId(params: {
  workspaceId: string;
  scenarioId: string;
  nodeId: string;
}): string {
  return buildCampaignNodeRunWorkflowId({
    workspaceId: params.workspaceId,
    scenarioId: params.scenarioId,
    nodeId: params.nodeId,
    executionId: "scheduled",
  });
}

export function buildCampaignNodeScheduledOccurrenceWorkflowId(params: {
  workspaceId: string;
  scenarioId: string;
  nodeId: string;
  scheduledFor: string;
}): string {
  return buildCampaignNodeRunWorkflowId({
    workspaceId: params.workspaceId,
    scenarioId: params.scenarioId,
    nodeId: params.nodeId,
    executionId: `scheduled:${params.scheduledFor}`,
  });
}

export function buildCampaignScheduleActionWorkflowId(params: {
  scheduleId: string;
}): string {
  const scheduleId = sanitizeTemporalWorkflowIdPart(
    params.scheduleId || "schedule",
  );
  return `campaign-schedule-action:${scheduleId}`;
}

export type BulkCampaignDispatchChannel = "whatsapp" | "telegram" | "email";
export const BULK_CAMPAIGN_DISPATCH_LIFECYCLE_STATES = [
  "queued",
  "scheduled",
  "running",
  "completed",
  "failed",
  "expired",
  "cancelled",
] as const;
export type BulkCampaignDispatchLifecycleState =
  (typeof BULK_CAMPAIGN_DISPATCH_LIFECYCLE_STATES)[number];

export type BulkCampaignEmailContent = {
  format: "markdown";
  subject: string;
  markdown: string;
};

export type BulkCampaignDispatchBatchPlan = {
  batchSize: number;
  delayMs: number;
  ratePerSecond: number;
  rateSource: string;
  throughputLevel?: string | null;
  /** Unique recipients per 24h wave when the audience exceeds the live cap. */
  dailyWaveLimit?: number;
};

export type BulkCampaignWhatsAppMarketingMessagePricing = {
  perMessageBidMultiplier?: number;
};

type BulkCampaignDispatchItemBase = {
  workspaceId: string;
  /** Immutable campaign_messages item identity. Absent only for legacy rows. */
  snapshotOrdinal?: number;
  campaignId?: string | null;
  scenarioId?: string | null;
  scenarioNodeId?: string | null;
  generatedRecipientMessageId?: string | null;
  executionSource?: BulkCampaignDispatchExecutionSource;
  sentByUserId?: string | null;
};

/** Activity input: inline batch or slice loaded from GCS staging (keeps workflow history small). */
type BulkCampaignDispatchSendBatchSource =
  | { mode: "inline"; items: BulkCampaignDispatchItem[] }
  | {
      mode: "store";
      workspaceId: string;
      payloadKey: string;
      offset: number;
      limit: number;
    };

type BulkCampaignDispatchLifecycleBatchIdentity =
  | {
      lifecycleManaged: true;
      campaignId: string;
      batchKey?: string;
    }
  | {
      lifecycleManaged?: false;
      campaignId?: never;
    };

export type BulkCampaignDispatchSendBatchInput =
  BulkCampaignDispatchSendBatchSource &
    BulkCampaignDispatchLifecycleBatchIdentity;

export type BulkCampaignDispatchItem =
  | (BulkCampaignDispatchItemBase & {
      channel: "whatsapp";
      whatsappMessageType?: "template";
      sourceId?: string;
      recipient: {
        phone: string;
        email?: string;
        /** The row's own name, kept on a new or placeholder contact. */
        name?: string;
      };
      phoneNumberId: string;
      marketingMessagePricing?: BulkCampaignWhatsAppMarketingMessagePricing;
      templateName: string;
      languageCode?: string;
      /** Mirrors approved template category (AUTHENTICATION needs phone-only recipient). */
      templateCategory?: "MARKETING" | "UTILITY" | "AUTHENTICATION";
      components?: unknown[];
    })
  | (BulkCampaignDispatchItemBase & {
      channel: "whatsapp";
      whatsappMessageType: "service_text";
      sourceId: string;
      recipient: {
        phone: string;
        email?: string;
        /** The row's own name, kept on a new or placeholder contact. */
        name?: string;
      };
      phoneNumberId: string;
      messageText: string;
      serviceWindowExpiresAt: string;
    })
  | (BulkCampaignDispatchItemBase & {
      channel: "telegram";
      sourceId?: string;
      businessConnectionId?: string;
      recipient: {
        chatId: string;
      };
      messageText: string;
    })
  | (BulkCampaignDispatchItemBase & {
      channel: "email";
      recipient: {
        email: string;
        variables?: Record<string, string>;
      };
      fromAddress?: string;
      templateKey?: "announcement" | "product_update" | "event_reminder";
      templateModel?: Record<string, string>;
      subjectOverride?: string;
      emailContent?: BulkCampaignEmailContent;
      messageStream?: string;
    });

/**
 * Stable campaign_messages.recipient key. This is operational persistence
 * identity, not a display label and not the HMAC audience hash.
 */
export function buildBulkCampaignDispatchLogicalRecipientKey(
  item: BulkCampaignDispatchItem,
): string | null {
  if (item.channel === "whatsapp") {
    const phone = item.recipient.phone.replace(/\D/g, "");
    return phone || null;
  }
  if (item.channel === "telegram") {
    const sourceId = item.sourceId?.trim().normalize("NFC").toLowerCase();
    const chatId = item.recipient.chatId.trim().normalize("NFC");
    return sourceId && chatId ? `${sourceId}:${chatId}` : null;
  }
  const email = item.recipient.email.trim().normalize("NFC").toLowerCase();
  return email || null;
}

export type BulkCampaignDispatchWorkflowInput = {
  contractVersion: number;
  /** Only v3 admitted campaigns have immutable recipient snapshots/lifecycle. */
  lifecycleManaged?: boolean;
  workspaceId: string;
  campaignId?: string | null;
  /** Server-recorded request time used to audit expiry. */
  requestedAt?: string | null;
  /** Dispatch is terminal when this deadline passes before work begins. */
  dispatchExpiresAt?: string | null;
  scheduledAt?: string | null;
  batchPlan: BulkCampaignDispatchBatchPlan;
  /** Used when the full list fits Temporal payload limits (see inline payload guard in API). */
  items?: BulkCampaignDispatchItem[];
  /**
   * GCS object path (written by web) holding JSON.stringify(items). Use with `itemCount` instead of `items` for large campaigns.
   */
  itemsPayloadKey?: string | null;
  /** Total items when using `itemsPayloadKey`. */
  itemCount?: number;
  /**
   * Unique-recipient send cap for one rolling 24h wave. Remaining items wait
   * `BULK_CAMPAIGN_OVERFLOW_QUEUE_BASE_INTERVAL_MS` plus jitter.
   */
  dailyWaveLimit?: number;
  continuation?: {
    nextIndex: number;
    processedCount: number;
    acceptedCount: number;
    failedCount: number;
    attemptedCount: number;
    batchCount: number;
    paused: boolean;
  };
};

export function resolveBulkCampaignOverflowQueueJitterMs(params: {
  seed?: string | null;
  waveIndex: number;
}): number {
  const seed = params.seed?.trim();
  if (!seed) return 0;
  const key = `${seed}\u0000${Math.max(0, Math.floor(params.waveIndex))}`;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % (BULK_CAMPAIGN_OVERFLOW_QUEUE_JITTER_MAX_MS + 1);
}

export function resolveBulkCampaignDispatchBatchLimit(params: {
  index: number;
  batchSize: number;
  totalItems: number;
  dailyWaveLimit?: number | null;
}): number {
  const remaining = Math.max(0, params.totalItems - params.index);
  if (remaining <= 0) return 0;
  const batchSize = Math.max(1, Math.floor(params.batchSize || 1));
  const waveLimit =
    typeof params.dailyWaveLimit === "number" &&
    Number.isInteger(params.dailyWaveLimit) &&
    params.dailyWaveLimit > 0
      ? params.dailyWaveLimit
      : remaining;
  const remainingInWave = waveLimit - (params.index % waveLimit);
  return Math.max(1, Math.min(batchSize, remaining, remainingInWave));
}

export function resolveBulkCampaignDispatchInterBatchDelayMs(params: {
  index: number;
  batchSize: number;
  totalItems: number;
  delayMs: number;
  dailyWaveLimit?: number | null;
  jitterSeed?: string | null;
}): number {
  const nextIndex = params.index + params.batchSize;
  if (nextIndex >= params.totalItems) return 0;
  const waveLimit =
    typeof params.dailyWaveLimit === "number" &&
    Number.isInteger(params.dailyWaveLimit) &&
    params.dailyWaveLimit > 0
      ? params.dailyWaveLimit
      : params.totalItems;
  if (
    Math.floor(params.index / waveLimit) !==
    Math.floor(nextIndex / waveLimit)
  ) {
    return (
      BULK_CAMPAIGN_OVERFLOW_QUEUE_BASE_INTERVAL_MS +
      resolveBulkCampaignOverflowQueueJitterMs({
        seed: params.jitterSeed,
        waveIndex: Math.floor(nextIndex / waveLimit),
      })
    );
  }
  return Math.max(0, Math.floor(params.delayMs || 0));
}

export type BulkCampaignDispatchSendResult = {
  channel: BulkCampaignDispatchChannel;
  recipient: string;
  success: boolean;
  messageId?: string;
  error?: string;
  failureScope?: "provider" | "recipient" | "unknown";
  provider?: string;
  code?: string;
  /** True when result came from a prior successful attempt (Temporal activity retry). */
  deduped?: boolean;
  /** False only when provider I/O was intentionally skipped. */
  attempted?: boolean;
};

export type BulkCampaignDispatchBatchResult = {
  results: BulkCampaignDispatchSendResult[];
  successfulSends: number;
  failedSends: number;
  /** Missing on activity results recorded before service-window skipping existed. */
  notAttemptedSends?: number;
  providerCircuit?: {
    state: "open" | "closed";
    provider?: string;
    code?: string;
  };
};

export type BulkCampaignDispatchFinalizeInput = {
  workspaceId: string;
  campaignId: string;
  successfulSends: number;
  failedSends: number;
};

export type BulkCampaignDispatchBeginInput = {
  campaignId: string;
};

export type BulkCampaignDispatchBeginResult = {
  outcome:
    | "started"
    | "already_started"
    | "workflow_mismatch"
    | "expired"
    | "cancelled"
    | "not_dispatchable"
    | "not_found";
  status: BulkCampaignDispatchLifecycleState | null;
  workflowId: string | null;
};

export type BulkCampaignDispatchProgressInput = {
  campaignId: string;
  processedCount: number;
  acceptedCount: number;
  failedCount: number;
  attemptedCount: number;
  notAttemptedCount: number;
};

export type BulkCampaignDispatchLifecycleFinalizeInput =
  BulkCampaignDispatchProgressInput & {
    workspaceId: string;
    status: Extract<
      BulkCampaignDispatchLifecycleState,
      "completed" | "failed" | "expired" | "cancelled"
    >;
    stopReason?: string | null;
    providerCircuit?: {
      state: "open" | "closed";
      provider?: string;
      code?: string;
    };
  };

export type BulkCampaignDispatchWorkflowResult = {
  campaignId?: string | null;
  processed: number;
  successfulSends: number;
  failedSends: number;
  batchCount: number;
  terminalState?: Extract<
    BulkCampaignDispatchLifecycleState,
    "completed" | "failed" | "expired" | "cancelled"
  >;
  attemptedCount?: number;
  notAttemptedCount?: number;
  stopReason?: string | null;
  providerCircuit?: BulkCampaignDispatchBatchResult["providerCircuit"];
};

export type CampaignNodeRunWorkflowInput = {
  contractVersion: number;
  workspaceId: string;
  scenarioId: string;
  nodeId: string;
  scheduledAt?: string | null;
  scheduledFor?: string | null;
  scheduleId?: string | null;
  executionSource?: BulkCampaignDispatchExecutionSource;
  forceShadow?: boolean;
  ignoreExistingDeliveryTasks?: boolean;
};

export type CampaignNodeRunActivityInput = CampaignNodeRunWorkflowInput;
export type CampaignNodeAudienceSource = "explicit" | "dynamic" | "birthday";

export type CampaignNodeRunActivityResult = {
  status: "materialized" | "shadow" | "skipped";
  shadowMode: boolean;
  scenarioId: string;
  nodeId: string;
  campaignId?: string | null;
  audienceSource?: CampaignNodeAudienceSource;
  runKey?: string;
  deliveryRuntime: "campaign_delivery";
  candidates: number;
  created: number;
  wouldCreate: number;
  pendingCount: number;
  batchPlan?: BulkCampaignDispatchBatchPlan;
  reason?: string;
};

export type CampaignDeliveryDrainInput = {
  workspaceId: string;
  campaignId: string;
  batchLimit?: number;
};

export type CampaignDeliveryDrainResult = {
  processed: number;
  completed: number;
  retried: number;
  failedTerminal: number;
  skipped: number;
  recoveredStale: number;
  pendingCount: number;
  nextDispatchAt?: string | null;
};

export type CampaignExecutionFinalizeInput = {
  workspaceId: string;
  campaignId: string;
};

export type CampaignExecutionWorkflowInput = {
  contractVersion: number;
  workspaceId: string;
  scenarioId: string;
  nodeId: string;
  campaignId: string;
  batchPlan: BulkCampaignDispatchBatchPlan;
  audienceSource?: CampaignNodeAudienceSource;
  runKey?: string;
  scheduledFor?: string | null;
};

export type CampaignExecutionWorkflowResult = {
  scenarioId: string;
  nodeId: string;
  campaignId: string;
  audienceSource?: CampaignNodeAudienceSource;
  runKey?: string;
  processed: number;
  completed: number;
  retried: number;
  failedTerminal: number;
  skipped: number;
  recoveredStale: number;
  pendingCount: number;
  batchCount: number;
};

export type CampaignNodeRunWorkflowResult = {
  scenarioId: string;
  nodeId: string;
  campaignId?: string | null;
  status: "materialized" | "shadow" | "skipped";
  shadowMode: boolean;
  audienceSource?: CampaignNodeAudienceSource;
  runKey?: string;
  candidates: number;
  created: number;
  wouldCreate: number;
  processed: number;
  completed: number;
  retried: number;
  failedTerminal: number;
  skipped: number;
  pendingCount: number;
  batchCount: number;
  executionWorkflowId?: string | null;
  reason?: string;
};

export type CampaignScheduleActionWorkflowInput = {
  contractVersion: number;
  workspaceId: string;
  scenarioId: string;
  nodeId: string;
  scheduleId: string;
};

export type CampaignScheduleActionClaimActivityInput =
  CampaignScheduleActionWorkflowInput & {
    actionWorkflowId: string;
    actionWorkflowRunId: string;
    actionFirstExecutionRunId: string;
    scheduledFor?: string | null;
    actionRunStartedAt?: string | null;
  };

export type CampaignScheduleActionClaimActivityResult = {
  status: "claimed" | "duplicate";
  scheduleId: string;
  scheduledFor: string;
  takenAt?: string | null;
  existingChildWorkflowId?: string | null;
};

export type CampaignScheduleActionCompleteActivityInput =
  CampaignScheduleActionWorkflowInput & {
    scheduledFor: string;
    actionWorkflowId: string;
    actionWorkflowRunId: string;
    childWorkflowId: string;
  };

export type CampaignScheduleActionWorkflowResult = {
  status: "started" | "duplicate";
  scheduleId: string;
  scheduledFor: string;
  childWorkflowId?: string | null;
};
