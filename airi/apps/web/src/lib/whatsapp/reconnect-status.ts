import { supabaseAdmin } from "@/lib/supabase/admin";
import { getWhatsAppConnectionMaintenanceStatus } from "./token-lifecycle";

export type WhatsAppReconnectState =
  | "healthy"
  | "maintaining"
  | "action_required"
  | "expired"
  | "removed"
  | "unknown"
  | "not_connected";

export interface WhatsAppReconnectStatus {
  state: WhatsAppReconnectState;
  daysUntilExpiry: number | null;
  wabaId?: string;
  displayPhoneNumber?: string;
  /**
   * Stable connection signal for UX copy: did the source originally
   * onboard via Embedded Signup or QR (= can self-reconnect) vs legacy
   * OAuth (= we need the full OAuth dance again)?
   */
  reconnectMethod: "embedded" | "qr" | "oauth" | "unknown";
  partnerRemoval?: {
    sourceId: string;
    removedAt: string;
    alertDismissed: boolean;
    reason?: string;
    initiatedBy?: string;
  };
}

interface Credentials extends Record<string, unknown> {
  token_expires_at?: string | null;
  waba_id?: string;
  display_phone_number?: string;
  embedded_signup?: boolean;
  qr_registered?: boolean;
  coexistence_reonboarding_status?: string;
  coexistence_reonboarding_event?: string;
  coexistence_reonboarding_removed_at?: string;
  coexistence_reonboarding_last_event_at?: string;
  partner_removed_alert_dismissed_for?: string;
  partner_removed_reason?: string;
  partner_removed_initiated_by?: string;
}

export interface ActivePartnerRemovalIncident {
  removedAt: string;
  expectedCredentials: Readonly<Record<string, unknown>>;
}

export function getActivePartnerRemovalIncident(
  credentials: Readonly<Record<string, unknown>>
): ActivePartnerRemovalIncident | null {
  if (
    credentials.coexistence_reonboarding_status !== "removed" ||
    credentials.coexistence_reonboarding_event !== "PARTNER_REMOVED"
  ) {
    return null;
  }

  const explicitRemovedAt =
    typeof credentials.coexistence_reonboarding_removed_at === "string" &&
    credentials.coexistence_reonboarding_removed_at
      ? credentials.coexistence_reonboarding_removed_at
      : null;
  const lastEventAt =
    typeof credentials.coexistence_reonboarding_last_event_at === "string" &&
    credentials.coexistence_reonboarding_last_event_at
      ? credentials.coexistence_reonboarding_last_event_at
      : null;
  const removedAt = explicitRemovedAt || lastEventAt;
  if (!removedAt) return null;

  return {
    removedAt,
    expectedCredentials: {
      coexistence_reonboarding_status: "removed",
      coexistence_reonboarding_event: "PARTNER_REMOVED",
      ...(explicitRemovedAt
        ? { coexistence_reonboarding_removed_at: explicitRemovedAt }
        : {
            coexistence_reonboarding_removed_at:
              credentials.coexistence_reonboarding_removed_at,
            coexistence_reonboarding_last_event_at: lastEventAt,
          }),
    },
  };
}

/**
 * Compute whether a workspace's WhatsApp source needs reconnection.
 * Shared between the layout-level banner and any client UI that wants
 * the same status without duplicating connection maintenance decisions.
 */
export async function getWhatsAppReconnectStatus(
  workspaceId: string
): Promise<WhatsAppReconnectStatus> {
  const { data: source, error } = await supabaseAdmin
    .from("sources")
    .select("id, credentials")
    .eq("workspace_id", workspaceId)
    .eq("type", "whatsapp")
    .maybeSingle();

  if (error || !source) {
    return {
      state: "not_connected",
      daysUntilExpiry: null,
      reconnectMethod: "unknown",
    };
  }

  const credentials = (source.credentials || {}) as Credentials;
  const reconnectMethod: WhatsAppReconnectStatus["reconnectMethod"] =
    credentials.embedded_signup
      ? "embedded"
      : credentials.qr_registered
        ? "qr"
        : credentials.token_expires_at
          ? "oauth"
          : "unknown";

  const partnerRemovalIncident = getActivePartnerRemovalIncident(credentials);
  if (source.id && partnerRemovalIncident) {
    const { removedAt } = partnerRemovalIncident;
    return {
      state: "removed",
      daysUntilExpiry: null,
      wabaId: credentials.waba_id,
      displayPhoneNumber: credentials.display_phone_number,
      reconnectMethod,
      partnerRemoval: {
        sourceId: source.id,
        removedAt,
        alertDismissed:
          credentials.partner_removed_alert_dismissed_for === removedAt,
        ...(credentials.partner_removed_reason
          ? { reason: credentials.partner_removed_reason }
          : {}),
        ...(credentials.partner_removed_initiated_by
          ? { initiatedBy: credentials.partner_removed_initiated_by }
          : {}),
      },
    };
  }

  return {
    ...getWhatsAppConnectionMaintenanceStatus(credentials),
    wabaId: credentials.waba_id,
    displayPhoneNumber: credentials.display_phone_number,
    reconnectMethod,
  };
}
