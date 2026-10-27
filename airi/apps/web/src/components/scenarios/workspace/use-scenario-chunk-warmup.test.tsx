/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react";
import type { ScenarioSummary } from "../types";

const mockPreloadOpen = jest.fn();
const mockPreloadSummary = jest.fn();
const mockPreloadIdle = jest.fn();

jest.mock("../scenario-editor-chunks", () => ({
  preloadScenarioOpenChunks: () => mockPreloadOpen(),
  preloadScenarioSummaryChunks: (summary: unknown) =>
    mockPreloadSummary(summary),
  preloadScenarioIdleChunks: (options: unknown) => mockPreloadIdle(options),
}));

import { useScenarioChunkWarmup } from "./use-scenario-chunk-warmup";

type WarmupProps = Parameters<typeof useScenarioChunkWarmup>[0];

const scenarios = [
  { _id: "bulk", mode: "bulk_campaign" },
  {
    _id: "template",
    mode: "conversation",
    builderSummary: { primaryActionType: "whatsapp_template" },
  },
] as unknown as ScenarioSummary[];

function props(overrides: Partial<WarmupProps> = {}): WarmupProps {
  return {
    scenarios,
    activeScenarioId: "bulk",
    loadingScenarios: false,
    loadingFlow: true,
    nodeSettingsPanelEnabled: false,
    ...overrides,
  };
}

describe("useScenarioChunkWarmup", () => {
  const originalRequestIdleCallback = window.requestIdleCallback;
  const originalCancelIdleCallback = window.cancelIdleCallback;
  let idleTasks: Map<number, IdleRequestCallback>;

  beforeEach(() => {
    jest.clearAllMocks();
    idleTasks = new Map();
    window.requestIdleCallback = jest.fn(task => {
      const handle = idleTasks.size + 1;
      idleTasks.set(handle, task);
      return handle;
    });
    window.cancelIdleCallback = jest.fn(handle => {
      idleTasks.delete(handle);
    });
  });

  afterEach(() => {
    window.requestIdleCallback = originalRequestIdleCallback;
    window.cancelIdleCallback = originalCancelIdleCallback;
  });

  function runIdleTasks() {
    for (const task of idleTasks.values()) {
      task({ didTimeout: false, timeRemaining: () => 50 });
    }
    idleTasks.clear();
  }

  it("starts the common editors once, with the page", () => {
    const { rerender } = renderHook(useScenarioChunkWarmup, {
      initialProps: props(),
    });
    rerender(props({ activeScenarioId: "template" }));

    expect(mockPreloadOpen).toHaveBeenCalledTimes(1);
  });

  it("starts the editors the active scenario's list entry calls for", () => {
    const { rerender } = renderHook(useScenarioChunkWarmup, {
      initialProps: props(),
    });
    expect(mockPreloadSummary).toHaveBeenLastCalledWith({
      mode: "bulk_campaign",
      primaryActionType: undefined,
    });

    rerender(props({ activeScenarioId: "template" }));
    expect(mockPreloadSummary).toHaveBeenLastCalledWith({
      mode: "conversation",
      primaryActionType: "whatsapp_template",
    });
  });

  it("waits for the canvas before fetching the rest when idle", () => {
    const { rerender, unmount } = renderHook(useScenarioChunkWarmup, {
      initialProps: props({ loadingFlow: true }),
    });
    expect(window.requestIdleCallback).not.toHaveBeenCalled();

    rerender(props({ loadingFlow: false, nodeSettingsPanelEnabled: true }));
    expect(mockPreloadIdle).not.toHaveBeenCalled();
    runIdleTasks();
    expect(mockPreloadIdle).toHaveBeenCalledWith({ nodeSettingsPanel: true });

    rerender(props({ loadingFlow: true }));
    rerender(props({ loadingFlow: false }));
    unmount();
    expect(window.cancelIdleCallback).toHaveBeenCalled();
    expect(idleTasks.size).toBe(0);
  });
});
