import mongoose from "mongoose";
import {
  PRODUCT_VOICE_ERROR_CODES,
  PRODUCT_VOICE_STATES,
  type ProductVoiceErrorCode,
  type ProductVoiceState,
} from "@/lib/products/types";

/**
 * A workspace's cloned voice (Products, Part V): an ElevenLabs Instant Voice
 * Clone of the owner, made from the narration of one of their shelf videos
 * only after they ticked that it's their voice (or that the speaker agreed),
 * and reused by every ad read in "Your voice, new words". One live voice per
 * workspace; "Remove my voice" deletes it at ElevenLabs and sets removedAt.
 * The web writes the consent (pending, with the video it's made from); the
 * first ad run that asks for "Your voice, new words" makes the clone in the
 * worker and fills in elevenVoiceId (ready), or says why it couldn't
 * (failed).
 */
export interface IProductVoice {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  state: ProductVoiceState;
  /** ElevenLabs' id of the clone; null until it's made, and after it's removed. */
  elevenVoiceId: string | null;
  /** The import whose narration it's made from. */
  sourceImportId: string;
  /** The user who ticked the consent, and when. */
  consentBy: string;
  consentAt: Date;
  /** The clear speech it was made from, in seconds; null until measured. */
  speechSeconds: number | null;
  errorCode: ProductVoiceErrorCode | null;
  /** The failure in words, for support; not shown to the owner. */
  errorMessage: string | null;
  /** What making it cost, in millionths of a US dollar. */
  costMicros: number;
  removedAt: Date | null;
  /**
   * Pending or ready, not removed: the workspace's one voice (a unique
   * index holds it to one). False once it failed or was removed.
   */
  live: boolean;
  /**
   * The ad run making it now, and since when: another run waits for it, or
   * takes it over once the claim is old (the run stopped).
   */
  claimedAt: Date | null;
  claimedBy: string | null;
  /**
   * Clones of this voice the worker made but couldn't delete at ElevenLabs
   * (a run stopped, a delete failed): "Remove my voice" deletes them too.
   */
  orphanVoiceIds?: string[];
  createdAt: Date;
  updatedAt: Date;
}

const ProductVoiceSchema = new mongoose.Schema<IProductVoice>(
  {
    workspaceId: { type: String, required: true, trim: true, maxlength: 64 },
    state: {
      type: String,
      required: true,
      enum: PRODUCT_VOICE_STATES,
      default: "pending",
    },
    elevenVoiceId: { type: String, maxlength: 64, default: null },
    sourceImportId: { type: String, required: true, maxlength: 64 },
    consentBy: { type: String, required: true, maxlength: 64 },
    consentAt: { type: Date, required: true },
    speechSeconds: { type: Number, min: 0, default: null },
    errorCode: {
      type: String,
      enum: [...PRODUCT_VOICE_ERROR_CODES, null],
      default: null,
    },
    errorMessage: { type: String, maxlength: 500, default: null },
    costMicros: { type: Number, min: 0, default: 0 },
    removedAt: { type: Date, default: null },
    live: { type: Boolean, default: true },
    claimedAt: { type: Date, default: null },
    claimedBy: { type: String, maxlength: 64, default: null },
    orphanVoiceIds: { type: [{ type: String, maxlength: 64 }], default: [] },
  },
  { timestamps: true, collection: "product_voices" }
);

// The workspace's voice is its newest one not removed.
ProductVoiceSchema.index(
  { workspaceId: 1, createdAt: -1 },
  { name: "product_voice_workspace_recent" }
);

// One live voice per workspace: a second consent press finds the first.
ProductVoiceSchema.index(
  { workspaceId: 1 },
  {
    name: "product_voice_workspace_live",
    unique: true,
    partialFilterExpression: { live: true },
  }
);

export const ProductVoice =
  (mongoose.models.ProductVoice as mongoose.Model<IProductVoice> | undefined) ||
  mongoose.model<IProductVoice>("ProductVoice", ProductVoiceSchema);
