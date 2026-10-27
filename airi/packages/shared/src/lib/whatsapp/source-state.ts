import {
  asNullableRecord,
  booleanField,
  readStringField,
} from "../value-utils";
import type { Source } from "../../types/sources";

export type WhatsAppWebhookSourceSkipReason =
  | "partner_removed"
  | "cloud_api_messaging_suspended";

export type WhatsAppWebhookSourceSkip = {
  reason: WhatsAppWebhookSourceSkipReason;
  message: string;
};

export const WHATSAPP_WEBHOOK_SOURCE_DISCONNECTED_MESSAGE =
  "source disconnected";

export function buildWhatsAppWebhookSourceSkipPayload(
  skip: WhatsAppWebhookSourceSkip,
) {
  return {
    status: "ok" as const,
    message: WHATSAPP_WEBHOOK_SOURCE_DISCONNECTED_MESSAGE,
    reason: skip.reason,
  };
}

function credentialString(credentials: unknown, key: string): string {
  return readStringField(asNullableRecord(credentials), key, { trim: true });
}

function credentialBoolean(credentials: unknown, key: string): boolean | null {
  return booleanField(asNullableRecord(credentials), key);
}

function readWhatsAppReonboardingStatus(credentials: unknown): string {
  return credentialString(
    credentials,
    "coexistence_reonboarding_status",
  ).toLowerCase();
}

export function isWhatsAppCloudApiMessagingSuspended(
  credentials: unknown,
): boolean {
  const reonboardingStatus = readWhatsAppReonboardingStatus(credentials);
  return (
    reonboardingStatus === "offboarded" ||
    reonboardingStatus === "removed" ||
    credentialBoolean(credentials, "cloud_api_messaging_suspended") === true
  );
}

function isDisconnectedWhatsAppCredentials(credentials: unknown): boolean {
  const coexistenceMode = credentialBoolean(credentials, "coexistence_mode");
  const partnerAppInstalled = credentialBoolean(
    credentials,
    "partner_app_installed",
  );

  return (
    isWhatsAppCloudApiMessagingSuspended(credentials) ||
    (coexistenceMode === true && partnerAppInstalled === false)
  );
}

export function isDisconnectedWhatsAppSource(
  source: Source | null | undefined,
) {
  if (source?.type !== "whatsapp") return false;

  return isDisconnectedWhatsAppCredentials(source.credentials);
}

export type WhatsAppSourceConnectionStatus =
  | "active"
  | "offboarded"
  | "removed";

/**
 * Connection state of a source-bound WhatsApp account, derived with the same
 * rules the webhook runtime uses to skip a disconnected source.
 */
export function deriveWhatsAppSourceConnectionStatus(
  credentials: unknown,
): WhatsAppSourceConnectionStatus {
  if (readWhatsAppReonboardingStatus(credentials) === "removed") {
    return "removed";
  }
  return isDisconnectedWhatsAppCredentials(credentials)
    ? "offboarded"
    : "active";
}

export function isRemovedWhatsAppSource(source: Source | null | undefined) {
  return (
    source?.type === "whatsapp" &&
    readWhatsAppReonboardingStatus(source.credentials) === "removed"
  );
}

export function getWhatsAppWebhookSourceSkip(
  source: Source | null | undefined,
): WhatsAppWebhookSourceSkip | null {
  if (source?.type !== "whatsapp") return null;

  const reonboardingStatus = readWhatsAppReonboardingStatus(source.credentials);
  if (reonboardingStatus === "removed") {
    return {
      reason: "partner_removed",
      message: "WhatsApp partner app access was removed.",
    };
  }

  if (isDisconnectedWhatsAppSource(source)) {
    return {
      reason: "cloud_api_messaging_suspended",
      message: "WhatsApp Cloud API messaging is suspended for this source.",
    };
  }

  return null;
}
