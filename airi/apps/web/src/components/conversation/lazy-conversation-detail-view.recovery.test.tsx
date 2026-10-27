/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { preloadConversationDetailView } from "./conversation-detail-loader";
import { LazyConversationDetailView } from "./lazy-conversation-detail-view";

const mockImportDetail = jest.fn();

// Simulate the network-loaded module, while keeping the real loader, lazy
// renderer and retry boundary in the test.
jest.mock("./conversation-detail-view", () => mockImportDetail());

class PageBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    return this.state.error ? (
      <div role="alert">{this.state.error.message}</div>
    ) : (
      this.props.children
    );
  }
}

describe("conversation detail chunk recovery", () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockImportDetail.mockReset().mockReturnValue({
      ConversationDetailView: ({
        conversationId,
      }: {
        conversationId: string;
      }) => {
        if (conversationId === "render-error") throw new Error("Render failed");
        return <input aria-label="Reply" defaultValue="" />;
      },
    });
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("keeps Back usable after a failed download and recovers without losing the composer on rerender", async () => {
    mockImportDetail.mockImplementationOnce(() => {
      throw new Error(
        "Failed to load chunk /_next/static/chunks/conversation.js"
      );
    });
    const onBack = jest.fn();
    const view = render(
      <PageBoundary>
        <LazyConversationDetailView
          conversationId="conversation-1"
          workspaceId="workspace-1"
          onBack={onBack}
        />
      </PageBoundary>
    );

    expect(
      screen.getByRole("status", { name: "loadingRecentMessages" })
    ).toBeInTheDocument();
    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
    fireEvent.click(
      screen.getByRole("button", { name: "backToConversations" })
    );
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("status", { name: "loadingRecentMessages" })
    ).toBeInTheDocument();
    const reply = await screen.findByRole(
      "textbox",
      { name: "Reply" },
      { timeout: 4000 }
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mockImportDetail).toHaveBeenCalledTimes(2);
    fireEvent.change(reply, { target: { value: "Unsent reply" } });
    view.rerender(
      <PageBoundary>
        <LazyConversationDetailView
          conversationId="conversation-1"
          workspaceId="workspace-1"
          searchQuery="updated"
          onBack={onBack}
        />
      </PageBoundary>
    );
    expect(screen.getByRole("textbox", { name: "Reply" })).toBe(reply);
    expect(reply).toHaveValue("Unsent reply");
  });

  it("lets errors from the downloaded conversation reach the page boundary", async () => {
    await preloadConversationDetailView();
    render(
      <PageBoundary>
        <LazyConversationDetailView
          conversationId="render-error"
          workspaceId="workspace-1"
        />
      </PageBoundary>
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Render failed");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
