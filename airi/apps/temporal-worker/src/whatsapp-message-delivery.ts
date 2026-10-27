import { normalizeWhatsAppMessageId } from "@icecore/shared/lib/whatsapp/message-id";
import type {
  WhatsAppStatusConversation,
  WhatsAppStatusPricing,
} from "@icecore/shared/lib/whatsapp/webhook-payload";
import {
  normalizeWhatsAppDeliveryStatus,
  shouldAdvanceWhatsAppDeliveryStatus,
  type WhatsAppDeliveryEventStatus,
  type WhatsAppDeliveryStatus,
} from "@icecore/shared/types/whatsapp-delivery";
import { isRecord, readDate } from "@icecore/shared/lib/value-utils";

type DeliveryErrorLike = {
  code?: number;
  message?: string;
  title?: string;
};

export interface StructuredStatusFields {
  pricingBillable: boolean | null;
  pricingCategory: string | null;
  pricingType: string | null;
  pricingModel: string | null;
  conversationCategory: string | null;
  conversationProviderId: string | null;
  conversationExpiresAt: Date | null;
}

function toOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function extractStructuredStatusFields(params: {
  pricing?: unknown;
  conversation?: unknown;
}): StructuredStatusFields {
  const pricing: WhatsAppStatusPricing | null = isRecord(params.pricing)
    ? (params.pricing as WhatsAppStatusPricing)
    : null;
  const conversation: WhatsAppStatusConversation | null = isRecord(
    params.conversation,
  )
    ? (params.conversation as WhatsAppStatusConversation)
    : null;

  let expiresAt: Date | null = null;
  if (conversation?.expiration_timestamp) {
    const rawTs =
      typeof conversation.expiration_timestamp === "number"
        ? conversation.expiration_timestamp
        : Number.parseInt(String(conversation.expiration_timestamp), 10);
    if (Number.isFinite(rawTs) && rawTs > 0) {
      expiresAt = new Date(rawTs * 1000);
    }
  }

  return {
    pricingBillable:
      typeof pricing?.billable === "boolean" ? pricing.billable : null,
    pricingCategory: toOptionalString(pricing?.category),
    pricingType: toOptionalString(pricing?.type),
    pricingModel: toOptionalString(pricing?.pricing_model),
    conversationCategory: toOptionalString(conversation?.origin?.type),
    conversationProviderId: toOptionalString(conversation?.id),
    conversationExpiresAt: expiresAt,
  };
}

export type StoredDeliveryState = {
  status?: WhatsAppDeliveryStatus | null;
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
  recipientType?: string | null;
  recipientParticipantId?: string | null;
  recipientIdentityKeyHash?: string | null;
  errorCode?: number | null;
  errorMessage?: string | null;
  pricingCategory?: string | null;
  pricingType?: string | null;
  pricingModel?: string | null;
  conversationCategory?: string | null;
};

export type DeliveryRealtimeState = StoredDeliveryState & {
  status?: WhatsAppDeliveryStatus | null;
};

export type LeanMessageForDelivery = {
  _id: string;
  conversationId: string | null;
  chatId?: string | null;
  delivery?: StoredDeliveryState | null;
};

export type DeliveryEventUpsertParams = {
  workspaceId: string;
  messageId: string;
  channel: "whatsapp";
  status: WhatsAppDeliveryEventStatus;
  eventAt: Date;
  recipientId: string | null;
  recipientWaId: string | null;
  recipientUserId: string | null;
  recipientParentUserId: string | null;
  recipientUsername: string | null;
  recipientType: string | null;
  recipientParticipantId: string | null;
  campaignId: string | null;
  phoneNumberId: string | null;
  sourceId: string | null;
  conversationId: string | null;
  messageObjectId: string | null;
  pricing: unknown;
  conversation: unknown;
  errors: DeliveryErrorLike[] | null;
  rawStatus: unknown;
  providerStatus: string | null;
  structured: StructuredStatusFields;
  bizOpaqueCallbackData: string | null;
  recipientIdentityKeyHash: string | null;
  errorCode: number | null;
  errorMessage: string | null;
};

export type RecordWhatsAppMessageDeliveryStatusDependencies = {
  connectDB: () => Promise<unknown>;
  findMessageByWhatsAppMessageId: (params: {
    workspaceId: string;
    messageId: string;
    normalizedMessageId: string;
  }) => Promise<LeanMessageForDelivery | null>;
  refreshConversationEngagement?: (params: {
    conversationId: string;
    workspaceId: string;
    messageObjectId: string;
  }) => Promise<unknown> | unknown;
  updateMessageDelivery: (params: {
    messageObjectId: string;
    expectedStatus?: WhatsAppDeliveryStatus | null;
    expectedLastEventAt?: Date | string | null;
    update: Record<string, unknown>;
  }) => Promise<boolean>;
  upsertDeliveryEvent: (params: DeliveryEventUpsertParams) => Promise<unknown>;
};

export function shouldApplyDeliveryUpdate(params: {
  current?: StoredDeliveryState | null;
  incomingStatus: WhatsAppDeliveryStatus;
  eventAt: Date;
}): boolean {
  if (
    !shouldAdvanceWhatsAppDeliveryStatus({
      currentStatus: params.current?.status,
      incomingStatus: params.incomingStatus,
    })
  ) {
    return false;
  }

  const currentStatus = params.current?.status || null;
  if (!currentStatus) return true;
  if (params.incomingStatus !== currentStatus) return true;

  const currentLastEventAt = readDate(params.current?.lastEventAt);
  return !currentLastEventAt || params.eventAt >= currentLastEventAt;
}

function firstDeliveryError(
  errors: DeliveryErrorLike[] | null | undefined,
): DeliveryErrorLike | null {
  return Array.isArray(errors) && errors.length > 0 ? errors[0] || null : null;
}

export function buildDeliverySet(params: {
  current?: StoredDeliveryState | null;
  status: WhatsAppDeliveryStatus;
  eventAt: Date;
  recipientId?: string | null;
  recipientWaId?: string | null;
  recipientUserId?: string | null;
  recipientParentUserId?: string | null;
  recipientUsername?: string | null;
  recipientType?: string | null;
  recipientParticipantId?: string | null;
  recipientIdentityKeyHash?: string | null;
  errors?: DeliveryErrorLike[] | null;
  structured?: StructuredStatusFields | null;
}): Record<string, unknown> {
  const currentLastEventAt = readDate(params.current?.lastEventAt);
  const update: Record<string, unknown> = {
    "delivery.status": params.status,
    "delivery.lastEventAt":
      currentLastEventAt && currentLastEventAt > params.eventAt
        ? currentLastEventAt
        : params.eventAt,
    "delivery.recipientId": params.recipientId || null,
    "delivery.recipientWaId": params.recipientWaId || null,
    "delivery.recipientUserId": params.recipientUserId || null,
    "delivery.recipientParentUserId": params.recipientParentUserId || null,
    "delivery.recipientUsername": params.recipientUsername || null,
    "delivery.recipientType": params.recipientType || null,
    "delivery.recipientParticipantId": params.recipientParticipantId || null,
    "delivery.recipientIdentityKeyHash":
      params.recipientIdentityKeyHash || null,
  };

  if (params.structured) {
    if (params.structured.pricingCategory !== null) {
      update["delivery.pricingCategory"] = params.structured.pricingCategory;
    }
    if (params.structured.pricingType !== null) {
      update["delivery.pricingType"] = params.structured.pricingType;
    }
    if (params.structured.pricingModel !== null) {
      update["delivery.pricingModel"] = params.structured.pricingModel;
    }
    if (params.structured.conversationCategory !== null) {
      update["delivery.conversationCategory"] =
        params.structured.conversationCategory;
    }
  }

  if (params.status === "sent") {
    update["delivery.sentAt"] = params.eventAt;
  }

  if (params.status === "delivered") {
    update["delivery.deliveredAt"] = params.eventAt;
    if (!params.current?.sentAt) {
      update["delivery.sentAt"] = params.eventAt;
    }
  }

  if (params.status === "read") {
    update["delivery.readAt"] = params.eventAt;
    if (!params.current?.deliveredAt) {
      update["delivery.deliveredAt"] = params.eventAt;
    }
    if (!params.current?.sentAt) {
      update["delivery.sentAt"] = params.eventAt;
    }
  }

  if (params.status === "played") {
    update["delivery.playedAt"] = params.eventAt;
    if (!params.current?.readAt) {
      update["delivery.readAt"] = params.eventAt;
    }
    if (!params.current?.deliveredAt) {
      update["delivery.deliveredAt"] = params.eventAt;
    }
    if (!params.current?.sentAt) {
      update["delivery.sentAt"] = params.eventAt;
    }
  }

  if (params.status === "failed") {
    const error = firstDeliveryError(params.errors);
    update["delivery.failedAt"] = params.eventAt;
    update["delivery.errorCode"] =
      typeof error?.code === "number" ? error.code : null;
    update["delivery.errorMessage"] = error?.message || error?.title || null;
  }

  return update;
}

function buildDeliveryStateFromSet(params: {
  current?: StoredDeliveryState | null;
  update: Record<string, unknown>;
}): DeliveryRealtimeState {
  const next: DeliveryRealtimeState = { ...(params.current || {}) };
  const mutableNext = next as Record<string, unknown>;
  for (const [key, value] of Object.entries(params.update)) {
    if (!key.startsWith("delivery.")) continue;
    const deliveryKey = key.slice("delivery.".length);
    mutableNext[deliveryKey] = value;
  }
  return next;
}

export function createRecordWhatsAppMessageDeliveryStatus(
  deps: RecordWhatsAppMessageDeliveryStatusDependencies,
) {
  return async function recordWhatsAppMessageDeliveryStatus(params: {
    workspaceId: string;
    messageId: string;
    status: string;
    eventAt: Date;
    recipientId?: string | null;
    recipientWaId?: string | null;
    recipientUserId?: string | null;
    recipientParentUserId?: string | null;
    recipientUsername?: string | null;
    recipientType?: string | null;
    recipientParticipantId?: string | null;
    campaignId?: string | null;
    phoneNumberId?: string | null;
    sourceId?: string | null;
    pricing?: unknown;
    conversation?: unknown;
    errors?: DeliveryErrorLike[] | null;
    rawStatus?: unknown;
    bizOpaqueCallbackData?: string | null;
    recipientIdentityKeyHash?: string | null;
  }): Promise<{
    recorded: boolean;
    status: WhatsAppDeliveryStatus | null;
    eventStatus: WhatsAppDeliveryEventStatus | null;
    messageFound: boolean;
    messageDeliveryUpdated: boolean;
    conversationId: string | null;
    messageObjectId: string | null;
    delivery: DeliveryRealtimeState | null;
    /** Chat of the stored message, so callers need not look it up again. */
    chatId?: string | null;
  }> {
    const workspaceId = params.workspaceId.trim();
    const messageId = params.messageId.trim();
    const status = normalizeWhatsAppDeliveryStatus(params.status);
    const eventStatus: WhatsAppDeliveryEventStatus = status ?? "unknown";

    if (!workspaceId || !messageId) {
      return {
        recorded: false,
        status,
        eventStatus: null,
        messageFound: false,
        messageDeliveryUpdated: false,
        conversationId: null,
        messageObjectId: null,
        delivery: null,
      };
    }

    await deps.connectDB();

    const normalizedMessageId = normalizeWhatsAppMessageId(messageId);
    const message = await deps.findMessageByWhatsAppMessageId({
      workspaceId,
      messageId,
      normalizedMessageId,
    });

    const conversationId = message?.conversationId || null;
    const structured = extractStructuredStatusFields({
      pricing: params.pricing,
      conversation: params.conversation,
    });
    const firstError = firstDeliveryError(params.errors);

    await deps.upsertDeliveryEvent({
      workspaceId,
      messageId,
      channel: "whatsapp",
      status: eventStatus,
      eventAt: params.eventAt,
      recipientId: params.recipientId || null,
      recipientWaId: params.recipientWaId || null,
      recipientUserId: params.recipientUserId || null,
      recipientParentUserId: params.recipientParentUserId || null,
      recipientUsername: params.recipientUsername || null,
      recipientType: params.recipientType || null,
      recipientParticipantId: params.recipientParticipantId || null,
      campaignId: params.campaignId || null,
      phoneNumberId: params.phoneNumberId || null,
      sourceId: params.sourceId || null,
      conversationId,
      messageObjectId: message?._id || null,
      pricing: params.pricing ?? null,
      conversation: params.conversation ?? null,
      errors: params.errors ?? null,
      rawStatus: params.rawStatus ?? null,
      providerStatus: params.status || null,
      structured,
      bizOpaqueCallbackData: params.bizOpaqueCallbackData ?? null,
      recipientIdentityKeyHash: params.recipientIdentityKeyHash ?? null,
      errorCode: typeof firstError?.code === "number" ? firstError.code : null,
      errorMessage: firstError?.message || firstError?.title || null,
    });

    let currentMessage = message;
    let delivery: DeliveryRealtimeState | null = currentMessage?.delivery
      ? { ...currentMessage.delivery }
      : null;
    let messageDeliveryUpdated = false;

    for (
      let attempt = 0;
      currentMessage && status && attempt < 3;
      attempt += 1
    ) {
      if (
        !shouldApplyDeliveryUpdate({
          current: currentMessage.delivery,
          incomingStatus: status,
          eventAt: params.eventAt,
        })
      ) {
        break;
      }

      const update = buildDeliverySet({
        current: currentMessage.delivery,
        status,
        eventAt: params.eventAt,
        recipientId: params.recipientId,
        recipientWaId: params.recipientWaId,
        recipientUserId: params.recipientUserId,
        recipientParentUserId: params.recipientParentUserId,
        recipientUsername: params.recipientUsername,
        recipientType: params.recipientType,
        recipientParticipantId: params.recipientParticipantId,
        recipientIdentityKeyHash: params.recipientIdentityKeyHash,
        errors: params.errors,
        structured,
      });
      const nextDelivery = buildDeliveryStateFromSet({
        current: currentMessage.delivery,
        update,
      });
      const applied = await deps.updateMessageDelivery({
        messageObjectId: currentMessage._id,
        expectedStatus: currentMessage.delivery?.status ?? null,
        expectedLastEventAt: currentMessage.delivery?.lastEventAt ?? null,
        update,
      });
      if (!applied) {
        currentMessage = await deps.findMessageByWhatsAppMessageId({
          workspaceId,
          messageId,
          normalizedMessageId,
        });
        delivery = currentMessage?.delivery
          ? { ...currentMessage.delivery }
          : null;
        continue;
      }

      delivery = nextDelivery;
      messageDeliveryUpdated = true;
      break;
    }

    if (conversationId && messageDeliveryUpdated) {
      await deps.refreshConversationEngagement?.({
        conversationId,
        workspaceId,
        messageObjectId: currentMessage!._id,
      });
    }

    return {
      recorded: true,
      status,
      eventStatus,
      messageFound: Boolean(message),
      messageDeliveryUpdated,
      conversationId,
      messageObjectId: message?._id || null,
      delivery,
      chatId: message?.chatId || null,
    };
  };
}
