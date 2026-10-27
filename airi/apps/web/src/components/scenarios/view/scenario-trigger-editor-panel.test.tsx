/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ScenarioFlowNode } from "../types";
import { isScenarioKeyboardControlTarget } from "../scenario-keyboard-events";
import { scenarioEditorChunks } from "../scenario-editor-chunks";

const mockSelectNodeById = jest.fn();
const mockUpdateTriggerConfigById = jest.fn();
const mockContext = {
  selectedNodeId: "first" as string | null,
  scenarioSessionOwnerKey: "visit-1",
  callbacksRef: {
    current: {
      selectNodeById: mockSelectNodeById,
      updateTriggerConfigById: mockUpdateTriggerConfigById,
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
    onChange,
  }: {
    triggerConfig: { keywordPattern?: string };
    onChange: (delta: { keywordPattern: string }) => void;
  }) => (
    <>
      <input
        aria-label="Message pattern"
        value={triggerConfig.keywordPattern ?? ""}
        onChange={event => onChange({ keywordPattern: event.target.value })}
      />
      <input aria-label="Local search" defaultValue="" />
    </>
  ),
}));

import { ScenarioTriggerEditorPanel } from "./scenario-trigger-editor-panel";

const node = (id: string, keywordPattern: string): ScenarioFlowNode => ({
  id,
  position: { x: 10000, y: 10000 },
  data: {
    kind: "trigger",
    triggerConfig: { messageMatchMode: "exact", keywordPattern },
  },
});
const first = node("first", "first order");
const second = node("second", "second order");

// Editors load lazily in the app; load them up front so they render at once.
beforeAll(async () => {
  await Promise.all([scenarioEditorChunks.triggerNodeSettings.load()]);
});

describe("ScenarioTriggerEditorPanel", () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  beforeAll(() => {
    HTMLElement.prototype.scrollIntoView = jest.fn();
  });
  afterAll(() => {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    mockContext.selectedNodeId = "first";
    mockContext.scenarioSessionOwnerKey = "visit-1";
  });

  it("edits the selected raw graph node without requiring a mounted canvas node", () => {
    render(<ScenarioTriggerEditorPanel nodes={[first, second]} />);
    expect(
      screen.getByRole("dialog", { name: "triggerEditorTitle" })
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Message pattern")).toHaveValue("first order");
    expect(mockUpdateTriggerConfigById).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Message pattern"), {
      target: { value: "updated order" },
    });
    expect(mockUpdateTriggerConfigById).toHaveBeenCalledWith("first", {
      keywordPattern: "updated order",
    });
  });

  it("offers business events without changing the saved trigger until selected", async () => {
    render(<ScenarioTriggerEditorPanel nodes={[first]} />);
    screen.getByRole("combobox", { name: "triggerEditorEntryLabel" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(mockUpdateTriggerConfigById).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("option", { name: "presetTriggerBusinessEvent" })
    );
    expect(mockUpdateTriggerConfigById).toHaveBeenCalledWith("first", {
      entryPointType: "business_event",
    });
  });

  it("reopens an unfinished business event as a draft without message controls or catalog mutations", () => {
    const business = {
      ...first,
      data: {
        kind: "trigger",
        triggerConfig: { entryPointType: "business_event" },
      },
    } as ScenarioFlowNode;
    render(<ScenarioTriggerEditorPanel nodes={[business]} />);
    expect(
      screen.getByRole("combobox", { name: "triggerEditorEntryLabel" })
    ).toHaveTextContent("presetTriggerBusinessEvent");
    expect(screen.queryByLabelText("Message pattern")).not.toBeInTheDocument();
    expect(
      screen.getByText("businessEventDraftDescription")
    ).toBeInTheDocument();
    expect(mockUpdateTriggerConfigById).not.toHaveBeenCalled();
  });

  it("uses current selection and discards local search when the editor or document changes", async () => {
    const view = render(<ScenarioTriggerEditorPanel nodes={[first, second]} />);
    fireEvent.change(screen.getByLabelText("Local search"), {
      target: { value: "old search" },
    });
    mockContext.selectedNodeId = "second";
    view.rerender(<ScenarioTriggerEditorPanel nodes={[first, second]} />);
    expect(screen.getByLabelText("Message pattern")).toHaveValue(
      "second order"
    );
    expect(screen.getByLabelText("Local search")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Local search"), {
      target: { value: "another search" },
    });
    mockContext.scenarioSessionOwnerKey = "visit-2";
    view.rerender(<ScenarioTriggerEditorPanel nodes={[first, second]} />);
    expect(screen.getByLabelText("Local search")).toHaveValue("");
    expect(mockUpdateTriggerConfigById).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(
        true
      )
    );
  });

  it("closes on Escape through selection and restores the Edit trigger button", async () => {
    const editButton = document.createElement("button");
    editButton.dataset.scenarioNodeSettings = "first";
    editButton.textContent = "Edit trigger";
    document.body.appendChild(editButton);
    editButton.focus();
    const view = render(<ScenarioTriggerEditorPanel nodes={[first]} />);
    await userEvent.keyboard("{Escape}");
    expect(mockSelectNodeById).toHaveBeenCalledWith(null);
    mockContext.selectedNodeId = null;
    view.rerender(<ScenarioTriggerEditorPanel nodes={[first]} />);
    await waitFor(() => expect(editButton).toHaveFocus());
    expect(mockUpdateTriggerConfigById).not.toHaveBeenCalled();
    editButton.remove();
  });

  it("closes without committing another graph edit and falls back to the canvas node for focus", async () => {
    const canvasNode = document.createElement("div");
    canvasNode.className = "react-flow__node";
    canvasNode.dataset.id = "first";
    canvasNode.tabIndex = 0;
    document.body.appendChild(canvasNode);
    const view = render(<ScenarioTriggerEditorPanel nodes={[first]} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: "triggerEditorClose" }).at(-1)!
    );
    expect(mockSelectNodeById).toHaveBeenCalledWith(null);
    mockContext.selectedNodeId = null;
    view.rerender(<ScenarioTriggerEditorPanel nodes={[first]} />);
    await waitFor(() => expect(canvasNode).toHaveFocus());
    expect(mockUpdateTriggerConfigById).not.toHaveBeenCalled();
    canvasNode.remove();
  });

  it("lets the nested entry selector handle Escape before the sheet and protects canvas keyboard shortcuts", async () => {
    render(<ScenarioTriggerEditorPanel nodes={[first]} />);
    const selector = screen.getByRole("combobox", {
      name: "triggerEditorEntryLabel",
    });
    selector.focus();
    await userEvent.keyboard("{Enter}");
    expect(
      screen.getByRole("option", { name: "presetTriggerCustomerBehavior" })
    ).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(mockSelectNodeById).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(isScenarioKeyboardControlTarget(screen.getByRole("dialog"))).toBe(
      true
    );
    expect(
      isScenarioKeyboardControlTarget(screen.getByLabelText("Message pattern"))
    ).toBe(true);
    expect(mockUpdateTriggerConfigById).not.toHaveBeenCalled();
  });

  it("removes the panel when its node disappears and skips QR or linked entries", () => {
    const view = render(<ScenarioTriggerEditorPanel nodes={[first]} />);
    view.rerender(<ScenarioTriggerEditorPanel nodes={[]} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    view.rerender(
      <ScenarioTriggerEditorPanel
        nodes={[
          { ...first, data: { kind: "trigger", linkedConditionId: "parent" } },
        ]}
      />
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    view.rerender(
      <ScenarioTriggerEditorPanel
        nodes={[
          {
            ...first,
            data: {
              kind: "trigger",
              triggerConfig: { entryPointType: "whatsapp_qr" },
            },
          },
        ]}
      />
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockUpdateTriggerConfigById).not.toHaveBeenCalled();
  });
});
