import { readFiniteNumber } from "../value-utils";

type WhatsAppContactSyncStatus =
  | "requested"
  | "in_progress"
  | "completed"
  | "declined"
  | "error";

export type WhatsAppContactSyncState = {
  requested_at?: string;
  request_id?: string;
  status?: WhatsAppContactSyncStatus;
  last_webhook_at?: string;
  completed_at?: string;
  processed_count_total?: number;
  skipped_count_total?: number;
  last_processed_count?: number;
  last_skipped_count?: number;
  webhook_count?: number;
  error?: string;
  error_code?: number | string;
  error_details?: string;
};

function sumMetric(current: unknown, next: number) {
  return (readFiniteNumber(current) || 0) + next;
}

export function buildContactSyncWebhookState({
  current,
  processedCount,
  skippedCount,
  receivedAt,
  error,
}: {
  current?: WhatsAppContactSyncState | null;
  processedCount: number;
  skippedCount: number;
  receivedAt: string;
  error?: {
    code?: number | string;
    message?: string;
    details?: string;
  };
}): WhatsAppContactSyncState {
  const currentState = current || {};
  const base: WhatsAppContactSyncState = {
    ...currentState,
    last_webhook_at: receivedAt,
    last_processed_count: processedCount,
    last_skipped_count: skippedCount,
    processed_count_total: sumMetric(
      currentState.processed_count_total,
      processedCount,
    ),
    skipped_count_total: sumMetric(
      currentState.skipped_count_total,
      skippedCount,
    ),
    webhook_count: sumMetric(currentState.webhook_count, 1),
  };

  if (error) {
    return {
      ...base,
      status: "error",
      error_code: error.code,
      error: error.message || "Contact sync error",
      error_details: error.details,
    };
  }

  return {
    ...base,
    status: "in_progress",
  };
}
