import "server-only";

import {
  canonicalGcsUri,
  createCreativeAssetObjectPath,
  MEDIA_API_PATHS,
  type MediaApiCreativeAssetKind,
  type MediaApiInitiateUploadRequest,
  type MediaApiInitiateUploadResponse,
  type MediaApiObjectDeleteRequest,
  type MediaApiObjectDeleteResponse,
  type MediaApiObjectReadUrlRequest,
  type MediaApiObjectReadUrlResponse,
  type MediaApiObjectStatRequest,
  type MediaApiObjectStatResponse,
} from "@icecore/airi-runtime/media-api";
import { compactEnv, getVercelOidcTokenOrEnv } from "@/lib/google/gcp-auth";
import {
  readStorageObject,
  readWorkspaceStorageObject,
  settleStorageObject,
  storageObjectId,
  StorageQuotaError,
} from "@icecore/airi-runtime/storage-quota";

const GCP_MEDIA_API_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.GCP_MEDIA_API_TIMEOUT_MS || 30_000)
);

export function getGcpMediaApiBaseUrl(): string | null {
  const value = String(process.env.GCP_MEDIA_API_URL || "").trim();
  if (!value) return null;
  return value.replace(/\/$/, "");
}

function isLocalMediaApiUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function canCallGcpMediaApi(): boolean {
  const baseUrl = getGcpMediaApiBaseUrl();
  if (!baseUrl) return false;
  if (isLocalMediaApiUrl(baseUrl)) return true;
  return Boolean(compactEnv("VERCEL_OIDC_TOKEN") || compactEnv("VERCEL"));
}

async function callGcpMediaApi<TResponse>(
  path: string,
  payload: unknown
): Promise<TResponse> {
  const baseUrl = getGcpMediaApiBaseUrl();
  if (!baseUrl) {
    throw new Error("GCP_MEDIA_API_URL is not configured");
  }

  const token = await getVercelOidcTokenOrEnv();
  if (!token && !isLocalMediaApiUrl(baseUrl)) {
    throw new Error(
      "Creative asset uploads need a local media API in development. " +
        "Set GCP_MEDIA_API_URL=http://127.0.0.1:8080 and run " +
        "`MEDIA_API_DISABLE_AUTH=true pnpm --filter @icecore/temporal-worker start:media-api`. " +
        "Cloud Run media API requires a Vercel OIDC token (available only on Vercel)."
    );
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(GCP_MEDIA_API_TIMEOUT_MS),
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  if (!response.ok) {
    let failure: { code?: string; error?: string } = {};
    try {
      failure = JSON.parse(responseText || "{}");
    } catch {
      /* Preserve the provider HTTP error below. */
    }
    if (
      failure.code === "storage_inventory_required" ||
      failure.code === "company_storage_limit_exceeded" ||
      failure.code === "storage_identity_conflict" ||
      failure.code === "storage_object_deleted"
    ) {
      throw new StorageQuotaError(
        failure.code,
        failure.error || "Storage upload was not admitted",
        response.status
      );
    }
    throw new Error(
      `GCP media API HTTP ${response.status}: ${responseText.slice(0, 800)}`
    );
  }

  try {
    return JSON.parse(responseText) as TResponse;
  } catch {
    throw new Error("GCP media API returned non-JSON response");
  }
}

export async function createRemoteCreativeAssetUpload(
  payload: MediaApiInitiateUploadRequest
): Promise<MediaApiInitiateUploadResponse> {
  return callGcpMediaApi<MediaApiInitiateUploadResponse>(
    MEDIA_API_PATHS.initiateUpload,
    payload
  );
}

export async function statRemoteCreativeAssetObject(
  payload: MediaApiObjectStatRequest
): Promise<MediaApiObjectStatResponse> {
  const result = await callGcpMediaApi<MediaApiObjectStatResponse>(
    MEDIA_API_PATHS.objectStat,
    payload
  );
  if (
    result.exists &&
    typeof result.fileSize === "number" &&
    Number.isSafeInteger(result.fileSize) &&
    result.fileSize >= 0
  ) {
    const id = storageObjectId(payload);
    const reservation = await readStorageObject(id);
    if (reservation?.status === "reserved")
      await settleStorageObject(id, result.fileSize);
  }
  return result;
}

export async function createRemoteCreativeAssetReadUrl(
  payload: MediaApiObjectReadUrlRequest
): Promise<MediaApiObjectReadUrlResponse> {
  return callGcpMediaApi<MediaApiObjectReadUrlResponse>(
    MEDIA_API_PATHS.objectReadUrl,
    payload
  );
}

export async function deleteRemoteCreativeAssetObject(
  payload: MediaApiObjectDeleteRequest
): Promise<MediaApiObjectDeleteResponse> {
  return callGcpMediaApi<MediaApiObjectDeleteResponse>(
    MEDIA_API_PATHS.objectDelete,
    payload
  );
}

export async function storeRemoteCreativeAssetBuffer(params: {
  workspaceId: string;
  assetId: string;
  kind: MediaApiCreativeAssetKind;
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<{
  provider: "gcs";
  url: string;
  bucket: string;
  path: string;
  mimeType: string;
  fileName: string;
  fileSize: number;
}> {
  const path = createCreativeAssetObjectPath(params);
  const existing = await readWorkspaceStorageObject({
    workspaceId: params.workspaceId,
    provider: "gcs",
    path,
  });
  if (existing?.status === "tombstoned")
    throw new StorageQuotaError(
      "storage_object_deleted",
      "Storage object was deleted; use a new object identity"
    );
  if (existing?.status === "stored") {
    if (existing.bytes !== params.buffer.byteLength)
      throw new StorageQuotaError(
        "storage_identity_conflict",
        "Stored object size differs from this upload"
      );
    return {
      provider: "gcs",
      url: canonicalGcsUri(existing.bucket, existing.path),
      bucket: existing.bucket,
      path: existing.path,
      mimeType: params.mimeType,
      fileName: params.fileName,
      fileSize: existing.bytes,
    };
  }
  const upload = await createRemoteCreativeAssetUpload({
    workspaceId: params.workspaceId,
    assetId: params.assetId,
    kind: params.kind,
    fileName: params.fileName,
    mimeType: params.mimeType,
    fileSize: params.buffer.byteLength,
  });

  const body = Uint8Array.from(params.buffer).buffer;

  try {
    const uploadResponse = await fetch(upload.uploadUrl, {
      method: upload.method,
      headers: {
        "Content-Type": params.mimeType,
        "Content-Length": String(params.buffer.byteLength),
        ...upload.headers,
      },
      body,
    });

    const responseText = await uploadResponse.text().catch(() => "");
    if (!uploadResponse.ok) {
      throw new Error(
        `GCS upload failed: HTTP ${uploadResponse.status} ${responseText.slice(
          0,
          500
        )}`
      );
    }
  } catch (error) {
    const existing = await statRemoteCreativeAssetObject({
      provider: "gcs",
      workspaceId: params.workspaceId,
      bucket: upload.bucket,
      path: upload.path,
    }).catch(() => null);
    if (!existing?.exists || existing.fileSize !== params.buffer.byteLength)
      throw error;
  }
  await settleStorageObject(
    storageObjectId({
      provider: "gcs",
      bucket: upload.bucket,
      path: upload.path,
    }),
    params.buffer.byteLength
  );

  return {
    provider: "gcs",
    url: canonicalGcsUri(upload.bucket, upload.path),
    bucket: upload.bucket,
    path: upload.path,
    mimeType: params.mimeType,
    fileName: params.fileName,
    fileSize: params.buffer.byteLength,
  };
}
