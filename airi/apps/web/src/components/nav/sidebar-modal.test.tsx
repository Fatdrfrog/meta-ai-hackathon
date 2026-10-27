/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { SidebarModal } from "./sidebar-modal";

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () =>
    function DynamicMock() {
      return <nav aria-label="sidebar navigation" />;
    },
}));

jest.mock("next/navigation", () => ({
  usePathname: () => "/panel/w/workspace-1/requests",
}));

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => {
    const messages: Record<string, Record<string, string>> = {
      Sheet: {
        close: "Close",
      },
      Sidebar: {
        mobileSidebarTitle: "Sidebar",
        mobileSidebarDescription: "Displays the mobile sidebar.",
      },
    };

    return messages[namespace]?.[key] ?? key;
  },
}));

jest.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

describe("SidebarModal", () => {
  it("opens with an accessible title and description", () => {
    render(
      <SidebarModal workspaceId="workspace-1" open onOpenChange={jest.fn()} />
    );

    const dialog = screen.getByRole("dialog", { name: "Sidebar" });
    expect(dialog).toHaveAccessibleDescription("Displays the mobile sidebar.");
    expect(screen.getByLabelText("sidebar navigation")).toBeInTheDocument();
  });
});
