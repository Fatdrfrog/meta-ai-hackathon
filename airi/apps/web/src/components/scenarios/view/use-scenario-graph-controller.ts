"use client";

import {
  addEdge,
  type Connection,
  type FinalConnectionState,
  type IsValidConnection,
  type OnConnectStartParams,
} from "@xyflow/react";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import { toast } from "sonner";
import { DEFAULT_SCENARIO_EDGE_STYLE } from "../graph/config";
import { createScenarioGraphId } from "../graph/id";
import {
  createNodeFromPaletteItem,
  SCENARIO_EMPTY_CANVAS_ROOT_PALETTE_IDS,
  SCENARIO_NODE_PALETTE,
  type ScenarioEmptyCanvasRootKind,
  type ScenarioNodePaletteItem,
} from "../graph/node-palette";
import type {
  ScenarioActionSourceId,
  ScenarioFlowEdge,
  ScenarioFlowNode,
  ScenarioNodeData,
  ScenarioWhatsAppTemplate,
} from "../types";
import {
  buildActionPatchForSelector,
  resolveDefaultReplyActionPatch,
  resolveWhatsAppTemplatePickMatch,
} from "./action/selector-utils";
import {
  collectKeptBranchRoutes,
  hasSameBranchBindingData,
  transitionBranchNodes,
  type BranchDescriptor,
  type BranchRoute,
  type BranchTransitionResult,
} from "./graph/branch-sync";
import {
  resolveScenarioConnectionPlan,
  removeScenarioSourceConnections,
  type ScenarioGraphEditor,
} from "./graph/controller-utils";
import { resolveScenarioActionTypeFromNodeData } from "@icecore/airi-runtime/scenario-action-semantics";
import { isWhatsAppTemplateFormSubmittedSourceHandleId } from "@icecore/scenario-contracts";
import { resolveScenarioDestinationLabel } from "../scenario-node-labels";
import type { BranchSyncOptions } from "./scenario-node-enrichment-context";
import { getWhatsAppTemplateFormSubmittedSourceHandleCopy } from "./scenario-source-handle-copy";
import {
  formatQuotedLabelList,
  resolveScenarioNodeDataWithLiveWhatsAppTemplate,
} from "./scenario-template-utils";
import { SCENARIO_UNDO_TOAST_DURATION_MS } from "./graph/undo-context";
import { useLatestRef } from "./use-latest-ref";
import { getReleaseClientPoint } from "./use-pane-drag-gesture";

export type ScenarioGraphContextMenuState = {
  left: number;
  top: number;
  flowX: number;
  flowY: number;
  connectFromNodeId?: string;
  connectFromSourceHandle?: string | null;
};

export type PendingConnectionRelease = {
  clientX: number;
  clientY: number;
  sourceNodeId: string;
  sourceHandleId: string | null;
};

type PendingConnectionSource = {
  sourceNodeId: string;
  sourceHandleId: string | null;
};

type PendingConnectionSourceState = PendingConnectionSource & {
  scenarioContextToken: ScenarioGraphEditor;
};

type ScenarioGraphContextMenuInternalState = ScenarioGraphContextMenuState & {
  scenarioContextToken: ScenarioGraphEditor;
};

type ScenarioFlowPosition = {
  x: number;
  y: number;
};

function isServiceMessageSource(node: ScenarioFlowNode | undefined) {
  return (
    node?.data.kind === "action" &&
    (node.data.actionWhatsAppServiceMessage !== undefined ||
      (node.data.actionType === "reply" &&
        node.data.actionReplyChannel === "whatsapp"))
  );
}

const REACT_FLOW_CONNECTION_TARGET_SELECTOR =
  ".react-flow__node, .react-flow__handle";

type UseScenarioGraphControllerParams = {
  flowWrapperRef: RefObject<HTMLDivElement | null>;
  screenToFlowPosition: (
    position: ScenarioFlowPosition
  ) => ScenarioFlowPosition | null;
  graphEditor: ScenarioGraphEditor;
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
  setSelectedNodeId: Dispatch<SetStateAction<string | null>>;
  whatsAppTemplates: ScenarioWhatsAppTemplate[];
  connectedActionSources?: readonly ScenarioActionSourceId[];
  /** Reverts the last recorded graph change, for Undo in toasts. */
  undoGraphChange?: () => boolean;
  t: (key: string, values?: Record<string, string | number | Date>) => string;
};

function isConnectionReleaseOverExistingTarget(
  event: MouseEvent | TouchEvent
): boolean {
  const target = event.target;
  if (typeof Element === "undefined" || !(target instanceof Element)) {
    return false;
  }

  return Boolean(target.closest(REACT_FLOW_CONNECTION_TARGET_SELECTOR));
}

export function resolvePendingConnectionRelease(
  event: MouseEvent | TouchEvent,
  connectionState: FinalConnectionState,
  fallbackSource: PendingConnectionSource | null = null
): PendingConnectionRelease | null {
  if (
    connectionState.toNode ||
    connectionState.toHandle ||
    isConnectionReleaseOverExistingTarget(event)
  ) {
    return null;
  }

  const point = getReleaseClientPoint(event);
  if (!point) return null;
  const sourceNodeId =
    connectionState.fromNode?.id ?? fallbackSource?.sourceNodeId ?? null;
  if (!sourceNodeId) return null;

  return {
    clientX: point.x,
    clientY: point.y,
    sourceNodeId,
    sourceHandleId:
      connectionState.fromHandle?.id ?? fallbackSource?.sourceHandleId ?? null,
  };
}

export function useScenarioGraphController({
  flowWrapperRef,
  screenToFlowPosition,
  graphEditor,
  nodes,
  edges,
  setSelectedNodeId,
  whatsAppTemplates,
  connectedActionSources = [],
  undoGraphChange,
  t,
}: UseScenarioGraphControllerParams) {
  const scenarioContextToken = graphEditor;
  const [contextMenuState, setContextMenu] =
    useState<ScenarioGraphContextMenuInternalState | null>(null);
  const contextMenu =
    contextMenuState?.scenarioContextToken === scenarioContextToken
      ? contextMenuState
      : null;
  const pendingConnectionSourceRef =
    useRef<PendingConnectionSourceState | null>(null);

  const openContextMenuAtClientPoint = useCallback(
    (
      clientX: number,
      clientY: number,
      connectFromNodeId?: string,
      connectFromSourceHandle?: string | null
    ) => {
      const wrapper = flowWrapperRef.current;
      if (!wrapper) return;

      const bounds = wrapper.getBoundingClientRect();
      const edgePadding = 12;
      const projected = screenToFlowPosition({
        x: clientX,
        y: clientY,
      }) ?? { x: clientX - bounds.left, y: clientY - bounds.top };

      setContextMenu({
        scenarioContextToken,
        left: Math.min(
          Math.max(clientX - bounds.left, edgePadding),
          Math.max(edgePadding, bounds.width - edgePadding)
        ),
        top: Math.min(
          Math.max(clientY - bounds.top, edgePadding),
          Math.max(edgePadding, bounds.height - edgePadding)
        ),
        flowX: projected.x,
        flowY: projected.y,
        connectFromNodeId,
        connectFromSourceHandle,
      });
    },
    [flowWrapperRef, scenarioContextToken, screenToFlowPosition]
  );

  const openNodePickerFromHandle = useCallback(
    (
      nodeId: string,
      sourceHandleId: string | null,
      clientX: number,
      clientY: number
    ) => {
      openContextMenuAtClientPoint(clientX, clientY, nodeId, sourceHandleId);
    },
    [openContextMenuAtClientPoint]
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const contextMenuRoute = useMemo(() => {
    if (!contextMenu?.connectFromNodeId) return null;
    const graph = { nodes, edges };
    const sourceNode = graph.nodes.find(
      node => node.id === contextMenu.connectFromNodeId
    );
    if (!sourceNode || !isServiceMessageSource(sourceNode)) return null;
    const disconnected = removeScenarioSourceConnections(
      graph,
      sourceNode.id,
      contextMenu.connectFromSourceHandle
    );
    const disconnectedIds = new Set(disconnected.edges.map(edge => edge.id));
    const currentDestinationId =
      graph.edges.find(edge => !disconnectedIds.has(edge.id))?.target ?? null;
    const destinations = graph.nodes.flatMap(node => {
      const plan = resolveScenarioConnectionPlan({
        connection: {
          sourceHandle: contextMenu.connectFromSourceHandle ?? null,
        },
        sourceNode: resolveScenarioNodeForConnections({
          node: sourceNode,
          sourceHandle: contextMenu.connectFromSourceHandle,
          whatsAppTemplates,
        }),
        targetNode: node,
        nodes: disconnected.nodes,
        edges: disconnected.edges,
      });
      if (plan?.kind !== "valid") return [];
      return [
        {
          nodeId: node.id,
          label: resolveScenarioDestinationLabel({ nodeData: node.data, t }),
        },
      ];
    });
    return { currentDestinationId, destinations };
  }, [contextMenu, nodes, edges, t, whatsAppTemplates]);

  const disconnectContextMenuRoute = useCallback(() => {
    if (!contextMenu?.connectFromNodeId) return;
    graphEditor.edit(graph => {
      const next = removeScenarioSourceConnections(
        graph,
        contextMenu.connectFromNodeId!,
        contextMenu.connectFromSourceHandle
      );
      return next === graph ? null : { ...next, history: "record" };
    });
    setContextMenu(null);
  }, [contextMenu, graphEditor]);

  const connectContextMenuToNode = useCallback(
    (targetNodeId: string) => {
      if (!contextMenu?.connectFromNodeId) return;
      const applied = graphEditor.edit(graph => {
        const disconnected = removeScenarioSourceConnections(
          graph,
          contextMenu.connectFromNodeId!,
          contextMenu.connectFromSourceHandle
        );
        const sourceNode = disconnected.nodes.find(
          node => node.id === contextMenu.connectFromNodeId
        );
        const targetNode = disconnected.nodes.find(
          node => node.id === targetNodeId
        );
        if (!sourceNode || !targetNode) return null;
        const plan = resolveScenarioConnectionPlan({
          connection: {
            sourceHandle: contextMenu.connectFromSourceHandle ?? null,
          },
          sourceNode: resolveScenarioNodeForConnections({
            node: sourceNode,
            sourceHandle: contextMenu.connectFromSourceHandle,
            whatsAppTemplates,
          }),
          targetNode,
          nodes: disconnected.nodes,
          edges: disconnected.edges,
        });
        if (!plan) return null;
        if (plan.kind === "invalid") {
          toast.error(t(plan.errorKey, plan.errorValues));
          return null;
        }
        return {
          nodes: plan.targetPatch
            ? disconnected.nodes.map(node =>
                node.id === targetNodeId
                  ? { ...node, data: { ...node.data, ...plan.targetPatch } }
                  : node
              )
            : disconnected.nodes,
          edges: [
            ...disconnected.edges,
            {
              id: createScenarioGraphId("edge"),
              source: sourceNode.id,
              sourceHandle: plan.sourceHandleId,
              target: targetNodeId,
              targetHandle: plan.targetHandleId,
              ...DEFAULT_SCENARIO_EDGE_STYLE,
            },
          ],
          history: "record",
        };
      });
      if (applied) setSelectedNodeId(targetNodeId);
      setContextMenu(null);
    },
    [contextMenu, graphEditor, setSelectedNodeId, t, whatsAppTemplates]
  );

  const handlePaneContextMenu = useCallback(
    (event: MouseEvent | ReactMouseEvent<Element, MouseEvent>) => {
      event.preventDefault();
      openContextMenuAtClientPoint(event.clientX, event.clientY);
    },
    [openContextMenuAtClientPoint]
  );

  const handleNodeClick = useCallback(
    (_: ReactMouseEvent, node: ScenarioFlowNode) => {
      setSelectedNodeId(node.id);
      setContextMenu(null);
    },
    [setSelectedNodeId]
  );

  const handlePaneClick = useCallback(() => {
    setSelectedNodeId(null);
    setContextMenu(null);
  }, [setSelectedNodeId]);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      graphEditor.edit(({ nodes, edges }) => {
        const sourceNode = nodes.find(node => node.id === connection.source);
        const targetNode = nodes.find(node => node.id === connection.target);
        if (!sourceNode || !targetNode) return null;
        const connectionPlan = resolveScenarioConnectionPlan({
          connection,
          sourceNode: resolveScenarioNodeForConnections({
            node: sourceNode,
            sourceHandle: connection.sourceHandle,
            whatsAppTemplates,
          }),
          targetNode,
          nodes,
          edges,
        });
        if (!connectionPlan) return null;
        if (connectionPlan.kind === "invalid") {
          toast.error(t(connectionPlan.errorKey, connectionPlan.errorValues));
          return null;
        }
        const nextEdges = addEdge(
          {
            ...connection,
            id: createScenarioGraphId("edge"),
            sourceHandle: connectionPlan.sourceHandleId,
            targetHandle: connectionPlan.targetHandleId,
            ...DEFAULT_SCENARIO_EDGE_STYLE,
          },
          edges
        );
        const targetPatch =
          connectionPlan.targetPatch &&
          !hasSameBranchBindingData(targetNode.data, {
            ...targetNode.data,
            ...connectionPlan.targetPatch,
          })
            ? connectionPlan.targetPatch
            : null;
        if (nextEdges === edges && !targetPatch) return null;
        return {
          nodes: targetPatch
            ? nodes.map(node =>
                node.id === targetNode.id
                  ? {
                      ...node,
                      data: { ...node.data, ...targetPatch },
                    }
                  : node
              )
            : nodes,
          edges: nextEdges,
          history: "record",
        };
      });
    },
    [graphEditor, t, whatsAppTemplates]
  );

  const isValidConnection = useCallback<IsValidConnection<ScenarioFlowEdge>>(
    connection => {
      if (!connection.source || !connection.target) return false;

      const { nodes: currentNodes, edges: currentEdges } = graphEditor.read();
      const sourceNode = currentNodes.find(
        node => node.id === connection.source
      );
      const targetNode = currentNodes.find(
        node => node.id === connection.target
      );
      if (!sourceNode || !targetNode) return false;

      const resolvedSourceNode = resolveScenarioNodeForConnections({
        node: sourceNode,
        sourceHandle: connection.sourceHandle,
        whatsAppTemplates,
      });
      const connectionPlan = resolveScenarioConnectionPlan({
        connection: {
          sourceHandle: connection.sourceHandle ?? null,
        },
        sourceNode: resolvedSourceNode,
        targetNode,
        nodes: currentNodes,
        edges: currentEdges,
      });

      return connectionPlan?.kind === "valid";
    },
    [graphEditor, whatsAppTemplates]
  );

  const insertPaletteItemAtFlowPoint = useCallback(
    async (params: {
      item: ScenarioNodePaletteItem;
      flowX: number;
      flowY: number;
      connectFromNodeId?: string;
      connectFromSourceHandle?: string | null;
    }) => {
      if (params.item.disabled) return;

      const node = createNodeFromPaletteItem(params.item, {
        x: params.flowX,
        y: params.flowY,
      });

      const applied = graphEditor.edit(graph => {
        const serviceSource = graph.nodes.find(
          node => node.id === params.connectFromNodeId
        );
        const { nodes, edges } =
          params.connectFromNodeId && isServiceMessageSource(serviceSource)
            ? removeScenarioSourceConnections(
                graph,
                params.connectFromNodeId,
                params.connectFromSourceHandle
              )
            : graph;
        let nodeToInsert =
          params.item.id === "action-reply"
            ? {
                ...node,
                data: {
                  ...node.data,
                  ...(isServiceMessageSource(serviceSource)
                    ? buildActionPatchForSelector({
                        nodeData: undefined,
                        selectorType: "whatsapp_service_message",
                      })
                    : resolveDefaultReplyActionPatch(connectedActionSources)),
                },
              }
            : node;
        let nextEdges = edges;
        if (params.connectFromNodeId) {
          const sourceNode = nodes.find(
            item => item.id === params.connectFromNodeId
          );
          if (!sourceNode) return null;
          const connectionPlan = resolveScenarioConnectionPlan({
            connection: {
              sourceHandle: params.connectFromSourceHandle ?? null,
            },
            sourceNode: resolveScenarioNodeForConnections({
              node: sourceNode,
              sourceHandle: params.connectFromSourceHandle,
              whatsAppTemplates,
            }),
            targetNode: nodeToInsert,
            nodes: [...nodes, nodeToInsert],
            edges,
          });
          if (!connectionPlan) return null;
          if (connectionPlan.kind === "invalid") {
            toast.error(t(connectionPlan.errorKey, connectionPlan.errorValues));
            return null;
          }
          if (connectionPlan.targetPatch) {
            nodeToInsert = {
              ...nodeToInsert,
              data: { ...nodeToInsert.data, ...connectionPlan.targetPatch },
            };
          }
          nextEdges = [
            ...edges,
            {
              id: createScenarioGraphId("edge"),
              source: sourceNode.id,
              sourceHandle: connectionPlan.sourceHandleId,
              target: node.id,
              targetHandle: connectionPlan.targetHandleId,
              ...DEFAULT_SCENARIO_EDGE_STYLE,
            },
          ];
        }
        return {
          nodes: [...nodes, nodeToInsert],
          edges: nextEdges,
          history: "record",
          // The user chose this spot; auto-layout must not move the new node.
          layout: "keep",
        };
      });
      if (applied) setSelectedNodeId(node.id);
      setContextMenu(null);
    },
    [
      connectedActionSources,
      graphEditor,
      setSelectedNodeId,
      t,
      whatsAppTemplates,
    ]
  );

  const addNodeFromPaletteItem = useCallback(
    async (item: ScenarioNodePaletteItem) => {
      if (!contextMenu) return;
      await insertPaletteItemAtFlowPoint({
        item,
        flowX: contextMenu.flowX,
        flowY: contextMenu.flowY,
        connectFromNodeId: contextMenu.connectFromNodeId,
        connectFromSourceHandle: contextMenu.connectFromSourceHandle,
      });
    },
    [contextMenu, insertPaletteItemAtFlowPoint]
  );

  const addEmptyCanvasRootNode = useCallback(
    (kind: ScenarioEmptyCanvasRootKind) => {
      const paletteId = SCENARIO_EMPTY_CANVAS_ROOT_PALETTE_IDS[kind];
      const item = SCENARIO_NODE_PALETTE.find(entry => entry.id === paletteId);
      if (!item || item.disabled) return;

      const wrapper = flowWrapperRef.current;
      if (!wrapper) return;
      const bounds = wrapper.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;

      const clientX = bounds.left + bounds.width / 2;
      const clientY = bounds.top + bounds.height / 2;
      const projected = screenToFlowPosition({
        x: clientX,
        y: clientY,
      }) ?? {
        x: bounds.width / 2,
        y: bounds.height / 2,
      };

      setSelectedNodeId(null);
      void insertPaletteItemAtFlowPoint({
        item,
        flowX: projected.x,
        flowY: projected.y,
      });
    },
    [
      flowWrapperRef,
      insertPaletteItemAtFlowPoint,
      screenToFlowPosition,
      setSelectedNodeId,
    ]
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      const release = resolvePendingConnectionRelease(
        event,
        connectionState,
        pendingConnectionSourceRef.current?.scenarioContextToken ===
          scenarioContextToken
          ? pendingConnectionSourceRef.current
          : null
      );
      pendingConnectionSourceRef.current = null;
      if (!release) return;

      openContextMenuAtClientPoint(
        release.clientX,
        release.clientY,
        release.sourceNodeId,
        release.sourceHandleId
      );
    },
    [openContextMenuAtClientPoint, scenarioContextToken]
  );

  const onConnectStart = useCallback(
    (_event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
      pendingConnectionSourceRef.current =
        params.handleType === "source" && params.nodeId
          ? {
              sourceNodeId: params.nodeId,
              sourceHandleId: params.handleId,
              scenarioContextToken,
            }
          : null;
    },
    [scenarioContextToken]
  );

  const handleBranchSyncForNode = useCallback(
    (
      actionNodeId: string,
      descriptorOrDescriptors: BranchDescriptor | BranchDescriptor[],
      actionNodePatch?: Partial<ScenarioNodeData>,
      options?: BranchSyncOptions
    ) => {
      const descriptors = Array.isArray(descriptorOrDescriptors)
        ? descriptorOrDescriptors
        : [descriptorOrDescriptors];
      const templatePick = Boolean(options?.templatePick);
      let routeChanges = null as TemplateRouteChanges | null;
      const edited = graphEditor.edit(({ nodes, edges }) => {
        const transition = transitionBranchNodes({
          actionNodeId,
          nodes,
          edges,
          descriptors,
          actionNodePatch,
        });
        if (!transition.changed) return null;
        routeChanges = collectTemplateRouteChanges({
          actionNodeId,
          nodes,
          edges,
          transition,
          descriptors,
          templatePick,
        });
        return {
          nodes: transition.nodes,
          edges: transition.edges,
          // A pick is recorded even when no edge changed, so its Undo
          // reverts the pick and not an older change.
          history:
            transition.structuralHistoryRequired || templatePick
              ? "record"
              : "skip",
        };
      });
      if (!edited || !routeChanges) return;
      showTemplateRouteChangesToast({
        actionNodeId,
        changes: routeChanges,
        t,
        templatePick,
        undo: undoGraphChange,
      });
    },
    [graphEditor, t, undoGraphChange]
  );

  const handleBranchSyncForNodeRef = useLatestRef(handleBranchSyncForNode);

  return {
    contextMenu,
    contextMenuRoute,
    connectContextMenuToNode,
    disconnectContextMenuRoute,
    closeContextMenu,
    addNodeFromPaletteItem,
    addEmptyCanvasRootNode,
    handleBranchSyncForNodeRef,
    handleNodeClick,
    handlePaneClick,
    handlePaneContextMenu,
    openContextMenuAtClientPoint,
    openNodePickerFromHandle,
    onConnect,
    onConnectEnd,
    onConnectStart,
    isValidConnection,
  };
}

type TemplateRouteChanges = {
  nextActionData: ScenarioNodeData | undefined;
  removedRoutes: BranchRoute[];
  /** Routes a pick of another template kept on same-text buttons. */
  movedRoutes: BranchRoute[];
};

function collectTemplateRouteChanges(params: {
  actionNodeId: string;
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
  transition: BranchTransitionResult;
  descriptors: BranchDescriptor[];
  templatePick: boolean;
}): TemplateRouteChanges {
  const findActionData = (nodes: ScenarioFlowNode[]) =>
    nodes.find(node => node.id === params.actionNodeId)?.data as
      | ScenarioNodeData
      | undefined;
  const nextActionData = findActionData(params.transition.nodes);
  const picksAnotherTemplate =
    params.templatePick &&
    resolveWhatsAppTemplatePickMatch(
      findActionData(params.nodes),
      nextActionData?.actionWhatsAppTemplateName
    ) === "textOnly";
  return {
    nextActionData,
    removedRoutes: params.transition.removedRoutes,
    movedRoutes: picksAnotherTemplate
      ? collectKeptBranchRoutes({
          actionNodeId: params.actionNodeId,
          previousEdges: params.edges,
          nodes: params.transition.nodes,
          edges: params.transition.edges,
          descriptors: params.descriptors,
        })
      : [],
  };
}

/** A route as the toast names it; branch sync leaves the form route unnamed. */
function resolveTemplateRouteLabel(
  route: BranchRoute,
  t: UseScenarioGraphControllerParams["t"]
): string {
  return route.descriptorKind === "whatsapp_template_form_submitted"
    ? getWhatsAppTemplateFormSubmittedSourceHandleCopy(t).label
    : route.label;
}

function listTemplateButtonRouteLabels(
  routes: BranchRoute[],
  t: UseScenarioGraphControllerParams["t"]
): string[] {
  return routes
    .filter(
      route =>
        route.descriptorKind === "whatsapp_template_button" ||
        route.descriptorKind === "whatsapp_template_form_submitted"
    )
    .map(route => resolveTemplateRouteLabel(route, t));
}

/**
 * Names the routes a template change removed; their next steps stay on the
 * canvas. A save names reply-button and "Form submitted" routes. A pick can
 * be undone, so it names every route it removed or, when it removed none, the
 * routes it kept on same-text buttons of another template. A type change
 * stays silent.
 */
function showTemplateRouteChangesToast(params: {
  actionNodeId: string;
  changes: TemplateRouteChanges;
  t: UseScenarioGraphControllerParams["t"];
  templatePick: boolean;
  undo?: () => boolean;
}) {
  const { changes, t, templatePick, undo } = params;
  if (
    !changes.nextActionData ||
    resolveScenarioActionTypeFromNodeData(changes.nextActionData) !==
      "whatsapp_template"
  ) {
    return;
  }
  const removed = formatQuotedLabelList(
    templatePick
      ? changes.removedRoutes.map(route => resolveTemplateRouteLabel(route, t))
      : listTemplateButtonRouteLabels(changes.removedRoutes, t),
    t
  );
  const moved = formatQuotedLabelList(
    listTemplateButtonRouteLabels(changes.movedRoutes, t),
    t
  );
  const options = {
    id: "whatsapp-template-routes-removed:" + params.actionNodeId,
    ...(templatePick && undo
      ? {
          duration: SCENARIO_UNDO_TOAST_DURATION_MS,
          action: { label: t("whatsappServiceUndo"), onClick: () => undo() },
        }
      : {}),
  };
  if (removed.count > 0) {
    toast(t("whatsappTemplateRoutesRemoved", removed), {
      ...options,
      description: t("whatsappTemplateRoutesRemovedNextSteps", {
        count: removed.count,
      }),
    });
  } else if (moved.count > 0) {
    toast(t("whatsappTemplatePickRoutesMoved", moved), options);
  }
}

/**
 * The source as its routes connect: a step that saved no buttons routes the
 * approved template's. Its "Form submitted" route is the saved step's, as
 * graph validation and the runtime read it.
 */
function resolveScenarioNodeForConnections(params: {
  node: ScenarioFlowNode;
  sourceHandle: string | null | undefined;
  whatsAppTemplates: ScenarioWhatsAppTemplate[];
}): ScenarioFlowNode {
  const nodeData = params.node.data as ScenarioNodeData;
  if (
    nodeData.kind !== "action" ||
    params.whatsAppTemplates.length === 0 ||
    isWhatsAppTemplateFormSubmittedSourceHandleId(params.sourceHandle)
  ) {
    return params.node;
  }

  const resolvedData = resolveScenarioNodeDataWithLiveWhatsAppTemplate({
    nodeData,
    whatsAppTemplates: params.whatsAppTemplates,
  }) as ScenarioNodeData;

  if (resolvedData === nodeData) {
    return params.node;
  }

  return {
    ...params.node,
    data: resolvedData,
  };
}
