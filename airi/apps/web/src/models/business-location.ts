import mongoose from "mongoose";

/**
 * One office of a workspace (Settings → Offices). Scenario location routes
 * send a customer's shared location to the nearest active office. Offices
 * are deactivated, never deleted, so saved routes and routed conversations
 * keep naming them.
 */
export interface IBusinessLocation {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  /** Stable per workspace: what scenarios save and imports update by. */
  key: string;
  name: string;
  /** ISO-3166 alpha-2, upper case. */
  country: string;
  city: string;
  /** The comparable city, as scenario routes store it. */
  cityKey: string;
  address?: string;
  phone?: string;
  mapUrl?: string;
  tags: string[];
  latitude: number;
  longitude: number;
  isActive: boolean;
  sortOrder: number;
  createdBy?: string;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const BusinessLocationSchema = new mongoose.Schema<IBusinessLocation>(
  {
    workspaceId: { type: String, required: true, trim: true, maxlength: 64 },
    key: { type: String, required: true, trim: true, maxlength: 64 },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    country: { type: String, required: true, trim: true, maxlength: 2 },
    city: { type: String, required: true, trim: true, maxlength: 120 },
    cityKey: { type: String, required: true, trim: true, maxlength: 120 },
    address: { type: String, trim: true, maxlength: 240 },
    phone: { type: String, trim: true, maxlength: 40 },
    mapUrl: { type: String, trim: true, maxlength: 500 },
    tags: { type: [String], default: [] },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true, collection: "business_locations" }
);

BusinessLocationSchema.index(
  { workspaceId: 1, key: 1 },
  { unique: true, name: "business_location_workspace_key_unique" }
);
BusinessLocationSchema.index(
  { workspaceId: 1, isActive: 1, sortOrder: 1, key: 1 },
  { name: "business_location_workspace_active_order" }
);

export const BusinessLocation =
  (mongoose.models.BusinessLocation as
    | mongoose.Model<IBusinessLocation>
    | undefined) ||
  mongoose.model<IBusinessLocation>("BusinessLocation", BusinessLocationSchema);
