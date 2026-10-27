/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import en from "../../../messages/marketing/en/page.json";
import kz from "../../../messages/marketing/kz/page.json";
import ru from "../../../messages/marketing/ru/page.json";
import { MarketingPage } from "./marketing-page";

const catalogs = { en, ru, kz };

jest.mock("next-intl", () => ({
  NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock("@/i18n/message-loader", () => ({
  loadMarketingPageMessages: async (locale: "en" | "ru" | "kz") =>
    ({
      en: jest.requireActual("../../../messages/marketing/en/page.json"),
      ru: jest.requireActual("../../../messages/marketing/ru/page.json"),
      kz: jest.requireActual("../../../messages/marketing/kz/page.json"),
    })[locale],
}));
jest.mock("@/lib/landing/landing-header-viewer.server", () => ({
  getLandingHeaderViewerForRequest: async () => null,
}));
jest.mock("@/lib/landing/public-template-page-context.server", () => ({
  getPublicTemplatePageContext: async () => ({
    messages: {},
    translate: (key: string) => key,
  }),
}));
jest.mock("./page-header", () => ({ LandingPageHeader: () => null }));
jest.mock("./landing-footer", () => ({ LandingFooter: () => null }));
jest.mock("./landing-display-font", () => ({
  landingDisplayFont: { variable: "landing-display-font" },
}));

const pages = ["delivery", "metaAds", "mcp"] as const;
const locales = ["en", "ru", "kz"] as const;

describe("product pages", () => {
  it.each(
    pages.flatMap(page => locales.map(locale => [page, locale] as const))
  )("renders every %s section and answer in %s", async (page, locale) => {
    const copy = catalogs[locale].MarketingPages[page];
    render(await MarketingPage({ page, locale }));

    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      copy.hero.title
    );
    expect(screen.getByRole("main")).toHaveAttribute(
      "lang",
      locale === "kz" ? "kk" : locale
    );
    for (const item of Object.values(copy.faq.items)) {
      expect(screen.getByText(item.question)).toBeInTheDocument();
      expect(screen.getByText(item.answer)).toBeInTheDocument();
    }
    const jsonLd = [
      ...document.querySelectorAll('script[type="application/ld+json"]'),
    ]
      .map(script => script.textContent)
      .join("\n");
    expect(jsonLd).toContain('"FAQPage"');
    expect(jsonLd).toContain(copy.seo.title);
  });

  it("lists every documented Meta error code with what happens next", async () => {
    render(await MarketingPage({ page: "delivery", locale: "en" }));

    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(
      rows.slice(1).map(row => row.querySelector("th")?.textContent)
    ).toEqual([
      "131049",
      "131050",
      "131026",
      "131047",
      "130429",
      "131042",
      "131063",
      "132000 / 132012",
    ]);
  });

  it("gives working client configuration for Claude Code, Codex and Cursor", async () => {
    render(await MarketingPage({ page: "mcp", locale: "en" }));

    const configs = [...document.querySelectorAll("pre code")].map(
      code => code.textContent ?? ""
    );
    expect(configs).toHaveLength(3);
    expect(
      configs.every(config => config.includes("https://www.airi.chat/api/mcp"))
    ).toBe(true);
    expect(configs[0]).toContain("claude mcp add --transport http airi");
    expect(configs[1]).toContain('bearer_token_env_var = "AIRI_API_KEY"');
    expect(configs[2]).toContain('"Bearer ${env:AIRI_API_KEY}"');
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  // The pages are marketing for real behaviour; keep promises out of the copy.
  it.each(locales)("makes no delivery guarantees in %s", locale => {
    const copy = JSON.stringify(catalogs[locale]);

    expect(copy).not.toMatch(/guarantee|гарант|кепілдік|\d+\s?%/i);
  });
});
