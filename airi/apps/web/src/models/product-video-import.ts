import mongoose from "mongoose";
import {
  PRODUCT_VIDEO_IMPORT_SOURCES,
  PRODUCT_VIDEO_IMPORT_STATUSES,
  type ProductVideoImportSource,
  type ProductVideoImportStatus,
} from "@/lib/products/types";

/**
 * One shelf video the owner sent, and the job that turns it into draft
 * products (Products). Its products point back to it by `importId`.
 */
export interface IProductVideoImport {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  source: ProductVideoImportSource;
  status: ProductVideoImportStatus;
  /** Draft products the video produced; set once it's ready. */
  productCount: number;
  /** Why it failed, as a code the panel explains. */
  errorCode?: string;
  /** The panel user who uploaded it; absent for a WhatsApp video. */
  createdBy?: string;
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
    status: {
      type: String,
      required: true,
      enum: PRODUCT_VIDEO_IMPORT_STATUSES,
      default: "queued",
    },
    productCount: { type: Number, default: 0, min: 0 },
    errorCode: { type: String, trim: true, maxlength: 64 },
    createdBy: { type: String },
    finishedAt: { type: Date },
  },
  { timestamps: true, collection: "product_video_imports" }
);

ProductVideoImportSchema.index(
  { workspaceId: 1, createdAt: -1 },
  { name: "product_video_import_workspace_recent" }
);

export const ProductVideoImport =
  (mongoose.models.ProductVideoImport as
    | mongoose.Model<IProductVideoImport>
    | undefined) ||
  mongoose.model<IProductVideoImport>(
    "ProductVideoImport",
    ProductVideoImportSchema
  );
