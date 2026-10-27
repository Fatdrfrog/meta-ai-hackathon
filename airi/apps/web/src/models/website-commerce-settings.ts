import mongoose, { type Model } from "mongoose";

import type { EncryptedString } from "@/lib/crypto";
import { EncryptedStringSchema } from "@/models/encrypted-string-schema";

export type WebsiteCommerceSettings = {
  workspaceId: string;
  widgetSourceId: string;
  enabled: boolean;
  whatsappSourceId: string | null;
  shopifyShopDomain: string | null;
  webhookSecret?: EncryptedString;
  shopifyWebhookSecret?: EncryptedString;
  tildaToken?: EncryptedString;
  lastEventAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export const WEBSITE_COMMERCE_SETTINGS_INDEX_SPECS = [
  {
    key: { widgetSourceId: 1 },
    options: {
      background: true,
      unique: true,
      name: "website_commerce_settings_widget_source_unique",
    },
  },
  {
    key: { workspaceId: 1, updatedAt: -1 },
    options: {
      background: true,
      name: "website_commerce_settings_workspace_updated",
    },
  },
] as const;

const boundedSourceId = {
  type: String,
  required: true,
  trim: true,
  maxlength: 200,
} as const;

const WebsiteCommerceSettingsSchema =
  new mongoose.Schema<WebsiteCommerceSettings>(
    {
      workspaceId: boundedSourceId,
      widgetSourceId: boundedSourceId,
      enabled: { type: Boolean, required: true, default: false },
      whatsappSourceId: {
        type: String,
        trim: true,
        maxlength: 200,
        default: null,
      },
      shopifyShopDomain: {
        type: String,
        trim: true,
        lowercase: true,
        maxlength: 255,
        default: null,
      },
      webhookSecret: { type: EncryptedStringSchema },
      shopifyWebhookSecret: { type: EncryptedStringSchema },
      tildaToken: { type: EncryptedStringSchema },
      lastEventAt: { type: Date },
    },
    {
      collection: "website_commerce_settings",
      strict: "throw",
      timestamps: true,
      versionKey: false,
    }
  );

for (const spec of WEBSITE_COMMERCE_SETTINGS_INDEX_SPECS) {
  WebsiteCommerceSettingsSchema.index(spec.key, spec.options);
}

const WebsiteCommerceSettingsModel =
  (mongoose.models.WebsiteCommerceSettings as
    | Model<WebsiteCommerceSettings>
    | undefined) ||
  mongoose.model<WebsiteCommerceSettings>(
    "WebsiteCommerceSettings",
    WebsiteCommerceSettingsSchema
  );

export default WebsiteCommerceSettingsModel;
