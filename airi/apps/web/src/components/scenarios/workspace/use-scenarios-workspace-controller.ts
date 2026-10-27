"use client";

import { useCompanyLimits } from "@/hooks/use-company-limits";
import { useTransitionOwnerKey } from "@/hooks/use-transition-owner-key";
import type { ScenarioSidebarPatch } from "@/lib/scenarios/client";
import type { InitialScenarioDetail } from "@/lib/scenarios/initial-scenario-detail";
import type { AiriScenarioGeneratorDraft } from "@/lib/airi-chats/scenario-generator-draft";
import type { RegisteredBusinessPhonesAudienceSummary } from "@/lib/campaign/bulk-campaign-contracts";
import { resolveSubscenarioLinkSummary } from "@/lib/scenarios/subscenario-linking";
import { hasWhatsAppQrGraphBinding } from "@/lib/whatsapp/qr-entry-points/scenario-binding";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { toast } from "sonner";
import { DEMO_SCENARIO_PRESET_ID } from "@/lib/scenarios/scenario-presets";
import {
  isDemoScenarioAutoCreatePending,
  shouldAutoCreateDemoScenario,
  type ConnectedScenarioActionSource,
  type ConnectedScenarioSourceMention,
  type ScenarioSourceCapabilities,
  type ScenarioSourceInstanceOption,
} from "../scenario-onboarding";
import type {
  ScenarioDocument,
  ScenarioNodeData,
  ScenarioSummary,
} from "../types";
import { useHelperLines } from "../view/helper-lines";
import { resolveScenarioStatusPriority } from "../view/hierarchy/use-scenario-status-toggle";
import { useScenarioActivationImpactGuard } from "../view/scenario-activation-impact";
import type {
  ScenarioNodeEnrichmentBridge,
  ScenarioNodeEnrichmentGraphState,
  ScenarioNodeEnrichmentResources,
} from "../view/scenario-node-enrichment-context";
import type { ScenarioCanvasInteractionMode } from "../view/scenario-canvas-interaction-mode";
import { ScenariosViewDialogs } from "../view/scenarios-view-dialogs";
import { useLatestRef } from "../view/use-latest-ref";
import { useLinkedWhatsAppFlowPreview } from "../view/use-linked-whatsapp-flow-preview";
import { usePaneDragGesture } from "../view/use-pane-drag-gesture";
import { useScenarioCreationDialogs } from "../view/use-scenario-creation-dialogs";
import { useScenarioFlowController } from "../view/use-scenario-flow-controller";
import { useScenarioGraphController } from "../view/use-scenario-graph-controller";
import { useScenarioNodeCallbacks } from "../view/use-scenario-node-callbacks";
import {
  scenarioGraphHasFlowRoot,
  useScenarioNodePaletteSections,
} from "../view/palette/use-scenario-node-palette-sections";
import { useScenarioPreviewDrawer } from "../view/use-scenario-preview-drawer";
import type { ScenarioSimulationTrace } from "../view/preview/use-scenario-simulation";
import { useScenarioResourcesEntity } from "../view/resources/use-scenario-resources-entity";
import { useScenarioSelectedResources } from "../view/resources/use-scenario-selected-resources";
import { useScenarioTriggerLogs } from "../view/use-scenario-trigger-logs";
import {
  useScenarioAutomationHeaderActions,
  useScenarioLoadingSignal,
} from "./use-scenario-view-signals";
import { useScenarioWhatsAppQrEntryPoints } from "../view/useScenarioWhatsAppQrEntryPoints";
import { useScenarioDetailPrefetch } from "./use-scenario-detail-prefetch";
import { useScenarioWorkspaceEntity } from "./use-scenario-workspace-entity";
import { useScenarioContextMenu } from "../view/palette/use-scenario-context-menu";

const EMPTY_SUBSCENARIO_INDICATOR_BY_SCENARIO_ID: Record<string, string> = {};
// Shared defaults keep the canvas resources the same between renders.
const NO_SOURCE_MENTIONS: ConnectedScenarioSourceMention[] = [];
const NO_SOURCE_OPTIONS: ScenarioSourceInstanceOption[] = [];
const NO_ACTION_SOURCES: ConnectedScenarioActionSource[] = [];

export type UseScenariosWorkspaceControllerParams = {
  workspaceId: string;
  connectedSourceMentions?: ConnectedScenarioSourceMention[];
  connectedSourceOptions?: ScenarioSourceInstanceOption[];
  higgsfieldUnavailableReason?: string;
  connectedActionSources?: ConnectedScenarioActionSource[];
  sourceCapabilities?: ScenarioSourceCapabilities;
  registeredBusinessPhonesAudience?: RegisteredBusinessPhonesAudienceSummary | null;
  hasConnectedSources: boolean;
  hasGoogleCalendar?: boolean;
  onLoadingChange?: (isLoading: boolean) => void;
  onAutomationActionsChange?: Parameters<
    typeof useScenarioAutomationHeaderActions
  >[0]["onAutomationActionsChange"];
  requestedScenarioId?: string | null;
  openPreviewOnMount?: boolean;
  openAiriCreateOnMount?: boolean;
  initialAiriCreateDraft?: AiriScenarioGeneratorDraft | null;
  initialScenarios?: ScenarioSummary[];
  /** The page's read of the scenario it opens first. */
  initialScenarioDetail?: PromiseLike<InitialScenarioDetail | null> | null;
  /** Workspace flag `scenario_node_settings_panel`. */
  nodeSettingsPanelEnabled?: boolean;
};

export function useScenariosWorkspaceController({
  workspaceId,
  connectedSourceMentions = NO_SOURCE_MENTIONS,
  connectedSourceOptions = NO_SOURCE_OPTIONS,
  higgsfieldUnavailableReason = "",
  connectedActionSources = NO_ACTION_SOURCES,
  sourceCapabilities,
  registeredBusinessPhonesAudience = null,
  hasConnectedSources,
  hasGoogleCalendar = false,
  onLoadingChange,
  onAutomationActionsChange,
  requestedScenarioId = null,
  openPreviewOnMount = false,
  openAiriCreateOnMount = false,
  initialAiriCreateDraft = null,
  initialScenarios,
  initialScenarioDetail = null,
  nodeSettingsPanelEnabled = false,
}: UseScenariosWorkspaceControllerParams) {
  const t = useTranslations("Scenarios");
  const { data: limits } = useCompanyLimits(workspaceId);
  const isFreePlan = limits?.subscriptionType === "free";
  const scenarioCreateLocked = Boolean(
    limits?.scenarioExhausted || limits?.conversationExhausted
  );
  // Creation locks on either limit; name the one that was reached.
  const scenarioLimitMessage = t(
    limits?.conversationExhausted && !limits?.scenarioExhausted
      ? "company_conversation_limit_exceeded"
      : "company_scenario_limit_exceeded"
  );
  const [canvasInteractionMode, setCanvasInteractionMode] =
    useState<ScenarioCanvasInteractionMode>("pan");
  const whatsAppFlowSources = useMemo(() => {
    const provisioningSources: Array<{ id: string; label: string }> = [];
    const sourceIds: string[] = [];
    for (const option of connectedSourceOptions) {
      if (option.type !== "whatsapp") continue;
      provisioningSources.push({ id: option.id, label: option.label });
      sourceIds.push(option.id);
    }
    return { provisioningSources, sourceIds };
  }, [connectedSourceOptions]);

  const {
    contextOptions,
    contextItemsByOptionId,
    audienceOptions,
    whatsAppTemplates,
    whatsAppFlows,
    graphResourceState,
    loadContextItems,
    loadWhatsAppTemplates,
    loadWhatsAppFlows,
  } = useScenarioResourcesEntity({
    workspaceId,
    whatsAppSourceIds: whatsAppFlowSources.sourceIds,
  });

  const workspace = useScenarioWorkspaceEntity({
    workspaceId,
    contextOptions,
    connectedActionSources,
    requestedScenarioId,
    initialScenarios,
    t,
  });

  const {
    scenarios,
    setScenarios,
    activeScenarioId,
    selectScenario: selectWorkspaceScenario,
    pendingScenarioId,
    adoptConfirmedScenarioDocument,
    activeScenario,
    activeScenarioName,
    activeScenarioDescription,
    activeScenarioStatus,
    activeScenarioGraphSettings: workspaceGraphSettings,
    entryPriorityInput,
    setEntryPriorityInput,
    loadingScenarios,
    isCreatingScenario,
    funnelTemplates,
    scenarioListLayoutItems,
    pendingConfirmation,
    closePendingConfirmation,
    confirmPendingConfirmation,
    createScenarioFromGuide: createGuidedDocument,
    createDemoScenario: createDemoDocument,
    createScenarioFromGenerator: createGeneratedDocument,
    createScenarioFromRevenuePlaybook: createRevenuePlaybookDocument,
    handleScenarioReorderWithSave,
    saveScenarioPatch: saveSidebarPatch,
    deleteScenarioById,
  } = workspace;

  const scenariosRef = useLatestRef(scenarios);
  const activeScenarioIdRef = useLatestRef(activeScenarioId);
  const selectionOwnerKey = useTransitionOwnerKey(
    `${workspaceId}\u0000${activeScenarioId}\u0000${pendingScenarioId}`
  );
  const selectionOwnerKeyRef = useLatestRef(selectionOwnerKey);
  const consumedRequestedScenarioRef = useRef<string | null>(null);

  const triggerLogsState = useScenarioTriggerLogs({
    workspaceId,
    activeScenarioId,
    t,
  });

  const {
    showTriggerLogPanel,
    setShowTriggerLogPanel,
    toggleTriggerLogPanel,
    triggerLogs,
    triggerLogsHasMore,
    loadingTriggerLogs,
    loadTriggerLogs,
    loadMoreTriggerLogs,
  } = triggerLogsState;

  const demoAutoCreateAttemptedRef = useRef(false);
  const [demoCreateFailed, setDemoCreateFailed] = useState(false);
  const [simulationTrace, setSimulationTrace] =
    useState<ScenarioSimulationTrace | null>(null);

  const flow = useScenarioFlowController({
    workspaceId,
    activeScenarioId,
    activeScenario,
    activeScenarioName,
    activeScenarioDescription,
    activeScenarioStatus,
    entryPriorityInput,
    setEntryPriorityInput,
    setScenarios,
    onScenarioDocumentConfirmed: adoptConfirmedScenarioDocument,
    t,
    keepSelectionThroughHistory: nodeSettingsPanelEnabled,
    initialScenarioDetail,
  });

  const {
    nodes,
    edges,
    graphEditor,
    finishNodeDrag,
    canvasSelection,
    selectedNodeId,
    setSelectedNodeId,
    linkedConditionParentCountByNodeId,
    loadingFlow,
    saveStatus,
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
    prepareScenarioSelection,
    isScenarioGraphSettled,
    trackNodeMediaOperation,
    coordinateActiveScenarioPatch,
    adoptGeneratedBulkServerUpdate,
    prepareScenarioBulkSend,
    adoptScenarioActivation,
    onScenarioActivationBlocked,
    publishManagedWhatsAppFlow,
    scenarioSessionOwnerKey,
    publishingManagedFlowNodeId,
    attachWhatsAppFlowProviderReferenceToNode,
    prepareGeneratedJobRefresh,
    submitGeneratedTemplateForNode,
    submittingGeneratedTemplateNodeId,
    loadWhatsAppTemplateForm,
    loadingTemplateFormNodeIds,
    reconcileGeneratedJobServerUpdate,
    onNodesChange,
    onEdgesChange,
    onViewportChange,
    readInitialViewport,
  } = flow;

  const activeScenarioGraphSettings = useMemo(
    () => ({
      ...workspaceGraphSettings,
      validationMode:
        activeScenarioStatus === "active" || flow.validationRequested
          ? ("runnable" as const)
          : ("draft" as const),
    }),
    [activeScenarioStatus, flow.validationRequested, workspaceGraphSettings]
  );

  // Reads a scenario's detail ahead of a likely open (pointer or focus on
  // its sidebar entry). The open adopts it only while it is still current.
  const { prefetchScenario, cancelScenarioPrefetch, prefetchScenarioNow } =
    useScenarioDetailPrefetch({ workspaceId, activeScenarioIdRef });
  const selectScenario = useCallback(
    (scenarioId: string | null) => {
      // Leaving a scenario with nothing to save writes nothing, so the next
      // one's read need not wait for the switch.
      if (scenarioId && isScenarioGraphSettled()) {
        prefetchScenarioNow(scenarioId);
      } else {
        cancelScenarioPrefetch();
      }
      return selectWorkspaceScenario(scenarioId, prepareScenarioSelection);
    },
    [
      cancelScenarioPrefetch,
      isScenarioGraphSettled,
      prefetchScenarioNow,
      prepareScenarioSelection,
      selectWorkspaceScenario,
    ]
  );

  useEffect(() => {
    if (!requestedScenarioId) consumedRequestedScenarioRef.current = null;
    if (loadingScenarios) return;
    const requestedKey = `${workspaceId}\u0000${requestedScenarioId}`;
    if (
      requestedScenarioId &&
      consumedRequestedScenarioRef.current !== requestedKey &&
      scenarios.some(scenario => scenario._id === requestedScenarioId)
    ) {
      consumedRequestedScenarioRef.current = requestedKey;
      void selectScenario(requestedScenarioId);
      return;
    }
    if (!scenarios.some(scenario => scenario._id === activeScenarioId)) {
      void selectScenario(scenarios[0]?._id ?? null);
    }
  }, [
    activeScenarioId,
    loadingScenarios,
    requestedScenarioId,
    scenarios,
    selectScenario,
    workspaceId,
  ]);

  const createScenarioAndSelect = useCallback(
    async (createDocument: () => Promise<ScenarioDocument | null>) => {
      const ownerKey = selectionOwnerKeyRef.current;
      if (
        !(await prepareScenarioSelection()) ||
        selectionOwnerKeyRef.current !== ownerKey
      ) {
        return null;
      }
      const created = await createDocument();
      if (created && selectionOwnerKeyRef.current === ownerKey) {
        await selectScenario(created._id);
      }
      return created;
    },
    [prepareScenarioSelection, selectScenario, selectionOwnerKeyRef]
  );
  const createDemoScenario = useCallback(
    () => createScenarioAndSelect(createDemoDocument),
    [createDemoDocument, createScenarioAndSelect]
  );
  const createScenarioFromGuide = useCallback(
    (kind: Parameters<typeof createGuidedDocument>[0]) =>
      createScenarioAndSelect(() => createGuidedDocument(kind)),
    [createGuidedDocument, createScenarioAndSelect]
  );
  const createScenarioFromGenerator = useCallback(
    async (input: Parameters<typeof createGeneratedDocument>[0]) =>
      Boolean(
        await createScenarioAndSelect(() => createGeneratedDocument(input))
      ),
    [createGeneratedDocument, createScenarioAndSelect]
  );
  const createScenarioFromRevenuePlaybook = useCallback(
    async (config: Parameters<typeof createRevenuePlaybookDocument>[0]) =>
      Boolean(
        await createScenarioAndSelect(() =>
          createRevenuePlaybookDocument(config)
        )
      ),
    [createRevenuePlaybookDocument, createScenarioAndSelect]
  );
  const {
    showCreateTypeDialog,
    setShowCreateTypeDialog,
    showAiriCreateDialog,
    setShowAiriCreateDialog,
    handleGuidedScenarioCreate,
    handleCreateGeneratedScenario,
    showRevenuePlaybookDialog,
    setShowRevenuePlaybookDialog,
    handleOpenRevenuePlaybook,
    handleCreateRevenuePlaybook,
  } = useScenarioCreationDialogs({
    createScenarioFromGuide,
    createScenarioFromGenerator,
    createScenarioFromRevenuePlaybook,
  });

  const saveScenarioPatch = useCallback(
    (scenarioId: string, patch: ScenarioSidebarPatch): Promise<boolean> => {
      if (scenarioId === activeScenarioIdRef.current) {
        return coordinateActiveScenarioPatch(patch);
      }
      return saveSidebarPatch(scenarioId, patch);
    },
    [activeScenarioIdRef, coordinateActiveScenarioPatch, saveSidebarPatch]
  );
  const saveScenarioSettings = useCallback(
    ({
      scenarioId,
      ...patch
    }: {
      scenarioId: string;
      status: ScenarioSummary["status"];
      priority: number;
    }) => saveScenarioPatch(scenarioId, patch),
    [saveScenarioPatch]
  );
  const saveScenarioName = useCallback(
    (scenarioId: string, value: string) =>
      saveScenarioPatch(scenarioId, {
        name: value.trim() || t("defaultScenarioName"),
      }),
    [saveScenarioPatch, t]
  );
  const reorderScenarios = useCallback(
    (payload: Parameters<typeof handleScenarioReorderWithSave>[0]) =>
      handleScenarioReorderWithSave(payload, (scenarioId, priority) =>
        saveScenarioPatch(scenarioId, { priority })
      ),
    [handleScenarioReorderWithSave, saveScenarioPatch]
  );

  const managedWhatsAppFlowProvisioningSources =
    whatsAppFlowSources.provisioningSources;

  const hasWhatsAppQrTrigger = useMemo(
    () => hasWhatsAppQrGraphBinding(nodes),
    [nodes]
  );
  const whatsAppQrEntryPoints = useScenarioWhatsAppQrEntryPoints({
    workspaceId,
    scenarioId: activeScenarioId,
    scenarioName: activeScenarioName,
    whatsAppSources: whatsAppFlowSources.provisioningSources,
    assignmentHost: whatsAppQrAssignmentHost,
    onSelectScenario: selectScenario,
    hasWhatsAppQrTrigger,
  });

  const hasFlowRoot = useMemo(() => scenarioGraphHasFlowRoot(nodes), [nodes]);
  const { nodePaletteSections } = useScenarioNodePaletteSections(t, {
    hasFlowRoot,
  });

  const { helperLines, onNodeDrag, handleNodeDragStop } = useHelperLines({
    enabled: canvasInteractionMode === "pan",
    graphEditor,
    finishNodeDrag,
  });

  useScenarioLoadingSignal({
    isLoading: loadingScenarios || loadingFlow,
    onLoadingChange,
  });

  const previewDrawer = useScenarioPreviewDrawer({
    activeScenarioId,
    activeScenario,
    activeScenarioName,
    activeScenarioStatus,
    entryPriorityInput,
    loadingFlow,
    nodes,
    edges,
    requestedScenarioId,
    openPreviewOnMount,
  });

  const {
    isPreviewDrawerOpen,
    draftScenarioForPreview,
    openPreviewDrawer,
    handlePreviewDrawerOpenChange,
  } = previewDrawer;

  const flowWrapperRef = useRef<HTMLDivElement>(null);

  const graph = useScenarioGraphController({
    flowWrapperRef,
    screenToFlowPosition,
    graphEditor,
    nodes,
    edges,
    setSelectedNodeId,
    whatsAppTemplates,
    connectedActionSources,
    undoGraphChange: flow.undoGraphChange,
    t,
  });

  const {
    contextMenu,
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
    isValidConnection,
    onConnectStart,
    onConnectEnd,
  } = graph;

  const { handlePaneMouseDown, handlePaneMouseUp, handleNodeDrag } =
    usePaneDragGesture(openContextMenuAtClientPoint, onNodeDrag, {
      enabled: canvasInteractionMode === "pan",
    });

  const handleOpenNodePaletteFromHeader = useCallback(() => {
    const wrapper = flowWrapperRef.current;
    if (!wrapper) return;
    const bounds = wrapper.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    setSelectedNodeId(null);
    openContextMenuAtClientPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2
    );
  }, [flowWrapperRef, openContextMenuAtClientPoint, setSelectedNodeId]);

  const nodesById = useMemo(
    () => new Map(nodes.map(node => [node.id, node])),
    [nodes]
  );
  const { contextMenuSections, contextMenuSourceLabel } =
    useScenarioContextMenu({
      nodesById,
      contextMenu,
      nodePaletteSections,
      t,
    });

  const handleDeleteScenario = useCallback(
    async (scenarioId: string) => {
      const deleted = await deleteScenarioById(scenarioId);
      if (!deleted) return;
      if (activeScenarioIdRef.current === scenarioId) {
        clearPendingSave();
        const nextScenario = scenariosRef.current.find(
          scenario => scenario._id !== scenarioId
        );
        await selectScenario(nextScenario?._id ?? null);
      }
    },
    [
      activeScenarioIdRef,
      clearPendingSave,
      deleteScenarioById,
      scenariosRef,
      selectScenario,
    ]
  );

  const handleDeleteActiveScenario = useCallback(() => {
    if (!activeScenarioId) return;
    void handleDeleteScenario(activeScenarioId);
  }, [activeScenarioId, handleDeleteScenario]);

  const handleCanvasInteractionModeChange = useCallback(
    (mode: ScenarioCanvasInteractionMode) => {
      clearCanvasSelection();
      setSelectedNodeId(null);
      setCanvasInteractionMode(mode);
    },
    [clearCanvasSelection, setSelectedNodeId]
  );

  const handleCanvasPaneClick = useCallback(() => {
    clearCanvasSelection();
    handlePaneClick();
  }, [clearCanvasSelection, handlePaneClick]);

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

  const openCreateTypeDialog = useCallback(() => {
    if (scenarioCreateLocked) {
      toast.error(scenarioLimitMessage);
      return;
    }
    setShowCreateTypeDialog(true);
  }, [scenarioCreateLocked, scenarioLimitMessage, setShowCreateTypeDialog]);

  const openAiGenerateDialog = useCallback(() => {
    if (scenarioCreateLocked) {
      toast.error(scenarioLimitMessage);
      return;
    }
    setShowAiriCreateDialog(true);
  }, [scenarioCreateLocked, scenarioLimitMessage, setShowAiriCreateDialog]);

  useEffect(() => {
    if (!openAiriCreateOnMount) return;
    openAiGenerateDialog();
  }, [openAiGenerateDialog, openAiriCreateOnMount]);

  const handleSidebarDeleteScenario = useCallback(
    (scenarioId: string) => {
      void handleDeleteScenario(scenarioId);
    },
    [handleDeleteScenario]
  );

  const nodeCallbacksState = useScenarioNodeCallbacks({
    workspaceId,
    graphEditor,
    setSelectedNodeId,
    contextOptions,
    whatsAppTemplates,
    loadContextItems,
    t,
  });

  const {
    isCreatingSnippet,
    updateNodeById,
    removeNodeById,
    updateNodeContextOptionById,
    updateNodeContextSelectionModeById,
    toggleContextItemSelectionById,
    selectContextItemsById,
    clearContextItemSelectionById,
    toggleContextSourceById,
    updateContextSourceSelectionModeById,
    toggleContextSourceItemById,
    selectContextSourceItemsById,
    clearContextSourceItemSelectionById,
    updateTriggerConfigById,
    updateActionWhatsAppTemplateById,
    uploadActionImageForNodeId: uploadActionImage,
    generateActionVoiceForNodeId: generateActionVoice,
    removeActionImageUrlByNodeId,
    createAnswerSnippetFromNode,
  } = nodeCallbacksState;
  // A step's signed media is shown only after its upload or voice finished.
  const uploadActionImageForNodeId = useCallback<typeof uploadActionImage>(
    (nodeId, file, options) =>
      trackNodeMediaOperation(nodeId, uploadActionImage(nodeId, file, options)),
    [trackNodeMediaOperation, uploadActionImage]
  );
  const generateActionVoiceForNodeId = useCallback<typeof generateActionVoice>(
    (nodeId, params) =>
      trackNodeMediaOperation(nodeId, generateActionVoice(nodeId, params)),
    [generateActionVoice, trackNodeMediaOperation]
  );

  // The template a new step gets by default loads its form fields, as a
  // pick does. Steps without a form button read nothing.
  const selectDefaultWhatsAppTemplate = useCallback(
    (nodeId: string, templateValue: string) => {
      updateActionWhatsAppTemplateById(nodeId, templateValue);
      void loadWhatsAppTemplateForm(nodeId, { reason: "pick" });
    },
    [loadWhatsAppTemplateForm, updateActionWhatsAppTemplateById]
  );
  useScenarioSelectedResources({
    selectedNode: selectedNodeId ? nodesById.get(selectedNodeId) : undefined,
    whatsAppTemplates,
    loadContextItems,
    loadWhatsAppTemplates,
    loadWhatsAppFlows,
    selectWhatsAppTemplate: selectDefaultWhatsAppTemplate,
  });

  useEffect(() => {
    if (
      scenarioCreateLocked ||
      !shouldAutoCreateDemoScenario({
        attempted: demoAutoCreateAttemptedRef.current,
        hasConnectedSources,
        loadingScenarios,
        scenarioCount: scenarios.length,
      })
    ) {
      return;
    }

    demoAutoCreateAttemptedRef.current = true;

    void (async () => {
      const created = await createDemoScenario();
      if (!created) {
        setDemoCreateFailed(true);
      }
    })();
  }, [
    createDemoScenario,
    scenarioCreateLocked,
    hasConnectedSources,
    loadingScenarios,
    scenarios.length,
  ]);

  const linkedFlowPreviewState = useLinkedWhatsAppFlowPreview({
    workspaceId,
    whatsAppFlows,
    attachWhatsAppFlowProviderReferenceToNode,
    t,
  });

  const {
    linkedFlowPreview,
    openingLinkedFlowPreview,
    openLinkedWhatsAppFlowPreview,
    handleLinkedFlowPreviewOpenChange,
    selectExistingFlowForNode,
  } = linkedFlowPreviewState;

  const nodeCallbacks = useMemo(
    () => ({
      selectNodeById: setSelectedNodeId,
      updateNodeById,
      convertLegacyActionRouting,
      removeNodeById,
      updateTriggerConfigById,
      updateActionWhatsAppTemplateById,
      uploadActionImageForNodeId,
      generateActionVoiceForNodeId,
      removeActionImageUrlByNodeId,
      updateNodeContextOptionById,
      updateNodeContextSelectionModeById,
      toggleContextItemSelectionById,
      selectContextItemsById,
      clearContextItemSelectionById,
      toggleContextSourceById,
      updateContextSourceSelectionModeById,
      toggleContextSourceItemById,
      selectContextSourceItemsById,
      clearContextSourceItemSelectionById,
      createAnswerSnippetFromNode,
      loadWhatsAppTemplates,
      loadContextItems,
      loadWhatsAppFlows,
      openLinkedWhatsAppFlowPreview,
    }),
    [
      setSelectedNodeId,
      updateNodeById,
      convertLegacyActionRouting,
      removeNodeById,
      updateTriggerConfigById,
      updateActionWhatsAppTemplateById,
      uploadActionImageForNodeId,
      generateActionVoiceForNodeId,
      removeActionImageUrlByNodeId,
      updateNodeContextOptionById,
      updateNodeContextSelectionModeById,
      toggleContextItemSelectionById,
      selectContextItemsById,
      clearContextItemSelectionById,
      toggleContextSourceById,
      updateContextSourceSelectionModeById,
      toggleContextSourceItemById,
      selectContextSourceItemsById,
      clearContextSourceItemSelectionById,
      createAnswerSnippetFromNode,
      loadWhatsAppTemplates,
      loadContextItems,
      loadWhatsAppFlows,
      openLinkedWhatsAppFlowPreview,
    ]
  );

  const selectExistingFlowForNodeRef = useLatestRef(selectExistingFlowForNode);

  const scenarioLinkOptions = useMemo(
    () =>
      scenarios
        .filter(s => s._id !== activeScenarioId)
        .map(s => ({
          id: s._id,
          name: s.name,
          triggers: s.builderSummary?.triggers,
        })),
    [scenarios, activeScenarioId]
  );

  const subscenarioIndicatorByScenarioId = useMemo(() => {
    if (!activeScenarioId) {
      return EMPTY_SUBSCENARIO_INDICATOR_BY_SCENARIO_ID;
    }

    const actionNodeCount = nodes.filter(
      n => (n.data as ScenarioNodeData).kind === "action"
    ).length;
    const resolved = resolveSubscenarioLinkSummary({
      scenarioId: activeScenarioId,
      nodes,
      edges,
    });
    const summary = resolved.summary;
    const next: Record<string, string> = {};
    Object.entries(summary.actionNodeIdsByChildScenarioId).forEach(
      ([childScenarioId, actionIds]) => {
        if (actionNodeCount > 0 && actionIds.length === actionNodeCount) {
          next[childScenarioId] = t("subscenarioIndicatorAll");
        } else {
          next[childScenarioId] = t("subscenarioIndicatorPartial", {
            linked: actionIds.length,
            total: actionNodeCount,
          });
        }
      }
    );
    return next;
  }, [activeScenarioId, edges, nodes, t]);

  const activationImpact = useScenarioActivationImpactGuard({
    workspaceId,
    activeScenario,
    activeScenarioName,
    activeScenarioStatus,
    activeScenarioNodes: nodes,
    activeScenarioEdges: edges,
    scenarios,
    whatsAppTemplates,
    saveScenarioSettings,
    t,
  });

  const {
    pendingActivationImpact,
    confirmActivationImpact,
    handleActivationImpactOpenChange,
    saveScenarioSettingsWithActivationGuard,
  } = activationImpact;

  // The toolbar's Activate runs the same reviewed path as the list switch.
  const [isActivatingScenario, setIsActivatingScenario] = useState(false);
  const handleActivateActiveScenario = useCallback(async () => {
    if (!activeScenarioId) return;
    const priority = resolveScenarioStatusPriority(
      scenarioListLayoutItems,
      activeScenarioId
    );
    if (priority === null) return;
    setIsActivatingScenario(true);
    try {
      await saveScenarioSettingsWithActivationGuard({
        scenarioId: activeScenarioId,
        status: "active",
        priority,
      });
    } finally {
      setIsActivatingScenario(false);
    }
  }, [
    activeScenarioId,
    saveScenarioSettingsWithActivationGuard,
    scenarioListLayoutItems,
  ]);

  const handleShowActivationBlock = useCallback(
    (nodeId: string) => {
      handleActivationImpactOpenChange(false);
      onScenarioActivationBlocked([nodeId]);
    },
    [handleActivationImpactOpenChange, onScenarioActivationBlocked]
  );

  useScenarioAutomationHeaderActions({
    onAutomationActionsChange,
    hasScenario: Boolean(activeScenario),
    canCreate: !scenarioCreateLocked,
    isCreatingScenario,
    canDelete: Boolean(activeScenario) && scenarios.length > 1,
    saveStatus,
    canvasInteractionMode,
    isTriggerLogVisible: showTriggerLogPanel,
    activeScenarioStatus: activeScenario ? activeScenarioStatus : null,
    isActivatingScenario,
    onCreateScenario: openCreateTypeDialog,
    onOpenNodePalette: activeScenario
      ? handleOpenNodePaletteFromHeader
      : undefined,
    onOpenAiGenerate: openAiGenerateDialog,
    onCanvasInteractionModeChange: handleCanvasInteractionModeChange,
    onToggleTriggerLog: toggleTriggerLogPanel,
    onDeleteScenario: handleDeleteActiveScenario,
    onActivateScenario: activeScenario
      ? handleActivateActiveScenario
      : undefined,
  });

  const graphPaneData = useMemo<ScenarioNodeEnrichmentGraphState>(
    () => ({
      nodes,
      edges,
      selectedNodeId,
      linkedConditionParentCountByNodeId,
    }),
    [nodes, edges, selectedNodeId, linkedConditionParentCountByNodeId]
  );

  const graphPaneResources = useMemo<ScenarioNodeEnrichmentResources>(
    () => ({
      activeScenarioId,
      audienceOptions,
      contextItemsByOptionId,
      contextOptions,
      isCreatingSnippet,
      t,
      whatsAppFlows,
      whatsAppTemplates,
      workspaceId,
      connectedActionSources,
      managedWhatsAppFlowProvisioningSources,
      sourceCapabilities,
      registeredBusinessPhonesAudience,
      getWhatsAppQrPickerProps: whatsAppQrEntryPoints.getPickerProps,
      scenarioLinkOptions,
      openingLinkedWhatsAppFlowNodeId: openingLinkedFlowPreview?.nodeId ?? null,
      openingLinkedWhatsAppFlowId: openingLinkedFlowPreview?.flowId ?? null,
      nodeSettingsPanelEnabled,
    }),
    [
      nodeSettingsPanelEnabled,
      activeScenarioId,
      audienceOptions,
      connectedActionSources,
      managedWhatsAppFlowProvisioningSources,
      registeredBusinessPhonesAudience,
      contextItemsByOptionId,
      contextOptions,
      isCreatingSnippet,
      t,
      whatsAppFlows,
      whatsAppTemplates,
      workspaceId,
      sourceCapabilities,
      whatsAppQrEntryPoints.getPickerProps,
      scenarioLinkOptions,
      openingLinkedFlowPreview?.nodeId,
      openingLinkedFlowPreview?.flowId,
    ]
  );

  const graphPaneNodeBridge = useMemo<ScenarioNodeEnrichmentBridge>(
    () => ({
      nodeCallbacks,
      adoptGeneratedBulkServerUpdate,
      prepareScenarioBulkSend,
      adoptScenarioActivation,
      onScenarioActivationBlocked,
      publishManagedWhatsAppFlow,
      scenarioSessionOwnerKey,
      publishingManagedFlowNodeId,
      prepareGeneratedJobRefresh,
      submitGeneratedTemplateForNode,
      submittingGeneratedTemplateNodeId,
      loadWhatsAppTemplateForm,
      loadingTemplateFormNodeIds,
      reconcileGeneratedJobServerUpdate,
      selectExistingFlowForNodeRef,
      handleBranchSyncForNodeRef,
      openNodePickerFromHandle,
    }),
    [
      adoptGeneratedBulkServerUpdate,
      prepareScenarioBulkSend,
      adoptScenarioActivation,
      onScenarioActivationBlocked,
      publishManagedWhatsAppFlow,
      scenarioSessionOwnerKey,
      publishingManagedFlowNodeId,
      prepareGeneratedJobRefresh,
      submitGeneratedTemplateForNode,
      submittingGeneratedTemplateNodeId,
      loadWhatsAppTemplateForm,
      loadingTemplateFormNodeIds,
      reconcileGeneratedJobServerUpdate,
      handleBranchSyncForNodeRef,
      nodeCallbacks,
      openNodePickerFromHandle,
      selectExistingFlowForNodeRef,
    ]
  );

  const graphPaneCanvas = useMemo(
    () => ({
      contextMenuRoute: graph.contextMenuRoute,
      connectContextMenuToNode: graph.connectContextMenuToNode,
      disconnectContextMenuRoute: graph.disconnectContextMenuRoute,
      autoLayoutEnabled: flow.autoLayoutEnabled,
      setAutoLayoutEnabled: flow.setAutoLayoutEnabled,
      highlightedNodeIds: simulationTrace?.pathNodeIds,
      highlightedEdgeIds: simulationTrace?.pathEdgeIds,
      focusedNodeId: simulationTrace?.actionNodeId,
      canvasSelection,
      flowWrapperRef,
      loadingFlow,
      setReactFlowInstance,
      scenarioGraphResources: graphResourceState,
      interactionMode: canvasInteractionMode,
      helperLines,
      contextMenu,
      closeContextMenu,
      contextMenuSourceLabel,
      contextMenuSections,
      addNodeFromPaletteItem,
      addEmptyCanvasRootNode,
      onNodesChange,
      onEdgesChange,
      onConnect,
      isValidConnection,
      onConnectStart,
      onConnectEnd,
      onSelectionChange: onCanvasSelectionChange,
      onEdgeClick: onCanvasEdgeClick,
      onBeforeDelete: onBeforeCanvasDelete,
      onNodeDrag: handleNodeDrag,
      onNodeDragStop: handleNodeDragStop,
      onNodeClick: handleCanvasNodeClick,
      onPaneClick: handleCanvasPaneClick,
      onPaneContextMenu: handlePaneContextMenu,
      onPaneMouseDown: handlePaneMouseDown,
      onPaneMouseUp: handlePaneMouseUp,
      onViewportChange,
      readInitialViewport,
      showDemoCallouts:
        !hasConnectedSources &&
        activeScenario?.presetId === DEMO_SCENARIO_PRESET_ID,
      showNoSourcePrompt:
        !hasConnectedSources &&
        Boolean(activeScenarioId) &&
        activeScenario?.presetId !== DEMO_SCENARIO_PRESET_ID,
    }),
    [
      graph.contextMenuRoute,
      graph.connectContextMenuToNode,
      graph.disconnectContextMenuRoute,
      flow.autoLayoutEnabled,
      flow.setAutoLayoutEnabled,
      simulationTrace,
      activeScenarioId,
      activeScenario?.presetId,
      contextMenu,
      closeContextMenu,
      contextMenuSections,
      flowWrapperRef,
      addNodeFromPaletteItem,
      addEmptyCanvasRootNode,
      canvasInteractionMode,
      canvasSelection,
      handleCanvasNodeClick,
      handleNodeDrag,
      handleNodeDragStop,
      handleCanvasPaneClick,
      handlePaneContextMenu,
      handlePaneMouseDown,
      handlePaneMouseUp,
      helperLines,
      contextMenuSourceLabel,
      loadingFlow,
      onConnect,
      isValidConnection,
      onConnectEnd,
      onConnectStart,
      onCanvasSelectionChange,
      onCanvasEdgeClick,
      onBeforeCanvasDelete,
      onEdgesChange,
      onNodesChange,
      onViewportChange,
      readInitialViewport,
      hasConnectedSources,
      graphResourceState,
      setReactFlowInstance,
    ]
  );

  const graphPaneTriggerLog = useMemo(
    () => ({
      showTriggerLogPanel,
      triggerLogs,
      triggerLogsHasMore,
      loadingTriggerLogs,
      loadTriggerLogs,
      loadMoreTriggerLogs,
      setShowTriggerLogPanel,
      onOpenPreview: openPreviewDrawer,
    }),
    [
      loadMoreTriggerLogs,
      loadTriggerLogs,
      loadingTriggerLogs,
      openPreviewDrawer,
      setShowTriggerLogPanel,
      showTriggerLogPanel,
      triggerLogs,
      triggerLogsHasMore,
    ]
  );

  const handlePendingConfirmationOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closePendingConfirmation();
      }
    },
    [closePendingConfirmation]
  );

  const viewDialogsProps: ComponentProps<typeof ScenariosViewDialogs> = useMemo(
    () => ({
      createTypeDialog: {
        open: showCreateTypeDialog,
        onOpenChange: setShowCreateTypeDialog,
        onSelect: handleGuidedScenarioCreate,
        onSelectRevenuePlaybook: handleOpenRevenuePlaybook,
      },
      revenuePlaybookDialog: {
        open: showRevenuePlaybookDialog,
        onOpenChange: setShowRevenuePlaybookDialog,
        workspaceId,
        sourceOptions: managedWhatsAppFlowProvisioningSources,
        isCreating: isCreatingScenario,
        onCreate: handleCreateRevenuePlaybook,
      },
      airiCreateDialog: {
        open: showAiriCreateDialog,
        onOpenChange: setShowAiriCreateDialog,
        templates: funnelTemplates,
        isCreating: isCreatingScenario,
        workspaceId,
        initialDraft: initialAiriCreateDraft,
        connectedSourceMentions,
        connectedSourceOptions,
        hasGoogleCalendar,
        higgsfieldUnavailableReason,
        onCreateGeneratedScenario: handleCreateGeneratedScenario,
      },
      linkedFlowPreviewDialog: {
        open: linkedFlowPreview.open,
        onOpenChange: handleLinkedFlowPreviewOpenChange,
        flowId: linkedFlowPreview.flowId,
        flowName: linkedFlowPreview.flowName,
        flowStatus: linkedFlowPreview.flowStatus,
        flowAction: linkedFlowPreview.flowAction,
        previewUrl: linkedFlowPreview.previewUrl,
        flowConfig: linkedFlowPreview.config,
        loading: linkedFlowPreview.loading,
        error: linkedFlowPreview.error,
      },
      previewDrawer: {
        onSimulationTrace: setSimulationTrace,
        open: isPreviewDrawerOpen,
        onOpenChange: handlePreviewDrawerOpenChange,
        workspaceId,
        availableChannels: audienceOptions.channels,
        draftScenario: draftScenarioForPreview,
      },
      activationImpactDialog: {
        open: Boolean(pendingActivationImpact),
        impact: pendingActivationImpact?.impact ?? null,
        onOpenChange: handleActivationImpactOpenChange,
        onConfirm: confirmActivationImpact,
        onShowBlock: handleShowActivationBlock,
      },
      pendingConfirmationDialog: {
        pendingConfirmation,
        cancelLabel: t("cancel"),
        createLabel: t("create"),
        deleteLabel: t("delete"),
        deleteDescription: t("deleteConfirm"),
        secondTriggerDescription: t("secondTriggerPrompt"),
        onConfirm: confirmPendingConfirmation,
        onOpenChange: handlePendingConfirmationOpenChange,
      },
    }),
    [
      audienceOptions.channels,
      connectedSourceMentions,
      connectedSourceOptions,
      hasGoogleCalendar,
      higgsfieldUnavailableReason,
      confirmActivationImpact,
      confirmPendingConfirmation,
      draftScenarioForPreview,
      funnelTemplates,
      handleActivationImpactOpenChange,
      handleShowActivationBlock,
      handleCreateGeneratedScenario,
      handleCreateRevenuePlaybook,
      handleOpenRevenuePlaybook,
      managedWhatsAppFlowProvisioningSources,
      showRevenuePlaybookDialog,
      setShowRevenuePlaybookDialog,
      handleGuidedScenarioCreate,
      initialAiriCreateDraft,
      handleLinkedFlowPreviewOpenChange,
      handlePendingConfirmationOpenChange,
      handlePreviewDrawerOpenChange,
      isCreatingScenario,
      isPreviewDrawerOpen,
      linkedFlowPreview.config,
      linkedFlowPreview.error,
      linkedFlowPreview.flowAction,
      linkedFlowPreview.flowId,
      linkedFlowPreview.flowName,
      linkedFlowPreview.flowStatus,
      linkedFlowPreview.loading,
      linkedFlowPreview.open,
      linkedFlowPreview.previewUrl,
      pendingActivationImpact,
      pendingConfirmation,
      setShowCreateTypeDialog,
      setShowAiriCreateDialog,
      showCreateTypeDialog,
      showAiriCreateDialog,
      t,
      workspaceId,
    ]
  );

  const handleCreateDemoScenario = useCallback(() => {
    if (scenarioCreateLocked) {
      toast.error(scenarioLimitMessage);
      return;
    }
    setDemoCreateFailed(false);
    demoAutoCreateAttemptedRef.current = true;
    void (async () => {
      const created = await createDemoScenario();
      if (!created) {
        setDemoCreateFailed(true);
      }
    })();
  }, [createDemoScenario, scenarioCreateLocked, scenarioLimitMessage]);

  const isAutoCreatingDemo = isDemoScenarioAutoCreatePending({
    hasConnectedSources,
    demoCreateFailed,
    scenarioCreateLocked,
  });

  const historyControls = useMemo(
    () => ({
      undo: flow.undoGraphChange,
      redo: flow.redoGraphChange,
      canUndo: flow.canUndoGraphChange,
      canRedo: flow.canRedoGraphChange,
    }),
    [
      flow.canRedoGraphChange,
      flow.canUndoGraphChange,
      flow.redoGraphChange,
      flow.undoGraphChange,
    ]
  );

  return {
    t,
    workspaceId,
    hasConnectedSources,
    hasGoogleCalendar,
    isFreePlan,
    scenarioCreateLocked,
    loadingScenarios,
    scenarios,
    activeScenarioId,
    activeScenarioName,
    activeScenarioPresetId: activeScenario?.presetId ?? null,
    isCreatingScenario,
    scenarioListLayoutItems,
    subscenarioIndicatorByScenarioId,
    activeScenarioGraphSettings,
    demoCreateFailed,
    isAutoCreatingDemo,
    graph: {
      undoGraphChange: flow.undoGraphChange,
      historyControls,
      data: graphPaneData,
      resources: graphPaneResources,
      nodeBridge: graphPaneNodeBridge,
      canvas: graphPaneCanvas,
      triggerLog: graphPaneTriggerLog,
    },
    dialogs: viewDialogsProps,
    sidebar: {
      onCreateScenario: openCreateTypeDialog,
      pendingScenarioId,
      onSelectScenario: selectScenario,
      onPrefetchScenario: prefetchScenario,
      onCancelScenarioPrefetch: cancelScenarioPrefetch,
      onScenarioNameCommit: saveScenarioName,
      onReorder: reorderScenarios,
      onScenarioSettingsSave: saveScenarioSettingsWithActivationGuard,
      onScenarioRoutingSettingsChange: saveScenarioPatch,
      onDeleteScenario: handleSidebarDeleteScenario,
      onNormalizeScenarioLayout: normalizeScenarioLayout,
      normalizeScenarioLayoutDisabled,
    },
    emptyState: {
      onCreateScenario: openCreateTypeDialog,
      onCreateDemoScenario: handleCreateDemoScenario,
    },
  };
}
