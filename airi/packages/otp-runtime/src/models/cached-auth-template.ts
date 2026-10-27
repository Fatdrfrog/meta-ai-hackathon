import mongoose, { Schema, type Model } from "mongoose";

export type CachedAuthTemplateDocument = {
  workspaceId: string;
  templateId: string;
  name: string;
  language: string;
  status: string;
  category: string;
};

const CachedAuthTemplateSchema = new Schema<CachedAuthTemplateDocument>(
  {
    workspaceId: { type: String, required: true, index: true },
    templateId: { type: String, required: true },
    name: { type: String, required: true },
    language: { type: String, required: true },
    status: { type: String, required: true },
    category: { type: String, required: true },
  },
  { collection: "whatsapptemplates", strict: false }
);

const CACHED_AUTH_TEMPLATE_MODEL_NAME = "OtpCachedWhatsAppTemplate";

export const CachedAuthTemplateModel =
  (mongoose.models[CACHED_AUTH_TEMPLATE_MODEL_NAME] as
    | Model<CachedAuthTemplateDocument>
    | undefined) ||
  mongoose.model<CachedAuthTemplateDocument>(
    CACHED_AUTH_TEMPLATE_MODEL_NAME,
    CachedAuthTemplateSchema
  );
