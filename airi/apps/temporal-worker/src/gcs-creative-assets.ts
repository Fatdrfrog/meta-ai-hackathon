import { Storage } from "@google-cloud/storage";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Writable } from "node:stream";
import {
  reserveWorkspaceStorage,
  settleStorageObject,
  tombstoneStorageObject,
  storageObjectId,
  StorageQuotaError,
  type StorageObjectInput,
} from "@icecore/airi-runtime/storage-quota";
import {
  CREATIVE_ASSET_CACHE_CONTROL,
  CREATIVE_ASSET_SIGNED_READ_URL_TTL_SECONDS,
  CREATIVE_ASSET_UPLOAD_SESSION_TTL_SECONDS,
  DEFAULT_GCS_CREATIVE_ASSETS_BUCKET,
  canonicalGcsUri,
  createCreativeAssetObjectPath,
  isCreativeAssetObjectPathForWorkspace,
  type MediaApiCreativeAssetKind,
} from "@icecore/airi-runtime/media-api";
import { readTrimmedString as cleanString } from "@icecore/shared/lib/value-utils";

let storageClient: Storage | null = null;

type GcsObjectMetadata = {
  size?: string | number;
  contentType?: string;
  updated?: string;
  metadata?: Record<string, unknown>;
  generation?: string | number;
  metageneration?: string | number;
};

type GcsFileLike = {
  createWriteStream?: (options: {
    resumable: boolean;
    metadata: {
      contentType: string;
      cacheControl: string;
      metadata: Record<string, string>;
    };
    preconditionOpts: { ifGenerationMatch: 0 };
  }) => Writable;
  getSignedUrl?: (options: {
    version: "v4";
    action: "write";
    expires: number;
    contentType: string;
    extensionHeaders: Record<string, string>;
  }) => Promise<string[]>;
  exists?: () => Promise<[boolean]>;
  getMetadata: () => Promise<GcsObjectMetadata[]>;
  copy?: (
    destination: GcsFileLike,
    options: {
      cacheControl: string;
      contentType: string;
      metadata: Record<string, string>;
      preconditionOpts: { ifGenerationMatch: 0 };
    },
  ) => Promise<[GcsFileLike, unknown?]>;
  delete?: (options: {
    ignoreNotFound: boolean;
    ifGenerationMatch?: string;
    ifMetagenerationMatch?: string;
  }) => Promise<unknown>;
  save?: (
    buffer: Buffer,
    options: {
      resumable: boolean;
      contentType: string;
      metadata: {
        cacheControl: string;
        metadata: Record<string, string>;
      };
      preconditionOpts?: {
        ifGenerationMatch: string | 0;
        ifMetagenerationMatch?: string;
      };
    },
  ) => Promise<unknown>;
};

type GcsCreativeAssetStorageClient = {
  bucket: (bucket: string) => {
    file?: (
      path: string,
      options?: {
        generation?: string;
      },
    ) => GcsFileLike;
  };
};

type StorageQuota = {
  reserve(
    input: Omit<StorageObjectInput, "companyId">,
  ): Promise<{ _id: string; status: "reserved" | "stored" }>;
  settle(id: string, bytes: number): Promise<void>;
};

const storageQuota: StorageQuota = {
  reserve: reserveWorkspaceStorage,
  settle: settleStorageObject,
};

async function recoverGcsCreativeAssetWrite(
  file: GcsFileLike,
  error: unknown,
): Promise<void> {
  try {
    const [metadata] = await file.getMetadata();
    if (metadata && Number.isSafeInteger(Number(metadata.size))) return;
  } catch {
    /* An unconfirmed write keeps its reservation. */
  }
  throw error;
}

/**
 * Legacy callers may pass the Supabase-shaped storage client through their
 * generic media-storage port. Buffer GCS uploads have always ignored it; keep
 * that compatibility while retaining a typed GCS injection seam for tests.
 */
function isGcsCreativeAssetStorageClient(
  value: unknown,
): value is GcsCreativeAssetStorageClient {
  return Boolean(
    value &&
      typeof value === "object" &&
      "bucket" in value &&
      typeof value.bucket === "function",
  );
}

function customMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      )
      .map(([key, item]) => [key, item]),
  );
}

function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function getGcsCreativeAssetsBucketName(): string {
  return (
    cleanString(process.env.GCS_CREATIVE_ASSETS_BUCKET) ||
    DEFAULT_GCS_CREATIVE_ASSETS_BUCKET
  );
}

export function getGcsCreativeAssetReadUrlTtlSeconds(): number {
  return CREATIVE_ASSET_SIGNED_READ_URL_TTL_SECONDS;
}

function getStorageClient(): Storage {
  storageClient ||= new Storage({
    projectId:
      cleanString(process.env.GOOGLE_CLOUD_PROJECT) ||
      cleanString(process.env.GCP_PROJECT_ID) ||
      undefined,
  });
  return storageClient;
}

function assertCreativeAssetObjectPath(params: {
  workspaceId?: string;
  path: string;
}): void {
  const path = cleanString(params.path);
  if (!path || path.startsWith("/") || path.includes("..")) {
    throw new Error("Invalid creative asset object path");
  }
  if (
    params.workspaceId &&
    !isCreativeAssetObjectPathForWorkspace({
      workspaceId: params.workspaceId,
      path,
    })
  ) {
    throw new Error("Creative asset object path is outside the workspace");
  }
}

export function createGcsCreativeAssetPath(input: {
  workspaceId: string;
  assetId: string;
  kind: MediaApiCreativeAssetKind;
  fileName: string;
}): string {
  return createCreativeAssetObjectPath(input);
}

export async function createGcsCreativeAssetUpload(params: {
  storageClient?: GcsCreativeAssetStorageClient;
  storageQuota?: StorageQuota;
  workspaceId: string;
  assetId: string;
  kind: MediaApiCreativeAssetKind;
  fileName: string;
  mimeType: string;
  fileSize: number;
  bucket?: string | null;
  origin?: string | null;
}): Promise<{
  storageProvider: "gcs";
  url: string;
  bucket: string;
  path: string;
  uploadUrl: string;
  expiresInSeconds: number;
  cacheControl: string;
  mode: "single";
  headers: Record<string, string>;
}> {
  const bucket = cleanString(params.bucket) || getGcsCreativeAssetsBucketName();
  const path = createGcsCreativeAssetPath(params);
  assertCreativeAssetObjectPath({ workspaceId: params.workspaceId, path });

  if (!Number.isSafeInteger(params.fileSize) || params.fileSize <= 0) {
    throw new Error(
      "Creative asset upload requires an exact positive byte count",
    );
  }
  const expires = Date.now() + CREATIVE_ASSET_UPLOAD_SESSION_TTL_SECONDS * 1000;
  const claim = await (params.storageQuota || storageQuota).reserve({
    workspaceId: params.workspaceId,
    provider: "gcs",
    bucket,
    path,
    bytes: params.fileSize,
    expiresAt: new Date(expires),
  });
  if (claim.status === "stored")
    throw new StorageQuotaError(
      "storage_identity_conflict",
      "Storage object is already stored; complete the existing upload or use a new identity",
    );
  const file = (
    params.storageClient ||
    (getStorageClient() as unknown as GcsCreativeAssetStorageClient)
  )
    .bucket(bucket)
    .file?.(path);
  if (!file?.getSignedUrl)
    throw new Error("GCS signed upload client is unavailable");
  const headers = {
    "x-goog-content-length-range": `${params.fileSize},${params.fileSize}`,
    "x-goog-if-generation-match": "0",
    "x-goog-meta-workspaceid": params.workspaceId,
    "x-goog-meta-assetid": params.assetId,
    "x-goog-meta-kind": params.kind,
  };
  const [uploadUrl] = await file.getSignedUrl({
    version: "v4",
    action: "write",
    expires,
    contentType: cleanString(params.mimeType) || "application/octet-stream",
    extensionHeaders: headers,
  });
  if (!uploadUrl) throw new Error("GCS signed upload URL is unavailable");

  return {
    storageProvider: "gcs",
    url: canonicalGcsUri(bucket, path),
    bucket,
    path,
    uploadUrl,
    expiresInSeconds: CREATIVE_ASSET_UPLOAD_SESSION_TTL_SECONDS,
    cacheControl: CREATIVE_ASSET_CACHE_CONTROL,
    mode: "single",
    headers,
  };
}

/**
 * Downloads a workspace's stored file to a local path, refusing one larger
 * than `maxBytes` before reading it.
 */
export async function downloadGcsCreativeAssetObject(params: {
  bucket: string;
  path: string;
  workspaceId: string;
  destination: string;
  maxBytes: number;
}): Promise<{ fileSize: number }> {
  assertCreativeAssetObjectPath({
    workspaceId: params.workspaceId,
    path: params.path,
  });
  const file = getStorageClient().bucket(params.bucket).file(params.path);
  const [metadata] = await file.getMetadata();
  const fileSize = Number(metadata?.size);
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    throw new Error("The stored file is empty or unreadable");
  }
  if (fileSize > params.maxBytes) {
    throw new Error(
      `The stored file is ${fileSize} bytes; the limit is ${params.maxBytes}`,
    );
  }
  await file.download({ destination: params.destination });
  return { fileSize };
}

export async function statGcsCreativeAssetObject(params: {
  storageClient?: GcsCreativeAssetStorageClient;
  bucket: string;
  path: string;
  workspaceId?: string;
}): Promise<{
  exists: boolean;
  fileSize: number | null;
  mimeType: string | null;
  updatedAt: string | null;
  customMetadata: Record<string, string>;
  generation: string | null;
  metageneration: string | null;
}> {
  assertCreativeAssetObjectPath({
    workspaceId: params.workspaceId,
    path: params.path,
  });

  const client =
    params.storageClient ||
    (getStorageClient() as unknown as GcsCreativeAssetStorageClient);
  const file = client.bucket(params.bucket).file?.(params.path);
  if (!file?.exists) throw new Error("GCS object client is unavailable");
  const [exists] = await file.exists();
  if (!exists) {
    return {
      exists: false,
      fileSize: null,
      mimeType: null,
      updatedAt: null,
      customMetadata: {},
      generation: null,
      metageneration: null,
    };
  }

  const [metadata] = await file.getMetadata();
  if (!metadata) throw new Error("GCS object metadata is unavailable");
  const size = Number(metadata.size);
  return {
    exists: true,
    fileSize: Number.isFinite(size) && size > 0 ? Math.floor(size) : null,
    mimeType: cleanString(metadata.contentType) || null,
    updatedAt: cleanString(metadata.updated) || null,
    customMetadata: customMetadata(metadata.metadata),
    generation: cleanString(metadata.generation) || null,
    metageneration: cleanString(metadata.metageneration) || null,
  };
}

export async function createGcsCreativeAssetReadUrl(params: {
  bucket: string;
  path: string;
  workspaceId?: string;
  expiresInSeconds?: number | null;
}): Promise<{ url: string; expiresAt: string }> {
  assertCreativeAssetObjectPath({
    workspaceId: params.workspaceId,
    path: params.path,
  });

  const ttlSeconds = readPositiveInteger(
    params.expiresInSeconds,
    getGcsCreativeAssetReadUrlTtlSeconds(),
  );
  const expiresAtMs = Date.now() + ttlSeconds * 1000;
  const [url] = await getStorageClient()
    .bucket(params.bucket)
    .file(params.path)
    .getSignedUrl({
      action: "read",
      expires: expiresAtMs,
      version: "v4",
    });

  return { url, expiresAt: new Date(expiresAtMs).toISOString() };
}

export async function deleteGcsCreativeAssetObject(params: {
  storageClient?: GcsCreativeAssetStorageClient;
  tombstone?: typeof tombstoneStorageObject;
  bucket: string;
  path: string;
  workspaceId?: string;
  ifGenerationMatch?: string;
  ifMetagenerationMatch?: string;
}): Promise<{ deleted: boolean }> {
  assertCreativeAssetObjectPath({
    workspaceId: params.workspaceId,
    path: params.path,
  });

  const client =
    params.storageClient ||
    (getStorageClient() as unknown as GcsCreativeAssetStorageClient);
  const file = client.bucket(params.bucket).file?.(params.path);
  if (!file?.save)
    throw new Error("GCS object tombstone client is unavailable");
  const [metadata] = await file.getMetadata().catch((error: unknown) => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === 404
    )
      return [];
    throw error;
  });
  const alreadyDeleted =
    metadata?.metadata?.airiDeleted === "true" && Number(metadata.size) === 0;
  if (
    !alreadyDeleted &&
    metadata &&
    ((params.ifGenerationMatch &&
      String(metadata.generation) !== params.ifGenerationMatch) ||
      (params.ifMetagenerationMatch &&
        String(metadata.metageneration) !== params.ifMetagenerationMatch))
  )
    throw Object.assign(
      new Error("Creative object version changed before deletion"),
      { code: 412 },
    );
  if (metadata && !metadata.generation)
    throw new Error("GCS object generation is unavailable");
  await (params.tombstone || tombstoneStorageObject)(
    storageObjectId({
      provider: "gcs",
      bucket: params.bucket,
      path: params.path,
    }),
    metadata && !alreadyDeleted
      ? {
          generation: String(metadata.generation),
          bytes: Number(metadata.size),
        }
      : undefined,
  );
  if (!alreadyDeleted) {
    // Keep the name occupied permanently: an already-issued create-only grant
    // must never recreate it while a retained generation is still charged.
    await file.save(Buffer.alloc(0), {
      resumable: false,
      contentType: "application/octet-stream",
      metadata: { cacheControl: "no-store", metadata: { airiDeleted: "true" } },
      preconditionOpts: {
        ifGenerationMatch: metadata ? String(metadata.generation) : 0,
        ...(params.ifMetagenerationMatch
          ? { ifMetagenerationMatch: params.ifMetagenerationMatch }
          : {}),
      },
    });
  }
  return { deleted: true };
}

export async function copyGcsCreativeAssetObject(params: {
  storageClient?: GcsCreativeAssetStorageClient;
  storageQuota?: StorageQuota;
  bucket: string;
  sourcePath: string;
  sourceGeneration: string;
  sourceMetageneration: string;
  destinationPath: string;
  workspaceId: string;
  mimeType: string;
  customMetadata: Record<string, string>;
}): Promise<{
  generation: string;
  metageneration: string;
}> {
  assertCreativeAssetObjectPath({
    workspaceId: params.workspaceId,
    path: params.sourcePath,
  });
  assertCreativeAssetObjectPath({
    workspaceId: params.workspaceId,
    path: params.destinationPath,
  });
  if (params.sourcePath === params.destinationPath) {
    throw new Error("Creative asset copy paths must be different");
  }
  if (!cleanString(params.sourceGeneration)) {
    throw new Error("Creative asset source generation is required");
  }
  if (!cleanString(params.sourceMetageneration)) {
    throw new Error("Creative asset source metageneration is required");
  }

  const client =
    params.storageClient ||
    (getStorageClient() as unknown as GcsCreativeAssetStorageClient);
  const bucket = client.bucket(params.bucket);
  const source = bucket.file?.(params.sourcePath, {
    generation: params.sourceGeneration,
  });
  const destination = bucket.file?.(params.destinationPath);
  if (!source?.copy || !destination) {
    throw new Error("GCS object server-side copy client is unavailable");
  }

  const [sourceMetadata] = await source.getMetadata();
  const bytes = Number(sourceMetadata?.size);
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw new Error("Creative copy source size is unavailable");
  const quota = params.storageQuota || storageQuota;
  const claim = await quota.reserve({
    workspaceId: params.workspaceId,
    provider: "gcs",
    bucket: params.bucket,
    path: params.destinationPath,
    bytes,
  });
  if (claim.status !== "stored")
    try {
      await source.copy(destination, {
        cacheControl: CREATIVE_ASSET_CACHE_CONTROL,
        contentType: params.mimeType,
        metadata: {
          ...customMetadata(params.customMetadata),
          workspaceId: params.workspaceId,
          kind: "video",
        },
        preconditionOpts: { ifGenerationMatch: 0 },
      });
    } catch (error) {
      await recoverGcsCreativeAssetWrite(destination, error);
    }

  const [metadata] = await destination.getMetadata();
  const storedBytes = Number(metadata?.size);
  if (!Number.isSafeInteger(storedBytes) || storedBytes !== bytes) {
    if (Number.isSafeInteger(storedBytes) && storedBytes >= 0)
      await quota.settle(claim._id, storedBytes);
    throw new Error("Creative copy size does not match its reservation");
  }
  await quota.settle(claim._id, storedBytes);
  const generation = cleanString(metadata?.generation);
  const metageneration = cleanString(metadata?.metageneration);
  if (!generation || !metageneration) {
    throw new Error("GCS object copy did not return version preconditions");
  }
  return { generation, metageneration };
}

export async function uploadGcsCreativeAssetBuffer<
  StorageClient = GcsCreativeAssetStorageClient,
>(params: {
  storageClient?: StorageClient;
  storageQuota?: StorageQuota;
  bucket?: string | null;
  workspaceId: string;
  assetId: string;
  kind: MediaApiCreativeAssetKind;
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  customMetadata?: Record<string, string>;
  preconditionOpts?: { ifGenerationMatch: 0 };
}): Promise<{
  storageProvider: "gcs";
  url: string;
  bucket: string;
  path: string;
  mimeType: string;
  fileName: string;
  fileSize: number;
}> {
  const bucket = cleanString(params.bucket) || getGcsCreativeAssetsBucketName();
  const path = createGcsCreativeAssetPath(params);
  assertCreativeAssetObjectPath({ workspaceId: params.workspaceId, path });

  const client = isGcsCreativeAssetStorageClient(params.storageClient)
    ? params.storageClient
    : (getStorageClient() as unknown as GcsCreativeAssetStorageClient);
  const file = client.bucket(bucket).file?.(path);
  if (!file?.save) throw new Error("GCS buffer upload client is unavailable");
  const quota = params.storageQuota || storageQuota;
  const claim = await quota.reserve({
    workspaceId: params.workspaceId,
    provider: "gcs",
    bucket,
    path,
    bytes: params.buffer.byteLength,
  });
  if (claim.status !== "stored")
    try {
      await file.save(params.buffer, {
        resumable: params.buffer.byteLength >= 8 * 1024 * 1024,
        contentType: params.mimeType,
        metadata: {
          cacheControl: CREATIVE_ASSET_CACHE_CONTROL,
          metadata: {
            ...customMetadata(params.customMetadata),
            workspaceId: params.workspaceId,
            assetId: params.assetId,
            kind: params.kind,
          },
        },
        preconditionOpts: { ifGenerationMatch: 0 },
      });
    } catch (error) {
      await recoverGcsCreativeAssetWrite(file, error);
      const [metadata] = await file.getMetadata();
      const bytes = Number(metadata?.size);
      if (bytes !== params.buffer.byteLength) {
        await quota.settle(claim._id, bytes);
        throw new Error(
          "GCS stored buffer size does not match its reservation",
        );
      }
    }
  await quota.settle(claim._id, params.buffer.byteLength);

  return {
    storageProvider: "gcs",
    url: canonicalGcsUri(bucket, path),
    bucket,
    path,
    mimeType: params.mimeType,
    fileName: params.fileName,
    fileSize: params.buffer.byteLength,
  };
}

export async function uploadGcsCreativeAssetFile(params: {
  storageClient?: GcsCreativeAssetStorageClient;
  storageQuota?: StorageQuota;
  bucket?: string | null;
  workspaceId: string;
  assetId: string;
  kind: MediaApiCreativeAssetKind;
  localPath: string;
  mimeType: string;
  fileName: string;
  customMetadata?: Record<string, string>;
  preconditionOpts?: { ifGenerationMatch: 0 };
}): Promise<{
  storageProvider: "gcs";
  url: string;
  bucket: string;
  path: string;
  mimeType: string;
  fileName: string;
  fileSize: number;
  generation: string | null;
  metageneration: string | null;
}> {
  const bucket = cleanString(params.bucket) || getGcsCreativeAssetsBucketName();
  const path = createGcsCreativeAssetPath(params);
  assertCreativeAssetObjectPath({ workspaceId: params.workspaceId, path });
  const file = await stat(params.localPath);
  if (!file.isFile() || file.size <= 0) {
    throw new Error("Creative asset upload file is empty or unavailable");
  }

  const client =
    params.storageClient ||
    (getStorageClient() as unknown as GcsCreativeAssetStorageClient);
  const uploadedFile = client.bucket(bucket).file?.(path);
  if (!uploadedFile?.createWriteStream)
    throw new Error("GCS file upload client is unavailable");
  const quota = params.storageQuota || storageQuota;
  const claim = await quota.reserve({
    workspaceId: params.workspaceId,
    provider: "gcs",
    bucket,
    path,
    bytes: file.size,
  });
  if (claim.status !== "stored")
    try {
      await pipeline(
        createReadStream(params.localPath, { start: 0, end: file.size - 1 }),
        uploadedFile.createWriteStream({
          resumable: true,
          metadata: {
            contentType: params.mimeType,
            cacheControl: CREATIVE_ASSET_CACHE_CONTROL,
            metadata: {
              ...customMetadata(params.customMetadata),
              workspaceId: params.workspaceId,
              assetId: params.assetId,
              kind: params.kind,
            },
          },
          preconditionOpts: { ifGenerationMatch: 0 },
        }),
      );
    } catch (error) {
      await recoverGcsCreativeAssetWrite(uploadedFile, error);
    }
  const [uploadedMetadata] = await uploadedFile.getMetadata();
  if (!uploadedMetadata) throw new Error("GCS upload metadata is unavailable");
  const storedBytes = Number(uploadedMetadata.size);
  if (!Number.isSafeInteger(storedBytes) || storedBytes !== file.size) {
    if (Number.isSafeInteger(storedBytes) && storedBytes >= 0)
      await quota.settle(claim._id, storedBytes);
    throw new Error("GCS uploaded file size does not match its reservation");
  }
  await quota.settle(claim._id, storedBytes);

  return {
    storageProvider: "gcs",
    url: canonicalGcsUri(bucket, path),
    bucket,
    path,
    mimeType: params.mimeType,
    fileName: params.fileName,
    fileSize: file.size,
    generation: cleanString(uploadedMetadata.generation) || null,
    metageneration: cleanString(uploadedMetadata.metageneration) || null,
  };
}
