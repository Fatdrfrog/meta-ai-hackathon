import type { CreativeAssetTimeline } from "./timeline";
import type {
  GenerativeAIImageProvider,
  ScenarioActionAttachment,
} from "@icecore/scenario-contracts";
export {
  GENERATIVE_AI_IMAGE_MODELS,
  ELEVENLABS_GENERATIVE_AI_IMAGE_MODELS,
  isGenerativeAIImageModel,
  isGenerativeAIImageProvider,
  listGenerativeAIImageModels,
  GENERATIVE_AI_IMAGE_ASPECT_RATIOS,
  MAX_GENERATIVE_AI_REFERENCE_IMAGES,
  MAX_GENERATIVE_AI_REFERENCE_IMAGE_BYTES,
  MAX_GENERATIVE_AI_REFERENCE_TOTAL_BYTES,
  type ScenarioActionAttachment,
} from "@icecore/scenario-contracts";

export const CREATIVE_ASSET_EDIT_WORKFLOW = "creativeAssetEditWorkflow";

export const CREATIVE_ASSET_EDIT_WORKFLOW_CONTRACT_VERSION = 3;
export const CREATIVE_ASSET_EDIT_ACTIVITY_CONTRACT_VERSION = 3;

export const CREATIVE_ASSET_PROCESS_EDIT_ACTIVITY =
  "creativeAssetProcessEditActivity";

export const CREATIVE_ASSET_FAIL_EDIT_ACTIVITY =
  "creativeAssetFailEditActivity";

export const CREATIVE_ASSET_EDIT_TASK_QUEUE = "airi-media";

export const CREATIVE_IMAGE_GENERATION_WORKFLOW =
  "creativeImageGenerationWorkflow";

export const CREATIVE_IMAGE_GENERATION_TASK_QUEUE =
  CREATIVE_ASSET_EDIT_TASK_QUEUE;

export const CREATIVE_IMAGE_GENERATION_WORKFLOW_CONTRACT_VERSION = 1;

export const CREATIVE_IMAGE_GENERATION_ACTIVITY =
  "creativeImageGenerationActivity";

/**
 * Attempts the image workflow gives its activity. The activity records a
 * terminal failure itself on the last one, when nothing will retry it.
 */
export const CREATIVE_IMAGE_GENERATION_ACTIVITY_MAX_ATTEMPTS = 3;

export const ELEVENLABS_CREATIVE_TRANSCRIPTION_WORKFLOW =
  "elevenLabsCreativeTranscriptionWorkflow";

export const ELEVENLABS_CREATIVE_TRANSCRIPTION_TASK_QUEUE =
  CREATIVE_ASSET_EDIT_TASK_QUEUE;

export const ELEVENLABS_CREATIVE_TRANSCRIPTION_WORKFLOW_CONTRACT_VERSION = 1;

export const ELEVENLABS_CREATIVE_TRANSCRIPTION_SUBMIT_ACTIVITY =
  "elevenLabsCreativeTranscriptionSubmitActivity";

export const ELEVENLABS_CREATIVE_TRANSCRIPTION_COMPLETE_ACTIVITY =
  "elevenLabsCreativeTranscriptionCompleteActivity";

export const ELEVENLABS_CREATIVE_TRANSCRIPTION_FAIL_ACTIVITY =
  "elevenLabsCreativeTranscriptionFailActivity";

export const ELEVENLABS_CREATIVE_TRANSCRIPTION_COMPLETED_SIGNAL =
  "elevenLabsCreativeTranscriptionCompleted";

export const ELEVENLABS_CREATIVE_TRANSCRIPTION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export const AIRI_GREEN_SCREEN_LEGACY_MODEL_ID = "airi-green-screen-v1";
export const AIRI_GREEN_SCREEN_MODEL_ID = "airi-green-screen-bria-v1";
export const AIRI_GREEN_SCREEN_RETRY_MODEL_IDS = [
  AIRI_GREEN_SCREEN_MODEL_ID,
  AIRI_GREEN_SCREEN_LEGACY_MODEL_ID,
] as const;

export const AIRI_TIMELINE_RENDER_MODEL_ID = "airi-timeline-render-v1";

export type CreativeAssetEditOperation = "green_screen" | "timeline_render";

export type CreativeAssetEditWorkflowInput = {
  contractVersion: number;
  workspaceId: string;
  sourceAssetId: string;
  outputAssetId: string;
  operation: CreativeAssetEditOperation;
  timeline?: CreativeAssetTimeline;
};

export type CreativeAssetEditActivityInput = CreativeAssetEditWorkflowInput;

export type CreativeAssetFailEditActivityInput = {
  contractVersion: number;
  workspaceId: string;
  outputAssetId: string;
  operation?: CreativeAssetEditOperation;
  error: string;
};

export type CreativeAssetEditActivityResult = {
  outputAssetId: string;
  status: "complete" | "failed";
  terminal: true;
};

export type CreativeAssetEditWorkflowResult = CreativeAssetEditActivityResult;

export type CreativeImageGenerationProvider = GenerativeAIImageProvider;

export type CreativeImageGenerationWorkflowInput = {
  contractVersion: number;
  workspaceId: string;
  assetId: string;
  provider: CreativeImageGenerationProvider;
  providerSourceId?: string | null;
  prompt: string;
  aspectRatio?: string | null;
  modelId?: string;
  referenceImages?: ScenarioActionAttachment[];
};

export type CreativeImageGenerationActivityInput =
  CreativeImageGenerationWorkflowInput & {
    workflowId: string;
  };

export type CreativeImageGenerationActivityResult = {
  assetId: string;
  status: "complete" | "failed";
  terminal: true;
  providerRequestId?: string | null;
};

export type CreativeImageGenerationWorkflowResult =
  CreativeImageGenerationActivityResult;

export type ElevenLabsCreativeTranscriptionMode = "transcript" | "subtitles";

export type ElevenLabsCreativeTranscriptionWorkflowInput = {
  contractVersion: number;
  workspaceId: string;
  assetId: string;
  sourceAssetId: string;
  mode: ElevenLabsCreativeTranscriptionMode;
  mediaType: "audio" | "video";
  providerSourceId?: string | null;
};

export type ElevenLabsCreativeTranscriptionSubmitActivityInput =
  ElevenLabsCreativeTranscriptionWorkflowInput & {
    workflowId: string;
  };

export type ElevenLabsCreativeTranscriptionSubmitActivityResult = {
  assetId: string;
  requestId: string;
  modelId: string;
  alreadyComplete?: boolean;
};

export type ElevenLabsCreativeTranscriptionCompletedSignalInput = {
  requestId: string;
  status: "completed" | "failed";
  mode: ElevenLabsCreativeTranscriptionMode;
  webhookType: string;
  data: Record<string, unknown>;
  error?: string | null;
  receivedAt?: string | null;
};

export type ElevenLabsCreativeTranscriptionCompleteActivityInput =
  ElevenLabsCreativeTranscriptionWorkflowInput & {
    workflowId: string;
    transcription: ElevenLabsCreativeTranscriptionCompletedSignalInput;
  };

export type ElevenLabsCreativeTranscriptionFailActivityInput =
  ElevenLabsCreativeTranscriptionWorkflowInput & {
    workflowId: string;
    error: string;
    requestId?: string | null;
  };

export type ElevenLabsCreativeTranscriptionActivityResult = {
  assetId: string;
  status: "submitted" | "complete" | "failed";
  providerRequestId?: string | null;
  terminal: boolean;
};

export type ElevenLabsCreativeTranscriptionWorkflowResult =
  ElevenLabsCreativeTranscriptionActivityResult;

export function sanitizeCreativeAssetEditWorkflowIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-");
}

export function buildCreativeAssetEditWorkflowId(params: {
  outputAssetId: string;
}): string {
  const outputAssetId = sanitizeCreativeAssetEditWorkflowIdPart(
    params.outputAssetId || "asset",
  );
  return `creative-asset-edit:${outputAssetId}`;
}

export function buildCreativeImageGenerationWorkflowId(params: {
  assetId: string;
}): string {
  const assetId = sanitizeCreativeAssetEditWorkflowIdPart(
    params.assetId || "asset",
  );
  return `creative-image-generation:${assetId}`;
}

export function buildElevenLabsCreativeTranscriptionWorkflowId(params: {
  assetId: string;
}): string {
  const assetId = sanitizeCreativeAssetEditWorkflowIdPart(
    params.assetId || "asset",
  );
  return `elevenlabs-creative-transcription:${assetId}`;
}

export const WAN_AVATAR_WORKFLOW = "wanAvatarWorkflow";

export const WAN_AVATAR_WORKFLOW_CONTRACT_VERSION = 1;
export const WAN_AVATAR_ACTIVITY_CONTRACT_VERSION = 1;

export const WAN_AVATAR_PROCESS_ACTIVITY = "wanAvatarProcessActivity";
export const WAN_AVATAR_FAIL_ACTIVITY = "wanAvatarFailActivity";

export const WAN_AVATAR_TASK_QUEUE = CREATIVE_ASSET_EDIT_TASK_QUEUE;

export const WAN_AVATAR_POLL_INTERVAL_MS = 15_000;
export const WAN_AVATAR_TIMEOUT_MS = 25 * 60 * 1000;

export type WanAvatarMode = "image_audio" | "image_script";
export type WanAvatarResolution = "720P" | "1080P";

export type WanAvatarWorkflowInput = {
  contractVersion: number;
  workspaceId: string;
  outputAssetId: string;
  imageAssetId: string;
  mode: WanAvatarMode;
  audioAssetId?: string | null;
  script?: string | null;
  voiceId?: string | null;
  resolution: WanAvatarResolution;
  elevenLabsProviderSourceId?: string | null;
};

export type WanAvatarProcessActivityInput = WanAvatarWorkflowInput;

export type WanAvatarFailActivityInput = {
  contractVersion: number;
  workspaceId: string;
  outputAssetId: string;
  error: string;
};

export type WanAvatarActivityResult = {
  outputAssetId: string;
  status: "complete" | "failed";
  terminal: true;
  providerRequestId?: string | null;
};

export type WanAvatarWorkflowResult = WanAvatarActivityResult;

export function buildWanAvatarWorkflowId(params: {
  outputAssetId: string;
}): string {
  const outputAssetId = sanitizeCreativeAssetEditWorkflowIdPart(
    params.outputAssetId || "asset",
  );
  return `wan-avatar:${outputAssetId}`;
}

export const HAPPYHORSE_VIDEO_WORKFLOW = "happyHorseVideoWorkflow";

export const HAPPYHORSE_VIDEO_WORKFLOW_CONTRACT_VERSION = 2;
export const HAPPYHORSE_VIDEO_ACTIVITY_CONTRACT_VERSION = 2;

export const HAPPYHORSE_VIDEO_PROCESS_ACTIVITY =
  "happyHorseVideoProcessActivity";
export const HAPPYHORSE_VIDEO_FAIL_ACTIVITY = "happyHorseVideoFailActivity";

export const HAPPYHORSE_VIDEO_TASK_QUEUE = CREATIVE_ASSET_EDIT_TASK_QUEUE;

export const HAPPYHORSE_VIDEO_POLL_INTERVAL_MS = 15_000;
export const HAPPYHORSE_VIDEO_TIMEOUT_MS = 25 * 60 * 1000;

export type HappyHorseVideoMode =
  | "text_to_video"
  | "image_to_video"
  | "reference_to_video";
export type HappyHorseVideoResolution = "720P" | "1080P";
export type HappyHorseVideoRatio =
  | "9:16"
  | "16:9"
  | "1:1"
  | "4:3"
  | "3:4"
  | "4:5"
  | "5:4"
  | "9:21"
  | "21:9";

export type HappyHorseVideoWorkflowInput = {
  contractVersion: number;
  workspaceId: string;
  outputAssetId: string;
  mode: HappyHorseVideoMode;
  prompt: string;
  sourceAssetId?: string | null;
  /** Ordered reference image asset IDs for reference_to_video (1–9). */
  referenceAssetIds?: string[] | null;
  resolution: HappyHorseVideoResolution;
  /** Used for text_to_video and reference_to_video; i2v follows the source image aspect. */
  ratio?: HappyHorseVideoRatio | null;
  duration: number;
};

export type HappyHorseVideoProcessActivityInput = HappyHorseVideoWorkflowInput;

export type HappyHorseVideoFailActivityInput = {
  contractVersion: number;
  workspaceId: string;
  outputAssetId: string;
  error: string;
};

export type HappyHorseVideoActivityResult = {
  outputAssetId: string;
  status: "complete" | "failed";
  terminal: true;
  providerRequestId?: string | null;
};

export type HappyHorseVideoWorkflowResult = HappyHorseVideoActivityResult;

export function buildHappyHorseVideoWorkflowId(params: {
  outputAssetId: string;
}): string {
  const outputAssetId = sanitizeCreativeAssetEditWorkflowIdPart(
    params.outputAssetId || "asset",
  );
  return `happyhorse-video:${outputAssetId}`;
}

/** Wan 2.7 first+last frame morph (before/after). */
export const WAN_MORPH_WORKFLOW = "wanMorphWorkflow";

export const WAN_MORPH_WORKFLOW_CONTRACT_VERSION = 1;
export const WAN_MORPH_ACTIVITY_CONTRACT_VERSION = 1;

export const WAN_MORPH_PROCESS_ACTIVITY = "wanMorphProcessActivity";
export const WAN_MORPH_FAIL_ACTIVITY = "wanMorphFailActivity";

export const WAN_MORPH_TASK_QUEUE = CREATIVE_ASSET_EDIT_TASK_QUEUE;

export const WAN_MORPH_POLL_INTERVAL_MS = 15_000;
export const WAN_MORPH_TIMEOUT_MS = 25 * 60 * 1000;

export type WanMorphResolution = "720P" | "1080P";

export type WanMorphWorkflowInput = {
  contractVersion: number;
  workspaceId: string;
  outputAssetId: string;
  prompt: string;
  firstFrameAssetId: string;
  lastFrameAssetId: string;
  resolution: WanMorphResolution;
  duration: number;
};

export type WanMorphProcessActivityInput = WanMorphWorkflowInput;

export type WanMorphFailActivityInput = {
  contractVersion: number;
  workspaceId: string;
  outputAssetId: string;
  error: string;
};

export type WanMorphActivityResult = {
  outputAssetId: string;
  status: "complete" | "failed";
  terminal: true;
  providerRequestId?: string | null;
};

export type WanMorphWorkflowResult = WanMorphActivityResult;

export function buildWanMorphWorkflowId(params: {
  outputAssetId: string;
}): string {
  const outputAssetId = sanitizeCreativeAssetEditWorkflowIdPart(
    params.outputAssetId || "asset",
  );
  return `wan-morph:${outputAssetId}`;
}
