import "server-only";

import {
  isGenericAcknowledgementText,
  normalizeKBLocale,
} from "@/lib/airi/language-detector";
import {
  detectTextLanguageWithGoogle,
  type GoogleLanguageDetectionOptions,
  type GoogleTextLanguageDetection,
} from "@/lib/google/language-detection";

const MIN_CONFIDENCE = 0.55;
const SHORT_TEXT_CONFIDENCE = 0.8;

function normalizeDetectedLanguage(value: string): string {
  const normalized = normalizeKBLocale(value);
  return normalized || "en";
}

function isConfidentGoogleDetection(
  text: string,
  detection: { confidence: number; isReliable: boolean } | null
): boolean {
  const trimmed = String(text || "").trim();
  if (!trimmed || isGenericAcknowledgementText(trimmed)) {
    return false;
  }
  if (!detection) {
    return false;
  }
  if (detection.isReliable) {
    return true;
  }
  if (detection.confidence < MIN_CONFIDENCE) {
    return false;
  }
  if (trimmed.length < 12 && detection.confidence < SHORT_TEXT_CONFIDENCE) {
    return false;
  }
  return true;
}

function resolveConfidentGoogleLanguage(
  trimmed: string,
  detection: GoogleTextLanguageDetection | null
): string | null {
  if (!detection?.language) {
    return null;
  }
  if (!isConfidentGoogleDetection(trimmed, detection)) {
    return null;
  }
  return normalizeDetectedLanguage(detection.language);
}

async function detectLanguageWithGoogle(
  trimmed: string,
  options?: GoogleLanguageDetectionOptions
): Promise<string | null> {
  const detection = await detectTextLanguageWithGoogle(trimmed, options);
  return resolveConfidentGoogleLanguage(trimmed, detection);
}

export async function detectLanguageModelOnly(
  text: string,
  options?: GoogleLanguageDetectionOptions
): Promise<string | null> {
  options?.signal?.throwIfAborted();
  const trimmed = String(text || "").trim();
  if (trimmed.length < 3) {
    return null;
  }

  return detectLanguageWithGoogle(trimmed, options);
}

/**
 * Google Cloud Translation language detection for persisted metadata and slower paths.
 */
export async function detectLanguage(
  text: string,
  options?: GoogleLanguageDetectionOptions
): Promise<string> {
  options?.signal?.throwIfAborted();
  const trimmed = String(text || "").trim();
  if (trimmed.length < 3) {
    return "en";
  }

  const detection = await detectTextLanguageWithGoogle(trimmed, options);
  const confidentLanguage = resolveConfidentGoogleLanguage(trimmed, detection);
  if (confidentLanguage) {
    return confidentLanguage;
  }

  if (detection?.language) {
    return normalizeDetectedLanguage(detection.language);
  }

  return "en";
}
