/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ScenarioFlowNode } from "../types";

const mockSelectNodeById = jest.fn();
const mockContext = {
  selectedNodeId: "first" as string | null,
  scenarioSessionOwnerKey: "visit-1",
  callbacksRef: {
    current: {
      selectNodeById: mockSelectNodeById,
      updateTriggerConfigById: jest.fn(),
      updateNodeById: jest.fn(),
      removeNodeById: jest.fn(),
    },
  },
  sourceCapabilities: { hasMetaAds: false },
  audienceOptions: { channels: [] },
  openNodePickerFromHandle: jest.fn(),
  getWhatsAppQrPickerProps: jest.fn(),
  t: (key: string) => key,
};

jest.mock("./scenario-node-enrichment-context", () => ({
  useScenarioNodeEnrichment: () => mockContext,
}));
jest.mock("../nodes/trigger-node/message-trigger-editor", () => ({
  MessageTriggerEditor: ({
    triggerConfig,
  }: {
    triggerConfig: { keywordPattern?: string };
  }) => (
    <input
      aria-label="Message pattern"
      defaultValue={triggerConfig.keywordPattern ?? ""}
    />
  ),
}));

import { ScenarioTriggerEditorPanel } from "./scenario-trigger-editor-panel";

const first: ScenarioFlowNode = {
  id: "first",
  position: { x: 0, y: 0 },
  data: {
    kind: "trigger",
    triggerConfig: { messageMatchMode: "exact", keywordPattern: "order" },
  },
};

describe("ScenarioTriggerEditorPanel before its settings load", () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  beforeAll(() => {
    HTMLElement.prototype.scrollIntoView = jest.fn();
  });
  afterAll(() => {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  });

  it("opens the sheet with focus inside, keeps its body's place, and restores focus on close", async () => {
    const editButton = document.createElement("button");
    editButton.dataset.scenarioNodeSettings = "first";
    document.body.appendChild(editButton);
    editButton.focus();

    const view = render(<ScenarioTriggerEditorPanel nodes={[first]} />);
    const sheet = screen.getByRole("dialog", { name: "triggerEditorTitle" });
    // The settings download on first open; their placeholder keeps the
    // scrolling body between the header and footer.
    const loading = within(sheet).getByRole("status");
    expect(loading).toHaveTextContent("loadingItems");
    expect(loading).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");
    await waitFor(() =>
      expect(sheet.contains(document.activeElement)).toBe(true)
    );

    expect(await within(sheet).findByLabelText("Message pattern")).toHaveValue(
      "order"
    );
    expect(within(sheet).queryByRole("status")).not.toBeInTheDocument();
    expect(sheet.contains(document.activeElement)).toBe(true);

    await userEvent.keyboard("{Escape}");
    expect(mockSelectNodeById).toHaveBeenCalledWith(null);
    mockContext.selectedNodeId = null;
    view.rerender(<ScenarioTriggerEditorPanel nodes={[first]} />);
    await waitFor(() => expect(editButton).toHaveFocus());
    editButton.remove();
  });
});
