/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { useState } from "react";
import { ConversationInfoSheet } from "./conversation-info-sheet";
import type { ConversationInfoDetails } from "./conversation-info-view-model";

jest.mock("@/components/ui/sheet", () => ({
  Sheet: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
  }) =>
    open ? (
      <div data-testid="info-drawer">
        <button type="button" onClick={() => onOpenChange(false)}>
          close-info
        </button>
        {children}
      </div>
    ) : null,
  SheetContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SheetHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SheetTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
}));

jest.mock("./conversation-info", () => ({
  ConversationInfo: ({
    onMomentClick,
    actions,
  }: {
    onMomentClick: (id: string) => void;
    actions?: React.ReactNode;
  }) => (
    <div>
      conversation-info
      {actions}
      <button type="button" onClick={() => onMomentClick("msg_1")}>
        open-moment
      </button>
    </div>
  ),
}));

function Harness({ onMomentClick }: { onMomentClick?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const details: ConversationInfoDetails = {
    classification: {},
    messages: [],
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open-info
      </button>
      <ConversationInfoSheet
        open={open}
        onOpenChange={setOpen}
        details={details}
        conversationId="conv_1"
        messages={[]}
        messageTotal={0}
        actions={<button type="button">sales-and-follow-ups</button>}
        onMomentClick={id => {
          setOpen(false);
          onMomentClick?.(id);
        }}
      />
    </>
  );
}

describe("ConversationInfoSheet", () => {
  it("announces loading and failed full details while keeping available information accessible", async () => {
    const onRetry = jest.fn();
    const props = {
      open: true,
      onOpenChange: jest.fn(),
      details: {},
      conversationId: "conv_1",
      onMomentClick: jest.fn(),
      onRetry,
    };
    const { rerender } = render(<ConversationInfoSheet {...props} isLoading />);
    expect(screen.getByRole("status")).toHaveTextContent("info.loading");
    expect(await screen.findByText("conversation-info")).toBeInTheDocument();
    rerender(<ConversationInfoSheet {...props} hasError />);
    expect(screen.getByRole("alert")).toHaveTextContent("info.loadError");
    fireEvent.click(screen.getByRole("button", { name: "info.retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<ConversationInfoSheet {...props} hasError isLoading />);
    expect(screen.getByRole("button", { name: "info.retry" })).toBeDisabled();
  });

  it("opens and closes from the conversation header control", async () => {
    render(<Harness />);

    expect(screen.queryByTestId("info-drawer")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "open-info" }));

    expect(screen.getByTestId("info-drawer")).toBeInTheDocument();
    expect(await screen.findByText("conversation-info")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "sales-and-follow-ups" })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "close-info" }));

    expect(screen.queryByTestId("info-drawer")).not.toBeInTheDocument();
  });

  it("closes before navigating to a key moment", async () => {
    const onMomentClick = jest.fn();
    render(<Harness onMomentClick={onMomentClick} />);

    fireEvent.click(screen.getByRole("button", { name: "open-info" }));
    fireEvent.click(await screen.findByRole("button", { name: "open-moment" }));

    expect(onMomentClick).toHaveBeenCalledWith("msg_1");
    expect(screen.queryByTestId("info-drawer")).not.toBeInTheDocument();
  });
});
