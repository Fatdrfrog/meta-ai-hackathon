import mongoose, { Schema, type Document, type Model } from "mongoose";

export type OtpTemplateBindingChannel = "whatsapp";
export type OtpTemplateBindingMode = "copy_code";

export interface OtpTemplateBindingDocument extends Document {
  workspaceId: string;
  channel: OtpTemplateBindingChannel;
  purpose: string;
  templateId: string;
  templateName: string;
  languageCode: string;
  sourceId?: string | null;
  phoneNumberId?: string | null;
  mode: OtpTemplateBindingMode;
  ttlSeconds: number;
  maxAttempts: number;
  enabled: boolean;
  createdByUserId: string;
  updatedByUserId?: string | null;
  lastValidatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const OtpTemplateBindingSchema = new Schema<OtpTemplateBindingDocument>(
  {
    workspaceId: { type: String, required: true, index: true },
    channel: {
      type: String,
      enum: ["whatsapp"],
      required: true,
      default: "whatsapp",
      index: true,
    },
    purpose: { type: String, required: true, index: true },
    templateId: { type: String, required: true },
    templateName: { type: String, required: true },
    languageCode: { type: String, required: true },
    sourceId: { type: String, default: null },
    phoneNumberId: { type: String, default: null },
    mode: {
      type: String,
      enum: ["copy_code"],
      required: true,
      default: "copy_code",
    },
    ttlSeconds: { type: Number, required: true, default: 300 },
    maxAttempts: { type: Number, required: true, default: 5 },
    enabled: { type: Boolean, required: true, default: true, index: true },
    createdByUserId: { type: String, required: true },
    updatedByUserId: { type: String, default: null },
    lastValidatedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true }
);

OtpTemplateBindingSchema.index(
  { workspaceId: 1, channel: 1, purpose: 1 },
  { unique: true }
);
OtpTemplateBindingSchema.index({
  workspaceId: 1,
  enabled: 1,
  channel: 1,
});

export const OtpTemplateBindingModel =
  (mongoose.models.OtpTemplateBinding as
    | Model<OtpTemplateBindingDocument>
    | undefined) ||
  mongoose.model<OtpTemplateBindingDocument>(
    "OtpTemplateBinding",
    OtpTemplateBindingSchema
  );
