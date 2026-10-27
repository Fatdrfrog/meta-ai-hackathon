/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { useScenarioSelectedResources } from "../view/resources/use-scenario-selected-resources";
import type { ScenarioSummary } from "../types";
import { SCENARIO_PREFETCH_DWELL_MS } from "./use-scenario-detail-prefetch";
import {
  useScenariosWorkspaceController,
  type UseScenariosWorkspaceControllerParams,
} from "./use-scenarios-workspace-controller";

const mockDeleteScenario = jest.fn();
const mockCreateGeneratedScenario = jest.fn();
const mockPatchSidebar = jest.fn();
const mockPrepareSelection = jest.fn();
const mockActivePatch = jest.fn();
const mockClearPendingSave = jest.fn();
const mockFlowControllerParams = jest.fn();
const mockIsScenarioGraphSettled = jest.fn(() => false);
const mockPrefetchScenarioDetail = jest.fn();
const mockUploadActionImage = jest.fn();
const mockGenerateActionVoice = jest.fn();
const mockUpdateActionWhatsAppTemplate = jest.fn();
const mockLoadWhatsAppTemplateForm = jest.fn(async () => ({
  status: "skipped",
}));
const mockLoadingTemplateFormNodeIds = new Set(["node-2"]);
const mockTrackNodeMediaOperation = jest.fn(
  (_nodeId: string, operation: Promise<unknown>) => operation
);
const mockQrEntryPointsParams = jest.fn();
const mockUndo = jest.fn();
const mockRedo = jest.fn();
const mockQrAssignmentHost = {
  readEntryPointId: jest.fn(),
  readSnapshot: jest.fn(),
  adopt: jest.fn(),
};
const mockTranslate = (key: string) => key;
const mockNodes: [] = [];
const mockEdges: [] = [];
let mockValidationRequested = false;

jest.mock("next-intl", () => ({ useTranslations: () => mockTranslate }));
jest.mock("@/hooks/use-company-limits", () => ({
  useCompanyLimits: () => ({}),
}));
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));
jest.mock("@/lib/scenarios/client", () => ({
  deleteScenarioRequest: (...args: unknown[]) => mockDeleteScenario(...args),
  createScenarioFromGeneratorRequest: (...args: unknown[]) =>
    mockCreateGeneratedScenario(...args),
  patchScenarioSidebarRequest: (...args: unknown[]) =>
    mockPatchSidebar(...args),
}));
jest.mock("../view/use-scenario-flow-controller", () => ({
  useScenarioFlowController: (params: unknown) => ({
    ...mockFlowControllerParams(params),
    nodes: mockNodes,
    edges: mockEdges,
    graphEditor: {
      read: () => ({ nodes: mockNodes, edges: mockEdges }),
      edit: jest.fn(),
    },
    loadingFlow: false,
    saveStatus: "unsaved",
    validationRequested: mockValidationRequested,
    clearPendingSave: mockClearPendingSave,
    prepareScenarioSelection: mockPrepareSelection,
    isScenarioGraphSettled: mockIsScenarioGraphSettled,
    trackNodeMediaOperation: mockTrackNodeMediaOperation,
    coordinateActiveScenarioPatch: mockActivePatch,
    whatsAppQrAssignmentHost: mockQrAssignmentHost,
    loadWhatsAppTemplateForm: mockLoadWhatsAppTemplateForm,
    loadingTemplateFormNodeIds: mockLoadingTemplateFormNodeIds,
    undoGraphChange: mockUndo,
    redoGraphChange: mockRedo,
    canUndoGraphChange: false,
    canRedoGraphChange: false,
  }),
}));
jest.mock("@/lib/scenarios/client/scenario-detail-sources", () => ({
  prefetchScenarioDetail: (...args: unknown[]) =>
    mockPrefetchScenarioDetail(...args),
}));
jest.mock("../view/resources/use-scenario-resources-entity", () => {
  // The real hook keeps these identities between renders.
  const resources = {
    contextOptions: [],
    contextItemsByOptionId: {},
    audienceOptions: { channels: [] },
    whatsAppTemplates: [],
    whatsAppFlows: [],
  };
  return { useScenarioResourcesEntity: () => resources };
});
jest.mock("../view/resources/use-scenario-selected-resources", () => ({
  useScenarioSelectedResources: jest.fn(),
}));
jest.mock("../view/use-scenario-graph-controller", () => ({
  useScenarioGraphController: () => ({}),
}));
jest.mock("../view/use-scenario-node-callbacks", () => ({
  useScenarioNodeCallbacks: () => ({
    uploadActionImageForNodeId: mockUploadActionImage,
    generateActionVoiceForNodeId: mockGenerateActionVoice,
    updateActionWhatsAppTemplateById: mockUpdateActionWhatsAppTemplate,
  }),
}));
jest.mock("../view/palette/use-scenario-node-palette-sections", () => ({
  scenarioGraphHasFlowRoot: () => false,
  useScenarioNodePaletteSections: () => ({ nodePaletteSections: [] }),
}));
jest.mock("../view/use-scenario-preview-drawer", () => ({
  useScenarioPreviewDrawer: () => ({}),
}));
jest.mock("../view/use-scenario-trigger-logs", () => ({
  useScenarioTriggerLogs: () => ({}),
}));
jest.mock("../view/useScenarioWhatsAppQrEntryPoints", () => ({
  useScenarioWhatsAppQrEntryPoints: (params: unknown) => {
    mockQrEntryPointsParams(params);
    return {};
  },
}));
jest.mock("../view/use-linked-whatsapp-flow-preview", () => ({
  useLinkedWhatsAppFlowPreview: () => ({ linkedFlowPreview: {} }),
}));
jest.mock("../view/helper-lines", () => ({ useHelperLines: () => ({}) }));
jest.mock("../view/use-pane-drag-gesture", () => ({
  usePaneDragGesture: () => ({}),
}));
jest.mock("../view/palette/use-scenario-context-menu", () => ({
  useScenarioContextMenu: () => ({}),
}));

const scenarios: ScenarioSummary[] = ["a", "b"].map(id => ({
  _id: id,
  name: id.toUpperCase(),
  description: "",
  status: "draft",
  mode: "conversation",
  timezone: "UTC",
  priority: 0,
  matchingRole: "default",
  entryPolicy: "repeatable",
  nodeCount: 0,
  edgeCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}));

function useController(
  overrides: Partial<UseScenariosWorkspaceControllerParams> = {}
) {
  return useScenariosWorkspaceController({
    workspaceId: "workspace-1",
    initialScenarios: scenarios,
    hasConnectedSources: true,
    ...overrides,
  });
}

describe("scenario workspace document coordination", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidationRequested = false;
    mockIsScenarioGraphSettled.mockReturnValue(false);
    mockPrepareSelection.mockResolvedValue(true);
    mockActivePatch.mockResolvedValue(true);
    mockDeleteScenario.mockResolvedValue(undefined);
    mockPatchSidebar.mockResolvedValue({
      ...scenarios[1],
      name: "Renamed B",
      nodes: [],
      edges: [],
    });
  });

  it.each([
    ["off by default", undefined, false],
    ["on", true, true],
  ])(
    "hands the node settings flag (%s) to the graph pane and graph history",
    (_label, nodeSettingsPanelEnabled, expected) => {
      const { result } = renderHook(() =>
        useController({ nodeSettingsPanelEnabled })
      );
      expect(result.current.graph.resources.nodeSettingsPanelEnabled).toBe(
        expected
      );
      expect(mockFlowControllerParams).toHaveBeenLastCalledWith(
        expect.objectContaining({ keepSelectionThroughHistory: expected })
      );
    }
  );

  it("validates graph editors only for active scenarios or an attempted publication", () => {
    const { result, rerender } = renderHook(useController);
    expect(result.current.activeScenarioGraphSettings.validationMode).toBe(
      "draft"
    );
    mockValidationRequested = true;
    rerender();
    expect(result.current.activeScenarioGraphSettings.validationMode).toBe(
      "runnable"
    );
    mockValidationRequested = false;
    rerender();
    expect(result.current.activeScenarioGraphSettings.validationMode).toBe(
      "draft"
    );
    act(() =>
      result.current.activeScenarioGraphSettings.onScenarioStatusChange(
        "active"
      )
    );
    expect(result.current.activeScenarioGraphSettings.validationMode).toBe(
      "runnable"
    );
  });

  it("applies a sent scenario's status only while that scenario is open", () => {
    const { result } = renderHook(useController);
    act(() =>
      result.current.activeScenarioGraphSettings.onScenarioStatusChange(
        "active",
        "b"
      )
    );
    expect(result.current.activeScenarioGraphSettings.validationMode).toBe(
      "draft"
    );
    expect(result.current.scenarios.map(scenario => scenario.status)).toEqual([
      "draft",
      "draft",
    ]);

    act(() =>
      result.current.activeScenarioGraphSettings.onScenarioStatusChange(
        "active",
        "a"
      )
    );
    expect(result.current.activeScenarioGraphSettings.validationMode).toBe(
      "runnable"
    );
  });

  it("leaves the active editor's pending save intact when deleting an inactive scenario", async () => {
    const { result } = renderHook(useController);
    act(() => result.current.sidebar.onDeleteScenario("b"));
    expect(
      result.current.dialogs.pendingConfirmationDialog.pendingConfirmation
    ).toMatchObject({
      scenarioId: "b",
    });
    act(() => result.current.dialogs.pendingConfirmationDialog.onConfirm());
    await waitFor(() => expect(result.current.scenarios).toHaveLength(1));
    expect(mockDeleteScenario).toHaveBeenCalledTimes(1);
    expect(result.current.activeScenarioId).toBe("a");
    expect(mockClearPendingSave).not.toHaveBeenCalled();
    expect(mockPrepareSelection).not.toHaveBeenCalled();
  });

  it("routes sidebar navigation through editor preparation", async () => {
    mockPrepareSelection.mockResolvedValueOnce(false);
    const { result } = renderHook(useController);
    await act(async () => {
      expect(await result.current.sidebar.onSelectScenario("b")).toBe(false);
    });
    expect(result.current.activeScenarioId).toBe("a");
    await act(async () => {
      expect(await result.current.sidebar.onSelectScenario("b")).toBe(true);
    });
    expect(result.current.activeScenarioId).toBe("b");
    expect(mockPrepareSelection).toHaveBeenCalledTimes(2);
  });

  it("selects the generated document after creation registers it in the sidebar", async () => {
    mockCreateGeneratedScenario.mockResolvedValue({
      scenario: {
        ...scenarios[0],
        _id: "created",
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    });
    const { result } = renderHook(useController);
    const createGenerated =
      result.current.dialogs.airiCreateDialog.onCreateGeneratedScenario;
    if (!createGenerated)
      throw new Error("Generated scenario creation must be wired");
    await act(async () => {
      expect(
        await createGenerated({
          workspaceId: "workspace-1",
          prompt: "Create a welcome journey",
          workflowKind: "follow_up_workflow",
          sendMode: "trigger",
          channels: ["whatsapp"],
        })
      ).toBe(true);
    });
    expect(
      result.current.scenarios.some(scenario => scenario._id === "created")
    ).toBe(true);
    expect(result.current.activeScenarioId).toBe("created");
  });

  it("honors a repeated URL scenario after the parameter was removed", async () => {
    const { result, rerender } = renderHook<
      ReturnType<typeof useController>,
      Pick<UseScenariosWorkspaceControllerParams, "requestedScenarioId">
    >(
      (
        props: Pick<
          UseScenariosWorkspaceControllerParams,
          "requestedScenarioId"
        >
      ) => useController(props),
      { initialProps: { requestedScenarioId: "b" } }
    );
    expect(result.current.activeScenarioId).toBe("b");
    await act(async () => {
      expect(await result.current.sidebar.onSelectScenario("a")).toBe(true);
    });
    rerender({ requestedScenarioId: null });
    rerender({ requestedScenarioId: "b" });
    await waitFor(() => expect(result.current.activeScenarioId).toBe("b"));
  });

  it("uses the document writer for active settings and the sidebar writer for inactive settings", async () => {
    const { result } = renderHook(useController);
    await act(async () => {
      expect(
        await result.current.sidebar.onScenarioNameCommit("a", "Renamed A")
      ).toBe(true);
      expect(
        await result.current.sidebar.onScenarioNameCommit("b", "Renamed B")
      ).toBe(true);
    });
    expect(mockActivePatch).toHaveBeenCalledWith({ name: "Renamed A" });
    expect(mockPatchSidebar).toHaveBeenCalledTimes(1);
    expect(mockPatchSidebar).toHaveBeenCalledWith({
      scenarioId: "b",
      workspaceId: "workspace-1",
      patch: { name: "Renamed B" },
    });
  });

  it("keeps the canvas resources and undo controls identical across unrelated renders", () => {
    const { result, rerender } = renderHook(useController);
    const { resources, historyControls } = result.current.graph;

    rerender();

    expect(result.current.graph.resources).toBe(resources);
    expect(result.current.graph.historyControls).toBe(historyControls);
    expect(historyControls).toEqual({
      undo: mockUndo,
      redo: mockRedo,
      canUndo: false,
      canRedo: false,
    });
  });

  it("hands the QR picker the editor's save-aware host and whether a QR trigger exists", () => {
    renderHook(useController);
    expect(mockQrEntryPointsParams).toHaveBeenLastCalledWith(
      expect.objectContaining({
        assignmentHost: mockQrAssignmentHost,
        hasWhatsAppQrTrigger: false,
      })
    );
  });

  it("reads the next scenario during the switch only when leaving writes nothing", async () => {
    const { result } = renderHook(useController);

    await act(async () => {
      await result.current.sidebar.onSelectScenario("b");
    });
    expect(mockPrefetchScenarioDetail).not.toHaveBeenCalled();

    mockIsScenarioGraphSettled.mockReturnValue(true);
    await act(async () => {
      await result.current.sidebar.onSelectScenario("a");
    });
    expect(mockPrefetchScenarioDetail).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId: "a",
    });
    expect(result.current.activeScenarioId).toBe("a");
  });

  it("reads a sidebar scenario ahead once pointed at for a moment, but never the open one", () => {
    jest.useFakeTimers();
    try {
      const { result } = renderHook(useController);

      act(() => result.current.sidebar.onPrefetchScenario("a"));
      act(() => jest.advanceTimersByTime(SCENARIO_PREFETCH_DWELL_MS));
      expect(mockPrefetchScenarioDetail).not.toHaveBeenCalled();

      // Passing over an entry reads nothing.
      act(() => result.current.sidebar.onPrefetchScenario("b"));
      act(() => jest.advanceTimersByTime(SCENARIO_PREFETCH_DWELL_MS - 1));
      act(() => result.current.sidebar.onCancelScenarioPrefetch("b"));
      act(() => jest.advanceTimersByTime(SCENARIO_PREFETCH_DWELL_MS));
      expect(mockPrefetchScenarioDetail).not.toHaveBeenCalled();

      act(() => result.current.sidebar.onPrefetchScenario("b"));
      act(() => jest.advanceTimersByTime(SCENARIO_PREFETCH_DWELL_MS));
      expect(mockPrefetchScenarioDetail).toHaveBeenCalledTimes(1);
      expect(mockPrefetchScenarioDetail).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        scenarioId: "b",
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it("drops a waiting read-ahead when a selection may save first", async () => {
    jest.useFakeTimers();
    try {
      const { result } = renderHook(useController);

      act(() => result.current.sidebar.onPrefetchScenario("b"));
      await act(async () => {
        await result.current.sidebar.onSelectScenario("a");
      });
      act(() => jest.advanceTimersByTime(SCENARIO_PREFETCH_DWELL_MS));

      expect(mockPrefetchScenarioDetail).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("shows a step's signed media only after its upload or voice finished", async () => {
    const attachment = { url: "https://cdn.example/new.png" };
    mockUploadActionImage.mockResolvedValue(attachment);
    mockGenerateActionVoice.mockResolvedValue(attachment);
    const { result } = renderHook(useController);
    const callbacks = result.current.graph.nodeBridge.nodeCallbacks;
    const file = new File(["x"], "x.png", { type: "image/png" });

    await expect(
      callbacks.uploadActionImageForNodeId("node-1", file, { persist: false })
    ).resolves.toBe(attachment);
    await expect(
      callbacks.generateActionVoiceForNodeId("node-2", { text: "Hi" })
    ).resolves.toBe(attachment);

    expect(mockUploadActionImage).toHaveBeenCalledWith("node-1", file, {
      persist: false,
    });
    expect(mockGenerateActionVoice).toHaveBeenCalledWith("node-2", {
      text: "Hi",
    });
    expect(mockTrackNodeMediaOperation.mock.calls.map(([id]) => id)).toEqual([
      "node-1",
      "node-2",
    ]);
  });

  it("loads the form fields of the template a new step gets by default", () => {
    const { result } = renderHook(useController);
    const [{ selectWhatsAppTemplate }] = jest.mocked(
      useScenarioSelectedResources
    ).mock.lastCall!;

    selectWhatsAppTemplate("node-1", "demoshop_test::kk");

    expect(mockUpdateActionWhatsAppTemplate).toHaveBeenCalledWith(
      "node-1",
      "demoshop_test::kk"
    );
    expect(mockLoadWhatsAppTemplateForm).toHaveBeenCalledWith("node-1", {
      reason: "pick",
    });
    expect(
      mockUpdateActionWhatsAppTemplate.mock.invocationCallOrder[0]
    ).toBeLessThan(mockLoadWhatsAppTemplateForm.mock.invocationCallOrder[0]);
    // Steps load their form fields, and show the load, through the bridge.
    expect(result.current.graph.nodeBridge).toMatchObject({
      loadWhatsAppTemplateForm: mockLoadWhatsAppTemplateForm,
      loadingTemplateFormNodeIds: mockLoadingTemplateFormNodeIds,
    });
  });
});
