import mongoose, { type Model } from "mongoose";

export const WHATSAPP_CALL_COMMAND_ACTIONS = [
  "pre_accept",
  "accept",
  "reject",
  "terminate",
] as const;

export const WHATSAPP_CALL_COMMAND_STATUSES = [
  "pending",
  "sent",
  "failed",
] as const;

export type WhatsAppCallCommandAction =
  (typeof WHATSAPP_CALL_COMMAND_ACTIONS)[number];

export type WhatsAppCallCommandStatus =
  (typeof WHATSAPP_CALL_COMMAND_STATUSES)[number];

export type WhatsAppCallCommandDocument = mongoose.Document & {
  workspaceId: string;
  sourceId: string | null;
  callSessionId: mongoose.Types.ObjectId | string;
  callId: string;
  action: WhatsAppCallCommandAction;
  status: WhatsAppCallCommandStatus;
  requestedBy: string | null;
  correlationId: string;
};

const WhatsAppCallCommandSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true, index: true },
    sourceId: { type: String, default: null, index: true },
    callSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WhatsAppCallSession",
      required: true,
      index: true,
    },
    callId: { type: String, required: true, index: true },
    action: {
      type: String,
      enum: WHATSAPP_CALL_COMMAND_ACTIONS,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: WHATSAPP_CALL_COMMAND_STATUSES,
      default: "pending",
      required: true,
      index: true,
    },
    requestedBy: { type: String, default: null, index: true },
    correlationId: { type: String, required: true, index: true },
    request: { type: mongoose.Schema.Types.Mixed, default: null },
    providerResponse: { type: mongoose.Schema.Types.Mixed, default: null },
    providerError: { type: mongoose.Schema.Types.Mixed, default: null },
    sentAt: { type: Date, default: null, index: true },
    failedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

WhatsAppCallCommandSchema.index(
  { workspaceId: 1, correlationId: 1 },
  { unique: true, name: "whatsapp_call_command_correlation" }
);
WhatsAppCallCommandSchema.index({
  workspaceId: 1,
  callSessionId: 1,
  createdAt: -1,
});
WhatsAppCallCommandSchema.index({
  workspaceId: 1,
  callId: 1,
  createdAt: -1,
});

const WhatsAppCallCommand =
  (mongoose.models.WhatsAppCallCommand as
    | Model<WhatsAppCallCommandDocument>
    | undefined) ||
  mongoose.model<WhatsAppCallCommandDocument>(
    "WhatsAppCallCommand",
    WhatsAppCallCommandSchema
  );

export default WhatsAppCallCommand;
