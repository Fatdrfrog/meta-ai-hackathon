/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { SWRConfig } from "swr";
import { WorkspaceSwitcher } from "./workspace-switcher";

const routerPush = jest.fn();
const routerPrefetch = jest.fn();
let pathname = "/panel/w/workspace-current/requests";

jest.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ prefetch: routerPrefetch, push: routerPush }),
}));

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    ({
      selectWorkspace: "Select a workspace",
      workspaces: "Workspaces",
      manageWorkspaces: "Manage workspaces",
    })[key] ?? key,
}));

jest.mock("@/components/ui/dropdown-menu", () => {
  const React = jest.requireActual<typeof import("react")>("react");

  const passThrough = ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  );

  return {
    DropdownMenu: passThrough,
    DropdownMenuTrigger: passThrough,
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: ({
      asChild,
      children,
      onClick,
      onFocus,
      onPointerEnter,
      onSelect,
      disabled,
    }: {
      asChild?: boolean;
      children: React.ReactNode;
      onClick?: React.MouseEventHandler;
      onFocus?: React.FocusEventHandler;
      onPointerEnter?: React.PointerEventHandler;
      onSelect?: React.MouseEventHandler;
      disabled?: boolean;
    }) => {
      const handleClick: React.MouseEventHandler = event => {
        if (disabled) return;
        onClick?.(event);
        onSelect?.(event);
      };

      if (asChild && React.isValidElement(children)) {
        const child = children as React.ReactElement<{
          onClick?: React.MouseEventHandler;
          onFocus?: React.FocusEventHandler;
          onPointerEnter?: React.PointerEventHandler;
        }>;

        return React.cloneElement(child, {
          onClick: event => {
            child.props.onClick?.(event);
            handleClick(event);
          },
          onFocus,
          onPointerEnter,
        });
      }

      return (
        <button
          type="button"
          disabled={disabled}
          onFocus={onFocus}
          onPointerEnter={onPointerEnter}
          onClick={handleClick}
        >
          {children}
        </button>
      );
    },
  };
});

describe("WorkspaceSwitcher", () => {
  beforeEach(() => {
    routerPush.mockClear();
    routerPrefetch.mockClear();
    pathname = "/panel/w/workspace-current/requests";
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/workspaces") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              workspaces: [
                { id: "workspace-current", name: "Current workspace" },
                { id: "workspace-next", name: "Next workspace" },
              ],
            }),
        } as Response);
      }

      if (url === "/api/workspaces/last-used") {
        return new Promise<Response>(() => undefined);
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("caps the trigger width so the phone header can fit remaining actions", async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <WorkspaceSwitcher currentWorkspaceId="workspace-current" />
      </SWRConfig>
    );

    const triggers = await screen.findAllByRole("button", {
      name: /Current workspace/,
    });
    expect(
      triggers.some(button => button.className.includes("max-w-[7rem]"))
    ).toBe(true);
  });

  it("navigates to the selected workspace without waiting for the last-used request", async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <WorkspaceSwitcher currentWorkspaceId="workspace-current" />
      </SWRConfig>
    );

    const nextWorkspaceItem = await screen.findByText("Next workspace");

    fireEvent.click(nextWorkspaceItem);

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/workspaces/last-used",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ workspaceId: "workspace-next" }),
      })
    );
    expect(routerPush).toHaveBeenCalledWith("/panel/w/workspace-next/requests");
  });

  it("falls back to Airi when the current route is workspace-specific", async () => {
    pathname = "/panel/w/workspace-current/kb/article-from-other-company";

    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <WorkspaceSwitcher currentWorkspaceId="workspace-current" />
      </SWRConfig>
    );

    fireEvent.click(await screen.findByText("Next workspace"));

    expect(routerPush).toHaveBeenCalledWith("/panel/w/workspace-next/kb");
  });

  it("prefetches the target workspace route on hover and focus", async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <WorkspaceSwitcher currentWorkspaceId="workspace-current" />
      </SWRConfig>
    );

    const nextWorkspaceItem = await screen.findByRole("button", {
      name: "Next workspace",
    });

    fireEvent.pointerEnter(nextWorkspaceItem);
    expect(routerPrefetch).toHaveBeenCalledWith(
      "/panel/w/workspace-next/requests"
    );

    routerPrefetch.mockClear();
    fireEvent.focus(nextWorkspaceItem);
    expect(routerPrefetch).toHaveBeenCalledWith(
      "/panel/w/workspace-next/requests"
    );
  });

  it("shows the selected workspace as busy while route navigation is pending", async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <WorkspaceSwitcher currentWorkspaceId="workspace-current" />
      </SWRConfig>
    );

    fireEvent.click(await screen.findByText("Next workspace"));

    await waitFor(() => {
      const busyTrigger = document.querySelector('button[aria-busy="true"]');
      expect(busyTrigger).toBeInTheDocument();
      expect(busyTrigger).toBeDisabled();
      expect(busyTrigger).toHaveTextContent("Next workspace");
    });
  });
});
