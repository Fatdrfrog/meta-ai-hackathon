"use client";

import type { ScenarioCanvasSelection } from "./graph/controller-utils";
import {
  projectLegacyActionRoutingForDisplay,
  type LegacyActionRoutingGraph,
} from "@/lib/scenarios/legacy-action-routing";
import { ResizablePanel } from "@/components/ui/resizable";
import {
  Background,
  ReactFlow,
  SelectionMode,
  useReactFlow,
  type IsValidConnection,
  type NodeMouseHandler,
  type NodeTypes,
  type OnBeforeDelete,
  type OnConnect,
  type OnConnectEnd,
  type OnConnectStart,
  type OnEdgesChange,
  type OnError,
  type OnNodeDrag,
  type OnNodesChange,
  type AriaLabelConfig,
  type OnSelectionChangeFunc,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  useCallback,
  useMemo,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { ImperativePanelHandle } from "react-resizable-panels";
import { ActionNode } from "../nodes/action-node";
import { LazyBulkRootNode } from "../nodes/lazy-bulk-root-node";
import { ScenarioLinkNode } from "../nodes/link-node";
import { ScenarioNode } from "../nodes/scenario-node";
import { TriggerNode } from "../nodes/trigger-node";
import {
  type ScenarioEmptyCanvasRootKind,
  type ScenarioNodePaletteItem,
} from "../graph/node-palette";
import type { ScenarioFlowEdge, ScenarioFlowNode } from "../types";
import {
  ScenarioGraphResourcesProvider,
  type ScenarioGraphResourcesState,
} from "./graph/resources-context";
import { HelperLinesRenderer } from "./helper-lines";
import type { ScenarioCanvasInteractionMode } from "./scenario-canvas-interaction-mode";
import {
  ScenarioNodeEnrichmentProvider,
  type ScenarioNodeEnrichmentBridge,
  type ScenarioNodeEnrichmentGraphState,
  type ScenarioNodeEnrichmentResources,
  type ScenarioNodeEnrichmentScenarioSettings,
} from "./scenario-node-enrichment-context";
import { LazyScenarioNodePaletteMenu } from "./palette/lazy-scenario-node-palette-menu";
import type { ScenarioNodePaletteMenuSection } from "./palette/scenario-node-palette-menu";
import { supportsScenarioNodeSettings } from "./node-settings/scenario-node-settings-content";
import {
  resolveScenarioNodeSettingsLayout,
  SCENARIO_CANVAS_MIN_SIZE_PERCENT,
  ScenarioNodeSettingsPanel,
} from "./node-settings/scenario-node-settings-panel";
import { ScenarioNodeSettingsReveal } from "./node-settings/scenario-node-settings-reveal";
import { useResizablePanelGroupWidth } from "./node-settings/use-resizable-panel-group-width";
import { LazyScenarioTriggerLogPanel } from "./lazy-scenario-trigger-log-panel";
import { ScenarioCanvasEditorsGate } from "./scenario-canvas-editors-gate";
import type { ScenarioTriggerLogPanel } from "./scenario-trigger-log-panel";
import { ScenarioTriggerEditorPanel } from "./scenario-trigger-editor-panel";
import { ScenarioFlowLoadingState } from "./scenarios-view-shell";
import { useScenarioDisplayNodes } from "./use-scenario-display-nodes";
import {
  createScenarioCanvasNodeCache,
  projectScenarioCanvasNodes,
} from "./graph/canvas-nodes";
import {
  createScenarioCanvasEdgeCache,
  projectScenarioCanvasEdges,
} from "./graph/canvas-edges";
import { projectScenarioReturnEdges } from "./graph/return-edges";
import { ScenarioReturnEdge } from "./graph/scenario-return-edge";
import {
  getScenarioRouteKey,
  projectScenarioBranchVisibility,
} from "./graph/branch-visibility";
import { ScenarioCanvasControls } from "./graph/scenario-canvas-controls";
import { useScenarioCanvasWheelGuard } from "./graph/use-scenario-canvas-wheel-guard";
import {
  ScenarioConnectionLine,
  ScenarioGraphStaticStyles,
} from "./graph/scenario-canvas-layers";
import {
  ScenarioDemoCallouts,
  ScenarioNoSourcePrompt,
  ScenarioCanvasEmptyState,
} from "./graph/scenario-canvas-onboarding";
import type { ScenarioGraphContextMenuState } from "./use-scenario-graph-controller";

const nodeTypes: NodeTypes = {
  bulkNode: LazyBulkRootNode,
  scenarioNode: ScenarioNode,
  triggerNode: TriggerNode,
  actionNode: ActionNode,
  scenarioLinkNode: ScenarioLinkNode,
};
const edgeTypes = { scenarioReturn: ScenarioReturnEdge };

const REACT_FLOW_SNAP_GRID: [number, number] = [20, 20];
const REACT_FLOW_PRO_OPTIONS = { hideAttribution: true };
const SCENARIO_GRAPH_CONNECTION_DRAG_THRESHOLD = 3;
const SCENARIO_GRAPH_NODE_DRAG_THRESHOLD = 2;
// React Flow's default of 0 drops a node click whose pointer moves at all
// between press and release (trackpads, sensitive mice), so the card never
// opens its settings. Well under the 20px snap grid.
const SCENARIO_GRAPH_NODE_CLICK_DISTANCE = 6;
// Deletion is handled by the workspace keyboard shortcut controller so edge
// deletes never compete with React Flow's built-in node cascade behavior.
const SCENARIO_GRAPH_DELETE_KEY_CODES = null;
const EMPTY_HIGHLIGHT_IDS: readonly string[] = [];
/**
 * Above this many nodes React Flow draws only the nodes in view. Below it
 * every node stays mounted: panning then moves the canvas without mounting
 * nodes again (and re-running their editors' setup), and each frame skips
 * the visibility pass over every node and edge. Real scenarios stay far
 * below it; very large graphs keep the culling.
 */
const SCENARIO_CANVAS_CULLING_MIN_NODES = 100;

function ScenarioGraphFocus({ nodeId }: { nodeId?: string | null }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!nodeId) return;
    const frame = requestAnimationFrame(() => {
      void fitView({
        nodes: [{ id: nodeId }],
        padding: 0.4,
        maxZoom: 1,
        duration: 200,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [fitView, nodeId]);
  return null;
}

function ScenarioGraphCanvas({
  children,
  nodes,
  selectedNodeIds,
  highlightedNodeIds,
}: {
  children: (
    displayNodes: ReturnType<typeof useScenarioDisplayNodes>
  ) => ReactNode;
  nodes: ScenarioFlowNode[];
  selectedNodeIds: ReadonlySet<string>;
  highlightedNodeIds: ReadonlySet<string>;
}) {
  const displayNodes = useScenarioDisplayNodes(nodes);
  const [canvasNodeCache] = useState(createScenarioCanvasNodeCache);
  const canvasNodes = useMemo(
    () =>
      projectScenarioCanvasNodes(
        displayNodes,
        selectedNodeIds,
        highlightedNodeIds,
        canvasNodeCache
      ),
    [canvasNodeCache, displayNodes, selectedNodeIds, highlightedNodeIds]
  );
  return children(canvasNodes);
}

/** Where React Flow opens: read once, when it mounts. */
type ScenarioCanvasInitialViewport = {
  /** The session or saved viewport; null keeps React Flow's default. */
  viewport: Viewport | null;
  /** Fit the graph as soon as its nodes are measured. */
  fitView: boolean;
};

const SCENARIO_INITIAL_FIT_VIEW_OPTIONS = { padding: 0.2 };

/**
 * React Flow props that place the first frame where the canvas settles, so
 * it does not start at the default viewport and move there afterwards.
 */
function useScenarioInitialViewportProps(
  readInitialViewport: ScenariosGraphPaneCanvas["readInitialViewport"]
) {
  const [initial] = useState(() => readInitialViewport?.() ?? null);
  return {
    ...(initial?.viewport ? { defaultViewport: initial.viewport } : {}),
    ...(initial?.fitView
      ? { fitView: true, fitViewOptions: SCENARIO_INITIAL_FIT_VIEW_OPTIONS }
      : {}),
  };
}

const handleScenarioReactFlowError: OnError = (id, message) => {
  if (process.env.NODE_ENV === "production") return;

  // eslint-disable-next-line no-console
  console.warn(`[scenarios/react-flow:${id}] ${message}`);
};

function ScenarioGraphLoadedSurface({
  canvas,
  t,
  workspaceId,
  displayNodes,
  visibleNodes,
  highlightedNodes,
  canvasEdges,
  isSelectionMode,
  contextRouteKey,
  collapsedRoutes,
  setCollapsedState,
  revealContextRoute,
  activeScenarioId,
  onSelectionStart,
  revealNodeId = null,
}: {
  canvas: ScenariosGraphPaneCanvas;
  t: ScenarioNodeEnrichmentResources["t"];
  workspaceId: string;
  displayNodes: ScenarioFlowNode[];
  visibleNodes: ScenarioFlowNode[];
  highlightedNodes: ReadonlySet<string>;
  canvasEdges: ScenarioFlowEdge[];
  isSelectionMode: boolean;
  contextRouteKey: string | null;
  collapsedRoutes: ReadonlySet<string>;
  setCollapsedState: (state: {
    scenarioId: string | null;
    routes: ReadonlySet<string>;
  }) => void;
  revealContextRoute: () => void;
  activeScenarioId: string | null;
  /** Starting a marquee selection closes node settings. */
  onSelectionStart?: () => void;
  /** Node whose docked settings just opened; keep its card in view. */
  revealNodeId?: string | null;
}) {
  const {
    canvasSelection,
    setReactFlowInstance,
    helperLines,
    contextMenu,
    closeContextMenu,
    contextMenuSourceLabel,
    contextMenuSections,
    contextMenuRoute,
    connectContextMenuToNode,
    disconnectContextMenuRoute,
    autoLayoutEnabled,
    setAutoLayoutEnabled,
    focusedNodeId,
    addNodeFromPaletteItem,
    addEmptyCanvasRootNode,
    onNodesChange,
    onEdgesChange,
    onConnect,
    isValidConnection,
    onConnectStart,
    onConnectEnd,
    onBeforeDelete,
    onSelectionChange,
    onEdgeClick,
    onNodeDrag,
    onNodeDragStop,
    onNodeClick,
    onPaneClick,
    onPaneContextMenu,
    onViewportChange,
    readInitialViewport,
    showDemoCallouts = false,
    showNoSourcePrompt = false,
  } = canvas;
  const initialViewportProps =
    useScenarioInitialViewportProps(readInitialViewport);
  const handleMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => onViewportChange(viewport),
    [onViewportChange]
  );
  const ariaLabelConfig = useMemo<Partial<AriaLabelConfig>>(
    () => ({
      "handle.ariaLabel": t("canvasHandle"),
      "node.a11yDescription.default": t("canvasNodeA11yDescription"),
      "node.a11yDescription.keyboardDisabled": t(
        "canvasNodeA11yDescriptionWithKeys"
      ),
      "edge.a11yDescription.default": t("canvasEdgeA11yDescription"),
    }),
    [t]
  );
  return (
    <>
      <ScenarioGraphCanvas
        nodes={visibleNodes}
        selectedNodeIds={canvasSelection.nodeIds}
        highlightedNodeIds={highlightedNodes}
      >
        {typedNodes => (
          <ReactFlow
            className={`scenario-graph-flow ${
              isSelectionMode
                ? "scenario-graph-flow--select"
                : "scenario-graph-flow--pan"
            }`}
            nodes={typedNodes}
            edges={canvasEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            onError={handleScenarioReactFlowError}
            onBeforeDelete={onBeforeDelete}
            onSelectionChange={onSelectionChange}
            onEdgeClick={onEdgeClick}
            edgesFocusable
            edgesReconnectable={false}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            onSelectionStart={onSelectionStart}
            onPaneContextMenu={onPaneContextMenu}
            onMoveEnd={handleMoveEnd}
            onInit={setReactFlowInstance}
            {...initialViewportProps}
            deleteKeyCode={SCENARIO_GRAPH_DELETE_KEY_CODES}
            connectionLineComponent={ScenarioConnectionLine}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            elevateNodesOnSelect
            autoPanOnNodeFocus
            autoPanOnSelection={isSelectionMode}
            ariaLabelConfig={ariaLabelConfig}
            nodeDragThreshold={SCENARIO_GRAPH_NODE_DRAG_THRESHOLD}
            nodeClickDistance={SCENARIO_GRAPH_NODE_CLICK_DISTANCE}
            connectionDragThreshold={SCENARIO_GRAPH_CONNECTION_DRAG_THRESHOLD}
            minZoom={0.1}
            maxZoom={1.6}
            panActivationKeyCode="Space"
            panOnDrag={isSelectionMode ? [1] : true}
            panOnScroll={isSelectionMode}
            selectionOnDrag={isSelectionMode}
            selectionMode={SelectionMode.Partial}
            zoomOnScroll={!isSelectionMode}
            onlyRenderVisibleElements={
              visibleNodes.length > SCENARIO_CANVAS_CULLING_MIN_NODES
            }
            snapToGrid
            snapGrid={REACT_FLOW_SNAP_GRID}
            proOptions={REACT_FLOW_PRO_OPTIONS}
          >
            <HelperLinesRenderer
              horizontal={helperLines.horizontal}
              vertical={helperLines.vertical}
            />
            {showDemoCallouts ? (
              <ScenarioDemoCallouts nodes={displayNodes} t={t} />
            ) : null}
            <Background gap={20} size={1} />
            <ScenarioCanvasControls
              autoLayoutEnabled={autoLayoutEnabled}
              onAutoLayoutChange={setAutoLayoutEnabled}
            />
            <ScenarioGraphFocus nodeId={focusedNodeId} />
            {revealNodeId ? (
              <ScenarioNodeSettingsReveal nodeId={revealNodeId} />
            ) : null}
          </ReactFlow>
        )}
      </ScenarioGraphCanvas>
      {showNoSourcePrompt ? (
        <ScenarioNoSourcePrompt
          href={`/panel/w/${workspaceId}/settings/integrations`}
          label={t("scenarioOnboardingConnectSource")}
        />
      ) : null}
      {displayNodes.length === 0 ? (
        <ScenarioCanvasEmptyState
          title={t("canvasEmptyTitle")}
          body={t("canvasEmptyHint")}
          secondary={t("canvasEmptyHintSecondary")}
          triggerLabel={t("startTriggerSection")}
          triggerHint={t("canvasEmptyCtaTriggerHint")}
          bulkLabel={t("presetBulkCampaign")}
          bulkHint={t("canvasEmptyCtaBulkHint")}
          onAddRoot={addEmptyCanvasRootNode}
        />
      ) : null}
      <ScenarioGraphStaticStyles />
      <LazyScenarioNodePaletteMenu
        contextMenu={contextMenu}
        title={t(
          contextMenuRoute
            ? contextMenuRoute.currentDestinationId
              ? "routeChangeDestination"
              : "routeChooseNextStep"
            : "addBlock"
        )}
        sourceLabel={contextMenuSourceLabel}
        searchPlaceholder={t(
          contextMenuRoute ? "routeSearchSteps" : "addBlockSearchPlaceholder"
        )}
        emptyLabel={t(
          contextMenuRoute ? "routeNoMatchingSteps" : "addBlockSearchNoResults"
        )}
        route={
          contextMenuRoute &&
          connectContextMenuToNode &&
          disconnectContextMenuRoute
            ? {
                ...contextMenuRoute,
                onSelect: nodeId => {
                  revealContextRoute();
                  connectContextMenuToNode(nodeId);
                },
                onDisconnect: () => {
                  revealContextRoute();
                  disconnectContextMenuRoute();
                },
                onEnd: () => {
                  revealContextRoute();
                  void addNodeFromPaletteItem({
                    id: "action-end-scenario",
                    kind: "action",
                    defaults: { actionType: "end_scenario" },
                  });
                },
                newMessageLabel: t("routeNewMessage"),
                existingStepLabel: t("routeExistingStep"),
                endLabel: t("routeEnd"),
                disconnectLabel: t("routeDisconnect"),
                branchLabel: t(
                  contextRouteKey && collapsedRoutes.has(contextRouteKey)
                    ? "routeExpandBranch"
                    : "routeCollapseBranch"
                ),
                branchCollapsed: Boolean(
                  contextRouteKey && collapsedRoutes.has(contextRouteKey)
                ),
                onToggleBranch: contextRouteKey
                  ? () => {
                      const next = new Set(collapsedRoutes);
                      if (next.has(contextRouteKey))
                        next.delete(contextRouteKey);
                      else next.add(contextRouteKey);
                      setCollapsedState({
                        scenarioId: activeScenarioId,
                        routes: next,
                      });
                      closeContextMenu();
                    }
                  : undefined,
              }
            : null
        }
        sections={contextMenuSections}
        onClose={closeContextMenu}
        onAddNodeFromPaletteItem={item => {
          revealContextRoute();
          void addNodeFromPaletteItem(item);
        }}
      />
    </>
  );
}

type ScenariosGraphPaneCanvas = {
  canvasSelection: ScenarioCanvasSelection;
  flowWrapperRef: RefObject<HTMLDivElement | null>;
  loadingFlow: boolean;
  setReactFlowInstance: (
    instance: ReactFlowInstance<ScenarioFlowNode, ScenarioFlowEdge>
  ) => void;
  scenarioGraphResources: ScenarioGraphResourcesState;
  interactionMode: ScenarioCanvasInteractionMode;
  helperLines: { horizontal: number | null; vertical: number | null };
  contextMenu: ScenarioGraphContextMenuState | null;
  closeContextMenu: () => void;
  contextMenuSourceLabel?: string | null;
  contextMenuSections: ScenarioNodePaletteMenuSection[];
  contextMenuRoute?: {
    currentDestinationId: string | null;
    destinations: readonly { nodeId: string; label: string }[];
  } | null;
  connectContextMenuToNode?: (nodeId: string) => void;
  disconnectContextMenuRoute?: () => void;
  autoLayoutEnabled?: boolean;
  setAutoLayoutEnabled?: (enabled: boolean) => void;
  highlightedNodeIds?: readonly string[];
  highlightedEdgeIds?: readonly string[];
  focusedNodeId?: string | null;
  addNodeFromPaletteItem: (
    item: ScenarioNodePaletteItem
  ) => void | Promise<void>;
  addEmptyCanvasRootNode: (kind: ScenarioEmptyCanvasRootKind) => void;
  onNodesChange: OnNodesChange<ScenarioFlowNode>;
  onEdgesChange: OnEdgesChange<ScenarioFlowEdge>;
  onConnect: OnConnect;
  isValidConnection: IsValidConnection<ScenarioFlowEdge>;
  onConnectStart: OnConnectStart;
  onConnectEnd: OnConnectEnd;
  onBeforeDelete: OnBeforeDelete<ScenarioFlowNode, ScenarioFlowEdge>;
  onSelectionChange: OnSelectionChangeFunc<ScenarioFlowNode, ScenarioFlowEdge>;
  onEdgeClick: (
    event: MouseEvent | ReactMouseEvent<Element, MouseEvent>,
    edge: ScenarioFlowEdge
  ) => void;
  onNodeDrag: OnNodeDrag<ScenarioFlowNode>;
  onNodeDragStop: OnNodeDrag<ScenarioFlowNode>;
  onNodeClick: NodeMouseHandler<ScenarioFlowNode>;
  onPaneClick: (
    event: MouseEvent | ReactMouseEvent<Element, MouseEvent>
  ) => void;
  onPaneContextMenu: (
    event: MouseEvent | ReactMouseEvent<Element, MouseEvent>
  ) => void;
  onPaneMouseDown: (event: ReactMouseEvent<Element, MouseEvent>) => void;
  onPaneMouseUp: (event: ReactMouseEvent<Element, MouseEvent>) => void;
  onViewportChange: (viewport: Viewport) => void;
  /**
   * Where React Flow opens, read when it mounts. Without it the canvas
   * starts at React Flow's default viewport.
   */
  readInitialViewport?: () => ScenarioCanvasInitialViewport;
  showDemoCallouts?: boolean;
  showNoSourcePrompt?: boolean;
};

type ScenariosGraphPaneTriggerLog = {
  showTriggerLogPanel: boolean;
  triggerLogs: ComponentProps<typeof ScenarioTriggerLogPanel>["logs"];
  triggerLogsHasMore: boolean;
  loadingTriggerLogs: boolean;
  loadTriggerLogs: () => void | Promise<void>;
  loadMoreTriggerLogs: () => void | Promise<void>;
  setShowTriggerLogPanel: (visible: boolean) => void;
  onOpenPreview?: () => void;
};

type ScenariosGraphPaneProps = {
  canvas: ScenariosGraphPaneCanvas;
  data: ScenarioNodeEnrichmentGraphState;
  resources: ScenarioNodeEnrichmentResources;
  nodeBridge: ScenarioNodeEnrichmentBridge;
  scenarioSettings: ScenarioNodeEnrichmentScenarioSettings;
  triggerLog: ScenariosGraphPaneTriggerLog;
};

export function ScenariosGraphPane({
  canvas,
  data,
  resources,
  nodeBridge,
  scenarioSettings,
  triggerLog,
}: ScenariosGraphPaneProps) {
  const { linkedConditionParentCountByNodeId, nodes, selectedNodeId, edges } =
    data;
  const { t, workspaceId } = resources;
  const {
    flowWrapperRef,
    canvasSelection,
    loadingFlow,
    scenarioGraphResources,
    interactionMode,
    contextMenu,
    highlightedNodeIds = EMPTY_HIGHLIGHT_IDS,
    highlightedEdgeIds = EMPTY_HIGHLIGHT_IDS,
    focusedNodeId,
    onPaneMouseDown,
    onPaneMouseUp,
  } = canvas;
  const {
    showTriggerLogPanel,
    triggerLogs,
    triggerLogsHasMore,
    loadingTriggerLogs,
    loadTriggerLogs,
    loadMoreTriggerLogs,
    setShowTriggerLogPanel,
    onOpenPreview,
  } = triggerLog;
  const isSelectionMode = interactionMode === "select";
  const [collapsedState, setCollapsedState] = useState<{
    scenarioId: string | null;
    routes: ReadonlySet<string>;
  }>({ scenarioId: null, routes: new Set() });
  const collapsedRoutes = useMemo(
    () =>
      collapsedState.scenarioId === resources.activeScenarioId
        ? collapsedState.routes
        : new Set<string>(),
    [collapsedState, resources.activeScenarioId]
  );
  const highlightedNodes = useMemo(
    () => new Set(highlightedNodeIds),
    [highlightedNodeIds]
  );
  const highlightedEdges = useMemo(
    () => new Set(highlightedEdgeIds),
    [highlightedEdgeIds]
  );
  const displayGraph = useMemo(
    () =>
      projectLegacyActionRoutingForDisplay({
        nodes,
        edges,
      } as LegacyActionRoutingGraph),
    [edges, nodes]
  );
  const displayNodes = displayGraph.nodes as ScenarioFlowNode[];
  const displayEdges = displayGraph.edges as ScenarioFlowEdge[];
  const visibleGraph = useMemo(
    () =>
      projectScenarioBranchVisibility({
        nodes: displayNodes,
        edges: displayEdges,
        collapsedRoutes,
        focusedNodeId,
      }),
    [displayNodes, displayEdges, collapsedRoutes, focusedNodeId]
  );
  const contextRouteKey = contextMenu?.connectFromNodeId
    ? getScenarioRouteKey(
        contextMenu.connectFromNodeId,
        contextMenu.connectFromSourceHandle
      )
    : null;
  const revealContextRoute = () => {
    if (!contextRouteKey || !collapsedRoutes.has(contextRouteKey)) return;
    const routes = new Set(collapsedRoutes);
    routes.delete(contextRouteKey);
    setCollapsedState({
      scenarioId: resources.activeScenarioId ?? null,
      routes,
    });
  };
  const [canvasEdgeCache] = useState(createScenarioCanvasEdgeCache);
  const canvasEdges = useMemo(
    () =>
      projectScenarioCanvasEdges(
        projectScenarioReturnEdges(visibleGraph.nodes, visibleGraph.edges),
        canvasSelection.edgeIds,
        highlightedEdges,
        canvasEdgeCache
      ),
    [canvasEdgeCache, canvasSelection.edgeIds, visibleGraph, highlightedEdges]
  );
  const providerGraph = useMemo<ScenarioNodeEnrichmentGraphState>(
    () => ({
      nodes: displayNodes,
      edges: displayEdges,
      selectedNodeId,
      legacyRoutingByActionId: displayGraph.legacyRoutingByActionId,
      linkedConditionParentCountByNodeId,
    }),
    [
      displayEdges,
      displayGraph.legacyRoutingByActionId,
      displayNodes,
      linkedConditionParentCountByNodeId,
      selectedNodeId,
    ]
  );
  useScenarioCanvasWheelGuard(flowWrapperRef);
  const nodeSettingsEnabled = resources.nodeSettingsPanelEnabled === true;
  const canvasPanelRef = useRef<ImperativePanelHandle>(null);
  const groupWidth = useResizablePanelGroupWidth(
    flowWrapperRef,
    nodeSettingsEnabled
  );
  const nodeSettingsLayout = useMemo(
    () => resolveScenarioNodeSettingsLayout(groupWidth),
    [groupWidth]
  );
  const nodeSettingsNodeId = useMemo(() => {
    if (!nodeSettingsEnabled || loadingFlow || !selectedNodeId) return null;
    return supportsScenarioNodeSettings(
      displayNodes.find(node => node.id === selectedNodeId)
    )
      ? selectedNodeId
      : null;
  }, [displayNodes, loadingFlow, nodeSettingsEnabled, selectedNodeId]);
  const { selectNodeById } = nodeBridge.nodeCallbacks;
  const closeNodeSettings = useCallback(
    () => selectNodeById(null),
    [selectNodeById]
  );

  return (
    <ScenarioGraphResourcesProvider value={scenarioGraphResources}>
      <ScenarioNodeEnrichmentProvider
        graph={providerGraph}
        resources={resources}
        nodeBridge={nodeBridge}
        scenarioSettings={scenarioSettings}
      >
        <ResizablePanel
          ref={canvasPanelRef}
          id="scenario-canvas"
          order={2}
          defaultSize={72}
          minSize={
            nodeSettingsEnabled
              ? nodeSettingsLayout.canvasMinSize
              : SCENARIO_CANVAS_MIN_SIZE_PERCENT
          }
          className="min-h-0 overflow-hidden"
        >
          <div className="flex h-full min-w-0 flex-1 flex-col">
            {!loadingFlow && !nodeSettingsEnabled ? (
              <ScenarioTriggerEditorPanel nodes={displayNodes} />
            ) : null}
            <div
              ref={flowWrapperRef}
              role="presentation"
              className="relative min-h-0 flex-1"
              onMouseDown={onPaneMouseDown}
              onMouseUp={onPaneMouseUp}
            >
              <ScenarioCanvasEditorsGate
                loading={loadingFlow}
                scenarioKey={resources.activeScenarioId ?? ""}
                nodes={displayNodes}
                fallback={
                  <ScenarioFlowLoadingState label={t("loadingGraph")} />
                }
              >
                <ScenarioGraphLoadedSurface
                  canvas={canvas}
                  t={t}
                  workspaceId={workspaceId}
                  displayNodes={displayNodes}
                  visibleNodes={visibleGraph.nodes}
                  highlightedNodes={highlightedNodes}
                  canvasEdges={canvasEdges}
                  isSelectionMode={isSelectionMode}
                  contextRouteKey={contextRouteKey}
                  collapsedRoutes={collapsedRoutes}
                  setCollapsedState={setCollapsedState}
                  revealContextRoute={revealContextRoute}
                  activeScenarioId={resources.activeScenarioId ?? null}
                  onSelectionStart={
                    nodeSettingsEnabled ? closeNodeSettings : undefined
                  }
                  revealNodeId={
                    nodeSettingsLayout.docked ? nodeSettingsNodeId : null
                  }
                />
              </ScenarioCanvasEditorsGate>
            </div>
            {showTriggerLogPanel ? (
              <div className="h-[260px]">
                <LazyScenarioTriggerLogPanel
                  logs={triggerLogs}
                  loading={loadingTriggerLogs}
                  hasMore={triggerLogsHasMore}
                  onRefresh={() => {
                    void loadTriggerLogs();
                  }}
                  onLoadMore={() => {
                    void loadMoreTriggerLogs();
                  }}
                  onOpenPreview={onOpenPreview}
                  previewLabel={t("previewDrawerOpen")}
                  onClose={() => setShowTriggerLogPanel(false)}
                  layout="bottom"
                />
              </div>
            ) : null}
          </div>
        </ResizablePanel>
        {nodeSettingsEnabled ? (
          <ScenarioNodeSettingsPanel
            nodes={displayNodes}
            nodeId={nodeSettingsNodeId}
            layout={nodeSettingsLayout}
            canvasPanelRef={canvasPanelRef}
          />
        ) : null}
      </ScenarioNodeEnrichmentProvider>
    </ScenarioGraphResourcesProvider>
  );
}
