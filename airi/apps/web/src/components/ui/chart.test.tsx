/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { ChartContainer, ChartTooltipContent } from "./chart";

jest.mock("recharts", () => ({
  ...jest.requireActual("recharts"),
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
    children,
}));

function TooltipFixture({
  value = 28,
  ...props
}: React.ComponentProps<typeof ChartTooltipContent> & { value?: number }) {
  return (
    <ChartContainer config={{ conversations: { label: "Conversations" } }}>
      <ChartTooltipContent
        active
        accessibilityLayer
        label="Day 1"
        payload={[
          {
            dataKey: "conversations",
            name: "conversations",
            value,
            payload: {},
          },
        ]}
        {...props}
      />
    </ChartContainer>
  );
}

describe("ChartTooltipContent accessibility", () => {
  it("retains a live region when the chart updates its values", () => {
    const { rerender } = render(<TooltipFixture />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");
    expect(status).toHaveTextContent("Conversations28");
    rerender(<TooltipFixture value={34} />);
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Conversations34");
  });

  it("preserves explicit accessibility attributes without sending Recharts props to the DOM", () => {
    render(
      <TooltipFixture
        id="chart-values"
        role="status"
        aria-label="Daily values"
        aria-live="assertive"
        aria-atomic={false}
        coordinate={{ x: 1, y: 2 }}
      />
    );
    const status = screen.getByRole("status", { name: "Daily values" });
    expect(status).toHaveAttribute("id", "chart-values");
    expect(status).toHaveAttribute("aria-live", "assertive");
    expect(status).toHaveAttribute("aria-atomic", "false");
    expect(status).not.toHaveAttribute("coordinate");
    expect(status).not.toHaveAttribute("accessibilityLayer");
  });

  it("does not announce pointer-only charts or inactive tooltips", () => {
    const { container, rerender } = render(
      <TooltipFixture accessibilityLayer={false} />
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(screen.getByText("28")).toBeVisible();
    rerender(<TooltipFixture active={false} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText("28")).not.toBeInTheDocument();
  });
});
