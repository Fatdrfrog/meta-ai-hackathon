import {
  MetaGraphRequestError,
  formatMetaGraphAPIError,
  getWhatsAppGraphClient,
  parseMetaGraphAPIError,
} from "@icecore/shared/lib/meta/api";
import { normalizeWhatsAppCredentials } from "./credentials";
import {
  WHATSAPP_COEXISTENCE_ONBOARDING_DOC_URL,
  WHATSAPP_SMB_APP_STATE_SYNC_DOC_URL,
  WHATSAPP_SMB_MESSAGE_ECHOES_DOC_URL,
} from "./docs";
import { isWhatsAppHistorySyncEligible } from "./history-sync/eligibility";
import { getWhatsAppCoexistenceSyncWebhookReadiness } from "./waba-service";

export interface WhatsAppSmbAppDataSyncParams {
  sourceId: string;
  workspaceId: string;
  credentials: Record<string, unknown> | null | undefined;
  saveCredentials: (credentials: Record<string, unknown>) => Promise<void>;
}

export interface WhatsAppSmbAppDataSyncResult {
  attempted: boolean;
  requested: boolean;
  skipped: boolean;
  reason?:
    | "already_requested"
    | "missing_credentials"
    | "not_coexistence"
    | "webhooks_not_ready"
    | "persist_failed"
    | "request_in_flight"
    | "request_outcome_unknown"
    | "onboarding_required"
    | "request_window_expired"
    | "meta_error";
  requestId?: string;
  requestedAt?: string;
  error?: string;
  actionable?: string;
  docs?: string[];
  errorCode?: number | string;
  errorSubcode?: number;
  outcomeUnknown?: boolean;
}

// Callers keep their one-shot guard and domain state persistence around this request.
export async function requestWhatsAppSmbAppData({
  credentials,
  syncType,
  beforeRequest,
}: {
  credentials: Record<string, unknown>;
  syncType: "history" | "smb_app_state_sync";
  beforeRequest?: () => Promise<void>;
}): Promise<WhatsAppSmbAppDataSyncResult> {
  const isHistory = syncType === "history";
  const label = isHistory ? "History" : "Contact";

  if (!isWhatsAppHistorySyncEligible(credentials)) {
    return {
      attempted: false,
      requested: false,
      skipped: true,
      reason: "not_coexistence",
      actionable: `${label} sync is only available for WhatsApp Business app coexistence numbers.`,
      docs: [WHATSAPP_COEXISTENCE_ONBOARDING_DOC_URL],
    };
  }

  const normalized = normalizeWhatsAppCredentials(credentials);
  if (!normalized.phoneNumberId || !normalized.accessToken) {
    return {
      attempted: false,
      requested: false,
      skipped: true,
      reason: "missing_credentials",
      error: `Cannot auto-request WhatsApp ${label.toLowerCase()} sync because credentials are incomplete.`,
    };
  }

  const webhookReadiness = await getWhatsAppCoexistenceSyncWebhookReadiness(
    normalized.wabaId,
    normalized.accessToken
  );
  if (!webhookReadiness.ready) {
    return {
      attempted: false,
      requested: false,
      skipped: true,
      reason: "webhooks_not_ready",
      error: webhookReadiness.error,
      actionable: webhookReadiness.actionable,
      docs: webhookReadiness.docs,
    };
  }

  await beforeRequest?.();

  // A timeout can happen after Meta accepts the one-shot request. Its outcome
  // remains unknown and must not trigger another provider request.
  const requestController = isHistory ? new AbortController() : undefined;
  const requestTimeout = requestController
    ? setTimeout(() => requestController.abort(), 30_000)
    : undefined;
  let requestData: { request_id?: string };
  try {
    requestData = await getWhatsAppGraphClient().postJson<{
      request_id?: string;
    }>(`${normalized.phoneNumberId}/smb_app_data`, {
      token: normalized.accessToken,
      body: { messaging_product: "whatsapp", sync_type: syncType },
      ...(requestController ? { signal: requestController.signal } : {}),
    });
  } catch (error) {
    const metaError =
      error instanceof MetaGraphRequestError
        ? error.metaError || parseMetaGraphAPIError(error.details)
        : parseMetaGraphAPIError(
            error instanceof Error ? error.message : String(error)
          );
    const formatted = metaError ? formatMetaGraphAPIError(metaError) : null;
    const outcomeUnknown =
      isHistory &&
      !(
        error instanceof MetaGraphRequestError &&
        error.status >= 400 &&
        error.status < 500 &&
        metaError
      );
    const isHistoryGenericUserError =
      isHistory &&
      (metaError?.code === 135000 ||
        (metaError?.message?.toLowerCase() || "").includes(
          "generic user error"
        ));

    return {
      attempted: true,
      requested: false,
      skipped: false,
      reason: outcomeUnknown ? "request_outcome_unknown" : "meta_error",
      outcomeUnknown,
      error: isHistoryGenericUserError
        ? "History sync is not available for this WhatsApp account setup yet."
        : formatted?.message || metaError?.message || "Meta API error",
      actionable: isHistoryGenericUserError
        ? "Finish coexistence onboarding in WhatsApp Manager or the WhatsApp Business app, then retry history sync."
        : formatted?.actionable || undefined,
      docs: !isHistory
        ? [
            WHATSAPP_COEXISTENCE_ONBOARDING_DOC_URL,
            WHATSAPP_SMB_APP_STATE_SYNC_DOC_URL,
          ]
        : isHistoryGenericUserError
          ? [
              WHATSAPP_COEXISTENCE_ONBOARDING_DOC_URL,
              WHATSAPP_SMB_MESSAGE_ECHOES_DOC_URL,
            ]
          : undefined,
      errorCode: metaError?.code,
      errorSubcode: metaError?.error_subcode,
    };
  } finally {
    if (requestTimeout !== undefined) clearTimeout(requestTimeout);
  }

  if (
    isHistory &&
    (typeof requestData?.request_id !== "string" ||
      !requestData.request_id.trim())
  ) {
    return {
      attempted: true,
      requested: false,
      skipped: false,
      reason: "request_outcome_unknown",
      outcomeUnknown: true,
      error:
        "Meta did not return a history request ID. Request acceptance is unknown.",
      actionable:
        "Wait for history delivery or contact support; do not send another request.",
    };
  }

  return {
    attempted: true,
    requested: true,
    skipped: false,
    requestId: requestData.request_id,
  };
}
