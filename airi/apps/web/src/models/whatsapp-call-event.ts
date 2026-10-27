import mongoose from "mongoose";

const WhatsAppCallEventSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true, index: true },
    sourceId: { type: String, default: null, index: true },
    wabaId: { type: String, default: null, index: true },
    phoneNumberId: { type: String, default: null, index: true },
    callId: { type: String, default: null, index: true },
    kind: {
      type: String,
      enum: ["call", "status"],
      required: true,
      index: true,
    },
    event: { type: String, default: null, index: true },
    status: { type: String, default: null, index: true },
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
    timestamp: { type: String, default: null },
    eventAt: { type: Date, default: null, index: true },
    bizOpaqueCallbackData: { type: String, default: null, index: true },
    sessionSdpType: { type: String, default: null },
    sessionSdp: { type: String, default: null },
    durationSeconds: { type: Number, default: null },
    errorCode: { type: Number, default: null, index: true },
    errorMessage: { type: String, default: null },
    rawEvent: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

WhatsAppCallEventSchema.index({
  workspaceId: 1,
  callId: 1,
  kind: 1,
  event: 1,
  status: 1,
});
WhatsAppCallEventSchema.index({
  workspaceId: 1,
  phoneNumberId: 1,
  eventAt: -1,
});
WhatsAppCallEventSchema.index({
  workspaceId: 1,
  contactUserId: 1,
  eventAt: -1,
});

const WhatsAppCallEvent =
  mongoose.models.WhatsAppCallEvent ||
  mongoose.model("WhatsAppCallEvent", WhatsAppCallEventSchema);

export default WhatsAppCallEvent;
