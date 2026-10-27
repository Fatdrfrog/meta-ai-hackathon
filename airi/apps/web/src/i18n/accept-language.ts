import {
  normalizeWidgetLanguageCode,
  parseWidgetAcceptLanguageHeader,
} from "@icecore/shared/lib/widget-localization";
import { isLocale, type Locale } from "./locales";

// Browsers list Accept-Language tags in preference order, so the first tag
// with an interface locale wins: ru-RU → ru, kk-KZ → kz, en-US → en.
export function pickLocaleFromAcceptLanguage(
  header: string | null
): Locale | null {
  for (const tag of parseWidgetAcceptLanguageHeader(header)) {
    const code = normalizeWidgetLanguageCode(tag);
    if (code && isLocale(code)) return code;
  }
  return null;
}
