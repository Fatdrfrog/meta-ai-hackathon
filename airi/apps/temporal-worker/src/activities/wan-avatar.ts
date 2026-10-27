import { setTimeout as sleep } from "node:timers/promises";

import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import {
  asRecord,
  cleanString,
  requireNonEmptyString as validateRequiredString,
} from "@icecore/shared/lib/value-utils";
import {
  assertContractVersion,
  WAN_AVATAR_ACTIVITY_CONTRACT_VERSION,
  WAN_AVATAR_POLL_INTERVAL_MS,
  WAN_AVATAR_TIMEOUT_MS,
  type WanAvatarActivityResult,
  type WanAvatarFailActivityInput,
  type WanAvatarProcessActivityInput,
} from "@icecore/temporal";
import { ApplicationFailure, heartbeat } from "@temporalio/activity";

import { uploadGcsCreativeAssetBuffer } from "../gcs-creative-assets.js";

function validateContractVersion(value: number): void {
  assertContractVersion(
    value,
    { max: WAN_AVATAR_ACTIVITY_CONTRACT_VERSION },
    "Wan avatar activity",
  );
}

function nonRetryable(message: string, type: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(message, type);
}

function isNonRetryableConfigError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /GCP_MEDIA_API_URL|VERCEL_OIDC|ALIBABA_API_|not configured/i.test(
    message,
  );
}

function rethrowActivityError(error: unknown): never {
  if (error instanceof ApplicationFailure) {
    throw error;
  }
  if (isNonRetryableConfigError(error)) {
    throw nonRetryable(
      error instanceof Error ? error.message : String(error),
      "WanAvatarMisconfigured",
    );
  }
  throw error;
}

export async function wanAvatarProcessActivity(
  input: WanAvatarProcessActivityInput,
): Promise<WanAvatarActivityResult> {
  validateContractVersion(input.contractVersion);
  const workspaceId = validateRequiredString(input.workspaceId, "workspaceId");
  const outputAssetId = validateRequiredString(
    input.outputAssetId,
    "outputAssetId",
  );
  const imageAssetId = validateRequiredString(
    input.imageAssetId,
    "imageAssetId",
  );

  const [
    { default: connectDB },
    { CreativeAsset },
    { supabaseAdmin },
    { downloadAndStoreCreativeAsset },
    {
      isWanS2VSuccessStatus,
      isWanS2VTerminalStatus,
      pollWanS2VTask,
      WanS2VApiError,
    },
  ] = await Promise.all([
    import("@/lib/mongoose"),
    import("@/models/creative-asset"),
    import("@/lib/supabase/admin"),
    import("@/lib/higgsfield/creative-asset-storage"),
    import("@/lib/wan/wan-s2v-client"),
  ]);

  await connectDB();

  const outputAsset = await CreativeAsset.findOne({
    _id: outputAssetId,
    workspaceId,
  }).lean<{
    _id: unknown;
    kind?: string;
    source?: string;
    provider?: string | null;
    status?: string;
    providerRequestId?: string | null;
    providerPayload?: unknown;
  } | null>();

  if (
    !outputAsset ||
    outputAsset.kind !== "video" ||
    outputAsset.source !== "wan" ||
    outputAsset.provider !== "wan"
  ) {
    throw nonRetryable(
      "Wan avatar output asset is missing or invalid",
      "WanAvatarOutputInvalid",
    );
  }

  if (outputAsset.status === "complete") {
    return {
      outputAssetId,
      status: "complete",
      terminal: true,
    };
  }

  if (outputAsset.status !== "queued" && outputAsset.status !== "in_progress") {
    throw nonRetryable(
      `Wan avatar output asset is not mutable (status=${outputAsset.status})`,
      "WanAvatarOutputNotMutable",
    );
  }

  const providerPayload = asRecord(outputAsset.providerPayload);
  const taskId =
    cleanString(outputAsset.providerRequestId, 200) ||
    cleanString(asRecord(providerPayload.submit).task_id, 200);
  if (!taskId) {
    throw nonRetryable(
      "Customer-funded Wan generation is not available. Use Google AI or Higgsfield.",
      "own_ai_source_required",
    );
  }

  // Existing paid tasks need only polling; inputs may have been deleted since submission.
  await CreativeAsset.findByIdAndUpdate(outputAssetId, {
    status: "in_progress",
    providerRequestId: taskId,
    error: null,
    updatedAt: new Date(),
  });
  let lastTaskStatus = "PENDING";
  const startedAt = Date.now();

  while (Date.now() - startedAt < WAN_AVATAR_TIMEOUT_MS) {
    heartbeat({
      phase: "poll",
      workspaceId,
      outputAssetId,
      taskId,
      taskStatus: lastTaskStatus,
    });

    await sleep(WAN_AVATAR_POLL_INTERVAL_MS);

    let poll;
    try {
      poll = await pollWanS2VTask(taskId);
    } catch (error) {
      if (error instanceof WanS2VApiError && !error.retryable) {
        throw nonRetryable(error.message, "WanS2VPollFailed");
      }
      rethrowActivityError(error);
    }
    lastTaskStatus = poll.taskStatus;

    if (!isWanS2VTerminalStatus(poll.taskStatus)) {
      continue;
    }

    if (!isWanS2VSuccessStatus(poll.taskStatus) || !poll.videoUrl) {
      const message =
        poll.errorMessage ||
        `Wan S2V task ${poll.taskStatus}${
          poll.errorCode ? ` (${poll.errorCode})` : ""
        }`;
      throw nonRetryable(message, "WanS2VTaskFailed");
    }

    let stored;
    try {
      stored = await downloadAndStoreCreativeAsset({
        storageClient: supabaseAdmin,
        workspaceId,
        assetId: outputAssetId,
        kind: "video",
        mediaUrl: poll.videoUrl,
        storeBuffer: async (storeInput) =>
          uploadGcsCreativeAssetBuffer(storeInput),
      });
    } catch (error) {
      rethrowActivityError(error);
    }

    await CreativeAsset.findByIdAndUpdate(outputAssetId, {
      status: "complete",
      url: stored.url,
      storageProvider: stored.storageProvider,
      bucket: stored.bucket,
      path: stored.path,
      mimeType: stored.mimeType,
      fileName: stored.fileName,
      fileSize: stored.fileSize,
      providerPayload: {
        ...providerPayload,
        mode: input.mode,
        imageAssetId,
        resolution: input.resolution,
        poll: poll.raw,
        usage: poll.usage,
      },
      error: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    });

    airiWorkerLogger.info("airi.worker.wan_avatar", {
      note: "generation_completed",
      workspaceId,
      outputAssetId,
      taskId,
      mode: input.mode,
    });

    return {
      outputAssetId,
      status: "complete",
      terminal: true,
      providerRequestId: taskId,
    };
  }

  throw nonRetryable(
    "Timed out waiting for Wan S2V talking avatar generation",
    "WanS2VTimeout",
  );
}

export async function wanAvatarFailActivity(
  input: WanAvatarFailActivityInput,
): Promise<WanAvatarActivityResult> {
  validateContractVersion(input.contractVersion);
  const workspaceId = validateRequiredString(input.workspaceId, "workspaceId");
  const outputAssetId = validateRequiredString(
    input.outputAssetId,
    "outputAssetId",
  );
  const error = cleanString(input.error, 1000) || "Wan talking avatar failed";

  const [{ default: connectDB }, { CreativeAsset }] = await Promise.all([
    import("@/lib/mongoose"),
    import("@/models/creative-asset"),
  ]);
  await connectDB();

  await CreativeAsset.findOneAndUpdate(
    {
      _id: outputAssetId,
      workspaceId,
      status: { $in: ["queued", "in_progress"] },
    },
    {
      status: "failed",
      error,
      updatedAt: new Date(),
    },
  );

  airiWorkerLogger.warn("airi.worker.wan_avatar", {
    note: "generation_failed",
    workspaceId,
    outputAssetId,
    error,
  });

  return {
    outputAssetId,
    status: "failed",
    terminal: true,
  };
}
