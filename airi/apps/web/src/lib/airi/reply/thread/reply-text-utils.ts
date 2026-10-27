/**
 * Non-semantic text helpers for deduplication and token counting.
 * Message *classification* lives in LLM turn understanding, not here.
 */

export function stripAiriPrefix(text: string): string {
  return String(text || "")
    .replace(/^airi:\s*/i, "")
    .trim();
}

/**
 * Channel-normalized reaction stub text (integration format, not semantic classification).
 */
export function isIntegrationReactionStubMessage(text: string): boolean {
  const normalized = stripAiriPrefix(text);
  if (!normalized) return false;
  return (
    /^reacted:\s*.+?\s*\(to message\s+[^\)]+\)\s*$/i.test(normalized) ||
    /^reaction removed\s*\(to message\s+[^\)]+\)\s*$/i.test(normalized)
  );
}

export function normalizeComparableText(text: string): string {
  return stripAiriPrefix(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function countWordLikeTokens(text: string): number {
  return (String(text || "").match(/\p{L}[\p{L}\p{N}'’-]*/gu) || []).filter(
    Boolean
  ).length;
}

/** Thread memory: inbound likely carries a trackable customer need (length / tokens only). */
export function shouldTrackThreadNeedStructural(text: string): boolean {
  const t = stripAiriPrefix(text).trim();
  if (!t) return false;
  const tokens = countWordLikeTokens(t);
  return tokens >= 3 || (tokens >= 2 && t.length >= 20) || t.length >= 22;
}

/** Short quoted/code-like reference without relying on phrase lists. */
export function looksLikeShortEntityReferenceStructural(text: string): boolean {
  const t = stripAiriPrefix(text).trim();
  if (!t) return false;
  const last = t.slice(-1);
  if (last === "?" || last === "？") return false;
  return countWordLikeTokens(t) <= 2 && t.length <= 48;
}

/** Very short inbound that may mean “continue previous topic” (no phrase matching). */
export function mightBeGenericResumeStructural(text: string): boolean {
  const t = normalizeComparableText(text);
  if (!t) return false;
  return t.length <= 28 && countWordLikeTokens(text) <= 2;
}

export function isSubstantiveAgentReplyStructural(text: string): boolean {
  const t = stripAiriPrefix(text).trim();
  if (!t) return false;
  return countWordLikeTokens(t) >= 5 || t.length >= 32;
}

/** Short generic ask — token/length only (used when LLM output is unavailable). */
export function contextDependentGenericQuestionStructural(
  text: string
): boolean {
  const n = normalizeComparableText(text);
  if (!n) return false;
  return countWordLikeTokens(text) <= 3 && n.length <= 34;
}

export function shouldPreferStandaloneAskStructural(
  ask: string,
  followUpAnchor: string
): boolean {
  const normalizedAsk = normalizeComparableText(ask);
  const normalizedAnchor = normalizeComparableText(followUpAnchor);
  if (!normalizedAsk || !normalizedAnchor) return false;
  if (normalizedAsk === normalizedAnchor) return false;
  if (normalizedAsk.includes(normalizedAnchor)) return false;
  if (normalizedAnchor.includes(normalizedAsk)) return false;
  const tokens = countWordLikeTokens(ask);
  if (tokens < 4 && ask.trim().length < 28) return false;
  if (tokens <= 2 && ask.length <= 48) return false;
  if (contextDependentGenericQuestionStructural(ask)) return false;
  return true;
}
