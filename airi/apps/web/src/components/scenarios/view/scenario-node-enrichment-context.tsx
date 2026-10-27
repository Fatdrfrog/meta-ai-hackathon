"use client";

import type {
  ConnectedScenarioActionSource,
  ScenarioSourceCapabilities,
} from "@/components/scenarios/scenario-onboarding";
import type { ManagedWhatsAppFlowProvisioningHost } from "@/components/scenarios/builders/whatsapp/managed-provisioning-host";
import type {
  GeneratedBulkSendScenarioUpdate,
  RegisteredBusinessPhonesAudienceSummary,
} from "@/lib/campaign/bulk-campaign-contracts";
import type {
  ScenarioActionAttachment,
  ScenarioAudienceOptions,
  ScenarioContextItem,
  ScenarioContextOption,
  ScenarioFlowEdge,
  ScenarioFlowNode,
  ScenarioGenerationJobRefreshResult,
  ScenarioGenerationJobServerUpdate,
  ScenarioNodeData,
  ScenarioStatus,
  ScenarioUiLinkedScenarioOption,
  ScenarioWhatsAppFlowOption,
  ScenarioWhatsAppTemplate,
} from "@/components/scenarios/types";
import type { BranchDescriptor } from "@/components/scenarios/view/graph/branch-sync";
import { useLatestRef } from "@/components/scenarios/view/use-latest-ref";
import { isSameIndexSnapshot } from "@/components/scenarios/view/node-enrichment/enrichment-view";
import {
  buildScenarioNodeGraphIndex,
  type ScenarioNodeGraphIndex,
} from "@/components/scenarios/view/node-enrichment/scenario-node-graph-index";
import type {
  ScenarioActionRoutingPatch,
  ScenarioLegacyActionRoutingPresentation,
  ScenarioLegacyActionRoutingSource,
} from "@icecore/scenario-contracts";
import type { WhatsAppFlowActionType } from "@icecore/shared/types/whatsapp";
import type { ScenarioEditorValidationMode } from "./node-enrichment/types";
import type { LoadWhatsAppTemplateForm } from "./use-scenario-template-form-loader";
import type { WhatsAppQrTriggerPickerProps } from "@/components/scenarios/nodes/trigger-node/whatsapp-qr-trigger-picker";
import type { BusinessEventTriggerCatalog } from "../nodes/trigger-node/business-event-trigger-model";
import {
  createContext,
  use,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

export type ScenarioDisplayNodeCallbacks = {
  selectNodeById: (nodeId: string | null) => void;
  updateNodeById: (nodeId: string, patch: Partial<ScenarioNodeData>) => void;
  convertLegacyActionRouting?: (input: {
    sourceActionNodeId: string;
    sourceNodeId: string;
    sourceKind: ScenarioLegacyActionRoutingSource["sourceKind"];
    patch: ScenarioActionRoutingPatch;
  }) => Promise<boolean>;
  removeNodeById: (nodeId: string) => void;
  updateNodeContextOptionById: (
    nodeId: string,
    contextOptionId: string
  ) => void;
  updateNodeContextSelectionModeById: (
    nodeId: string,
    mode: "all" | "specific"
  ) => void;
  toggleContextItemSelectionById: (nodeId: string, itemId: string) => void;
  selectContextItemsById: (nodeId: string, itemIds: string[]) => void;
  clearContextItemSelectionById: (nodeId: string) => void;
  toggleContextSourceById: (
    nodeId: string,
    optionId: string,
    enabled: boolean
  ) => void;
  updateContextSourceSelectionModeById: (
    nodeId: string,
    optionId: string,
    mode: "all" | "specific"
  ) => void;
  toggleContextSourceItemById: (
    nodeId: string,
    optionId: string,
    itemId: string
  ) => void;
  selectContextSourceItemsById: (
    nodeId: string,
    optionId: string,
    itemIds: string[]
  ) => void;
  clearContextSourceItemSelectionById: (
    nodeId: string,
    optionId: string
  ) => void;
  updateTriggerConfigById: (
    nodeId: string,
    patch: Partial<import("@/components/scenarios/types").ScenarioTriggerConfig>
  ) => void;
  updateActionWhatsAppTemplateById: (
    nodeId: string,
    templateValue: string
  ) => void;
  uploadActionImageForNodeId: (
    nodeId: string,
    file: File,
    options?: { persist?: boolean }
  ) => Promise<ScenarioActionAttachment | undefined>;
  generateActionVoiceForNodeId: (
    nodeId: string,
    params: { text: string; voiceId?: string }
  ) => Promise<ScenarioActionAttachment | undefined>;
  removeActionImageUrlByNodeId: (nodeId: string, imageUrl: string) => void;
  createAnswerSnippetFromNode: (
    nodeId: string,
    question: string,
    answer: string
  ) => Promise<void>;
  loadWhatsAppTemplates: (force?: boolean) => Promise<void>;
  loadContextItems: (
    contextOptionId: string,
    forceRefresh?: boolean
  ) => Promise<void>;
  loadWhatsAppFlows: (force?: boolean) => Promise<void>;
  openLinkedWhatsAppFlowPreview: (
    nodeId: string,
    flowId: string,
    flowAction?: WhatsAppFlowActionType,
    currentConfig?: ScenarioNodeData["actionFlowConfig"] | null
  ) => void | Promise<void>;
};

export type OpenNodePickerFromHandle = (
  nodeId: string,
  sourceHandleId: string | null,
  clientX: number,
  clientY: number
) => void;

export type SelectExistingFlowForNode = (
  nodeId: string,
  flow: ScenarioWhatsAppFlowOption
) => Promise<void>;

export type BranchSyncOptions = {
  /**
   * A template pick. It is recorded for Undo even when no route changed, so
   * its toast offers Undo; picking another template also names the routes
   * it kept on same-text buttons.
   */
  templatePick?: boolean;
};

export type HandleBranchSyncForNode = (
  actionNodeId: string,
  descriptorOrDescriptors: BranchDescriptor | BranchDescriptor[],
  actionNodePatch?: Partial<ScenarioNodeData>,
  options?: BranchSyncOptions
) => void;

/** With `scenarioId`, the change applies only while that scenario is open. */
type ScenarioStatusChange = (
  status: ScenarioStatus,
  scenarioId?: string
) => void;

type ScenarioConfigCallbacks = {
  onScenarioStatusChange?: ScenarioStatusChange;
};

type AdoptScenarioActivation = (activation: {
  scenarioId: string;
  scenarioUpdatedAt: string;
  previousScenarioUpdatedAt: string | null;
}) => boolean;

/** Saves pending edits; null when they could not be saved. */
type PrepareScenarioBulkSend = () => Promise<(() => void) | null>;

type PublishManagedWhatsAppFlow = (
  params: Parameters<ManagedWhatsAppFlowProvisioningHost["publish"]>[0] & {
    nodeId: string;
  }
) => ReturnType<ManagedWhatsAppFlowProvisioningHost["publish"]>;

export type ScenarioNodeEnrichmentContextValue = {
  businessEventCatalog?: BusinessEventTriggerCatalog;
  refreshBusinessEventCatalog?: () => void;
  validationMode?: ScenarioNodeEnrichmentScenarioSettings["validationMode"];
  selectedNodeId: string | null;
  /** Workspace flag: supported nodes are edited in the settings panel. */
  nodeSettingsPanelEnabled: boolean;
  /** Node whose settings were opened from the keyboard; the panel consumes it. */
  nodeSettingsFocusRequestRef: RefObject<string | null>;
  callbacksRef: RefObject<ScenarioDisplayNodeCallbacks>;
  scenarioCallbacksRef: RefObject<ScenarioConfigCallbacks>;
  handleBranchSyncForNodeRef: RefObject<HandleBranchSyncForNode>;
  selectExistingFlowForNodeRef: RefObject<SelectExistingFlowForNode>;
  openNodePickerFromHandle: OpenNodePickerFromHandle;
  adoptGeneratedBulkServerUpdate: (
    update: GeneratedBulkSendScenarioUpdate,
    scenarioStatus?: ScenarioStatus
  ) => boolean;
  prepareScenarioBulkSend: PrepareScenarioBulkSend;
  adoptScenarioActivation: AdoptScenarioActivation;
  onScenarioActivationBlocked: (nodeIds: string[]) => void;
  reconcileGeneratedJobServerUpdate: (
    update: ScenarioGenerationJobServerUpdate
  ) => Promise<ScenarioGenerationJobRefreshResult>;
  prepareGeneratedJobRefresh: () => Promise<boolean>;
  submitGeneratedTemplateForNode: (nodeId: string) => Promise<boolean>;
  submittingGeneratedTemplateNodeId: string | null;
  loadWhatsAppTemplateForm: LoadWhatsAppTemplateForm;
  /** Template steps whose form fields are being read from WhatsApp. */
  loadingTemplateFormNodeIds: ReadonlySet<string>;
  publishManagedWhatsAppFlow: PublishManagedWhatsAppFlow;
  scenarioSessionOwnerKey: string;
  publishingManagedFlowNodeId: string | null;
  graphIndex: ScenarioNodeGraphIndex;
  filteredContextOptions: ScenarioContextOption[];
  audienceOptions: ScenarioAudienceOptions;
  contextItemsByOptionId: Record<string, ScenarioContextItem[]>;
  scenarioLinkOptions: ScenarioUiLinkedScenarioOption[];
  whatsAppFlows: ScenarioWhatsAppFlowOption[];
  whatsAppTemplates: ScenarioWhatsAppTemplate[];
  isCreatingSnippet: boolean;
  openingLinkedWhatsAppFlowId: string | null;
  openingLinkedWhatsAppFlowNodeId: string | null;
  activeScenarioId: string | null;
  workspaceId: string;
  t: (key: string, values?: Record<string, string | number | Date>) => string;
  knowledgeDisabledReason: string | null;
  sourceCapabilities: ScenarioSourceCapabilities;
  connectedActionSources: ConnectedScenarioActionSource[];
  managedWhatsAppFlowProvisioningSources: ManagedWhatsAppFlowProvisioningHost["sources"];
  registeredBusinessPhonesAudience: RegisteredBusinessPhonesAudienceSummary | null;
  legacyRoutingByActionId: ReadonlyMap<
    string,
    ScenarioLegacyActionRoutingPresentation
  >;
  linkedConditionParentCountByNodeId: ReadonlyMap<string, number>;
  getWhatsAppQrPickerProps: (
    nodeId: string
  ) => WhatsAppQrTriggerPickerProps | null;
};

const ScenarioNodeEnrichmentContext =
  createContext<ScenarioNodeEnrichmentContextValue | null>(null);

const DEFAULT_SOURCE_CAPABILITIES: ScenarioSourceCapabilities = {
  hasWhatsApp: false,
  hasWhatsAppCoexistence: false,
  hasMetaAds: false,
};
const EMPTY_LEGACY_ROUTING_BY_ACTION_ID = new Map<
  string,
  ScenarioLegacyActionRoutingPresentation
>();
const EMPTY_LINKED_CONDITION_PARENT_COUNT_BY_NODE_ID = new Map<
  string,
  number
>();
const NOOP_GET_WHATSAPP_QR_PICKER_PROPS = (_nodeId: string) => null;
const EMPTY_MANAGED_WHATSAPP_FLOW_PROVISIONING_SOURCES: ManagedWhatsAppFlowProvisioningHost["sources"] =
  [];
const EMPTY_CONNECTED_ACTION_SOURCES: ConnectedScenarioActionSource[] = [];
const EMPTY_SCENARIO_LINK_OPTIONS: ScenarioUiLinkedScenarioOption[] = [];
const EMPTY_WHATSAPP_FLOWS: ScenarioWhatsAppFlowOption[] = [];
const EMPTY_WHATSAPP_TEMPLATES: ScenarioWhatsAppTemplate[] = [];
const EMPTY_CONTEXT_OPTIONS: ScenarioContextOption[] = [];

/** One empty list for every render, so an empty resource never looks new. */
function stableList<T extends readonly unknown[]>(
  items: T | undefined,
  empty: T
): T {
  return items && items.length > 0 ? items : empty;
}

export function useScenarioNodeEnrichment(): ScenarioNodeEnrichmentContextValue {
  const ctx = use(ScenarioNodeEnrichmentContext);
  if (!ctx)
    throw new Error(
      "useScenarioNodeEnrichment must be used within ScenarioNodeEnrichmentProvider"
    );
  return ctx;
}

type ScenarioGraphContent = {
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
  legacyRoutingByActionId: ReadonlyMap<
    string,
    ScenarioLegacyActionRoutingPresentation
  >;
};

function isSameEdge(left: ScenarioFlowEdge, right: ScenarioFlowEdge): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left) as (keyof ScenarioFlowEdge)[];
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every(
      key => Object.hasOwn(right, key) && Object.is(left[key], right[key])
    )
  );
}

/**
 * Same nodes (by id and data) and edges in the same order. Positions and
 * measured sizes are left out: neither the graph index nor any node's
 * editor data reads them.
 */
function isSameGraphContent(
  left: ScenarioGraphContent,
  right: ScenarioGraphContent
): boolean {
  return (
    left.nodes.length === right.nodes.length &&
    left.edges.length === right.edges.length &&
    left.nodes.every(
      (node, index) =>
        node.id === right.nodes[index].id &&
        node.data === right.nodes[index].data
    ) &&
    left.edges.every((edge, index) => isSameEdge(edge, right.edges[index])) &&
    isSameIndexSnapshot(
      left.legacyRoutingByActionId,
      right.legacyRoutingByActionId
    )
  );
}

/**
 * The graph as the index reads it. React Flow's size measurements and drags
 * replace the node array but keep every node's data, so they keep this
 * snapshot, the graph index and the context value.
 */
function useScenarioGraphContent(
  next: ScenarioGraphContent
): ScenarioGraphContent {
  const [content, setContent] = useState(next);
  const unchanged =
    (content.nodes === next.nodes &&
      content.edges === next.edges &&
      content.legacyRoutingByActionId === next.legacyRoutingByActionId) ||
    isSameGraphContent(content, next);
  if (unchanged) return content;
  setContent(next);
  return next;
}

function useScenarioNodeGraphIndex(
  content: ScenarioGraphContent,
  whatsAppTemplates: ScenarioWhatsAppTemplate[],
  audienceOptions: ScenarioAudienceOptions,
  t: (key: string) => string
): ScenarioNodeGraphIndex {
  return useMemo(
    () =>
      buildScenarioNodeGraphIndex({
        nodes: content.nodes,
        edges: content.edges,
        whatsAppTemplates,
        audienceOptions,
        translate: t,
      }),
    [audienceOptions, content, t, whatsAppTemplates]
  );
}

type ScenarioBridgeCommands = Pick<
  ScenarioNodeEnrichmentBridge,
  | "openNodePickerFromHandle"
  | "adoptGeneratedBulkServerUpdate"
  | "prepareScenarioBulkSend"
  | "adoptScenarioActivation"
  | "onScenarioActivationBlocked"
  | "reconcileGeneratedJobServerUpdate"
  | "prepareGeneratedJobRefresh"
  | "submitGeneratedTemplateForNode"
  | "loadWhatsAppTemplateForm"
  | "publishManagedWhatsAppFlow"
>;

/**
 * The bridge commands nodes call from their handlers, stable for one
 * scenario session, so editor data built in an earlier pass keeps working
 * after the canvas replaces a command. A call runs the session's latest
 * command. Once another scenario is loaded, a call that resolves late runs
 * a command of its own session, whose owner-key guard refuses it, as a
 * command captured in a render did.
 */
function useSessionBridgeCommands(
  nodeBridge: ScenarioNodeEnrichmentBridge
): ScenarioBridgeCommands {
  const bridgeRef = useLatestRef(nodeBridge);
  const [sessionStart, setSessionStart] = useState(nodeBridge);
  const sameSession =
    sessionStart.scenarioSessionOwnerKey === nodeBridge.scenarioSessionOwnerKey;
  if (!sameSession) setSessionStart(nodeBridge);
  const start = sameSession ? sessionStart : nodeBridge;
  return useMemo(() => {
    const session = () =>
      bridgeRef.current.scenarioSessionOwnerKey ===
      start.scenarioSessionOwnerKey
        ? bridgeRef.current
        : start;
    return {
      openNodePickerFromHandle: (...args) =>
        session().openNodePickerFromHandle(...args),
      adoptGeneratedBulkServerUpdate: (...args) =>
        session().adoptGeneratedBulkServerUpdate(...args),
      prepareScenarioBulkSend: () => session().prepareScenarioBulkSend(),
      adoptScenarioActivation: (...args) =>
        session().adoptScenarioActivation(...args),
      onScenarioActivationBlocked: (...args) =>
        session().onScenarioActivationBlocked(...args),
      reconcileGeneratedJobServerUpdate: (...args) =>
        session().reconcileGeneratedJobServerUpdate(...args),
      prepareGeneratedJobRefresh: () => session().prepareGeneratedJobRefresh(),
      submitGeneratedTemplateForNode: (...args) =>
        session().submitGeneratedTemplateForNode(...args),
      loadWhatsAppTemplateForm: (...args) =>
        session().loadWhatsAppTemplateForm(...args),
      publishManagedWhatsAppFlow: (...args) =>
        session().publishManagedWhatsAppFlow(...args),
    };
  }, [bridgeRef, start]);
}

export type ScenarioNodeEnrichmentGraphState = {
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
  selectedNodeId?: string | null;
  legacyRoutingByActionId?: ReadonlyMap<
    string,
    ScenarioLegacyActionRoutingPresentation
  >;
  linkedConditionParentCountByNodeId?: ReadonlyMap<string, number>;
};

export type ScenarioNodeEnrichmentResources = {
  /** Event capabilities only; connected messaging sources are not event integrations. */
  businessEventCatalog?: BusinessEventTriggerCatalog;
  refreshBusinessEventCatalog?: () => void;
  audienceOptions: ScenarioAudienceOptions;
  contextOptions: ScenarioContextOption[];
  contextItemsByOptionId: Record<string, ScenarioContextItem[]>;
  isCreatingSnippet: boolean;
  t: (key: string, values?: Record<string, string | number | Date>) => string;
  whatsAppFlows: ScenarioWhatsAppFlowOption[];
  whatsAppTemplates: ScenarioWhatsAppTemplate[];
  openingLinkedWhatsAppFlowNodeId?: string | null;
  openingLinkedWhatsAppFlowId?: string | null;
  activeScenarioId?: string | null;
  workspaceId: string;
  scenarioLinkOptions?: ScenarioUiLinkedScenarioOption[];
  sourceCapabilities?: ScenarioSourceCapabilities;
  connectedActionSources?: ConnectedScenarioActionSource[];
  managedWhatsAppFlowProvisioningSources?: ManagedWhatsAppFlowProvisioningHost["sources"];
  registeredBusinessPhonesAudience?: RegisteredBusinessPhonesAudienceSummary | null;
  getWhatsAppQrPickerProps?: (
    nodeId: string
  ) => WhatsAppQrTriggerPickerProps | null;
  /** Workspace flag `scenario_node_settings_panel`; defaults to inline editing. */
  nodeSettingsPanelEnabled?: boolean;
};

export type ScenarioNodeEnrichmentBridge = {
  nodeCallbacks: ScenarioDisplayNodeCallbacks;
  adoptGeneratedBulkServerUpdate: (
    update: GeneratedBulkSendScenarioUpdate,
    scenarioStatus?: ScenarioStatus
  ) => boolean;
  prepareScenarioBulkSend: PrepareScenarioBulkSend;
  adoptScenarioActivation: AdoptScenarioActivation;
  onScenarioActivationBlocked: (nodeIds: string[]) => void;
  reconcileGeneratedJobServerUpdate: (
    update: ScenarioGenerationJobServerUpdate
  ) => Promise<ScenarioGenerationJobRefreshResult>;
  prepareGeneratedJobRefresh: () => Promise<boolean>;
  submitGeneratedTemplateForNode: (nodeId: string) => Promise<boolean>;
  submittingGeneratedTemplateNodeId: string | null;
  loadWhatsAppTemplateForm: LoadWhatsAppTemplateForm;
  loadingTemplateFormNodeIds: ReadonlySet<string>;
  publishManagedWhatsAppFlow: PublishManagedWhatsAppFlow;
  scenarioSessionOwnerKey: string;
  publishingManagedFlowNodeId: string | null;
  selectExistingFlowForNodeRef: RefObject<SelectExistingFlowForNode>;
  handleBranchSyncForNodeRef: RefObject<HandleBranchSyncForNode>;
  openNodePickerFromHandle: OpenNodePickerFromHandle;
};

export type ScenarioNodeEnrichmentScenarioSettings = {
  validationMode?: ScenarioEditorValidationMode;
  onScenarioStatusChange?: ScenarioStatusChange;
};

type ScenarioNodeEnrichmentProviderProps = {
  graph: ScenarioNodeEnrichmentGraphState;
  resources: ScenarioNodeEnrichmentResources;
  nodeBridge: ScenarioNodeEnrichmentBridge;
  scenarioSettings: ScenarioNodeEnrichmentScenarioSettings;
  children: ReactNode;
};

export function ScenarioNodeEnrichmentProvider({
  children,
  graph,
  resources,
  nodeBridge,
  scenarioSettings,
}: ScenarioNodeEnrichmentProviderProps) {
  const {
    nodes,
    edges,
    selectedNodeId = null,
    legacyRoutingByActionId = EMPTY_LEGACY_ROUTING_BY_ACTION_ID,
    linkedConditionParentCountByNodeId = EMPTY_LINKED_CONDITION_PARENT_COUNT_BY_NODE_ID,
  } = graph;
  const {
    audienceOptions,
    businessEventCatalog,
    refreshBusinessEventCatalog,
    contextOptions,
    contextItemsByOptionId,
    isCreatingSnippet,
    t,
    openingLinkedWhatsAppFlowNodeId = null,
    openingLinkedWhatsAppFlowId = null,
    activeScenarioId = null,
    workspaceId,
    sourceCapabilities = DEFAULT_SOURCE_CAPABILITIES,
    registeredBusinessPhonesAudience = null,
    getWhatsAppQrPickerProps = NOOP_GET_WHATSAPP_QR_PICKER_PROPS,
    nodeSettingsPanelEnabled = false,
  } = resources;
  const whatsAppFlows = stableList(
    resources.whatsAppFlows,
    EMPTY_WHATSAPP_FLOWS
  );
  const whatsAppTemplates = stableList(
    resources.whatsAppTemplates,
    EMPTY_WHATSAPP_TEMPLATES
  );
  const scenarioLinkOptions = stableList(
    resources.scenarioLinkOptions,
    EMPTY_SCENARIO_LINK_OPTIONS
  );
  const connectedActionSources = stableList(
    resources.connectedActionSources,
    EMPTY_CONNECTED_ACTION_SOURCES
  );
  const managedWhatsAppFlowProvisioningSources = stableList(
    resources.managedWhatsAppFlowProvisioningSources,
    EMPTY_MANAGED_WHATSAPP_FLOW_PROVISIONING_SOURCES
  );
  const {
    nodeCallbacks,
    submittingGeneratedTemplateNodeId,
    loadingTemplateFormNodeIds,
    scenarioSessionOwnerKey,
    publishingManagedFlowNodeId,
    selectExistingFlowForNodeRef,
    handleBranchSyncForNodeRef,
  } = nodeBridge;
  const {
    adoptGeneratedBulkServerUpdate,
    prepareScenarioBulkSend,
    adoptScenarioActivation,
    onScenarioActivationBlocked,
    prepareGeneratedJobRefresh,
    submitGeneratedTemplateForNode,
    loadWhatsAppTemplateForm,
    publishManagedWhatsAppFlow,
    reconcileGeneratedJobServerUpdate,
    openNodePickerFromHandle,
  } = useSessionBridgeCommands(nodeBridge);
  const { onScenarioStatusChange, validationMode } = scenarioSettings;
  const filteredContextOptions = useMemo(
    () =>
      stableList(
        contextOptions.filter(
          option =>
            !["connected_channels", "dynamic_business_tags"].includes(
              String(option.id)
            )
        ),
        EMPTY_CONTEXT_OPTIONS
      ),
    [contextOptions]
  );

  const graphContent = useScenarioGraphContent({
    nodes,
    edges,
    legacyRoutingByActionId,
  });
  const graphIndex = useScenarioNodeGraphIndex(
    graphContent,
    whatsAppTemplates,
    audienceOptions,
    t
  );
  const knowledgeDisabledReason = useMemo(
    () =>
      graphIndex.allActionsNonAiReply ? t("knowledgeDisabledAllNonAi") : null,
    [graphIndex.allActionsNonAiReply, t]
  );

  const callbacksRef = useLatestRef(nodeCallbacks);
  const nodeSettingsFocusRequestRef = useRef<string | null>(null);
  const scenarioCallbacks = useMemo<ScenarioConfigCallbacks>(
    () => ({
      onScenarioStatusChange,
    }),
    [onScenarioStatusChange]
  );
  const scenarioCallbacksRef = useLatestRef(scenarioCallbacks);

  const value = useMemo<ScenarioNodeEnrichmentContextValue>(
    () => ({
      businessEventCatalog,
      refreshBusinessEventCatalog,
      validationMode,
      selectedNodeId,
      nodeSettingsPanelEnabled,
      nodeSettingsFocusRequestRef,
      callbacksRef,
      scenarioCallbacksRef,
      handleBranchSyncForNodeRef,
      selectExistingFlowForNodeRef,
      openNodePickerFromHandle,
      adoptGeneratedBulkServerUpdate,
      prepareScenarioBulkSend,
      adoptScenarioActivation,
      onScenarioActivationBlocked,
      prepareGeneratedJobRefresh,
      submitGeneratedTemplateForNode,
      submittingGeneratedTemplateNodeId,
      loadWhatsAppTemplateForm,
      loadingTemplateFormNodeIds,
      publishManagedWhatsAppFlow,
      scenarioSessionOwnerKey,
      publishingManagedFlowNodeId,
      reconcileGeneratedJobServerUpdate,
      graphIndex,
      filteredContextOptions,
      audienceOptions,
      contextItemsByOptionId,
      scenarioLinkOptions,
      whatsAppFlows,
      whatsAppTemplates,
      isCreatingSnippet,
      openingLinkedWhatsAppFlowId,
      openingLinkedWhatsAppFlowNodeId,
      activeScenarioId,
      workspaceId,
      t,
      knowledgeDisabledReason,
      sourceCapabilities,
      connectedActionSources,
      managedWhatsAppFlowProvisioningSources,
      registeredBusinessPhonesAudience,
      legacyRoutingByActionId: graphContent.legacyRoutingByActionId,
      linkedConditionParentCountByNodeId,
      getWhatsAppQrPickerProps,
    }),
    [
      businessEventCatalog,
      refreshBusinessEventCatalog,
      validationMode,
      selectedNodeId,
      nodeSettingsPanelEnabled,
      graphIndex,
      filteredContextOptions,
      audienceOptions,
      contextItemsByOptionId,
      scenarioLinkOptions,
      whatsAppFlows,
      whatsAppTemplates,
      isCreatingSnippet,
      openingLinkedWhatsAppFlowId,
      openingLinkedWhatsAppFlowNodeId,
      activeScenarioId,
      workspaceId,
      t,
      knowledgeDisabledReason,
      sourceCapabilities,
      connectedActionSources,
      managedWhatsAppFlowProvisioningSources,
      registeredBusinessPhonesAudience,
      graphContent.legacyRoutingByActionId,
      linkedConditionParentCountByNodeId,
      getWhatsAppQrPickerProps,
      callbacksRef,
      scenarioCallbacksRef,
      handleBranchSyncForNodeRef,
      selectExistingFlowForNodeRef,
      openNodePickerFromHandle,
      adoptGeneratedBulkServerUpdate,
      prepareScenarioBulkSend,
      adoptScenarioActivation,
      onScenarioActivationBlocked,
      prepareGeneratedJobRefresh,
      submitGeneratedTemplateForNode,
      submittingGeneratedTemplateNodeId,
      loadWhatsAppTemplateForm,
      loadingTemplateFormNodeIds,
      publishManagedWhatsAppFlow,
      scenarioSessionOwnerKey,
      publishingManagedFlowNodeId,
      reconcileGeneratedJobServerUpdate,
    ]
  );

  return (
    <ScenarioNodeEnrichmentContext.Provider value={value}>
      {children}
    </ScenarioNodeEnrichmentContext.Provider>
  );
}
