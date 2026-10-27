import {
  chatCompletionWithFallback,
  getLightTextModel,
  getStructuredJsonGenerationConfig,
} from "@/lib/ai";
import { extractCustomerOnlyConversationContextForHyDE } from "@/lib/airi/rag/pipeline/hyde-safety";
import { truncateToTokenBudget } from "@/lib/airi/shared/token-budget";
import { ragLogger } from "@/lib/airi/shared/logger";
import { buildCacheKey, cache } from "@/lib/cache";
import crypto from "crypto";

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Minimum query length to apply HyDE (short queries benefit most) */
const HYDE_MIN_QUERY_LENGTH = 3;

/** Maximum query length for HyDE (long queries don't need expansion) */
const HYDE_MAX_QUERY_LENGTH = 200;

const HYDE_ANSWER_TOKEN_LIMIT = 256;

// =============================================================================
// TYPES
// =============================================================================

export interface HyDEResult {
  /** Whether HyDE was applied */
  applied: boolean;

  /** Original query */
  originalQuery: string;

  /** Hypothetical answer (if generated) */
  hypotheticalAnswer?: string;

  /** Text to use for embedding (either hypothetical or original) */
  textForEmbedding: string;

  /** Processing time in ms */
  processingTimeMs?: number;
}

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Generate a hypothetical answer for improved retrieval
 *
 * @param query - User's original question
 * @param options - Optional configuration
 * @returns HyDE result with text to embed
 *
 * @example
 * ```ts
 * const result = await generateHypotheticalAnswer("What is the return policy?");
 * const embedding = await getEmbedding(result.textForEmbedding);
 * ```
 */
export async function generateHypotheticalAnswer(
  query: string,
  options?: {
    /** Language for the hypothetical answer */
    language?: string;
    /** Company/domain context for better answers */
    domainContext?: string;
    /** Conversation context (full conversation window with agent responses) */
    conversationContext?: string;
    workspaceId?: string | null;
    conversationId?: string | null;
    /** Force HyDE even if query is long */
    forceApply?: boolean;
    /**
     * Phase 3.3: caller-supplied hypothetical from the unified query-prep
     * LLM call. When present and non-empty, short-circuit the standalone HyDE
     * LLM invocation and reuse it. Caller is responsible for verifying the
     * text originated from the same turn so language + context stay aligned.
     */
    seedHypotheticalAnswer?: string;
  }
): Promise<HyDEResult> {
  const startTime = Date.now();
  const trimmedQuery = query.trim();
  const seeded = truncateToTokenBudget(
    options?.seedHypotheticalAnswer?.trim() || "",
    HYDE_ANSWER_TOKEN_LIMIT
  );
  if (seeded && trimmedQuery.length >= HYDE_MIN_QUERY_LENGTH) {
    return {
      applied: true,
      originalQuery: query,
      hypotheticalAnswer: seeded,
      textForEmbedding: `${trimmedQuery}\n\n${seeded}`,
      processingTimeMs: 0,
    };
  }
  const customerOnlyConversationContext =
    extractCustomerOnlyConversationContextForHyDE(options?.conversationContext);

  // Phase 2.5: Skip HyDE if we have rich conversation context and long query
  // Rich context already provides answer space, so HyDE may generate generic answers
  if (
    customerOnlyConversationContext &&
    customerOnlyConversationContext.length > 200 &&
    query.length > 50
  ) {
    ragLogger.query.debug(
      "Skipping HyDE because rich customer-only context already provides answer-space signal",
      {
        queryPreview: trimmedQuery.slice(0, 50),
        queryLength: trimmedQuery.length,
        hasConversationContext: Boolean(customerOnlyConversationContext),
      }
    );
    return {
      applied: false,
      originalQuery: query,
      textForEmbedding: query,
    };
  }

  // Single eligibility gate: `shouldApplyHyDE` (length + heuristics), unless forced.
  const shouldRunHydeLlm =
    Boolean(options?.forceApply) || shouldApplyHyDE(trimmedQuery);

  if (!shouldRunHydeLlm) {
    return {
      applied: false,
      originalQuery: query,
      textForEmbedding: query,
    };
  }

  try {
    const language = options?.language || "en";
    const model = getLightTextModel();
    const domainContext = truncateToTokenBudget(
      options?.domainContext || "",
      512
    );
    const domainHint = options?.domainContext
      ? `\nContext: This is for a ${domainContext}.`
      : "";

    // Phase 2.5: Include conversation context in prompt for better hypothetical answers
    const contextHint = customerOnlyConversationContext
      ? `\n\nRecent customer messages:\n${customerOnlyConversationContext}` // Already trimmed to bounded customer-only context
      : "";

    // Phase 2.5: Add HyDE caching
    const hash = crypto
      .createHash("md5")
      .update(
        JSON.stringify({
          version: 2,
          workspaceId: options?.workspaceId ?? null,
          model,
          domainContext,
          query: trimmedQuery,
          language,
          customerOnlyConversationContext,
        })
      )
      .digest("hex")
      .substring(0, 16);
    const cacheKey = buildCacheKey("ai:hyde", [hash]);

    const cached = truncateToTokenBudget(
      (await cache.get<string>(cacheKey)) || "",
      HYDE_ANSWER_TOKEN_LIMIT
    );
    if (cached) {
      ragLogger.query.debug("HyDE cache hit", {
        queryPreview:
          trimmedQuery.length > 50
            ? trimmedQuery.slice(0, 50) + "..."
            : trimmedQuery,
      });
      return {
        applied: true,
        originalQuery: query,
        hypotheticalAnswer: cached,
        textForEmbedding: `${trimmedQuery}\n\n${cached}`,
        processingTimeMs: 0,
      };
    }

    const systemPrompt = `You are a helpful assistant that writes concise, factual answers.
Given a customer question, write a brief hypothetical answer (2-3 sentences max).
The answer should be informative and sound like it comes from a knowledge base.${domainHint}${contextHint}
Write in ${language === "en" ? "English" : language === "ru" ? "Russian" : language === "kz" ? "Kazakh" : language === "uz" ? "Uzbek" : "the same language as the question"}.
Do NOT include phrases like "I think" or "It seems like". Be direct and factual.`;

    const response = await chatCompletionWithFallback({
      model,
      analytics: options?.workspaceId
        ? {
            workspaceId: options.workspaceId,
            conversationId: options.conversationId || null,
            operation: "airi.rag.hyde",
            sourceService: "web.airi.rag",
          }
        : undefined,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Question: ${truncateToTokenBudget(trimmedQuery, 512)}`,
        },
      ],
      temperature: 0.7,
      generationConfig: {
        ...getStructuredJsonGenerationConfig(model),
        maxOutputTokens: 512,
      },
    });

    const hypotheticalAnswer = truncateToTokenBudget(
      response.content?.trim() || "",
      HYDE_ANSWER_TOKEN_LIMIT
    );

    if (hypotheticalAnswer) {
      const processingTimeMs = Date.now() - startTime;

      // Cache the result for 12 hours
      await cache.set(cacheKey, hypotheticalAnswer, 12 * 60 * 60);

      ragLogger.query.info("HyDE generated hypothetical answer", {
        queryPreview:
          trimmedQuery.length > 50
            ? trimmedQuery.slice(0, 50) + "..."
            : trimmedQuery,
        answerPreview:
          hypotheticalAnswer.length > 80
            ? hypotheticalAnswer.slice(0, 80) + "..."
            : hypotheticalAnswer,
        language,
        processingTimeMs,
      });

      return {
        applied: true,
        originalQuery: query,
        hypotheticalAnswer,
        // Combine query + hypothetical for richer embedding
        textForEmbedding: `${trimmedQuery}\n\n${hypotheticalAnswer}`,
        processingTimeMs,
      };
    }

    // Fallback if no response
    return {
      applied: false,
      originalQuery: query,
      textForEmbedding: query,
    };
  } catch (error) {
    ragLogger.query.warn("HyDE generation failed, using original query", {
      queryPreview:
        trimmedQuery.length > 50
          ? trimmedQuery.slice(0, 50) + "..."
          : trimmedQuery,
      error: error instanceof Error ? error.message : String(error),
    });

    // Graceful fallback - use original query
    return {
      applied: false,
      originalQuery: query,
      textForEmbedding: query,
    };
  }
}

/**
 * Synchronous pre-LLM eligibility for HyDE (length band + light heuristics).
 * `generateHypotheticalAnswer` uses this as the single gate before invoking the model
 * (unless `forceApply`); export this when callers need the same rule without calling HyDE.
 */
export function shouldApplyHyDE(query: string): boolean {
  const trimmed = query.trim();

  // Too short or too long
  if (
    trimmed.length < HYDE_MIN_QUERY_LENGTH ||
    trimmed.length > HYDE_MAX_QUERY_LENGTH
  ) {
    return false;
  }

  // Single word queries always benefit
  if (!trimmed.includes(" ")) {
    return true;
  }

  // Short questions (under 50 chars) benefit
  if (trimmed.length < 50) {
    return true;
  }

  // Questions with question words benefit
  const questionWords = [
    "what",
    "how",
    "why",
    "when",
    "where",
    "who",
    "which",
    "can",
    "do",
    "does",
    "is",
    "are",
    // Russian
    "что",
    "как",
    "почему",
    "когда",
    "где",
    "кто",
    "какой",
    "можно",
  ];

  const lowerQuery = trimmed.toLowerCase();
  return questionWords.some(
    word =>
      lowerQuery.startsWith(word + " ") || lowerQuery.startsWith(word + "?")
  );
}
