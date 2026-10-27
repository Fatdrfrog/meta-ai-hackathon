/**
 * @jest-environment jsdom
 */

import type { ReactNode } from "react";
import "@testing-library/jest-dom";

const mockTranslate = (
  key: string,
  values?: Record<string, string | number | Date>
) => {
  if (typeof values?.text === "string") {
    return `${key}:${values.text}`;
  }
  return key;
};

jest.mock("next-intl", () => ({
  useTranslations: () => mockTranslate,
}));

jest.mock("@xyflow/react", () => ({
  Handle: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  MarkerType: {
    ArrowClosed: "ArrowClosed",
  },
  Position: {
    Left: "left",
    Right: "right",
  },
}));

import { fireEvent, render, screen } from "@testing-library/react";
import type { ScenarioTriggerConfig } from "../types";
import type { ScenarioLinkEditorNodeData } from "../view/node-enrichment/types";
import { ScenarioLinkNode } from "./link-node";

function renderLinkCard(data: Partial<ScenarioLinkEditorNodeData>) {
  const nodeData: ScenarioLinkEditorNodeData = {
    kind: "scenario_link",
    uiOnSelect: jest.fn(),
    uiOnPatch: jest.fn(),
    uiOnRemove: jest.fn(),
    linkedScenarioId: "target-scenario",
    linkedScenarioName: "Target scenario",
    uiScenarioOptions: [{ id: "target-scenario", name: "Target scenario" }],
    ...data,
  };
  const props = {
    id: "link-1",
    selected: false,
    type: "scenarioLinkNode" as const,
    dragging: false,
    zIndex: 0,
    isConnectable: true,
    selectable: true,
    deletable: true,
    draggable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  };
  const view = render(<ScenarioLinkNode {...props} data={nodeData} />);
  return {
    nodeData,
    rerender: (next: Partial<ScenarioLinkEditorNodeData>) =>
      view.rerender(
        <ScenarioLinkNode {...props} data={{ ...nodeData, ...next }} />
      ),
  };
}

describe("ScenarioLinkNode settings", () => {
  it("keeps the inline scenario picker while the settings panel is off", () => {
    const { nodeData } = renderLinkCard({ uiOnOpenSettings: jest.fn() });
    expect(screen.getByRole("combobox")).toHaveTextContent("Target scenario");
    expect(
      document.querySelector("[data-scenario-node-settings]")
    ).not.toBeInTheDocument();
    expect(nodeData.uiOnPatch).not.toHaveBeenCalled();
  });

  it("shows a read-only card that opens its settings when the panel is on", () => {
    const onOpenSettings = jest.fn();
    const { nodeData, rerender } = renderLinkCard({
      uiUsesSettingsPanel: true,
      uiOnOpenSettings: onOpenSettings,
      uiIsEditorExpanded: false,
    });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText("Target scenario")).toBeInTheDocument();
    const settings = screen.getByRole("button", {
      name: "nodeSettingsOpenFor",
    });
    expect(settings).toHaveTextContent("settings");
    expect(settings).toHaveAttribute("data-scenario-node-settings", "link-1");
    expect(settings).toHaveAttribute("aria-haspopup", "dialog");
    expect(settings).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(settings, { detail: 1 });
    expect(onOpenSettings).toHaveBeenLastCalledWith({ moveFocus: false });
    fireEvent.click(settings, { detail: 0 });
    expect(onOpenSettings).toHaveBeenLastCalledWith({ moveFocus: true });
    rerender({ uiIsEditorExpanded: true });
    expect(settings).toHaveAttribute("aria-expanded", "true");
    expect(settings).toHaveAttribute(
      "aria-controls",
      "scenario-node-settings-panel"
    );
    expect(nodeData.uiOnPatch).not.toHaveBeenCalled();
    expect(nodeData.uiOnSelect).not.toHaveBeenCalled();
  });

  it("names an unlinked read-only card with the sub-scenario placeholder", () => {
    renderLinkCard({
      linkedScenarioId: undefined,
      linkedScenarioName: undefined,
      uiUsesSettingsPanel: true,
      uiOnOpenSettings: jest.fn(),
    });
    expect(screen.getByText("scenarioLinkPlaceholder")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});

function renderLinkNode(triggerConfig: ScenarioTriggerConfig) {
  const data: ScenarioLinkEditorNodeData = {
    kind: "scenario_link",
    uiOnSelect: jest.fn(),
    uiOnPatch: jest.fn(),
    uiOnRemove: jest.fn(),
    linkedScenarioId: "target-scenario",
    linkedScenarioName: "Target scenario",
    uiScenarioOptions: [
      {
        id: "target-scenario",
        name: "Target scenario",
        triggers: [
          {
            triggerNodeId: "trigger-1",
            triggerConfig,
            label: null,
          },
        ],
      },
    ],
  };

  return render(
    <ScenarioLinkNode
      id="link-1"
      selected={false}
      type="scenarioLinkNode"
      dragging={false}
      zIndex={0}
      isConnectable
      selectable
      deletable
      draggable
      positionAbsoluteX={0}
      positionAbsoluteY={0}
      data={data}
    />
  );
}

describe("ScenarioLinkNode trigger summary", () => {
  it("identifies a saved business event instead of calling it an incoming message", () => {
    renderLinkNode({
      entryPointType: "business_event",
      businessEvent: {
        integrationId: "store-1",
        eventId: "order.changed",
        eventName: "Order changed",
      },
    });
    expect(screen.getByText(/Order changed/)).toBeInTheDocument();
    expect(
      screen.queryByText("scenarioLinkTriggerIncoming")
    ).not.toBeInTheDocument();
  });
  it("renders the shared linked summary with a real ellipsis", () => {
    renderLinkNode({
      messageMatchMode: "contains",
      keywordMatchMode: "contains",
      keywordPattern: "12345678901234567890123456789012345",
    });

    expect(
      screen.getByText(
        "scenarioLinkTriggerContains:123456789012345678901234567890…"
      )
    ).toBeInTheDocument();
    // "…" misread as Windows-1251, built from code points so this source file stays clean.
    expect(document.body.textContent).not.toContain(
      String.fromCharCode(0x0432, 0x0402, 0x00a6)
    );
  });

  it("does not expose dormant matcher fields for Any", () => {
    renderLinkNode({
      messageMatchMode: "any",
      keywordMatchMode: "regex",
      keywordPattern: "refund",
    });

    expect(screen.getByText("scenarioLinkTriggerIncoming")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("refund");
  });

  it("shows malformed selected Contains configuration as its mode", () => {
    renderLinkNode({
      messageMatchMode: "contains",
      keywordMatchMode: "regex",
      keywordPattern: "[",
    });

    expect(
      screen.getByText("scenarioLinkTriggerContainsDefault")
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("[");
  });
});
