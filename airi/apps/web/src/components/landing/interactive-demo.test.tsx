/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { LandingHeaderViewer } from "@/lib/landing/landing-header-viewer";
import { InteractiveDemoLanding } from "./interactive-demo";

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: (
    _loader: () => Promise<unknown>,
    options?: { loading?: () => ReactNode }
  ) =>
    function DynamicMock() {
      const Loading = options?.loading;
      return Loading ? <Loading /> : null;
    },
}));

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: (namespace: string) => (key: string) => {
    const messages: Record<string, Record<string, string>> = {
      LandingDemo: {
        "header.signIn": "Sign in",
        "header.bookDemo": "Book a demo",
        "header.startFree": "Start free",
        "hero.startFree": "Start free",
        "hero.bookDemo": "Book a demo",
        "hero.connectWaba": "Connect WABA",
        "hero.title": "Airi campaign flow",
        "hero.titleAccent": "conversation.",
        "hero.subtitle": "Launch campaigns and follow-ups from one workspace.",
        "hero.subtitleSecondary":
          "Segmented broadcasts, promos, and reminders across every chat.",
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

jest.mock("@/components/settings/language-switcher", () => ({
  LanguageSwitcher: () => <button type="button">Language</button>,
}));

jest.mock("@/components/settings/theme-switcher", () => ({
  ThemeSwitcher: () => <button type="button">Theme</button>,
}));

jest.mock("./sources-section", () => ({
  SourcesSection: () => <section data-testid="landing-sources-section" />,
}));

jest.mock("./landing-below-fold", () => ({
  LandingBelowFold: () => <section data-testid="landing-below-fold" />,
}));

jest.mock("./hero-feature-cards", () => ({
  HeroFeatureCards: () => <div data-testid="hero-feature-cards" />,
}));

jest.mock("./hero-demo-cta", () => ({
  HeroDemoCta: () => <div data-testid="hero-demo-cta" />,
}));

describe("InteractiveDemoLanding", () => {
  beforeEach(() => {
    jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    jest
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("keeps a normal-flow consent slot and does not load a decorative WebGL canvas", () => {
    render(<InteractiveDemoLanding />);

    expect(document.getElementById("landing-consent-slot")).toBeInTheDocument();
    expect(document.querySelector("canvas")).toBeNull();
  });

  it("keeps the product visible before asking anonymous visitors for their email", () => {
    render(<InteractiveDemoLanding />);

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Airi campaign flow");
    expect(
      screen.getByText("Launch campaigns and follow-ups from one workspace.")
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Segmented broadcasts, promos, and reminders across every chat."
      )
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("hero-demo-cta")).not.toBeInTheDocument();
    expect(screen.getByTestId("hero-feature-cards")).toBeInTheDocument();
    const demoTrigger = screen.getByRole("button", { name: "Book a demo" });
    expect(demoTrigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(demoTrigger);
    expect(demoTrigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("hero-demo-cta")).toBeInTheDocument();
  });

  it.each<[string, LandingHeaderViewer | undefined, string, string]>([
    ["anonymous", undefined, "Start free", "/login?tab=signup"],
    [
      "known-account",
      { isAuthenticated: false, hasKnownAccount: true },
      "Sign in",
      "/login",
    ],
    [
      "authenticated",
      { isAuthenticated: true, panelHref: "/workspace" },
      "Open workspace",
      "/workspace",
    ],
  ])(
    "renders the %s viewer primary action inside the hero",
    (_viewerState, viewer, label, href) => {
      render(<InteractiveDemoLanding viewer={viewer} />);

      const hero = screen.getByRole("heading", { level: 1 }).closest("section");

      expect(hero).not.toBeNull();
      expect(within(hero!).getByRole("link", { name: label })).toHaveAttribute(
        "href",
        href
      );
    }
  );

  it("sends the headline accent as a message without changing the heading's name", () => {
    render(<InteractiveDemoLanding />);

    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Airi campaign flow conversation.",
    });
    const ticks = heading.querySelectorAll("svg");
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toHaveAttribute("aria-hidden", "true");
  });

  it("hides the demo CTA for authenticated viewers", () => {
    render(
      <InteractiveDemoLanding
        viewer={{
          panelHref: "/panel",
          isAuthenticated: true,
        }}
      />
    );

    expect(screen.queryByTestId("hero-demo-cta")).not.toBeInTheDocument();
    expect(screen.getByTestId("hero-feature-cards")).toBeInTheDocument();
  });
});
