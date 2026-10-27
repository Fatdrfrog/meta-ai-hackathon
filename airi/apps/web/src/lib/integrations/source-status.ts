import {
  isOnboardingTestSource,
  type Source,
} from "@icecore/shared/types/sources";
import {
  isDisconnectedWhatsAppSource,
  isRemovedWhatsAppSource,
} from "@icecore/shared/lib/whatsapp/source-state";
import {
  asNullableRecord,
  readStringField,
} from "@icecore/shared/lib/value-utils";
import { getMetaAdsReportingReadiness } from "@/lib/meta-ads/meta-ads-reporting-readiness";

export { isDisconnectedWhatsAppSource, isRemovedWhatsAppSource };

function credentialString(
  credentials: Source["credentials"] | null | undefined,
  key: string
): string {
  return readStringField(asNullableRecord(credentials), key, { trim: true });
}

function hasEncryptedFields(value: unknown): boolean {
  const envelope = asNullableRecord(value);
  return Boolean(
    readStringField(envelope, "iv") &&
      readStringField(envelope, "tag") &&
      readStringField(envelope, "ciphertext")
  );
}

/**
 * Whether a stored Telegram row holds a bot token, without decrypting it: an
 * encrypted token, or a plain-text one saved before encryption.
 */
export function hasStoredTelegramBotToken(credentials: unknown): boolean {
  const token = asNullableRecord(credentials)?.bot_token;
  return typeof token === "string"
    ? token.trim().length > 0
    : hasEncryptedFields(token);
}

/** Also accepts the `has_bot_token` flag the browser gets instead of the token. */
export function hasTelegramBotToken(credentials: unknown): boolean {
  return (
    asNullableRecord(credentials)?.has_bot_token === true ||
    hasStoredTelegramBotToken(credentials)
  );
}

export function isConfiguredTelegramSource(source: Source | null | undefined) {
  return source?.type === "telegram" && hasTelegramBotToken(source.credentials);
}

export function isConfiguredWhatsAppSource(source: Source | null | undefined) {
  return source?.type === "whatsapp" && !isDisconnectedWhatsAppSource(source);
}

export function isConfiguredMetaAdsSource(source: Source | null | undefined) {
  return (
    source?.type === "meta_ads" &&
    getMetaAdsReportingReadiness(source.credentials).canRead
  );
}

export function isConfiguredIntegrationSource(source: Source) {
  // The onboarding test chat lazily creates a web_widget source; it is not a
  // real connected channel and must not satisfy onboarding/routing checks.
  if (isOnboardingTestSource(source)) {
    return false;
  }

  if (source.type === "telegram") {
    return isConfiguredTelegramSource(source);
  }

  if (source.type === "whatsapp") {
    return isConfiguredWhatsAppSource(source);
  }

  if (source.type === "meta_ads") {
    return isConfiguredMetaAdsSource(source);
  }

  if (source.type === "google_ai") {
    const credentials = asNullableRecord(source.credentials);
    const hasKey =
      credentials?.has_api_key === true ||
      hasEncryptedFields(credentials?.api_key);
    return (
      hasKey && Boolean(credentialString(source.credentials, "validated_at"))
    );
  }

  return true;
}
