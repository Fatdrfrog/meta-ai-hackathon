import mongoose, { Schema, type Document, type Model } from "mongoose";

export type OtpChallengeStatus =
  | "pending"
  | "verified"
  | "expired"
  | "failed"
  | "cancelled";

export const ACTIVE_IDEMPOTENT_OTP_STATUSES = [
  "pending",
  "verified",
] as const satisfies readonly OtpChallengeStatus[];

export const REUSABLE_TERMINAL_OTP_STATUSES = [
  "expired",
  "failed",
  "cancelled",
] as const satisfies readonly OtpChallengeStatus[];

export type OtpDeliveryStatus =
  | "queued"
  | "sending"
  | "retrying"
  | "sent"
  | "failed";

export interface OtpChallengeDocument extends Document {
  workspaceId: string;
  channel: "whatsapp";
  recipientPhone: string;
  purpose: string;
  templateBindingId?: mongoose.Types.ObjectId | null;
  templateId?: string | null;
  templateName: string;
  languageCode: string;
  sourceId?: string | null;
  phoneNumberId?: string | null;
  codeHash: string;
  encryptedCode?: Record<string, string> | null;
  expiresAt: Date;
  maxAttempts: number;
  attempts: number;
  status: OtpChallengeStatus;
  deliveryStatus: OtpDeliveryStatus;
  deliveryAttempts: number;
  deliveryQueuedAt?: Date | null;
  deliveryLastAttemptAt?: Date | null;
  deliverySentAt?: Date | null;
  deliveryLeaseId?: string | null;
  deliveryLeaseExpiresAt?: Date | null;
  providerMessageId?: string | null;
  correlationId: string;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
  lastError?: string | null;
  verifiedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const OtpChallengeSchema = new Schema<OtpChallengeDocument>(
  {
    workspaceId: { type: String, required: true, index: true },
    channel: { type: String, enum: ["whatsapp"], required: true },
    recipientPhone: { type: String, required: true, index: true },
    purpose: { type: String, required: true, default: "login", index: true },
    templateBindingId: {
      type: Schema.Types.ObjectId,
      ref: "OtpTemplateBinding",
      default: null,
      index: true,
    },
    templateId: { type: String, default: null },
    templateName: { type: String, required: true },
    languageCode: { type: String, required: true, default: "en_US" },
    sourceId: { type: String, default: null, index: true },
    phoneNumberId: { type: String, default: null },
    codeHash: { type: String, required: true },
    encryptedCode: { type: Schema.Types.Mixed, default: null },
    expiresAt: { type: Date, required: true },
    maxAttempts: { type: Number, required: true, default: 5 },
    attempts: { type: Number, required: true, default: 0 },
    status: {
      type: String,
      enum: ["pending", "verified", "expired", "failed", "cancelled"],
      required: true,
      default: "pending",
      index: true,
    },
    deliveryStatus: {
      type: String,
      enum: ["queued", "sending", "retrying", "sent", "failed"],
      required: true,
      default: "queued",
      index: true,
    },
    deliveryAttempts: { type: Number, required: true, default: 0 },
    deliveryQueuedAt: { type: Date, default: null },
    deliveryLastAttemptAt: { type: Date, default: null },
    deliverySentAt: { type: Date, default: null },
    deliveryLeaseId: { type: String, default: null, index: true },
    deliveryLeaseExpiresAt: { type: Date, default: null, index: true },
    providerMessageId: { type: String, default: null },
    correlationId: { type: String, required: true, index: true },
    idempotencyKey: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: undefined },
    lastError: { type: String, default: null },
    verifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

OtpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
OtpChallengeSchema.index({
  workspaceId: 1,
  recipientPhone: 1,
  purpose: 1,
  status: 1,
  createdAt: -1,
});
OtpChallengeSchema.index(
  {
    workspaceId: 1,
    channel: 1,
    purpose: 1,
    recipientPhone: 1,
    idempotencyKey: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      idempotencyKey: { $type: "string" },
      status: { $in: [...ACTIVE_IDEMPOTENT_OTP_STATUSES] },
    },
  }
);
OtpChallengeSchema.index({
  deliveryStatus: 1,
  deliveryLeaseExpiresAt: 1,
  expiresAt: 1,
});

export const OtpChallengeModel =
  (mongoose.models.OtpChallenge as Model<OtpChallengeDocument> | undefined) ||
  mongoose.model<OtpChallengeDocument>("OtpChallenge", OtpChallengeSchema);
