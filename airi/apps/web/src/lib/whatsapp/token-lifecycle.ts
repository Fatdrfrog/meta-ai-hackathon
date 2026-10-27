import {
  evaluateMetaAccessToken,
  type MetaDebugTokenData,
} from "@icecore/shared/lib/meta/debug-token";
import type { WhatsAppTokenMaintenanceStatus } from "@icecore/shared/types/sources";

export const WHATSAPP_TOKEN_RENEWAL_WINDOW_DAYS = 21;
export const WHATSAPP_CONNECTION_ATTENTION_DAYS = 7;
const DAY_MS = 86400000;

export const META_DIAGNOSTICS_RECONNECT_REASON_FIELD =
  "meta_diagnostics_reconnect_reason";
export const META_DIAGNOSTICS_META_AUTHORIZATION_RECONNECT_REASON =
  "meta_authorization";

export function hasConfirmedWhatsAppMetaAuthorizationReconnect(
  credentials: Readonly<Record<string, unknown>>
): boolean {
  return (
    credentials[META_DIAGNOSTICS_RECONNECT_REASON_FIELD] ===
    META_DIAGNOSTICS_META_AUTHORIZATION_RECONNECT_REASON
  );
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export type WhatsAppTokenMetadataPatch = {
  token_type: string | null;
  token_is_valid: boolean | undefined;
  token_verified_at: string;
  token_never_expires: boolean;
  token_provider_expires_at: string | null;
  token_data_access_expires_at: string | null;
  token_expires_at: string | null;
  token_maintenance_status: WhatsAppTokenMaintenanceStatus;
  token_maintenance_error_code: string | null;
};

/** Pure projection shared by signup, scheduled maintenance and customer status. */
export function buildWhatsAppTokenMetadataPatch(
  data: MetaDebugTokenData,
  options: { appId: string; nowMs?: number; expiresIn?: number }
): WhatsAppTokenMetadataPatch {
  const nowMs = options.nowMs ?? Date.now();
  const evaluation = evaluateMetaAccessToken(data, { ...options, nowMs });
  const iso = (seconds: number | undefined): string | null =>
    typeof seconds === "number" &&
    seconds > 0 &&
    Number.isFinite(seconds) &&
    !Number.isNaN(new Date(seconds * 1000).getTime())
      ? new Date(seconds * 1000).toISOString()
      : null;
  const confirmedInvalid =
    evaluation.expired ||
    data.is_valid === false ||
    (typeof data.app_id === "string" &&
      data.app_id.length > 0 &&
      data.app_id !== options.appId);
  return {
    token_type: typeof data.type === "string" ? data.type : null,
    token_is_valid: evaluation.valid
      ? true
      : confirmedInvalid
        ? false
        : undefined,
    token_verified_at: new Date(nowMs).toISOString(),
    token_never_expires: evaluation.neverExpires,
    token_provider_expires_at: iso(data.expires_at),
    token_data_access_expires_at: iso(data.data_access_expires_at),
    token_expires_at: evaluation.expiresAt?.toISOString() ?? null,
    token_maintenance_status: evaluation.valid
      ? "healthy"
      : confirmedInvalid
        ? "reconnect_required"
        : "retrying",
    token_maintenance_error_code: evaluation.valid
      ? null
      : evaluation.expired
        ? "expired"
        : confirmedInvalid
          ? "invalid_authorization"
          : "verification_unavailable",
  };
}

export type WhatsAppConnectionMaintenanceStatus = {
  state: "healthy" | "maintaining" | "action_required" | "expired" | "unknown";
  daysUntilExpiry: number | null;
};

/** Cached dates alone cannot establish that messages are disconnected. */
export function getWhatsAppConnectionMaintenanceStatus(
  credentials: Readonly<Record<string, unknown>>,
  nowMs = Date.now()
): WhatsAppConnectionMaintenanceStatus {
  const expiry = timestamp(credentials.token_expires_at);
  const daysUntilExpiry =
    expiry === null ? null : Math.ceil((expiry - nowMs) / DAY_MS);
  const verified = timestamp(credentials.token_verified_at) !== null;
  if (verified && expiry !== null && expiry <= nowMs)
    return { state: "expired", daysUntilExpiry };
  if (
    (verified && credentials.token_is_valid === false) ||
    ((credentials.webhook_requires_reconnect === true ||
      credentials.waba_subscription_permanently_failed === true) &&
      hasConfirmedWhatsAppMetaAuthorizationReconnect(credentials))
  )
    return { state: "action_required", daysUntilExpiry };
  if (
    verified &&
    credentials.token_maintenance_status === "reconnect_required" &&
    daysUntilExpiry !== null &&
    daysUntilExpiry <= WHATSAPP_CONNECTION_ATTENTION_DAYS
  )
    return { state: "action_required", daysUntilExpiry };
  if (
    verified &&
    credentials.token_is_valid === true &&
    credentials.token_never_expires === true
  )
    return { state: "healthy", daysUntilExpiry: null };
  if (daysUntilExpiry !== null)
    return {
      state:
        daysUntilExpiry <= WHATSAPP_TOKEN_RENEWAL_WINDOW_DAYS
          ? "maintaining"
          : "healthy",
      daysUntilExpiry,
    };
  return { state: "unknown", daysUntilExpiry: null };
}
