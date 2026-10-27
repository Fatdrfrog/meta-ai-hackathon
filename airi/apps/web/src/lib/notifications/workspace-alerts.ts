/**
 * Shared helper for publishing real-time workspace alerts via realtime.
 * Matches the shape already consumed by the in-app alert toaster
 * (see token-expiry-alerts.ts and the "WhatsApp Message Failed" alert in the
 * WhatsApp webhook handler).
 *
 * The channel `private-${workspaceId}-alerts` and event name `alert` are part
 * of the existing client contract — do not rename without updating the
 * subscriber.
 */

import { realtime } from "@/lib/realtime/server";

export type WorkspaceAlertSeverity = "info" | "warning" | "critical";

export interface WorkspaceAlertAction {
  label: string;
  url: string;
}

export interface WorkspaceAlertPayload {
  workspaceId: string;
  type: WorkspaceAlertSeverity;
  title: string;
  message: string;
  action?: WorkspaceAlertAction;
  /**
   * Opaque correlation id used by the UI to de-duplicate the same alert
   * (e.g. template name for template lifecycle events). Optional.
   */
  dedupeKey?: string;
  /** Structured extras for the toaster / downstream debugging. */
  metadata?: Record<string, unknown>;
}

export async function publishWorkspaceAlert(
  params: WorkspaceAlertPayload
): Promise<void> {
  try {
    await realtime.trigger(`private-${params.workspaceId}-alerts`, "alert", {
      type: params.type,
      title: params.title,
      message: params.message,
      action: params.action,
      dedupeKey: params.dedupeKey,
      metadata: params.metadata,
      timestamp: new Date(),
    });
  } catch (error) {
    // Alerts are best-effort; never break the caller's control flow.
    console.warn("publishWorkspaceAlert failed", {
      workspaceId: params.workspaceId,
      title: params.title,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
