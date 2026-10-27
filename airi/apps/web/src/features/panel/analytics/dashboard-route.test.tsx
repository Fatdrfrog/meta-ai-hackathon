/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react";

import DashboardPage from "./dashboard-route";

const mockPageHeader = jest.fn();
const mockGetTranslations = jest.fn();

jest.mock("next-intl/server", () => ({
  getTranslations: (...args: unknown[]) => mockGetTranslations(...args),
}));

jest.mock("@/components/analytics/analytics-layout", () => ({
  AnalyticsLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="analytics-layout">{children}</div>
  ),
}));

jest.mock("@/components/dashboard/dashboard-page-client", () => ({
  DashboardPageClient: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="dashboard-client">{workspaceId}</div>
  ),
}));

jest.mock("@/components/ui/page-header", () => ({
  PageHeader: (props: {
    title: string;
    description?: string;
    primaryAction?: React.ReactNode;
  }) => {
    mockPageHeader(props);
    return (
      <header>
        <h1>{props.title}</h1>
        {props.description ? <p>{props.description}</p> : null}
        {props.primaryAction}
      </header>
    );
  },
}));

describe("DashboardPage", () => {
  beforeEach(() => {
    mockPageHeader.mockClear();
    mockGetTranslations.mockResolvedValue((key: string) =>
      ({
        title: "Панель аналитики",
        description: "Обзор обращений и тенденций поддержки.",
      })[key]
    );
  });

  it("does not render the legacy New Request action", async () => {
    render(
      await DashboardPage({
        params: Promise.resolve({ workspaceId: "workspace-1" }),
      })
    );

    expect(
      screen.getByRole("heading", { name: "Панель аналитики" })
    ).toBeTruthy();
    expect(
      screen.getByText("Обзор обращений и тенденций поддержки.")
    ).toBeTruthy();
    expect(mockGetTranslations).toHaveBeenCalledWith("DashboardPage.header");
    expect(screen.queryByRole("link", { name: "New Request" })).toBeNull();
    expect(mockPageHeader).toHaveBeenCalledWith(
      expect.not.objectContaining({
        primaryAction: expect.anything(),
      })
    );
  });
});
