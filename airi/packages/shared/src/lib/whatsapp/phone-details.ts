import type { WhatsAppCredentials } from "../../types/sources";
import { readNonEmptyString } from "../value-utils";
import { isCloudApiPlatformType } from "./phone-registration-mode";

export type WhatsAppPhoneNumberDetails = {
  id: string;
  verified_name?: string;
  display_phone_number?: string;
  quality_rating?: string;
  whatsapp_business_manager_messaging_limit?: string;
  code_verification_status?: string;
  status?: string;
  platform_type?: string;
  is_on_biz_app?: boolean;
  is_pin_enabled?: boolean | string;
  throughput?: {
    level?: string;
  };
  name_status?: string;
};

export type WhatsAppPhoneNumberReadiness = {
  ready: boolean;
  status: string;
  issues?: string[];
};

export type WhatsAppPhoneDetailsCredentialPatch = Partial<
  Pick<
    WhatsAppCredentials,
    | "phone_registration_status"
    | "platform_type"
    | "display_phone_number"
    | "verified_name"
    | "name_status"
    | "quality_rating"
    | "is_on_biz_app"
    | "whatsapp_business_manager_messaging_limit"
    | "phone_messaging_limit"
  >
>;

/**
 * Maps the stable phone fields returned by Meta into source credentials.
 * Route-specific timestamps, registration decisions, and UI status fields
 * remain owned by their callers.
 */
export function buildWhatsAppPhoneDetailsCredentialPatch(
  details: WhatsAppPhoneNumberDetails,
): WhatsAppPhoneDetailsCredentialPatch {
  const phoneRegistrationStatus =
    readNonEmptyString(details.status) ||
    (isWhatsAppPhoneNumberRegistered(details) ? "REGISTERED" : undefined);
  const platformType = readNonEmptyString(details.platform_type);
  const displayPhoneNumber = readNonEmptyString(details.display_phone_number);
  const verifiedName = readNonEmptyString(details.verified_name);
  const nameStatus = readNonEmptyString(details.name_status);
  const qualityRating = readNonEmptyString(details.quality_rating);
  const patch: WhatsAppPhoneDetailsCredentialPatch = {
    ...(phoneRegistrationStatus
      ? { phone_registration_status: phoneRegistrationStatus }
      : {}),
    ...(platformType ? { platform_type: platformType } : {}),
    ...(displayPhoneNumber ? { display_phone_number: displayPhoneNumber } : {}),
    ...(verifiedName ? { verified_name: verifiedName } : {}),
    ...(nameStatus ? { name_status: nameStatus } : {}),
    ...(qualityRating ? { quality_rating: qualityRating } : {}),
  };

  if (typeof details.is_on_biz_app === "boolean") {
    patch.is_on_biz_app = details.is_on_biz_app;
  }

  const messagingLimit = readNonEmptyString(
    details.whatsapp_business_manager_messaging_limit,
  );
  if (messagingLimit) {
    patch.whatsapp_business_manager_messaging_limit = messagingLimit;
    patch.phone_messaging_limit = messagingLimit;
  }

  return patch;
}

/**
 * OTP verification and platform type do not confirm Cloud API registration.
 * Prefer Meta's live connection status; if absent, accept Meta's documented
 * coexistence proof or a recorded successful registration/connection.
 */
export function isWhatsAppPhoneNumberRegistered(
  details: Pick<
    WhatsAppPhoneNumberDetails,
    "status" | "is_on_biz_app" | "platform_type"
  >,
  credentials?: Pick<
    WhatsAppCredentials,
    "phone_registered" | "phone_registration_status"
  >,
): boolean {
  const status = readNonEmptyString(details.status)?.toUpperCase();
  if (status) return status === "CONNECTED";

  // Meta's coexistence onboarding check confirms registration on both platforms.
  if (
    details.is_on_biz_app === true &&
    isCloudApiPlatformType(details.platform_type)
  ) {
    return true;
  }

  const storedStatus = readNonEmptyString(
    credentials?.phone_registration_status,
  )?.toUpperCase();
  return (
    credentials?.phone_registered === true &&
    (storedStatus === "REGISTERED" || storedStatus === "CONNECTED")
  );
}

export function getWhatsAppPhoneNumberReadiness(
  details: WhatsAppPhoneNumberDetails,
): WhatsAppPhoneNumberReadiness {
  const issues: string[] = [];
  const verificationStatus = readNonEmptyString(
    details.code_verification_status,
  );
  const nameStatus = readNonEmptyString(details.name_status);
  const qualityRating = readNonEmptyString(details.quality_rating);

  if (!isWhatsAppPhoneNumberRegistered(details)) {
    issues.push(
      `Phone number is not connected to Cloud API (status: ${readNonEmptyString(details.status) || "UNAVAILABLE"})`,
    );
  }

  if (!verificationStatus) {
    issues.push("Phone number verification status is unavailable");
  } else if (verificationStatus !== "VERIFIED") {
    issues.push(`Phone number not verified (status: ${verificationStatus})`);
  }

  if (!nameStatus) {
    issues.push("Display name status is unavailable");
  } else if (nameStatus !== "APPROVED") {
    issues.push(`Display name not approved (status: ${nameStatus})`);
  }

  if (qualityRating === "RED") {
    issues.push(
      "Phone number has RED quality rating - messaging may be limited",
    );
  }

  return {
    ready: issues.length === 0,
    status: verificationStatus || "UNAVAILABLE",
    ...(issues.length > 0 ? { issues } : {}),
  };
}
