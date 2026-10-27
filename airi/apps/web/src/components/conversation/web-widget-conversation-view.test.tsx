/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { WebWidgetConversationView } from "./web-widget-conversation-view";

const originalFetch = global.fetch;

function renderView() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
      <WebWidgetConversationView conversationId="conv_2" />
    </SWRConfig>
  );
}

describe("WebWidgetConversationView", () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("lists the visitor's widget pages oldest first and marks the open one", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        visitorId: "visitor-12345678",
        conversations: [
          {
            id: "conv_2",
            pageUrl: "https://shop.example/pricing",
            messageCount: 3,
            createdAt: "2026-07-02T00:00:00.000Z",
          },
          {
            id: "conv_1",
            pageUrl: "https://shop.example/",
            messageCount: 2,
            createdAt: "2026-07-01T00:00:00.000Z",
          },
        ],
      }),
    }) as jest.Mock;

    renderView();

    expect(await screen.findByText("Visitor journey")).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/conversations/conv_2/widget-urls"
    );
    expect(
      screen.getAllByText(/^\/(pricing)?$/).map(node => node.textContent)
    ).toEqual(["/", "/pricing"]);
    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getByText("12345678")).toBeInTheDocument();
  });

  it("shows a quiet notice when the journey cannot load", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ success: false, error: "Unavailable" }),
    }) as jest.Mock;

    renderView();

    expect(
      await screen.findByText("Visitor journey is temporarily unavailable.")
    ).toBeInTheDocument();
  });
});
