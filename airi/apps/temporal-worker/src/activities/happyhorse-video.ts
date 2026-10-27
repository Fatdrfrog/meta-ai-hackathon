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
  HAPPYHORSE_VIDEO_ACTIVITY_CONTRACT_VERSION,
  HAPPYHORSE_VIDEO_POLL_INTERVAL_MS,
  HAPPYHORSE_VIDEO_TIMEOUT_MS,
  type HappyHorseVideoActivityResult,
  type HappyHorseVideoFailActivityInput,
  type HappyHorseVideoProcessActivityInput,
} from "@icecore/temporal";
import { ApplicationFailure, heartbeat } from "@temporalio/activity";

import { uploadGcsCreativeAssetBuffer } from "../gcs-creative-assets.js";

function validateContractVersion(value: number): void {
  assertContractVersion(
    value,
    { max: HAPPYHORSE_VIDEO_ACTIVITY_CONTRACT_VERSION },
    "HappyHorse video activity",
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
      "HappyHorseMisconfigured",
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
    `Asset ${String(asset._id || "")} does not have a public HTTP(S) URL for HappyHorse`,
    "HappyHorseMediaUrlUnavailable",
  );
}

export async function happyHorseVideoProcessActivity(
  input: HappyHorseVideoProcessActivityInput,
): Promise<HappyHorseVideoActivityResult> {
  validateContractVersion(input.contractVersion);
  const workspaceId = validateRequiredString(input.workspaceId, "workspaceId");
  const outputAssetId = validateRequiredString(
    input.outputAssetId,
    "outputAssetId",
  );
  const prompt = validateRequiredString(input.prompt, "prompt");
  const mode = input.mode;

  const [
    { default: connectDB },
    { CreativeAsset },
    { supabaseAdmin },
    { downloadAndStoreCreativeAsset },
    {
      HappyHorseApiError,
      isHappyHorseSuccessStatus,
      isHappyHorseTerminalStatus,
      pollHappyHorseTask,
      submitHappyHorseI2V,
      submitHappyHorseR2V,
      submitHappyHorseT2V,
    },
    {
      getHappyHorseDefaultRatio,
      getHappyHorseModelForMode,
      HAPPYHORSE_REFERENCE_MAX,
      HAPPYHORSE_REFERENCE_MIN,
      normalizeHappyHorseDuration,
      normalizeHappyHorseRatio,
      normalizeHappyHorseResolution,
    },
  ] = await Promise.all([
    import("@/lib/mongoose"),
    import("@/models/creative-asset"),
    import("@/lib/supabase/admin"),
    import("@/lib/higgsfield/creative-asset-storage"),
    import("@/lib/happyhorse/happyhorse-client"),
    import("@/lib/happyhorse/happyhorse-config"),
  ]);

  const usesRatio = mode === "text_to_video" || mode === "reference_to_video";

  await connectDB();

  const outputAsset = await CreativeAsset.findOne({
    _id: outputAssetId,
    workspaceId,
  }).lean();
  if (!outputAsset) {
    throw nonRetryable(
      `Output asset ${outputAssetId} not found`,
      "HappyHorseOutputMissing",
    );
  }

  const providerPayload = asRecord(
    (outputAsset as { providerPayload?: unknown }).providerPayload,
  );
  const resolution =
    normalizeHappyHorseResolution(input.resolution) ||
    normalizeHappyHorseResolution(providerPayload.resolution) ||
    "1080P";
  const duration =
    normalizeHappyHorseDuration(input.duration) ||
    normalizeHappyHorseDuration(providerPayload.duration) ||
    5;
  const ratio =
    normalizeHappyHorseRatio(input.ratio) ||
    normalizeHappyHorseRatio(providerPayload.ratio) ||
    getHappyHorseDefaultRatio();

  let submitTaskId = cleanString(
    (outputAsset as { providerRequestId?: unknown }).providerRequestId,
    200,
  );
  let lastTaskStatus = "PENDING";
  let submitRaw: unknown = providerPayload.submit || null;

  if (!submitTaskId) {
    throw nonRetryable(
      "Customer-funded HappyHorse generation is not available. Use Google AI or Higgsfield.",
      "own_ai_source_required",
    );
  }

  if (!submitTaskId) {
    heartbeat({
      phase: "submit",
      workspaceId,
      outputAssetId,
      mode,
    });

    let submit;
    let referenceAssetIds: string[] = [];
    try {
      if (mode === "text_to_video") {
        submit = await submitHappyHorseT2V({
          prompt,
          resolution,
          ratio,
          duration,
          watermark: false,
        });
      } else if (mode === "reference_to_video") {
        const fromInput = Array.isArray(input.referenceAssetIds)
          ? input.referenceAssetIds
          : [];
        const fromPayload = Array.isArray(providerPayload.referenceAssetIds)
          ? providerPayload.referenceAssetIds
          : [];
        const orderedRefs = fromInput.length > 0 ? fromInput : fromPayload;
        referenceAssetIds = orderedRefs
          .map((id) => cleanString(id, 80))
          .filter(Boolean)
          .filter((id, index, all) => all.indexOf(id) === index);
        if (
          referenceAssetIds.length < HAPPYHORSE_REFERENCE_MIN ||
          referenceAssetIds.length > HAPPYHORSE_REFERENCE_MAX
        ) {
          throw nonRetryable(
            `HappyHorse reference-to-video requires ${HAPPYHORSE_REFERENCE_MIN}–${HAPPYHORSE_REFERENCE_MAX} reference images`,
            "HappyHorseReferencesMissing",
          );
        }

        const refs = await CreativeAsset.find({
          _id: { $in: referenceAssetIds },
          workspaceId,
          kind: "image",
          status: "complete",
        }).lean();
        const byId = new Map(
          refs.map((row) => [String((row as { _id?: unknown })._id), row]),
        );
        const referenceImageUrls: string[] = [];
        for (const id of referenceAssetIds) {
          const refAsset = byId.get(id);
          if (!refAsset) {
            throw nonRetryable(
              `Completed reference image ${id} is required for HappyHorse reference-to-video`,
              "HappyHorseReferenceInvalid",
            );
          }
          referenceImageUrls.push(
            await resolveAssetHttpsUrl(
              refAsset as unknown as Record<string, unknown>,
            ),
          );
        }

        submit = await submitHappyHorseR2V({
          prompt,
          referenceImageUrls,
          resolution,
          ratio,
          duration,
          watermark: false,
        });
      } else {
        const sourceAssetId = validateRequiredString(
          input.sourceAssetId,
          "sourceAssetId",
        );
        const sourceAsset = await CreativeAsset.findOne({
          _id: sourceAssetId,
          workspaceId,
          kind: "image",
          status: "complete",
        }).lean();
        if (!sourceAsset) {
          throw nonRetryable(
            "Completed source image is required for HappyHorse image-to-video",
            "HappyHorseSourceMissing",
          );
        }
        const imageUrl = await resolveAssetHttpsUrl(
          sourceAsset as unknown as Record<string, unknown>,
        );
        submit = await submitHappyHorseI2V({
          prompt,
          imageUrl,
          resolution,
          duration,
          watermark: false,
        });
      }
    } catch (error) {
      if (error instanceof ApplicationFailure) {
        throw error;
      }
      if (error instanceof HappyHorseApiError && !error.retryable) {
        throw nonRetryable(
          error.message,
          mode === "reference_to_video"
            ? "HappyHorseR2VSubmitFailed"
            : "HappyHorseSubmitFailed",
        );
      }
      rethrowActivityError(error);
    }

    submitTaskId = submit.taskId;
    lastTaskStatus = submit.taskStatus;
    submitRaw = submit.raw;

    await CreativeAsset.findByIdAndUpdate(outputAssetId, {
      status: "in_progress",
      providerRequestId: submit.taskId,
      modelId: getHappyHorseModelForMode(mode),
      providerPayload: {
        ...providerPayload,
        mode,
        prompt,
        sourceAssetId: input.sourceAssetId || null,
        referenceAssetIds:
          mode === "reference_to_video" ? referenceAssetIds : null,
        resolution,
        ratio: usesRatio ? ratio : null,
        duration,
        submit: submit.raw,
      },
      error: null,
      updatedAt: new Date(),
    });
  }

  const startedAt = Date.now();

  while (Date.now() - startedAt < HAPPYHORSE_VIDEO_TIMEOUT_MS) {
    heartbeat({
      phase: "poll",
      workspaceId,
      outputAssetId,
      taskId: submitTaskId,
      taskStatus: lastTaskStatus,
    });

    await sleep(HAPPYHORSE_VIDEO_POLL_INTERVAL_MS);

    let poll;
    try {
      poll = await pollHappyHorseTask(submitTaskId);
    } catch (error) {
      if (error instanceof HappyHorseApiError && !error.retryable) {
        throw nonRetryable(error.message, "HappyHorsePollFailed");
      }
      rethrowActivityError(error);
    }
    lastTaskStatus = poll.taskStatus;

    if (!isHappyHorseTerminalStatus(poll.taskStatus)) {
      continue;
    }

    if (!isHappyHorseSuccessStatus(poll.taskStatus) || !poll.videoUrl) {
      const message =
        poll.errorMessage ||
        `HappyHorse task ${poll.taskStatus}${
          poll.errorCode ? ` (${poll.errorCode})` : ""
        }`;
      throw nonRetryable(message, "HappyHorseTaskFailed");
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
        mode,
        prompt,
        sourceAssetId: input.sourceAssetId || null,
        referenceAssetIds:
          mode === "reference_to_video"
            ? input.referenceAssetIds ||
              providerPayload.referenceAssetIds ||
              null
            : null,
        resolution,
        ratio: usesRatio ? ratio : null,
        duration,
        submit: submitRaw,
        poll: poll.raw,
        usage: poll.usage,
      },
      error: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    });

    airiWorkerLogger.info("airi.worker.happyhorse_video", {
      note: "generation_completed",
      workspaceId,
      outputAssetId,
      taskId: submitTaskId,
      mode,
    });

    return {
      outputAssetId,
      status: "complete",
      terminal: true,
      providerRequestId: submitTaskId,
    };
  }

  throw nonRetryable(
    "Timed out waiting for HappyHorse video generation",
    "HappyHorseTimeout",
  );
}

export async function happyHorseVideoFailActivity(
  input: HappyHorseVideoFailActivityInput,
): Promise<HappyHorseVideoActivityResult> {
  validateContractVersion(input.contractVersion);
  const workspaceId = validateRequiredString(input.workspaceId, "workspaceId");
  const outputAssetId = validateRequiredString(
    input.outputAssetId,
    "outputAssetId",
  );
  const error = cleanString(input.error, 1000) || "HappyHorse video failed";

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

  airiWorkerLogger.warn("airi.worker.happyhorse_video", {
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
