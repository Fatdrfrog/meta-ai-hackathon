import { decryptMaybeString } from "./crypto";
import { normalizeWhatsAppAccountIdentifiers } from "@icecore/shared/lib/whatsapp/account-identifiers";

export type OtpWhatsAppCredentials = {
  phoneNumberId?: string;
  accessToken?: string;
  messagingAccountId?: string;
};

export function extractOtpWhatsAppCredentials(
  input: unknown
): OtpWhatsAppCredentials {
  if (!input || typeof input !== "object") return {};
  const creds = input as Record<string, unknown>;
  const accountIds = normalizeWhatsAppAccountIdentifiers(creds);
  const accessToken =
    decryptMaybeString(creds.access_token) ||
    decryptMaybeString(creds.accessToken);

  return {
    phoneNumberId: accountIds.phoneNumberId,
    accessToken: accessToken || undefined,
    messagingAccountId: accountIds.messagingAccountId,
  };
}
