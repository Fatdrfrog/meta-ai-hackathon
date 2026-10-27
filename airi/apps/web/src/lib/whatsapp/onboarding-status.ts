import {
  readWhatsAppAccountHealthReasons,
  type WhatsAppAccountHealth,
  type WhatsAppAccountHealthReason,
  type WhatsAppAccountHealthState,
} from "@/lib/whatsapp/account/health";
import type { WhatsAppCallingOperationalReadiness } from "@/lib/whatsapp/auto-defaults";
import {
  readOptionalStringArray,
  readString as optionalString,
} from "@icecore/shared/lib/value-utils";
import {
  readBusinessUsernameState,
  type WhatsAppBusinessUsernameState,
} from "@icecore/whatsapp/businessUsernameState";

export type WhatsAppOnboardingStatus = {
  phone_registered?: boolean;
  phone_registered_at?: string;
  phone_registration_status?: string;
  phone_registration_error?: string | null;
  last_test_message_at?: string;
  last_test_message_to?: string;
  last_test_message_id?: string;
  payment_method_prompted_at?: string;
  waba_id?: string;
  phone_number_id?: string;
  display_phone_number?: string;
  verified_name?: string;
  name_status?: string;
  business_username?: WhatsAppBusinessUsernameState;
  whatsapp_lifecycle_last_event_at?: string;
  whatsapp_lifecycle_last_event_field?: string;
  whatsapp_lifecycle_events?: Record<
    string,
    {
      field?: string;
      receivedAt?: string;
      event?: string | null;
      value?: Record<string, unknown> | null;
    }
  >;
  quality_rating?: string;
  whatsapp_business_manager_messaging_limit?: string;
  phone_messaging_limit?: string;
  messaging_limit_last_checked_at?: string;
  account_review_status?: string;
  business_verification_status?: string;
  verification_updated_at?: string;
  platform_type?: string;
  two_step_pin_enabled?: boolean;
  coexistence_mode?: boolean;
  partner_app_installed?: boolean;
  partner_app_installed_at?: string;
  cloud_api_messaging_suspended?: boolean;
  coexistence_reonboarding_status?: string;
  coexistence_reonboarding_event?: string;
  coexistence_reonboarding_offboarded_at?: string;
  coexistence_reonboarding_reconnected_at?: string;
  coexistence_reonboarding_removed_at?: string;
  coexistence_reonboarding_last_event_at?: string;
  partner_removed_reason?: string;
  partner_removed_initiated_by?: string;
  onboarding_completed?: boolean;
  onboarding_completed_at?: string;
  embedded_signup?: boolean;
  embedded_signup_flow?: string;
  embedded_signup_event?: string;
  is_on_biz_app?: boolean;
  qr_registered?: boolean;
  calls_enabled?: boolean;
  whatsapp_calls_media_enabled?: boolean;
  calls_status?: string;
  calls_icon_visibility?: string;
  calls_callback_permission_status?: string;
  calls_voicemail_enabled?: boolean;
  calls_voicemail_status?: string;
  calls_voicemail_triggers?: string[];
  calls_voicemail_announcement_media_id?: string;
  calls_voicemail_timeout_seconds?: number;
  calls_restrictions?: Array<{
    type: string;
    reason?: string;
    expiration?: number;
  }>;
  calls_webhook_subscribed?: boolean;
  waba_subscribed_fields?: string[];
  calls_last_checked_at?: string;
  calls_enabled_at?: string;
  calls_enablement_error?: string | null;
  calls_enablement_actionable?: string | null;
  calls_operational_readiness?: WhatsAppCallingOperationalReadiness;
  auto_defaults_last_attempt_at?: string;
  auto_defaults_last_success_at?: string;
  auto_defaults_last_trigger?: string;
  auto_defaults_last_error?: string | null;
  webhook_profile_version?: string;
  webhook_required_fields?: string[];
  webhook_optional_fields?: string[];
  webhook_missing_required_fields?: string[];
  webhook_missing_optional_fields?: string[];
  webhook_fields_last_checked_at?: string;
  webhook_requires_reconnect?: boolean;
  webhook_error?: string | null;
  phone_webhook_error?: string | null;
  expected_meta_app_id?: string;
  token_app_id?: string;
  token_app_id_matches_config?: boolean;
  waba_selected_app_id?: string;
  waba_selected_app_name?: string;
  waba_selected_app_matches_config?: boolean;
  waba_subscribed_app_ids?: string[];
  waba_calls_field_present_for_selected_app?: boolean;
  waba_phone_number_ids?: string[];
  phone_number_in_waba?: boolean;
  phone_number_accessible?: boolean;
  phone_number_access_error?: string | null;
  diagnostics_last_checked_at?: string;
  payment_configuration_status?: string;
  payment_configuration_last_event?: string;
  payment_configuration_message?: string;
  account_alerts_last_event?: string;
  account_alerts_last_status?: string;
  account_alerts_last_message?: string;
  security_last_event?: string;
  security_last_status?: string;
  security_last_message?: string;
  waba_banned?: boolean;
  waba_ban_state?: string[];
  waba_ban_date?: string;
  banned_at?: string;
  waba_health_state?: WhatsAppAccountHealthState | string;
  waba_health_reasons?: WhatsAppAccountHealthReason[];
  waba_health_last_checked_at?: string;
  account_health?: WhatsAppAccountHealth;
};

type WhatsAppBusinessAppConnectionSignalInput = {
  embeddedSignupFlow?: string;
  embeddedSignupEvent?: string;
  isOnBizApp?: boolean | null;
  coexistenceMode?: boolean | null;
  partnerAppInstalled?: boolean | null;
  qrRegistered?: boolean | null;
  platformType?: string | null;
};

type WhatsAppBusinessAppConnectionSignalOverrides = {
  isOnBizApp?: boolean | null;
  platformType?: string | null;
};

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function nullableString(value: unknown): string | null | undefined {
  if (typeof value === "string") return value;
  return value === null ? null : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  return readOptionalStringArray(value);
}

export function buildWhatsAppBusinessAppConnectionSignalInput(
  credentials: Record<string, unknown>,
  overrides: WhatsAppBusinessAppConnectionSignalOverrides = {}
): WhatsAppBusinessAppConnectionSignalInput {
  return {
    embeddedSignupFlow: optionalString(credentials.embedded_signup_flow),
    embeddedSignupEvent: optionalString(credentials.embedded_signup_event),
    isOnBizApp:
      overrides.isOnBizApp ?? optionalBoolean(credentials.is_on_biz_app),
    coexistenceMode: optionalBoolean(credentials.coexistence_mode),
    partnerAppInstalled: optionalBoolean(credentials.partner_app_installed),
    qrRegistered: optionalBoolean(credentials.qr_registered),
    platformType:
      overrides.platformType ?? optionalString(credentials.platform_type),
  };
}

function readWhatsAppLifecycleEvents(
  value: unknown
): WhatsAppOnboardingStatus["whatsapp_lifecycle_events"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const events: NonNullable<
    WhatsAppOnboardingStatus["whatsapp_lifecycle_events"]
  > = {};
  for (const [key, rawEvent] of Object.entries(value)) {
    if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) {
      continue;
    }
    const record = rawEvent as Record<string, unknown>;
    const field = optionalString(record.field) || key;
    const receivedAt = optionalString(record.receivedAt);
    const event =
      typeof record.event === "string"
        ? record.event
        : record.event === null
          ? null
          : undefined;
    const rawValue =
      record.value &&
      typeof record.value === "object" &&
      !Array.isArray(record.value)
        ? (record.value as Record<string, unknown>)
        : undefined;

    events[key] = {
      field,
      ...(receivedAt ? { receivedAt } : {}),
      ...(event !== undefined ? { event } : {}),
      ...(rawValue ? { value: rawValue } : {}),
    };
  }

  return Object.keys(events).length > 0 ? events : undefined;
}

function readCallsRestrictions(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map(item => {
      if (!item || typeof item !== "object") return null;
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.type !== "string") return null;
      return {
        type: candidate.type,
        ...(typeof candidate.reason === "string"
          ? { reason: candidate.reason }
          : {}),
        ...(typeof candidate.expiration === "number"
          ? { expiration: candidate.expiration }
          : {}),
      };
    })
    .filter(
      (item): item is { type: string; reason?: string; expiration?: number } =>
        item !== null
    );
  return normalized.length > 0 ? normalized : [];
}

export function buildWhatsAppOnboardingStatusFromCredentials(
  creds: Record<string, unknown>
): WhatsAppOnboardingStatus {
  return {
    phone_registered: optionalBoolean(creds.phone_registered),
    phone_registered_at: optionalString(creds.phone_registered_at),
    phone_registration_status: optionalString(creds.phone_registration_status),
    phone_registration_error: nullableString(creds.phone_registration_error),
    last_test_message_at: optionalString(creds.last_test_message_at),
    last_test_message_to: optionalString(creds.last_test_message_to),
    last_test_message_id: optionalString(creds.last_test_message_id),
    payment_method_prompted_at: optionalString(
      creds.payment_method_prompted_at
    ),
    waba_id: optionalString(creds.waba_id),
    phone_number_id: optionalString(creds.phone_number_id),
    display_phone_number: optionalString(creds.display_phone_number),
    verified_name: optionalString(creds.verified_name),
    name_status: optionalString(creds.name_status),
    business_username: readBusinessUsernameState(creds.business_username),
    whatsapp_lifecycle_last_event_at: optionalString(
      creds.whatsapp_lifecycle_last_event_at
    ),
    whatsapp_lifecycle_last_event_field: optionalString(
      creds.whatsapp_lifecycle_last_event_field
    ),
    whatsapp_lifecycle_events: readWhatsAppLifecycleEvents(
      creds.whatsapp_lifecycle_events
    ),
    quality_rating: optionalString(creds.quality_rating),
    whatsapp_business_manager_messaging_limit: optionalString(
      creds.whatsapp_business_manager_messaging_limit
    ),
    phone_messaging_limit: optionalString(creds.phone_messaging_limit),
    messaging_limit_last_checked_at: optionalString(
      creds.messaging_limit_last_checked_at
    ),
    account_review_status: optionalString(creds.account_review_status),
    business_verification_status: optionalString(
      creds.business_verification_status
    ),
    verification_updated_at: optionalString(creds.verification_updated_at),
    platform_type: optionalString(creds.platform_type),
    two_step_pin_enabled: optionalBoolean(creds.two_step_pin_enabled),
    coexistence_mode: optionalBoolean(creds.coexistence_mode),
    is_on_biz_app: optionalBoolean(creds.is_on_biz_app),
    partner_app_installed: optionalBoolean(creds.partner_app_installed),
    partner_app_installed_at: optionalString(creds.partner_app_installed_at),
    cloud_api_messaging_suspended: optionalBoolean(
      creds.cloud_api_messaging_suspended
    ),
    coexistence_reonboarding_status: optionalString(
      creds.coexistence_reonboarding_status
    ),
    coexistence_reonboarding_event: optionalString(
      creds.coexistence_reonboarding_event
    ),
    coexistence_reonboarding_offboarded_at: optionalString(
      creds.coexistence_reonboarding_offboarded_at
    ),
    coexistence_reonboarding_reconnected_at: optionalString(
      creds.coexistence_reonboarding_reconnected_at
    ),
    coexistence_reonboarding_removed_at: optionalString(
      creds.coexistence_reonboarding_removed_at
    ),
    coexistence_reonboarding_last_event_at: optionalString(
      creds.coexistence_reonboarding_last_event_at
    ),
    partner_removed_reason: optionalString(creds.partner_removed_reason),
    partner_removed_initiated_by: optionalString(
      creds.partner_removed_initiated_by
    ),
    qr_registered: optionalBoolean(creds.qr_registered),
    onboarding_completed: optionalBoolean(creds.onboarding_completed),
    onboarding_completed_at: optionalString(creds.onboarding_completed_at),
    embedded_signup: optionalBoolean(creds.embedded_signup),
    embedded_signup_flow: optionalString(creds.embedded_signup_flow),
    embedded_signup_event: optionalString(creds.embedded_signup_event),
    calls_enabled: optionalBoolean(creds.calls_enabled),
    whatsapp_calls_media_enabled: optionalBoolean(
      creds.whatsapp_calls_media_enabled
    ),
    calls_status: optionalString(creds.calls_status),
    calls_icon_visibility: optionalString(creds.calls_icon_visibility),
    calls_callback_permission_status: optionalString(
      creds.calls_callback_permission_status
    ),
    calls_voicemail_enabled: optionalBoolean(creds.calls_voicemail_enabled),
    calls_voicemail_status: optionalString(creds.calls_voicemail_status),
    calls_voicemail_triggers: optionalStringArray(
      creds.calls_voicemail_triggers
    ),
    calls_voicemail_announcement_media_id: optionalString(
      creds.calls_voicemail_announcement_media_id
    ),
    calls_voicemail_timeout_seconds: optionalInteger(
      creds.calls_voicemail_timeout_seconds
    ),
    calls_restrictions: readCallsRestrictions(creds.calls_restrictions),
    calls_webhook_subscribed: optionalBoolean(creds.calls_webhook_subscribed),
    waba_subscribed_fields: optionalStringArray(creds.waba_subscribed_fields),
    calls_last_checked_at: optionalString(creds.calls_last_checked_at),
    calls_enabled_at: optionalString(creds.calls_enabled_at),
    calls_enablement_error: nullableString(creds.calls_enablement_error),
    calls_enablement_actionable: nullableString(
      creds.calls_enablement_actionable
    ),
    auto_defaults_last_attempt_at: optionalString(
      creds.auto_defaults_last_attempt_at
    ),
    auto_defaults_last_success_at: optionalString(
      creds.auto_defaults_last_success_at
    ),
    auto_defaults_last_trigger: optionalString(
      creds.auto_defaults_last_trigger
    ),
    auto_defaults_last_error: nullableString(creds.auto_defaults_last_error),
    webhook_profile_version: optionalString(creds.webhook_profile_version),
    webhook_required_fields: optionalStringArray(creds.webhook_required_fields),
    webhook_optional_fields: optionalStringArray(creds.webhook_optional_fields),
    webhook_missing_required_fields: optionalStringArray(
      creds.webhook_missing_required_fields
    ),
    webhook_missing_optional_fields: optionalStringArray(
      creds.webhook_missing_optional_fields
    ),
    webhook_fields_last_checked_at: optionalString(
      creds.webhook_fields_last_checked_at
    ),
    webhook_requires_reconnect: optionalBoolean(
      creds.webhook_requires_reconnect
    ),
    webhook_error: nullableString(creds.webhook_error),
    phone_webhook_error: nullableString(creds.phone_webhook_error),
    expected_meta_app_id: optionalString(creds.expected_meta_app_id),
    token_app_id: optionalString(creds.token_app_id),
    token_app_id_matches_config: optionalBoolean(
      creds.token_app_id_matches_config
    ),
    waba_selected_app_id: optionalString(creds.waba_selected_app_id),
    waba_selected_app_name: optionalString(creds.waba_selected_app_name),
    waba_selected_app_matches_config: optionalBoolean(
      creds.waba_selected_app_matches_config
    ),
    waba_subscribed_app_ids: optionalStringArray(creds.waba_subscribed_app_ids),
    waba_calls_field_present_for_selected_app: optionalBoolean(
      creds.waba_calls_field_present_for_selected_app
    ),
    waba_phone_number_ids: optionalStringArray(creds.waba_phone_number_ids),
    phone_number_in_waba: optionalBoolean(creds.phone_number_in_waba),
    phone_number_accessible: optionalBoolean(creds.phone_number_accessible),
    phone_number_access_error: nullableString(creds.phone_number_access_error),
    diagnostics_last_checked_at: optionalString(
      creds.diagnostics_last_checked_at
    ),
    payment_configuration_status: optionalString(
      creds.payment_configuration_status
    ),
    payment_configuration_last_event: optionalString(
      creds.payment_configuration_last_event
    ),
    payment_configuration_message: optionalString(
      creds.payment_configuration_message
    ),
    account_alerts_last_event: optionalString(creds.account_alerts_last_event),
    account_alerts_last_status: optionalString(
      creds.account_alerts_last_status
    ),
    account_alerts_last_message: optionalString(
      creds.account_alerts_last_message
    ),
    security_last_event: optionalString(creds.security_last_event),
    security_last_status: optionalString(creds.security_last_status),
    security_last_message: optionalString(creds.security_last_message),
    waba_banned: optionalBoolean(creds.waba_banned),
    waba_ban_state: optionalStringArray(creds.waba_ban_state),
    waba_ban_date: optionalString(creds.waba_ban_date),
    banned_at: optionalString(creds.banned_at),
    waba_health_state: optionalString(creds.waba_health_state),
    waba_health_reasons: readWhatsAppAccountHealthReasons(
      creds.waba_health_reasons
    ),
    waba_health_last_checked_at: optionalString(
      creds.waba_health_last_checked_at
    ),
  };
}
