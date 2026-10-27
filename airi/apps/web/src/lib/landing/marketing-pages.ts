import type { MetadataRoute } from "next";
import { locales, type Locale } from "@/i18n/locales";
import { getPublicUrl } from "@/lib/public-seo";
import { createMetadata } from "@/lib/seo";
import { PUBLIC_TEMPLATE_LANGUAGES } from "./public-template-seo";

/** Public product pages, keyed by their message namespace. */
export const MARKETING_PAGES = {
  delivery: "/whatsapp-marketing-delivery",
  metaAds: "/meta-ads-mcp",
  mcp: "/mcp",
} as const;

export type MarketingPageId = keyof typeof MARKETING_PAGES;

export const MARKETING_PAGE_IDS = Object.keys(
  MARKETING_PAGES
) as MarketingPageId[];

export function findMarketingPageByPath(
  path: string
): MarketingPageId | undefined {
  return MARKETING_PAGE_IDS.find(page => MARKETING_PAGES[page] === path);
}

/** Like the template gallery, each language has its own crawlable URL. */
export function getMarketingPagePath(
  page: MarketingPageId,
  locale: Locale
): string {
  const path = MARKETING_PAGES[page];
  return locale === "en" ? path : `${path}?locale=${locale}`;
}

export function getMarketingPageLanguages(page: MarketingPageId) {
  return Object.fromEntries([
    ...locales.map(locale => [
      PUBLIC_TEMPLATE_LANGUAGES[locale].tag,
      getPublicUrl(getMarketingPagePath(page, locale)),
    ]),
    ["x-default", getPublicUrl(getMarketingPagePath(page, "en"))],
  ]);
}

export function createMarketingPageMetadata({
  page,
  locale,
  title,
  description,
}: {
  page: MarketingPageId;
  locale: Locale;
  title: string;
  description: string;
}) {
  return createMetadata({
    title,
    description,
    path: getMarketingPagePath(page, locale),
    languages: getMarketingPageLanguages(page),
    locale: PUBLIC_TEMPLATE_LANGUAGES[locale].og,
    alternateLocales: locales
      .filter(other => other !== locale)
      .map(other => PUBLIC_TEMPLATE_LANGUAGES[other].og),
  });
}

export function getMarketingPageSitemapEntries(
  page: MarketingPageId
): MetadataRoute.Sitemap {
  return locales.map(locale => ({
    url: getPublicUrl(getMarketingPagePath(page, locale)),
    alternates: { languages: getMarketingPageLanguages(page) },
    changeFrequency: "monthly" as const,
    priority: 0.8,
  }));
}
