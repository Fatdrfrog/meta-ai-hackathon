/** @jest-environment jsdom */
/* eslint-disable @next/next/no-img-element -- DOM image fixture. */
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BulkCampaignsSection } from "./bulk-campaigns-section";
import en from "../../../messages/en.json";
let mockFormattedBodies: Record<string, string> = {};
let mockLocale = "en";
jest.mock("next-intl", () => ({
  useLocale: () => mockLocale,
  useTranslations: (namespace: string) => {
    const messages = jest.requireActual(`../../../messages/${mockLocale}.json`);
    const root = namespace
      .split(".")
      .reduce<unknown>(
        (value, key) => (value as Record<string, unknown>)[key],
        messages
      );
    return (key: string, values?: Record<string, string>) => {
      if (
        namespace === "LandingDemo.revenueWorkflows" &&
        mockFormattedBodies[key]
      )
        return mockFormattedBodies[key];
      const result = key
        .split(".")
        .reduce<unknown>(
          (value, part) => (value as Record<string, unknown>)[part],
          root
        );
      return Object.entries(values ?? {}).reduce(
        (text, [name, value]) => text.replace("{" + name + "}", value),
        String(result)
      );
    };
  },
}));
jest.mock("next/image", () => ({
  __esModule: true,
  default: ({
    fill: _fill,
    priority: _priority,
    unoptimized: _unoptimized,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & {
    fill?: boolean;
    priority?: boolean;
    unoptimized?: boolean;
  }) => <img {...props} alt={props.alt ?? ""} />,
}));

const t = en.LandingDemo.revenueWorkflows;
describe("Visible revenue workflows", () => {
  beforeEach(() => {
    mockFormattedBodies = {};
    mockLocale = "en";
  });
  it.each(["en", "ru", "kz"])(
    "keeps the %s locale on the browse-all link",
    locale => {
      mockLocale = locale;
      const messages = jest.requireActual(`../../../messages/${locale}.json`);
      render(<BulkCampaignsSection />);
      expect(
        screen.getByRole("link", {
          name: messages.LandingDemo.templates.browseAll,
        })
      ).toHaveAttribute(
        "href",
        `/whatsapp-templates${locale === "en" ? "" : `?locale=${locale}`}`
      );
    }
  );
  it("shows the selected template artwork in the campaign and repeat examples", () => {
    render(<BulkCampaignsSection />);
    for (const [title, path] of [
      [t.campaign.title, "/templates/seasonal-offer.png"],
      [t.repeat.title, "/templates/repeat-purchase.png"],
    ]) {
      expect(
        screen
          .getByRole("article", { name: title })
          .querySelector(`img[src="${path}"]`)
      ).toBeInTheDocument();
    }
  });
  it("shows each workflow directly with template requests on outbound examples", () => {
    const { container } = render(<BulkCampaignsSection />);
    for (const key of [
      "campaign",
      "consultation",
      "recovery",
      "repeat",
      "qr",
    ] as const) {
      const article = within(
        screen.getByRole("article", { name: t[key].title })
      );
      expect(article.queryByText(t[key].outcome)).not.toBeInTheDocument();
    }
    expect(container.querySelectorAll("[data-revenue-workflow]")).toHaveLength(
      5
    );
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(
      container.querySelector('[data-template-id="seasonal-offer"]')
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-template-id="abandoned-cart"]')
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-template-id="repeat-purchase"]')
    ).toBeInTheDocument();
    for (const key of ["consultation", "qr"] as const) {
      expect(
        within(screen.getByRole("article", { name: t[key].title })).queryByRole(
          "button"
        )
      ).not.toBeInTheDocument();
    }
    expect(screen.getByText(t.consultation.question)).toBeVisible();
    expect(screen.getByText(t.consultation.answer)).toBeVisible();
    expect(screen.getByText(t.consultation.reply)).toBeVisible();
  });
  it("connects a known audience, recorded payment and repeat purchase to explicit examples", () => {
    render(<BulkCampaignsSection />);
    expect(screen.getByText("1,240")).toBeVisible();
    expect(
      screen.getByText(en.LandingDemo.featureCards.previews.smartChat.audience)
    ).toBeVisible();
    expect(screen.getByText(t.recovery.pending)).toBeVisible();
    expect(screen.getByText(t.recovery.confirmed)).toBeVisible();
    expect(screen.getByText(t.recovery.stop)).toBeVisible();
    expect(screen.getByText(t.repeat.previous)).toBeVisible();
    expect(screen.getByText(t.repeat.audience)).toBeVisible();
    expect(
      screen.getByText(new RegExp(en.LandingDemo.featureCards.reviewNote))
    ).toBeVisible();
  });
  it("shows a QR placement, customer-sent enquiry and its saved source together", () => {
    render(<BulkCampaignsSection />);
    const qr = within(screen.getByRole("article", { name: t.qr.title }));
    expect(qr.getByRole("link", { name: t.qr.open })).toHaveAttribute(
      "href",
      "#qr-conversation"
    );
    expect(qr.getByRole("img", { name: t.qr.alt })).toHaveAttribute(
      "src",
      "/landing/whatsapp-demo-qr.svg"
    );
    expect(qr.getByText(t.qr.question).closest("div")).toHaveClass("outgoing");
    expect(qr.getByText(t.qr.answer).closest("div")).not.toHaveClass(
      "outgoing"
    );
    expect(qr.getByText(t.qr.source)).toBeVisible();
    expect(qr.getByText(t.qr.demoNote)).toBeVisible();
  });
  it("retains the QR destination without repeated conversion prompts", () => {
    render(<BulkCampaignsSection />);
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(
      document.querySelector('a[href="/whatsapp-templates"]')
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t.qr.open })).toHaveAttribute(
      "href",
      "#qr-conversation"
    );
    expect(
      screen.queryByRole("link", { name: t.demo })
    ).not.toBeInTheDocument();
  });

  it("formats the campaign, recovery and repeat message bodies using WhatsApp markers", () => {
    mockFormattedBodies = {
      "campaign.message": "A *sample offer* for Alex",
      "recovery.message": "A _sample reminder_ for Alex",
      "repeat.message": "A ~previous price~ and ```DEMO-001```",
    };
    render(<BulkCampaignsSection />);
    expect(screen.getByText("sample offer").tagName).toBe("STRONG");
    expect(screen.getByText("sample reminder").tagName).toBe("EM");
    expect(screen.getByText("previous price").tagName).toBe("S");
    expect(screen.getByText("DEMO-001").tagName).toBe("CODE");
  });

  it("keeps message emphasis inline while recovery step labels remain blocks", () => {
    mockFormattedBodies = {
      "recovery.message": "Still considering the *Sora* mirror?",
    };
    const stylesheet = readFileSync(
      join(__dirname, "landing-workflow-studio.module.css"),
      "utf8"
    );
    const timelineLabelRule = stylesheet.match(
      /\.recoveryTimeline[^{}]*\bstrong\s*\{[^}]*\}/
    );
    expect(timelineLabelRule).not.toBeNull();
    const style = document.createElement("style");
    // Emulate inline HTML emphasis, then apply the actual timeline CSS rule.
    style.textContent = `strong { display: inline; } ${timelineLabelRule![0]}`;
    document.head.appendChild(style);
    try {
      render(<BulkCampaignsSection />);
      const recovery = within(
        screen.getByRole("article", { name: t.recovery.title })
      );
      expect(
        getComputedStyle(recovery.getByText(t.recovery.wait)).display
      ).toBe("block");
      expect(getComputedStyle(recovery.getByText("Sora")).display).toBe(
        "inline"
      );
    } finally {
      style.remove();
    }
  });
});
