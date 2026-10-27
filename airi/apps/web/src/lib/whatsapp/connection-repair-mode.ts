import { hasWhatsAppBusinessAppConnectionSignal } from "@icecore/shared/lib/whatsapp/phone-registration-mode";
import type { WhatsAppCredentialFields } from "@icecore/shared/types/sources";

export function isWhatsAppBusinessAppConnection(
  credentials: Partial<WhatsAppCredentialFields> | null | undefined
) {
  if (!credentials) return false;

  return hasWhatsAppBusinessAppConnectionSignal({
    embeddedSignupFlow: credentials.embedded_signup_flow,
    embeddedSignupEvent: credentials.embedded_signup_event,
    isOnBizApp: credentials.is_on_biz_app,
    coexistenceMode: credentials.coexistence_mode,
    partnerAppInstalled: credentials.partner_app_installed,
    qrRegistered: credentials.qr_registered,
    platformType: credentials.platform_type,
  });
}

export function getWhatsAppReconnectDefaultTab(
  credentials: Partial<WhatsAppCredentialFields> | null | undefined
): "qr" | "embedded" {
  return isWhatsAppBusinessAppConnection(credentials) ? "qr" : "embedded";
}

/**
 * PARTNER_REMOVED overwrites coexistence_mode and partner_app_installed, so
 * for a removed source only the flags Meta reported about the number count.
 */
export function withoutPartnerRemovalOverrides<
  T extends Partial<WhatsAppCredentialFields>,
>(credentials: T): T {
  return {
    ...credentials,
    coexistence_mode: undefined,
    partner_app_installed: undefined,
  };
}
