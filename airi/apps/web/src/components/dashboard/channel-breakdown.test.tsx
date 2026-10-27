/**
 * @jest-environment jsdom
 */

import { render, screen, within } from "@testing-library/react";
import { ChannelBreakdown } from "./channel-breakdown";

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) =>
    (
      ({
        title: "Categories by channel",
        description: "Inquiry volume across actual channels.",
        category: "Category",
        telegram: "Telegram",
        whatsapp: "WhatsApp",
        insight: "Insight:",
        total: "Total",
      }) as Record<string, string>
    )[key] ?? key,
}));

describe("ChannelBreakdown", () => {
  it("returns no card when no meaningful rows exist", () => {
    expect(
      render(
        <ChannelBreakdown
          data={[{ category: "Accounting", channel: "whatsapp", count: 0 }]}
          insight=""
        />
      ).container.firstChild
    ).toBeNull();
  });

  it("derives ordered channel columns from real rows and preserves literal Other", () => {
    render(
      <ChannelBreakdown
        data={[
          { category: "Other", channel: "whatsapp", count: 2 },
          {
            category: "A very long customer category name that must wrap",
            channel: "Email / Partner KEEP",
            count: 3,
          },
          { category: "Other", channel: "telegram", count: 1 },
          { category: "Other", channel: "whatsapp", count: 4 },
        ]}
        insight="Factual current-period insight"
      />
    );

    const headers = screen
      .getAllByRole("columnheader")
      .map(header => header.textContent);
    expect(headers).toEqual([
      "Category",
      "WhatsApp",
      "Email / Partner KEEP",
      "Telegram",
    ]);
    expect(screen.getByText("Other")).toBeTruthy();
    expect(
      within(screen.getByRole("row", { name: /^Other/ })).getByText("6")
    ).toBeTruthy();
    expect(screen.getByText("Email / Partner KEEP")).toBeTruthy();
  });

  it("totals each channel in a footer row with locale-formatted counts", () => {
    const { container } = render(
      <ChannelBreakdown
        data={[
          { category: "Delivery", channel: "whatsapp", count: 1_200 },
          { category: "Delivery", channel: "instagram", count: 30 },
          { category: "Pricing", channel: "whatsapp", count: 300 },
        ]}
        insight=""
      />
    );

    const footer = container.querySelector("tfoot");
    expect(footer).toBeTruthy();
    const cells = Array.from(footer!.querySelectorAll("td")).map(
      cell => cell.textContent
    );
    expect(cells).toEqual(["Total", "1,500", "30"]);
    expect(
      within(screen.getByRole("row", { name: /^Pricing/ })).getByText("0")
    ).toBeTruthy();
  });

  it("omits the footer when a single category would only repeat its own row", () => {
    const { container } = render(
      <ChannelBreakdown
        data={[{ category: "Delivery", channel: "whatsapp", count: 3 }]}
        insight=""
      />
    );

    expect(container.querySelector("tfoot")).toBeNull();
  });

  it("uses a valid caption/header/body table and contains overflow at 320px", () => {
    const longCategory = "A very long customer category name that must wrap";
    const { container } = render(
      <ChannelBreakdown
        data={[{ category: longCategory, channel: "web-widget", count: 8 }]}
        insight=""
      />
    );

    expect(
      screen.getByRole("table", {
        name: "Inquiry volume across actual channels.",
      })
    ).toBeTruthy();
    expect(container.querySelector("thead th")).toBeTruthy();
    expect(container.querySelector("tbody th")).toBeNull();
    expect(screen.getByText(longCategory).getAttribute("title")).toBe(
      longCategory
    );
    expect(container.querySelector('[data-slot="card"]')?.className).toContain(
      "min-w-0"
    );
    expect(
      container.querySelector('[data-slot="table-container"]')?.className
    ).toContain("overflow-x-auto");
  });
});
