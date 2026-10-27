import type { WhatsAppCredentialFields } from "@/types/supabase";
import { compactWhatsAppString } from "@icecore/shared/lib/whatsapp/value-utils";

const WHATSAPP_MANAGER_OVERVIEW_URL =
  "https://business.facebook.com/wa/manage/home/";

const MARKETING_MESSAGES_ONBOARDED_STATUSES = new Set([
  "ONBOARDED",
  "ENABLED",
  "ACTIVE",
]);

export type MarketingMessagesUserFacingState =
  | "ready"
  | "not_ready"
  | "unknown";

export function normalizeMarketingMessagesOnboardingStatus(value: unknown) {
  const normalized = (compactWhatsAppString(value) || "").toUpperCase();
  return normalized || null;
}

export function isMarketingMessagesStatusOnboarded(value: unknown) {
  const status = normalizeMarketingMessagesOnboardingStatus(value);
  return status ? MARKETING_MESSAGES_ONBOARDED_STATUSES.has(status) : false;
}

export function isMarketingMessagesApiOnboarded(
  credentials: Pick<
    WhatsAppCredentialFields,
    | "marketing_messages_enabled"
    | "marketing_messages_onboarding_status"
    | "marketing_messages_api_status"
  >
) {
  const status = normalizeMarketingMessagesOnboardingStatus(
    credentials.marketing_messages_onboarding_status ||
      credentials.marketing_messages_api_status
  );

  return status
    ? isMarketingMessagesStatusOnboarded(status)
    : credentials.marketing_messages_enabled === true;
}

export function getMarketingMessagesUserFacingState(
  credentials: WhatsAppCredentialFields
): MarketingMessagesUserFacingState {
  if (isMarketingMessagesApiOnboarded(credentials)) {
    return "ready";
  }

  if (
    normalizeMarketingMessagesOnboardingStatus(
      credentials.marketing_messages_onboarding_status ||
        credentials.marketing_messages_api_status
    )
  ) {
    return "not_ready";
  }

  return "unknown";
}

export function shouldSyncMarketingMessagesOnboarding(
  credentials: WhatsAppCredentialFields
) {
  return Boolean(
    compactWhatsAppString(credentials.phone_number_id) &&
      compactWhatsAppString(credentials.waba_id) &&
      !compactWhatsAppString(
        credentials.marketing_messages_onboarding_last_checked_at
      )
  );
}

export function shouldShowMarketingMessagesOnboardingNudge(
  credentials: WhatsAppCredentialFields
) {
  return Boolean(
    compactWhatsAppString(credentials.phone_number_id) &&
      compactWhatsAppString(credentials.waba_id) &&
      !isMarketingMessagesApiOnboarded(credentials)
  );
}

export function buildMarketingMessagesCredentialPatch(input: {
  status?: unknown;
  checkedAt?: string;
}) {
  const status = normalizeMarketingMessagesOnboardingStatus(input.status);
  const checkedAt = input.checkedAt || new Date().toISOString();

  return {
    marketing_messages_onboarding_status: status,
    marketing_messages_api_status: status,
    marketing_messages_enabled: isMarketingMessagesStatusOnboarded(status),
    marketing_messages_onboarding_last_checked_at: checkedAt,
  };
}

export function resolveMarketingMessagesStatusFromMetaPayload(input: {
  wabaStatus?: unknown;
  businessStatus?: unknown;
}) {
  return (
    normalizeMarketingMessagesOnboardingStatus(input.wabaStatus) ||
    normalizeMarketingMessagesOnboardingStatus(
      typeof input.businessStatus === "object" &&
        input.businessStatus !== null &&
        "status" in input.businessStatus
        ? (input.businessStatus as { status?: unknown }).status
        : input.businessStatus
    )
  );
}

export function buildWhatsAppManagerPortalUrl(
  credentials: Pick<WhatsAppCredentialFields, "business_id" | "waba_id">
) {
  const url = new URL(WHATSAPP_MANAGER_OVERVIEW_URL);
  const businessId = compactWhatsAppString(credentials.business_id);
  const wabaId = compactWhatsAppString(credentials.waba_id);

  if (businessId) {
    url.searchParams.set("business_id", businessId);
  }

  if (wabaId) {
    url.searchParams.set("waba_id", wabaId);
  }

  return url.toString();
}

export function buildWhatsAppMarketingMessagesPortalUrl(
  credentials: Pick<WhatsAppCredentialFields, "business_id" | "waba_id">
) {
  return buildWhatsAppManagerPortalUrl(credentials);
}
