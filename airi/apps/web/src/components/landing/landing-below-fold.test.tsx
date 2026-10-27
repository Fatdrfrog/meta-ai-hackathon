/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { LandingBelowFold } from "./landing-below-fold";
import en from "../../../messages/en.json";
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
  useTranslations: jest
    .requireActual("./landing-test-utils")
    .catalogTranslations(jest.requireActual("../../../messages/en.json")),
}));
jest.mock("next/image", () =>
  jest.requireActual("./landing-test-utils").nextImageMock()
);

jest.mock("./bulk-campaigns-section", () => ({
  BulkCampaignsSection: () => <section data-testid="bulk-campaigns" />,
}));
const t = en.LandingDemo;
describe("LandingBelowFold", () => {
  it("keeps the final action focused on getting started", () => {
    render(<LandingBelowFold />);
    const finalSection = within(
      screen.getByRole("region", {
        // SentAccent keeps short words with the next one using a no-break space.
        name: name =>
          name.replace(/\u00a0/g, " ") ===
          `${t.cta.title} ${t.cta.titleAccent}`,
      })
    );
    expect(finalSection.getAllByRole("link")).toHaveLength(1);
    expect(
      finalSection.getByRole("link", { name: t.hero.startFree })
    ).toHaveAttribute("href", "/login?tab=signup");
    expect(
      screen.queryByRole("link", { name: t.cta.demo })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: t.footer.ourTeam })
    ).toHaveAttribute("href", "/about");
  });
  it("compares the complete monthly attribution chain and updates both periods without mixing currencies", () => {
    const { container } = render(<LandingBelowFold />);
    const monthly = within(
      container.querySelector("[data-monthly-analytics]") as HTMLElement
    );
    const copy = t.revenueReport.monthly;
    expect(monthly.getByText(copy.concept)).toBeVisible();
    const row = (metric: string) =>
      container.querySelector(`[data-monthly-metric="${metric}"]`)!;
    expect(row("spend")).toHaveTextContent("$288");
    expect(row("spend")).toHaveTextContent("$312");
    expect(row("spend")).toHaveTextContent("-7.7%");
    expect(row("conversations")).toHaveTextContent("168");
    expect(row("conversations")).toHaveTextContent("174");
    expect(row("sales")).toHaveTextContent("24");
    expect(row("sales")).toHaveTextContent("22");
    expect(row("netRevenue")).toHaveTextContent("414,000 ₸");
    expect(row("netRevenue")).toHaveTextContent("360,000 ₸");
    expect(row("netRevenue")).toHaveTextContent("+15%");
    const current = monthly.getByRole("combobox", { name: copy.current });
    const previous = monthly.getByRole("combobox", { name: copy.previous });
    fireEvent.change(current, { target: { value: "jan" } });
    expect(row("netRevenue")).toHaveTextContent("234,000 ₸");
    expect(row("netRevenue")).toHaveTextContent("-35%");
    fireEvent.change(previous, { target: { value: "jun" } });
    expect(row("netRevenue")).toHaveTextContent("414,000 ₸");
    expect(row("netRevenue")).toHaveTextContent("-43.5%");
    fireEvent.change(previous, { target: { value: "jan" } });
    for (const metric of ["spend", "conversations", "sales", "netRevenue"])
      expect(row(metric).lastElementChild).toHaveTextContent(/^0%$/);
    expect(monthly.getByRole("table")).toHaveAccessibleName(
      "Comparing January 2026 with January 2026."
    );
    expect(
      container.querySelector('[data-monthly-analytics] [aria-live="polite"]')
    ).toHaveTextContent("Comparing January 2026 with January 2026.");
    expect(row("spend")).not.toHaveTextContent("₸");
    expect(row("netRevenue")).not.toHaveTextContent("$");
  });
  it("makes the monthly graph keyboard-readable with month names and exact net revenue", async () => {
    const { container } = render(<LandingBelowFold />);
    const monthly = container.querySelector(
      "[data-monthly-analytics]"
    ) as HTMLElement;
    const graph = within(monthly).getByRole("application", {
      name: t.revenueReport.monthly.chartLabel,
    });
    fireEvent.focus(graph);
    const tooltip = await within(monthly).findByRole("status");
    expect(tooltip).toHaveAttribute("aria-live", "polite");
    expect(tooltip).toHaveAttribute("aria-atomic", "true");
    expect(graph).toHaveAttribute("aria-describedby", tooltip.id);
    expect(tooltip).toHaveTextContent("January 2026");
    expect(tooltip).toHaveTextContent("234,000 ₸");
    fireEvent.keyDown(graph, { key: "ArrowRight" });
    expect(await within(tooltip).findByText("February 2026")).toBeVisible();
    expect(tooltip).toHaveTextContent("288,000 ₸");
  });
  it("names the focused chart and announces the changing keyboard day and values", async () => {
    const { container } = render(<LandingBelowFold />);
    const surface = container.querySelector(
      '[data-conversation-trend] [role="application"]'
    ) as SVGElement;
    expect(surface).toHaveAccessibleName(/^Daily conversations:/);
    fireEvent.focus(surface);
    const status = await screen.findByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");
    expect(surface).toHaveAttribute("aria-describedby", status.id);
    expect(status).toHaveTextContent("Day 1");
    expect(within(status).getByText("28")).toBeVisible();
    fireEvent.keyDown(surface, { key: "ArrowRight" });
    expect(await screen.findByText("Day 2")).toBeVisible();
    expect(screen.getByRole("status")).toBe(status);
    expect(within(status).getByText("34")).toBeVisible();
    expect(within(status).getByText("26")).toBeVisible();
    expect(status).not.toHaveTextContent("₸");
    fireEvent.keyDown(surface, { key: "ArrowLeft" });
    expect(await screen.findByText("Day 1")).toBeVisible();
    expect(screen.queryByText("Day Previous period")).not.toBeInTheDocument();
  });
  it("separates recorded revenue from the Overview conversation chart without inventing a scenario report", () => {
    const { container } = render(<LandingBelowFold />);
    const report = within(
      container.querySelector('[data-analytics-layout="report"]') as HTMLElement
    );
    expect(report.getByText("1,152,000")).toBeVisible();
    expect(report.getByText("66")).toBeVisible();
    expect(report.getByText("36,000")).toBeVisible();
    expect(
      report.getByRole("region", { name: "Dashboard → Sources" })
    ).toHaveTextContent("1,152,000");
    expect(report.getByText("Dashboard → Overview")).toBeVisible();
    expect(report.queryByText(/Revenue by workflow/)).not.toBeInTheDocument();
    expect(report.queryByRole("button")).not.toBeInTheDocument();
    expect(report.queryByRole("tab")).not.toBeInTheDocument();
    const chart = container.querySelector('[data-conversation-trend="month"]')!;
    expect(chart.querySelectorAll(".recharts-area-curve")).toHaveLength(2);
    expect(
      within(chart as HTMLElement).getByRole("application")
    ).toHaveAccessibleName(/^Daily conversations:/);
    expect(chart).not.toHaveTextContent(/₸|refunds|revenue/i);
    expect(
      report.getByText(t.featureCards.previews.analytics.sample)
    ).toBeVisible();
  });
  it("shows supported ad, campaign and team metrics with their source boundaries", () => {
    const { container } = render(<LandingBelowFold />);
    const details = t.revenueReport.details;
    const ads = within(
      container.querySelector('[data-analytics-detail="meta"]') as HTMLElement
    );
    expect(ads.getByRole("table")).toHaveAccessibleName(details.ads.table);
    expect(ads.getByText("Dashboard → Sources · Meta Ads · USD")).toBeVisible();
    expect(ads.getByText("$288")).toBeVisible();
    expect(ads.getByText("$1.60")).toBeVisible();
    expect(ads.getByText("180")).toBeVisible();
    expect(
      ads.getByText(details.ads.captured.replace("{count}", "168"))
    ).toBeVisible();
    expect(ads.getByText(details.ads.boundary, { exact: false })).toBeVisible();
    const campaign = within(
      container.querySelector(
        '[data-analytics-detail="campaign"]'
      ) as HTMLElement
    );
    for (const count of ["1,240", "1,210", "930", "248"])
      expect(campaign.getByText(count)).toBeVisible();
    expect(campaign.getByText("Campaigns → Analytics")).toBeVisible();
    expect(campaign.getByText(/20% of accepted sends/)).toBeVisible();
    expect(campaign.getByText(/20%.*\$0.15/)).toBeVisible();
    const response = within(
      container.querySelector(
        '[data-analytics-detail="response"]'
      ) as HTMLElement
    );
    expect(response.getByText(details.response.median)).toBeVisible();
    expect(response.getByText("Dashboard → Overview / Team")).toBeVisible();
    expect(
      response.getByText(/Excludes unanswered conversations; elapsed time/)
    ).toBeVisible();
    expect(response.getByText(details.response.p90)).toBeVisible();
    expect(response.getByText(/840/)).toBeVisible();
    expect(screen.getByText(details.demoNote)).toBeVisible();
    expect(
      container.querySelector('[data-analytics-layout="report"]')
    ).not.toHaveTextContent(/ROAS|ROI|\+33/);
  });
  it("presents revenue, practical answers and a final action after the workflows", () => {
    const { container } = render(<LandingBelowFold />);
    expect(container.firstElementChild).toHaveAttribute(
      "data-testid",
      "bulk-campaigns"
    );
    for (const name of [t.revenueReport.title, t.faq.title])
      expect(screen.getByRole("heading", { name })).toBeVisible();
    expect(container.querySelectorAll("details")).toHaveLength(5);
    for (const item of Object.values(t.faq.items)) {
      expect(screen.getByText(item.question)).toBeInTheDocument();
      expect(screen.getByText(item.answer)).toBeInTheDocument();
    }
    expect(
      screen.queryByRole("link", { name: /see plans|pricing/i })
    ).not.toBeInTheDocument();
  });
  it("opens the first answer as a visible chat exchange and keeps the rest collapsed", () => {
    const { container } = render(<LandingBelowFold />);
    const [first, ...rest] = Array.from(container.querySelectorAll("details"));
    expect(first).toHaveAttribute("open");
    expect(screen.getByText(t.faq.items.start.answer)).toBeVisible();
    for (const item of rest) expect(item).not.toHaveAttribute("open");
    expect(screen.getByText(t.faq.items.cost.answer)).not.toBeVisible();
    for (const ticks of container.querySelectorAll("summary svg"))
      expect(ticks).toHaveAttribute("aria-hidden", "true");
  });
  it("keeps the oversized footer wordmark out of the accessibility tree", () => {
    render(
      <main>
        <LandingBelowFold />
      </main>
    );
    const footer = screen.getByRole("contentinfo");
    expect(footer.querySelector(".footerWordmark")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
  });
  it("preserves legal links and company details as accessible footer navigation", () => {
    render(
      <main>
        <LandingBelowFold />
      </main>
    );
    const footer = within(screen.getByRole("contentinfo"));
    expect(footer.getByText("Turan 57G, Astana, Kazakhstan")).toBeVisible();
    expect(footer.getByText(t.footer.rights)).toBeVisible();
    const nav = within(
      footer.getByRole("navigation", { name: t.footer.navigation })
    );
    for (const [key, href] of [
      ["ourTeam", "/about"],
      ["terms", "/terms"],
      ["refunds", "/refunds"],
      ["privacy", "/privacy"],
      ["security", "/security"],
    ] as const)
      expect(nav.getByRole("link", { name: t.footer[key] })).toHaveAttribute(
        "href",
        href
      );
    const product = within(
      footer.getByRole("navigation", { name: t.footer.productNavigation })
    );
    for (const [key, href] of [
      ["delivery", "/whatsapp-marketing-delivery"],
      ["metaAds", "/meta-ads-mcp"],
      ["mcp", "/mcp"],
      ["templates", "/whatsapp-templates"],
    ] as const)
      expect(
        product.getByRole("link", { name: t.footer[key] })
      ).toHaveAttribute("href", href);
  });
  it("keeps authenticated users in their workspace and omits the demo invitation", () => {
    render(
      <LandingBelowFold
        viewer={{ isAuthenticated: true, panelHref: "/panel" }}
      />
    );
    expect(
      screen.getByRole("link", { name: "Open workspace" })
    ).toHaveAttribute("href", "/panel");
    expect(
      screen.queryByRole("link", { name: t.cta.demo })
    ).not.toBeInTheDocument();
  });
  it("keeps returning users on the existing sign-in route", () => {
    render(
      <LandingBelowFold
        viewer={{ isAuthenticated: false, hasKnownAccount: true }}
      />
    );
    expect(screen.getByRole("link", { name: t.header.signIn })).toHaveAttribute(
      "href",
      "/login"
    );
  });
});
