import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import { createCreativeAssetReadUrl } from "@icecore/airi-runtime/creative-asset-read-url";
import {
  asRecord,
  readTrimmedString as cleanString,
  requireNonEmptyString as validateRequiredString,
} from "@icecore/shared/lib/value-utils";
import {
  resolveCreativeAssetGcsObjectRef,
  type CreativeAssetStorageProvider,
} from "@icecore/airi-runtime/media-api";
import {
  assertContractVersion,
  AIRI_GREEN_SCREEN_MODEL_ID,
  CREATIVE_ASSET_EDIT_ACTIVITY_CONTRACT_VERSION,
  CREATIVE_ASSET_TIMELINE_MAX_DURATION_SECONDS,
  creativeAssetTimelineSourceKey,
  type CreativeAssetFailEditActivityInput,
  type CreativeAssetEditActivityInput,
  type CreativeAssetEditActivityResult,
} from "@icecore/temporal";
import { Context, heartbeat } from "@temporalio/activity";

import {
  type GreenScreenProcessorProgress,
  type GreenScreenProcessorResult,
} from "../media/green-screen-processor.js";
import {
  BriaGreenScreenTerminalError,
  runBriaGreenScreenProcessor,
  type BriaGreenScreenProcessorInput,
} from "../media/bria-green-screen-processor.js";
import {
  runTimelineRenderProcessor,
  TimelineRenderTerminalError,
  type TimelineRenderProcessorResult,
  type TimelineRenderProgress,
} from "../media/timeline-render-processor.js";
import {
  deleteGcsCreativeAssetObject,
  uploadGcsCreativeAssetBuffer,
  uploadGcsCreativeAssetFile,
} from "../gcs-creative-assets.js";

const TIMELINE_RENDER_SOURCE_URL_TTL_SECONDS =
  CREATIVE_ASSET_TIMELINE_MAX_DURATION_SECONDS + 60 * 60;

type LeanChain<T> = {
  lean: () => Promise<T>;
};

type AssetFindQuery = {
  _id: string;
  workspaceId?: string;
};

type AssetUpdateQuery = AssetFindQuery & {
  status?: string | { $in: string[] };
};

type AssetModel = {
  findOne: (query: AssetFindQuery) => LeanChain<Record<string, unknown> | null>;
  findOneAndUpdate: (
    query: AssetUpdateQuery,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
};

type StoreBuffer = (params: {
  storageClient: unknown;
  workspaceId: string;
  assetId: string;
  kind: "video";
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}) => Promise<{
  storageProvider: CreativeAssetStorageProvider;
  url: string;
  bucket: string;
  path: string;
  mimeType: string;
  fileName: string;
  fileSize: number;
}>;

type StoreFile = (params: {
  workspaceId: string;
  assetId: string;
  kind: "video";
  localPath: string;
  mimeType: string;
  fileName: string;
}) => Promise<{
  storageProvider: CreativeAssetStorageProvider;
  url: string;
  bucket: string;
  path: string;
  mimeType: string;
  fileName: string;
  fileSize: number;
}>;

export type ProcessCreativeAssetEditActivityDeps = {
  input: CreativeAssetEditActivityInput;
  assetModel: AssetModel;
  storageClient: unknown;
  runGreenScreenProcessor: (
    params: BriaGreenScreenProcessorInput,
  ) => Promise<GreenScreenProcessorResult>;
  storeBuffer: StoreBuffer;
  temporaryUploadId?: string;
  deleteStoredObject?: typeof deleteGcsCreativeAssetObject;
  runTimelineRenderProcessor?: typeof runTimelineRenderProcessor;
  storeFile?: StoreFile;
  heartbeat?: (details: Record<string, unknown>) => void;
  abortSignal?: AbortSignal;
  now?: () => Date;
};

class CreativeAssetEditTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreativeAssetEditTerminalError";
  }
}

function validateContractVersion(value: number): void {
  assertContractVersion(
    value,
    { max: CREATIVE_ASSET_EDIT_ACTIVITY_CONTRACT_VERSION },
    "creative asset edit",
  );
}

function resolveAssetStorageProvider(
  asset: Record<string, unknown>,
): CreativeAssetStorageProvider {
  if (asset.storageProvider === "gcs" || asset.storageProvider === "supabase") {
    return asset.storageProvider;
  }

  return cleanString(asset.url).startsWith("gcs://") ? "gcs" : "supabase";
}

async function resolveSourceMediaUrl(params: {
  asset: Record<string, unknown>;
  workspaceId: string;
  expiresInSeconds?: number;
}): Promise<string> {
  if (resolveAssetStorageProvider(params.asset) !== "gcs") {
    return cleanString(params.asset.url);
  }

  const ref = resolveCreativeAssetGcsObjectRef({
    url: cleanString(params.asset.url) || null,
    bucket: cleanString(params.asset.bucket) || null,
    path: cleanString(params.asset.path) || null,
  });
  if (!ref) {
    throw new CreativeAssetEditTerminalError(
      "Creative asset source media is missing GCS storage metadata",
    );
  }

  const { url } = await createCreativeAssetReadUrl({
    provider: "gcs",
    bucket: ref.bucket,
    path: ref.path,
    workspaceId: params.workspaceId,
    expiresInSeconds: params.expiresInSeconds,
  });
  return url;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Failed to process creative asset edit";
}

function isTerminalEditError(error: unknown): boolean {
  if (error instanceof CreativeAssetEditTerminalError) return true;
  if (error instanceof BriaGreenScreenTerminalError) return true;
  if (error instanceof TimelineRenderTerminalError) return true;
  const message = errorMessage(error);
  return (
    /^BRIA_API_TOKEN is required/i.test(message) ||
    /^Bria green-screen API supports videos up to/i.test(message) ||
    /^Bria green-screen API returned HTTP (400|403|405|413|415|422)/i.test(
      message,
    ) ||
    /^Bria green-screen status API returned HTTP (400|403|405|413|415|422)/i.test(
      message,
    ) ||
    /^Bria green-screen API failed/i.test(message) ||
    /^Unsupported source video codec for Bria green-screen edit/i.test(
      message,
    ) ||
    /Bria green-screen processing (size|limit)/i.test(message) ||
    /^FFprobe did not (find a video stream|return a usable video duration)/i.test(
      message,
    ) ||
    /^Unsupported source video codec/i.test(message) ||
    /green-screen processing (size|limit|frame|duration)/i.test(message) ||
    /Source video is too long for green-screen processing/i.test(message) ||
    /Green-screen processing .*timed out/i.test(message) ||
    /FFmpeg did not extract any video frames/i.test(message) ||
    /Matting command returned/i.test(message) ||
    /Green-screen processor produced an empty video/i.test(message) ||
    /Green-screen output exceeds creative asset size limit/i.test(message) ||
    /Source video URL must use HTTP or HTTPS/i.test(message) ||
    /Failed to download source video: HTTP 4\d\d/i.test(message)
  );
}

async function loadAsset(
  assetModel: AssetModel,
  id: string,
  workspaceId: string,
): Promise<Record<string, unknown> | null> {
  return assetModel.findOne({ _id: id, workspaceId }).lean();
}

function assertSourceMedia(
  asset: Record<string, unknown> | null,
  allowImages = false,
): asserts asset is Record<string, unknown> {
  if (
    !asset ||
    (asset.kind !== "video" && !(allowImages && asset.kind === "image")) ||
    asset.status !== "complete" ||
    !cleanString(asset.url)
  ) {
    throw new CreativeAssetEditTerminalError(
      allowImages
        ? "Timeline renders require a completed image or video asset"
        : "Creative asset edits require a completed video asset",
    );
  }
}

function assertOutputAsset(
  asset: Record<string, unknown> | null,
  sourceAssetId: string,
): asserts asset is Record<string, unknown> {
  const status = cleanString(asset?.status);
  if (
    !asset ||
    asset.kind !== "video" ||
    asset.source !== "edited" ||
    asset.provider !== "airi" ||
    (status !== "queued" && status !== "in_progress") ||
    creativeAssetTimelineSourceKey(cleanString(asset.sourceAssetId)) !==
      creativeAssetTimelineSourceKey(sourceAssetId)
  ) {
    throw new CreativeAssetEditTerminalError(
      "Green-screen output asset is not a mutable edited video",
    );
  }
}

async function updateOutputAsset(
  assetModel: AssetModel,
  workspaceId: string,
  outputAssetId: string,
  update: Record<string, unknown>,
) {
  return assetModel.findOneAndUpdate(
    {
      _id: outputAssetId,
      workspaceId,
      status: { $in: ["queued", "in_progress"] },
    },
    update,
  );
}

async function markOutputAssetFailed(params: {
  assetModel: AssetModel;
  workspaceId: string;
  outputAssetId: string;
  error: string;
  now: () => Date;
}) {
  return params.assetModel.findOneAndUpdate(
    {
      _id: params.outputAssetId,
      workspaceId: params.workspaceId,
      status: { $in: ["queued", "in_progress"] },
    },
    {
      status: "failed",
      error: params.error,
      updatedAt: params.now(),
    },
  );
}

export async function processCreativeAssetEditActivity(
  deps: ProcessCreativeAssetEditActivityDeps,
): Promise<CreativeAssetEditActivityResult> {
  const { input, assetModel, storageClient } = deps;
  const now = deps.now || (() => new Date());
  const outputAssetId = validateRequiredString(
    input.outputAssetId,
    "outputAssetId",
  );
  let workspaceId: string | null = null;
  let canUpdateOutputAsset = false;

  try {
    validateContractVersion(input.contractVersion);
    workspaceId = validateRequiredString(input.workspaceId, "workspaceId");
    const sourceAssetId = validateRequiredString(
      input.sourceAssetId,
      "sourceAssetId",
    );
    if (
      input.operation !== "green_screen" &&
      input.operation !== "timeline_render"
    ) {
      throw new Error(
        `Unsupported creative asset edit operation: ${input.operation}`,
      );
    }
    let lastProgressLogAt = 0;
    let lastProgressLogPhase = "";
    const reportProgress = (
      progress: GreenScreenProcessorProgress | TimelineRenderProgress,
    ) => {
      const heartbeatDetails = {
        workspaceId,
        sourceAssetId,
        outputAssetId,
        operation: input.operation,
        ...progress,
      };
      deps.heartbeat?.(heartbeatDetails);

      const phase = cleanString(progress.phase);
      const nowMs = Date.now();
      if (
        phase &&
        (phase !== lastProgressLogPhase || nowMs - lastProgressLogAt >= 60_000)
      ) {
        lastProgressLogPhase = phase;
        lastProgressLogAt = nowMs;
        airiWorkerLogger.info("airi.worker.creative_asset_edit.progress", {
          ...heartbeatDetails,
          note: `${input.operation}_progress`,
        });
      }
    };

    const outputAsset = await loadAsset(assetModel, outputAssetId, workspaceId);
    assertOutputAsset(outputAsset, sourceAssetId);
    canUpdateOutputAsset = true;
    const sourceAsset = await loadAsset(assetModel, sourceAssetId, workspaceId);
    assertSourceMedia(sourceAsset, input.operation === "timeline_render");
    const activeWorkspaceId = workspaceId;

    await updateOutputAsset(assetModel, workspaceId, outputAssetId, {
      status: "in_progress",
      error: null,
      updatedAt: now(),
    });

    let stored: Awaited<ReturnType<StoreBuffer>>;
    let processedProviderPayload: Record<string, unknown>;

    if (input.operation === "green_screen") {
      const processed = await deps.runGreenScreenProcessor({
        workspaceId,
        sourceAssetId,
        outputAssetId,
        sourceUrl: await resolveSourceMediaUrl({
          asset: sourceAsset,
          workspaceId,
        }),
        sourceFileName: cleanString(sourceAsset.fileName) || null,
        sourceFileSize:
          typeof sourceAsset.fileSize === "number"
            ? sourceAsset.fileSize
            : null,
        providerRequestId: cleanString(outputAsset.providerRequestId) || null,
        providerStatusUrl: cleanString(outputAsset.providerStatusUrl) || null,
        abortSignal: deps.abortSignal,
        uploadChunkSource: async (chunk) => {
          const temporaryUploadId = validateRequiredString(
            deps.temporaryUploadId,
            "temporaryUploadId",
          );
          const uploaded = await deps.storeBuffer({
            storageClient,
            workspaceId: activeWorkspaceId,
            assetId: outputAssetId,
            kind: "video",
            buffer: chunk.buffer,
            mimeType: chunk.mimeType,
            fileName: `tmp-${temporaryUploadId}-${chunk.fileName}`,
          });
          const { url } = await createCreativeAssetReadUrl({
            provider: "gcs",
            bucket: uploaded.bucket,
            path: uploaded.path,
            workspaceId: activeWorkspaceId,
          });
          return {
            url,
            bucket: uploaded.bucket,
            path: uploaded.path,
          };
        },
        deleteChunkSource: async (chunk) => {
          const bucket = cleanString(chunk.bucket);
          const path = cleanString(chunk.path);
          if (!bucket || !path) return;
          await (deps.deleteStoredObject || deleteGcsCreativeAssetObject)({
            bucket,
            path,
            workspaceId: activeWorkspaceId,
          }).catch(() => undefined);
        },
        onProviderSubmitted: async (submission) => {
          await updateOutputAsset(
            assetModel,
            activeWorkspaceId,
            outputAssetId,
            {
              providerRequestId: submission.requestId,
              providerStatusUrl: submission.statusUrl,
              providerPayload: {
                ...asRecord(outputAsset.providerPayload),
                operation: input.operation,
                provider: "bria",
                processor: "bria-video-green-screen-api",
                modelId: AIRI_GREEN_SCREEN_MODEL_ID,
                requestId: submission.requestId,
                statusUrl: submission.statusUrl,
                ...(submission.chunkIndex && submission.chunkCount
                  ? {
                      chunkIndex: submission.chunkIndex,
                      chunkCount: submission.chunkCount,
                    }
                  : {}),
                greenShade: "chroma_green",
                backgroundColor: "#00ff00",
                outputContainerAndCodec: "mp4_h264",
                preserveAudio: true,
                rawSubmitResponse: submission.raw,
              },
              updatedAt: now(),
            },
          );
        },
        ...(deps.heartbeat ? { onProgress: reportProgress } : {}),
      });

      reportProgress({ phase: "upload" });
      stored = await deps.storeBuffer({
        storageClient,
        workspaceId,
        assetId: outputAssetId,
        kind: "video",
        buffer: processed.buffer,
        mimeType: processed.mimeType,
        fileName: processed.fileName,
      });
      processedProviderPayload = processed.providerPayload;
    } else {
      if (!input.timeline) {
        throw new CreativeAssetEditTerminalError(
          "Timeline render payload is required",
        );
      }
      if (!deps.runTimelineRenderProcessor || !deps.storeFile) {
        throw new Error("Timeline renderer storage dependencies are missing");
      }

      const sourceIds = Array.from(
        new Set(
          input.timeline.clips.map((clip) =>
            creativeAssetTimelineSourceKey(clip.assetId),
          ),
        ),
      );
      const timelineSources = await Promise.all(
        sourceIds.map(async (id) => ({
          id,
          asset:
            id === creativeAssetTimelineSourceKey(sourceAssetId)
              ? sourceAsset
              : await loadAsset(assetModel, id, activeWorkspaceId),
        })),
      );
      timelineSources.forEach(({ asset }) => assertSourceMedia(asset, true));

      const rendered: TimelineRenderProcessorResult =
        await deps.runTimelineRenderProcessor({
          workspaceId: activeWorkspaceId,
          outputAssetId,
          timeline: input.timeline,
          sources: await Promise.all(
            timelineSources.map(async ({ id, asset }) => ({
              assetId: id,
              kind: asset!.kind as "image" | "video",
              url: await resolveSourceMediaUrl({
                asset: asset!,
                workspaceId: activeWorkspaceId,
                expiresInSeconds: TIMELINE_RENDER_SOURCE_URL_TTL_SECONDS,
              }),
              fileName: cleanString(asset?.fileName) || null,
            })),
          ),
          abortSignal: deps.abortSignal,
          ...(deps.heartbeat ? { onProgress: reportProgress } : {}),
        });

      try {
        reportProgress({ phase: "encode" });
        stored = await deps.storeFile({
          workspaceId,
          assetId: outputAssetId,
          kind: "video",
          localPath: rendered.outputPath,
          mimeType: rendered.mimeType,
          fileName: cleanString(outputAsset.fileName) || rendered.fileName,
        });
      } finally {
        await rendered.cleanup();
      }
      processedProviderPayload = rendered.providerPayload;
    }

    reportProgress({ phase: "uploaded" });
    const completedAt = now();
    const completedUpdate: Record<string, unknown> = {
      status: "complete",
      url: stored.url,
      storageProvider: stored.storageProvider,
      bucket: stored.bucket,
      path: stored.path,
      mimeType: stored.mimeType,
      fileName: stored.fileName,
      fileSize: stored.fileSize,
      providerPayload: {
        ...asRecord(outputAsset.providerPayload),
        ...processedProviderPayload,
      },
      error: null,
      completedAt,
      updatedAt: completedAt,
    };
    const providerRequestId = cleanString(processedProviderPayload.requestId);
    const providerStatusUrl = cleanString(processedProviderPayload.statusUrl);
    if (providerRequestId)
      completedUpdate.providerRequestId = providerRequestId;
    if (providerStatusUrl)
      completedUpdate.providerStatusUrl = providerStatusUrl;

    await updateOutputAsset(
      assetModel,
      workspaceId,
      outputAssetId,
      completedUpdate,
    );

    airiWorkerLogger.info("airi.worker.creative_asset_edit", {
      note: `${input.operation}_completed`,
      workspaceId,
      sourceAssetId,
      outputAssetId,
    });

    return { outputAssetId, status: "complete", terminal: true };
  } catch (error) {
    if (!workspaceId || !isTerminalEditError(error)) {
      throw error;
    }

    if (!canUpdateOutputAsset) {
      return { outputAssetId, status: "failed", terminal: true };
    }

    const message = errorMessage(error);
    await markOutputAssetFailed({
      assetModel,
      workspaceId,
      outputAssetId,
      error: message,
      now,
    });

    airiWorkerLogger.warn("airi.worker.creative_asset_edit", {
      note: `${input.operation}_failed`,
      outputAssetId,
      error: message,
    });

    return { outputAssetId, status: "failed", terminal: true };
  }
}

export async function failCreativeAssetEditActivity(deps: {
  input: CreativeAssetFailEditActivityInput;
  assetModel: AssetModel;
  now?: () => Date;
}): Promise<CreativeAssetEditActivityResult> {
  validateContractVersion(deps.input.contractVersion);
  const workspaceId = validateRequiredString(
    deps.input.workspaceId,
    "workspaceId",
  );
  const outputAssetId = validateRequiredString(
    deps.input.outputAssetId,
    "outputAssetId",
  );
  const message = validateRequiredString(deps.input.error, "error");
  const now = deps.now || (() => new Date());

  await markOutputAssetFailed({
    assetModel: deps.assetModel,
    workspaceId,
    outputAssetId,
    error: message,
    now,
  });

  airiWorkerLogger.warn("airi.worker.creative_asset_edit", {
    note: `${deps.input.operation || "creative_asset_edit"}_failed_after_retries`,
    workspaceId,
    outputAssetId,
    error: message,
  });

  return { outputAssetId, status: "failed", terminal: true };
}

export async function creativeAssetProcessEditActivity(
  input: CreativeAssetEditActivityInput,
): Promise<CreativeAssetEditActivityResult> {
  validateContractVersion(input.contractVersion);
  const activityContext = Context.current();
  const activityRunId = validateRequiredString(
    activityContext.info.workflowExecution?.runId ||
      activityContext.info.activityRunId,
    "activityRunId",
  );

  const [{ default: connectDB }, { CreativeAsset }] = await Promise.all([
    import("@/lib/mongoose"),
    import("@/models/creative-asset"),
  ]);

  await connectDB();
  return processCreativeAssetEditActivity({
    input,
    assetModel: CreativeAsset as AssetModel,
    storageClient: null,
    runGreenScreenProcessor: runBriaGreenScreenProcessor,
    storeBuffer: async (params) => uploadGcsCreativeAssetBuffer(params),
    temporaryUploadId: `${activityRunId}-${activityContext.info.activityId}-${activityContext.info.attempt}`,
    runTimelineRenderProcessor,
    storeFile: async (params) => uploadGcsCreativeAssetFile(params),
    heartbeat,
    abortSignal: activityContext.cancellationSignal,
  });
}

export async function creativeAssetFailEditActivity(
  input: CreativeAssetFailEditActivityInput,
): Promise<CreativeAssetEditActivityResult> {
  validateContractVersion(input.contractVersion);

  const [{ default: connectDB }, { CreativeAsset }] = await Promise.all([
    import("@/lib/mongoose"),
    import("@/models/creative-asset"),
  ]);

  await connectDB();
  return failCreativeAssetEditActivity({
    input,
    assetModel: CreativeAsset as AssetModel,
  });
}
