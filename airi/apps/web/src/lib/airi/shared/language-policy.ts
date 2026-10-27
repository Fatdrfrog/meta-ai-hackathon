import {
  CONVERSATION_PREFERRED_LANGUAGES,
  type ConversationPreferredLanguage,
} from "@icecore/shared/types/conversation";

import {
  getLanguageDisplayName,
  normalizeProductLanguageBase,
} from "@/lib/airi/language-detector";

export const AIRI_LANGUAGES =
  CONVERSATION_PREFERRED_LANGUAGES satisfies readonly ConversationPreferredLanguage[];

export type AiriLanguage = (typeof AIRI_LANGUAGES)[number];

export const LANGUAGE_INSTRUCTIONS: Record<AiriLanguage, string> = {
  en: "ABSOLUTE REQUIREMENT: Generate all text fields (summary, action, overall_comment) in English ONLY. Do not use any other language.",
  ru: "ОБЯЗАТЕЛЬНОЕ ТРЕБОВАНИЕ: Сгенерируй все текстовые поля (summary, action, overall_comment) ТОЛЬКО на русском языке. Использование других языков запрещено.",
  kz: "АБСОЛЮТТЫ ТАЛАП: Барлық мәтін өрістерін (summary, action, overall_comment) ТЕК қазақ тілінде жасаңыз. Басқа тілдерді пайдалануға болмайды.",
  uz: "MUTLAQ TALAB: Barcha matn maydonlarini (summary, action, overall_comment) FAQAT o'zbek tilida yarating. Boshqa tillardan foydalanish qat'iyan man etiladi.",
};

export const SUMMARY_LANGUAGE_INSTRUCTIONS: Record<AiriLanguage, string> = {
  en: "CRITICAL: Write the summary in English ONLY. This is mandatory.",
  ru: "КРИТИЧЕСКИ ВАЖНО: Напиши резюме ТОЛЬКО на русском языке. Это обязательное условие.",
  kz: "ӨТЕ МАҢЫЗДЫ: Қорытындыны ТЕК қазақ тілінде жазыңыз. Бұл міндетті талап.",
  uz: "O'TA MUHIM: Xulosani FAQAT o'zbek tilida yozing. Bu majburiy shart.",
};

const AIRI_LANGUAGE_SET = new Set<string>(AIRI_LANGUAGES);

const RESPONSE_LANGUAGE_INSTRUCTIONS: Record<AiriLanguage, string> = {
  en: "Answer in English.",
  ru: "Отвечай на русском языке.",
  kz: "Жауапты қазақ тілінде бер.",
  uz: "Javobni o'zbek tilida bering.",
};

export function isAiriLanguage(value: unknown): value is AiriLanguage {
  return typeof value === "string" && AIRI_LANGUAGE_SET.has(value);
}

export function normalizeAiriLanguage(
  value: unknown,
  fallback: AiriLanguage = "en"
): AiriLanguage {
  const base = normalizeProductLanguageBase(value);
  if (!base) return fallback;
  return isAiriLanguage(base) ? base : fallback;
}

export function getAiriLanguageName(language: AiriLanguage): string {
  return getLanguageDisplayName(language);
}

export function getAiriResponseLanguageInstruction(
  language: AiriLanguage
): string {
  return RESPONSE_LANGUAGE_INSTRUCTIONS[language];
}
