import { DEFAULT_LOCALE } from "@/i18n/locales";

// Recipient languages come from account metadata and the workspace's Airi
// language, which still include Uzbek although it is no longer an interface
// locale.
export const EMAIL_CAMPAIGN_LOCALES = ["en", "ru", "kz", "uz"] as const;
export type EmailCampaignLocale = (typeof EMAIL_CAMPAIGN_LOCALES)[number];
export const DEFAULT_EMAIL_CAMPAIGN_LOCALE: EmailCampaignLocale =
  DEFAULT_LOCALE;

export const EMAIL_CAMPAIGN_LOCALE_LABELS: Record<EmailCampaignLocale, string> =
  {
    en: "English",
    ru: "Russian",
    kz: "Kazakh",
    uz: "Uzbek",
  };

const EMAIL_CAMPAIGN_LOCALE_ALIASES: Record<string, EmailCampaignLocale> = {
  en: "en",
  eng: "en",
  english: "en",
  ru: "ru",
  rus: "ru",
  russian: "ru",
  kz: "kz",
  kk: "kz",
  kaz: "kz",
  kazakh: "kz",
  uz: "uz",
  uzb: "uz",
  uzbek: "uz",
};

export function normalizeEmailCampaignLocale(
  value: unknown
): EmailCampaignLocale | null {
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return null;

  const direct = EMAIL_CAMPAIGN_LOCALE_ALIASES[normalized];
  if (direct) return direct;

  const primarySubtag = normalized.split("-")[0];
  return EMAIL_CAMPAIGN_LOCALE_ALIASES[primarySubtag] || null;
}
