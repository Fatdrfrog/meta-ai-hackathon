import { setTimeout as sleep } from "node:timers/promises";

import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import { createCreativeAssetReadUrl } from "@icecore/airi-runtime/creative-asset-read-url";
import { resolveCreativeAssetGcsObjectRef } from "@icecore/airi-runtime/media-api";
import {
  asRecord,
  cleanString,
  requireNonEmptyString as validateRequiredString,
} from "@icecore/shared/lib/value-utils";
import {
  assertContractVersion,
  WAN_MORPH_ACTIVITY_CONTRACT_VERSION,
  WAN_MORPH_POLL_INTERVAL_MS,
  WAN_MORPH_TIMEOUT_MS,
  type WanMorphActivityResult,
  type WanMorphFailActivityInput,
  type WanMorphProcessActivityInput,
} from "@icecore/temporal";
import { ApplicationFailure, heartbeat } from "@temporalio/activity";

import { uploadGcsCreativeAssetBuffer } from "../gcs-creative-assets.js";

function validateContractVersion(value: number): void {
  assertContractVersion(
    value,
    { max: WAN_MORPH_ACTIVITY_CONTRACT_VERSION },
    "Wan morph activity",
  );
}

function nonRetryable(message: string, type: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(message, type);
}

function isNonRetryableConfigError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ALIBABA_API_|not configured/i.test(message);
}

function rethrowActivityError(error: unknown): never {
  if (error instanceof ApplicationFailure) {
    throw error;
  }
  if (isNonRetryableConfigError(error)) {
    throw nonRetryable(
      error instanceof Error ? error.message : String(error),
      "WanMorphMisconfigured",
    );
  }
  throw error;
}

async function resolveAssetHttpsUrl(
  asset: Record<string, unknown>,
): Promise<string> {
  const existingUrl = cleanString(asset.url, 4000);
  if (/^https?:\/\//i.test(existingUrl)) {
    return existingUrl;
  }

  const ref = resolveCreativeAssetGcsObjectRef({
    url: existingUrl || null,
    bucket: cleanString(asset.bucket, 200) || null,
    path: cleanString(asset.path, 1000) || null,
  });
  if (ref) {
    try {
      const signed = await createCreativeAssetReadUrl({
        provider: "gcs",
        bucket: ref.bucket,
        path: ref.path,
        workspaceId: cleanString(asset.workspaceId, 80) || undefined,
      });
      if (/^https?:\/\//i.test(signed.url)) {
        return signed.url;
      }
    } catch (error) {
      rethrowActivityError(error);
    }
  }

  throw nonRetryable(
    `Asset ${String(asset._id || "")} does not have a public HTTP(S) URL for Wan morph`,
    "WanMorphMediaUrlUnavailable",
  );
}

export async function wanMorphProcessActivity(
  input: WanMorphProcessActivityInput,
): Promise<WanMorphActivityResult> {
  validateContractVersion(input.contractVersion);
  const workspaceId = validateRequiredString(input.workspaceId, "workspaceId");
  const outputAssetId = validateRequiredString(
    input.outputAssetId,
    "outputAssetId",
  );
  const prompt = validateRequiredString(input.prompt, "prompt");
  const firstFrameAssetId = validateRequiredString(
    input.firstFrameAssetId,
    "firstFrameAssetId",
  );
  const lastFrameAssetId = validateRequiredString(
    input.lastFrameAssetId,
    "lastFrameAssetId",
  );

  const [
    { default: connectDB },
    { CreativeAsset },
    { supabaseAdmin },
    { downloadAndStoreCreativeAsset },
    {
      WanS2VApiError,
      isWanS2VSuccessStatus,
      isWanS2VTerminalStatus,
      pollWanS2VTask,
      submitWanFirstLastI2V,
    },
    { getWanI2VModel, normalizeWanS2VDuration, normalizeWanS2VResolution },
  ] = await Promise.all([
    import("@/lib/mongoose"),
    import("@/models/creative-asset"),
    import("@/lib/supabase/admin"),
    import("@/lib/higgsfield/creative-asset-storage"),
    import("@/lib/wan/wan-s2v-client"),
    import("@/lib/wan/wan-config"),
  ]);

  await connectDB();

  const outputAsset = await CreativeAsset.findOne({
    _id: outputAssetId,
    workspaceId,
  }).lean();
  if (!outputAsset) {
    throw nonRetryable(
      `Output asset ${outputAssetId} not found`,
      "WanMorphOutputMissing",
    );
  }

  const providerPayload = asRecord(
    (outputAsset as { providerPayload?: unknown }).providerPayload,
  );
  const resolution =
    normalizeWanS2VResolution(input.resolution) ||
    normalizeWanS2VResolution(providerPayload.resolution) ||
    "1080P";
  const duration =
    normalizeWanS2VDuration(input.duration) ||
    normalizeWanS2VDuration(providerPayload.duration) ||
    5;

  let submitTaskId = cleanString(
    (outputAsset as { providerRequestId?: unknown }).providerRequestId,
    200,
  );
  let lastTaskStatus = "PENDING";
  let submitRaw: unknown = providerPayload.submit || null;

  if (!submitTaskId) {
    throw nonRetryable(
      "Customer-funded Wan generation is not available. Use Google AI or Higgsfield.",
      "own_ai_source_required",
    );
  }

  if (!submitTaskId) {
    heartbeat({
      phase: "submit",
      workspaceId,
      outputAssetId,
    });

    const [firstFrame, lastFrame] = await Promise.all([
      CreativeAsset.findOne({
        _id: firstFrameAssetId,
        workspaceId,
        kind: "image",
        status: "complete",
      }).lean(),
      CreativeAsset.findOne({
        _id: lastFrameAssetId,
        workspaceId,
        kind: "image",
        status: "complete",
      }).lean(),
    ]);
    if (!firstFrame || !lastFrame) {
      throw nonRetryable(
        "Completed first and last frame images are required for Wan morph",
        "WanMorphFramesMissing",
      );
    }

    const firstFrameUrl = await resolveAssetHttpsUrl(
      firstFrame as unknown as Record<string, unknown>,
    );
    const lastFrameUrl = await resolveAssetHttpsUrl(
      lastFrame as unknown as Record<string, unknown>,
    );

    let submit;
    try {
      submit = await submitWanFirstLastI2V({
        prompt,
        firstFrameUrl,
        lastFrameUrl,
        resolution,
        duration,
        watermark: false,
      });
    } catch (error) {
      if (error instanceof WanS2VApiError && !error.retryable) {
        throw nonRetryable(error.message, "WanMorphSubmitFailed");
      }
      rethrowActivityError(error);
    }

    submitTaskId = submit.taskId;
    lastTaskStatus = submit.taskStatus;
    submitRaw = submit.raw;

    await CreativeAsset.findByIdAndUpdate(outputAssetId, {
      status: "in_progress",
      providerRequestId: submit.taskId,
      modelId: getWanI2VModel(),
      providerPayload: {
        ...providerPayload,
        mode: "first_last_frame",
        prompt,
        firstFrameAssetId,
        lastFrameAssetId,
        resolution,
        duration,
        submit: submit.raw,
      },
      error: null,
      updatedAt: new Date(),
    });
  }

  const startedAt = Date.now();

  while (Date.now() - startedAt < WAN_MORPH_TIMEOUT_MS) {
    heartbeat({
      phase: "poll",
      workspaceId,
      outputAssetId,
      taskId: submitTaskId,
      taskStatus: lastTaskStatus,
    });

    await sleep(WAN_MORPH_POLL_INTERVAL_MS);

    let poll;
    try {
      poll = await pollWanS2VTask(submitTaskId);
    } catch (error) {
      if (error instanceof WanS2VApiError && !error.retryable) {
        throw nonRetryable(error.message, "WanMorphPollFailed");
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
        `Wan morph task ${poll.taskStatus}${
          poll.errorCode ? ` (${poll.errorCode})` : ""
        }`;
      throw nonRetryable(message, "WanMorphTaskFailed");
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
        mode: "first_last_frame",
        prompt,
        firstFrameAssetId,
        lastFrameAssetId,
        resolution,
        duration,
        submit: submitRaw,
        poll: poll.raw,
        usage: poll.usage,
      },
      error: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    });

    airiWorkerLogger.info("airi.worker.wan_morph", {
      note: "generation_completed",
      workspaceId,
      outputAssetId,
      taskId: submitTaskId,
    });

    return {
      outputAssetId,
      status: "complete",
      terminal: true,
      providerRequestId: submitTaskId,
    };
  }

  throw nonRetryable(
    "Timed out waiting for Wan morph video generation",
    "WanMorphTimeout",
  );
}

export async function wanMorphFailActivity(
  input: WanMorphFailActivityInput,
): Promise<WanMorphActivityResult> {
  validateContractVersion(input.contractVersion);
  const workspaceId = validateRequiredString(input.workspaceId, "workspaceId");
  const outputAssetId = validateRequiredString(
    input.outputAssetId,
    "outputAssetId",
  );
  const error = cleanString(input.error, 1000) || "Wan morph video failed";

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

  airiWorkerLogger.warn("airi.worker.wan_morph", {
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
