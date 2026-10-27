import mongoose, { type Model } from "mongoose";

export const WEBSITE_COMMERCE_EVENT_PROVIDERS = [
  "generic",
  "shopify",
  "tilda",
] as const;
export const WEBSITE_COMMERCE_EVENT_TYPES = [
  "order_placed",
  "checkout_closed",
  "purchase",
  "refund",
] as const;
export const WEBSITE_COMMERCE_EVENT_STATUSES = [
  "pending",
  "completed",
  "unmatched",
] as const;

export type WebsiteCommerceEventRow = {
  eventId: string;
  provider: (typeof WEBSITE_COMMERCE_EVENT_PROVIDERS)[number];
  workspaceId: string;
  widgetSourceId: string;
  cartId?: string;
  checkoutId?: string;
  orderId: string;
  type: (typeof WEBSITE_COMMERCE_EVENT_TYPES)[number];
  occurredAt: Date;
  transactionId?: string;
  purchaseTransactionId?: string;
  value?: number;
  currency?: string;
  payloadHash: string;
  status: (typeof WEBSITE_COMMERCE_EVENT_STATUSES)[number];
  attempts: number;
  nextAttemptAt: Date;
  error?: string;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export const WEBSITE_COMMERCE_EVENT_INDEX_SPECS = [
  {
    key: { widgetSourceId: 1, provider: 1, eventId: 1 },
    options: {
      background: true,
      unique: true,
      name: "website_commerce_event_receipt_unique",
    },
  },
  {
    key: { status: 1, nextAttemptAt: 1, _id: 1 },
    options: {
      background: true,
      name: "website_commerce_event_pending_queue",
    },
  },
  {
    key: { widgetSourceId: 1, cartId: 1, type: 1 },
    options: {
      background: true,
      name: "website_commerce_event_cart_terminal_lookup",
    },
  },
  {
    key: { widgetSourceId: 1, checkoutId: 1, type: 1 },
    options: {
      background: true,
      name: "website_commerce_event_checkout_terminal_lookup",
    },
  },
  {
    key: {
      widgetSourceId: 1,
      provider: 1,
      orderId: 1,
      type: 1,
      occurredAt: -1,
    },
    options: {
      background: true,
      name: "website_commerce_event_order_correlation_lookup",
    },
  },
] as const;

const boundedIdentity = {
  type: String,
  required: true,
  trim: true,
  maxlength: 200,
} as const;
const optionalIdentity = {
  type: String,
  trim: true,
  maxlength: 200,
} as const;

const WebsiteCommerceEventSchema = new mongoose.Schema<WebsiteCommerceEventRow>(
  {
    eventId: boundedIdentity,
    provider: {
      type: String,
      enum: WEBSITE_COMMERCE_EVENT_PROVIDERS,
      required: true,
    },
    workspaceId: boundedIdentity,
    widgetSourceId: boundedIdentity,
    cartId: optionalIdentity,
    checkoutId: optionalIdentity,
    orderId: boundedIdentity,
    type: {
      type: String,
      enum: WEBSITE_COMMERCE_EVENT_TYPES,
      required: true,
    },
    occurredAt: { type: Date, required: true },
    transactionId: optionalIdentity,
    purchaseTransactionId: optionalIdentity,
    value: { type: Number, min: 0.01, max: 99_999_999.99 },
    currency: {
      type: String,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
    },
    payloadHash: {
      type: String,
      required: true,
      match: /^[a-f0-9]{64}$/,
    },
    status: {
      type: String,
      enum: WEBSITE_COMMERCE_EVENT_STATUSES,
      required: true,
      default: "pending",
    },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    nextAttemptAt: { type: Date, required: true, default: Date.now },
    error: { type: String, maxlength: 512 },
    completedAt: { type: Date },
  },
  {
    collection: "website_commerce_events",
    strict: "throw",
    timestamps: true,
    versionKey: false,
  }
);

for (const spec of WEBSITE_COMMERCE_EVENT_INDEX_SPECS) {
  WebsiteCommerceEventSchema.index(spec.key, spec.options);
}

const WebsiteCommerceEvent =
  (mongoose.models.WebsiteCommerceEvent as
    | Model<WebsiteCommerceEventRow>
    | undefined) ||
  mongoose.model<WebsiteCommerceEventRow>(
    "WebsiteCommerceEvent",
    WebsiteCommerceEventSchema
  );

export default WebsiteCommerceEvent;
