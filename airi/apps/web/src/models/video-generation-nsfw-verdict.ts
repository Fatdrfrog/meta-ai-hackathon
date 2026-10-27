import mongoose, { type Model } from "mongoose";

import {
  MAX_VIDEO_GENERATION_SAFETY_ANCESTOR_ID_LENGTH,
  MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_ID_LENGTH,
} from "@/lib/creative-assets/video-generation-nsfw";

export const VIDEO_GENERATION_NSFW_VERDICT_SOURCE_INDEX = {
  key: {
    workspaceId: 1,
    provider: 1,
    sourceAssetId: 1,
    sourceAttemptToken: 1,
  } as const,
  options: {
    name: "workspace_video_nsfw_source_attempt",
  },
};

export const VIDEO_GENERATION_NSFW_VERDICT_PENDING_SWEEP_INDEX = {
  key: {
    sweepCompletedAt: 1,
    firstReceivedAt: 1,
    _id: 1,
  } as const,
  options: {
    name: "video_generation_nsfw_pending_sweep",
    partialFilterExpression: {
      sweepCompletedAt: null,
    },
  },
};

export type VideoGenerationNsfwVerdictRecord = {
  _id: string;
  workspaceId: string;
  provider: "higgsfield";
  providerRequestId: string;
  verdict: "nsfw";
  sourceAssetId: string;
  sourceAttemptToken: string;
  firstReceivedAt: Date;
  lastReceivedAt: Date;
  sweepCompletedAt: Date | null;
};

const VideoGenerationNsfwVerdictSchema =
  new mongoose.Schema<VideoGenerationNsfwVerdictRecord>(
    {
      _id: { type: String, required: true, maxlength: 64 },
      workspaceId: { type: String, required: true, maxlength: 128 },
      provider: {
        type: String,
        enum: ["higgsfield"],
        required: true,
      },
      providerRequestId: {
        type: String,
        required: true,
        maxlength: MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_ID_LENGTH,
      },
      verdict: {
        type: String,
        enum: ["nsfw"],
        required: true,
      },
      sourceAssetId: {
        type: String,
        required: true,
        maxlength: MAX_VIDEO_GENERATION_SAFETY_ANCESTOR_ID_LENGTH,
      },
      sourceAttemptToken: {
        type: String,
        required: true,
        maxlength: MAX_VIDEO_GENERATION_SAFETY_ANCESTOR_ID_LENGTH,
      },
      firstReceivedAt: { type: Date, required: true },
      lastReceivedAt: { type: Date, required: true },
      sweepCompletedAt: { type: Date, default: null },
    },
    {
      collection: "video_generation_nsfw_verdicts",
      versionKey: false,
    }
  );

VideoGenerationNsfwVerdictSchema.index(
  VIDEO_GENERATION_NSFW_VERDICT_SOURCE_INDEX.key,
  { ...VIDEO_GENERATION_NSFW_VERDICT_SOURCE_INDEX.options }
);
VideoGenerationNsfwVerdictSchema.index(
  VIDEO_GENERATION_NSFW_VERDICT_PENDING_SWEEP_INDEX.key,
  {
    ...VIDEO_GENERATION_NSFW_VERDICT_PENDING_SWEEP_INDEX.options,
    partialFilterExpression: {
      ...VIDEO_GENERATION_NSFW_VERDICT_PENDING_SWEEP_INDEX.options
        .partialFilterExpression,
    },
  }
);

export const VideoGenerationNsfwVerdict =
  (mongoose.models
    .VideoGenerationNsfwVerdict as Model<VideoGenerationNsfwVerdictRecord>) ||
  mongoose.model<VideoGenerationNsfwVerdictRecord>(
    "VideoGenerationNsfwVerdict",
    VideoGenerationNsfwVerdictSchema
  );
