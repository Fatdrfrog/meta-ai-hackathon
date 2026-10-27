/** @jest-environment jsdom */

/**
 * Typing-focus regression harness for inline action editors.
 *
 * Production report: on a 25-node scenario, several action fields lose focus
 * after every keystroke while the card stays open. These tests type 20
 * characters and require the same element to keep focus, in two hosts:
 * - `enrichment`: the real enrichment provider and display projection render
 *   node components directly, with a stateful graph behind the real node
 *   callbacks and branch sync;
 * - `canvas`: the real flow, graph and node controllers wired to the real
 *   ScenariosGraphPane and React Flow, as the workspace controller wires them,
 *   in both pan and select interaction modes.
 */

import "@testing-library/jest-dom";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactFlowProvider } from "@xyflow/react";
import { TextEncoder } from "node:util";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ResizablePanelGroup } from "@/components/ui/resizable";
import {
  fetchScenarioById,
  updateScenarioRequest,
} from "@/lib/scenarios/client";
import type {
  ScenarioAudienceOptions,
  ScenarioDocument,
  ScenarioFlowEdge,
  ScenarioFlowNode,
  ScenarioNodeData,
  ScenarioSummary,
} from "../../types";
import { DEFAULT_SCENARIO_VIEWPORT } from "../../types";
import { scenarioEditorChunks } from "../../scenario-editor-chunks";
import { transitionBranchNodes } from "../../view/graph/branch-sync";
import type { ScenarioGraphEditor } from "../../view/graph/controller-utils";
import { ScenarioGraphResourcesProvider } from "../../view/graph/resources-context";
import type { ScenarioActionEditorNodeData } from "../../view/node-enrichment/types";
import {
  ScenarioNodeEnrichmentProvider,
  type HandleBranchSyncForNode,
  type ScenarioDisplayNodeCallbacks,
  type ScenarioNodeEnrichmentBridge,
  type ScenarioNodeEnrichmentResources,
} from "../../view/scenario-node-enrichment-context";
import type { ScenarioCanvasInteractionMode } from "../../view/scenario-canvas-interaction-mode";
import { ScenariosGraphPane } from "../../view/scenarios-graph-pane";
import { useScenarioDisplayNodes } from "../../view/use-scenario-display-nodes";
import { useScenarioFlowController } from "../../view/use-scenario-flow-controller";
import { useScenarioGraphController } from "../../view/use-scenario-graph-controller";
import { useScenarioNodeCallbacks } from "../../view/use-scenario-node-callbacks";
import { ActionNode } from "./index";
import { installResizeObserver } from "@/test-support/dom-test-utils";

Object.defineProperty(globalThis, "TextEncoder", {
  configurable: true,
  value: TextEncoder,
});

const mockTranslate = Object.assign(
  (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  {
    rich: (key: string) => key,
    markup: (key: string) => key,
    raw: (key: string) => key,
    has: () => true,
  }
);

jest.mock("next-intl", () => ({
  useFormatter: () => ({
    number: (value: number, options: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat("en", options).format(value),
  }),
  useLocale: () => "en",
  useTranslations: () => mockTranslate,
}));
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn(), warning: jest.fn() },
}));
jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
jest.mock("@/lib/scenarios/client", () => {
  const { ScenarioRequestError } = jest.requireActual(
    "@/lib/scenarios/client/http"
  );
  return {
    ScenarioRequestError,
    convertLegacyActionRoutingRequest: jest.fn(),
    fetchScenarioById: jest.fn(),
    retryScenarioTimerReplanRecoveryRequest: jest.fn(),
    submitGeneratedScenarioTemplateRequest: jest.fn(),
    updateScenarioRequest: jest.fn(),
  };
});
jest.mock("@/lib/whatsapp/flows/client", () => ({
  attachWhatsAppFlowProviderReference: jest.fn(),
  provisionWhatsAppFlow: jest.fn(),
}));
// Bulk roots are not part of these graphs; their live-status module needs a
// browser TextEncoder at import time.
jest.mock("../bulk-root-node", () => ({ BulkRootNode: () => null }));
// The template creation drawer is lazy and closed in these tests.
jest.mock("@/components/whatsapp-templates/template-form-drawer", () => ({
  TemplateFormDrawer: () => null,
}));
// react-resizable-panels ships ESM only; the pane only needs a container.
jest.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children?: React.ReactNode }) => (
    <div data-panel-group>{children}</div>
  ),
  ResizablePanel: ({ children }: { children?: React.ReactNode }) => (
    <div data-panel>{children}</div>
  ),
  ResizableHandle: () => <div role="separator" />,
}));
jest.mock(
  "../../builders/whatsapp/service-message/service-message-resources",
  () => ({
    ...jest.requireActual(
      "../../builders/whatsapp/service-message/service-message-resources"
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

const mockFetchScenarioById = fetchScenarioById as jest.MockedFunction<
  typeof fetchScenarioById
>;
const mockUpdateScenarioRequest = updateScenarioRequest as jest.MockedFunction<
  typeof updateScenarioRequest
>;

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SCENARIO_ID = "scenario-1";
const EDITED_NODE_ID = "edited-action";
const TYPED_TEXT = "abcdefghijklmnopqrst";

const AUDIENCE_OPTIONS: ScenarioAudienceOptions = {
  channels: ["whatsapp"],
  classificationCategories: [],
  funnelStages: [],
  internalLabels: [],
  customers: [],
  metaReferralAds: [],
  metaReferralAdSets: [],
  metaReferralCampaigns: [],
  metaCampaignLabels: [],
};
const SCENARIO_SUMMARY: ScenarioSummary = {
  _id: SCENARIO_ID,
  name: "Scenario 1",
  description: "",
  status: "draft",
  mode: "conversation",
  timezone: null,
  priority: 0,
  matchingRole: "default",
  entryPolicy: "repeatable",
  nodeCount: 0,
  edgeCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as ScenarioSummary;
const SCENARIO_SETTINGS = { validationMode: "draft" as const };
const GRAPH_RESOURCES = {
  whatsAppTemplatesLoading: false,
  whatsAppTemplatesRefreshing: false,
  hasLoadedWhatsAppTemplates: true,
  whatsAppFlowsLoading: false,
  whatsAppFlowsRefreshing: false,
  contextItemsLoading: false,
};

class MockDOMMatrixReadOnly {
  m22 = 1;
  constructor(_transform?: string) {}
}

type GraphState = { nodes: ScenarioFlowNode[]; edges: ScenarioFlowEdge[] };
type HostKind = "enrichment" | "canvas-pan" | "canvas-select";

/** The committed graph, published after each render for assertions. */
const graphProbe: { current: GraphState } = {
  current: { nodes: [], edges: [] },
};
function usePublishGraph(nodes: ScenarioFlowNode[], edges: ScenarioFlowEdge[]) {
  useEffect(() => {
    graphProbe.current = { nodes, edges };
  }, [edges, nodes]);
}
const noop = () => {};

function useScenarioResources(
  nodeSettingsPanelEnabled = false
): ScenarioNodeEnrichmentResources {
  return useMemo(
    () => ({
      activeScenarioId: SCENARIO_ID,
      audienceOptions: AUDIENCE_OPTIONS,
      contextItemsByOptionId: {},
      contextOptions: [],
      isCreatingSnippet: false,
      t: mockTranslate,
      whatsAppFlows: [],
      whatsAppTemplates: [],
      workspaceId: WORKSPACE_ID,
      connectedActionSources: ["whatsapp"],
      managedWhatsAppFlowProvisioningSources: [],
      sourceCapabilities: {
        hasWhatsApp: true,
        hasWhatsAppCoexistence: false,
        hasMetaAds: false,
      },
      nodeSettingsPanelEnabled,
    }),
    [nodeSettingsPanelEnabled]
  );
}

function useNodeBridge({
  nodeCallbacks,
  handleBranchSyncForNodeRef,
  openNodePickerFromHandle = noop,
  scenarioSessionOwnerKey = "session-1",
}: {
  nodeCallbacks: ScenarioDisplayNodeCallbacks;
  handleBranchSyncForNodeRef: ScenarioNodeEnrichmentBridge["handleBranchSyncForNodeRef"];
  openNodePickerFromHandle?: ScenarioNodeEnrichmentBridge["openNodePickerFromHandle"];
  scenarioSessionOwnerKey?: string;
}) {
  const selectExistingFlowForNodeRef = useRef(async () => {});
  return useMemo<ScenarioNodeEnrichmentBridge>(
    () => ({
      nodeCallbacks,
      adoptGeneratedBulkServerUpdate: () => false,
      prepareScenarioBulkSend: async () => null,
      adoptScenarioActivation: () => false,
      onScenarioActivationBlocked: () => {},
      reconcileGeneratedJobServerUpdate: async () => ({ status: "no_op" }),
      prepareGeneratedJobRefresh: async () => true,
      submitGeneratedTemplateForNode: async () => true,
      submittingGeneratedTemplateNodeId: null,
      loadWhatsAppTemplateForm: async () => ({ status: "skipped" }),
      loadingTemplateFormNodeIds: new Set(),
      publishManagedWhatsAppFlow: async () => null,
      scenarioSessionOwnerKey,
      publishingManagedFlowNodeId: null,
      selectExistingFlowForNodeRef,
      handleBranchSyncForNodeRef,
      openNodePickerFromHandle,
    }),
    [
      handleBranchSyncForNodeRef,
      nodeCallbacks,
      openNodePickerFromHandle,
      scenarioSessionOwnerKey,
    ]
  );
}

function useDisplayCallbacks(
  callbacks: ReturnType<typeof useScenarioNodeCallbacks>,
  selectNodeById: ScenarioDisplayNodeCallbacks["selectNodeById"]
) {
  return useMemo<ScenarioDisplayNodeCallbacks>(
    () => ({
      ...callbacks,
      selectNodeById,
      loadContextItems: async () => {},
      loadWhatsAppTemplates: async () => {},
      loadWhatsAppFlows: async () => {},
      openLinkedWhatsAppFlowPreview: noop,
    }),
    [callbacks, selectNodeById]
  );
}

function DirectDisplayNodes({ nodes }: { nodes: ScenarioFlowNode[] }) {
  const displayNodes = useScenarioDisplayNodes(nodes);
  return (
    <>
      {displayNodes.map(node =>
        node.type === "actionNode" ? (
          <div key={node.id} className="react-flow__node" data-id={node.id}>
            <ActionNode
              id={node.id}
              type="actionNode"
              data={node.data as ScenarioActionEditorNodeData}
              selected={false}
              dragging={false}
              zIndex={0}
              isConnectable
              selectable
              deletable
              draggable
              positionAbsoluteX={0}
              positionAbsoluteY={0}
            />
          </div>
        ) : null
      )}
    </>
  );
}

/** Enrichment and editors without React Flow's renderer or store updates. */
function EnrichmentHost({ initial }: { initial: GraphState }) {
  const graphRef = useRef(initial);
  const [graph, setGraph] = useState(initial);
  const [selected, setSelected] = useState<string | null>(EDITED_NODE_ID);
  usePublishGraph(graph.nodes, graph.edges);
  const graphEditor = useMemo<ScenarioGraphEditor>(
    () => ({
      read: () => graphRef.current,
      edit: transition => {
        const current = graphRef.current;
        const next = transition(current);
        if (
          !next ||
          (next.nodes === current.nodes && next.edges === current.edges)
        ) {
          return false;
        }
        graphRef.current = { nodes: next.nodes, edges: next.edges };
        setGraph(graphRef.current);
        return true;
      },
    }),
    []
  );
  const callbacks = useScenarioNodeCallbacks({
    workspaceId: WORKSPACE_ID,
    graphEditor,
    setSelectedNodeId: setSelected,
    contextOptions: [],
    whatsAppTemplates: [],
    loadContextItems: async () => {},
    t: mockTranslate,
  });
  const nodeCallbacks = useDisplayCallbacks(callbacks, setSelected);
  // The same transition as the graph controller's branch sync command.
  const handleBranchSyncForNode = useCallback<HandleBranchSyncForNode>(
    (actionNodeId, descriptorOrDescriptors, actionNodePatch) => {
      graphEditor.edit(({ nodes, edges }) => {
        const transition = transitionBranchNodes({
          actionNodeId,
          nodes,
          edges,
          descriptors: Array.isArray(descriptorOrDescriptors)
            ? descriptorOrDescriptors
            : [descriptorOrDescriptors],
          actionNodePatch,
        });
        if (!transition.changed) return null;
        return {
          nodes: transition.nodes,
          edges: transition.edges,
          history: transition.structuralHistoryRequired ? "record" : "skip",
        };
      });
    },
    [graphEditor]
  );
  const handleBranchSyncForNodeRef = useRef(handleBranchSyncForNode);
  const nodeBridge = useNodeBridge({
    nodeCallbacks,
    handleBranchSyncForNodeRef,
  });
  const resources = useScenarioResources();
  const providerGraph = useMemo(
    () => ({ ...graph, selectedNodeId: selected }),
    [graph, selected]
  );
  return (
    <ReactFlowProvider>
      <ScenarioGraphResourcesProvider value={GRAPH_RESOURCES}>
        <ScenarioNodeEnrichmentProvider
          graph={providerGraph}
          resources={resources}
          nodeBridge={nodeBridge}
          scenarioSettings={SCENARIO_SETTINGS}
        >
          <DirectDisplayNodes nodes={graph.nodes} />
        </ScenarioNodeEnrichmentProvider>
      </ScenarioGraphResourcesProvider>
    </ReactFlowProvider>
  );
}

/**
 * The real document, graph and node controllers composed the way
 * useScenariosWorkspaceController composes them for ScenariosGraphPane.
 */
function CanvasHost({
  interactionMode,
  nodeSettingsPanelEnabled = false,
}: {
  interactionMode: ScenarioCanvasInteractionMode;
  nodeSettingsPanelEnabled?: boolean;
}) {
  const [, setScenarios] = useState<ScenarioSummary[]>([SCENARIO_SUMMARY]);
  const flow = useScenarioFlowController({
    workspaceId: WORKSPACE_ID,
    activeScenarioId: SCENARIO_ID,
    activeScenario: SCENARIO_SUMMARY,
    activeScenarioName: SCENARIO_SUMMARY.name,
    activeScenarioDescription: "",
    activeScenarioStatus: "draft",
    entryPriorityInput: "0",
    setEntryPriorityInput: noop,
    setScenarios,
    onScenarioDocumentConfirmed: noop,
    t: mockTranslate,
  });
  usePublishGraph(flow.nodes, flow.edges);
  const flowWrapperRef = useRef<HTMLDivElement>(null);
  const graph = useScenarioGraphController({
    flowWrapperRef,
    screenToFlowPosition: flow.screenToFlowPosition,
    graphEditor: flow.graphEditor,
    nodes: flow.nodes,
    edges: flow.edges,
    setSelectedNodeId: flow.setSelectedNodeId,
    whatsAppTemplates: [],
    connectedActionSources: ["whatsapp"],
    t: mockTranslate,
  });
  const callbacks = useScenarioNodeCallbacks({
    workspaceId: WORKSPACE_ID,
    graphEditor: flow.graphEditor,
    setSelectedNodeId: flow.setSelectedNodeId,
    contextOptions: [],
    whatsAppTemplates: [],
    loadContextItems: async () => {},
    t: mockTranslate,
  });
  const nodeCallbacks = useDisplayCallbacks(callbacks, flow.setSelectedNodeId);
  const nodeBridge = useNodeBridge({
    nodeCallbacks,
    handleBranchSyncForNodeRef: graph.handleBranchSyncForNodeRef,
    openNodePickerFromHandle: graph.openNodePickerFromHandle,
    scenarioSessionOwnerKey: flow.scenarioSessionOwnerKey,
  });
  const resources = useScenarioResources(nodeSettingsPanelEnabled);
  const { loadingFlow, setSelectedNodeId } = flow;
  useEffect(() => {
    if (!loadingFlow) setSelectedNodeId(EDITED_NODE_ID);
  }, [loadingFlow, setSelectedNodeId]);

  const { onCanvasNodeClick, clearCanvasSelection } = flow;
  const { handleNodeClick, handlePaneClick } = graph;
  const handleCanvasNodeClick = useCallback(
    (
      event: Parameters<typeof handleNodeClick>[0],
      node: Parameters<typeof handleNodeClick>[1]
    ) => {
      onCanvasNodeClick(event, node);
      handleNodeClick(event, node);
    },
    [handleNodeClick, onCanvasNodeClick]
  );
  const handleCanvasPaneClick = useCallback(() => {
    clearCanvasSelection();
    handlePaneClick();
  }, [clearCanvasSelection, handlePaneClick]);
  const canvas = useMemo(
    () => ({
      canvasSelection: flow.canvasSelection,
      flowWrapperRef,
      loadingFlow: flow.loadingFlow,
      setReactFlowInstance: flow.setReactFlowInstance,
      scenarioGraphResources: GRAPH_RESOURCES,
      interactionMode,
      helperLines: { horizontal: null, vertical: null },
      contextMenu: graph.contextMenu,
      closeContextMenu: graph.closeContextMenu,
      contextMenuSections: [],
      addNodeFromPaletteItem: graph.addNodeFromPaletteItem,
      addEmptyCanvasRootNode: graph.addEmptyCanvasRootNode,
      onNodesChange: flow.onNodesChange,
      onEdgesChange: flow.onEdgesChange,
      onConnect: graph.onConnect,
      isValidConnection: graph.isValidConnection,
      onConnectStart: graph.onConnectStart,
      onConnectEnd: graph.onConnectEnd,
      onSelectionChange: flow.onCanvasSelectionChange,
      onEdgeClick: flow.onCanvasEdgeClick,
      onBeforeDelete: flow.onBeforeCanvasDelete,
      onNodeDrag: noop,
      onNodeDragStop: noop,
      onNodeClick: handleCanvasNodeClick,
      onPaneClick: handleCanvasPaneClick,
      onPaneContextMenu: graph.handlePaneContextMenu,
      onPaneMouseDown: noop,
      onPaneMouseUp: noop,
      onViewportChange: flow.onViewportChange,
    }),
    [
      flow.canvasSelection,
      flow.loadingFlow,
      flow.setReactFlowInstance,
      flow.onNodesChange,
      flow.onEdgesChange,
      flow.onCanvasSelectionChange,
      flow.onCanvasEdgeClick,
      flow.onBeforeCanvasDelete,
      flow.onViewportChange,
      graph.contextMenu,
      graph.closeContextMenu,
      graph.addNodeFromPaletteItem,
      graph.addEmptyCanvasRootNode,
      graph.onConnect,
      graph.isValidConnection,
      graph.onConnectStart,
      graph.onConnectEnd,
      graph.handlePaneContextMenu,
      handleCanvasNodeClick,
      handleCanvasPaneClick,
      interactionMode,
    ]
  );
  const data = useMemo(
    () => ({
      nodes: flow.nodes,
      edges: flow.edges,
      selectedNodeId: flow.selectedNodeId,
      linkedConditionParentCountByNodeId:
        flow.linkedConditionParentCountByNodeId,
    }),
    [
      flow.edges,
      flow.linkedConditionParentCountByNodeId,
      flow.nodes,
      flow.selectedNodeId,
    ]
  );
  return (
    <ResizablePanelGroup direction="horizontal">
      <ScenariosGraphPane
        canvas={canvas}
        data={data}
        resources={resources}
        nodeBridge={nodeBridge}
        scenarioSettings={SCENARIO_SETTINGS}
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
    </ResizablePanelGroup>
  );
}

function scenarioDocument(graph: GraphState): ScenarioDocument {
  return {
    ...SCENARIO_SUMMARY,
    presetId: null,
    presetVersion: null,
    segmentKey: null,
    linkedParentScenarioIds: [],
    nodes: graph.nodes,
    edges: graph.edges,
    viewport: DEFAULT_SCENARIO_VIEWPORT,
  } as unknown as ScenarioDocument;
}

async function renderHost(
  host: HostKind,
  initial: GraphState,
  { nodeSettingsPanelEnabled = false } = {}
) {
  if (host === "enrichment") {
    render(<EnrichmentHost initial={initial} />);
    return;
  }
  mockFetchScenarioById.mockResolvedValue({
    scenario: scenarioDocument(initial),
    metadata: { linkedConditionParentCountByNodeId: {} },
  } as Awaited<ReturnType<typeof fetchScenarioById>>);
  mockUpdateScenarioRequest.mockImplementation(async request =>
    scenarioDocument({
      nodes: request.nodes as ScenarioFlowNode[],
      edges: request.edges as ScenarioFlowEdge[],
    })
  );
  render(
    <CanvasHost
      interactionMode={host === "canvas-pan" ? "pan" : "select"}
      nodeSettingsPanelEnabled={nodeSettingsPanelEnabled}
    />
  );
  await waitFor(() =>
    expect(graphProbe.current.nodes.map(node => node.id)).toContain(
      EDITED_NODE_ID
    )
  );
}

function editedNodeData(): ScenarioNodeData {
  const node = graphProbe.current.nodes.find(
    item => item.id === EDITED_NODE_ID
  );
  if (!node) throw new Error("Edited node disappeared from the graph");
  return node.data;
}

/**
 * The variable name is edited in a popover opened from its chip. Found by its
 * label because React Flow keeps unmeasured nodes visibility-hidden.
 */
async function openPromptInputRename(container: HTMLElement = document.body) {
  await userEvent
    .setup()
    .click(
      await within(container).findByLabelText(
        "whatsappServicePromptInputsRename"
      )
    );
}

async function typeWithStableFocus(element: HTMLElement) {
  const user = userEvent.setup();
  await user.click(element);
  expect(element).toHaveFocus();
  for (const character of TYPED_TEXT) {
    await user.keyboard(character);
    expect(element.isConnected).toBe(true);
    expect(document.activeElement).toBe(element);
  }
}

function actionNode(
  id: string,
  data: Omit<ScenarioNodeData, "kind">,
  index: number
): ScenarioFlowNode {
  return {
    id,
    type: "actionNode",
    position: {
      x: 40 + (index % 5) * 420,
      y: 40 + Math.floor(index / 5) * 360,
    },
    data: { kind: "action", ...data },
  };
}

function graphWith(
  data: Omit<ScenarioNodeData, "kind">,
  fillerCount: number
): GraphState {
  return {
    nodes: [
      actionNode(EDITED_NODE_ID, data, 0),
      ...Array.from({ length: fillerCount }, (_, index) =>
        actionNode(
          `filler-${index}`,
          { actionType: "reply", actionReplyMode: "ai" },
          index + 1
        )
      ),
    ],
    edges: [],
  };
}

const SERVICE_MESSAGE_DATA: Omit<ScenarioNodeData, "kind"> = {
  actionType: "reply",
  actionWhatsAppServiceMessage: {
    version: 1,
    message: {
      kind: "text",
      body: { mode: "fixed", text: "Your medal is ready" },
    },
    promptInputs: [{ key: "", label: "", prompt: "" }],
  },
};
const TEMPLATE_DATA: Omit<ScenarioNodeData, "kind"> = {
  actionType: "whatsapp_template",
  actionWhatsAppTemplateName: "order_update",
  actionWhatsAppTemplateLanguage: "en",
  actionWhatsAppTemplateComponents: [
    { type: "BODY", text: "Hello {{1}}, your order is ready." },
  ],
  actionWhatsAppTemplateBindings: { version: 1, parameters: {} },
};
const GENERATIVE_DATA: Omit<ScenarioNodeData, "kind"> = {
  actionType: "generative_ai",
  actionGenerativeAIConfig: {
    version: 1,
    mode: "text_to_video",
    prompt: "",
  },
};

const HOSTS: HostKind[] = ["enrichment", "canvas-pan", "canvas-select"];
// Below 8 actions every card renders its full editor; from 8 actions an action
// expands only while it is the selected node.
const GRAPH_SIZES = [
  { label: "fewer than 8 actions", fillerCount: 2 },
  { label: "8 or more actions", fillerCount: 24 },
];

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
  ]);
});

describe("inline action editors keep focus while typing", () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalDOMMatrix = (globalThis as { DOMMatrixReadOnly?: unknown })
    .DOMMatrixReadOnly;
  const originalFetch = globalThis.fetch;
  const elementPrototype = Element.prototype as Element & {
    hasPointerCapture?: unknown;
    setPointerCapture?: unknown;
    releasePointerCapture?: unknown;
  };
  const rangePrototype = Range.prototype as Range & {
    getClientRects?: unknown;
    getBoundingClientRect?: unknown;
  };
  const originalElementMethods = {
    hasPointerCapture: elementPrototype.hasPointerCapture,
    setPointerCapture: elementPrototype.setPointerCapture,
    releasePointerCapture: elementPrototype.releasePointerCapture,
    scrollIntoView: HTMLElement.prototype.scrollIntoView,
  };
  const originalRangeMethods = {
    getClientRects: rangePrototype.getClientRects,
    getBoundingClientRect: rangePrototype.getBoundingClientRect,
  };
  const offsetDescriptors = {
    offsetWidth: Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetWidth"
    ),
    offsetHeight: Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetHeight"
    ),
  };

  beforeAll(() => {
    // jsdom has no layout: size only React Flow's renderer so the canvas
    // renders without warning 004, and leave cards unmeasured.
    for (const [property, size] of [
      ["offsetWidth", 1440],
      ["offsetHeight", 900],
    ] as const) {
      Object.defineProperty(HTMLElement.prototype, property, {
        configurable: true,
        get(this: HTMLElement) {
          return this.classList.contains("react-flow__renderer") ? size : 0;
        },
      });
    }
    installResizeObserver();
    Object.defineProperty(globalThis, "DOMMatrixReadOnly", {
      configurable: true,
      writable: true,
      value: MockDOMMatrixReadOnly,
    });
    globalThis.fetch = jest.fn(async () => {
      throw new Error("Network is unavailable in this harness");
    }) as typeof fetch;
    // Radix Select and ProseMirror use layout APIs that jsdom omits.
    elementPrototype.hasPointerCapture = () => false;
    elementPrototype.setPointerCapture = noop;
    elementPrototype.releasePointerCapture = noop;
    HTMLElement.prototype.scrollIntoView = noop;
    const emptyRect = () => new DOMRect(0, 0, 0, 0);
    rangePrototype.getBoundingClientRect = emptyRect;
    rangePrototype.getClientRects = () =>
      Object.assign([emptyRect()], { item: () => emptyRect() });
  });
  afterAll(() => {
    for (const [property, descriptor] of Object.entries(offsetDescriptors)) {
      if (descriptor) {
        Object.defineProperty(HTMLElement.prototype, property, descriptor);
      }
    }
    globalThis.ResizeObserver = originalResizeObserver;
    Object.defineProperty(globalThis, "DOMMatrixReadOnly", {
      configurable: true,
      writable: true,
      value: originalDOMMatrix,
    });
    globalThis.fetch = originalFetch;
    Object.assign(elementPrototype, {
      hasPointerCapture: originalElementMethods.hasPointerCapture,
      setPointerCapture: originalElementMethods.setPointerCapture,
      releasePointerCapture: originalElementMethods.releasePointerCapture,
    });
    HTMLElement.prototype.scrollIntoView =
      originalElementMethods.scrollIntoView;
    Object.assign(rangePrototype, originalRangeMethods);
  });
  beforeEach(() => {
    graphProbe.current = { nodes: [], edges: [] };
    mockFetchScenarioById.mockReset();
    mockUpdateScenarioRequest.mockReset();
  });

  describe.each(GRAPH_SIZES)("with $label", ({ fillerCount }) => {
    it.each(HOSTS)(
      "service-message prompt input key and question (%s host)",
      async host => {
        await renderHost(host, graphWith(SERVICE_MESSAGE_DATA, fillerCount));
        await openPromptInputRename();
        const key = await screen.findByLabelText(
          "whatsappServicePromptInputsKey 1"
        );
        await typeWithStableFocus(key);
        const question = screen.getByLabelText(
          "whatsappServicePromptInputsQuestion 1"
        );
        await typeWithStableFocus(question);
        expect(
          editedNodeData().actionWhatsAppServiceMessage?.promptInputs
        ).toEqual([{ key: TYPED_TEXT, label: "", prompt: TYPED_TEXT }]);
      },
      60_000
    );

    it.each(HOSTS)(
      "template binding literal value (%s host)",
      async host => {
        await renderHost(host, graphWith(TEMPLATE_DATA, fillerCount));
        const user = userEvent.setup();
        await user.click(
          await screen.findByTestId(/^template-binding-source-/)
        );
        await user.click(
          await screen.findByRole("option", {
            name: "whatsappTemplateBindingLiteral",
          })
        );
        const input = await screen.findByTestId(/^template-binding-value-/);
        await typeWithStableFocus(input);
        const bindings = editedNodeData().actionWhatsAppTemplateBindings;
        expect(Object.values(bindings?.parameters ?? {})).toEqual([
          { source: "literal", value: TYPED_TEXT },
        ]);
      },
      60_000
    );

    it.each(HOSTS)(
      "generative AI prompt (%s host)",
      async host => {
        await renderHost(host, graphWith(GENERATIVE_DATA, fillerCount));
        const prompt = await screen.findByLabelText("generativeAIPromptLabel");
        await typeWithStableFocus(prompt);
        expect(editedNodeData().actionGenerativeAIConfig?.prompt).toBe(
          TYPED_TEXT
        );
      },
      60_000
    );
  });

  it.each(HOSTS)(
    "fixed-reply rich editor keeps its editable element (%s host)",
    async host => {
      await renderHost(
        host,
        graphWith(
          {
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "",
          },
          24
        )
      );
      const editor = await waitFor(() => {
        const element = document.querySelector<HTMLElement>(
          `[data-id="${EDITED_NODE_ID}"] [contenteditable="true"]`
        );
        if (!element) throw new Error("Fixed-reply editor is not mounted");
        return element;
      });
      await act(async () => {
        editor.focus();
      });
      const user = userEvent.setup();
      for (const character of TYPED_TEXT) {
        await user.keyboard(character);
        expect(editor.isConnected).toBe(true);
        expect(document.activeElement).toBe(editor);
      }
      expect(editedNodeData().actionReplyText).toBe(TYPED_TEXT);
    },
    60_000
  );

  describe("in the node settings panel", () => {
    const CANVAS_HOSTS = ["canvas-pan", "canvas-select"] as const;

    async function findSettingsPanel() {
      const panel = await screen.findByRole("dialog");
      expect(panel).toHaveAttribute(
        "data-scenario-node-settings-panel",
        EDITED_NODE_ID
      );
      // The canvas shows the read-only card; the editors live in the panel.
      expect(
        document.querySelector(
          `.react-flow__node[data-id="${EDITED_NODE_ID}"] [data-testid="scenario-action-node-card"]`
        )
      ).not.toBeNull();
      return panel;
    }

    it.each(CANVAS_HOSTS)(
      "fixed-reply rich editor keeps its editable element (%s host)",
      async host => {
        await renderHost(
          host,
          graphWith(
            {
              actionType: "reply",
              actionReplyMode: "fixed",
              actionReplyText: "",
            },
            24
          ),
          { nodeSettingsPanelEnabled: true }
        );
        const panel = await findSettingsPanel();
        const editor = await waitFor(() => {
          const element = panel.querySelector<HTMLElement>(
            '[contenteditable="true"]'
          );
          if (!element) throw new Error("Fixed-reply editor is not mounted");
          return element;
        });
        await act(async () => {
          editor.focus();
        });
        const user = userEvent.setup();
        for (const character of TYPED_TEXT) {
          await user.keyboard(character);
          expect(editor.isConnected).toBe(true);
          expect(document.activeElement).toBe(editor);
        }
        expect(editedNodeData().actionReplyText).toBe(TYPED_TEXT);
      },
      60_000
    );

    it.each(CANVAS_HOSTS)(
      "generative AI prompt (%s host)",
      async host => {
        await renderHost(host, graphWith(GENERATIVE_DATA, 24), {
          nodeSettingsPanelEnabled: true,
        });
        const panel = await findSettingsPanel();
        await typeWithStableFocus(
          within(panel).getByLabelText("generativeAIPromptLabel")
        );
        expect(editedNodeData().actionGenerativeAIConfig?.prompt).toBe(
          TYPED_TEXT
        );
      },
      60_000
    );

    it.each(CANVAS_HOSTS)(
      "service-message prompt input key and question (%s host)",
      async host => {
        await renderHost(host, graphWith(SERVICE_MESSAGE_DATA, 24), {
          nodeSettingsPanelEnabled: true,
        });
        const panel = await findSettingsPanel();
        await openPromptInputRename(panel);
        // The popover renders outside the panel.
        await typeWithStableFocus(
          await screen.findByLabelText("whatsappServicePromptInputsKey 1")
        );
        await typeWithStableFocus(
          within(panel).getByLabelText("whatsappServicePromptInputsQuestion 1")
        );
        expect(
          editedNodeData().actionWhatsAppServiceMessage?.promptInputs
        ).toEqual([{ key: TYPED_TEXT, label: "", prompt: TYPED_TEXT }]);
      },
      60_000
    );

    it.each(CANVAS_HOSTS)(
      "template binding literal value (%s host)",
      async host => {
        await renderHost(host, graphWith(TEMPLATE_DATA, 24), {
          nodeSettingsPanelEnabled: true,
        });
        const panel = await findSettingsPanel();
        const user = userEvent.setup();
        await user.click(
          await within(panel).findByTestId(/^template-binding-source-/)
        );
        await user.click(
          await screen.findByRole("option", {
            name: "whatsappTemplateBindingLiteral",
          })
        );
        await typeWithStableFocus(
          await within(panel).findByTestId(/^template-binding-value-/)
        );
        const bindings = editedNodeData().actionWhatsAppTemplateBindings;
        expect(Object.values(bindings?.parameters ?? {})).toEqual([
          { source: "literal", value: TYPED_TEXT },
        ]);
      },
      60_000
    );
  });
});
