import { isWorkspaceAiPolicyError } from "@/lib/ai/workspace-ai-errors";
import pLimit from "p-limit";
/**
 * Conversation summarization through the provider-aware chat path
 * (`chatCompletionWithFallback`): Claude heavy tier for platform billing,
 * Vertex Gemini as outage fallback, customer Google key when customer-billed.
 */

import {
  SUMMARY_LANGUAGE_INSTRUCTIONS,
  type AiriLanguage,
} from "@/lib/airi/shared/language-policy";
import type { AIChatProvider } from "./index";
import { getHeavyTextModel } from "./text-models";

export interface SummarizationResult {
  summary: string;
  chunks: string[];
  provider: AIChatProvider;
  metadata?: {
    wordCount?: number;
    messageCount?: number;
    chunkCount?: number;
    generationTimeMs?: number;
  };
}

export interface SummarizationOptions {
  language?: AiriLanguage;
  chunkSize?: number;
  generateChunks?: boolean;
}

const SUMMARY_TIMEOUT_MS = 120_000;

async function summarizeText(
  text: string,
  options: SummarizationOptions
): Promise<{ summary: string; provider: AIChatProvider }> {
  const languageName =
    options.language === "ru"
      ? "Russian"
      : options.language === "kz"
        ? "Kazakh"
        : options.language === "uz"
          ? "Uzbek"
          : "English";
  const languageInstruction = options.language
    ? `**CRITICAL LANGUAGE REQUIREMENT**: ${SUMMARY_LANGUAGE_INSTRUCTIONS[options.language]}`
    : "";

  const prompt = `${languageInstruction ? `${languageInstruction}\n\n` : ""}Summarize the following conversation into a concise paragraph in ${languageName} ONLY. Capture the main goal, key issues, and overall sentiment. This summary will be used for cross-conversation retrieval, so include key entities, topics, and actionable insights.

Conversation:
${text}`;

  // Lazy: "./index" re-exports this module, so a static import is circular.
  const { chatCompletionWithFallback } = await import("./index");
  const result = await chatCompletionWithFallback({
    model: getHeavyTextModel(),
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    generationConfig: { maxOutputTokens: 1024 },
    resilience: { timeoutMs: SUMMARY_TIMEOUT_MS },
    analytics: { operation: "ai.conversation_summary" },
  });

  return { summary: result.content, provider: result.provider };
}

function splitIntoChunks(
  messages: Array<{ text?: string; date?: Date | string }>,
  chunkSize = 600
): string[][] {
  const chunks: string[][] = [];
  let currentChunk: string[] = [];
  let currentWordCount = 0;

  for (const msg of messages) {
    const text = msg.text || "";
    const words = text.split(/\s+/).filter(Boolean);
    const parts =
      words.length > chunkSize
        ? Array.from(
            { length: Math.ceil(words.length / chunkSize) },
            (_, index) =>
              words.slice(index * chunkSize, (index + 1) * chunkSize).join(" ")
          )
        : [text];
    for (const part of parts) {
      const wordCount = part.split(/\s+/).filter(Boolean).length;
      if (currentWordCount + wordCount > chunkSize && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentWordCount = 0;
      }
      currentChunk.push(part);
      currentWordCount += wordCount;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

async function generateChunkSummaries(
  chunks: string[][],
  options: SummarizationOptions
): Promise<string[]> {
  const chunkTexts = chunks.map(chunk => chunk.join("\n"));
  const limit = pLimit(4);

  const summaries = await Promise.all(
    chunkTexts.map(chunkText =>
      limit(async () => {
        try {
          const result = await summarizeText(chunkText, options);
          return result.summary;
        } catch (error) {
          if (isWorkspaceAiPolicyError(error)) throw error;
          console.error("[Summarization] Chunk summary failed:", error);
          return "";
        }
      })
    )
  );

  // Partial chunk coverage cannot safely stand in for the full transcript.
  return summaries.every(Boolean) ? summaries : [];
}

export async function generateConversationSummary(
  messages: Array<{ text?: string; date?: Date | string }>,
  options: SummarizationOptions = {}
): Promise<SummarizationResult> {
  const startTime = Date.now();
  const chunkSize =
    options.chunkSize &&
    Number.isFinite(options.chunkSize) &&
    options.chunkSize > 0
      ? Math.max(1, Math.floor(options.chunkSize))
      : 600;
  const generateChunks = options.generateChunks ?? true;

  const fullText = messages.map(msg => msg.text || "").join("\n");
  const wordCount = fullText.split(/\s+/).filter(Boolean).length;
  const messageCount = messages.length;

  let chunks: string[] = [];
  if (generateChunks && wordCount > chunkSize) {
    const messageChunks = splitIntoChunks(messages, chunkSize);
    if (messageChunks.length > 1) {
      chunks = await generateChunkSummaries(messageChunks, options);
    }
  }

  const summaryInput =
    chunks.length > 0
      ? chunks
          .map(
            (summary, index) => `Conversation segment ${index + 1}:\n${summary}`
          )
          .join("\n\n")
      : fullText;
  const summaryResult = await summarizeText(summaryInput, options);

  const generationTime = Date.now() - startTime;

  return {
    summary: summaryResult.summary,
    chunks,
    provider: summaryResult.provider,
    metadata: {
      wordCount,
      messageCount,
      chunkCount: chunks.length,
      generationTimeMs: generationTime,
    },
  };
}
