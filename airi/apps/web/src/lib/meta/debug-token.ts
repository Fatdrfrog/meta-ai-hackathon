import {
  buildMetaAppAccessToken,
  getMetaServerAppConfig,
  type MetaServerAppConfig,
} from "@/lib/meta/app-config";
import {
  debugMetaAccessToken as requestMetaDebugToken,
  type MetaDebugTokenData,
} from "@icecore/shared/lib/meta/debug-token";
import { getWhatsAppGraphClient } from "@icecore/shared/lib/meta/api";

export type { MetaDebugTokenData } from "@icecore/shared/lib/meta/debug-token";

const graphClient = getWhatsAppGraphClient();

/**
 * Calls Meta's debug_token endpoint with the configured server app token.
 * Optional flows may pass a missing config and explicitly opt into using the
 * input token itself, preserving the provider's fallback behavior.
 */
export async function debugConfiguredMetaAccessToken(
  inputToken: string,
  options: {
    appConfig?: MetaServerAppConfig | null;
    allowInputTokenFallback?: boolean;
    signal?: AbortSignal;
  } = {}
): Promise<MetaDebugTokenData> {
  const appConfig =
    options.appConfig === undefined
      ? getMetaServerAppConfig()
      : options.appConfig;

  if (!appConfig && !options.allowInputTokenFallback) {
    // Re-run the canonical accessor so callers receive the precise typed
    // missing-id versus missing-secret configuration error.
    getMetaServerAppConfig();
  }

  return requestMetaDebugToken(inputToken, {
    appAccessToken: appConfig
      ? buildMetaAppAccessToken(appConfig)
      : null,
    allowInputTokenFallback: options.allowInputTokenFallback,
    client: graphClient,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
