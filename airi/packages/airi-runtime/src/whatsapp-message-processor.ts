import * as WorkspaceBotDefaultModule from "@/lib/airi/workspace-bot-default";
import * as ConversationMessagesModule from "@/lib/conversation-messages";
import * as WhatsAppMediaUrlModule from "@/lib/media/whatsapp-media-url";
import * as MongoErrorsModule from "@/lib/mongo-errors";
import * as PostHogServerModule from "@/lib/posthog/server";
import * as ProviderMessageDisplayModule from "@/lib/provider-message-display";
import * as WhatsAppContactUtilsModule from "@/lib/whatsapp/contact/utils";
import * as WhatsAppConversationLookupModule from "@/lib/whatsapp/conversation-lookup";
import * as WhatsAppIdentityIndexesModule from "@/lib/whatsapp/identity/indexes";
import * as WhatsAppMediaTypesModule from "@/lib/whatsapp/media-types";
import type { WhatsAppWebhookMediaMessageType } from "@/lib/whatsapp/media-types";
import { buildWhatsAppIdentitySnapshotUpdate } from "@icecore/shared/lib/whatsapp/identity-snapshot";
import { customerCsatResolutionFields } from "@icecore/shared/lib/conversation-service-resolution";
import * as WhatsAppReferralEnrichmentModule from "@/lib/whatsapp/referral-enrichment";
import * as ChatModule from "@/models/chat";
import * as ConversationModule from "@/models/conversation";
import * as MessageModule from "@/models/message";
import * as UserModule from "@/models/user";
import * as WhatsAppPendingMessageMutationModule from "@/models/whatsapp-pending-message-mutation";
import type {
  ChatDocument,
  ConversationDocument,
  MessageDocument,
} from "@/types/models";
import {
  buildRawSourcePayload,
  type RawSourcePayload,
} from "@icecore/shared/lib/raw-source-payload";
import {
  buildWhatsAppCanonicalId,
  buildWhatsAppCanonicalIdFromPhone,
  listWhatsAppPhoneIdentityVariants,
  normalizeWhatsAppPhone,
  type WhatsAppNormalizedContact,
} from "@icecore/shared/lib/whatsapp/contact-identities";
import {
  buildWhatsAppStoredReplyMeta,
  extractWhatsAppWamidFingerprint,
  findWhatsAppContextMessage,
  listWhatsAppMessageIdLookupKeys,
  normalizeWhatsAppMessageId,
} from "@icecore/shared/lib/whatsapp/message-id";
import {
  WHATSAPP_DELETED_MESSAGE_TEXT,
  WHATSAPP_REVOKED_MEDIA_UNSET,
} from "@icecore/shared/lib/whatsapp/revoked-message";
import {
  normalizeWhatsAppFlowReply,
  type NormalizedWhatsAppFlowReply,
} from "@icecore/shared/lib/whatsapp/flow-reply";
import { getWhatsAppMessageMutationKind } from "@icecore/shared/lib/whatsapp/message-mutations";
import type { WhatsAppMessage } from "@icecore/shared/lib/whatsapp/webhook-payload";
import type { WhatsAppStoredMessageMeta } from "@icecore/shared/types/whatsapp-message-meta";
import { buildWhatsAppGroupChatId } from "@icecore/whatsapp/groupWebhooks";
import type { ConversationMediaAnalysisType } from "@icecore/temporal";
import { readRuntimeExport } from "./internal/module-interop";
import connectDB from "./mongoose";
import { persistWhatsAppMessageConversationLink } from "./whatsapp-message-conversation-link";
import {
  buildWhatsAppPlanSkippedProcessResult,
  getOrCreateWhatsAppConversationWithPlanGate,
  type WHATSAPP_PLAN_SKIPPED_PROCESSED_AS,
  type WhatsAppIntakePlanCheck,
  type WhatsAppIntakePlanSkip,
} from "./whatsapp-intake-plan-gate";
import {
  buildWhatsAppMessageRecovery,
  mergeWhatsAppReferral,
  recoverWhatsAppMessage,
} from "./whatsapp-message-recovery";

const persistWhatsAppConversationReferral = readRuntimeExport<
  typeof WhatsAppReferralEnrichmentModule.persistWhatsAppConversationReferral
>(WhatsAppReferralEnrichmentModule, "persistWhatsAppConversationReferral");

const WHATSAPP_UNSUPPORTED_MESSAGE_TYPE_ERROR_CODE = 131051;
const WHATSAPP_OVERSIZED_MEDIA_ERROR_CODE = 131052;
const WHATSAPP_UNAVAILABLE_MESSAGE_ERROR_CODE = 131060;

const WHATSAPP_UNAVAILABLE_MESSAGE_TEXT =
  "[WhatsApp message unavailable: open WhatsApp Business app to view]";

// Inbound media downloads used to fail into a bare catch: the placeholder was
// stored with no log and no event, so the loss was invisible and the expiring
// media id was never diagnosed. Log it and capture a failure event so the
// inbound path stops being a blind spot.
function reportWhatsAppInboundMediaFailure(params: {
  error: unknown;
  workspaceId: string;
  conversationId: string;
  whatsappMessageId: string;
  whatsappMediaId?: string;
  mediaType: string;
}): void {
  const errorMessage =
    params.error instanceof Error ? params.error.message : String(params.error);

  console.error("[WhatsApp Message Processor] inbound_media_upload_failed", {
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    whatsappMessageId: params.whatsappMessageId,
    mediaType: params.mediaType,
    error: errorMessage,
  });

  try {
    const posthog = getPostHogClient();
    posthog?.capture({
      distinctId: `airi:workspace:${params.workspaceId}`,
      event: "conversation_attachment_upload_failed",
      properties: {
        // A workspace is not a person; keep it out of person profiles.
        $process_person_profile: false,
        workspace_id: params.workspaceId,
        conversation_id: params.conversationId,
        channel: "whatsapp",
        direction: "inbound",
        media_type: params.mediaType,
        whatsapp_media_id: params.whatsappMediaId,
        reason: errorMessage,
      },
    });
  } catch {
    // A capture failure must never mask the original media failure.
  }
}

const getWorkspaceBotRuntimeSettings = readRuntimeExport<
  typeof WorkspaceBotDefaultModule.getWorkspaceBotRuntimeSettings
>(WorkspaceBotDefaultModule, "getWorkspaceBotRuntimeSettings");
const appendMessageToConversationById = readRuntimeExport<
  typeof ConversationMessagesModule.appendMessageToConversationById
>(ConversationMessagesModule, "appendMessageToConversationById");
const buildWhatsAppMediaProxyUrl = readRuntimeExport<
  typeof WhatsAppMediaUrlModule.buildWhatsAppMediaProxyUrl
>(WhatsAppMediaUrlModule, "buildWhatsAppMediaProxyUrl");
const isMongoDuplicateKeyError = readRuntimeExport<
  typeof MongoErrorsModule.isMongoDuplicateKeyError
>(MongoErrorsModule, "isMongoDuplicateKeyError");
const getPostHogClient = readRuntimeExport<
  typeof PostHogServerModule.getPostHogClient
>(PostHogServerModule, "getPostHogClient");
const isWhatsAppApiUnavailableUnsupportedMessage = readRuntimeExport<
  typeof ProviderMessageDisplayModule.isWhatsAppApiUnavailableUnsupportedMessage
>(ProviderMessageDisplayModule, "isWhatsAppApiUnavailableUnsupportedMessage");
const WHATSAPP_API_UNAVAILABLE_MESSAGE_TEXT = readRuntimeExport<
  typeof ProviderMessageDisplayModule.WHATSAPP_API_UNAVAILABLE_MESSAGE_TEXT
>(ProviderMessageDisplayModule, "WHATSAPP_API_UNAVAILABLE_MESSAGE_TEXT");
const parseWhatsAppName = readRuntimeExport<
  typeof WhatsAppContactUtilsModule.parseWhatsAppName
>(WhatsAppContactUtilsModule, "parseWhatsAppName");
const getOrCreateWhatsAppConversation = readRuntimeExport<
  typeof WhatsAppConversationLookupModule.getOrCreateWhatsAppConversation
>(WhatsAppConversationLookupModule, "getOrCreateWhatsAppConversation");
const ensureWhatsAppIdentityIndexes = readRuntimeExport<
  typeof WhatsAppIdentityIndexesModule.ensureWhatsAppIdentityIndexes
>(WhatsAppIdentityIndexesModule, "ensureWhatsAppIdentityIndexes");
const WHATSAPP_WEBHOOK_MEDIA_MESSAGE_TYPES = readRuntimeExport<
  typeof WhatsAppMediaTypesModule.WHATSAPP_WEBHOOK_MEDIA_MESSAGE_TYPES
>(WhatsAppMediaTypesModule, "WHATSAPP_WEBHOOK_MEDIA_MESSAGE_TYPES");
const isWhatsAppWebhookMediaMessageType = readRuntimeExport<
  typeof WhatsAppMediaTypesModule.isWhatsAppWebhookMediaMessageType
>(WhatsAppMediaTypesModule, "isWhatsAppWebhookMediaMessageType");
const buildWhatsAppReferralRagContext = readRuntimeExport<
  typeof WhatsAppReferralEnrichmentModule.buildWhatsAppReferralRagContext
>(WhatsAppReferralEnrichmentModule, "buildWhatsAppReferralRagContext");
const enrichWhatsAppReferralWithMetaAdMetadata = readRuntimeExport<
  typeof WhatsAppReferralEnrichmentModule.enrichWhatsAppReferralWithMetaAdMetadata
>(WhatsAppReferralEnrichmentModule, "enrichWhatsAppReferralWithMetaAdMetadata");
const normalizeWhatsAppWebhookReferral = readRuntimeExport<
  typeof WhatsAppReferralEnrichmentModule.normalizeWhatsAppWebhookReferral
>(WhatsAppReferralEnrichmentModule, "normalizeWhatsAppWebhookReferral");

const Chat = readRuntimeExport<typeof ChatModule.default>(
  ChatModule,
  "default",
);
const Conversation = readRuntimeExport<typeof ConversationModule.Conversation>(
  ConversationModule,
  "Conversation",
);
const Message = readRuntimeExport<typeof MessageModule.default>(
  MessageModule,
  "default",
);
const User = readRuntimeExport<typeof UserModule.default>(
  UserModule,
  "default",
);
const WhatsAppPendingMessageMutation = readRuntimeExport<
  typeof WhatsAppPendingMessageMutationModule.default
>(WhatsAppPendingMessageMutationModule, "default");

function isWhatsAppMediaType(
  value: WhatsAppMessage["type"],
): value is WhatsAppWebhookMediaMessageType {
  return isWhatsAppWebhookMediaMessageType(value);
}

function getWhatsAppMessageMediaId(
  messageData: WhatsAppMessage,
): string | undefined {
  if (messageData.type === "unsupported" && messageData.video?.id) {
    return messageData.video.id;
  }

  if (!isWhatsAppMediaType(messageData.type)) {
    return undefined;
  }

  const mediaData = messageData[messageData.type];
  return mediaData && "id" in mediaData ? mediaData.id : undefined;
}

async function storePendingWhatsAppMessageMutation(params: {
  workspaceId: string;
  sourceId?: string | null;
  phoneNumberId: string;
  mutationMessageId: string;
  targetMessageId: string;
  kind: "edit" | "revoke";
  text?: string | null;
  eventAt: Date;
  payload: unknown;
}) {
  const normalizedTargetMessageId = normalizeWhatsAppMessageId(
    params.targetMessageId,
  );
  await WhatsAppPendingMessageMutation.findOneAndUpdate(
    {
      normalizedTargetMessageId,
      kind: params.kind,
      mutationMessageId: params.mutationMessageId,
    },
    {
      $setOnInsert: {
        workspaceId: params.workspaceId,
        sourceId: params.sourceId || null,
        phoneNumberId: params.phoneNumberId,
        mutationMessageId: params.mutationMessageId,
        targetMessageId: params.targetMessageId,
        normalizedTargetMessageId,
        kind: params.kind,
        text: params.text || null,
        eventAt: params.eventAt,
        payload: params.payload,
        status: "pending",
      },
      $set: {
        lastError: null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function applyPendingWhatsAppMessageMutations(params: {
  workspaceId: string;
  messageId: string;
  messageObjectId: unknown;
  eventAt: Date;
}) {
  const pending = await WhatsAppPendingMessageMutation.find({
    workspaceId: params.workspaceId,
    status: "pending" as const,
    normalizedTargetMessageId: normalizeWhatsAppMessageId(params.messageId),
  })
    .sort({
      eventAt: 1,
      createdAt: 1,
    })
    .lean<
      Array<{
        _id: unknown;
        kind: "edit" | "revoke";
        text?: string | null;
        eventAt?: Date | null;
      }>
    >();

  for (const mutation of pending) {
    const nextText =
      mutation.kind === "revoke"
        ? WHATSAPP_DELETED_MESSAGE_TEXT
        : mutation.text || null;
    if (!nextText) {
      await WhatsAppPendingMessageMutation.updateOne(
        { _id: mutation._id },
        {
          $set: {
            status: "failed",
            lastError: "Pending edit mutation had no text",
          },
          $inc: { attempts: 1 },
        },
      );
      continue;
    }

    const current = await Message.findById(params.messageObjectId)
      .select("text")
      .lean<{ text?: string | null } | null>();
    const previousText = current?.text || null;
    const hasTextChange = (previousText || "") !== nextText;

    await Message.updateOne(
      { _id: params.messageObjectId },
      {
        $set: {
          text: nextText,
          updatedAt: mutation.eventAt || params.eventAt,
          "editMeta.editedAt": mutation.eventAt || params.eventAt,
          "editMeta.kind": mutation.kind,
          "editMeta.source": "whatsapp_webhook_pending",
          ...(hasTextChange ? { "editMeta.previousText": previousText } : {}),
        },
        ...(hasTextChange ? { $inc: { "editMeta.editCount": 1 } } : {}),
        ...(mutation.kind === "revoke"
          ? { $unset: WHATSAPP_REVOKED_MEDIA_UNSET }
          : {}),
      },
    );

    await WhatsAppPendingMessageMutation.updateOne(
      { _id: mutation._id },
      {
        $set: {
          status: "applied",
          appliedAt: new Date(),
          lastError: null,
        },
        $inc: { attempts: 1 },
      },
    );
  }
}

const whatsAppMessageConversationLinkDependencies = {
  applyPendingMutations: applyPendingWhatsAppMessageMutations,
  appendMessage: appendMessageToConversationById,
};

export function getWhatsAppProviderMediaErrorText(
  errors: WhatsAppMessage["errors"] | undefined,
): string | null {
  const oversizedMediaError = errors?.find(
    (error) => error.code === WHATSAPP_OVERSIZED_MEDIA_ERROR_CODE,
  );

  if (!oversizedMediaError) return null;

  const details =
    oversizedMediaError.error_data?.details ||
    oversizedMediaError.message ||
    oversizedMediaError.title ||
    "WhatsApp reported this media is too large to download.";

  return `[Media unavailable: ${details}]`;
}

function hasRenderableUnsupportedPayload(
  messageData: WhatsAppMessage,
): boolean {
  return Boolean(
    messageData.text?.body ||
      messageData.button?.text ||
      messageData.button?.payload ||
      messageData.interactive ||
      messageData.image?.id ||
      messageData.video?.id ||
      messageData.audio?.id ||
      messageData.voice?.id ||
      messageData.document?.id ||
      messageData.sticker?.id ||
      messageData.location ||
      (Array.isArray(messageData.contacts) &&
        messageData.contacts.length > 0) ||
      messageData.order ||
      messageData.system?.body ||
      messageData.context?.id ||
      messageData.referral,
  );
}

export function isNonDisplayableWhatsAppUnsupportedMessage(
  messageData: WhatsAppMessage,
): boolean {
  if (messageData.type !== "unsupported") return false;
  if (isWhatsAppApiUnavailableUnsupportedMessage(messageData)) return false;

  const errors = messageData.errors || [];
  const hasUnknownTypeError = errors.some(
    (error) => error.code === WHATSAPP_UNSUPPORTED_MESSAGE_TYPE_ERROR_CODE,
  );
  if (!hasUnknownTypeError) return false;

  if (
    errors.some(
      (error) => error.code === WHATSAPP_UNAVAILABLE_MESSAGE_ERROR_CODE,
    )
  ) {
    return false;
  }

  if (getWhatsAppProviderMediaErrorText(errors)) return false;

  const unsupportedType = messageData.unsupported?.type?.trim();
  const isGenericUnknownType =
    !unsupportedType || unsupportedType === "unknown";
  return isGenericUnknownType && !hasRenderableUnsupportedPayload(messageData);
}

function getWhatsAppUnsupportedMessageText(
  messageData: WhatsAppMessage,
): string | null {
  if (isWhatsAppApiUnavailableUnsupportedMessage(messageData)) {
    return WHATSAPP_API_UNAVAILABLE_MESSAGE_TEXT;
  }
  if (messageData.type !== "unsupported") return null;
  if (isNonDisplayableWhatsAppUnsupportedMessage(messageData)) return null;

  const errors = messageData.errors || [];
  if (
    errors.some(
      (error) => error.code === WHATSAPP_UNAVAILABLE_MESSAGE_ERROR_CODE,
    )
  ) {
    return WHATSAPP_UNAVAILABLE_MESSAGE_TEXT;
  }

  const unsupportedType = messageData.unsupported?.type?.trim();
  const hasUnsupportedTypeError = errors.some(
    (error) => error.code === WHATSAPP_UNSUPPORTED_MESSAGE_TYPE_ERROR_CODE,
  );

  if (hasUnsupportedTypeError || unsupportedType) {
    return unsupportedType && unsupportedType !== "unknown"
      ? `[Unsupported WhatsApp message: ${unsupportedType}]`
      : WHATSAPP_API_UNAVAILABLE_MESSAGE_TEXT;
  }

  return "[Unsupported WhatsApp message]";
}

function extractMessageAuthorId(author: unknown): string | undefined {
  if (!author || typeof author !== "object" || !("_id" in author)) {
    return undefined;
  }

  const rawId = (author as { _id?: unknown })._id;
  if (rawId === null || rawId === undefined) {
    return undefined;
  }

  return String(rawId);
}

function extractMessageAuthorName(author: unknown): string | undefined {
  if (!author || typeof author !== "object" || !("firstName" in author)) {
    return undefined;
  }

  const firstName = (author as { firstName?: unknown }).firstName;
  if (typeof firstName !== "string") {
    return undefined;
  }

  const trimmed = firstName.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse CSAT rating from message text.
 * Looks for a single digit 1-5 in the message.
 * Returns null if no valid rating found.
 */
function parseCsatRating(text: string): number | null {
  if (!text) return null;
  const trimmed = text.trim();
  // Check if message is just a single digit 1-5
  if (/^[1-5]$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }
  // Also check for common patterns like "5 stars", "4 out of 5", etc.
  const match = trimmed.match(/^([1-5])\s*(star|out|\/|\s|$)/i);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

function formatInteractiveValue(value: unknown): string {
  if (value === null || value === undefined) return "null";

  if (typeof value === "string") {
    return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.length} items]`;
  }

  if (typeof value === "object") {
    return "{...}";
  }

  return String(value);
}

function parseFlowResponseSummary(responseJson?: string): string | null {
  if (!responseJson) return null;

  try {
    const parsed = JSON.parse(responseJson) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) return null;

    const preview = entries
      .slice(0, 5)
      .map(([key, value]) => `${key}: ${formatInteractiveValue(value)}`)
      .join("; ");

    if (entries.length > 5) {
      return `${preview}; ...`;
    }

    return preview;
  } catch {
    return null;
  }
}

function getInteractiveMessageText(messageData: WhatsAppMessage): string {
  const interactive = messageData.interactive;

  if (interactive?.type === "nfm_reply") {
    const flowName = interactive.nfm_reply?.name || "flow";

    // REQUEST_CONTACT_INFO responses arrive as nfm_reply with name "address_message"
    if (flowName === "address_message") {
      const phone = extractPhoneFromAddressMessageReply(
        interactive.nfm_reply?.response_json,
      );
      if (phone) {
        return `[Contact info shared: ${phone}]`;
      }
      return "[Contact info shared]";
    }

    const summary = parseFlowResponseSummary(
      interactive.nfm_reply?.response_json,
    );
    if (summary) {
      return `[Flow response: ${flowName}] ${summary}`;
    }

    if (interactive.nfm_reply?.body) {
      return `[Flow response: ${flowName}] ${interactive.nfm_reply.body}`;
    }

    return `[Flow response: ${flowName}]`;
  }

  if (interactive?.type === "button_reply") {
    return (
      interactive.button_reply?.title || interactive.button_reply?.id || ""
    );
  }

  if (interactive?.type === "list_reply") {
    return interactive.list_reply?.title || interactive.list_reply?.id || "";
  }

  return "[Interactive message]";
}

function getLocationMessageText(messageData: WhatsAppMessage): string {
  const location = messageData.location;
  if (!location) return "[Location]";

  const label = [location.name, location.address]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join(", ");

  const latLng =
    typeof location.latitude === "number" &&
    typeof location.longitude === "number"
      ? `${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`
      : null;

  if (label && latLng) return `[Location] ${label} (${latLng})`;
  if (label) return `[Location] ${label}`;
  if (latLng) return `[Location] ${latLng}`;
  return "[Location]";
}

function getContactsMessageText(messageData: WhatsAppMessage): string {
  const contacts = messageData.contacts;
  if (!Array.isArray(contacts) || contacts.length === 0) return "[Contact]";

  const summaries = contacts.slice(0, 3).map((contact) => {
    const name =
      contact?.name?.formatted_name ||
      [contact?.name?.first_name, contact?.name?.last_name]
        .filter(Boolean)
        .join(" ") ||
      null;
    const primaryPhone = contact?.phones?.find(
      (phone) => typeof phone?.phone === "string" && phone.phone.length > 0,
    )?.phone;

    if (name && primaryPhone) return `${name} (${primaryPhone})`;
    if (name) return name;
    if (primaryPhone) return primaryPhone;
    return "unnamed";
  });

  const label = summaries.join("; ");
  const suffix =
    contacts.length > summaries.length
      ? ` (+${contacts.length - summaries.length} more)`
      : "";
  return contacts.length === 1
    ? `[Contact] ${label}${suffix}`
    : `[Contacts] ${label}${suffix}`;
}

function normalizeWhatsAppProductInquiry(messageData: WhatsAppMessage) {
  const referredProduct = messageData.context?.referred_product;
  if (!referredProduct?.product_retailer_id && !referredProduct?.catalog_id) {
    return null;
  }
  return {
    catalogId: referredProduct.catalog_id || null,
    productRetailerId: referredProduct.product_retailer_id || null,
    contextMessageId: messageData.context?.id || null,
  };
}

async function resolveWhatsAppReplyMeta(params: {
  conversationId: unknown;
  contextMessageId?: string | null;
  /**
   * Product-inquiry webhooks also carry `context.id`, but that is commerce
   * context (`referred_product`), not a chat reply quote.
   */
  hasReferredProduct?: boolean;
}): Promise<WhatsAppStoredMessageMeta | null> {
  if (params.hasReferredProduct) return null;

  const contextMessageId =
    typeof params.contextMessageId === "string"
      ? params.contextMessageId.trim()
      : "";
  if (!contextMessageId || !params.conversationId) return null;

  const parent = await findWhatsAppContextMessage<{
    messageId?: string | null;
    text?: string | null;
    mediaType?: string | null;
  }>({
    Message,
    conversationId: params.conversationId,
    contextMessageId,
    select: "messageId text mediaType",
  });

  return buildWhatsAppStoredReplyMeta({
    replyToMessageId: parent?.messageId || contextMessageId,
    parent,
  });
}

function buildWhatsAppForwardMeta(
  context: WhatsAppMessage["context"] | null | undefined,
): Pick<WhatsAppStoredMessageMeta, "forwarded" | "frequentlyForwarded"> | null {
  if (!context) return null;
  const forwarded = Boolean(context.forwarded);
  const frequentlyForwarded = Boolean(context.frequently_forwarded);
  if (!forwarded && !frequentlyForwarded) return null;
  return {
    ...(forwarded ? { forwarded: true } : {}),
    ...(frequentlyForwarded ? { frequentlyForwarded: true } : {}),
  };
}

async function resolveWhatsAppStoredMessageMeta(params: {
  conversationId: unknown;
  context?: WhatsAppMessage["context"] | null;
}): Promise<WhatsAppStoredMessageMeta | null> {
  const hasReferredProduct = Boolean(
    params.context?.referred_product?.catalog_id ||
      params.context?.referred_product?.product_retailer_id,
  );
  const replyMeta = await resolveWhatsAppReplyMeta({
    conversationId: params.conversationId,
    contextMessageId: params.context?.id,
    hasReferredProduct,
  });
  const forwardMeta = buildWhatsAppForwardMeta(params.context);

  if (!replyMeta && !forwardMeta) return null;
  return {
    ...(replyMeta || {}),
    ...(forwardMeta || {}),
  };
}

function normalizeWhatsAppOrder(messageData: WhatsAppMessage) {
  const order = messageData.order;
  if (messageData.type !== "order" || !order) return null;
  const productItems = Array.isArray(order.product_items)
    ? order.product_items.map((item) => ({
        productRetailerId: item.product_retailer_id || null,
        quantity:
          typeof item.quantity === "number" && Number.isFinite(item.quantity)
            ? item.quantity
            : 0,
        itemPrice:
          typeof item.item_price === "number" &&
          Number.isFinite(item.item_price)
            ? item.item_price
            : 0,
        currency: item.currency || null,
      }))
    : [];

  const currency =
    productItems.find((item) => typeof item.currency === "string")?.currency ||
    null;
  const totalQuantity = productItems.reduce(
    (sum, item) => sum + item.quantity,
    0,
  );
  const totalAmount = productItems.reduce(
    (sum, item) => sum + item.quantity * item.itemPrice,
    0,
  );

  return {
    catalogId: order.catalog_id || null,
    text: order.text || null,
    productItems,
    totalQuantity,
    totalAmount,
    currency,
  };
}

function formatCommerceAmount(value: number) {
  return value.toFixed(2);
}

export function buildWhatsAppCommerceRagContext(
  messageData: WhatsAppMessage,
): string | undefined {
  const inquiry = normalizeWhatsAppProductInquiry(messageData);
  if (inquiry) {
    const parts = [
      "WhatsApp commerce context: product inquiry",
      inquiry.catalogId ? `catalog_id=${inquiry.catalogId}` : null,
      inquiry.productRetailerId
        ? `product_retailer_id=${inquiry.productRetailerId}`
        : null,
      inquiry.contextMessageId
        ? `context_message_id=${inquiry.contextMessageId}`
        : null,
    ].filter(Boolean);
    return parts.join("; ");
  }

  const order = normalizeWhatsAppOrder(messageData);
  if (!order) return undefined;

  const itemParts = (order.productItems || [])
    .map((item) => {
      const productRetailerId = item.productRetailerId?.trim();
      if (!productRetailerId) return null;
      const quantity =
        typeof item.quantity === "number" && Number.isFinite(item.quantity)
          ? item.quantity
          : 0;
      const price =
        typeof item.itemPrice === "number" && Number.isFinite(item.itemPrice)
          ? item.itemPrice
          : 0;
      const currency = item.currency?.trim();
      return `${productRetailerId} x${quantity} @ ${formatCommerceAmount(
        price,
      )}${currency ? ` ${currency}` : ""}`;
    })
    .filter(Boolean);

  const parts = [
    "WhatsApp commerce context: order",
    order.catalogId ? `catalog_id=${order.catalogId}` : null,
    `total_quantity=${order.totalQuantity}`,
    order.currency
      ? `total_amount=${formatCommerceAmount(order.totalAmount)} ${
          order.currency
        }`
      : null,
    order.text ? `note=${order.text}` : null,
    itemParts.length > 0 ? `items=${itemParts.join(", ")}` : null,
  ].filter(Boolean);

  return parts.join("; ");
}

function getWhatsAppOrderMessageText(messageData: WhatsAppMessage): string {
  const order = normalizeWhatsAppOrder(messageData);
  if (!order) return "[WhatsApp order]";
  const countLabel =
    order.totalQuantity === 1 ? "1 item" : `${order.totalQuantity} items`;
  const amountLabel =
    order.currency && order.totalAmount > 0
      ? `, ${order.totalAmount.toFixed(2)} ${order.currency}`
      : "";
  const suffix = order.text ? ` ${order.text}` : "";
  return `[WhatsApp order: ${countLabel}${amountLabel}]${suffix}`;
}

export function getWhatsAppInboundMessageText(
  messageData: WhatsAppMessage,
): string {
  if (
    messageData.type === "unsupported" &&
    getWhatsAppMessageMutationKind(messageData) === "edit"
  ) {
    return "";
  }

  if (messageData.type === "order") {
    return getWhatsAppOrderMessageText(messageData);
  }

  if (messageData.type === "text" || messageData.type === "edit") {
    const text = messageData.text?.body || "";
    const inquiry = normalizeWhatsAppProductInquiry(messageData);
    if (inquiry?.productRetailerId) {
      return `[Product inquiry: ${inquiry.productRetailerId}] ${text}`.trim();
    }
    return text;
  }

  if (messageData.type === "interactive") {
    return getInteractiveMessageText(messageData);
  }

  if (messageData.type === "button") {
    return messageData.button?.text || messageData.button?.payload || "";
  }

  if (messageData.type === "location") {
    return getLocationMessageText(messageData);
  }

  if (messageData.type === "contacts") {
    return getContactsMessageText(messageData);
  }

  return getWhatsAppUnsupportedMessageText(messageData) || "";
}

/**
 * Extract phone number from a REQUEST_CONTACT_INFO (address_message) nfm_reply.
 *
 * The `response_json` payload from Meta's address_message interactive type
 * contains the shared phone number in `{ phone_number: "+1234567890" }` or
 * `{ values: { phone_number: "+1234567890" } }` depending on API version.
 *
 * Returns normalized phone digits or null if not found.
 */
export function extractPhoneFromAddressMessageReply(
  responseJson: string | undefined | null,
): string | null {
  if (!responseJson) return null;
  try {
    const parsed =
      typeof responseJson === "string"
        ? JSON.parse(responseJson)
        : responseJson;
    // Try direct field
    const directPhone = normalizeWhatsAppPhone(parsed?.phone_number);
    if (directPhone) return directPhone;
    // Try nested values field
    const nestedPhone = normalizeWhatsAppPhone(parsed?.values?.phone_number);
    if (nestedPhone) return nestedPhone;
    // Try response_json.saved_addresses[0].phone_number (another possible shape)
    if (Array.isArray(parsed?.saved_addresses) && parsed.saved_addresses[0]) {
      const savedPhone = normalizeWhatsAppPhone(
        parsed.saved_addresses[0].phone_number,
      );
      if (savedPhone) return savedPhone;
    }
    return null;
  } catch {
    return null;
  }
}

interface ProcessWhatsAppMessageParams {
  importMode?: "history";
  messageData: WhatsAppMessage;
  contactData: WhatsAppNormalizedContact;
  phoneNumberId: string;
  accessToken?: string;
  workspaceId: string;
  direction: "inbound" | "outbound";
  sourceId: string;
  messageDate: Date;
  conversationId?: string;
  rawSourcePayload?: RawSourcePayload;
  normalizedWhatsAppFlowReply?: NormalizedWhatsAppFlowReply | null;
  deferMediaHydration?: boolean;
  /** Keep raw referral durable; the webhook runtime queues metadata enrichment. */
  deferReferralEnrichment?: boolean;
  claimWebsiteCart?: (input: {
    workspaceId: string;
    sourceId: string;
    conversationId: string;
    text: string;
    messageId: string;
    occurredAt: Date;
  }) => Promise<boolean>;
  /**
   * Plan gate for NEW conversations; existing conversations never call it.
   * Required so every production caller decides explicitly (null = no gate).
   */
  getNewConversationPlanSkip: WhatsAppIntakePlanCheck | null;
}

function requireWhatsAppMediaAccessToken(accessToken?: string): string {
  const normalized = accessToken?.trim();
  if (!normalized) {
    throw new Error(
      "WhatsApp access token is required for synchronous media hydration",
    );
  }

  return normalized;
}

interface ProcessWhatsAppMessageResult {
  message?: MessageDocument;
  conversationId: string;
  isNewConversation: boolean;
  messageWasNew: boolean;
  messageRecoveryRevision?: string;
  processedAs?:
    | "reaction"
    | "unsupported_skipped"
    | typeof WHATSAPP_PLAN_SKIPPED_PROCESSED_AS;
  /** Set when processedAs is "plan_skipped": no conversation was created. */
  planSkip?: WhatsAppIntakePlanSkip;
  reopenedConversation?: boolean;
  userId?: string;
  chatId?: string;
  conversation?: ConversationDocument;
  chat?: ChatDocument;
  mediaAnalysisType?: ConversationMediaAnalysisType | null;
}

function resolveConversationMediaAnalysisType(
  value: unknown,
): ConversationMediaAnalysisType | null {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "audio" ||
    normalized === "voice" ||
    normalized === "video"
    ? normalized
    : null;
}

interface ParsedLegacyReactionText {
  emoji: string;
  targetMessageId: string;
}

function plainStoredValue(value: unknown): unknown {
  const document = value as { toObject?: () => unknown } | null;
  return document?.toObject ? document.toObject() : (value ?? null);
}

async function persistRecoveredWhatsAppMessage(
  existing: MessageDocument,
  incoming: MessageDocument,
): Promise<MessageDocument> {
  return recoverWhatsAppMessage(existing, incoming, {
    compareAndSwap: async (previous, update) =>
      Message.findOneAndUpdate(
        {
          _id: previous._id,
          workspaceId: previous.workspaceId,
          direction: "inbound",
          text: previous.text ?? null,
          rawSourcePayload: plainStoredValue(previous.rawSourcePayload),
          whatsappReferral: plainStoredValue(previous.whatsappReferral),
          editMeta: plainStoredValue(previous.editMeta),
          whatsappRecoveryRevision: previous.whatsappRecoveryRevision ?? null,
        },
        { $set: update },
        { new: true },
      ).populate({ path: "author", select: "isBot firstName" }),
    read: async () =>
      Message.findById(existing._id)
        .populate({
          path: "author",
          select: "isBot firstName",
        })
        .lean<MessageDocument | null>(),
  });
}


function parseLegacyReactionText(
  text: string | undefined,
): ParsedLegacyReactionText | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  let payload = trimmed;
  const managerPrefixMatch = trimmed.match(/^([^:]+):\s*(.+)$/);
  if (managerPrefixMatch?.[2]) {
    payload = managerPrefixMatch[2].trim();
  }

  const reactedMatch = payload.match(
    /^Reacted:\s*(.+?)\s*\(to message\s+([^)]+)\)\s*$/i,
  );
  if (reactedMatch) {
    const emoji = reactedMatch[1]?.trim() || "";
    const targetMessageId = reactedMatch[2]?.trim() || "";
    if (!targetMessageId) return null;
    if (
      !targetMessageId.startsWith("wamid.") &&
      !targetMessageId.startsWith("ws_")
    ) {
      return null;
    }
    return { emoji, targetMessageId };
  }

  const removedMatch = payload.match(
    /^Reaction removed\s*\(to message\s+([^)]+)\)\s*$/i,
  );
  if (removedMatch) {
    const targetMessageId = removedMatch[1]?.trim() || "";
    if (!targetMessageId) return null;
    if (
      !targetMessageId.startsWith("wamid.") &&
      !targetMessageId.startsWith("ws_")
    ) {
      return null;
    }
    return { emoji: "", targetMessageId };
  }

  return null;
}

type WhatsAppIdentityMatchSets = {
  phoneIds: string[];
  userIds: string[];
  parentUserIds: string[];
};

type WhatsAppIdentityLookupFilter = {
  workspaceId: string;
  $or: Array<Record<string, string>>;
};

type WhatsAppIdentityMatchDocument = {
  _id?: unknown;
  whatsapp?: {
    waId?: string | null;
    previousWaIds?: string[] | null;
    userId?: string | null;
    previousUserIds?: string[] | null;
    parentUserId?: string | null;
  } | null;
};

function dedupeStringArray(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value))),
  );
}

export function buildWhatsAppIdentityLookupFilter(params: {
  contactData: WhatsAppNormalizedContact;
  workspaceId: string;
}): WhatsAppIdentityLookupFilter {
  const { contactData, workspaceId } = params;
  const phoneVariants = listWhatsAppPhoneIdentityVariants(contactData.waId);
  const identityClauses: Array<Record<string, string>> = [];
  for (const phone of phoneVariants) {
    identityClauses.push(
      { _id: buildWhatsAppCanonicalIdFromPhone(phone) },
      { "whatsapp.waId": phone },
      { "whatsapp.previousWaIds": phone },
    );
  }

  if (contactData.userId) {
    identityClauses.push(
      { "whatsapp.userId": contactData.userId },
      { "whatsapp.previousUserIds": contactData.userId },
    );
  }
  if (contactData.parentUserId) {
    identityClauses.push({
      "whatsapp.parentUserId": contactData.parentUserId,
    });
  }

  return { workspaceId, $or: identityClauses };
}

function includesIdentity(
  values: string[] | null | undefined,
  expected: string | null | undefined,
): boolean {
  return Boolean(expected && values?.includes(expected));
}

export function classifyWhatsAppIdentityMatchDocuments(params: {
  contactData: WhatsAppNormalizedContact;
  documents: WhatsAppIdentityMatchDocument[];
}): WhatsAppIdentityMatchSets {
  const phoneVariants = new Set(
    listWhatsAppPhoneIdentityVariants(params.contactData.waId),
  );
  const canonicalPhoneIds = new Set(
    Array.from(phoneVariants, buildWhatsAppCanonicalIdFromPhone),
  );
  const phoneIds: string[] = [];
  const userIds: string[] = [];
  const parentUserIds: string[] = [];

  for (const document of params.documents) {
    if (document._id === undefined || document._id === null) continue;
    const id = String(document._id);
    const whatsapp = document.whatsapp;
    const phoneMatched =
      canonicalPhoneIds.has(id) ||
      Boolean(whatsapp?.waId && phoneVariants.has(whatsapp.waId)) ||
      Boolean(
        whatsapp?.previousWaIds?.some((value) => phoneVariants.has(value)),
      );
    const userMatched =
      Boolean(
        params.contactData.userId &&
          whatsapp?.userId === params.contactData.userId,
      ) ||
      includesIdentity(whatsapp?.previousUserIds, params.contactData.userId);
    const parentMatched = Boolean(
      params.contactData.parentUserId &&
        whatsapp?.parentUserId === params.contactData.parentUserId,
    );

    if (phoneMatched) phoneIds.push(id);
    if (userMatched) userIds.push(id);
    if (parentMatched) parentUserIds.push(id);
  }

  return {
    phoneIds: dedupeStringArray(phoneIds),
    userIds: dedupeStringArray(userIds),
    parentUserIds: dedupeStringArray(parentUserIds),
  };
}

async function findWhatsAppIdentityMatches(params: {
  contactData: WhatsAppNormalizedContact;
  workspaceId: string;
}): Promise<WhatsAppIdentityMatchSets> {
  try {
    await ensureWhatsAppIdentityIndexes();
  } catch (error) {
    console.warn("[WhatsApp Message Processor] identity_index_ensure_failed", {
      workspaceId: params.workspaceId,
      error,
    });
  }
  const filter = buildWhatsAppIdentityLookupFilter(params);
  if (filter.$or.length === 0) {
    return { phoneIds: [], userIds: [], parentUserIds: [] };
  }

  const projection =
    "_id whatsapp.waId whatsapp.previousWaIds whatsapp.userId whatsapp.previousUserIds whatsapp.parentUserId";
  const [userMatches, chatMatches] = await Promise.all([
    User.find(filter)
      .select(projection)
      .limit(20)
      .lean<WhatsAppIdentityMatchDocument[]>(),
    Chat.find(filter)
      .select(projection)
      .limit(20)
      .lean<WhatsAppIdentityMatchDocument[]>(),
  ]);

  return classifyWhatsAppIdentityMatchDocuments({
    contactData: params.contactData,
    documents: [...userMatches, ...chatMatches],
  });
}

function resolveCanonicalWhatsAppRecordId(params: {
  contactData: WhatsAppNormalizedContact;
  matches: WhatsAppIdentityMatchSets;
}) {
  const { contactData, matches } = params;
  const phoneCanonicalId = contactData.waId
    ? buildWhatsAppCanonicalIdFromPhone(contactData.waId)
    : null;
  const fallbackCanonicalId = buildWhatsAppCanonicalId(contactData);

  if (matches.phoneIds.length === 1) {
    return {
      canonicalId: matches.phoneIds[0],
      hadConflict: false,
    };
  }

  if (matches.phoneIds.length > 1) {
    return {
      canonicalId:
        (phoneCanonicalId && matches.phoneIds.includes(phoneCanonicalId)
          ? phoneCanonicalId
          : matches.phoneIds[0]) || fallbackCanonicalId,
      hadConflict: true,
    };
  }

  if (matches.userIds.length === 1) {
    return {
      canonicalId: matches.userIds[0],
      hadConflict: false,
    };
  }

  if (matches.userIds.length > 1) {
    return {
      canonicalId: matches.userIds[0] || fallbackCanonicalId,
      hadConflict: true,
    };
  }

  if (matches.parentUserIds.length === 1) {
    return {
      canonicalId: matches.parentUserIds[0],
      hadConflict: false,
    };
  }

  if (matches.parentUserIds.length > 1) {
    return {
      canonicalId: matches.parentUserIds[0] || fallbackCanonicalId,
      hadConflict: true,
    };
  }

  const allMatches = dedupeStringArray([
    ...matches.phoneIds,
    ...matches.userIds,
    ...matches.parentUserIds,
  ]);

  if (allMatches.length > 1) {
    return {
      canonicalId:
        phoneCanonicalId ||
        matches.userIds[0] ||
        matches.parentUserIds[0] ||
        allMatches[0] ||
        fallbackCanonicalId,
      hadConflict: true,
    };
  }

  if (allMatches.length === 1) {
    return {
      canonicalId: allMatches[0],
      hadConflict: false,
    };
  }

  return {
    canonicalId: fallbackCanonicalId,
    hadConflict: false,
  };
}

export async function processWhatsAppMessage(
  params: ProcessWhatsAppMessageParams,
): Promise<ProcessWhatsAppMessageResult> {
  const isHistoryImport = params.importMode === "history";
  const {
    messageData,
    contactData,
    phoneNumberId,
    accessToken,
    workspaceId,
    direction,
    sourceId,
    messageDate,
    conversationId: existingConversationId,
    rawSourcePayload,
    normalizedWhatsAppFlowReply,
    deferMediaHydration = false,
  } = params;
  const timingEnabled = process.env.WHATSAPP_MESSAGE_PROCESSOR_TIMINGS === "1";
  const timingStartedAt = Date.now();
  let timingLastAt = timingStartedAt;
  const logTiming = (stage: string) => {
    if (!timingEnabled) return;
    const now = Date.now();
    console.info("[WhatsApp Message Processor] timing", {
      stage,
      messageId: messageData.id,
      workspaceId,
      sourceId,
      phoneNumberId,
      direction,
      stageMs: now - timingLastAt,
      totalMs: now - timingStartedAt,
    });
    timingLastAt = now;
  };

  await connectDB();
  logTiming("mongodb_connection");
  const whatsappGroupId =
    typeof messageData.group_id === "string" && messageData.group_id.trim()
      ? messageData.group_id.trim()
      : null;
  const whatsappGroupChatId = whatsappGroupId
    ? buildWhatsAppGroupChatId({
        groupId: whatsappGroupId,
        phoneNumberId,
        sourceId,
      })
    : null;
  const whatsappGroupMeta = whatsappGroupId
    ? {
        groupId: whatsappGroupId,
        phoneNumberId,
        sourceId,
      }
    : null;

  if (isNonDisplayableWhatsAppUnsupportedMessage(messageData)) {
    console.info(
      "[WhatsApp Message Processor] Empty unsupported event skipped",
      {
        workspaceId,
        sourceId,
        phoneNumberId,
        messageId: messageData.id,
        errors: messageData.errors?.map((error) => error.code) || [],
        unsupportedType: messageData.unsupported?.type || null,
      },
    );

    return {
      conversationId: existingConversationId || "",
      isNewConversation: false,
      messageWasNew: false,
      processedAs: "unsupported_skipped",
    };
  }

  // History replay can contain an already persisted inbound message. Live
  // retries retain the full processing path for cart handoff and media recovery.
  // Edits, revokes, and reactions must still apply their mutation.
  let existingStoredMessage: MessageDocument | null = null;
  if (
    direction === "outbound" ||
    (rawSourcePayload?.eventType === "history_message" &&
      !getWhatsAppMessageMutationKind(messageData))
  ) {
    const normalizedMessageId = normalizeWhatsAppMessageId(messageData.id);
    const existingStoredMessageQuery = Message.findOne({
      workspaceId,
      channel: "whatsapp",
      messageId: { $in: listWhatsAppMessageIdLookupKeys(messageData.id) },
    }).populate({
      path: "author",
      select: "isBot firstName",
    });
    existingStoredMessage = (
      direction === "inbound"
        ? await existingStoredMessageQuery.lean()
        : await existingStoredMessageQuery
    ) as MessageDocument | null;

    if (existingStoredMessage) {
      const existingConversation = await Conversation.findById(
        existingStoredMessage.conversation,
      );
      const recovery =
        direction === "inbound"
          ? buildWhatsAppMessageRecovery(existingStoredMessage, {
              rawSourcePayload: { payload: { message: messageData } },
              text: getWhatsAppInboundMessageText(messageData),
              whatsappReferral: normalizeWhatsAppWebhookReferral(
                messageData.referral,
              ),
            })
          : null;
      if (existingConversation && !recovery) {
        await persistWhatsAppMessageConversationLink(
          {
            workspaceId,
            messageId: normalizedMessageId,
            messageObjectId: existingStoredMessage._id,
            eventAt: messageDate,
            conversationId: existingConversation._id,
            direction,
            importMode: params.importMode,
            conversationSet: {
              workspaceId,
              ...(whatsappGroupMeta
                ? { whatsappGroup: whatsappGroupMeta }
                : {}),
            },
          },
          whatsAppMessageConversationLinkDependencies,
        );

        return {
          message: existingStoredMessage,
          conversationId: String(existingConversation._id),
          isNewConversation: false,
          messageWasNew: false,
          messageRecoveryRevision:
            existingStoredMessage.whatsappRecoveryRevision,
        };
      }
    }
  }

  const identityMatches = await findWhatsAppIdentityMatches({
    contactData,
    workspaceId,
  });
  logTiming("identity_matches");
  const { canonicalId: customerId, hadConflict } =
    resolveCanonicalWhatsAppRecordId({
      contactData,
      matches: identityMatches,
    });

  if (!customerId) {
    throw new Error("Unable to resolve canonical WhatsApp identity");
  }

  if (hadConflict) {
    console.warn("[WhatsApp Message Processor] identity_conflict", {
      workspaceId,
      phoneNumberId,
      messageId: messageData.id,
      waId: contactData.waId || null,
      userId: contactData.userId || null,
      parentUserId: contactData.parentUserId || null,
      preferredCanonicalId: customerId,
      matches: identityMatches,
    });
  }

  const { firstName, lastName, fullName } = parseWhatsAppName(
    contactData.profile.name,
  );

  const whatsappSnapshotUpdate =
    buildWhatsAppIdentitySnapshotUpdate(contactData);
  const updateFields: {
    firstName?: string;
    lastName?: string;
    username?: string;
    isBot: boolean;
  } = {
    isBot: false,
  };

  if (firstName) {
    updateFields.firstName = firstName;
  }
  if (lastName) {
    updateFields.lastName = lastName;
  }
  if (contactData.profile.username) {
    updateFields.username = contactData.profile.username;
  } else if (fullName && !firstName && !lastName) {
    updateFields.username = fullName;
  }

  const customerUserPromise = User.findOneAndUpdate(
    { _id: customerId },
    {
      $set: {
        ...updateFields,
        ...whatsappSnapshotUpdate.set,
      },
      ...(Object.keys(whatsappSnapshotUpdate.unset).length > 0
        ? { $unset: whatsappSnapshotUpdate.unset }
        : {}),
      $setOnInsert: {
        workspaceId,
      },
    },
    { upsert: true, new: true },
  ).exec();
  void customerUserPromise.catch(() => undefined);

  // Get message text early to detect manager messages
  let messageText = getWhatsAppInboundMessageText(messageData);
  const messageMutationKind = getWhatsAppMessageMutationKind(messageData);

  // REQUEST_CONTACT_INFO response: link shared phone to BSUID-keyed record
  if (
    messageData.type === "interactive" &&
    messageData.interactive?.type === "nfm_reply" &&
    messageData.interactive.nfm_reply?.name === "address_message" &&
    direction === "inbound"
  ) {
    await customerUserPromise;
    logTiming("customer_upsert_for_contact_info");
    const sharedPhone = extractPhoneFromAddressMessageReply(
      messageData.interactive.nfm_reply.response_json,
    );
    if (sharedPhone && !contactData.waId) {
      console.log("[WhatsApp Message Processor] contact_info_phone_linked", {
        workspaceId,
        customerId,
        sharedPhone,
        userId: contactData.userId || null,
        parentUserId: contactData.parentUserId || null,
      });
      // Enrich User and Chat with the newly shared phone number.
      // Best-effort: these are separate writes, matching the existing
      // enrichment pattern in buildWhatsAppIdentitySnapshot usage.
      // Partial success is acceptable — the repair script can reconcile.
      await User.updateOne(
        { _id: customerId },
        { $set: { "whatsapp.waId": sharedPhone } },
      );
      await Chat.updateOne(
        { _id: customerId },
        { $set: { "whatsapp.waId": sharedPhone } },
      );
    }
  }

  if (messageMutationKind) {
    await customerUserPromise;
    logTiming("customer_upsert_for_mutation");
  }

  if (messageMutationKind === "edit") {
    const editPayload = messageData.edit;
    const editMessage = editPayload?.message;
    const isUnsupportedEditEvent = messageData.type === "unsupported";
    const targetMessageId =
      editPayload?.original_message_id ||
      editMessage?.context?.id ||
      editPayload?.message_id ||
      messageData.context?.id ||
      (messageData.type === "edit" ? messageData.id : "");
    const normalizedTargetId = normalizeWhatsAppMessageId(targetMessageId);
    const updatedText =
      editMessage?.text?.body ||
      editMessage?.image?.caption ||
      editMessage?.video?.caption ||
      editMessage?.document?.caption ||
      (!isUnsupportedEditEvent ? messageText : "") ||
      "";

    console.log("[WhatsApp Message Processor] Edit event received:", {
      messageId: messageData.id,
      targetMessageId,
      editMessageType: editMessage?.type,
      hasText: !!updatedText,
      hasMediaId: !!(
        editMessage?.image?.id ||
        editMessage?.video?.id ||
        editMessage?.document?.id
      ),
      phoneNumberId,
      workspaceId,
    });

    if (!targetMessageId) {
      console.warn("[WhatsApp Message Processor] Edit event missing target:", {
        messageId: messageData.id,
        unsupportedType: messageData.unsupported?.type || null,
        phoneNumberId,
        workspaceId,
      });

      const fallbackMessage = await Message.findOne({
        channel: "whatsapp",
        chat: whatsappGroupChatId || customerId,
      }).sort({ date: -1 });

      return {
        message: (fallbackMessage as MessageDocument) || undefined,
        conversationId: fallbackMessage
          ? String(fallbackMessage.conversation)
          : existingConversationId || "",
        isNewConversation: false,
        messageWasNew: false,
      };
    }

    const targetMessage = await Message.findOne({
      channel: "whatsapp",
      $or: [{ messageId: normalizedTargetId }, { messageId: targetMessageId }],
    })
      .select("_id conversation text")
      .lean<{
        _id: unknown;
        conversation?: unknown;
        text?: string | null;
      } | null>();

    const previousText =
      typeof targetMessage?.text === "string" ? targetMessage.text : null;
    const hasTextChange = Boolean(
      updatedText && (previousText || "") !== updatedText,
    );

    const updatedMessage = targetMessage
      ? await Message.findByIdAndUpdate(
          targetMessage._id,
          {
            $set: {
              ...(updatedText ? { text: updatedText } : {}),
              updatedAt: messageDate,
              "editMeta.editedAt": messageDate,
              "editMeta.kind": "edit",
              "editMeta.source": "whatsapp_webhook",
              ...(hasTextChange
                ? { "editMeta.previousText": previousText }
                : {}),
            },
            ...(hasTextChange ? { $inc: { "editMeta.editCount": 1 } } : {}),
          },
          { new: true },
        )
      : null;

    if (updatedMessage) {
      const existingConversation = await Conversation.findById(
        updatedMessage.conversation,
      );
      if (existingConversation) {
        return {
          message: updatedMessage as MessageDocument,
          conversationId: String(existingConversation._id),
          isNewConversation: false,
          messageWasNew: false,
        };
      }
    }

    console.warn("[WhatsApp Message Processor] Edit target not found:", {
      targetMessageId,
      normalizedTargetId,
      hasText: !!updatedText,
      phoneNumberId,
      workspaceId,
    });

    if (updatedText) {
      await storePendingWhatsAppMessageMutation({
        workspaceId,
        sourceId,
        phoneNumberId,
        mutationMessageId: messageData.id,
        targetMessageId,
        kind: "edit",
        text: updatedText,
        eventAt: messageDate,
        payload: messageData,
      });
    }

    const fallbackMessage = await Message.findOne({
      channel: "whatsapp",
      chat: whatsappGroupChatId || customerId,
    }).sort({ date: -1 });

    if (fallbackMessage) {
      return {
        message: fallbackMessage as MessageDocument,
        conversationId: String(fallbackMessage.conversation),
        isNewConversation: false,
        messageWasNew: false,
      };
    }

    return {
      message: (updatedMessage as MessageDocument) || ({} as MessageDocument),
      conversationId: existingConversationId || "",
      isNewConversation: false,
      messageWasNew: false,
    };
  }

  if (messageMutationKind === "revoke") {
    const targetMessageId =
      messageData.revoke?.original_message_id ||
      messageData.context?.id ||
      messageData.id;
    const normalizedTargetId = normalizeWhatsAppMessageId(targetMessageId);

    console.log("[WhatsApp Message Processor] Revoke event received:", {
      messageId: messageData.id,
      targetMessageId,
      phoneNumberId,
      workspaceId,
    });

    const targetMessage = await Message.findOne({
      channel: "whatsapp",
      $or: [{ messageId: normalizedTargetId }, { messageId: targetMessageId }],
    })
      .select("_id conversation text")
      .lean<{
        _id: unknown;
        conversation?: unknown;
        text?: string | null;
      } | null>();

    const previousText =
      typeof targetMessage?.text === "string" ? targetMessage.text : null;
    const nextText = WHATSAPP_DELETED_MESSAGE_TEXT;
    const hasTextChange = (previousText || "") !== nextText;

    const updatedMessage = targetMessage
      ? await Message.findByIdAndUpdate(
          targetMessage._id,
          {
            $set: {
              text: nextText,
              updatedAt: messageDate,
              "editMeta.editedAt": messageDate,
              "editMeta.kind": "revoke",
              "editMeta.source": "whatsapp_webhook",
              ...(hasTextChange
                ? { "editMeta.previousText": previousText }
                : {}),
            },
            ...(hasTextChange ? { $inc: { "editMeta.editCount": 1 } } : {}),
            $unset: WHATSAPP_REVOKED_MEDIA_UNSET,
          },
          { new: true },
        )
      : null;

    if (updatedMessage) {
      const existingConversation = await Conversation.findById(
        updatedMessage.conversation,
      );
      if (existingConversation) {
        return {
          message: updatedMessage as MessageDocument,
          conversationId: String(existingConversation._id),
          isNewConversation: false,
          messageWasNew: false,
        };
      }
    }

    console.warn("[WhatsApp Message Processor] Revoke target not found:", {
      targetMessageId,
      normalizedTargetId,
      phoneNumberId,
      workspaceId,
    });

    await storePendingWhatsAppMessageMutation({
      workspaceId,
      sourceId,
      phoneNumberId,
      mutationMessageId: messageData.id,
      targetMessageId,
      kind: "revoke",
      text: WHATSAPP_DELETED_MESSAGE_TEXT,
      eventAt: messageDate,
      payload: messageData,
    });

    const fallbackMessage = await Message.findOne({
      channel: "whatsapp",
      chat: whatsappGroupChatId || customerId,
    }).sort({ date: -1 });

    if (fallbackMessage) {
      return {
        message: fallbackMessage as MessageDocument,
        conversationId: String(fallbackMessage.conversation),
        isNewConversation: false,
        messageWasNew: false,
      };
    }

    return {
      message: (updatedMessage as MessageDocument) || ({} as MessageDocument),
      conversationId: existingConversationId || "",
      isNewConversation: false,
      messageWasNew: false,
    };
  }

  const messageAuthorPromise =
    direction === "outbound"
      ? (async () => {
          // If the manager route persisted first, preserve its human author.
          if (
            existingStoredMessage?.author &&
            !(existingStoredMessage.author as { isBot?: boolean }).isBot
          ) {
            return existingStoredMessage.author;
          }

          const isAiri = /^airi\s*:/i.test(messageText.trim());
          const businessUserId = isAiri
            ? "0"
            : `whatsapp_business_${phoneNumberId}`;
          return User.findOneAndUpdate(
            { _id: businessUserId },
            {
              firstName: isAiri ? "Airi" : "Business Account",
              isBot: isAiri,
            },
            { upsert: true, new: true },
          );
        })()
      : customerUserPromise;

  const chatId = whatsappGroupChatId || customerId;
  const chatUpdate = whatsappGroupMeta
    ? {
        $set: {
          sourceId,
          type: "whatsapp",
          whatsappGroup: whatsappGroupMeta,
          workspaceId,
        },
        $setOnInsert: {
          title: `WhatsApp group ${(whatsappGroupId || "").slice(-6)}`,
        },
        $addToSet: { participants: customerId },
      }
    : {
        $set: {
          type: "whatsapp",
          sourceId,
          workspaceId,
          ...whatsappSnapshotUpdate.set,
          ...(firstName ? { first_name: firstName } : {}),
          ...(lastName ? { last_name: lastName } : {}),
          ...(contactData.profile.username
            ? { username: contactData.profile.username }
            : {}),
          ...(fullName ? { title: fullName } : {}),
        },
        ...(Object.keys(whatsappSnapshotUpdate.unset).length > 0
          ? { $unset: whatsappSnapshotUpdate.unset }
          : {}),
      };

  const chatPromise = Chat.findOneAndUpdate({ _id: chatId }, chatUpdate, {
    upsert: true,
    new: true,
  });
  const canonicalConversationId =
    existingStoredMessage?.conversation || existingConversationId;
  const conversationLookupPromise = canonicalConversationId
    ? Conversation.findById(canonicalConversationId)
    : Promise.resolve(null);

  const rawReferral =
    direction === "inbound"
      ? normalizeWhatsAppWebhookReferral(messageData.referral)
      : null;
  const normalizedReferralPromise = rawReferral
    ? enrichWhatsAppReferralWithMetaAdMetadata({
        workspaceId,
        referral: rawReferral,
        defer: params.deferReferralEnrichment,
      })
    : Promise.resolve(rawReferral);
  const [
    customerUser,
    messageAuthor,
    resolvedChat,
    resolvedConversation,
    normalizedReferral,
  ] = await Promise.all([
    customerUserPromise,
    messageAuthorPromise,
    chatPromise,
    conversationLookupPromise,
    normalizedReferralPromise,
  ]);
  logTiming("identity_writes_and_conversation_lookup");
  const referralRagContext =
    direction === "inbound"
      ? buildWhatsAppReferralRagContext(normalizedReferral)
      : undefined;
  const commerceRagContext =
    direction === "inbound"
      ? buildWhatsAppCommerceRagContext(messageData)
      : undefined;
  const messageRagContext = [referralRagContext, commerceRagContext]
    .filter(Boolean)
    .join("\n");

  let chat = resolvedChat;
  let conversation = resolvedConversation;
  let isNewConversation = false;
  let reopenedConversation = false;

  if (!conversation) {
    // A refused create (trial expired or the free conversation cap) ends this
    // message as a typed skip; User and Chat were already upserted, as on the
    // other channels.
    const gated = await getOrCreateWhatsAppConversationWithPlanGate({
      workspaceId,
      sourceId,
      itemKind: isHistoryImport ? "history_message" : "new_conversation",
      getNewConversationSkip: params.getNewConversationPlanSkip ?? undefined,
      getOrCreate: (create) =>
        getOrCreateWhatsAppConversation({
          workspaceId,
          sourceId,
          chatId: String(chatId),
          candidateIds: whatsappGroupMeta
            ? [String(chatId)]
            : [
                String(chatId),
                String(customerId),
                ...[
                  contactData.waId,
                  contactData.userId,
                  ...(!hadConflict &&
                  identityMatches.parentUserIds.every((id) => id === customerId)
                    ? [contactData.parentUserId]
                    : []),
                ].filter((value): value is string => Boolean(value)),
              ],
          create,
        }),
      create: async (ownershipKey, identityKeys) => {
        const workspaceBotSettings =
          await getWorkspaceBotRuntimeSettings(workspaceId);
        const created = new Conversation({
          whatsappConversationIdentityKey: ownershipKey,
          whatsappConversationIdentityKeys: identityKeys,
          chat: chat._id,
          user: customerUser._id,
          messages: [],
          is_classified: false,
          workspaceId: workspaceId,
          sourceId: sourceId,
          channel: "whatsapp",
          status: "open",
          ...(isHistoryImport ? { is_read_by_manager: true } : {}),
          ...(whatsappGroupMeta ? { whatsappGroup: whatsappGroupMeta } : {}),
          airi_bot_enabled: workspaceBotSettings.defaultBotEnabled,
          airi_scenarios_enabled: workspaceBotSettings.defaultScenariosEnabled,
          airi_coach_enabled: workspaceBotSettings.defaultCoachEnabled,
          ...(normalizedReferral
            ? {
                whatsappReferral: {
                  ...normalizedReferral,
                  capturedAt: messageDate,
                },
              }
            : {}),
        });
        await created.save();
        return created;
      },
    });
    // Callers log the skip once and complete the receipt.
    if (gated.skip) return buildWhatsAppPlanSkippedProcessResult(gated.skip);
    const owner = gated.owner;
    conversation = owner.conversation;
    isNewConversation = owner.created;
    logTiming("conversation_get_or_create");
  }
  if (!isNewConversation) {
    let needsSave = false;
    if (
      !isHistoryImport &&
      !existingStoredMessage &&
      !existingConversationId &&
      conversation.status === "closed"
    ) {
      conversation.status = "open";
      needsSave = true;
      reopenedConversation = true;
    }
    if (conversation.workspaceId !== workspaceId) {
      conversation.workspaceId = workspaceId;
      needsSave = true;
    }
    if (conversation.sourceId !== sourceId) {
      conversation.sourceId = sourceId;
      needsSave = true;
    }
    if (
      whatsappGroupMeta &&
      conversation.whatsappGroup?.groupId !== whatsappGroupMeta.groupId
    ) {
      conversation.whatsappGroup = whatsappGroupMeta;
      needsSave = true;
    }
    if (needsSave) {
      await conversation.save();
    }
    logTiming("conversation_existing_update");

    if (normalizedReferral) {
      conversation = await persistWhatsAppConversationReferral(
        conversation,
        normalizedReferral,
        messageDate,
      );
    }
  }

  const legacyReaction = parseLegacyReactionText(messageText);
  if (messageData.type === "reaction" || legacyReaction) {
    const reactionTargetId =
      messageData.type === "reaction"
        ? messageData.reaction?.message_id
        : legacyReaction?.targetMessageId;
    const normalizedTargetId = reactionTargetId
      ? normalizeWhatsAppMessageId(reactionTargetId)
      : undefined;
    const reactionEmoji =
      messageData.type === "reaction"
        ? messageData.reaction?.emoji?.trim() || ""
        : legacyReaction?.emoji || "";
    const reactionAuthorId = extractMessageAuthorId(messageAuthor);
    const reactionAuthorName =
      extractMessageAuthorName(messageAuthor) ||
      (direction === "inbound" ? customerUser.firstName : "Business Account") ||
      contactData.profile.name ||
      "Customer";

    const targetFilter: Record<string, unknown> = {
      channel: "whatsapp",
      conversation: conversation._id,
      ...(reactionTargetId && {
        $or: [
          { messageId: normalizedTargetId },
          { messageId: reactionTargetId },
        ],
      }),
    };

    const targetMessage = reactionTargetId
      ? await Message.findOne(targetFilter)
      : null;

    if (targetMessage && reactionAuthorId) {
      await Message.updateOne(
        { _id: targetMessage._id },
        { $pull: { reactions: { authorId: reactionAuthorId } } },
      );

      if (reactionEmoji) {
        await Message.updateOne(
          { _id: targetMessage._id },
          {
            $push: {
              reactions: {
                emoji: reactionEmoji,
                authorId: reactionAuthorId,
                authorName: reactionAuthorName,
                reactionMessageId: normalizeWhatsAppMessageId(messageData.id),
                date: messageDate,
              },
            },
          },
        );
      }

      const updatedTarget = await Message.findById(targetMessage._id).populate({
        path: "author",
        select: "isBot firstName",
      });

      if (updatedTarget) {
        console.log("[WhatsApp Message Processor] Reaction attached:", {
          reactionMessageId: messageData.id,
          targetMessageId: reactionTargetId,
          normalizedTargetId,
          emoji: reactionEmoji || null,
          authorId: reactionAuthorId,
          sourceType: messageData.type,
          conversationId: String(conversation._id),
        });

        return {
          message: updatedTarget as MessageDocument,
          conversationId: String(conversation._id),
          isNewConversation: false,
          messageWasNew: false,
          processedAs: "reaction",
          reopenedConversation,
          userId: String(customerUser._id),
          chatId: String(chat._id),
        };
      }
    }

    console.warn("[WhatsApp Message Processor] Reaction target not found:", {
      messageId: messageData.id,
      reactionTargetId,
      normalizedTargetId,
      hasReactionEmoji: !!reactionEmoji,
      sourceType: messageData.type,
      workspaceId,
      conversationId: String(conversation._id),
    });

    const fallbackMessage = await Message.findOne({
      conversation: conversation._id,
    }).sort({ date: -1 });

    return {
      message: (fallbackMessage as MessageDocument) || ({} as MessageDocument),
      conversationId: String(conversation._id),
      isNewConversation: false,
      messageWasNew: false,
      processedAs: "reaction",
      reopenedConversation,
      userId: String(customerUser._id),
      chatId: String(chat._id),
    };
  }

  // messageText already extracted above for bot detection
  // Re-extract if needed for media messages
  if (!messageText) {
    messageText = "";
  }
  let imageUrl: string | undefined;
  let mediaFileSize: number | undefined;
  let whatsappMediaId: string | undefined =
    getWhatsAppMessageMediaId(messageData);
  const providerMediaErrorText = getWhatsAppProviderMediaErrorText(
    messageData.errors,
  );

  if (providerMediaErrorText) {
    messageText = providerMediaErrorText;
  } else if (messageData.type === "unsupported") {
    if (messageData.video && "id" in messageData.video) {
      whatsappMediaId = messageData.video.id;
      if (deferMediaHydration) {
        imageUrl = buildWhatsAppMediaProxyUrl(
          String(conversation._id),
          messageData.video.id,
        );
        messageText = messageData.video.caption || "[Round video]";
      } else {
        try {
          const { handleWhatsAppMedia } = await import("@/lib/media/handler");
          const mediaResult = await handleWhatsAppMedia(
            messageData.video.id,
            requireWhatsAppMediaAccessToken(accessToken),
            workspaceId,
            String(conversation._id),
            messageData.id,
            "video",
            {
              mimeType: messageData.video.mime_type,
              filename: undefined,
            },
          );

          imageUrl = mediaResult.publicUrl;
          mediaFileSize = mediaResult.size || undefined;
          messageText = messageData.video.caption || "[Round video]";
        } catch (error) {
          reportWhatsAppInboundMediaFailure({
            error,
            workspaceId,
            conversationId: String(conversation._id),
            whatsappMessageId: messageData.id,
            whatsappMediaId,
            mediaType: "video",
          });
          messageText = "[Round video - upload failed]";
        }
      }
    }
  } else if (messageData.type === "interactive") {
    if (!messageText) {
      messageText = getWhatsAppInboundMessageText(messageData);
    }
  } else if (messageData.type === "button") {
    if (!messageText) {
      messageText = getWhatsAppInboundMessageText(messageData);
    }
  } else if (
    messageData.type === "location" ||
    messageData.type === "contacts"
  ) {
    // Location / contacts carry no media to download. Keep the synthetic
    // text from getWhatsAppInboundMessageText so agents see a meaningful
    // preview in the conversation list and thread view.
    if (!messageText) {
      messageText = getWhatsAppInboundMessageText(messageData);
    }
  } else if (messageData.type !== "text") {
    for (const mediaType of WHATSAPP_WEBHOOK_MEDIA_MESSAGE_TYPES) {
      const mediaData = messageData[mediaType];
      if (mediaData && "id" in mediaData) {
        whatsappMediaId = mediaData.id;
        const filename =
          "filename" in mediaData ? mediaData.filename : undefined;

        if (deferMediaHydration) {
          imageUrl = buildWhatsAppMediaProxyUrl(
            String(conversation._id),
            mediaData.id,
            filename,
          );
          messageText =
            ("caption" in mediaData ? mediaData.caption : "") ||
            `[${mediaType} attachment]`;
          break;
        }

        try {
          const { handleWhatsAppMedia } = await import("@/lib/media/handler");
          const mediaResult = await handleWhatsAppMedia(
            mediaData.id,
            requireWhatsAppMediaAccessToken(accessToken),
            workspaceId,
            String(conversation._id),
            messageData.id,
            mediaType,
            {
              mimeType: mediaData.mime_type,
              filename,
            },
          );

          imageUrl = mediaResult.publicUrl;
          mediaFileSize = mediaResult.size || undefined;
          messageText =
            ("caption" in mediaData ? mediaData.caption : "") ||
            `[${mediaType} attachment]`;
        } catch (error) {
          reportWhatsAppInboundMediaFailure({
            error,
            workspaceId,
            conversationId: String(conversation._id),
            whatsappMessageId: messageData.id,
            whatsappMediaId,
            mediaType,
          });
          messageText = `[${mediaType} - upload failed]`;
        }
        break;
      }
    }
  } else if (messageData.type === "text" && !messageText) {
    // Only set if not already set (for outbound messages we already extracted it)
    messageText = messageData.text?.body || "";
  }

  const normalizedMessageId = normalizeWhatsAppMessageId(messageData.id);
  const whatsappFlowReply =
    normalizedWhatsAppFlowReply !== undefined
      ? normalizedWhatsAppFlowReply
      : normalizeWhatsAppFlowReply(messageData);

  const whatsappLocationPayload =
    messageData.type === "location" && messageData.location
      ? {
          latitude:
            typeof messageData.location.latitude === "number"
              ? messageData.location.latitude
              : null,
          longitude:
            typeof messageData.location.longitude === "number"
              ? messageData.location.longitude
              : null,
          name: messageData.location.name || null,
          address: messageData.location.address || null,
          url: messageData.location.url || null,
        }
      : null;

  const whatsappContactsPayload =
    messageData.type === "contacts" &&
    Array.isArray(messageData.contacts) &&
    messageData.contacts.length > 0
      ? messageData.contacts
      : null;
  const whatsappProductInquiryPayload =
    normalizeWhatsAppProductInquiry(messageData);
  const whatsappOrderPayload = normalizeWhatsAppOrder(messageData);
  const whatsappStoredMeta = await resolveWhatsAppStoredMessageMeta({
    conversationId: conversation._id,
    context: messageData.context,
  });
  const outboundAuthorId =
    direction === "outbound" && messageAuthor?._id
      ? String(messageAuthor._id)
      : "";
  const isHumanOutboundAuthor =
    direction === "outbound" &&
    outboundAuthorId !== "" &&
    outboundAuthorId !== "0" &&
    messageAuthor?.isBot === false;

  const newMessage = new Message({
    messageId: normalizedMessageId,
    whatsappWamidFingerprint:
      extractWhatsAppWamidFingerprint(normalizedMessageId) || undefined,
    chat: chat._id,
    author: messageAuthor._id,
    rawSourcePayload:
      rawSourcePayload ||
      buildRawSourcePayload({
        provider: "whatsapp",
        eventType: "message",
        capturedAt: messageDate,
        payload: messageData,
      }),
    text: messageText,
    imageUrl,
    ...(whatsappMediaId ? { whatsappMediaId } : {}),
    date: messageDate,
    workspaceId: workspaceId,
    conversation: conversation._id,
    channel: "whatsapp",
    direction: direction,
    ...(direction === "outbound" && {
      origin: {
        kind: isHumanOutboundAuthor ? "manager" : "system",
        sourceId,
        ...(isHumanOutboundAuthor ? { sentByUserId: outboundAuthorId } : {}),
      },
    }),
    ...(whatsappFlowReply ? { whatsappFlowReply } : {}),
    ...(whatsappLocationPayload
      ? { whatsappLocation: whatsappLocationPayload }
      : {}),
    ...(whatsappContactsPayload
      ? { whatsappContacts: whatsappContactsPayload }
      : {}),
    ...(whatsappProductInquiryPayload
      ? { whatsappProductInquiry: whatsappProductInquiryPayload }
      : {}),
    ...(whatsappOrderPayload ? { whatsappOrder: whatsappOrderPayload } : {}),
    ...(whatsappStoredMeta ? { whatsappMeta: whatsappStoredMeta } : {}),
    ...(normalizedReferral ? { whatsappReferral: normalizedReferral } : {}),
    ...(whatsappGroupMeta
      ? {
          whatsappGroup: {
            ...whatsappGroupMeta,
            senderParentUserId: contactData.parentUserId || null,
            senderUserId: contactData.userId || null,
            senderUsername: contactData.profile.username || null,
            senderWaId: contactData.waId || null,
          },
        }
      : {}),
    ...(messageRagContext ? { ragContext: messageRagContext } : {}),
    ...(isWhatsAppMediaType(messageData.type) && {
      mediaType: messageData.type,
      mimeType: messageData[messageData.type]?.mime_type,
      fileName:
        messageData.type === "document" && messageData.document?.filename
          ? messageData.document.filename
          : undefined,
      fileSize: mediaFileSize,
    }),
    ...(messageData.type === "unsupported" &&
      messageData.video && {
        mediaType: "video" as const,
        mimeType: messageData.video.mime_type,
        fileName: undefined,
        fileSize: mediaFileSize,
      }),
  }) as MessageDocument;

  let savedMessage: MessageDocument;
  let messageWasNew = true;

  try {
    // Commit the source-scoped customer webhook intent with the message save.
    newMessage.$locals.customerWebhookSourceId = sourceId;
    await newMessage.save();
    savedMessage = newMessage as MessageDocument;
    logTiming("message_save");
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) {
      throw error;
    }
    const existingMessageQuery = Message.findOne({
      workspaceId,
      channel: "whatsapp",
      messageId: { $in: listWhatsAppMessageIdLookupKeys(messageData.id) },
    }).populate({ path: "author", select: "isBot firstName" });
    const existingMessage =
      direction === "inbound"
        ? await existingMessageQuery.lean()
        : await existingMessageQuery;

    if (!existingMessage) {
      throw error;
    }

    // Concurrent deliveries can choose/create different conversations before
    // the unique message insert decides the winner. The persisted message owns
    // the retry, even when the webhook supplied no explicit conversation ID.
    const storedConversationId = String(existingMessage.conversation || "");
    if (!storedConversationId) {
      throw new Error(
        "WhatsApp duplicate message conversation ownership mismatch",
      );
    }
    if (storedConversationId !== String(conversation._id)) {
      const storedConversation = await Conversation.findById(
        existingMessage.conversation,
      );
      if (
        !storedConversation ||
        String(storedConversation.workspaceId) !== workspaceId
      ) {
        throw new Error(
          "WhatsApp duplicate message conversation ownership mismatch",
        );
      }
      const storedChatId = storedConversation.chat || existingMessage.chat;
      if (storedChatId && String(storedChatId) !== String(chat._id)) {
        const storedChat = await Chat.findById(storedChatId);
        if (!storedChat || String(storedChat.workspaceId) !== workspaceId) {
          throw new Error("WhatsApp duplicate message chat ownership mismatch");
        }
        chat = storedChat;
      }
      conversation = storedConversation;
      isNewConversation = false;
      reopenedConversation = false;

      // Recovery content must use the same owner as linking and Airi ingress.
      newMessage.conversation = conversation._id;
      newMessage.chat = chat._id;
      newMessage.whatsappMeta = await resolveWhatsAppStoredMessageMeta({
        conversationId: conversation._id,
        context: messageData.context,
      });
      if (deferMediaHydration && whatsappMediaId && newMessage.imageUrl) {
        newMessage.imageUrl = buildWhatsAppMediaProxyUrl(
          storedConversationId,
          whatsappMediaId,
          newMessage.fileName,
        );
      }
      if (normalizedReferral) {
        conversation = await persistWhatsAppConversationReferral(
          conversation,
          normalizedReferral,
          messageDate,
        );
      }
    }

    // If existing message has correct author (manager with isBot: false), preserve it
    // Otherwise, check if we should update to manager author
    if (direction === "outbound") {
      const existingAuthor = existingMessage.author as {
        isBot?: boolean;
        _id?: unknown;
      } | null;

      if (messageAuthor && !messageAuthor.isBot) {
        // Use the author we detected earlier
        if (!existingAuthor || existingAuthor.isBot) {
          existingMessage.author = messageAuthor._id;
          existingMessage.origin = {
            ...(existingMessage.origin || {}),
            kind: "manager",
            sourceId,
            sentByUserId: String(messageAuthor._id),
          };
          await existingMessage.save();
        }
      }
    }

    savedMessage =
      direction === "inbound"
        ? await persistRecoveredWhatsAppMessage(
            existingMessage as MessageDocument,
            newMessage,
          )
        : (existingMessage as MessageDocument);
    messageWasNew = false;
    logTiming("message_duplicate");
  }

  const conversationSet: Record<string, unknown> = {
    workspaceId,
    ...(whatsappGroupMeta ? { whatsappGroup: whatsappGroupMeta } : {}),
  };
  await persistWhatsAppMessageConversationLink(
    {
      workspaceId,
      messageId: normalizedMessageId,
      messageObjectId: savedMessage._id,
      eventAt: messageDate,
      conversationId: conversation._id,
      direction,
      conversationSet,
      importMode: params.importMode,
    },
    whatsAppMessageConversationLinkDependencies,
  );
  logTiming("pending_mutations_and_conversation_append");

  // Repairing an imported existing message is not a fresh customer action.
  const isHistoryRecovery = Boolean(
    isHistoryImport ||
      (existingStoredMessage && rawSourcePayload?.eventType === "history_message"),
  );

  if (
    !isHistoryRecovery &&
    direction === "inbound" &&
    /\nAIRI-CART:[a-f0-9]{48}$/.test(messageText)
  ) {
    if (!params.claimWebsiteCart)
      throw new Error("Cart handoff host unavailable");
    await params.claimWebsiteCart({
      workspaceId,
      sourceId,
      conversationId: String(conversation._id),
      text: messageText,
      messageId: String(savedMessage._id),
      occurredAt: messageDate,
    });
  }

  // CSAT is optional enrichment; it must not acknowledge a failed append.
  try {
    if (
      !isHistoryRecovery &&
      direction === "inbound" &&
      conversation.awaiting_csat
    ) {
      const csatRating = parseCsatRating(messageText);
      if (csatRating) {
        await Conversation.updateOne(
          { _id: conversation._id },
          {
            $set: {
              customer_satisfaction_score: csatRating,
              status: "closed",
              awaiting_csat: false,
              ...customerCsatResolutionFields(),
            },
          },
        );
        console.log(
          `[WhatsApp Message Processor] CSAT recorded: ${csatRating} for conversation ${conversation._id}`,
        );
      }
    }
  } catch (error) {
    console.error(
      "[WhatsApp Message Processor] Error recording optional CSAT:",
      {
        conversationId: String(conversation._id),
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }

  return {
    message: savedMessage,
    conversationId: String(conversation._id),
    isNewConversation: messageWasNew && isNewConversation,
    messageWasNew,
    messageRecoveryRevision: savedMessage.whatsappRecoveryRevision,
    reopenedConversation,
    userId: String(customerUser._id),
    chatId: String(chat._id),
    conversation,
    chat,
    mediaAnalysisType: resolveConversationMediaAnalysisType(
      savedMessage.mediaType,
    ),
  };
}
