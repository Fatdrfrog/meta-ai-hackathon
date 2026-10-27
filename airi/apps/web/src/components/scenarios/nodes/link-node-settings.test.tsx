/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ScenarioLinkEditorNodeData } from "../view/node-enrichment/types";
import {
  buildScenarioLinkSelectionPatch,
  LinkNodeSettings,
} from "./link-node-settings";
import { NONE_OPTION_VALUE } from "./utils";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

const OPTIONS = [
  {
    id: "renewal",
    name: "Renewal follow-up",
    triggers: [
      {
        triggerNodeId: "trigger-1",
        label: null,
        triggerConfig: { messageMatchMode: "any" as const },
      },
    ],
  },
  { id: "win-back", name: "Win-back" },
];

function renderSettings(data: Partial<ScenarioLinkEditorNodeData> = {}) {
  const nodeData: ScenarioLinkEditorNodeData = {
    kind: "scenario_link",
    uiOnSelect: jest.fn(),
    uiOnPatch: jest.fn(),
    uiOnRemove: jest.fn(),
    uiScenarioOptions: OPTIONS,
    ...data,
  };
  render(<LinkNodeSettings nodeId="link-1" data={nodeData} />);
  return nodeData;
}

describe("LinkNodeSettings", () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  const elementPrototype = Element.prototype as Element & {
    hasPointerCapture?: unknown;
    releasePointerCapture?: unknown;
  };
  const originalPointerCapture = {
    hasPointerCapture: elementPrototype.hasPointerCapture,
    releasePointerCapture: elementPrototype.releasePointerCapture,
  };
  beforeAll(() => {
    // Radix Select uses pointer capture, which jsdom omits.
    HTMLElement.prototype.scrollIntoView = jest.fn();
    elementPrototype.hasPointerCapture = () => false;
    elementPrototype.releasePointerCapture = () => {};
  });
  afterAll(() => {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    Object.assign(elementPrototype, originalPointerCapture);
  });

  it("links a scenario with its name snapshot and can clear the link", async () => {
    const user = userEvent.setup();
    const data = renderSettings({
      linkedScenarioId: "renewal",
      linkedScenarioName: "Renewal follow-up",
    });
    const picker = screen.getByRole("combobox", {
      name: "scenarioLinkSettingsLabel",
    });
    expect(picker).toHaveTextContent("Renewal follow-up");
    expect(screen.getByText("scenarioLinkSettingsHint")).toBeInTheDocument();
    expect(screen.getByText("scenarioLinkTriggerIncoming")).toBeInTheDocument();
    await user.click(picker);
    await user.click(screen.getByRole("option", { name: "Win-back" }));
    expect(data.uiOnPatch).toHaveBeenLastCalledWith({
      linkedScenarioId: "win-back",
      linkedScenarioName: "Win-back",
    });
    await user.click(picker);
    await user.click(screen.getByRole("option", { name: "scenarioLinkNone" }));
    expect(data.uiOnPatch).toHaveBeenLastCalledWith({
      linkedScenarioId: undefined,
      linkedScenarioName: undefined,
    });
  });

  it("explains how to link when no other scenario exists", () => {
    renderSettings({ uiScenarioOptions: [] });
    expect(screen.getByText("scenarioLinkNoOptions")).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "scenarioLinkSettingsLabel" })
    ).toHaveTextContent("scenarioLinkNone");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a saved scenario that is no longer offered visible and flagged", async () => {
    const user = userEvent.setup();
    const data = renderSettings({
      linkedScenarioId: "deleted",
      linkedScenarioName: "Archived journey",
    });
    const picker = screen.getByRole("combobox", {
      name: "scenarioLinkSettingsLabel",
    });
    expect(picker).toHaveTextContent(
      'scenarioLinkMissing:{"name":"Archived journey"}'
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "scenarioLinkMissingHint"
    );
    await user.click(picker);
    await user.click(screen.getByRole("option", { name: "Renewal follow-up" }));
    expect(data.uiOnPatch).toHaveBeenCalledWith({
      linkedScenarioId: "renewal",
      linkedScenarioName: "Renewal follow-up",
    });
  });
});

describe("buildScenarioLinkSelectionPatch", () => {
  it("snapshots the option name and falls back to the identifier", () => {
    expect(buildScenarioLinkSelectionPatch("win-back", OPTIONS)).toEqual({
      linkedScenarioId: "win-back",
      linkedScenarioName: "Win-back",
    });
    expect(buildScenarioLinkSelectionPatch("unknown", OPTIONS)).toEqual({
      linkedScenarioId: "unknown",
      linkedScenarioName: "unknown",
    });
    expect(buildScenarioLinkSelectionPatch(NONE_OPTION_VALUE, OPTIONS)).toEqual(
      { linkedScenarioId: undefined, linkedScenarioName: undefined }
    );
  });
});
