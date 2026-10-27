export const locales = ["en", "ru", "kz"] as const;
export type Locale = (typeof locales)[number];
export const DEFAULT_LOCALE: Locale = "en";

export const languageSwitcherLocales = ["kz", "en", "ru"] as const;

export function isLocale(value: string): value is Locale {
  return locales.includes(value as Locale);
}

/** The BCP 47 tag Intl expects: the app's "kz" is Kazakh, "kk". */
export function toIntlLocale(locale: string): string {
  return locale === "kz" ? "kk" : locale;
}
