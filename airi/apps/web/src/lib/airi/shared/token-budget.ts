/**
 * Token Budget — Centralized prompt-size management
 *
 * Prevents uncapped prompt growth by providing shared budget constants
 * and a lightweight character-based token estimator. Each module that
 * contributes to the final LLM prompt should respect these limits.
 *
 * Design principles:
 * - Use character-based estimation (4 chars ≈ 1 token) to avoid
 *   adding a tokenizer dependency.
 * - All limits are expressed in *characters* for O(1) truncation.
 * - Callers convert to approximate tokens when needed for logging.
 */

// =============================================================================
// BUDGET LIMITS (characters)
// =============================================================================

/** Maximum characters for the agent context prompt block */
export const AGENT_CONTEXT_CHAR_LIMIT = 1200;

/** Maximum characters for reply-time whole-thread context (memory + raw tail) */
export const THREAD_CONTEXT_CHAR_LIMIT = 4000;

/** Maximum characters reserved for the synthetic thread-memory summary block */
export const THREAD_MEMORY_SUMMARY_CHAR_LIMIT = 1600;

/** Minimum number of raw recent messages preserved after compaction */
export const MIN_THREAD_CONTEXT_RECENT_MESSAGES = 8;

/** Maximum characters for KB article block in user content */
export const KB_BLOCK_CHAR_LIMIT = 5000;

/** Maximum characters for scenario instruction block */
export const SCENARIO_INSTRUCTION_CHAR_LIMIT = 1200;

/** Maximum characters for the latest customer message */
export const CUSTOMER_MESSAGE_CHAR_LIMIT = 1000;

/** Maximum characters for the full LLM reply output */
export const MAX_REPLY_CHAR_LIMIT = 2200;

/**
 * Provider-specific maximum input size for reply-generation prompts. Claude
 * takes a 200k context, so its budget only bounds cost: every section keeps
 * its own cap and a full prompt fits without trimming.
 */
export const REPLY_PROMPT_INPUT_CHAR_LIMITS = {
  anthropic: 30000,
  vertex: 12000,
  elevenlabs: 9000,
} as const;

export const REPLY_PROMPT_INPUT_TOKEN_LIMITS = {
  anthropic: 12000,
  vertex: 3200,
  elevenlabs: 2400,
} as const;

/** Reply-type-aware max_tokens defaults for assistant generation. */
export const REPLY_OUTPUT_TOKEN_LIMITS = {
  clarification: 360,
  /**
   * Higher ceiling for the Gemini fallback, whose thinking counts against this
   * cap (avoids MAX_TOKENS with empty visible text). Claude treats it as the
   * visible-text cap and adds its own thinking headroom.
   */
  grounded_answer: 1400,
  grounded_list: 1400,
  grounded_overview: 1700,
} as const;

// =============================================================================
// TOKEN ESTIMATION
// =============================================================================

/**
 * Kazakh letters outside the Russian alphabet. Claude splits words around
 * them, so each costs about a token and a half on its own.
 */
const KAZAKH_SPECIFIC_LETTERS = /[ӘәҒғҚқҢңӨөҰұҮүҺһІі]/gu;

/**
 * Estimate the number of tokens in a text string.
 *
 * This is intentionally lightweight — no external tokenizer required.
 * Per-script rates follow Claude's count_tokens (claude-sonnet-5-5,
 * 2026-10-23): Russian ~2.5 chars/token, Kazakh ~1.7, English ~3.4,
 * digits ~1.5 and punctuation ~1. Undercounting Cyrillic by half let
 * reply prompts overflow and drop the conversation tail.
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  const source = String(text);

  const cjkChars =
    source.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
    )?.length || 0;
  const cyrillicChars = source.match(/\p{Script=Cyrillic}/gu)?.length || 0;
  const kazakhChars = source.match(KAZAKH_SPECIFIC_LETTERS)?.length || 0;
  const latinChars = source.match(/\p{Script=Latin}/gu)?.length || 0;
  const digitChars = source.match(/\p{N}/gu)?.length || 0;
  const whitespaceChars = source.match(/\s/gu)?.length || 0;
  const punctuationChars = source.match(/[^\p{L}\p{N}\s]/gu)?.length || 0;
  const otherChars =
    source.length -
    cjkChars -
    cyrillicChars -
    latinChars -
    digitChars -
    whitespaceChars -
    punctuationChars;

  const estimatedTokens =
    cjkChars / 1.8 +
    (cyrillicChars - kazakhChars) / 2.4 +
    kazakhChars * 1.5 +
    latinChars / 3.3 +
    digitChars / 1.5 +
    punctuationChars / 1.0 +
    otherChars / 3.3 +
    whitespaceChars / 10;

  return Math.ceil(estimatedTokens);
}

export function estimateTokenCountFromCharBudget(maxChars: number): number {
  if (!maxChars || maxChars <= 0) return 0;
  return estimateTokenCount("a".repeat(maxChars));
}

/**
 * Truncate text to fit within a character budget, breaking at the
 * last complete sentence when possible to preserve coherence.
 */
export function truncateToCharBudget(text: string, maxChars: number): string {
  if (!text || text.length <= maxChars) return text;

  const truncated = text.slice(0, maxChars);

  // Try to break at a sentence boundary
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf(". "),
    truncated.lastIndexOf(".\n"),
    truncated.lastIndexOf("! "),
    truncated.lastIndexOf("!\n"),
    truncated.lastIndexOf("? "),
    truncated.lastIndexOf("?\n")
  );

  if (lastSentenceEnd > maxChars * 0.5) {
    return truncated.slice(0, lastSentenceEnd + 1).trim();
  }

  return truncated.trim();
}

/**
 * Fits a transcript rendered one turn per line by dropping its oldest lines,
 * so trimming never loses the latest turns of the conversation.
 */
function keepLatestTranscriptLines(
  text: string,
  fits: (candidate: string) => boolean,
  truncateLine: (line: string) => string
): string {
  if (!text || fits(text)) return text;
  const lines = text.split("\n");
  let kept = "";
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = kept ? `${lines[index]}\n${kept}` : lines[index]!;
    if (!fits(candidate)) {
      return kept ? kept.trim() : truncateLine(lines[index]!);
    }
    kept = candidate;
  }
  return kept.trim();
}

export function truncateTranscriptToCharBudget(
  text: string,
  maxChars: number
): string {
  if (maxChars <= 0) return "";
  return keepLatestTranscriptLines(
    text,
    candidate => candidate.length <= maxChars,
    line => truncateToCharBudget(line, maxChars)
  );
}

export function truncateTranscriptToTokenBudget(
  text: string,
  maxTokens: number
): string {
  if (maxTokens <= 0) return "";
  return keepLatestTranscriptLines(
    text,
    candidate => estimateTokenCount(candidate) <= maxTokens,
    line => truncateToTokenBudget(line, maxTokens)
  );
}

export function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) return "";
  if (estimateTokenCount(text) <= maxTokens) return text;

  const tokenRatio = maxTokens / Math.max(estimateTokenCount(text), 1);
  const targetChars = Math.max(1, Math.floor(text.length * tokenRatio));
  let truncated = truncateToCharBudget(text, targetChars);

  while (truncated && estimateTokenCount(truncated) > maxTokens) {
    const nextChars = Math.max(
      1,
      truncated.length - Math.ceil(truncated.length * 0.08)
    );
    if (nextChars >= truncated.length) {
      break;
    }
    truncated = truncateToCharBudget(truncated, nextChars);
  }

  return truncated;
}
