"use client";

import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  chartAxisLineStyle,
  chartAxisTickStyle,
  chartDefaultColor,
  chartTooltipContentStyle,
  chartTooltipCursorStyle,
  chartTooltipItemStyle,
  chartTooltipLabelStyle,
} from "./chart-theme";

export interface BarChartData {
  name: string;
  value: number;
  label?: string;
  tooltipLabel?: string;
}

interface BarChartProps {
  data: BarChartData[];
  emptyLabel: string;
  valueLabel: string;
  height?: number;
  color?: string;
  formatValue?: (value: number) => string;
  showGrid?: boolean;
  horizontal?: boolean;
}

function BarChartTooltip({
  active,
  payload,
  label,
  valueLabel,
  formatValue,
}: {
  active?: boolean;
  payload?: Array<{
    payload?: BarChartData;
    value?: number | string;
  }>;
  label?: string | number;
  valueLabel: string;
  formatValue?: (value: number) => string;
}) {
  if (!active || !payload?.length) return null;

  const item = payload[0];
  const data = item.payload;
  const title = data?.tooltipLabel || data?.name || String(label || "");
  const value = item.value ?? data?.value ?? 0;
  const formattedValue =
    typeof value === "number" && formatValue
      ? formatValue(value)
      : String(value);

  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg">
      <div className="font-medium">{title}</div>
      <div className="mt-1 text-muted-foreground">
        {valueLabel}: {formattedValue}
      </div>
      {data?.label ? (
        <div className="mt-0.5 text-muted-foreground">{data.label}</div>
      ) : null}
    </div>
  );
}

export function BarChart({
  data,
  emptyLabel,
  valueLabel,
  height = 300,
  color = chartDefaultColor,
  formatValue,
  showGrid = true,
  horizontal = false,
}: BarChartProps) {
  if (!data || data.length === 0) {
    return (
      <div
        className="flex items-center justify-center bg-muted/30 rounded-lg"
        style={{ height }}
      >
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <RechartsBarChart
        data={data}
        layout={horizontal ? "vertical" : "horizontal"}
        margin={{ top: 5, right: 10, left: horizontal ? 60 : 0, bottom: 5 }}
      >
        {showGrid && (
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        )}
        {horizontal ? (
          <>
            <XAxis
              type="number"
              className="text-xs"
              tick={chartAxisTickStyle}
              tickLine={chartAxisLineStyle}
            />
            <YAxis
              type="category"
              dataKey="name"
              className="text-xs"
              tick={chartAxisTickStyle}
              tickLine={chartAxisLineStyle}
              width={100}
            />
          </>
        ) : (
          <>
            <XAxis
              dataKey="name"
              className="text-xs"
              tick={chartAxisTickStyle}
              tickLine={chartAxisLineStyle}
            />
            <YAxis
              className="text-xs"
              tick={chartAxisTickStyle}
              tickLine={chartAxisLineStyle}
            />
          </>
        )}
        <Tooltip
          content={
            <BarChartTooltip
              valueLabel={valueLabel}
              formatValue={formatValue}
            />
          }
          contentStyle={chartTooltipContentStyle}
          cursor={chartTooltipCursorStyle}
          itemStyle={chartTooltipItemStyle}
          labelStyle={chartTooltipLabelStyle}
        />
        <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} />
      </RechartsBarChart>
    </ResponsiveContainer>
  );
}
