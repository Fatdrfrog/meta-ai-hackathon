import type { MissingKnowledgeSignal } from "@/lib/airi/grounding/factual-grounding-guard";
import { buildKBContentExcerpt } from "@/lib/airi/rag/kb/kb-content";
import type { KBArticleResult } from "@/lib/airi/rag/kb/kb-types";
import type { RetrievedAnswer } from "@/lib/airi/rag/types";
import {
  isInterruptedFinishReason,
  isLikelyIncompleteAssistantReply,
} from "@/lib/airi/reply/generation/reply-completeness";
import { normalizeReplyText } from "@/lib/airi/reply/generation/reply-text-sanitize";
import { MAX_REPLY_CHAR_LIMIT } from "@/lib/airi/shared/token-budget";

export type ReplyFallbackAction =
  | "use_generated_reply"
  | "grounded_recovery"
  | "intent_fallback"
  | "generic_clarification"
  | "clarifying_generation";

export type ReplyFallbackReason =
  | "generated_reply_complete"
  | "empty_generated_reply"
  | "incomplete_generated_reply"
  | "hyde_leakage_guard"
  | "missing_ask_coverage"
  | "grounded_context_available"
  | "missing_knowledge_signal"
  | "generic_ungrounded_turn"
  | "clarifying_generation_allowed"
  | "evidence_policy_clarify"
  | "evidence_policy_handoff";

/** What any recovery needs to answer this turn rather than a KB topic. */
export type RecoveryTurnContext = {
  /** The scenario step's instruction for this reply. */
  stepInstruction?: string;
  /** The latest turns of this chat, oldest first. */
  recentConversation?: string;
};

export type ReplyFallbackContext = {
  language: string;
  latestCustomerMessage?: string | null;
  intentAnchor?: string | null;
  turnContext?: RecoveryTurnContext;
  snippetContext?: RetrievedAnswer | null;
  kbContext?: KBArticleResult[] | null;
  missingKnowledgeSignal?: MissingKnowledgeSignal | null;
  generatedReply?: string | null;
  finishReason?: string | null;
  markedIncomplete?: boolean;
  coverageRequired?: boolean;
  missingAsks?: string[] | null;
  allowClarifyingGeneration?: boolean;
};

export type FallbackRecoveryContext = RecoveryTurnContext & {
  kbExcerpt?: string;
  snippetAnswer?: string;
  missingKnowledgeIntent?: string;
  latestCustomerMessage?: string;
  intentAnchor?: string;
  /** The writer's own reply, finished or fixed by recovery instead of replaced. */
  draftReply?: string;
};

const RECENT_CONVERSATION_CHAR_LIMIT = 1500;

/** The end of a one-turn-per-line transcript, cut at a line start. */
export function latestConversationTurns(
  transcript?: string | null
): string | undefined {
  const text = String(transcript || "").trim();
  if (!text) return undefined;
  if (text.length <= RECENT_CONVERSATION_CHAR_LIMIT) return text;
  const tail = text.slice(-RECENT_CONVERSATION_CHAR_LIMIT);
  const lineStart = tail.indexOf("\n");
  return lineStart >= 0 ? tail.slice(lineStart + 1).trim() : tail.trim();
}

export type ReplyFallbackDecision = {
  action: ReplyFallbackAction;
  reason: ReplyFallbackReason;
  reply?: string;
  hasGroundedContext: boolean;
  usedMissingKnowledgeSignal: boolean;
  recoveryContext?: FallbackRecoveryContext;
};

function hasGroundedRecoveryMaterial(params: {
  snippet?: RetrievedAnswer | null;
  kbContext?: KBArticleResult[] | null;
}): boolean {
  if (params.snippet?.answer?.trim()) return true;

  const usableArticles = (params.kbContext || []).filter(
    article => article.title?.trim() || article.fullContent?.trim()
  );
  return usableArticles.length > 0;
}

function buildRecoveryContextFromGrounding(params: {
  latestCustomerMessage?: string | null;
  intentAnchor?: string | null;
  snippet?: RetrievedAnswer | null;
  kbContext?: KBArticleResult[] | null;
  turnContext?: RecoveryTurnContext;
  draftReply?: string;
}): FallbackRecoveryContext {
  const ctx: FallbackRecoveryContext = { ...params.turnContext };
  if (params.draftReply) {
    ctx.draftReply = params.draftReply;
  }

  if (params.latestCustomerMessage) {
    ctx.latestCustomerMessage = params.latestCustomerMessage;
  }
  if (params.intentAnchor) {
    ctx.intentAnchor = params.intentAnchor;
  }
  if (params.snippet?.answer?.trim()) {
    ctx.snippetAnswer = params.snippet.answer.trim();
  }

  const recoveryQuery =
    `${params.intentAnchor || ""} ${params.latestCustomerMessage || ""}`.trim();
  const topArticles = (params.kbContext || [])
    .filter(article => article.title?.trim() || article.fullContent?.trim())
    .slice(0, 2);

  if (topArticles.length > 0) {
    const excerpts = topArticles
      .map(article => {
        const excerpt = buildKBContentExcerpt({
          content: article.fullContent || "",
          query: recoveryQuery || article.title,
          maxChars: 1200,
        });
        const title = article.title?.trim();
        return title ? `${title}:\n${excerpt}` : excerpt;
      })
      .filter(Boolean);

    if (excerpts.length > 0) {
      ctx.kbExcerpt = excerpts.join("\n\n");
    }
  }

  return ctx;
}

export function resolveReplyFallbackDecision(
  params: ReplyFallbackContext
): ReplyFallbackDecision {
  const normalizedGeneratedReply = normalizeReplyText(
    params.generatedReply || "",
    MAX_REPLY_CHAR_LIMIT
  );
  const coverageIncomplete =
    Boolean(params.coverageRequired) && (params.missingAsks?.length || 0) > 0;
  const generatedReplyIncomplete =
    Boolean(normalizedGeneratedReply) &&
    (params.markedIncomplete ||
      isInterruptedFinishReason(params.finishReason) ||
      isLikelyIncompleteAssistantReply(
        normalizedGeneratedReply,
        params.finishReason
      ));
  const hasGroundedContext = hasGroundedRecoveryMaterial({
    snippet: params.snippetContext,
    kbContext: params.kbContext,
  });
  const usedMissingKnowledgeSignal = Boolean(params.missingKnowledgeSignal);

  if (
    normalizedGeneratedReply &&
    !generatedReplyIncomplete &&
    !coverageIncomplete
  ) {
    return {
      action: "use_generated_reply",
      reason: "generated_reply_complete",
      reply: normalizedGeneratedReply,
      hasGroundedContext,
      usedMissingKnowledgeSignal,
    };
  }

  if (hasGroundedContext) {
    return {
      action: "grounded_recovery",
      reason: coverageIncomplete
        ? "missing_ask_coverage"
        : normalizedGeneratedReply || params.generatedReply
          ? "incomplete_generated_reply"
          : "grounded_context_available",
      /** Preserve partial main-generation text until fallback recovery succeeds. */
      reply: normalizedGeneratedReply || undefined,
      hasGroundedContext: true,
      usedMissingKnowledgeSignal,
      recoveryContext: buildRecoveryContextFromGrounding({
        latestCustomerMessage: params.latestCustomerMessage,
        intentAnchor: params.intentAnchor,
        snippet: params.snippetContext,
        kbContext: params.kbContext,
        turnContext: params.turnContext,
        draftReply: normalizedGeneratedReply || undefined,
      }),
    };
  }

  if (params.missingKnowledgeSignal) {
    return {
      action: "intent_fallback",
      reason: "missing_knowledge_signal",
      hasGroundedContext: false,
      usedMissingKnowledgeSignal: true,
      recoveryContext: {
        ...params.turnContext,
        missingKnowledgeIntent: params.missingKnowledgeSignal.intent,
        latestCustomerMessage: params.latestCustomerMessage || undefined,
        intentAnchor: params.intentAnchor || undefined,
      },
    };
  }

  if (params.allowClarifyingGeneration) {
    return {
      action: "clarifying_generation",
      reason: "clarifying_generation_allowed",
      hasGroundedContext: false,
      usedMissingKnowledgeSignal: false,
    };
  }

  return {
    action: "generic_clarification",
    reason: coverageIncomplete
      ? "missing_ask_coverage"
      : normalizedGeneratedReply || params.generatedReply
        ? generatedReplyIncomplete
          ? "incomplete_generated_reply"
          : "empty_generated_reply"
        : "generic_ungrounded_turn",
    hasGroundedContext: false,
    usedMissingKnowledgeSignal: false,
    recoveryContext: {
      ...params.turnContext,
      latestCustomerMessage: params.latestCustomerMessage || undefined,
      intentAnchor: params.intentAnchor || undefined,
    },
  };
}
