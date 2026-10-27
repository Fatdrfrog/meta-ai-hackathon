/** @jest-environment jsdom */
import { fireEvent, render, screen, within } from "@testing-library/react";
import mockMessages from "../../../messages/panel/en/page.json";
import type {
  ConversionAttributionReport,
  MetaConversionDeliveryStatus,
} from "@icecore/shared/types/conversion-events";
import { AdvertisementAnalyticsSection } from "./advertisement-analytics";
import { ConversionAttributionReportSection } from "./conversion-attribution-report";

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: (namespace: string) => {
    return (key: string, values: Record<string, string | number> = {}) => {
      const text =
        `${namespace}.${key}`
          .split(".")
          .reduce<unknown>(
            (value, part) =>
              value && typeof value === "object"
                ? (value as Record<string, unknown>)[part]
                : undefined,
            mockMessages
          ) ?? key;
      return String(text).replace(/\{(\w+)\}/g, (_match, name) =>
        String(values[name] ?? name)
      );
    };
  },
}));

const report: ConversionAttributionReport = {
  rows: [
    {
      adId: "ad-1",
      campaignId: "campaign-1",
      campaignName: "Autumn sale",
      currency: "KZT",
      sales: 3,
      refunds: 1,
      grossRevenue: 12000.15,
      refundedRevenue: 2000.05,
      netRevenue: 10000.1,
      payingCustomers: 2,
      paidConversations: 3,
    },
    {
      adId: null,
      campaignId: null,
      campaignName: null,
      currency: "USD",
      sales: 1,
      refunds: 0,
      grossRevenue: 19.95,
      refundedRevenue: 0,
      netRevenue: 19.95,
      payingCustomers: 0,
      paidConversations: 1,
    },
  ],
  recentDeliveries: [
    {
      id: "conversion-1",
      conversionType: "sale",
      value: 12000.15,
      currency: "KZT",
      occurredAt: "2026-09-10T09:00:00Z",
      status: "delivery_unknown",
      reason: "private raw provider text",
      testMode: false,
    },
  ],
  truncated: false,
};

describe("conversion attribution report", () => {
  it("groups recorded money by currency with exact cents and distinct known-customer counts", () => {
    render(<ConversionAttributionReportSection report={report} />);
    const kzt = screen.getByRole("region", { name: "Sales in KZT" });
    const usd = screen.getByRole("region", { name: "Sales in USD" });
    expect(within(kzt).getByText("Autumn sale")).toBeTruthy();
    expect(within(kzt).getByText("Ad: ad-1")).toBeTruthy();
    for (const amount of ["12,000.15", "2,000.05", "10,000.10"])
      expect(within(kzt).getByText(amount)).toBeTruthy();
    expect(within(usd).getByText("Unattributed")).toBeTruthy();
    expect(within(usd).getAllByText("19.95")).toHaveLength(2);
    expect(screen.queryByText("12,020.10")).toBeNull();
    expect(
      within(kzt).getByRole("columnheader", { name: "Known paying customers" })
    ).toBeTruthy();
    expect(
      within(kzt).getByRole("columnheader", { name: "Paid conversations" })
    ).toBeTruthy();
    const cells = within(
      within(kzt).getByRole("row", { name: /Autumn sale/ })
    ).getAllByRole("cell");
    expect(cells.slice(1, 5).map(cell => cell.textContent)).toEqual([
      "2",
      "3",
      "3",
      "1",
    ]);
    expect(
      screen.getByText(
        /Channel, category, label and manager filters do not apply/
      )
    ).toBeTruthy();
  });

  it("does not silently assign USD to records without a currency", () => {
    render(
      <ConversionAttributionReportSection
        report={{
          ...report,
          rows: [{ ...report.rows[0], currency: "" }],
          recentDeliveries: [],
        }}
      />
    );
    expect(
      screen.getByRole("region", { name: "Sales in Unknown currency" })
    ).toBeTruthy();
    expect(screen.queryByText("USD")).toBeNull();
  });

  it("discloses unknown delivery for reconciliation without offering a resend or exposing raw reason", () => {
    render(<ConversionAttributionReportSection report={report} />);
    const summary = screen.getByText("Recent Meta delivery (1)");
    fireEvent.click(summary);
    expect(screen.getByText("Delivery unknown")).toBeTruthy();
    expect(
      screen.getByText(
        /Check these events in Meta Events Manager before any resend/
      )
    ).toBeTruthy();
    expect(screen.queryByText("private raw provider text")).toBeNull();
    expect(screen.queryByRole("button", { name: /retry|resend/i })).toBeNull();
  });

  it("renders every documented delivery status and labels explicit test codes", () => {
    const statuses: MetaConversionDeliveryStatus[] = [
      "pending",
      "queued",
      "sent",
      "rejected",
      "not_eligible",
      "delivery_unknown",
    ];
    render(
      <ConversionAttributionReportSection
        report={{
          ...report,
          recentDeliveries: statuses.map((status, index) => ({
            ...report.recentDeliveries[0],
            id: String(index),
            status,
            testMode: index === 0,
          })),
        }}
      />
    );
    for (const label of [
      "Pending",
      "Queued",
      "Received by Meta",
      "Rejected by Meta",
      "Not eligible",
      "Delivery unknown",
      "Test code",
    ])
      expect(screen.getByText(label)).toBeTruthy();
  });

  it("does not label a preparation failure as a rejection from Meta", () => {
    render(
      <ConversionAttributionReportSection
        report={{
          ...report,
          recentDeliveries: [
            {
              ...report.recentDeliveries[0],
              status: "rejected",
              reason: "pre_dispatch_failure",
            },
          ],
        }}
      />
    );
    expect(screen.getByText("Could not send")).toBeTruthy();
    expect(screen.queryByText("Rejected by Meta")).toBeNull();
  });

  it("distinguishes an empty report, a failure, and a limited result", () => {
    const { rerender } = render(
      <ConversionAttributionReportSection
        report={{ rows: [], recentDeliveries: [], truncated: false }}
      />
    );
    expect(
      screen.getByText("No recorded sales or refunds for these dates.")
    ).toBeTruthy();
    rerender(
      <ConversionAttributionReportSection report={null} error="unavailable" />
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Could not load recorded sales"
    );
    expect(
      screen.queryByText("No recorded sales or refunds for these dates.")
    ).toBeNull();
    rerender(
      <ConversionAttributionReportSection
        report={null}
        error="date_range_too_large"
      />
    );
    expect(screen.getByRole("alert").textContent).toContain("366 days");
    rerender(
      <ConversionAttributionReportSection
        report={{ ...report, truncated: true }}
      />
    );
    expect(
      screen.getByText(/Showing the first 200 ad and currency groups/)
    ).toBeTruthy();
  });

  it("mounts recorded sales in the canonical advertising card without ad conversation data", () => {
    render(
      <AdvertisementAnalyticsSection
        data={{
          totalConversations: 0,
          uniqueSources: 0,
          respondedConversations: 0,
          closedConversations: 0,
          responseRate: 0,
          closeRate: 0,
          topSources: [],
          bySourceType: [],
          dailyCounts: [],
          conversionAttribution: report,
        }}
      />
    );
    expect(
      screen.getByRole("heading", { name: "Recorded sales" })
    ).toBeTruthy();
    expect(screen.getByText("Autumn sale")).toBeTruthy();
  });
});
