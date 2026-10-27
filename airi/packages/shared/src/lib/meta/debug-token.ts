import { isRecord } from "../value-utils";
import type { WhatsAppGraphClient } from "./api";

export type MetaDebugTokenData = {
  app_id?: string;
  user_id?: string;
  profile_id?: string;
  business_id?: string;
  scopes?: string[];
  type?: string;
  expires_at?: number;
  data_access_expires_at?: number;
  is_valid?: boolean;
  granular_scopes?: Array<{
    scope: string;
    target_ids?: string[];
  }>;
};

type DebugTokenResponse = {
  data?: MetaDebugTokenData;
};

/**
 * Interprets token validity separately from the raw debugger response. The
 * usable lifetime ends at the earliest provider token or data-access deadline.
 * Missing metadata never creates an expiry date; explicit zero expiry also
 * takes precedence over an OAuth duration.
 */
export function evaluateMetaAccessToken(
  data: MetaDebugTokenData,
  options: { appId?: string; expiresIn?: number; nowMs?: number } = {},
) {
  const nowMs = options.nowMs ?? Date.now();
  const positiveTimestamp = (value: number | undefined) =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    !Number.isNaN(new Date(value * 1000).getTime())
      ? value * 1000
      : undefined;
  const tokenExpiry =
    positiveTimestamp(data.expires_at) ??
    (data.expires_at === undefined &&
    typeof options.expiresIn === "number" &&
    Number.isFinite(options.expiresIn) &&
    options.expiresIn > 0
      ? positiveTimestamp(nowMs / 1000 + options.expiresIn)
      : undefined);
  const dataExpiry = positiveTimestamp(data.data_access_expires_at);
  const deadlines = [tokenExpiry, dataExpiry].filter(
    (value): value is number => value !== undefined,
  );
  const expiresAt =
    deadlines.length > 0 ? new Date(Math.min(...deadlines)) : undefined;
  const expired = expiresAt !== undefined && expiresAt.getTime() <= nowMs;
  const appMismatch = Boolean(options.appId && data.app_id !== options.appId);
  const revoked = data.is_valid === false || appMismatch;
  let error: string | undefined;
  if (appMismatch)
    error =
      "Meta access token belongs to a different app or its app could not be verified.";
  else if (expired)
    error =
      "Meta access token or its data access has expired. Reconnect WhatsApp.";
  else if (data.is_valid === false)
    error = "Meta access token is invalid or revoked. Reconnect WhatsApp.";
  else if (data.is_valid !== true)
    error =
      "Meta did not confirm access token validity. Try connecting WhatsApp again.";

  return {
    valid: !error,
    expired,
    revoked,
    expiresAt,
    daysUntilExpiry: expiresAt
      ? Math.ceil((expiresAt.getTime() - nowMs) / (1000 * 60 * 60 * 24))
      : undefined,
    neverExpires: data.expires_at === 0 && dataExpiry === undefined,
    error,
  };
}

export class MetaDebugTokenConfigurationError extends Error {
  constructor() {
    super("A Meta app access token is required to debug an access token");
    this.name = "MetaDebugTokenConfigurationError";
  }
}

/**
 * Calls Meta's generic debug_token endpoint. Server applications resolve
 * their app access token separately; this package only owns the Graph request
 * and response contract so it stays usable by every runtime.
 */
export async function debugMetaAccessToken(
  inputToken: string,
  options: {
    appAccessToken?: string | null;
    allowInputTokenFallback?: boolean;
    client: Pick<WhatsAppGraphClient, "getJson">;
    signal?: AbortSignal;
  },
): Promise<MetaDebugTokenData> {
  const appAccessToken = options.appAccessToken?.trim() || null;
  if (!appAccessToken && !options.allowInputTokenFallback) {
    throw new MetaDebugTokenConfigurationError();
  }

  const debugAccessToken = appAccessToken || inputToken;
  const response = await options.client.getJson<DebugTokenResponse>(
    "debug_token",
    {
      token: debugAccessToken,
      query: {
        input_token: inputToken,
        access_token: debugAccessToken,
      },
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );

  if (!isRecord(response.data)) {
    throw new Error("Meta debug_token response did not include data");
  }

  return response.data;
}
