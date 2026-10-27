import mongoose from "mongoose";
import { WHATSAPP_DELIVERY_EVENT_STATUSES } from "@icecore/shared/types/whatsapp-delivery";

export const MESSAGE_DELIVERY_STATUSES = WHATSAPP_DELIVERY_EVENT_STATUSES;

const MessageDeliveryEventSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true, index: true },
    customerWebhookIntent: { type: mongoose.Schema.Types.Mixed, select: false },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      default: null,
      index: true,
    },
    messageObjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null,
      index: true,
    },
    messageId: { type: String, required: true, index: true },
    channel: {
      type: String,
      enum: ["whatsapp"],
      default: "whatsapp",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: MESSAGE_DELIVERY_STATUSES,
      required: true,
      index: true,
    },
    eventAt: { type: Date, required: true, index: true },
    recipientId: { type: String, default: null, index: true },
    recipientWaId: { type: String, default: null, index: true },
    recipientUserId: { type: String, default: null, index: true },
    recipientParentUserId: { type: String, default: null, index: true },
    recipientUsername: { type: String, default: null },
    recipientType: { type: String, default: null, index: true },
    recipientParticipantId: { type: String, default: null, index: true },
    campaignId: { type: String, default: null, index: true },
    phoneNumberId: { type: String, default: null, index: true },
    sourceId: { type: String, default: null, index: true },
    pricing: { type: mongoose.Schema.Types.Mixed, default: null },
    conversation: { type: mongoose.Schema.Types.Mixed, default: null },
    errors: { type: mongoose.Schema.Types.Mixed, default: null },
    rawStatus: { type: mongoose.Schema.Types.Mixed, default: null },
    providerStatus: { type: String, default: null, index: true },
    // Structured, indexable copies of what Meta sends in `pricing` and
    // `conversation` so downstream insights/billing queries don't need to
    // parse `rawStatus` at read time.
    pricingBillable: { type: Boolean, default: null },
    pricingCategory: { type: String, default: null, index: true },
    pricingType: { type: String, default: null, index: true },
    pricingModel: { type: String, default: null },
    conversationCategory: { type: String, default: null, index: true },
    conversationProviderId: { type: String, default: null },
    conversationExpiresAt: { type: Date, default: null },
    bizOpaqueCallbackData: { type: String, default: null, index: true },
    recipientIdentityKeyHash: { type: String, default: null },
    errorCode: { type: Number, default: null, index: true },
    errorMessage: { type: String, default: null },
  },
  { timestamps: true, suppressReservedKeysWarning: true }
);

MessageDeliveryEventSchema.index({
  workspaceId: 1,
  messageId: 1,
  status: 1,
  eventAt: 1,
});
MessageDeliveryEventSchema.index(
  { "customerWebhookIntent.timestamp": 1, _id: 1 },
  {
    name: "message_delivery_customer_webhook_pending_v1",
    partialFilterExpression: { customerWebhookIntent: { $exists: true } },
  }
);
function stripPrivateWebhookIntent(
  _document: unknown,
  result: Record<string, unknown>
) {
  delete result.customerWebhookIntent;
  return result;
}
MessageDeliveryEventSchema.set("toJSON", {
  transform: stripPrivateWebhookIntent,
});
MessageDeliveryEventSchema.set("toObject", {
  transform: stripPrivateWebhookIntent,
});
MessageDeliveryEventSchema.index({
  workspaceId: 1,
  conversationId: 1,
  eventAt: -1,
});
MessageDeliveryEventSchema.index({
  workspaceId: 1,
  campaignId: 1,
  eventAt: -1,
});

const MessageDeliveryEvent =
  mongoose.models.MessageDeliveryEvent ||
  mongoose.model("MessageDeliveryEvent", MessageDeliveryEventSchema);

export default MessageDeliveryEvent;
