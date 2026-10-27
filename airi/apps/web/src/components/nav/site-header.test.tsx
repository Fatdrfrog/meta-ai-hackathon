/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { SiteHeader } from "./site-header";

const mockUseCompanyLimits = jest.fn();
const mockSetSidebarOpen = jest.fn();
let mockPathname = "/panel/w/workspace-1/requests";

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () =>
    function DynamicMock() {
      return null;
    },
}));

jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => {
    const messages: Record<string, Record<string, string>> = {
      SiteHeader: {
        bookDemo: "Book a demo",
        toggleSidebar: "Toggle sidebar",
        toggleTheme: "Toggle theme",
        lightTheme: "Light theme",
        darkTheme: "Dark theme",
        systemTheme: "System settings",
        upgrade: "Upgrade",
        openAiriChat: "Open Airi chat",
      },
    };

    return messages[namespace]?.[key] ?? key;
  },
}));

jest.mock("next-themes", () => ({
  useTheme: () => ({ setTheme: jest.fn() }),
}));

jest.mock("jotai", () => ({
  useAtom: () => [null, jest.fn()],
  useAtomValue: () => null,
  useSetAtom: () => jest.fn(),
}));

jest.mock("@/components/nav/layout-content", () => ({
  useSidebarModal: () => ({ setOpen: mockSetSidebarOpen }),
}));

jest.mock("@/components/nav/workspace-onboarding-nav-helper", () => ({
  WorkspaceOnboardingNavHelper: () => {
    const Link = jest.requireActual("next/link")
      .default as typeof import("next/link").default;
    return <Link href="/panel/w/workspace-1/airi">Test Airi</Link>;
  },
}));

jest.mock("@/components/nav/whatsapp-business-username-nav-action", () => ({
  WhatsAppBusinessUsernameNavAction: ({
    workspaceId,
  }: {
    workspaceId: string;
  }) => (
    <button data-workspace-id={workspaceId} type="button">
      Create WhatsApp @username
    </button>
  ),
}));

jest.mock("@/components/workspaces/workspace-switcher", () => ({
  WorkspaceSwitcher: () => <button type="button">Workspace</button>,
}));

jest.mock("@/components/settings/language-switcher", () => ({
  LanguageSwitcher: () => <button type="button">Language</button>,
}));

const mockPreloadAiriChatModal = jest.fn();

jest.mock("@/components/ai/airi-chat-modal", () => ({
  AiriChatModal: ({ open }: { open: boolean }) => (
    <div data-open={String(open)} data-testid="airi-chat-modal" />
  ),
  preloadAiriChatModal: () => mockPreloadAiriChatModal(),
}));

jest.mock("@/components/billing/plan-upgrade-dialog", () => ({
  PlanUpgradeDialog: ({
    open,
    subscriptionType,
  }: {
    open: boolean;
    subscriptionType: string;
  }) => (
    <div
      data-open={String(open)}
      data-plan={subscriptionType}
      data-testid="plan-upgrade-dialog"
    />
  ),
}));

jest.mock("@/hooks/use-company-limits", () => ({
  useCompanyLimits: (workspaceId: string | null | undefined) =>
    mockUseCompanyLimits(workspaceId),
}));

jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

describe("SiteHeader", () => {
  beforeEach(() => {
    mockUseCompanyLimits.mockReset();
    mockUseCompanyLimits.mockReturnValue({
      data: { subscriptionType: "free" },
    });
    mockPathname = "/panel/w/workspace-1/requests";
  });

  it("shows the top-navbar upgrade button for free workspaces", () => {
    render(<SiteHeader workspaceId="workspace-1" />);

    expect(mockUseCompanyLimits).toHaveBeenCalledWith("workspace-1");
    const upgradeButton = screen.getByRole("button", { name: "Upgrade" });
    expect(upgradeButton).toBeInTheDocument();
    expect(upgradeButton).toHaveClass("hidden", "sm:inline-flex");
  });

  it("opens the plan picker from the top-navbar upgrade button", () => {
    render(<SiteHeader workspaceId="workspace-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));

    expect(screen.getByTestId("plan-upgrade-dialog")).toHaveAttribute(
      "data-open",
      "true"
    );
  });

  it("does not show the upgrade button for paid workspaces", () => {
    mockUseCompanyLimits.mockReturnValue({
      data: { subscriptionType: "pro" },
    });

    const { rerender } = render(<SiteHeader workspaceId="workspace-1" />);

    expect(
      screen.queryByRole("button", { name: "Upgrade" })
    ).not.toBeInTheDocument();

    mockUseCompanyLimits.mockReturnValue({
      data: { subscriptionType: "enterprise" },
    });

    rerender(<SiteHeader workspaceId="workspace-1" />);

    expect(
      screen.queryByRole("button", { name: "Upgrade" })
    ).not.toBeInTheDocument();
  });

  it("shows Airi as a purple header action button instead of a shortcut hint", async () => {
    render(<SiteHeader workspaceId="workspace-1" />);

    expect(screen.queryByTestId("airi-shortcut-hint")).not.toBeInTheDocument();
    expect(screen.queryByText("Ask Airi")).not.toBeInTheDocument();
    const airiButton = screen.getByRole("button", { name: "Open Airi chat" });
    expect(airiButton).toHaveClass("bg-violet-100", "border-0");
    expect(airiButton).toHaveClass("inline-flex");
    expect(airiButton).not.toHaveClass("hidden");

    fireEvent.click(airiButton);

    expect(await screen.findByTestId("airi-chat-modal")).toHaveAttribute(
      "data-open",
      "true"
    );
  });

  it("renders the WhatsApp username action inside workspace desktop header actions", () => {
    render(<SiteHeader workspaceId="workspace-1" />);

    expect(
      screen.getByRole("button", { name: "Create WhatsApp @username" })
    ).toHaveAttribute("data-workspace-id", "workspace-1");
  });

  it("opens the global Airi chat with Ctrl+K outside editable fields", async () => {
    render(<SiteHeader workspaceId="workspace-1" />);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(await screen.findByTestId("airi-chat-modal")).toHaveAttribute(
      "data-open",
      "true"
    );
  });

  it("opens the global Airi chat with Ctrl+K while a text field is focused", async () => {
    render(
      <>
        <input aria-label="Panel search" />
        <SiteHeader workspaceId="workspace-1" />
      </>
    );

    screen.getByLabelText("Panel search").focus();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(await screen.findByTestId("airi-chat-modal")).toHaveAttribute(
      "data-open",
      "true"
    );
  });

  it("hides the global Airi chat CTA and shortcut on the canonical Airi page", () => {
    mockPathname = "/panel/w/workspace-1/airi";

    render(<SiteHeader workspaceId="workspace-1" />);

    expect(
      screen.queryByRole("button", { name: "Open Airi chat" })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Ask Airi")).not.toBeInTheDocument();
    expect(screen.queryByTestId("airi-shortcut-hint")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Test Airi" })
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("airi-chat-modal")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(screen.queryByTestId("airi-chat-modal")).not.toBeInTheDocument();
  });

  it("does not reopen the drawer after a visit to the Airi page", async () => {
    const view = render(<SiteHeader workspaceId="workspace-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Open Airi chat" }));
    expect(await screen.findByTestId("airi-chat-modal")).toBeInTheDocument();

    mockPathname = "/panel/w/workspace-1/airi";
    view.rerender(<SiteHeader workspaceId="workspace-1" />);
    expect(screen.queryByTestId("airi-chat-modal")).not.toBeInTheDocument();

    mockPathname = "/panel/w/workspace-1/requests";
    view.rerender(<SiteHeader workspaceId="workspace-1" />);
    expect(screen.queryByTestId("airi-chat-modal")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open Airi chat" })
    ).toBeInTheDocument();
  });

  it("starts the drawer download on hover and focus of the Airi button", () => {
    mockPreloadAiriChatModal.mockClear();
    render(<SiteHeader workspaceId="workspace-1" />);
    const airiButton = screen.getByRole("button", { name: "Open Airi chat" });

    fireEvent.pointerEnter(airiButton);
    fireEvent.focus(airiButton);

    expect(mockPreloadAiriChatModal).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("airi-chat-modal")).not.toBeInTheDocument();
  });
});
