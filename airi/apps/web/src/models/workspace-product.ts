import mongoose from "mongoose";
import {
  PRODUCT_PHOTO_METHODS,
  PRODUCT_PRICE_SOURCES,
  WORKSPACE_PRODUCT_STATUSES,
  type ProductPhotoMethod,
  type ProductPriceSource,
  type StoredFileRef,
  type WorkspaceProductStatus,
} from "@/lib/products/types";

/**
 * One product of a workspace's own catalog (Products). Named apart from the
 * Meta Commerce catalog, which numbers on WhatsApp Business app coexistence
 * can't use. Products found in a video start as drafts until the owner
 * reviews them; rejected ones are kept, so the import still accounts for them.
 */
export interface IWorkspaceProduct {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  status: WorkspaceProductStatus;
  /** As the owner named it, in their own language: what buyers see. */
  name: string;
  /** Whole tenge; null until the owner sets a price. */
  price: number | null;
  /**
   * Place on the workspace's shelf, across all imports. A new video's products
   * go after everything already there, in the order they were filmed.
   */
  position: number;
  /** The video this product was found in; absent for one added by hand. */
  importId?: mongoose.Types.ObjectId;
  /** Its place in that video's product list: one row per item, however often the import runs. */
  importIndex?: number;
  /** The catalog name in English, from the import. */
  englishName?: string;
  category?: string;
  /** The currency the owner said, when it wasn't tenge. */
  currency?: string | null;
  /** The narration's words, or the video's text, the price came from. */
  priceQuote?: string | null;
  /** Said aloud or only written in the video; null without a price. */
  priceSource?: ProductPriceSource | null;
  /** A starting price ("from 15 500"): the final one depends on options. */
  priceIsFrom: boolean;
  /** The English noun phrase SAM 3.1 finds the product by. */
  samPhrase?: string;
  /** What the owner should confirm before publishing, in English. */
  doubts: string[];
  /** The stretch of the video the owner presents it in. */
  videoWindow?: { fromSeconds: number; toSeconds: number };
  photo?: {
    method: ProductPhotoMethod;
    /** Transparent PNG cut-out, its small WebP copy, and the filmed JPEG crop. */
    cutout?: StoredFileRef;
    thumb?: StoredFileRef;
    original?: StoredFileRef;
    frameTimeSeconds?: number;
  };
  publishedAt?: Date;
  publishedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const WorkspaceProductSchema = new mongoose.Schema<IWorkspaceProduct>(
  {
    workspaceId: { type: String, required: true, trim: true, maxlength: 64 },
    status: {
      type: String,
      required: true,
      enum: WORKSPACE_PRODUCT_STATUSES,
      default: "draft",
    },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    price: {
      type: Number,
      default: null,
      min: 0,
      validate: {
        validator: (value: number | null) =>
          value === null || Number.isInteger(value),
        message: "Prices are whole tenge",
      },
    },
    position: { type: Number, default: 0 },
    importId: { type: mongoose.Schema.Types.ObjectId },
    importIndex: { type: Number, min: 0 },
    englishName: { type: String, trim: true, maxlength: 160 },
    category: { type: String, trim: true, maxlength: 60 },
    currency: { type: String, trim: true, maxlength: 8, default: null },
    priceQuote: { type: String, trim: true, maxlength: 300, default: null },
    priceSource: {
      type: String,
      enum: [...PRODUCT_PRICE_SOURCES, null],
      default: null,
    },
    priceIsFrom: { type: Boolean, default: false },
    samPhrase: { type: String, trim: true, maxlength: 80 },
    doubts: { type: [{ type: String, maxlength: 400 }], default: [] },
    videoWindow: {
      type: new mongoose.Schema(
        { fromSeconds: Number, toSeconds: Number },
        { _id: false }
      ),
    },
    photo: {
      type: new mongoose.Schema(
        {
          method: {
            type: String,
            enum: PRODUCT_PHOTO_METHODS,
            default: "pending",
          },
          cutout: { bucket: { type: String }, path: { type: String } },
          thumb: { bucket: { type: String }, path: { type: String } },
          original: { bucket: { type: String }, path: { type: String } },
          frameTimeSeconds: Number,
        },
        { _id: false }
      ),
    },
    publishedAt: { type: Date },
    publishedBy: { type: String },
  },
  { timestamps: true, collection: "workspace_products" }
);

WorkspaceProductSchema.index(
  { workspaceId: 1, status: 1, position: 1, _id: 1 },
  { name: "workspace_product_status_position" }
);

// An import's products, in its order; unique, so a retried import can't add
// a product twice.
WorkspaceProductSchema.index(
  { importId: 1, importIndex: 1 },
  {
    name: "workspace_product_import_item",
    unique: true,
    partialFilterExpression: {
      importId: { $exists: true },
      importIndex: { $exists: true },
    },
  }
);

export const WorkspaceProduct =
  (mongoose.models.WorkspaceProduct as
    | mongoose.Model<IWorkspaceProduct>
    | undefined) ||
  mongoose.model<IWorkspaceProduct>("WorkspaceProduct", WorkspaceProductSchema);
