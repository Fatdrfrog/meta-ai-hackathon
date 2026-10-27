/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { ChatPanel } from "./chat-panel";

jest.mock("@/components/conversation/lazy-conversation-detail-view", () => ({
  LazyConversationDetailView: ({
    conversationId,
  }: {
    conversationId: string;
  }) => <textarea aria-label={`Reply to ${conversationId}`} defaultValue="" />,
}));

describe("ChatPanel selection", () => {
  it("immediately replaces the previous chat and clears its composer when switching", () => {
    const { rerender } = render(<ChatPanel conversationId="first" />);
    const firstComposer = screen.getByRole("textbox", {
      name: "Reply to first",
    });
    (firstComposer as HTMLTextAreaElement).value = "Unsent first-chat reply";

    rerender(<ChatPanel conversationId="second" />);

    expect(firstComposer).not.toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(
      screen.getByRole("textbox", { name: "Reply to second" })
    ).toHaveValue("");

    rerender(<ChatPanel conversationId={null} />);

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("selectConversation")).toBeInTheDocument();
  });
});
