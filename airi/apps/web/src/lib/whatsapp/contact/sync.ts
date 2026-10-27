import type { WhatsAppContactSyncState } from "@icecore/shared/lib/whatsapp/contact-sync-state";
import {
  requestWhatsAppSmbAppData,
  type WhatsAppSmbAppDataSyncParams,
  type WhatsAppSmbAppDataSyncResult,
} from "../smb-app-data";
import { asWhatsAppRecord as asRecord } from "@icecore/shared/lib/whatsapp/value-utils";

export type RequestWhatsAppContactSyncParams = WhatsAppSmbAppDataSyncParams;

export interface RequestWhatsAppContactSyncResult
  extends WhatsAppSmbAppDataSyncResult {
  contactSync?: WhatsAppContactSyncState;
}

export async function requestWhatsAppContactSync({
  sourceId,
  workspaceId,
  credentials,
  saveCredentials,
}: RequestWhatsAppContactSyncParams): Promise<RequestWhatsAppContactSyncResult> {
  const nextCredentials = asRecord(credentials);
  const existingContactSync = asRecord(
    (nextCredentials as { contact_sync?: unknown }).contact_sync
  ) as WhatsAppContactSyncState;

  if (existingContactSync?.requested_at) {
    return {
      attempted: false,
      requested: false,
      skipped: true,
      reason: "already_requested",
      requestId:
        typeof existingContactSync.request_id === "string"
          ? existingContactSync.request_id
          : undefined,
      requestedAt:
        typeof existingContactSync.requested_at === "string"
          ? existingContactSync.requested_at
          : undefined,
      contactSync: existingContactSync,
    };
  }

  const request = await requestWhatsAppSmbAppData({
    credentials: nextCredentials,
    syncType: "smb_app_state_sync",
  });
  if (!request.requested) return request;

  const requestedAt = new Date().toISOString();
  const credentialsWithContactSync = {
    ...nextCredentials,
    contact_sync: {
      requested_at: requestedAt,
      request_id: request.requestId,
      status: "requested" as const,
      processed_count_total: 0,
      skipped_count_total: 0,
      webhook_count: 0,
    },
  };

  try {
    await saveCredentials(credentialsWithContactSync);
  } catch (error) {
    console.error("Failed to persist auto contact sync state:", {
      sourceId,
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      attempted: true,
      requested: true,
      skipped: false,
      reason: "persist_failed",
      requestId: request.requestId,
      requestedAt,
      contactSync: credentialsWithContactSync.contact_sync,
      error:
        "Contact sync request was sent to Meta but could not be persisted locally.",
      actionable:
        "Refresh this page before retrying to avoid duplicate requests.",
    };
  }

  return {
    attempted: true,
    requested: true,
    skipped: false,
    requestId: request.requestId,
    requestedAt,
    contactSync: credentialsWithContactSync.contact_sync,
  };
}
