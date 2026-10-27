/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import type { FormattedRequest } from "@/features/panel/requests/formatting";
import { ConversationSelectionPreview } from "./conversation-selection-preview";
import { preloadConversationDetailView } from "./conversation-detail-loader";
import { LazyConversationDetailView } from "./lazy-conversation-detail-view";

let mockForceCold = false;
jest.mock("./conversation-detail-loader", () => {
  const actual = jest.requireActual<
    typeof import("./conversation-detail-loader")
  >("./conversation-detail-loader");
  return {
    ...actual,
    getLoadedConversationDetailModule: () =>
      mockForceCold ? null : actual.getLoadedConversationDetailModule(),
  };
});

const mockConversationDetailView = jest.fn(
  ({ conversationId }: { conversationId: string }) => (
    <div>
      detail:{conversationId}
      <input aria-label="draft" defaultValue="" />
    </div>
  )
);

jest.mock("./conversation-detail-view", () => ({
  ConversationDetailView: (props: { conversationId: string }) =>
    mockConversationDetailView(props),
}));

const requestSummary = "Please help with my order";

const requestPreview: FormattedRequest = {
  id: "conversation-1",
  projectionGeneration: "1",
  readStateWatermark: "1",
  client: "Acme Customer",
  request: requestSummary,
  source: "WhatsApp",
  channel: "whatsapp",
  dateValue: "2026-08-17T00:00:00.000Z",
  status: "open",
  category: "Support",
  action: "No action",
};

describe("lazy conversation detail view", () => {
  beforeEach(() => {
    mockConversationDetailView.mockClear();
    mockForceCold = false;
  });

  it.each(["inbound", "outbound"] as const)(
    "shows loading history rather than fabricating a %s message from the list row",
    lastMessageDirection => {
      render(
        <ConversationSelectionPreview
          request={{
            ...requestPreview,
            lastMessageDirection,
            lastMessageText: "List-only message summary",
          }}
        />
      );

      expect(screen.getByText("Acme Customer")).toBeInTheDocument();
      expect(
        screen.queryByText("List-only message summary")
      ).not.toBeInTheDocument();
      expect(screen.queryByText(requestSummary)).not.toBeInTheDocument();
      expect(
        screen.getByRole("status", { name: "loadingRecentMessages" })
      ).toBeInTheDocument();
    }
  );

  it("names an unnamed conversation with the catalog placeholder while loading", () => {
    render(
      <ConversationSelectionPreview
        request={{ ...requestPreview, client: "" }}
      />
    );

    expect(screen.getByText("unnamedCustomer")).toBeInTheDocument();
  });

  it.each([requestPreview, undefined])(
    "keeps Back available while the selected conversation is loading (%s)",
    request => {
      const onBack = jest.fn();
      render(
        <ConversationSelectionPreview request={request} onBack={onBack} />
      );

      fireEvent.click(
        screen.getByRole("button", { name: "backToConversations" })
      );
      expect(onBack).toHaveBeenCalledTimes(1);
      expect(
        screen.getByTestId("conversation-selection-preview")
      ).toHaveAttribute("aria-busy", "true");
    }
  );

  it("replaces the cold loading state with the detail renderer through the shared loader", async () => {
    render(
      <LazyConversationDetailView
        conversationId="conversation-1"
        workspaceId="workspace-1"
        requestPreview={requestPreview}
      />
    );

    expect(screen.queryByText(requestSummary)).not.toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "loadingRecentMessages" })
    ).toBeInTheDocument();

    expect(
      await screen.findByText("detail:conversation-1")
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(mockConversationDetailView).toHaveBeenCalledTimes(1);
  });

  it("renders an already prepared module immediately without a loading fallback", async () => {
    await preloadConversationDetailView();
    render(
      <LazyConversationDetailView
        conversationId="prepared"
        workspaceId="workspace-1"
      />
    );
    expect(screen.getByText("detail:prepared")).toBeInTheDocument();
  });

  it("keeps the composer mounted after a cold module resolves and the parent rerenders", async () => {
    mockForceCold = true;
    try {
      const view = render(
        <LazyConversationDetailView
          conversationId="cold"
          workspaceId="workspace-1"
        />
      );
      const input = await screen.findByRole("textbox", { name: "draft" });
      mockForceCold = false;
      (input as HTMLInputElement).value = "Unsent reply";
      view.rerender(
        <LazyConversationDetailView
          conversationId="cold"
          workspaceId="workspace-1"
          searchQuery="updated"
        />
      );
      expect(screen.getByRole("textbox", { name: "draft" })).toBe(input);
      expect(input).toHaveValue("Unsent reply");
    } finally {
      mockForceCold = false;
    }
  });
});
