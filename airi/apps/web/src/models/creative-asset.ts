import mongoose from "mongoose";
import type {
  CompiledVideoPrompt,
  VideoGenerationCompletionTarget,
  VideoGenerationSpec,
  VideoPromptWarning,
} from "@icecore/temporal";
import {
  MAX_VIDEO_GENERATION_COMPLETION_TARGET_CORRELATION_ID_LENGTH,
  MAX_VIDEO_GENERATION_COMPLETION_TARGET_SIGNAL_NAME_LENGTH,
  MAX_VIDEO_GENERATION_COMPLETION_TARGET_WORKFLOW_ID_LENGTH,
  normalizeVideoGenerationCompletionTarget,
} from "@icecore/temporal";
import {
  MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_ID_LENGTH,
  MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_IDS,
  MAX_VIDEO_GENERATION_SAFETY_ANCESTOR_ID_LENGTH,
  MAX_VIDEO_GENERATION_SAFETY_ANCESTORS,
} from "@/lib/creative-assets/video-generation-nsfw";

export type CreativeAssetKind = "image" | "video" | "audio" | "text";
export type CreativeAssetSource =
  | "uploaded"
  | "higgsfield"
  | "google"
  | "elevenlabs"
  | "wan"
  | "happyhorse"
  | "alibaba"
  | "edited";
export type CreativeAssetProvider =
  | "higgsfield"
  | "google"
  | "elevenlabs"
  | "wan"
  | "happyhorse"
  | "alibaba"
  | "airi";
export type CreativeAssetStatus =
  | "queued"
  | "in_progress"
  | "complete"
  | "failed"
  | "nsfw";
export type CreativeAssetStorageProvider = "gcs" | "supabase";

export type CreativeAssetVideoGenerationResultWarning = {
  code: "duration_mismatch" | "mime_type_normalized";
  message: string;
};

export type CreativeAssetVideoGeneration = {
  contractVersion: 1;
  spec: VideoGenerationSpec;
  prompt: CompiledVideoPrompt;
  requestIdempotencyKey: string;
  retryOfAssetId: string | null;
  safetyProviderRequestIds?: string[];
  safetyAncestors?: Array<{
    assetId: string;
    attemptToken: string;
  }>;
  recoveryMode?: "provider_result" | null;
  recoverySource?: {
    assetId: string;
    attemptToken: string;
    providerRequestId: string;
    recipeFingerprint: string;
    provider: VideoGenerationSpec["provider"];
  } | null;
  recipeFingerprint: string;
  webhookSignalKeys?: string[];
  orchestration: {
    workflowId: string;
    state: "pending" | "started" | "unknown";
    startedAt: Date | null;
    completionTarget?: VideoGenerationCompletionTarget | null;
  };
  submission: {
    state:
      | "pending"
      | "dispatching"
      | "submitted"
      | "not_attempted"
      | "unknown";
    attemptToken: string;
    providerRequestId: string | null;
    submittedAt: Date | null;
  };
  result: {
    durationSeconds: number;
    width: number;
    height: number;
    mimeType: string;
    fileSize: number;
    sha256: string;
    providerUsage: Record<string, number | string> | null;
    warnings: CreativeAssetVideoGenerationResultWarning[];
    startedAt: Date | null;
    completedAt: Date;
  } | null;
  failure: {
    phase:
      | "validation"
      | "compile"
      | "submit"
      | "poll"
      | "download"
      | "probe"
      | "store";
    code: string;
    providerCode: string | null;
    message: string;
    retryable: boolean;
    submissionUncertain: boolean;
    failedAt: Date;
  } | null;
};

export interface ICreativeAsset {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  kind: CreativeAssetKind;
  source: CreativeAssetSource;
  provider?: CreativeAssetProvider | null;
  status: CreativeAssetStatus;
  prompt?: string | null;
  modelId?: string | null;
  sourceAssetId?: string | null;
  editFingerprint?: string | null;
  url?: string | null;
  storageProvider?: CreativeAssetStorageProvider | null;
  bucket?: string | null;
  path?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  sourceMedia?: {
    version: 1;
    provenanceDigest: string;
    workspaceId: string;
    conversationId: string;
    inputMessageId: string;
    whatsappMediaId: string;
    declaredMimeType: string | null;
    contentSha256: string | null;
  } | null;
  providerRequestId?: string | null;
  providerSourceId?: string | null;
  providerStatusUrl?: string | null;
  providerCancelUrl?: string | null;
  providerPayload?: unknown;
  generation?: CreativeAssetVideoGeneration | null;
  error?: string | null;
  createdBy?: string | null;
  updatedBy?: string | null;
  completedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const MAX_GENERATION_STRING_LENGTH = 5_000;
const MAX_GENERATION_CODE_LENGTH = 100;
const MAX_GENERATION_MESSAGE_LENGTH = 1_000;
const MAX_GENERATION_REFERENCE_ASSETS = 9;
const MAX_GENERATION_WARNINGS = 16;
const MAX_GENERATION_USAGE_ENTRIES = 16;
const MAX_GENERATION_WEBHOOK_SIGNAL_KEY_LENGTH = 512;
const MAX_GENERATION_WEBHOOK_SIGNAL_KEYS = 6;

function isValidVideoGenerationCompletionTarget(value: unknown): boolean {
  try {
    normalizeVideoGenerationCompletionTarget(value);
    return true;
  } catch {
    return false;
  }
}

function isFrozenVideoGenerationSpec(
  value: unknown
): value is VideoGenerationSpec {
  if (!value || typeof value !== "object") return false;

  const spec = value as Record<string, unknown>;
  const references = spec.referenceAssetIds;
  const hasSourceAsset =
    typeof spec.sourceAssetId === "string" && spec.sourceAssetId.length > 0;
  const hasNoSourceAsset = spec.sourceAssetId === null;
  const hasNoReferences = Array.isArray(references) && references.length === 0;
  const hasReferences =
    Array.isArray(references) &&
    references.length >= 1 &&
    references.length <= MAX_GENERATION_REFERENCE_ASSETS;
  const happyHorseRatio = [
    "9:16",
    "16:9",
    "1:1",
    "4:3",
    "3:4",
    "4:5",
    "5:4",
    "9:21",
    "21:9",
  ].includes(spec.aspectRatio as string);
  const happyHorseResolution =
    spec.resolution === "720P" || spec.resolution === "1080P";
  const happyHorseDuration =
    typeof spec.durationSeconds === "number" &&
    Number.isInteger(spec.durationSeconds) &&
    spec.durationSeconds >= 3 &&
    spec.durationSeconds <= 15;

  if (spec.provider === "happyhorse" && spec.mode === "text_to_video") {
    return (
      spec.skill === "video" &&
      happyHorseDuration &&
      happyHorseRatio &&
      happyHorseResolution &&
      hasNoSourceAsset &&
      hasNoReferences
    );
  }

  if (spec.provider === "happyhorse" && spec.mode === "image_to_video") {
    return (
      spec.skill === "video" &&
      happyHorseDuration &&
      spec.aspectRatio === null &&
      happyHorseResolution &&
      hasSourceAsset &&
      hasNoReferences
    );
  }

  if (spec.provider === "happyhorse" && spec.mode === "reference_to_video") {
    return (
      spec.skill === "character" &&
      happyHorseDuration &&
      happyHorseRatio &&
      happyHorseResolution &&
      hasNoSourceAsset &&
      hasReferences
    );
  }

  if (spec.provider === "higgsfield" && spec.mode === "image_to_video") {
    return (
      spec.skill === "video" &&
      typeof spec.durationSeconds === "number" &&
      Number.isInteger(spec.durationSeconds) &&
      spec.durationSeconds >= 3 &&
      spec.durationSeconds <= 8 &&
      spec.aspectRatio === null &&
      spec.resolution === "provider_default" &&
      hasSourceAsset &&
      hasNoReferences
    );
  }

  return (
    spec.provider === "google" &&
    spec.mode === "image_to_video" &&
    spec.skill === "video" &&
    (spec.durationSeconds === 4 ||
      spec.durationSeconds === 6 ||
      spec.durationSeconds === 8) &&
    (spec.aspectRatio === "9:16" || spec.aspectRatio === "16:9") &&
    spec.resolution === "720p" &&
    hasSourceAsset &&
    hasNoReferences
  );
}

const VideoPromptWarningSchema = new mongoose.Schema<VideoPromptWarning>(
  {
    code: {
      type: String,
      required: true,
      maxlength: MAX_GENERATION_CODE_LENGTH,
    },
    message: {
      type: String,
      required: true,
      maxlength: MAX_GENERATION_MESSAGE_LENGTH,
    },
  },
  { _id: false }
);

const VideoGenerationSpecSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    contractVersion: { type: Number, enum: [1], required: true },
    provider: {
      type: String,
      enum: ["happyhorse", "higgsfield", "google"],
      required: true,
    },
    mode: {
      type: String,
      enum: ["text_to_video", "image_to_video", "reference_to_video"],
      required: true,
    },
    skill: { type: String, enum: ["video", "character"], required: true },
    userPrompt: {
      type: String,
      required: true,
      maxlength: MAX_GENERATION_STRING_LENGTH,
    },
    modelId: {
      type: String,
      required: true,
      maxlength: MAX_GENERATION_STRING_LENGTH,
    },
    seed: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      validate: { validator: (value: unknown) => value === null },
    },
    durationSeconds: {
      type: Number,
      required: true,
      min: 3,
      max: 15,
      validate: { validator: Number.isInteger },
    },
    aspectRatio: {
      type: String,
      enum: [
        "9:16",
        "16:9",
        "1:1",
        "4:3",
        "3:4",
        "4:5",
        "5:4",
        "9:21",
        "21:9",
        null,
      ],
      default: null,
    },
    resolution: {
      type: String,
      enum: ["720P", "1080P", "provider_default", "720p"],
      required: true,
    },
    sourceAssetId: {
      type: String,
      default: null,
      maxlength: MAX_GENERATION_STRING_LENGTH,
    },
    referenceAssetIds: {
      type: [
        {
          type: String,
          required: true,
          maxlength: MAX_GENERATION_STRING_LENGTH,
        },
      ],
      default: [],
      validate: {
        validator: (value: string[]) =>
          Array.isArray(value) &&
          value.length <= MAX_GENERATION_REFERENCE_ASSETS,
      },
    },
  },
  { _id: false }
);

const CompiledVideoPromptSchema = new mongoose.Schema<CompiledVideoPrompt>(
  {
    compilerId: { type: String, enum: ["airi-video-director"], required: true },
    compilerVersion: { type: Number, enum: [1], required: true },
    normalizedUserPrompt: {
      type: String,
      required: true,
      maxlength: MAX_GENERATION_STRING_LENGTH,
    },
    providerPrompt: {
      type: String,
      required: true,
      maxlength: MAX_GENERATION_STRING_LENGTH,
    },
    providerPromptSha256: { type: String, required: true, maxlength: 64 },
    warnings: {
      type: [VideoPromptWarningSchema],
      default: [],
      validate: {
        validator: (value: VideoPromptWarning[]) =>
          Array.isArray(value) && value.length <= MAX_GENERATION_WARNINGS,
      },
    },
  },
  { _id: false }
);

const VideoGenerationSchema = new mongoose.Schema<CreativeAssetVideoGeneration>(
  {
    contractVersion: { type: Number, enum: [1], required: true },
    spec: {
      type: VideoGenerationSpecSchema,
      required: true,
      validate: {
        validator: isFrozenVideoGenerationSpec,
        message: "Video generation spec must match a contract-v1 variant",
      },
    },
    prompt: { type: CompiledVideoPromptSchema, required: true },
    requestIdempotencyKey: {
      type: String,
      required: true,
      maxlength: MAX_GENERATION_STRING_LENGTH,
    },
    retryOfAssetId: {
      type: String,
      default: null,
      maxlength: MAX_GENERATION_STRING_LENGTH,
    },
    safetyProviderRequestIds: {
      type: [
        {
          type: String,
          maxlength: MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_ID_LENGTH,
        },
      ],
      default: undefined,
      validate: {
        validator: (requestIds: string[] | undefined) =>
          requestIds === undefined ||
          (requestIds.length <=
            MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_IDS &&
            new Set(requestIds).size === requestIds.length),
        message: `Safety provider request lineage cannot exceed ${MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_IDS} unique entries`,
      },
    },
    safetyAncestors: {
      type: [
        new mongoose.Schema<Record<string, unknown>>(
          {
            assetId: {
              type: String,
              required: true,
              maxlength: MAX_VIDEO_GENERATION_SAFETY_ANCESTOR_ID_LENGTH,
            },
            attemptToken: {
              type: String,
              required: true,
              maxlength: MAX_VIDEO_GENERATION_SAFETY_ANCESTOR_ID_LENGTH,
            },
          },
          { _id: false, versionKey: false }
        ),
      ],
      default: undefined,
      validate: {
        validator: (
          ancestors:
            | Array<{ assetId: string; attemptToken: string }>
            | undefined
        ) =>
          ancestors === undefined ||
          (ancestors.length <= MAX_VIDEO_GENERATION_SAFETY_ANCESTORS &&
            new Set(
              ancestors.map(
                ancestor => `${ancestor.assetId}\u0000${ancestor.attemptToken}`
              )
            ).size === ancestors.length),
        message: `Safety ancestor lineage cannot exceed ${MAX_VIDEO_GENERATION_SAFETY_ANCESTORS} unique entries`,
      },
    },
    recoveryMode: {
      type: String,
      enum: ["provider_result", null],
      default: null,
    },
    recoverySource: {
      type: new mongoose.Schema<Record<string, unknown>>(
        {
          assetId: {
            type: String,
            required: true,
            maxlength: MAX_GENERATION_STRING_LENGTH,
          },
          attemptToken: {
            type: String,
            required: true,
            maxlength: MAX_GENERATION_STRING_LENGTH,
          },
          providerRequestId: {
            type: String,
            required: true,
            maxlength: MAX_GENERATION_STRING_LENGTH,
          },
          recipeFingerprint: {
            type: String,
            required: true,
            maxlength: 64,
            validate: {
              validator: (value: string) => /^[a-f0-9]{64}$/.test(value),
            },
          },
          provider: {
            type: String,
            required: true,
            enum: ["happyhorse", "higgsfield", "google"],
          },
        },
        { _id: false }
      ),
      default: null,
    },
    recipeFingerprint: {
      type: String,
      required: true,
      maxlength: MAX_GENERATION_STRING_LENGTH,
    },
    webhookSignalKeys: {
      type: [
        {
          type: String,
          maxlength: MAX_GENERATION_WEBHOOK_SIGNAL_KEY_LENGTH,
        },
      ],
      default: [],
      validate: {
        validator: (keys: string[]) =>
          keys.length <= MAX_GENERATION_WEBHOOK_SIGNAL_KEYS,
        message: `Webhook signal history cannot exceed ${MAX_GENERATION_WEBHOOK_SIGNAL_KEYS} entries`,
      },
    },
    orchestration: {
      workflowId: {
        type: String,
        required: true,
        maxlength: MAX_GENERATION_STRING_LENGTH,
      },
      state: {
        type: String,
        enum: ["pending", "started", "unknown"],
        required: true,
      },
      startedAt: { type: Date, default: null },
      completionTarget: {
        type: new mongoose.Schema<Record<string, unknown>>(
          {
            workflowId: {
              type: String,
              required: true,
              maxlength:
                MAX_VIDEO_GENERATION_COMPLETION_TARGET_WORKFLOW_ID_LENGTH,
            },
            signalName: {
              type: String,
              required: true,
              maxlength:
                MAX_VIDEO_GENERATION_COMPLETION_TARGET_SIGNAL_NAME_LENGTH,
            },
            correlationId: {
              type: String,
              required: true,
              maxlength:
                MAX_VIDEO_GENERATION_COMPLETION_TARGET_CORRELATION_ID_LENGTH,
            },
          },
          { _id: false }
        ),
        default: null,
        validate: {
          validator: isValidVideoGenerationCompletionTarget,
          message:
            "Video generation completion target must be bounded and trimmed",
        },
      },
    },
    submission: {
      state: {
        type: String,
        enum: [
          "pending",
          "dispatching",
          "submitted",
          "not_attempted",
          "unknown",
        ],
        required: true,
      },
      attemptToken: {
        type: String,
        required: true,
        maxlength: MAX_GENERATION_STRING_LENGTH,
      },
      providerRequestId: {
        type: String,
        default: null,
        maxlength: MAX_GENERATION_STRING_LENGTH,
      },
      submittedAt: { type: Date, default: null },
    },
    result: {
      type: new mongoose.Schema<Record<string, unknown>>(
        {
          durationSeconds: { type: Number, required: true, min: 0 },
          width: { type: Number, required: true, min: 1 },
          height: { type: Number, required: true, min: 1 },
          mimeType: { type: String, required: true, maxlength: 100 },
          fileSize: { type: Number, required: true, min: 0 },
          sha256: { type: String, required: true, maxlength: 64 },
          providerUsage: {
            type: Map,
            of: mongoose.Schema.Types.Mixed,
            default: null,
            validate: {
              validator: (value: unknown) => {
                if (value === null) return true;
                const entries =
                  value instanceof Map
                    ? [...value.entries()]
                    : Object.entries(value as object);
                return (
                  entries.length <= MAX_GENERATION_USAGE_ENTRIES &&
                  entries.every(
                    ([key, usage]) =>
                      key.length <= 64 &&
                      (typeof usage === "number"
                        ? Number.isFinite(usage)
                        : typeof usage === "string" && usage.length <= 256)
                  )
                );
              },
            },
          },
          warnings: {
            type: [
              new mongoose.Schema<Record<string, unknown>>(
                {
                  code: {
                    type: String,
                    enum: ["duration_mismatch", "mime_type_normalized"],
                    required: true,
                  },
                  message: {
                    type: String,
                    required: true,
                    maxlength: MAX_GENERATION_MESSAGE_LENGTH,
                  },
                },
                { _id: false }
              ),
            ],
            default: [],
            validate: {
              validator: (value: unknown[]) =>
                Array.isArray(value) && value.length <= MAX_GENERATION_WARNINGS,
            },
          },
          startedAt: { type: Date, default: null },
          completedAt: { type: Date, required: true },
        },
        { _id: false }
      ),
      default: null,
    },
    failure: {
      type: new mongoose.Schema<Record<string, unknown>>(
        {
          phase: {
            type: String,
            enum: [
              "validation",
              "compile",
              "submit",
              "poll",
              "download",
              "probe",
              "store",
            ],
            required: true,
          },
          code: {
            type: String,
            required: true,
            maxlength: MAX_GENERATION_CODE_LENGTH,
          },
          providerCode: {
            type: String,
            default: null,
            maxlength: MAX_GENERATION_CODE_LENGTH,
          },
          message: {
            type: String,
            required: true,
            maxlength: MAX_GENERATION_MESSAGE_LENGTH,
          },
          retryable: { type: Boolean, required: true },
          submissionUncertain: { type: Boolean, required: true },
          failedAt: { type: Date, required: true },
        },
        { _id: false }
      ),
      default: null,
    },
  },
  { _id: false }
);

export const CREATIVE_ASSET_PLATFORM_QUOTA_LEGACY_INDEX_NAME =
  "workspace_platform_creative_generation_quota";

export const CREATIVE_ASSET_PLATFORM_QUOTA_INDEX = {
  key: {
    workspaceId: 1,
    "generation.recoveryMode": 1,
    provider: 1,
    status: 1,
    providerSourceId: 1,
  } as const,
  options: {
    name: "workspace_platform_creative_generation_quota_v2",
    partialFilterExpression: {
      provider: { $in: ["google", "elevenlabs"] },
      status: { $in: ["queued", "in_progress", "complete", "nsfw"] },
    },
  },
};

export const CREATIVE_ASSET_VIDEO_IDEMPOTENCY_INDEX = {
  key: { workspaceId: 1, "generation.requestIdempotencyKey": 1 } as const,
  options: {
    name: "workspace_video_generation_idempotency",
    unique: true,
    partialFilterExpression: {
      "generation.requestIdempotencyKey": { $type: "string" },
    },
  },
};

export const CREATIVE_ASSET_VIDEO_SAFETY_ALIAS_INDEX = {
  key: {
    workspaceId: 1,
    "generation.safetyProviderRequestIds": 1,
  } as const,
  options: {
    name: "workspace_video_generation_safety_alias",
    partialFilterExpression: {
      "generation.contractVersion": 1,
      "generation.spec.provider": "higgsfield",
      "generation.safetyProviderRequestIds": { $exists: true },
    },
  },
};

export const CREATIVE_ASSET_VIDEO_SAFETY_ANCESTOR_INDEX = {
  key: {
    workspaceId: 1,
    "generation.safetyAncestors.assetId": 1,
    "generation.safetyAncestors.attemptToken": 1,
  } as const,
  options: {
    name: "workspace_video_generation_safety_ancestor",
    partialFilterExpression: {
      "generation.contractVersion": 1,
      "generation.spec.provider": "higgsfield",
      "generation.safetyAncestors": { $exists: true },
    },
  },
};

export const CREATIVE_ASSET_VIDEO_ORCHESTRATION_LEGACY_INDEX_NAME =
  "video_generation_orchestration_reconcile";

export const CREATIVE_ASSET_VIDEO_ORCHESTRATION_INDEX = {
  key: { "generation.orchestration.state": 1, updatedAt: 1, _id: 1 } as const,
  options: {
    name: "video_generation_orchestration_reconcile_v2",
    partialFilterExpression: {
      status: { $in: ["queued", "in_progress"] },
      "generation.contractVersion": 1,
      "generation.orchestration.state": {
        $in: ["pending", "unknown", "started"],
      },
    },
  },
};

export const CREATIVE_ASSET_VIDEO_NSFW_CLEANUP_INDEX = {
  key: { updatedAt: 1, _id: 1 } as const,
  options: {
    name: "video_generation_nsfw_storage_cleanup",
    partialFilterExpression: {
      kind: "video",
      status: "nsfw",
      storageProvider: "gcs",
      workspaceId: { $type: "string" },
      bucket: { $type: "string" },
      path: { $type: "string" },
      "generation.contractVersion": 1,
      "generation.submission.attemptToken": { $type: "string" },
    },
  },
};

const CreativeAssetSchema = new mongoose.Schema<ICreativeAsset>(
  {
    workspaceId: { type: String, required: true, index: true },
    kind: {
      type: String,
      enum: ["image", "video", "audio", "text"],
      required: true,
      index: true,
    },
    source: {
      type: String,
      enum: [
        "uploaded",
        "higgsfield",
        "google",
        "elevenlabs",
        "wan",
        "happyhorse",
        "alibaba",
        "edited",
      ],
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: [
        "higgsfield",
        "google",
        "elevenlabs",
        "wan",
        "happyhorse",
        "alibaba",
        "airi",
      ],
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: ["queued", "in_progress", "complete", "failed", "nsfw"],
      required: true,
      index: true,
    },
    prompt: { type: String, default: null },
    modelId: { type: String, default: null },
    sourceAssetId: { type: String, default: null, index: true },
    editFingerprint: { type: String, default: null },
    url: { type: String, default: null },
    storageProvider: {
      type: String,
      enum: ["gcs", "supabase"],
      default: null,
      index: true,
    },
    bucket: { type: String, default: null },
    path: { type: String, default: null },
    mimeType: { type: String, default: null },
    fileName: { type: String, default: null },
    fileSize: { type: Number, default: null },
    sourceMedia: {
      type: new mongoose.Schema<Record<string, unknown>>(
        {
          version: { type: Number, enum: [1], required: true },
          provenanceDigest: { type: String, required: true },
          workspaceId: { type: String, required: true },
          conversationId: { type: String, required: true },
          inputMessageId: { type: String, required: true },
          whatsappMediaId: { type: String, required: true },
          declaredMimeType: { type: String, default: null },
          contentSha256: { type: String, default: null },
        },
        { _id: false }
      ),
      default: null,
    },
    providerRequestId: { type: String, default: null, index: true },
    providerSourceId: { type: String, default: null, index: true },
    providerStatusUrl: { type: String, default: null },
    providerCancelUrl: { type: String, default: null },
    providerPayload: { type: mongoose.Schema.Types.Mixed, default: null },
    generation: { type: VideoGenerationSchema, default: null },
    error: { type: String, default: null },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

CreativeAssetSchema.index({ workspaceId: 1, createdAt: -1 });
CreativeAssetSchema.index({ workspaceId: 1, status: 1, updatedAt: -1 });
CreativeAssetSchema.index({ workspaceId: 1, providerRequestId: 1 });
CreativeAssetSchema.index(
  {
    workspaceId: 1,
    editFingerprint: 1,
    status: 1,
  },
  {
    unique: true,
    partialFilterExpression: { editFingerprint: { $type: "string" } },
  }
);
CreativeAssetSchema.index({
  workspaceId: 1,
  storageProvider: 1,
  bucket: 1,
  path: 1,
});
CreativeAssetSchema.index(CREATIVE_ASSET_PLATFORM_QUOTA_INDEX.key, {
  ...CREATIVE_ASSET_PLATFORM_QUOTA_INDEX.options,
});
CreativeAssetSchema.index(CREATIVE_ASSET_VIDEO_IDEMPOTENCY_INDEX.key, {
  ...CREATIVE_ASSET_VIDEO_IDEMPOTENCY_INDEX.options,
});
CreativeAssetSchema.index(CREATIVE_ASSET_VIDEO_SAFETY_ALIAS_INDEX.key, {
  ...CREATIVE_ASSET_VIDEO_SAFETY_ALIAS_INDEX.options,
});
CreativeAssetSchema.index(CREATIVE_ASSET_VIDEO_SAFETY_ANCESTOR_INDEX.key, {
  ...CREATIVE_ASSET_VIDEO_SAFETY_ANCESTOR_INDEX.options,
});
CreativeAssetSchema.index(CREATIVE_ASSET_VIDEO_ORCHESTRATION_INDEX.key, {
  ...CREATIVE_ASSET_VIDEO_ORCHESTRATION_INDEX.options,
});
CreativeAssetSchema.index(CREATIVE_ASSET_VIDEO_NSFW_CLEANUP_INDEX.key, {
  ...CREATIVE_ASSET_VIDEO_NSFW_CLEANUP_INDEX.options,
});

export const CreativeAsset =
  mongoose.models.CreativeAsset ||
  mongoose.model<ICreativeAsset>("CreativeAsset", CreativeAssetSchema);
