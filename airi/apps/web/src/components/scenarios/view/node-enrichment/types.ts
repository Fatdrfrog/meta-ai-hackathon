import type {
  ScenarioActionAttachment,
  ScenarioActionSelectorType,
  ScenarioActionSourceOption,
  ScenarioAudienceOptions,
  ScenarioBulkColumnSplitPreview,
  ScenarioBulkConnectedAction,
  ScenarioBulkSendOptions,
  ScenarioCampaignRecipient,
  ScenarioConditionBranchConfig,
  ScenarioContextItem,
  ScenarioContextOption,
  ScenarioContextSelectionMode,
  ScenarioFlowNode as PersistedScenarioFlowNode,
  ScenarioGenerationJobRefreshResult,
  ScenarioInstagramConfig,
  ScenarioNodeData,
  ScenarioNodeKind,
  ScenarioPostActionConditionType,
  ScenarioReplyMode,
  ScenarioTelegramQuickReplyRow,
  ScenarioTriggerConfig,
  ScenarioUiLinkedScenarioOption,
  ScenarioWhatsAppFlowOption,
  ScenarioWhatsAppTemplate,
  ScenarioWhatsAppTemplatePreview,
} from "../../types";
import type {
  ScenarioActionRoutingPatch,
  ScenarioLegacyActionRoutingPresentation,
} from "@icecore/scenario-contracts";
import type { ScenarioSourceCapabilities } from "../../scenario-onboarding";
import type {
  ScenarioFormAnswerChoice,
  ScenarioPickedOptionChoice,
  ScenarioRouteDestination,
} from "./scenario-node-graph-index";
import type { RegisteredBusinessPhonesAudienceSummary } from "@/lib/campaign/bulk-campaign-contracts";
import type { ManagedWhatsAppFlowProvisioningHost } from "../../builders/whatsapp/managed-provisioning-host";
import type { WhatsAppFlowActionType } from "@icecore/shared/types/whatsapp";
import type { Node, NodeProps } from "@xyflow/react";
import type { WhatsAppQrTriggerPickerProps } from "../../nodes/trigger-node/whatsapp-qr-trigger-picker";
import type {
  ScenarioTemplateFormLoadOptions,
  ScenarioTemplateFormLoadReason,
  ScenarioTemplateFormLoadResult,
} from "../use-scenario-template-form-loader";

export type ScenarioPersistedNodeDataOfKind<TKind extends ScenarioNodeKind> =
  Omit<ScenarioNodeData, "kind"> & { kind: TKind };

export type ScenarioEditorValidationMode = "draft" | "runnable";

export type ScenarioEditorNodeBase = {
  uiValidationMode?: ScenarioEditorValidationMode;
  /** The workspace edits supported nodes in the settings panel, not inline. */
  uiUsesSettingsPanel?: boolean;
  uiOnSelect: () => void;
  /** Opens node settings; keyboard activation also moves focus into them. */
  uiOnOpenSettings?: (options: { moveFocus: boolean }) => void;
  uiOnPatch: (patch: Partial<ScenarioNodeData>) => void;
  uiOnRemove: () => void;
  uiOnCreateNodeFromSourceHandle?: (
    sourceHandleId: string,
    clientX: number,
    clientY: number
  ) => void | Promise<void>;
};

export type ScenarioTriggerNodeEnrichment = {
  uiWorkspaceId?: string;
  uiNodeLabel: string;
  uiAudienceOptions: ScenarioAudienceOptions;
  uiTriggerConfig: ScenarioTriggerConfig;
  uiOnTriggerConfigChange: (patch: Partial<ScenarioTriggerConfig>) => void;
  uiIsEditorExpanded: boolean;
  uiHasMetaAdsConnection: boolean;
  uiWhatsAppQrPicker?: WhatsAppQrTriggerPickerProps | null;
};

export type ScenarioActionCommands = {
  changeType: (actionType: ScenarioActionSelectorType) => void;
  changeReplyMode: (mode: ScenarioReplyMode) => void;
  changeTelegramQuickReplies: (
    quickReplies: ScenarioTelegramQuickReplyRow[]
  ) => void;
  changeInstagramConfig: (config: ScenarioInstagramConfig) => void;
  convertLegacyRouting?: (
    patch: ScenarioActionRoutingPatch
  ) => void | Promise<void>;
};

export type ScenarioActionMedia = {
  upload: (
    file: File,
    options?: { persist?: boolean }
  ) => Promise<ScenarioActionAttachment | undefined>;
  generateVoice: (params: {
    text: string;
    voiceId?: string;
  }) => Promise<ScenarioActionAttachment | undefined>;
  remove: (imageUrl: string) => void;
};

export type ScenarioActionWhatsAppTemplates = {
  /** Match in the provider catalog, excluding the saved preview fallback. */
  catalogMatch?: boolean;
  options: ScenarioWhatsAppTemplate[];
  selectedValue: string;
  preview: ScenarioWhatsAppTemplatePreview | null;
  onOpenChange: (open: boolean) => void;
  select: (templateValue: string) => void;
  refresh: () => void | Promise<void>;
  submitGenerated: () => Promise<boolean>;
  submittingGenerated: boolean;
  /** The fields of the form the template's FLOW button opens, for AI steps. */
  formFields: {
    /**
     * The Flow `load` reads: the one the step's saved FLOW button opens, as
     * its saved fields and its Form submitted route read it. The step can
     * show the approved template's buttons when it saved none of its own.
     */
    flowId: string | null;
    loading: boolean;
    load: (
      reason: ScenarioTemplateFormLoadReason,
      options?: Omit<ScenarioTemplateFormLoadOptions, "reason">
    ) => Promise<ScenarioTemplateFormLoadResult>;
  };
};

export type ScenarioActionWhatsAppFlows = {
  options: ScenarioWhatsAppFlowOption[];
  openPicker: () => void;
  onCtaOptionsOpenChange: (open: boolean) => void;
  select: (flow: ScenarioWhatsAppFlowOption) => void | Promise<void>;
  openingPreviewId: string | null;
  openPreview: (
    flowId: string,
    flowAction?: WhatsAppFlowActionType
  ) => void | Promise<void>;
  refresh: () => void;
  managedProvisioningHost: ManagedWhatsAppFlowProvisioningHost;
};

export type ScenarioActionConnections = Readonly<{
  destinationsBySourceHandle?: ReadonlyMap<string, ScenarioRouteDestination>;
  sourceHandleIds: readonly string[];
  telegramPayloads: readonly string[];
  instagramPayloads: readonly string[];
  whatsAppChoicePayloads: readonly string[];
  flowBranchIds: readonly string[];
  templateButtonPayloads: readonly string[];
}>;

export type ScenarioActionNodeEnrichment = {
  actionPreviewText?: string;
  uiAudienceOptions?: ScenarioAudienceOptions;
  uiActionSourceOptions?: ScenarioActionSourceOption[];
  uiActionCommands: ScenarioActionCommands;
  uiMedia: ScenarioActionMedia;
  uiWhatsAppTemplates: ScenarioActionWhatsAppTemplates;
  uiWhatsAppFlows: ScenarioActionWhatsAppFlows;
  uiConnections: ScenarioActionConnections;
  uiLegacyActionRouting?: ScenarioLegacyActionRoutingPresentation | null;
  uiBulkPrimaryAction?: boolean;
  /**
   * A template a bulk send sends, by the rule the flow check refuses its
   * "Form submitted" route with: it offers none and reads no form fields.
   */
  uiBulkPrimaryWhatsAppTemplate?: boolean;
  /**
   * Whether the saved step offers a "Form submitted" route, as graph
   * validation and the runtime read it. A step that saved no buttons shows
   * the approved template's, its FLOW button too. Absent, the node data is
   * the saved step.
   */
  uiSavedStepOffersFormSubmittedRoute?: boolean;
  uiBulkRouteRecipients?: ScenarioCampaignRecipient[];
  uiInstagramReplyDisabledReason?: string | null;
  uiWorkspaceId?: string;
  uiActiveScenarioId?: string | null;
  uiActionNodeCount: number;
  uiScenarioPromptInputs?: ReadonlyArray<{
    key: string;
    label: string;
    prompt: string;
    /** A form's text field read as `{{input.<id>}}`; menus leave it out. */
    fromForm?: boolean;
  }>;
  /** Earlier buttons, list and carousel messages whose pick this node can read. */
  uiScenarioPickedOptionSources?: readonly ScenarioPickedOptionChoice[];
  /** Earlier forms whose answers this node's AI prompts can read. */
  uiScenarioFormAnswerSources?: readonly ScenarioFormAnswerChoice[];
  /** Every form's key by sending node, so this node's form keeps a unique one. */
  uiScenarioFormKeys?: ReadonlyMap<string, string>;
  /** The answers of this node's form AI prompts read, as their tokens. */
  uiScenarioFormAnswerTokensRead?: readonly string[];
  uiIncomingRouteCount?: number;
  /** A No reply route of a day or more leads here. */
  uiReachedAfterLongNoReply?: boolean;
  uiIsEditorExpanded: boolean;
  uiSourceCapabilities: ScenarioSourceCapabilities;
};

export type ScenarioBulkNodeEnrichment = {
  uiBulkConnectedAction?: ScenarioBulkConnectedAction | null;
  uiBulkColumnSplitPreview?: ScenarioBulkColumnSplitPreview | null;
  uiOnBulkSend?: (
    options?: ScenarioBulkSendOptions
  ) => unknown | Promise<unknown>;
  uiOnRefreshGenerationJob?: () =>
    | ScenarioGenerationJobRefreshResult
    | Promise<ScenarioGenerationJobRefreshResult>;
  uiOnOpenBulkRecipientMessages?: (branchId?: string) => void;
  uiWorkspaceId: string;
  uiActiveScenarioId?: string | null;
  uiRegisteredBusinessPhonesAudience: RegisteredBusinessPhonesAudienceSummary | null;
  uiOnConnectedActionPatch: (
    nodeId: string,
    patch: Partial<ScenarioNodeData>
  ) => void;
  /** Shows the steps that kept a send from activating its scenario. */
  uiOnScenarioActivationBlocked?: (nodeIds: string[]) => void;
  /** Loads the WhatsApp template catalog, which Send needs, if not loaded. */
  uiOnLoadWhatsAppTemplates?: () => void;
};

export type ScenarioContextNodeEnrichment = {
  uiAudienceOptions?: ScenarioAudienceOptions;
  uiKnowledgeDisabledReason?: string | null;
  uiContextOptions?: ScenarioContextOption[];
  uiContextItems?: ScenarioContextItem[];
  uiContextItemsByOptionId?: Record<string, ScenarioContextItem[]>;
  uiOnContextOptionChange?: (contextOptionId: string) => void;
  uiOnContextSelectionModeChange?: (mode: ScenarioContextSelectionMode) => void;
  uiOnContextItemToggle?: (itemId: string) => void;
  uiOnContextSelectVisible?: (itemIds: string[]) => void;
  uiOnContextClearSelection?: () => void;
  uiOnContextRefresh?: () => void;
  uiOnContextCreateSnippet?: (
    question: string,
    answer: string
  ) => Promise<void>;
  uiIsCreatingSnippet?: boolean;
  uiOnContextSourceToggle?: (optionId: string, enabled: boolean) => void;
  uiOnContextSourceSelectionModeChange?: (
    optionId: string,
    mode: ScenarioContextSelectionMode
  ) => void;
  uiOnContextSourceItemToggle?: (optionId: string, itemId: string) => void;
  uiOnContextSourceSelectVisible?: (
    optionId: string,
    itemIds: string[]
  ) => void;
  uiOnContextSourceClearSelection?: (optionId: string) => void;
  uiOnContextSourceRefresh?: (optionId: string) => void;
};

export type ScenarioLogicNodeEnrichment = {
  uiAudienceOptions?: ScenarioAudienceOptions;
  uiConditionBranches?: ScenarioConditionBranchConfig[];
  uiDestinationsBySourceHandle?: ReadonlyMap<
    string,
    Readonly<{ nodeId: string; label: string }>
  >;
  uiConnectedHandleIds?: ReadonlySet<string>;
  uiOnConditionBranchChange?: (
    branchType: ScenarioPostActionConditionType,
    patch: Partial<ScenarioConditionBranchConfig>
  ) => void;
  uiPostActionConditionScope?:
    | "default"
    | "flow_branch"
    | "telegram_branch"
    | "instagram_branch"
    | "whatsapp_session_choice";
  uiPostActionConditionScopeLabel?: string | null;
  uiRecipientColumnOptions?: string[];
  uiRecipientColumnValueSuggestions?: Record<string, string[]>;
  uiRecipientColumnSplitDisabledReason?: string | null;
  uiConnectedColumnSplitHandleIds?: ReadonlySet<string>;
  uiBulkColumnSplitPreview?: ScenarioBulkColumnSplitPreview | null;
};

export type ScenarioLinkNodeEnrichment = {
  uiScenarioOptions?: ScenarioUiLinkedScenarioOption[];
  uiIsEditorExpanded?: boolean;
};

export type ScenarioTriggerEditorNodeData =
  ScenarioPersistedNodeDataOfKind<"trigger"> &
    ScenarioEditorNodeBase &
    ScenarioTriggerNodeEnrichment;

export type ScenarioActionEditorNodeData =
  ScenarioPersistedNodeDataOfKind<"action"> &
    ScenarioEditorNodeBase &
    ScenarioActionNodeEnrichment;

export type ScenarioBulkEditorNodeData =
  ScenarioPersistedNodeDataOfKind<"bulk"> &
    ScenarioEditorNodeBase &
    ScenarioBulkNodeEnrichment;

export type ScenarioContextEditorNodeData =
  ScenarioPersistedNodeDataOfKind<"context"> &
    ScenarioEditorNodeBase &
    ScenarioContextNodeEnrichment;

export type ScenarioLogicEditorNodeData =
  ScenarioPersistedNodeDataOfKind<"logic"> &
    ScenarioEditorNodeBase &
    ScenarioLogicNodeEnrichment;

export type ScenarioLinkEditorNodeData =
  ScenarioPersistedNodeDataOfKind<"scenario_link"> &
    ScenarioEditorNodeBase &
    ScenarioLinkNodeEnrichment;

export type ScenarioEditorNodeData =
  | ScenarioTriggerEditorNodeData
  | ScenarioActionEditorNodeData
  | ScenarioBulkEditorNodeData
  | ScenarioContextEditorNodeData
  | ScenarioLogicEditorNodeData
  | ScenarioLinkEditorNodeData;

export type ScenarioFlowNode = PersistedScenarioFlowNode;
export type ScenarioEditorFlowNode =
  | ScenarioTriggerEditorFlowNode
  | ScenarioActionEditorFlowNode
  | ScenarioBulkEditorFlowNode
  | ScenarioContextEditorFlowNode
  | ScenarioLogicEditorFlowNode
  | ScenarioLinkEditorFlowNode;

export type ScenarioTriggerEditorFlowNode = Node<
  ScenarioTriggerEditorNodeData,
  "triggerNode"
>;
export type ScenarioActionEditorFlowNode = Node<
  ScenarioActionEditorNodeData,
  "actionNode"
>;
export type ScenarioBulkEditorFlowNode = Node<
  ScenarioBulkEditorNodeData,
  "bulkNode"
>;
export type ScenarioContextEditorFlowNode = Node<
  ScenarioContextEditorNodeData,
  "scenarioNode"
>;
export type ScenarioLogicEditorFlowNode = Node<
  ScenarioLogicEditorNodeData,
  "scenarioNode"
>;
export type ScenarioLinkEditorFlowNode = Node<
  ScenarioLinkEditorNodeData,
  "scenarioLinkNode"
>;

export type ScenarioTriggerEditorNodeProps =
  NodeProps<ScenarioTriggerEditorFlowNode>;
export type ScenarioActionEditorNodeProps =
  NodeProps<ScenarioActionEditorFlowNode>;
export type ScenarioBulkEditorNodeProps = NodeProps<ScenarioBulkEditorFlowNode>;
export type ScenarioContextEditorNodeProps =
  NodeProps<ScenarioContextEditorFlowNode>;
export type ScenarioLogicEditorNodeProps =
  NodeProps<ScenarioLogicEditorFlowNode>;
export type ScenarioLinkEditorNodeProps = NodeProps<ScenarioLinkEditorFlowNode>;
export type ScenarioContextOrLogicEditorNodeProps =
  | ScenarioContextEditorNodeProps
  | ScenarioLogicEditorNodeProps;
