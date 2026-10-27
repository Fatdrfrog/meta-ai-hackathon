import { extractQuotedPrice } from "@/lib/airi/grounding/pricing-quote-extract";
import { normalizeComparableText } from "@/lib/airi/reply/thread/reply-text-utils";
import { trimSelectionLabelText } from "@/lib/airi/reply/selection/selection-text";
import {
  normalizeAiriActiveSelection,
  type AiriActiveSelection,
} from "@/lib/airi/reply/selection/types";

const OFFER_KEYWORD_PATTERN =
  /(?:guide|гайд|package|пакет\p{L}*|consult\p{L}*|консультац\p{L}*|program\p{L}*|программ\p{L}*|grant\p{L}*|грант\p{L}*|service\p{L}*|услуг\p{L}*|payment\p{L}*|төлем\p{L}*)/iu;

const GENERIC_SELECTION_TERMS = new Set([
  "guide",
  "package",
  "program",
  "grant",
  "payment",
  "service",
  "consultation",
  "гайд",
  "пакет",
  "программа",
  "грант",
  "оплата",
  "услуга",
  "консультация",
  "төлем",
]);

const GENERIC_REPLY_TERMS = new Set([
  ...GENERIC_SELECTION_TERMS,
  "the",
  "this",
  "that",
  "you",
  "your",
  "can",
  "buy",
  "pay",
  "selected",
  "option",
  "reply",
  "costs",
  "includes",
  "да",
  "можно",
  "оплатить",
  "выбранный",
]);

function inferConflictingLabelFromReply(text: string): string {
  const normalized = trimSelectionLabelText(text);
  if (!normalized) return "";

  const keywordMatch = normalized.match(
    /(?:guide|гайд|package|пакет\p{L}*|consult\p{L}*|консультац\p{L}*|program\p{L}*|программ\p{L}*|grant\p{L}*|грант\p{L}*)[^.?!\n]{0,80}/iu
  );
  if (keywordMatch?.[0]) {
    return trimSelectionLabelText(keywordMatch[0]);
  }

  const questionCut = normalized.split(/[?!\n]/u)[0] || normalized;
  if (OFFER_KEYWORD_PATTERN.test(questionCut)) {
    return trimSelectionLabelText(questionCut);
  }

  return "";
}

function extractDistinctiveTerms(
  label: string,
  genericTerms: Set<string>
): string[] {
  return normalizeComparableText(label)
    .split(/\s+/u)
    .map(part => part.trim())
    .filter(part => part.length >= 3)
    .filter(part => !genericTerms.has(part));
}

function replyMentionsConflictingPrice(
  reply: string,
  selection: NonNullable<AiriActiveSelection>
): boolean {
  if (!selection.quotedPriceAmount || !selection.quotedPriceCurrency) {
    return false;
  }

  const replyPrice = extractQuotedPrice(reply);
  if (!replyPrice?.amount || !replyPrice.currency) {
    return false;
  }

  return !(
    replyPrice.amount === selection.quotedPriceAmount &&
    replyPrice.currency === selection.quotedPriceCurrency
  );
}

function replyMentionsConflictingLabel(
  reply: string,
  selection: NonNullable<AiriActiveSelection>
): boolean {
  const replyLabel = inferConflictingLabelFromReply(reply);
  if (!replyLabel) return false;

  const selectionTerms = extractDistinctiveTerms(
    selection.label,
    GENERIC_SELECTION_TERMS
  );
  const replyTerms = extractDistinctiveTerms(replyLabel, GENERIC_REPLY_TERMS);

  if (selectionTerms.length === 0 || replyTerms.length === 0) {
    return false;
  }

  return !replyTerms.some(term => selectionTerms.includes(term));
}

export function evaluateActiveSelectionReplyConsistency(params: {
  reply: string;
  selection?: AiriActiveSelection;
}): {
  isConsistent: boolean;
  repairInstruction?: string;
} {
  const selection = normalizeAiriActiveSelection(params.selection);
  if (!selection || !params.reply.trim()) {
    return { isConsistent: true };
  }

  if (replyMentionsConflictingPrice(params.reply, selection)) {
    const repairInstruction = [
      "SELECTION CONSISTENCY REPAIR:",
      `- The previous draft drifted away from the locked customer selection: ${selection.label}.`,
      selection.quotedPriceText
        ? `- The locked quoted price is ${selection.quotedPriceText}.`
        : "",
      "- Rewrite the reply so it stays on the selected option and does not introduce a different price or package.",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      isConsistent: false,
      repairInstruction,
    };
  }

  if (replyMentionsConflictingLabel(params.reply, selection)) {
    return {
      isConsistent: false,
      repairInstruction: [
        "SELECTION CONSISTENCY REPAIR:",
        `- The previous draft drifted away from the locked customer selection: ${selection.label}.`,
        "- Rewrite the reply so it stays on the selected option and does not switch to a different package, guide, or program.",
      ].join("\n"),
    };
  }

  return { isConsistent: true };
}
