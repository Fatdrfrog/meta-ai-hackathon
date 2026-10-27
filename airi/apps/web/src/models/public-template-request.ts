import mongoose, { type Model } from "mongoose";

export type PublicTemplateRequestRecord = {
  _id: string;
  payloadDigest: string;
  workspaceId: string;
  sourceId: string;
  templateId: string;
  metaTemplateId: string;
  templateName: string;
  language: string;
  locale: "en" | "ru" | "kz";
  name: string;
  email: string;
  phone: string;
  source: "landing" | "marketplace";
  consentVersion: string;
  consentedAt: Date;
  marketingConsent?: boolean;
  state: "reserved" | "dispatching" | "accepted" | "failed" | "unknown";
  dispatchedAt?: Date;
  acceptedAt?: Date;
  providerMessageId?: string;
  createdAt: Date;
  updatedAt: Date;
};

const PublicTemplateRequestSchema =
  new mongoose.Schema<PublicTemplateRequestRecord>(
    {
      // The built-in _id unique index fences concurrent requests without index setup.
      _id: { type: String, required: true, immutable: true },
      payloadDigest: { type: String, required: true, immutable: true },
      workspaceId: { type: String, required: true, immutable: true },
      sourceId: { type: String, required: true, immutable: true },
      templateId: { type: String, required: true, immutable: true },
      metaTemplateId: { type: String, required: true, immutable: true },
      templateName: { type: String, required: true, immutable: true },
      language: { type: String, required: true, immutable: true },
      locale: {
        type: String,
        enum: ["en", "ru", "kz"],
        required: true,
        immutable: true,
      },
      name: { type: String, required: true, immutable: true },
      email: { type: String, required: true, immutable: true },
      phone: { type: String, required: true, immutable: true },
      source: {
        type: String,
        enum: ["landing", "marketplace"],
        required: true,
        immutable: true,
      },
      consentVersion: { type: String, required: true, immutable: true },
      consentedAt: { type: Date, required: true, immutable: true },
      // Historical consent evidence, not the current subscription status.
      // No default: earlier demo-only records must remain without this grant.
      marketingConsent: { type: Boolean, immutable: true },
      state: {
        type: String,
        enum: ["reserved", "dispatching", "accepted", "failed", "unknown"],
        required: true,
      },
      dispatchedAt: { type: Date },
      acceptedAt: { type: Date },
      providerMessageId: { type: String },
    },
    { timestamps: true, collection: "public_template_requests" }
  );

// Retention must never erase the dispatch fence and allow an ambiguous retry.
// Apply a reviewed PII retention policy separately from the immutable operation ID.
export default (mongoose.models.PublicTemplateRequest as
  | Model<PublicTemplateRequestRecord>
  | undefined) ||
  mongoose.model<PublicTemplateRequestRecord>(
    "PublicTemplateRequest",
    PublicTemplateRequestSchema
  );
