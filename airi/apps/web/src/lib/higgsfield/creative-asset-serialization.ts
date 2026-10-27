import {
  resolveCreativeAssetGcsObjectRef,
  type CreativeAssetStorageProvider,
} from "@icecore/airi-runtime/media-api";
import { createCreativeAssetReadUrl } from "@icecore/airi-runtime/creative-asset-read-url";
import {
  resolveVideoGenerationRetryAvailability,
  type VideoGenerationRetryAvailability,
} from "@/lib/creative-assets/video-generation-retry-availability";
import { ensureMediaApiCreativeAssetReadUrlPort } from "@/lib/google/creative-asset-read-url-media-api-adapter";
import type {
  CreativeAssetVideoGeneration,
  ICreativeAsset,
} from "@/models/creative-asset";
import { readNonEmptyString as cleanString } from "@icecore/shared/lib/value-utils";

export type PublicVideoGeneration = {
  contractVersion: 1;
  provider: "happyhorse" | "higgsfield" | "google";
  mode: "text_to_video" | "image_to_video" | "reference_to_video";
  skill: "video" | "character";
  status: "queued" | "in_progress" | "complete" | "failed" | "nsfw";
  modelId: string;
  userPrompt: string;
  durationSeconds: number;
  aspectRatio: string | null;
  resolution: string;
  sourceAssetId: string | null;
  referenceAssetIds: string[];
  prompt: {
    compilerId: "airi-video-director";
    compilerVersion: 1;
    providerPromptSha256: string;
    warnings: Array<{ code: string; message: string }>;
  };
  retryOfAssetId: string | null;
  result: PublicVideoGenerationResult | null;
  failure: PublicVideoGenerationFailure | null;
  canRetry: boolean;
  requiresDuplicateChargeAcknowledgement: boolean;
};

export type PublicVideoGenerationResult = {
  durationSeconds: number;
  width: number;
  height: number;
  mimeType: string;
  fileSize: number;
  sha256: string;
  warnings: Array<{
    code: "duration_mismatch" | "mime_type_normalized";
    message: string;
  }>;
  startedAt: string | null;
  completedAt: string;
};

export type PublicVideoGenerationFailure = {
  phase:
    | "validation"
    | "compile"
    | "submit"
    | "poll"
    | "download"
    | "probe"
    | "store";
  code: string;
  message: string;
  retryable: boolean;
  submissionUncertain: boolean;
  failedAt: string;
};

export type LeanCreativeAsset = Omit<
  Partial<ICreativeAsset>,
  "_id" | "createdAt" | "updatedAt" | "completedAt"
> & {
  _id?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  completedAt?: unknown;
};

function isoDate(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) return value;
  return null;
}

function isContractV1VideoAsset(asset: LeanCreativeAsset): boolean {
  return asset.generation?.contractVersion === 1;
}

export function serializePublicVideoGeneration(
  generation: CreativeAssetVideoGeneration,
  status: PublicVideoGeneration["status"],
  retryAvailability: VideoGenerationRetryAvailability
): PublicVideoGeneration {
  return {
    contractVersion: 1,
    provider: generation.spec.provider,
    mode: generation.spec.mode,
    skill: generation.spec.skill,
    status,
    modelId: generation.spec.modelId,
    userPrompt: generation.spec.userPrompt,
    durationSeconds: generation.spec.durationSeconds,
    aspectRatio: generation.spec.aspectRatio,
    resolution: generation.spec.resolution,
    sourceAssetId: generation.spec.sourceAssetId,
    referenceAssetIds: [...generation.spec.referenceAssetIds],
    prompt: {
      compilerId: generation.prompt.compilerId,
      compilerVersion: generation.prompt.compilerVersion,
      providerPromptSha256: generation.prompt.providerPromptSha256,
      warnings: generation.prompt.warnings.map(warning => ({
        code: warning.code,
        message: warning.message,
      })),
    },
    retryOfAssetId: generation.retryOfAssetId,
    result: generation.result
      ? {
          durationSeconds: generation.result.durationSeconds,
          width: generation.result.width,
          height: generation.result.height,
          mimeType: generation.result.mimeType,
          fileSize: generation.result.fileSize,
          sha256: generation.result.sha256,
          warnings: generation.result.warnings.map(warning => ({
            code: warning.code,
            message: warning.message,
          })),
          startedAt: isoDate(generation.result.startedAt),
          completedAt: isoDate(generation.result.completedAt) || "",
        }
      : null,
    failure: generation.failure
      ? {
          phase: generation.failure.phase,
          code: generation.failure.code,
          message: generation.failure.message,
          retryable: generation.failure.retryable,
          submissionUncertain: generation.failure.submissionUncertain,
          failedAt: isoDate(generation.failure.failedAt) || "",
        }
      : null,
    canRetry: retryAvailability.canRetry,
    requiresDuplicateChargeAcknowledgement:
      retryAvailability.requiresDuplicateChargeAcknowledgement,
  };
}

export function resolveCreativeAssetStorageProvider(
  asset: LeanCreativeAsset
): CreativeAssetStorageProvider {
  if (asset.storageProvider === "gcs" || asset.storageProvider === "supabase") {
    return asset.storageProvider;
  }
  return cleanString(asset.url)?.startsWith("gcs://") ? "gcs" : "supabase";
}

export async function resolveCreativeAssetDisplayUrl(
  asset: LeanCreativeAsset
): Promise<string | null> {
  const storageProvider = resolveCreativeAssetStorageProvider(asset);
  if (isContractV1VideoAsset(asset) && storageProvider !== "gcs") {
    return null;
  }
  if (storageProvider !== "gcs") {
    return cleanString(asset.url);
  }
  if (asset.status !== "complete") return null;
  const ref = resolveCreativeAssetGcsObjectRef({
    url: asset.url,
    bucket: asset.bucket,
    path: asset.path,
  });
  if (!ref) return null;
  try {
    ensureMediaApiCreativeAssetReadUrlPort();
    const result = await createCreativeAssetReadUrl({
      provider: "gcs",
      bucket: ref.bucket,
      path: ref.path,
      workspaceId: cleanString(asset.workspaceId) || undefined,
    });
    return result.url;
  } catch {
    // List/picker must still return assets when Media API / OIDC is unavailable
    // locally; UI shows missing preview instead of a 500.
    return null;
  }
}

export async function serializeCreativeAssetForResponse(
  asset: LeanCreativeAsset
) {
  return {
    ...serializeCreativeAsset(asset),
    url: await resolveCreativeAssetDisplayUrl(asset),
  };
}

export async function serializeCreativeAssetsForResponse(
  assets: LeanCreativeAsset[]
) {
  ensureMediaApiCreativeAssetReadUrlPort();
  return Promise.all(
    assets.map(asset => serializeCreativeAssetForResponse(asset))
  );
}

export function serializeCreativeAsset(asset: LeanCreativeAsset) {
  const status = asset.status || "failed";
  const generation = asset.generation;
  const publicGeneration =
    generation?.contractVersion === 1
      ? serializePublicVideoGeneration(
          generation,
          status,
          resolveVideoGenerationRetryAvailability(asset)
        )
      : null;

  if (publicGeneration && generation) {
    const isGcsBackedResult =
      resolveCreativeAssetStorageProvider(asset) === "gcs" &&
      status === "complete";

    return {
      id: String(asset._id || ""),
      workspaceId: cleanString(asset.workspaceId) || "",
      kind: asset.kind || "video",
      source: asset.source || "happyhorse",
      provider: generation.spec.provider,
      status,
      prompt: generation.spec.userPrompt,
      modelId: generation.spec.modelId,
      sourceAssetId: generation.spec.sourceAssetId,
      url: null,
      storageProvider: isGcsBackedResult ? "gcs" : null,
      bucket: isGcsBackedResult ? cleanString(asset.bucket) : null,
      path: isGcsBackedResult ? cleanString(asset.path) : null,
      mimeType: generation.result?.mimeType || null,
      fileName: null,
      fileSize: generation.result?.fileSize ?? null,
      error: generation.failure?.message || null,
      completedAt: generation.result
        ? isoDate(generation.result.completedAt)
        : null,
      createdAt: isoDate(asset.createdAt),
      updatedAt: isoDate(asset.updatedAt),
      generation: publicGeneration,
    };
  }

  const base = {
    id: String(asset._id || ""),
    workspaceId: cleanString(asset.workspaceId) || "",
    kind: asset.kind || "image",
    source: asset.source || "uploaded",
    provider: asset.provider || null,
    status,
    prompt: cleanString(asset.prompt),
    modelId: cleanString(asset.modelId),
    sourceAssetId: cleanString(asset.sourceAssetId),
    url: cleanString(asset.url),
    storageProvider: resolveCreativeAssetStorageProvider(asset),
    bucket: cleanString(asset.bucket),
    path: cleanString(asset.path),
    mimeType: cleanString(asset.mimeType),
    fileName: cleanString(asset.fileName),
    fileSize: typeof asset.fileSize === "number" ? asset.fileSize : null,
    error: cleanString(asset.error),
    completedAt: isoDate(asset.completedAt),
    createdAt: isoDate(asset.createdAt),
    updatedAt: isoDate(asset.updatedAt),
  };

  return {
    ...base,
    generation: null,
    providerRequestId: cleanString(asset.providerRequestId),
    providerStatusUrl: cleanString(asset.providerStatusUrl),
    providerCancelUrl: cleanString(asset.providerCancelUrl),
  };
}
