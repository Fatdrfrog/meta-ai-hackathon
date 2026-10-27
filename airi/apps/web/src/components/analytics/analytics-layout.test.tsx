/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { AnalyticsLayout } from "./analytics-layout";

let mockPathname = "/panel/w/workspace-1/analytics/llm";
jest.mock("next/navigation", () => ({ usePathname: () => mockPathname }));

it("highlights only the specialist report under the dashboards home", () => {
  const { container } = render(
    <AnalyticsLayout workspaceId="workspace-1">Report</AnalyticsLayout>
  );
  expect(screen.getByRole("link", { name: "nav.ai" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  expect(
    screen.getByRole("link", { name: "nav.dashboards" })
  ).not.toHaveAttribute("aria-current");
  expect(screen.getAllByRole("navigation")).toHaveLength(1);
  expect(screen.getAllByRole("link")).toHaveLength(7);
  expect(container.querySelector("svg")).toBeNull();
});

it("highlights dashboards only at its exact URL", () => {
  mockPathname = "/panel/w/workspace-1/analytics";
  render(
    <AnalyticsLayout workspaceId="workspace-1">Dashboards</AnalyticsLayout>
  );
  expect(screen.getByRole("link", { name: "nav.dashboards" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  expect(
    screen.getByRole("link", { name: "nav.conversations" })
  ).toHaveAttribute("href", "/panel/w/workspace-1/dashboard");
});

it("keeps campaign analytics selected after its canonical route redirect", () => {
  mockPathname = "/panel/w/workspace-1/bulk-campaigns";
  render(
    <AnalyticsLayout workspaceId="workspace-1">Campaign report</AnalyticsLayout>
  );
  expect(screen.getByRole("link", { name: "nav.campaigns" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  expect(
    screen.getByRole("link", { name: "nav.dashboards" })
  ).not.toHaveAttribute("aria-current");
});
