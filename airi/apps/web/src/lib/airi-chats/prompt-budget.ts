import { normalizePromptComparableText } from "@/lib/airi/reply/generation/prompt-envelope-sections";
import {
  estimateTokenCount,
  truncateToCharBudget,
  truncateToTokenBudget,
} from "@/lib/airi/shared/token-budget";

export const AIRI_CHAT_INPUT_CHAR_LIMIT = 32000;
export const AIRI_CHAT_INPUT_TOKEN_LIMIT = 8000;
/** The latest thread messages are kept whole whenever the budget allows. */
export const AIRI_CHAT_RECENT_HISTORY_MESSAGES = 4;
/** An older message trimmed below this is dropped instead of kept as a stub. */
const MIN_TRUNCATED_HISTORY_CHARS = 160;
const HISTORY_ELISION = " [...] ";
const EMPTY_HISTORY = "No previous messages in this Airi chat.";

type ContextSection = { label: string; content: string | string[] };

/** A character and token allowance; both limits apply at once. */
type Budget = { chars: number; tokens: number };

/** Share of the available budget (0..1) that a text needs to fit whole. */
function costOf(text: string, available: Budget): number {
  if (!text) return 0;
  const charCost = available.chars > 0 ? text.length / available.chars : 1;
  const tokenCost =
    available.tokens > 0 ? estimateTokenCount(text) / available.tokens : 1;
  return Math.max(charCost, tokenCost);
}

function budgetFor(share: number, available: Budget): Budget {
  return {
    chars: Math.max(0, Math.floor(share * available.chars)),
    tokens: Math.max(0, Math.floor(share * available.tokens)),
  };
}

/**
 * Water-filling: each item gets what it needs when that fits under the common
 * level, and budget a small item does not use is shared by the larger ones.
 */
function allocateByNeed(needs: number[], total: number): number[] {
  const shares = needs.map(() => 0);
  let remaining = Math.max(0, total);
  const order = needs
    .map((need, index) => ({ need, index }))
    .sort((left, right) => left.need - right.need);
  order.forEach(({ need, index }, position) => {
    const level = remaining / (order.length - position);
    shares[index] = Math.min(need, level);
    remaining -= shares[index];
  });
  return shares;
}

function truncateHead(text: string, budget: Budget): string {
  return truncateToTokenBudget(
    truncateToCharBudget(text, budget.chars),
    budget.tokens
  );
}

/** Never split a surrogate pair when cutting at a UTF-16 index. */
function safeSliceEnd(text: string, end: number): number {
  const code = text.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

function safeSliceStart(text: string, start: number): number {
  const code = text.charCodeAt(start);
  return code >= 0xdc00 && code <= 0xdfff ? start + 1 : start;
}

/** Keep the opening (role and topic) and the ending (conclusion) of a message. */
function truncateMiddle(text: string, budget: Budget): string {
  if (text.length <= budget.chars && estimateTokenCount(text) <= budget.tokens)
    return text;
  const tokenRatio = budget.tokens / Math.max(estimateTokenCount(text), 1);
  let keep =
    Math.min(budget.chars, Math.floor(text.length * tokenRatio)) -
    HISTORY_ELISION.length;
  while (keep > 0) {
    const headLength = Math.ceil(keep * 0.6);
    const tailLength = keep - headLength;
    const head = text.slice(0, safeSliceEnd(text, headLength)).trimEnd();
    const tail = text
      .slice(safeSliceStart(text, text.length - tailLength))
      .trimStart();
    const candidate = `${head}${HISTORY_ELISION}${tail}`;
    if (
      candidate.length <= budget.chars &&
      estimateTokenCount(candidate) <= budget.tokens
    ) {
      return candidate;
    }
    keep = Math.floor(keep * 0.92) - 1;
  }
  return "";
}

function uniqueSegments(content: string | string[]): string[] {
  const segments = Array.isArray(content) ? content : [content];
  const seen = new Set<string>();
  return segments.filter(segment => {
    const comparable = normalizePromptComparableText(segment);
    if (!comparable || seen.has(comparable)) return false;
    seen.add(comparable);
    return true;
  });
}

/** Every selected source keeps its heading; unused share flows to larger ones. */
function boundSection(
  segments: string[],
  share: number,
  available: Budget
): string {
  if (segments.length === 0) return "";
  const separator = "\n\n";
  const separatorsCost = costOf(
    separator.repeat(segments.length - 1),
    available
  );
  const shares = allocateByNeed(
    segments.map(segment => costOf(segment, available)),
    Math.max(0, share - separatorsCost)
  );
  return segments
    .map((segment, index) =>
      truncateHead(segment, budgetFor(shares[index], available))
    )
    .filter(Boolean)
    .join(separator);
}

function historyNeeds(messages: string[], available: Budget): number[] {
  return messages.map(message => costOf(`${message}\n`, available));
}

function omissionNote(count: number): string {
  return `[${count} earlier messages omitted]`;
}

/**
 * Newest messages first: the last few stay whole (sharing the section when
 * even they do not fit), then older ones fill what is left. An older message
 * that only partly fits keeps its opening and ending; anything older than
 * that is replaced by one omission note.
 */
function boundHistory(
  messages: string[],
  share: number,
  available: Budget
): string {
  if (messages.length === 0) return "";
  const separator = "\n";
  const separatorCost = costOf(separator, available);
  const needs = historyNeeds(messages, available);
  const totalNeed = needs.reduce((sum, need) => sum + need, 0);
  if (totalNeed <= share) return messages.join(separator);

  const recentCount = Math.min(
    AIRI_CHAT_RECENT_HISTORY_MESSAGES,
    messages.length
  );
  const recentStart = messages.length - recentCount;
  const omissionCost =
    recentStart > 0
      ? costOf(`${omissionNote(recentStart)}${separator}`, available)
      : 0;
  let remaining = Math.max(0, share - omissionCost);
  const kept = new Map<number, string>();

  const recentNeeds = needs.slice(recentStart);
  const recentNeed = recentNeeds.reduce((sum, need) => sum + need, 0);
  const recentShares =
    recentNeed <= remaining
      ? recentNeeds
      : allocateByNeed(recentNeeds, remaining);
  recentShares.forEach((recentShare, offset) => {
    const index = recentStart + offset;
    const text =
      recentShare >= needs[index]
        ? messages[index]
        : truncateMiddle(
            messages[index],
            budgetFor(Math.max(0, recentShare - separatorCost), available)
          );
    if (text) kept.set(index, text);
    remaining -= recentShare;
  });

  let oldestKept = recentStart;
  for (let index = recentStart - 1; index >= 0 && remaining > 0; index -= 1) {
    if (needs[index] <= remaining) {
      kept.set(index, messages[index]);
      remaining -= needs[index];
      oldestKept = index;
      continue;
    }
    const partial = budgetFor(
      Math.max(0, remaining - separatorCost),
      available
    );
    if (partial.chars >= MIN_TRUNCATED_HISTORY_CHARS) {
      const text = truncateMiddle(messages[index], partial);
      if (text) {
        kept.set(index, text);
        oldestKept = index;
      }
    }
    break;
  }

  const lines = Array.from(kept.entries())
    .sort(([left], [right]) => left - right)
    .map(([, text]) => text);
  if (oldestKept > 0) lines.unshift(omissionNote(oldestKept));
  return lines.join(separator);
}

function splitHistory(history: string, userMessage: string): string[] {
  const messages = history
    .split(/\n(?=(?:User|Airi|System): )/u)
    .filter(message => message.trim());
  // The thread read includes the message being answered. It is already the
  // reserved USER MESSAGE, so do not spend history budget on a second copy.
  const last = messages[messages.length - 1];
  if (
    last &&
    normalizePromptComparableText(last) ===
      normalizePromptComparableText(`User: ${userMessage}`)
  ) {
    messages.pop();
  }
  return messages;
}

/** Stable context precedes history; instructions and the current request are reserved. */
export function buildBoundedAiriChatPrompt(params: {
  header: string;
  instructions: string;
  stableSections: ContextSection[];
  history: string;
  userMessage: string;
}): string {
  // The API already validates the current request. Reserve it intact before
  // spending the remaining budget on retrieved context or prior messages.
  const userMessage = params.userMessage;
  const prefix = `${params.header}\n\nINSTRUCTIONS:\n${params.instructions}`;
  const suffix = `USER MESSAGE: "${userMessage}"`;
  const historyMessages = splitHistory(params.history, userMessage);
  const seen = new Set<string>();
  const sections = [
    ...params.stableSections.map(section => ({
      label: section.label,
      segments: uniqueSegments(section.content),
      history: false,
    })),
    {
      label: "THREAD HISTORY",
      segments: historyMessages.length > 0 ? historyMessages : [EMPTY_HISTORY],
      history: true,
    },
  ].filter(section => {
    const comparable = normalizePromptComparableText(
      section.segments.join("\n\n")
    );
    if (!comparable || seen.has(comparable)) return false;
    seen.add(comparable);
    return true;
  });
  const overhead = [
    prefix,
    ...sections.map(section => `${section.label}:\n`),
    suffix,
  ].join("\n\n");
  const available: Budget = {
    chars: AIRI_CHAT_INPUT_CHAR_LIMIT - overhead.length,
    tokens: AIRI_CHAT_INPUT_TOKEN_LIMIT - estimateTokenCount(overhead),
  };
  if (available.chars < 0 || available.tokens < 0) {
    throw new Error(
      "Airi chat request and instructions exceed the input budget"
    );
  }
  // Allocate by need: small sections keep everything, and the budget they
  // leave unused goes to the sections that need more (history, KB, sources).
  const shares = allocateByNeed(
    sections.map(section =>
      section.history
        ? historyNeeds(section.segments, available).reduce(
            (sum, need) => sum + need,
            0
          )
        : costOf(section.segments.join("\n\n"), available)
    ),
    1
  );
  const render = (scale: number) =>
    [
      prefix,
      ...sections.map((section, index) => {
        const share = shares[index] * scale;
        const content = section.history
          ? boundHistory(section.segments, share, available)
          : boundSection(section.segments, share, available);
        return `${section.label}:\n${content}`;
      }),
      suffix,
    ].join("\n\n");
  // Estimates are not exactly additive; shrink every share until it fits.
  let scale = 1;
  let prompt = render(scale);
  while (
    scale > 0 &&
    (prompt.length > AIRI_CHAT_INPUT_CHAR_LIMIT ||
      estimateTokenCount(prompt) > AIRI_CHAT_INPUT_TOKEN_LIMIT)
  ) {
    scale = scale > 0.01 ? scale * 0.9 : 0;
    prompt = render(scale);
  }
  return prompt;
}
