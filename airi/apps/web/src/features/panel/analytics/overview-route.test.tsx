/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import OverviewRoute from "./overview-route";

jest.mock("@/features/panel/shared/workspace/server-context", () => ({
  getReadOnlySupabaseUser: async () => ({ id: "member-1" }),
}));

jest.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
jest.mock("@/components/ui/page-header", () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
jest.mock("@/components/dashboard/dashboard-page-client", () => ({
  DashboardPageClient: ({
    workspaceId,
    customizable,
    memberId,
  }: {
    workspaceId: string;
    customizable?: boolean;
    memberId?: string;
  }) => (
    <div
      data-testid="dashboard"
      data-workspace={workspaceId}
      data-customizable={String(customizable)}
      data-member={memberId}
    />
  ),
}));

it("composes the existing dashboard controller in board mode without nesting analytics layouts", async () => {
  render(
    await OverviewRoute({
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    })
  );
  expect(screen.getByTestId("dashboard").getAttribute("data-workspace")).toBe(
    "workspace-1"
  );
  expect(
    screen.getByTestId("dashboard").getAttribute("data-customizable")
  ).toBe("true");
  expect(screen.getByTestId("dashboard").getAttribute("data-member")).toBe(
    "member-1"
  );
  expect(screen.getByRole("heading", { name: "title" })).toBeTruthy();
});
