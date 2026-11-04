import mongoose from "mongoose";

/**
 * One Airi voice's short sample in one shop language (Products, Part V):
 * made once with ElevenLabs on airi's key the first time an owner plays it,
 * then served from here to every workspace. A few kilobytes each; at most
 * one per voice, language and text version (a race keeps the first).
 */
export interface IProductVoiceSample {
  _id: mongoose.Types.ObjectId;
  voiceId: string;
  language: string;
  /** The sample text's version: a new text makes new samples. */
  version: number;
  audio: Buffer;
  mimeType: string;
  /** Characters read, for the record. */
  characters: number;
  createdAt: Date;
  updatedAt: Date;
}

const ProductVoiceSampleSchema = new mongoose.Schema<IProductVoiceSample>(
  {
    voiceId: { type: String, required: true, maxlength: 64 },
    language: { type: String, required: true, maxlength: 8 },
    version: { type: Number, required: true, min: 1 },
    audio: { type: Buffer, required: true },
    mimeType: { type: String, required: true, maxlength: 40 },
    characters: { type: Number, min: 0, default: 0 },
  },
  {
    timestamps: true,
    collection: "product_voice_samples",
    // A dozen documents, read by all three fields: no index to keep.
    autoIndex: false,
  }
);

export const ProductVoiceSample =
  (mongoose.models.ProductVoiceSample as
    | mongoose.Model<IProductVoiceSample>
    | undefined) ||
  mongoose.model<IProductVoiceSample>(
    "ProductVoiceSample",
    ProductVoiceSampleSchema
  );
