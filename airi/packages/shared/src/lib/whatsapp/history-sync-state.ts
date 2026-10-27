/** Connection-scoped request state plus a read projection of durable history receipts. */
export type WhatsAppHistorySyncStatus =
  | "requested"
  | "in_progress"
  | "completed"
  | "declined"
  | "error"
  | "paused";
export const WHATSAPP_HISTORY_IMPORT_DEFAULT_RANGE_DAYS = 30;
export const WHATSAPP_HISTORY_IMPORT_DEFAULT_MESSAGE_LIMIT = 50_000;
export const WHATSAPP_HISTORY_IMPORT_DEFAULT_BYTE_LIMIT = 256 * 1024 * 1024;

/** Why a "paused" import waits: the company allowance, or a locked plan. */
export type WhatsAppHistoryPauseReason =
  | "history_import_allowance"
  | "company_trial_expired";

export type WhatsAppHistoryRequestState =
  | "requesting"
  | "accepted"
  | "rejected"
  | "unknown";

export type WhatsAppHistorySyncState = {
  import_policy_version?: 1;
  import_message_limit?: number;
  import_byte_limit?: number;
  /** Created only by a future connection or a confirmed new onboarding. */
  session_id?: string;
  session_started_at?: string;
  request_attempt_id?: string;
  request_attempted_at?: string;
  request_state?: WhatsAppHistoryRequestState;
  range_days?: number;
  requested_at?: string;
  request_id?: string;
  status?: WhatsAppHistorySyncStatus;
  /** Set with status "paused" by the durable receipt projection. */
  pause_reason?: WhatsAppHistoryPauseReason;
  last_webhook_at?: string;
  /** Meta transfer progress, independent of successful local persistence. */
  last_progress?: number;
  last_phase?: number;
  last_chunk_order?: number;
  completed_at?: string;
  provider_completed_at?: string;
  /** True only for a projection derived from session-scoped durable receipts. */
  counts_verified?: boolean;
  received_count_total?: number;
  synchronized_count_total?: number;
  pending_count_total?: number;
  failed_count_total?: number;
  /**
   * Received history messages the company plan gate skipped (part of
   * skipped_count_total). They are not restored by an upgrade alone.
   */
  plan_skipped_count_total?: number;
  pending_chunk_count_total?: number;
  failed_chunk_count_total?: number;
  /** Legacy attempt counters; do not present as a verified imported-row count. */
  processed_count_total?: number;
  skipped_count_total?: number;
  last_processed_count?: number;
  last_skipped_count?: number;
  webhook_count?: number;
  error?: string;
  error_code?: number | string;
  error_details?: string;
};
