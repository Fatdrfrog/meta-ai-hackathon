import "server-only";

import { chatCompletionWithFallback, getLightTextModel } from "@/lib/ai";
import { buildCacheKey, cache } from "@/lib/cache";
import {
  normalizeWidgetLanguageCode,
  normalizeWidgetQuickReplies,
  normalizeWidgetQuickRepliesTranslations,
  DEFAULT_WIDGET_LANGUAGE_CODE,
} from "@icecore/shared/lib/widget-localization";
import {
  SUPPORTED_WIDGET_LANGUAGE_CODES,
  type WidgetLanguageCode,
  type WidgetQuickRepliesTranslations,
} from "@icecore/shared/types/widget-config";
import crypto from "crypto";
import { z } from "zod";

import { getLanguageDisplayName } from "@/lib/airi/language-detector";

const TRANSLATION_CACHE_TTL_SECONDS = 24 * 60 * 60;

const translationResponseSchema = z.object({
  translations: z.record(z.string(), z.array(z.string())),
});

type TranslateWidgetQuickRepliesParams = {
  quickReplies: unknown;
  sourceLocale: unknown;
  targetLocales?: unknown[];
};

export async function translateWidgetQuickRepliesSet(
  params: TranslateWidgetQuickRepliesParams
): Promise<WidgetQuickRepliesTranslations> {
  const sourceLocale =
    normalizeWidgetLanguageCode(params.sourceLocale) ||
    DEFAULT_WIDGET_LANGUAGE_CODE;
  const sourceQuickReplies = normalizeWidgetQuickReplies(params.quickReplies);

  if (sourceQuickReplies.length === 0) {
    return {};
  }

  const targetLocales = Array.from(
    new Set(
      (params.targetLocales || [])
        .map(locale => normalizeWidgetLanguageCode(locale))
        .filter(
          (locale): locale is WidgetLanguageCode =>
            Boolean(locale) && locale !== sourceLocale
        )
    )
  );

  if (targetLocales.length === 0) {
    return {};
  }

  const translationCacheKey = buildCacheKey("widget:quick-replies:i18n:v1", [
    crypto
      .createHash("md5")
      .update(
        JSON.stringify({
          sourceLocale,
          sourceQuickReplies,
          targetLocales,
        })
      )
      .digest("hex")
      .slice(0, 16),
  ]);

  const cached =
    await cache.get<WidgetQuickRepliesTranslations>(translationCacheKey);
  if (cached) {
    return normalizeWidgetQuickRepliesTranslations(cached);
  }

  const sourceLanguage = getLanguageDisplayName(sourceLocale);
  const targetLanguageLabels = targetLocales
    .map(locale => `${locale} (${getLanguageDisplayName(locale)})`)
    .join(", ");

  const response = await chatCompletionWithFallback({
    model: getLightTextModel(),
    temperature: 0.1,
    responseFormat: { type: "json_object" },
    // Name each locale so the schema has no free-form map: Claude structured
    // outputs then guarantee bare JSON, which a prompt alone does not.
    generationConfig: {
      responseSchema: {
        type: "OBJECT",
        properties: {
          translations: {
            type: "OBJECT",
            properties: Object.fromEntries(
              targetLocales.map(locale => [
                locale,
                { type: "ARRAY", items: { type: "STRING" } },
              ])
            ),
            required: targetLocales,
          },
        },
        required: ["translations"],
      },
    },
    messages: [
      {
        role: "system",
        content: [
          `Translate short widget quick replies from ${sourceLanguage}.`,
          `Target locales: ${targetLanguageLabels}.`,
          'Return JSON only in the shape {"translations":{"ru":["..."],"kz":["..."]}}.',
          "Rules:",
          "- Keep the array length and order exactly the same for every locale.",
          "- Keep each reply concise and natural for a tappable UI chip.",
          "- Preserve intent, placeholders, URLs, and brand/product names.",
          "- Do not add numbering, commentary, or extra locales.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          sourceLocale,
          targetLocales,
          quickReplies: sourceQuickReplies,
        }),
      },
    ],
  });

  const parsed = translationResponseSchema.safeParse(
    JSON.parse(response.content || "{}")
  );
  if (!parsed.success) {
    throw new Error("Invalid widget quick-reply translation response");
  }

  const translations: WidgetQuickRepliesTranslations = {};

  for (const locale of SUPPORTED_WIDGET_LANGUAGE_CODES) {
    if (!targetLocales.includes(locale)) {
      continue;
    }

    const translatedReplies = normalizeWidgetQuickReplies(
      parsed.data.translations[locale],
      sourceQuickReplies.length
    );

    if (translatedReplies.length === sourceQuickReplies.length) {
      translations[locale] = translatedReplies;
    }
  }

  await cache.set(
    translationCacheKey,
    translations,
    TRANSLATION_CACHE_TTL_SECONDS
  );

  return translations;
}
