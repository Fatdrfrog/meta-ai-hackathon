import { stripAiriPrefix } from "@/lib/airi/reply/thread/reply-text-utils";

/** Start-anchored greetings for outbound / lead stripping (multi-language). */
export const GREETING_START_PATTERNS = [
  /^(?:hi|hello|hey)\b/i,
  /^(?:привет|здравствуйте|добрый день)/i,
  /^(?:сәлемет|сәлеметсіз бе)/i,
  /^(?:salom|assalomu alaykum)/i,
];

export function isGreetingMessage(text: string): boolean {
  const normalized = stripAiriPrefix(text);
  return GREETING_START_PATTERNS.some(pattern => pattern.test(normalized));
}

/**
 * Whole-query greeting-only heuristic for retrieval planning (short, no substantive ask).
 * Stricter than {@link isGreetingMessage} (requires full-line match).
 */
export function isLikelyGreetingOnly(query: string): boolean {
  const t = query.trim();
  if (t.length > 48) return false;
  return /^(hi+|hello+|hey+|hiya+|yo+|sup+|good\s+(morning|afternoon|evening)|привет!?|здравствуйте!?|добрый\s+(день|вечер)!?|салам!?|сәлем!?)[\s!?.]*$/iu.test(
    t
  );
}
