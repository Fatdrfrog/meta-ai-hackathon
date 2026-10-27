const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  en: "English",
  ru: "Russian",
  kz: "Kazakh",
  uz: "Uzbek",
};

export const SUPPORTED_LANGUAGE_CODES = Object.freeze(
  Object.keys(LANGUAGE_DISPLAY_NAMES)
);

export type WorkspaceLanguageBias = "none" | "kz" | "ru" | "uz";

const GENERIC_ACK_RE = /^(ok|okay|okey|ок|окей|ага|угу|mhm|mm|hmm)$/iu;

export function isGenericAcknowledgementText(message: string): boolean {
  return GENERIC_ACK_RE.test((message || "").trim());
}

export function normalizeLanguageCode(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/-/g, "_").toLowerCase();
}

export function baseLanguage(value: string): string {
  const normalized = normalizeLanguageCode(value);
  if (!normalized) return "";
  const [base] = normalized.split("_");
  return base || "";
}

export function normalizeKBLocale(value: unknown): string {
  const normalized = normalizeLanguageCode(value);
  if (!normalized) return "";
  if (baseLanguage(normalized) === "kk") return "kz";
  return normalized;
}

export function normalizeProductLanguageBase(value: unknown): string {
  const normalized = normalizeLanguageCode(value);
  if (!normalized) return "";
  const base = baseLanguage(normalized);
  if (base === "kk") return "kz";
  return base || normalized;
}

export function getLanguageDisplayName(code: string): string {
  const lang = baseLanguage(code);
  return LANGUAGE_DISPLAY_NAMES[lang] || lang.toUpperCase() || "English";
}

export function getLanguageName(langCode: string): string {
  return getLanguageDisplayName(langCode);
}
