export const CROSS_STORE_OUTBOX_DRAIN_WORKFLOW =
  "crossStoreOutboxDrainWorkflow";
export const CROSS_STORE_OUTBOX_DRAIN_WORKFLOW_CONTRACT_VERSION = 1;
export const CROSS_STORE_OUTBOX_DRAIN_ACTIVITY = "cross-store-outbox.drain";
export const CROSS_STORE_OUTBOX_DRAIN_SCHEDULE_ID = "cross-store-outbox:drain";
export const CROSS_STORE_OUTBOX_DRAIN_SCHEDULE_INTERVAL_MS = 60_000;
export const CROSS_STORE_OUTBOX_DRAIN_SCHEDULE_CATCHUP_WINDOW_MS = 5 * 60_000;
export const CROSS_STORE_OUTBOX_DRAIN_BATCH_LIMIT = 200;
export const CROSS_STORE_OUTBOX_DRAIN_MAX_BATCHES = 20;
export const CROSS_STORE_OUTBOX_DRAIN_MAX_DURATION_MS = 45_000;

export type CrossStoreOutboxDrainWorkflowInput = {
  contractVersion: number;
  batchLimit: number;
  maxBatches: number;
  maxDurationMs: number;
};

export type CrossStoreOutboxDrainActivityInput =
  CrossStoreOutboxDrainWorkflowInput;

export type CrossStoreOutboxDrainBatchResult = {
  recoveredStale: number;
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
  skippedUnsupported: number;
  analyticsBacklog: number;
  analyticsFailed: number;
  /** Persisted WhatsApp facts admitted and cleared during this batch. */
  customerWebhookIntentsAdmitted?: number;
  /** Persisted facts cleared because no active subscription wants their event. */
  customerWebhookIntentsSkipped?: number;
  /** More persisted facts remain; catch up only while admission makes progress. */
  customerWebhookIntentsHasMore?: boolean;
};

export type CrossStoreOutboxDrainStopReason =
  | "drained"
  | "max_batches"
  | "time_budget";

export type CrossStoreOutboxDrainActivityResult =
  CrossStoreOutboxDrainBatchResult & {
    batches: number;
    stopReason: CrossStoreOutboxDrainStopReason;
    durationMs: number;
  };

export type CrossStoreOutboxDrainWorkflowResult =
  CrossStoreOutboxDrainActivityResult;
