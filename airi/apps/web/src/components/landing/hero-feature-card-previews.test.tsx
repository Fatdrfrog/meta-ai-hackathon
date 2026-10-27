/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { HeroFeatureCardPreview } from "./hero-feature-card-previews";

// jsdom has no layout observer; retain the real chart and supply measured dimensions.
jest.mock("recharts", () => ({
  ...jest.requireActual("recharts"),
  ResponsiveContainer: ({ children }: { children: React.ReactElement }) =>
    jest
      .requireActual("react")
      .cloneElement(children, { width: 600, height: 250 }),
}));

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations:
    (namespace: string) => (key: string, values?: Record<string, string>) => {
      const prefix = namespace
        .replace("LandingDemo.featureCards", "")
        .replace(/^\./, "");
      const fullKey = prefix ? `${prefix}.${key}` : key;
      return values ? `${fullKey}:${Object.values(values).join(",")}` : fullKey;
    },
}));
jest.mock("next/image", () =>
  jest.requireActual("./landing-test-utils").nextImageMock()
);

describe("HeroFeatureCardPreview", () => {
  it("keeps essential analytics facts in compact cards and the explanations in the expanded view", () => {
    const { container, rerender } = render(
      <HeroFeatureCardPreview kind="analytics" compact interactive />
    );
    for (const label of [
      "sample",
      "netRevenue",
      "sales",
      "refunds",
      "trend.title",
    ]) {
      expect(
        screen.getByText(`previews.analytics.${label}`)
      ).toBeInTheDocument();
    }
    expect(
      container.querySelector("[data-conversation-trend]")
    ).toBeInTheDocument();
    for (const label of [
      "source",
      "note",
      "trend.source",
      "trend.axis",
      "trend.unit",
    ]) {
      expect(
        screen.queryByText(`previews.analytics.${label}`)
      ).not.toBeInTheDocument();
    }
    rerender(<HeroFeatureCardPreview kind="analytics" interactive />);
    expect(screen.getByText("previews.analytics.note")).toBeInTheDocument();
    expect(screen.getByText("previews.analytics.source")).toBeInTheDocument();
  });
  it("trims duplicated preview introductions without removing the campaign audience or product facts", () => {
    const { rerender } = render(
      <HeroFeatureCardPreview kind="smartChat" compact interactive />
    );
    for (const label of [
      "audience",
      "eligibility",
      "answer",
      "status",
      "templateStatus",
    ]) {
      expect(
        screen.getByText(`previews.smartChat.${label}`)
      ).toBeInTheDocument();
    }
    expect(screen.getByText("1,240")).toBeInTheDocument();
    expect(
      screen.queryByText("previews.smartChat.title")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("previews.smartChat.approval")
    ).not.toBeInTheDocument();
    rerender(<HeroFeatureCardPreview kind="meta" compact interactive />);
    expect(screen.getByText("previews.meta.body")).toBeInTheDocument();
    expect(screen.queryByText("previews.meta.note")).not.toBeInTheDocument();
    rerender(<HeroFeatureCardPreview kind="assets" compact interactive />);
    expect(screen.queryByText("previews.assets.title")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "previews.assets.catalog" })
    ).toBeInTheDocument();
    rerender(<HeroFeatureCardPreview kind="voice" compact interactive />);
    expect(screen.getByText("previews.voice.script")).toBeInTheDocument();
    expect(screen.queryByText("previews.voice.title")).not.toBeInTheDocument();
    expect(screen.queryByText("previews.voice.note")).not.toBeInTheDocument();
  });
  it("shows an opened WhatsApp chat with two distinct carousel cards and no passive controls", () => {
    const { container } = render(<HeroFeatureCardPreview kind="carousel" />);
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "/landing/home-campaign.webp"
    );
    expect(container.querySelectorAll(".messageProductCard")).toHaveLength(2);
    expect(
      container.querySelector('img[src="/landing/home-catalog.webp"]')
    ).toBeInTheDocument();
    expect(container.querySelector(".whatsappHeader")).toHaveTextContent(
      "previews.common.shop"
    );
    expect(container.querySelector(".whatsappComposer")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
    expect(container.querySelector("button")).toBeNull();
  });
  it("shows meaningful fallback content when the product image cannot load", () => {
    const { container } = render(
      <HeroFeatureCardPreview kind="carousel" interactive />
    );
    fireEvent.error(container.querySelector("img")!);
    expect(screen.getByText("imageUnavailable")).toBeInTheDocument();
    expect(screen.getByText("previews.carousel.question")).toBeInTheDocument();
  });
  it("uses the selected quick reply as the outgoing customer message without sending it", () => {
    const originalFetch = global.fetch;
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;
    try {
      render(<HeroFeatureCardPreview kind="carousel" interactive />);
      expect(
        screen.getByText("previews.carousel.question").closest("div")
      ).toHaveClass("outgoing");
      expect(
        screen.getByText("previews.carousel.answer").closest("div")
      ).not.toHaveClass("outgoing");
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
      fireEvent.click(
        screen.getByRole("button", { name: /previews.common.terracotta/ })
      );
      expect(
        within(screen.getByRole("status"))
          .getByText("previews.common.terracotta")
          .closest("div")
      ).toHaveClass("outgoing");
      fireEvent.click(
        screen.getByRole("button", { name: "previews.common.cream" })
      );
      expect(screen.getByRole("status")).toHaveTextContent(
        "previews.common.cream"
      );
      expect(screen.getByRole("status")).not.toHaveTextContent(
        "previews.common.terracotta"
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });
  it("shows an Instagram sponsored post that opens a customer-side WhatsApp conversation", () => {
    const { container } = render(
      <HeroFeatureCardPreview kind="ads" interactive />
    );
    expect(screen.getByText("Instagram")).toBeInTheDocument();
    expect(screen.getByText("previews.ads.sponsored")).toBeInTheDocument();
    expect(
      container.querySelector('img[src="/landing/home-story.webp"]')
    ).toBeInTheDocument();
    expect(screen.queryByText("previews.ads.answer")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "previews.ads.cta" }));
    expect(
      screen.getByRole("region", { name: "previews.common.conversationLabel" })
    ).toBeInTheDocument();
    expect(screen.getByText("previews.ads.answer")).toBeInTheDocument();
    expect(screen.getByText("previews.ads.source")).toBeInTheDocument();
    expect(screen.getByText("previews.ads.lead").closest("div")).toHaveClass(
      "outgoing"
    );
    expect(
      screen.getByText("previews.ads.answer").closest("div")
    ).not.toHaveClass("outgoing");
    expect(
      screen.getByRole("button", { name: "previews.ads.back" })
    ).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "previews.ads.back" }));
    expect(
      screen.getByRole("button", { name: "previews.ads.cta" })
    ).toHaveFocus();
  });
  it("keeps Instagram likes and saves local and preserves them after returning from chat", () => {
    const { container, rerender } = render(
      <HeroFeatureCardPreview kind="ads" />
    );
    expect(container.querySelector("button")).toBeNull();
    rerender(<HeroFeatureCardPreview kind="ads" interactive />);
    fireEvent.click(screen.getByRole("button", { name: "previews.ads.like" }));
    fireEvent.click(screen.getByRole("button", { name: "previews.ads.save" }));
    fireEvent.click(screen.getByRole("button", { name: "previews.ads.cta" }));
    fireEvent.click(screen.getByRole("button", { name: "previews.ads.back" }));
    for (const name of ["previews.ads.like", "previews.ads.save"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
    }
  });
  it("uses distinct photographs for each campaign and library placement", () => {
    const sources = new Set<string>();
    const { container, rerender } = render(
      <HeroFeatureCardPreview kind="carousel" interactive />
    );
    const collect = () =>
      container
        .querySelectorAll<HTMLImageElement>('img[src^="/landing/"]')
        .forEach(img => sources.add(img.getAttribute("src")!));
    collect();
    for (const kind of ["smartChat", "ads", "assets"] as const) {
      rerender(<HeroFeatureCardPreview kind={kind} interactive />);
      collect();
    }
    expect(sources.size).toBe(5);
    const libraryImages = container.querySelectorAll<HTMLImageElement>(
      'img[src^="/landing/"]'
    );
    expect(libraryImages).toHaveLength(3);
    expect(new Set([...libraryImages].map(img => img.alt)).size).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: "previews.assets.ad" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "previews.assets.selected:previews.assets.ad"
    );
  });
  it("retains the Instagram action if the ad photograph cannot load", () => {
    const { container } = render(
      <HeroFeatureCardPreview kind="ads" interactive />
    );
    fireEvent.error(container.querySelector('img[src^="/landing/"]')!);
    expect(screen.getByText("imageUnavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "previews.ads.cta" }));
    expect(screen.getByText("previews.ads.answer")).toBeInTheDocument();
  });
  it("identifies eligible recipients and exposes exclusions without implying a send or approval", () => {
    const originalFetch = global.fetch;
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;
    const { container } = render(
      <HeroFeatureCardPreview kind="smartChat" interactive />
    );
    expect(screen.getByText("1,240")).toBeInTheDocument();
    expect(screen.getByText("previews.smartChat.audience")).toBeInTheDocument();
    expect(
      screen.getByText("previews.smartChat.eligibility")
    ).toBeInTheDocument();
    expect(
      screen.getByText("previews.smartChat.templateStatus")
    ).toBeInTheDocument();
    expect(container.querySelector("[data-analytics-period]")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "previews.smartChat.showExclusions" })
    );
    expect(
      screen.getByText("previews.smartChat.purchased")
    ).toBeInTheDocument();
    expect(screen.getByText("52")).toBeInTheDocument();
    expect(screen.getByText("28")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "previews.smartChat.hideExclusions" })
    );
    expect(
      screen.queryByText("previews.smartChat.purchased")
    ).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
    global.fetch = originalFetch;
  });
  it("keeps sales analytics separate, labels sample figures and changes the complete reporting period", () => {
    const { container } = render(
      <HeroFeatureCardPreview kind="analytics" interactive />
    );
    expect(screen.getByText("previews.analytics.sample")).toBeInTheDocument();
    expect(screen.getByText(/1,152,000/)).toBeInTheDocument();
    expect(screen.getByText("66")).toBeInTheDocument();
    expect(screen.getByText("36,000")).toBeInTheDocument();
    expect(screen.queryByText("+33.3%")).not.toBeInTheDocument();
    expect(container.querySelector("[data-campaign-audience]")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "previews.analytics.periods.week" })
    );
    expect(container.querySelector("[data-analytics-period]")).toHaveAttribute(
      "data-analytics-period",
      "week"
    );
    expect(screen.getByText(/378,000/, { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("22")).toBeInTheDocument();
    expect(screen.getByText("18,000")).toBeInTheDocument();
    expect(screen.queryByText("+23.5%")).not.toBeInTheDocument();
    expect(screen.queryByText(/1,152,000/)).not.toBeInTheDocument();
    expect(container.querySelectorAll("dl dd")).toHaveLength(3);
  });
  it("does not dress up monitoring as live metrics or a fake audio player", () => {
    const { container, rerender } = render(
      <HeroFeatureCardPreview kind="meta" />
    );
    expect(container).not.toHaveTextContent(/21%|12\.4k|64 \/ 80|LIVE|YELLOW/);
    rerender(<HeroFeatureCardPreview kind="voice" interactive />);
    expect(
      screen.queryByRole("button", { name: /play|generate/i })
    ).not.toBeInTheDocument();
    expect(screen.getByText("previews.voice.script")).toBeInTheDocument();
  });
});
