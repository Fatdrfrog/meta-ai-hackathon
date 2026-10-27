/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { BarChart } from "./BarChart";
import { LineChart } from "./LineChart";

jest.mock("recharts", () => {
  const React = jest.requireActual<typeof import("react")>("react");

  function Container({ children }: { children?: ReactNode }) {
    return React.createElement("div", null, children);
  }

  function Tooltip({ content }: { content?: ReactElement }) {
    if (!React.isValidElement(content)) return null;

    return React.cloneElement(
      content as ReactElement<Record<string, unknown>>,
      {
        active: true,
        label: "31 июл.",
        payload: [
          {
            value: 1234.5,
            payload: {
              date: "31 июл.",
              name: "Пользовательская серия",
              value: 1234.5,
            },
          },
        ],
      }
    );
  }

  return {
    Bar: () => null,
    BarChart: Container,
    CartesianGrid: () => null,
    Line: () => null,
    LineChart: Container,
    ResponsiveContainer: Container,
    Tooltip,
    XAxis: () => null,
    YAxis: () => null,
  };
});

describe("generic analytics chart localization", () => {
  it.each([
    ["bar", BarChart],
    ["line", LineChart],
  ] as const)("renders the caller-owned empty label for %s charts", (_, Chart) => {
    render(
      <Chart
        data={[]}
        emptyLabel="Нет данных для графика"
        valueLabel="Значение"
      />
    );

    expect(screen.getByText("Нет данных для графика")).toBeTruthy();
    expect(screen.queryByText("No data available")).toBeNull();
  });

  it.each([
    [
      "bar",
      <BarChart
        key="bar"
        data={[{ name: "Пользовательская серия", value: 1234.5 }]}
        emptyLabel="Нет данных для графика"
        valueLabel="Значение"
        formatValue={value => `формат ${String(value).replace(".", ",")}`}
      />,
    ],
    [
      "line",
      <LineChart
        key="line"
        data={[{ date: "31 июл.", value: 1234.5 }]}
        emptyLabel="Нет данных для графика"
        valueLabel="Значение"
        formatValue={value => `формат ${String(value).replace(".", ",")}`}
      />,
    ],
  ] as const)("renders the caller-owned value label and formatter for %s tooltips", (_, chart) => {
    render(chart);

    expect(screen.getByText("Значение: формат 1234,5")).toBeTruthy();
    expect(screen.queryByText(/^Value:/)).toBeNull();
  });
});
