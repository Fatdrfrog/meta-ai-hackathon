/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import { CategoryDistributionChart } from "./category-distribution-chart";

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations:
    () => (key: string, values?: Record<string, number | string>) =>
      (
        (
          ({
            title: "Categories",
            description: "Conversations by category.",
            uncategorized: "Uncategorized:",
            previousValue: "Previous: {value}",
          }) as Record<string, string>
        )[key] ?? key
      ).replace(/\{(\w+)\}/g, (_, token: string) => String(values?.[token])),
}));

it("adds previous-period counts and bars on one shared scale when comparing", () => {
  const { container, rerender } = render(
    <CategoryDistributionChart
      data={[
        { name: "Delivery", value: 6, previous: 8 },
        { name: "Pricing", value: 4, previous: 0 },
      ]}
      uncategorized={3}
      uncategorizedPrevious={5}
      comparisonEnabled
    />
  );

  const rows = within(
    screen.getByRole("list", { name: "Categories" })
  ).getAllByRole("listitem");
  expect(rows[0]).toHaveTextContent("Delivery6Previous: 8");
  expect(rows[1]).toHaveTextContent("Pricing4Previous: 0");
  const current = container.querySelectorAll<HTMLElement>(".bg-chart-3");
  const previous = container.querySelectorAll<HTMLElement>(
    "[data-previous-bar]"
  );
  // The previous Delivery count (8) sets the scale for every bar.
  expect(current[0].style.width).toBe("75%");
  expect(previous[0].style.width).toBe("100%");
  expect(previous[1].style.width).toBe("0%");
  expect(screen.getByText(/Uncategorized:/).parentElement).toHaveTextContent(
    "Uncategorized: 3Previous: 5"
  );

  rerender(
    <CategoryDistributionChart
      data={[{ name: "Delivery", value: 6, previous: 8 }]}
      uncategorized={0}
    />
  );
  expect(screen.queryByText(/Previous:/)).toBeNull();
  expect(container.querySelector("[data-previous-bar]")).toBeNull();
});

it("omits empty and invalid volume rather than showing a fabricated zero chart", () => {
  const { container } = render(
    <CategoryDistributionChart
      data={[
        { name: "Invalid", value: NaN },
        { name: "Zero", value: 0 },
      ]}
      uncategorized={Infinity}
    />
  );
  expect(container.firstChild).toBeNull();
});

it("keeps uncategorized-only volume visible once", () => {
  render(<CategoryDistributionChart data={[]} uncategorized={3} />);
  const rows = within(
    screen.getByRole("list", { name: "Categories" })
  ).getAllByRole("listitem");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toHaveTextContent("Uncategorized");
  expect(rows[0]).toHaveTextContent("3");
});

it("ranks categories by real count with intact names and a shared visual scale", () => {
  const longName = "A long customer category name that must remain intact";
  const { container } = render(
    <CategoryDistributionChart
      data={[
        { name: longName, value: 4 },
        { name: "Accounting", value: 8 },
        { name: "Invalid", value: -3 },
      ]}
      uncategorized={2}
    />
  );
  const rows = within(
    screen.getByRole("list", { name: "Categories" })
  ).getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent("Accounting8");
  expect(rows[1]).toHaveTextContent(longName);
  const bars = container.querySelectorAll<HTMLElement>(".bg-chart-3");
  expect(bars[0].style.width).toBe("100%");
  expect(bars[1].style.width).toBe("50%");
  expect(screen.getByText(/Uncategorized:/)).toHaveTextContent("2");
  expect(container.querySelector("svg")).toBeNull();
});
