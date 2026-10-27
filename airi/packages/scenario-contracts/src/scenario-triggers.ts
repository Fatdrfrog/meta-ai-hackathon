export type ScenarioNodeKind =
  | "bulk"
  | "trigger"
  | "context"
  | "logic"
  | "action"
  | "scenario_link";

export const SCENARIO_CONTEXT_OPTION_IDS = [
  "conversation_timeline",
  "knowledge_base_articles",
  "indexed_public_urls",
  "answer_snippets",
  "quick_replies",
  "customer_profile",
  "purchase_history",
  "active_subscriptions",
] as const;

export type ScenarioContextOptionId =
  (typeof SCENARIO_CONTEXT_OPTION_IDS)[number];

const SCENARIO_CONTEXT_OPTION_ID_SET = new Set<string>(
  SCENARIO_CONTEXT_OPTION_IDS,
);

export function isScenarioContextOptionId(
  value: string,
): value is ScenarioContextOptionId {
  return SCENARIO_CONTEXT_OPTION_ID_SET.has(value);
}

/** RAG indexing uses the same id allowlist as context options. */
export const SCENARIO_RAG_CONTEXT_OPTION_IDS = SCENARIO_CONTEXT_OPTION_IDS;

export function isRagScenarioContextOptionId(
  value: string,
): value is ScenarioContextOptionId {
  return isScenarioContextOptionId(value);
}

export type ScenarioAudienceMode =
  | "all"
  | "classification"
  | "internalLabel"
  | "specificCustomers"
  | "has_purchase_history"
  | "funnel_stage"
  | "last_seen_greater_than_x_days"
  | "last_seen_days";

export type ScenarioContextSelectionMode = "all" | "specific";

export const SCENARIO_LOGIC_TYPES = [
  "audience_filter",
  "post_action_condition",
  "recipient_column_split",
] as const;

export type ScenarioLogicType = (typeof SCENARIO_LOGIC_TYPES)[number];

export const SCENARIO_POST_ACTION_CONDITION_TYPES = [
  "user_replied",
  "payment_detected",
  "no_reply_timeout",
] as const;

export type ScenarioPostActionConditionType =
  (typeof SCENARIO_POST_ACTION_CONDITION_TYPES)[number];

export const SCENARIO_POST_ACTION_CONDITION_VARIANTS = [
  "interactive_no_reply",
] as const;

export type ScenarioPostActionConditionVariant =
  (typeof SCENARIO_POST_ACTION_CONDITION_VARIANTS)[number];

export const SCENARIO_INTERACTIVE_NO_REPLY_SURFACES = [
  "telegram_builder",
  "instagram_reply",
  "whatsapp_session_choices",
  "whatsapp_flow",
] as const;

export type ScenarioInteractiveNoReplySurface =
  (typeof SCENARIO_INTERACTIVE_NO_REPLY_SURFACES)[number];

export type ScenarioAnswerMatchMode = "exact" | "intent";

export type ScenarioAnswerMatchRule = {
  id: string;
  mode: ScenarioAnswerMatchMode;
  text: string;
};

export type ScenarioConditionBranchConfig = {
  id: string;
  type: ScenarioPostActionConditionType;
  timeoutMinutes?: number;
  missingTextPhrases?: string[];
  answerMatchRules?: ScenarioAnswerMatchRule[];
  linkedConditionId?: string;
};

export type ScenarioContextSourceEntry = {
  optionId: ScenarioContextOptionId;
  selectionMode: ScenarioContextSelectionMode;
  itemIds: string[];
};

export type ScenarioActionType =
  | "reply"
  | "assign_human"
  | "end_scenario"
  | "whatsapp_template"
  | "generative_ai";

export type ScenarioReplyMode = "ai" | "fixed";

export type ScenarioActionReplyChannel =
  | "telegram"
  | "instagram"
  | "whatsapp"
  | "email"
  | "web_widget";

export type ScenarioReplyCtaType = "none" | "link" | "flow";

export type ScenarioMessageMatchMode = "any" | "exact" | "contains";

/**
 * Absent remains the legacy incoming-message trigger. QR provider state stays
 * outside the graph; the node only declares the ingress contract.
 */
export type ScenarioTriggerEntryPointType =
  | "message"
  | "whatsapp_qr"
  | "customer_behavior"
  | "business_event";

/** Editable integration intent only; no business-event ingress is executable yet. */
export type ScenarioBusinessEventConfig = {
  integrationId?: string;
  integrationName?: string;
  eventId?: string;
  eventName?: string;
  filters?: Array<{
    field: string;
    operator: "equals" | "not_equals";
    value: string;
  }>;
};

export const SCENARIO_TRIGGER_ENTRY_POINT_ID_MAX_LENGTH = 256;

export function normalizeWhatsAppQrEntryPointId(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 &&
    normalized.length <= SCENARIO_TRIGGER_ENTRY_POINT_ID_MAX_LENGTH
    ? normalized
    : undefined;
}

export {
  SCENARIO_TRIGGER_EVENT_KIND,
  type ScenarioTriggerEventKind,
} from "./scenario-message-events";

export type ScenarioTriggerConfig = {
  behavior?: import("./scenario-behavior").ScenarioBehaviorConfig;
  businessEvent?: ScenarioBusinessEventConfig;
  entryPointType?: ScenarioTriggerEntryPointType;
  entryPointId?: string;
  enabled?: boolean;
  messageMatchMode?: ScenarioMessageMatchMode;
  channelFilter?: string[];
  keywordPattern?: string;
  keywordMatchMode?: "contains" | "regex";
  whatsappReferralSourceTypes?: string[];
  whatsappReferralSourcePlatforms?: string[];
  metaReferralSourceIds?: string[];
  metaReferralCampaignIds?: string[];
  metaReferralAdSetIds?: string[];
  metaCampaignAdAccountId?: string;
  metaCampaignLabels?: Array<{ id: string; name?: string }>;
  metaCampaignNameFallbacks?: string[];
  onlyNewCustomers?: boolean;
};

export type ScenarioBuilderTriggerSummary = {
  triggerNodeId: string | null;
  triggerConfig: ScenarioTriggerConfig | null;
  label: string | null;
};

/** A kind "bulk" root: a builder campaign start or a follow-up root. */
export type ScenarioBuilderBulkRootSummary = {
  bulkNodeId: string | null;
  /** null when the root carries no known workflow kind. */
  workflowKind:
    | import("./scenario-generator").ScenarioGeneratorWorkflowKind
    | null;
};

export type ScenarioBuilderSummary = {
  triggers?: ScenarioBuilderTriggerSummary[];
  /**
   * Builder campaigns keep Scenario.mode "conversation", so whether a
   * scenario is a campaign is read from its bulk roots, not from the mode.
   */
  bulkRoots?: ScenarioBuilderBulkRootSummary[];
  primaryActionType?: ScenarioActionType | null;
};

export type ScenarioTelegramQuickReplyButton = {
  text: string;
  payload: string;
};

export type ScenarioTelegramQuickReplyRow = ScenarioTelegramQuickReplyButton[];
