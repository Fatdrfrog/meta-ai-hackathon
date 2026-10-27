import type { MetadataRoute } from "next";
import { DEFAULT_LOCALE, isLocale, locales } from "@/i18n/locales";
import { getPublicUrl } from "@/lib/public-seo";
import { createMetadata } from "@/lib/seo";
import {
  PUBLIC_TEMPLATES,
  filterPublicTemplates,
  getPublicTemplateFilters,
  getPublicTemplateText,
  isPublicTemplateAvailableInLocale,
  type PublicTemplate,
} from "./public-template-catalog";
import type { PublicTemplateLocale } from "./template-request";

export type PublicTemplateSearchParams = Record<
  string,
  string | string[] | undefined
>;

export const PUBLIC_TEMPLATE_LANGUAGES = {
  en: { tag: "en", name: "English", og: "en_US" },
  ru: { tag: "ru", name: "Русский", og: "ru_RU" },
  kz: { tag: "kk", name: "Қазақша", og: "kk_KZ" },
} as const;

/** Canonical public URLs must render the same language without cookies. */
export function resolvePublicTemplateLocale(
  params: PublicTemplateSearchParams = {}
): PublicTemplateLocale {
  const locale = params.locale;
  return typeof locale === "string" && isLocale(locale)
    ? locale
    : DEFAULT_LOCALE;
}

export function getPublicTemplatePath(
  locale: PublicTemplateLocale,
  templateId?: string
): string {
  const path = `/whatsapp-templates${templateId ? `/${encodeURIComponent(templateId)}` : ""}`;
  return locale === "en" ? path : `${path}?locale=${locale}`;
}

export function getPublicTemplateLanguages(template?: PublicTemplate) {
  const available = locales.filter(
    locale => !template || isPublicTemplateAvailableInLocale(template, locale)
  );
  return Object.fromEntries([
    ...available.map(locale => [
      PUBLIC_TEMPLATE_LANGUAGES[locale].tag,
      getPublicUrl(getPublicTemplatePath(locale, template?.id)),
    ]),
    [
      "x-default",
      getPublicUrl(
        getPublicTemplatePath(
          available.includes("en") ? "en" : (available[0] ?? "en"),
          template?.id
        )
      ),
    ],
  ]);
}

export function createPublicTemplateMetadata({
  locale,
  translate,
  template,
  searchParams = {},
}: {
  locale: PublicTemplateLocale;
  translate: (key: string) => string;
  template?: PublicTemplate;
  searchParams?: PublicTemplateSearchParams;
}) {
  const title = template
    ? `${getPublicTemplateText(template, "title", translate)} | ${translate("LandingDemo.templates.seo.detailTitle")}`
    : translate("LandingDemo.templates.seo.title");
  const description = template
    ? getPublicTemplateText(template, "description", translate)
    : translate("LandingDemo.templates.seo.description");
  const filtered = ["q", "industry", "goal", "format", "useCase"].some(key =>
    Boolean(searchParams[key])
  );
  return createMetadata({
    title,
    description,
    path: getPublicTemplatePath(locale, template?.id),
    languages: getPublicTemplateLanguages(template),
    locale: PUBLIC_TEMPLATE_LANGUAGES[locale].og,
    alternateLocales: locales
      .filter(
        other =>
          other !== locale &&
          (!template || isPublicTemplateAvailableInLocale(template, other))
      )
      .map(other => PUBLIC_TEMPLATE_LANGUAGES[other].og),
    ...(filtered ? { robots: { index: false, follow: true } } : {}),
  });
}

export function getPublicTemplateSitemapEntries(): MetadataRoute.Sitemap {
  return locales.flatMap(locale => [
    {
      url: getPublicUrl(getPublicTemplatePath(locale)),
      alternates: { languages: getPublicTemplateLanguages() },
      changeFrequency: "weekly" as const,
      priority: 0.9,
    },
    ...PUBLIC_TEMPLATES.filter(template =>
      isPublicTemplateAvailableInLocale(template, locale)
    ).map(template => ({
      url: getPublicUrl(getPublicTemplatePath(locale, template.id)),
      alternates: { languages: getPublicTemplateLanguages(template) },
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
  ]);
}

/** Structured data describes the same visible examples, without delivery claims. */
export function createPublicTemplateSchema({
  locale,
  translate,
  template,
  searchParams = {},
}: {
  locale: PublicTemplateLocale;
  translate: (key: string) => string;
  template?: PublicTemplate;
  searchParams?: PublicTemplateSearchParams;
}) {
  const url = getPublicUrl(getPublicTemplatePath(locale, template?.id));
  const metadata = createPublicTemplateMetadata({
    locale,
    translate,
    template,
  });
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") params.set(key, value);
    else if (Array.isArray(value) && typeof value[0] === "string")
      params.set(key, value[0]);
  }
  const examples = filterPublicTemplates(
    getPublicTemplateFilters(params),
    translate,
    locale
  );
  return {
    "@context": "https://schema.org",
    "@type": template ? "WebPage" : "CollectionPage",
    "@id": `${url}#page`,
    url,
    name: metadata.title,
    description: metadata.description,
    inLanguage: PUBLIC_TEMPLATE_LANGUAGES[locale].tag,
    isPartOf: { "@id": `${getPublicUrl()}/#website` },
    mainEntity: template
      ? {
          "@type": "CreativeWork",
          name: getPublicTemplateText(template, "title", translate),
          description: getPublicTemplateText(
            template,
            "description",
            translate
          ),
          text: getPublicTemplateText(template, "body", translate),
          inLanguage: PUBLIC_TEMPLATE_LANGUAGES[locale].tag,
          url,
          genre: translate(`LandingDemo.templates.formats.${template.format}`),
        }
      : {
          "@type": "ItemList",
          numberOfItems: examples.length,
          itemListElement: examples.map((example, index) => ({
            "@type": "ListItem",
            position: index + 1,
            name: getPublicTemplateText(example, "title", translate),
            url: getPublicUrl(getPublicTemplatePath(locale, example.id)),
          })),
        },
  };
}
