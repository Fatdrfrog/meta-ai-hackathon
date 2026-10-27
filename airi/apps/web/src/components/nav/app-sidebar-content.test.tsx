/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { AppSidebarContent } from "./app-sidebar-content";

const mockNavMainItems: Array<{ title: string; url: string }> = [];
const mockNavSecondaryItems: Array<{ title: string; url: string }> = [];

jest.mock("next/navigation", () => ({
  usePathname: () => "/panel/w/workspace-1/requests",
}));

jest.mock("next-themes", () => ({
  useTheme: () => ({ theme: "light" }),
}));

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const labels: Record<string, string> = {
      airiChat: "Airi chat",
      requests: "Customer chats",
      tasks: "Tasks",
      settings: "Settings",
      integrations: "Integrations",
      help: "Help",
      defaultUserName: "User",
      knowledgeBase: "Knowledge base",
      scenarios: "Scenarios",
      bulkCampaigns: "Bulk campaigns",
      customers: "Leads",
      "messengers.title": "WhatsApp Manager",
      "analytics.title": "Analytics",
      "widget.title": "Web widget",
      "widget.analytics": "Analytics",
      "widget.branding": "Branding",
    };

    return labels[key] ?? key;
  },
}));

jest.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getUser: jest.fn(async () => ({
        data: {
          user: {
            email: "user@example.com",
            user_metadata: {},
          },
        },
      })),
    },
  }),
}));

jest.mock("@/components/ui/sidebar", () => ({
  SidebarContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarFooter: ({ children }: { children: ReactNode }) => (
    <footer>{children}</footer>
  ),
  SidebarHeader: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
  SidebarMenu: ({ children }: { children: ReactNode }) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => (
    <li>{children}</li>
  ),
}));

jest.mock("@/components/nav/nav-main", () => ({
  NavMain: ({
    items,
  }: {
    items: Array<{ title: string; url: string }>;
    pathname: string;
  }) => {
    mockNavMainItems.splice(0, mockNavMainItems.length, ...items);

    return (
      <nav aria-label="main nav">
        {items.map(item => (
          <a key={item.url} href={item.url}>
            {item.title}
          </a>
        ))}
      </nav>
    );
  },
}));

jest.mock("@/components/nav/nav-secondary", () => ({
  NavSecondary: ({
    items,
  }: {
    items: Array<{ title: string; url: string }>;
    pathname: string;
  }) => {
    mockNavSecondaryItems.splice(0, mockNavSecondaryItems.length, ...items);

    return (
      <nav aria-label="secondary nav">
        {items.map(item => (
          <a key={item.url} href={item.url}>
            {item.title}
          </a>
        ))}
      </nav>
    );
  },
}));

jest.mock("@/components/nav/nav-user", () => ({
  NavUser: () => null,
}));

jest.mock("@/components/nav/workspace-onboarding-helper", () => ({
  WorkspaceOnboardingHelper: () => null,
}));

jest.mock("@/components/nav/company-limit-status", () => ({
  CompanyLimitStatus: () => null,
}));

jest.mock("next/image", () => ({
  __esModule: true,
  default: ({ alt }: { alt: string }) => <span aria-label={alt} />,
}));

jest.mock("../assets/logo_short_black.svg", () => "black-logo.svg");
jest.mock("../assets/logo_short_white.svg", () => "white-logo.svg");

describe("AppSidebarContent", () => {
  beforeEach(() => {
    mockNavMainItems.splice(0, mockNavMainItems.length);
    mockNavSecondaryItems.splice(0, mockNavSecondaryItems.length);
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        sources: [],
        emailProviderConnected: false,
        emailSources: [],
      }),
    })) as jest.Mock;
    global.requestAnimationFrame = jest.fn(callback => {
      callback(0);
      return 1;
    });
    global.cancelAnimationFrame = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("opens the starter dashboards from the main Analytics entry", async () => {
    render(<AppSidebarContent workspaceId="workspace-1" />);
    await waitFor(() => expect(mockNavMainItems.length).toBeGreaterThan(0));
    expect(mockNavMainItems.find(item => item.title === "Analytics")?.url).toBe(
      "/panel/w/workspace-1/analytics"
    );
  });

  it("does not expose the removed tasks panel route in main navigation", async () => {
    render(<AppSidebarContent workspaceId="workspace-1" />);

    await waitFor(() => {
      expect(screen.getByLabelText("main nav")).toBeInTheDocument();
    });

    expect(
      screen.queryByRole("link", { name: "Tasks" })
    ).not.toBeInTheDocument();
    expect(mockNavMainItems.map(item => item.url)).not.toContain(
      "/panel/w/workspace-1/tasks"
    );
  });

  it("shows Airi chat separately from customer chats", async () => {
    render(<AppSidebarContent workspaceId="workspace-1" />);

    await waitFor(() => {
      expect(screen.getByLabelText("main nav")).toBeInTheDocument();
    });

    expect(screen.getByRole("link", { name: "Airi chat" })).toHaveAttribute(
      "href",
      "/panel/w/workspace-1/airi"
    );
    expect(
      screen.getByRole("link", { name: "Customer chats" })
    ).toHaveAttribute("href", "/panel/w/workspace-1/requests");
    expect(screen.getByRole("link", { name: "Leads" })).toHaveAttribute(
      "href",
      "/panel/w/workspace-1/leads"
    );
  });

  it("labels the settings entry by its concrete destination", async () => {
    render(<AppSidebarContent workspaceId="workspace-1" />);

    await waitFor(() => {
      expect(screen.getByLabelText("main nav")).toBeInTheDocument();
    });

    expect(screen.getByRole("link", { name: "Integrations" })).toHaveAttribute(
      "href",
      "/panel/w/workspace-1/settings/integrations"
    );
    expect(mockNavSecondaryItems.map(item => item.title)).toContain(
      "Integrations"
    );
    expect(mockNavSecondaryItems.map(item => item.title)).not.toContain(
      "Settings"
    );
  });
});
