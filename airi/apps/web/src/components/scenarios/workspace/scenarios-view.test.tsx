/**
 * @jest-environment jsdom
 */

import { act, render } from "@testing-library/react";
import {
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { ScenariosView } from "./scenarios-view";

const mockController = jest.fn();
const mockSidebarPanel = jest.fn();
const mockEmptyState = jest.fn();

jest.mock("./use-scenarios-workspace-controller", () => ({
  useScenariosWorkspaceController: (params: unknown) => mockController(params),
}));
jest.mock("./use-scenario-chunk-warmup", () => ({
  useScenarioChunkWarmup: jest.fn(),
}));
jest.mock("@/components/limits/free-plan-upsell", () => ({
  FreePlanUpsell: () => <div data-testid="free-plan-upsell" />,
}));
jest.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => null,
}));
jest.mock("../view/scenarios-graph-pane", () => ({
  ScenariosGraphPane: () => null,
}));
jest.mock("../view/scenario-playbook-results", () => ({
  ScenarioPlaybookResults: () => null,
}));
jest.mock("../view/scenarios-view-dialogs", () => ({
  ScenariosViewDialogs: () => null,
}));
jest.mock("../view/scenarios-sidebar-panel", () => ({
  ScenariosSidebarPanel: (props: Record<string, unknown>) => {
    mockSidebarPanel(props);
    return null;
  },
}));
jest.mock("../view/scenarios-view-shell", () => ({
  ScenariosViewEmptyState: (props: Record<string, unknown>) => {
    mockEmptyState(props);
    return null;
  },
  ScenariosViewLoadingState: () => null,
}));

const onPrefetchScenario = jest.fn();

function controllerResult(overrides: Record<string, unknown> = {}) {
  return {
    t: (key: string) => key,
    workspaceId: "workspace-1",
    hasConnectedSources: true,
    isFreePlan: true,
    scenarioCreateLocked: false,
    loadingScenarios: false,
    scenarios: [{ _id: "a" }],
    activeScenarioId: "a",
    activeScenarioPresetId: null,
    isCreatingScenario: false,
    scenarioListLayoutItems: [],
    subscenarioIndicatorByScenarioId: {},
    activeScenarioGraphSettings: {},
    demoCreateFailed: false,
    isAutoCreatingDemo: false,
    graph: {
      historyControls: {},
      data: {},
      resources: { nodeSettingsPanelEnabled: false },
      nodeBridge: {},
      canvas: { loadingFlow: false },
      triggerLog: {},
    },
    dialogs: {},
    sidebar: { onPrefetchScenario },
    emptyState: {},
    ...overrides,
  };
}

type ViewProps = ComponentProps<typeof ScenariosView>;

const viewProps: ViewProps = {
  workspaceId: "workspace-1",
  hasConnectedSources: true,
};

let bumpFrame = () => {};

/** The workspace frame: its own state (toolbar actions) changes often. */
function Frame() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    bumpFrame = () => setCount(current => current + 1);
  }, []);
  return (
    <div data-count={count}>
      <ScenariosView {...viewProps} />
    </div>
  );
}

describe("ScenariosView", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockController.mockImplementation(() => controllerResult());
  });

  it("skips its editor when only the surrounding frame re-renders", () => {
    const { container } = render(<Frame />);
    expect(mockController).toHaveBeenCalledTimes(1);

    act(() => bumpFrame());

    expect(container.firstElementChild?.getAttribute("data-count")).toBe("1");
    expect(mockController).toHaveBeenCalledTimes(1);
  });

  it("gives the sidebar one free-plan notice element across renders", () => {
    const { rerender } = render(<ScenariosView {...viewProps} />);
    const notice = mockSidebarPanel.mock.calls.at(-1)?.[0].createLimitNotice;
    expect(notice).toBeTruthy();

    rerender(<ScenariosView {...viewProps} hasGoogleCalendar />);

    expect(mockSidebarPanel).toHaveBeenCalledTimes(2);
    expect(mockSidebarPanel.mock.calls.at(-1)?.[0].createLimitNotice).toBe(
      notice
    );
    expect(mockSidebarPanel.mock.calls.at(-1)?.[0].onPrefetchScenario).toBe(
      onPrefetchScenario
    );
  });

  it.each([
    [true, false, "scenarioEmptyTitle", "scenarioEmptyDescription"],
    [
      false,
      true,
      "scenarioOnboardingFailedTitle",
      "scenarioOnboardingFailedDescription",
    ],
    [
      false,
      false,
      "scenarioOnboardingCreatingTitle",
      "scenarioOnboardingCreatingDescription",
    ],
  ])(
    "titles the empty workspace (connected %s, demo failed %s)",
    (hasConnectedSources, demoCreateFailed, title, description) => {
      mockController.mockImplementation(() =>
        controllerResult({
          scenarios: [],
          hasConnectedSources,
          demoCreateFailed,
        })
      );
      render(<ScenariosView {...viewProps} />);
      expect(mockEmptyState).toHaveBeenLastCalledWith(
        expect.objectContaining({ title, description })
      );
    }
  );

  it.each([false, true])(
    "shows the regular empty state when creation is locked (demo failed %s)",
    demoCreateFailed => {
      mockController.mockImplementation(() =>
        controllerResult({
          scenarios: [],
          hasConnectedSources: false,
          demoCreateFailed,
          scenarioCreateLocked: true,
        })
      );
      render(<ScenariosView {...viewProps} />);
      expect(mockEmptyState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          title: "scenarioEmptyTitle",
          description: "scenarioEmptyDescription",
          showDemoRetry: false,
          createDisabled: true,
        })
      );
    }
  );
});
