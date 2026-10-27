/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import AnalyticsSectionLayout from "@/app/panel/w/[workspaceId]/analytics/layout";
import OverviewRoute from "@/app/panel/w/[workspaceId]/analytics/page";
import OutcomesRoute from "@/app/panel/w/[workspaceId]/analytics/outcomes/page";
import LlmRoute from "@/app/panel/w/[workspaceId]/analytics/llm/page";

let mockPathname = "/panel/w/workspace-1/analytics";
const mockGetUser = jest.fn(
  async (): Promise<{ id: string } | null> => ({
    id: "member-1",
  })
);
const mockRedirect = jest.fn((href: string) => {
  throw new Error(`Redirect: ${href}`);
});

jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  redirect: (href: string) => mockRedirect(href),
}));
jest.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
jest.mock("@/features/panel/shared/workspace/server-context", () => ({
  getReadOnlySupabaseUser: () => mockGetUser(),
}));
jest.mock("@/i18n/message-loader", () => ({
  getLocaleFromCookie: async () => "en",
  loadAnalyticsClientMessages: async () => ({}),
  loadConversationsClientMessages: async () => ({}),
}));
jest.mock("@/components/i18n/scoped-intl-provider", () => ({
  ScopedIntlProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock("@/components/dashboard/dashboard-page-client", () => ({
  DashboardPageClient: () => <div data-testid="report">Conversation data</div>,
}));
jest.mock("@/components/analytics/llm-analytics-page", () => ({
  LlmAnalyticsPage: () => <div data-testid="report">AI data</div>,
}));
jest.mock("@/components/analytics/journey-analytics", () => ({
  JourneyAnalytics: ({
    workspaceId,
    memberId,
  }: {
    workspaceId: string;
    memberId?: string;
  }) => (
    <div
      data-testid="report"
      data-workspace={workspaceId}
      data-member={memberId}
    >
      Outcome data
    </div>
  ),
}));

beforeEach(() => {
  mockGetUser.mockResolvedValue({ id: "member-1" });
  mockRedirect.mockClear();
});

it.each([
  ["dashboards", "", () => OverviewRoute({ params: routeParams() })],
  ["outcomes", "/outcomes", () => OutcomesRoute({ params: routeParams() })],
  [
    "ai",
    "/llm",
    () =>
      LlmRoute({
        params: routeParams(),
        searchParams: Promise.resolve({}),
      }),
  ],
] as const)(
  "renders the %s App Router page inside exactly one analytics shell",
  async (activeItem, suffix, page) => {
    mockPathname = `/panel/w/workspace-1/analytics${suffix}`;
    const { container } = render(
      await AnalyticsSectionLayout({
        params: routeParams(),
        children: await page(),
      })
    );

    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(container.querySelectorAll("[data-analytics-content]")).toHaveLength(
      1
    );
    expect(screen.getAllByRole("link")).toHaveLength(7);
    expect(
      screen.getByRole("link", { name: `nav.${activeItem}` })
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("report")).toBeVisible();
  }
);

it("passes the authenticated member into the personal outcomes workspace", async () => {
  render(await OutcomesRoute({ params: routeParams() }));

  expect(screen.getByTestId("report")).toHaveAttribute(
    "data-workspace",
    "workspace-1"
  );
  expect(screen.getByTestId("report")).toHaveAttribute(
    "data-member",
    "member-1"
  );
});

it("redirects an unauthenticated outcomes request before rendering a personal workspace", async () => {
  mockGetUser.mockResolvedValueOnce(null);

  await expect(OutcomesRoute({ params: routeParams() })).rejects.toThrow(
    "Redirect: /login"
  );
  expect(mockRedirect).toHaveBeenCalledWith("/login");
});

function routeParams() {
  return Promise.resolve({ workspaceId: "workspace-1" });
}
