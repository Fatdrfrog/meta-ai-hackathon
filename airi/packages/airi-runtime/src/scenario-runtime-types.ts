import type {
  ScenarioActionType,
  ScenarioActionAttachment,
  ScenarioContextOptionId,
  ScenarioFormAnswerFieldMap,
  ScenarioInstagramConfig,
  ScenarioTelegramQuickReplyRow,
  ScenarioWhatsAppServiceMessage,
  ScenarioWhatsAppTemplateBindings,
  ScenarioWhatsAppTemplateButtonIds,
  WhatsAppFlowConfig,
} from "@icecore/scenario-contracts";
import type { ScenarioPendingLegacyRouting } from "./scenario-state";
import type { StoredWhatsAppFlowFieldMetadataPreview } from "@icecore/shared/types/message-preview";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";

export type ScenarioDispatchTransition = {
  nextActionNodeId: string | null;
  completesScenario: boolean;
  pendingConditionNodeId?: string | null;
  pendingSourceActionNodeId?: string | null;
  pendingLinkedConditionId?: string | null;
  pendingLegacyRouting?: ScenarioPendingLegacyRouting | null;
};

export interface ScenarioRuntimeQuickReply {
  text: string;
  category?: string;
  channel?: string;
}

export type ScenarioRuntimeBlockedAction = {
  reason:
    | "whatsapp_service_message_invalid"
    | "whatsapp_service_message_unsupported";
  scenarioId: string;
  actionNodeId: string;
};

export interface AiriScenarioRuntimeConfig {
  scenarioId: string;
  scenarioName: string;
  /** Revision of the graph that selected this action, retained by its wait. */
  scenarioUpdatedAt?: string | null;
  evaluationId?: string;
  scenarioPriority?: number;
  selectedActionNodeId?: string;
  nextActionNodeId?: string | null;
  selectedPathNodeIds?: string[];
  selectedBranchNodeIds?: string[];
  completesScenario?: boolean;
  pendingConditionNodeId?: string | null;
  pendingSourceActionNodeId?: string | null;
  pendingLinkedConditionId?: string | null;
  pendingLegacyRouting?: ScenarioPendingLegacyRouting | null;
  lockedByConversationState?: boolean;
  actionType: ScenarioActionType;
  actionInstruction?: string;
  actionHandoffNotifyEmail?: string;
  actionHandoffNotifyWhatsapp?: string;
  actionReplyMode?: import("@icecore/scenario-contracts").ScenarioReplyMode;
  actionReplyChannel?: import("@icecore/scenario-contracts").ScenarioActionReplyChannel;
  actionReplyInstruction?: string;
  actionReplyText?: string;
  actionReplyTemplate?: string;
  actionReplyCtaType?: import("@icecore/scenario-contracts").ScenarioReplyCtaType;
  actionReplyCtaLabel?: string;
  actionReplyCtaFlowId?: string;
  actionSnippetId?: string;
  actionSnippetQuestion?: string;
  actionSnippetAnswer?: string;
  actionWhatsAppTemplateId?: string;
  actionWhatsAppTemplateName?: string;
  actionWhatsAppTemplateLanguage?: string;
  actionWhatsAppTemplateComponents?: WhatsAppComponent[];
  actionWhatsAppTemplateBindings?: ScenarioWhatsAppTemplateBindings;
  actionWhatsAppTemplateButtonIds?: ScenarioWhatsAppTemplateButtonIds;
  actionFlowConfig?: WhatsAppFlowConfig | null;
  actionLinkUrls?: string[];
  actionAttachments?: ScenarioActionAttachment[];
  actionImageUrls?: string[];
  includeConversationTimeline: boolean;
  includeConversationSummaries: boolean;
  includeSnippets: boolean;
  includeKBArticles: boolean;
  includeIndexedUrls: boolean;
  includeQuickReplies: boolean;
  includeCustomerProfile: boolean;
  includePurchaseHistory: boolean;
  includeActiveSubscriptions: boolean;
  includeDynamicBusinessTags: boolean;
  contextSourcePriority?: ScenarioContextOptionId[];
  conversationIds?: string[];
  snippetIds?: string[];
  kbArticleIds?: string[];
  indexedUrlIds?: string[];
  dynamicTags?: string[];
  quickReplies?: ScenarioRuntimeQuickReply[];
  actionTelegramQuickReplies?: ScenarioTelegramQuickReplyRow[];
  actionInstagramConfig?: ScenarioInstagramConfig;
  actionWhatsAppServiceMessage?: ScenarioWhatsAppServiceMessage;
  scenarioRevisionFingerprint?: string;
  actionGenerativeAI?: import("./scenario-graph").ScenarioFlowMatch["generativeAI"];
  actionGenerativeAISuccessTransition?: ScenarioDispatchTransition;
  actionGenerativeAIFailureTransition?: ScenarioDispatchTransition;
  /** Next action on the "ask was not met" edge. Missing edge does not end the scenario. */
  actionPromptInputsUnmetTransition?: ScenarioDispatchTransition;
  /**
   * Where a text ask continues once its details are met, set when its own
   * outcome wait holds the dispatch on it. Otherwise `nextActionNodeId` is
   * that route.
   */
  actionPromptInputsMetTransition?: ScenarioDispatchTransition;
  /**
   * The scenario's forms by sending step: their keys and labels, so answers
   * stored by step read as `{{form.<formKey>.<fieldKey>}}`. Absent when the
   * scenario sends no form.
   */
  formAnswerFields?: ScenarioFormAnswerFieldMap;
  /**
   * The fields a template step's form send stores, keyed as its reply sends
   * them, and the Flow they were read from. Absent when the form lists none.
   */
  actionFormResponseFields?: {
    flowId: string | null;
    fields: StoredWhatsAppFlowFieldMetadataPreview[];
  };
  /** Text answers submitted by the Flow that led to this action. */
  flowPromptInputCapture?: {
    sourceActionNodeId: string;
    values: Record<string, string>;
  };
  /**
   * The buttons, list or carousel message a tap chose from, when it also asks
   * for details: the tap may have to wait for them before this action runs.
   */
  choicePromptInputSource?: {
    actionNodeId: string;
    optionId: string;
    config: ScenarioWhatsAppServiceMessage;
  };
}

export function resolveScenarioRuntimeWhatsAppAppointmentConfig(
  runtime:
    | Pick<AiriScenarioRuntimeConfig, "actionWhatsAppServiceMessage">
    | null
    | undefined,
): import("@icecore/scenario-contracts").ScenarioWhatsAppBookCallConfig | null {
  const serviceMessage = runtime?.actionWhatsAppServiceMessage;
  return serviceMessage?.message.kind === "appointment"
    ? serviceMessage.message.config
    : null;
}

export interface AiriScenarioRuntimeResolution {
  runtime: AiriScenarioRuntimeConfig | null;
  /** The caller must preserve the current wait instead of completing it. */
  staleScenarioRevision?: boolean;
  whatsappQrTrace?: {
    referencePresent: true;
    outcome: "anchored" | "fail_closed";
    reasonCode?: string;
    entryPointId?: string;
    scenarioId?: string;
    nodeId?: string;
    codeId?: string;
  };
  blockedScenarioAction?: ScenarioRuntimeBlockedAction;
  containsTriggerMatchedNoAction?: boolean;
  lockedScenarioNoMatch?: {
    scenarioId: string;
    scenarioName: string;
    lastMatchedAt?: string | Date | null;
    lastActionNodeId?: string | null;
    lastMessageId?: string | null;
  };
  lockedScenarioMissing?: {
    scenarioId: string;
    scenarioName?: string | null;
  };
}
