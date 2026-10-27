/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import type { FormattedRequest as RequestItem } from "@/features/panel/requests/formatting";
import { RequestsMasterDetailLayout } from "./requests-master-detail-layout";

let mockIsMobile = true;
let mockSearchParams = new URLSearchParams();
const mockListMount = jest.fn();
const mockListUnmount = jest.fn();
const mockDetailMount = jest.fn();
const mockDetailUnmount = jest.fn();
const mockRequest = {
  id: "conversation-1",
  client: "Acme Customer",
  request: "Need help",
  source: "WhatsApp",
  channel: "whatsapp",
  dateValue: "2026-08-17T00:00:00.000Z",
  status: "open",
  category: "Support",
  action: null,
} as RequestItem;

jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mockIsMobile }));
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));
jest.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
    className,
  }: React.PropsWithChildren<{ className?: string }>) => (
    <div data-testid="panel-group" className={className}>
      {children}
    </div>
  ),
  ResizablePanel: ({
    children,
    className,
  }: React.PropsWithChildren<{ className?: string }>) => (
    <section className={className}>{children}</section>
  ),
  ResizableHandle: ({ className }: { className?: string }) => (
    <div data-testid="resize-handle" className={className} />
  ),
}));
jest.mock("./dialog-list-panel", () => ({
  DialogListPanel: ({
    onSelectConversation,
  }: {
    onSelectConversation: (
      id: string,
      options?: { requestPreview?: RequestItem | null }
    ) => void;
  }) => {
    const [query, setQuery] = React.useState("");
    React.useEffect(() => {
      mockListMount();
      return () => mockListUnmount();
    }, []);
    return (
      <div data-testid="dialog-list-panel">
        <input
          aria-label="conversation search"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        <div
          data-testid="conversation-scroll"
          style={{ overflow: "auto", height: 80 }}
        >
          <div style={{ height: 300 }} />
        </div>
        <button
          type="button"
          onClick={() =>
            onSelectConversation(mockRequest.id, {
              requestPreview: mockRequest,
            })
          }
        >
          Open conversation
        </button>
      </div>
    );
  },
}));
jest.mock("./chat-panel", () => ({
  ChatPanel: ({
    conversationId,
    onBack,
  }: {
    conversationId: string | null;
    onBack?: () => void;
  }) => {
    React.useEffect(() => {
      mockDetailMount();
      return () => mockDetailUnmount();
    }, []);
    return (
      <div data-testid="chat-panel">
        <span>{conversationId ?? "no conversation"}</span>
        <input aria-label="Reply" />
        {onBack ? (
          <button type="button" onClick={onBack}>
            Back to list
          </button>
        ) : null}
      </div>
    );
  },
}));

const layout = (
  <RequestsMasterDetailLayout
    workspaceId="workspace-1"
    initialRequests={[mockRequest]}
    initialAvailableChannels={["whatsapp"]}
    initialHasMore={false}
    initialRenderNowMs={new Date("2026-08-17T00:01:00.000Z").getTime()}
  />
);

describe("RequestsMasterDetailLayout", () => {
  beforeEach(() => {
    mockIsMobile = true;
    mockSearchParams = new URLSearchParams();
    jest.clearAllMocks();
    window.history.replaceState(null, "", "/panel/w/workspace-1/requests");
  });

  it("moves mobile focus out of the hidden list and restores the selected row on back", () => {
    render(layout);
    const row = screen.getByRole("button", { name: "Open conversation" });
    row.focus();
    fireEvent.click(row);

    expect(screen.getByTestId("requests-detail-region")).toHaveFocus();
    const back = screen.getByRole("button", { name: "Back to list" });
    back.focus();
    fireEvent.click(back);

    expect(row).toHaveFocus();
  });

  it("restores mobile focus when browser history returns to the list", () => {
    render(layout);
    const row = screen.getByRole("button", { name: "Open conversation" });
    row.focus();
    fireEvent.click(row);
    fireEvent.popState(window);
    expect(row).toHaveFocus();
  });

  it("keeps desktop focus in the list when opening a conversation", () => {
    mockIsMobile = false;
    render(layout);
    const row = screen.getByRole("button", { name: "Open conversation" });
    row.focus();
    fireEvent.click(row);
    expect(row).toHaveFocus();
  });

  it("preserves focus inside the conversation when crossing mobile breakpoints", () => {
    const view = render(layout);
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
    const reply = screen.getByRole("textbox", { name: "Reply" });
    reply.focus();
    fireEvent.change(reply, { target: { value: "Unsent reply" } });
    mockIsMobile = false;
    view.rerender(React.cloneElement(layout));
    mockIsMobile = true;
    view.rerender(React.cloneElement(layout));
    expect(reply).toHaveFocus();
    expect(reply).toHaveValue("Unsent reply");
  });

  it("keeps one list and one detail owner mounted across open, back, and breakpoints", () => {
    const view = render(layout);
    const search = screen.getByRole("textbox", {
      name: "conversation search",
    });
    const scroll = screen.getByTestId("conversation-scroll");
    fireEvent.change(search, { target: { value: "invoice" } });
    scroll.scrollTop = 142;
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));

    const listRegion = () => screen.getByTestId("requests-list-region");
    expect(screen.getByText("conversation-1")).toBeInTheDocument();
    expect(listRegion()).toHaveAttribute("aria-hidden", "true");
    expect(listRegion()).toHaveAttribute("inert");
    expect(search).toHaveValue("invoice");
    expect(scroll.scrollTop).toBe(142);
    const listMounts = mockListMount.mock.calls.length;
    const detailMounts = mockDetailMount.mock.calls.length;

    mockIsMobile = false;
    view.rerender(React.cloneElement(layout));
    mockIsMobile = true;
    view.rerender(React.cloneElement(layout));

    expect(mockListMount).toHaveBeenCalledTimes(listMounts);
    expect(mockDetailMount).toHaveBeenCalledTimes(detailMounts);
    expect(mockListUnmount).not.toHaveBeenCalled();
    expect(mockDetailUnmount).not.toHaveBeenCalled();
    expect(search).toHaveValue("invoice");
    expect(scroll.scrollTop).toBe(142);
    expect(screen.getByTestId("resize-handle")).toHaveClass("max-md:hidden");

    fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
    expect(listRegion()).toHaveAttribute("aria-hidden", "false");
    expect(listRegion()).not.toHaveAttribute("inert");
    expect(mockListUnmount).not.toHaveBeenCalled();
    expect(mockDetailUnmount).not.toHaveBeenCalled();
  });

  it("syncs browser history selection without remounting either panel", () => {
    mockIsMobile = false;
    render(layout);

    expect(screen.getByText("no conversation")).toBeInTheDocument();
    const listMounts = mockListMount.mock.calls.length;
    const detailMounts = mockDetailMount.mock.calls.length;

    window.history.pushState(
      null,
      "",
      "/panel/w/workspace-1/requests?conversation=conversation-1&searchType=message_within_chat&searchQuery=invoice"
    );
    fireEvent.popState(window);

    expect(screen.getByText("conversation-1")).toBeInTheDocument();
    expect(mockListMount).toHaveBeenCalledTimes(listMounts);
    expect(mockDetailMount).toHaveBeenCalledTimes(detailMounts);
    expect(mockListUnmount).not.toHaveBeenCalled();
    expect(mockDetailUnmount).not.toHaveBeenCalled();
  });
});
