"use client";

import { normalizeScenarioEdges } from "@/components/scenarios/graph/edge-normalization";
import { resolveScenarioFlowNodeType } from "@/components/scenarios/graph/node-type";
import { isScenarioKeyboardControlTarget } from "@/components/scenarios/scenario-keyboard-events";
import {
  DEFAULT_SCENARIO_ENTRY_POLICY,
  DEFAULT_SCENARIO_VIEWPORT,
} from "@/components/scenarios/types";
import {
  normalizeNodesAfterEdgeChanges,
  removeUnconfiguredActionOutcomeEdges,
  type ScenarioCanvasSelection,
  type ScenarioGraphEditor,
  type ScenarioGraphSnapshot,
} from "@/components/scenarios/view/graph/controller-utils";
import {
  getScenarioRequestErrorBlockNodeIds,
  getScenarioRequestErrorCode,
  isScenarioRequestErrorWithCode,
  resolveScenarioRequestErrorMessage,
} from "@/components/scenarios/view/scenario-request-error-utils";
import { captureClientEvent } from "@/lib/posthog/client";
import { applyScenarioEntryInputs } from "@/components/scenarios/view/scenario-summary-utils";
import {
  clearScenarioEdgeSelection,
  clearScenarioNodeSelection,
  hasStructuralEdgeChanges,
  hasStructuralNodeChanges,
  omitSelectionEdgeChanges,
} from "@/components/scenarios/view/scenarios-dirty-utils";
import { useLatestRef } from "@/components/scenarios/view/use-latest-ref";
import { useTransitionOwnerKey } from "@/hooks/use-transition-owner-key";
import type { GeneratedBulkSendScenarioUpdate } from "@/lib/campaign/bulk-campaign-contracts";
import {
  retryScenarioTimerReplanRecoveryRequest,
  submitGeneratedScenarioTemplateRequest,
  updateScenarioRequest,
  type ScenarioSidebarPatch,
} from "@/lib/scenarios/client";
import { noteConfirmedScenarioRevision } from "@/lib/scenarios/client/scenario-revision-tracker";
import {
  applySignedScenarioMedia,
  type SignedScenarioMedia,
} from "@/lib/scenarios/client/scenario-media-display";
import type { ScenarioDetail } from "@/lib/scenarios/client/scenario-detail-sources";
import type { InitialScenarioDetail } from "@/lib/scenarios/initial-scenario-detail";
import {
  applyManagedWhatsAppFlowProvisioningProjectionToNode,
  applyScenarioWhatsAppInteractiveFlowConfigToNode,
  applyScenarioWhatsAppInteractiveFlowSelectionToNode,
  createWhatsAppFlowEditableContentDigest,
} from "@/lib/scenarios/whatsapp-flow-projection";
import { GeneratedTemplateSubmissionError } from "@/lib/scenarios/client/generator";
import {
  createGeneratedTemplateTargetDigest,
  type GeneratedTemplateScenarioUpdate,
} from "@/lib/scenarios/generated-template-submission";
import { resolveScenarioWhatsAppInteractiveFlowTarget } from "@/lib/scenarios/whatsapp-service-message";
import type { WhatsAppFlowProvisioningResult } from "@/lib/whatsapp/flows/provisioning-contract";
import {
  attachWhatsAppFlowProviderReference,
  provisionWhatsAppFlow,
} from "@/lib/whatsapp/flows/client";
import type { ManagedWhatsAppFlowPublication } from "../builders/whatsapp/managed-provisioning-host";
import type { WhatsAppQrAssignmentResult } from "@/lib/whatsapp/qr-entry-points/client";
import {
  clearWhatsAppQrGraphBinding,
  collectWhatsAppQrGraphBindings,
  setWhatsAppQrGraphBinding,
} from "@/lib/whatsapp/qr-entry-points/scenario-binding";
import type {
  EditableWhatsAppFlowConfig,
  ScenarioActionRoutingPatch,
  WhatsAppFlowConfig,
} from "@icecore/scenario-contracts";
import { useLegacyRoutingConversion } from "./use-legacy-routing-conversion";
import {
  preloadScenarioFlowEditors,
  readScenarioFlowDetail,
} from "./scenario-flow-detail-source";
import { useScenarioMediaDisplayRefresh } from "./use-scenario-media-display-refresh";
import { useScenarioTemplateFormLoader } from "./use-scenario-template-form-loader";
import {
  assertWhatsAppQrAssignmentReady,
  type WhatsAppQrAssignmentSaveState,
} from "./whatsapp-qr-assignment-readiness";
import type { WhatsAppQrAssignmentHost } from "./useScenarioWhatsAppQrEntryPoints";
import {
  applyNormalizedScenarioPositions,
  computeNormalizedScenarioNodePositions,
} from "@/lib/scenarios/graph-layout";
import {
  prepareLegacyRoutingGraphForDeletion,
  projectLegacyActionRoutingForDisplay,
  type LegacyActionRoutingGraph,
} from "@/lib/scenarios/legacy-action-routing";
import { migrateLegacyTriggerNodeData } from "@/lib/scenarios/legacy-trigger-adapter";
import {
  applyEdgeChanges,
  applyNodeChanges,
  type EdgeChange,
  type NodeChange,
  type OnBeforeDelete,
  type ReactFlowInstance,
  useEdgesState,
  useNodesState,
  type Viewport,
} from "@xyflow/react";
import {
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  type ScenarioDocument,
  type ScenarioDetailResponseMetadata,
  type ScenarioDetailResponseWarning,
  type ScenarioFlowEdge,
  type ScenarioFlowNode,
  type ScenarioGenerationJobRefreshResult,
  type ScenarioGenerationJobServerUpdate,
  type ScenarioNodeData,
  type ScenarioSummary,
  TranslateFn,
} from "../types";
type UseScenarioFlowControllerParams = {
  workspaceId: string;
  activeScenarioId: string | null;
  activeScenario:
    | (ScenarioSummary & {
        presetId?: string | null;
        presetVersion?: string | null;
        segmentKey?: string | null;
        matchingRole?: import("@/components/scenarios/types").ScenarioMatchingRole;
        entryPolicy?: import("@/components/scenarios/types").ScenarioEntryPolicy;
      })
    | null;
  activeScenarioName: string;
  activeScenarioDescription: string;
  activeScenarioStatus: "draft" | "active";
  entryPriorityInput: string;
  setEntryPriorityInput: (value: string) => void;
  setScenarios: Dispatch<SetStateAction<ScenarioSummary[]>>;
  onScenarioDocumentConfirmed: (scenario: ScenarioDocument) => void;
  t: TranslateFn;
  /**
   * Undo and redo keep the selected node when it still exists, so its
   * settings stay open. Otherwise they clear the selection.
   */
  keepSelectionThroughHistory?: boolean;
  /**
   * The page's read of the scenario it opens. The first load adopts it,
   * when still usable, instead of asking the server again.
   */
  initialScenarioDetail?: PromiseLike<InitialScenarioDetail | null> | null;
};

export type ScenarioFlowSaveStatus = "saved" | "saving" | "unsaved";

export type WhatsAppQrAssignmentHostSnapshot = {
  scenarioId: string;
  nodeId: string;
  expectedUpdatedAt: string;
  currentEntryPointId: string | null;
  ownershipKey: string;
};

type ScenarioSaveOptions = {
  autosave?: boolean;
  providerMutationOperationId?: number;
  patch?: ScenarioSidebarPatch;
};

type ScenarioSaveFn = (options?: ScenarioSaveOptions) => Promise<boolean>;

const MAX_SCENARIO_GRAPH_HISTORY = 50;

function canAdoptScenarioRevision(
  current: string | null,
  incoming: string
): boolean {
  const incomingTimestamp = Date.parse(incoming);
  if (!Number.isFinite(incomingTimestamp)) return false;
  if (!current) return true;
  const currentTimestamp = Date.parse(current);
  if (!Number.isFinite(currentTimestamp)) return false;
  return incomingTimestamp >= currentTimestamp;
}

function scenarioRevisionsMatch(
  left: string | null,
  right: string | null
): boolean {
  if (!left || !right) return false;
  const leftTimestamp = Date.parse(left);
  const rightTimestamp = Date.parse(right);
  return (
    Number.isFinite(leftTimestamp) &&
    Number.isFinite(rightTimestamp) &&
    leftTimestamp === rightTimestamp
  );
}

function isGeneratedJobRefreshNoOp(
  update: ScenarioGenerationJobServerUpdate
): boolean {
  return (
    !update.scenarioRevisionConflict &&
    update.nodeUpdates.length === 0 &&
    scenarioRevisionsMatch(
      update.previousScenarioUpdatedAt,
      update.scenarioUpdatedAt
    )
  );
}

function isPositionNodeChange(
  change: NodeChange<ScenarioFlowNode>
): change is Extract<NodeChange<ScenarioFlowNode>, { type: "position" }> {
  return change.type === "position";
}

function hasCompletedPositionNodeChanges(
  changes: NodeChange<ScenarioFlowNode>[]
): boolean {
  return changes.some(
    change => isPositionNodeChange(change) && change.dragging !== true
  );
}

function hasActivePositionNodeChanges(
  changes: NodeChange<ScenarioFlowNode>[]
): boolean {
  return changes.some(
    change => isPositionNodeChange(change) && change.dragging === true
  );
}

function hasUndoableNonPositionNodeChanges(
  changes: NodeChange<ScenarioFlowNode>[]
): boolean {
  return changes.some(change => {
    return (
      change.type !== "select" &&
      change.type !== "dimensions" &&
      change.type !== "position"
    );
  });
}

function isKeyboardShortcut(
  event: KeyboardEvent,
  key: string,
  code: string
): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    (event.key.toLowerCase() === key || event.code === code)
  );
}

function isCanvasDeleteShortcut(event: KeyboardEvent): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) return false;

  return (
    event.key === "Delete" ||
    event.key === "Backspace" ||
    event.code === "Delete" ||
    event.code === "Backspace"
  );
}

type CanvasDeleteSelection = {
  edgeIds: Set<string>;
  nodeIds: Set<string>;
};

export function resolveCanvasDeleteSelection(params: {
  reactFlowInstance: ReactFlowInstance<
    ScenarioFlowNode,
    ScenarioFlowEdge
  > | null;
  trackedNodeIds: Set<string>;
  trackedEdgeIds: Set<string>;
}): CanvasDeleteSelection {
  const reactFlowSelectedEdgeIds =
    params.reactFlowInstance
      ?.getEdges()
      .filter(edge => edge.selected)
      .map(edge => edge.id) ?? [];
  const reactFlowSelectedNodeIds =
    params.reactFlowInstance
      ?.getNodes()
      .filter(node => node.selected)
      .map(node => node.id) ?? [];

  const edgeIds = new Set([
    ...params.trackedEdgeIds,
    ...reactFlowSelectedEdgeIds,
  ]);

  // Edge delete always wins: expanded nodes keep `selected: true` for UI, but
  // that must not cascade into deleting the node when an arrow is selected.
  if (edgeIds.size > 0) {
    return {
      edgeIds,
      nodeIds: new Set<string>(),
    };
  }

  const nodeIds = new Set([
    ...params.trackedNodeIds,
    ...reactFlowSelectedNodeIds,
  ]);

  return { edgeIds, nodeIds };
}

function useScenarioKeyboardShortcuts({
  deleteCanvasSelection,
  saveScenario,
  undoGraphChange,
  redoGraphChange,
}: {
  deleteCanvasSelection: () => boolean;
  saveScenario: ScenarioSaveFn;
  undoGraphChange: () => boolean;
  redoGraphChange: () => boolean;
}) {
  useEffect(() => {
    const handleKeyboardShortcut = (event: KeyboardEvent) => {
      if (
        isCanvasDeleteShortcut(event) &&
        !isScenarioKeyboardControlTarget(event.target)
      ) {
        if (deleteCanvasSelection()) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
        }
        return;
      }

      if (isKeyboardShortcut(event, "s", "KeyS")) {
        event.preventDefault();
        event.stopPropagation();
        void saveScenario();
        return;
      }

      if (
        ((isKeyboardShortcut(event, "z", "KeyZ") && event.shiftKey) ||
          isKeyboardShortcut(event, "y", "KeyY")) &&
        !event.altKey &&
        !isScenarioKeyboardControlTarget(event.target)
      ) {
        if (redoGraphChange()) event.preventDefault();
        return;
      }

      if (
        isKeyboardShortcut(event, "z", "KeyZ") &&
        !event.shiftKey &&
        !event.altKey &&
        !isScenarioKeyboardControlTarget(event.target)
      ) {
        if (undoGraphChange()) {
          event.preventDefault();
        }
      }
    };

    window.addEventListener("keydown", handleKeyboardShortcut, true);
    return () =>
      window.removeEventListener("keydown", handleKeyboardShortcut, true);
  }, [deleteCanvasSelection, saveScenario, undoGraphChange, redoGraphChange]);
}

function useScenarioAutosave({
  autoSaveTimerRef,
  editVersion,
  lastSaveAttemptVersion,
  hasSaveConflict,
  isDirty,
  saveScenario,
  setSaveStatus,
  suspended,
}: {
  autoSaveTimerRef: RefObject<ReturnType<typeof setTimeout> | null>;
  editVersion: number;
  lastSaveAttemptVersion: number;
  hasSaveConflict: boolean;
  isDirty: boolean;
  saveScenario: ScenarioSaveFn;
  setSaveStatus: Dispatch<SetStateAction<ScenarioFlowSaveStatus>>;
  suspended: boolean;
}) {
  useEffect(() => {
    if (
      isDirty &&
      editVersion !== lastSaveAttemptVersion &&
      !hasSaveConflict &&
      !suspended
    ) {
      setSaveStatus("unsaved");
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = setTimeout(() => {
        void saveScenario({ autosave: true });
      }, 3000);
    }

    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, [
    autoSaveTimerRef,
    editVersion,
    lastSaveAttemptVersion,
    hasSaveConflict,
    isDirty,
    saveScenario,
    setSaveStatus,
    suspended,
  ]);
}

function viewportsEqual(left: Viewport, right: Viewport): boolean {
  return (
    Math.abs(left.x - right.x) < 0.5 &&
    Math.abs(left.y - right.y) < 0.5 &&
    Math.abs(left.zoom - right.zoom) < 0.001
  );
}

function pageScenarioDetailFor(
  ownerKey: string,
  detail: PromiseLike<InitialScenarioDetail | null> | null
) {
  return detail ? { ownerKey, detail } : null;
}

export function normalizeScenarioDocumentToFlow(scenario: ScenarioDocument): {
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
  viewport: typeof DEFAULT_SCENARIO_VIEWPORT;
} {
  const normalizedNodes = scenario.nodes.map(node => {
    // The transport checks the graph envelope; nested editable drafts remain
    // permissive. Interpret supported legacy triggers only at this boundary.
    const normalizedData =
      node.data.kind === "trigger"
        ? migrateLegacyTriggerNodeData(node.data)
        : (node.data as ScenarioNodeData);

    return {
      ...node,
      position: node.position ?? { x: 0, y: 0 },
      data: normalizedData,
      type: resolveScenarioFlowNodeType(normalizedData.kind),
    } satisfies ScenarioFlowNode;
  });
  const normalizedEdges = normalizeScenarioEdges(
    normalizedNodes,
    scenario.edges
  );

  return {
    nodes: normalizedNodes,
    edges: normalizedEdges,
    viewport: scenario.viewport || DEFAULT_SCENARIO_VIEWPORT,
  };
}

export function useScenarioFlowController({
  workspaceId,
  activeScenarioId,
  activeScenario,
  activeScenarioName,
  activeScenarioDescription,
  activeScenarioStatus,
  entryPriorityInput,
  setEntryPriorityInput,
  setScenarios,
  onScenarioDocumentConfirmed,
  t,
  keepSelectionThroughHistory = false,
  initialScenarioDetail = null,
}: UseScenarioFlowControllerParams) {
  const sessionOwnerKey = useTransitionOwnerKey(
    `${workspaceId}\u0000${activeScenarioId ?? ""}`
  );
  const sessionOwnerKeyRef = useLatestRef(sessionOwnerKey);
  const loadedSessionOwnerRef = useRef<string | null>(null);
  // Only the first load, of the scenario the page opened, may adopt it.
  const initialScenarioDetailRef = useRef(
    pageScenarioDetailFor(sessionOwnerKey, initialScenarioDetail)
  );
  const confirmedScenarioRef = useRef<ScenarioDocument | null>(null);
  const [nodes, setNodes] = useNodesState<ScenarioFlowNode>([]);
  const [edges, setEdges] = useEdgesState<ScenarioFlowEdge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [canvasSelection, setCanvasSelection] =
    useState<ScenarioCanvasSelection>(() => ({
      nodeIds: new Set<string>(),
      edgeIds: new Set<string>(),
    }));
  const [isDirty, setIsDirty] = useState(false);
  const [editVersion, setEditVersion] = useState(0);
  const [lastSaveAttemptVersion, setLastSaveAttemptVersion] = useState(-1);
  const [validationRequested, setValidationRequested] = useState(false);
  const [autoLayoutEnabled, setAutoLayoutEnabled] = useState(true);
  const autoLayoutEnabledRef = useLatestRef(autoLayoutEnabled);
  const [loadingFlow, setLoadingFlow] = useState(() =>
    Boolean(activeScenarioId)
  );
  const [saveStatus, setSaveStatus] = useState<ScenarioFlowSaveStatus>("saved");
  const [hasSaveConflict, setHasSaveConflict] = useState(false);
  const [providerMutationInFlight, setProviderMutationInFlight] =
    useState(false);
  const [bulkSendsInFlight, setBulkSendsInFlight] = useState(0);
  const [
    linkedConditionParentCountByNodeId,
    setLinkedConditionParentCountByNodeId,
  ] = useState<ReadonlyMap<string, number>>(() => new Map());

  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scenarioFlowRequestTokenRef = useRef(0);
  const scenarioFlowAbortControllerRef = useRef<AbortController | null>(null);
  const loadScenarioFlowRef = useRef<() => Promise<boolean>>(async () => false);
  const activeScenarioUpdatedAt = activeScenario?.updatedAt ?? null;
  const latestScenarioUpdatedAtRef = useRef<string | null>(
    activeScenarioUpdatedAt
  );
  const latestScenarioUpdatedAtScenarioIdRef = useRef<string | null>(
    activeScenarioId
  );
  const viewportByScenarioIdRef = useRef<Record<string, Viewport>>({});
  const reactFlowInstanceRef = useRef<ReactFlowInstance<
    ScenarioFlowNode,
    ScenarioFlowEdge
  > | null>(null);
  const nodesRef = useLatestRef(nodes);
  const edgesRef = useLatestRef(edges);
  const isDirtyRef = useLatestRef(isDirty);
  const loadingFlowRef = useLatestRef(loadingFlow);
  const saveStatusRef = useLatestRef(saveStatus);
  const activeScenarioIdRef = useLatestRef(activeScenarioId);
  const activeScenarioRef = useLatestRef(activeScenario);
  const activeScenarioNameRef = useLatestRef(activeScenarioName);
  const activeScenarioDescriptionRef = useLatestRef(activeScenarioDescription);
  const activeScenarioStatusRef = useLatestRef(activeScenarioStatus);
  const entryPriorityInputRef = useLatestRef(entryPriorityInput);
  const hasSaveConflictRef = useLatestRef(hasSaveConflict);
  const pendingViewportRef = useRef<Viewport | null>(null);
  const fitViewOnInitRef = useRef(false);
  const lastViewportRef = useRef(DEFAULT_SCENARIO_VIEWPORT);
  const graphHistoryRef = useRef<ScenarioGraphSnapshot[]>([]);
  const graphFutureRef = useRef<ScenarioGraphSnapshot[]>([]);
  const pendingLayoutMeasurementsRef = useRef<Set<string>>(new Set());
  const pendingPositionHistorySnapshotRef =
    useRef<ScenarioGraphSnapshot | null>(null);
  const dragHistoryCompletedBeforeNodeChangeRef = useRef(false);
  const hasCanvasSelectionRef = useRef(false);
  const selectedCanvasNodeIdsRef = useRef<Set<string>>(new Set());
  const selectedCanvasEdgeIdsRef = useRef<Set<string>>(new Set());
  const commitCanvasSelection = useCallback(
    (nodeIds: Set<string>, edgeIds: Set<string>) => {
      hasCanvasSelectionRef.current = nodeIds.size > 0 || edgeIds.size > 0;
      selectedCanvasNodeIdsRef.current = nodeIds;
      selectedCanvasEdgeIdsRef.current = edgeIds;
      setCanvasSelection(current =>
        current.nodeIds.size === nodeIds.size &&
        current.edgeIds.size === edgeIds.size &&
        Array.from(nodeIds).every(id => current.nodeIds.has(id)) &&
        Array.from(edgeIds).every(id => current.edgeIds.has(id))
          ? current
          : { nodeIds, edgeIds }
      );
    },
    []
  );
  const historyNodesRef = useRef<ScenarioFlowNode[]>(nodes);
  const historyEdgesRef = useRef<ScenarioFlowEdge[]>(edges);
  const graphMutationVersionRef = useRef(0);
  const persistedMutationVersionRef = useRef(0);
  const providerMutationSequenceRef = useRef(0);
  const providerMutationOperationRef = useRef<{
    id: number;
    scenarioId: string;
    kind: "flow_attachment" | "generated_template" | "managed_flow";
    nodeId: string;
  } | null>(null);
  const scenarioSaveOperationRef = useRef<{
    scenarioId: string;
    ownerKey: string;
    promise: Promise<boolean>;
  } | null>(null);
  const ownsLoadedSession = useCallback(
    (ownerKey: string) =>
      sessionOwnerKeyRef.current === ownerKey &&
      loadedSessionOwnerRef.current === ownerKey &&
      !loadingFlowRef.current,
    [loadingFlowRef, sessionOwnerKeyRef]
  );
  const readScenarioFlowSessionKey = useCallback(
    () =>
      `${sessionOwnerKeyRef.current}:${scenarioFlowRequestTokenRef.current}`,
    [sessionOwnerKeyRef]
  );
  const readScenarioFlowOwnershipKey = useCallback(
    () => `${readScenarioFlowSessionKey()}:${graphMutationVersionRef.current}`,
    [readScenarioFlowSessionKey]
  );

  const readWhatsAppQrGraphEntryPointId = useCallback(
    (nodeId: string): string | null => {
      const normalizedNodeId = nodeId.trim();
      if (!normalizedNodeId) return null;
      return (
        collectWhatsAppQrGraphBindings(nodesRef.current).find(
          candidate => candidate.nodeId === normalizedNodeId
        )?.entryPointId ?? null
      );
    },
    [nodesRef]
  );

  const readWhatsAppQrAssignmentSnapshot = useCallback(
    (
      nodeId: string,
      saveState: WhatsAppQrAssignmentSaveState
    ): WhatsAppQrAssignmentHostSnapshot => {
      const normalizedNodeId = nodeId.trim();
      const expectedUpdatedAt = latestScenarioUpdatedAtRef.current;
      assertWhatsAppQrAssignmentReady({
        ...saveState,
        nodeId: normalizedNodeId,
        expectedUpdatedAt,
        updatedAtScenarioId: latestScenarioUpdatedAtScenarioIdRef.current,
        saveInFlight: scenarioSaveOperationRef.current !== null,
      });
      const binding = collectWhatsAppQrGraphBindings(nodesRef.current).find(
        candidate => candidate.nodeId === normalizedNodeId
      );
      if (!binding) throw new Error("WhatsApp QR trigger node not found");
      return {
        scenarioId: saveState.scenarioId as string,
        nodeId: normalizedNodeId,
        expectedUpdatedAt: expectedUpdatedAt as string,
        currentEntryPointId: binding.entryPointId,
        ownershipKey: readScenarioFlowOwnershipKey(),
      };
    },
    [nodesRef, readScenarioFlowOwnershipKey]
  );

  const readWhatsAppQrAssignmentHostSnapshot = useCallback(
    (nodeId: string): WhatsAppQrAssignmentHostSnapshot =>
      readWhatsAppQrAssignmentSnapshot(nodeId, {
        scenarioId: activeScenarioIdRef.current,
        loadingFlow: loadingFlowRef.current,
        saveStatus: saveStatusRef.current,
        isDirty: isDirtyRef.current,
        hasSaveConflict: hasSaveConflictRef.current,
        scenarioStatus: activeScenarioStatusRef.current,
      }),
    [
      activeScenarioIdRef,
      activeScenarioStatusRef,
      hasSaveConflictRef,
      isDirtyRef,
      loadingFlowRef,
      readWhatsAppQrAssignmentSnapshot,
      saveStatusRef,
    ]
  );

  const adoptWhatsAppQrAssignmentResult = useCallback(
    (
      snapshot: WhatsAppQrAssignmentHostSnapshot,
      result: WhatsAppQrAssignmentResult
    ): boolean => {
      const target = result.targetScenario;
      const assignment = result.assignment;
      const source = result.sourceScenario;
      const isUnassign = assignment === null && target === undefined;
      const committedUpdatedAt = isUnassign
        ? source?.updatedAt
        : target?.updatedAt;
      if (isUnassign) {
        if (
          !snapshot.currentEntryPointId ||
          result.entryPointId !== snapshot.currentEntryPointId ||
          !source ||
          source.scenarioId !== snapshot.scenarioId ||
          source.nodeId !== snapshot.nodeId ||
          !canAdoptScenarioRevision(
            snapshot.expectedUpdatedAt,
            source.updatedAt
          )
        ) {
          return false;
        }
      } else if (
        !target ||
        !assignment ||
        target.scenarioId !== snapshot.scenarioId ||
        target.nodeId !== snapshot.nodeId ||
        target.previousEntryPointId !== snapshot.currentEntryPointId ||
        assignment.scenarioId !== snapshot.scenarioId ||
        assignment.nodeId !== snapshot.nodeId ||
        !scenarioRevisionsMatch(
          assignment.scenarioUpdatedAt,
          target.updatedAt
        ) ||
        !canAdoptScenarioRevision(snapshot.expectedUpdatedAt, target.updatedAt)
      ) {
        return false;
      }
      if (!committedUpdatedAt) return false;
      if (
        activeScenarioIdRef.current !== snapshot.scenarioId ||
        latestScenarioUpdatedAtScenarioIdRef.current !== snapshot.scenarioId ||
        !scenarioRevisionsMatch(
          latestScenarioUpdatedAtRef.current,
          snapshot.expectedUpdatedAt
        ) ||
        readScenarioFlowOwnershipKey() !== snapshot.ownershipKey ||
        loadingFlowRef.current ||
        scenarioSaveOperationRef.current !== null ||
        saveStatusRef.current !== "saved" ||
        isDirtyRef.current ||
        hasSaveConflictRef.current ||
        activeScenarioStatusRef.current !== "draft"
      ) {
        return false;
      }

      const bindings = collectWhatsAppQrGraphBindings(nodesRef.current);
      const currentTarget = bindings.find(
        candidate => candidate.nodeId === snapshot.nodeId
      );
      if (
        !currentTarget ||
        currentTarget.entryPointId !== snapshot.currentEntryPointId
      ) {
        return false;
      }

      let nextNodes = nodesRef.current;
      if (isUnassign) {
        nextNodes = clearWhatsAppQrGraphBinding(nextNodes, snapshot.nodeId);
      } else if (
        source?.scenarioId === snapshot.scenarioId &&
        source.nodeId !== snapshot.nodeId
      ) {
        const currentSource = bindings.find(
          candidate => candidate.nodeId === source.nodeId
        );
        if (currentSource?.entryPointId !== result.entryPointId) return false;
        nextNodes = clearWhatsAppQrGraphBinding(nextNodes, source.nodeId);
      }
      if (!isUnassign) {
        nextNodes = setWhatsAppQrGraphBinding(
          nextNodes,
          snapshot.nodeId,
          result.entryPointId
        );
      }

      graphMutationVersionRef.current += 1;
      nodesRef.current = nextNodes;
      historyNodesRef.current = nextNodes;
      latestScenarioUpdatedAtRef.current = committedUpdatedAt;
      noteConfirmedScenarioRevision(snapshot.scenarioId, committedUpdatedAt);
      noteConfirmedScenarioRevision(source?.scenarioId, source?.updatedAt);
      setNodes(nextNodes);
      setIsDirty(false);
      setHasSaveConflict(false);
      setSaveStatus("saved");
      setScenarios(previous =>
        previous.map(scenario =>
          scenario._id === snapshot.scenarioId
            ? { ...scenario, updatedAt: committedUpdatedAt }
            : scenario
        )
      );
      return true;
    },
    [
      activeScenarioIdRef,
      activeScenarioStatusRef,
      hasSaveConflictRef,
      isDirtyRef,
      loadingFlowRef,
      nodesRef,
      readScenarioFlowOwnershipKey,
      saveStatusRef,
      setNodes,
      setSaveStatus,
      setScenarios,
    ]
  );

  useEffect(() => {
    historyNodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    historyEdgesRef.current = edges;
  }, [edges]);

  /**
   * Where the canvas opens, read when React Flow mounts: fitted on a first
   * open, else at the session or saved viewport. React Flow applies it before
   * the first frame, so the canvas does not start elsewhere and move.
   */
  const readInitialViewport = useCallback(
    () =>
      fitViewOnInitRef.current
        ? { viewport: null, fitView: true }
        : { viewport: pendingViewportRef.current, fitView: false },
    []
  );

  const setReactFlowInstance = useCallback(
    (instance: ReactFlowInstance<ScenarioFlowNode, ScenarioFlowEdge>) => {
      reactFlowInstanceRef.current = instance;
      if (fitViewOnInitRef.current) {
        // React Flow's fitView prop fits once the nodes are measured.
        fitViewOnInitRef.current = false;
        return;
      }
      if (pendingViewportRef.current) {
        // Normally already the mount's defaultViewport, so this moves nothing.
        instance.setViewport(pendingViewportRef.current);
      }
    },
    []
  );

  const screenToFlowPosition = useCallback(
    (position: { x: number; y: number }) =>
      reactFlowInstanceRef.current?.screenToFlowPosition(position) ?? null,
    []
  );

  const markFlowDirty = useCallback(() => {
    graphMutationVersionRef.current += 1;
    setEditVersion(graphMutationVersionRef.current);
    isDirtyRef.current = true;
    setIsDirty(true);
  }, [isDirtyRef]);

  const createGraphSnapshot = useCallback(
    (snapshot?: ScenarioGraphSnapshot): ScenarioGraphSnapshot => ({
      nodes: clearScenarioNodeSelection(
        snapshot?.nodes ?? historyNodesRef.current,
        { forceClone: Boolean(snapshot) }
      ),
      edges: clearScenarioEdgeSelection(
        snapshot?.edges ?? historyEdgesRef.current,
        { forceClone: Boolean(snapshot) }
      ),
    }),
    []
  );

  const pushGraphHistorySnapshot = useCallback(
    (snapshot: ScenarioGraphSnapshot) => {
      graphFutureRef.current = [];
      graphHistoryRef.current = [
        ...graphHistoryRef.current.slice(-(MAX_SCENARIO_GRAPH_HISTORY - 1)),
        snapshot,
      ];
    },
    []
  );

  const captureGraphHistory = useCallback(
    (snapshot?: ScenarioGraphSnapshot) => {
      pushGraphHistorySnapshot(createGraphSnapshot(snapshot));
    },
    [createGraphSnapshot, pushGraphHistorySnapshot]
  );

  const commitGraphSnapshot = useCallback(
    (graph: ScenarioGraphSnapshot) => {
      nodesRef.current = graph.nodes;
      edgesRef.current = graph.edges;
      historyNodesRef.current = graph.nodes;
      historyEdgesRef.current = graph.edges;
      setNodes(graph.nodes);
      setEdges(graph.edges);
      if (hasCanvasSelectionRef.current) {
        const nodeIds = new Set(graph.nodes.map(node => node.id));
        const edgeIds = new Set(graph.edges.map(edge => edge.id));
        commitCanvasSelection(
          new Set(
            Array.from(selectedCanvasNodeIdsRef.current).filter(id =>
              nodeIds.has(id)
            )
          ),
          new Set(
            Array.from(selectedCanvasEdgeIdsRef.current).filter(id =>
              edgeIds.has(id)
            )
          )
        );
      }
    },
    [commitCanvasSelection, edgesRef, nodesRef, setEdges, setNodes]
  );

  const readGraph = useCallback<ScenarioGraphEditor["read"]>(
    () =>
      ownsLoadedSession(sessionOwnerKey)
        ? { nodes: nodesRef.current, edges: edgesRef.current }
        : { nodes: [], edges: [] },
    [edgesRef, nodesRef, ownsLoadedSession, sessionOwnerKey]
  );
  const editGraph = useCallback<ScenarioGraphEditor["edit"]>(
    transition => {
      if (!ownsLoadedSession(sessionOwnerKey)) return false;
      const current = { nodes: nodesRef.current, edges: edgesRef.current };
      let next = transition(current);
      if (
        !next ||
        (next.nodes === current.nodes && next.edges === current.edges)
      )
        return false;
      if (next.history === "record") captureGraphHistory(current);
      graphFutureRef.current = [];
      const structuralChange =
        next.nodes.length !== current.nodes.length ||
        next.edges.length !== current.edges.length ||
        next.nodes.some(
          (node, index) => node.id !== current.nodes[index]?.id
        ) ||
        next.edges.some((edge, index) => {
          const previous = current.edges[index];
          return (
            edge.id !== previous?.id ||
            edge.source !== previous.source ||
            edge.target !== previous.target ||
            edge.sourceHandle !== previous.sourceHandle
          );
        });
      if (structuralChange) pendingLayoutMeasurementsRef.current.clear();
      if (
        autoLayoutEnabledRef.current &&
        structuralChange &&
        next.layout !== "keep" &&
        next.nodes.some(
          node =>
            node.data.kind === "action" &&
            node.data.actionWhatsAppServiceMessage !== undefined
        )
      ) {
        const displayGraph = projectLegacyActionRoutingForDisplay(
          next as LegacyActionRoutingGraph
        );
        const nextNodeById = new Map(next.nodes.map(node => [node.id, node]));
        pendingLayoutMeasurementsRef.current = new Set(
          displayGraph.nodes
            .filter(projected => {
              const node = nextNodeById.get(projected.id);
              return node && (!node.measured?.width || !node.measured?.height);
            })
            .map(node => node.id)
        );
        const positions = computeNormalizedScenarioNodePositions(
          displayGraph.nodes as ScenarioFlowNode[],
          displayGraph.edges as ScenarioFlowEdge[]
        );
        next = {
          ...next,
          nodes: applyNormalizedScenarioPositions(next.nodes, positions),
        };
      }
      commitGraphSnapshot(next);
      markFlowDirty();
      return true;
    },
    [
      captureGraphHistory,
      autoLayoutEnabledRef,
      commitGraphSnapshot,
      edgesRef,
      markFlowDirty,
      nodesRef,
      ownsLoadedSession,
      sessionOwnerKey,
    ]
  );
  const graphEditor = useMemo<ScenarioGraphEditor>(
    () => ({ read: readGraph, edit: editGraph }),
    [editGraph, readGraph]
  );
  const { loadWhatsAppTemplateForm, loadingTemplateFormNodeIds } =
    useScenarioTemplateFormLoader({
      workspaceId,
      graphEditor,
      sessionOwnerKey,
      ownsLoadedSession,
    });

  const clearCanvasSelection = useCallback(() => {
    if (!ownsLoadedSession(sessionOwnerKey)) return;
    const hasSelectionState =
      hasCanvasSelectionRef.current ||
      nodesRef.current.some(node => node.selected !== undefined) ||
      edgesRef.current.some(edge => edge.selected !== undefined);
    if (!hasSelectionState) return;

    commitCanvasSelection(new Set(), new Set());
    commitGraphSnapshot({
      nodes: clearScenarioNodeSelection(nodesRef.current, { forceClone: true }),
      edges: clearScenarioEdgeSelection(edgesRef.current, { forceClone: true }),
    });
  }, [
    commitCanvasSelection,
    commitGraphSnapshot,
    edgesRef,
    nodesRef,
    ownsLoadedSession,
    sessionOwnerKey,
  ]);

  const onCanvasSelectionChange = useCallback(
    ({
      nodes: selectedNodes,
      edges: selectedEdges,
    }: {
      nodes: ScenarioFlowNode[];
      edges: ScenarioFlowEdge[];
    }) => {
      if (!ownsLoadedSession(sessionOwnerKey)) return;
      commitCanvasSelection(
        new Set(selectedNodes.map(node => node.id)),
        new Set(selectedEdges.map(edge => edge.id))
      );
    },
    [commitCanvasSelection, ownsLoadedSession, sessionOwnerKey]
  );

  const onCanvasEdgeClick = useCallback(
    (
      _: MouseEvent | ReactMouseEvent<Element, MouseEvent>,
      edge: ScenarioFlowEdge
    ) => {
      if (!ownsLoadedSession(sessionOwnerKey)) return;
      commitCanvasSelection(new Set(), new Set([edge.id]));
    },
    [commitCanvasSelection, ownsLoadedSession, sessionOwnerKey]
  );

  const onCanvasNodeClick = useCallback(
    (_: ReactMouseEvent<Element, MouseEvent>, node: ScenarioFlowNode) => {
      if (!ownsLoadedSession(sessionOwnerKey)) return;
      commitCanvasSelection(new Set([node.id]), new Set());
    },
    [commitCanvasSelection, ownsLoadedSession, sessionOwnerKey]
  );

  const onBeforeCanvasDelete = useCallback<
    OnBeforeDelete<ScenarioFlowNode, ScenarioFlowEdge>
  >(async ({ nodes: nodesToDelete, edges: edgesToDelete }) => {
    const { edgeIds, nodeIds } = resolveCanvasDeleteSelection({
      reactFlowInstance: reactFlowInstanceRef.current,
      trackedNodeIds: selectedCanvasNodeIdsRef.current,
      trackedEdgeIds: selectedCanvasEdgeIdsRef.current,
    });

    if (edgeIds.size > 0) {
      return {
        nodes: [],
        edges: edgesToDelete.filter(edge => edgeIds.has(edge.id)),
      };
    }

    if (nodeIds.size === 0) {
      return {
        nodes: [],
        edges: [],
      };
    }

    return {
      nodes: nodesToDelete.filter(node => nodeIds.has(node.id)),
      edges: edgesToDelete,
    };
  }, []);

  const selectAfterHistoryChange = useCallback(
    (restoredNodes: ScenarioFlowNode[]) => {
      setSelectedNodeId(current =>
        keepSelectionThroughHistory &&
        current !== null &&
        restoredNodes.some(node => node.id === current)
          ? current
          : null
      );
    },
    [keepSelectionThroughHistory]
  );

  const restoreHistorySnapshot = useCallback(
    (snapshot: ScenarioGraphSnapshot) => {
      commitCanvasSelection(new Set(), new Set());
      commitGraphSnapshot({
        nodes: clearScenarioNodeSelection(snapshot.nodes, { forceClone: true }),
        edges: clearScenarioEdgeSelection(snapshot.edges, { forceClone: true }),
      });
      selectAfterHistoryChange(snapshot.nodes);
      markFlowDirty();
      return true;
    },
    [
      commitCanvasSelection,
      commitGraphSnapshot,
      markFlowDirty,
      selectAfterHistoryChange,
    ]
  );

  // Undo resets the pending drag history before its empty-stack check and
  // redo after it; keep the two heads separate.
  const undoGraphChange = useCallback(() => {
    if (!ownsLoadedSession(sessionOwnerKey)) return false;
    const snapshot = graphHistoryRef.current.pop();
    pendingLayoutMeasurementsRef.current.clear();
    pendingPositionHistorySnapshotRef.current = null;
    dragHistoryCompletedBeforeNodeChangeRef.current = false;
    if (!snapshot) return false;

    graphFutureRef.current.push(createGraphSnapshot());
    return restoreHistorySnapshot(snapshot);
  }, [
    createGraphSnapshot,
    ownsLoadedSession,
    restoreHistorySnapshot,
    sessionOwnerKey,
  ]);

  const redoGraphChange = useCallback(() => {
    if (!ownsLoadedSession(sessionOwnerKey)) return false;
    const snapshot = graphFutureRef.current.pop();
    pendingLayoutMeasurementsRef.current.clear();
    if (!snapshot) return false;
    graphHistoryRef.current.push(createGraphSnapshot());
    pendingPositionHistorySnapshotRef.current = null;
    dragHistoryCompletedBeforeNodeChangeRef.current = false;
    return restoreHistorySnapshot(snapshot);
  }, [
    createGraphSnapshot,
    ownsLoadedSession,
    restoreHistorySnapshot,
    sessionOwnerKey,
  ]);

  const fitView = useCallback(
    (
      options?: Parameters<
        ReactFlowInstance<ScenarioFlowNode, ScenarioFlowEdge>["fitView"]
      >[0]
    ) => {
      void reactFlowInstanceRef.current?.fitView(options);
    },
    []
  );

  // Select and centre the first block a validation failure named, so the user
  // no longer hunts the canvas for it by hand.
  const revealValidationBlockedNode = useCallback(
    (nodeIds: string[], ownerKey: string) => {
      if (!ownsLoadedSession(ownerKey)) return;
      const targetId = nodeIds.find(nodeId =>
        nodesRef.current.some(node => node.id === nodeId)
      );
      if (!targetId) return;
      setSelectedNodeId(targetId);
      requestAnimationFrame(() => {
        if (
          !ownsLoadedSession(ownerKey) ||
          !nodesRef.current.some(node => node.id === targetId)
        )
          return;
        fitView({
          nodes: [{ id: targetId }],
          padding: 0.4,
          duration: 280,
          maxZoom: 1.2,
        });
      });
    },
    [fitView, nodesRef, ownsLoadedSession, setSelectedNodeId]
  );

  const normalizeScenarioLayoutDisabled = loadingFlow || nodes.length === 0;
  const normalizeScenarioLayout = useCallback(() => {
    if (!ownsLoadedSession(sessionOwnerKey)) return;
    const currentNodes = nodesRef.current;
    if (loadingFlowRef.current || currentNodes.length === 0) return;
    const displayGraph = projectLegacyActionRoutingForDisplay({
      nodes: currentNodes,
      edges: edgesRef.current,
    } as LegacyActionRoutingGraph);
    const positions = computeNormalizedScenarioNodePositions(
      displayGraph.nodes as ScenarioFlowNode[],
      displayGraph.edges as ScenarioFlowEdge[]
    );
    if (positions.size === 0) return;

    editGraph(graph => ({
      ...graph,
      nodes: applyNormalizedScenarioPositions(graph.nodes, positions),
      history: "record",
    }));
    requestAnimationFrame(() => {
      if (ownsLoadedSession(sessionOwnerKey))
        fitView({ padding: 0.2, duration: 280 });
    });
  }, [
    editGraph,
    edgesRef,
    fitView,
    loadingFlowRef,
    nodesRef,
    ownsLoadedSession,
    sessionOwnerKey,
  ]);

  const clearPendingSave = useCallback(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    isDirtyRef.current = false;
    persistedMutationVersionRef.current = graphMutationVersionRef.current;
    setIsDirty(false);
    setSaveStatus("saved");
  }, [isDirtyRef]);

  // A server write outside this editor's saves moved the revision (and maybe
  // the status). Adopt both, or the next autosave conflicts or reverts it.
  const adoptServerScenarioRevision = useCallback(
    (
      scenarioId: string,
      updatedAt: string,
      scenarioStatus?: "draft" | "active"
    ) => {
      latestScenarioUpdatedAtRef.current = updatedAt;
      noteConfirmedScenarioRevision(scenarioId, updatedAt);
      if (scenarioStatus) {
        activeScenarioStatusRef.current = scenarioStatus;
      }
      if (activeScenarioRef.current) {
        activeScenarioRef.current = {
          ...activeScenarioRef.current,
          ...(scenarioStatus ? { status: scenarioStatus } : {}),
          updatedAt,
        };
      }
      setScenarios(current =>
        current.map(scenario =>
          scenario._id === scenarioId
            ? {
                ...scenario,
                ...(scenarioStatus ? { status: scenarioStatus } : {}),
                updatedAt,
              }
            : scenario
        )
      );
    },
    [activeScenarioRef, activeScenarioStatusRef, setScenarios]
  );

  // A provider or generator write confirmed a new revision of the loaded
  // scenario; adopt it for the next save and in the scenario list.
  const adoptConfirmedScenarioRevision = useCallback(
    (scenarioId: string, updatedAt: string) => {
      latestScenarioUpdatedAtRef.current = updatedAt;
      noteConfirmedScenarioRevision(
        latestScenarioUpdatedAtScenarioIdRef.current,
        updatedAt
      );
      setScenarios(current =>
        current.map(scenario =>
          scenario._id === scenarioId ? { ...scenario, updatedAt } : scenario
        )
      );
    },
    [setScenarios]
  );
  const replaceNodeById = useCallback(
    (nodeId: string, nextNode: ScenarioFlowNode) => {
      const nextNodes = nodesRef.current.map(node =>
        node.id === nodeId ? nextNode : node
      );
      nodesRef.current = nextNodes;
      historyNodesRef.current = nextNodes;
      setNodes(nextNodes);
    },
    [nodesRef, setNodes]
  );
  const endProviderMutation = useCallback(
    (ownsOperation: boolean, scenarioId: string) => {
      if (!ownsOperation) return;
      providerMutationOperationRef.current = null;
      setProviderMutationInFlight(false);
      if (activeScenarioIdRef.current === scenarioId) {
        setSaveStatus(
          isDirtyRef.current || hasSaveConflictRef.current ? "unsaved" : "saved"
        );
      }
    },
    [activeScenarioIdRef, hasSaveConflictRef, isDirtyRef]
  );

  const adoptGeneratedBulkServerUpdate = useCallback(
    (
      update: GeneratedBulkSendScenarioUpdate,
      scenarioStatus?: "draft" | "active"
    ): boolean => {
      if (!ownsLoadedSession(sessionOwnerKey)) return false;
      const scenarioId = activeScenarioIdRef.current;
      if (!scenarioId) return false;
      if (
        !canAdoptScenarioRevision(
          latestScenarioUpdatedAtRef.current,
          update.scenarioUpdatedAt
        )
      ) {
        return false;
      }

      let updated = false;
      const nextNodes = nodesRef.current.map(node => {
        if (node.id !== update.nodeId) return node;
        const data = node.data as ScenarioNodeData;
        if (data.kind !== "bulk" || !data.bulkRootConfig) return node;
        if (
          !data.bulkRootConfig.generationJobId ||
          update.bulkRootConfigPatch.generatedSendState?.revision !==
            data.bulkRootConfig.generationJobId
        ) {
          return node;
        }
        updated = true;
        return {
          ...node,
          data: {
            ...data,
            bulkRootConfig: {
              ...data.bulkRootConfig,
              ...update.bulkRootConfigPatch,
            },
          },
        };
      });
      if (!updated) return false;

      nodesRef.current = nextNodes;
      historyNodesRef.current = nextNodes;
      setNodes(nextNodes);
      adoptServerScenarioRevision(
        scenarioId,
        update.scenarioUpdatedAt,
        scenarioStatus
      );
      return true;
    },
    [
      activeScenarioIdRef,
      adoptServerScenarioRevision,
      nodesRef,
      ownsLoadedSession,
      sessionOwnerKey,
      setNodes,
    ]
  );

  // A bulk send turned the sending scenario on. The editor adopts it only when
  // the activation replaced the revision it holds; otherwise another session
  // saved in between, and the next save must conflict instead of overwriting.
  const adoptScenarioActivation = useCallback(
    (activation: {
      scenarioId: string;
      scenarioUpdatedAt: string;
      previousScenarioUpdatedAt: string | null;
    }): boolean => {
      if (
        !ownsLoadedSession(sessionOwnerKey) ||
        activeScenarioIdRef.current !== activation.scenarioId
      ) {
        // The editor moved on; the sender's sidebar row still shows the status,
        // and a detail read before the send is not shown when it reopens.
        noteConfirmedScenarioRevision(
          activation.scenarioId,
          activation.scenarioUpdatedAt
        );
        setScenarios(current =>
          current.map(scenario =>
            scenario._id === activation.scenarioId
              ? {
                  ...scenario,
                  status: "active" as const,
                  ...(scenarioRevisionsMatch(
                    scenario.updatedAt,
                    activation.previousScenarioUpdatedAt
                  )
                    ? { updatedAt: activation.scenarioUpdatedAt }
                    : {}),
                }
              : scenario
          )
        );
        return false;
      }
      const currentUpdatedAt = latestScenarioUpdatedAtRef.current;
      if (
        scenarioRevisionsMatch(currentUpdatedAt, activation.scenarioUpdatedAt)
      ) {
        // Already on this revision; still take its active status, or the
        // next autosave would send the draft status back.
        adoptServerScenarioRevision(
          activation.scenarioId,
          activation.scenarioUpdatedAt,
          "active"
        );
        return true;
      }
      if (
        !activation.previousScenarioUpdatedAt ||
        !scenarioRevisionsMatch(
          currentUpdatedAt,
          activation.previousScenarioUpdatedAt
        ) ||
        !canAdoptScenarioRevision(
          activation.previousScenarioUpdatedAt,
          activation.scenarioUpdatedAt
        )
      ) {
        return false;
      }
      adoptServerScenarioRevision(
        activation.scenarioId,
        activation.scenarioUpdatedAt,
        "active"
      );
      return true;
    },
    [
      activeScenarioIdRef,
      adoptServerScenarioRevision,
      ownsLoadedSession,
      sessionOwnerKey,
      setScenarios,
    ]
  );

  const onScenarioActivationBlocked = useCallback(
    (nodeIds: string[]) => {
      if (!ownsLoadedSession(sessionOwnerKey)) return;
      setValidationRequested(true);
      revealValidationBlockedNode(nodeIds, sessionOwnerKey);
    },
    [ownsLoadedSession, revealValidationBlockedNode, sessionOwnerKey]
  );

  // Display only: the graph, its history and the save state stay as loaded,
  // so the scenario is neither marked changed nor saved for this.
  const adoptSignedScenarioMedia = useCallback(
    (ownerKey: string, signed: SignedScenarioMedia): boolean => {
      if (!ownsLoadedSession(ownerKey)) return false;
      const nextNodes = applySignedScenarioMedia(nodesRef.current, signed);
      if (nextNodes !== nodesRef.current) {
        nodesRef.current = nextNodes;
        historyNodesRef.current = nextNodes;
        setNodes(nextNodes);
      }
      // Undo and redo show the same media, not the durable refs again.
      const signSnapshot = (snapshot: ScenarioGraphSnapshot) => {
        const snapshotNodes = applySignedScenarioMedia(snapshot.nodes, signed);
        return snapshotNodes === snapshot.nodes
          ? snapshot
          : { ...snapshot, nodes: snapshotNodes };
      };
      graphHistoryRef.current = graphHistoryRef.current.map(signSnapshot);
      graphFutureRef.current = graphFutureRef.current.map(signSnapshot);
      const pendingPosition = pendingPositionHistorySnapshotRef.current;
      if (pendingPosition) {
        pendingPositionHistorySnapshotRef.current =
          signSnapshot(pendingPosition);
      }
      return true;
    },
    [nodesRef, ownsLoadedSession, setNodes]
  );
  const {
    start: startMediaDisplayRefresh,
    stop: stopMediaDisplayRefresh,
    trackNodeMediaOperation,
  } = useScenarioMediaDisplayRefresh({
    sessionOwnerKey,
    adoptSignedMedia: adoptSignedScenarioMedia,
  });

  const adoptScenarioFlow = useCallback(
    (
      scenario: ScenarioDocument,
      options: {
        viewport: Viewport;
        selectedNodeId?: string | null;
        metadata?: ScenarioDetailResponseMetadata;
        fitViewOnInit?: boolean;
      }
    ) => {
      const normalized = normalizeScenarioDocumentToFlow(scenario);
      // Cards whose editors are still downloading would first measure at
      // their placeholders' size.
      preloadScenarioFlowEditors(normalized.nodes);
      stopMediaDisplayRefresh();
      confirmedScenarioRef.current = scenario;
      loadedSessionOwnerRef.current = sessionOwnerKeyRef.current;
      onScenarioDocumentConfirmed(scenario);
      applyScenarioEntryInputs({
        scenario,
        setEntryPriorityInput,
      });
      setNodes(normalized.nodes);
      setEdges(normalized.edges);
      nodesRef.current = normalized.nodes;
      edgesRef.current = normalized.edges;
      historyNodesRef.current = normalized.nodes;
      historyEdgesRef.current = normalized.edges;
      graphHistoryRef.current = [];
      graphFutureRef.current = [];
      pendingLayoutMeasurementsRef.current.clear();
      pendingPositionHistorySnapshotRef.current = null;
      commitCanvasSelection(new Set(), new Set());
      pendingViewportRef.current = options.viewport;
      fitViewOnInitRef.current =
        options.fitViewOnInit === true && normalized.nodes.length > 0;
      lastViewportRef.current = options.viewport;
      if (!fitViewOnInitRef.current) {
        reactFlowInstanceRef.current?.setViewport(options.viewport, {
          duration: 150,
        });
      }
      setSelectedNodeId(options.selectedNodeId ?? null);
      setLinkedConditionParentCountByNodeId(
        new Map(
          Object.entries(
            options.metadata?.linkedConditionParentCountByNodeId ?? {}
          )
        )
      );
      setHasSaveConflict(false);
      latestScenarioUpdatedAtRef.current = scenario.updatedAt ?? null;
      noteConfirmedScenarioRevision(scenario._id, scenario.updatedAt);
      clearPendingSave();
      return normalized;
    },
    [
      clearPendingSave,
      commitCanvasSelection,
      edgesRef,
      nodesRef,
      setEdges,
      setEntryPriorityInput,
      setNodes,
      onScenarioDocumentConfirmed,
      sessionOwnerKeyRef,
      stopMediaDisplayRefresh,
    ]
  );

  const showScenarioDetailWarning = useCallback(
    (warning: ScenarioDetailResponseWarning, scenarioId: string) => {
      if (
        warning.code === "legacy_action_routing_timer_replan_failed" &&
        warning.recoveryStatus
      ) {
        toast.warning(warning.message, {
          id: `scenario-timer-recovery:${scenarioId}`,
          ...(warning.retryable === true
            ? {
                action: {
                  label: t("retryTimerRecoveryAction"),
                  onClick: async () => {
                    try {
                      await retryScenarioTimerReplanRecoveryRequest({
                        scenarioId,
                        workspaceId,
                      });
                      if (activeScenarioIdRef.current === scenarioId) {
                        await loadScenarioFlowRef.current();
                      }
                    } catch (error) {
                      toast.error(
                        resolveScenarioRequestErrorMessage(
                          error,
                          t,
                          "saveFailed"
                        )
                      );
                    }
                  },
                },
              }
            : {}),
        });
        return;
      }
      toast.warning(warning.message);
    },
    [activeScenarioIdRef, t, workspaceId]
  );

  const adoptLoadedScenarioDetail = useCallback(
    (detail: ScenarioDetail, ownerKey: string) => {
      const { scenario, metadata } = detail;
      const sessionViewport =
        viewportByScenarioIdRef.current[scenario._id] ?? null;
      adoptScenarioFlow(scenario, {
        // What normalizeScenarioDocumentToFlow does to it: no other checks.
        viewport:
          sessionViewport ?? (scenario.viewport || DEFAULT_SCENARIO_VIEWPORT),
        metadata,
        fitViewOnInit: !sessionViewport,
      });
      for (const warning of metadata.warnings ?? []) {
        showScenarioDetailWarning(warning, scenario._id);
      }
      startMediaDisplayRefresh({
        ownerKey,
        workspaceId,
        scenarioId: scenario._id,
        detail,
      });
    },
    [
      adoptScenarioFlow,
      showScenarioDetailWarning,
      startMediaDisplayRefresh,
      workspaceId,
    ]
  );

  // Hands the page's own read to the first load of the scenario it opened.
  const takeInitialScenarioDetail = useCallback((ownerKey: string) => {
    const initial = initialScenarioDetailRef.current;
    if (initial?.ownerKey === ownerKey) return initial.detail;
    initialScenarioDetailRef.current = null;
    return null;
  }, []);

  const loadScenarioFlow = useCallback(async (): Promise<boolean> => {
    if (sessionOwnerKeyRef.current !== sessionOwnerKey) return false;
    if (!activeScenarioId) {
      setLoadingFlow(false);
      return false;
    }

    const requestToken = scenarioFlowRequestTokenRef.current + 1;
    const requestOwnerKey = sessionOwnerKey;
    const requestMutationVersion = graphMutationVersionRef.current;
    scenarioFlowRequestTokenRef.current = requestToken;
    scenarioFlowAbortControllerRef.current?.abort();
    const abortController = new AbortController();
    scenarioFlowAbortControllerRef.current = abortController;
    const isCurrentRequest = () =>
      requestToken === scenarioFlowRequestTokenRef.current &&
      requestOwnerKey === sessionOwnerKeyRef.current;

    try {
      setLoadingFlow(true);
      const detail = await readScenarioFlowDetail({
        workspaceId,
        scenarioId: activeScenarioId,
        signal: abortController.signal,
        initialDetail: takeInitialScenarioDetail(requestOwnerKey),
        // Reloads of a visit already shown always ask the server.
        useReadAhead: loadedSessionOwnerRef.current !== requestOwnerKey,
        readListUpdatedAt: () => activeScenarioRef.current?.updatedAt ?? null,
        isCurrent: isCurrentRequest,
      });
      if (!isCurrentRequest()) return false;
      initialScenarioDetailRef.current = null;
      if (requestMutationVersion !== graphMutationVersionRef.current)
        return false;
      if (!detail || detail.scenario._id !== activeScenarioId) return false;
      adoptLoadedScenarioDetail(detail, requestOwnerKey);
      return true;
    } catch (error) {
      if (abortController.signal.aborted || !isCurrentRequest()) return false;
      toast.error(resolveScenarioRequestErrorMessage(error, t, "openFailed"));
      return false;
    } finally {
      if (isCurrentRequest()) setLoadingFlow(false);
    }
  }, [
    activeScenarioId,
    activeScenarioRef,
    adoptLoadedScenarioDetail,
    sessionOwnerKey,
    sessionOwnerKeyRef,
    t,
    takeInitialScenarioDetail,
    workspaceId,
  ]);
  useEffect(() => {
    loadScenarioFlowRef.current = loadScenarioFlow;
  }, [loadScenarioFlow]);

  const adoptGeneratedJobServerUpdate = useCallback(
    (update: ScenarioGenerationJobServerUpdate): boolean => {
      if (!ownsLoadedSession(sessionOwnerKey)) return false;
      const scenarioId = activeScenarioIdRef.current;
      if (
        !scenarioId ||
        isDirtyRef.current ||
        update.scenarioRevisionConflict ||
        !update.generationJobId ||
        !update.previousScenarioUpdatedAt ||
        !update.scenarioUpdatedAt ||
        !canAdoptScenarioRevision(
          update.previousScenarioUpdatedAt,
          update.scenarioUpdatedAt
        )
      ) {
        return false;
      }

      const currentUpdatedAt = latestScenarioUpdatedAtRef.current;
      if (scenarioRevisionsMatch(currentUpdatedAt, update.scenarioUpdatedAt)) {
        return true;
      }
      if (
        !scenarioRevisionsMatch(
          currentUpdatedAt,
          update.previousScenarioUpdatedAt
        )
      ) {
        return false;
      }

      const currentNodes = nodesRef.current;
      const ownsGenerationRevision = currentNodes.some(node => {
        const data = node.data as ScenarioNodeData;
        return (
          data.kind === "bulk" &&
          data.bulkRootConfig?.generationJobId === update.generationJobId
        );
      });
      if (!ownsGenerationRevision) return false;

      const updatesById = new Map<string, ScenarioNodeData>();
      for (const nodeUpdate of update.nodeUpdates) {
        if (
          !nodeUpdate ||
          typeof nodeUpdate.id !== "string" ||
          !nodeUpdate.id ||
          !nodeUpdate.data
        ) {
          return false;
        }
        updatesById.set(nodeUpdate.id, nodeUpdate.data);
      }
      if (
        Array.from(updatesById.keys()).some(
          nodeId => !currentNodes.some(node => node.id === nodeId)
        )
      ) {
        return false;
      }

      const nextNodes =
        updatesById.size > 0
          ? currentNodes.map(node => {
              const data = updatesById.get(node.id);
              return data ? { ...node, data } : node;
            })
          : currentNodes;
      if (nextNodes !== currentNodes) {
        nodesRef.current = nextNodes;
        historyNodesRef.current = nextNodes;
        setNodes(nextNodes);
      }

      if (activeScenarioRef.current) {
        activeScenarioRef.current = {
          ...activeScenarioRef.current,
          updatedAt: update.scenarioUpdatedAt,
        };
      }
      adoptConfirmedScenarioRevision(scenarioId, update.scenarioUpdatedAt);
      return true;
    },
    [
      activeScenarioIdRef,
      activeScenarioRef,
      adoptConfirmedScenarioRevision,
      isDirtyRef,
      nodesRef,
      ownsLoadedSession,
      sessionOwnerKey,
      setNodes,
    ]
  );

  const showSaveConflictToast = useCallback(() => {
    toast.error(t("scenario_updated_conflict"), {
      action: {
        label: t("reloadScenarioAction"),
        onClick: () => {
          void loadScenarioFlow();
        },
      },
    });
  }, [loadScenarioFlow, t]);

  const markSaveConflict = useCallback(() => {
    hasSaveConflictRef.current = true;
    setHasSaveConflict(true);
    showSaveConflictToast();
  }, [hasSaveConflictRef, showSaveConflictToast]);

  const persistCurrentScenarioGraph = useCallback(
    (patch?: ScenarioSidebarPatch) => {
      const currentScenarioId = activeScenarioIdRef.current;
      const currentScenario = confirmedScenarioRef.current;
      if (
        !currentScenarioId ||
        !currentScenario ||
        currentScenario._id !== currentScenarioId ||
        !ownsLoadedSession(sessionOwnerKey)
      )
        return null;
      return updateScenarioRequest({
        scenarioId: currentScenarioId,
        workspaceId,
        expectedUpdatedAt: latestScenarioUpdatedAtRef.current,
        name: activeScenarioNameRef.current.trim() || t("defaultScenarioName"),
        description: activeScenarioDescriptionRef.current,
        status: activeScenarioStatusRef.current,
        priority: Number(entryPriorityInputRef.current),
        presetId: currentScenario.presetId ?? null,
        presetVersion: currentScenario.presetVersion ?? null,
        segmentKey: currentScenario.segmentKey ?? null,
        matchingRole: currentScenario.matchingRole ?? "default",
        entryPolicy:
          currentScenario.entryPolicy ?? DEFAULT_SCENARIO_ENTRY_POLICY,
        ...patch,
        nodes: nodesRef.current,
        edges: edgesRef.current,
        viewport:
          reactFlowInstanceRef.current?.getViewport() ||
          DEFAULT_SCENARIO_VIEWPORT,
      });
    },
    [
      activeScenarioDescriptionRef,
      activeScenarioIdRef,
      activeScenarioNameRef,
      activeScenarioStatusRef,
      entryPriorityInputRef,
      edgesRef,
      nodesRef,
      ownsLoadedSession,
      sessionOwnerKey,
      t,
      workspaceId,
    ]
  );

  const adoptSavedScenarioMetadata = useCallback(
    (updated: ScenarioDocument) => {
      confirmedScenarioRef.current = updated;
      activeScenarioRef.current = {
        ...updated,
        nodeCount: updated.nodes.length,
        edgeCount: updated.edges.length,
      };
      activeScenarioNameRef.current = updated.name;
      activeScenarioDescriptionRef.current = updated.description;
      activeScenarioStatusRef.current = updated.status;
      entryPriorityInputRef.current = String(updated.priority);
      onScenarioDocumentConfirmed(updated);
      applyScenarioEntryInputs({
        scenario: updated,
        setEntryPriorityInput,
      });
      latestScenarioUpdatedAtRef.current = updated.updatedAt;
      noteConfirmedScenarioRevision(
        latestScenarioUpdatedAtScenarioIdRef.current,
        updated.updatedAt
      );
      setHasSaveConflict(false);
      hasSaveConflictRef.current = false;
    },
    [
      activeScenarioRef,
      activeScenarioNameRef,
      activeScenarioDescriptionRef,
      activeScenarioStatusRef,
      entryPriorityInputRef,
      hasSaveConflictRef,
      onScenarioDocumentConfirmed,
      setEntryPriorityInput,
    ]
  );

  const reconcileGeneratedJobServerUpdate = useCallback(
    async (
      update: ScenarioGenerationJobServerUpdate
    ): Promise<ScenarioGenerationJobRefreshResult> => {
      if (!ownsLoadedSession(sessionOwnerKey)) return { status: "failed" };
      if (
        isGeneratedJobRefreshNoOp(update) &&
        (isDirtyRef.current ||
          scenarioRevisionsMatch(
            latestScenarioUpdatedAtRef.current,
            update.scenarioUpdatedAt
          ))
      ) {
        return { status: "no_op" };
      }
      if (isDirtyRef.current) {
        markSaveConflict();
        return { status: "conflict" };
      }
      if (adoptGeneratedJobServerUpdate(update)) {
        return { status: "applied" };
      }
      return (await loadScenarioFlow())
        ? { status: "applied" }
        : { status: "failed" };
    },
    [
      adoptGeneratedJobServerUpdate,
      isDirtyRef,
      loadScenarioFlow,
      markSaveConflict,
      ownsLoadedSession,
      sessionOwnerKey,
    ]
  );

  const saveScenario = useCallback(
    async function saveOwnedScenario(
      options?: ScenarioSaveOptions
    ): Promise<boolean> {
      const ownerKey = sessionOwnerKey;
      const currentScenarioId = activeScenarioIdRef.current;
      if (!currentScenarioId || !ownsLoadedSession(ownerKey)) return false;
      if (options?.patch?.status) {
        setValidationRequested(options.patch.status === "active");
      }
      const activeProviderMutation = providerMutationOperationRef.current;
      if (
        activeProviderMutation &&
        activeProviderMutation.id !== options?.providerMutationOperationId
      )
        return false;
      if (hasSaveConflictRef.current) {
        showSaveConflictToast();
        return false;
      }
      const inFlightSave = scenarioSaveOperationRef.current;
      if (inFlightSave?.ownerKey === ownerKey) {
        const saved = await inFlightSave.promise;
        if (!ownsLoadedSession(ownerKey)) return false;
        return options?.patch || (!options?.autosave && isDirtyRef.current)
          ? saveOwnedScenario(options)
          : saved;
      }
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }

      const savePromise = (async () => {
        try {
          do {
            if (!ownsLoadedSession(ownerKey)) return false;
            setSaveStatus("saving");
            const persistedMutationVersion = graphMutationVersionRef.current;
            setLastSaveAttemptVersion(persistedMutationVersion);
            const updated = await persistCurrentScenarioGraph(options?.patch);
            if (
              !ownsLoadedSession(ownerKey) ||
              (options?.providerMutationOperationId !== undefined &&
                providerMutationOperationRef.current?.id !==
                  options.providerMutationOperationId)
            )
              return false;
            if (!updated || updated._id !== currentScenarioId) return false;
            adoptSavedScenarioMetadata(updated);
            persistedMutationVersionRef.current = persistedMutationVersion;
            const hasNewerEdits =
              graphMutationVersionRef.current !==
              persistedMutationVersionRef.current;
            isDirtyRef.current = hasNewerEdits;
            setIsDirty(hasNewerEdits);
            setSaveStatus(hasNewerEdits ? "unsaved" : "saved");
            // Provider attachment must recheck its target before carrying on.
            if (options?.providerMutationOperationId !== undefined) return true;
          } while (
            !options?.autosave &&
            isDirtyRef.current &&
            !providerMutationOperationRef.current
          );
          return true;
        } catch (error) {
          if (!ownsLoadedSession(ownerKey)) return false;
          if (
            isScenarioRequestErrorWithCode(error, "scenario_updated_conflict")
          ) {
            markSaveConflict();
          } else {
            if (!options?.autosave) {
              revealValidationBlockedNode(
                getScenarioRequestErrorBlockNodeIds(error),
                ownerKey
              );
            }
            if (options?.patch?.status === "active") {
              // No activation event exists otherwise, so this measures the
              // real block rate along with the code that caused it.
              captureClientEvent("scenario_activation_blocked", {
                workspace_id: workspaceId,
                error_code: getScenarioRequestErrorCode(error) ?? "unknown",
              });
            }
            toast.error(
              resolveScenarioRequestErrorMessage(error, t, "saveFailed")
            );
          }
          setSaveStatus("unsaved");
          return false;
        }
      })();
      scenarioSaveOperationRef.current = {
        scenarioId: currentScenarioId,
        ownerKey,
        promise: savePromise,
      };
      try {
        return await savePromise;
      } finally {
        if (scenarioSaveOperationRef.current?.promise === savePromise) {
          scenarioSaveOperationRef.current = null;
        }
      }
    },
    [
      activeScenarioIdRef,
      adoptSavedScenarioMetadata,
      hasSaveConflictRef,
      isDirtyRef,
      markSaveConflict,
      ownsLoadedSession,
      persistCurrentScenarioGraph,
      revealValidationBlockedNode,
      sessionOwnerKey,
      showSaveConflictToast,
      t,
      workspaceId,
    ]
  );

  const flushScenario = useCallback(async (): Promise<boolean> => {
    const ownerKey = sessionOwnerKey;
    if (sessionOwnerKeyRef.current !== ownerKey) return false;
    if (!activeScenarioIdRef.current) return true;
    if (
      !ownsLoadedSession(ownerKey) ||
      hasSaveConflictRef.current ||
      providerMutationOperationRef.current
    )
      return false;
    const pendingSave = scenarioSaveOperationRef.current;
    if (pendingSave?.ownerKey === ownerKey && !(await pendingSave.promise))
      return false;
    if (!ownsLoadedSession(ownerKey)) return false;
    if (isDirtyRef.current && !(await saveScenario())) return false;
    return (
      ownsLoadedSession(ownerKey) &&
      !isDirtyRef.current &&
      !hasSaveConflictRef.current
    );
  }, [
    activeScenarioIdRef,
    hasSaveConflictRef,
    isDirtyRef,
    ownsLoadedSession,
    saveScenario,
    sessionOwnerKey,
    sessionOwnerKeyRef,
  ]);

  const coordinateActiveScenarioPatch = useCallback(
    async (patch: ScenarioSidebarPatch): Promise<boolean> => {
      const ownerKey = sessionOwnerKey;
      if (!ownsLoadedSession(ownerKey)) return false;
      const saved = await saveScenario({ patch });
      return (
        saved &&
        ownsLoadedSession(ownerKey) &&
        !isDirtyRef.current &&
        !hasSaveConflictRef.current
      );
    },
    [
      hasSaveConflictRef,
      isDirtyRef,
      ownsLoadedSession,
      saveScenario,
      sessionOwnerKey,
    ]
  );
  const prepareScenarioSelection = useCallback(async (): Promise<boolean> => {
    if (sessionOwnerKeyRef.current !== sessionOwnerKey) return false;
    if (!loadedSessionOwnerRef.current && !isDirtyRef.current) return true;
    return flushScenario();
  }, [flushScenario, isDirtyRef, sessionOwnerKey, sessionOwnerKeyRef]);
  /** Leaving now would write nothing: no save is due, running or blocked. */
  const isScenarioGraphSettled = useCallback(
    () =>
      !isDirtyRef.current &&
      !hasSaveConflictRef.current &&
      scenarioSaveOperationRef.current === null &&
      providerMutationOperationRef.current === null,
    [hasSaveConflictRef, isDirtyRef]
  );

  // A bulk send can turn this scenario on server-side. Save pending edits
  // first, so the send checks this graph, then hold other saves (and scenario
  // switches) until the returned release runs after the send's revision is
  // adopted; a save in between would carry the old revision and conflict.
  const prepareScenarioBulkSend = useCallback(async (): Promise<
    (() => void) | null
  > => {
    const ownerKey = sessionOwnerKey;
    const scenarioId = activeScenarioIdRef.current;
    if (!scenarioId || !(await flushScenario())) return null;
    if (!ownsLoadedSession(ownerKey)) return null;
    let settle: ((saved: boolean) => void) | null = null;
    const operation = {
      scenarioId,
      ownerKey,
      promise: new Promise<boolean>(resolve => {
        settle = resolve;
      }),
    };
    scenarioSaveOperationRef.current = operation;
    setBulkSendsInFlight(count => count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (scenarioSaveOperationRef.current === operation) {
        scenarioSaveOperationRef.current = null;
      }
      setBulkSendsInFlight(count => count - 1);
      settle?.(true);
    };
  }, [activeScenarioIdRef, flushScenario, ownsLoadedSession, sessionOwnerKey]);

  const prepareManagedWhatsAppFlowTarget = useCallback(
    async (
      params: {
        nodeId: string;
        sourceId: string;
        editableConfig: EditableWhatsAppFlowConfig;
      },
      operationId: number
    ) => {
      const ownerKey = sessionOwnerKey;
      const currentScenarioId = activeScenarioIdRef.current;
      if (!currentScenarioId || !ownsLoadedSession(ownerKey)) {
        throw new Error(
          "A persisted scenario is required to publish this Flow"
        );
      }
      const requestedNode = nodesRef.current.find(
        node => node.id === params.nodeId
      );
      const requestedTarget = requestedNode
        ? resolveScenarioWhatsAppInteractiveFlowTarget(requestedNode.data)
        : null;
      const requestedDigest = requestedTarget
        ? createWhatsAppFlowEditableContentDigest(requestedTarget.config)
        : null;
      const needsSave = isDirtyRef.current || scenarioSaveOperationRef.current;
      const ready =
        !hasSaveConflictRef.current &&
        (!needsSave ||
          (await saveScenario({ providerMutationOperationId: operationId })));
      if (!ready || !ownsLoadedSession(ownerKey)) {
        throw new Error(
          "Scenario changed; save the scenario before publishing this Flow"
        );
      }
      const currentNode = nodesRef.current.find(
        node => node.id === params.nodeId
      );
      if (!currentNode)
        throw new Error("The Flow action node no longer exists");
      const currentTarget = resolveScenarioWhatsAppInteractiveFlowTarget(
        currentNode.data
      );
      if (
        !requestedDigest ||
        !currentTarget ||
        createWhatsAppFlowEditableContentDigest(currentTarget.config) !==
          requestedDigest
      ) {
        throw new Error("Flow content changed while preparing this Flow");
      }
      const projectedNode = applyScenarioWhatsAppInteractiveFlowConfigToNode(
        currentNode,
        params.editableConfig
      );
      if (projectedNode === currentNode)
        throw new Error("The Flow action target is no longer editable");
      replaceNodeById(params.nodeId, projectedNode);
      markFlowDirty();
      const saved = await saveScenario({
        providerMutationOperationId: operationId,
      });
      if (!ownsLoadedSession(ownerKey))
        throw new Error("Scenario changed while preparing this Flow");
      if (!saved || isDirtyRef.current)
        throw new Error("Failed to persist the Flow before publishing");
      const savedTarget = nodesRef.current.find(
        node => node.id === params.nodeId
      );
      const currentConfig = savedTarget
        ? resolveScenarioWhatsAppInteractiveFlowTarget(savedTarget.data)?.config
        : null;
      if (
        !currentConfig ||
        createWhatsAppFlowEditableContentDigest(currentConfig) !==
          createWhatsAppFlowEditableContentDigest(params.editableConfig)
      ) {
        throw new Error("Flow content changed while preparing this Flow");
      }
      return {
        scenarioId: currentScenarioId,
        nodeId: params.nodeId,
        sourceId: params.sourceId,
      };
    },
    [
      activeScenarioIdRef,
      hasSaveConflictRef,
      isDirtyRef,
      markFlowDirty,
      nodesRef,
      ownsLoadedSession,
      replaceNodeById,
      saveScenario,
      sessionOwnerKey,
    ]
  );
  const adoptManagedWhatsAppFlowProvisioningResult = useCallback(
    (params: {
      nodeId: string;
      result: WhatsAppFlowProvisioningResult;
    }): boolean => {
      if (!ownsLoadedSession(sessionOwnerKey)) return false;
      const projection = params.result.projection;
      const scenarioRevision = params.result.scenarioRevision;
      if (
        !projection ||
        !scenarioRevision ||
        params.result.operationId !== projection.operationId ||
        !canAdoptScenarioRevision(
          latestScenarioUpdatedAtRef.current,
          scenarioRevision.finalUpdatedAt
        )
      ) {
        return false;
      }
      const currentNode = nodesRef.current.find(
        node => node.id === params.nodeId
      );
      if (!currentNode) return false;
      try {
        const currentTarget = resolveScenarioWhatsAppInteractiveFlowTarget(
          currentNode.data
        );
        if (
          !currentTarget ||
          createWhatsAppFlowEditableContentDigest(currentTarget.config) !==
            projection.contentDigest
        ) {
          return false;
        }
        const projectedNode =
          applyManagedWhatsAppFlowProvisioningProjectionToNode(
            currentNode,
            projection
          );
        if (!projectedNode) return false;
        replaceNodeById(params.nodeId, projectedNode);
        latestScenarioUpdatedAtRef.current = scenarioRevision.finalUpdatedAt;
        noteConfirmedScenarioRevision(
          latestScenarioUpdatedAtScenarioIdRef.current,
          scenarioRevision.finalUpdatedAt
        );
        setScenarios(current =>
          current.map(scenario =>
            scenario._id === activeScenarioIdRef.current
              ? { ...scenario, updatedAt: scenarioRevision.finalUpdatedAt }
              : scenario
          )
        );
        setHasSaveConflict(false);
        hasSaveConflictRef.current = false;
        return true;
      } catch {
        return false;
      }
    },
    [
      activeScenarioIdRef,
      hasSaveConflictRef,
      nodesRef,
      ownsLoadedSession,
      replaceNodeById,
      sessionOwnerKey,
      setScenarios,
    ]
  );

  const publishManagedWhatsAppFlow = useCallback(
    async (params: {
      nodeId: string;
      sourceId: string;
      editableConfig: EditableWhatsAppFlowConfig;
    }): Promise<ManagedWhatsAppFlowPublication | null> => {
      const ownerKey = sessionOwnerKey;
      const scenarioId = activeScenarioIdRef.current;
      if (!scenarioId || !ownsLoadedSession(ownerKey)) return null;
      if (providerMutationOperationRef.current) return null;
      if (hasSaveConflictRef.current)
        throw new Error(
          "Scenario changed; refresh before publishing this Flow"
        );
      const operation = {
        id: ++providerMutationSequenceRef.current,
        scenarioId,
        nodeId: params.nodeId,
        kind: "managed_flow" as const,
      };
      const ownsOperation = () =>
        providerMutationOperationRef.current?.id === operation.id;
      const ownsSession = () => ownsOperation() && ownsLoadedSession(ownerKey);
      providerMutationOperationRef.current = operation;
      setProviderMutationInFlight(true);
      setSaveStatus("saving");
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
      try {
        const target = await prepareManagedWhatsAppFlowTarget(
          params,
          operation.id
        );
        if (!ownsSession()) return null;
        const response = await provisionWhatsAppFlow({
          workspaceId,
          ...target,
          editableConfig: params.editableConfig,
        });
        if (!ownsSession()) {
          if (ownsOperation() && activeScenarioIdRef.current === scenarioId) {
            if (!isDirtyRef.current) await loadScenarioFlowRef.current();
            else {
              hasSaveConflictRef.current = true;
              setHasSaveConflict(true);
            }
          }
          return null;
        }
        const data = response.data;
        const adopted =
          !!data?.projection &&
          adoptManagedWhatsAppFlowProvisioningResult({
            nodeId: params.nodeId,
            result: data,
          });
        if (data?.projection && !adopted) markSaveConflict();
        return { response, adopted };
      } catch (error) {
        if (!ownsSession()) return null;
        throw error;
      } finally {
        endProviderMutation(ownsOperation(), scenarioId);
      }
    },
    [
      activeScenarioIdRef,
      adoptManagedWhatsAppFlowProvisioningResult,
      endProviderMutation,
      hasSaveConflictRef,
      isDirtyRef,
      markSaveConflict,
      ownsLoadedSession,
      prepareManagedWhatsAppFlowTarget,
      sessionOwnerKey,
      workspaceId,
    ]
  );

  const attachWhatsAppFlowProviderReferenceToNode = useCallback(
    async (params: {
      nodeId: string;
      sourceId: string;
      flowId: string;
    }): Promise<WhatsAppFlowConfig> => {
      const ownerKey = sessionOwnerKey;
      const currentScenarioId = activeScenarioIdRef.current;
      if (!currentScenarioId || !ownsLoadedSession(ownerKey)) {
        throw new Error(
          "A persisted scenario is required to attach this WhatsApp Flow"
        );
      }
      if (hasSaveConflictRef.current) {
        showSaveConflictToast();
        throw new Error(
          "Scenario changed; refresh before attaching this WhatsApp Flow"
        );
      }
      if (providerMutationOperationRef.current) {
        throw new Error(
          "Another scenario provider operation is already running"
        );
      }

      const operation = {
        id: ++providerMutationSequenceRef.current,
        scenarioId: currentScenarioId,
        kind: "flow_attachment" as const,
        nodeId: params.nodeId,
      };
      const isCurrentOperation = () =>
        providerMutationOperationRef.current?.id === operation.id &&
        ownsLoadedSession(ownerKey);
      providerMutationOperationRef.current = operation;
      setProviderMutationInFlight(true);
      setSaveStatus("saving");
      let attachmentConflicted = false;
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }

      try {
        if (isDirtyRef.current) {
          const saved = await saveScenario({
            providerMutationOperationId: operation.id,
          });
          if (
            !isCurrentOperation() ||
            activeScenarioIdRef.current !== currentScenarioId
          ) {
            throw new Error(
              "Scenario changed while attaching this WhatsApp Flow"
            );
          }
          if (!saved || isDirtyRef.current || hasSaveConflictRef.current) {
            throw new Error(
              "Save the scenario before attaching this WhatsApp Flow"
            );
          }
        }

        const expectedUpdatedAt = latestScenarioUpdatedAtRef.current;
        if (!expectedUpdatedAt) {
          throw new Error(
            "Scenario revision is unavailable; refresh and retry"
          );
        }

        const requestedMutationVersion = graphMutationVersionRef.current;
        const requestedNode = nodesRef.current.find(
          node => node.id === params.nodeId
        );
        const requestedTarget = requestedNode
          ? resolveScenarioWhatsAppInteractiveFlowTarget(requestedNode.data)
          : null;
        const requestedContentDigest = requestedTarget
          ? createWhatsAppFlowEditableContentDigest(requestedTarget.config)
          : null;

        const response = await attachWhatsAppFlowProviderReference({
          workspaceId,
          scenarioId: currentScenarioId,
          nodeId: params.nodeId,
          sourceId: params.sourceId,
          flowId: params.flowId,
          expectedUpdatedAt,
        });
        const data = response.data;
        if (!isCurrentOperation()) {
          if (data?.ok) return data.flowConfig;
          throw new Error(
            "Scenario changed while attaching this WhatsApp Flow"
          );
        }
        if (!response.ok || !data || !data.ok) {
          const code = data && !data.ok ? data.error.code : "";
          if (code === "SCENARIO_REVISION_CONFLICT") {
            attachmentConflicted = true;
            setSaveStatus("unsaved");
            markSaveConflict();
          }
          throw new Error(
            data && !data.ok
              ? data.error.message
              : "Failed to attach the WhatsApp Flow"
          );
        }

        if (
          !isCurrentOperation() ||
          activeScenarioIdRef.current !== currentScenarioId
        ) {
          return data.flowConfig;
        }

        const hasConcurrentLocalChanges =
          graphMutationVersionRef.current !== requestedMutationVersion ||
          isDirtyRef.current;
        const responseMatchesRequestedRevision =
          scenarioRevisionsMatch(
            latestScenarioUpdatedAtRef.current,
            data.previousScenarioUpdatedAt
          ) &&
          canAdoptScenarioRevision(
            data.previousScenarioUpdatedAt,
            data.scenarioUpdatedAt
          );
        const canAdopt =
          !hasConcurrentLocalChanges && responseMatchesRequestedRevision;
        const currentNode = nodesRef.current.find(
          node => node.id === params.nodeId
        );
        const currentTarget = currentNode
          ? resolveScenarioWhatsAppInteractiveFlowTarget(currentNode.data)
          : null;
        const canMergeIntoCurrentTarget =
          requestedTarget !== null &&
          currentTarget?.owner === requestedTarget.owner &&
          requestedContentDigest !== null &&
          createWhatsAppFlowEditableContentDigest(currentTarget.config) ===
            requestedContentDigest;
        const projectedNode = currentNode
          ? canAdopt || canMergeIntoCurrentTarget
            ? applyScenarioWhatsAppInteractiveFlowSelectionToNode(
                currentNode,
                data.flowConfig
              )
            : null
          : null;

        if (hasConcurrentLocalChanges) {
          if (
            responseMatchesRequestedRevision &&
            projectedNode &&
            projectedNode !== currentNode
          ) {
            replaceNodeById(params.nodeId, projectedNode);
          }
          if (responseMatchesRequestedRevision) {
            adoptConfirmedScenarioRevision(
              currentScenarioId,
              data.scenarioUpdatedAt
            );
          }
          setSaveStatus("unsaved");
          return data.flowConfig;
        }
        if (
          !canAdopt ||
          !currentNode ||
          !projectedNode ||
          projectedNode === currentNode
        ) {
          const reloaded = await loadScenarioFlow();
          if (
            !isCurrentOperation() ||
            activeScenarioIdRef.current !== currentScenarioId
          ) {
            return data.flowConfig;
          }
          if (!reloaded) {
            setSaveStatus("unsaved");
            throw new Error(
              "WhatsApp Flow was attached, but the scenario could not be refreshed"
            );
          }
          return data.flowConfig;
        }

        replaceNodeById(params.nodeId, projectedNode);
        adoptConfirmedScenarioRevision(
          currentScenarioId,
          data.scenarioUpdatedAt
        );
        isDirtyRef.current = false;
        setIsDirty(false);
        setHasSaveConflict(false);
        hasSaveConflictRef.current = false;
        setSaveStatus("saved");
        return data.flowConfig;
      } finally {
        if (providerMutationOperationRef.current?.id === operation.id) {
          providerMutationOperationRef.current = null;
          setProviderMutationInFlight(false);
          if (activeScenarioIdRef.current === currentScenarioId) {
            setSaveStatus(
              attachmentConflicted ||
                isDirtyRef.current ||
                hasSaveConflictRef.current
                ? "unsaved"
                : "saved"
            );
          }
        }
      }
    },
    [
      activeScenarioIdRef,
      adoptConfirmedScenarioRevision,
      hasSaveConflictRef,
      isDirtyRef,
      loadScenarioFlow,
      markSaveConflict,
      nodesRef,
      ownsLoadedSession,
      replaceNodeById,
      saveScenario,
      sessionOwnerKey,
      showSaveConflictToast,
      workspaceId,
    ]
  );

  const submitGeneratedTemplateForNode = useCallback(
    async (nodeId: string): Promise<boolean> => {
      const ownerKey = sessionOwnerKey;
      const scenarioId = activeScenarioIdRef.current;
      if (!scenarioId || !ownsLoadedSession(ownerKey)) return false;
      if (providerMutationOperationRef.current) return false;
      if (hasSaveConflictRef.current) {
        throw new Error(
          "Scenario changed; refresh before submitting the template"
        );
      }
      const requestedNode = nodesRef.current.find(node => node.id === nodeId);
      const draft = requestedNode?.data.generatedTemplateDraft;
      if (
        !requestedNode ||
        !draft ||
        !["draft", "rejected"].includes(draft.status)
      ) {
        throw new Error("Generated template draft is not ready");
      }
      const targetDigest = createGeneratedTemplateTargetDigest(
        requestedNode.data
      );
      const operation = {
        id: ++providerMutationSequenceRef.current,
        scenarioId,
        nodeId,
        kind: "generated_template" as const,
      };
      const ownsOperation = () =>
        providerMutationOperationRef.current?.id === operation.id;
      const ownsSession = () => ownsOperation() && ownsLoadedSession(ownerKey);
      const ownsTarget = () => {
        const node = nodesRef.current.find(node => node.id === nodeId);
        return (
          ownsSession() &&
          !!node &&
          createGeneratedTemplateTargetDigest(node.data) === targetDigest
        );
      };
      providerMutationOperationRef.current = operation;
      setProviderMutationInFlight(true);
      setSaveStatus("saving");
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
      try {
        if (isDirtyRef.current || scenarioSaveOperationRef.current) {
          const saved = await saveScenario({
            providerMutationOperationId: operation.id,
          });
          if (!ownsTarget()) return false;
          if (!saved || isDirtyRef.current || hasSaveConflictRef.current) {
            throw new Error("Save the scenario before submitting the template");
          }
        }
        const expectedUpdatedAt = latestScenarioUpdatedAtRef.current;
        if (!expectedUpdatedAt)
          throw new Error(
            "Scenario revision is unavailable; refresh and retry"
          );
        let update: GeneratedTemplateScenarioUpdate | undefined;
        let submissionError: unknown;
        try {
          const response = await submitGeneratedScenarioTemplateRequest({
            workspaceId,
            scenarioId,
            nodeId,
            expectedUpdatedAt,
          });
          update = response.scenarioUpdate;
        } catch (error) {
          submissionError = error;
          if (error instanceof GeneratedTemplateSubmissionError)
            update = error.scenarioUpdate;
        }
        if (!ownsSession()) {
          // A fresh visit may have loaded the graph before this commit. Refresh
          // through the current session owner; its loader preserves newer edits.
          if (ownsOperation() && activeScenarioIdRef.current === scenarioId) {
            if (!isDirtyRef.current) await loadScenarioFlowRef.current();
            else {
              // Preserve edits in a newer visit without accepting an old visit's
              // revision. Explicit refresh must resolve this ambiguous baseline.
              hasSaveConflictRef.current = true;
              setHasSaveConflict(true);
            }
          }
          return false;
        }
        const targetUnchanged = ownsTarget();
        if (update) {
          if (
            update.nodeId !== nodeId ||
            !scenarioRevisionsMatch(
              latestScenarioUpdatedAtRef.current,
              update.previousScenarioUpdatedAt
            ) ||
            !canAdoptScenarioRevision(
              update.previousScenarioUpdatedAt,
              update.scenarioUpdatedAt
            )
          ) {
            markSaveConflict();
            throw new Error(
              "Template submission changed the scenario; refresh before saving"
            );
          }
          if (targetUnchanged) {
            const nextNodes = nodesRef.current.map(node =>
              node.id === nodeId
                ? { ...node, data: { ...node.data, ...update.patch } }
                : node
            );
            nodesRef.current = nextNodes;
            historyNodesRef.current = nextNodes;
            setNodes(nextNodes);
          }
          const confirmed = confirmedScenarioRef.current;
          if (confirmed?._id === scenarioId) {
            confirmedScenarioRef.current = {
              ...confirmed,
              updatedAt: update.scenarioUpdatedAt,
              nodes: confirmed.nodes.map(node =>
                node.id === nodeId
                  ? { ...node, data: { ...node.data, ...update.patch } }
                  : node
              ),
            };
          }
          adoptConfirmedScenarioRevision(scenarioId, update.scenarioUpdatedAt);
        } else if (
          submissionError instanceof GeneratedTemplateSubmissionError &&
          (submissionError.status === 409 ||
            (submissionError.status >= 200 && submissionError.status < 300))
        ) {
          markSaveConflict();
        }
        if (!targetUnchanged) return false;
        if (submissionError) throw submissionError;
        return true;
      } catch (error) {
        if (!ownsSession()) return false;
        throw error;
      } finally {
        endProviderMutation(ownsOperation(), scenarioId);
      }
    },
    [
      activeScenarioIdRef,
      adoptConfirmedScenarioRevision,
      endProviderMutation,
      hasSaveConflictRef,
      isDirtyRef,
      markSaveConflict,
      nodesRef,
      ownsLoadedSession,
      saveScenario,
      sessionOwnerKey,
      setNodes,
      workspaceId,
    ]
  );

  const prepareGeneratedJobRefresh = useCallback(async (): Promise<boolean> => {
    if (!ownsLoadedSession(sessionOwnerKey)) return false;
    if (!isDirtyRef.current && !hasSaveConflictRef.current) {
      return true;
    }
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    const saved = await saveScenario();
    return saved && !isDirtyRef.current && !hasSaveConflictRef.current;
  }, [
    hasSaveConflictRef,
    isDirtyRef,
    ownsLoadedSession,
    saveScenario,
    sessionOwnerKey,
  ]);

  const applyActionRoutingPatchLocally = useCallback(
    (
      sourceActionNodeId: string,
      patch: ScenarioActionRoutingPatch
    ): boolean => {
      const hasOutcomes = Object.prototype.hasOwnProperty.call(
        patch,
        "actionOutcomes"
      );
      const hasRunConditions = Object.prototype.hasOwnProperty.call(
        patch,
        "actionRunConditions"
      );
      if (!hasOutcomes && !hasRunConditions) return true;

      const currentNodes = nodesRef.current;
      const actionNode = currentNodes.find(
        node => node.id === sourceActionNodeId
      );
      if (!actionNode || actionNode.data.kind !== "action") return false;

      const nextData: ScenarioNodeData = {
        ...actionNode.data,
        ...(hasOutcomes ? { actionOutcomes: patch.actionOutcomes } : {}),
        ...(hasRunConditions
          ? { actionRunConditions: patch.actionRunConditions }
          : {}),
      };
      const nextNodes = currentNodes.map(node =>
        node.id === sourceActionNodeId ? { ...node, data: nextData } : node
      );
      const currentEdges = edgesRef.current;
      const nextEdges = hasOutcomes
        ? removeUnconfiguredActionOutcomeEdges({
            nodeId: sourceActionNodeId,
            nodeData: nextData,
            edges: currentEdges,
          })
        : currentEdges;

      captureGraphHistory();
      nodesRef.current = nextNodes;
      edgesRef.current = nextEdges;
      historyNodesRef.current = nextNodes;
      historyEdgesRef.current = nextEdges;
      setNodes(nextNodes);
      setEdges(nextEdges);
      markFlowDirty();
      return true;
    },
    [captureGraphHistory, edgesRef, markFlowDirty, nodesRef, setEdges, setNodes]
  );

  const convertLegacyActionRouting = useLegacyRoutingConversion({
    workspaceId,
    host: {
      readState: () => ({
        scenarioId: activeScenarioIdRef.current,
        expectedUpdatedAt: latestScenarioUpdatedAtRef.current,
        sessionKey: readScenarioFlowSessionKey(),
        ownershipKey: readScenarioFlowOwnershipKey(),
        isDirty: isDirtyRef.current,
        hasConflict: hasSaveConflictRef.current,
      }),
      cancelPendingAutosave: () => {
        if (!autoSaveTimerRef.current) return;
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      },
      saveScenario,
      applyActionRoutingPatch: applyActionRoutingPatchLocally,
      adoptConvertedScenario: (
        scenarioId,
        converted,
        sourceActionNodeId,
        metadata,
        ownershipKey
      ) => {
        if (
          activeScenarioIdRef.current !== scenarioId ||
          readScenarioFlowOwnershipKey() !== ownershipKey
        ) {
          return false;
        }
        adoptScenarioFlow(converted, {
          viewport:
            reactFlowInstanceRef.current?.getViewport() ??
            lastViewportRef.current,
          selectedNodeId: sourceActionNodeId,
          metadata,
        });
        return true;
      },
      onConflict: () => {
        markSaveConflict();
      },
      onError: error => {
        // A repeated conversion failure replaces its toast instead of stacking.
        toast.error(
          resolveScenarioRequestErrorMessage(error, t, "saveFailed"),
          {
            id: `scenario-legacy-routing-conversion:${activeScenarioIdRef.current ?? ""}`,
          }
        );
      },
      onWarning: warning => {
        const scenarioId = activeScenarioIdRef.current;
        if (scenarioId) showScenarioDetailWarning(warning, scenarioId);
      },
      onStatusChange: setSaveStatus,
      onConversionAbandoned: () => {
        // Operations that will settle this session's status keep it.
        if (
          scenarioSaveOperationRef.current?.ownerKey ===
            sessionOwnerKeyRef.current ||
          providerMutationOperationRef.current?.scenarioId ===
            activeScenarioIdRef.current
        )
          return;
        setSaveStatus(current =>
          current === "saving"
            ? isDirtyRef.current || hasSaveConflictRef.current
              ? "unsaved"
              : "saved"
            : current
        );
      },
    },
  });

  useEffect(() => {
    void loadScenarioFlow();
  }, [loadScenarioFlow]);

  useEffect(() => {
    return () => {
      scenarioFlowAbortControllerRef.current?.abort();
      scenarioFlowRequestTokenRef.current += 1;
      loadedSessionOwnerRef.current = null;
      providerMutationOperationRef.current = null;
    };
  }, []);

  const deleteCanvasSelection = useCallback(() => {
    if (!ownsLoadedSession(sessionOwnerKey)) return false;
    const { edgeIds: selectedEdgeIds, nodeIds: selectedNodeIds } =
      resolveCanvasDeleteSelection({
        reactFlowInstance: reactFlowInstanceRef.current,
        trackedNodeIds: selectedCanvasNodeIdsRef.current,
        trackedEdgeIds: selectedCanvasEdgeIdsRef.current,
      });

    if (selectedNodeIds.size === 0 && selectedEdgeIds.size === 0) {
      return false;
    }

    let currentNodes = nodesRef.current;
    let currentEdges = edgesRef.current;
    const deleteOnlyEdges = selectedEdgeIds.size > 0;
    const nodeIdsToDelete = deleteOnlyEdges
      ? new Set<string>()
      : selectedNodeIds;
    const deletableNodeIdsToDelete = new Set(
      currentNodes
        .filter(
          node => nodeIdsToDelete.has(node.id) && node.deletable !== false
        )
        .map(node => node.id)
    );
    const preparedDeletion = prepareLegacyRoutingGraphForDeletion({
      graph: {
        nodes: currentNodes,
        edges: currentEdges,
      } as LegacyActionRoutingGraph,
      nodeIds: deletableNodeIdsToDelete,
      edgeIds: selectedEdgeIds,
    });
    currentNodes = preparedDeletion.graph.nodes as ScenarioFlowNode[];
    currentEdges = preparedDeletion.graph.edges as ScenarioFlowEdge[];
    const preparedNodeIdsToDelete = preparedDeletion.nodeIds;
    const edgeIdsToDelete = new Set<string>();

    for (const edge of currentEdges) {
      if (edge.deletable === false) continue;

      const selectedForDelete = selectedEdgeIds.has(edge.id);
      const connectedToDeletedNode =
        !deleteOnlyEdges &&
        (preparedNodeIdsToDelete.has(edge.source) ||
          preparedNodeIdsToDelete.has(edge.target));

      if (selectedForDelete || connectedToDeletedNode) {
        edgeIdsToDelete.add(edge.id);
      }
    }

    if (preparedNodeIdsToDelete.size === 0 && edgeIdsToDelete.size === 0) {
      return false;
    }

    const edgeChanges: EdgeChange<ScenarioFlowEdge>[] = Array.from(
      edgeIdsToDelete
    ).map(id => ({ id, type: "remove" }));
    const nextEdges =
      edgeChanges.length > 0
        ? applyEdgeChanges(edgeChanges, currentEdges)
        : currentEdges;
    const nodesAfterEdgeNormalization =
      edgeChanges.length > 0
        ? normalizeNodesAfterEdgeChanges({
            changes: edgeChanges,
            currentEdges,
            nextEdges,
            currentNodes,
          })
        : currentNodes;
    const nodeChanges: NodeChange<ScenarioFlowNode>[] = Array.from(
      preparedNodeIdsToDelete
    ).map(id => ({ id, type: "remove" }));
    const nextNodes =
      nodeChanges.length > 0
        ? applyNodeChanges(nodeChanges, nodesAfterEdgeNormalization)
        : nodesAfterEdgeNormalization;

    commitCanvasSelection(new Set(), new Set());
    if (!deleteOnlyEdges) {
      setSelectedNodeId(null);
    }
    return editGraph(() => ({
      nodes: clearScenarioNodeSelection(nextNodes, { forceClone: true }),
      edges: clearScenarioEdgeSelection(nextEdges, { forceClone: true }),
      history: "record",
    }));
  }, [
    commitCanvasSelection,
    editGraph,
    edgesRef,
    nodesRef,
    ownsLoadedSession,
    sessionOwnerKey,
    setSelectedNodeId,
  ]);

  useLayoutEffect(() => {
    if (loadedSessionOwnerRef.current !== sessionOwnerKey) {
      scenarioFlowRequestTokenRef.current += 1;
      scenarioFlowAbortControllerRef.current?.abort();
      scenarioFlowAbortControllerRef.current = null;
      setSaveStatus("saved");
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
      loadedSessionOwnerRef.current = null;
      confirmedScenarioRef.current = null;
      latestScenarioUpdatedAtRef.current = null;
      isDirtyRef.current = false;
      setIsDirty(false);
      setHasSaveConflict(false);
      hasSaveConflictRef.current = false;
      graphMutationVersionRef.current = 0;
      setEditVersion(0);
      setLastSaveAttemptVersion(-1);
      setValidationRequested(false);
      persistedMutationVersionRef.current = 0;
      graphHistoryRef.current = [];
      graphFutureRef.current = [];
      pendingLayoutMeasurementsRef.current.clear();
      pendingPositionHistorySnapshotRef.current = null;
      dragHistoryCompletedBeforeNodeChangeRef.current = false;
      historyNodesRef.current = [];
      historyEdgesRef.current = [];
      commitCanvasSelection(new Set(), new Set());
      setSelectedNodeId(null);
      nodesRef.current = [];
      edgesRef.current = [];
      setNodes([]);
      setEdges([]);
      setLoadingFlow(Boolean(activeScenarioId));
      if (providerMutationOperationRef.current?.kind === "flow_attachment") {
        providerMutationOperationRef.current = null;
        setProviderMutationInFlight(false);
      }
      latestScenarioUpdatedAtScenarioIdRef.current = activeScenarioId;
      return;
    }
  }, [
    activeScenarioId,
    commitCanvasSelection,
    edgesRef,
    hasSaveConflictRef,
    isDirtyRef,
    nodesRef,
    sessionOwnerKey,
    setEdges,
    setNodes,
  ]);

  const onViewportChange = useCallback(
    (viewport: Viewport) => {
      if (viewportsEqual(lastViewportRef.current, viewport)) {
        return;
      }

      lastViewportRef.current = viewport;
      pendingViewportRef.current = viewport;
      if (activeScenarioId) {
        viewportByScenarioIdRef.current[activeScenarioId] = viewport;
      }
    },
    [activeScenarioId]
  );

  useScenarioKeyboardShortcuts({
    deleteCanvasSelection,
    saveScenario,
    undoGraphChange,
    redoGraphChange,
  });
  useScenarioAutosave({
    autoSaveTimerRef,
    editVersion,
    lastSaveAttemptVersion,
    hasSaveConflict,
    isDirty,
    saveScenario,
    setSaveStatus,
    suspended:
      providerMutationInFlight ||
      bulkSendsInFlight > 0 ||
      loadingFlow ||
      saveStatus === "saving" ||
      nodes.some(node => node.dragging),
  });

  const onNodesChange = useCallback(
    (changes: NodeChange<ScenarioFlowNode>[]) => {
      if (!ownsLoadedSession(sessionOwnerKey)) return;
      const selectedNodeIds = new Set(selectedCanvasNodeIdsRef.current);
      for (const change of changes) {
        if (change.type === "select") {
          if (change.selected) selectedNodeIds.add(change.id);
          else selectedNodeIds.delete(change.id);
        } else if (change.type === "remove") selectedNodeIds.delete(change.id);
      }
      commitCanvasSelection(selectedNodeIds, selectedCanvasEdgeIdsRef.current);
      const graphChanges = changes.filter(change => change.type !== "select");
      if (graphChanges.length === 0) return;

      if (hasUndoableNonPositionNodeChanges(graphChanges)) {
        captureGraphHistory();
      } else if (hasActivePositionNodeChanges(graphChanges)) {
        dragHistoryCompletedBeforeNodeChangeRef.current = false;
        pendingPositionHistorySnapshotRef.current ??= createGraphSnapshot();
      }

      if (hasCompletedPositionNodeChanges(graphChanges)) {
        if (!dragHistoryCompletedBeforeNodeChangeRef.current) {
          pushGraphHistorySnapshot(
            pendingPositionHistorySnapshotRef.current ?? createGraphSnapshot()
          );
        }
        dragHistoryCompletedBeforeNodeChangeRef.current = false;
        pendingPositionHistorySnapshotRef.current = null;
      }

      if (
        graphChanges.some(
          change => change.type === "position" || change.type === "remove"
        ) ||
        !autoLayoutEnabledRef.current
      ) {
        pendingLayoutMeasurementsRef.current.clear();
      }
      let nextNodes = applyNodeChanges(graphChanges, nodesRef.current);
      let completedMeasuredLayout = false;
      const measuredNodeById =
        pendingLayoutMeasurementsRef.current.size > 0
          ? new Map(nextNodes.map(node => [node.id, node]))
          : null;
      if (
        pendingLayoutMeasurementsRef.current.size > 0 &&
        [...pendingLayoutMeasurementsRef.current].every(id => {
          const node = measuredNodeById?.get(id);
          return Boolean(node?.measured?.width && node.measured?.height);
        })
      ) {
        // Finish the same structural edit once React Flow knows the new card's
        // size. Later editor expansion and manual placement do not reflow it.
        pendingLayoutMeasurementsRef.current.clear();
        const displayGraph = projectLegacyActionRoutingForDisplay({
          nodes: nextNodes,
          edges: edgesRef.current,
        } as LegacyActionRoutingGraph);
        const positions = computeNormalizedScenarioNodePositions(
          displayGraph.nodes as ScenarioFlowNode[],
          displayGraph.edges as ScenarioFlowEdge[]
        );
        nextNodes = applyNormalizedScenarioPositions(nextNodes, positions);
        completedMeasuredLayout = true;
      }
      commitGraphSnapshot({ nodes: nextNodes, edges: edgesRef.current });
      if (
        completedMeasuredLayout ||
        hasStructuralNodeChanges(graphChanges) ||
        hasCompletedPositionNodeChanges(graphChanges)
      ) {
        markFlowDirty();
      }
    },
    [
      autoLayoutEnabledRef,
      captureGraphHistory,
      commitCanvasSelection,
      commitGraphSnapshot,
      createGraphSnapshot,
      markFlowDirty,
      pushGraphHistorySnapshot,
      edgesRef,
      nodesRef,
      ownsLoadedSession,
      sessionOwnerKey,
    ]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<ScenarioFlowEdge>[]) => {
      if (!ownsLoadedSession(sessionOwnerKey)) return;
      const selectedEdgeIds = new Set(selectedCanvasEdgeIdsRef.current);
      for (const change of changes) {
        if (change.type === "select") {
          if (change.selected) selectedEdgeIds.add(change.id);
          else selectedEdgeIds.delete(change.id);
        } else if (change.type === "remove") selectedEdgeIds.delete(change.id);
      }
      commitCanvasSelection(selectedCanvasNodeIdsRef.current, selectedEdgeIds);
      const graphChanges = omitSelectionEdgeChanges(changes);
      if (graphChanges.length === 0) return;

      editGraph(graph => {
        const nextEdges = applyEdgeChanges(graphChanges, graph.edges);
        return {
          nodes: normalizeNodesAfterEdgeChanges({
            changes: graphChanges,
            currentEdges: graph.edges,
            nextEdges,
            currentNodes: graph.nodes,
          }),
          edges: nextEdges,
          history: hasStructuralEdgeChanges(graphChanges) ? "record" : "skip",
        };
      });
    },
    [commitCanvasSelection, editGraph, ownsLoadedSession, sessionOwnerKey]
  );

  const finishNodeDrag = useCallback(
    (snap: { nodeId: string; x: number | null; y: number | null } | null) => {
      if (!ownsLoadedSession(sessionOwnerKey)) return;
      const pendingHistory = pendingPositionHistorySnapshotRef.current;
      if (pendingHistory) {
        pushGraphHistorySnapshot(pendingHistory);
        pendingPositionHistorySnapshotRef.current = null;
        dragHistoryCompletedBeforeNodeChangeRef.current = true;
      }
      let changed = false;
      const nextNodes = snap
        ? nodesRef.current.map(node => {
            if (node.id !== snap.nodeId) return node;
            const position = {
              x: snap.x ?? node.position.x,
              y: snap.y ?? node.position.y,
            };
            if (
              position.x === node.position.x &&
              position.y === node.position.y
            )
              return node;
            changed = true;
            return { ...node, position };
          })
        : nodesRef.current;
      if (changed)
        commitGraphSnapshot({ nodes: nextNodes, edges: edgesRef.current });
      if (pendingHistory || changed) markFlowDirty();
    },
    [
      commitGraphSnapshot,
      edgesRef,
      markFlowDirty,
      nodesRef,
      ownsLoadedSession,
      pushGraphHistorySnapshot,
      sessionOwnerKey,
    ]
  );

  // Changes exactly when the save state a QR picker shows changes, so the
  // canvas re-reads pickers then and not on every render.
  const whatsAppQrAssignmentHost = useMemo<WhatsAppQrAssignmentHost>(
    () => ({
      readEntryPointId: readWhatsAppQrGraphEntryPointId,
      readSnapshot: readWhatsAppQrAssignmentHostSnapshot,
      // A picker renders with this render's save state: the refs the
      // snapshot above reads catch up only once the render commits.
      readPickerSnapshot: nodeId =>
        readWhatsAppQrAssignmentSnapshot(nodeId, {
          scenarioId: activeScenarioId,
          loadingFlow,
          saveStatus,
          isDirty,
          hasSaveConflict,
          scenarioStatus: activeScenarioStatus,
        }),
      adopt: adoptWhatsAppQrAssignmentResult,
    }),
    [
      activeScenarioId,
      activeScenarioStatus,
      adoptWhatsAppQrAssignmentResult,
      hasSaveConflict,
      isDirty,
      loadingFlow,
      readWhatsAppQrAssignmentHostSnapshot,
      readWhatsAppQrAssignmentSnapshot,
      readWhatsAppQrGraphEntryPointId,
      saveStatus,
    ]
  );

  return {
    nodes,
    edges,
    graphEditor,
    canvasSelection,
    selectedNodeId,
    setSelectedNodeId,
    linkedConditionParentCountByNodeId,
    loadingFlow,
    saveStatus,
    validationRequested,
    readWhatsAppQrGraphEntryPointId,
    readWhatsAppQrAssignmentHostSnapshot,
    adoptWhatsAppQrAssignmentResult,
    whatsAppQrAssignmentHost,
    convertLegacyActionRouting,
    clearCanvasSelection,
    onCanvasSelectionChange,
    onCanvasEdgeClick,
    onCanvasNodeClick,
    onBeforeCanvasDelete,
    setReactFlowInstance,
    screenToFlowPosition,
    normalizeScenarioLayout,
    normalizeScenarioLayoutDisabled,
    clearPendingSave,
    flushScenario,
    prepareScenarioSelection,
    isScenarioGraphSettled,
    trackNodeMediaOperation,
    coordinateActiveScenarioPatch,
    adoptGeneratedBulkServerUpdate,
    prepareScenarioBulkSend,
    adoptScenarioActivation,
    onScenarioActivationBlocked,
    publishManagedWhatsAppFlow,
    scenarioSessionOwnerKey: sessionOwnerKey,
    publishingManagedFlowNodeId:
      providerMutationInFlight &&
      providerMutationOperationRef.current?.kind === "managed_flow" &&
      providerMutationOperationRef.current.scenarioId === activeScenarioId
        ? providerMutationOperationRef.current.nodeId
        : null,
    attachWhatsAppFlowProviderReferenceToNode,
    loadWhatsAppTemplateForm,
    loadingTemplateFormNodeIds,
    submitGeneratedTemplateForNode,
    submittingGeneratedTemplateNodeId:
      providerMutationInFlight &&
      providerMutationOperationRef.current?.kind === "generated_template" &&
      providerMutationOperationRef.current.scenarioId === activeScenarioId
        ? providerMutationOperationRef.current.nodeId
        : null,
    prepareGeneratedJobRefresh,
    reconcileGeneratedJobServerUpdate,
    undoGraphChange,
    redoGraphChange,
    canUndoGraphChange: graphHistoryRef.current.length > 0,
    canRedoGraphChange: graphFutureRef.current.length > 0,
    autoLayoutEnabled,
    setAutoLayoutEnabled,
    onNodesChange,
    onEdgesChange,
    finishNodeDrag,
    onViewportChange,
    readInitialViewport,
  };
}
