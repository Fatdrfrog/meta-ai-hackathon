import mongoose from "mongoose";

// Linking a shop owner's phone to their workspace (Products), with nothing
// secret in the message: an admin opens a window on the Products page, the
// phone asks by naming the shop, and the admin confirms it there. All of it
// is short-lived, so each collection deletes its documents once they expire.

/**
 * The window in which phones may ask to be linked to a workspace, open while
 * an admin has "Send from WhatsApp" open on its Products page.
 */
export interface IProductWhatsAppPairing {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  /** The admin who opened it last. */
  createdBy: string;
  /** The workspace's name as the phone's message writes it. */
  shopName: string;
  /** That name as messages are matched against it. */
  shopKey: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ProductWhatsAppPairingSchema =
  new mongoose.Schema<IProductWhatsAppPairing>(
    {
      workspaceId: { type: String, required: true, trim: true, maxlength: 64 },
      createdBy: { type: String, required: true },
      shopName: { type: String, required: true, maxlength: 80 },
      shopKey: { type: String, required: true, maxlength: 80 },
      expiresAt: { type: Date, required: true },
    },
    { timestamps: true, collection: "product_whatsapp_pairings" }
  );

// One window per workspace: opening it again keeps it open longer.
ProductWhatsAppPairingSchema.index(
  { workspaceId: 1 },
  { name: "product_whatsapp_pairing_workspace", unique: true }
);

// A phone's message finds its window by the shop's name.
ProductWhatsAppPairingSchema.index(
  { shopKey: 1, expiresAt: 1 },
  { name: "product_whatsapp_pairing_shop" }
);

ProductWhatsAppPairingSchema.index(
  { expiresAt: 1 },
  { name: "product_whatsapp_pairing_expiry", expireAfterSeconds: 0 }
);

export const ProductWhatsAppPairing =
  (mongoose.models.ProductWhatsAppPairing as
    | mongoose.Model<IProductWhatsAppPairing>
    | undefined) ||
  mongoose.model<IProductWhatsAppPairing>(
    "ProductWhatsAppPairing",
    ProductWhatsAppPairingSchema
  );

/** A phone that asked to be linked to a workspace, until an admin answers. */
export interface IProductWhatsAppLinkRequest {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  /** The phone, digits only, as WhatsApp vouches for it. */
  phone: string;
  /** The name on its WhatsApp profile, when it has one. */
  profileName: string | null;
  /** airi's source the phone wrote to, which writes back to it. */
  sourceId: string;
  /** When the phone last asked; asking again renews the request. */
  createdAt: Date;
  expiresAt: Date;
}

const ProductWhatsAppLinkRequestSchema =
  new mongoose.Schema<IProductWhatsAppLinkRequest>(
    {
      workspaceId: { type: String, required: true, trim: true, maxlength: 64 },
      phone: { type: String, required: true, trim: true, maxlength: 20 },
      profileName: { type: String, default: null, maxlength: 80 },
      sourceId: { type: String, required: true },
      createdAt: { type: Date, required: true },
      expiresAt: { type: Date, required: true },
    },
    { collection: "product_whatsapp_link_requests" }
  );

// One request per phone and workspace: asking again renews it.
ProductWhatsAppLinkRequestSchema.index(
  { workspaceId: 1, phone: 1 },
  { name: "product_whatsapp_link_request_phone", unique: true }
);

ProductWhatsAppLinkRequestSchema.index(
  { expiresAt: 1 },
  { name: "product_whatsapp_link_request_expiry", expireAfterSeconds: 0 }
);

export const ProductWhatsAppLinkRequest =
  (mongoose.models.ProductWhatsAppLinkRequest as
    | mongoose.Model<IProductWhatsAppLinkRequest>
    | undefined) ||
  mongoose.model<IProductWhatsAppLinkRequest>(
    "ProductWhatsAppLinkRequest",
    ProductWhatsAppLinkRequestSchema
  );

/**
 * A link message from a phone that matched no open shop. Airi answers only a
 * few of these an hour per phone, so it counts them; each lasts an hour.
 */
export interface IProductWhatsAppLinkMiss {
  _id: mongoose.Types.ObjectId;
  /** The phone, digits only. */
  phone: string;
  expiresAt: Date;
}

const ProductWhatsAppLinkMissSchema =
  new mongoose.Schema<IProductWhatsAppLinkMiss>(
    {
      phone: { type: String, required: true, trim: true, maxlength: 20 },
      expiresAt: { type: Date, required: true },
    },
    { collection: "product_whatsapp_link_misses" }
  );

ProductWhatsAppLinkMissSchema.index(
  { phone: 1, expiresAt: 1 },
  { name: "product_whatsapp_link_miss_phone" }
);

ProductWhatsAppLinkMissSchema.index(
  { expiresAt: 1 },
  { name: "product_whatsapp_link_miss_expiry", expireAfterSeconds: 0 }
);

export const ProductWhatsAppLinkMiss =
  (mongoose.models.ProductWhatsAppLinkMiss as
    | mongoose.Model<IProductWhatsAppLinkMiss>
    | undefined) ||
  mongoose.model<IProductWhatsAppLinkMiss>(
    "ProductWhatsAppLinkMiss",
    ProductWhatsAppLinkMissSchema
  );
