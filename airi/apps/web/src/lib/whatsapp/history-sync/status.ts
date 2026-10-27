import {
  getWhatsAppHistoryRequestAvailability,
  type WhatsAppHistorySyncState,
} from "@icecore/whatsapp/historySyncState";

const STALE_ACTIVE_SYNC_AFTER_MS = 24 * 60 * 60 * 1000;

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function dateMs(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Provider progress describes transfer, never local persistence. */
export function buildWhatsAppHistorySyncSummary(
  historySync?: WhatsAppHistorySyncState | null,
  options?: { now?: number }
) {
  const countsVerified = historySync?.counts_verified === true;
  const synchronizedCount = countsVerified
    ? count(historySync?.synchronized_count_total)
    : null;
  const pendingCount = countsVerified
    ? count(historySync?.pending_count_total)
    : null;
  const failedCount = countsVerified
    ? count(historySync?.failed_count_total)
    : null;
  const receivedCount = countsVerified
    ? count(historySync?.received_count_total)
    : null;
  const pendingChunkCount = countsVerified
    ? count(historySync?.pending_chunk_count_total)
    : null;
  const failedChunkCount = countsVerified
    ? count(historySync?.failed_chunk_count_total)
    : null;
  const planSkippedCount = countsVerified
    ? count(historySync?.plan_skipped_count_total)
    : null;
  const rawProgress = historySync?.last_progress;
  const providerProgress =
    typeof rawProgress === "number" && Number.isFinite(rawProgress)
      ? Math.max(0, Math.min(100, rawProgress))
      : null;
  const base = {
    countsVerified,
    synchronizedCount,
    pendingCount,
    failedCount,
    receivedCount,
    pendingChunkCount,
    failedChunkCount,
    planSkippedCount,
    providerProgress,
  };
  const result = <S extends string, T extends string, D extends string>(
    status: S,
    titleKey: T,
    descriptionKey: D,
    active = false,
    terminal = false
  ) => ({ ...base, status, titleKey, descriptionKey, active, terminal });

  if (historySync?.status === "declined") {
    return result(
      "declined",
      "declinedTitle",
      "declinedDescription",
      false,
      true
    );
  }
  if (historySync?.status === "paused") {
    // A plan-locked import resumes after an upgrade; more capacity won't help.
    return result(
      "paused",
      "pausedTitle",
      historySync.pause_reason === "company_trial_expired"
        ? "pausedPlanDescription"
        : "pausedDescription"
    );
  }
  if (
    (historySync?.request_state === "unknown" ||
      getWhatsAppHistoryRequestAvailability(historySync, options?.now)
        .reason === "request_outcome_unknown") &&
    !historySync?.last_webhook_at
  ) {
    return result(
      "request_unknown",
      "requestUnknownTitle",
      "requestUnknownDescription",
      true
    );
  }
  if (historySync?.status === "error") {
    return result("error", "errorTitle", "errorDescription", false, true);
  }
  if (historySync?.status === "completed") {
    const settled =
      countsVerified &&
      pendingCount === 0 &&
      failedCount === 0 &&
      pendingChunkCount === 0 &&
      failedChunkCount === 0;
    // Plan-skipped chats complete their receipts but were never saved, and an
    // upgrade alone does not bring them back.
    if (settled && (planSkippedCount ?? 0) > 0) {
      return result(
        "plan_skipped",
        "planSkippedTitle",
        "planSkippedDescription",
        false,
        true
      );
    }
    return settled
      ? result(
          "completed",
          "completedTitle",
          "completedDescription",
          false,
          true
        )
      : result(
          "unverified",
          "unverifiedTitle",
          "unverifiedDescription",
          false,
          true
        );
  }
  const activityAt =
    dateMs(historySync?.last_webhook_at) ??
    dateMs(historySync?.request_attempted_at) ??
    dateMs(historySync?.requested_at);
  if (
    activityAt !== null &&
    (options?.now ?? Date.now()) - activityAt > STALE_ACTIVE_SYNC_AFTER_MS
  ) {
    return result("stale", "staleTitle", "staleDescription");
  }
  if (
    historySync?.request_state === "requesting" &&
    !historySync.last_webhook_at
  ) {
    return result(
      "requesting",
      "requestingTitle",
      "requestingDescription",
      true
    );
  }
  if (
    historySync?.requested_at ||
    historySync?.last_webhook_at ||
    historySync?.request_state === "accepted"
  ) {
    if (
      (providerProgress === 100 || historySync.provider_completed_at) &&
      ((pendingCount ?? 0) > 0 || (pendingChunkCount ?? 0) > 0)
    ) {
      return result("saving", "savingTitle", "savingDescription", true);
    }
    if (providerProgress !== null || historySync.last_webhook_at) {
      return result(
        "in_progress",
        "receivingTitle",
        "receivingDescription",
        true
      );
    }
    return result("requested", "requestedTitle", "requestedDescription", true);
  }
  return result("idle", "idleTitle", "idleDescription");
}

export function isWhatsAppHistorySyncActive(
  historySync?: WhatsAppHistorySyncState | null,
  options?: { now?: number }
) {
  return buildWhatsAppHistorySyncSummary(historySync, options).active;
}

export function hasVerifiedWhatsAppHistory(
  historySync?: WhatsAppHistorySyncState | null
) {
  const summary = buildWhatsAppHistorySyncSummary(historySync);
  return summary.countsVerified && (summary.synchronizedCount ?? 0) > 0;
}
