/** Cross-language text translation for RAG (match user language to company KB language). */

import {
  chatCompletionWithFallback,
  formatError,
  getLightTextModel,
} from "@/lib/ai";
import { normalizeRagQueryWhitespace } from "@/lib/airi/rag/query/query-cleaner";
import { getLanguageDisplayName } from "@/lib/airi/shared/language-utils";
import { ragLogger } from "@/lib/airi/shared/logger";
import { buildCacheKey, cache } from "@/lib/cache";
import type { ConversationPreferredLanguage } from "@icecore/shared/types/conversation";
import crypto from "crypto";

export type CompanyLanguage = ConversationPreferredLanguage;

/** Any ISO 639-1-style code the model can translate. */
export type CustomerLanguage = string;

type TextTranslationResult = {
  translatedText: string;
  wasTranslated: boolean;
  originalText: string;
  fromLang: string;
  toLang: CompanyLanguage;
};

async function translateTextWithLlm(params: {
  text: string;
  fromLang: CustomerLanguage;
  toLang: CompanyLanguage;
  purpose: "query" | "answer";
}): Promise<TextTranslationResult> {
  const { text, fromLang, toLang, purpose } = params;
  const normalizedFrom = fromLang.toLowerCase().trim();
  const normalizedTo = toLang.toLowerCase().trim();
  const originalText = String(text || "");

  if (normalizedFrom === normalizedTo) {
    return {
      translatedText: originalText,
      wasTranslated: false,
      originalText,
      fromLang,
      toLang,
    };
  }

  const textToTranslate =
    purpose === "query"
      ? normalizeRagQueryWhitespace(originalText)
      : originalText.trim();

  if (!textToTranslate) {
    return {
      translatedText: originalText,
      wasTranslated: false,
      originalText,
      fromLang,
      toLang,
    };
  }

  const fromLangName = getLanguageDisplayName(fromLang);
  const toLangName = getLanguageDisplayName(toLang);
  const hash = crypto
    .createHash("md5")
    .update(textToTranslate)
    .digest("hex")
    .substring(0, 16);
  const cacheKey = buildCacheKey(`ai:${purpose}-translation`, [
    hash,
    normalizedTo,
  ]);

  const cached = await cache.get<{
    translatedText?: string;
    fromLang: string;
    toLang: CompanyLanguage;
  }>(cacheKey);

  if (typeof cached?.translatedText === "string" && cached.translatedText) {
    ragLogger.translation.debug("Translation cache hit", {
      purpose,
      fromLang: cached.fromLang,
      toLang: cached.toLang,
      originalPreview: originalText.slice(0, 50),
      translatedPreview: cached.translatedText.slice(0, 50),
    });
    return {
      translatedText: cached.translatedText,
      wasTranslated: true,
      originalText,
      fromLang: cached.fromLang,
      toLang: cached.toLang,
    };
  }

  const startTime = Date.now();

  try {
    const response = await chatCompletionWithFallback({
      model: getLightTextModel(),
      messages: [
        {
          role: "system",
          content: `You are a professional translator. Translate the user's ${purpose} text from ${fromLangName} to ${toLangName}.
Rules:
- Preserve the meaning and intent exactly
- Keep proper nouns, brand names, URLs, prices, placeholders, and technical terms as-is
- Output ONLY the translation, nothing else
- If the text is already in ${toLangName}, return it unchanged`,
        },
        {
          role: "user",
          content: textToTranslate,
        },
      ],
      temperature: 0.1,
      resilience: {
        maxRetries: 0,
        timeoutMs: 8_000,
      },
    });

    const translatedText = response.content?.trim() || originalText;
    const duration = Date.now() - startTime;

    ragLogger.translation.info("Text translated", {
      purpose,
      fromLang,
      toLang,
      fromLangName,
      toLangName,
      originalPreview: originalText.slice(0, 50),
      normalizedForTranslation:
        purpose === "query" && textToTranslate !== originalText.trim(),
      translatedPreview: translatedText.slice(0, 50),
      provider: response.provider,
      model: response.model,
      durationMs: duration,
    });

    void Promise.resolve(
      cache.set(
        cacheKey,
        {
          translatedText,
          fromLang,
          toLang,
        },
        24 * 60 * 60
      )
    ).catch(cacheError => {
      ragLogger.translation.warn("Translation cache write failed", {
        purpose,
        fromLang,
        toLang,
        formattedError: formatError(cacheError),
      });
    });

    return {
      translatedText,
      wasTranslated: true,
      originalText,
      fromLang,
      toLang,
    };
  } catch (error) {
    ragLogger.translation.warn("Translation failed, using original text", {
      purpose,
      fromLang,
      toLang,
      originalPreview: originalText.slice(0, 50),
      formattedError: formatError(error),
    });

    return {
      translatedText: originalText,
      wasTranslated: false,
      originalText,
      fromLang,
      toLang,
    };
  }
}

/** Translate the retrieval query into the company's primary language when they differ. */
export async function translateQueryForRAG(
  query: string,
  fromLang: CustomerLanguage,
  toLang: CompanyLanguage
): Promise<{
  translatedQuery: string;
  wasTranslated: boolean;
  originalQuery: string;
  fromLang: string;
  toLang: CompanyLanguage;
}> {
  const result = await translateTextWithLlm({
    text: query,
    fromLang,
    toLang,
    purpose: "query",
  });

  return {
    translatedQuery: result.translatedText,
    wasTranslated: result.wasTranslated,
    originalQuery: query,
    fromLang: result.fromLang,
    toLang: result.toLang,
  };
}

export async function translateAnswerForReply(
  text: string,
  fromLang: CustomerLanguage,
  toLang: CompanyLanguage
): Promise<TextTranslationResult> {
  return translateTextWithLlm({
    text,
    fromLang,
    toLang,
    purpose: "answer",
  });
}

/** True when both languages are known and differ (model translates between any pair). */
export function shouldTranslateForRAG(
  queryLang: string | undefined,
  companyLang: CompanyLanguage | undefined
): boolean {
  if (!companyLang) return false;
  if (!queryLang) return false;

  const normalizedQuery = queryLang.toLowerCase().trim();
  const normalizedCompany = companyLang.toLowerCase().trim();

  if (normalizedQuery === normalizedCompany) return false;

  return true;
}
