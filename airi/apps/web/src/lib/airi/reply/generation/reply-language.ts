import { isWorkspaceAiPolicyError } from "@/lib/ai/workspace-ai-errors";
import { chatCompletionWithFallback, getLightTextModel } from "@/lib/ai";
import { createInferenceDeadline } from "@/lib/ai/inference-deadline";
import { airiReplyLogger } from "@/lib/airi/reply/runtime/reply-logging";
import { detectLanguage } from "@/lib/airi/language-detector-server";
import {
  canonicalLanguageCode,
  getLanguageDisplayName,
  isLanguageBearingMessageText,
  isSameLanguage,
  normalizeLanguageCandidateText,
  type WorkspaceLanguageBias,
} from "@/lib/airi/shared/language-utils";
import { buildCacheKey, cache } from "@/lib/cache";
import crypto from "crypto";

type ResolveCustomerReplyLanguageParams = {
  latestInboundText?: string | null;
  latestInboundDetectedLanguage?: string | null;
  recentCustomerLanguage?: string | null;
  conversationPreferredLanguage?: string | null;
  workspaceLanguage?: string | null;
  workspaceLanguageBias?: WorkspaceLanguageBias | null;
};

export type CustomerReplyLanguageContext = {
  inboundLanguage: string;
  replyLanguage: string;
};

type EnsureReplyLanguageParams = {
  text: string;
  targetLanguage: string;
  workspaceId?: string | null;
  /** Legacy settings may carry this value; translation always uses the metered facade. */
  elevenlabsAgentId?: string | null;
};

export type EnsureReplyLanguageResult = {
  text: string;
  translated: boolean;
  targetLanguage: string;
  detectedSourceLanguage: string;
  translationFallbackUsed: boolean;
};

const TRANSLATION_CACHE_TTL_SECONDS = 24 * 60 * 60;
const REPLY_TRANSLATION_TIMEOUT_MS = 10_000;

function scheduleTranslationCacheWrite(params: {
  key: string;
  text: string;
  workspaceId?: string | null;
}): void {
  void cache
    .set(params.key, { text: params.text }, TRANSLATION_CACHE_TTL_SECONDS)
    .catch(error => {
      airiReplyLogger.warn("airi.reply.delivery", {
        workspaceId: params.workspaceId || null,
        note: "reply_translation_cache_write_failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });
}

/** Languages customers write in Cyrillic; any other choice is wrong for Cyrillic text. */
const CYRILLIC_SCRIPT_LANGUAGES = new Set([
  "ru",
  "kz",
  "uz",
  "uk",
  "be",
  "bg",
  "sr",
  "mk",
  "ky",
  "tg",
  "mn",
]);
const KAZAKH_SPECIFIC_LETTER_RE = /[әғқңөұүһі]/iu;

/** `kz` or `ru` for mostly-Cyrillic text, empty otherwise. */
function inferCyrillicScriptLanguage(text: string): string {
  const letterCount = text.match(/\p{L}/gu)?.length || 0;
  if (letterCount < 2) return "";
  const cyrillicCount = text.match(/\p{Script=Cyrillic}/gu)?.length || 0;
  if (cyrillicCount * 2 < letterCount) return "";
  return KAZAKH_SPECIFIC_LETTER_RE.test(text) ? "kz" : "ru";
}

export function resolveCustomerReplyLanguageContext(
  params: ResolveCustomerReplyLanguageParams
): CustomerReplyLanguageContext {
  const inboundText =
    typeof params.latestInboundText === "string"
      ? normalizeLanguageCandidateText(params.latestInboundText)
      : "";
  const detectedInboundLanguage = isLanguageBearingMessageText(inboundText)
    ? canonicalLanguageCode(params.latestInboundDetectedLanguage)
    : "";
  const resolved = resolveFromLanguageSignals(params, detectedInboundLanguage);
  const scriptLanguage = inferCyrillicScriptLanguage(inboundText);
  if (
    !scriptLanguage ||
    CYRILLIC_SCRIPT_LANGUAGES.has(resolved.replyLanguage)
  ) {
    return resolved;
  }

  // Missing or low-confidence detection must never answer Cyrillic in English.
  const language = CYRILLIC_SCRIPT_LANGUAGES.has(detectedInboundLanguage)
    ? detectedInboundLanguage
    : scriptLanguage;
  return { inboundLanguage: language, replyLanguage: language };
}

function resolveFromLanguageSignals(
  params: ResolveCustomerReplyLanguageParams,
  detectedInboundLanguage: string
): CustomerReplyLanguageContext {
  const recentCustomerLanguage = canonicalLanguageCode(
    params.recentCustomerLanguage
  );
  const preferredLanguage = canonicalLanguageCode(
    params.conversationPreferredLanguage
  );

  if (detectedInboundLanguage) {
    if (
      recentCustomerLanguage &&
      !isSameLanguage(detectedInboundLanguage, recentCustomerLanguage)
    ) {
      return {
        inboundLanguage: recentCustomerLanguage,
        replyLanguage: recentCustomerLanguage,
      };
    }

    return {
      inboundLanguage: detectedInboundLanguage,
      replyLanguage: detectedInboundLanguage,
    };
  }

  if (recentCustomerLanguage) {
    return {
      inboundLanguage: recentCustomerLanguage,
      replyLanguage: recentCustomerLanguage,
    };
  }

  if (preferredLanguage) {
    return {
      inboundLanguage: preferredLanguage,
      replyLanguage: preferredLanguage,
    };
  }

  const workspaceLanguage = canonicalLanguageCode(params.workspaceLanguage);
  if (workspaceLanguage) {
    return {
      inboundLanguage: workspaceLanguage,
      replyLanguage: workspaceLanguage,
    };
  }

  return {
    inboundLanguage: "en",
    replyLanguage: "en",
  };
}

export function resolveCustomerReplyLanguage(
  params: ResolveCustomerReplyLanguageParams
): string {
  return resolveCustomerReplyLanguageContext(params).replyLanguage;
}

export async function ensureReplyLanguage(
  params: EnsureReplyLanguageParams
): Promise<EnsureReplyLanguageResult> {
  const inferenceDeadline = createInferenceDeadline(
    REPLY_TRANSLATION_TIMEOUT_MS
  );
  const originalText = String(params.text || "").trim();
  const targetLanguage = canonicalLanguageCode(params.targetLanguage) || "en";
  if (!originalText) {
    return {
      text: originalText,
      translated: false,
      targetLanguage,
      detectedSourceLanguage: targetLanguage,
      translationFallbackUsed: false,
    };
  }

  const detectedSourceLanguage =
    canonicalLanguageCode(
      await detectLanguage(originalText, {
        timeoutMs: inferenceDeadline.remainingMs(),
      })
    ) || "en";

  if (isSameLanguage(detectedSourceLanguage, targetLanguage)) {
    return {
      text: originalText,
      translated: false,
      targetLanguage,
      detectedSourceLanguage,
      translationFallbackUsed: false,
    };
  }

  const textHash = crypto
    .createHash("md5")
    .update(originalText)
    .digest("hex")
    .slice(0, 16);
  const translationCacheKey = buildCacheKey("airi:reply-translation:v1", [
    textHash,
    targetLanguage,
  ]);

  const cached = await cache.get<{ text?: string }>(translationCacheKey);
  if (typeof cached?.text === "string" && cached.text.trim()) {
    return {
      text: cached.text.trim(),
      translated: true,
      targetLanguage,
      detectedSourceLanguage,
      translationFallbackUsed: false,
    };
  }

  try {
    const fromDisplayName = getLanguageDisplayName(detectedSourceLanguage);
    const toDisplayName = getLanguageDisplayName(targetLanguage);
    const textModelTimeoutMs = inferenceDeadline.nextTimeoutMs(
      REPLY_TRANSLATION_TIMEOUT_MS
    );
    if (!textModelTimeoutMs) {
      throw new Error("Reply-translation inference deadline exhausted");
    }

    const response = await chatCompletionWithFallback({
      model: getLightTextModel(),
      temperature: 0.1,
      resilience: {
        maxRetries: 0,
        timeoutMs: textModelTimeoutMs,
      },
      messages: [
        {
          role: "system",
          content: [
            `Translate the user-visible assistant reply from ${fromDisplayName} to ${toDisplayName}.`,
            "Rules:",
            "- Preserve meaning and intent exactly.",
            "- Keep URLs, placeholders, and brand/product names intact.",
            "- Return only the translated text.",
            `- If the text is already in ${toDisplayName}, return it unchanged.`,
          ].join("\n"),
        },
        {
          role: "user",
          content: originalText,
        },
      ],
    });

    const translatedText = String(response.content || "").trim();
    if (!translatedText) {
      return {
        text: originalText,
        translated: false,
        targetLanguage,
        detectedSourceLanguage,
        translationFallbackUsed: true,
      };
    }

    scheduleTranslationCacheWrite({
      key: translationCacheKey,
      text: translatedText,
      workspaceId: params.workspaceId,
    });

    return {
      text: translatedText,
      translated: translatedText !== originalText,
      targetLanguage,
      detectedSourceLanguage,
      translationFallbackUsed: false,
    };
  } catch (error) {
    if (isWorkspaceAiPolicyError(error)) throw error;
    return {
      text: originalText,
      translated: false,
      targetLanguage,
      detectedSourceLanguage,
      translationFallbackUsed: true,
    };
  }
}
