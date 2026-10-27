/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { LandingPageHeader } from "./page-header";

let mockLocale = "en";

jest.mock("next/navigation", () => ({
  usePathname: () => "/airichat/kb/get-started",
}));

jest.mock("next-intl", () => ({
  useLocale: () => mockLocale,
  useTranslations: (namespace: string) => (key: string) => {
    const messages: Record<string, Record<string, string>> = {
      LandingDemo: {
        "header.signIn": "Sign in",
        "header.startFree": "Start free",
        "header.bookDemo": "Book a demo",
        "header.navigation": "Explore campaigns",
        "header.openMenu": "Open menu",
        "header.resources": "Материалы",
        "header.close": "Закрыть",
        "header.openResources": "Открыть материалы",
        "header.closeResources": "Закрыть материалы",
        "header.nav.pricing": "Pricing",
        "header.nav.about": "About",
        "templates.navigation": "Templates",
        "bulkCampaigns.caseStudiesCta": "Epic stories",
        "bulkCampaigns.caseStudiesUrl":
          "https://www.airi.chat/airichat/kb/8dd3d577-cdb6-4f59-9b15-58e8dc7cefc3",
        "bulkCampaigns.guideLabels.official": "Setup guide",
        "bulkCampaigns.featureLinks.official":
          "https://www.airi.chat/airichat/kb/2ae58487-39a7-4182-8455-f3e041db18b4",
        "bulkCampaigns.guideLabels.noBlocks": "Safety guide",
        "bulkCampaigns.featureLinks.noBlocks":
          "https://www.airi.chat/airichat/kb/2e70b7f0-96f0-4844-a87b-74ce7f147f37",
      },
      LandingPage: {
        "header.openWorkspace": "Open workspace",
      },
    };

    return messages[namespace]?.[key] ?? key;
  },
}));

jest.mock("framer-motion", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    motion: new Proxy(
      {},
      {
        get:
          (_target, tag: string) =>
          ({
            children,
            initial: _initial,
            animate: _animate,
            transition: _transition,
            ...props
          }: {
            children: React.ReactNode;
            initial?: unknown;
            animate?: unknown;
            transition?: unknown;
          }) =>
            React.createElement(tag, props, children),
      }
    ),
    useReducedMotion: () => true,
  };
});

jest.mock("@/components/settings/language-switcher", () => ({
  LanguageSwitcher: () => <button type="button">Language</button>,
}));

jest.mock("@/components/settings/theme-switcher", () => ({
  ThemeSwitcher: () => <button type="button">Theme</button>,
}));

jest.mock("@/components/ui/sheet", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const passthrough = ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  );

  return {
    Sheet: passthrough,
    SheetContent: passthrough,
    SheetDescription: ({ children }: { children: React.ReactNode }) => (
      <p>{children}</p>
    ),
    SheetTitle: ({ children }: { children: React.ReactNode }) => (
      <h2>{children}</h2>
    ),
    SheetTrigger: passthrough,
  };
});

describe("LandingPageHeader", () => {
  const demoHref = "https://calendar.app.google/iT6L4Vr6L3ma4WY5A";
  beforeEach(() => {
    mockLocale = "en";
  });

  it.each(["en", "ru", "kz"] as const)(
    "keeps the landing's %s locale when browsing templates",
    locale => {
      mockLocale = locale;
      render(<LandingPageHeader />);
      expect(screen.getByRole("link", { name: "Templates" })).toHaveAttribute(
        "href",
        `/whatsapp-templates${locale === "en" ? "" : `?locale=${locale}`}`
      );
    }
  );

  it.each(["en", "ru", "kz"] as const)(
    "prefers the explicit %s page locale over a different cookie locale",
    locale => {
      mockLocale = locale === "en" ? "ru" : "en";
      render(<LandingPageHeader languageSwitcherActiveLocale={locale} />);
      expect(screen.getByRole("link", { name: "Templates" })).toHaveAttribute(
        "href",
        `/whatsapp-templates${locale === "en" ? "" : `?locale=${locale}`}`
      );
    }
  );

  it("shows only workspace entry instead of marketing actions for authenticated docs viewers", () => {
    render(
      <LandingPageHeader
        variant="docs"
        leadingSlot={
          <button type="button" aria-label="Open docs navigation">
            Open
          </button>
        }
        viewer={{
          isAuthenticated: true,
          panelHref: "/panel",
        }}
      />
    );

    expect(
      screen.getByRole("button", { name: "Open docs navigation" })
    ).toBeInTheDocument();
    expect(screen.queryByText("Sign in")).not.toBeInTheDocument();
    expect(screen.queryByText("Start free")).not.toBeInTheDocument();
    expect(screen.queryByText("Book a demo")).not.toBeInTheDocument();
    expect(screen.queryByText("Pricing")).not.toBeInTheDocument();
    expect(screen.queryByText("About")).not.toBeInTheDocument();

    const panelLinks = screen.getAllByRole("link", {
      name: "Open workspace",
    });
    expect(panelLinks.length).toBeGreaterThan(0);
    for (const link of panelLinks) {
      expect(link).toHaveAttribute("href", "/panel");
    }
  });

  it("keeps account, demo and language actions without a top menu", () => {
    render(<LandingPageHeader />);

    expect(screen.getAllByText("Sign in").length).toBeGreaterThan(0);
    expect(screen.queryByText("Theme")).not.toBeInTheDocument();
    expect(screen.queryByText("Explore campaigns")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Открыть материалы" })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Материалы")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Language" }).length
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Resources")).not.toBeInTheDocument();
    for (const name of ["Epic stories", "Setup guide", "Safety guide"])
      expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
    expect(document.querySelector('a[href*="/airichat/kb/"]')).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Pricing" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "About" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start free" })).toHaveAttribute(
      "href",
      "/login?tab=signup"
    );
    const demoLinks = screen.getAllByRole("link", { name: "Book a demo" });
    expect(demoLinks.length).toBeGreaterThan(0);
    for (const link of demoLinks) {
      expect(link).toHaveAttribute("href", demoHref);
    }
  });

  it("hides signup actions for known unauthenticated visitors", () => {
    render(
      <LandingPageHeader
        viewer={{ isAuthenticated: false, hasKnownAccount: true }}
      />
    );

    expect(screen.getAllByText("Sign in").length).toBeGreaterThan(0);
    expect(screen.queryByText("Start free")).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Book a demo" }).length).toBe(1);
  });

  it("connects the public landing to the template gallery without changing docs navigation", () => {
    const { rerender } = render(<LandingPageHeader />);
    expect(screen.getByRole("link", { name: "Templates" })).toHaveAttribute(
      "href",
      "/whatsapp-templates"
    );
    rerender(<LandingPageHeader variant="docs" />);
    expect(
      screen.queryByRole("link", { name: "Templates" })
    ).not.toBeInTheDocument();
  });
});
