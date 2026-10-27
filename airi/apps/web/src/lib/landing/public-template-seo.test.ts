import en from "../../../messages/en.json";
import ru from "../../../messages/ru.json";
import kz from "../../../messages/kz.json";
import { getPublicTemplate } from "./public-template-catalog";
import {
  createPublicTemplateMetadata,
  createPublicTemplateSchema,
  getPublicTemplateSitemapEntries,
  getPublicTemplateLanguages,
  resolvePublicTemplateLocale,
  type PublicTemplateSearchParams,
} from "./public-template-seo";

const messages = { en, ru, kz };

function createTranslator({ messages }: { locale: string; messages: unknown }) {
  return (key: string): string => {
    const result = key
      .split(".")
      .reduce<unknown>(
        (value, part) => (value as Record<string, unknown>)[part],
        messages
      );
    if (typeof result !== "string")
      throw new Error(`Missing translation: ${key}`);
    return result;
  };
}

describe("public template SEO", () => {
  it("never advertises an unavailable locale or an English default that would 404", () => {
    const template = {
      ...getPublicTemplate("welcome")!,
      locales: ["ru"] as const,
    };
    expect(getPublicTemplateLanguages(template)).toEqual({
      ru: "https://www.airi.chat/whatsapp-templates/welcome?locale=ru",
      "x-default": "https://www.airi.chat/whatsapp-templates/welcome?locale=ru",
    });
  });
  it.each<Array<[PublicTemplateSearchParams, string]>[number]>([
    [{}, "en"],
    [{ locale: "ru" }, "ru"],
    [{ locale: "kz" }, "kz"],
    [{ locale: "en" }, "en"],
    [{ locale: "kk" }, "en"],
    [{ locale: "../../ru" }, "en"],
    [{ locale: ["ru", "kz"] }, "en"],
  ])("uses a stable validated URL locale for %j", (query, expected) => {
    expect(resolvePublicTemplateLocale(query)).toBe(expected);
  });

  it.each(["en", "ru", "kz"] as const)(
    "publishes matching localized metadata and reciprocal language URLs in %s",
    locale => {
      const translate = createTranslator({
        locale,
        messages: messages[locale],
      });
      const metadata = createPublicTemplateMetadata({ locale, translate });
      const suffix = locale === "en" ? "" : `?locale=${locale}`;
      expect(metadata.title).toBe(
        messages[locale].LandingDemo.templates.seo.title
      );
      expect(metadata.alternates).toEqual({
        canonical: `https://www.airi.chat/whatsapp-templates${suffix}`,
        languages: {
          en: "https://www.airi.chat/whatsapp-templates",
          ru: "https://www.airi.chat/whatsapp-templates?locale=ru",
          kk: "https://www.airi.chat/whatsapp-templates?locale=kz",
          "x-default": "https://www.airi.chat/whatsapp-templates",
        },
      });
      expect(metadata.openGraph?.url).toBe(metadata.alternates?.canonical);
      expect(metadata.openGraph?.locale).toBe(
        { en: "en_US", ru: "ru_RU", kz: "kk_KZ" }[locale]
      );
      expect(metadata.robots).toMatchObject({ index: true, follow: true });
      const schema = createPublicTemplateSchema({ locale, translate });
      expect(schema["@type"]).toBe("CollectionPage");
      expect(schema.inLanguage).toBe(locale === "kz" ? "kk" : locale);
      expect(schema.mainEntity).toMatchObject({ numberOfItems: 62 });
    }
  );

  it("canonicalizes filtered/search/tracking URLs without indexing crawl traps", () => {
    const translate = createTranslator({ locale: "ru", messages: ru });
    const searchParams = {
      locale: "ru",
      q: "zz-never-matches",
      format: "text",
      utm_source: "newsletter",
    };
    const metadata = createPublicTemplateMetadata({
      locale: "ru",
      translate,
      searchParams,
    });
    expect(metadata.alternates?.canonical).toBe(
      "https://www.airi.chat/whatsapp-templates?locale=ru"
    );
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(
      createPublicTemplateSchema({ locale: "ru", translate, searchParams })
        .mainEntity
    ).toMatchObject({ numberOfItems: 0, itemListElement: [] });
    expect(
      createPublicTemplateMetadata({
        locale: "ru",
        translate,
        searchParams: { utm_source: "newsletter" },
      }).robots
    ).toMatchObject({ index: true });
  });

  it("uses the actual translated complete example in detail metadata/schema", () => {
    const translate = createTranslator({ locale: "kz", messages: kz });
    const template = getPublicTemplate("quote-ready", "kz")!;
    const metadata = createPublicTemplateMetadata({
      locale: "kz",
      translate,
      template,
    });
    expect(metadata.title).toContain(
      kz.LandingDemo.templates.catalog["quote-ready"].title
    );
    expect(metadata.description).toBe(
      kz.LandingDemo.templates.catalog["quote-ready"].description
    );
    expect(metadata.alternates?.canonical).toBe(
      "https://www.airi.chat/whatsapp-templates/quote-ready?locale=kz"
    );
    expect(
      createPublicTemplateSchema({ locale: "kz", translate, template })
        .mainEntity
    ).toMatchObject({
      "@type": "CreativeWork",
      text: kz.LandingDemo.templates.catalog["quote-ready"].body,
      inLanguage: "kk",
    });
  });

  it("canonicalizes use-case browse URLs and includes only matching examples in schema", () => {
    const translate = createTranslator({ locale: "en", messages: en });
    const searchParams = { useCase: "contacts" };
    const metadata = createPublicTemplateMetadata({
      locale: "en",
      translate,
      searchParams,
    });
    expect(metadata.alternates?.canonical).toBe(
      "https://www.airi.chat/whatsapp-templates"
    );
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(
      createPublicTemplateSchema({ locale: "en", translate, searchParams })
        .mainEntity
    ).toMatchObject({ numberOfItems: 6 });
  });

  it("lists only 189 canonical gallery/example locale URLs without invented change dates", () => {
    const entries = getPublicTemplateSitemapEntries();
    expect(entries).toHaveLength(189);
    expect(new Set(entries.map(entry => entry.url)).size).toBe(189);
    expect(
      entries.filter(entry => entry.url.includes("?locale=ru"))
    ).toHaveLength(63);
    expect(
      entries.filter(entry => entry.url.includes("?locale=kz"))
    ).toHaveLength(63);
    for (const entry of entries) {
      expect(entry.lastModified).toBeUndefined();
      expect(entry.url).not.toMatch(/locale=en|q=|industry=|format=/);
      const alternates = entry.alternates?.languages;
      expect(alternates).toHaveProperty("en");
      expect(alternates).toHaveProperty("ru");
      expect(alternates).toHaveProperty("kk");
      expect(Object.values(alternates ?? {})).toContain(entry.url);
    }
  });
});
