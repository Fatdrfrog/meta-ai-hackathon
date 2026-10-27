const TERMINAL_REPLY_END_RE = /[.!?…"»"'”’)\]\p{Sc}%]$/u;
const INCOMPLETE_TRAILING_CHAR_RE = /[,:;(\-\/«"'“‘]$/u;
const LAST_TOKEN_RE = /([\p{L}\p{N}-]+)$/u;
const WORD_LIKE_TOKEN_RE = /[\p{L}\p{N}]+/gu;
/** Emoji, symbols and markdown marks that close a chat message on their own. */
const TRAILING_DECORATION_RE =
  /[\s\p{Extended_Pictographic}\p{So}\p{Sk}‍️*_~`]+$/u;
const INTERRUPTED_FINISH_REASONS = new Set([
  "length",
  "max_tokens",
  "max_output_tokens",
  "safety",
  "recitation",
  "other",
  "stop_sequence",
]);
/** The model ended the reply itself (Claude end_turn, Gemini/OpenAI stop). */
const NATURAL_FINISH_REASONS = new Set(["end_turn", "stop"]);
/** Words a reply cannot end on: a natural stop after one is still a cut. */
const DANGLING_LAST_WORDS = new Set([
  // ru
  "и",
  "или",
  "а",
  "но",
  "что",
  "чтобы",
  "в",
  "во",
  "на",
  "с",
  "со",
  "к",
  "ко",
  "по",
  "для",
  "от",
  "до",
  "из",
  "за",
  "о",
  "об",
  "у",
  "не",
  // kz
  "және",
  "мен",
  "немесе",
  "бірақ",
  // en
  "and",
  "or",
  "but",
  "to",
  "the",
  "a",
  "an",
  "of",
  "for",
  "with",
  "in",
  "on",
  "at",
  "by",
  "from",
  "that",
]);

function countWordLikeTokens(text: string): number {
  const matches = text.match(WORD_LIKE_TOKEN_RE);
  return matches ? matches.length : 0;
}

function normalizeFinishReason(reason?: string | null): string {
  return String(reason || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

/**
 * A reply that ends on an emoji, a price, a time or without a full stop is a
 * normal chat message. When the provider says the model stopped on its own,
 * only a cut-off ending counts as incomplete; the shape heuristics are for
 * replies whose finish reason is unknown.
 */
export function isLikelyIncompleteAssistantReply(
  text: string,
  finishReason?: string | null
): boolean {
  const raw = String(text || "").trim();
  const trimmed = raw.replace(TRAILING_DECORATION_RE, "");
  if (!trimmed) {
    return false;
  }

  if (TERMINAL_REPLY_END_RE.test(trimmed)) {
    return false;
  }

  if (INCOMPLETE_TRAILING_CHAR_RE.test(trimmed)) {
    return true;
  }

  // A deliberate stop or a closing emoji ends a chat message like a full stop.
  const endsOnEmoji = /\p{Extended_Pictographic}/u.test(
    raw.slice(trimmed.length)
  );
  if (
    endsOnEmoji ||
    NATURAL_FINISH_REASONS.has(normalizeFinishReason(finishReason))
  ) {
    const lastWord = trimmed.match(LAST_TOKEN_RE)?.[1]?.toLowerCase() || "";
    return DANGLING_LAST_WORDS.has(lastWord);
  }

  const tokenCount = countWordLikeTokens(trimmed);
  if (tokenCount < 3) {
    return false;
  }

  const lastLine = trimmed.split(/\n+/).pop()?.trim() || trimmed;
  if (/\b\d{1,3}$/.test(lastLine)) {
    return true;
  }

  const lastToken = lastLine.match(LAST_TOKEN_RE)?.[1] || "";
  if (!lastToken) {
    return true;
  }

  if (lastToken.length <= 2) {
    return true;
  }

  const hasStructuredContext =
    /\n/.test(trimmed) || /\d+\.\s/.test(trimmed) || /[.!?]/.test(trimmed);
  if (!hasStructuredContext && trimmed.length < 80) {
    return false;
  }

  return true;
}

export function isInterruptedFinishReason(reason?: string | null): boolean {
  const normalized = normalizeFinishReason(reason);
  if (!normalized) {
    return false;
  }
  return INTERRUPTED_FINISH_REASONS.has(normalized);
}

export function shouldPreferRetriedAssistantReply(
  originalText: string,
  candidateText: string,
  finishReasons?: {
    original?: string | null;
    candidate?: string | null;
  }
): boolean {
  const original = String(originalText || "").trim();
  const candidate = String(candidateText || "").trim();

  if (!candidate) {
    return false;
  }

  const originalIncomplete = isLikelyIncompleteAssistantReply(
    original,
    finishReasons?.original
  );
  const candidateIncomplete = isLikelyIncompleteAssistantReply(
    candidate,
    finishReasons?.candidate
  );

  if (candidateIncomplete) {
    return false;
  }

  if (originalIncomplete && !candidateIncomplete) {
    return true;
  }

  if (originalIncomplete && candidate.length > original.length) {
    return true;
  }

  if (!originalIncomplete && candidate.length >= original.length + 24) {
    return true;
  }

  return (
    candidate.length > original.length && TERMINAL_REPLY_END_RE.test(candidate)
  );
}
