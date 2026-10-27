"use client";

import {
  CartesianGrid,
  Line,
  LineChart as RechartsLineChart,
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
  chartTooltipItemStyle,
  chartTooltipLabelStyle,
} from "./chart-theme";

export interface LineChartData {
  date: string;
  value: number;
  label?: string;
}

interface LineChartProps {
  data: LineChartData[];
  emptyLabel: string;
  valueLabel: string;
  height?: number;
  color?: string;
  formatValue?: (value: number) => string;
  showGrid?: boolean;
}

function LineChartTooltip({
  active,
  payload,
  label,
  valueLabel,
  formatValue,
}: {
  active?: boolean;
  payload?: Array<{
    payload?: LineChartData;
    value?: number | string;
  }>;
  label?: string | number;
  valueLabel: string;
  formatValue?: (value: number) => string;
}) {
  if (!active || !payload?.length) return null;

  const item = payload[0];
  const data = item.payload;
  const title = data?.label || data?.date || String(label ?? "");
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
    </div>
  );
}

export function LineChart({
  data,
  emptyLabel,
  valueLabel,
  height = 300,
  color = chartDefaultColor,
  formatValue,
  showGrid = true,
}: LineChartProps) {
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
      <RechartsLineChart
        data={data}
        margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
      >
        {showGrid && (
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        )}
        <XAxis
          dataKey="date"
          className="text-xs"
          tick={chartAxisTickStyle}
          tickLine={chartAxisLineStyle}
        />
        <YAxis
          className="text-xs"
          tick={chartAxisTickStyle}
          tickLine={chartAxisLineStyle}
        />
        <Tooltip
          content={
            <LineChartTooltip
              valueLabel={valueLabel}
              formatValue={formatValue}
            />
          }
          contentStyle={chartTooltipContentStyle}
          itemStyle={chartTooltipItemStyle}
          labelStyle={chartTooltipLabelStyle}
        />
        <Line
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
        />
      </RechartsLineChart>
    </ResponsiveContainer>
  );
}
