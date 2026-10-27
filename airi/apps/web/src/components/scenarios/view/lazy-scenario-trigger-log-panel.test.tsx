/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

const mockPanelModuleLoaded = jest.fn();

jest.mock("./scenario-trigger-log-panel", () => {
  mockPanelModuleLoaded();
  return {
    ScenarioTriggerLogPanel: ({ logs }: { logs: unknown[] }) => (
      <aside aria-label="triggerLogTitle">{logs.length} logs</aside>
    ),
  };
});

import { LazyScenarioTriggerLogPanel } from "./lazy-scenario-trigger-log-panel";

describe("LazyScenarioTriggerLogPanel", () => {
  it("shows the logs' loading line in the panel's place until it loads", async () => {
    expect(mockPanelModuleLoaded).not.toHaveBeenCalled();
    render(
      <LazyScenarioTriggerLogPanel
        logs={[]}
        loading={false}
        onRefresh={jest.fn()}
        onLoadMore={jest.fn()}
        onClose={jest.fn()}
        layout="bottom"
      />
    );

    const loading = screen.getByRole("status");
    expect(loading).toHaveTextContent("triggerLogLoading");
    expect(loading).toHaveClass("h-full", "border-t");
    expect(
      await screen.findByRole("complementary", { name: "triggerLogTitle" })
    ).toHaveTextContent("0 logs");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
