/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { StatsCard } from "./StatsCard";

describe("StatsCard trend context", () => {
  it.each([
    { value: 12.5, isPositive: true, text: "+12.5%" },
    { value: -8.5, isPositive: false, text: "-8.5%" },
    { value: 0, isPositive: true, text: "0%" },
    { value: -4, isPositive: true, text: "-4%" },
  ])("shows the signed change $text without relying on color", trend => {
    render(<StatsCard title="AI spend" value="$12" trend={trend} />);

    expect(screen.getByText(trend.text)).toBeTruthy();
    expect(screen.getByText("$12")).toBeTruthy();
  });
});
