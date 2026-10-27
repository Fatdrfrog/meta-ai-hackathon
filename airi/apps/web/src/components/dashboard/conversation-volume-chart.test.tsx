/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import type { DashboardComparisonPeriod } from "@/types/dashboard";

import { ConversationVolumeChart } from "./conversation-volume-chart";

const messages: Record<string, string> = {
  "conversationVolume.title": "Inquiry volume",
  "conversationVolume.description":
    "Distinct customer inquiries for each day in the selected period.",
  "comparison.previousValue": "Previous: {value}",
};

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations:
    () => (key: string, values?: Record<string, number | string>) =>
      (messages[key] ?? key).replace(/\{(\w+)\}/g, (_, token: string) =>
        String(values?.[token])
      ),
}));

jest.mock("recharts", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  let chartData: Array<Record<string, unknown>> = [];

  const Container = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  const AreaChart = ({
    children,
    data,
  }: {
    children?: ReactNode;
    data: Array<Record<string, unknown>>;
  }) => {
    chartData = data;
    return React.createElement(
      "div",
      {
        "data-testid": "conversation-chart-data",
        "data-chart-data": JSON.stringify(data),
      },
      children
    );
  };
  const Area = ({
    dataKey,
    strokeDasharray,
  }: {
    dataKey: string;
    strokeDasharray?: string;
  }) =>
    React.createElement("div", {
      "data-testid": `series-${dataKey}`,
      "data-stroke-dasharray": strokeDasharray,
    });
  const Tooltip = ({
    content,
  }: {
    content?: ReactElement<Record<string, unknown>>;
  }) => {
    const first = chartData[0];
    const last = chartData.at(-1);
    if (!content || !first || !last) return null;

    return React.createElement(
      React.Fragment,
      null,
      [first, ...(last === first ? [] : [last])].map((datum, index) => {
        const dataKey = datum.current === undefined ? "previous" : "current";
        return React.cloneElement(content, {
          key: index,
          active: true,
          label: datum.currentDate ?? datum.previousDate,
          payload: [
            {
              color:
                dataKey === "current"
                  ? "var(--chart-1)"
                  : "var(--muted-foreground)",
              dataKey,
              name: dataKey,
              value: datum[dataKey],
              payload: datum,
            },
          ],
        });
      })
    );
  };
  const Legend = ({
    content,
  }: {
    content?: ReactElement<Record<string, unknown>>;
  }) =>
    content
      ? React.cloneElement(content, {
          payload: [
            {
              color: "var(--chart-1)",
              dataKey: "current",
              value: "current",
            },
            {
              color: "var(--muted-foreground)",
              dataKey: "previous",
              value: "previous",
            },
          ],
        })
      : null;
  const XAxis = ({
    dataKey,
    tickFormatter,
  }: {
    dataKey: string;
    tickFormatter: (value: string) => string;
  }) =>
    React.createElement(
      "span",
      { "data-testid": "conversation-chart-date" },
      chartData.map(datum => tickFormatter(String(datum[dataKey]))).join(" | ")
    );

  return {
    Area,
    AreaChart,
    CartesianGrid: Container,
    Legend,
    ResponsiveContainer: Container,
    Tooltip,
    XAxis,
    YAxis: Container,
  };
});

const current = [
  { date: "2026-08-01", total: 2 },
  { date: "2026-08-02", total: 3 },
];
const previous = [
  { date: "2026-07-25", total: 7 },
  { date: "2026-07-26", total: 11 },
];
const comparisonPeriod: DashboardComparisonPeriod = {
  preset: "custom",
  strategy: "adjacent_equal_duration",
  timeZone: "UTC",
  current: {
    start: "2026-08-01T00:00:00.000Z",
    endExclusive: "2026-08-03T00:00:00.000Z",
  },
  previous: {
    start: "2026-07-25T00:00:00.000Z",
    endExclusive: "2026-07-27T00:00:00.000Z",
  },
};

function readChartData(): Array<Record<string, unknown>> {
  return JSON.parse(
    screen.getByTestId("conversation-chart-data").dataset.chartData ?? "[]"
  );
}

describe("ConversationVolumeChart", () => {
  it("aligns current and previous days by ordinal position and localizes both tooltip dates", () => {
    render(
      <ConversationVolumeChart
        comparisonPeriod={comparisonPeriod}
        current={current}
        previous={previous}
        comparisonEnabled
        currentLabel="Current"
        previousLabel="Previous"
      />
    );

    const data = readChartData();
    expect(data[0]).toMatchObject({
      currentDate: "2026-08-01",
      current: 2,
      previousDate: "2026-07-25",
      previous: 7,
    });
    expect(data[1]).toMatchObject({
      currentDate: "2026-08-02",
      current: 3,
      previousDate: "2026-07-26",
      previous: 11,
    });
    expect(screen.getByTestId("conversation-chart-date")).toHaveTextContent(
      "Aug 1"
    );
    expect(screen.getByText("Current: Aug 1 · Previous: Jul 25")).toBeVisible();
  });

  it("retains prior-only trailing ordinals with a previous-date axis and tooltip fallback", () => {
    render(
      <ConversationVolumeChart
        comparisonPeriod={{
          ...comparisonPeriod,
          current: {
            start: "2026-08-01T00:00:00.000Z",
            endExclusive: "2026-08-02T00:00:00.000Z",
          },
          previous: {
            start: "2026-07-25T00:00:00.000Z",
            endExclusive: "2026-07-28T00:00:00.000Z",
          },
        }}
        current={[current[0]]}
        previous={[...previous, { date: "2026-07-27", total: 13 }]}
        comparisonEnabled
        currentLabel="Current"
        previousLabel="Previous"
      />
    );

    const data = readChartData();
    expect(data).toHaveLength(3);
    expect(data[2]).toEqual({
      ordinal: 3,
      axisDate: "2026-07-27",
      previousDate: "2026-07-27",
      previous: 13,
    });
    expect(screen.getByTestId("conversation-chart-date")).toHaveTextContent(
      "Aug 1 | Jul 26 | Jul 27"
    );
    expect(screen.getByText("Previous: Jul 27")).toBeVisible();
  });

  it("renders a dashed all-zero prior period when comparison is enabled without prior inquiries", () => {
    const { rerender } = render(
      <ConversationVolumeChart
        comparisonPeriod={comparisonPeriod}
        current={current}
        previous={previous}
        comparisonEnabled
        currentLabel="Current"
        previousLabel="Previous"
      />
    );

    expect(screen.getByTestId("series-current")).not.toHaveAttribute(
      "data-stroke-dasharray"
    );
    expect(screen.getByTestId("series-previous")).toHaveAttribute(
      "data-stroke-dasharray"
    );

    rerender(
      <ConversationVolumeChart
        comparisonPeriod={comparisonPeriod}
        current={current}
        previous={[]}
        comparisonEnabled
        currentLabel="Current"
        previousLabel="Previous"
      />
    );

    expect(screen.getByTestId("series-previous")).toHaveAttribute(
      "data-stroke-dasharray",
      "4 4"
    );
    expect(readChartData().map(day => day.previous)).toEqual([0, 0]);
    expect(screen.getByText("Previous")).toBeVisible();
    expect(screen.getByText("Current: 5. Previous: 0.")).toHaveClass("sr-only");
  });

  it("provides a localized textual total summary for assistive technology", () => {
    render(
      <ConversationVolumeChart
        comparisonPeriod={comparisonPeriod}
        current={current}
        previous={previous}
        comparisonEnabled
        currentLabel="Current"
        previousLabel="Previous"
      />
    );

    expect(screen.getByText("Current: 5. Previous: 18.")).toHaveClass(
      "sr-only"
    );
  });

  it("shows the period totals and their change above the chart", () => {
    const { rerender } = render(
      <ConversationVolumeChart
        comparisonPeriod={comparisonPeriod}
        current={current}
        previous={previous}
        comparisonEnabled
        currentLabel="Current"
        previousLabel="Previous"
      />
    );

    const totals = screen.getByTestId("conversation-volume-totals");
    // The sr-only summary already carries these numbers for assistive tech.
    expect(totals).toHaveAttribute("aria-hidden", "true");
    expect(totals).toHaveTextContent("5-72.2%Previous: 18");

    rerender(
      <ConversationVolumeChart
        comparisonPeriod={comparisonPeriod}
        current={current}
        previous={previous}
        comparisonEnabled={false}
        currentLabel="Current"
        previousLabel="Previous"
      />
    );
    expect(screen.getByTestId("conversation-volume-totals")).toHaveTextContent(
      /^5$/
    );
  });

  it("returns no chart chrome when the current series is empty", () => {
    const { container } = render(
      <ConversationVolumeChart
        comparisonPeriod={comparisonPeriod}
        current={[]}
        previous={previous}
        comparisonEnabled
        currentLabel="Current"
        previousLabel="Previous"
      />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("removes every previous-period visual and summary value when comparison is off", () => {
    render(
      <ConversationVolumeChart
        comparisonPeriod={comparisonPeriod}
        current={current}
        previous={previous}
        comparisonEnabled={false}
        currentLabel="Current"
        previousLabel="Previous"
      />
    );

    expect(screen.getByTestId("series-current")).toBeInTheDocument();
    expect(screen.queryByTestId("series-previous")).not.toBeInTheDocument();
    expect(screen.getByText("Current: 5.")).toHaveClass("sr-only");
    expect(screen.queryByText(/Previous:/)).not.toBeInTheDocument();
  });

  it("fills a missing middle calendar day before pairing periods by ordinal day", () => {
    render(
      <ConversationVolumeChart
        comparisonPeriod={{
          ...comparisonPeriod,
          current: {
            start: "2026-08-01T00:00:00.000Z",
            endExclusive: "2026-08-04T00:00:00.000Z",
          },
          previous: {
            start: "2026-07-25T00:00:00.000Z",
            endExclusive: "2026-07-28T00:00:00.000Z",
          },
        }}
        current={[
          { date: "2026-08-01", total: 2 },
          { date: "2026-08-03", total: 5 },
        ]}
        previous={[
          { date: "2026-07-25", total: 7 },
          { date: "2026-07-26", total: 11 },
          { date: "2026-07-27", total: 13 },
        ]}
        comparisonEnabled
        currentLabel="Current"
        previousLabel="Previous"
      />
    );

    expect(readChartData()).toEqual([
      {
        ordinal: 1,
        axisDate: "2026-08-01",
        currentDate: "2026-08-01",
        current: 2,
        previousDate: "2026-07-25",
        previous: 7,
      },
      {
        ordinal: 2,
        axisDate: "2026-08-02",
        currentDate: "2026-08-02",
        current: 0,
        previousDate: "2026-07-26",
        previous: 11,
      },
      {
        ordinal: 3,
        axisDate: "2026-08-03",
        currentDate: "2026-08-03",
        current: 5,
        previousDate: "2026-07-27",
        previous: 13,
      },
    ]);
  });

  it("aligns every intersecting local day for rolling partial-day ranges across DST", () => {
    render(
      <ConversationVolumeChart
        comparisonPeriod={{
          preset: "custom",
          strategy: "adjacent_equal_duration",
          timeZone: "America/New_York",
          current: {
            start: "2026-10-30T12:00:00.000Z",
            endExclusive: "2026-11-03T12:00:00.000Z",
          },
          previous: {
            start: "2026-10-26T12:00:00.000Z",
            endExclusive: "2026-10-30T12:00:00.000Z",
          },
        }}
        current={[
          { date: "2026-10-30", total: 2 },
          { date: "2026-11-01", total: 3 },
          { date: "2026-11-03", total: 5 },
        ]}
        previous={[
          { date: "2026-10-26", total: 7 },
          { date: "2026-10-28", total: 11 },
          { date: "2026-10-30", total: 13 },
        ]}
        comparisonEnabled
        currentLabel="Current"
        previousLabel="Previous"
      />
    );

    const data = readChartData();
    expect(data).toHaveLength(5);
    expect(data.map(day => [day.currentDate, day.current])).toEqual([
      ["2026-10-30", 2],
      ["2026-10-31", 0],
      ["2026-11-01", 3],
      ["2026-11-02", 0],
      ["2026-11-03", 5],
    ]);
    expect(data.map(day => [day.previousDate, day.previous])).toEqual([
      ["2026-10-26", 7],
      ["2026-10-27", 0],
      ["2026-10-28", 11],
      ["2026-10-29", 0],
      ["2026-10-30", 13],
    ]);
  });

  it("names the chart region from its localized visible title", () => {
    render(
      <ConversationVolumeChart
        comparisonPeriod={comparisonPeriod}
        current={current}
        previous={previous}
        comparisonEnabled
        currentLabel="Current"
        previousLabel="Previous"
      />
    );

    expect(screen.getByRole("img", { name: "Inquiry volume" })).toHaveAttribute(
      "aria-describedby"
    );
  });
});
