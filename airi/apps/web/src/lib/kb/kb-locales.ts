import {
  DEFAULT_LOCALE,
  isLocale,
  languageSwitcherLocales,
  type Locale,
} from "@/i18n/locales";

export type KBLocale = Locale;

export const LANGUAGE_SWITCHER_LOCALES = [...languageSwitcherLocales];

export function toKBLocaleList(values: readonly unknown[]): KBLocale[] {
  const available = new Set(
    values.filter(
      (value): value is KBLocale => typeof value === "string" && isLocale(value)
    )
  );

  return LANGUAGE_SWITCHER_LOCALES.filter(locale => available.has(locale));
}

export function resolveKBArticleLocale({
  requestedLocale,
  availableLocales,
}: {
  requestedLocale?: string | null;
  availableLocales: readonly unknown[];
}): KBLocale {
  const normalizedAvailable = toKBLocaleList(availableLocales);

  if (
    requestedLocale &&
    isLocale(requestedLocale) &&
    normalizedAvailable.includes(requestedLocale)
  ) {
    return requestedLocale;
  }

  return normalizedAvailable[0] ?? DEFAULT_LOCALE;
}

export function resolveKBArticleReadLocale({
  requestedLocale,
  defaultLocale,
  localizationLocales,
}: {
  requestedLocale?: string | null;
  defaultLocale?: string | null;
  localizationLocales: readonly unknown[];
}): {
  locale: KBLocale;
  availableLocales: KBLocale[];
} {
  const availableLocales = toKBLocaleList([
    ...localizationLocales,
    defaultLocale,
  ]);
  const normalizedDefaultLocale =
    typeof defaultLocale === "string" && isLocale(defaultLocale)
      ? defaultLocale
      : DEFAULT_LOCALE;
  const locale =
    requestedLocale &&
    isLocale(requestedLocale) &&
    availableLocales.includes(requestedLocale)
      ? requestedLocale
      : availableLocales.includes(normalizedDefaultLocale)
        ? normalizedDefaultLocale
        : resolveKBArticleLocale({
            requestedLocale,
            availableLocales,
          });

  return {
    locale,
    availableLocales:
      availableLocales.length > 0 ? availableLocales : [DEFAULT_LOCALE],
  };
}

export function resolveKBPublicArticleReadLocale({
  requestedLocale,
  defaultLocale,
  localizationLocales,
  hasDefaultLocaleVariant,
}: {
  requestedLocale?: string | null;
  defaultLocale?: string | null;
  localizationLocales: readonly unknown[];
  hasDefaultLocaleVariant: boolean;
}): {
  locale: KBLocale;
  availableLocales: KBLocale[];
} {
  return resolveKBArticleReadLocale({
    requestedLocale,
    defaultLocale: hasDefaultLocaleVariant ? defaultLocale : null,
    localizationLocales,
  });
}
