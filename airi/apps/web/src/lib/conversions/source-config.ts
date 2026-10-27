import type { WhatsAppConversionsConfiguration } from "@icecore/shared/types/conversion-events";
import { normalizeWhatsAppAccountIdentifiers } from "@icecore/shared/lib/whatsapp/account-identifiers";
import { asWhatsAppRecord } from "@icecore/shared/lib/whatsapp/value-utils";

export type WhatsAppConversionsSettings = {
  enabled: boolean;
  datasetId: string | null;
  wabaId: string | null;
  hasWebhookSecret: boolean;
  webhookEnabled: boolean;
  webhookUrl: string;
};

export type WhatsAppConversionsSettingsAction =
  | "enable_meta"
  | "disable_meta"
  | "rotate_webhook_secret"
  | "disable_webhook";

export function readWhatsAppConversionsConfiguration(
  credentials: unknown
): WhatsAppConversionsConfiguration | null {
  const raw = asWhatsAppRecord(credentials);
  const config = asWhatsAppRecord(raw.conversions_api);
  const { wabaId } = normalizeWhatsAppAccountIdentifiers(raw);
  if (
    typeof config.enabled !== "boolean" ||
    typeof config.dataset_id !== "string" ||
    !/^\d{1,32}$/.test(config.dataset_id) ||
    typeof config.waba_id !== "string" ||
    !/^\d{1,32}$/.test(config.waba_id) ||
    config.waba_id !== wabaId ||
    typeof config.configured_at !== "string" ||
    !Number.isFinite(Date.parse(config.configured_at)) ||
    (config.test_event_code != null &&
      (typeof config.test_event_code !== "string" ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(config.test_event_code))) ||
    (config.attribution_boundary_at !== undefined &&
      (typeof config.attribution_boundary_at !== "string" ||
        !Number.isFinite(Date.parse(config.attribution_boundary_at))))
  ) {
    return null;
  }
  return {
    enabled: config.enabled,
    dataset_id: config.dataset_id,
    waba_id: config.waba_id,
    configured_at: config.configured_at,
    ...(typeof config.attribution_boundary_at === "string"
      ? { attribution_boundary_at: config.attribution_boundary_at }
      : {}),
    ...(typeof config.test_event_code === "string" &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(config.test_event_code)
      ? { test_event_code: config.test_event_code }
      : {}),
  };
}

/** Keep public connection fields while withholding provider and commerce secrets. */
export function toPublicWhatsAppConversionCredentials(credentials: unknown) {
  const result = { ...asWhatsAppRecord(credentials) };
  delete result.access_token;
  delete result.accessToken;
  delete result.sales_webhook_secret;
  if ("conversions_api" in result) {
    result.conversions_api = readWhatsAppConversionsConfiguration(result);
  }
  return result;
}

export function hasProtectedWhatsAppConversionFields(credentials: unknown) {
  const raw = asWhatsAppRecord(credentials);
  return [
    "conversions_api",
    "sales_webhook_secret",
    "sales_webhook_enabled",
  ].some(key => Object.prototype.hasOwnProperty.call(raw, key));
}
