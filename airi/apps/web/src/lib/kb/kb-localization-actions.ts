import {
  DEFAULT_LOCALE,
  isLocale,
  languageSwitcherLocales,
  type Locale,
} from "@/i18n/locales";

export const KB_LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  ru: "Russian",
  kz: "Kazakh",
};

export type KBArticleLocalizationMeta = {
  locale: Locale;
  status: string | null;
  published_at: string | null;
  updated_at: string | null;
  hasDraft: boolean;
  isDefault: boolean;
};

export type KBArticleLocalizationMetadataRow = {
  locale: string;
  status: string | null;
  published_at: string | null;
  updated_at: string | null;
  draft_title?: string | null;
  draft_content_mdx?: string | null;
};

export type KBLocalizationCreateMode =
  | "empty"
  | "copy_current"
  | "copy_default"
  | "copy_locale"
  | "ai_translate";

export function isKBLocalizationCreateMode(
  value: unknown
): value is KBLocalizationCreateMode {
  return (
    value === "empty" ||
    value === "copy_current" ||
    value === "copy_default" ||
    value === "copy_locale" ||
    value === "ai_translate"
  );
}

export function normalizeKBLocale(value: unknown): Locale | null {
  return typeof value === "string" && isLocale(value) ? value : null;
}

export function getKBLocaleLabel(locale: Locale): string {
  return KB_LOCALE_LABELS[locale];
}

export function resolveKBDefaultLocale(value: unknown): Locale {
  return normalizeKBLocale(value) ?? DEFAULT_LOCALE;
}

export function buildKBLocalizationMetadata({
  defaultLocale,
  articleStatus,
  articlePublishedAt,
  articleUpdatedAt = null,
  articleDraftTitle,
  articleDraftContentMdx,
  rows,
}: {
  defaultLocale?: string | null;
  articleStatus: string | null;
  articlePublishedAt: string | null;
  articleUpdatedAt?: string | null;
  articleDraftTitle?: string | null;
  articleDraftContentMdx?: string | null;
  rows: readonly KBArticleLocalizationMetadataRow[];
}): KBArticleLocalizationMeta[] {
  const resolvedDefaultLocale = resolveKBDefaultLocale(defaultLocale);
  const rowsByLocale = new Map<Locale, KBArticleLocalizationMetadataRow>();

  for (const row of rows) {
    const locale = normalizeKBLocale(row.locale);
    if (locale) {
      rowsByLocale.set(locale, row);
    }
  }

  const locales = new Set<Locale>([resolvedDefaultLocale]);
  for (const locale of rowsByLocale.keys()) {
    locales.add(locale);
  }

  return languageSwitcherLocales
    .filter(locale => locales.has(locale))
    .map(locale => {
      const row = rowsByLocale.get(locale);
      const hasDraft = row
        ? row.draft_title != null || row.draft_content_mdx != null
        : articleDraftTitle != null || articleDraftContentMdx != null;

      return {
        locale,
        status:
          row?.status ??
          (locale === resolvedDefaultLocale ? articleStatus : "draft"),
        published_at:
          row?.published_at ??
          (locale === resolvedDefaultLocale ? articlePublishedAt : null),
        updated_at:
          row?.updated_at ??
          (locale === resolvedDefaultLocale ? articleUpdatedAt : null),
        hasDraft,
        isDefault: locale === resolvedDefaultLocale,
      };
    });
}

export function areKBLocalizationMetadataEqual(
  left: KBArticleLocalizationMeta | null | undefined,
  right: KBArticleLocalizationMeta | null | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;

  return (
    left.locale === right.locale &&
    left.status === right.status &&
    left.published_at === right.published_at &&
    left.updated_at === right.updated_at &&
    left.hasDraft === right.hasDraft &&
    left.isDefault === right.isDefault
  );
}

export function upsertKBLocalizationMetadata(
  localizations: readonly KBArticleLocalizationMeta[],
  nextLocalization: KBArticleLocalizationMeta | null | undefined
): readonly KBArticleLocalizationMeta[] {
  if (!nextLocalization) return localizations;

  const existing = localizations.find(
    localization => localization.locale === nextLocalization.locale
  );
  if (areKBLocalizationMetadataEqual(existing, nextLocalization)) {
    return localizations;
  }

  const byLocale = new Map<Locale, KBArticleLocalizationMeta>();
  for (const localization of localizations) {
    byLocale.set(localization.locale, localization);
  }
  byLocale.set(nextLocalization.locale, nextLocalization);

  return languageSwitcherLocales
    .filter(locale => byLocale.has(locale))
    .map(locale => byLocale.get(locale)!);
}

export function getKBLocalizationDeleteError({
  targetLocale,
  defaultLocale,
  availableLocaleCount,
}: {
  targetLocale: Locale;
  defaultLocale: Locale;
  availableLocaleCount: number;
}): string | null {
  if (targetLocale === defaultLocale) {
    return "Default language cannot be deleted";
  }

  if (availableLocaleCount <= 1) {
    return "At least one language must remain";
  }

  return null;
}

export function getKBLocalizationUnpublishError({
  publishedLocaleCount,
  targetStatus,
}: {
  publishedLocaleCount: number;
  targetStatus: string | null;
}): string | null {
  if (targetStatus !== "published") {
    return "Language is not published";
  }

  if (publishedLocaleCount <= 1) {
    return "At least one published language must remain";
  }

  return null;
}
