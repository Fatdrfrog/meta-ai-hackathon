import type { WhatsAppAccountHealthState } from "./account/health";
import type { WhatsAppMetaRefreshOutcome } from "./meta-read-policy";

const META_REFRESH_MESSAGES = {
  success: "accountHealthCheckSuccess",
  info: "accountHealthCheckDeferred",
  warning: "accountHealthCheckRateLimited",
  error: "accountHealthCheckFailed",
} as const;

const META_REFRESH_LEVELS = {
  succeeded: "success",
  fresh: "info",
  minimum_interval: "info",
  in_progress: "info",
  cooldown: "warning",
  rate_limited: "warning",
  failed: "error",
  not_configured: "error",
} as const satisfies Record<
  WhatsAppMetaRefreshOutcome,
  keyof typeof META_REFRESH_MESSAGES
>;

export function getWhatsAppMetaRefreshFeedback(
  outcome?: WhatsAppMetaRefreshOutcome
) {
  const level =
    outcome === undefined ? "success" : META_REFRESH_LEVELS[outcome];
  return typeof level === "string"
    ? { level, messageKey: META_REFRESH_MESSAGES[level] }
    : undefined;
}

export function humanizeWhatsAppStatus(
  value?: string | null,
  fallback = "Unknown"
) {
  if (!value) return fallback;

  return value
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, char => char.toUpperCase());
}

export function formatWhatsAppStatusDate(
  value?: string | null,
  fallback = "Not yet"
) {
  if (!value) return fallback;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;

  return date.toLocaleString();
}
const ACCOUNT_HEALTH_STATUS_KEYS = {
  healthy: "accountHealthStatusHealthy",
  warning: "accountHealthStatusWarning",
  reconnecting: "accountHealthStatusReconnecting",
  disconnected: "accountHealthStatusDisconnected",
  restricted: "accountHealthStatusRestricted",
  disabled: "accountHealthStatusDisabled",
  payment_required: "accountHealthStatusPaymentRequired",
  inaccessible: "accountHealthStatusInaccessible",
  unknown: "accountHealthStatusUnknown",
} as const satisfies Record<WhatsAppAccountHealthState, string>;

export function getWhatsAppAccountHealthStatusKey(
  state: WhatsAppAccountHealthState
) {
  return (
    ACCOUNT_HEALTH_STATUS_KEYS[state] || ACCOUNT_HEALTH_STATUS_KEYS.unknown
  );
}
