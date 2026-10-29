import mongoose from "mongoose";

/**
 * The question Airi asked about videos a phone sent together (an album, or
 * one right after another), so it asks once for all of them.
 */
export type ProductWhatsAppQuestion = {
  /** The first video's stored message; the question's buttons carry it. */
  messageId: string;
  /** Every video in the burst, in the order they came. */
  videos: Array<{
    messageId: string;
    mediaId: string;
    mimeType: string | null;
  }>;
  /** When the burst's last video came; one within two minutes joins it. */
  lastVideoAt: Date;
  /** The owner's answer; null until they tap a button. */
  answer: "add" | "skip" | null;
};

/**
 * A shop owner's WhatsApp number linked to their workspace, so the shelf
 * videos they send to airi's own number become product imports (Products).
 * A link starts as a one-time code the owner opens WhatsApp with from the
 * Products page; sending it from their phone sets the phone and ends the
 * code. A number already connected to the workspace in airi needs no code:
 * its link is made on its first video.
 */
export interface IProductWhatsAppLink {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  /** How the phone was linked: by sending a code, or as a connected number. */
  via: "code" | "connected_number";
  /** The panel user who made the code. */
  createdBy?: string;
  /** SHA-256 of the one-time code, until it's used. */
  codeHash?: string;
  /** When an unused code stops working; it's deleted then, and unset once used. */
  expiresAt?: Date;
  /** The owner's number, digits only, once linked. */
  phone?: string;
  /** When the code was sent from `phone`; absent for a connected number. */
  linkedAt?: Date;
  /** When this phone last sent a video that became an import. */
  lastVideoAt?: Date;
  /** The latest question Airi asked this phone; null before the first. */
  question?: ProductWhatsAppQuestion | null;
  createdAt: Date;
  updatedAt: Date;
}

const ProductWhatsAppLinkSchema = new mongoose.Schema<IProductWhatsAppLink>(
  {
    workspaceId: { type: String, required: true, trim: true, maxlength: 64 },
    via: {
      type: String,
      required: true,
      enum: ["code", "connected_number"],
    },
    createdBy: { type: String },
    codeHash: { type: String },
    expiresAt: { type: Date },
    phone: { type: String, trim: true, maxlength: 20 },
    linkedAt: { type: Date },
    lastVideoAt: { type: Date },
    question: {
      type: new mongoose.Schema<ProductWhatsAppQuestion>(
        {
          messageId: { type: String, required: true },
          videos: {
            type: [
              new mongoose.Schema<ProductWhatsAppQuestion["videos"][number]>(
                {
                  messageId: { type: String, required: true },
                  mediaId: { type: String, required: true },
                  mimeType: { type: String, default: null },
                },
                { _id: false }
              ),
            ],
            default: [],
          },
          lastVideoAt: { type: Date, required: true },
          answer: { type: String, enum: ["add", "skip", null], default: null },
        },
        { _id: false }
      ),
      default: null,
    },
  },
  { timestamps: true, collection: "product_whatsapp_links" }
);

// One workspace per phone: linking it again moves it.
ProductWhatsAppLinkSchema.index(
  { phone: 1 },
  {
    name: "product_whatsapp_link_phone",
    unique: true,
    partialFilterExpression: { phone: { $exists: true } },
  }
);

ProductWhatsAppLinkSchema.index(
  { codeHash: 1 },
  {
    name: "product_whatsapp_link_code",
    unique: true,
    partialFilterExpression: { codeHash: { $exists: true } },
  }
);

// Codes nobody used go away; a used one has no expiry, so its link stays.
ProductWhatsAppLinkSchema.index(
  { expiresAt: 1 },
  { name: "product_whatsapp_link_expiry", expireAfterSeconds: 0 }
);

export const ProductWhatsAppLink =
  (mongoose.models.ProductWhatsAppLink as
    | mongoose.Model<IProductWhatsAppLink>
    | undefined) ||
  mongoose.model<IProductWhatsAppLink>(
    "ProductWhatsAppLink",
    ProductWhatsAppLinkSchema
  );
