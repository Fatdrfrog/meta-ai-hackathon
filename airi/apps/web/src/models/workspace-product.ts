import mongoose from "mongoose";
import {
  WORKSPACE_PRODUCT_STATUSES,
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
  /** Order on the shelf: a video's products keep the order they were filmed in. */
  position: number;
  /** The video this product was found in; absent for one added by hand. */
  importId?: mongoose.Types.ObjectId;
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
    price: { type: Number, default: null, min: 0 },
    position: { type: Number, default: 0 },
    importId: { type: mongoose.Schema.Types.ObjectId },
    publishedAt: { type: Date },
    publishedBy: { type: String },
  },
  { timestamps: true, collection: "workspace_products" }
);

WorkspaceProductSchema.index(
  { workspaceId: 1, status: 1, position: 1, _id: 1 },
  { name: "workspace_product_status_position" }
);

export const WorkspaceProduct =
  (mongoose.models.WorkspaceProduct as
    | mongoose.Model<IWorkspaceProduct>
    | undefined) ||
  mongoose.model<IWorkspaceProduct>("WorkspaceProduct", WorkspaceProductSchema);
