/**
 * WhatsApp Template Constants
 * Character limits, validation rules, and UI metadata
 */

import type {
  WhatsAppTemplateCategory,
  WhatsAppTemplateStatus,
} from "../types/whatsapp";

// ============================================================================
// CHARACTER LIMITS
// ============================================================================

export const WHATSAPP_TEMPLATE_LIMITS = {
  NAME_MAX_LENGTH: 512,
  NAME_MIN_LENGTH: 1,
  BODY_MAX_LENGTH: 1024,
  HEADER_MAX_LENGTH: 60,
  FOOTER_MAX_LENGTH: 60,
  BUTTON_TEXT_MAX_LENGTH: 25,
  BUTTON_URL_MAX_LENGTH: 2000,
  VARIABLES_MAX_COUNT: 50,
  BUTTONS_MAX_COUNT: 3,
  COMPONENTS_MAX_COUNT: 5, // HEADER, BODY, FOOTER, BUTTONS, CAROUSEL
  CAROUSEL_CARDS_MIN: 2,
  CAROUSEL_CARDS_MAX: 10,
  CAROUSEL_CARD_BODY_MAX_LENGTH: 160,
  CAROUSEL_CARD_BUTTONS_MAX_COUNT: 2,
} as const;

// ============================================================================
// STATUS METADATA
// ============================================================================

export interface StatusMetadata {
  label: string;
  description: string;
  color: "green" | "yellow" | "red" | "blue" | "gray";
  icon?: string;
}

export const TEMPLATE_STATUS_METADATA: Record<
  WhatsAppTemplateStatus,
  StatusMetadata
> = {
  APPROVED: {
    label: "Approved",
    description: "Template is approved and ready to use",
    color: "green",
  },
  PENDING: {
    label: "Pending Review",
    description: "Template is awaiting Meta approval",
    color: "yellow",
  },
  REJECTED: {
    label: "Rejected",
    description: "Template was rejected by Meta",
    color: "red",
  },
  PAUSED: {
    label: "Paused",
    description: "Template is paused and cannot be used",
    color: "gray",
  },
  LIMIT_EXCEEDED: {
    label: "Limit Exceeded",
    description: "Template edit limit exceeded",
    color: "red",
  },
};

// ============================================================================
// CATEGORY METADATA
// ============================================================================

export interface CategoryMetadata {
  label: string;
  description: string;
  approvalTime: string;
  useCase: string;
  color: "blue" | "purple" | "orange";
}

export const TEMPLATE_CATEGORY_METADATA: Record<
  WhatsAppTemplateCategory,
  CategoryMetadata
> = {
  MARKETING: {
    label: "Marketing",
    description: "Promotional messages, sales, offers",
    approvalTime: "24-48 hours",
    useCase: "Promotions, sales, announcements",
    color: "purple",
  },
  UTILITY: {
    label: "Utility",
    description: "Transactional updates, alerts, notifications",
    approvalTime: "12-24 hours",
    useCase: "Order updates, alerts, confirmations",
    color: "blue",
  },
  AUTHENTICATION: {
    label: "Authentication",
    description: "OTP codes, verification, security",
    approvalTime: "2-4 hours",
    useCase: "OTP, verification codes, security alerts",
    color: "orange",
  },
};

// ============================================================================
// LANGUAGE CODES
// ============================================================================

/** The markets we serve most, shown above the rest in language pickers. */
const MAIN_TEMPLATE_LANGUAGES = [
  { code: "en", name: "English", nativeName: "English" },
  { code: "en_US", name: "English (US)", nativeName: "English (US)" },
  { code: "en_GB", name: "English (UK)", nativeName: "English (UK)" },
  { code: "ru", name: "Russian", nativeName: "Русский" },
  { code: "kk", name: "Kazakh", nativeName: "Қазақ тілі" },
  { code: "uz", name: "Uzbek", nativeName: "Oʻzbekcha" },
] as const;

/**
 * Every other language Meta accepts for message templates, by English name.
 * Source: developers.facebook.com/docs/whatsapp/business-management-api/
 * message-templates/supported-languages (checked 2026-10-13).
 */
const OTHER_TEMPLATE_LANGUAGES = [
  { code: "af", name: "Afrikaans", nativeName: "Afrikaans" },
  { code: "sq", name: "Albanian", nativeName: "Shqip" },
  { code: "ar", name: "Arabic", nativeName: "العربية" },
  { code: "ar_EG", name: "Arabic (Egypt)", nativeName: "العربية (مصر)" },
  { code: "ar_LB", name: "Arabic (Lebanon)", nativeName: "العربية (لبنان)" },
  { code: "ar_MA", name: "Arabic (Morocco)", nativeName: "العربية (المغرب)" },
  { code: "ar_QA", name: "Arabic (Qatar)", nativeName: "العربية (قطر)" },
  { code: "ar_AE", name: "Arabic (UAE)", nativeName: "العربية (الإمارات)" },
  { code: "az", name: "Azerbaijani", nativeName: "Azərbaycan dili" },
  { code: "be_BY", name: "Belarusian", nativeName: "Беларуская" },
  { code: "bn", name: "Bengali", nativeName: "বাংলা" },
  { code: "bn_IN", name: "Bengali (India)", nativeName: "বাংলা (ভারত)" },
  { code: "bg", name: "Bulgarian", nativeName: "Български" },
  { code: "ca", name: "Catalan", nativeName: "Català" },
  { code: "zh_HK", name: "Chinese (Hong Kong)", nativeName: "中文（香港）" },
  { code: "zh_CN", name: "Chinese (Simplified)", nativeName: "中文（简体）" },
  { code: "zh_TW", name: "Chinese (Traditional)", nativeName: "中文（繁體）" },
  { code: "hr", name: "Croatian", nativeName: "Hrvatski" },
  { code: "cs", name: "Czech", nativeName: "Čeština" },
  { code: "da", name: "Danish", nativeName: "Dansk" },
  { code: "prs_AF", name: "Dari", nativeName: "دری" },
  { code: "nl", name: "Dutch", nativeName: "Nederlands" },
  { code: "nl_BE", name: "Dutch (Belgium)", nativeName: "Nederlands (België)" },
  {
    code: "en_AU",
    name: "English (Australia)",
    nativeName: "English (Australia)",
  },
  { code: "en_CA", name: "English (Canada)", nativeName: "English (Canada)" },
  { code: "en_GH", name: "English (Ghana)", nativeName: "English (Ghana)" },
  { code: "en_IN", name: "English (India)", nativeName: "English (India)" },
  { code: "en_IE", name: "English (Ireland)", nativeName: "English (Ireland)" },
  { code: "en_JM", name: "English (Jamaica)", nativeName: "English (Jamaica)" },
  {
    code: "en_MY",
    name: "English (Malaysia)",
    nativeName: "English (Malaysia)",
  },
  {
    code: "en_NZ",
    name: "English (New Zealand)",
    nativeName: "English (New Zealand)",
  },
  { code: "en_QA", name: "English (Qatar)", nativeName: "English (Qatar)" },
  {
    code: "en_SG",
    name: "English (Singapore)",
    nativeName: "English (Singapore)",
  },
  {
    code: "en_ZA",
    name: "English (South Africa)",
    nativeName: "English (South Africa)",
  },
  { code: "en_AE", name: "English (UAE)", nativeName: "English (UAE)" },
  { code: "en_UG", name: "English (Uganda)", nativeName: "English (Uganda)" },
  { code: "et", name: "Estonian", nativeName: "Eesti" },
  { code: "fil", name: "Filipino", nativeName: "Filipino" },
  { code: "fi", name: "Finnish", nativeName: "Suomi" },
  { code: "fr", name: "French", nativeName: "Français" },
  {
    code: "fr_BE",
    name: "French (Belgium)",
    nativeName: "Français (Belgique)",
  },
  { code: "fr_CA", name: "French (Canada)", nativeName: "Français (Canada)" },
  {
    code: "fr_CI",
    name: "French (Côte d’Ivoire)",
    nativeName: "Français (Côte d’Ivoire)",
  },
  { code: "fr_MA", name: "French (Morocco)", nativeName: "Français (Maroc)" },
  {
    code: "fr_CH",
    name: "French (Switzerland)",
    nativeName: "Français (Suisse)",
  },
  { code: "ka", name: "Georgian", nativeName: "ქართული" },
  { code: "de", name: "German", nativeName: "Deutsch" },
  {
    code: "de_AT",
    name: "German (Austria)",
    nativeName: "Deutsch (Österreich)",
  },
  {
    code: "de_CH",
    name: "German (Switzerland)",
    nativeName: "Deutsch (Schweiz)",
  },
  { code: "el", name: "Greek", nativeName: "Ελληνικά" },
  { code: "gu", name: "Gujarati", nativeName: "ગુજરાતી" },
  { code: "ha", name: "Hausa", nativeName: "Hausa" },
  { code: "he", name: "Hebrew", nativeName: "עברית" },
  { code: "hi", name: "Hindi", nativeName: "हिन्दी" },
  { code: "hu", name: "Hungarian", nativeName: "Magyar" },
  { code: "id", name: "Indonesian", nativeName: "Bahasa Indonesia" },
  { code: "ga", name: "Irish", nativeName: "Gaeilge" },
  { code: "it", name: "Italian", nativeName: "Italiano" },
  { code: "ja", name: "Japanese", nativeName: "日本語" },
  { code: "kn", name: "Kannada", nativeName: "ಕನ್ನಡ" },
  { code: "rw_RW", name: "Kinyarwanda", nativeName: "Ikinyarwanda" },
  { code: "ko", name: "Korean", nativeName: "한국어" },
  { code: "ky_KG", name: "Kyrgyz", nativeName: "Кыргызча" },
  { code: "lo", name: "Lao", nativeName: "ລາວ" },
  { code: "lv", name: "Latvian", nativeName: "Latviešu" },
  { code: "lt", name: "Lithuanian", nativeName: "Lietuvių" },
  { code: "mk", name: "Macedonian", nativeName: "Македонски" },
  { code: "ms", name: "Malay", nativeName: "Bahasa Melayu" },
  { code: "ml", name: "Malayalam", nativeName: "മലയാളം" },
  { code: "mr", name: "Marathi", nativeName: "मराठी" },
  { code: "nb", name: "Norwegian", nativeName: "Norsk bokmål" },
  { code: "ps_AF", name: "Pashto", nativeName: "پښتو" },
  { code: "fa", name: "Persian", nativeName: "فارسی" },
  { code: "pl", name: "Polish", nativeName: "Polski" },
  {
    code: "pt_BR",
    name: "Portuguese (Brazil)",
    nativeName: "Português (Brasil)",
  },
  {
    code: "pt_PT",
    name: "Portuguese (Portugal)",
    nativeName: "Português (Portugal)",
  },
  { code: "pa", name: "Punjabi", nativeName: "ਪੰਜਾਬੀ" },
  { code: "ro", name: "Romanian", nativeName: "Română" },
  { code: "sr", name: "Serbian", nativeName: "Српски" },
  { code: "si_LK", name: "Sinhala", nativeName: "සිංහල" },
  { code: "sk", name: "Slovak", nativeName: "Slovenčina" },
  { code: "sl", name: "Slovenian", nativeName: "Slovenščina" },
  { code: "es", name: "Spanish", nativeName: "Español" },
  {
    code: "es_AR",
    name: "Spanish (Argentina)",
    nativeName: "Español (Argentina)",
  },
  { code: "es_CL", name: "Spanish (Chile)", nativeName: "Español (Chile)" },
  {
    code: "es_CO",
    name: "Spanish (Colombia)",
    nativeName: "Español (Colombia)",
  },
  {
    code: "es_CR",
    name: "Spanish (Costa Rica)",
    nativeName: "Español (Costa Rica)",
  },
  {
    code: "es_DO",
    name: "Spanish (Dominican Republic)",
    nativeName: "Español (República Dominicana)",
  },
  { code: "es_EC", name: "Spanish (Ecuador)", nativeName: "Español (Ecuador)" },
  {
    code: "es_HN",
    name: "Spanish (Honduras)",
    nativeName: "Español (Honduras)",
  },
  { code: "es_MX", name: "Spanish (Mexico)", nativeName: "Español (México)" },
  { code: "es_PA", name: "Spanish (Panama)", nativeName: "Español (Panamá)" },
  { code: "es_PE", name: "Spanish (Peru)", nativeName: "Español (Perú)" },
  { code: "es_ES", name: "Spanish (Spain)", nativeName: "Español (España)" },
  { code: "es_UY", name: "Spanish (Uruguay)", nativeName: "Español (Uruguay)" },
  { code: "sw", name: "Swahili", nativeName: "Kiswahili" },
  { code: "sv", name: "Swedish", nativeName: "Svenska" },
  { code: "ta", name: "Tamil", nativeName: "தமிழ்" },
  { code: "te", name: "Telugu", nativeName: "తెలుగు" },
  { code: "th", name: "Thai", nativeName: "ไทย" },
  { code: "tr", name: "Turkish", nativeName: "Türkçe" },
  { code: "uk", name: "Ukrainian", nativeName: "Українська" },
  { code: "ur", name: "Urdu", nativeName: "اردو" },
  { code: "vi", name: "Vietnamese", nativeName: "Tiếng Việt" },
  { code: "zu", name: "Zulu", nativeName: "isiZulu" },
] as const;

/**
 * Meta's template languages. `nativeName` is the language's own name, so
 * pickers can search "Русский" too.
 */
export const SUPPORTED_LANGUAGES = [
  ...MAIN_TEMPLATE_LANGUAGES,
  ...OTHER_TEMPLATE_LANGUAGES,
] as const;

/** SUPPORTED_LANGUAGES starts with this many main-market languages. */
export const MAIN_TEMPLATE_LANGUAGE_COUNT = MAIN_TEMPLATE_LANGUAGES.length;

export type WhatsAppTemplateLanguageCode =
  (typeof SUPPORTED_LANGUAGES)[number]["code"];

const SUPPORTED_LANGUAGE_CODES = new Set<string>(
  SUPPORTED_LANGUAGES.map((language) => language.code),
);

const LANGUAGE_CODE_ALIASES: Record<string, WhatsAppTemplateLanguageCode> = {
  ar_SA: "ar",
  de_DE: "de",
  fr_FR: "fr",
  it_IT: "it",
  ja_JP: "ja",
  kk_KZ: "kk",
  ko_KR: "ko",
  ru_RU: "ru",
  tr_TR: "tr",
  uz_UZ: "uz",
};

function normalizeLanguageCodeShape(value: string): string {
  const normalized = value.trim().replace(/-/g, "_");
  const [language, region, ...rest] = normalized.split("_");
  if (!language || rest.length > 0) return normalized;
  if (!region) return language.toLowerCase();
  return `${language.toLowerCase()}_${region.toUpperCase()}`;
}

export function normalizeWhatsAppTemplateLanguageCode(
  value: unknown,
): WhatsAppTemplateLanguageCode | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeLanguageCodeShape(value);
  const canonical = LANGUAGE_CODE_ALIASES[normalized] || normalized;

  return SUPPORTED_LANGUAGE_CODES.has(canonical)
    ? (canonical as WhatsAppTemplateLanguageCode)
    : null;
}

/** Match send/catalog identities without rejecting languages outside the picker. */
export function normalizeWhatsAppTemplateLanguageForSend(
  value: unknown,
): string {
  const supported = normalizeWhatsAppTemplateLanguageCode(value);
  if (supported) return supported.toLowerCase();
  if (typeof value !== "string") return "";

  const normalized = value.trim().replace(/-/g, "_").toLowerCase();
  if (normalized === "kz" || normalized === "kz_kz" || normalized === "kk_kz") {
    return "kk";
  }

  return normalized;
}

export function isSupportedWhatsAppTemplateLanguageCode(
  value: unknown,
): value is WhatsAppTemplateLanguageCode {
  return normalizeWhatsAppTemplateLanguageCode(value) !== null;
}

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Get status badge variant for shadcn Badge component
 */
export function getStatusBadgeVariant(
  status: WhatsAppTemplateStatus,
): "default" | "secondary" | "destructive" | "outline" {
  const metadata = TEMPLATE_STATUS_METADATA[status];
  if (!metadata) return "outline";
  switch (metadata.color) {
    case "green":
      return "default";
    case "yellow":
      return "secondary";
    case "red":
      return "destructive";
    default:
      return "outline";
  }
}

/**
 * Check if template can be edited
 * Approved templates can only be edited 10 times in 30 days or once in 24 hours
 */
export function canEditTemplate(
  status: WhatsAppTemplateStatus,
  lastEditedAt?: Date,
  editCount?: number,
): boolean {
  if (status === "REJECTED" || status === "PAUSED") {
    return true; // Can edit unlimited times
  }
  if (status === "APPROVED") {
    // This would need to check edit history in practice
    // For now, we allow editing but warn about limits
    return true;
  }
  return false;
}
