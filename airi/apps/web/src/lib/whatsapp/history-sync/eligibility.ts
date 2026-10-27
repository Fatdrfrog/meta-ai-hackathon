import { isSmbPlatformType } from "@icecore/shared/lib/whatsapp/phone-registration-mode";
import {
  asWhatsAppRecord as asRecord,
  readWhatsAppBoolean as booleanValue,
  compactWhatsAppString,
} from "@icecore/shared/lib/whatsapp/value-utils";

function stringValue(value: unknown) {
  return compactWhatsAppString(value)?.toLowerCase() || "";
}

export function isWhatsAppHistorySyncEligible(credentials: unknown) {
  const record = asRecord(credentials);
  const embeddedSignupFlow = stringValue(record.embedded_signup_flow);
  const embeddedSignupEvent = stringValue(record.embedded_signup_event);
  const platformType = stringValue(record.platform_type);
  const explicitlyFullCloud =
    (record.is_on_biz_app === false && platformType === "cloud_api") ||
    (embeddedSignupFlow === "cloud_api" &&
      !booleanValue(record.is_on_biz_app) &&
      !isSmbPlatformType(platformType));

  if (explicitlyFullCloud) return false;

  return (
    booleanValue(record.coexistence_mode) ||
    booleanValue(record.partner_app_installed) ||
    booleanValue(record.is_on_biz_app) ||
    booleanValue(record.qr_registered) ||
    embeddedSignupFlow === "coexistence" ||
    embeddedSignupEvent === "finish_whatsapp_business_app_onboarding" ||
    isSmbPlatformType(platformType)
  );
}
