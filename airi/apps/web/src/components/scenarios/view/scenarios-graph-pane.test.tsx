/**
 * @jest-environment jsdom
 */

import type { ComponentProps, ReactNode } from "react";
import "@testing-library/jest-dom";
import { ACTION_ANY_REPLY_OUTCOME_HANDLE_ID } from "@icecore/scenario-contracts";
import { getPostActionConditionHandleId } from "@icecore/scenario-contracts";

let capturedReactFlowProps: Record<string, unknown> | null = null;
const mockFitView = jest.fn();
const mockZoomIn = jest.fn();
const mockZoomOut = jest.fn();

jest.mock("@xyflow/react", () => ({
  Panel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useReactFlow: () => ({
    fitView: mockFitView,
    zoomIn: mockZoomIn,
    zoomOut: mockZoomOut,
  }),
  useViewport: () => ({ zoom: 0.7 }),
  Background: () => <div data-testid="react-flow-background" />,
  ReactFlow: (props: Record<string, unknown> & { children?: ReactNode }) => {
    capturedReactFlowProps = props;
    return (
      <div data-testid="react-flow">
        <div data-testid="plain-wheel-target">Canvas area</div>
        <div
          className="nowheel"
          data-testid="guarded-wheel-target"
          style={{ overflowY: "auto" }}
        >
          <div className="nowheel" data-testid="nested-guarded-wheel-target">
            <div data-testid="guarded-wheel-content">Scrollable editor</div>
          </div>
        </div>
        {props.children}
      </div>
    );
  },
  MarkerType: { ArrowClosed: "ArrowClosed" },
  Position: { Left: "left", Right: "right" },
  SelectionMode: { Partial: "partial" },
  ViewportPortal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  getBezierPath: () => ["M0 0", 0, 0],
}));

// Latest props of each resizable panel, by panel id.
const mockResizablePanelProps = new Map<string, Record<string, unknown>>();
const mockResizeObservers = new Map<Element, () => void>();

jest.mock("@/components/ui/resizable", () => ({
  ResizablePanel: ({
    children,
    ...props
  }: Record<string, unknown> & { children?: ReactNode }) => {
    mockResizablePanelProps.set(String(props.id), props);
    return (
      <div data-testid="resizable-panel" data-panel-id={String(props.id)}>
        {children}
      </div>
    );
  },
  ResizableHandle: ({
    disabled,
    "aria-label": ariaLabel,
  }: {
    disabled?: boolean;
    "aria-label"?: string;
  }) => (
    <div
      role="separator"
      aria-label={ariaLabel}
      data-disabled={String(Boolean(disabled))}
    />
  ),
}));
jest.mock("@/lib/observe-element-resize", () => ({
  observeElementResize: (element: Element, callback: () => void) => {
    mockResizeObservers.set(element, callback);
    return () => mockResizeObservers.delete(element);
  },
}));
jest.mock("./node-settings/scenario-node-settings-reveal", () => ({
  ScenarioNodeSettingsReveal: ({ nodeId }: { nodeId: string }) => (
    <div data-testid="node-settings-reveal" data-node-id={nodeId} />
  ),
}));

jest.mock("next-intl", () => ({
  useFormatter: () => ({
    number: (value: number, options: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat("en", options).format(value),
  }),
  useLocale: () => "en",
  useTranslations: () => (key: string) => key,
}));

jest.mock("../nodes/action-node", () => ({
  ActionNode: () => null,
}));
// Action settings host the builders: no provider resources or matchMedia.
jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
jest.mock(
  "../builders/whatsapp/service-message/service-message-resources",
  () => ({
    ...jest.requireActual(
      "../builders/whatsapp/service-message/service-message-resources"
    ),
    useWhatsAppServiceMessageResources: () => ({
      loading: false,
      failed: false,
      retry: jest.fn(),
      signupLinks: [],
      callingReady: true,
      catalogs: [],
      products: [],
    }),
  })
);
jest.mock("@/components/whatsapp-templates/template-form-drawer", () => ({
  TemplateFormDrawer: () => null,
}));
jest.mock("../nodes/bulk-root-node", () => ({
  BulkRootNode: () => null,
}));
jest.mock("../nodes/link-node", () => ({
  ScenarioLinkNode: () => null,
}));
jest.mock("../nodes/scenario-node", () => ({
  ScenarioNode: () => null,
}));
jest.mock("../nodes/trigger-node", () => ({
  TriggerNode: () => null,
}));

jest.mock("./helper-lines", () => ({
  HelperLinesRenderer: () => null,
}));

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { resolveScenarioNodeSettingsLayout } from "./node-settings/scenario-node-settings-panel";
import { scenarioEditorChunks } from "../scenario-editor-chunks";
import { ScenariosGraphPane } from "./scenarios-graph-pane";
import type { ScenarioCanvasSelection } from "./graph/controller-utils";
import { createGraphTestNode, createGraphTestEdge } from "./graph/test-utils";
import type {
  ScenarioDisplayNodeCallbacks,
  ScenarioNodeEnrichmentResources,
  ScenarioNodeEnrichmentScenarioSettings,
} from "./scenario-node-enrichment-context";
import type { ScenarioLinkEditorNodeData } from "./node-enrichment/types";
import type { ScenarioNodeData } from "../types";

function renderGraphPane({
  onWheel,
  contextMenuSourceLabel,
  data = {},
  resources = {},
  nodeCallbacks = {},
  scenarioSettings = {},
  isValidConnection = jest.fn(() => true),
  addEmptyCanvasRootNode = jest.fn(),
  closeContextMenu = jest.fn(),
  canvasSelection = { nodeIds: new Set(), edgeIds: new Set() },
  canvas = {},
  panelGroup = false,
}: {
  /** Host the pane in a resizable panel group, as the workspace does. */
  panelGroup?: boolean;
  onWheel?: () => void;
  contextMenuSourceLabel?: string;
  data?: Record<string, unknown>;
  resources?: Partial<ScenarioNodeEnrichmentResources>;
  nodeCallbacks?: Partial<ScenarioDisplayNodeCallbacks>;
  scenarioSettings?: ScenarioNodeEnrichmentScenarioSettings;
  isValidConnection?: () => boolean;
  addEmptyCanvasRootNode?: (kind: "trigger" | "bulk") => void;
  closeContextMenu?: () => void;
  canvasSelection?: ScenarioCanvasSelection;
  canvas?: Partial<ComponentProps<typeof ScenariosGraphPane>["canvas"]>;
} = {}) {
  const noop = jest.fn();
  // Created once, so a rerender with new graph data keeps every other prop.
  const linkedConditionParentCountByNodeId = new Map();
  const selectExistingFlowForNodeRef = { current: jest.fn() as never };
  const handleBranchSyncForNodeRef = { current: jest.fn() as never };
  const t = (key: string) => key;
  const audienceOptions = {
    channels: [],
    customers: [],
    internalLabels: [],
    funnelStages: [],
    classificationCategories: [],
    metaReferralAds: [],
    metaReferralAdSets: [],
    metaReferralCampaigns: [],
    metaCampaignLabels: [],
  };
  const renderElement = (currentData: Record<string, unknown>) => (
    <div onWheel={onWheel} data-panel-group={panelGroup ? "" : undefined}>
      <ScenariosGraphPane
        canvas={{
          canvasSelection,
          flowWrapperRef: { current: null },
          loadingFlow: false,
          setReactFlowInstance: noop,
          scenarioGraphResources: {} as never,
          interactionMode: "select",
          helperLines: { horizontal: null, vertical: null },
          contextMenu: contextMenuSourceLabel
            ? { left: 0, top: 0, flowX: 0, flowY: 0 }
            : null,
          closeContextMenu,
          contextMenuSourceLabel,
          contextMenuSections: [],
          addNodeFromPaletteItem: noop,
          addEmptyCanvasRootNode,
          onNodesChange: noop,
          onEdgesChange: noop,
          onConnect: noop,
          isValidConnection,
          onConnectStart: noop,
          onConnectEnd: noop,
          onBeforeDelete: jest.fn(async params => params),
          onSelectionChange: noop,
          onEdgeClick: noop,
          onNodeDrag: noop,
          onNodeDragStop: noop,
          onNodeClick: noop,
          onPaneClick: noop,
          onPaneContextMenu: noop,
          onPaneMouseDown: noop,
          onPaneMouseUp: noop,
          onViewportChange: noop,
          ...canvas,
        }}
        data={{
          linkedConditionParentCountByNodeId,
          nodes: [],
          selectedNodeId: null,
          edges: [],
          ...currentData,
        }}
        resources={{
          activeScenarioId: "scenario-1",
          audienceOptions,
          contextItemsByOptionId: {},
          contextOptions: [],
          isCreatingSnippet: false,
          t,
          whatsAppFlows: [],
          whatsAppTemplates: [],
          workspaceId: "workspace-1",
          managedWhatsAppFlowProvisioningSources: [],
          ...resources,
        }}
        nodeBridge={{
          nodeCallbacks: {
            resolvePreviewProfileForActionNode: jest.fn(() => ({
              channel: "whatsapp",
            })),
            ...nodeCallbacks,
          } as never,
          adoptGeneratedBulkServerUpdate: jest.fn(),
          prepareScenarioBulkSend: jest.fn(),
          adoptScenarioActivation: jest.fn(),
          onScenarioActivationBlocked: jest.fn(),
          publishManagedWhatsAppFlow: jest.fn(async () => null),
          scenarioSessionOwnerKey: "session-1",
          publishingManagedFlowNodeId: null,
          prepareGeneratedJobRefresh: jest.fn().mockResolvedValue(true),

          submitGeneratedTemplateForNode: jest.fn(async () => true),

          submittingGeneratedTemplateNodeId: null,
          loadWhatsAppTemplateForm: jest.fn(async () => ({
            status: "skipped" as const,
          })),
          loadingTemplateFormNodeIds: new Set<string>(),
          reconcileGeneratedJobServerUpdate: jest.fn(),
          selectExistingFlowForNodeRef,
          handleBranchSyncForNodeRef,
          openNodePickerFromHandle: noop,
        }}
        scenarioSettings={scenarioSettings}
        triggerLog={{
          showTriggerLogPanel: false,
          triggerLogs: [],
          triggerLogsHasMore: false,
          loadingTriggerLogs: false,
          loadTriggerLogs: noop,
          loadMoreTriggerLogs: noop,
          setShowTriggerLogPanel: noop,
        }}
      />
    </div>
  );
  const view = render(renderElement(data));

  return {
    addEmptyCanvasRootNode,
    closeContextMenu,
    ...view,
    rerenderData: (nextData: Record<string, unknown>) =>
      view.rerender(renderElement(nextData)),
  };
}

// Editors load lazily in the app; load them up front so they render at once.
beforeAll(async () => {
  await Promise.all([
    scenarioEditorChunks.nodePaletteMenu.load(),
    scenarioEditorChunks.triggerNodeSettings.load(),
    scenarioEditorChunks.actionNodeSettings.load(),
    scenarioEditorChunks.whatsAppInlineEditor.load(),
    scenarioEditorChunks.whatsAppServiceMessageSection.load(),
    scenarioEditorChunks.whatsAppTemplateSection.load(),
    scenarioEditorChunks.generativeAISection.load(),
    scenarioEditorChunks.telegramReplyBuilder.load(),
    scenarioEditorChunks.bulkRootNode.load(),
    scenarioEditorChunks.triggerLogPanel.load(),
  ]);
});

describe("ScenariosGraphPane", () => {
  it("mounts the focused trigger editor outside the virtualized canvas", () => {
    const updateTriggerConfigById = jest.fn();
    renderGraphPane({
      data: {
        nodes: [createGraphTestNode("trigger", { kind: "trigger" })],
        selectedNodeId: "trigger",
      },
      nodeCallbacks: { selectNodeById: jest.fn(), updateTriggerConfigById },
    });
    const editor = screen.getByRole("dialog", { name: "triggerEditorTitle" });
    expect(screen.getByTestId("react-flow").contains(editor)).toBe(false);
    expect(updateTriggerConfigById).not.toHaveBeenCalled();
  });
  it("keeps a click that moves a few pixels a node click", () => {
    renderGraphPane({
      data: { nodes: [createGraphTestNode("action", { kind: "action" })] },
    });
    const clickDistance = capturedReactFlowProps?.nodeClickDistance as number;
    const dragThreshold = capturedReactFlowProps?.nodeDragThreshold as number;
    // With React Flow's default of 0, any pointer movement swallows the click
    // and the card never opens its settings.
    expect(clickDistance).toBeGreaterThanOrEqual(dragThreshold);
    expect(clickDistance).toBeGreaterThan(0);
  });

  it("collapses the selected destination and reveals its road when changing the destination", () => {
    const source = createGraphTestNode("source", {
      kind: "action",
      actionType: "reply",
    });
    const target = createGraphTestNode("target", {
      kind: "action",
      actionType: "reply",
    });
    const connect = jest.fn();
    renderGraphPane({
      data: {
        nodes: [source, target],
        edges: [
          createGraphTestEdge("source", "target", {
            sourceHandle: "right-source",
          }),
        ],
        selectedNodeId: "target",
      },
      canvas: {
        contextMenu: {
          left: 0,
          top: 0,
          flowX: 0,
          flowY: 0,
          connectFromNodeId: "source",
          connectFromSourceHandle: "right-source",
        },
        contextMenuRoute: {
          currentDestinationId: "target",
          destinations: [{ nodeId: "target", label: "Target" }],
        },
        connectContextMenuToNode: connect,
        disconnectContextMenuRoute: jest.fn(),
      },
    });
    const collapse = screen.getByRole("menuitem", {
      name: "routeCollapseBranch",
    });
    expect(collapse.querySelector(".lucide-chevrons-down-up")).not.toBeNull();
    fireEvent.click(collapse);
    expect(
      (capturedReactFlowProps!.nodes as Array<{ id: string }>).map(
        node => node.id
      )
    ).toEqual(["source"]);
    // The toggle now expands the branch, and its icon points outward.
    expect(
      screen
        .getByRole("menuitem", { name: "routeExpandBranch" })
        .querySelector(".lucide-chevrons-up-down")
    ).not.toBeNull();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "routeExistingStep" })
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Target" }));
    expect(connect).toHaveBeenCalledWith("target");
    expect(
      (capturedReactFlowProps!.nodes as Array<{ id: string }>).map(
        node => node.id
      )
    ).toEqual(["source", "target"]);
  });
  it("opens service route actions and creates an explicit end destination", () => {
    const add = jest.fn();
    renderGraphPane({
      canvas: {
        contextMenu: {
          left: 0,
          top: 0,
          flowX: 0,
          flowY: 0,
          connectFromNodeId: "source",
          connectFromSourceHandle: "right-source",
        },
        contextMenuRoute: { currentDestinationId: null, destinations: [] },
        connectContextMenuToNode: jest.fn(),
        disconnectContextMenuRoute: jest.fn(),
        addNodeFromPaletteItem: add,
      },
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "routeEnd" }));
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "action",
        defaults: { actionType: "end_scenario" },
      })
    );
  });

  it("highlights simulated nodes and edges without writing highlight state into the graph", () => {
    const nodes = [
      createGraphTestNode("source", { kind: "action", actionType: "reply" }),
      createGraphTestNode("next", { kind: "action", actionType: "reply" }),
    ];
    const edges = [createGraphTestEdge("source", "next")];
    renderGraphPane({
      data: { nodes, edges },
      canvas: {
        highlightedNodeIds: ["next"],
        highlightedEdgeIds: ["source-next"],
      },
    });
    expect(
      (
        capturedReactFlowProps!.nodes as Array<{
          id: string;
          className?: string;
        }>
      ).find(node => node.id === "next")?.className
    ).toContain("scenario-route-highlight");
    expect(
      (capturedReactFlowProps!.edges as Array<{ animated?: boolean }>)[0]
        .animated
    ).toBe(true);
    expect(nodes[1].className).toBeUndefined();
    expect(edges[0].animated).toBeUndefined();
  });
  it("keeps document commands, linked-scenario resources and validation available after graph projection", () => {
    const updateNodeById = jest.fn();
    const scenarioLinkOptions = [{ id: "next-scenario", name: "Next step" }];
    renderGraphPane({
      data: {
        nodes: [createGraphTestNode("link", { kind: "scenario_link" })],
      },
      resources: { scenarioLinkOptions },
      nodeCallbacks: { updateNodeById },
      scenarioSettings: { validationMode: "runnable" },
    });

    const [node] = capturedReactFlowProps?.nodes as Array<{
      data: ScenarioLinkEditorNodeData;
    }>;
    expect(node.data.uiScenarioOptions).toBe(scenarioLinkOptions);
    expect(node.data.uiValidationMode).toBe("runnable");
    node.data.uiOnPatch({ linkedScenarioId: "next-scenario" });
    expect(updateNodeById).toHaveBeenCalledWith("link", {
      linkedScenarioId: "next-scenario",
    });
  });

  it("projects canvas selection after enrichment without changing authored graph data", () => {
    const nodes = [
      createGraphTestNode("first", { kind: "action", actionType: "reply" }),
      createGraphTestNode("second", { kind: "action", actionType: "reply" }),
    ];
    const edges = [createGraphTestEdge("first", "second")];
    renderGraphPane({
      data: { nodes, edges },
      canvasSelection: {
        nodeIds: new Set(["second"]),
        edgeIds: new Set([edges[0].id]),
      },
    });
    expect(capturedReactFlowProps?.nodes).toEqual([
      expect.objectContaining({ id: "first", selected: false }),
      expect.objectContaining({ id: "second", selected: true }),
    ]);
    expect(capturedReactFlowProps?.edges).toEqual([
      expect.objectContaining({ id: edges[0].id, selected: true }),
    ]);
    expect(nodes.every(node => node.selected === undefined)).toBe(true);
    expect(edges[0].selected).toBeUndefined();
  });

  beforeEach(() => {
    capturedReactFlowProps = null;
  });

  it("allows selected arrows to be removed with Backspace or Delete", () => {
    renderGraphPane();

    expect(screen.getByTestId("react-flow")).toBeTruthy();
    expect(capturedReactFlowProps?.deleteKeyCode).toBeNull();
    expect(capturedReactFlowProps?.autoPanOnNodeFocus).toBe(true);
    expect(capturedReactFlowProps?.autoPanOnSelection).toBe(true);
    expect(capturedReactFlowProps?.ariaLabelConfig).toEqual({
      "handle.ariaLabel": "canvasHandle",
      "node.a11yDescription.default": "canvasNodeA11yDescription",
      "node.a11yDescription.keyboardDisabled":
        "canvasNodeA11yDescriptionWithKeys",
      "edge.a11yDescription.default": "canvasEdgeA11yDescription",
    });
  });

  it("uses live connection validation and a small drag threshold", () => {
    const isValidConnection = jest.fn(() => false);
    renderGraphPane({ isValidConnection });

    expect(capturedReactFlowProps?.isValidConnection).toBe(isValidConnection);
    expect(capturedReactFlowProps?.connectionDragThreshold).toBe(3);
    expect(capturedReactFlowProps?.onError).toEqual(expect.any(Function));
  });

  it("hands React Flow the same objects for nodes a size measurement leaves unchanged", () => {
    const trigger = createGraphTestNode("trigger", { kind: "trigger" });
    const greeting = createGraphTestNode("greeting", {
      kind: "action",
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyText: "Hello",
    });
    const followUp = createGraphTestNode("follow-up", {
      kind: "action",
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyText: "Bye",
    });
    const edges = [
      createGraphTestEdge("trigger", "greeting", {
        sourceHandle: "right-source",
      }),
      createGraphTestEdge("greeting", "follow-up", {
        sourceHandle: "right-source",
      }),
    ];
    const { rerenderData } = renderGraphPane({
      data: { nodes: [trigger, greeting, followUp], edges },
    });
    const first = capturedReactFlowProps?.nodes as { data: unknown }[];

    rerenderData({
      nodes: [
        trigger,
        { ...greeting, measured: { width: 320, height: 180 } },
        followUp,
      ],
      edges: [...edges],
    });
    const next = capturedReactFlowProps?.nodes as { data: unknown }[];

    expect(next).toHaveLength(3);
    expect(next[0]).toBe(first[0]);
    expect(next[2]).toBe(first[2]);
    expect(next[1]).not.toBe(first[1]);
    expect(next[1].data).toBe(first[1].data);
    expect(next[1]).toMatchObject({ measured: { width: 320, height: 180 } });
  });

  it("hands React Flow the same edge objects until an edge or its route changes", () => {
    const trigger = createGraphTestNode("trigger", { kind: "trigger" });
    const ask = createGraphTestNode(
      "ask",
      { kind: "action", actionType: "reply" },
      { position: { x: 300, y: 100 } }
    );
    const retry = createGraphTestNode(
      "retry",
      { kind: "action", actionType: "reply" },
      { position: { x: 600, y: 100 } }
    );
    const edges = [
      createGraphTestEdge("trigger", "ask", { sourceHandle: "right-source" }),
      createGraphTestEdge("ask", "retry", { sourceHandle: "right-source" }),
      // Goes back to an earlier step, so the canvas draws it as a return.
      createGraphTestEdge("retry", "ask", { sourceHandle: "right-source" }),
    ];
    const { rerenderData } = renderGraphPane({
      data: { nodes: [trigger, ask, retry], edges },
    });
    const canvasEdges = () =>
      capturedReactFlowProps?.edges as Array<{
        id: string;
        type?: string;
        selected?: boolean;
        data?: { scenarioReturn?: { routeY: number } };
      }>;
    const first = canvasEdges();
    expect(first[2].type).toBe("scenarioReturn");

    // React Flow measures a step: nodes change, no edge does.
    rerenderData({
      nodes: [
        trigger,
        { ...ask, measured: { width: 320, height: 180 } },
        retry,
      ],
      edges: [...edges],
    });
    expect(canvasEdges()).toHaveLength(3);
    canvasEdges().forEach((edge, index) => expect(edge).toBe(first[index]));

    // Moving the top step moves the return route above it.
    rerenderData({
      nodes: [trigger, { ...ask, position: { x: 300, y: -200 } }, retry],
      edges,
    });
    const moved = canvasEdges();
    expect(moved[0]).toBe(first[0]);
    expect(moved[1]).toBe(first[1]);
    expect(moved[2]).not.toBe(first[2]);
    expect(moved[2].data?.scenarioReturn?.routeY).toBeLessThan(
      first[2].data!.scenarioReturn!.routeY
    );
  });

  it("keeps every node of a scenario-sized graph mounted and culls very large ones", () => {
    const graph = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        createGraphTestNode(`note-${index}`, { kind: "context" })
      );
    const { rerenderData } = renderGraphPane({ data: { nodes: graph(100) } });
    expect(capturedReactFlowProps?.onlyRenderVisibleElements).toBe(false);

    rerenderData({ nodes: graph(101) });
    expect(capturedReactFlowProps?.onlyRenderVisibleElements).toBe(true);
  });

  it("passes React Flow one move-end handler that saves the viewport", () => {
    const onViewportChange = jest.fn();
    const { rerenderData } = renderGraphPane({ canvas: { onViewportChange } });
    const onMoveEnd = capturedReactFlowProps?.onMoveEnd as (
      event: unknown,
      viewport: { x: number; y: number; zoom: number }
    ) => void;

    rerenderData({ nodes: [] });
    onMoveEnd(null, { x: 5, y: 6, zoom: 0.8 });

    expect(capturedReactFlowProps?.onMoveEnd).toBe(onMoveEnd);
    expect(onViewportChange).toHaveBeenCalledWith({ x: 5, y: 6, zoom: 0.8 });
  });

  it.each([
    [
      "opens at the session or saved viewport",
      { viewport: { x: 10, y: 20, zoom: 0.5 }, fitView: false },
      { defaultViewport: { x: 10, y: 20, zoom: 0.5 } },
    ],
    [
      "fits a first open as soon as the nodes are measured",
      { viewport: { x: 10, y: 20, zoom: 0.5 }, fitView: true },
      {
        defaultViewport: { x: 10, y: 20, zoom: 0.5 },
        fitView: true,
        fitViewOptions: { padding: 0.2 },
      },
    ],
  ])("%s", (_name, initialViewport, expected) => {
    const readInitialViewport = jest.fn(() => initialViewport);
    const { rerenderData } = renderGraphPane({
      canvas: { readInitialViewport },
    });
    rerenderData({ nodes: [] });

    expect(capturedReactFlowProps).toMatchObject(expected);
    if (!initialViewport.fitView) {
      expect(capturedReactFlowProps).not.toHaveProperty("fitView");
    }
    expect(readInitialViewport).toHaveBeenCalledTimes(1);
  });

  it("keeps React Flow's default viewport without an initial viewport", () => {
    renderGraphPane();

    expect(capturedReactFlowProps).not.toHaveProperty("defaultViewport");
    expect(capturedReactFlowProps).not.toHaveProperty("fitView");
  });

  it("keeps wheel gestures inside guarded node editors", () => {
    const onWheel = jest.fn();
    renderGraphPane({ onWheel });

    fireEvent.wheel(screen.getByTestId("guarded-wheel-content"), {
      ctrlKey: true,
      deltaX: 0,
      deltaY: 120,
    });

    expect(onWheel).not.toHaveBeenCalled();
  });

  it("lets ordinary canvas wheel gestures bubble", () => {
    const onWheel = jest.fn();
    renderGraphPane({ onWheel });

    fireEvent.wheel(screen.getByTestId("plain-wheel-target"), {
      deltaX: 0,
      deltaY: 120,
    });

    expect(onWheel).toHaveBeenCalledTimes(1);
  });

  it("scrolls guarded node editors with the mouse wheel", () => {
    const onWheel = jest.fn();
    renderGraphPane({ onWheel });

    const scrollContainer = screen.getByTestId("guarded-wheel-target");
    Object.defineProperties(scrollContainer, {
      clientHeight: { configurable: true, value: 80 },
      scrollHeight: { configurable: true, value: 240 },
    });
    scrollContainer.scrollTop = 0;

    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 72,
    });
    fireEvent(screen.getByTestId("guarded-wheel-content"), event);

    expect(scrollContainer.scrollTop).toBe(72);
    expect(event.defaultPrevented).toBe(true);
    expect(onWheel).not.toHaveBeenCalled();
  });

  it("scrolls the outer editor when the wheel starts inside a nested guard", () => {
    const onWheel = jest.fn();
    renderGraphPane({ onWheel });

    const outerScrollContainer = screen.getByTestId("guarded-wheel-target");
    const nestedGuard = screen.getByTestId("nested-guarded-wheel-target");
    Object.defineProperties(outerScrollContainer, {
      clientHeight: { configurable: true, value: 80 },
      scrollHeight: { configurable: true, value: 240 },
    });
    Object.defineProperties(nestedGuard, {
      clientHeight: { configurable: true, value: 80 },
      scrollHeight: { configurable: true, value: 80 },
    });
    outerScrollContainer.scrollTop = 0;

    fireEvent.wheel(screen.getByTestId("guarded-wheel-content"), {
      deltaX: 0,
      deltaY: 64,
    });

    expect(outerScrollContainer.scrollTop).toBe(64);
    expect(onWheel).not.toHaveBeenCalled();
  });

  it("shows the source label in the add-node menu", () => {
    renderGraphPane({ contextMenuSourceLabel: "Source: Any user reply" });

    expect(screen.getByText("Source: Any user reply")).toBeTruthy();
  });

  it("releases the native wheel guard when the canvas unmounts", () => {
    const { unmount } = renderGraphPane();
    const target = screen.getByTestId("guarded-wheel-content");
    const wrapper = screen.getByTestId("react-flow").parentElement!;
    const onWheel = jest.fn();
    wrapper.addEventListener("wheel", onWheel);

    fireEvent.wheel(target, { deltaY: 120 });
    expect(onWheel).not.toHaveBeenCalled();

    unmount();
    fireEvent.wheel(target, { deltaY: 120 });
    expect(onWheel).toHaveBeenCalledTimes(1);
    wrapper.removeEventListener("wheel", onWheel);
  });

  it("keeps onboarding callouts attached to matching nodes and links to this workspace's integrations", () => {
    renderGraphPane({
      data: {
        nodes: [createGraphTestNode("trigger", { kind: "trigger" })],
      },
      canvas: { showDemoCallouts: true, showNoSourcePrompt: true },
    });

    expect(
      screen.getByText("scenarioOnboardingCalloutTriggerTitle")
    ).toBeTruthy();
    expect(
      screen.queryByText("scenarioOnboardingCalloutActionTitle")
    ).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "scenarioOnboardingConnectSource" })
        .getAttribute("href")
    ).toBe("/panel/w/workspace-1/settings/integrations");
  });

  it("defers onboarding and empty-canvas actions while the graph loads", () => {
    renderGraphPane({
      canvas: {
        loadingFlow: true,
        showDemoCallouts: true,
        showNoSourcePrompt: true,
      },
    });

    expect(screen.queryByTestId("react-flow")).toBeNull();
    expect(screen.queryByTestId("scenario-canvas-empty-state")).toBeNull();
    expect(
      screen.queryByRole("link", { name: "scenarioOnboardingConnectSource" })
    ).toBeNull();
  });

  it("closes the add-node menu with Escape through the canvas controller", () => {
    const closeContextMenu = jest.fn();
    renderGraphPane({
      contextMenuSourceLabel: "Source: Any user reply",
      closeContextMenu,
    });

    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });

    expect(closeContextMenu).toHaveBeenCalledTimes(1);
  });

  it("shows empty-canvas helper copy when the graph has no nodes", () => {
    renderGraphPane();

    expect(screen.getByTestId("scenario-canvas-empty-state")).toBeTruthy();
    expect(screen.getByText("canvasEmptyTitle")).toBeTruthy();
    expect(screen.getByText("canvasEmptyHint")).toBeTruthy();
    expect(screen.getByText("canvasEmptyHintSecondary")).toBeTruthy();
    expect(
      screen.getByTestId("scenario-canvas-empty-cta-trigger")
    ).toBeTruthy();
    expect(screen.getByTestId("scenario-canvas-empty-cta-bulk")).toBeTruthy();
  });

  it("adds a root block from empty-canvas CTAs", () => {
    const addEmptyCanvasRootNode = jest.fn();
    renderGraphPane({ addEmptyCanvasRootNode });

    fireEvent.click(screen.getByTestId("scenario-canvas-empty-cta-trigger"));
    fireEvent.click(screen.getByTestId("scenario-canvas-empty-cta-bulk"));

    expect(addEmptyCanvasRootNode).toHaveBeenCalledWith("trigger");
    expect(addEmptyCanvasRootNode).toHaveBeenCalledWith("bulk");
  });

  it("hides empty-canvas helper when nodes exist", () => {
    renderGraphPane({
      data: {
        nodes: [
          {
            id: "trigger-1",
            position: { x: 0, y: 0 },
            data: {
              kind: "trigger",
              triggerConfig: {
                enabled: true,
                messageMatchMode: "any",
                keywordMatchMode: "contains",
              },
            },
          },
        ],
      },
    });

    expect(screen.queryByTestId("scenario-canvas-empty-state")).toBeNull();
  });

  it("exposes keyboard-accessible zoom and fit controls", () => {
    renderGraphPane();
    fireEvent.click(screen.getByRole("button", { name: "canvasZoomIn" }));
    fireEvent.click(screen.getByRole("button", { name: "canvasZoomOut" }));
    fireEvent.click(screen.getByRole("button", { name: "canvasFitView" }));
    expect(mockZoomIn).toHaveBeenCalled();
    expect(mockZoomOut).toHaveBeenCalled();
    expect(mockFitView).toHaveBeenCalledWith(
      expect.objectContaining({ minZoom: 0.1 })
    );
    expect(screen.getByText("70%")).toBeTruthy();
  });

  it("keeps saved arrows and labels above selected cards without drawing hover connector previews", () => {
    renderGraphPane();

    const canvas = document.createElement("div");
    canvas.className = "scenario-graph-flow";
    canvas.innerHTML = `
      <div class="react-flow__edges"></div>
      <div class="react-flow__nodes">
        <div class="react-flow__node selected dragging" style="z-index: 1000"></div>
      </div>
      <div class="react-flow__edgelabel-renderer"></div>
    `;
    document.body.appendChild(canvas);
    const layer = (selector: string) =>
      Number(getComputedStyle(canvas.querySelector(selector)!).zIndex);

    expect(layer(".react-flow__edges")).toBeGreaterThan(
      layer(".react-flow__nodes")
    );
    expect(layer(".react-flow__edgelabel-renderer")).toBeGreaterThan(
      layer(".react-flow__edges")
    );
    canvas.remove();

    const cssText = Array.from(document.querySelectorAll("style"))
      .map(style => style.textContent ?? "")
      .join("\n");

    expect(cssText).toContain(".scenario-graph-flow .react-flow__edges");
    expect(cssText).toContain("translate: none");
    expect(cssText).toContain("--translate: translate(50%, -50%)");
    expect(cssText).not.toContain(
      "scenario-source-handle-button--connector::after"
    );
    expect(cssText).not.toContain(
      ":has(.scenario-source-handle-button--connector:hover)"
    );
  });

  it("projects eligible legacy routing without mutating the persisted graph", () => {
    const nodes = [
      {
        id: "action-1",
        position: { x: 0, y: 0 },
        data: { kind: "action", actionType: "reply" },
      },
      {
        id: "condition-1",
        position: { x: 240, y: 0 },
        data: {
          kind: "logic",
          logicType: "post_action_condition",
          conditionBranches: [{ id: "reply", type: "user_replied" }],
        },
      },
      {
        id: "target-1",
        position: { x: 480, y: 0 },
        data: { kind: "action", actionType: "reply" },
      },
    ];
    const edges = [
      { id: "input", source: "action-1", target: "condition-1" },
      {
        id: "reply",
        source: "condition-1",
        sourceHandle: getPostActionConditionHandleId("user_replied"),
        target: "target-1",
      },
    ];

    renderGraphPane({
      data: { nodes, edges },
    });

    expect(
      (capturedReactFlowProps?.nodes as Array<{ id: string }>).map(
        node => node.id
      )
    ).toEqual(["action-1", "target-1"]);
    expect(capturedReactFlowProps?.edges).toEqual([
      expect.objectContaining({
        id: "reply",
        source: "action-1",
        sourceHandle: ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
        target: "target-1",
      }),
    ]);
    expect(nodes.map(node => node.id)).toEqual([
      "action-1",
      "condition-1",
      "target-1",
    ]);
    expect(edges[1]?.source).toBe("condition-1");
  });
});

describe("ScenariosGraphPane node settings panel flag", () => {
  const trigger = createGraphTestNode("trigger", { kind: "trigger" });
  const link = createGraphTestNode("link", {
    kind: "scenario_link",
    linkedScenarioId: "renewal",
    linkedScenarioName: "Renewal follow-up",
  });
  const panel = (id: string) =>
    document.querySelector<HTMLElement>(`[data-panel-id="${id}"]`)!;
  const resizeGroup = (container: HTMLElement, width: number) => {
    const group = container.querySelector("[data-panel-group]")!;
    jest
      .spyOn(group, "getBoundingClientRect")
      .mockReturnValue({ width } as DOMRect);
    act(() => mockResizeObservers.get(group)!());
  };

  beforeEach(() => {
    capturedReactFlowProps = null;
    mockResizablePanelProps.clear();
    mockResizeObservers.clear();
  });

  it("keeps the single canvas panel and the trigger sheet while the flag is off", () => {
    renderGraphPane({
      panelGroup: true,
      data: { nodes: [trigger], selectedNodeId: "trigger" },
      nodeCallbacks: {
        selectNodeById: jest.fn(),
        updateTriggerConfigById: jest.fn(),
      },
    });
    expect([...mockResizablePanelProps.keys()]).toEqual(["scenario-canvas"]);
    expect(mockResizablePanelProps.get("scenario-canvas")).toMatchObject({
      order: 2,
      defaultSize: 72,
      minSize: 45,
    });
    expect(screen.queryByRole("separator", { hidden: true })).toBeNull();
    expect(
      screen.getByRole("dialog", { name: "triggerEditorTitle" })
    ).toBeInTheDocument();
    expect(
      document.querySelector("[data-scenario-node-settings-panel]")
    ).toBeNull();
    expect(capturedReactFlowProps?.onSelectionStart).toBeUndefined();
    // The group is not measured for a panel that is not there.
    expect(mockResizeObservers.size).toBe(0);
  });

  it("mounts the collapsible settings panel after the canvas and uses a sheet on narrow groups", () => {
    renderGraphPane({
      data: { nodes: [trigger], selectedNodeId: "trigger" },
      resources: { nodeSettingsPanelEnabled: true },
      nodeCallbacks: {
        selectNodeById: jest.fn(),
        updateTriggerConfigById: jest.fn(),
      },
    });
    expect([...mockResizablePanelProps.keys()]).toEqual([
      "scenario-canvas",
      "scenario-node-settings",
    ]);
    expect(mockResizablePanelProps.get("scenario-canvas")).toMatchObject({
      order: 2,
      minSize: 45,
    });
    expect(mockResizablePanelProps.get("scenario-node-settings")).toMatchObject(
      { order: 3, collapsible: true, collapsedSize: 0, defaultSize: 0 }
    );
    // The modal sheet hides the rest of the page, including the handle.
    const handle = screen.getByRole("separator", { hidden: true });
    expect(handle).toHaveAttribute("aria-label", "nodeSettingsResize");
    expect(handle).toHaveAttribute("data-disabled", "true");
    const settings = screen.getByRole("dialog");
    expect(settings).toHaveAttribute(
      "data-scenario-node-settings-panel",
      "trigger"
    );
    expect(panel("scenario-node-settings").contains(settings)).toBe(false);
    expect(
      screen.queryByRole("dialog", { name: "triggerEditorTitle" })
    ).toBeNull();
    expect(screen.queryByTestId("node-settings-reveal")).toBeNull();
  });

  it("docks the settings beside the canvas once the group is wide enough", () => {
    const { container } = renderGraphPane({
      panelGroup: true,
      data: { nodes: [link], selectedNodeId: "link" },
      resources: {
        nodeSettingsPanelEnabled: true,
        scenarioLinkOptions: [{ id: "renewal", name: "Renewal follow-up" }],
      },
      nodeCallbacks: { selectNodeById: jest.fn(), updateNodeById: jest.fn() },
    });
    resizeGroup(container, 1440);
    const layout = resolveScenarioNodeSettingsLayout(1440);
    const settings = within(panel("scenario-node-settings")).getByRole(
      "dialog"
    );
    expect(settings).toHaveAttribute(
      "data-scenario-node-settings-panel",
      "link"
    );
    expect(
      screen.getByRole("separator", { name: "nodeSettingsResize" })
    ).toHaveAttribute("data-disabled", "false");
    expect(screen.getByTestId("node-settings-reveal")).toHaveAttribute(
      "data-node-id",
      "link"
    );
    expect(mockResizablePanelProps.get("scenario-canvas")?.minSize).toBe(
      layout.canvasMinSize
    );
    expect(mockResizablePanelProps.get("scenario-node-settings")).toMatchObject(
      { minSize: layout.settingsMinSize, maxSize: layout.settingsMaxSize }
    );
    expect(panel("scenario-canvas").contains(settings)).toBe(false);
  });

  it("closes node settings when a marquee selection starts", () => {
    const selectNodeById = jest.fn();
    renderGraphPane({
      data: { nodes: [trigger], selectedNodeId: "trigger" },
      resources: { nodeSettingsPanelEnabled: true },
      nodeCallbacks: { selectNodeById, updateTriggerConfigById: jest.fn() },
    });
    act(() => (capturedReactFlowProps!.onSelectionStart as () => void)());
    expect(selectNodeById).toHaveBeenCalledWith(null);
  });

  it.each([
    [
      "a reply",
      { kind: "action", actionType: "reply", actionReplyMode: "ai" },
      "presetActionReply",
    ],
    [
      "a handoff",
      { kind: "action", actionType: "assign_human" },
      "presetActionAssignHuman",
    ],
    [
      "a Generative AI action",
      {
        kind: "action",
        actionType: "generative_ai",
        actionGenerativeAIConfig: {
          version: 1,
          mode: "text_to_video",
          prompt: "A launch clip",
        },
      },
      "generativeAITitleVideo",
    ],
    [
      "a WhatsApp service message",
      {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: { kind: "text", body: { mode: "fixed", text: "Hello" } },
        },
      },
      "whatsappServiceFormatText",
    ],
    [
      "a WhatsApp template",
      { kind: "action", actionType: "whatsapp_template" },
      "whatsappActionKindTemplate",
    ],
    [
      "a Telegram reply",
      {
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "telegram",
        actionTelegramQuickReplies: [[{ text: "Yes", payload: "yes" }]],
      },
      "presetActionTelegramBuilder",
    ],
    [
      "an Instagram reply",
      { kind: "action", actionType: "reply", actionReplyChannel: "instagram" },
      "presetActionInstagramReply",
    ],
  ] as const)("opens action settings for %s", (_label, data, title) => {
    renderGraphPane({
      data: {
        nodes: [createGraphTestNode("selected", data as ScenarioNodeData)],
        selectedNodeId: "selected",
      },
      resources: { nodeSettingsPanelEnabled: true },
      nodeCallbacks: { selectNodeById: jest.fn(), updateNodeById: jest.fn() },
    });
    const settings = screen.getByRole("dialog", { name: title });
    expect(settings).toHaveAttribute(
      "data-scenario-node-settings-panel",
      "selected"
    );
    expect(
      within(settings).getByTestId("action-node-settings")
    ).toBeInTheDocument();
    expect(screen.getByTestId("react-flow").contains(settings)).toBe(false);
  });

  it.each([
    [
      "End scenario",
      createGraphTestNode("selected", {
        kind: "action",
        actionType: "end_scenario",
      }),
      {},
    ],
    [
      "a WhatsApp QR trigger",
      createGraphTestNode("selected", {
        kind: "trigger",
        triggerConfig: { entryPointType: "whatsapp_qr" },
      }),
      {},
    ],
    [
      "a trigger while the graph loads",
      createGraphTestNode("selected", { kind: "trigger" }),
      { loadingFlow: true },
    ],
  ])("opens no settings for %s", (_label, node, canvas) => {
    renderGraphPane({
      data: { nodes: [node], selectedNodeId: "selected" },
      resources: { nodeSettingsPanelEnabled: true },
      nodeCallbacks: {
        selectNodeById: jest.fn(),
        updateTriggerConfigById: jest.fn(),
      },
      canvas,
    });
    expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
    expect(mockResizablePanelProps.has("scenario-node-settings")).toBe(true);
  });
});
