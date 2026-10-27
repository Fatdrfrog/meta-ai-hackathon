export const VIDEO_GENERATION_WORKFLOW = "videoGenerationWorkflow";
export const VIDEO_GENERATION_WORKFLOW_CONTRACT_VERSION = 1;
export const VIDEO_GENERATION_SUBMIT_ACTIVITY = "videoGenerationSubmitActivity";
export const VIDEO_GENERATION_POLL_ACTIVITY = "videoGenerationPollActivity";
export const VIDEO_GENERATION_FINALIZE_ACTIVITY =
  "videoGenerationFinalizeActivity";
export const VIDEO_GENERATION_FAIL_ACTIVITY = "videoGenerationFailActivity";
export const VIDEO_GENERATION_STATUS_SIGNAL = "videoGenerationStatus";

export const MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_IDS = 16;
export const MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_ID_LENGTH = 500;
export const MAX_VIDEO_GENERATION_SAFETY_ANCESTORS = 16;
export const MAX_VIDEO_GENERATION_SAFETY_ANCESTOR_ID_LENGTH = 128;
export const MAX_VIDEO_GENERATION_COMPLETION_TARGET_WORKFLOW_ID_LENGTH = 512;
export const MAX_VIDEO_GENERATION_COMPLETION_TARGET_SIGNAL_NAME_LENGTH = 128;
export const MAX_VIDEO_GENERATION_COMPLETION_TARGET_CORRELATION_ID_LENGTH = 128;
export const MAX_VIDEO_GENERATION_COMPLETION_RESULT_ASSET_ID_LENGTH = 128;
export const MAX_VIDEO_GENERATION_COMPLETION_RESULT_ATTEMPT_TOKEN_LENGTH = 128;
export const MAX_VIDEO_GENERATION_COMPLETION_RESULT_CODE_LENGTH = 100;

export type VideoGenerationCompletionTarget = {
  workflowId: string;
  signalName: string;
  correlationId: string;
};

export function normalizeVideoGenerationCompletionTarget(
  value: unknown,
): VideoGenerationCompletionTarget | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Video generation completion target must be an object");
  }
  const target = value as Record<string, unknown>;
  return {
    workflowId: normalizeBoundedExactString(
      target.workflowId,
      "Video generation completion target",
      "workflowId",
      MAX_VIDEO_GENERATION_COMPLETION_TARGET_WORKFLOW_ID_LENGTH,
    ),
    signalName: normalizeBoundedExactString(
      target.signalName,
      "Video generation completion target",
      "signalName",
      MAX_VIDEO_GENERATION_COMPLETION_TARGET_SIGNAL_NAME_LENGTH,
    ),
    correlationId: normalizeBoundedExactString(
      target.correlationId,
      "Video generation completion target",
      "correlationId",
      MAX_VIDEO_GENERATION_COMPLETION_TARGET_CORRELATION_ID_LENGTH,
    ),
  };
}

function normalizeBoundedExactString(
  value: unknown,
  owner: string,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.length > maxLength
  ) {
    throw new Error(
      `${owner} ${field} must be non-empty, trimmed, and at most ${maxLength} characters`,
    );
  }
  return value;
}

export type VideoGenerationCompletionResult = {
  contractVersion: 1;
  correlationId: string;
  assetId: string;
  attemptToken: string;
  terminal: "complete" | "failed" | "unsafe" | "timeout";
  code: string;
};

export function isVideoGenerationCompletionCode(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_VIDEO_GENERATION_COMPLETION_RESULT_CODE_LENGTH &&
    /^[a-z0-9_]+$/.test(value)
  );
}

const VIDEO_GENERATION_COMPLETION_RESULT_FIELDS = new Set([
  "contractVersion",
  "correlationId",
  "assetId",
  "attemptToken",
  "terminal",
  "code",
]);

export function normalizeVideoGenerationCompletionResult(
  value: unknown,
): VideoGenerationCompletionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Video generation completion result must be an object");
  }
  const result = value as Record<string, unknown>;
  const fields = Object.keys(result);
  if (
    fields.length !== VIDEO_GENERATION_COMPLETION_RESULT_FIELDS.size ||
    fields.some(
      (field) => !VIDEO_GENERATION_COMPLETION_RESULT_FIELDS.has(field),
    )
  ) {
    throw new Error(
      "Video generation completion result fields are not allowlisted",
    );
  }
  if (result.contractVersion !== 1) {
    throw new Error(
      "Video generation completion result contractVersion must be 1",
    );
  }
  const terminal = result.terminal;
  if (
    terminal !== "complete" &&
    terminal !== "failed" &&
    terminal !== "unsafe" &&
    terminal !== "timeout"
  ) {
    throw new Error("Video generation completion result terminal is invalid");
  }
  if (!isVideoGenerationCompletionCode(result.code)) {
    throw new Error(
      `Video generation completion result code must be a non-empty lowercase safe token of at most ${MAX_VIDEO_GENERATION_COMPLETION_RESULT_CODE_LENGTH} characters`,
    );
  }
  return {
    contractVersion: 1,
    correlationId: normalizeBoundedExactString(
      result.correlationId,
      "Video generation completion result",
      "correlationId",
      MAX_VIDEO_GENERATION_COMPLETION_TARGET_CORRELATION_ID_LENGTH,
    ),
    assetId: normalizeBoundedExactString(
      result.assetId,
      "Video generation completion result",
      "assetId",
      MAX_VIDEO_GENERATION_COMPLETION_RESULT_ASSET_ID_LENGTH,
    ),
    attemptToken: normalizeBoundedExactString(
      result.attemptToken,
      "Video generation completion result",
      "attemptToken",
      MAX_VIDEO_GENERATION_COMPLETION_RESULT_ATTEMPT_TOKEN_LENGTH,
    ),
    terminal,
    code: result.code,
  };
}

export type VideoGenerationSafetyAncestor = {
  assetId: string;
  attemptToken: string;
};

export const VIDEO_GENERATION_POLL_POLICIES = {
  happyhorse: {
    intervalMs: 15_000,
    maxPolls: 100,
    deadlineMs: 25 * 60_000,
    continueAsNewEvery: null,
  },
  google: {
    intervalMs: 10_000,
    maxPolls: 180,
    deadlineMs: 30 * 60_000,
    continueAsNewEvery: null,
  },
  higgsfield: {
    intervalMs: 5 * 60_000,
    maxPolls: 288,
    deadlineMs: 24 * 60 * 60_000,
    continueAsNewEvery: 100,
  },
} as const;

export type HappyHorseVideoGenerationRatio =
  | "9:16"
  | "16:9"
  | "1:1"
  | "4:3"
  | "3:4"
  | "4:5"
  | "5:4"
  | "9:21"
  | "21:9";

type VideoGenerationBase = {
  contractVersion: 1;
  userPrompt: string;
  modelId: string;
  seed: null;
};

export type VideoGenerationSpec =
  | (VideoGenerationBase & {
      provider: "happyhorse";
      mode: "text_to_video";
      skill: "video";
      durationSeconds: number;
      aspectRatio: HappyHorseVideoGenerationRatio;
      resolution: "720P" | "1080P";
      sourceAssetId: null;
      referenceAssetIds: [];
    })
  | (VideoGenerationBase & {
      provider: "happyhorse";
      mode: "image_to_video";
      skill: "video";
      durationSeconds: number;
      aspectRatio: null;
      resolution: "720P" | "1080P";
      sourceAssetId: string;
      referenceAssetIds: [];
    })
  | (VideoGenerationBase & {
      provider: "happyhorse";
      mode: "reference_to_video";
      skill: "character";
      durationSeconds: number;
      aspectRatio: HappyHorseVideoGenerationRatio;
      resolution: "720P" | "1080P";
      sourceAssetId: null;
      referenceAssetIds: [string, ...string[]];
    })
  | (VideoGenerationBase & {
      provider: "higgsfield";
      mode: "image_to_video";
      skill: "video";
      durationSeconds: number;
      aspectRatio: null;
      resolution: "provider_default";
      sourceAssetId: string;
      referenceAssetIds: [];
    })
  | (VideoGenerationBase & {
      provider: "google";
      mode: "image_to_video";
      skill: "video";
      durationSeconds: 4 | 6 | 8;
      aspectRatio: "9:16" | "16:9";
      resolution: "720p";
      sourceAssetId: string;
      referenceAssetIds: [];
    });

export type VideoPromptWarning = {
  code: string;
  message: string;
};

export type CompiledVideoPrompt = {
  compilerId: "airi-video-director";
  compilerVersion: 1;
  normalizedUserPrompt: string;
  providerPrompt: string;
  providerPromptSha256: string;
  warnings: VideoPromptWarning[];
};

export type VideoGenerationWorkflowInput = {
  contractVersion: 1;
  workspaceId: string;
  assetId: string;
  attemptToken: string;
  spec: VideoGenerationSpec;
  prompt: CompiledVideoPrompt;
  providerSourceId: string | null;
  mediaTaskQueue: string;
  completionTarget?: VideoGenerationCompletionTarget | null;
  resume?: {
    providerRequestId: string;
    providerRequestLocator: string;
    pollCount: number;
    elapsedMs: number;
  } | null;
};

export type VideoGenerationStatusSignal = {
  contractVersion: 1;
  assetId: string;
  providerRequestId: string;
  status:
    | "queued"
    | "in_progress"
    | "completed"
    | "failed"
    | "nsfw"
    | "cancelled";
  receivedAt: string;
};

export type VideoGenerationActivityResult = {
  contractVersion: 1;
  assetId: string;
  attemptToken: string;
  status: "queued" | "in_progress" | "complete" | "failed" | "nsfw";
  terminal: boolean;
  providerRequestId: string | null;
  providerRequestLocator: string | null;
  providerStatus:
    | "queued"
    | "in_progress"
    | "completed"
    | "failed"
    | "nsfw"
    | "cancelled"
    | null;
  submissionState:
    | "pending"
    | "dispatching"
    | "submitted"
    | "not_attempted"
    | "unknown";
};

export type VideoGenerationPollPolicy =
  (typeof VIDEO_GENERATION_POLL_POLICIES)[keyof typeof VIDEO_GENERATION_POLL_POLICIES];

export type VideoGenerationTerminalProviderStatus =
  | "completed"
  | "failed"
  | "nsfw"
  | "cancelled";

export function resolveVideoGenerationPollPolicy(
  provider: unknown,
): VideoGenerationPollPolicy | null {
  if (provider === "happyhorse")
    return VIDEO_GENERATION_POLL_POLICIES.happyhorse;
  if (provider === "google") return VIDEO_GENERATION_POLL_POLICIES.google;
  if (provider === "higgsfield")
    return VIDEO_GENERATION_POLL_POLICIES.higgsfield;
  return null;
}

export function selectVideoGenerationTerminalStatus(
  statuses: ReadonlyArray<
    VideoGenerationActivityResult["providerStatus"] | undefined
  >,
): VideoGenerationTerminalProviderStatus | null {
  if (statuses.includes("nsfw")) return "nsfw";
  if (statuses.includes("completed")) return "completed";
  if (statuses.includes("cancelled")) return "cancelled";
  if (statuses.includes("failed")) return "failed";
  return null;
}

export function selectVideoGenerationWebhookTerminalStatus(params: {
  providerRequestId: string;
  webhookSignalKeys: ReadonlyArray<string>;
}): VideoGenerationTerminalProviderStatus | null {
  return selectVideoGenerationTerminalStatus(
    (["nsfw", "completed", "cancelled", "failed"] as const).filter((status) =>
      params.webhookSignalKeys.includes(
        `${params.providerRequestId}:${status}`,
      ),
    ),
  );
}

export function selectVideoGenerationSettledStatus(params: {
  signalStatuses: ReadonlyArray<VideoGenerationStatusSignal["status"]>;
  pollResult: Pick<
    VideoGenerationActivityResult,
    "status" | "terminal" | "providerStatus"
  > | null;
}): VideoGenerationTerminalProviderStatus | null {
  const resultStatus =
    params.pollResult?.status === "complete"
      ? "completed"
      : params.pollResult?.status === "nsfw"
        ? "nsfw"
        : params.pollResult?.terminal && params.pollResult.status === "failed"
          ? "failed"
          : undefined;
  return selectVideoGenerationTerminalStatus([
    ...params.signalStatuses,
    params.pollResult?.providerStatus,
    resultStatus,
  ]);
}

export function buildVideoGenerationWorkflowId(params: {
  assetId: string;
}): string {
  const assetId = (params.assetId || "asset").replace(/[^A-Za-z0-9._-]+/g, "-");
  return `video-generation:${assetId}`;
}
