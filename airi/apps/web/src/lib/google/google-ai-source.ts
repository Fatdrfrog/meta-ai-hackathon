import "server-only";

import { decryptString, type EncryptedString } from "@/lib/crypto";
import {
  BoundedJsonResponseError,
  fetchJsonWithinLimits,
} from "@/lib/http/bounded-json-response";
import type { createClient } from "@/lib/supabase/server";
import { isRecord } from "@icecore/shared/lib/value-utils";

export const GOOGLE_AI_SOURCE_TYPE = "google_ai" as const;

export type GoogleAiConnectionErrorCode =
  | "INVALID_API_KEY"
  | "GOOGLE_AI_ACCESS_DENIED"
  | "GOOGLE_AI_RATE_LIMITED"
  | "GOOGLE_AI_UNAVAILABLE"
  | "GOOGLE_AI_INVALID_RESPONSE";

const ERROR_MESSAGES: Record<GoogleAiConnectionErrorCode, string> = {
  INVALID_API_KEY: "Enter a valid Google AI Studio API key.",
  GOOGLE_AI_ACCESS_DENIED:
    "Google AI access is unavailable. Check the connection, key permissions and project billing.",
  GOOGLE_AI_RATE_LIMITED:
    "Google AI is temporarily rate limited. Try again later.",
  GOOGLE_AI_UNAVAILABLE:
    "Google AI could not be reached or the connection could not be read. Try again later.",
  GOOGLE_AI_INVALID_RESPONSE:
    "Google AI returned an invalid model catalog. Try again later.",
};

const MODEL_CATALOG_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";
const MODEL_PAGE_SIZE = 1000;
const MAX_MODEL_PAGES = 10;
const MAX_RESPONSE_BYTES = 256 * 1024;
const CONNECTION_TIMEOUT_MS = 10_000;
const MAX_API_KEY_LENGTH = 4096;

export class GoogleAiConnectionError extends Error {
  constructor(readonly code: GoogleAiConnectionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "GoogleAiConnectionError";
  }
}

export function normalizeGoogleAiApiKey(value: unknown): string {
  const key = typeof value === "string" ? value.trim() : "";
  if (
    !key ||
    key.length > MAX_API_KEY_LENGTH ||
    /[\s\x00-\x1f\x7f-\x9f]/.test(key)
  ) {
    throw new GoogleAiConnectionError("INVALID_API_KEY");
  }
  return key;
}

function catalogError(): GoogleAiConnectionError {
  return new GoogleAiConnectionError("GOOGLE_AI_INVALID_RESPONSE");
}

function providerError(
  status: number,
  payload: unknown
): GoogleAiConnectionError {
  const error =
    isRecord(payload) && isRecord(payload.error) ? payload.error : {};
  if (
    status === 403 ||
    (status === 400 && error.status === "FAILED_PRECONDITION")
  ) {
    return new GoogleAiConnectionError("GOOGLE_AI_ACCESS_DENIED");
  }
  if (status === 400 || status === 401) {
    return new GoogleAiConnectionError("INVALID_API_KEY");
  }
  return new GoogleAiConnectionError(
    status === 429 ? "GOOGLE_AI_RATE_LIMITED" : "GOOGLE_AI_UNAVAILABLE"
  );
}

/** Checks catalog access only; generation billing and model capabilities are separate. */
export async function validateGoogleAiApiKey(
  apiKey: string
): Promise<{ modelCount: number }> {
  const key = normalizeGoogleAiApiKey(apiKey);
  const deadline = Date.now() + CONNECTION_TIMEOUT_MS;
  const modelNames = new Set<string>();
  const pageTokens = new Set<string>();
  let pageToken: string | undefined;

  try {
    for (let page = 0; page < MAX_MODEL_PAGES; page++) {
      const timeoutMs = deadline - Date.now();
      if (timeoutMs <= 0)
        throw new GoogleAiConnectionError("GOOGLE_AI_UNAVAILABLE");
      const url = new URL(MODEL_CATALOG_URL);
      url.searchParams.set("pageSize", String(MODEL_PAGE_SIZE));
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const { response, payload } = await fetchJsonWithinLimits(
        url,
        {
          method: "GET",
          headers: { "x-goog-api-key": key },
          redirect: "error",
          cache: "no-store",
        },
        { maxBytes: MAX_RESPONSE_BYTES, timeoutMs }
      );
      if (!response.ok) throw providerError(response.status, payload);
      if (!isRecord(payload) || "error" in payload) throw catalogError();
      const models = payload.models === undefined ? [] : payload.models;
      if (!Array.isArray(models) || models.length > MODEL_PAGE_SIZE)
        throw catalogError();
      for (const model of models) {
        if (
          !isRecord(model) ||
          typeof model.name !== "string" ||
          model.name.length > 256 ||
          !/^models\/[^\s/]+$/.test(model.name) ||
          modelNames.has(model.name) ||
          (model.supportedGenerationMethods !== undefined &&
            (!Array.isArray(model.supportedGenerationMethods) ||
              !model.supportedGenerationMethods.every(
                method => typeof method === "string" && method.length > 0
              )))
        )
          throw catalogError();
        modelNames.add(model.name);
      }
      const nextPageToken = payload.nextPageToken;
      if (nextPageToken === undefined || nextPageToken === "") {
        return { modelCount: modelNames.size };
      }
      if (
        typeof nextPageToken !== "string" ||
        nextPageToken.length > 8192 ||
        pageTokens.has(nextPageToken)
      ) {
        throw catalogError();
      }
      pageTokens.add(nextPageToken);
      pageToken = nextPageToken;
    }
    throw catalogError();
  } catch (error) {
    if (error instanceof GoogleAiConnectionError) throw error;
    if (
      error instanceof BoundedJsonResponseError &&
      error.code === "provider_response_too_large"
    ) {
      throw catalogError();
    }
    // Never retain provider messages, request headers, URLs, or error causes.
    throw new GoogleAiConnectionError("GOOGLE_AI_UNAVAILABLE");
  }
}

function isEncryptedKey(value: unknown): value is EncryptedString {
  if (!isRecord(value)) return false;
  const { iv, tag, ciphertext } = value;
  return (
    typeof iv === "string" &&
    /^[A-Za-z0-9+/]{16}$/.test(iv) &&
    typeof tag === "string" &&
    /^[A-Za-z0-9+/]{22}==$/.test(tag) &&
    typeof ciphertext === "string" &&
    ciphertext.length > 0 &&
    ciphertext.length <= Math.ceil(MAX_API_KEY_LENGTH / 3) * 4 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      ciphertext
    )
  );
}

function publicDate(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 100 ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value)
  )
    return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function toPublicGoogleAiCredentials(
  credentials: unknown
): Record<string, unknown> {
  const raw = isRecord(credentials) ? credentials : {};
  return {
    has_api_key: isEncryptedKey(raw.api_key),
    key_label:
      typeof raw.key_label === "string" &&
      /^\*{4}(?:[A-Za-z0-9_-]{4})?$/.test(raw.key_label)
        ? raw.key_label
        : null,
    connected_at: publicDate(raw.connected_at),
    validated_at: publicDate(raw.validated_at),
    model_count:
      typeof raw.model_count === "number" &&
      Number.isSafeInteger(raw.model_count) &&
      raw.model_count >= 0
        ? raw.model_count
        : null,
  };
}

export async function resolveGoogleAiCredentialsForWorkspace(params: {
  supabase: Pick<Awaited<ReturnType<typeof createClient>>, "from">;
  workspaceId: string;
  sourceId: string;
}): Promise<{ sourceId: string; apiKey: string }> {
  if (!params.workspaceId?.trim() || !params.sourceId?.trim()) {
    throw new GoogleAiConnectionError("GOOGLE_AI_ACCESS_DENIED");
  }
  try {
    const { data, error } = await params.supabase
      .from("sources")
      .select("id, credentials")
      .eq("workspace_id", params.workspaceId)
      .eq("type", GOOGLE_AI_SOURCE_TYPE)
      .eq("id", params.sourceId)
      .maybeSingle();
    if (error) throw new GoogleAiConnectionError("GOOGLE_AI_UNAVAILABLE");
    if (!data || data.id !== params.sourceId) {
      throw new GoogleAiConnectionError("GOOGLE_AI_ACCESS_DENIED");
    }
    const credentials = isRecord(data.credentials) ? data.credentials : {};
    if (!isEncryptedKey(credentials.api_key)) {
      throw new GoogleAiConnectionError("INVALID_API_KEY");
    }
    return {
      sourceId: data.id,
      apiKey: normalizeGoogleAiApiKey(decryptString(credentials.api_key)),
    };
  } catch (error) {
    if (error instanceof GoogleAiConnectionError) throw error;
    throw new GoogleAiConnectionError("GOOGLE_AI_UNAVAILABLE");
  }
}
