import "server-only";

import { normalizeProductLanguageBase } from "@/lib/airi/language-detector";

const DEFAULT_FLOW_REPLY_CTA_BY_LANGUAGE: Record<string, string> = {
  en: "Open flow",
  ru: "Открыть форму",
  kz: "Форманы ашу",
  uz: "Formani ochish",
};

const DEFAULT_LINK_CTA_BY_LANGUAGE: Record<string, string> = {
  en: "Open link",
  ru: "Открыть ссылку",
  kz: "Сілтемені ашу",
  uz: "Havolani ochish",
};

function normalizeScenarioCopyLanguage(
  value: string | null | undefined
): string {
  return normalizeProductLanguageBase(value) || "en";
}

function resolveDefaultScenarioFlowReplyCta(
  targetLanguage?: string | null
): string {
  return (
    DEFAULT_FLOW_REPLY_CTA_BY_LANGUAGE[
      normalizeScenarioCopyLanguage(targetLanguage)
    ] || DEFAULT_FLOW_REPLY_CTA_BY_LANGUAGE.en
  );
}

function resolveDefaultScenarioLinkCta(targetLanguage?: string | null): string {
  return (
    DEFAULT_LINK_CTA_BY_LANGUAGE[
      normalizeScenarioCopyLanguage(targetLanguage)
    ] || DEFAULT_LINK_CTA_BY_LANGUAGE.en
  );
}

export {
  resolveDefaultScenarioFlowReplyCta,
  resolveDefaultScenarioLinkCta,
  normalizeScenarioCopyLanguage,
};
