import {
  readWhatsAppAccountHealth,
  readWhatsAppAccountHealthReasons,
  type WhatsAppAccountHealth,
  type WhatsAppAccountHealthReason,
  type WhatsAppAccountHealthState,
} from "@/lib/whatsapp/account/health";
import type { WhatsAppMetaRefreshResponse } from "@/lib/whatsapp/meta-read-policy";
import { asNullableRecord } from "@icecore/shared/lib/value-utils";

export type WhatsAppOnboardingHealthResponse = {
  connected?: boolean;
  status?: {
    account_health?: WhatsAppAccountHealth;
    waba_health_state?: WhatsAppAccountHealthState | string;
    waba_health_reasons?: WhatsAppAccountHealthReason[];
    waba_health_last_checked_at?: string;
  } | null;
  meta_refresh?: WhatsAppMetaRefreshResponse;
  error?: string;
};

function decodeStatus(
  value: unknown
): WhatsAppOnboardingHealthResponse["status"] {
  const record = asNullableRecord(value);
  if (!record) return null;

  const reasons = readWhatsAppAccountHealthReasons(record.waba_health_reasons);

  const accountHealth = readWhatsAppAccountHealth(record.account_health);
  return {
    ...(accountHealth ? { account_health: accountHealth } : {}),
    ...(typeof record.waba_health_state === "string"
      ? { waba_health_state: record.waba_health_state }
      : {}),
    ...(reasons ? { waba_health_reasons: reasons } : {}),
    ...(typeof record.waba_health_last_checked_at === "string"
      ? { waba_health_last_checked_at: record.waba_health_last_checked_at }
      : {}),
  };
}

export function decodeWhatsAppOnboardingHealthResponse(
  input: unknown
): WhatsAppOnboardingHealthResponse | null {
  const record = asNullableRecord(input);
  if (!record) return null;

  const metaRefresh = asNullableRecord(record.meta_refresh);
  return {
    ...(typeof record.connected === "boolean"
      ? { connected: record.connected }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(record, "status")
      ? { status: decodeStatus(record.status) }
      : {}),
    ...(metaRefresh
      ? {
          meta_refresh: metaRefresh as unknown as WhatsAppMetaRefreshResponse,
        }
      : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
  };
}

export function resolveWhatsAppAccountHealth(
  payload: WhatsAppOnboardingHealthResponse | undefined | null
): WhatsAppAccountHealth | null {
  if (payload?.status?.account_health) {
    return payload.status.account_health;
  }
  if (!payload?.status?.waba_health_state) {
    return null;
  }

  return {
    state: payload.status.waba_health_state as WhatsAppAccountHealthState,
    reasons: payload.status.waba_health_reasons || [],
    lastCheckedAt: payload.status.waba_health_last_checked_at,
  };
}

export async function fetchWhatsAppOnboardingHealth(
  input: RequestInfo | URL
): Promise<WhatsAppOnboardingHealthResponse> {
  const response = await fetch(input);
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => null);
    const errorResponse = decodeWhatsAppOnboardingHealthResponse(errorPayload);
    throw new Error(
      errorResponse?.error || "Failed to fetch WhatsApp onboarding health"
    );
  }

  const payload = await response.json().catch(() => null);
  const decoded = decodeWhatsAppOnboardingHealthResponse(payload);
  if (!decoded) {
    throw new Error("Invalid WhatsApp onboarding health response");
  }
  return decoded;
}
