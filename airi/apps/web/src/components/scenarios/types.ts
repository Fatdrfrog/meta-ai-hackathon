import type {
  ScenarioDocumentDTO,
  ScenarioNodeData,
  ScenarioRawGraphNode,
  ScenarioRawGraphEdge,
  ScenarioSummaryDTO,
} from "@icecore/scenario-contracts";
import type { Edge, Node } from "@xyflow/react";

export type {
  CampaignVariableSourceConfig,
  ScenarioActionAttachment,
  ScenarioActionSelectorType,
  ScenarioActionSourceId,
  ScenarioActionSourceOption,
  ScenarioActionType,
  ScenarioAnswerMatchMode,
  ScenarioAnswerMatchRule,
  ScenarioAudienceCustomer,
  ScenarioAudienceOptions,
  ScenarioBuilderSummary,
  ScenarioBulkBatchPlan,
  ScenarioBulkColumnSplitPreview,
  ScenarioBulkConnectedAction,
  ScenarioBulkRecipientLimit,
  ScenarioBulkSendOptions,
  ScenarioCampaignRecipient,
  ScenarioConditionBranchConfig,
  ScenarioContextItem,
  ScenarioContextOption,
  ScenarioContextSelectionMode,
  ScenarioDetailResponseMetadata,
  ScenarioDetailResponseWarning,
  ScenarioDocumentDTO,
  ScenarioEntryPolicy,
  ScenarioGenerationJobRefreshResult,
  ScenarioInstagramButton,
  ScenarioInstagramConfig,
  ScenarioInstagramGenericCard,
  ScenarioInstagramMediaType,
  ScenarioInstagramMessageKind,
  ScenarioInstagramQuickReply,
  ScenarioMatchingRole,
  ScenarioMetaReferralAdOption,
  ScenarioMetaReferralAdSetOption,
  ScenarioMetaReferralCampaignOption,
  ScenarioNodeData,
  ScenarioNodeKind,
  ScenarioPostActionConditionType,
  ScenarioReplyCtaType,
  ScenarioReplyMode,
  ScenarioRecipientColumnSplitConfig,
  ScenarioRecipientColumnSplitOp,
  ScenarioRecipientColumnSplitPath,
  ScenarioRecipientColumnSplitRule,
  ScenarioStatus,
  ScenarioSummaryDTO,
  ScenarioTelegramQuickReplyRow,
  ScenarioTriggerConfig,
  ScenarioMessageMatchMode,
  ScenarioMetaAdsDataStatus,
  ScenarioUiLinkedScenarioOption,
  ScenarioViewport,
  ScenarioWhatsAppFlowOption,
  ScenarioWhatsAppPreviewButton,
  ScenarioWhatsAppTemplate,
  ScenarioWhatsAppTemplatePreview,
  WhatsAppFlowConfig,
  WhatsAppFlowFieldConfig,
  WhatsAppFlowFieldType,
  WhatsAppFlowNavigationMode,
  WhatsAppFlowNavigationItem,
  WhatsAppFlowScreenAction,
  WhatsAppFlowPayloadValue,
  WhatsAppFlowDataSchema,
  WhatsAppFlowScreenConfig,
  WhatsAppFlowTextType,
  WhatsAppFlowLayoutContentItem,
  WhatsAppFlowUiLocaleId,
} from "@icecore/scenario-contracts";

export {
  DEFAULT_SCENARIO_ENTRY_POLICY,
  DEFAULT_SCENARIO_VIEWPORT,
  isScenarioContextOptionId,
  normalizeScenarioEntryPolicy,
  normalizeScenarioPriority,
  WHATSAPP_FLOW_UI_LOCALE_IDS,
} from "@icecore/scenario-contracts";

export type ScenarioFlowNode = Node<ScenarioNodeData>;
export type ScenarioFlowEdge = Edge;

export type ScenarioGenerationJobServerUpdate = {
  generationJobId: string;
  previousScenarioUpdatedAt: string | null;
  scenarioUpdatedAt: string | null;
  scenarioRevisionConflict: boolean;
  nodeUpdates: Array<{ id: string; data: ScenarioNodeData }>;
};

export type ScenarioSummary = ScenarioSummaryDTO;

export type ScenarioRoutingSettingsPatch = Partial<
  Pick<ScenarioSummary, "entryPolicy">
>;

export type ScenarioDocument = ScenarioDocumentDTO<
  ScenarioRawGraphNode,
  ScenarioRawGraphEdge
>;

export type { FunnelSegmentKey } from "@icecore/scenario-contracts";

export type TranslateFn = (
  key: string,
  values?: Record<string, string | number | Date>
) => string;
