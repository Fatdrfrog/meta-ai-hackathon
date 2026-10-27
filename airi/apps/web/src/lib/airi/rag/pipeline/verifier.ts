/**
 * Snippet/KB Relevance Verifier
 *
 * Uses a fast LLM call to verify if retrieved content actually answers
 * the user's question. This prevents false positive matches where
 * cosine similarity is high but topics are different.
 *
 * Example false positive this catches:
 * - User: "How much does americano cost?"
 * - Snippet: "How much does delivery cost?" (89% similarity)
 * - Verifier: { isRelevant: false, reason: "Different products" }
 */

import {
  chatCompletionWithFallback,
  formatScore,
  getHeavyTextModel,
  truncateText,
} from "@/lib/ai";
import { extractJsonObject } from "@/lib/ai/json-object";
import { VerificationError } from "@/lib/airi/shared/errors";
import { ragLogger } from "@/lib/airi/shared/logger";

export interface VerificationResult {
  isRelevant: boolean;
  confidence: number;
  reason: string;
}

export interface SnippetForVerification {
  question: string;
  answer: string;
  score?: number;
}

/**
 * Verify if a snippet actually answers the user's question
 *
 * Uses the heavy text model for verification.
 * Only called for high-similarity snippets to prevent hallucinations.
 */
export async function verifySnippetRelevance(
  userQuery: string,
  snippet: SnippetForVerification,
  options?: {
    workspaceId?: string | null;
    conversationId?: string | null;
  }
): Promise<VerificationResult> {
  const startTime = Date.now();

  try {
    const response = await chatCompletionWithFallback({
      model: getHeavyTextModel(),
      analytics: options?.workspaceId
        ? {
            workspaceId: options.workspaceId,
            conversationId: options.conversationId || null,
            operation: "airi.rag.verifier",
            sourceService: "web.airi.rag",
          }
        : undefined,
      messages: [
        {
          role: "system",
          content: `You are a relevance checker for a customer support AI system.
          
Given a customer's question and a FAQ entry from the knowledge base, determine if the FAQ actually answers what the customer is asking about.

CRITICAL: Check if they are asking about the SAME TOPIC/PRODUCT/SERVICE.
- "How much does X cost?" and "How much does Y cost?" are NOT relevant if X ≠ Y
- Different products, services, or topics = NOT relevant
- Generic greetings can match generic greeting responses

Respond with JSON only:
{
  "isRelevant": boolean,
  "confidence": 0.0-1.0,
  "reason": "brief explanation"
}`,
        },
        {
          role: "user",
          content: `Customer Question: "${userQuery}"

FAQ Entry:
Q: "${snippet.question}"
A: "${snippet.answer}"

Is this FAQ entry relevant to answer the customer's question?`,
        },
      ],
      responseFormat: { type: "json_object" },
      temperature: 0,
    });

    // Prompt-only JSON (no response schema) may come back in a code fence.
    const result = extractJsonObject(response.content || "{}") as {
      isRelevant?: boolean;
      confidence?: number;
      reason?: string;
    };
    const verifyTime = Date.now() - startTime;

    ragLogger.verification.info("Snippet verification result", {
      userQuery: truncateText(userQuery, 50),
      snippetQuestion: truncateText(snippet.question, 50),
      isRelevant: result.isRelevant,
      confidence: result.confidence,
      reason: result.reason,
      verifyTimeMs: verifyTime,
      originalScore: formatScore(snippet.score),
    });

    return {
      isRelevant: result.isRelevant ?? false,
      confidence: result.confidence ?? 0,
      reason: result.reason ?? "Unknown",
    };
  } catch (error) {
    if (error instanceof VerificationError) {
      throw error;
    }
    throw new VerificationError("Snippet verification failed", {
      userQuery: truncateText(userQuery, 50),
      snippetQuestion: truncateText(snippet.question, 50),
      originalError: error instanceof Error ? error.message : String(error),
    });
  }
}
