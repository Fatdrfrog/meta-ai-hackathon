/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import { WhatsAppBusinessUsernameNavAction } from "./whatsapp-business-username-nav-action";

const mockToastSuccess = jest.fn();

jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}));

jest.mock("@/components/ui/popover", () => {
  const React = jest.requireActual("react") as typeof import("react");
  const PopoverContext = React.createContext<{
    onOpenChange: (open: boolean) => void;
    open: boolean;
  }>({ onOpenChange: () => undefined, open: false });

  return {
    Popover: ({
      children,
      onOpenChange,
      open,
    }: {
      children: React.ReactNode;
      onOpenChange: (open: boolean) => void;
      open: boolean;
    }) => (
      <PopoverContext.Provider value={{ onOpenChange, open }}>
        {children}
      </PopoverContext.Provider>
    ),
    PopoverContent: ({ children }: { children: React.ReactNode }) => {
      const context = React.useContext(PopoverContext);
      return context.open ? <div role="dialog">{children}</div> : null;
    },
    PopoverTrigger: ({ children }: { children: React.ReactElement }) => {
      const context = React.useContext(PopoverContext);
      return React.cloneElement(
        children as React.ReactElement<{ onClick?: () => void }>,
        {
          onClick: () => context.onOpenChange(!context.open),
        }
      );
    },
  };
});

jest.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  SelectValue: () => <span>Do not transfer</span>,
}));

function jsonResponse(body: unknown, init?: ResponseInit) {
  const status = init?.status || 200;
  return {
    json: jest.fn().mockResolvedValue(body),
    ok: status >= 200 && status < 300,
    status,
  } as unknown as Response;
}

function renderAction(workspaceId: string) {
  return render(
    <SWRConfig value={{ dedupingInterval: 0, provider: () => new Map() }}>
      <WhatsAppBusinessUsernameNavAction workspaceId={workspaceId} />
    </SWRConfig>
  );
}

describe("WhatsAppBusinessUsernameNavAction", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  it("creates a username and hides the navbar action immediately", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ canCreate: true, hasUsername: false })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          canCreate: true,
          hasUsername: false,
          suggestions: ["airi_chat"],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          hasUsername: true,
          status: "reserved",
          username: "airi_chat",
        })
      );

    renderAction("workspace-1");

    const trigger = await screen.findByRole("button", {
      name: /Create WhatsApp @username/i,
    });
    fireEvent.click(trigger);

    const suggestion = await screen.findByRole("button", {
      name: "@airi_chat",
    });
    fireEvent.click(suggestion);

    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Create WhatsApp @username/i })
      ).not.toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/whatsapp/username",
      expect.objectContaining({
        method: "POST",
      })
    );
    expect(mockToastSuccess).toHaveBeenCalledWith("WhatsApp @airi_chat saved.");
  });

  it("does not render when the connected phone number already has a username", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        canCreate: false,
        hasUsername: true,
        username: "airi_chat",
      })
    );

    renderAction("workspace-1");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole("button", { name: /Create WhatsApp @username/i })
    ).not.toBeInTheDocument();
  });

  it("loads the new workspace status when the workspace changes", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ canCreate: true, hasUsername: false })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          canCreate: false,
          hasUsername: true,
          username: "existing_workspace",
        })
      );

    const { rerender } = render(
      <SWRConfig value={{ dedupingInterval: 0, provider: () => new Map() }}>
        <WhatsAppBusinessUsernameNavAction workspaceId="workspace-1" />
      </SWRConfig>
    );

    expect(
      await screen.findByRole("button", {
        name: /Create WhatsApp @username/i,
      })
    ).toBeInTheDocument();

    rerender(
      <SWRConfig value={{ dedupingInterval: 0, provider: () => new Map() }}>
        <WhatsAppBusinessUsernameNavAction workspaceId="workspace-2" />
      </SWRConfig>
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/whatsapp/username?workspaceId=workspace-2",
        expect.objectContaining({ cache: "no-store" })
      );
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Create WhatsApp @username/i })
      ).not.toBeInTheDocument();
    });
  });
});
