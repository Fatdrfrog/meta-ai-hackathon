import {
  booleanField,
  readNonEmptyString,
  readStringArrayField as readStringArray,
  readStringField,
} from "@icecore/shared/lib/value-utils";
import { isDisconnectedWhatsAppSource } from "@icecore/shared/lib/whatsapp/source-state";
import type { Source } from "@icecore/shared/types/sources";
import { getVisibleWhatsAppInboundSilence } from "@/lib/whatsapp/inbound-liveness";

export type WhatsAppAccountHealthState =
  | "healthy"
  | "warning"
  | "reconnecting"
  | "disconnected"
  | "restricted"
  | "disabled"
  | "payment_required"
  | "inaccessible"
  | "unknown";

export type WhatsAppAccountHealthReason = {
  code: string;
  title: string;
  message: string;
  source: string;
  actionUrl?: string;
};

export type WhatsAppAccountHealth = {
  state: WhatsAppAccountHealthState;
  reasons: WhatsAppAccountHealthReason[];
  lastCheckedAt?: string;
};

const WHATSAPP_ACCOUNT_HEALTH_STATES: ReadonlySet<string> = new Set([
  "healthy",
  "warning",
  "reconnecting",
  "disconnected",
  "restricted",
  "disabled",
  "payment_required",
  "inaccessible",
  "unknown",
]);

function isWhatsAppAccountHealthState(
  value: string
): value is WhatsAppAccountHealthState {
  return WHATSAPP_ACCOUNT_HEALTH_STATES.has(value);
}

/**
 * Sanitizes provider-supplied health reasons at the shared WhatsApp boundary.
 * Both persisted onboarding status and API response decoding use this shape.
 */
export function readWhatsAppAccountHealthReasons(
  value: unknown
): WhatsAppAccountHealthReason[] | undefined {
  if (!Array.isArray(value)) return undefined;

  return value.flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const record = item as Record<string, unknown>;
    const code = readNonEmptyString(record.code, { trim: true });
    const title = readNonEmptyString(record.title, { trim: true });
    const message = readNonEmptyString(record.message, { trim: true });
    const source = readNonEmptyString(record.source, { trim: true });
    if (!code || !title || !message || !source) return [];

    const actionUrl = readNonEmptyString(record.actionUrl, { trim: true });
    return [
      {
        code,
        title,
        message,
        source,
        ...(actionUrl ? { actionUrl } : {}),
      },
    ];
  });
}

export function readWhatsAppAccountHealth(
  value: unknown
): WhatsAppAccountHealth | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const state = readNonEmptyString(record.state, { trim: true });
  const reasons = readWhatsAppAccountHealthReasons(record.reasons);
  if (!state || !isWhatsAppAccountHealthState(state) || !reasons) {
    return undefined;
  }

  const lastCheckedAt = readNonEmptyString(record.lastCheckedAt, {
    trim: true,
  });
  return {
    state,
    reasons,
    ...(lastCheckedAt ? { lastCheckedAt } : {}),
  };
}

type HealthInput = Record<string, unknown>;

const META_BUSINESS_SUPPORT_URL =
  "https://business.facebook.com/business-support-home";
export const META_PAYMENT_URL = "https://business.facebook.com/wa/manage/home/";
export const META_WHATSAPP_MANAGER_URL =
  "https://business.facebook.com/wa/manage/";

const STATE_RANK: Record<WhatsAppAccountHealthState, number> = {
  healthy: 0,
  unknown: 1,
  warning: 2,
  reconnecting: 3,
  inaccessible: 4,
  payment_required: 5,
  restricted: 6,
  disabled: 7,
  disconnected: 8,
};

function normalizeToken(value: string) {
  return value.trim().toLowerCase();
}

function hasToken(input: string, tokens: string[]) {
  const normalized = normalizeToken(input);
  return tokens.some(token => normalized.includes(token));
}

function addReason(
  reasons: WhatsAppAccountHealthReason[],
  reason: WhatsAppAccountHealthReason
) {
  if (!reasons.some(existing => existing.code === reason.code)) {
    reasons.push(reason);
  }
}

function maxState(
  left: WhatsAppAccountHealthState,
  right: WhatsAppAccountHealthState
): WhatsAppAccountHealthState {
  return STATE_RANK[right] > STATE_RANK[left] ? right : left;
}

function readLifecycleEvents(input: HealthInput) {
  const value = input.whatsapp_lifecycle_events;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, { event?: unknown; value?: unknown }>)
    : {};
}

function readLifecycleEventName(input: HealthInput, field: string): string {
  const event = readLifecycleEvents(input)[field];
  if (!event || typeof event !== "object") return "";
  if (typeof event.event === "string") return event.event.trim();
  const value = event.value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.event === "string") return record.event.trim();
    if (typeof record.status === "string") return record.status.trim();
  }
  return "";
}

function readPaymentStatus(input: HealthInput) {
  return (
    readStringField(input, "payment_configuration_status") ||
    readStringField(input, "payment_configuration_last_event") ||
    readLifecycleEventName(input, "payment_configuration_update")
  );
}

function readAccountAlert(input: HealthInput) {
  return (
    readStringField(input, "account_alerts_last_event") ||
    readLifecycleEventName(input, "account_alerts")
  );
}

function buildLastCheckedAt(input: HealthInput) {
  return (
    readStringField(input, "diagnostics_last_checked_at") ||
    readStringField(input, "waba_health_last_checked_at") ||
    readStringField(input, "whatsapp_lifecycle_last_event_at") ||
    undefined
  );
}

export function deriveWhatsAppAccountHealth(
  input: HealthInput,
  { now = Date.now() }: { now?: number } = {}
): WhatsAppAccountHealth {
  let state: WhatsAppAccountHealthState = "healthy";
  const reasons: WhatsAppAccountHealthReason[] = [];
  const reonboardingStatus = normalizeToken(
    readStringField(input, "coexistence_reonboarding_status")
  );
  const accountReviewStatus = normalizeToken(
    readStringField(input, "account_review_status")
  );
  const paymentStatus = readPaymentStatus(input);
  const accountAlert = readAccountAlert(input);
  const banStates = readStringArray(input, "waba_ban_state").join(" ");
  const phoneNumberId = readStringField(input, "phone_number_id");
  const wabaPhoneNumberIds = readStringArray(input, "waba_phone_number_ids");
  const livePhoneNumberMismatch =
    Boolean(phoneNumberId) &&
    wabaPhoneNumberIds.length > 0 &&
    !wabaPhoneNumberIds.includes(phoneNumberId);

  if (reonboardingStatus === "removed") {
    state = maxState(state, "disconnected");
    const reason = readStringField(input, "partner_removed_reason");
    const initiatedBy = readStringField(input, "partner_removed_initiated_by");
    addReason(reasons, {
      code: "partner_removed",
      title: "WhatsApp partner removed",
      message:
        reason || initiatedBy
          ? `Meta says this WhatsApp Business account was disconnected${reason ? ` because of ${reason}` : ""}${initiatedBy ? ` by ${initiatedBy}` : ""}.`
          : "Meta says this WhatsApp Business account is no longer shared with airi.chat.",
      source: "account_update",
      actionUrl: META_WHATSAPP_MANAGER_URL,
    });
  }

  if (
    reonboardingStatus === "offboarded" ||
    (reonboardingStatus !== "removed" &&
      booleanField(input, "cloud_api_messaging_suspended") === true)
  ) {
    state = maxState(state, "reconnecting");
    addReason(reasons, {
      code: "coexistence_offboarded",
      title: "Coexistence reconnect in progress",
      message:
        "Meta temporarily suspended Cloud API messaging while the WhatsApp Business app connection is being restored.",
      source: "account_update",
      actionUrl:
        "https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/reconnect-offboarded-coexistence-clients/",
    });
  }

  if (
    booleanField(input, "waba_banned") === true ||
    hasToken(`${accountReviewStatus} ${accountAlert} ${banStates}`, [
      "disabled",
      "banned",
      "ban",
    ])
  ) {
    state = maxState(state, "disabled");
    addReason(reasons, {
      code: "waba_disabled",
      title: "WhatsApp account disabled",
      message:
        "Meta indicates this WhatsApp Business Account is disabled or banned. WhatsApp Manager may hide normal tools until Meta review is resolved.",
      source: "account_update",
      actionUrl: META_BUSINESS_SUPPORT_URL,
    });
  } else if (
    hasToken(`${accountReviewStatus} ${accountAlert}`, [
      "restricted",
      "restriction",
      "integrity",
      "violation",
    ])
  ) {
    state = maxState(state, "restricted");
    addReason(reasons, {
      code: "waba_restricted",
      title: "WhatsApp account restricted",
      message:
        "Meta reports an account quality or policy restriction. Review Business Support Home before sending more campaigns.",
      source: "account_alerts",
      actionUrl: META_BUSINESS_SUPPORT_URL,
    });
  }

  if (
    hasToken(paymentStatus, [
      "missing",
      "payment",
      "required",
      "invalid",
      "failed",
      "unpaid",
      "none",
    ])
  ) {
    state = maxState(state, "payment_required");
    addReason(reasons, {
      code: "payment_required",
      title: "Payment setup required",
      message:
        "Meta may reject sends until the WhatsApp Business Account has a valid payment method or billing configuration.",
      source: "payment_configuration_update",
      actionUrl: META_PAYMENT_URL,
    });
  }

  if (booleanField(input, "phone_number_accessible") === false) {
    state = maxState(state, "inaccessible");
    addReason(reasons, {
      code: "phone_inaccessible",
      title: "Phone number is not accessible",
      message:
        readStringField(input, "phone_number_access_error") ||
        "Meta rejected access to the selected phone number or WABA.",
      source: "diagnostics",
      actionUrl: META_WHATSAPP_MANAGER_URL,
    });
  } else if (
    livePhoneNumberMismatch ||
    booleanField(input, "phone_number_in_waba") === false
  ) {
    state = maxState(state, "inaccessible");
    addReason(reasons, {
      code: "phone_not_in_waba",
      title: "Phone number not found in WABA",
      message:
        "The stored phone number is not present in the selected WhatsApp Business Account.",
      source: "diagnostics",
      actionUrl: META_WHATSAPP_MANAGER_URL,
    });
  }

  if (booleanField(input, "phone_registered") === false) {
    state = maxState(state, "warning");
    addReason(reasons, {
      code: "phone_not_registered",
      title: "Phone registration incomplete",
      message:
        readStringField(input, "phone_registration_error") ||
        "Complete phone number registration before using Cloud API messaging.",
      source: "phone_registration",
    });
  }

  const webhookRequiresReconnect =
    booleanField(input, "webhook_requires_reconnect") === true;
  const selectedAppMatchesConfig = booleanField(
    input,
    "waba_selected_app_matches_config"
  );
  if (webhookRequiresReconnect || selectedAppMatchesConfig === false) {
    state = maxState(state, "warning");
    addReason(reasons, {
      code: "webhook_reconnect_required",
      title: "Webhook reconnect required",
      message:
        readStringField(input, "webhook_error") ||
        readStringField(input, "phone_webhook_error") ||
        "Meta is not delivering WhatsApp webhooks to the configured airi.chat app.",
      source: "webhook_subscription",
      actionUrl: META_WHATSAPP_MANAGER_URL,
    });
  }

  const missingWebhookFields = readStringArray(
    input,
    "webhook_missing_required_fields"
  );
  if (missingWebhookFields.length > 0) {
    state = maxState(state, "warning");
    addReason(reasons, {
      code: "webhook_fields_missing",
      title: "Webhook fields missing",
      message: `Meta is not subscribed to required webhook fields: ${missingWebhookFields.join(", ")}.`,
      source: "webhook_coverage",
    });
  }

  // Set by the hourly inbound liveness check, which refreshes it while the
  // silence lasts. A disconnected source explains its silence with its own
  // reason.
  const inboundSilentSince = getVisibleWhatsAppInboundSilence(input, now);
  if (
    inboundSilentSince &&
    !isDisconnectedWhatsAppSource({
      type: "whatsapp",
      credentials: input,
    } as unknown as Source)
  ) {
    state = maxState(state, "warning");
    const since = `since ${inboundSilentSince.toISOString().slice(0, 16).replace("T", " ")} UTC`;
    addReason(reasons, {
      code: "inbound_silent",
      title: "No incoming WhatsApp messages",
      message: `airi.chat has not received any messages for this number ${since}, which is unusual for it. Send a test message to the number; if it does not arrive, reconnect WhatsApp.`,
      source: "inbound_liveness",
    });
  }

  const marketingStatus = readStringField(
    input,
    "marketing_messages_onboarding_status"
  );
  if (
    marketingStatus &&
    !["onboarded", "enabled", "active"].includes(
      normalizeToken(marketingStatus)
    )
  ) {
    state = maxState(state, "warning");
    addReason(reasons, {
      code: "marketing_messages_not_onboarded",
      title: "Marketing Messages not onboarded",
      message: `Meta Marketing Messages status is ${marketingStatus}. Campaigns can still use Cloud API where allowed.`,
      source: "marketing_messages_onboarding_status",
      actionUrl: META_PAYMENT_URL,
    });
  }

  const templateLifecycle = readLifecycleEventName(
    input,
    "message_template_status_update"
  );
  if (hasToken(templateLifecycle, ["rejected", "disabled", "paused"])) {
    state = maxState(state, "warning");
    addReason(reasons, {
      code: "template_health",
      title: "Template needs review",
      message: `Meta reported a template lifecycle event: ${templateLifecycle}.`,
      source: "message_template_status_update",
      actionUrl: META_WHATSAPP_MANAGER_URL,
    });
  }

  if (
    reasons.length === 0 &&
    !readStringField(input, "waba_id") &&
    !readStringField(input, "phone_number_id")
  ) {
    state = "unknown";
    addReason(reasons, {
      code: "missing_identifiers",
      title: "WhatsApp identifiers missing",
      message:
        "airi.chat does not have enough WhatsApp account identifiers to verify this connection.",
      source: "credentials",
    });
  }

  return {
    state,
    reasons,
    lastCheckedAt: buildLastCheckedAt(input),
  };
}

// Reason codes that mean the provider will reject Cloud API sends outright, so
// the composer must block rather than let the operator fail one message at a
// time. Soft reasons (webhook coverage, marketing onboarding, template review,
// account quality restriction) stay warn-only and are deliberately excluded.
const WHATSAPP_SEND_BLOCKING_REASON_CODES: ReadonlySet<string> = new Set([
  "phone_not_registered",
  "phone_inaccessible",
  "phone_not_in_waba",
  "payment_required",
  "waba_disabled",
  "partner_removed",
  "coexistence_offboarded",
]);

/**
 * Returns the first health reason that prevents WhatsApp sends, or null when
 * the account can still send. Used to gate the reply composer and warn before
 * the operator attempts a message that can never leave.
 */
export function getWhatsAppSendBlockingReason(
  health: WhatsAppAccountHealth | null | undefined
): WhatsAppAccountHealthReason | null {
  if (!health) return null;
  return (
    health.reasons.find(reason =>
      WHATSAPP_SEND_BLOCKING_REASON_CODES.has(reason.code)
    ) ?? null
  );
}

export function mergeWhatsAppAccountHealthCredentials<T extends HealthInput>(
  credentials: T
): T & {
  waba_health_state: WhatsAppAccountHealthState;
  waba_health_reasons: WhatsAppAccountHealthReason[];
  waba_health_last_checked_at: string;
} {
  const now = new Date().toISOString();
  const health = deriveWhatsAppAccountHealth({
    ...credentials,
    diagnostics_last_checked_at:
      readStringField(credentials, "diagnostics_last_checked_at") || now,
  });

  return {
    ...credentials,
    waba_health_state: health.state,
    waba_health_reasons: health.reasons,
    waba_health_last_checked_at: now,
  };
}
