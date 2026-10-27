import { Children, type ReactElement } from "react";
import { existsSync } from "node:fs";
import { join } from "node:path";
import WhatsAppTemplatesPage, {
  generateMetadata as galleryMetadata,
} from "./page";
import WhatsAppTemplatePage, {
  generateMetadata as detailMetadata,
} from "./[templateId]/page";

jest.mock("server-only", () => ({}));
let mockCookieLocale = "en";
jest.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: mockCookieLocale }) }),
}));
// Reuse the catalog suite's ESM bridge: formatter and messages are real, while
// Jest's CJS next-intl mapping cannot import the ESM library directly.
jest.mock("next-intl", () => ({
  NextIntlClientProvider: () => null,
  createTranslator: ({
    locale,
    messages,
  }: {
    locale: string;
    messages: unknown;
  }) => {
    const { execFileSync } = jest.requireActual("node:child_process");
    const formatted = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import { readFileSync } from "node:fs";
        import { createTranslator } from "next-intl";
        const { locale, messages } = JSON.parse(readFileSync(0, "utf8"));
        const translate = createTranslator({ locale, messages, onError() {} });
        const formatted = {};
        function visit(value, prefix = '') {
          for (const [key, message] of Object.entries(value)) {
            const path = prefix ? prefix + '.' + key : key;
            if (typeof message === 'string') formatted[path] = translate(path);
            else if (message && typeof message === 'object') visit(message, path);
          }
        }
        visit({ LandingDemo: messages.LandingDemo });
        process.stdout.write(JSON.stringify(formatted));
      `,
        ],
        {
          cwd: process.cwd(),
          input: JSON.stringify({ locale, messages }),
          encoding: "utf8",
          windowsHide: true,
        }
      )
    ) as Record<string, string>;
    return (key: string) => {
      if (!(key in formatted))
        throw new Error(`Missing real translation: ${key}`);
      return formatted[key];
    };
  },
}));
jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("404");
  },
}));
jest.mock("@/lib/landing/landing-header-viewer.server", () => ({
  getLandingHeaderViewerForRequest: async () => ({ isAuthenticated: false }),
}));
jest.mock("@/components/landing/landing-display-font", () => ({
  landingDisplayFont: { variable: "display-font" },
}));
jest.mock("@/components/landing/template-marketplace", () => ({
  TemplateMarketplace: () => null,
}));

describe("public template routes", () => {
  it("keeps public template HTML outside inherited loading boundaries while the panel retains one", () => {
    for (const boundary of [
      "../loading.tsx",
      "loading.tsx",
      "[templateId]/loading.tsx",
    ]) {
      expect(existsSync(join(__dirname, boundary))).toBe(false);
    }
    expect(existsSync(join(__dirname, "../panel/loading.tsx"))).toBe(true);
  });

  it.each(["en", "ru", "kz"])(
    "uses the explicit %s URL locale in metadata, visible content and scoped provider",
    async locale => {
      mockCookieLocale = locale === "en" ? "ru" : "en";
      const { getLocaleFromCookie } = await import("@/i18n/message-loader");
      expect(await getLocaleFromCookie()).toBe(mockCookieLocale);
      const messages = jest.requireActual(`../../../messages/${locale}.json`);
      const searchParams = Promise.resolve({ locale });
      const gallery = await WhatsAppTemplatesPage({ searchParams });
      expect(gallery.props.lang).toBe(locale === "kz" ? "kk" : locale);
      const provider = Children.toArray(
        gallery.props.children
      )[1] as ReactElement<{ locale: string; messages: unknown }>;
      expect(provider.props.locale).toBe(locale);
      expect(provider.props.messages).toMatchObject({
        LandingDemo: messages.LandingDemo,
      });
      const metadata = await galleryMetadata({ searchParams });
      expect(metadata.title).toBe(messages.LandingDemo.templates.seo.title);
      const schema = Children.toArray(
        gallery.props.children
      )[0] as ReactElement<{ data: { name: string; description: string } }>;
      expect(schema.props.data.name).toBe(
        messages.LandingDemo.templates.seo.title
      );
      expect(schema.props.data.description).toBe(
        messages.LandingDemo.templates.seo.description
      );
      expect(metadata.alternates?.canonical).toBe(
        `https://www.airi.chat/whatsapp-templates${locale === "en" ? "" : `?locale=${locale}`}`
      );
      const params = Promise.resolve({ templateId: "quote-ready" });
      const detail = await WhatsAppTemplatePage({ params, searchParams });
      expect(detail.props.lang).toBe(locale === "kz" ? "kk" : locale);
      expect((await detailMetadata({ params, searchParams })).description).toBe(
        messages.LandingDemo.templates.catalog["quote-ready"].description
      );
      expect(
        (await detailMetadata({ params, searchParams })).alternates?.canonical
      ).toBe(
        `https://www.airi.chat/whatsapp-templates/quote-ready${locale === "en" ? "" : `?locale=${locale}`}`
      );
    }
  );

  it("keeps the unqualified canonical URL English independently of cookie preferences", async () => {
    mockCookieLocale = "kz";
    const page = await WhatsAppTemplatesPage({
      searchParams: Promise.resolve({}),
    });
    expect(page.props.lang).toBe("en");
    const metadata = await galleryMetadata({
      searchParams: Promise.resolve({ locale: ["ru", "kz"] }),
    });
    expect(metadata.alternates?.canonical).toBe(
      "https://www.airi.chat/whatsapp-templates"
    );
    const messages = jest.requireActual("../../../messages/en.json");
    expect(metadata.title).toBe(messages.LandingDemo.templates.seo.title);
  });

  it("returns 404 for an unknown template instead of rendering an empty success page", async () => {
    const props = {
      params: Promise.resolve({ templateId: "does-not-exist" }),
      searchParams: Promise.resolve({ locale: "ru" }),
    };
    await expect(WhatsAppTemplatePage(props)).rejects.toThrow("404");
    await expect(detailMetadata(props)).rejects.toThrow("404");
  });
});
