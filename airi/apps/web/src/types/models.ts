import type {
  ConversationPreferredLanguage,
  ConversationStatus,
} from "@icecore/shared/types/conversation";
import type { ConversationClassificationProvenanceKind } from "@icecore/shared/lib/conversation-classification-freshness";
import type { RawSourcePayload } from "@icecore/shared/lib/raw-source-payload";
import type { MessageDirection } from "@icecore/shared/types/message";
import type { PaymentSuggestion } from "@icecore/shared/types/payment-evidence";
import type {
  AgentPerformanceScorecard,
  ClassificationPriority,
  ClassificationSentiment,
  ExtractedEntity,
  InteractionMetrics,
  KeyMoment,
} from "@icecore/shared/types/models";
import type { ConversationChannel } from "@icecore/shared/types/sources";
import type {
  StoredGroundedReplyOptionsPreview,
  StoredMessageEditMeta,
  StoredMessageMediaType,
  StoredTelegramReplyMarkupPreview,
  StoredWhatsAppCtaLinkPreview,
  StoredWhatsAppFlowPreview,
  StoredWhatsAppFlowReplyPreview,
  StoredWhatsAppServiceMessagePreview,
  StoredWhatsAppTemplatePreview,
} from "@icecore/shared/types/message-preview";
import type { TelegramStoredMessageMeta } from "@icecore/shared/types/telegram";
import type { WhatsAppStoredMessageMeta } from "@icecore/shared/types/whatsapp-message-meta";
import mongoose from "mongoose";

// ============================================================================
// MODEL DOCUMENT TYPES
// ============================================================================

// Define document types properly using mongoose Document interface

// Re-export shared types for convenience
export type { ConversationStatus } from "@icecore/shared/types/conversation";
export type { ConversationPreferredLanguage } from "@icecore/shared/types/conversation";
export type { MessageDirection } from "@icecore/shared/types/message";
export type {
  AgentPerformanceScorecard,
  ClassificationPriority,
  ClassificationSentiment,
  ExtractedEntity,
  InteractionMetrics,
  KeyMoment,
} from "@icecore/shared/types/models";
/** `Channel` = Mongo `conversation.channel` (subset of integration channels in `@icecore/shared/types/sources`). */
export type {
  ConversationChannel,
  ConversationChannel as Channel,
} from "@icecore/shared/types/sources";
export { isConversationChannel } from "@icecore/shared/types/sources";

export interface InstagramReferralMeta {
  source?: string;
  type?: string;
  ref?: string;
  adId?: string;
  campaignId?: string;
  campaignName?: string;
  adSetId?: string;
  adSetName?: string;
  productId?: string;
  productRetailerId?: string;
  title?: string;
  body?: string;
  mediaUrl?: string;
  sourceUrl?: string;
  adAccountId?: string;
  campaignLabels?: Array<{ id: string; name?: string | null }>;
  campaignLabelStatus?: "present" | "absent" | "unavailable";
}

export type WhatsAppProductInquiryPayload = {
  catalogId?: string | null;
  productRetailerId?: string | null;
  contextMessageId?: string | null;
} | null;

export type WhatsAppOrderPayload = {
  catalogId?: string | null;
  text?: string | null;
  productItems?: Array<{
    productRetailerId?: string | null;
    quantity?: number | null;
    itemPrice?: number | null;
    currency?: string | null;
  }>;
  totalQuantity?: number | null;
  totalAmount?: number | null;
  currency?: string | null;
} | null;

export type ConversationClassificationStatus =
  | "pending"
  | "processing"
  | "ready"
  | "review_required"
  | "failed"
  | "blocked"
  | "not_applicable";

export type ConversationClassificationLease = {
  ownerToken?: string | null;
  claimedAt?: Date | null;
  expiresAt?: Date | null;
} | null;

export type ConversationClassificationState = {
  contractVersion: 2;
  status: ConversationClassificationStatus;
  requestedRevision: number;
  processingRevision: number | null;
  appliedRevision: number | null;
  generation: number;
  attemptRevision: number;
  attemptCount: number;
  fence: number;
  requestedAt: Date | null;
  nextAttemptAt: Date | null;
  lastEnqueuedAt: Date | null;
  completedAt: Date | null;
  lease: ConversationClassificationLease;
  error?: {
    code?: string | null;
    message?: string | null;
    retryable?: boolean | null;
    at?: Date | null;
  } | null;
  review?: {
    code?: string | null;
    reason?: string | null;
    at?: Date | null;
  } | null;
  blocked?: {
    code?: string | null;
    reason?: string | null;
    recheckAt?: Date | null;
  } | null;
};

export interface ConversationDocument extends mongoose.Document {
  _id: mongoose.Types.ObjectId;
  customerId?: mongoose.Types.ObjectId | string | null;
  chat: {
    _id: number | string;
    type: "private" | "group" | "supergroup" | "channel";
  };
  user?: { _id: number | string };
  business_connection_id?: string;
  messages: (mongoose.Types.ObjectId | string)[];
  message_count?: number | null;
  status: ConversationStatus;
  channel: ConversationChannel;
  workspaceId: string;
  sourceId?: string;
  customerLinkedAt?: Date | null;
  customerLinkedBy?: string | null;
  customerLinkMethod?:
    | "system"
    | "backfill"
    | "manual"
    | "suggested"
    | "rule"
    | null;
  customerLinkConfidence?: number | null;
  lastMessageAt?: Date;
  last_outbound_at?: Date | string | null;
  last_inbound_at?: Date | string | null;
  first_inbound_at?: Date | string | null;
  first_response_at?: Date | string | null;
  first_response_seconds?: number | null;
  first_response_manager_id?: string | null;
  first_response_manager_name?: string | null;
  service_episode_started_at?: Date | string | null;
  service_closed_at?: Date | string | null;
  service_resolved_at?: Date | string | null;
  service_resolution_kind?: "manager" | "customer_csat" | "timeout" | "unknown" | null;
  service_lifecycle_revision?: number;
  service_lifecycle_event?: import("@/lib/analytics/service-lifecycle").ServiceLifecycleEnvelope | null;
  service_lifecycle_event_key?: string | null;
  subject?: string;
  rename?: string | null;
  campaign_recipient_name?: string | null;
  quick_note?: string | null;
  quick_note_updated_at?: Date | string | null;
  quick_note_updated_by?: string | null;
  participants?: {
    from?: string[];
    to?: string[];
  };
  external_thread?: {
    provider?: "postmark" | "instagram";
    type?: "comment";
    threadId?: string;
    permalink?: string;
    comment?: {
      id?: string;
      timestamp?: Date;
      parentId?: string;
      hidden?: boolean;
      likeCount?: number;
    };
    media?: {
      id?: string;
      mediaType?: string;
      mediaProductType?: string;
      shortcode?: string;
      timestamp?: Date;
      caption?: string;
      mediaUrl?: string;
      thumbnailUrl?: string;
      username?: string;
    };
    referral?: InstagramReferralMeta;
    headers?: Record<string, unknown>;
  };
  whatsappReferral?: {
    sourceType?: string | null;
    sourceId?: string | null;
    sourceUrl?: string | null;
    campaignId?: string | null;
    campaignName?: string | null;
    adSetId?: string | null;
    adSetName?: string | null;
    headline?: string | null;
    body?: string | null;
    mediaType?: string | null;
    imageUrl?: string | null;
    videoUrl?: string | null;
    thumbnailUrl?: string | null;
    ctwaClid?: string | null;
    ref?: string | null;
    welcomeMessageText?: string | null;
    capturedAt?: Date | null;
    adAccountId?: string | null;
    campaignLabels?: Array<{ id: string; name?: string | null }> | null;
    campaignLabelStatus?: "present" | "absent" | "unavailable" | null;
  } | null;
  history_summary?: string;
  airi_context_memory?: {
    version?: number | null;
    summary?: string | null;
    currentGoal?: string | null;
    unresolvedNeeds?: string[];
    resolvedNeeds?: string[];
    preferredLanguage?: string | null;
    coveredThroughMessageId?: string | null;
    coveredMessageCount?: number | null;
    updatedAt?: Date | null;
  } | null;
  is_classified: boolean;
  classification_revision?: number;
  payment_suggestions?: PaymentSuggestion[];
  classification_state?: ConversationClassificationState | null;
  classification?: {
    category?: string;
    priority?: ClassificationPriority;
    sentiment?: ClassificationSentiment;
    summary?: string;
    action?: string;
    tags?: string[];
    confidence?: {
      category?: number;
      priority?: number;
      sentiment?: number;
    };
  };
  shadow_classification?: {
    category?: string;
    priority?: ClassificationPriority;
    sentiment?: ClassificationSentiment;
    summary?: string;
    action?: string;
    tags?: string[];
    confidence?: {
      category?: number;
      priority?: number;
      sentiment?: number;
    };
  };
  classification_meta?: {
    provenance_kind?: ConversationClassificationProvenanceKind | null;
    taxonomy_id?: string | null;
    classifier_version?: string | null;
    source_revision?: number | null;
    taxonomy_digest?: string | null;
    classifier_contract_revision?: number | null;
    analysis_revision_id?: string | null;
    completed_at?: Date | null;
  };
  classification_error?: string | null;
  internal_labels?: string[];
  extracted_entities?: ExtractedEntity[];
  key_moments?: KeyMoment[];
  interaction_metrics?: InteractionMetrics;
  engagement_metrics?: {
    version: number;
    computedAt?: Date | string | null;
    messageCount: number;
    inboundCount: number;
    outboundCount: number;
    customerQuestionCount: number;
    firstMessageAt?: Date | string | null;
    lastMessageAt?: Date | string | null;
    activeDurationMinutes?: number | null;
    hasTwoWayConversation: boolean;
    turnSwitchCount: number;
    customerRepliesAfterOutbound: number;
    firstCustomerReplyDelayMinutes?: number | null;
    avgCustomerReplyDelayMinutes?: number | null;
    inboundMediaCount: number;
    inboundVoiceCount: number;
    flowSubmitCount: number;
    reactionCount: number;
    templateOutboundCount: number;
    campaignReplyCount: number;
    deliveredCount: number;
    readCount: number;
    score: number;
    scoreParts: {
      depth: number;
      reciprocity: number;
      intent: number;
      richness: number;
      delivery: number;
    };
  } | null;
  agent_performance_scorecard?: AgentPerformanceScorecard;
  is_best_practice: boolean;
  is_qa_analyzed: boolean;
  customer_satisfaction_score?: number | null;
  customer_satisfaction_comment?: string | null;
  awaiting_csat?: boolean;
  csat_timeout_closed?: boolean;
  estimated_customer_ltv?: number | null;
  health_score_snapshot?: number | null;
  health_score_factors?: Record<string, number> | null;
  health_scored_at?: Date | null;
  health_score_version?: number | null;
  churn_risk_level?: "none" | "low" | "medium" | "high" | null;
  handled_by_agent_id?: string;
  // Airi controls - separate for bot auto-replies, scenarios, and coach
  airi_bot_enabled?: boolean; // AI bot auto-replies - default OFF
  airi_scenarios_enabled?: boolean; // AI scenario automation - default ON
  airi_coach_enabled?: boolean; // AI coaching suggestions - default ON
  airi_assigned_by?: string | null;
  airi_handoff_active?: boolean;
  airi_handoff_started_at?: Date | null;
  airi_handoff_restore_bot_enabled?: boolean | null;
  airi_handoff_source?:
    | "scenario_contains"
    | "scenario_timeout"
    | "manual"
    | null;
  airi_handoff_reason?: string | null;
  airi_last_suppressed_at?: Date | null;
  airi_last_suppressed_reason?:
    | "manager_recently_replied"
    | "tagged_manager_message"
    | "scenario_handoff"
    | null;
  airi_last_suppressed_manager_user_id?: string | null;
  airi_last_suppressed_message_id?: string | null;
  airi_scenario_state?: {
    behaviorRunId?: string | null;
    lockedScenarioId?: string | null;
    lockedScenarioName?: string | null;
    currentActionNodeId?: string | null;
    currentPathNodeIds?: string[];
    currentBranchNodeIds?: string[];
    pendingConditionNodeId?: string | null;
    pendingSourceActionNodeId?: string | null;
    pendingLegacyRouting?: {
      kind: "interactive_no_reply_assignment";
      conditionNodeId: string;
      sourceActionNodeId: string;
    } | null;
    pendingStartedAt?: Date | string | null;
    pendingScenarioUpdatedAt?: Date | string | null;
    pendingLastOutboundMessageId?: string | null;
    pendingLinkedConditionId?: string | null;
    lastMatchedAt?: Date | string | null;
    lastMessageId?: string | null;
    collectedPromptInputs?: {
      scenarioId: string;
      sourceActionNodeId: string;
      awaitingReply: boolean;
      resumeActionNodeId: string | null;
      sourcePathNodeIds: string[];
      values: Record<string, string>;
      followsChoice?: boolean;
      choiceOptionId?: string | null;
      expiresAt?: Date | string | null;
      nudged?: boolean;
    } | null;
    pickedOptions?: {
      scenarioId: string;
      picks: Array<{
        sourceActionNodeId: string;
        optionId: string;
        label: string;
        cardIndex?: number;
        cardId?: string;
        cardBodyText?: string;
        cardMedia?: {
          url: string;
          mediaType: string;
          mimeType?: string;
          fileName?: string;
          fileSize?: number;
          bucket?: string;
          path?: string;
        };
        pickedAt: string;
      }>;
    } | null;
    formAnswers?: {
      scenarioId: string;
      submissions: Array<{
        sourceActionNodeId: string;
        flowId: string | null;
        inboundMessageId: string;
        submittedAt: string;
        fields: Array<{
          key: string;
          label: string;
          fieldType: string;
          value: string;
        }>;
      }>;
    } | null;
    routedLocations?: {
      scenarioId: string;
      entries: Array<{
        sourceActionNodeId: string;
        inboundMessageId: string;
        sharedAt: string;
        decidedAt: string;
        source: string;
        outcome: string;
        routeId?: string;
        office?: Record<string, unknown>;
        distanceMeters?: number;
        reason?: string;
      }>;
    } | null;
    startedScenarios?: Array<{
      scenarioId: string;
      scenarioName?: string | null;
      startedAt: Date | string;
      firstActionNodeId?: string | null;
      firstMessageId?: string | null;
    }>;
    completedScenarios?: Array<{
      scenarioId: string;
      scenarioName?: string | null;
      completedAt: Date | string;
      lastActionNodeId?: string | null;
      lastMessageId?: string | null;
    }>;
  } | null;
  // Legacy field for backward compatibility
  airi_enabled?: boolean;
  preferred_language?: ConversationPreferredLanguage;
  // Web widget specific fields (for multi-URL conversation grouping)
  page_url?: string; // The specific URL this conversation is associated with
  visitor_id?: string; // The visitor ID (for grouping conversations across URLs)
  embedding?: number[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatDocument extends mongoose.Document<string> {
  type:
    | "private"
    | "group"
    | "supergroup"
    | "channel"
    | "whatsapp"
    | "instagram"
    | "email";
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  whatsapp?: {
    waId?: string | null;
    userId?: string | null;
    parentUserId?: string | null;
    username?: string | null;
    profileName?: string | null;
    primaryIdType?:
      | "wa_id"
      | "user_id"
      | "parent_user_id"
      | "message_from"
      | null;
  } | null;
  is_forum?: boolean;
  participants?: number[];
  sourceId: string;
  workspaceId?: string;
  businessConnectionId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type MessageMediaAnalysisStatus =
  | "queued"
  | "processing"
  | "submitted"
  | "completed"
  | "failed"
  | "skipped";

export type MessageMediaAnalysisKind = "audio" | "voice" | "video";

export interface MessageMediaAnalysisState {
  status?: MessageMediaAnalysisStatus | null;
  kind?: MessageMediaAnalysisKind | null;
  workflowId?: string | null;
  sourceId?: string | null;
  requestedAt?: Date | string | null;
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
  lastError?: string | null;
  transcriptSource?: string | null;
  analysisSource?: string | null;
  provider?: string | null;
  providerRequestId?: string | null;
  providerWebhookId?: string | null;
  contractVersion?: number | null;
}

export interface MessageDocument extends mongoose.Document {
  _id: mongoose.Types.ObjectId;
  messageId?: number | string;
  /** Internal join key for phone/BSUID wamid twins. Not returned on chat API. */
  whatsappWamidFingerprint?: string | null;
  /** Private unique key for new inbound WhatsApp writes. */
  whatsappInboundDedupeKey?: string;
  /** Stable token shared by replayed recoveries of the same inbound content. */
  whatsappRecoveryRevision?: string;
  chat?: mongoose.Types.ObjectId | string | number | ChatDocument;
  author?: number | string;
  workspaceId: string;
  conversation: mongoose.Types.ObjectId;
  temporalDeliveryKey?: string | null;
  /** Private bootstrap outbox; never part of message API payloads. */
  airiIngressIntent?: unknown;
  widgetRequestHash?: string;
  origin?: {
    kind?:
      | "manager"
      | "airi"
      | "scenario"
      | "campaign"
      | "bulk_analytics"
      | "system"
      | null;
    campaignId?: string | null;
    scenarioId?: string | null;
    nodeId?: string | null;
    templateName?: string | null;
    templateCategory?: string | null;
    sourceId?: string | null;
    executionSource?: string | null;
    sentByUserId?: string | null;
  } | null;
  delivery?: {
    status?: "sent" | "delivered" | "read" | "played" | "failed" | null;
    lastEventAt?: Date | string | null;
    sentAt?: Date | string | null;
    deliveredAt?: Date | string | null;
    readAt?: Date | string | null;
    playedAt?: Date | string | null;
    failedAt?: Date | string | null;
    recipientId?: string | null;
    recipientWaId?: string | null;
    recipientUserId?: string | null;
    recipientParentUserId?: string | null;
    recipientUsername?: string | null;
    recipientType?: "individual" | "group" | string | null;
    recipientParticipantId?: string | null;
    recipientIdentityKeyHash?: string | null;
    errorCode?: number | null;
    errorMessage?: string | null;
    pricingCategory?: string | null;
    pricingType?: string | null;
    pricingModel?: string | null;
    conversationCategory?: string | null;
  } | null;
  channel: ConversationChannel;
  direction: MessageDirection;
  rawSourcePayload?: RawSourcePayload | null;
  text?: string;
  ragContext?: string;
  date: Date;
  subject?: string;
  html?: string;
  headers?: Record<string, unknown>;
  external_ids?: {
    messageId?: string;
  };
  attachments?: Array<{
    filename: string;
    url: string;
    contentType: string;
    sizeBytes: number;
  }>;
  imageUrl?: string;
  imageAnalysis?: string;
  audioAnalysis?: string;
  videoAnalysis?: string;
  mediaAnalysis?: MessageMediaAnalysisState | null;
  mediaType?: StoredMessageMediaType;
  mimeType?: string;
  fileName?: string;
  fileSize?: number;
  whatsappMediaId?: string | null;
  reactions?: Array<{
    emoji: string;
    authorId: string | number;
    authorName?: string;
    reactionMessageId?: string;
    date?: string | Date;
  }>;
  editMeta?: StoredMessageEditMeta | null;
  whatsappFlow?: StoredWhatsAppFlowPreview | null;
  whatsappFlowReply?: StoredWhatsAppFlowReplyPreview | null;
  whatsappTemplate?: StoredWhatsAppTemplatePreview | null;
  whatsappServiceMessage?: StoredWhatsAppServiceMessagePreview | null;
  whatsappCtaLink?: StoredWhatsAppCtaLinkPreview | null;
  groundedReplyOptions?: StoredGroundedReplyOptionsPreview | null;
  telegramReplyMarkup?: StoredTelegramReplyMarkupPreview | null;
  telegramMeta?: TelegramStoredMessageMeta | null;
  whatsappMeta?: WhatsAppStoredMessageMeta | null;
  whatsappGroup?: {
    groupId?: string | null;
    phoneNumberId?: string | null;
    sourceId?: string | null;
    senderWaId?: string | null;
    senderUserId?: string | null;
    senderParentUserId?: string | null;
    senderUsername?: string | null;
  } | null;
  whatsappLocation?: {
    latitude?: number | null;
    longitude?: number | null;
    name?: string | null;
    address?: string | null;
    url?: string | null;
  } | null;
  whatsappContacts?: Array<Record<string, unknown>> | null;
  whatsappProductInquiry?: WhatsAppProductInquiryPayload;
  whatsappOrder?: WhatsAppOrderPayload;
  whatsappReferral?: {
    sourceType?: string | null;
    sourceId?: string | null;
    sourceUrl?: string | null;
    campaignId?: string | null;
    campaignName?: string | null;
    adSetId?: string | null;
    adSetName?: string | null;
    headline?: string | null;
    body?: string | null;
    mediaType?: string | null;
    imageUrl?: string | null;
    videoUrl?: string | null;
    thumbnailUrl?: string | null;
    ctwaClid?: string | null;
    ref?: string | null;
    welcomeMessageText?: string | null;
    adAccountId?: string | null;
    campaignLabels?: Array<{ id: string; name?: string | null }> | null;
    campaignLabelStatus?: "present" | "absent" | "unavailable" | null;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserDocument
  extends mongoose.Document<mongoose.Types.ObjectId | string | number> {
  isBot: boolean;
  firstName?: string;
  lastName?: string;
  username?: string;
  avatar_url?: string;
  email?: string; // For authenticated widget users
  whatsapp?: {
    waId?: string | null;
    userId?: string | null;
    parentUserId?: string | null;
    username?: string | null;
    profileName?: string | null;
    primaryIdType?:
      | "wa_id"
      | "user_id"
      | "parent_user_id"
      | "message_from"
      | null;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// TELEGRAM API TYPES
// ============================================================================

// ============================================================================
// WHATSAPP API TYPES
// ============================================================================

// ============================================================================
// EMAIL API TYPES
// ============================================================================

export interface EmailSendResponse {
  success: boolean;
  messageId?: string;
  error?: string;
}

// ============================================================================
// POPULATED TYPES
// ============================================================================

export interface PopulatedMessage {
  _id: mongoose.Schema.Types.ObjectId;
  messageId?: string | number;
  author: UserDocument | null;
  text: string;
  ragContext?: string;
  date: string | Date;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  direction: MessageDirection;
  rawSourcePayload?: RawSourcePayload | null;
  user?: {
    avatar_url?: string;
  };
  imageUrl?: string;
  imageAnalysis?: string;
  audioAnalysis?: string;
  videoAnalysis?: string;
  mediaAnalysis?: MessageMediaAnalysisState | null;
  attachments?: Array<{
    filename: string;
    url: string;
    contentType: string;
    sizeBytes: number;
  }>;
  // Media metadata (for all channels)
  mediaType?: StoredMessageMediaType;
  mimeType?: string;
  fileName?: string;
  fileSize?: number;
  whatsappMediaId?: string | null;
  reactions?: Array<{
    emoji: string;
    authorId: string | number;
    authorName?: string;
    reactionMessageId?: string;
    date?: string | Date;
  }>;
  editMeta?: StoredMessageEditMeta | null;
  whatsappFlow?: StoredWhatsAppFlowPreview | null;
  whatsappFlowReply?: StoredWhatsAppFlowReplyPreview | null;
  whatsappTemplate?: StoredWhatsAppTemplatePreview | null;
  whatsappServiceMessage?: StoredWhatsAppServiceMessagePreview | null;
  whatsappCtaLink?: StoredWhatsAppCtaLinkPreview | null;
  groundedReplyOptions?: StoredGroundedReplyOptionsPreview | null;
  telegramReplyMarkup?: StoredTelegramReplyMarkupPreview | null;
  telegramMeta?: TelegramStoredMessageMeta | null;
  whatsappMeta?: WhatsAppStoredMessageMeta | null;
  whatsappGroup?: {
    groupId?: string | null;
    phoneNumberId?: string | null;
    sourceId?: string | null;
    senderWaId?: string | null;
    senderUserId?: string | null;
    senderParentUserId?: string | null;
    senderUsername?: string | null;
  } | null;
  whatsappLocation?: {
    latitude?: number | null;
    longitude?: number | null;
    name?: string | null;
    address?: string | null;
    url?: string | null;
  } | null;
  whatsappContacts?: Array<Record<string, unknown>> | null;
  whatsappProductInquiry?: WhatsAppProductInquiryPayload;
  whatsappOrder?: WhatsAppOrderPayload;
  whatsappReferral?: {
    sourceType?: string | null;
    sourceId?: string | null;
    sourceUrl?: string | null;
    campaignId?: string | null;
    campaignName?: string | null;
    adSetId?: string | null;
    adSetName?: string | null;
    headline?: string | null;
    body?: string | null;
    mediaType?: string | null;
    imageUrl?: string | null;
    videoUrl?: string | null;
    thumbnailUrl?: string | null;
    ctwaClid?: string | null;
    ref?: string | null;
    welcomeMessageText?: string | null;
    adAccountId?: string | null;
    campaignLabels?: Array<{ id: string; name?: string | null }> | null;
    campaignLabelStatus?: "present" | "absent" | "unavailable" | null;
  } | null;
  delivery?: {
    status?: "sent" | "delivered" | "read" | "played" | "failed" | null;
    lastEventAt?: string | Date | null;
    sentAt?: string | Date | null;
    deliveredAt?: string | Date | null;
    readAt?: string | Date | null;
    playedAt?: string | Date | null;
    failedAt?: string | Date | null;
    recipientId?: string | null;
    recipientWaId?: string | null;
    recipientUserId?: string | null;
    recipientParentUserId?: string | null;
    recipientUsername?: string | null;
    recipientType?: "individual" | "group" | string | null;
    recipientParticipantId?: string | null;
    recipientIdentityKeyHash?: string | null;
    errorCode?: number | null;
    errorMessage?: string | null;
    pricingCategory?: string | null;
    pricingType?: string | null;
    pricingModel?: string | null;
    conversationCategory?: string | null;
  } | null;
  origin?: MessageDocument["origin"] | null;
}
