import "server-only";

import {
  downloadElevenLabsDubbingResult,
  getElevenLabsDubbingStatus,
} from "@/lib/elevenlabs/creative-assets";
import {
  getPlatformElevenLabsApiKey,
  resolveElevenLabsCredentialsForWorkspace,
} from "@/lib/elevenlabs/elevenlabs-source";
import {
  storeCreativeAssetBuffer,
  type CreativeAssetStorageClient,
} from "@/lib/higgsfield/creative-asset-storage";
import type { createClient } from "@/lib/supabase/server";
import { CreativeAsset, type ICreativeAsset } from "@/models/creative-asset";
import { asRecord, cleanString } from "@icecore/shared/lib/value-utils";

type SupabaseSourceClient = Pick<
  Awaited<ReturnType<typeof createClient>>,
  "from"
>;

type SyncableElevenLabsAsset = Omit<
  Pick<
    Partial<ICreativeAsset>,
    | "_id"
    | "workspaceId"
    | "kind"
    | "provider"
    | "status"
    | "providerRequestId"
    | "providerSourceId"
    | "providerPayload"
    | "updatedAt"
  >,
  "_id" | "updatedAt"
> & {
  _id?: unknown;
  updatedAt?: unknown;
};

const ELEVENLABS_DUBBING_POLL_THROTTLE_MS = 10_000;

function assetId(asset: SyncableElevenLabsAsset): string {
  return String(asset._id || "");
}

function shouldPollElevenLabsDubbingAsset(
  asset: SyncableElevenLabsAsset
): boolean {
  if (asset.provider !== "elevenlabs") return false;
  if (asset.status !== "queued" && asset.status !== "in_progress") return false;
  if (!asset.providerRequestId) return false;

  const payload = asRecord(asset.providerPayload);
  if (cleanString(payload.mode, 40) !== "dub") return false;

  const updatedAt =
    asset.updatedAt instanceof Date ? asset.updatedAt.getTime() : 0;
  return (
    !updatedAt || Date.now() - updatedAt >= ELEVENLABS_DUBBING_POLL_THROTTLE_MS
  );
}

export async function syncElevenLabsCreativeAsset(params: {
  supabase: SupabaseSourceClient;
  storageClient: CreativeAssetStorageClient;
  asset: SyncableElevenLabsAsset;
}): Promise<void> {
  if (!shouldPollElevenLabsDubbingAsset(params.asset)) return;

  const id = assetId(params.asset);
  const workspaceId = cleanString(params.asset.workspaceId, 200);
  const dubbingId = cleanString(params.asset.providerRequestId, 200);
  if (!id || !workspaceId || !dubbingId) return;

  const payload = asRecord(params.asset.providerPayload);
  const targetLanguage = cleanString(payload.targetLanguage, 24);
  if (!targetLanguage) return;

  const sourceId = cleanString(params.asset.providerSourceId, 200);
  const apiKey = sourceId
    ? (
        await resolveElevenLabsCredentialsForWorkspace({
          supabase: params.supabase,
          workspaceId,
          sourceId,
        })
      ).apiKey
    : getPlatformElevenLabsApiKey();
  if (!apiKey)
    throw new Error("The original ElevenLabs credentials are unavailable.");

  const status = await getElevenLabsDubbingStatus({
    apiKey,
    dubbingId,
  });

  if (status.status === "failed") {
    await CreativeAsset.findByIdAndUpdate(id, {
      status: "failed",
      providerPayload: {
        ...payload,
        status: status.raw,
      },
      error: status.error || "ElevenLabs dubbing failed",
      updatedAt: new Date(),
    });
    return;
  }

  if (status.status !== "complete") {
    await CreativeAsset.findByIdAndUpdate(id, {
      status: "in_progress",
      providerPayload: {
        ...payload,
        status: status.raw,
      },
      updatedAt: new Date(),
    });
    return;
  }

  try {
    const media = await downloadElevenLabsDubbingResult({
      apiKey,
      dubbingId,
      languageCode: targetLanguage,
    });
    const stored = await storeCreativeAssetBuffer({
      storageClient: params.storageClient,
      workspaceId,
      assetId: id,
      kind: media.mimeType.startsWith("video/") ? "video" : "audio",
      buffer: media.buffer,
      mimeType: media.mimeType,
      fileName: media.fileName,
    });

    await CreativeAsset.findByIdAndUpdate(id, {
      status: "complete",
      kind: stored.mimeType.startsWith("video/") ? "video" : "audio",
      url: stored.url,
      storageProvider: stored.storageProvider,
      bucket: stored.bucket,
      path: stored.path,
      mimeType: stored.mimeType,
      fileName: stored.fileName,
      fileSize: stored.fileSize,
      providerPayload: {
        ...payload,
        status: status.raw,
      },
      error: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (error) {
    await CreativeAsset.findByIdAndUpdate(id, {
      status: "failed",
      providerPayload: {
        ...payload,
        status: status.raw,
      },
      error:
        error instanceof Error
          ? error.message
          : "Failed to store ElevenLabs dubbed media",
      updatedAt: new Date(),
    });
  }
}

export async function syncWorkspaceElevenLabsCreativeAssets(params: {
  supabase: SupabaseSourceClient;
  storageClient: CreativeAssetStorageClient;
  workspaceId: string;
  limit?: number;
}): Promise<void> {
  const assets = await CreativeAsset.find({
    workspaceId: params.workspaceId,
    provider: "elevenlabs",
    status: { $in: ["queued", "in_progress"] },
    providerRequestId: { $type: "string", $ne: "" },
  })
    .sort({ updatedAt: 1 })
    .limit(params.limit || 4)
    .lean();

  for (const asset of assets) {
    await syncElevenLabsCreativeAsset({
      supabase: params.supabase,
      storageClient: params.storageClient,
      asset: asset as SyncableElevenLabsAsset,
    }).catch(() => undefined);
  }
}
