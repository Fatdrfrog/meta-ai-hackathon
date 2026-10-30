import mongoose from "mongoose";
import {
  PRODUCTS_WHATSAPP_LINK_VIAS,
  type ProductsWhatsAppLinkVia,
} from "@/lib/products/types";

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
 * The phone asks to be linked from the Products page's QR, and an admin of
 * the workspace confirms it there. A number already connected to the
 * workspace in airi needs no linking: its link is made on its first video.
 * Phones linked with a one-time code, before admins confirmed them, keep
 * working as they are.
 */
export interface IProductWhatsAppLink {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  via: ProductsWhatsAppLinkVia;
  /** The admin who linked it; absent for a connected number. */
  createdBy?: string;
  /** The owner's number, digits only. */
  phone?: string;
  /** When it was linked; absent for a connected number. */
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
      enum: PRODUCTS_WHATSAPP_LINK_VIAS,
    },
    createdBy: { type: String },
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

// One workspace per phone: it's unlinked there before another can link it.
ProductWhatsAppLinkSchema.index(
  { phone: 1 },
  {
    name: "product_whatsapp_link_phone",
    unique: true,
    partialFilterExpression: { phone: { $exists: true } },
  }
);

// The Products page lists a workspace's phones.
ProductWhatsAppLinkSchema.index(
  { workspaceId: 1, createdAt: 1 },
  { name: "product_whatsapp_link_workspace" }
);

export const ProductWhatsAppLink =
  (mongoose.models.ProductWhatsAppLink as
    | mongoose.Model<IProductWhatsAppLink>
    | undefined) ||
  mongoose.model<IProductWhatsAppLink>(
    "ProductWhatsAppLink",
    ProductWhatsAppLinkSchema
  );
