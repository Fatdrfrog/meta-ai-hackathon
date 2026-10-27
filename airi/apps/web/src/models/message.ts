import {
  WHATSAPP_DELIVERY_STATUSES,
  type WhatsAppDeliveryStatus,
} from "@icecore/shared/types/whatsapp-delivery";
import {
  CONVERSATION_CHANNELS,
  type ConversationChannel,
} from "@icecore/shared/types/sources";
import {
  buildWhatsAppInboundDedupeKey,
  extractWhatsAppWamidFingerprint,
} from "@icecore/shared/lib/whatsapp/message-id";
import {
  buildConversationFirstResponseUpdate,
  buildConversationMessageTimestampSet,
  type ConversationMessageDirection,
} from "@/lib/conversation-message-denorm";
import mongoose from "mongoose";
import { buildCustomerMessageWebhookIntent } from "@/lib/customer-webhook-intents";
import {
  markEngagementRefreshForQueryUpdate,
  stripPrivateEngagementState,
} from "@/lib/engagement/message-engagement-refresh";

const RawSourcePayloadSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    provider: {
      type: String,
      enum: CONVERSATION_CHANNELS,
      required: true,
    },
    eventType: { type: String, default: null },
    capturedAt: { type: Date, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const TemporalDispatchSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    version: { type: Number, enum: [1], required: true },
    state: {
      type: String,
      enum: [
        "reserved",
        "dispatching",
        "sent",
        "not_attempted",
        "outcome_unknown",
      ],
      required: true,
    },
    deliveryKey: { type: String, required: true },
    attemptToken: { type: String, required: true },
    claimedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    terminalCode: { type: String, maxlength: 64, default: null },
  },
  { _id: false }
);

// Stored message shape for the hooks below. Spelled out so TypeScript does not
// infer it from the schema literal; the default export stays Model<any>.
type IMessage = {
  messageId?: string | null;
  whatsappWamidFingerprint?: string | null;
  whatsappInboundDedupeKey?: string | null;
  /** Durable idempotency token for recovered inbound content or attribution. */
  whatsappRecoveryRevision?: string;
  chat?: unknown;
  author?: unknown;
  workspaceId?: string | null;
  conversation?: mongoose.Types.ObjectId | null;
  temporalDeliveryKey?: string | null;
  airiIngressIntent?: unknown;
  customerWebhookIntent?: unknown;
  widgetRequestHash?: string | null;
  engagementContribution?: unknown;
  engagementRefreshPending?: boolean | null;
  temporalDispatch?: {
    version: number;
    state:
      | "reserved"
      | "dispatching"
      | "sent"
      | "not_attempted"
      | "outcome_unknown";
    deliveryKey: string;
    attemptToken: string;
    claimedAt?: Date | null;
    finishedAt?: Date | null;
    terminalCode?: string | null;
  } | null;
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
    status?: WhatsAppDeliveryStatus | null;
    lastEventAt?: Date | null;
    sentAt?: Date | null;
    deliveredAt?: Date | null;
    readAt?: Date | null;
    playedAt?: Date | null;
    failedAt?: Date | null;
    recipientId?: string | null;
    recipientWaId?: string | null;
    recipientUserId?: string | null;
    recipientParentUserId?: string | null;
    recipientUsername?: string | null;
    recipientType?: string | null;
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
  direction?: "inbound" | "outbound" | null;
  rawSourcePayload?: {
    provider: ConversationChannel;
    eventType?: string | null;
    capturedAt: Date;
    payload?: unknown;
  } | null;
  text?: string | null;
  ragContext?: string | null;
  date?: Date | null;
  subject?: string | null;
  html?: string | null;
  headers?: unknown;
  external_ids?: { messageId?: string | null } | null;
  attachments: {
    filename?: string | null;
    url?: string | null;
    contentType?: string | null;
    sizeBytes?: number | null;
  }[];
  imageUrl?: string | null;
  imageAnalysis?: string | null;
  audioAnalysis?: string | null;
  videoAnalysis?: string | null;
  mediaAnalysis?: {
    status?:
      | "queued"
      | "processing"
      | "submitted"
      | "completed"
      | "failed"
      | "skipped"
      | null;
    kind?: "audio" | "voice" | "video" | null;
    workflowId?: string | null;
    sourceId?: string | null;
    requestedAt?: Date | null;
    startedAt?: Date | null;
    completedAt?: Date | null;
    lastError?: string | null;
    transcriptSource?: string | null;
    analysisSource?: string | null;
    provider?: string | null;
    providerRequestId?: string | null;
    submissionClaimedAt?: Date | null;
    credentialSource?: "workspace_source" | "platform" | null;
    credentialSourceId?: string | null;
    providerWebhookId?: string | null;
    contractVersion?: number | null;
  } | null;
  mediaType?:
    | "image"
    | "video"
    | "audio"
    | "document"
    | "sticker"
    | "voice"
    | "file"
    | null;
  mimeType?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  whatsappMediaId?: string | null;
  reactions: {
    emoji: string;
    authorId: unknown;
    authorName?: string | null;
    reactionMessageId?: string | null;
    date: Date;
  }[];
  editMeta?: {
    editedAt?: Date | null;
    previousText?: string | null;
    editCount: number;
    source?: "whatsapp_webhook" | "instagram_webhook" | "manager" | null;
    kind?: "edit" | "revoke" | null;
  } | null;
  whatsappFlow?: {
    flowId?: string | null;
    flowName?: string | null;
    flowToken?: string | null;
    flowCta?: string | null;
    headerText?: string | null;
    bodyText?: string | null;
    footerText?: string | null;
    responseFieldMetadata?: unknown;
    flowActionType?: "navigate" | "data_exchange" | null;
    flowActionPayload?: unknown;
    scenarioId?: string | null;
    scenarioName?: string | null;
    actionNodeId?: string | null;
    status?: "sent" | "read" | "submitted" | null;
    responseJson?: string | null;
  } | null;
  whatsappFlowReply?: {
    flowName?: string | null;
    flowToken?: string | null;
    body?: string | null;
    responseJson?: string | null;
  } | null;
  whatsappTemplate?: Record<string, unknown> | null;
  whatsappServiceMessage?: Record<string, unknown> | null;
  whatsappCtaLink?: unknown;
  groundedReplyOptions?: unknown;
  whatsappLocation?: {
    latitude?: number | null;
    longitude?: number | null;
    name?: string | null;
    address?: string | null;
    url?: string | null;
  } | null;
  whatsappContacts?: unknown[] | null;
  whatsappProductInquiry?: {
    catalogId?: string | null;
    productRetailerId?: string | null;
    contextMessageId?: string | null;
  } | null;
  whatsappOrder?: {
    catalogId?: string | null;
    text?: string | null;
    productItems?: unknown[] | null;
    totalQuantity?: number | null;
    totalAmount?: number | null;
    currency?: string | null;
  } | null;
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
    campaignLabels?: { id: string; name?: string | null }[] | null;
    campaignLabelStatus?: "present" | "absent" | "unavailable" | null;
  } | null;
  whatsappGroup?: {
    groupId?: string | null;
    phoneNumberId?: string | null;
    sourceId?: string | null;
    senderWaId?: string | null;
    senderUserId?: string | null;
    senderParentUserId?: string | null;
    senderUsername?: string | null;
  } | null;
  telegramReplyMarkup?: unknown;
  telegramMeta?: {
    businessConnectionId?: string | null;
    senderDisplayName?: string | null;
    senderChatId?: string | null;
    senderChatTitle?: string | null;
    senderChatType?: "private" | "group" | "supergroup" | "channel" | null;
    authorSignature?: string | null;
    senderTag?: string | null;
    messageThreadId?: number | null;
    isTopicMessage?: boolean | null;
    replyToTelegramMessageId?: string | null;
    replyToTextPreview?: string | null;
  } | null;
  whatsappMeta?: {
    replyToWhatsAppMessageId?: string | null;
    replyToTextPreview?: string | null;
    forwarded?: boolean | null;
    frequentlyForwarded?: boolean | null;
  } | null;
  actionType?: "csat_request" | null;
  createdAt: Date;
  updatedAt: Date;
};

const MessageSchema = new mongoose.Schema<IMessage>(
  {
    // Telegram legacy fields (optional)
    messageId: { type: String },
    /**
     * Decoded wamid fingerprint shared by phone-encoded and BSUID-encoded twins.
     * Used for O(1) parent lookup on inbound reply context — not exposed on chat API.
     */
    whatsappWamidFingerprint: { type: String, default: null },
    whatsappInboundDedupeKey: { type: String, select: false },
    whatsappRecoveryRevision: { type: String },
    chat: { type: mongoose.Schema.Types.Mixed, ref: "Chat" }, // Support Number (Telegram), String, or ObjectId for different channels
    author: { type: mongoose.Schema.Types.Mixed, ref: "User" }, // Support both Number (Telegram IDs) and String (Supabase UUIDs)

    workspaceId: { type: String },
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
    },
    temporalDeliveryKey: { type: String, default: null },
    // A temporary, sanitized copy of AiriTurnContext closes the message/queue
    // write boundary. Reconciliation removes it only after durable queue insertion.
    airiIngressIntent: { type: mongoose.Schema.Types.Mixed, select: false },
    customerWebhookIntent: { type: mongoose.Schema.Types.Mixed, select: false },
    widgetRequestHash: { type: String, select: false },
    // Internal engagement projection; committed with the conversation accumulator.
    engagementContribution: { type: mongoose.Schema.Types.Mixed, select: false },
    engagementRefreshPending: { type: Boolean, select: false },
    temporalDispatch: {
      type: TemporalDispatchSchema,
      default: undefined,
      select: false,
    },
    origin: {
      kind: {
        type: String,
        enum: [
          "manager",
          "airi",
          "scenario",
          "campaign",
          "bulk_analytics",
          "system",
        ],
        default: null,
      },
      campaignId: { type: String, default: null },
      scenarioId: { type: String, default: null },
      nodeId: { type: String, default: null },
      templateName: { type: String, default: null },
      templateCategory: { type: String, default: null },
      sourceId: { type: String, default: null },
      executionSource: { type: String, default: null },
      sentByUserId: { type: String, default: null },
    },
    delivery: {
      status: {
        type: String,
        enum: WHATSAPP_DELIVERY_STATUSES,
        default: null,
      },
      lastEventAt: { type: Date, default: null },
      sentAt: { type: Date, default: null },
      deliveredAt: { type: Date, default: null },
      readAt: { type: Date, default: null },
      playedAt: { type: Date, default: null },
      failedAt: { type: Date, default: null },
      recipientId: { type: String, default: null },
      recipientWaId: { type: String, default: null },
      recipientUserId: { type: String, default: null },
      recipientParentUserId: { type: String, default: null },
      recipientUsername: { type: String, default: null },
      recipientType: { type: String, default: null },
      recipientParticipantId: { type: String, default: null },
      recipientIdentityKeyHash: { type: String, default: null },
      errorCode: { type: Number, default: null },
      errorMessage: { type: String, default: null },
      // Denormalized from WhatsApp status payloads so the outbound bubble
      // can show a billing-category chip without joining MessageDeliveryEvent.
      pricingCategory: { type: String, default: null },
      pricingType: { type: String, default: null },
      pricingModel: { type: String, default: null },
      conversationCategory: { type: String, default: null },
    },
    channel: {
      type: String,
      enum: CONVERSATION_CHANNELS,
      default: function defaultMessageChannel(this: {
        temporalDispatch?: { state?: string | null } | null;
      }) {
        return hasUnsentTemporalDispatch(this) ? undefined : "telegram";
      },
    },
    direction: { type: String, enum: ["inbound", "outbound"] },
    rawSourcePayload: {
      type: RawSourcePayloadSchema,
      default: undefined,
    },
    text: { type: String },
    // Widget-only contextual page/tab data passed by the client for better grounding.
    ragContext: { type: String, default: null },
    date: {
      type: Date,
      required: function requiredMessageDate() {
        return !hasUnsentTemporalDispatch(this);
      },
    },

    // Email-specific fields
    subject: { type: String },
    html: { type: String },
    headers: { type: mongoose.Schema.Types.Mixed }, // EmailHeaders
    external_ids: {
      messageId: { type: String },
    },
    attachments: [
      {
        filename: String,
        url: String,
        contentType: String,
        sizeBytes: Number,
      },
    ],

    // Media fields
    imageUrl: { type: String, default: null },
    imageAnalysis: { type: String, default: null },
    audioAnalysis: { type: String, default: null },
    videoAnalysis: { type: String, default: null },
    mediaAnalysis: {
      status: {
        type: String,
        enum: [
          "queued",
          "processing",
          "submitted",
          "completed",
          "failed",
          "skipped",
        ],
        default: null,
      },
      kind: {
        type: String,
        enum: ["audio", "voice", "video"],
        default: null,
      },
      workflowId: { type: String, default: null },
      sourceId: { type: String, default: null },
      requestedAt: { type: Date, default: null },
      startedAt: { type: Date, default: null },
      completedAt: { type: Date, default: null },
      lastError: { type: String, default: null },
      transcriptSource: { type: String, default: null },
      analysisSource: { type: String, default: null },
      provider: { type: String, default: null },
      providerRequestId: { type: String, default: null },
      submissionClaimedAt: { type: Date, default: null },
      credentialSource: { type: String, enum: ["workspace_source", "platform"], default: null },
      credentialSourceId: { type: String, default: null },
      providerWebhookId: { type: String, default: null },
      contractVersion: { type: Number, default: null },
    },

    // Media metadata (for all channels)
    mediaType: {
      type: String,
      enum: ["image", "video", "audio", "document", "sticker", "voice", "file"],
      default: null,
    },
    mimeType: { type: String, default: null },
    fileName: { type: String, default: null },
    fileSize: { type: Number, default: null },
    whatsappMediaId: { type: String, default: null, index: true },
    reactions: [
      {
        _id: false,
        emoji: { type: String, required: true },
        authorId: { type: mongoose.Schema.Types.Mixed, required: true },
        authorName: { type: String, default: null },
        reactionMessageId: { type: String, default: null },
        date: { type: Date, default: Date.now },
      },
    ],
    editMeta: {
      editedAt: { type: Date, default: null },
      previousText: { type: String, default: null },
      editCount: { type: Number, default: 0 },
      source: {
        type: String,
        enum: ["whatsapp_webhook", "instagram_webhook", "manager"],
        default: null,
      },
      kind: {
        type: String,
        enum: ["edit", "revoke"],
        default: null,
      },
    },
    whatsappFlow: {
      flowId: { type: String, default: null },
      flowName: { type: String, default: null },
      flowToken: { type: String, default: null },
      flowCta: { type: String, default: null },
      headerText: { type: String, default: null },
      bodyText: { type: String, default: null },
      footerText: { type: String, default: null },
      responseFieldMetadata: {
        type: mongoose.Schema.Types.Mixed,
        default: null,
      },
      flowActionType: {
        type: String,
        enum: ["navigate", "data_exchange"],
        default: null,
      },
      flowActionPayload: { type: mongoose.Schema.Types.Mixed, default: null },
      scenarioId: { type: String, default: null },
      scenarioName: { type: String, default: null },
      actionNodeId: { type: String, default: null },
      status: {
        type: String,
        enum: ["sent", "read", "submitted"],
        default: null,
      },
      responseJson: { type: String, default: null },
    },
    whatsappFlowReply: {
      flowName: { type: String, default: null },
      flowToken: { type: String, default: null },
      body: { type: String, default: null },
      responseJson: { type: String, default: null },
    },
    whatsappTemplate: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    whatsappServiceMessage: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    whatsappCtaLink: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    groundedReplyOptions: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    whatsappLocation: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
      name: { type: String, default: null },
      address: { type: String, default: null },
      url: { type: String, default: null },
    },
    whatsappContacts: {
      type: [mongoose.Schema.Types.Mixed],
      default: undefined,
    },
    whatsappProductInquiry: {
      catalogId: { type: String, default: null },
      productRetailerId: { type: String, default: null },
      contextMessageId: { type: String, default: null },
    },
    whatsappOrder: {
      catalogId: { type: String, default: null },
      text: { type: String, default: null },
      productItems: {
        type: [mongoose.Schema.Types.Mixed],
        default: undefined,
      },
      totalQuantity: { type: Number, default: null },
      totalAmount: { type: Number, default: null },
      currency: { type: String, default: null },
    },
    whatsappReferral: {
      sourceType: { type: String, default: null },
      sourceId: { type: String, default: null },
      sourceUrl: { type: String, default: null },
      campaignId: { type: String, default: null },
      campaignName: { type: String, default: null },
      adSetId: { type: String, default: null },
      adSetName: { type: String, default: null },
      headline: { type: String, default: null },
      body: { type: String, default: null },
      mediaType: { type: String, default: null },
      imageUrl: { type: String, default: null },
      videoUrl: { type: String, default: null },
      thumbnailUrl: { type: String, default: null },
      ctwaClid: { type: String, default: null },
      ref: { type: String, default: null },
      welcomeMessageText: { type: String, default: null },
      adAccountId: { type: String, default: null },
      campaignLabels: {
        type: [
          new mongoose.Schema<Record<string, unknown>>(
            {
              id: { type: String, required: true },
              name: { type: String, default: null },
            },
            { _id: false }
          ),
        ],
        default: undefined,
      },
      campaignLabelStatus: {
        type: String,
        enum: ["present", "absent", "unavailable"],
        default: undefined,
      },
    },
    whatsappGroup: {
      groupId: { type: String, default: null },
      phoneNumberId: { type: String, default: null },
      sourceId: { type: String, default: null },
      senderWaId: { type: String, default: null },
      senderUserId: { type: String, default: null },
      senderParentUserId: { type: String, default: null },
      senderUsername: { type: String, default: null },
    },
    telegramReplyMarkup: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    telegramMeta: {
      businessConnectionId: { type: String, default: null },
      senderDisplayName: { type: String, default: null },
      senderChatId: { type: String, default: null },
      senderChatTitle: { type: String, default: null },
      senderChatType: {
        type: String,
        enum: ["private", "group", "supergroup", "channel"],
        default: null,
      },
      authorSignature: { type: String, default: null },
      senderTag: { type: String, default: null },
      messageThreadId: { type: Number, default: null },
      isTopicMessage: { type: Boolean, default: null },
      replyToTelegramMessageId: { type: String, default: null },
      replyToTextPreview: { type: String, default: null },
    },
    whatsappMeta: {
      replyToWhatsAppMessageId: { type: String, default: null },
      replyToTextPreview: { type: String, default: null },
      forwarded: { type: Boolean, default: null },
      frequentlyForwarded: { type: Boolean, default: null },
    },

    // Widget system message type (e.g. CSAT request)
    actionType: {
      type: String,
      enum: ["csat_request"],
      default: null,
    },
  },
  { timestamps: true }
);

// Legacy compound index remains for Telegram chats if present (fix field name to 'chat')
MessageSchema.index({ chat: 1, messageId: 1 }, { unique: true, sparse: true });
export const MESSAGE_AIRI_INGRESS_PENDING_INDEX = {
  keys: { "airiIngressIntent.ingressNextRetryAt": 1, _id: 1 },
  options: {
    name: "message_airi_ingress_pending",
    partialFilterExpression: {
      "airiIngressIntent.ingressKey": { $type: "string" },
    },
  },
} as const;
MessageSchema.index(
  MESSAGE_AIRI_INGRESS_PENDING_INDEX.keys,
  MESSAGE_AIRI_INGRESS_PENDING_INDEX.options
);

// Index for WhatsApp messages (channel + messageId for singleton pattern)
// Should NOT be unique because Telegram messageIds are only unique within a chat
MessageSchema.index({ channel: 1, messageId: 1 }, { sparse: true });

// Historical replays contain duplicate message IDs, so the legacy collection
// cannot accept a global unique index yet. Enroll new inbound writes only and
// keep existing rows available to the processor's early replay lookup.
export const MESSAGE_WHATSAPP_INBOUND_DEDUPE_INDEX = {
  keys: { workspaceId: 1, whatsappInboundDedupeKey: 1 },
  options: {
    name: "messages_whatsapp_inbound_dedupe_v1",
    unique: true,
    partialFilterExpression: {
      channel: "whatsapp",
      direction: "inbound",
      workspaceId: { $type: "string" },
      whatsappInboundDedupeKey: { $type: "string" },
    },
  },
} as const;
MessageSchema.index(
  MESSAGE_WHATSAPP_INBOUND_DEDUPE_INDEX.keys,
  MESSAGE_WHATSAPP_INBOUND_DEDUPE_INDEX.options
);

// Workspace-scoped external id for emails
MessageSchema.index({ workspaceId: 1, "external_ids.messageId": 1 });

MessageSchema.index({ workspaceId: 1, conversation: 1, createdAt: -1 });
MessageSchema.index({ workspaceId: 1, updatedAt: 1, _id: 1 });
MessageSchema.index({ workspaceId: 1, conversation: 1, date: 1 });
MessageSchema.index({ workspaceId: 1, channel: 1, date: -1 });
// The daily AIRI gap backfill reads inbound messages across workspaces by date.
MessageSchema.index({ direction: 1, date: -1 });
MessageSchema.index({ workspaceId: 1, channel: 1, direction: 1, date: -1 });
export const MESSAGE_WORKSPACE_DIRECTION_DATE_INDEX_KEYS = {
  workspaceId: 1,
  direction: 1,
  date: -1,
} as const;

MessageSchema.index(MESSAGE_WORKSPACE_DIRECTION_DATE_INDEX_KEYS);
MessageSchema.index(
  { workspaceId: 1, "mediaAnalysis.providerRequestId": 1 },
  {
    name: "messages_workspace_media_provider_request",
    unique: true,
    partialFilterExpression: {
      "mediaAnalysis.providerRequestId": { $type: "string" },
    },
  }
);
MessageSchema.index({
  workspaceId: 1,
  "mediaAnalysis.status": 1,
  mediaType: 1,
  date: -1,
});
MessageSchema.index({
  workspaceId: 1,
  channel: 1,
  direction: 1,
  messageId: 1,
  date: -1,
});
MessageSchema.index({
  workspaceId: 1,
  channel: 1,
  direction: 1,
  "origin.templateName": 1,
  date: -1,
});
MessageSchema.index({
  workspaceId: 1,
  channel: 1,
  direction: 1,
  "whatsappTemplate.name": 1,
  date: -1,
});
MessageSchema.index({
  workspaceId: 1,
  conversation: 1,
  channel: 1,
  direction: 1,
  date: -1,
});
MessageSchema.index({
  workspaceId: 1,
  conversation: 1,
  channel: 1,
  date: -1,
});
export const MESSAGE_TEMPORAL_DELIVERY_KEY_INDEX = {
  keys: { temporalDeliveryKey: 1 },
  options: {
    name: "messages_temporal_delivery_key_unique_v1",
    unique: true,
    partialFilterExpression: { temporalDeliveryKey: { $type: "string" } },
  },
} as const;

export function buildTemporalDeliveryKeyFilter(deliveryKey: string) {
  // MongoDB needs the partial index predicate explicitly in the query to use it.
  return { temporalDeliveryKey: { $eq: deliveryKey, $type: "string" as const } };
}

MessageSchema.index(
  MESSAGE_TEMPORAL_DELIVERY_KEY_INDEX.keys,
  MESSAGE_TEMPORAL_DELIVERY_KEY_INDEX.options
);
MessageSchema.index({ workspaceId: 1, "origin.kind": 1, date: -1 });
MessageSchema.index({ workspaceId: 1, "origin.campaignId": 1, date: -1 });
MessageSchema.index({ workspaceId: 1, "delivery.status": 1, date: -1 });
MessageSchema.index({
  workspaceId: 1,
  conversation: 1,
  direction: 1,
  "origin.kind": 1,
  "origin.sentByUserId": 1,
  date: 1,
});
MessageSchema.index(
  {
    "rawSourcePayload.provider": 1,
    "rawSourcePayload.eventType": 1,
    createdAt: -1,
  },
  { name: "messages_raw_provider_event_type_created_at_desc" }
);
// Optimize conversation view pagination by sorting on message date
MessageSchema.index({ conversation: 1, date: -1 });
// Optimize chronological thread reads with a deterministic tie-breaker.
MessageSchema.index({ conversation: 1, date: 1, _id: 1 });
// Optimize last inbound message lookup for requests page (WhatsApp/Instagram)
MessageSchema.index({ conversation: 1, direction: 1, date: -1 });
export const MESSAGE_REQUEST_AIRI_WITNESS_INDEX_NAME =
  "messages_conversation_direction_origin_id_desc_v1";
export const MESSAGE_REQUEST_AIRI_WITNESS_INDEX_KEYS = {
  conversation: 1,
  direction: 1,
  "origin.kind": 1,
  _id: -1,
} as const;
MessageSchema.index(MESSAGE_REQUEST_AIRI_WITNESS_INDEX_KEYS, {
  name: MESSAGE_REQUEST_AIRI_WITNESS_INDEX_NAME,
});
// WhatsApp reply-parent twin lookup (phone vs BSUID wamid encodings)
MessageSchema.index(
  { conversation: 1, whatsappWamidFingerprint: 1 },
  {
    name: "messages_conversation_whatsapp_wamid_fingerprint",
    sparse: true,
  }
);

MessageSchema.pre("validate", function ensureWhatsAppWamidFingerprint() {
  if (this.channel !== "whatsapp") {
    return;
  }

  const messageId =
    typeof this.messageId === "string" ? this.messageId.trim() : "";
  if (!messageId) {
    return;
  }

  if (this.isNew) {
    this.whatsappInboundDedupeKey = buildWhatsAppInboundDedupeKey(this);
  }

  const fingerprint = extractWhatsAppWamidFingerprint(messageId);
  if (fingerprint) {
    this.whatsappWamidFingerprint = fingerprint;
  }
});

MessageSchema.pre("save", function captureUsageCounterState() {
  this.$locals.wasNewForUsageCounter = this.isNew;
});

MessageSchema.pre("save", function captureCustomerWebhookFact() {
  // create/save owns live messages and accepted send finalization. Projection
  // edits and imported history must not create a second message event.
  if (!this.isNew && !this.isModified("messageId")) return;
  const localSource = this.$locals.customerWebhookSourceId;
  const intent = buildCustomerMessageWebhookIntent(
    this,
    typeof localSource === "string" ? localSource : undefined
  );
  if (intent) this.customerWebhookIntent = intent;
});

MessageSchema.index(
  { "customerWebhookIntent.timestamp": 1, _id: 1 },
  {
    name: "messages_customer_webhook_pending_v1",
    partialFilterExpression: { customerWebhookIntent: { $exists: true } },
  }
);

MessageSchema.pre("save", function markEngagementRefreshPending() {
  if (this.conversation && !hasUnsentTemporalDispatch(this))
    this.engagementRefreshPending = true;
});
MessageSchema.pre(
  ["updateOne", "updateMany", "findOneAndUpdate"],
  function markQueryEngagementRefreshPending() {
    const update = this.getUpdate();
    if (update) this.setUpdate(markEngagementRefreshForQueryUpdate(update));
  }
);

function hasUnsentTemporalDispatch(doc: {
  temporalDispatch?: { state?: string | null } | null;
}): boolean {
  const state = doc?.temporalDispatch?.state;
  return Boolean(state && state !== "sent");
}

// Real manager outbounds trigger sticky manual handoff so Airi stays silent
// until a manager resumes the bot. Campaign/scenario/Airi/system messages must
// not — they often reuse non-bot author records (business account / sender).
MessageSchema.post("save", function postSaveActivateManualHandoff(doc) {
  if (
    !doc?.conversation ||
    doc.direction !== "outbound" ||
    hasUnsentTemporalDispatch(doc)
  ) {
    return;
  }

  setImmediate(async () => {
    try {
      const { isAutomatedOutboundOriginKind } = await import(
        "@/lib/conversation-message-denorm"
      );
      const originKind =
        doc.origin && typeof doc.origin.kind === "string"
          ? doc.origin.kind
          : null;
      if (isAutomatedOutboundOriginKind(originKind)) {
        return;
      }

      const authorId =
        doc.author !== null && doc.author !== undefined
          ? String(doc.author)
          : "";

      if (!authorId || authorId === "0") {
        return;
      }

      const User = (await import("./user")).default;
      const author = await User.findById(authorId)
        .select("isBot")
        .lean<{ isBot?: boolean } | null>();

      if (author?.isBot !== false) {
        return;
      }

      const { activateManualHandoff } = await import(
        "@/lib/airi/reply/runtime/handoff-state"
      );

      await activateManualHandoff({
        conversationId: String(doc.conversation),
        handoffAt: doc.date,
        handoffReason: "manager_reply",
      });
    } catch (error) {
      // Non-blocking, but a lost handoff lets Airi keep replying: make it visible.
      console.warn("[Message] Manual handoff activation failed", {
        conversationId: String(doc.conversation),
        messageId: String(doc._id),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
});

// Keep the Temporal conversation workflow informed about human outbound
// messages so it can clear active scenario timers and mirrored state.
MessageSchema.post("save", function postSaveHandleScenarioTimeouts(doc) {
  if (!doc?.conversation || hasUnsentTemporalDispatch(doc)) {
    return;
  }

  setImmediate(async () => {
    try {
      const {
        handleScenarioTimeoutMessageSaved,
        toScenarioTimeoutMessageEvent,
      } = await import("@/lib/airi/scenario/scenario-timeout-events");
      const event = toScenarioTimeoutMessageEvent({
        _id: doc._id,
        conversation: doc.conversation,
        workspaceId: doc.workspaceId,
        channel: doc.channel,
        direction: doc.direction,
        author: doc.author,
        origin: doc.origin,
        text: doc.text,
        date: doc.date,
      });
      if (!event) return;

      await handleScenarioTimeoutMessageSaved(event);
    } catch {
      // Non-blocking best effort.
    }
  });
});

MessageSchema.post("save", function postSaveSyncCustomer(doc) {
  if (!doc?.conversation || hasUnsentTemporalDispatch(doc)) {
    return;
  }

  setImmediate(async () => {
    try {
      const { syncCustomerForConversation } = await import(
        "@/lib/customers/service"
      );
      await syncCustomerForConversation({
        conversationId: String(doc.conversation),
      });
    } catch {
      // Non-blocking best effort.
    }
  });
});

MessageSchema.post("save", function postSaveRefreshEngagement(doc) {
  if (!doc?.conversation || hasUnsentTemporalDispatch(doc)) {
    return;
  }

  setImmediate(async () => {
    try {
      const { refreshConversationEngagement } = await import(
        "@/lib/engagement/conversation-engagement"
      );
      await refreshConversationEngagement(String(doc.conversation), {
        messageId: doc._id,
        workspaceId:
          typeof doc.workspaceId === "string" ? doc.workspaceId : undefined,
      });
    } catch {
      // Non-blocking best effort.
    }
  });
});

MessageSchema.post("save", function postSaveEmitUsageCounter(doc) {
  if (
    !doc?._id ||
    (!doc.$locals?.wasNewForUsageCounter &&
      !doc.$locals?.wasTemporalDispatchFinalized) ||
    !doc.workspaceId ||
    doc.direction !== "outbound" ||
    hasUnsentTemporalDispatch(doc)
  ) {
    return;
  }

  const originKind =
    doc.origin && typeof doc.origin.kind === "string" ? doc.origin.kind : null;
  const isAiriMessage =
    originKind === "airi" ||
    (!originKind && (doc.author === 0 || String(doc.author) === "0"));
  if (!isAiriMessage) {
    return;
  }

  setImmediate(async () => {
    try {
      const { emitWorkspaceUsageDeltaBestEffort } = await import(
        "@/lib/limits/company-usage-events"
      );
      emitWorkspaceUsageDeltaBestEffort(
        {
          workspaceId: String(doc.workspaceId),
          metric: "airi_auto_reply_count",
          delta: 1,
          objectId: String(doc._id),
          source: "message_model",
          metadata: {
            sourceType: typeof doc.channel === "string" ? doc.channel : null,
            originKind,
          },
        },
        { logContext: "Message.postSave" }
      );
    } catch {
      // Non-blocking best effort.
    }
  });
});

function toConversationDirection(
  value: unknown
): ConversationMessageDirection | null {
  return value === "inbound" || value === "outbound" ? value : null;
}

type FirstResponseAuthorMeta = {
  isBot?: boolean | null;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
};

function formatFirstResponseAuthorName(
  author: FirstResponseAuthorMeta | null
): string | null {
  if (!author) return null;
  const fullName = [author.firstName, author.lastName]
    .map(value => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join(" ");
  return fullName || author.username?.trim() || null;
}

// Maintain denormalized message timestamps on the conversation so analytics
// filters can skip per-message $lookup stages.
MessageSchema.post(
  "save",
  function postSaveMaintainConversationMessageTimestamps(doc) {
    if (!doc?.conversation || !doc?.date || hasUnsentTemporalDispatch(doc)) {
      return;
    }

    const timestampSet = buildConversationMessageTimestampSet(
      doc.date,
      toConversationDirection(doc.direction)
    );

    void import("./conversation")
      .then(({ Conversation }) =>
        Conversation.updateOne({ _id: doc.conversation }, [
          { $set: timestampSet },
        ])
      )
      .catch(() => {
        // Non-blocking best effort.
      });
  }
);

// Maintain first human response fields on the conversation read model. This
// keeps dashboard metrics off the high-volume messages collection.
MessageSchema.post(
  "save",
  function postSaveMaintainConversationFirstResponse(doc) {
    if (
      !doc?.conversation ||
      !doc?.workspaceId ||
      !doc?.date ||
      hasUnsentTemporalDispatch(doc)
    ) {
      return;
    }

    const immediateUpdate = buildConversationFirstResponseUpdate(doc);
    const needsAuthorVerification =
      !immediateUpdate &&
      doc.direction === "outbound" &&
      doc.author !== null &&
      doc.author !== undefined &&
      String(doc.author).trim() !== "" &&
      String(doc.author).trim() !== "0";

    if (!immediateUpdate && !needsAuthorVerification) {
      return;
    }

    setImmediate(async () => {
      try {
        let authorMeta: FirstResponseAuthorMeta | null = null;
        if (doc.author !== null && doc.author !== undefined) {
          try {
            const User = (await import("./user")).default;
            authorMeta = await User.findById(doc.author)
              .select("isBot firstName lastName username")
              .lean<FirstResponseAuthorMeta | null>();
          } catch {
            authorMeta = null;
          }
        }

        const update =
          buildConversationFirstResponseUpdate(doc, {
            authorIsHuman: authorMeta?.isBot === false,
            managerName: formatFirstResponseAuthorName(authorMeta),
          }) || immediateUpdate;

        if (!update) return;

        const { Conversation } = await import("./conversation");
        await Conversation.updateOne(update.filter, update.update).exec();
      } catch {
        // Non-blocking best effort.
      }
    });
  }
);

export const MESSAGE_ENGAGEMENT_INDEX_SPECS = [
  {
    keys: {
      conversation: 1,
      "engagementContribution.generation": 1,
      "engagementContribution.date": 1,
      _id: 1,
    },
    options: {
      name: "engagement_contribution_order_v1",
      partialFilterExpression: {
        "engagementContribution.date": { $type: "date" },
      },
    },
  },
  {
    keys: {
      conversation: 1,
      "engagementContribution.generation": 1,
      "engagementContribution.edge.customerRepliesAfterOutbound": 1,
      "engagementContribution.date": 1,
      _id: 1,
    },
    options: {
      name: "engagement_contribution_reply_v1",
      partialFilterExpression: {
        "engagementContribution.date": { $type: "date" },
      },
    },
  },
  {
    keys: { engagementRefreshPending: 1, conversation: 1, _id: 1 },
    options: {
      name: "engagement_pending_v1",
      partialFilterExpression: { engagementRefreshPending: true },
    },
  },
  {
    keys: { conversation: 1, _id: 1 },
    options: { name: "engagement_bootstrap_scan_v1" },
  },
] as const;
for (const spec of MESSAGE_ENGAGEMENT_INDEX_SPECS)
  MessageSchema.index(spec.keys, spec.options);

function stripPrivateMessageState(
  document: unknown,
  result: Record<string, unknown>
) {
  delete result.customerWebhookIntent;
  return stripPrivateEngagementState(document, result);
}
MessageSchema.set("toJSON", { transform: stripPrivateMessageState });
MessageSchema.set("toObject", { transform: stripPrivateMessageState });

export default mongoose.models.Message ||
  mongoose.model("Message", MessageSchema);
