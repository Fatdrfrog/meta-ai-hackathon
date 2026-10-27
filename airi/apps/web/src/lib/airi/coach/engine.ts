import { isWorkspaceAiPolicyError } from "@/lib/ai/workspace-ai-errors";
import {
  chatCompletionWithFallback,
  getHeavyTextModel,
  type AIChatProvider,
} from "@/lib/ai";
import { canUseTextAI } from "@/lib/ai/text-provider-config";
import { estimateLlmCostUsd } from "@icecore/airi-runtime/llm-pricing";
import {
  analyzeConversationContext,
  buildHeuristicTips,
  redactPII,
  unredact,
} from "@/lib/airi/coach/coach-utils";
import {
  buildCoachSystemPrompt,
  buildCoachUserPrompt,
  COACH_RESPONSE_SCHEMA,
} from "@/lib/airi/coach/prompts";
import { hasGreetedToday } from "@/lib/airi/conversation";
import { stripDuplicateGreetingLead } from "@/lib/airi/reply/generation/strip-duplicate-greeting-lead";
import { RAG_CONFIG } from "@/lib/airi/rag/config";
import type { KBArticleResult } from "@/lib/airi/rag/kb/kb-types";
import type { RetrievedAnswer } from "@/lib/airi/rag/types";
export type CoachTip = {
  title: string;
  suggestion: string;
  type: "tone" | "clarity" | "policy" | "empathy" | "urgency" | "other";
  confidence: number;
  reasoning?: string;
};

export type EngineContext = {
  workspaceId: string;
  conversationId: string;
  conversationWindow?: string;
  messages?: Array<{ text: string; direction: string; date?: Date }>;
  preferredLanguage?: string; // Any ISO 639-1 language code
  workspaceLanguage?: string; // For manager/coach UI - any language
  agentId?: string; // For skill profiling (future)
  customerQuestion?: string;
  knowledgeContext?: {
    snippet?: RetrievedAnswer | null;
    kbArticles?: KBArticleResult[];
    quickReplies?: Array<{ text: string; category?: string; channel?: string }>;
  };
};

export type EngineResult = {
  tips: CoachTip[];
  suggestedEdit?: string;
  suggestedEditInCustomerLanguage?: string; // For "Apply" button - in customer's language
  inference?: {
    model: string;
    /** Provider that served the call; absent for the heuristic fallback. */
    provider?: AIChatProvider;
    latencyMs: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
  };
};

const MAX_QUICK_REPLIES = 8;
const MAX_QUESTION_CHARS = 400;
const MAX_SNIPPET_CHARS = 800;
const MAX_KB_CHARS = 1400;

function normalizeTextForCompare(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(text: string, maxChars: number): string {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).trim() + "...";
}

function isSuggestedEditTooSimilar(
  draft: string,
  suggestedEdit: string
): boolean {
  const a = normalizeTextForCompare(draft);
  const b = normalizeTextForCompare(suggestedEdit);
  if (!a || !b) return false;
  if (a === b) return true;

  const lenDiffRatio =
    Math.abs(a.length - b.length) / Math.max(a.length, b.length);
  if (lenDiffRatio <= 0.05 && (a.includes(b) || b.includes(a))) {
    return true;
  }

  const tokensA = new Set(a.split(" ").filter(Boolean));
  const tokensB = new Set(b.split(" ").filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return false;

  let intersection = 0;
  tokensA.forEach(token => {
    if (tokensB.has(token)) intersection += 1;
  });
  const overlap = intersection / Math.max(tokensA.size, tokensB.size);
  return overlap > 0.9;
}

function dedupeTips(tips: CoachTip[]): CoachTip[] {
  const seenTitles = new Set<string>();
  const seenSuggestions = new Set<string>();
  const result: CoachTip[] = [];

  for (const tip of tips) {
    const titleKey = (tip.title || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    const suggestionKey = (tip.suggestion || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

    if (titleKey && seenTitles.has(titleKey)) continue;
    if (suggestionKey && seenSuggestions.has(suggestionKey)) continue;

    if (titleKey) seenTitles.add(titleKey);
    if (suggestionKey) seenSuggestions.add(suggestionKey);
    result.push(tip);
  }

  return result;
}

function buildFallbackTips(tips: CoachTip[], language: string): CoachTip[] {
  if (tips.length > 0) return tips.slice(0, 3);

  const genericByLanguage: Record<
    string,
    { title: string; suggestion: string }
  > = {
    en: {
      title: "Clarify next steps",
      suggestion:
        "Acknowledge the issue and share the exact next step and timeline.",
    },
    ru: {
      title: "Уточните следующие шаги",
      suggestion:
        "Признайте проблему и укажите конкретный следующий шаг и срок.",
    },
    kz: {
      title: "Келесі қадамды нақтылаңыз",
      suggestion:
        "Мәселені мойындап, нақты келесі қадам мен мерзімді көрсетіңіз.",
    },
    uz: {
      title: "Keyingi qadamni aniqlang",
      suggestion:
        "Muammoni tan oling va aniq keyingi qadam hamda muddatni ayting.",
    },
  };

  const localized = genericByLanguage[language] || genericByLanguage.en;
  return [
    {
      title: localized.title,
      suggestion: localized.suggestion,
      type: "clarity",
      confidence: 0.55,
      reasoning: "Fallback coaching when LLM output is unavailable.",
    },
  ];
}

function formatCoachKnowledgeContext(input: {
  customerQuestion?: string;
  snippet?: RetrievedAnswer | null;
  kbArticles?: KBArticleResult[];
  quickReplies?: Array<{ text: string; category?: string; channel?: string }>;
}): string | undefined {
  const sections: string[] = [];

  if (input.customerQuestion?.trim()) {
    sections.push(
      `CUSTOMER QUESTION:\n${truncateText(input.customerQuestion.trim(), MAX_QUESTION_CHARS)}`
    );
  }

  if (input.snippet?.answer) {
    const score = Math.round((input.snippet.score || 0) * 100);
    sections.push(
      `Q/A SNIPPET:\nQ: ${truncateText(input.snippet.question || "", 300)}\nA: ${truncateText(
        input.snippet.answer,
        MAX_SNIPPET_CHARS
      )}\nRelevance: ${score}%`
    );
  }

  if (input.kbArticles && input.kbArticles.length > 0) {
    const kbBlock = input.kbArticles
      .slice(0, RAG_CONFIG.limits.kbArticlesCoach)
      .map((article, idx) => {
        const similarity = Math.round(article.similarity * 100);
        return `${idx + 1}. ${article.title} (relevance: ${similarity}%)
${truncateText(article.fullContent, MAX_KB_CHARS)}
${article.url ? `[Read more: ${article.url}]` : ""}`.trim();
      });
    sections.push(`KNOWLEDGE BASE ARTICLES:\n${kbBlock.join("\n---\n")}`);
  }

  if (input.quickReplies && input.quickReplies.length > 0) {
    const replies = input.quickReplies.slice(0, MAX_QUICK_REPLIES);
    const formatted = replies
      .map(reply => {
        const meta = [reply.category, reply.channel].filter(Boolean).join(", ");
        return `- ${reply.text}${meta ? ` (${meta})` : ""}`;
      })
      .join("\n");
    sections.push(`QUICK REPLIES (pre-approved):\n${formatted}`);
  }

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

/**
 * Simple Coach Engine - Uses the provider-aware heavy text tier via @/lib/ai
 */
export class SimpleCoachEngine {
  async generate(text: string, ctx: EngineContext): Promise<EngineResult> {
    const customerLanguage = ctx.preferredLanguage || "en";
    const tipsLanguage = ctx.workspaceLanguage || "en";

    const conversationContext =
      ctx.messages && ctx.messages.length > 0
        ? analyzeConversationContext(ctx.messages)
        : undefined;

    const heur = buildHeuristicTips(
      text || "",
      tipsLanguage,
      conversationContext,
      customerLanguage
    ).slice(0, 3);
    const fallbackTips = buildFallbackTips(heur, tipsLanguage);

    if (!text || text.trim().length < 3) {
      return { tips: [], suggestedEdit: "" };
    }

    const { redacted, map } = redactPII(text || "");
    const started = Date.now();

    const hasAnyLLMProvider = canUseTextAI();

    if (!hasAnyLLMProvider) {
      return {
        tips: fallbackTips,
        suggestedEdit: "",
        suggestedEditInCustomerLanguage: "",
        inference: {
          model: "heuristic-fallback",
          latencyMs: 0,
        },
      };
    }

    try {
      const alreadyGreeted = await hasGreetedToday(ctx.conversationId);

      const knowledgeBlock = formatCoachKnowledgeContext({
        customerQuestion: ctx.customerQuestion,
        snippet: ctx.knowledgeContext?.snippet,
        kbArticles: ctx.knowledgeContext?.kbArticles,
        quickReplies: ctx.knowledgeContext?.quickReplies,
      });

      const systemPrompt = buildCoachSystemPrompt({
        tipsLanguage,
        customerLanguage,
        conversationContext,
        alreadyGreeted,
      });

      const userPrompt = buildCoachUserPrompt({
        knowledgeBlock,
        conversationWindow: ctx.conversationWindow?.slice(0, 3000),
        agentDraft: redacted.slice(0, 1200),
      });

      const requestedModel = getHeavyTextModel();
      const response = await chatCompletionWithFallback({
        model: requestedModel,
        analytics: {
          workspaceId: ctx.workspaceId,
          conversationId: ctx.conversationId,
          operation: "airi.coach",
          sourceService: "web.airi.coach",
        },
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: userPrompt,
          },
        ],
        responseFormat: { type: "json_object" },
        generationConfig: {
          responseSchema: COACH_RESPONSE_SCHEMA,
        },
        temperature: 0.2,
      });

      const latencyMs = response.latencyMs || Date.now() - started;
      const content = response.content ?? "";
      let parsed: { tips?: CoachTip[]; suggestedEdit?: string } | null = null;
      try {
        parsed = JSON.parse(content);
      } catch {}

      const llmTips = parsed?.tips || [];
      const merged = dedupeTips([...llmTips, ...heur]).slice(0, 3);
      const finalTips = buildFallbackTips(merged, tipsLanguage);

      const suggestedEditRaw = unredact(parsed?.suggestedEdit || "", map);
      let suggestedEdit = isSuggestedEditTooSimilar(text, suggestedEditRaw)
        ? ""
        : suggestedEditRaw;
      if (alreadyGreeted && suggestedEdit) {
        suggestedEdit = stripDuplicateGreetingLead(suggestedEdit, true);
      }

      const servedModel = response.model || requestedModel;
      const costEstimate = estimateLlmCostUsd({
        model: servedModel,
        promptTokens: response.usage?.prompt_tokens,
        completionTokens: response.usage?.completion_tokens,
        // Claude caches the system block; cache reads are billed at a discount.
        cachedPromptTokens: response.usage?.cached_prompt_tokens,
        // Cache writes cost more than base input (1.25x on Claude).
        cacheWritePromptTokens: response.usage?.cache_write_prompt_tokens,
      });

      const result: EngineResult = {
        tips: finalTips,
        suggestedEdit,
        suggestedEditInCustomerLanguage: suggestedEdit,
        inference: {
          model: servedModel,
          ...(response.provider ? { provider: response.provider } : {}),
          latencyMs,
          promptTokens: response.usage?.prompt_tokens,
          completionTokens: response.usage?.completion_tokens,
          totalTokens: response.usage?.total_tokens,
          estimatedCostUsd: costEstimate.totalCostUsd,
        },
      };

      return result;
    } catch (error) {
      if (isWorkspaceAiPolicyError(error)) throw error;
      return {
        tips: fallbackTips,
        suggestedEdit: "",
        suggestedEditInCustomerLanguage: "",
        inference: {
          model: "heuristic-fallback",
          latencyMs: Date.now() - started,
        },
      };
    }
  }
}

export const simpleCoachEngine = new SimpleCoachEngine();
