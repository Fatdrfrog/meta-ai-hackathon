import mongoose from "mongoose";
import {
  PRODUCT_VIDEO_IMPORT_ERROR_CODES,
  PRODUCT_VIDEO_IMPORT_SOURCES,
  PRODUCT_VIDEO_IMPORT_STAGES,
  PRODUCT_VIDEO_IMPORT_STATUSES,
  type ProductVideoImportErrorCode,
  type ProductVideoImportSource,
  type ProductVideoImportStage,
  type ProductVideoImportStatus,
  type StoredFileRef,
} from "@/lib/products/types";

/**
 * A shelf video sent to airi's own WhatsApp number: the message it came in,
 * stored in the workspace that owns that number, and the owner's phone.
 */
export type ProductVideoImportWhatsApp = {
  /** airi's source and workspace that received it. */
  sourceId: string;
  workspaceId: string;
  conversationId: string;
  /** The stored message, and its WhatsApp media. */
  messageId: string;
  mediaId: string;
  mimeType?: string | null;
  /** The owner's number, digits only. */
  phone: string;
  /** When the owner was told the outcome; set once, so they're told once. */
  notifiedAt?: Date | null;
};

/**
 * One shelf video the owner sent, and the job that turns it into draft
 * products (Products). Its products point back to it by `importId`. The job
 * saves each step here (the transcript, how far it got), so a retried job
 * resumes instead of paying for the same work again.
 */
export interface IProductVideoImport {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  source: ProductVideoImportSource;
  /**
   * The video, in the workspace's media storage. A video sent on WhatsApp
   * has none until the job has copied it there from WhatsApp.
   */
  video?: (StoredFileRef & { mimeType?: string; fileName?: string }) | null;
  /** Where a video sent on WhatsApp came from, and whom to tell when it's done. */
  whatsapp?: ProductVideoImportWhatsApp | null;
  status: ProductVideoImportStatus;
  stage?: ProductVideoImportStage | null;
  /** The owner's narration, one timed sentence per line; null until heard. */
  transcript?: string | null;
  /** The language the owner spoke, as Muse Spark named it. */
  language?: string | null;
  /** Products found, their options' photos, and how many photos are made. */
  productTotal: number;
  photoTotal: number;
  photoDone: number;
  /** Draft products the video produced; set once it's ready. */
  productCount: number;
  /** List-price cost of the Meta model calls, in US dollars. */
  costUsd: number;
  /**
   * The person who presents the products, when someone does: the moment
   * they're clearest, and their cut-out once made. An asset to reuse later,
   * for example beside the products on carousel cards.
   */
  presenter?: {
    momentSeconds: number;
    photo?: {
      /** Transparent PNG cut-out, its small WebP copy, and the filmed frame. */
      cutout?: StoredFileRef;
      thumb?: StoredFileRef;
      original?: StoredFileRef;
      frameTimeSeconds?: number;
    } | null;
  } | null;
  /** Why it failed, as a code the panel explains. */
  errorCode?: ProductVideoImportErrorCode | null;
  /** The failure in words, for support; not shown to the owner. */
  errorMessage?: string | null;
  workflowId?: string;
  /** The panel user who uploaded it; absent for a WhatsApp video. */
  createdBy?: string;
  startedAt?: Date;
  finishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ProductVideoImportSchema = new mongoose.Schema<IProductVideoImport>(
  {
    workspaceId: { type: String, required: true, trim: true, maxlength: 64 },
    source: {
      type: String,
      required: true,
      enum: PRODUCT_VIDEO_IMPORT_SOURCES,
    },
    video: {
      type: new mongoose.Schema<NonNullable<IProductVideoImport["video"]>>(
        {
          bucket: { type: String, required: true },
          path: { type: String, required: true },
          mimeType: { type: String },
          fileName: { type: String, maxlength: 255 },
        },
        { _id: false }
      ),
      default: null,
    },
    whatsapp: {
      type: new mongoose.Schema<ProductVideoImportWhatsApp>(
        {
          sourceId: { type: String, required: true },
          workspaceId: { type: String, required: true },
          conversationId: { type: String, required: true },
          messageId: { type: String, required: true },
          mediaId: { type: String, required: true },
          mimeType: { type: String, default: null },
          phone: { type: String, required: true, maxlength: 20 },
          notifiedAt: { type: Date, default: null },
        },
        { _id: false }
      ),
      default: null,
    },
    status: {
      type: String,
      required: true,
      enum: PRODUCT_VIDEO_IMPORT_STATUSES,
      default: "queued",
    },
    stage: { type: String, enum: [...PRODUCT_VIDEO_IMPORT_STAGES, null] },
    transcript: { type: String, maxlength: 40_000, default: null },
    language: { type: String, trim: true, maxlength: 40, default: null },
    productTotal: { type: Number, default: 0, min: 0 },
    photoTotal: { type: Number, default: 0, min: 0 },
    photoDone: { type: Number, default: 0, min: 0 },
    productCount: { type: Number, default: 0, min: 0 },
    costUsd: { type: Number, default: 0, min: 0 },
    presenter: {
      type: new mongoose.Schema<NonNullable<IProductVideoImport["presenter"]>>(
        {
          momentSeconds: { type: Number, required: true, min: 0 },
          photo: {
            type: new mongoose.Schema<
              NonNullable<
                NonNullable<IProductVideoImport["presenter"]>["photo"]
              >
            >(
              {
                cutout: { bucket: { type: String }, path: { type: String } },
                thumb: { bucket: { type: String }, path: { type: String } },
                original: { bucket: { type: String }, path: { type: String } },
                frameTimeSeconds: Number,
              },
              { _id: false }
            ),
            default: null,
          },
        },
        { _id: false }
      ),
      default: null,
    },
    errorCode: {
      type: String,
      enum: [...PRODUCT_VIDEO_IMPORT_ERROR_CODES, null],
      default: null,
    },
    errorMessage: { type: String, maxlength: 500, default: null },
    workflowId: { type: String },
    createdBy: { type: String },
    startedAt: { type: Date },
    finishedAt: { type: Date },
  },
  { timestamps: true, collection: "product_video_imports" }
);

ProductVideoImportSchema.index(
  { workspaceId: 1, createdAt: -1 },
  { name: "product_video_import_workspace_recent" }
);

// One import per WhatsApp message, however often its webhook is delivered.
ProductVideoImportSchema.index(
  { "whatsapp.messageId": 1 },
  {
    name: "product_video_import_whatsapp_message",
    unique: true,
    partialFilterExpression: { "whatsapp.messageId": { $exists: true } },
  }
);

export const ProductVideoImport =
  (mongoose.models.ProductVideoImport as
    | mongoose.Model<IProductVideoImport>
    | undefined) ||
  mongoose.model<IProductVideoImport>(
    "ProductVideoImport",
    ProductVideoImportSchema
  );
