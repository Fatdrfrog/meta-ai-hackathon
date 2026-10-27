import "server-only";

import { awaitWithCancellation } from "@/lib/ai/cancellation";
import {
  createInferenceDeadline,
  type InferenceDeadline,
} from "@/lib/ai/inference-deadline";
import {
  BoundedJsonResponseError,
  fetchJsonWithinLimits,
} from "@/lib/http/bounded-json-response";
import {
  getGoogleCloudPlatformAccessToken,
  getGoogleCloudProjectId,
} from "@/lib/google/gcp-auth";
import {
  normalizeKBLocale,
  SUPPORTED_LANGUAGE_CODES,
} from "@/lib/airi/language-detector";
import { readTrimmedString } from "@icecore/shared/lib/value-utils";

const TRANSLATION_V3_BASE_URL = "https://translate.googleapis.com/v3";
const MAX_DETECT_CHARS = 5000;
const DETECTION_TIMEOUT_MS = 4_000;
const MAX_DETECT_RESPONSE_BYTES = 16 * 1024;

const SUPPORTED_LANGUAGE_SET = new Set<string>(SUPPORTED_LANGUAGE_CODES);

export type GoogleTextLanguageDetection = {
  language: string;
  confidence: number;
  isReliable: boolean;
};

export type GoogleLanguageDetectionOptions = {
  signal?: AbortSignal;
  /** Total OAuth/request/body budget, capped at the detector's four-second limit. */
  timeoutMs?: number;
};

function normalizeDetectedLanguageCode(value: string): string {
  const normalized = normalizeKBLocale(value);
  if (!normalized) return "en";
  const base = normalized.split("_")[0] || normalized;
  if (SUPPORTED_LANGUAGE_SET.has(base)) {
    return base;
  }
  return base || "en";
}

function getCloudTranslationLocation(): string {
  return (
    readTrimmedString(process.env.GOOGLE_TRANSLATE_LOCATION) ||
    readTrimmedString(process.env.GOOGLE_CLOUD_LOCATION) ||
    "global"
  );
}

function extractGoogleErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as { error?: { message?: unknown } }).error;
  return typeof error?.message === "string" && error.message.trim()
    ? error.message.trim()
    : null;
}

function buildGoogleHttpError(
  response: Response,
  payload: unknown,
  context: string
): Error {
  const message =
    extractGoogleErrorMessage(payload) || `HTTP ${response.status}`;
  return new Error(`${context}: ${message}`);
}

function parseV3DetectResponse(
  payload: unknown
): GoogleTextLanguageDetection | null {
  if (!payload || typeof payload !== "object") return null;
  const language = (payload as { languages?: Array<Record<string, unknown>> })
    .languages?.[0];
  if (!language || typeof language.languageCode !== "string") {
    return null;
  }

  const confidence =
    typeof language.confidence === "number" &&
    Number.isFinite(language.confidence)
      ? language.confidence
      : 0;

  return {
    language: normalizeDetectedLanguageCode(language.languageCode),
    confidence,
    isReliable: false,
  };
}

async function detectTextLanguageWithCloudTranslationV3(
  trimmed: string,
  options: { signal: AbortSignal; deadline: InferenceDeadline }
): Promise<GoogleTextLanguageDetection | null> {
  const projectId = getGoogleCloudProjectId("GOOGLE_CLOUD_PROJECT");
  if (!projectId) {
    throw new Error("Google Cloud project id is not configured");
  }

  const accessToken = await awaitWithCancellation(
    getGoogleCloudPlatformAccessToken(projectId),
    options.signal
  );
  options.signal.throwIfAborted();
  const remainingMs = options.deadline.remainingMs();
  if (!remainingMs) {
    throw new BoundedJsonResponseError("provider_response_timeout", 0);
  }
  const parent = `projects/${encodeURIComponent(
    projectId
  )}/locations/${encodeURIComponent(getCloudTranslationLocation())}`;
  const { response, payload } = await fetchJsonWithinLimits(
    `${TRANSLATION_V3_BASE_URL}/${parent}:detectLanguage`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        content: trimmed.slice(0, MAX_DETECT_CHARS),
        mimeType: "text/plain",
      }),
      signal: options.signal,
    },
    { maxBytes: MAX_DETECT_RESPONSE_BYTES, timeoutMs: remainingMs }
  );
  options.signal.throwIfAborted();

  if (!response.ok) {
    throw buildGoogleHttpError(
      response,
      payload,
      "Cloud Translation v3 detect failed"
    );
  }

  return parseV3DetectResponse(payload);
}

export async function detectTextLanguageWithGoogle(
  text: string,
  options?: GoogleLanguageDetectionOptions
): Promise<GoogleTextLanguageDetection | null> {
  options?.signal?.throwIfAborted();
  const trimmed = String(text || "").trim();
  if (trimmed.length < 2) {
    return null;
  }

  const failures: string[] = [];
  const requestedTimeoutMs = options?.timeoutMs;
  if (
    typeof requestedTimeoutMs === "number" &&
    Number.isFinite(requestedTimeoutMs) &&
    requestedTimeoutMs <= 0
  ) {
    return null;
  }
  const timeoutMs =
    typeof requestedTimeoutMs === "number" &&
    Number.isFinite(requestedTimeoutMs) &&
    requestedTimeoutMs > 0
      ? Math.min(
          DETECTION_TIMEOUT_MS,
          Math.max(1, Math.floor(requestedTimeoutMs))
        )
      : DETECTION_TIMEOUT_MS;
  const deadline = createInferenceDeadline(timeoutMs);
  const controller = new AbortController();
  const signal = options?.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(
    () =>
      controller.abort(
        new BoundedJsonResponseError("provider_response_timeout", timeoutMs)
      ),
    timeoutMs
  );

  try {
    const detected = await detectTextLanguageWithCloudTranslationV3(trimmed, {
      signal,
      deadline,
    });
    if (detected?.language) {
      return detected;
    }
    failures.push("v3 OAuth: response did not include a detected language");
  } catch (error) {
    // Shared auth can finish later; cancellation still belongs to this caller.
    options?.signal?.throwIfAborted();
    failures.push(
      `v3 OAuth: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timer);
  }

  console.warn(
    "[Language Detection] Google Cloud detect failed:",
    failures.join("; ")
  );
  return null;
}
