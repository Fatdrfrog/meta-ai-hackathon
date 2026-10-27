import { randomUUID } from "node:crypto";
import { WHATSAPP_HISTORY_IMPORT_DEFAULT_RANGE_DAYS, WHATSAPP_HISTORY_IMPORT_DEFAULT_MESSAGE_LIMIT, WHATSAPP_HISTORY_IMPORT_DEFAULT_BYTE_LIMIT } from "@icecore/shared/lib/whatsapp/history-sync-state";
import {
  requestWhatsAppSmbAppData,
  type WhatsAppSmbAppDataSyncParams,
  type WhatsAppSmbAppDataSyncResult,
} from "../smb-app-data";
import { asWhatsAppRecord as asRecord } from "@icecore/shared/lib/whatsapp/value-utils";
import {
  getWhatsAppHistoryRequestAvailability,
  mergeHistorySyncRequestedState,
  type WhatsAppHistorySyncState,
} from "@icecore/whatsapp/historySyncState";
import { normalizeWhatsAppCredentials } from "../credentials";
import { updateCurrentWhatsAppSourceCredentials } from "../flows/source-rebind-guard";
import { isWhatsAppHistorySyncEligible } from "./eligibility";

type Params = Omit<WhatsAppSmbAppDataSyncParams, "saveCredentials"> & {
  rangeDays?: number;
};
interface Result extends WhatsAppSmbAppDataSyncResult {
  rangeDays: number;
  historySync?: WhatsAppHistorySyncState;
}
type Availability = ReturnType<typeof getWhatsAppHistoryRequestAvailability>;
class RequestBlocked extends Error {
  constructor(
    readonly availability: Availability,
    readonly state: WhatsAppHistorySyncState
  ) {
    super(availability.reason);
  }
}
const guidance: Record<string, string> = {
  already_requested:
    "Meta only allows one history sync request for this onboarding. To request it again, the customer must offboard and complete Embedded Signup again.",
  request_in_flight:
    "The history request is already being submitted. Wait for its result; do not send another request.",
  request_outcome_unknown:
    "Meta may have accepted the request. Wait for history delivery or contact support; do not send another request.",
  onboarding_required:
    "Complete a new WhatsApp Business app onboarding before requesting history.",
  request_window_expired:
    "The 24-hour onboarding window has expired. Complete a new WhatsApp Business app onboarding.",
};

export async function requestWhatsAppHistorySync({
  sourceId,
  workspaceId,
  credentials,
  rangeDays,
}: Params): Promise<Result> {
  const initial = asRecord(credentials);
  const normalized = normalizeWhatsAppCredentials(initial);
  let state = asRecord(initial.history_sync) as WhatsAppHistorySyncState;
  const range = Number.isFinite(rangeDays)
    ? Math.max(1, Math.min(180, Math.floor(rangeDays!)))
    : WHATSAPP_HISTORY_IMPORT_DEFAULT_RANGE_DAYS;
  const blocked = (availability: Availability, value = state): Result => ({
    attempted: false,
    requested: false,
    skipped: true,
    reason:
      availability.reason === "ready"
        ? "already_requested"
        : availability.reason,
    actionable: guidance[availability.reason],
    requestId: value.request_id,
    requestedAt: value.requested_at,
    rangeDays: range,
    historySync: value,
  });
  if (isWhatsAppHistorySyncEligible(initial)) {
    const availability = getWhatsAppHistoryRequestAvailability(state);
    if (!availability.canRequest) return blocked(availability);
  }
  const sessionId = state.session_id;
  const attemptId = randomUUID();
  const mutate = async (
    build: (current: WhatsAppHistorySyncState) => WhatsAppHistorySyncState
  ) => {
    for (let retry = 0; ; retry++) {
      try {
        const updated = await updateCurrentWhatsAppSourceCredentials({
          sourceId,
          workspaceId,
          expectedWabaId: normalized.wabaId || "",
          expectedPhoneNumberId: normalized.phoneNumberId || "",
          buildCredentials: current => {
            const latest = asRecord(
              current.history_sync
            ) as WhatsAppHistorySyncState;
            if (latest.session_id !== sessionId)
              throw new RequestBlocked(
                { canRequest: false, reason: "onboarding_required" },
                latest
              );
            state = build(latest);
            return { ...current, history_sync: state };
          },
        });
        state = asRecord(
          updated.credentials.history_sync
        ) as WhatsAppHistorySyncState;
        return;
      } catch (error) {
        if (
          retry < 2 &&
          (error as { code?: string })?.code ===
            "WHATSAPP_FLOW_SOURCE_BINDING_FENCE_CONFLICT"
        )
          continue;
        throw error;
      }
    }
  };
  let request: WhatsAppSmbAppDataSyncResult;
  try {
    request = await requestWhatsAppSmbAppData({
      credentials: initial,
      syncType: "history",
      beforeRequest: () =>
        mutate(current => {
          const availability = getWhatsAppHistoryRequestAvailability(current);
          if (!availability.canRequest)
            throw new RequestBlocked(availability, current);
          return {
            ...current,
            range_days: range,
            import_policy_version: 1,
            import_message_limit: WHATSAPP_HISTORY_IMPORT_DEFAULT_MESSAGE_LIMIT,
            import_byte_limit: WHATSAPP_HISTORY_IMPORT_DEFAULT_BYTE_LIMIT,
            status: "requested",
            request_state: "requesting",
            request_attempt_id: attemptId,
            request_attempted_at: new Date().toISOString(),
            error: undefined,
            error_code: undefined,
            error_details: undefined,
          };
        }),
    });
  } catch (error) {
    if (error instanceof RequestBlocked)
      return blocked(error.availability, error.state);
    return {
      attempted: false,
      requested: false,
      skipped: false,
      reason: "persist_failed",
      rangeDays: range,
      historySync: state,
      error:
        "Could not durably reserve the history request. No request was sent to Meta.",
    };
  }
  if (!request.attempted)
    return { ...request, rangeDays: range, historySync: state };
  const requestedAt = new Date().toISOString();
  const finish = (
    current: WhatsAppHistorySyncState
  ): WhatsAppHistorySyncState => {
    if (current.request_attempt_id !== attemptId)
      throw new RequestBlocked(
        { canRequest: false, reason: "request_outcome_unknown" },
        current
      );
    return request.requested
      ? {
          ...mergeHistorySyncRequestedState({
            current,
            requestedAt,
            requestId: request.requestId,
            rangeDays: range,
          }),
          request_state: "accepted",
        }
      : {
          ...current,
          request_state: request.outcomeUnknown ? "unknown" : "rejected",
          status: current.last_webhook_at ? current.status : "error",
          error: request.error,
          error_code: request.errorCode,
        };
  };
  try {
    await mutate(finish);
  } catch {
    return {
      ...request,
      reason: "persist_failed",
      rangeDays: range,
      historySync:
        state.request_attempt_id === attemptId ? finish(state) : state,
      requestedAt: request.requested ? requestedAt : undefined,
      error: request.requested
        ? "Meta accepted the history request, but its result could not be saved."
        : "The history request result could not be saved.",
      actionable:
        "Do not resend the history request. Refresh the status or contact support.",
    };
  }
  return {
    ...request,
    requestedAt: request.requested ? requestedAt : undefined,
    rangeDays: range,
    historySync: state,
  };
}
