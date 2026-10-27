import mongoose, { type Document, type Model } from "mongoose";

export interface ICreativeGenerationAdmissionLease extends Document<string> {
  _id: string;
  ownerToken: string | null;
  fencingToken: number;
  expiresAt: Date;
}

const CreativeGenerationAdmissionLeaseSchema =
  new mongoose.Schema<ICreativeGenerationAdmissionLease>(
    {
      _id: { type: String, required: true },
      ownerToken: { type: String, default: null },
      fencingToken: { type: Number, required: true, min: 0, default: 0 },
      expiresAt: { type: Date, required: true },
    },
    {
      collection: "creative_generation_admission_leases",
      versionKey: false,
    }
  );

export const CreativeGenerationAdmissionLease =
  (mongoose.models
    .CreativeGenerationAdmissionLease as Model<ICreativeGenerationAdmissionLease>) ||
  mongoose.model<ICreativeGenerationAdmissionLease>(
    "CreativeGenerationAdmissionLease",
    CreativeGenerationAdmissionLeaseSchema
  );
