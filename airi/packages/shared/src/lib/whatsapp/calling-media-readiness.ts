import { readString } from "../value-utils";
import {
  hasWhatsAppBusinessAppConnectionSignal,
  isCloudApiPlatformType,
} from "./phone-registration-mode";
import { asWhatsAppRecord } from "./value-utils";

type WhatsAppCallMediaReadinessReason =
  | "source_media_disabled"
  | "source_calls_not_enabled";

type WhatsAppCallMediaReadiness = {
  enabled: boolean;
  reason: WhatsAppCallMediaReadinessReason | null;
};

function parseOptionalBoolean(value: unknown): boolean | null {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

function firstOptionalBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    const parsed = parseOptionalBoolean(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

export function getWhatsAppCallMediaSourceReadiness(
  credentials: unknown,
): WhatsAppCallMediaReadiness {
  const record = asWhatsAppRecord(credentials);
  const mediaSetting = firstOptionalBoolean(
    record.whatsapp_calls_media_enabled,
    record.whatsappCallsMediaEnabled,
  );

  if (mediaSetting === false) {
    return { enabled: false, reason: "source_media_disabled" };
  }

  const embeddedSignupFlow = readString(
    record.embedded_signup_flow ?? record.embeddedSignupFlow,
  );
  const platformType = readString(record.platform_type ?? record.platformType);
  const coexistenceMode = hasWhatsAppBusinessAppConnectionSignal({
    embeddedSignupFlow,
    embeddedSignupEvent: readString(
      record.embedded_signup_event ?? record.embeddedSignupEvent,
    ),
    isOnBizApp: parseOptionalBoolean(record.is_on_biz_app ?? record.isOnBizApp),
    coexistenceMode: parseOptionalBoolean(
      record.coexistence_mode ?? record.coexistenceMode,
    ),
    partnerAppInstalled: parseOptionalBoolean(
      record.partner_app_installed ?? record.partnerAppInstalled,
    ),
    qrRegistered: parseOptionalBoolean(
      record.qr_registered ?? record.qrRegistered,
    ),
    platformType,
  });

  if (coexistenceMode) {
    return { enabled: false, reason: "source_media_disabled" };
  }

  const fullCloudDefault =
    embeddedSignupFlow?.trim().toLowerCase() === "cloud_api" ||
    isCloudApiPlatformType(platformType);
  if (mediaSetting === true || fullCloudDefault) {
    return { enabled: true, reason: null };
  }

  return { enabled: false, reason: "source_media_disabled" };
}

export function getWhatsAppCallMediaReadiness(
  credentials: unknown,
): WhatsAppCallMediaReadiness {
  const record = asWhatsAppRecord(credentials);
  const sourceReadiness = getWhatsAppCallMediaSourceReadiness(record);
  if (!sourceReadiness.enabled) {
    return sourceReadiness;
  }

  const callsEnabled = firstOptionalBoolean(
    record.calls_enabled,
    record.callsEnabled,
  );
  if (!callsEnabled) {
    return { enabled: false, reason: "source_calls_not_enabled" };
  }

  return { enabled: true, reason: null };
}
