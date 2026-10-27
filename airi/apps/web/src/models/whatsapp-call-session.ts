import mongoose, { type Model } from "mongoose";

export const WHATSAPP_CALL_SESSION_STATES = [
  "unknown",
  "incoming",
  "pre_accepted",
  "accepted",
  "ringing",
  "active",
  "terminated",
  "missed",
  "failed",
] as const;

export type WhatsAppCallSessionState =
  (typeof WHATSAPP_CALL_SESSION_STATES)[number];

export type WhatsAppCallSessionDocument = mongoose.Document & {
  workspaceId: string;
  sourceId: string | null;
  callId: string;
  conversationId?: mongoose.Types.ObjectId | string | null;
  customerId?: mongoose.Types.ObjectId | string | null;
  state: WhatsAppCallSessionState;
  phoneNumberId?: string | null;
  sessionSdpType?: string | null;
  sessionSdp?: string | null;
};

const WhatsAppCallSessionSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true, index: true },
    sourceId: { type: String, default: null, index: true },
    callId: { type: String, required: true, index: true },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      default: null,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
      index: true,
    },
    state: {
      type: String,
      enum: WHATSAPP_CALL_SESSION_STATES,
      default: "unknown",
      required: true,
      index: true,
    },
    latestEvent: { type: String, default: null, index: true },
    latestStatus: { type: String, default: null, index: true },
    direction: { type: String, default: null, index: true },
    from: { type: String, default: null, index: true },
    to: { type: String, default: null, index: true },
    fromUserId: { type: String, default: null, index: true },
    fromParentUserId: { type: String, default: null, index: true },
    toUserId: { type: String, default: null, index: true },
    toParentUserId: { type: String, default: null, index: true },
    recipientId: { type: String, default: null, index: true },
    recipientUserId: { type: String, default: null, index: true },
    recipientParentUserId: { type: String, default: null, index: true },
    contactUserId: { type: String, default: null, index: true },
    contactParentUserId: { type: String, default: null, index: true },
    contactWaId: { type: String, default: null, index: true },
    contactName: { type: String, default: null },
    contactUsername: { type: String, default: null },
    countryCode: { type: String, default: null },
    wabaId: { type: String, default: null, index: true },
    phoneNumberId: { type: String, default: null, index: true },
    bizOpaqueCallbackData: { type: String, default: null, index: true },
    sessionSdpType: { type: String, default: null },
    sessionSdp: { type: String, default: null },
    durationSeconds: { type: Number, default: null },
    errorCode: { type: Number, default: null, index: true },
    errorMessage: { type: String, default: null },
    firstSeenAt: { type: Date, default: null, index: true },
    answeredAt: { type: Date, default: null, index: true },
    endedAt: { type: Date, default: null, index: true },
    lastProviderUpdateAt: { type: Date, default: null, index: true },
    latestRawEvent: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

WhatsAppCallSessionSchema.index(
  { workspaceId: 1, sourceId: 1, callId: 1 },
  { unique: true, name: "whatsapp_call_session_identity" }
);
WhatsAppCallSessionSchema.index({
  workspaceId: 1,
  sourceId: 1,
  state: 1,
  updatedAt: -1,
});
WhatsAppCallSessionSchema.index({
  workspaceId: 1,
  contactUserId: 1,
  updatedAt: -1,
});
WhatsAppCallSessionSchema.index({
  workspaceId: 1,
  conversationId: 1,
  updatedAt: -1,
});

const WhatsAppCallSession =
  (mongoose.models.WhatsAppCallSession as
    | Model<WhatsAppCallSessionDocument>
    | undefined) ||
  mongoose.model<WhatsAppCallSessionDocument>(
    "WhatsAppCallSession",
    WhatsAppCallSessionSchema
  );

export default WhatsAppCallSession;
