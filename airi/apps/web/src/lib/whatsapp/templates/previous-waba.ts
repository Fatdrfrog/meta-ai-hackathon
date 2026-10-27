import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  compactWhatsAppWabaId,
  type WhatsAppWabaHistoryEntry,
} from "@/lib/whatsapp/templates/waba-origin";

export type { WhatsAppWabaHistoryEntry };

const CONNECTED_WABA_EVENT_TYPES = new Set([
  "embedded_signup_source_persisted",
  "source_reconnected",
  "ACCOUNT_RECONNECTED",
  "PARTNER_ADDED",
  "PARTNER_APP_INSTALLED",
]);

function asIsoTimestamp(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return null;
}

export async function loadWhatsAppWabaHistory(
  workspaceId: string
): Promise<WhatsAppWabaHistoryEntry[]> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_onboarding_events")
    .select("event_type, legacy_waba_id, created_at")
    .eq("workspace_id", workspaceId)
    .not("legacy_waba_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(100);

  if (error || !Array.isArray(data)) {
    return [];
  }

  const history: WhatsAppWabaHistoryEntry[] = [];
  for (const row of data) {
    const eventType = typeof row.event_type === "string" ? row.event_type : "";
    if (!CONNECTED_WABA_EVENT_TYPES.has(eventType)) {
      continue;
    }
    const wabaId = compactWhatsAppWabaId(row.legacy_waba_id);
    const recordedAt = asIsoTimestamp(row.created_at);
    if (!wabaId || !recordedAt) continue;
    history.push({ wabaId, recordedAt });
  }
  return history;
}

export async function resolvePreviousWhatsAppWabaId(params: {
  workspaceId: string;
  currentWabaId?: string | null;
}): Promise<{
  previousWabaId: string | null;
  wabaHistory: WhatsAppWabaHistoryEntry[];
}> {
  const currentWabaId = compactWhatsAppWabaId(params.currentWabaId);
  const wabaHistory = await loadWhatsAppWabaHistory(params.workspaceId);
  const previousWabaId =
    [...wabaHistory].reverse().find(entry => entry.wabaId !== currentWabaId)
      ?.wabaId || null;

  return { previousWabaId, wabaHistory };
}
