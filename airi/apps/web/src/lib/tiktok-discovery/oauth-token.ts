import "server-only";

import {
  BoundedJsonResponseError,
  fetchJsonWithinLimits,
} from "@/lib/http/bounded-json-response";
import { isRecord } from "@icecore/shared/lib/value-utils";

const TIKTOK_TOKEN_URL =
  "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/";
const TOKEN_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const TOKEN_RESPONSE_TIMEOUT_MS = 8_000;
const MAX_ADVERTISER_IDS = 500;
const MAX_SCOPES = 100;
const MAX_PROVIDER_IDENTIFIER_LENGTH = 128;
const ADVERTISER_ID_PATTERN = /^[0-9]{1,128}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type TikTokOAuthTokenErrorCode =
  | "provider_rejected"
  | "invalid_response"
  | "timeout"
  | "response_too_large"
  | "provider_unavailable";

export class TikTokOAuthTokenError extends Error {
  readonly name = "TikTokOAuthTokenError";

  constructor(
    readonly code: TikTokOAuthTokenErrorCode,
    readonly requestId: string | null = null
  ) {
    super(code);
  }
}

type TikTokOAuthToken = {
  accessToken: string;
  advertiserIds: string[];
  grantedScopes: string[];
  requestId: string | null;
};

function safeRequestId(
  payload: unknown,
  sensitiveValues: readonly string[]
): string | null {
  if (!isRecord(payload) || typeof payload.request_id !== "string") {
    return null;
  }
  const requestId = payload.request_id;
  if (!REQUEST_ID_PATTERN.test(requestId)) return null;
  if (
    sensitiveValues.some(value => value.length > 0 && requestId.includes(value))
  ) {
    return null;
  }
  return requestId;
}

function normalizeAdvertiserIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_ADVERTISER_IDS) return null;
  if (
    !value.every(
      advertiserId =>
        typeof advertiserId === "string" &&
        ADVERTISER_ID_PATTERN.test(advertiserId)
    )
  ) {
    return null;
  }
  return [...new Set(value)];
}

function normalizeScope(scope: unknown): string | null {
  if (typeof scope === "string") {
    const normalized = scope.trim();
    return normalized && normalized.length <= MAX_PROVIDER_IDENTIFIER_LENGTH
      ? normalized
      : null;
  }
  if (typeof scope === "number" && Number.isSafeInteger(scope) && scope >= 0) {
    const normalized = String(scope);
    return normalized.length <= MAX_PROVIDER_IDENTIFIER_LENGTH
      ? normalized
      : null;
  }
  return null;
}

function normalizeScopes(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_SCOPES) return null;
  const normalized: string[] = [];
  for (const scope of value) {
    const item = normalizeScope(scope);
    if (item === null) return null;
    normalized.push(item);
  }
  return [...new Set(normalized)];
}

function parseTokenPayload(
  payload: unknown,
  response: Response,
  sensitiveValues: readonly string[]
): TikTokOAuthToken {
  const requestId = safeRequestId(payload, sensitiveValues);
  if (
    isRecord(payload) &&
    typeof payload.code === "number" &&
    Number.isSafeInteger(payload.code) &&
    payload.code !== 0
  ) {
    throw new TikTokOAuthTokenError("provider_rejected", requestId);
  }

  if (!response.ok) {
    throw new TikTokOAuthTokenError("provider_unavailable", requestId);
  }

  if (!isRecord(payload) || payload.code !== 0 || !isRecord(payload.data)) {
    throw new TikTokOAuthTokenError("invalid_response", requestId);
  }

  const accessToken = payload.data.access_token;
  const advertiserIds = normalizeAdvertiserIds(payload.data.advertiser_ids);
  const grantedScopes = normalizeScopes(payload.data.scope);
  if (
    typeof accessToken !== "string" ||
    !accessToken.trim() ||
    advertiserIds === null ||
    grantedScopes === null
  ) {
    throw new TikTokOAuthTokenError("invalid_response", requestId);
  }

  return { accessToken, advertiserIds, grantedScopes, requestId };
}

function normalizeFetchFailure(error: unknown): TikTokOAuthTokenError {
  if (error instanceof BoundedJsonResponseError) {
    return new TikTokOAuthTokenError(
      error.code === "provider_response_timeout"
        ? "timeout"
        : "response_too_large"
    );
  }
  return new TikTokOAuthTokenError("provider_unavailable");
}

export async function exchangeTikTokOAuthCode(input: {
  appId: string;
  appSecret: string;
  authCode: string;
}): Promise<TikTokOAuthToken> {
  let result: { response: Response; payload: unknown };
  try {
    result = await fetchJsonWithinLimits(
      TIKTOK_TOKEN_URL,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          app_id: input.appId,
          secret: input.appSecret,
          auth_code: input.authCode,
        }),
        redirect: "error",
      },
      {
        maxBytes: TOKEN_RESPONSE_MAX_BYTES,
        timeoutMs: TOKEN_RESPONSE_TIMEOUT_MS,
      }
    );
  } catch (error) {
    throw normalizeFetchFailure(error);
  }

  return parseTokenPayload(result.payload, result.response, [
    input.authCode,
    input.appSecret,
  ]);
}
