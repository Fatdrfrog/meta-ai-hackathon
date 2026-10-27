import type { WhatsAppWelcomeMessageSequenceIceBreaker } from "@icecore/shared/types/whatsapp";
import mongoose from "mongoose";

export interface IWhatsAppWelcomeSequence {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  sourceId?: string | null;
  wabaId: string;
  sequenceId: string;
  name: string;
  text?: string | null;
  autofillMessageContent?: string | null;
  iceBreakers?: WhatsAppWelcomeMessageSequenceIceBreaker[];
  isUsedInAd: boolean;
  metaCreatedTime?: string | null;
  metaUpdatedTime?: string | null;
  lastSyncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const WhatsAppWelcomeSequenceSchema =
  new mongoose.Schema<IWhatsAppWelcomeSequence>(
    {
      workspaceId: {
        type: String,
        required: true,
        index: true,
      },
      sourceId: {
        type: String,
        default: null,
        index: true,
      },
      wabaId: {
        type: String,
        required: true,
        index: true,
      },
      sequenceId: {
        type: String,
        required: true,
      },
      name: {
        type: String,
        required: true,
        index: true,
      },
      text: {
        type: String,
        default: null,
      },
      autofillMessageContent: {
        type: String,
        default: null,
      },
      iceBreakers: {
        type: mongoose.Schema.Types.Mixed,
        default: [],
      },
      isUsedInAd: {
        type: Boolean,
        default: false,
        index: true,
      },
      metaCreatedTime: {
        type: String,
        default: null,
      },
      metaUpdatedTime: {
        type: String,
        default: null,
      },
      lastSyncedAt: {
        type: Date,
        default: Date.now,
        index: true,
      },
    },
    { timestamps: true }
  );

WhatsAppWelcomeSequenceSchema.index(
  { workspaceId: 1, sequenceId: 1 },
  { unique: true }
);
WhatsAppWelcomeSequenceSchema.index({ workspaceId: 1, updatedAt: -1 });

export const WhatsAppWelcomeSequenceModel =
  mongoose.models.WhatsAppWelcomeSequence ||
  mongoose.model<IWhatsAppWelcomeSequence>(
    "WhatsAppWelcomeSequence",
    WhatsAppWelcomeSequenceSchema
  );
