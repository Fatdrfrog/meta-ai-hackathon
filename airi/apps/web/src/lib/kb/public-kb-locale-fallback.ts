import { isLocale, type Locale } from "@/i18n/locales";
import type { KBLocale } from "@/lib/kb/kb-locales";

export interface PublicKBArticleLocaleFallback {
  requestedLocale: Locale;
  renderedLocale: KBLocale;
}

export function readLocaleSearchParam(
  searchParams?: { locale?: string | string[] } | null
): string | null {
  const localeParam = searchParams?.locale;
  if (typeof localeParam === "string" && localeParam.length > 0) {
    return localeParam;
  }
  if (Array.isArray(localeParam) && typeof localeParam[0] === "string") {
    return localeParam[0];
  }
  return null;
}

export function getPublicKBLanguageSwitcherLocale(
  requestedLocale: string | null | undefined,
  renderedLocale: KBLocale
): Locale {
  return requestedLocale && isLocale(requestedLocale)
    ? requestedLocale
    : renderedLocale;
}

export function resolvePublicKBRequestedLocale(
  searchParams: { locale?: string | string[] } | null | undefined,
  fallback: Locale
): Locale {
  return getPublicKBLanguageSwitcherLocale(
    readLocaleSearchParam(searchParams),
    fallback
  );
}

export function getPublicKBArticleLocaleFallback({
  requestedLocale,
  renderedLocale,
  availableLocales,
}: {
  requestedLocale: string | null | undefined;
  renderedLocale: KBLocale;
  availableLocales: readonly KBLocale[];
}): PublicKBArticleLocaleFallback | null {
  if (!requestedLocale || !isLocale(requestedLocale)) {
    return null;
  }

  if (
    requestedLocale === renderedLocale ||
    availableLocales.includes(requestedLocale)
  ) {
    return null;
  }

  return {
    requestedLocale,
    renderedLocale,
  };
}
