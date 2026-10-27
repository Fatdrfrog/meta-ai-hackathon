import {
  getLanguageDisplayName,
  isGenericAcknowledgementText,
  normalizeLanguageCode,
  normalizeProductLanguageBase,
  type WorkspaceLanguageBias,
} from "@/lib/airi/language-detector";
import { isMeaningfulMessageText } from "@/lib/media/message-media-utils";

export {
  getLanguageDisplayName,
  normalizeLanguageCode,
  normalizeProductLanguageBase,
};
export type { WorkspaceLanguageBias };

const FLOW_RESPONSE_WRAPPER_RE = /^\[flow response:[^\]]+\]/iu;
const TEMPLATE_WRAPPER_RE = /^\[template:[^\]]+\]$/iu;

function stripLanguageDetectionNoise(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (FLOW_RESPONSE_WRAPPER_RE.test(trimmed)) return "";
  if (TEMPLATE_WRAPPER_RE.test(trimmed)) return "";
  return trimmed;
}

export function isSameLanguage(first: string, second: string): boolean {
  const canonicalFirst = normalizeProductLanguageBase(first);
  const canonicalSecond = normalizeProductLanguageBase(second);
  return Boolean(
    canonicalFirst && canonicalSecond && canonicalFirst === canonicalSecond
  );
}

/** Product-canonical code (`kk` → `kz`, `en-US` → `en`). Empty when unknown. */
export function canonicalLanguageCode(value: unknown): string {
  return normalizeProductLanguageBase(value);
}

export function normalizeLanguageCandidateText(value: unknown): string {
  const normalized =
    typeof value === "string" ? stripLanguageDetectionNoise(value) : "";
  if (!normalized) return "";
  if (!isMeaningfulMessageText(normalized)) return "";
  if (isGenericAcknowledgementText(normalized)) return "";
  return normalized;
}

export function isLanguageBearingMessageText(value: unknown): value is string {
  return Boolean(normalizeLanguageCandidateText(value));
}
