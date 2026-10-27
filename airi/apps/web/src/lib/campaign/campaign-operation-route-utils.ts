import {
  BULK_CAMPAIGN_DISPATCH_PAUSED_STOP_REASON,
  type BulkCampaignDispatchLifecycleState,
} from "@icecore/temporal";

import type {
  CampaignDispatchAggregate,
  CampaignDispatchPublicStatus,
} from "./campaign-history-store";
import type { CampaignOperationStatusResponse } from "./campaign-operations-contracts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_STATUSES = new Set<BulkCampaignDispatchLifecycleState>([
  "queued",
  "scheduled",
  "running",
]);
const TERMINAL_STATUSES = new Set<BulkCampaignDispatchLifecycleState>([
  "completed",
  "failed",
  "expired",
  "cancelled",
]);
const ALL_STATUSES = new Set<BulkCampaignDispatchLifecycleState>([
  ...ACTIVE_STATUSES,
  ...TERMINAL_STATUSES,
]);

export function isCampaignOperationUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function serializeOperationFields(params: {
  campaignId: string;
  status: BulkCampaignDispatchLifecycleState;
  requestedAt: string | null;
  scheduledAt: string | null;
  dispatchExpiresAt: string | null;
  startedAt: string | null;
  progressAt: string | null;
  finishedAt: string | null;
  cancelledAt: string | null;
  expiredAt: string | null;
  totalRecipients: number;
  progress: CampaignOperationStatusResponse["progress"];
  delivery: CampaignOperationStatusResponse["delivery"];
  stopReason: string | null;
  providerCircuit: Omit<
    CampaignOperationStatusResponse["providerCircuit"],
    "requiresAcknowledgement"
  >;
  retry: {
    ofCampaignId: string | null;
    kind: "failed_only" | "send_again" | null;
  };
  retryableFailedRecipientCount: number;
}): CampaignOperationStatusResponse {
  const failedRecipientCount = params.retryableFailedRecipientCount;
  return {
    campaignId: params.campaignId,
    status: params.status,
    requestedAt: params.requestedAt,
    scheduledAt: params.scheduledAt,
    dispatchExpiresAt: params.dispatchExpiresAt,
    startedAt: params.startedAt,
    progressAt: params.progressAt,
    finishedAt: params.finishedAt,
    cancelledAt: params.cancelledAt,
    expiredAt: params.expiredAt,
    totalRecipients: params.totalRecipients,
    progress: params.progress,
    delivery: params.delivery,
    stopReason: params.stopReason,
    providerCircuit: {
      ...params.providerCircuit,
      requiresAcknowledgement: params.providerCircuit.state === "open",
    },
    retry: {
      ...params.retry,
      failedRecipientCount,
      available:
        TERMINAL_STATUSES.has(params.status) && failedRecipientCount > 0,
    },
    canCancel: ACTIVE_STATUSES.has(params.status),
    paused:
      ACTIVE_STATUSES.has(params.status) &&
      params.stopReason === BULK_CAMPAIGN_DISPATCH_PAUSED_STOP_REASON,
  };
}

/** Explicit public projection; private workspace/workflow/snapshot fields cannot spread. */
export function serializeCampaignOperationStatus(
  status: CampaignDispatchPublicStatus
): CampaignOperationStatusResponse {
  return serializeOperationFields({
    campaignId: status.campaignId,
    status: status.status,
    requestedAt: status.requestedAt,
    scheduledAt: status.scheduledAt,
    dispatchExpiresAt: status.dispatchExpiresAt,
    startedAt: status.startedAt,
    progressAt: status.progressAt,
    finishedAt: status.finishedAt,
    cancelledAt: status.cancelledAt,
    expiredAt: status.expiredAt,
    totalRecipients: status.totalRecipients,
    progress: status.progress,
    delivery: status.delivery,
    stopReason: status.stopReason,
    providerCircuit: status.providerCircuit,
    retry: status.retry,
    retryableFailedRecipientCount: status.retryableFailedRecipientCount,
  });
}

export type CampaignHistoryOperationRow = {
  id?: unknown;
  dispatch_status?: unknown;
  requested_at?: unknown;
  scheduled_at?: unknown;
  dispatch_expires_at?: unknown;
  started_at?: unknown;
  progress_at?: unknown;
  finished_at?: unknown;
  cancelled_at?: unknown;
  expired_at?: unknown;
  total_recipients?: unknown;
  processed_count?: unknown;
  accepted_count?: unknown;
  attempted_count?: unknown;
  not_attempted_count?: unknown;
  successful_sends?: unknown;
  failed_sends?: unknown;
  stop_reason?: unknown;
  provider_circuit_state?: unknown;
  provider_circuit_provider?: unknown;
  provider_circuit_code?: unknown;
  provider_circuit_opened_at?: unknown;
  retry_of_campaign_id?: unknown;
  retry_kind?: unknown;
};

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nonNegativeCount(value: unknown): number {
  const count =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0
    ? count
    : 0;
}

/**
 * History has already done one workspace-scoped batch aggregate lookup. A
 * missing aggregate is represented as unavailable (`null`), never as zeros.
 */
export function serializeCampaignHistoryOperation(params: {
  row: CampaignHistoryOperationRow;
  aggregate: CampaignDispatchAggregate | null;
}): CampaignOperationStatusResponse | null {
  const campaignId = nullableString(params.row.id);
  const status = params.row.dispatch_status;
  if (
    !campaignId ||
    !ALL_STATUSES.has(status as BulkCampaignDispatchLifecycleState) ||
    !params.aggregate
  ) {
    return null;
  }
  const lifecycleStatus = status as BulkCampaignDispatchLifecycleState;
  const storedCircuitOpen = params.row.provider_circuit_state === "open";
  const aggregateCircuit = params.aggregate.providerCircuit;
  const providerCircuitOpen =
    storedCircuitOpen || aggregateCircuit.state === "open";
  const retryKind =
    params.row.retry_kind === "failed_only" ||
    params.row.retry_kind === "send_again"
      ? params.row.retry_kind
      : null;

  return serializeOperationFields({
    campaignId,
    status: lifecycleStatus,
    requestedAt: nullableString(params.row.requested_at),
    scheduledAt: nullableString(params.row.scheduled_at),
    dispatchExpiresAt: nullableString(params.row.dispatch_expires_at),
    startedAt: nullableString(params.row.started_at),
    progressAt: nullableString(params.row.progress_at),
    finishedAt: nullableString(params.row.finished_at),
    cancelledAt: nullableString(params.row.cancelled_at),
    expiredAt: nullableString(params.row.expired_at),
    totalRecipients: nonNegativeCount(params.row.total_recipients),
    progress: {
      processed: nonNegativeCount(params.row.processed_count),
      accepted: nonNegativeCount(params.row.accepted_count),
      attempted: nonNegativeCount(params.row.attempted_count),
      notAttempted: nonNegativeCount(params.row.not_attempted_count),
      successful: nonNegativeCount(params.row.successful_sends),
      failed: nonNegativeCount(params.row.failed_sends),
    },
    delivery: params.aggregate.delivery,
    stopReason: nullableString(params.row.stop_reason),
    providerCircuit: {
      state: providerCircuitOpen ? "open" : "closed",
      provider: storedCircuitOpen
        ? nullableString(params.row.provider_circuit_provider)
        : aggregateCircuit.state === "open"
          ? aggregateCircuit.provider
          : null,
      code: storedCircuitOpen
        ? nullableString(params.row.provider_circuit_code)
        : aggregateCircuit.state === "open"
          ? aggregateCircuit.code
          : null,
      openedAt: nullableString(params.row.provider_circuit_opened_at),
      failureCount:
        aggregateCircuit.state === "open"
          ? aggregateCircuit.failureCount
          : storedCircuitOpen
            ? Math.max(
                params.aggregate.delivery.failed,
                nonNegativeCount(params.row.failed_sends)
              )
            : 0,
    },
    retry: {
      ofCampaignId: nullableString(params.row.retry_of_campaign_id),
      kind: retryKind,
    },
    retryableFailedRecipientCount:
      params.aggregate.retryableFailedRecipientCount,
  });
}
