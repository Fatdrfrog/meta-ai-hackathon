/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import type React from "react";

const mockImportWorkspace = jest.fn();

jest.mock("@/components/ai/airi-chat-chunks", () => {
  const { createScenarioLazyChunk } = jest.requireActual<
    typeof import("@/components/scenarios/scenario-lazy-chunk")
  >("@/components/scenarios/scenario-lazy-chunk");
  return {
    airiChatChunks: {
      workspace: createScenarioLazyChunk(() => mockImportWorkspace()),
    },
  };
});

jest.mock("@/components/ai/airi-resizable-sidebar", () => ({
  AiriResizableSidebar: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? <div data-testid="airi-sidebar">{children}</div> : null),
}));

function workspaceModule() {
  return {
    AiriChatWorkspace: ({
      workspaceId,
      onClose,
    }: {
      workspaceId: string;
      onClose?: () => void;
    }) => (
      <div data-testid="airi-chat-workspace" data-workspace-id={workspaceId}>
        <button type="button" onClick={onClose}>
          Close workspace
        </button>
      </div>
    ),
  };
}

describe("AiriChatModal", () => {
  beforeEach(() => {
    mockImportWorkspace.mockReset();
  });

  it("shows a closable loading shell at once and retries a failed download", async () => {
    mockImportWorkspace
      .mockRejectedValueOnce(new Error("ChunkLoadError"))
      .mockResolvedValue(workspaceModule());
    const { AiriChatModal } = await import("./airi-chat-modal");
    const onOpenChange = jest.fn();

    render(
      <AiriChatModal
        workspaceId="workspace-1"
        open
        onOpenChange={onOpenChange}
      />
    );

    expect(
      screen.getByRole("status", { name: "Loading Airi" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close Airi sidebar" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    expect(
      await screen.findByTestId("airi-chat-workspace", {}, { timeout: 4000 })
    ).toHaveAttribute("data-workspace-id", "workspace-1");
    expect(mockImportWorkspace).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole("status", { name: "Loading Airi" })
    ).not.toBeInTheDocument();
  });
});
