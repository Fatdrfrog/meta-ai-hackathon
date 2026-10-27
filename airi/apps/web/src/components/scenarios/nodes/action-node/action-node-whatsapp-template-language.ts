/** Locales for naming languages in the page language; "kz" pages are Kazakh. */
export function resolveLanguageNamesLocales(
  uiLanguage: string
): string[] | undefined {
  const locale = uiLanguage === "kz" ? "kk" : uiLanguage;
  return locale ? [locale] : undefined;
}

/** A readable name for a WhatsApp template language code such as "en_US". */
export function formatWhatsAppTemplateLanguage(
  code: string | null | undefined,
  names: Intl.DisplayNames | null
): string {
  const trimmed = (code || "").trim();
  if (!trimmed || !names) return trimmed;
  try {
    return names.of(trimmed.replace(/_/g, "-")) || trimmed;
  } catch {
    return trimmed;
  }
}
