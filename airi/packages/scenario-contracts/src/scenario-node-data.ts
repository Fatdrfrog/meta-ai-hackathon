import type {
  WhatsAppComponent,
  WhatsAppFlowActionType,
} from "../../shared/src/types/whatsapp";

import type { ScenarioGenericActionAttachment } from "./scenario-action-attachments";
import type {
  ScenarioActionOutcomes,
  ScenarioActionRunConditions,
} from "./scenario-action-routing";
import type {
  CampaignVariableSourceConfig,
  ScenarioBulkRootConfig,
  ScenarioGeneratedAsset,
  ScenarioGeneratedTemplateDraft,
} from "./scenario-bulk";
import type { CampaignScheduleConfig } from "./campaign-schedule-config";
import type { ScenarioRecipientColumnSplitConfig } from "./scenario-recipient-column-split";
import type { GenerativeAIActionConfig } from "./scenario-generative-ai";
import type {
  ScenarioInstagramConfig,
  WhatsAppFlowConfig,
} from "./scenario-channel-configs";
import type {
  ScenarioActionReplyChannel,
  ScenarioActionType,
  ScenarioAudienceMode,
  ScenarioBuilderTriggerSummary,
  ScenarioConditionBranchConfig,
  ScenarioContextOptionId,
  ScenarioContextSelectionMode,
  ScenarioContextSourceEntry,
  ScenarioInteractiveNoReplySurface,
  ScenarioLogicType,
  ScenarioNodeKind,
  ScenarioPostActionConditionVariant,
  ScenarioReplyCtaType,
  ScenarioReplyMode,
  ScenarioTelegramQuickReplyButton,
  ScenarioTelegramQuickReplyRow,
  ScenarioTriggerConfig,
} from "./scenario-triggers";
import type { ScenarioWhatsAppServiceMessage } from "./whatsapp-service-message";
import type { ScenarioWhatsAppTemplateBindings } from "./scenario-whatsapp-template-bindings";
import type { ScenarioWhatsAppTemplateButtonIds } from "./whatsapp-template-button-ids";
import type { ScenarioWhatsAppTemplateForm } from "./scenario-form-answers";

export type ScenarioActionSelectorType =
  | ScenarioActionType
  | "telegram_builder"
  | "instagram_reply"
  | "email_reply"
  | "web_widget_reply"
  | "whatsapp_service_message";

export type ScenarioActionSourceId =
  | "whatsapp"
  | "instagram"
  | "telegram"
  | "email"
  | "web_widget"
  | "team"
  | "airi";

export type ScenarioActionSourceOption = {
  id: ScenarioActionSourceId;
  label: string;
};

export type ScenarioActionTypeOption = {
  id: ScenarioActionSelectorType;
  label: string;
};

export type ScenarioWhatsAppFlowOption = {
  id: string;
  name: string;
  sourceId?: string;
  status?: string;
};

export type ScenarioWhatsAppPreviewButton = {
  type:
    | "quick_reply"
    | "url"
    | "phone"
    | "flow"
    | "copy_code"
    | "request_contact_info"
    | "location_request";
  label: string;
  value?: string;
  flowId?: string;
  flowName?: string;
  flowJson?: string;
  flowAction?: WhatsAppFlowActionType;
  navigateScreen?: string;
};

export type ScenarioWhatsAppTemplatePreview = {
  headerText?: string;
  headerMediaFormat?: "IMAGE" | "VIDEO" | "DOCUMENT";
  headerMediaUrl?: string;
  bodyText: string;
  footerText?: string;
  buttons: ScenarioWhatsAppPreviewButton[];
};

/** Scenarios list entry when linking one scenario from another (selector + trigger summary). */
export type ScenarioUiLinkedScenarioOption = {
  id: string;
  name: string;
  triggers?: ScenarioBuilderTriggerSummary[];
};

export type ScenarioContextOption = {
  id: ScenarioContextOptionId;
  title: string;
  description: string;
  source: string;
  count: number;
  available: boolean;
};

export type ScenarioContextItem = {
  id: string;
  label: string;
  description?: string;
  meta?: string;
  updatedAt?: string | null;
  question?: string;
  answer?: string;
};

export type ScenarioWhatsAppTemplate = {
  id?: string;
  name: string;
  language: string;
  category?: string;
  status?: string;
  components?: WhatsAppComponent[];
};

/** Untrusted fields at migration/normalization boundaries; this is not a runnable node. */
export type ScenarioNodeDataInput = Partial<
  Record<keyof ScenarioNodeData, unknown>
>;

export type ScenarioNodeData = {
  kind: ScenarioNodeKind;
  bulkRootConfig?: ScenarioBulkRootConfig;
  scheduleConfig?: CampaignScheduleConfig;

  triggerConfig?: ScenarioTriggerConfig;
  logicType?: ScenarioLogicType;
  conditionBranches?: ScenarioConditionBranchConfig[];
  /** Bulk audience column split (first-match paths + Else). */
  recipientColumnSplit?: ScenarioRecipientColumnSplitConfig;
  /**
   * Per WhatsApp template action: map template vars → CSV columns / modes.
   * Used when the action is a bulk-route target (direct or via column split).
   */
  actionCampaignVariableConfigs?: Record<string, CampaignVariableSourceConfig>;
  postActionConditionVariant?: ScenarioPostActionConditionVariant;
  interactiveNoReplySurface?: ScenarioInteractiveNoReplySurface;
  linkedConditionId?: string;
  contextOptionId?: ScenarioContextOptionId;
  contextSelectionMode?: ScenarioContextSelectionMode;
  contextItemIds?: string[];
  contextSources?: ScenarioContextSourceEntry[];
  source?: string;
  audienceMode?: ScenarioAudienceMode;
  classificationCategory?: string;
  internalLabel?: string;
  customerIds?: string[];
  audienceFunnelStage?: string;
  audienceLastSeenDays?: number;
  actionRunConditions?: ScenarioActionRunConditions;
  actionOutcomes?: ScenarioActionOutcomes;
  actionType?: ScenarioActionType;
  actionGenerativeAIConfig?: GenerativeAIActionConfig;
  actionInstruction?: string;
  actionHandoffNotifyEmail?: string;
  actionHandoffNotifyWhatsapp?: string;
  actionReplyMode?: ScenarioReplyMode;
  actionReplyChannel?: ScenarioActionReplyChannel;
  actionReplyInstruction?: string;
  actionReplyText?: string;
  actionReplyTemplate?: string;
  actionReplyCtaType?: ScenarioReplyCtaType;
  actionReplyCtaLabel?: string;
  actionReplyCtaFlowId?: string;
  actionReplyCtaFlowName?: string;
  actionLinkUrls?: string[];
  actionAttachments?: ScenarioGenericActionAttachment[];
  /** Legacy URL-only action media field. New writes should use actionAttachments. */
  actionImageUrls?: string[];
  actionMediaAssets?: ScenarioGeneratedAsset[];
  bulkRecipientBranchId?: string;
  bulkRecipientCount?: number;
  generatedTemplateDraft?: ScenarioGeneratedTemplateDraft;
  actionSnippetId?: string;
  actionSnippetQuestion?: string;
  actionSnippetAnswer?: string;
  actionWhatsAppTemplateId?: string;
  actionWhatsAppTemplateName?: string;
  actionWhatsAppTemplateLanguage?: string;
  actionWhatsAppTemplateCategory?: string;
  actionWhatsAppTemplateComponents?: WhatsAppComponent[];
  actionWhatsAppTemplateBindings?: ScenarioWhatsAppTemplateBindings;
  /** Ids of the saved template's quick replies. Without it, ids are positions. */
  actionWhatsAppTemplateButtonIds?: ScenarioWhatsAppTemplateButtonIds;
  /** Fields of the form the template's FLOW button opens, read from its Flow. */
  actionWhatsAppTemplateForm?: ScenarioWhatsAppTemplateForm;
  actionFlowConfig?: WhatsAppFlowConfig | null;
  flowBranchSourceFieldId?: string;
  flowBranchOptionId?: string;
  flowBranchOptionLabel?: string;
  actionTelegramQuickReplies?:
    | ScenarioTelegramQuickReplyRow[]
    | ScenarioTelegramQuickReplyButton[];
  actionInstagramConfig?: ScenarioInstagramConfig;
  actionWhatsAppServiceMessage?: ScenarioWhatsAppServiceMessage;
  telegramBranchPayload?: string;
  telegramBranchLabel?: string;
  instagramBranchPayload?: string;
  instagramBranchLabel?: string;
  whatsAppSessionChoicePayload?: string;
  whatsAppSessionChoiceLabel?: string;
  whatsAppTemplateButtonPayload?: string;
  whatsAppTemplateButtonLabel?: string;
  linkedScenarioId?: string;
  linkedScenarioName?: string;
};

/**
 * Closed persisted-node bag. Nest new fields under existing configs
 * (`actionWhatsAppServiceMessage`, `actionFlowConfig`,
 * `actionGenerativeAIConfig`, `actionInstagramConfig`, `bulkRootConfig`,
 * `triggerConfig`). Expanding this list is the explicit exception.
 * `actionWhatsAppTemplateForm` is an approved one: routing reads
 * `actionFlowConfig`, so a template's form fields read from its Flow are
 * kept apart from it.
 */
export const SCENARIO_NODE_DATA_KEYS = [
  "kind",
  "bulkRootConfig",
  "scheduleConfig",
  "triggerConfig",
  "logicType",
  "conditionBranches",
  "recipientColumnSplit",
  "actionCampaignVariableConfigs",
  "postActionConditionVariant",
  "interactiveNoReplySurface",
  "linkedConditionId",
  "contextOptionId",
  "contextSelectionMode",
  "contextItemIds",
  "contextSources",
  "source",
  "audienceMode",
  "classificationCategory",
  "internalLabel",
  "customerIds",
  "audienceFunnelStage",
  "audienceLastSeenDays",
  "actionRunConditions",
  "actionOutcomes",
  "actionType",
  "actionGenerativeAIConfig",
  "actionInstruction",
  "actionHandoffNotifyEmail",
  "actionHandoffNotifyWhatsapp",
  "actionReplyMode",
  "actionReplyChannel",
  "actionReplyInstruction",
  "actionReplyText",
  "actionReplyTemplate",
  "actionReplyCtaType",
  "actionReplyCtaLabel",
  "actionReplyCtaFlowId",
  "actionReplyCtaFlowName",
  "actionLinkUrls",
  "actionAttachments",
  "actionImageUrls",
  "actionMediaAssets",
  "bulkRecipientBranchId",
  "bulkRecipientCount",
  "generatedTemplateDraft",
  "actionSnippetId",
  "actionSnippetQuestion",
  "actionSnippetAnswer",
  "actionWhatsAppTemplateId",
  "actionWhatsAppTemplateName",
  "actionWhatsAppTemplateLanguage",
  "actionWhatsAppTemplateCategory",
  "actionWhatsAppTemplateComponents",
  "actionWhatsAppTemplateBindings",
  "actionWhatsAppTemplateButtonIds",
  "actionWhatsAppTemplateForm",
  "actionFlowConfig",
  "flowBranchSourceFieldId",
  "flowBranchOptionId",
  "flowBranchOptionLabel",
  "actionTelegramQuickReplies",
  "actionInstagramConfig",
  "actionWhatsAppServiceMessage",
  "telegramBranchPayload",
  "telegramBranchLabel",
  "instagramBranchPayload",
  "instagramBranchLabel",
  "whatsAppSessionChoicePayload",
  "whatsAppSessionChoiceLabel",
  "whatsAppTemplateButtonPayload",
  "whatsAppTemplateButtonLabel",
  "linkedScenarioId",
  "linkedScenarioName",
] as const satisfies readonly (keyof ScenarioNodeData)[];

export type ScenarioNodeDataKey = (typeof SCENARIO_NODE_DATA_KEYS)[number];

export const SCENARIO_NODE_DATA_NESTED_CONFIG_KEYS = [
  "bulkRootConfig",
  "scheduleConfig",
  "triggerConfig",
  "recipientColumnSplit",
  "actionGenerativeAIConfig",
  "actionFlowConfig",
  "actionInstagramConfig",
  "actionWhatsAppServiceMessage",
  "actionOutcomes",
  "actionWhatsAppTemplateBindings",
  "actionWhatsAppTemplateButtonIds",
  "actionWhatsAppTemplateForm",
  "actionRunConditions",
] as const satisfies readonly ScenarioNodeDataKey[];

const SCENARIO_NODE_DATA_KEY_SET = new Set<string>(SCENARIO_NODE_DATA_KEYS);

export function isScenarioNodeDataKey(key: string): key is ScenarioNodeDataKey {
  return SCENARIO_NODE_DATA_KEY_SET.has(key);
}

export type ScenarioGenerationJobRefreshResult =
  | { status: "applied" }
  | { status: "no_op" }
  | { status: "conflict" }
  | { status: "failed" };
