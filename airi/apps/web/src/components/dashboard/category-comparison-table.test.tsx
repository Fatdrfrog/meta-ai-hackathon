/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { DASHBOARD_UNCATEGORIZED_CATEGORY } from "@/types/dashboard";
import { CategoryComparisonTable } from "./category-comparison-table";

const messages: Record<string, string> = {
  "tabs.categories": "Categories",
  "categoryComparison.title": "Category comparison",
  "categoryComparison.description":
    "Inquiry volume by category for the selected periods.",
  "categoryComparison.currentOnlyDescription":
    "Inquiry volume by category for the selected period.",
  "categoryComparison.caption":
    "Current and previous inquiry volume by category",
  "categoryComparison.currentOnlyCaption": "Current inquiry volume by category",
  "categoryComparison.viewsLabel": "Category change views",
  "categoryComparison.views.all": "All",
  "categoryComparison.views.increased": "Increased",
  "categoryComparison.views.decreased": "Decreased",
  "categoryComparison.views.new": "New",
  "categoryComparison.views.noLongerActive": "No longer active",
  "categoryComparison.table.category": "Category",
  "categoryComparison.table.current": "Current",
  "categoryComparison.table.previous": "Previous",
  "categoryComparison.table.difference": "Difference",
  "categoryComparison.table.change": "Change",
  "categoryComparison.table.total": "Total",
  "categoryComparison.table.totalAllCategories": "Total, all categories",
  "categoryComparison.mobile.current": "Current",
  "categoryComparison.mobile.previous": "Previous",
  "categoryComparison.mobile.difference": "Difference",
  "categoryComparison.mobile.rate": "Rate",
  "categoryComparison.changeKinds.increase": "Increased",
  "categoryComparison.changeKinds.decrease": "Decreased",
  "categoryComparison.changeKinds.unchanged": "No change",
  "categoryComparison.changeKinds.new": "New",
  "categoryComparison.changeKinds.noLongerActive": "No longer active",
  "categoryComparison.viewAll": "View all",
  "categoryComparison.empty": "No categories match this view.",
  "accessibility.categoryViews": "Filter categories by change",
  uncategorized: "Uncategorized",
};

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations:
    () => (key: string, values?: Record<string, number | string>) => {
      const template = messages[key] ?? key;
      return template.replace(/\{(\w+)\}/g, (_, token: string) =>
        String(values?.[token] ?? `{${token}}`)
      );
    },
}));

const rows = [
  {
    category: "Billing / Enterprise",
    current: 15,
    previous: 10,
    delta: 5,
    percentChange: 50,
    kind: "increase" as const,
  },
  {
    category: "Sales",
    current: 4,
    previous: 8,
    delta: -4,
    percentChange: -50,
    kind: "decrease" as const,
  },
  {
    category: "VIP",
    current: 3,
    previous: 0,
    delta: 3,
    percentChange: null,
    kind: "new" as const,
  },
  {
    category: "Legacy",
    current: 0,
    previous: 2,
    delta: -2,
    percentChange: -100,
    kind: "no_longer_active" as const,
  },
  {
    category: DASHBOARD_UNCATEGORIZED_CATEGORY,
    current: 2,
    previous: 2,
    delta: 0,
    percentChange: 0,
    kind: "unchanged" as const,
  },
];

describe("CategoryComparisonTable", () => {
  it("names a real table and renders every mutually exclusive comparison kind", () => {
    render(
      <CategoryComparisonTable
        rows={rows}
        comparisonEnabled
        onViewAll={() => {}}
      />
    );

    expect(
      screen.getByRole("table", {
        name: "Current and previous inquiry volume by category",
      })
    ).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(5);

    for (const [category, current, previous, delta, change] of [
      ["Billing / Enterprise", "15", "10", "+5", "+50%"],
      ["Sales", "4", "8", "-4", "-50%"],
      ["VIP", "3", "0", "+3", "New"],
      ["Legacy", "0", "2", "-2", "No longer active"],
      ["Uncategorized", "2", "2", "0", "No change"],
    ]) {
      const row = screen.getByRole("row", { name: new RegExp(category) });
      expect(within(row).getAllByText(current).length).toBeGreaterThan(0);
      expect(within(row).getAllByText(previous).length).toBeGreaterThan(0);
      expect(within(row).getAllByText(delta).length).toBeGreaterThan(0);
      expect(row).toHaveTextContent(change);
    }

    expect(screen.getByRole("row", { name: /VIP/ })).not.toHaveTextContent("%");

    expect(screen.getByText("Billing / Enterprise")).toHaveClass(
      "whitespace-normal"
    );
    expect(
      screen.getByRole("row", { name: /Billing \/ Enterprise/ })
    ).toHaveTextContent("+50% · Increased");
    expect(
      screen
        .getAllByText("New")
        .some(element => element.closest("[data-slot='badge']") !== null)
    ).toBe(true);
    expect(
      screen
        .getAllByText("No longer active")
        .some(element => element.closest("[data-slot='badge']") !== null)
    ).toBe(true);
    expect(
      within(screen.getByRole("row", { name: /Legacy/ })).getAllByText("-100%")
        .length
    ).toBeGreaterThan(0);
  });

  it("uses one controlled Radix single ToggleGroup that cannot clear itself", () => {
    render(<CategoryComparisonTable rows={rows} comparisonEnabled />);

    const all = screen.getByRole("radio", { name: "All" });
    const increased = screen.getByRole("radio", { name: "Increased" });
    expect(
      screen.getByRole("group", { name: "Filter categories by change" })
    ).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(
      screen.queryByRole("radio", { name: "No longer active" })
    ).not.toBeInTheDocument();
    expect(all).toHaveAttribute("aria-checked", "true");

    fireEvent.click(increased);
    expect(increased).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Billing / Enterprise")).toBeInTheDocument();
    expect(screen.queryByText("Sales")).not.toBeInTheDocument();

    fireEvent.click(increased);
    expect(increased).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Billing / Enterprise")).toBeInTheDocument();
  });

  it("keeps current, previous, delta, and rate meaning in the mobile row DOM", () => {
    render(<CategoryComparisonTable rows={[rows[0]]} comparisonEnabled />);

    const row = screen.getByRole("row", { name: /Billing \/ Enterprise/ });
    expect(within(row).getByText(/^Current:/)).toHaveClass("sm:hidden");
    expect(within(row).getByText(/^Previous:/)).toHaveClass("sm:hidden");
    expect(within(row).getByText(/^Difference:/)).toHaveClass("sm:hidden");
    expect(within(row).getByText(/^Rate:/)).toHaveClass("sm:hidden");
  });

  it("fits phones: mobile pairs may wrap and the rate drops the redundant direction word", () => {
    render(<CategoryComparisonTable rows={[rows[0]]} comparisonEnabled />);

    const row = screen.getByRole("row", { name: /Billing \/ Enterprise/ });
    const rate = within(row).getByText(/^Rate:/).parentElement!;
    expect(rate).toHaveTextContent(/^Rate: \+50%$/);
    expect(rate.parentElement).toHaveClass("whitespace-normal", "sm:hidden");
    // Wider layouts keep the explicit direction beside the percentage.
    expect(row).toHaveTextContent("+50% · Increased");
  });

  it("shows only current-period meaning when comparison is off", () => {
    render(<CategoryComparisonTable rows={rows} comparisonEnabled={false} />);

    expect(
      screen.getByRole("table", { name: "Current inquiry volume by category" })
    ).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByText("Previous")).not.toBeInTheDocument();
    expect(screen.queryByText("Difference")).not.toBeInTheDocument();
    expect(screen.queryByText("No longer active")).not.toBeInTheDocument();
    expect(screen.queryByText("Legacy")).not.toBeInTheDocument();
  });

  it("renders the empty state when current-only data contains only previous-period rows", () => {
    render(
      <CategoryComparisonTable rows={[rows[3]]} comparisonEnabled={false} />
    );

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("No categories match this view.")).toBeVisible();
  });

  it("applies the preview limit and delegates View all", () => {
    const onViewAll = jest.fn();
    render(
      <CategoryComparisonTable
        rows={rows}
        comparisonEnabled
        limit={2}
        onViewAll={onViewAll}
      />
    );

    // Header, two previewed categories, and the all-category total.
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(
      screen.getByRole("row", { name: /^Total, all categories/ })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View all" }).querySelector("svg")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View all" }));
    expect(onViewAll).toHaveBeenCalledTimes(1);
  });

  it("totals every category in a footer row with the period change", () => {
    const { container } = render(
      <CategoryComparisonTable rows={rows} comparisonEnabled />
    );

    const footer = container.querySelector("tfoot");
    expect(footer).toBeTruthy();
    const total = within(footer as HTMLElement).getByRole("row");
    expect(total).toHaveAccessibleName(/^Total/);
    // 24 current vs 22 previous across all five categories.
    for (const value of ["24", "22", "+2", "+9.1%"]) {
      expect(within(total).getAllByText(value).length).toBeGreaterThan(0);
    }
    expect(total).toHaveTextContent("Total");
    expect(total).not.toHaveTextContent("all categories");
  });

  it("keeps the all-category total while a change view hides rows", () => {
    const { container } = render(
      <CategoryComparisonTable rows={rows} comparisonEnabled />
    );

    fireEvent.click(screen.getByRole("radio", { name: "Increased" }));

    const total = within(
      container.querySelector("tfoot") as HTMLElement
    ).getByRole("row");
    expect(total).toHaveTextContent("Total, all categories");
    expect(within(total).getAllByText("24").length).toBeGreaterThan(0);
  });

  it("totals only the current period when comparison is off", () => {
    const { container } = render(
      <CategoryComparisonTable rows={rows} comparisonEnabled={false} />
    );

    const total = within(
      container.querySelector("tfoot") as HTMLElement
    ).getByRole("row");
    expect(within(total).getAllByRole("cell")).toHaveLength(2);
    expect(total).toHaveTextContent(/^Total24$/);
  });
});
