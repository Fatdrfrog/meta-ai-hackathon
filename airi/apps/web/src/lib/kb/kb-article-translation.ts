import "server-only";

import { chatCompletionWithFallback, getHeavyTextModel } from "@/lib/ai";
import { z } from "zod";
import {
  getKBLocaleLabel,
  type KBArticleLocalizationMeta,
} from "./kb-localization-actions";
import type { Locale } from "@/i18n/locales";

export const KB_ARTICLE_TRANSLATION_MAX_CHARS = 30_000;

/**
 * Output is about as long as the input, so the deadline grows with the
 * article: 120 s plus 4 ms per char, capped at 240 s (the localizations route
 * pins maxDuration 300). A non-final Claude attempt gets 65% of it, so the
 * Gemini fallback keeps at least the 30 s+ it had before the migration.
 */
export function getKBArticleTranslationTimeoutMs(
  contentLength: number
): number {
  const length = Math.max(0, Math.floor(contentLength) || 0);
  return Math.min(240_000, 120_000 + length * 4);
}

const kbArticleTranslationResponseSchema = z.object({
  title: z.string().min(1),
  content_mdx: z.string(),
});

export async function translateKBArticleLocalization({
  sourceLocale,
  targetLocale,
  title,
  contentMdx,
}: {
  sourceLocale: Locale;
  targetLocale: Locale;
  title: string;
  contentMdx: string;
}): Promise<{ title: string; contentMdx: string }> {
  if (contentMdx.length > KB_ARTICLE_TRANSLATION_MAX_CHARS) {
    throw new Error("Article is too long for automatic translation");
  }

  const sourceLanguage = getKBLocaleLabel(sourceLocale);
  const targetLanguage = getKBLocaleLabel(targetLocale);

  const response = await chatCompletionWithFallback({
    // Heavy tier: long HTML, user-initiated and low volume.
    model: getHeavyTextModel(),
    temperature: 0.1,
    responseFormat: { type: "json_object" },
    resilience: {
      timeoutMs: getKBArticleTranslationTimeoutMs(contentMdx.length),
    },
    // A schema makes every provider return bare JSON: Claude has no JSON
    // mode, and escaping long HTML by prompt alone is fragile.
    generationConfig: {
      responseSchema: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          content_mdx: { type: "STRING" },
        },
        required: ["title", "content_mdx"],
      },
    },
    messages: [
      {
        role: "system",
        content: [
          `Translate a knowledge base article from ${sourceLanguage} to ${targetLanguage}.`,
          'Return JSON only in the shape {"title":"...","content_mdx":"..."}.',
          "Rules:",
          "- Preserve HTML/Tiptap structure, tags, links, embeds, tables, variables, placeholders, and product names.",
          "- Translate only user-visible prose.",
          "- Do not add explanations, headings, comments, markdown fences, or extra fields.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          sourceLocale,
          targetLocale,
          title,
          content_mdx: contentMdx,
        }),
      },
    ],
  });

  const parsed = kbArticleTranslationResponseSchema.safeParse(
    JSON.parse(response.content || "{}")
  );

  if (!parsed.success) {
    throw new Error("Invalid article translation response");
  }

  return {
    title: parsed.data.title,
    contentMdx: parsed.data.content_mdx,
  };
}

export type { KBArticleLocalizationMeta };
