import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";

import {
  getPhoneNumberDetails,
  registerPhoneNumberWithPin,
} from "@/lib/whatsapp/qr-code-service";
import {
  buildWhatsAppPhoneDetailsCredentialPatch,
  isWhatsAppPhoneNumberRegistered,
} from "@icecore/shared/lib/whatsapp/phone-details";
import {
  getWabaWebhookSubscriptionStatus,
  subscribeToWABAWebhooks,
} from "@/lib/whatsapp/waba-service";
import {
  analyzeSubscribedFields,
  type WebhookFieldCoverage,
} from "@icecore/whatsapp/webhookFields";
import { WHATSAPP_CALL_WEBHOOK_PUBSUB_DEFAULT_TOPIC } from "@icecore/temporal";
import type {
  PhoneCallingRestriction,
  PhoneCallingVoicemailDefaults,
  PhoneCallingVoicemailTrigger,
  PhoneSettingsResponse,
} from "@icecore/airi-runtime/whatsapp-calling-service";
import {
  DEFAULT_PHONE_CALLING_VOICEMAIL_TIMEOUT_SECONDS,
  DEFAULT_PHONE_CALLING_VOICEMAIL_TRIGGERS,
  enablePhoneCallingDefaults,
  getPhoneCallingSettings,
} from "@icecore/airi-runtime/whatsapp-calling-service";
import { readString } from "@icecore/shared/lib/value-utils";
import { getWhatsAppCallMediaSourceReadiness } from "@icecore/shared/lib/whatsapp/calling-media-readiness";
import {
  buildWhatsAppBusinessAppConnectionPatch,
  hasWhatsAppBusinessAppConnectionSignal,
  isSmbPlatformType,
} from "@icecore/shared/lib/whatsapp/phone-registration-mode";
import { isWhatsAppCloudApiMessagingSuspended } from "@icecore/shared/lib/whatsapp/source-state";
import {
  asWhatsAppRecord as asRecord,
  readWhatsAppBoolean as parseWhatsAppBoolean,
} from "@icecore/shared/lib/whatsapp/value-utils";
import type { WhatsAppCredentials } from "@icecore/shared/types/sources";

const CALLS_WEBHOOK_SETUP_GUIDE_URL =
  "https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks";

export type AutoDefaultsTrigger =
  | "embedded_signup_connect"
  | "oauth_connect"
  | "source_connect"
  | "token_refresh"
  | "upgrade_fallback"
  | "upgrade_retry"
  | "onboarding_action"
  | "unknown";

interface AutoDefaultsRunResult {
  success: boolean;
  warnings: string[];
  statusPatch: Partial<WhatsAppCredentials>;
  credentials: Record<string, unknown>;
  stepResults: AutoDefaultsStepResults;
}

type AutoDefaultsStepStatus = "success" | "failed" | "skipped";

interface AutoDefaultsStepResult {
  status: AutoDefaultsStepStatus;
  message: string;
}

interface AutoDefaultsStepResults {
  step3_subscribe_waba: AutoDefaultsStepResult;
  step4_verify_waba_subscription: AutoDefaultsStepResult;
  step8_enable_calling_defaults: AutoDefaultsStepResult;
  step9_verify_calling_settings: AutoDefaultsStepResult;
}

interface WabaSubscribedFieldsResult {
  success: boolean;
  fields: string[];
  coverage?: WebhookFieldCoverage;
  error?: string;
  actionable?: string | null;
}

type WhatsAppCallingReadinessCheckId =
  | "calls_webhook_subscribed"
  | "phone_calling_enabled"
  | "callback_permission_enabled"
  | "source_media_enabled"
  | "livekit_configured"
  | "temporal_configured"
  | "call_pubsub_configured";

interface WhatsAppCallingReadinessCheck {
  id: WhatsAppCallingReadinessCheckId;
  ready: boolean;
  label: string;
  value: string;
  actionable: string;
}

export interface WhatsAppCallingOperationalReadiness {
  ready: boolean;
  checks: WhatsAppCallingReadinessCheck[];
}

interface WhatsAppCallingReadinessStatus {
  calls_webhook_subscribed?: boolean;
  calls_enabled?: boolean;
  calls_callback_permission_status?: string;
  calls_voicemail_enabled?: boolean;
  calls_voicemail_status?: string;
  whatsapp_calls_media_enabled?: boolean;
  embedded_signup?: boolean;
  embedded_signup_flow?: string;
  embedded_signup_event?: string;
  is_on_biz_app?: boolean;
  coexistence_mode?: boolean;
  partner_app_installed?: boolean;
  qr_registered?: boolean;
  platform_type?: string;
}

interface AutoDefaultsParams {
  sourceId: string;
  credentials: Record<string, unknown> | null | undefined;
  saveCredentials: (credentials: Record<string, unknown>) => Promise<void>;
  trigger?: AutoDefaultsTrigger;
  force?: boolean;
}

function readRuntimeEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = String(env[name] || "").trim();
  return value || null;
}

function readFirstRuntimeEnv(
  env: NodeJS.ProcessEnv,
  ...names: string[]
): string | null {
  for (const name of names) {
    const value = readRuntimeEnv(env, name);
    if (value) return value;
  }
  return null;
}

function getRuntimeProjectId(env: NodeJS.ProcessEnv): string | null {
  return readFirstRuntimeEnv(
    env,
    "WHATSAPP_CALL_PUBSUB_PROJECT_ID",
    "GOOGLE_CLOUD_PROJECT",
    "GCP_PROJECT_ID",
    "GCP_PROJECT"
  );
}

function shouldRequireTemporalApiKey(address: string | null): boolean {
  if (!address) return false;
  return /\.api\.temporal\.io(?::\d+)?$/i.test(address);
}

function resolvePhoneCallingVoicemailDefaults(
  credentials: Record<string, unknown>
): PhoneCallingVoicemailDefaults | null {
  const announcementMediaId = readString(
    credentials.calls_voicemail_announcement_media_id
  )?.trim();
  if (!announcementMediaId) return null;

  return {
    announcementMediaId,
    timeoutSeconds: DEFAULT_PHONE_CALLING_VOICEMAIL_TIMEOUT_SECONDS,
    triggers: DEFAULT_PHONE_CALLING_VOICEMAIL_TRIGGERS,
  };
}

export function buildWhatsAppCallingOperationalReadiness(
  status: WhatsAppCallingReadinessStatus | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): WhatsAppCallingOperationalReadiness {
  const callingStatus = status || {};
  const callbackPermission =
    callingStatus.calls_callback_permission_status?.toUpperCase();
  const sourceMediaReadiness =
    getWhatsAppCallMediaSourceReadiness(callingStatus);
  const liveKitConfigured = Boolean(
    readRuntimeEnv(env, "LIVEKIT_URL") &&
      readRuntimeEnv(env, "LIVEKIT_API_KEY") &&
      readRuntimeEnv(env, "LIVEKIT_API_SECRET")
  );
  const temporalAddress = readFirstRuntimeEnv(
    env,
    "TEMPORAL_ADDRESS",
    "TEMPORAL_CLOUD_ADDRESS"
  );
  const temporalConfigured = Boolean(
    temporalAddress &&
      readFirstRuntimeEnv(
        env,
        "TEMPORAL_NAMESPACE",
        "TEMPORAL_CLOUD_NAMESPACE"
      ) &&
      (!shouldRequireTemporalApiKey(temporalAddress) ||
        readFirstRuntimeEnv(env, "TEMPORAL_API_KEY", "TEMPORAL_CLOUD_API_KEY"))
  );
  const callPubSubConfigured = Boolean(
    readRuntimeEnv(env, "WHATSAPP_CALL_PUBSUB_ENABLED") !== "false" &&
      getRuntimeProjectId(env) &&
      (readRuntimeEnv(env, "WHATSAPP_CALL_PUBSUB_TOPIC") ||
        WHATSAPP_CALL_WEBHOOK_PUBSUB_DEFAULT_TOPIC)
  );

  const checks: WhatsAppCallingReadinessCheck[] = [
    {
      id: "calls_webhook_subscribed",
      ready: callingStatus.calls_webhook_subscribed === true,
      label: "Calls webhook field",
      value:
        callingStatus.calls_webhook_subscribed === true
          ? "Subscribed"
          : "Missing",
      actionable:
        "Subscribe the WhatsApp Business Account to the calls webhook field.",
    },
    {
      id: "phone_calling_enabled",
      ready: callingStatus.calls_enabled === true,
      label: "Phone calling",
      value: callingStatus.calls_enabled === true ? "Enabled" : "Disabled",
      actionable: "Enable WhatsApp Calling API defaults for this phone number.",
    },
    {
      id: "callback_permission_enabled",
      ready: callbackPermission === "ENABLED",
      label: "Callback permission",
      value: callbackPermission
        ? humanizeRuntimeStatus(callbackPermission)
        : "Unknown",
      actionable:
        "Enable callback permission in the WhatsApp phone calling settings.",
    },
    {
      id: "source_media_enabled",
      ready: sourceMediaReadiness.enabled,
      label: "Full Cloud media",
      value: sourceMediaReadiness.enabled ? "Enabled" : "Disabled",
      actionable:
        "Reconnect with Full Cloud Embedded Signup; coexistence numbers do not auto-answer call media.",
    },
    {
      id: "livekit_configured",
      ready: liveKitConfigured,
      label: "LiveKit media bridge",
      value: liveKitConfigured ? "Configured" : "Missing",
      actionable: "Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET.",
    },
    {
      id: "temporal_configured",
      ready: temporalConfigured,
      label: "Temporal call orchestration",
      value: temporalConfigured ? "Configured" : "Missing",
      actionable:
        "Set Temporal address and namespace for call workflow signaling; Temporal Cloud also needs an API key.",
    },
    {
      id: "call_pubsub_configured",
      ready: callPubSubConfigured,
      label: "Call Pub/Sub queue",
      value: callPubSubConfigured ? "Configured" : "Missing",
      actionable:
        "Set WHATSAPP_CALL_PUBSUB_PROJECT_ID or a default GCP project and keep the call Pub/Sub topic configured.",
    },
  ];

  return {
    ready: checks.every(check => check.ready),
    checks,
  };
}

function humanizeRuntimeStatus(value: string): string {
  return value
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, char => char.toUpperCase());
}

function isSmbRegisterEndpointUnavailable(errorMessage: string): boolean {
  return errorMessage
    .toLowerCase()
    .includes("register endpoint is not available for smb businesses");
}

function resolveTwoStepPin(): string | null {
  const pin = process.env.WHATSAPP_DEFAULT_PIN;
  if (pin && /^\d{6}$/.test(pin)) {
    return pin;
  }
  return null;
}

function normalizeRestrictions(
  input: unknown
): PhoneCallingRestriction[] | undefined {
  if (!input) {
    return undefined;
  }

  const restrictions = (() => {
    if (Array.isArray(input)) {
      return input;
    }

    const record = asRecord(input);
    const list = record.restrictions_list;
    return Array.isArray(list) ? list : [];
  })();

  const normalized = restrictions
    .map(item => {
      if (!item || typeof item !== "object") return null;
      const candidate = item as Record<string, unknown>;
      const type = readString(candidate.type);
      if (!type) return null;
      const reason = readString(candidate.reason);
      const expiration =
        typeof candidate.expiration === "number"
          ? candidate.expiration
          : undefined;
      return {
        type,
        ...(reason ? { reason } : {}),
        ...(typeof expiration === "number" ? { expiration } : {}),
      };
    })
    .filter((item): item is PhoneCallingRestriction => item !== null);

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeVoicemailTriggers(
  input: unknown
): PhoneCallingVoicemailTrigger[] | undefined {
  if (!Array.isArray(input)) return undefined;

  const triggers = input
    .map(item => (typeof item === "string" ? item.trim().toUpperCase() : ""))
    .filter(
      (item): item is PhoneCallingVoicemailTrigger =>
        item === "REJECT" || item === "TIMEOUT"
    );

  return triggers.length > 0 ? Array.from(new Set(triggers)) : undefined;
}

function parseInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function buildCallingStatusPatch(
  settings: PhoneSettingsResponse,
  existingCredentials: Record<string, unknown> | null | undefined,
  checkedAt: string
): Partial<WhatsAppCredentials> {
  const calling = asRecord(settings.calling);
  const status = readString(calling.status);
  const iconVisibility = readString(calling.call_icon_visibility);
  const callbackPermissionStatus = readString(
    calling.callback_permission_status
  );
  const voicemail = asRecord(calling.voicemail);
  const voicemailStatus = readString(voicemail.status);
  const voicemailEnabled = voicemailStatus?.toUpperCase() === "ENABLED";
  const voicemailAudio = asRecord(asRecord(voicemail.audio).default);
  const voicemailAnnouncementMediaId =
    typeof voicemailAudio.announcement_media_id === "string" ||
    typeof voicemailAudio.announcement_media_id === "number"
      ? String(voicemailAudio.announcement_media_id)
      : undefined;
  const restrictions = normalizeRestrictions(calling.restrictions);
  const isEnabled = status?.toUpperCase() === "ENABLED";

  const patch: Partial<WhatsAppCredentials> = {
    calls_status: status,
    calls_enabled: isEnabled,
    calls_icon_visibility: iconVisibility,
    calls_callback_permission_status: callbackPermissionStatus,
    calls_voicemail_status: voicemailStatus,
    calls_voicemail_enabled: voicemailEnabled,
    calls_voicemail_triggers: normalizeVoicemailTriggers(voicemail.triggers),
    calls_voicemail_announcement_media_id: voicemailAnnouncementMediaId,
    calls_voicemail_timeout_seconds: parseInteger(
      voicemailAudio.timeout_seconds
    ),
    calls_restrictions: restrictions,
    calls_last_checked_at: checkedAt,
  };

  const existingEnabledAt = readString(existingCredentials?.calls_enabled_at);
  if (isEnabled && !existingEnabledAt) {
    patch.calls_enabled_at = checkedAt;
  }

  return patch;
}

async function getWabaSubscribedFields(
  wabaId: string,
  accessToken: string,
  options?: { coexistenceMode?: boolean }
): Promise<WabaSubscribedFieldsResult> {
  try {
    const status = await getWabaWebhookSubscriptionStatus(
      wabaId,
      accessToken,
      options
    );

    return {
      success: true,
      fields: status.fields,
      coverage: status.coverage,
    };
  } catch (error) {
    if (error instanceof MetaGraphRequestError) {
      return {
        success: false,
        fields: [],
        error:
          error.formattedError?.message ||
          `Failed to read WABA subscribed fields (HTTP ${error.status})`,
        actionable: error.formattedError?.actionable || null,
      };
    }

    return {
      success: false,
      fields: [],
      error:
        error instanceof Error
          ? error.message
          : "Failed to read WABA subscribed fields",
      actionable: null,
    };
  }
}

export async function runWhatsAppAutoDefaults({
  sourceId,
  credentials,
  saveCredentials,
  trigger = "unknown",
  force = false,
}: AutoDefaultsParams): Promise<AutoDefaultsRunResult> {
  const warnings: string[] = [];
  const stepResults: AutoDefaultsStepResults = {
    step3_subscribe_waba: {
      status: "skipped",
      message: "Step not executed yet.",
    },
    step4_verify_waba_subscription: {
      status: "skipped",
      message: "Step not executed yet.",
    },
    step8_enable_calling_defaults: {
      status: "skipped",
      message: "Step not executed yet.",
    },
    step9_verify_calling_settings: {
      status: "skipped",
      message: "Step not executed yet.",
    },
  };
  const statusPatch: Partial<WhatsAppCredentials> = {
    auto_defaults_last_attempt_at: new Date().toISOString(),
    auto_defaults_last_trigger: trigger,
    auto_defaults_last_error: null,
  };

  const nextCredentials: Record<string, unknown> = {
    ...asRecord(credentials),
  };

  const applyPatch = (patch: Partial<WhatsAppCredentials>) => {
    Object.assign(statusPatch, patch);
    Object.assign(nextCredentials, patch);
  };

  const normalized = normalizeWhatsAppCredentials(nextCredentials);
  const wabaId = normalized.wabaId;
  const phoneNumberId = normalized.phoneNumberId;
  const accessToken = normalized.accessToken;
  const storedCredentials = asRecord(nextCredentials);
  const coexistenceMode = hasWhatsAppBusinessAppConnectionSignal({
    embeddedSignupFlow: readString(storedCredentials.embedded_signup_flow),
    embeddedSignupEvent: readString(storedCredentials.embedded_signup_event),
    isOnBizApp: parseWhatsAppBoolean(storedCredentials.is_on_biz_app),
    coexistenceMode: parseWhatsAppBoolean(storedCredentials.coexistence_mode),
    partnerAppInstalled: parseWhatsAppBoolean(
      storedCredentials.partner_app_installed
    ),
    qrRegistered: parseWhatsAppBoolean(storedCredentials.qr_registered),
    platformType: readString(storedCredentials.platform_type),
  });
  const embeddedSignupFlow = readString(
    storedCredentials.embedded_signup_flow
  )?.toLowerCase();
  if (embeddedSignupFlow === "cloud_api" && !coexistenceMode) {
    applyPatch({ whatsapp_calls_media_enabled: true });
  } else if (embeddedSignupFlow === "coexistence" || coexistenceMode) {
    applyPatch({ whatsapp_calls_media_enabled: false });
  }

  if (!wabaId || !phoneNumberId || !accessToken) {
    const message = `Cannot auto-enable defaults for source ${sourceId} because WhatsApp credentials are incomplete.`;
    stepResults.step3_subscribe_waba = {
      status: "failed",
      message,
    };
    stepResults.step4_verify_waba_subscription = {
      status: "failed",
      message,
    };
    stepResults.step8_enable_calling_defaults = {
      status: "failed",
      message,
    };
    stepResults.step9_verify_calling_settings = {
      status: "failed",
      message,
    };
    applyPatch({
      calls_enablement_error: message,
      calls_enablement_actionable:
        "Reconnect WhatsApp integration to refresh WABA, phone number, and token data.",
      auto_defaults_last_error: message,
    });

    try {
      await saveCredentials(nextCredentials);
    } catch (saveError) {
      warnings.push(
        saveError instanceof Error ? saveError.message : String(saveError)
      );
    }

    return {
      success: false,
      warnings,
      statusPatch,
      credentials: nextCredentials,
      stepResults,
    };
  }

  const wabaSubscription = await subscribeToWABAWebhooks(wabaId, accessToken, {
    coexistenceMode,
  });
  if (!wabaSubscription.success) {
    const subscribeMessage =
      wabaSubscription.error ||
      "Failed to subscribe WABA webhooks automatically.";
    stepResults.step3_subscribe_waba = {
      status: "failed",
      message: subscribeMessage,
    };
    warnings.push(subscribeMessage);
  } else {
    stepResults.step3_subscribe_waba = {
      status: "success",
      message: "WABA webhook subscription request completed.",
    };
  }

  let subscribedFields = wabaSubscription.subscribedFields || [];
  let webhookCoverage = wabaSubscription.coverage;
  let step4ReadFailed = false;
  if (subscribedFields.length === 0 || force) {
    const subscribedFieldResult = await getWabaSubscribedFields(
      wabaId,
      accessToken,
      { coexistenceMode }
    );

    if (subscribedFieldResult.success) {
      subscribedFields = subscribedFieldResult.fields;
      webhookCoverage = subscribedFieldResult.coverage;
    } else if (subscribedFieldResult.error) {
      warnings.push(subscribedFieldResult.error);
      step4ReadFailed = true;
      stepResults.step4_verify_waba_subscription = {
        status: "failed",
        message: subscribedFieldResult.error,
      };
    }
  }

  const normalizedCoverage =
    webhookCoverage ||
    analyzeSubscribedFields(subscribedFields, { coexistenceMode });
  const callsWebhookSubscribed = subscribedFields.includes("calls");
  const webhookCheckedAt = new Date().toISOString();

  applyPatch({
    waba_subscribed_fields: subscribedFields,
    calls_webhook_subscribed: callsWebhookSubscribed,
    webhook_profile_version: normalizedCoverage.profileVersion,
    webhook_required_fields: normalizedCoverage.requiredFields,
    webhook_optional_fields: normalizedCoverage.optionalFields,
    webhook_missing_required_fields: normalizedCoverage.missingRequiredFields,
    webhook_missing_optional_fields: normalizedCoverage.missingOptionalFields,
    webhook_fields_last_checked_at: webhookCheckedAt,
  });

  if (!step4ReadFailed) {
    if (callsWebhookSubscribed) {
      stepResults.step4_verify_waba_subscription = {
        status: "success",
        message: "`calls` is present in WABA subscribed webhook fields.",
      };
    } else {
      stepResults.step4_verify_waba_subscription = {
        status: "failed",
        message: "`calls` is missing in WABA subscribed webhook fields.",
      };
    }
  }

  // Keep phone registration behavior aligned with existing onboarding rules.
  const storedRegistration = {
    phone_registered:
      parseWhatsAppBoolean(nextCredentials.phone_registered) === true,
    phone_registration_status:
      readString(nextCredentials.phone_registration_status) || undefined,
  };
  const phonePatch: Partial<WhatsAppCredentials> = {
    phone_registered: isWhatsAppPhoneNumberRegistered({}, storedRegistration),
  };
  let registerSkippedBySmb = coexistenceMode;

  try {
    const details = await getPhoneNumberDetails(phoneNumberId, accessToken);
    const detailsIndicateBusinessAppConnection =
      details.is_on_biz_app === true ||
      isSmbPlatformType(details.platform_type);

    Object.assign(
      phonePatch,
      buildWhatsAppPhoneDetailsCredentialPatch(details)
    );
    Object.assign(
      phonePatch,
      buildWhatsAppBusinessAppConnectionPatch({
        embeddedSignupFlow: readString(nextCredentials.embedded_signup_flow),
        embeddedSignupEvent: readString(nextCredentials.embedded_signup_event),
        isOnBizApp: details.is_on_biz_app,
        coexistenceMode: parseWhatsAppBoolean(nextCredentials.coexistence_mode),
        partnerAppInstalled: parseWhatsAppBoolean(
          nextCredentials.partner_app_installed
        ),
        partnerAppInstalledAt: readString(
          nextCredentials.partner_app_installed_at
        ),
        qrRegistered: parseWhatsAppBoolean(nextCredentials.qr_registered),
        platformType:
          details.platform_type || readString(nextCredentials.platform_type),
        cloudApiMessagingSuspended:
          isWhatsAppCloudApiMessagingSuspended(nextCredentials),
      })
    );

    phonePatch.phone_registered = isWhatsAppPhoneNumberRegistered(
      details,
      storedRegistration
    );
    registerSkippedBySmb ||= detailsIndicateBusinessAppConnection;
    if (phonePatch.phone_registered) {
      phonePatch.phone_registered_at =
        readString(nextCredentials.phone_registered_at) ||
        new Date().toISOString();
      phonePatch.phone_registration_error = null;
    }
  } catch (error) {
    warnings.push(
      error instanceof Error
        ? error.message
        : "Failed to fetch phone number status before auto registration."
    );
  }

  if (!phonePatch.phone_registered) {
    phonePatch.phone_registered_at = undefined;
    if (registerSkippedBySmb) {
      phonePatch.phone_registration_error =
        "Phone registration API is not available for SMB/coexistence numbers.";
    }
  }

  if (!phonePatch.phone_registered && !registerSkippedBySmb) {
    const pin = resolveTwoStepPin();
    if (!pin) {
      phonePatch.phone_registration_error =
        "PIN is not configured in server environment. Manual registration may be required.";
    } else {
      try {
        await registerPhoneNumberWithPin({
          phoneNumberId,
          pin,
          accessToken,
        });

        phonePatch.phone_registered = true;
        phonePatch.phone_registered_at = new Date().toISOString();
        phonePatch.phone_registration_status = "REGISTERED";
        phonePatch.phone_registration_error = null;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const normalizedError = errorMessage.toLowerCase();
        const alreadyRegistered =
          normalizedError.includes("already") &&
          normalizedError.includes("register");

        if (alreadyRegistered) {
          phonePatch.phone_registered = true;
          phonePatch.phone_registered_at =
            readString(nextCredentials.phone_registered_at) ||
            new Date().toISOString();
          phonePatch.phone_registration_status = "REGISTERED";
          phonePatch.phone_registration_error = null;
        } else if (isSmbRegisterEndpointUnavailable(errorMessage)) {
          registerSkippedBySmb = true;
          phonePatch.phone_registration_error =
            "Phone registration API is not available for SMB/coexistence numbers.";
        } else {
          phonePatch.phone_registration_error = errorMessage;
          warnings.push(errorMessage);
        }
      }
    }
  }

  applyPatch(phonePatch);

  let callsEnablementBlockedByWebhook = false;
  if (!callsWebhookSubscribed) {
    callsEnablementBlockedByWebhook = true;
    const actionable =
      normalizedCoverage.actionable ||
      "Enable the `calls` webhook field in Meta App Dashboard and re-subscribe the WABA app webhook.";
    const message =
      "Calls webhook field is not subscribed for this WABA. Calls enablement was skipped.";
    stepResults.step8_enable_calling_defaults = {
      status: "skipped",
      message,
    };
    applyPatch({
      calls_enablement_error: message,
      calls_enablement_actionable: actionable,
    });
    warnings.push(`${message} Guide: ${CALLS_WEBHOOK_SETUP_GUIDE_URL}`);
  } else {
    const voicemailDefaults =
      resolvePhoneCallingVoicemailDefaults(nextCredentials);
    const enableResult = await enablePhoneCallingDefaults(
      phoneNumberId,
      accessToken,
      {
        voicemail: voicemailDefaults,
      }
    );

    if (!enableResult.success) {
      stepResults.step8_enable_calling_defaults = {
        status: "failed",
        message: enableResult.error.message,
      };
      warnings.push(enableResult.error.message);
      applyPatch({
        calls_enablement_error: enableResult.error.message,
        calls_enablement_actionable: enableResult.error.actionable || null,
      });
    } else {
      stepResults.step8_enable_calling_defaults = {
        status: "success",
        message: voicemailDefaults
          ? "Calling defaults and voicemail were enabled via phone settings endpoint."
          : "Calling defaults were enabled via phone settings endpoint.",
      };
      applyPatch({
        calls_enablement_error: null,
        calls_enablement_actionable: null,
      });
    }
  }

  const checkedAt = new Date().toISOString();
  const settingsResult = await getPhoneCallingSettings(
    phoneNumberId,
    accessToken
  );

  if (settingsResult.success) {
    stepResults.step9_verify_calling_settings = {
      status: "success",
      message: "Phone calling settings were fetched successfully.",
    };
    applyPatch(
      buildCallingStatusPatch(settingsResult.data, nextCredentials, checkedAt)
    );

    if (statusPatch.calls_enabled && callsWebhookSubscribed) {
      applyPatch({
        calls_enablement_error: null,
        calls_enablement_actionable: null,
      });
    }
  } else {
    stepResults.step9_verify_calling_settings = {
      status: "failed",
      message: settingsResult.error.message,
    };
    warnings.push(settingsResult.error.message);
    applyPatch(
      callsEnablementBlockedByWebhook
        ? {
            calls_last_checked_at: checkedAt,
          }
        : {
            calls_last_checked_at: checkedAt,
            calls_enablement_error: settingsResult.error.message,
            calls_enablement_actionable:
              settingsResult.error.actionable || null,
          }
    );
  }

  if (!statusPatch.calls_enabled_at && statusPatch.calls_enabled) {
    applyPatch({
      calls_enabled_at: checkedAt,
    });
  }

  const finalError = statusPatch.calls_enablement_error || warnings[0] || null;
  applyPatch({
    auto_defaults_last_error: finalError,
    ...(finalError
      ? {}
      : { auto_defaults_last_success_at: new Date().toISOString() }),
  });

  try {
    await saveCredentials(nextCredentials);
  } catch (error) {
    const saveErrorMessage =
      error instanceof Error
        ? error.message
        : "Failed to persist WhatsApp auto-defaults status.";

    warnings.push(saveErrorMessage);
    applyPatch({
      auto_defaults_last_error: saveErrorMessage,
    });

    return {
      success: false,
      warnings,
      statusPatch,
      credentials: nextCredentials,
      stepResults,
    };
  }

  return {
    success: !statusPatch.auto_defaults_last_error,
    warnings,
    statusPatch,
    credentials: nextCredentials,
    stepResults,
  };
}
