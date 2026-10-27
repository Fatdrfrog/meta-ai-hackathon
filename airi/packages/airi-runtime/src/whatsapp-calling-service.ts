import {
  MetaGraphAPIError,
  MetaGraphRequestError,
  buildGraphApiUrl,
  formatMetaGraphAPIError,
} from "@icecore/shared/lib/meta/api";

import { airiWorkerLogger } from "./logging";

export interface PhoneCallingRestriction {
  type: string;
  reason?: string;
  expiration?: number;
}

export type PhoneCallingVoicemailTrigger = "REJECT" | "TIMEOUT";

interface PhoneCallingVoicemailConfig {
  status?: string;
  triggers?: string[];
  audio?: {
    default?: {
      announcement_media_id?: string | number;
      timeout_seconds?: number;
    };
  };
}

interface PhoneCallingConfig {
  status?: string;
  call_icon_visibility?: string;
  callback_permission_status?: string;
  voicemail?: PhoneCallingVoicemailConfig;
  restrictions?: {
    restrictions_list?: PhoneCallingRestriction[];
  };
  [key: string]: unknown;
}

export interface PhoneSettingsResponse {
  calling?: PhoneCallingConfig;
  [key: string]: unknown;
}

interface CallingServiceError {
  message: string;
  actionable?: string | null;
  status?: number;
  metaError?: MetaGraphAPIError;
  details?: unknown;
}

type CallingServiceResult<T> =
  | { success: true; data: T }
  | { success: false; error: CallingServiceError };

type WhatsAppCallControlAction =
  | "pre_accept"
  | "accept"
  | "reject"
  | "terminate";

interface WhatsAppCallCommandParams {
  phoneNumberId: string;
  accessToken: string;
  callId: string;
  correlationId: string;
  /** Preferred Cloud API Messaging Account target (replaces paid_messaging_account_id). */
  messagingAccountId?: string;
}

interface WhatsAppCallAnswerCommandParams extends WhatsAppCallCommandParams {
  sdp: string;
}

interface WhatsAppCallCommandResult {
  action: WhatsAppCallControlAction;
  callId: string;
  phoneNumberId: string;
  correlationId: string;
  response: Record<string, unknown>;
}

export interface PhoneCallingVoicemailDefaults {
  announcementMediaId: string;
  timeoutSeconds?: number;
  triggers?: PhoneCallingVoicemailTrigger[];
}

interface PhoneCallingDefaultsOptions {
  voicemail?: PhoneCallingVoicemailDefaults | null;
}

type CallingLogger = {
  info: (message: string, context?: Record<string, unknown>) => void;
  error: (
    message: string,
    error?: unknown,
    context?: Record<string, unknown>,
  ) => void;
};

export type WhatsAppCallingGraphClient = {
  getJson<T = unknown>(path: string, options: { token: string }): Promise<T>;
  postJson<T = unknown>(
    path: string,
    options: { token: string; body?: unknown },
  ): Promise<T>;
};

export const DEFAULT_PHONE_CALLING_VOICEMAIL_TIMEOUT_SECONDS = 20;
export const DEFAULT_PHONE_CALLING_VOICEMAIL_TRIGGERS: PhoneCallingVoicemailTrigger[] =
  ["REJECT", "TIMEOUT"];

function parseMetaGraphAPIError(errorData: unknown): MetaGraphAPIError | null {
  try {
    if (typeof errorData === "string") {
      const parsed = JSON.parse(errorData);
      if (parsed.error) {
        return parsed.error as MetaGraphAPIError;
      }
      return null;
    }

    if (typeof errorData === "object" && errorData !== null) {
      const obj = errorData as Record<string, unknown>;
      if (obj.error) {
        return obj.error as MetaGraphAPIError;
      }

      if (obj.message && obj.code) {
        return obj as unknown as MetaGraphAPIError;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function normalizeVoicemailTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_PHONE_CALLING_VOICEMAIL_TIMEOUT_SECONDS;
  }
  return Math.min(30, Math.max(0, Math.trunc(value)));
}

function normalizeVoicemailTriggers(
  triggers: PhoneCallingVoicemailDefaults["triggers"],
): PhoneCallingVoicemailTrigger[] {
  const normalized = (
    triggers || DEFAULT_PHONE_CALLING_VOICEMAIL_TRIGGERS
  ).filter(
    (trigger): trigger is PhoneCallingVoicemailTrigger =>
      trigger === "REJECT" || trigger === "TIMEOUT",
  );
  return normalized.length > 0
    ? Array.from(new Set(normalized))
    : DEFAULT_PHONE_CALLING_VOICEMAIL_TRIGGERS;
}

function buildPhoneCallingDefaultsBody(
  options: PhoneCallingDefaultsOptions = {},
): Record<string, unknown> {
  const calling: Record<string, unknown> = {
    status: "ENABLED",
    call_icon_visibility: "DEFAULT",
    callback_permission_status: "ENABLED",
  };

  const voicemail = options.voicemail;
  const announcementMediaId = voicemail?.announcementMediaId?.trim();
  if (voicemail && announcementMediaId) {
    const triggers = normalizeVoicemailTriggers(voicemail.triggers);
    const defaultAudio: Record<string, unknown> = {
      announcement_media_id: announcementMediaId,
    };

    if (triggers.includes("TIMEOUT")) {
      defaultAudio.timeout_seconds = normalizeVoicemailTimeout(
        voicemail.timeoutSeconds,
      );
    }

    calling.voicemail = {
      status: "ENABLED",
      triggers,
      audio: {
        default: defaultAudio,
      },
    };
  }

  return { calling };
}

function graphErrorToCallingServiceError(
  error: unknown,
  fallbackMessage: string,
): CallingServiceError {
  if (error instanceof MetaGraphRequestError) {
    return {
      message: error.formattedError?.message || fallbackMessage,
      actionable: error.formattedError?.actionable || null,
      status: error.status,
      metaError: error.metaError,
      details: error.details,
    };
  }

  return {
    message: error instanceof Error ? error.message : fallbackMessage,
  };
}

async function parseResponsePayload(response: Response): Promise<{
  details: unknown;
  text: string;
}> {
  const text = await response.text();

  if (!text) {
    return {
      details: null,
      text: "",
    };
  }

  try {
    return {
      details: JSON.parse(text),
      text,
    };
  } catch {
    return {
      details: text,
      text,
    };
  }
}

function createDefaultGraphClient(): WhatsAppCallingGraphClient {
  async function requestJson<T>(
    path: string,
    params: {
      body?: unknown;
      method: "GET" | "POST";
      token: string;
    },
  ): Promise<T> {
    const response = await fetch(buildGraphApiUrl(path), {
      method: params.method,
      headers: {
        Authorization: `Bearer ${params.token}`,
        ...(params.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: params.body === undefined ? undefined : JSON.stringify(params.body),
    });

    const parsed = await parseResponsePayload(response);
    if (!response.ok) {
      const metaError = parseMetaGraphAPIError(parsed.details);
      const formattedError = metaError
        ? formatMetaGraphAPIError(metaError)
        : undefined;
      throw new MetaGraphRequestError({
        message:
          formattedError?.message ||
          `Meta Graph API request failed: HTTP ${response.status}`,
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        details: parsed.details,
        metaError: metaError || undefined,
        formattedError,
      });
    }

    if (parsed.details === null || parsed.details === undefined) {
      return {} as T;
    }
    if (typeof parsed.details === "string") {
      throw new MetaGraphRequestError({
        message: "Expected JSON response from Meta Graph API",
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        details: parsed.details,
      });
    }

    return parsed.details as T;
  }

  return {
    getJson: (path, options) =>
      requestJson(path, {
        method: "GET",
        token: options.token,
      }),
    postJson: (path, options) =>
      requestJson(path, {
        body: options.body,
        method: "POST",
        token: options.token,
      }),
  };
}

function createDefaultCallingLogger(): CallingLogger {
  return {
    info(message, context) {
      airiWorkerLogger.info("whatsapp.calling", {
        message,
        ...(context || {}),
      });
    },
    error(message, error, context) {
      airiWorkerLogger.error("whatsapp.calling", error, {
        message,
        ...(context || {}),
      });
    },
  };
}

export function createWhatsAppCallingService(options?: {
  graphClient?: WhatsAppCallingGraphClient;
  logger?: CallingLogger;
}) {
  const graphClient = options?.graphClient || createDefaultGraphClient();
  const callingLogger = options?.logger || createDefaultCallingLogger();

  async function sendWhatsAppCallCommand(
    params: WhatsAppCallCommandParams & {
      action: WhatsAppCallControlAction;
      sdp?: string;
    },
  ): Promise<CallingServiceResult<WhatsAppCallCommandResult>> {
    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      call_id: params.callId,
      action: params.action,
    };

    const messagingAccountId =
      typeof params.messagingAccountId === "string"
        ? params.messagingAccountId.trim()
        : "";
    if (messagingAccountId) {
      body.messaging_account_id = messagingAccountId;
    }

    if (params.sdp) {
      body.session = {
        sdp_type: "answer",
        sdp: params.sdp,
      };
    }

    try {
      const response = await graphClient.postJson<Record<string, unknown>>(
        `${params.phoneNumberId}/calls`,
        {
          token: params.accessToken,
          body,
        },
      );

      callingLogger.info("WhatsApp call command sent", {
        action: params.action,
        callId: params.callId,
        correlationId: params.correlationId,
        phoneNumberId: params.phoneNumberId,
      });

      return {
        success: true,
        data: {
          action: params.action,
          callId: params.callId,
          phoneNumberId: params.phoneNumberId,
          correlationId: params.correlationId,
          response,
        },
      };
    } catch (error) {
      callingLogger.error("WhatsApp call command failed", error, {
        action: params.action,
        callId: params.callId,
        correlationId: params.correlationId,
        phoneNumberId: params.phoneNumberId,
      });

      return {
        success: false,
        error: graphErrorToCallingServiceError(
          error,
          `Failed to send WhatsApp call ${params.action} command`,
        ),
      };
    }
  }

  return {
    acceptWhatsAppCall(params: WhatsAppCallAnswerCommandParams) {
      return sendWhatsAppCallCommand({ ...params, action: "accept" });
    },

    enablePhoneCallingDefaults(
      phoneNumberId: string,
      accessToken: string,
      defaults: PhoneCallingDefaultsOptions = {},
    ): Promise<CallingServiceResult<Record<string, unknown>>> {
      return graphClient
        .postJson<Record<string, unknown>>(`${phoneNumberId}/settings`, {
          token: accessToken,
          body: buildPhoneCallingDefaultsBody(defaults),
        })
        .then((data) => ({ success: true as const, data }))
        .catch((error) => ({
          success: false as const,
          error: graphErrorToCallingServiceError(
            error,
            "Failed to enable calling defaults",
          ),
        }));
    },

    getPhoneCallingSettings(
      phoneNumberId: string,
      accessToken: string,
    ): Promise<CallingServiceResult<PhoneSettingsResponse>> {
      return graphClient
        .getJson<PhoneSettingsResponse>(`${phoneNumberId}/settings`, {
          token: accessToken,
        })
        .then((data) => ({ success: true as const, data }))
        .catch((error) => ({
          success: false as const,
          error: graphErrorToCallingServiceError(
            error,
            "Failed to fetch calling settings",
          ),
        }));
    },

    preAcceptWhatsAppCall(params: WhatsAppCallAnswerCommandParams) {
      return sendWhatsAppCallCommand({ ...params, action: "pre_accept" });
    },

    rejectWhatsAppCall(params: WhatsAppCallCommandParams) {
      return sendWhatsAppCallCommand({ ...params, action: "reject" });
    },

    terminateWhatsAppCall(params: WhatsAppCallCommandParams) {
      return sendWhatsAppCallCommand({ ...params, action: "terminate" });
    },
  };
}

const defaultWhatsAppCallingService = createWhatsAppCallingService();

export const acceptWhatsAppCall =
  defaultWhatsAppCallingService.acceptWhatsAppCall;
export const enablePhoneCallingDefaults =
  defaultWhatsAppCallingService.enablePhoneCallingDefaults;
export const getPhoneCallingSettings =
  defaultWhatsAppCallingService.getPhoneCallingSettings;
export const preAcceptWhatsAppCall =
  defaultWhatsAppCallingService.preAcceptWhatsAppCall;
export const rejectWhatsAppCall =
  defaultWhatsAppCallingService.rejectWhatsAppCall;
export const terminateWhatsAppCall =
  defaultWhatsAppCallingService.terminateWhatsAppCall;
