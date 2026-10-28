import mongoose from "mongoose";
import {
  PRODUCT_PHOTO_METHODS,
  PRODUCT_TEXT_SOURCES,
  WORKSPACE_PRODUCT_STATUSES,
  type ProductPhotoMethod,
  type ProductTextSource,
  type StoredFileRef,
  type WorkspaceProductStatus,
} from "@/lib/products/types";

/**
 * One item shown for a product: a design, size or shape of it, with its own
 * photo. A family-tree panel sold at one price in six designs has six.
 */
export interface IWorkspaceProductOption {
  /** A few English words that tell it apart from the product's other options. */
  description: string;
  /** The English noun phrase SAM 3.1 finds it by. */
  samPhrase?: string;
  /** The stretch of the video it is shown in. */
  videoWindow?: { fromSeconds: number; toSeconds: number };
  photo?: {
    method: ProductPhotoMethod;
    /** Transparent PNG cut-out, its small WebP copy, and the filmed JPEG crop. */
    cutout?: StoredFileRef;
    thumb?: StoredFileRef;
    original?: StoredFileRef;
    frameTimeSeconds?: number;
    /** Degrees the photo was turned to stand level, clockwise; 0 when it wasn't. */
    straightenedDegrees?: number;
  };
  /** What the owner should know about its photo, in English. */
  notes: string[];
}

/**
 * One product of a workspace's own catalog (Products): what a buyer orders
 * by one name at one price, with the items shown for it as options. Named
 * apart from the Meta Commerce catalog, which numbers on WhatsApp Business
 * app coexistence can't use. Products found in a video start as drafts until
 * the owner reviews them; rejected ones are kept, so the import still
 * accounts for them.
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
  /** Whether `name` was said in the video or only written on screen. */
  nameSource?: ProductTextSource | null;
  category?: string;
  /** The currency the owner said, when it wasn't tenge. */
  currency?: string | null;
  /** The narration's words, or the video's text, the price came from. */
  priceQuote?: string | null;
  /** Said aloud or only written in the video; null without a price. */
  priceSource?: ProductTextSource | null;
  /** A starting price ("from 15 500"): the final one depends on options. */
  priceIsFrom: boolean;
  /** What the owner should confirm before publishing, in English. */
  doubts: string[];
  /** The items shown for it, in the order shown. */
  options: IWorkspaceProductOption[];
  /** The option the shelf shows for it, as an index into `options`. */
  featuredOption: number;
  publishedAt?: Date;
  publishedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const WorkspaceProductOptionSchema =
  new mongoose.Schema<IWorkspaceProductOption>(
    {
      description: { type: String, required: true, trim: true, maxlength: 120 },
      samPhrase: { type: String, trim: true, maxlength: 80 },
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
            straightenedDegrees: Number,
          },
          { _id: false }
        ),
      },
      notes: { type: [{ type: String, maxlength: 400 }], default: [] },
    },
    { _id: false }
  );

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
    nameSource: {
      type: String,
      enum: [...PRODUCT_TEXT_SOURCES, null],
      default: null,
    },
    category: { type: String, trim: true, maxlength: 60 },
    currency: { type: String, trim: true, maxlength: 8, default: null },
    priceQuote: { type: String, trim: true, maxlength: 300, default: null },
    priceSource: {
      type: String,
      enum: [...PRODUCT_TEXT_SOURCES, null],
      default: null,
    },
    priceIsFrom: { type: Boolean, default: false },
    doubts: { type: [{ type: String, maxlength: 400 }], default: [] },
    options: { type: [WorkspaceProductOptionSchema], default: [] },
    featuredOption: { type: Number, default: 0, min: 0 },
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
