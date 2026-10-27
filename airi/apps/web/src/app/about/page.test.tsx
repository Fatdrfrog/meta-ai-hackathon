/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import enMessages from "../../../messages/en.json";
import kzMessages from "../../../messages/kz.json";
import ruMessages from "../../../messages/ru.json";
import About from "./page";

const mockGetTranslations = jest.fn();

jest.mock("next-intl/server", () => ({
  getTranslations: (...args: unknown[]) => mockGetTranslations(...args),
}));

jest.mock("@/components/landing/page-header", () => ({
  LandingPageHeader: () => null,
}));

jest.mock("@/components/seo/structured-data", () => ({
  StructuredData: () => null,
}));

// The real viewer reads request cookies, which do not exist outside a request.
jest.mock("@/lib/landing/landing-header-viewer.server", () => ({
  getLandingHeaderViewerForRequest: async () => null,
}));

jest.mock("next/image", () => ({
  __esModule: true,
  default: () => null,
}));

type JsonObject = Record<string, unknown>;

function collectLeafPaths(value: unknown, prefix: string[] = []): string[] {
  if (typeof value === "string") {
    return [prefix.join(".")];
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value as JsonObject).flatMap(([key, child]) =>
    collectLeafPaths(child, [...prefix, key])
  );
}

function getAboutMessages(messages: JsonObject): unknown {
  return (messages.LandingDemo as JsonObject | undefined)?.about;
}

describe("About page localization", () => {
  beforeEach(() => {
    mockGetTranslations.mockResolvedValue((key: string) => {
      const translations: Record<string, string> = {
        "about.title": "Translated about heading",
        "about.teamInfo.title": "Translated team section",
        "about.products.title": "Translated product section",
        "about.ourTeam.title": "Translated our team section",
        "about.ourTeam.join": "Translated join team",
      };

      return translations[key] ?? key;
    });
  });

  afterEach(() => {
    mockGetTranslations.mockReset();
  });

  it("renders visible About page copy from LandingDemo translations", async () => {
    render(await About());

    expect(mockGetTranslations).toHaveBeenCalledWith("LandingDemo");
    expect(
      screen.getByRole("heading", { name: "Translated about heading" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Translated team section" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Translated join team" })
    ).toBeInTheDocument();
  });

  // Regression: the About page promoted an unrelated side project.
  it("does not promote unrelated products", async () => {
    const { container } = render(await About());

    expect(
      container.querySelector('a[href*="slopcollector"]')
    ).not.toBeInTheDocument();
    for (const messages of [enMessages, ruMessages, kzMessages]) {
      expect(JSON.stringify(getAboutMessages(messages))).not.toMatch(
        /SlopCollector/i
      );
    }
  });

  it("keeps About page message keys aligned across supported locales", () => {
    const locales = {
      en: enMessages,
      kz: kzMessages,
      ru: ruMessages,
    };
    const expectedPaths = collectLeafPaths(getAboutMessages(enMessages));

    expect(expectedPaths.length).toBeGreaterThan(0);

    for (const messages of Object.values(locales)) {
      expect(collectLeafPaths(getAboutMessages(messages))).toEqual(
        expectedPaths
      );
      expect(getAboutMessages(messages)).toBeDefined();
    }
  });
});
