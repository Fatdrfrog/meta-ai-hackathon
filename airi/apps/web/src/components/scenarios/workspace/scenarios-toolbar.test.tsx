/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { ScenariosToolbar } from "./scenarios-toolbar";
import type { ScenarioAutomationHeaderActions } from "./use-scenario-view-signals";

function actions(
  overrides: Partial<ScenarioAutomationHeaderActions> = {}
): ScenarioAutomationHeaderActions {
  return {
    hasScenario: true,
    canCreate: true,
    isCreatingScenario: false,
    canDelete: true,
    saveStatus: "saved",
    canvasInteractionMode: "pan",
    isTriggerLogVisible: false,
    activeScenarioStatus: "draft",
    isActivatingScenario: false,
    onCreateScenario: jest.fn(),
    onCanvasInteractionModeChange: jest.fn(),
    onToggleTriggerLog: jest.fn(),
    onDeleteScenario: jest.fn(),
    onActivateScenario: jest.fn(),
    ...overrides,
  };
}

describe("ScenariosToolbar", () => {
  it("does not reserve an empty toolbar without a scenario", () => {
    const { container } = render(<ScenariosToolbar actions={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers a labelled Activate button for a draft", () => {
    const onActivateScenario = jest.fn();
    render(<ScenariosToolbar actions={actions({ onActivateScenario })} />);

    fireEvent.click(
      screen.getByRole("button", { name: "toolbarActivateScenario" })
    );
    expect(onActivateScenario).toHaveBeenCalledTimes(1);
  });

  it("disables Activate while the activation runs", () => {
    render(
      <ScenariosToolbar actions={actions({ isActivatingScenario: true })} />
    );
    expect(
      screen.getByRole("button", { name: "toolbarActivateScenario" })
    ).toBeDisabled();
  });

  it("shows that a live scenario is on instead of an Activate button", () => {
    render(
      <ScenariosToolbar actions={actions({ activeScenarioStatus: "active" })} />
    );
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "toolbarActivateScenario" })
    ).not.toBeInTheDocument();
  });
});
