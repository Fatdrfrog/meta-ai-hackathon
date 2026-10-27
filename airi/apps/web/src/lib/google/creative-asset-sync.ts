import "server-only";

import {
  downloadGoogleVideoResult,
  extractGoogleVideoResult,
  pollGoogleVideoOperation,
} from "@/lib/google/creative-assets";
import {
  storeCreativeAssetBuffer,
  type CreativeAssetStorageClient,
} from "@/lib/higgsfield/creative-asset-storage";
import { CreativeAsset, type ICreativeAsset } from "@/models/creative-asset";

type SyncableGoogleAsset = Omit<
  Pick<
    Partial<ICreativeAsset>,
    | "_id"
    | "workspaceId"
    | "kind"
    | "provider"
    | "status"
    | "providerSourceId"
    | "providerRequestId"
    | "updatedAt"
  >,
  "_id" | "updatedAt"
> & {
  _id?: unknown;
  updatedAt?: unknown;
  generation?: { contractVersion?: number } | null;
};

const GOOGLE_VIDEO_POLL_THROTTLE_MS = 10_000;

function assetId(asset: SyncableGoogleAsset): string {
  return String(asset._id || "");
}

function shouldPollGoogleVideoAsset(asset: SyncableGoogleAsset): boolean {
  if (asset.generation?.contractVersion === 1) return false;
  if (asset.provider !== "google") return false;
  if (asset.kind !== "video") return false;
  if (asset.status !== "queued" && asset.status !== "in_progress") {
    return false;
  }
  if (!asset.providerRequestId) return false;

  const updatedAt =
    asset.updatedAt instanceof Date ? asset.updatedAt.getTime() : 0;
  return !updatedAt || Date.now() - updatedAt >= GOOGLE_VIDEO_POLL_THROTTLE_MS;
}

export async function syncGoogleCreativeAsset(params: {
  storageClient: CreativeAssetStorageClient;
  asset: SyncableGoogleAsset;
}): Promise<void> {
  if (!shouldPollGoogleVideoAsset(params.asset)) return;

  const id = assetId(params.asset);
  const workspaceId = String(params.asset.workspaceId || "");
  const operationName = String(params.asset.providerRequestId || "");
  if (!id || !workspaceId || !operationName) return;

  const { resolveGoogleCreativeWorkerApiKey } = await import(
    "./creative-credentials"
  );
  const apiKey = await resolveGoogleCreativeWorkerApiKey({
    workspaceId,
    providerSourceId: params.asset.providerSourceId,
    allowLegacyPlatform: true,
  });
  const operation = await pollGoogleVideoOperation(operationName, apiKey);
  if (operation.error) {
    await CreativeAsset.findByIdAndUpdate(id, {
      status: "failed",
      providerPayload: operation.raw,
      error: JSON.stringify(operation.error),
      updatedAt: new Date(),
    });
    return;
  }

  if (!operation.done) {
    await CreativeAsset.findByIdAndUpdate(id, {
      status: "in_progress",
      providerPayload: operation.raw,
      updatedAt: new Date(),
    });
    return;
  }

  const result = extractGoogleVideoResult(operation.response);
  if (!result) {
    await CreativeAsset.findByIdAndUpdate(id, {
      status: "failed",
      providerPayload: operation.raw,
      error: "Completed Google video operation did not include a video result",
      updatedAt: new Date(),
    });
    return;
  }

  try {
    const media = await downloadGoogleVideoResult(result, apiKey);
    const stored = await storeCreativeAssetBuffer({
      storageClient: params.storageClient,
      workspaceId,
      assetId: id,
      kind: "video",
      buffer: media.buffer,
      mimeType: media.mimeType,
      fileName: "google-generated-video.mp4",
    });

    await CreativeAsset.findByIdAndUpdate(id, {
      status: "complete",
      url: stored.url,
      storageProvider: stored.storageProvider,
      bucket: stored.bucket,
      path: stored.path,
      mimeType: stored.mimeType,
      fileName: stored.fileName,
      fileSize: stored.fileSize,
      providerPayload: operation.raw,
      error: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (error) {
    await CreativeAsset.findByIdAndUpdate(id, {
      status: "failed",
      providerPayload: operation.raw,
      error:
        error instanceof Error
          ? error.message
          : "Failed to store Google generated video",
      updatedAt: new Date(),
    });
  }
}

export async function syncWorkspaceGoogleCreativeAssets(params: {
  storageClient: CreativeAssetStorageClient;
  workspaceId: string;
  limit?: number;
}): Promise<void> {
  const assets = await CreativeAsset.find({
    workspaceId: params.workspaceId,
    provider: "google",
    kind: "video",
    status: { $in: ["queued", "in_progress"] },
    providerRequestId: { $type: "string", $ne: "" },
    "generation.contractVersion": { $ne: 1 },
  })
    .sort({ updatedAt: 1 })
    .limit(params.limit || 4)
    .lean();

  for (const asset of assets) {
    await syncGoogleCreativeAsset({
      storageClient: params.storageClient,
      asset: asset as SyncableGoogleAsset,
    }).catch(() => undefined);
  }
}
