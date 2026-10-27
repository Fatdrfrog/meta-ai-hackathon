import type { WhatsAppHistorySyncState } from "@icecore/shared/lib/whatsapp/history-sync-state";
import { readFiniteNumber } from "@icecore/shared/lib/value-utils";

export type {
  WhatsAppHistoryRequestState,
  WhatsAppHistorySyncState,
  WhatsAppHistorySyncStatus,
} from "@icecore/shared/lib/whatsapp/history-sync-state";

export const WHATSAPP_HISTORY_REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;
// A 30-second provider timeout plus persistence grace; this never unlocks retry.
export const WHATSAPP_HISTORY_REQUEST_PENDING_GRACE_MS = 5 * 60 * 1000;

export type WhatsAppHistoryRequestAvailability = {
  canRequest: boolean;
  reason:
    | "ready"
    | "already_requested"
    | "request_in_flight"
    | "request_outcome_unknown"
    | "onboarding_required"
    | "request_window_expired";
};

/** The provider's one-shot guard is shared by the server and every request UI. */
export function getWhatsAppHistoryRequestAvailability(
  state?: WhatsAppHistorySyncState | null,
  now = Date.now(),
): WhatsAppHistoryRequestAvailability {
  if (
    state?.requested_at ||
    state?.request_state === "accepted" ||
    state?.last_webhook_at ||
    state?.status === "completed" ||
    state?.status === "declined"
  ) {
    return { canRequest: false, reason: "already_requested" };
  }
  if (state?.request_state === "requesting") {
    const attemptedAt = Date.parse(state.request_attempted_at || "");
    return {
      canRequest: false,
      reason:
        Number.isFinite(attemptedAt) &&
        now - attemptedAt >= WHATSAPP_HISTORY_REQUEST_PENDING_GRACE_MS
          ? "request_outcome_unknown"
          : "request_in_flight",
    };
  }
  if (
    state?.request_state === "unknown" ||
    ((state?.request_attempt_id || state?.request_attempted_at) &&
      state.request_state !== "rejected")
  ) {
    return { canRequest: false, reason: "request_outcome_unknown" };
  }
  const startedAt = Date.parse(state?.session_started_at || "");
  if (!state?.session_id?.trim() || !Number.isFinite(startedAt)) {
    return { canRequest: false, reason: "onboarding_required" };
  }
  if (now - startedAt >= WHATSAPP_HISTORY_REQUEST_WINDOW_MS) {
    return { canRequest: false, reason: "request_window_expired" };
  }
  return { canRequest: true, reason: "ready" };
}

export type WhatsAppHistoryWebhookMetadata = {
  phase?: number;
  chunk_order?: number;
  progress?: number;
};

export type WhatsAppHistoryWebhookError = {
  code?: number | string;
  title?: string;
  message?: string;
  error_data?: {
    details?: string;
  };
};

function sumMetric(current: unknown, next: number) {
  return (readFiniteNumber(current) || 0) + next;
}

function selectLatestMetadata(
  metadata: WhatsAppHistoryWebhookMetadata[],
  current?: WhatsAppHistorySyncState,
) {
  const valid = metadata.filter(
    (item) =>
      readFiniteNumber(item.progress) !== null ||
      readFiniteNumber(item.phase) !== null ||
      readFiniteNumber(item.chunk_order) !== null,
  );

  if (valid.length === 0) {
    return {
      phase: current?.last_phase,
      chunkOrder: current?.last_chunk_order,
      progress: current?.last_progress,
    };
  }

  let latest = valid[0]!;
  for (const item of valid.slice(1)) {
    const selected = latest;
    const selectedProgress = readFiniteNumber(selected.progress) ?? -1;
    const itemProgress = readFiniteNumber(item.progress) ?? -1;
    if (itemProgress !== selectedProgress) {
      latest = itemProgress > selectedProgress ? item : selected;
      continue;
    }

    const selectedPhase = readFiniteNumber(selected.phase) ?? -1;
    const itemPhase = readFiniteNumber(item.phase) ?? -1;
    if (itemPhase !== selectedPhase) {
      latest = itemPhase > selectedPhase ? item : selected;
      continue;
    }

    const selectedChunk = readFiniteNumber(selected.chunk_order) ?? -1;
    const itemChunk = readFiniteNumber(item.chunk_order) ?? -1;
    latest = itemChunk > selectedChunk ? item : selected;
  }

  return {
    phase: readFiniteNumber(latest.phase) ?? current?.last_phase,
    chunkOrder:
      readFiniteNumber(latest.chunk_order) ?? current?.last_chunk_order,
    progress:
      Math.max(
        readFiniteNumber(current?.last_progress) ?? 0,
        readFiniteNumber(latest.progress) ?? 0,
      ) || undefined,
  };
}

export function buildHistorySyncWebhookState({
  current,
  metadata,
  processedCount,
  skippedCount,
  receivedAt,
  errors = [],
}: {
  current?: WhatsAppHistorySyncState | null;
  metadata: WhatsAppHistoryWebhookMetadata[];
  processedCount: number;
  skippedCount: number;
  receivedAt: string;
  errors?: WhatsAppHistoryWebhookError[];
}): WhatsAppHistorySyncState {
  const currentState = current || {};
  const base: WhatsAppHistorySyncState = {
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

  if (errors.length > 0) {
    const [firstError] = errors;
    return {
      ...base,
      status: firstError?.code === 2593109 ? "declined" : "error",
      error_code: firstError?.code,
      error: firstError?.message || firstError?.title || "History sync error",
      error_details: firstError?.error_data?.details,
    };
  }

  const latest = selectLatestMetadata(metadata, currentState);
  const progress = latest.progress;
  const completed = progress !== undefined && progress >= 100;

  return {
    ...base,
    status: completed ? "completed" : "in_progress",
    last_phase: latest.phase,
    last_chunk_order: latest.chunkOrder,
    last_progress: progress,
    ...(completed
      ? { completed_at: currentState.completed_at || receivedAt }
      : {}),
  };
}

export function mergeHistorySyncRequestedState({
  current,
  requestedAt,
  requestId,
  rangeDays,
}: {
  current?: WhatsAppHistorySyncState | null;
  requestedAt: string;
  requestId?: string | null;
  rangeDays?: number;
}): WhatsAppHistorySyncState {
  const currentState = current || {};
  const hasWebhookState = Boolean(
    currentState.last_webhook_at ||
      (currentState.status && currentState.status !== "requested"),
  );

  return {
    ...currentState,
    range_days:
      typeof currentState.range_days === "number"
        ? currentState.range_days
        : rangeDays,
    requested_at: currentState.requested_at || requestedAt,
    request_id: currentState.request_id || requestId || undefined,
    status: hasWebhookState ? currentState.status : "requested",
    processed_count_total: currentState.processed_count_total ?? 0,
    skipped_count_total: currentState.skipped_count_total ?? 0,
    webhook_count: currentState.webhook_count ?? 0,
  };
}
