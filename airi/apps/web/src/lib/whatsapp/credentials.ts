import { decryptMaybeString } from "@/lib/crypto";
import { isMarketingMessagesApiOnboarded } from "@/lib/whatsapp/marketing/messages-onboarding";
import { createLogger } from "@icecore/shared/lib/logger";
import { normalizeWhatsAppAccountIdentifiers } from "@icecore/shared/lib/whatsapp/account-identifiers";
import { isSmbPlatformType } from "@icecore/shared/lib/whatsapp/phone-registration-mode";
import { compactWhatsAppStringOrUndefined as normalizeOptionalString } from "@icecore/shared/lib/whatsapp/value-utils";
import { readStringArray } from "@icecore/shared/lib/value-utils";

const whatsAppCredentialsLogger = createLogger("whatsapp.credentials");

export type NormalizedWhatsAppCredentials = {
  wabaId?: string;
  messagingAccountId?: string;
  waacId?: string;
  csId?: string;
  businessId?: string;
  phoneNumberId?: string;
  displayPhoneNumber?: string;
  accessToken?: string;
  messagingLimit?: string;
  marketingMessagesEnabled?: boolean;
  catalogIds?: string[];
  embeddedSignupFlow?: string;
  coexistenceMode?: boolean;
  isOnBizApp?: boolean;
  platformType?: string;
};

type RawWhatsAppCredentials = {
  waba_id?: string;
  wabaId?: string;
  messaging_account_id?: string;
  messagingAccountId?: string;
  waac_id?: string;
  waacId?: string;
  cs_id?: string;
  csId?: string;
  business_id?: string;
  businessId?: string;
  phone_number_id?: string;
  phoneNumberId?: string;
  display_phone_number?: string;
  displayPhoneNumber?: string;
  access_token?: unknown;
  accessToken?: unknown;
  catalog_ids?: unknown;
  catalogIds?: unknown;
  embedded_signup_flow?: unknown;
  embeddedSignupFlow?: unknown;
  coexistence_mode?: unknown;
  coexistenceMode?: unknown;
  is_on_biz_app?: unknown;
  isOnBizApp?: unknown;
  platform_type?: unknown;
  platformType?: unknown;
  whatsapp_business_manager_messaging_limit?: unknown;
  phone_messaging_limit?: unknown;
  marketing_messages_enabled?: unknown;
  marketingMessagesEnabled?: unknown;
  marketing_messages_api_status?: unknown;
  marketingMessagesApiStatus?: unknown;
  marketing_messages_onboarding_status?: unknown;
  marketingMessagesOnboardingStatus?: unknown;
};

function normalizeStringArray(input: unknown): string[] | undefined {
  const values = readStringArray(input);
  return values.length > 0 ? values : undefined;
}

function normalizeMarketingMessagesEnabled(creds: RawWhatsAppCredentials) {
  return isMarketingMessagesApiOnboarded({
    marketing_messages_enabled:
      creds.marketing_messages_enabled === true ||
      creds.marketingMessagesEnabled === true,
    marketing_messages_onboarding_status:
      normalizeOptionalString(creds.marketing_messages_onboarding_status) ||
      normalizeOptionalString(creds.marketingMessagesOnboardingStatus),
    marketing_messages_api_status:
      normalizeOptionalString(creds.marketing_messages_api_status) ||
      normalizeOptionalString(creds.marketingMessagesApiStatus),
  });
}

function resolveWhatsAppCoexistenceMode(input: {
  embeddedSignupFlow?: string;
  coexistenceMode?: boolean;
  isOnBizApp?: boolean;
  platformType?: string;
}) {
  if (input.embeddedSignupFlow === "coexistence") return true;
  if (input.isOnBizApp === true) return true;
  if (isSmbPlatformType(input.platformType)) return true;

  if (input.embeddedSignupFlow === "cloud_api") {
    return false;
  }

  return input.coexistenceMode;
}

// State that describes one phone number and must not carry over to another.
const WHATSAPP_PHONE_SCOPED_STATE_KEYS = [
  "phone_registered",
  "phone_registered_at",
  "phone_registration_status",
  "phone_registration_error",
  "contact_sync",
  "history_sync",
] as const;

export function resetWhatsAppPhoneScopedState(
  credentials: Record<string, unknown>,
  nextPhoneNumberId: string
): Record<string, unknown> {
  const nextCredentials = { ...credentials };
  if (
    normalizeWhatsAppAccountIdentifiers(credentials).phoneNumberId !==
    normalizeOptionalString(nextPhoneNumberId)
  ) {
    // The source-binding store merges built credentials onto the stored row,
    // so a deleted key would come back; null clears it.
    for (const key of WHATSAPP_PHONE_SCOPED_STATE_KEYS) {
      if (key in nextCredentials) nextCredentials[key] = null;
    }
  }
  return nextCredentials;
}

/**
 * Clears the offboarded/removed suspension and stale connection diagnostics
 * once a reconnect is proven (a completed Embedded Signup, or a fresh grant
 * for the WABA after PARTNER_REMOVED).
 */
export function buildWhatsAppReconnectedCredentialPatch(): Record<
  string,
  unknown
> {
  return {
    cloud_api_messaging_suspended: false,
    token_last_refresh_attempt_at: null,
    meta_diagnostics_reconnect_reason: null,
    coexistence_reonboarding_event: null,
    coexistence_reonboarding_last_event_at: null,
    coexistence_reonboarding_offboarded_at: null,
    coexistence_reonboarding_removed_at: null,
    coexistence_reonboarding_status: null,
    partner_removed_alert_dismissed_at: null,
    partner_removed_alert_dismissed_by: null,
    partner_removed_alert_dismissed_for: null,
    partner_removed_initiated_by: null,
    partner_removed_reason: null,
    phone_number_access_error: null,
    phone_number_accessible: null,
    phone_webhook_error: null,
    waba_subscription_consecutive_failures: 0,
    waba_subscription_permanently_failed: false,
    webhook_error: null,
    webhook_requires_reconnect: false,
    webhook_subscribed: null,
  };
}

export function normalizeWhatsAppCredentials(
  input: unknown
): NormalizedWhatsAppCredentials {
  if (!input || typeof input !== "object") return {};
  const creds = input as RawWhatsAppCredentials;
  const accountIds = normalizeWhatsAppAccountIdentifiers(creds);

  const wabaId = accountIds.wabaId;
  const businessId = accountIds.businessId;
  const phoneNumberId = accountIds.phoneNumberId;
  const displayPhoneNumber =
    normalizeOptionalString(creds.display_phone_number) ||
    normalizeOptionalString(creds.displayPhoneNumber);
  const accessToken =
    decryptMaybeString(creds.access_token) ||
    decryptMaybeString(creds.accessToken);
  const catalogIds =
    normalizeStringArray(creds.catalog_ids) ||
    normalizeStringArray(creds.catalogIds);
  const messagingLimit =
    typeof creds.whatsapp_business_manager_messaging_limit === "string"
      ? creds.whatsapp_business_manager_messaging_limit
      : typeof creds.phone_messaging_limit === "string"
        ? creds.phone_messaging_limit
        : undefined;
  const embeddedSignupFlow =
    typeof creds.embedded_signup_flow === "string"
      ? creds.embedded_signup_flow
      : typeof creds.embeddedSignupFlow === "string"
        ? creds.embeddedSignupFlow
        : undefined;
  const coexistenceMode =
    typeof creds.coexistence_mode === "boolean"
      ? creds.coexistence_mode
      : typeof creds.coexistenceMode === "boolean"
        ? creds.coexistenceMode
        : undefined;
  const isOnBizApp =
    typeof creds.is_on_biz_app === "boolean"
      ? creds.is_on_biz_app
      : typeof creds.isOnBizApp === "boolean"
        ? creds.isOnBizApp
        : undefined;
  const platformType =
    typeof creds.platform_type === "string"
      ? creds.platform_type
      : typeof creds.platformType === "string"
        ? creds.platformType
        : undefined;
  const marketingMessagesEnabled = normalizeMarketingMessagesEnabled(creds);
  const effectiveCoexistenceMode = resolveWhatsAppCoexistenceMode({
    embeddedSignupFlow,
    coexistenceMode,
    isOnBizApp,
    platformType,
  });

  if (!wabaId) {
    whatsAppCredentialsLogger.info("whatsapp.credentials.missing_waba_id", {
      hasPhoneNumberId: Boolean(phoneNumberId),
      hasBusinessId: Boolean(businessId),
    });
  }

  return {
    wabaId,
    messagingAccountId: accountIds.messagingAccountId,
    waacId: accountIds.waacId,
    csId: accountIds.csId,
    businessId,
    phoneNumberId,
    displayPhoneNumber,
    accessToken: accessToken || undefined,
    catalogIds,
    messagingLimit,
    marketingMessagesEnabled,
    embeddedSignupFlow,
    coexistenceMode: effectiveCoexistenceMode,
    isOnBizApp,
    platformType,
  };
}
