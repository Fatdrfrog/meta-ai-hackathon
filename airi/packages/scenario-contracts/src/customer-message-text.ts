/**
 * Stored inbound text that stands in for media or a deleted message rather
 * than words the customer wrote. Shared by the web message helpers and
 * scenario prompt-input extraction so both read a message the same way.
 */
export const MEDIA_PLACEHOLDER_TEXT_PATTERN =
  /^\[(?:(?:round\s+)?(?:audio|voice|video|image|document|sticker|file|animation)(?:\s+(?:message|attachment))?|attachment)\]$/i;
export const DELETED_MESSAGE_PLACEHOLDER_TEXT_PATTERN =
  /^\[message deleted\]$/i;

function testTrimmed(value: unknown, pattern: RegExp): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  return Boolean(normalized) && pattern.test(normalized);
}

export function isMediaPlaceholderText(value: unknown): value is string {
  return testTrimmed(value, MEDIA_PLACEHOLDER_TEXT_PATTERN);
}

export function isDeletedMessagePlaceholderText(
  value: unknown,
): value is string {
  return testTrimmed(value, DELETED_MESSAGE_PLACEHOLDER_TEXT_PATTERN);
}

export function isNonLinguisticPlaceholderText(
  value: unknown,
): value is string {
  return (
    isMediaPlaceholderText(value) || isDeletedMessagePlaceholderText(value)
  );
}

export function isMeaningfulMessageText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  return Boolean(normalized) && !isNonLinguisticPlaceholderText(normalized);
}

/** The customer's words in one stored field: trimmed, or "" for a placeholder. */
export function readMeaningfulMessageText(value: unknown): string {
  return isMeaningfulMessageText(value) ? value.trim() : "";
}

/** Stored fields of an inbound message that can hold the customer's words. */
export type CustomerMessageTextParts = {
  text?: string | null;
  audioAnalysis?: string | null;
  videoAnalysis?: string | null;
};

export type CustomerMessageTextSource =
  | "text"
  | "audio_analysis"
  | "video_analysis";

/**
 * What the customer said, one entry per non-empty part, in reading order:
 * text or caption, then stored audio analysis, then video analysis.
 * Readers keep different parts because they need different things:
 * - Prompt-input extraction, and the answer a collector passes on, read every
 *   part, since a detail may be in the caption, the voice note or the video.
 * - The reply pipeline shows a single part, analysis only when the media
 *   type allows it, labelled as a summary, since it builds one visible message.
 * - Generative text input takes typed text only, or a collector's answer,
 *   since a caption or voice note was not written as a prompt.
 */
export function listCustomerMessageTextParts(
  parts: CustomerMessageTextParts,
): Array<{ source: CustomerMessageTextSource; text: string }> {
  const ordered: Array<{ source: CustomerMessageTextSource; text: string }> = [
    { source: "text", text: readMeaningfulMessageText(parts.text) },
    {
      source: "audio_analysis",
      text: readMeaningfulMessageText(parts.audioAnalysis),
    },
    {
      source: "video_analysis",
      text: readMeaningfulMessageText(parts.videoAnalysis),
    },
  ];
  return ordered.filter((part) => part.text);
}
