import type { CSSProperties } from "react";

export const chartDefaultColor = "var(--chart-1)";

export const chartAxisTickStyle = {
  fill: "var(--muted-foreground)",
} as const;

export const chartAxisLineStyle = {
  stroke: "var(--border)",
} as const;

export const chartTooltipContentStyle: CSSProperties = {
  backgroundColor: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  boxShadow: "0 10px 24px rgb(0 0 0 / 0.12), 0 2px 8px rgb(0 0 0 / 0.08)",
  color: "var(--popover-foreground)",
  fontSize: "12px",
};

export const chartTooltipLabelStyle: CSSProperties = {
  color: "var(--popover-foreground)",
  fontWeight: 600,
};

export const chartTooltipItemStyle: CSSProperties = {
  color: "var(--popover-foreground)",
};

export const chartTooltipCursorStyle = {
  fill: "var(--muted)",
  fillOpacity: 0.45,
} as const;
