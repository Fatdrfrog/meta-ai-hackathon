/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import {
  ScenarioFlowLoadingState,
  ScenariosViewEmptyState,
  ScenariosViewLoadingState,
} from "./scenarios-view-shell";

it.each([ScenariosViewLoadingState, ScenarioFlowLoadingState])(
  "announces the loading view",
  LoadingState => {
    render(<LoadingState label="Loading scenario" />);
    expect(
      screen.getByRole("status", { name: "Loading scenario" })
    ).toBeTruthy();
  }
);

describe("ScenariosViewEmptyState", () => {
  it("renders the base scenario empty state actions", () => {
    const onCreateScenario = jest.fn();

    render(
      <ScenariosViewEmptyState
        title="Setting up a demo canvas"
        description="No sources are connected yet."
        createLabel="Create"
        demoCreateLabel="Create demo canvas"
        connectSourceLabel="Connect source"
        connectSourceHref="/panel/w/workspace-1/settings/integrations"
        isCreating={false}
        isAutoCreatingDemo={false}
        showDemoRetry={false}
        showConnectSource
        onCreateScenario={onCreateScenario}
        onCreateDemoScenario={jest.fn()}
      />
    );

    screen.getByText("Setting up a demo canvas");
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    expect(onCreateScenario).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("link", { name: /Connect source/ }).getAttribute("href")
    ).toBe("/panel/w/workspace-1/settings/integrations");
  });
});
