import mongoose from "mongoose";
import type { CommerceTrackingEvent } from "@icecore/shared/types/commerce-tracking";

export type WebsiteCartRow = {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  widgetSourceId: string;
  cartId: string;
  ownerSessionId: string;
  checkoutId?: string;
  orderId?: string;
  status:
    | "cart"
    | "checkout"
    | "closed"
    | "ordered"
    | "purchase_reported"
    | "paid";
  items: NonNullable<CommerceTrackingEvent["items"]>;
  currency: string;
  total: number;
  recoveryUrl?: string;
  version: number;
  activityAt: Date;
  eventAt: Date;
  eventId: string;
  eventHash: string;
  expiresAt: Date;
  recentEvents: { id: string; hash: string }[];
  conversationId?: mongoose.Types.ObjectId;
  customerId?: mongoose.Types.ObjectId;
  whatsappSourceId?: string;
  consentAt?: Date;
  handoffHash?: string;
  handoffExpiresAt?: Date;
  handoffIssuedAt?: Date;
  handoffMessageId?: string;
  handoffConsentText?: string;
  admissionPending: boolean;
  nextAdmissionAt: Date;
  updatedAt: Date;
};

const schema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true },
    widgetSourceId: { type: String, required: true },
    cartId: { type: String, required: true },
    ownerSessionId: { type: String, required: true },
    checkoutId: String,
    orderId: String,
    status: {
      type: String,
      enum: [
        "cart",
        "checkout",
        "closed",
        "ordered",
        "purchase_reported",
        "paid",
      ],
      required: true,
    },
    items: { type: [mongoose.Schema.Types.Mixed], default: [] },
    currency: { type: String, default: "KZT" },
    total: { type: Number, default: 0 },
    recoveryUrl: String,
    version: { type: Number, default: 1 },
    activityAt: { type: Date, required: true },
    eventAt: { type: Date, required: true },
    eventId: { type: String, required: true },
    eventHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    recentEvents: { type: [mongoose.Schema.Types.Mixed], default: [] },
    conversationId: mongoose.Schema.Types.ObjectId,
    customerId: mongoose.Schema.Types.ObjectId,
    whatsappSourceId: String,
    consentAt: Date,
    handoffHash: String,
    handoffExpiresAt: Date,
    handoffIssuedAt: Date,
    handoffMessageId: String,
    handoffConsentText: String,
    admissionPending: { type: Boolean, default: true },
    nextAdmissionAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
schema.index({ widgetSourceId: 1, cartId: 1 }, { unique: true });
schema.index(
  { widgetSourceId: 1, checkoutId: 1 },
  { unique: true, partialFilterExpression: { checkoutId: { $type: "string" } } }
);
schema.index({ widgetSourceId: 1, ownerSessionId: 1, updatedAt: -1 });
schema.index({ admissionPending: 1, nextAdmissionAt: 1, _id: 1 });
schema.index(
  { handoffHash: 1 },
  {
    unique: true,
    partialFilterExpression: { handoffHash: { $type: "string" } },
  }
);
schema.index({ workspaceId: 1, widgetSourceId: 1, updatedAt: -1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.WebsiteCart ||
  mongoose.model("WebsiteCart", schema);
