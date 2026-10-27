import "server-only";

import {
  parsePublicHttpsOrigin,
  readConfiguredEnvValue,
} from "@/lib/config/app-url";

export type MetaServerAppConfigErrorCode =
  | "missing_meta_app_id"
  | "missing_meta_app_secret"
  | "missing_whatsapp_flow_endpoint_origin"
  | "invalid_whatsapp_flow_endpoint_origin"
  | "invalid_whatsapp_flow_endpoint_id";

const ERROR_MESSAGES: Record<MetaServerAppConfigErrorCode, string> = {
  missing_meta_app_id: "Meta server app ID is not configured",
  missing_meta_app_secret: "Meta server app secret is not configured",
  missing_whatsapp_flow_endpoint_origin:
    "WhatsApp Flow endpoint origin is not configured",
  invalid_whatsapp_flow_endpoint_origin:
    "WhatsApp Flow endpoint origin must be a public HTTPS URL",
  invalid_whatsapp_flow_endpoint_id: "WhatsApp Flow endpoint ID is invalid",
};

export class MetaServerAppConfigError extends Error {
  constructor(readonly code: MetaServerAppConfigErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "MetaServerAppConfigError";
  }
}

export type MetaServerAppConfig = {
  appId: string;
  appSecret: string;
};

export function getMetaServerAppConfig(): MetaServerAppConfig {
  const appId =
    readConfiguredEnvValue(process.env.META_APP_ID) ||
    readConfiguredEnvValue(process.env.NEXT_PUBLIC_META_APP_ID);
  if (!appId) {
    throw new MetaServerAppConfigError("missing_meta_app_id");
  }

  const appSecret = readConfiguredEnvValue(process.env.META_APP_SECRET);
  if (!appSecret) {
    throw new MetaServerAppConfigError("missing_meta_app_secret");
  }

  return { appId, appSecret };
}

export function buildMetaAppAccessToken(config: MetaServerAppConfig): string {
  return `${config.appId}|${config.appSecret}`;
}

/**
 * Reads the configured Meta app when it is available without turning an
 * optional diagnostics path into a configuration error. Invalid unexpected
 * failures are still propagated; only the typed missing-config errors are
 * treated as an absent optional configuration.
 */
export function tryGetMetaServerAppConfig(): MetaServerAppConfig | null {
  try {
    return getMetaServerAppConfig();
  } catch (error) {
    if (error instanceof MetaServerAppConfigError) return null;
    throw error;
  }
}

function getWhatsAppFlowEndpointOrigin(): string {
  const configuredOrigin = readConfiguredEnvValue(
    process.env.NEXT_PUBLIC_APP_URL
  );
  if (!configuredOrigin) {
    throw new MetaServerAppConfigError("missing_whatsapp_flow_endpoint_origin");
  }

  const origin = parsePublicHttpsOrigin(configuredOrigin);
  if (!origin) {
    throw new MetaServerAppConfigError("invalid_whatsapp_flow_endpoint_origin");
  }

  return origin;
}

export function resolveWhatsAppFlowEndpointUri(endpointId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(endpointId)) {
    throw new MetaServerAppConfigError("invalid_whatsapp_flow_endpoint_id");
  }

  return `${getWhatsAppFlowEndpointOrigin()}/api/webhooks/whatsapp/flow-endpoint/${endpointId}`;
}
